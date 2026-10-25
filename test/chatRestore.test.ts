import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CodexParams, NativeChatTerminal, NativeChatTransport } from '../src/main/nativeChat';
import type { FakeList, FakeTerminal, FakeTransport, SavedChat } from './support/nativeChat';
import { tmpDir } from './support/tmp';
const fs = require('node:fs') as typeof import('node:fs'), os = require('node:os') as typeof import('node:os'), path = require('node:path') as typeof import('node:path');
const { NativeChat } = require('../src/main/nativeChat') as typeof import('../src/main/nativeChat');
/** The PTY daemon's stand-in: list reports which chats' CLIs still run, with only the fields restore reads; start, which nothing here reaches, opens no terminal. */
type RestoreTerminal = FakeTerminal<'kill'> & FakeList<'id' | 'alive' | 'meta'>;
// Opening a project reattaches only chats whose CLI is still running in the
// daemon; the rest start when opened or sent to (one CLI per past conversation at
// every open was a memory leak: docs/memory-leak-report-2026-10-11.md).
test('project restore reattaches only chats whose CLI still runs, once, without submitting or touching archived/other-project chats', async t => {
  const dir = tmpDir('radial-restore-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'chats.json');
  const sessions: SavedChat[] = (['claude', 'codex', 'cursor'] as const).map((engine, i) => ({ id: 'saved-'+i, threadId:'thread-'+i, engine, repoDir:dir, home:false, messages:[{id:'old',role:'user',text:'Previous message'}], state:'idle', updatedAt:i }));
  sessions.push({ ...sessions[0], id:'closed',archived:true }, { ...sessions[1],id:'elsewhere',repoDir:dir+'/closed-project' }, { ...sessions[1],id:'home',home:true }, { ...sessions[0],id:'empty',threadId:null,messages:[] });
  fs.writeFileSync(file, JSON.stringify(sessions)); const calls: { id: string; method: string; params: CodexParams }[]=[];
  const running = ['saved-0', 'saved-1', 'closed', 'elsewhere', 'home'].map(id => ({ id: 'pty-'+id, alive: true, meta: { nativeChatId: id } }));
  const terminal: RestoreTerminal = { list: async () => running, kill() {}, start: async () => null };
  const chat = new NativeChat({ file, terminal: terminal as NativeChatTerminal, context:()=>'', emit:()=>{}, transport: options => ({ initialize:async()=>{await new Promise<void>(r=>setTimeout(r,20));}, request:async(method,params)=>{if(method==='config/read')return {config:{}};calls.push({id:options.session!.id,method,params});return {thread:{id:params.threadId}};},close:()=>{} }) as FakeTransport as NativeChatTransport }); // connect passes the session
  t.after(()=>chat.close());
  await Promise.all([chat.restoreProject(dir), chat.restoreProject(dir)]);
  assert.deepEqual(calls.map(c=>c.id).sort(), ['saved-0','saved-1'], 'saved-2 has no running CLI: it waits to be opened');
  assert.ok(calls.every(c=>c.method==='thread/resume'));
  assert.deepEqual(calls.map(c=>c.params.threadId).sort(), ['thread-0','thread-1']);
  await chat.restoreProject(dir); assert.equal(calls.length,2);
  for (const s of sessions.slice(0,3)) assert.equal(chat.get(s.id).messages.length,1);
});
test('a failed native resume preserves its saved conversation and does not block other sessions', async t => {
  const dir=tmpDir('radial-restore-failure-');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'chats.json');fs.writeFileSync(file,JSON.stringify((['claude','codex'] as const).map((engine): SavedChat=>({id:engine,engine,threadId:engine+'-thread',repoDir:dir,home:false,messages:[],state:'idle'}))));
  const terminal: RestoreTerminal={list:async()=>['claude','codex'].map(id=>({id:'pty-'+id,alive:true,meta:{nativeChatId:id}})),kill(){},start:async()=>null};
  const chat=new NativeChat({file,terminal: terminal as NativeChatTerminal,context:()=>'',emit:()=>{},transport:o=>({initialize:async()=>{if(o.engine==='claude')throw Error('CLI unavailable');},request:async(_m,p)=>({thread:{id:p.threadId}}),close:()=>{}}) as FakeTransport as NativeChatTransport});t.after(()=>chat.close());
  await chat.restoreProject(dir);assert.equal(chat.get('claude').threadId,'claude-thread');assert.match(chat.get('claude').error!,/CLI unavailable/);assert.ok(chat.live.has('codex'));assert.equal(chat.get('claude').archived,undefined); // restoreProject sets the error
});
