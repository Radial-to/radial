import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { NativeChatModelPage, NativeChatTerminal, NativeChatTransport, NativeChatTransportOptions } from '../src/main/nativeChat';
import type { InteractiveOptions } from '../src/main/chat/interactive';
import type { ClaudeRecord, ProviderEngine, ProviderEvent, ProviderInputPart, ProviderItemEntry, ProviderMethod, ProviderRequest, ProviderResults, ProviderUserContent, RequestId } from '../src/main/chat/providers';
import type { ChatSession, ChatView } from '../src/shared/radialApi';
import type { FakeList, FakeTerminal, FakeTransport, Interactive, NativeStart, PtyWrite } from './support/nativeChat';
import { tmpDir } from './support/tmp';
import { screen, screens } from './fixtures/cliScreens';
const fs = require('fs') as typeof import('fs'), os = require('os') as typeof import('os'), path = require('path') as typeof import('path');
const { ClaudeTransport, CursorTransport, claudeHistory } = require('../src/main/chat/providers') as typeof import('../src/main/chat/providers');
const { NativeChat } = require('../src/main/nativeChat') as typeof import('../src/main/nativeChat');
const { InteractiveTransport } = require('../src/main/chat/interactive') as typeof import('../src/main/chat/interactive');
/** A provider adapter: Claude Code's or Cursor's. */
type Adapter = InstanceType<typeof ClaudeTransport> | InstanceType<typeof CursorTransport>;
/** What an adapter keeps for each CLI request waiting on an answer (its permissions). */
type PendingRequest = Parameters<Adapter['permissions']['set']>[1];
/** A call an adapter waits on (its pending). */
type PendingCall = Parameters<Adapter['pending']['set']>[1];
/**
 * A line an adapter wrote to its CLI (raw), with the fields these tests read. Each
 * test knows which it wrote: a Claude user message (message), a Claude control
 * answer (response), or a Cursor JSON-RPC answer (result).
 */
interface RawLine {
  message?: { content: ProviderUserContent[] };
  response?: { response: { behavior: 'allow' | 'deny'; updatedInput?: { answers?: Record<string, string>; [field: string]: unknown } } };
  result?: unknown;
}
/** A call an adapter made to its CLI (call), as the stand-in records it. */
interface AdapterCall { method: string; params?: Record<string, unknown> }
/** A block of the prompt Cursor's adapter sends (session/prompt): text, or an image when Cursor takes them. providers.ts's AcpPromptBlock, restated here while that module doesn't export it. */
type PromptBlock = { type: 'text'; text: string } | { type: 'image'; mimeType: string | undefined; data: string };

const nativeId = '12345678-1234-1234-1234-123456789abc';
function nativeFixture(t: TestContext, engine: ProviderEngine) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const dir = tmpDir('radial-native-view-');
  const starts: NativeStart[] = [], writes: PtyWrite[] = [], kills: string[] = [], transports: Interactive[] = [];
  const terminal: FakeTerminal<'write' | 'kill'> & FakeList<'id' | 'alive' | 'meta'> = {
    start: async (_cwd, options) => { starts.push(options); return 'pty'; },
    list: async () => starts.length ? [{ id: 'pty', alive: true, meta: starts[0].meta }] : [],
    write: (id, data) => writes.push({ id, data }),
    kill: id => kills.push(id),
  };
  const chat = new NativeChat({ file: path.join(dir, 'chats.json'), context: () => '', emit() {}, terminal: terminal as NativeChatTerminal,
    transport: options => {
      const keys = { RADIAL_USERDATA: dir, ['RADIAL_CHAT_TEST_' + engine.toUpperCase()]: process.execPath };
      const previous = Object.fromEntries(Object.keys(keys).map(key => [key, process.env[key]]));
      Object.assign(process.env, keys);
      let transport: Interactive;
      try { transport = new InteractiveTransport({ ...options, env: { ...options.env, CURSOR_CONFIG_DIR: dir } } as InteractiveOptions); } // this fixture's chats are Claude or Cursor ones, which connect gives their session, the terminal and runtimeRoot
      finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
      transport.transcript = path.join(dir, 'transcript.jsonl');
      transports.push(transport); return transport;
    },
  });
  const session = chat.create(dir, false, engine); session.threadId = nativeId;
  t.after(() => { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, chat, session, terminal, starts, writes, kills, transports };
}

function adapter<T extends Adapter>(Type: { prototype: T }) {
  const transport = Object.create(Type.prototype) as T, events: ProviderEvent[] = [], requests: ProviderRequest[] = [], writes: RawLine[] = []; // an adapter without its constructor (no CLI): the state it needs is set just below
  Object.assign(transport, { items: new Map<string, ProviderItemEntry>(), permissions: new Map<RequestId, PendingRequest>(), pending: new Map<string, PendingCall>(), historySeq: 0, onEvent: (e: ProviderEvent) => events.push(e), onRequest: (r: ProviderRequest) => requests.push(r), raw: (m: RawLine) => writes.push(m) });
  return { transport, events, requests, writes };
}
test('provider adapters send images only in supported prompt formats', async () => {
  const dir = tmpDir('radial-provider-image-');
  try {
    const file = path.join(dir, 'reference.png'); fs.writeFileSync(file, Buffer.from([1, 2, 3]));
    const input: [Extract<ProviderInputPart, { type: 'text' }>, Extract<ProviderInputPart, { type: 'localImage' }>] = [{ type: 'text', text: 'Review attached reference.png' }, { type: 'localImage', path: file }];
    const claude = adapter(ClaudeTransport); claude.transport.threadId = 'same-thread';
    await claude.transport.request('turn/start', { input });
    assert.deepEqual(claude.writes[0].message!.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } }); // the user message turn/start wrote
    for (const supported of [false, true]) {
      const { transport } = adapter(CursorTransport), calls: AdapterCall[] = [];
      transport.threadId = 'same-thread'; transport.init = { agentCapabilities: { promptCapabilities: { image: supported } } };
      transport.call = async (method, params) => { calls.push({ method, params }); return {}; };
      await transport.request('turn/start', { input });
      const prompt = calls.find(call => call.method === 'session/prompt')!.params!.prompt as [Extract<PromptBlock, { type: 'text' }>, ...PromptBlock[]]; // turn/start sends the prompt, which starts with the input's text
      assert.equal(prompt[0].text, input[0].text);
      assert.equal(prompt.length, supported ? 2 : 1);
      if (supported) assert.deepEqual(prompt[1], { type: 'image', mimeType: 'image/png', data: 'AQID' });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('Claude approvals require an explicit answer and preserve tool input', () => {
  const {transport,requests,writes}=adapter(ClaudeTransport);
  transport.receive({type:'control_request',request_id:'approval',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'git status'}}});
  assert.equal(writes.length,0);assert.equal(requests.length,1);
  transport.write({id:'approval',result:{decision:'accept'}});
  assert.deepEqual(writes[0].response!.response,{behavior:'allow',updatedInput:{command:'git status'}}); // write answered with a control response
  transport.receive({type:'control_request',request_id:'denied',request:{subtype:'can_use_tool',tool_name:'Write',input:{file_path:'index.html'}}});
  transport.write({id:'denied',result:{decision:'decline'}});
  assert.equal(writes[1].response!.response.behavior,'deny');
});
test('Claude stream records without an id are skipped, as history skips them, rather than shown under no id', () => {
  const { transport, events } = adapter(ClaudeTransport);
  // What names an item is optional on the wire: a user record's uuid, an assistant message's API id.
  transport.receive({ type: 'user', message: { content: 'No uuid' } });
  transport.receive({ type: 'assistant', message: { content: [{ type: 'text', text: 'No message id' }, { type: 'tool_use', id: 'tool-0', name: 'Read' }] } });
  transport.receive({ type: 'user', uuid: 'user-1', message: { content: 'Named' } });
  transport.receive({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'Reply' }] } });
  assert.deepEqual([...transport.items.keys()], ['tool-0', 'user-1', 'msg-1']);
  assert.equal(events.length, 3);
});
test('Claude tool questions return the answer without dropping the original input', () => {
  const {transport,requests,writes}=adapter(ClaudeTransport);
  transport.receive({type:'control_request',request_id:'q',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{questions:[{question:'Which color?',options:[{label:'Green'}]}]}}});
  assert.equal(requests[0].method,'item/tool/requestUserInput');
  transport.write({id:'q',result:{answers:{0:{answers:['Green']}}}});
  assert.deepEqual(writes[0].response!.response.updatedInput!.answers,{'Which color?':'Green'}); // write allowed the tool with the answers
});
test('Cursor uses provider permission option IDs and never widens an allow-once choice', () => {
  const {transport,writes}=adapter(CursorTransport);
  transport.receive({id:17,method:'session/request_permission',params:{toolCall:{title:'Edit index.html'},options:[{optionId:'once',kind:'allow_once'},{optionId:'always',kind:'allow_always'}]}});
  assert.equal(writes.length,0);
  transport.write({id:17,result:{decision:'accept'}});
  assert.deepEqual(writes[0].result,{outcome:{outcome:'selected',optionId:'once'}});
  transport.receive({id:18,method:'session/request_permission',params:{toolCall:{title:'Edit'},options:[{optionId:'always',kind:'allow_always'}]}});
  transport.write({id:18,result:{decision:'accept'}});
  assert.deepEqual(writes[1].result,{outcome:{outcome:'cancelled'}});
});
test('Cursor answers a question that came without options, as it showed it, instead of throwing', () => {
  const {transport,writes}=adapter(CursorTransport);
  transport.receive({id:21,method:'cursor/ask_question',params:{questions:[{id:'note',prompt:'Anything else?'},{id:'page',prompt:'Which page?',options:[{id:'home',label:'Home'}]}]}});
  transport.write({id:21,result:{answers:{page:{answers:['Home']}}}});
  assert.deepEqual(writes[0].result,{outcome:{outcome:'answered',answers:[{questionId:'note',selectedOptionIds:[]},{questionId:'page',selectedOptionIds:['home']}]}});
});
test('Cursor loads history without treating replayed user messages as a newly submitted task', () => {
  const {transport,events}=adapter(CursorTransport);transport.loadingHistory=true;
  transport.update({sessionUpdate:'user_message_chunk',content:{type:'text',text:'Earlier task'}});
  transport.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Earlier reply'}});
  assert.equal(events.length,0);assert.equal(transport.items.size,2);
  transport.loadingHistory=false;transport.lastRole=null;
  transport.update({sessionUpdate:'user_message_chunk',content:{type:'text',text:'New task'}});
  assert.equal(events.length,1);assert.equal((events[0] as Extract<ProviderEvent, { method: 'item/completed' }>).params.item.id,'cursor-message-3'); // a message chunk reports its item as completed
});
test('Claude history resolves symlinked projects and excludes unrelated/system records', async () => {
  const dir=tmpDir('radial-claude-history-');const prev=process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR=dir;const repo=path.join(dir,'repo');fs.mkdirSync(repo);fs.symlinkSync(repo,path.join(dir,'linked'));
    const project=path.join(dir,'projects',fs.realpathSync(repo).replace(/[^a-zA-Z0-9]/g,'-'));fs.mkdirSync(project,{recursive:true});
    const id='12345678-1234-1234-1234-123456789abc';
    fs.writeFileSync(path.join(project,id+'.jsonl'),([
      {type:'system',sessionId:id,message:{content:'internal'}},
      {type:'user',sessionId:'another-thread',uuid:'wrong',message:{content:'wrong'}},
      {type:'user',sessionId:id,uuid:'user',message:{content:'Task'}},
      {type:'assistant',sessionId:id,message:{id:'answer',content:[{type:'text',text:'Done'}]}},
    ] satisfies ClaudeRecord[]).map(JSON.stringify as (record: ClaudeRecord) => string).join('\n')); // map also hands JSON.stringify the index and the array, which it ignores (a number replacer, an array indent)
    const items=await claudeHistory(path.join(dir,'linked'),id);assert.equal(items.length,2);assert.equal(items[1].item.text,'Done');
  } finally {if(prev===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=prev;fs.rmSync(dir,{recursive:true,force:true});}
});
test('view changes keep the native draft and reject Chat sends without writing to the CLI', async t => {
  const f = nativeFixture(t, 'cursor'), s = f.session;
  await f.chat.setView(s.id, 'terminal');
  const transport = f.chat.live.get(s.id);
  f.chat.recordTerminalInput('pty', 'Unsent terminal draft');
  assert.equal(s.terminalHasInput, true);
  await f.chat.setView(s.id, 'chat');
  assert.equal(s.viewMode, 'chat');
  await assert.rejects(f.chat.send(s.id, 'Do not replace my draft'), /unsent Terminal draft/);
  assert.equal(s.messages.length, 0);
  assert.equal(s.terminalHasInput, true);
  assert.equal(s.threadId, nativeId);
  assert.equal(s.terminalId, 'pty');
  assert.equal(f.chat.live.get(s.id), transport);
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.kills, []);
});

test('Cursor store handoff shares one database and refuses to replace independent history', async () => {
  const { linkCursorStore } = require('../src/main/chat/providers') as typeof import('../src/main/chat/providers');
  const root = tmpDir('radial-cursor-store-');
  try {
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
    const id = '12345678-1234-1234-1234-123456789abc';
    const source = path.join(root, 'acp-sessions', id); fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'meta.json'), JSON.stringify({schemaVersion:1,cwd:fs.realpathSync(repo)}));
    fs.writeFileSync(path.join(source, 'store.db'), 'SQLite format 3\0history');
    await linkCursorStore(repo, id, root);
    const bucket = fs.readdirSync(path.join(root, 'chats'))[0];
    const target = path.join(root, 'chats', bucket, id);
    assert.equal(fs.realpathSync(target), fs.realpathSync(source));
    await linkCursorStore(repo, id, root);
    fs.appendFileSync(path.join(target, 'store.db'), 'new turn');
    assert.match(fs.readFileSync(path.join(source, 'store.db'), 'utf8'), /new turn$/);
    fs.unlinkSync(target); fs.mkdirSync(target); fs.writeFileSync(path.join(target,'store.db'),'Independent conversation');
    await assert.rejects(linkCursorStore(repo,id,root), /separate terminal history/);
    assert.equal(fs.readFileSync(path.join(target,'store.db'),'utf8'),'Independent conversation');
    await assert.rejects(linkCursorStore(repo,'../another-session',root), /Invalid Cursor/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('closing or archiving a terminal conversation never resumes its provider', async () => {
  const dir = tmpDir('radial-provider-close-');
  try {
    for (const action of ['archive', 'close']) {
      let launches = 0;
      const chat = new NativeChat({file:path.join(dir,action+'.json'),context:()=>'',emit:()=>{},transport:()=>{launches++;throw new Error('Unexpected restart');},terminal:{kill:id=>chat.terminalExited(id)} satisfies Partial<NativeChatTerminal> as NativeChatTerminal});
      const s = chat.create(dir,false,'claude'); s.terminalId='pty'; s.viewMode='terminal';
      if (action === 'archive') await chat.archive(s.id); else chat.close();
      await new Promise<void>(resolve=>setImmediate(resolve));
      assert.equal(launches,0);
      chat.close();
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('permission choices use provider CLI flags and preserve inherited Claude settings', () => {
  const p = require('../src/shared/chatPermissions') as typeof import('../src/shared/chatPermissions');
  assert.deepEqual(p.args('claude'), []);
  assert.deepEqual(p.args('claude', 'default'), ['--permission-mode', 'manual']);
  assert.deepEqual(p.args('claude', 'edits'), ['--permission-mode', 'acceptEdits']);
  assert.deepEqual(p.args('claude', 'full'), ['--permission-mode', 'bypassPermissions']);
  assert.deepEqual(p.args('cursor', 'plan'), ['--mode', 'plan']);
  assert.deepEqual(p.args('cursor', 'full'), ['--force']);
  assert.deepEqual(p.args('codex', 'read-only'), ['--sandbox', 'read-only', '--ask-for-approval', 'on-request']);
});

test('Cursor applies plan permissions to the same loaded ACP conversation', async () => {
  const { transport } = adapter(CursorTransport), calls: AdapterCall[] = [];
  transport.session = { permissionMode: 'plan' }; transport.cwd = '/tmp';
  transport.call = async (method, params) => { calls.push({method, params}); return {sessionId: 'same-session'}; };
  await transport.request('thread/resume', {threadId: 'same-session'});
  assert.deepEqual(calls.at(-1), {method: 'session/set_mode', params: {sessionId: 'same-session', modeId: 'plan'}});
});

test('empty Cursor sessions link the native directory without fabricating or forking a database', async () => {
  const { linkCursorStore } = require('../src/main/chat/providers') as typeof import('../src/main/chat/providers');
  const root = tmpDir('radial-cursor-empty-');
  try {
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
    const id = '12345678-1234-1234-1234-123456789abc';
    const source = path.join(root, 'acp-sessions', id); fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'meta.json'), JSON.stringify({ schemaVersion: 1, cwd: fs.realpathSync(repo) }));
    await assert.rejects(linkCursorStore(repo, id, root), /has not saved/);
    await linkCursorStore(repo, id, root, { allowEmpty: true });
    const bucket = fs.readdirSync(path.join(root, 'chats'))[0];
    const target = path.join(root, 'chats', bucket, id);
    assert.equal(fs.realpathSync(target), fs.realpathSync(source));
    assert.equal(fs.existsSync(path.join(source, 'store.db')), false, 'only the native CLI may create the database');
    fs.writeFileSync(path.join(target, 'store.db'), 'SQLite format 3\0native history');
    assert.equal(fs.readFileSync(path.join(source, 'store.db'), 'utf8'), 'SQLite format 3\0native history');
    await linkCursorStore(repo, id, root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('Cursor reports its native model label rather than exposing the default sentinel', async () => {
  const { transport } = adapter(CursorTransport);
  transport.cwd = '/tmp'; transport.session = {};
  transport.call = async method => method === 'session/new' ? { sessionId: 'same-id', models: { currentModelId: 'default', availableModels: [{ modelId: 'default', name: 'Auto' }] } } : {};
  const result = await transport.request('thread/start');
  assert.equal(result.model, 'default');
  assert.equal(result.modelName, 'Auto');
});

test('a Cursor edit reads as one line in the chat: the file and the lines it added and removed', () => {
  const { itemMessage } = require('../src/main/nativeChat') as typeof import('../src/main/nativeChat');
  const { transport } = adapter(CursorTransport); transport.cwd = '/site';
  const file = (lines: string[]) => lines.join('\n') + '\n';
  type ToolCallUpdate = Extract<Parameters<typeof transport.update>[0], { toolCallId: string }>;
  const edit = (id: string, content: NonNullable<ToolCallUpdate['content']>) => { transport.update({ sessionUpdate: 'tool_call_update', toolCallId: id, title: 'Edit `src/index.html`', status: 'completed', content }); return transport.items.get(id)!.item; };
  // Cursor's whole file before and after: the first line changed and a line added at the end, so no line at either end is kept.
  const before = file(['<h1>Hello</h1>', '<p>One</p>', '<p>Two</p>', '<footer>Bye</footer>']);
  const after = file(['<h1>Welcome</h1>', '<p>One</p>', '<p>Two</p>', '<footer>Bye</footer>', '<small>New</small>']);
  assert.equal(edit('whole', [{ type: 'diff', path: '/site/src/index.html', oldText: before, newText: after }]).result, 'src/index.html · +2 −1');
  // Only its changed hunks, joined by "...": one line changed in each of two.
  assert.equal(edit('hunks', [{ type: 'diff', path: '/site/src/app.css', oldText: 'a {\n  color: red;\n}\n...\nb {\n  margin: 0;\n}', newText: 'a {\n  color: blue;\n}\n...\nb {\n  margin: 4px;\n}' }]).result, 'src/app.css · +2 −2');
  // A new file (no text before) at a path relative to the project, and a file outside the project.
  assert.equal(edit('new', [{ type: 'diff', path: 'src/pages/about.astro', oldText: null, newText: file(['---', '---', '<h1>About</h1>']) }]).result, 'src/pages/about.astro · +3 −0');
  assert.equal(edit('outside', [{ type: 'diff', path: '/elsewhere/notes.md', oldText: 'one\n', newText: 'one\ntwo\n' }]).result, '/elsewhere/notes.md · +1 −0');
  // Text output reads as before.
  assert.equal(edit('text', [{ type: 'content', content: { type: 'text', text: 'Applied the change.' } }]).result, 'Applied the change.');
  // The chat's step shows that line as the edit's output, as it reads (not as a JSON string in quotes).
  assert.equal(itemMessage(transport.items.get('whole')!.item)!.detail, 'src/index.html · +2 −1');
  assert.equal(itemMessage(transport.items.get('text')!.item)!.detail, 'Applied the change.');
});

for (const engine of ['claude', 'cursor'] as const) test(`${engine} repeated view changes preserve the running turn, approval and queue on one native CLI`, async t => {
  const f = nativeFixture(t, engine), s = f.session;
  await f.chat.setView(s.id, 'chat');
  const transport = f.chat.live.get(s.id) as Interactive; // nativeFixture's chats make native terminal transports
  const shutdown = t.mock.method(transport, 'shutdown');
  const request = t.mock.method(transport, 'request');
  s.state = 'approval'; s.turnId = 'active-turn';
  s.approval = { id: 'pending', method: 'item/commandExecution/requestApproval', params: { command: 'npm test' } };
  s.queue = [{ id: 'queued', text: 'Continue afterwards', displayText: 'Continue afterwards', attachments: [] }]; s.queuePaused = false;
  s.nativeInputNotice = 'The CLI needs your input in Terminal.';
  const approval = s.approval, queue = s.queue;
  for (const view of ['terminal', 'chat', 'terminal', 'chat', 'terminal', 'chat'] satisfies ChatView[]) {
    await f.chat.setView(s.id, view, 120, 40, true);
    assert.equal(s.viewMode, view);
    assert.equal(s.state, 'approval'); assert.equal(s.turnId, 'active-turn');
    assert.equal(s.approval, approval); assert.equal(s.queue, queue); assert.equal(s.queuePaused, false);
    assert.equal(s.nativeInputNotice, 'The CLI needs your input in Terminal.');
    assert.equal(s.threadId, nativeId); assert.equal(s.terminalId, 'pty');
    assert.equal(f.chat.live.get(s.id), transport);
  }
  assert.equal(f.starts.length, 1, 'all views use the original PTY');
  assert.equal(f.transports.length, 1, 'all views retain the original observer');
  assert.equal(shutdown.mock.callCount(), 0);
  assert.equal(request.mock.callCount(), 0, 'switching never interrupts or resumes a conversation');
  assert.deepEqual(f.writes, []); assert.deepEqual(f.kills, []);
});

for (const engine of ['claude', 'cursor'] as const) test(`${engine} chat never takes its CLI's own question (trust, sign in, a first-run menu) for its prompt`, async t => {
  // Claude Code's menus put an indented ❯ on the chosen option, which read as its
  // input prompt: a message delivered there was lost, and its Enter answered the
  // question (for the trust prompt, "No, exit" quits the CLI).
  const f = nativeFixture(t, engine), s = f.session;
  await f.chat.setView(s.id, 'chat');
  const transport = f.chat.live.get(s.id) as Interactive;
  let lines: readonly string[] = [];
  t.mock.method(transport, 'screenText', () => screen([...lines]));
  const show = (next: readonly string[]) => { lines = next; transport.readControls(); };
  const questions = engine === 'claude' ? (['claudeTheme', 'claudeLogin', 'claudeApiKey', 'claudeSecurityNotes', 'claudeTrust'] as const) : (['cursorLogIn'] as const);
  for (const name of questions) {
    show(screens[name]);
    assert.equal(transport.ready, false, `${name}: no message goes in`);
    assert.equal(s.nativeInputNotice, 'The CLI needs your input in Terminal.', `${name}: the chat says why`);
  }
  show(engine === 'claude' ? screens.claudeReady : ['  Cursor Agent', '→ Plan, search, build anything']);
  assert.equal(transport.ready, true, 'at its prompt, a message goes in');
  assert.equal(s.nativeInputNotice, '', 'and the notice clears');
});

for (const engine of ['claude','cursor'] as const) test(`${engine} Stop keeps the turn busy until the native CLI completes interruption`, async () => {
  const dir=tmpDir('radial-stop-race-');
  let options!: NativeChatTransportOptions, interrupted!: () => void; // set by the factory and the promise just below
  const ack=new Promise<void>(resolve=>{interrupted=resolve;});
  const chat=new NativeChat({file:path.join(dir,'chats.json'),context:()=>'',emit(){},transport:o=>{options=o;return {initialize:async()=>{},close(){},request:async (method): Promise<ProviderResults[ProviderMethod] | void> =>{ // a provider's answer, or nothing for a method this stand-in doesn't know
    if(method==='thread/start')return {thread:{id:'same-thread'}};
    if(method==='turn/start')return {turn:{id:'first-turn'}};
    if(method==='turn/interrupt'){interrupted();return {};}
  }} as FakeTransport as NativeChatTransport;}});
  try {
    const s=chat.create(dir,false,engine);await chat.send(s.id,'First');
    const stopping=chat.stop(s.id);await ack;
    await assert.rejects(chat.send(s.id,'Too early'),/Wait for this turn/);
    assert.equal(s.state,'working');assert.equal(s.turnId,'first-turn');
    options.onEvent({method:'turn/completed',params:{turn:{id:'first-turn',status:'interrupted'}}});
    await assert.rejects(chat.send(s.id,'Still stopping'),/Wait for this turn/);
    await stopping;assert.equal(s.state,'idle');assert.equal(s.queuePaused,true);
    await chat.send(s.id,'Next');assert.equal(s.messages.filter(m=>m.role==='user').length,2);
  } finally {chat.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('provider changes cannot apply a stale model catalog from the previous provider', async () => {
  const dir=tmpDir('radial-model-provider-race-');
  let release!: (page: NativeChatModelPage) => void; // set when the catalog's request starts
  const chat=new NativeChat({file:path.join(dir,'chats.json'),context:()=>'',emit(){},transport:()=>({initialize:async()=>{},close(){},request:()=>new Promise<NativeChatModelPage>(resolve=>release=resolve)}) as FakeTransport as NativeChatTransport});
  try {
    const s=chat.create(dir,false,'codex'), setting=chat.configure(s.id,'codex-model');
    await new Promise<void>(resolve=>setImmediate(resolve));
    await chat.update(s.id,{engine:'claude'});
    release({data:[{model:'codex-model',displayName:'Codex model'}]});
    await assert.rejects(setting,/provider changed/i);
    assert.equal(s.engine,'claude');assert.equal(s.model,undefined);
  } finally {chat.close();fs.rmSync(dir,{recursive:true,force:true});}
});

for (const engine of ['claude', 'cursor'] as const) test(`${engine} failed first terminal launch retries the saved native conversation without a second writer`, async t => {
  const f = nativeFixture(t, engine), s = f.session;
  s.providerPersisted = true;
  const start = f.terminal.start;
  f.terminal.start = async () => { throw new Error('Terminal launch failed'); };
  await assert.rejects(f.chat.setView(s.id, 'terminal'), /Terminal launch failed/);
  assert.equal(s.threadId, nativeId); assert.ok(!s.terminalId);
  assert.equal(f.chat.live.has(s.id), false);
  assert.equal(f.transports[0].closed, true);
  f.terminal.start = start;
  await f.chat.setView(s.id, 'terminal');
  assert.equal(s.threadId, nativeId); assert.equal(s.terminalId, 'pty');
  assert.deepEqual(f.starts[0].command.args.slice(0, 2), ['--resume', nativeId]);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.kills, []);
});

test('closing Radial detaches its observer while the native terminal keeps working', async t => {
  const f = nativeFixture(t, 'cursor'), s = f.session;
  await f.chat.setView(s.id, 'terminal');
  const transport = f.chat.live.get(s.id) as Interactive; // nativeFixture's chats make native terminal transports
  s.state = 'working'; s.turnId = 'native-turn';
  f.chat.close();
  assert.equal(transport.closed, true);
  assert.equal(s.terminalId, 'pty'); assert.equal(s.threadId, nativeId);
  assert.equal(s.state, 'working');
  assert.deepEqual(f.writes, []); assert.deepEqual(f.kills, []);
  const saved: ChatSession = JSON.parse(fs.readFileSync(path.join(f.chat.dir, s.id + '.json'), 'utf8')); // the chat file close wrote
  assert.equal(saved.nativeTerminal, true); assert.equal(saved.terminalId, 'pty');
  assert.equal(saved.threadId, nativeId);
});
