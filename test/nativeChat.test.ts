import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NativeChatApprovalParams, NativeChatHistoryPage, NativeChatItemEntry, NativeChatReply, NativeChatTerminal, NativeChatTransport, NativeChatTransportFactory, NativeChatTransportOptions } from '../src/main/nativeChat';
import type { ChatEngine } from '../src/shared/chatPermissions';
import type { ChatEvent, ChatModel, ChatSession } from '../src/shared/radialApi';
import type { Call, FakeList, FakeTerminal, FakeTransport, NativeStart, SentRequest } from './support/nativeChat';
import { tmpDir } from './support/tmp';
const fs = require('fs') as typeof import('fs'), os = require('os') as typeof import('os'), path = require('path') as typeof import('path');
const { NativeChat, itemMessage } = require('../src/main/nativeChat') as typeof import('../src/main/nativeChat');
/** A model list's page without the models' display names, which the test that answers it doesn't read. */
type CatalogPage = { data: Omit<ChatModel, 'displayName'>[] };
test('CLI chat keeps streaming messages, explicit approvals, interruption, and resumed context', async () => {
  const dir = tmpDir('radial-chat-test-');
  const file = path.join(dir, 'chats.json'), calls: Call[] = [], transports: FakeTransport[] = [];
  const factory: NativeChatTransportFactory = options => {
    const t: FakeTransport<'initialize' | 'close' | 'write'> & { options: NativeChatTransportOptions } = { options, initialize: async () => {}, request: async (method, params) => { if (method === 'config/read') return { config: {} }; calls.push({method, params}); return method.startsWith('thread/') ? {thread:{id:'thread-1'}} : {turn:{id:'turn-1'}}; }, write: data => calls.push(data), close: () => {} };
    transports.push(t); return t as NativeChatTransport;
  };
  let chat = new NativeChat({ file, context:()=> 'Shared preview context', emit:()=>{}, transport:factory });
  const s = chat.create(dir);
  await chat.send(s.id, 'Inspect navigation with hidden context', 'Inspect navigation');
  assert.equal(s.messages[0].text, 'Inspect navigation');
  assert.equal(calls[0].params!.sandbox, 'workspace-write'); // the first request: thread/start
  assert.equal(calls[0].params!.approvalPolicy, 'on-request');
  chat.event(s, { method:'item/agentMessage/delta', params:{threadId:'thread-1',itemId:'m1',delta:'Hello '} });
  chat.event(s, { method:'item/agentMessage/delta', params:{threadId:'thread-1',itemId:'m1',delta:'world'} });
  chat.event(s, { method:'item/completed', params:{item:{id:'m1',type:'agentMessage',text:'Hello world'}} });
  assert.equal(s.messages.filter(m=>m.role==='assistant').length, 1);
  assert.equal(s.messages[1].text, 'Hello world');
  chat.requestFromCli(s, {id:99,method:'item/commandExecution/requestApproval',params:{command:'git status'}});
  assert.equal(s.state, 'approval');
  assert.equal(calls.some(c=>c.id===99), false, 'requests are never automatically approved');
  assert.throws(() => chat.respond(s.id, {requestId:98,decision:'accept'}), /no longer pending/);
  chat.respond(s.id, {requestId:99,decision:'decline'});
  assert.deepEqual(calls.at(-1), {id:99,result:{decision:'decline'}});
  chat.requestFromCli(s, {id:100,method:'item/commandExecution/requestApproval',params:{command:'git status'}});
  chat.respond(s.id, {requestId:100,decision:'acceptForSession'});
  assert.deepEqual(calls.at(-1), {id:100,result:{decision:'acceptForSession'}}, 'session approval uses the native CLI decision without widening the policy');
  const other = chat.create(dir, false, 'claude');
  chat.requestFromCli(other, {id:101,method:'item/commandExecution/requestApproval',params:{command:'git status'}});
  assert.throws(() => chat.respond(other.id, {requestId:101,decision:'acceptForSession'}), /available approval option/);
  await chat.stop(s.id); assert.equal(calls.at(-1)!.method, 'turn/interrupt'); // stop just sent it
  chat.close();
  chat = new NativeChat({file,context:()=>'',emit:()=>{},transport:factory});
  await chat.send(s.id, 'Continue');
  assert.ok(calls.find(c=>c.method==='thread/resume'&&c.params.threadId==='thread-1'));
  assert.equal(chat.get(s.id).messages.length, 3);
  chat.close(); fs.rmSync(dir,{recursive:true,force:true});
});
test('tool events retain command output and file diffs for review', () => {
  assert.equal(itemMessage({id:'1',type:'commandExecution',command:'npm test',aggregatedOutput:'passed',status:'completed'})!.detail, 'passed'); // a tool item renders as a message
  assert.equal(itemMessage({id:'2',type:'fileChange',changes:[{path:'index.html',diff:'-old\n+new'}]})!.detail, '-old\n+new');
  // @ts-expect-error -- a reasoning item on purpose: with its summary, which Codex sends and NativeChatItem doesn't have, and without its id. itemMessage drops a reasoning item by its type, before anything reads an id
  assert.equal(itemMessage({type:'reasoning',summary:[]}), null);
});

test('model discovery is read-only, and validated choices persist across turns and resume', async () => {
  const dir = tmpDir('radial-chat-models-');
  const file = path.join(dir, 'chats.json'), calls: SentRequest[] = [], transports: (FakeTransport & { closed?: boolean })[] = [];
  const catalog: ChatModel[] = [{ model: 'test-model', displayName: 'Test model', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }];
  const factory = () => {
    const t: FakeTransport & { closed?: boolean } = { initialize: async () => {}, close() { this.closed = true; }, request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'model/list') return { data: catalog, nextCursor: null };
      if (method.startsWith('thread/')) return { thread: { id: 'thread' }, model: params.model || 'configured-default', reasoningEffort: 'medium' };
      return { turn: { id: 'turn' } };
    } }; transports.push(t); return t as NativeChatTransport;
  };
  let chat = new NativeChat({ file, context: () => '', emit: () => {}, transport: factory });
  try {
    await Promise.all([chat.models(dir), chat.models(dir)]);
    assert.deepEqual(calls.map(c => c.method), ['model/list']);
    assert.equal(transports[0].closed, true);
    assert.equal(chat.list().length, 0);
    const s = chat.create(dir);
    await assert.rejects(chat.configure(s.id, 'unavailable', 'high'), /not available/);
    await assert.rejects(chat.configure(s.id, 'test-model', 'max'), /does not support/);
    assert.equal(s.model, undefined);
    await chat.configure(s.id, 'test-model', 'high');
    await chat.send(s.id, 'Build navigation');
    assert.equal(calls.find(c => c.method === 'thread/start')!.params.model, 'test-model'); // send started the thread
    assert.equal(calls.at(-1)!.params.model, 'test-model'); // the turn just sent
    assert.equal(calls.at(-1)!.params.effort, 'high');
    await chat.configure(s.id, 'test-model', 'medium');
    assert.equal(s.effort, 'high');
    assert.equal(s.pendingSettings!.effort, 'medium'); // configure queued it during the turn
    await chat.stop(s.id);
    chat.close();
    chat = new NativeChat({ file, context: () => '', emit: () => {}, transport: factory });
    await chat.send(s.id, 'Continue');
    assert.ok(calls.find(c => c.method === 'thread/resume' && c.params.model === 'test-model'));
    assert.equal(calls.at(-1)!.params.effort, 'medium'); // the turn just sent
  } finally { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a turn starting during model discovery queues the change for the next message', async () => {
  const dir = tmpDir('radial-chat-model-race-');
  let resolveCatalog!: (page: CatalogPage) => void; // set when the catalog's request starts
  const chat = new NativeChat({ file: path.join(dir, 'chats.json'), context: () => '', emit: () => {}, transport: () => ({ initialize: async () => {}, close() {}, request: () => new Promise<CatalogPage>(resolve => { resolveCatalog = resolve; }) }) as FakeTransport as NativeChatTransport });
  try {
    const s = chat.create(dir);
    const pending = chat.configure(s.id, 'test-model', 'high');
    await new Promise<void>(resolve => setImmediate(resolve));
    s.state = 'working';
    resolveCatalog({ data: [{ model: 'test-model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] });
    await pending;
    assert.equal(s.model, undefined);
    assert.equal(s.pendingSettings!.model, 'test-model'); // configure queued it during the turn
  } finally { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('shared views keep the same thread, running turn, approvals, and one terminal', async () => {
  const dir = tmpDir('radial-chat-views-');
  const calls: Call[] = [], started: NativeStart[] = [], killed: string[] = [], history: NativeChatItemEntry[] = [];
  const terminal: FakeTerminal<'kill'> & FakeList<'id' | 'alive'> = { start: async (cwd, options) => { started.push(options); return 'pty-1'; }, list: async () => [{id:'pty-1',alive:true}], kill: id => killed.push(id) };
  const chat = new NativeChat({ file:path.join(dir,'chats.json'), context:()=>'', emit:()=>{}, terminal: terminal as NativeChatTerminal, transport: options => ({
    endpoint:'unix:///test/control.sock', bin:'/test/codex', initialize:async()=>{}, close(){}, write: data => calls.push(data),
    request:async(method,params)=>{ calls.push({method,params}); if(method.startsWith('thread/') && method !== 'thread/items/list') return {thread:{id:'shared-thread'},model:'test-model',reasoningEffort:'high'}; if(method==='thread/items/list') return {data:history,nextCursor:null}; return {turn:{id:'turn-1'}}; },
  }) as FakeTransport<'initialize' | 'close' | 'write' | 'endpoint' | 'bin'> as NativeChatTransport });
  try {
    const s = chat.create(dir); await chat.send(s.id,'Context + original task','original task');
    const user={id:'cli-user',type:'userMessage',content:[{type:'text',text:'Context + original task'}]};
    chat.event(s,{method:'item/completed',params:{threadId:s.threadId,item:user}}); history.push({item:user});
    chat.requestFromCli(s,{id:71,method:'item/commandExecution/requestApproval',params:{threadId:s.threadId,command:'npm test'}});
    await Promise.all([chat.setView(s.id,'terminal'),chat.setView(s.id,'terminal')]);
    assert.equal(started.length,1);
    assert.deepEqual(started[0].command.args.slice(0,4),['resume','shared-thread','--remote','unix:///test/control.sock']);
    assert.ok(!started[0].command.args.includes('-a'),'remote resume must inherit the thread permissions');
    assert.equal(s.state,'approval'); assert.equal(s.turnId,'turn-1');
    assert.ok(!calls.some(c=>c.method==='turn/interrupt'));
    await assert.rejects(chat.send(s.id,'Not allowed'),/Switch this conversation/);
    assert.throws(()=>chat.respond(s.id,{requestId:71,decision:'accept'}),/active conversation view/);
    assert.equal(chat.acceptsTerminalInput('pty-1'),true);
    assert.equal(chat.terminalInputBlock('pty-1'),null,'an answer to its CLI\'s question can go in');
    chat.handoffs.set(s.id,Promise.resolve(s));
    assert.equal(chat.terminalInputBlock('pty-1'),'switching','mid-switch, it says so');
    chat.handoffs.delete(s.id);
    await chat.setView(s.id,'chat');
    assert.equal(s.messages.length,1);assert.equal(s.messages[0].text,'original task');
    assert.equal(chat.acceptsTerminalInput('pty-1'),false);
    assert.equal(chat.terminalInputBlock('pty-1'),'chat-view','in Chat view, it says why it takes no keys');
    assert.equal(chat.terminalInputBlock('pty-other'),null,'a terminal no chat runs in takes keys');
    assert.equal(s.approval!.id,71); // still waiting
    chat.event(s,{method:'serverRequest/resolved',params:{threadId:s.threadId,requestId:71}});
    assert.equal(s.approval,null);assert.equal(s.state,'working');
    await chat.setView(s.id,'terminal');assert.equal(started.length,1);
    chat.event(s,{method:'thread/settings/updated',params:{threadId:s.threadId,threadSettings:{model:'another-model',effort:'medium'}}});
    assert.equal(s.model,'another-model');assert.equal(s.effort,'medium');
    await chat.archive(s.id); assert.deepEqual(killed,['pty-1']);
  } finally { chat.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('history hydration keeps streamed updates without replaying duplicated deltas', async () => {
  const dir=tmpDir('radial-chat-stream-');
  const chat=new NativeChat({file:path.join(dir,'chats.json'),context:()=>'',emit:()=>{}});
  try {
    const s=chat.create(dir);s.threadId='thread';s.messages=[{id:'answer',role:'assistant',text:'Hello'}];
    let finish!: (page: NativeChatHistoryPage) => void; // set when hydrate asks for the history
    const pending=chat.hydrate(s,{request:()=>new Promise<NativeChatHistoryPage>(resolve=>finish=resolve)} as Pick<FakeTransport, 'request'> as Pick<NativeChatTransport, 'request'>);
    chat.event(s,{method:'item/agentMessage/delta',params:{threadId:'thread',itemId:'answer',delta:' world'}});
    chat.event(s,{method:'item/completed',params:{threadId:'thread',item:{id:'new-tool',type:'commandExecution',command:'pwd',status:'completed'}}});
    finish({data:[{item:{id:'answer',type:'agentMessage',text:'Hello world'}}],nextCursor:null});
    await pending;
    assert.equal(s.messages[0].text,'Hello world'); assert.equal(s.messages.length,2);
  } finally {chat.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('history compatibility reads only matching rollout items and excludes system instructions', async () => {
  const {readRollout}=require('../src/main/nativeChat') as typeof import('../src/main/nativeChat');
  const dir=tmpDir('radial-rollout-'),file=path.join(dir,'thread.jsonl');
  try {
    fs.writeFileSync(file,[
      {type:'session_meta',payload:{id:'thread'}},
      {type:'response_item',payload:{role:'developer',content:[{text:'private instructions'}]}},
      {type:'event_msg',payload:{type:'item_completed',turn_id:'turn',item:{id:'user',type:'UserMessage',content:[{type:'text',text:'Task'}]}}},
      {type:'event_msg',payload:{type:'item_completed',turn_id:'turn',item:{id:'answer',type:'AgentMessage',content:[{type:'Text',text:'Done'}]}}},
      {type:'event_msg',payload:{type:'item_completed',turn_id:'turn',item:{id:'command',type:'CommandExecution',command:'pwd',aggregated_output:'repo',status:'Completed'}}},
    ].map(r=>JSON.stringify(r)).join('\n')+'\n{"partial":');
    const items=await readRollout({id:'thread',path:file});
    assert.equal(items.length,3);assert.equal(itemMessage(items[1].item)!.text,'Done');assert.equal(itemMessage(items[2].item)!.detail,'repo'); // an answer and a command render as messages
    await assert.rejects(readRollout({id:'other-thread',path:file}),/different conversation/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('opening Terminal before the first prompt lets that CLI create the canonical thread', async () => {
  const dir=tmpDir('radial-empty-view-');const calls: string[]=[];let command: NativeStart['command'];
  const chat=new NativeChat({file:path.join(dir,'chats.json'),context:()=>'',emit:()=>{},terminal:{start:async(_,opts)=>{command=opts.command;return 'pty';},kill(){}} as FakeTerminal<'kill'> as NativeChatTerminal,transport:()=>({endpoint:'unix:///test',bin:'/test/codex',initialize:async()=>{},close(){},request:async(method)=>{if(method==='config/read')return {config:{}};calls.push(method);return {data:[]};}}) as FakeTransport<'initialize' | 'close' | 'endpoint' | 'bin'> as NativeChatTransport});
  try {
    const s=chat.create(dir);await chat.setView(s.id,'terminal');
    assert.equal(command!.args[0],'--remote');assert.equal(calls.length,0); // set by the stand-in's start, which setView just called
    await assert.rejects(chat.setView(s.id,'chat'),/Finish opening/);
    chat.event(s,{method:'thread/started',params:{thread:{id:'created-by-tui'}}});
    await chat.setView(s.id,'chat');assert.equal(s.threadId,'created-by-tui');assert.equal(s.viewMode,'chat');
  } finally {chat.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('a failed Terminal-first launch leaves Chat able to start its conversation', async () => {
  const dir = tmpDir('radial-view-failure-');
  let opened = 0, closed = 0;
  const chat = new NativeChat({ file: path.join(dir, 'chats.json'), context: () => '', emit: () => {},
    terminal: { start: async () => { throw new Error('PTY unavailable'); }, kill() {} } as FakeTerminal<'kill'> as NativeChatTerminal,
    transport: () => { opened++; return { endpoint: 'unix:///test', bin: '/test/codex', initialize: async () => {}, close() { closed++; },
      request: async method => method === 'thread/start' ? { thread: { id: 'recovered-thread' } } : { turn: { id: 'turn' } } } as FakeTransport<'initialize' | 'close' | 'endpoint' | 'bin'> as NativeChatTransport; },
  });
  try {
    const s = chat.create(dir);
    await assert.rejects(chat.setView(s.id, 'terminal'), /PTY unavailable/);
    assert.equal(s.awaitingTerminalThread, false);
    assert.equal(closed, 1);
    await chat.send(s.id, 'Continue in Chat');
    assert.equal(opened, 2);
    assert.equal(s.threadId, 'recovered-thread');
    assert.equal(s.state, 'working');
  } finally { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('permission changes persist per chat and reach the next turn and terminal without resuming an empty rollout', async () => {
  const dir = tmpDir('radial-permissions-');
  const calls: SentRequest[] = [], launches: NativeStart[] = [];
  const chat = new NativeChat({ file: path.join(dir, 'chats.json'), context: () => '', emit: () => {},
    terminal: { list: async () => [], start: async (cwd, options) => { launches.push(options); return 'terminal'; }, kill: () => {} } as FakeTerminal<'list' | 'kill'> as NativeChatTerminal,
    transport: () => ({ endpoint: 'unix:///fixture', bin: 'codex', initialize: async () => {}, close: () => {}, request: async (method, params) => { if (method === 'config/read') return { config: {} }; calls.push({ method, params }); return method.startsWith('thread/') ? { thread: { id: 'same-thread' } } : { turn: { id: 'turn' } }; } }) as FakeTransport<'initialize' | 'close' | 'endpoint' | 'bin'> as NativeChatTransport,
  });
  try {
    const s = chat.create(dir), other = chat.create(dir);
    await chat.update(s.id, { permissionMode: 'read-only' });
    await chat.send(s.id, 'Inspect');
    assert.equal(calls[0].params.sandbox, 'read-only');
    assert.equal(calls[1].params.sandboxPolicy!.type, 'readOnly'); // the turn carries its sandbox policy
    await chat.update(s.id, { permissionMode: 'full' });
    assert.equal(s.permissionMode, 'read-only');
    assert.equal(s.pendingSettings!.permissionMode, 'full'); // queued during the turn
    chat.event(s, { method: 'turn/completed', params: { turn: {} } });
    await chat.update(s.id, { permissionMode: 'full' });
    assert.equal(calls.filter(call => call.method === 'thread/resume').length, 0);
    assert.equal(s.threadId, 'same-thread');
    assert.equal(other.permissionMode, undefined);
    await chat.send(s.id, 'Continue');
    assert.equal(calls.at(-1)!.params.sandboxPolicy!.type, 'dangerFullAccess'); // the turn just sent, with its sandbox policy
    assert.equal(calls.at(-1)!.params.approvalPolicy, 'never');
    chat.event(s, { method: 'turn/completed', params: { turn: {} } });
    await chat.setView(s.id, 'terminal');
    assert.ok(!launches[0].command.args.includes('--sandbox'), 'remote terminal inherits permissions through the shared transport');
    assert.throws(() => chat.update(s.id, { permissionMode: 'workspace' }), /Switch to Chat/);
    chat.event(s, { method: 'thread/settings/updated', params: { threadSettings: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } } } });
    assert.equal(s.permissionMode, 'read-only', 'terminal setting changes update the chat choice');
    chat.close();
    const reopened = new NativeChat({ file: chat.file, context: () => '', emit: () => {} });
    assert.equal(reopened.get(s.id).permissionMode, 'read-only');
    reopened.close();
  } finally { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('provider permissions close the idle adapter before resuming and reject unsupported modes', async () => {
  const dir = tmpDir('radial-provider-permissions-');
  const chat = new NativeChat({ file: path.join(dir, 'chats.json'), context: () => '', emit: () => {} });
  try {
    for (const engine of ['claude', 'cursor'] as const) {
      const s = chat.create(dir, false, engine); s.threadId = 'existing'; let stopped = false;
      chat.live.set(s.id, { shutdown: async () => { stopped = true; } } satisfies Partial<NativeChatTransport> as NativeChatTransport); // a stand-in idle adapter: setPermissions only shuts it down
      await chat.update(s.id, { permissionMode: 'plan' });
      assert.equal(stopped, true); assert.equal(chat.live.has(s.id), false);
      assert.equal(s.threadId, 'existing'); assert.equal(s.permissionMode, 'plan');
      // @ts-expect-error -- 'unknown' on purpose: setPermissions' permissions.validate refuses a mode the provider doesn't have
      assert.throws(() => chat.update(s.id, { permissionMode: 'unknown' }), /not supported/);
    }
  } finally { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('closed conversations remain in history and reopen with their native thread and messages after restart', async () => {
  const dir = tmpDir('radial-closed-history-');
  const options = { file: path.join(dir, 'chats.json'), context: () => '', emit: () => {} };
  let chat = new NativeChat(options);
  try {
    const saved: Pick<ChatSession, 'id' | 'threadId' | 'messages'>[] = [];
    for (const engine of ['codex', 'claude', 'cursor'] as const) {
      const s = chat.create(dir, false, engine);
      s.threadId = engine + '-original'; s.messages = [{ id: 'answer', role: 'assistant', text: 'Saved reply' }];
      await chat.archive(s.id); saved.push({ id: s.id, threadId: s.threadId, messages: s.messages });
    }
    assert.equal(chat.list(dir).length, 0); assert.equal(chat.list(undefined, true).length, 3);
    chat.close(); chat = new NativeChat(options);
    assert.equal(chat.list(dir).length, 0); assert.equal(chat.list(dir, true).length, 3);
    for (const s of saved) {
      const restored = chat.update(s.id, { archived: false }) as ChatSession; // reopening answers the chat itself: only provider and permission changes answer a promise
      assert.equal(restored.threadId, s.threadId); assert.deepEqual(restored.messages, s.messages);
      assert.equal(restored.queuePaused, true); assert.equal(restored.viewMode, 'chat');
    }
    assert.equal(chat.list(dir).length, 3);
  } finally { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('new chats use provider names, then name from the first prompt without replacing manual titles', async () => {
  const dir = tmpDir('radial-chat-titles-');
  const options = { file: path.join(dir, 'chats.json'), context: () => '', emit: () => {}, transport: () => ({ initialize: async () => {}, close() {}, request: async method => method.startsWith('thread/') ? { thread: { id: 'native-thread' } } : { turn: { id: 'turn' } } }) as FakeTransport as NativeChatTransport };
  let chat = new NativeChat(options);
  try {
    for (const [engine, label] of Object.entries({ codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor' }) as [ChatEngine, string][]) { // its keys are the engines
      const s = chat.create(dir, false, engine); assert.equal(s.title, label);
      await chat.send(s.id, 'Review the navigation'); assert.equal(s.title, 'Review the navigation');
      chat.event(s, { method: 'turn/completed', params: { turn: {} } });
      await chat.send(s.id, 'Different follow up'); assert.equal(s.title, 'Review the navigation');
      const terminal = chat.create(dir, false, engine);
      chat.event(terminal, { method: 'item/completed', params: { item: { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Review the footer' }] } } });
      assert.equal(terminal.title, 'Review the footer');
      const manual = chat.create(dir, false, engine); chat.update(manual.id, { title: label });
      await chat.send(manual.id, 'Do not rename this'); assert.equal(manual.title, label);
    }
    const legacy = chat.create(dir); legacy.title = 'New chat'; delete legacy.titleAuto;
    chat.close(); chat = new NativeChat(options);
    assert.equal(chat.get(legacy.id).title, 'Codex');
    await chat.send(legacy.id, 'Review the old chat'); assert.equal(chat.get(legacy.id).title, 'Review the old chat');
  } finally { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('explicit Full access clears current CLI tool approvals and covers the rest of the turn for Claude and Codex', async () => {
  for (const engine of ['claude', 'codex'] as const) {
    const dir = tmpDir('radial-full-access-');
    const writes: NativeChatReply[] = [], calls: SentRequest[] = [];
    let opens = 0;
    const chat = new NativeChat({ file: path.join(dir, 'chats.json'), context: () => '', emit: () => {},
      transport: () => { opens++; return { initialize: async () => {}, close() {}, shutdown: async () => {}, write: m => writes.push(m), request: async (method, params) => { if (method === 'config/read') return { config: {} }; calls.push({ method, params }); return method.startsWith('thread/') ? { thread: { id: 'same-native-thread' } } : { turn: { id: 'same-turn' } }; } } as FakeTransport<'initialize' | 'close' | 'shutdown' | 'write'> as NativeChatTransport;
      },
    });
    try {
      const s = chat.create(dir, false, engine), other = chat.create(dir, false, engine);
      await chat.send(s.id, 'Make the requested changes');
      const ask = (id: string, method = 'item/commandExecution/requestApproval', params: NativeChatApprovalParams = {}) => chat.requestFromCli(s, { id, method, params });
      ask('command'); ask('question', 'item/tool/requestUserInput', { questions: [{ id: 'choice', question: 'Which page?' }] }); ask('file', 'item/fileChange/requestApproval');
      assert.equal(writes.length, 0);
      await chat.setPermissions(s.id, 'full');
      assert.deepEqual(writes.map(m => m.id), ['command', 'file']);
      assert.equal(s.approval!.id, 'question', 'Full access never answers a real question'); // still waiting
      assert.equal(s.state, 'approval'); assert.equal(s.threadId, 'same-native-thread'); assert.equal(opens, 1);
      ask('next-command');
      assert.deepEqual(writes.at(-1), { id: 'next-command', result: { decision: 'accept' } });
      ask('restricted', 'item/commandExecution/requestApproval', { availableDecisions: ['decline'] });
      assert.equal(writes.length, 3, 'native restrictions are not overridden');
      assert.equal(s.approvals![0].id, 'restricted'); // waiting behind the question
      assert.equal(other.pendingSettings, undefined, 'permission scope stays in the selected chat');
      await chat.setPermissions(s.id, engine === 'codex' ? 'workspace' : 'default'); ask('manual-again');
      assert.equal(writes.length, 3, 'switching back stops automatic approval immediately');
      await chat.setPermissions(s.id, 'full');
      assert.equal(writes.at(-1)!.id, 'manual-again'); // just answered
      s.viewMode = 'terminal'; ask('terminal-owned');
      assert.notEqual(writes.at(-1)!.id, 'terminal-owned', 'the native terminal owns its own approvals');
      s.viewMode = 'chat';
      chat.event(s, { method: 'turn/completed', params: { turn: { id: 'same-turn' } } });
      await chat.send(s.id, 'Continue');
      assert.equal(s.permissionMode, 'full'); assert.equal(s.pendingSettings, null); assert.equal(s.threadId, 'same-native-thread');
      if (engine === 'codex') assert.equal(calls.at(-1)!.params.approvalPolicy, 'never'); // the turn just sent
      else assert.equal(opens, 2, 'Claude reconnects the same native thread with its new permission flags');
    } finally { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('starting a chat with no project open asks for one instead of a raw path error', () => {
  const dir = tmpDir('radial-chat-no-project-');
  const chat = new NativeChat({ file: path.join(dir, 'chats.json'), context: () => '', emit: () => {} });
  try {
    // The window passes none from Home before initHomeTab, or with no project open.
    for (const repoDir of [undefined, null]) assert.throws(() => chat.create(repoDir), { message: 'Open a local project first.' });
    assert.throws(() => chat.create('relative/folder'), { message: 'Open a local project first.' });
    assert.equal(chat.list().length, 0);
  } finally { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a preview save keeps when the chat was selected, quietly, even when the chat has no view of its own', () => {
  const dir = tmpDir('radial-chat-preview-');
  let events = 0;
  const options = { file: path.join(dir, 'chats.json'), context: () => '', emit: () => { events++; } };
  const chat = new NativeChat(options);
  try {
    const s = chat.create(dir), revision = s.revision, sent = events;
    // In shared preview mode the window saves a chat with no view of its own: nativeChat:savePreview passes preview undefined.
    chat.update(s.id, { preview: undefined, previewSelectedAt: 1234 });
    assert.equal(s.previewSelectedAt, 1234);
    assert.equal(s.revision, revision, 'a preview save is not a change to the conversation'); assert.equal(events, sent, 'and sends the window no event');
    const view = { route: '/about' };
    chat.update(s.id, { preview: view, previewSelectedAt: 5678 });
    assert.deepEqual(s.preview, view); assert.equal(s.previewSelectedAt, 5678);
    chat.update(s.id, { preview: undefined, previewSelectedAt: 9012 });
    assert.deepEqual(s.preview, view, 'a save without a view keeps the one the chat has'); assert.equal(s.previewSelectedAt, 9012);
    assert.equal(s.revision, revision); assert.equal(events, sent);
    chat.close();
    const reopened = new NativeChat(options);
    assert.equal(reopened.get(s.id).previewSelectedAt, 9012); reopened.close();
  } finally { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unstarted chat can change providers without losing its identity or carrying provider settings', async () => {
  const dir = tmpDir('radial-provider-picker-');
  const chat = new NativeChat({file: path.join(dir, 'chats.json'), context: () => '', emit: () => {}});
  try {
    const s = chat.create(dir), id = s.id;
    Object.assign(s, {model:'old-model',modelName:'Old model',effort:'high',permissionMode:'full',pendingSettings:{model:'pending'},resolvedProvider:'openai'});
    await chat.update(id, {engine:'claude'});
    assert.equal(s.id, id); assert.equal(s.engine, 'claude'); assert.equal(s.title, 'Claude Code');
    for (const field of ['model','modelName','effort','permissionMode','pendingSettings','resolvedProvider'] as const) assert.equal(s[field], undefined);
    await chat.update(id, {title:'My draft'}); await chat.update(id, {engine:'cursor'});
    assert.equal(s.title, 'My draft'); assert.equal(chat.list().length, 1);
    // @ts-expect-error -- 'shell' on purpose: setProvider refuses an engine without a chat provider (LABELS)
    assert.throws(() => chat.update(id, {engine:'shell'}), /Terminal/);
    for (const patch of [{messages:[{role:'user',text:'Sent'}]}, {threadId:'native-history'}, {state:'working'}, {terminalId:'pty'}, {providerPersisted:true}, {lastSubmittedAt:1}, {archived:true}]) {
      const empty = chat.create(dir); Object.assign(empty, patch);
      assert.throws(() => chat.update(empty.id, {engine:'claude'}), /new chat/);
      assert.equal(empty.engine, 'codex');
    }
    chat.close();
    const reopened = new NativeChat({file:path.join(dir,'chats.json'), context:()=>'', emit:()=>{}});
    assert.equal(reopened.get(id).engine,'cursor');reopened.close();
  } finally { chat.close(); fs.rmSync(dir, {recursive:true,force:true}); }
});

test('a chat nobody used is deleted with its CLI; one with anything in it is kept', async () => {
  const dir = tmpDir('radial-chat-discard-');
  const options = { file: path.join(dir, 'chats.json'), context: () => '', emit: (event: ChatEvent) => { events.push(event); } };
  const events: ChatEvent[] = [], killed: string[] = [];
  let closed = 0;
  const chat = new NativeChat({ ...options, terminal: { start: async () => 'pty', kill: (id: string) => { killed.push(id); } } as FakeTerminal<'kill'> as NativeChatTerminal });
  try {
    // A project's first chat, its CLI started in Terminal and nothing done in it yet.
    const first = chat.create(dir, false, 'claude');
    first.terminalId = 'pty-first'; first.threadId = 'native-session';
    chat.live.set(first.id, { close: () => { closed++; } } satisfies Partial<NativeChatTransport> as NativeChatTransport); // a stand-in CLI: discard only closes it
    await chat.write(first.id);
    assert.equal(await chat.discard(first.id), true);
    assert.throws(() => chat.get(first.id), /not found/);
    assert.deepEqual(killed, ['pty-first']); assert.equal(closed, 1); assert.equal(chat.live.has(first.id), false);
    assert.equal(fs.existsSync(path.join(chat.dir, first.id + '.json')), false, 'its file is gone');
    assert.equal(events.at(-1)!.id, first.id); assert.equal(events.at(-1)!.discarded, true, 'the window is told to forget it');
    assert.equal(await chat.discard(first.id), true, 'a chat already gone stays gone');
    // Anything in a chat keeps it: a message, a name, a pin, keep awake, typed or queued input, a turn.
    const uses: Partial<ChatSession>[] = [{ messages: [{ id: 'sent', role: 'user', text: 'Fix the hero' }] }, { lastSubmittedAt: 1 }, { titleAuto: false }, { recentPinnedAt: 1 }, { keepAwake: true }, { terminalHasInput: true }, { queue: [{ id: 'later', text: 'Later', displayText: 'Later', attachments: [] }] }, { state: 'working' }, { archived: true }];
    for (const use of uses) {
      const used = chat.create(dir, false, 'claude'); Object.assign(used, use, { terminalId: 'pty-used' });
      assert.equal(await chat.discard(used.id), false, JSON.stringify(use));
      assert.equal(chat.get(used.id).id, used.id);
    }
    assert.deepEqual(killed, ['pty-first'], 'a kept chat keeps its CLI');
    chat.close();
    const reopened = new NativeChat(options);
    assert.throws(() => reopened.get(first.id), /not found/, 'it does not come back after a restart');
    assert.equal(reopened.list(dir, true).length, uses.length);
    reopened.close();
  } finally { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
