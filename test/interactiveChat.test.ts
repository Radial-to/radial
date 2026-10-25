import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { InteractiveEvent, InteractiveOptions, InteractiveSession } from '../src/main/chat/interactive';
import type { ClaudeContentBlock, ProviderEngine, ProviderUserContent } from '../src/main/chat/providers';
import type { NativeChatTerminal, NativeChatTransportOptions } from '../src/main/nativeChat';
import type { ChatSession } from '../src/shared/radialApi';
import type { FakeList, FakeTerminal, Interactive, NativeStart, PtyWrite } from './support/nativeChat';
import { tmpDir } from './support/tmp';
const fs = require('fs') as typeof import('fs'), os = require('os') as typeof import('os'), path = require('path') as typeof import('path');
const { InteractiveTransport } = require('../src/main/chat/interactive') as typeof import('../src/main/chat/interactive');
const { NativeChat } = require('../src/main/nativeChat') as typeof import('../src/main/nativeChat');
/** A transcript line as the transport reads it: scanRecords' records (interactive.ts's TranscriptRecord, which it doesn't export). */
type TranscriptRecord = Parameters<Interactive['scanRecords']>[0][number]['record'];
/** A line of Cursor's transcript as these tests write it: a TranscriptRecord whose message may also hold Cursor's image block with its data (ClaudeContentBlock's image block has none), which the transport reads only for text. */
type TranscriptLine = Omit<TranscriptRecord, 'message'> & { message?: { content: (ClaudeContentBlock | { type: 'image'; data: string })[] } };
/** The hooks the transport registers (commandArgs), Claude Code's then Cursor's: interactive.ts's HookEventName, restated here while that module doesn't export it. scanHooks skips any other name. */
type HookEventName = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PermissionRequest' | 'Notification' | 'Stop' | 'StopFailure' | 'SessionEnd' | 'preToolUse' | 'postToolUse' | 'postToolUseFailure';
/** A hook's input as observe.cjs journals it, which the transport reads (scanHooks): interactive.ts's HookRecord (not exported either) with the fields these tests set: the hook, the conversation it's for, and the tool. */
interface HookLine { hook_event_name: HookEventName; session_id?: string; conversation_id?: string; prompt_id?: string; tool_use_id?: string; tool_name?: string; tool_input?: unknown; tool_output?: unknown }
/** A user message's text, the first part of its content. */
type TextContent = Extract<ProviderUserContent, { type: 'text' }>;
/** A stand-in for the chat a native terminal serves (InteractiveSession): an id, a thread and a title, and the fields the transport sets. home and state are left unset, which the transport reads as not Home and not working. */
type FakeSession = Pick<ChatSession, 'id' | 'threadId' | 'title' | 'messages'> & Partial<InteractiveSession>;
const threadId = '12345678-1234-1234-1234-123456789abc';
const jsonl = (records: readonly (TranscriptLine | HookLine)[]) => records.map(record => JSON.stringify(record) + '\n').join('');
const user = (text: string, id?: string): TranscriptLine => ({ role: 'user', generation_id: id, message: { content: [{ type: 'text', text }] } });
const answer = (text: string): TranscriptLine => ({ role: 'assistant', message: { content: [{ type: 'text', text }] } });
const ended: TranscriptLine = { type: 'turn_ended', status: 'completed' };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(t: TestContext, engine: ProviderEngine = 'cursor') {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const dir = tmpDir('radial-interactive-');
  const transcript = path.join(dir, threadId + '.jsonl');
  const status = path.join(dir, 'status.json');
  const bin = path.join(dir, 'native-cli');
  fs.writeFileSync(transcript, '');
  fs.writeFileSync(status, JSON.stringify([{ sessionId: threadId, status: 'busy' }]));
  fs.writeFileSync(bin, '#!' + process.execPath + '\n' +
    'if (process.argv[2] === "create-chat") console.log(' + JSON.stringify(threadId) + ');\n' +
    'else console.log(require("fs").readFileSync(' + JSON.stringify(status) + ', "utf8"));\n', { mode: 0o700 });
  const events: InteractiveEvent[] = [], starts: NativeStart[] = [], writes: PtyWrite[] = [], kills: string[] = [], transports: Interactive[] = [], chats: InstanceType<typeof NativeChat>[] = [];
  const terminal: FakeTerminal<'write' | 'kill' | 'attach'> & FakeList<'id' | 'alive' | 'meta' | 'cols' | 'rows'> = {
    list: async () => starts.length ? [{ id: 'pty', alive: true, meta: starts[0].meta, cols: 100, rows: 30 }] : [],
    start: async (_cwd, options) => { starts.push(options); return 'pty'; },
    write: (id, data) => writes.push({ id, data }),
    kill: id => kills.push(id), attach() {},
  };
  const session: FakeSession = { id: 'chat-id', threadId, title: 'Native test', messages: [] };
  function make(options: Partial<NativeChatTransportOptions> = {}) {
    const env = { RADIAL_USERDATA: dir, ['RADIAL_CHAT_TEST_' + engine.toUpperCase()]: bin };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    let transport: Interactive;
    try { transport = new InteractiveTransport({ engine, cwd: dir, runtimeRoot: dir, session, terminal,
      env: { CURSOR_CONFIG_DIR: dir }, onEvent: event => events.push(event), ...options } as InteractiveOptions); } // the stand-ins, or what NativeChat passes for this fixture's Claude or Cursor chats
    finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
    transport.transcript = transcript; transports.push(transport); return transport;
  }
  const transport = make();
  async function initialize(target = transport) { await target.initialize(); clearInterval(target.timer); return target; }
  function chat() {
    const instance = new NativeChat({ file: path.join(dir, 'chats.json'), context: () => '', emit() {}, terminal: terminal as NativeChatTerminal, transport: make });
    chats.push(instance); return instance;
  }
  t.after(() => { for (const c of chats) c.close(); for (const tr of transports) if (!tr.closed) tr.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, transcript, status, session, transport, terminal, events, starts, writes, kills, transports, initialize, chat, make,
    append: (records: TranscriptLine[]) => fs.appendFileSync(transcript, jsonl(records)),
    hooks: (records: HookLine[]) => fs.appendFileSync(transport.journal, jsonl(records.map(record => ({ session_id: threadId, ...record })))),
    render: async (text: string, target = transport) => { const parsed = new Promise<void>(resolve => target.screen.write('\x1b[2J\x1b[H' + text, resolve)); t.mock.timers.tick(200); await parsed; },
    advance: async (ms: number) => { t.mock.timers.tick(ms); await flush(); },
  };
}

test('native transcript retains partial JSON and split UTF-8 until a full line arrives', async t => {
  const f = fixture(t); await f.initialize();
  const record = Buffer.from(jsonl([user('Build a café 🌈', 'one')]));
  const split = record.indexOf(Buffer.from('🌈')) + 2;
  fs.appendFileSync(f.transcript, record.subarray(0, split));
  await f.transport.scan(); assert.equal(f.transport.items.size, 0); assert.equal(f.events.filter(e => e.method === 'turn/started').length, 0);
  fs.appendFileSync(f.transcript, record.subarray(split, record.length - 1));
  await f.transport.scan(); assert.equal(f.transport.items.size, 0);
  fs.appendFileSync(f.transcript, '\n'); await f.transport.scan();
  assert.equal(([...f.transport.items.values()][0].item.content![0] as TextContent).text, 'Build a café 🌈'); // the user message's text
  const count = f.events.length; await f.transport.scan(); assert.equal(f.events.length, count);
});

test('identical Cursor turns remain separate native messages after a larger same-inode transcript rewrite', async t => {
  const f = fixture(t); await f.initialize();
  f.append([user('Repeat', 'first'), answer('Same answer'), ended]); await f.transport.scan();
  const inode = fs.statSync(f.transcript).ino, size = fs.statSync(f.transcript).size;
  fs.writeFileSync(f.transcript, jsonl([user('Repeat', 'first'), answer('Same answer'), user('Repeat', 'second'), answer('Same answer'), ended]));
  assert.equal(fs.statSync(f.transcript).ino, inode); assert.ok(fs.statSync(f.transcript).size > size);
  await f.transport.scan();
  const items = [...f.transport.items.values()].map(entry => entry.item);
  assert.equal(items.length, 4); assert.equal(new Set(items.map(item => item.id)).size, 4);
  assert.deepEqual(items.filter(item => item.type === 'userMessage').map(item => (item.content![0] as TextContent).text), ['Repeat', 'Repeat']); // a user message's text
  assert.deepEqual(f.events.filter(e => e.method === 'turn/started').map(e => e.params.turn.id), ['first', 'second']);
  assert.deepEqual(f.events.filter(e => e.method === 'turn/completed').map(e => e.params.turn.id), ['first', 'second']);
});

test('Claude transcript records without an id are skipped rather than shown under no id', async t => {
  const f = fixture(t, 'claude'); await f.initialize();
  f.append([
    { type: 'user', message: { content: [{ type: 'text', text: 'No uuid' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'No message id' }] } },
    { type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: 'Named' }] } },
  ]);
  await f.transport.scan();
  assert.deepEqual([...f.transport.items.keys()], ['user-1']);
  assert.deepEqual(f.events.filter(e => e.method === 'item/completed').map(e => e.params.item.id), ['user-1']);
});

for (const seen of ['empty', 'half written'] as const) test(`a Cursor transcript rewrite polled while ${seen} does not duplicate its messages`, async t => {
  const f = fixture(t); await f.initialize();
  f.append([user('Repeat', 'first'), answer('Same answer'), ended]); await f.transport.scan();
  const inode = fs.statSync(f.transcript).ino;
  const rewrite = jsonl([user('Repeat', 'first'), answer('Same answer'), user('Repeat', 'second'), answer('Same answer'), ended]);
  // Cursor rewrites the file in place, truncating it before it writes, and a poll can land in between.
  fs.writeFileSync(f.transcript, seen === 'empty' ? '' : rewrite.slice(0, 20)); await f.transport.scan();
  fs.writeFileSync(f.transcript, rewrite); await f.transport.scan();
  assert.equal(fs.statSync(f.transcript).ino, inode);
  const items = [...f.transport.items.values()].map(entry => entry.item);
  assert.equal(items.length, 4); assert.equal(new Set(items.map(item => item.id)).size, 4);
  assert.deepEqual(items.filter(item => item.type === 'userMessage').map(item => (item.content![0] as TextContent).text), ['Repeat', 'Repeat']); // a user message's text
  assert.deepEqual(f.events.filter(e => e.method === 'turn/started').map(e => e.params.turn.id), ['first', 'second']);
});

test('prompt delivery waits for setup and uses one bracketed paste before Enter', async t => {
  const f = fixture(t, 'claude'); await f.initialize();
  const result = await f.transport.request('turn/start', { input: [{ type: 'text', text: 'First\r\nsecond' }] });
  assert.equal(f.session.nativePendingPrompt!.id, result.turn.id); assert.deepEqual<PtyWrite[]>(f.writes, []); // turn/start left the prompt pending; typed, as an empty [] would leave writes typed never[] for the reads below
  assert.match(f.session.nativeInputNotice!, /finish CLI setup/);
  await f.render('❯ ');
  assert.deepEqual(f.writes, [{ id: 'pty', data: '\x1b[200~First\nsecond\x1b[201~' }]);
  assert.equal(f.session.nativePendingPrompt!.delivering, true);
  await f.advance(100);
  assert.equal(f.writes[1].data, '\r'); assert.equal(f.transport.pendingPrompt, null);
  assert.equal(f.events.some(e => e.method === 'turn/completed'), false);
  f.hooks([{ hook_event_name: 'UserPromptSubmit', prompt_id: 'native-prompt' }]); await f.transport.scanHooks();
  assert.equal(f.session.nativePendingPrompt, null); assert.equal(f.transport.turnId, result.turn.id);
});

test('Claude idle status cannot complete a new turn or bypass more recent Stop activity', async t => {
  const f = fixture(t, 'claude'); await f.initialize();
  fs.writeFileSync(f.status, JSON.stringify([{ sessionId: threadId, status: 'idle' }]));
  f.hooks([{ hook_event_name: 'UserPromptSubmit', prompt_id: 'one' }]); await f.transport.scanHooks();
  await f.transport.syncClaudeStatus(); assert.equal(f.transport.turnId, 'one');
  await f.advance(1); f.hooks([{ hook_event_name: 'Stop' }]); await f.transport.scanHooks();
  await f.transport.syncClaudeStatus(); assert.equal(f.transport.turnId, 'one', 'cached idle predates Stop');
  fs.writeFileSync(f.status, JSON.stringify([{ sessionId: threadId, status: 'busy' }]));
  await f.advance(1001); await f.transport.syncClaudeStatus(); assert.equal(f.transport.turnId, 'one', 'Stop hook can continue working');
  fs.writeFileSync(f.status, JSON.stringify([{ sessionId: threadId, status: 'idle' }]));
  await f.advance(1001); await f.transport.syncClaudeStatus();
  assert.equal(f.transport.turnId, null);
  assert.deepEqual(f.events.filter(e => e.method === 'turn/completed').map(e => e.params.turn), [{ id: 'one', status: 'completed' }]);
});

test('tool activity and Enter preserve a native draft until submission or an empty cleared editor', async t => {
  const f = fixture(t, 'claude'); await f.initialize();
  f.transport.noteInput('\x1b[?1;2c\x1b[1;1R'); assert.equal(f.session.terminalHasInput, false);
  f.transport.noteInput('Draft'); f.transport.noteInput('\r');
  f.hooks([{ hook_event_name: 'PreToolUse', tool_use_id: 'tool', tool_name: 'Bash', tool_input: { command: 'pwd' } }]); await f.transport.scanHooks();
  assert.equal(f.session.terminalHasInput, true);
  await assert.rejects(f.transport.request('turn/start', { input: [{ type: 'text', text: 'Replace it' }] }), /unsent Terminal draft/);
  assert.deepEqual(f.writes, []);
  f.transport.noteInput('\x15'); await f.render('❯ Draft'); assert.equal(f.session.terminalHasInput, true);
  await f.render('❯ '); assert.equal(f.session.terminalHasInput, false);
  f.transport.noteInput('Submitted');
  f.hooks([{ hook_event_name: 'UserPromptSubmit', prompt_id: 'native' }]); await f.transport.scanHooks();
  assert.equal(f.session.terminalHasInput, false);
});

for (const engine of ['claude', 'cursor'] as const) test(`${engine} only explicit Stop writes an interrupt and observer close never kills the CLI`, async t => {
  const f = fixture(t, engine); await f.initialize();
  await f.transport.request('turn/start', { input: [{ type: 'text', text: 'Waiting for setup' }] });
  await f.transport.request('turn/interrupt');
  assert.deepEqual(f.writes, [{ id: 'pty', data: engine === 'claude' ? '\x1b' : '\x03' }]);
  assert.equal(f.session.nativePendingPrompt, null);
  await f.advance(100); assert.equal(f.writes.length, 1, 'cancelled queued delivery never pastes');
  f.transport.close(); assert.deepEqual(f.kills, []); assert.equal(f.starts.length, 1);
});

test('queued Chat messages continue on the same native CLI while Terminal is visible', async t => {
  const f = fixture(t), chat = f.chat();
  const s = chat.create(f.dir, false, 'cursor'); s.threadId = threadId;
  await chat.setView(s.id, 'chat'); const transport = chat.live.get(s.id) as Interactive; clearInterval(transport.timer); // this fixture's chats make native terminal transports
  const parsed = new Promise<void>(resolve => transport.screen.write('→ Plan, search, build anything', resolve)); t.mock.timers.tick(200); await parsed;
  await chat.send(s.id, 'First'); await f.advance(100);
  chat.enqueue(s.id, 'Second'); await chat.setView(s.id, 'terminal');
  f.append([user('First', 'one'), answer('Done'), ended]); await transport.scan();
  await f.advance(100); await f.advance(100);
  assert.equal(s.viewMode, 'terminal'); assert.equal(s.queue!.length, 0); assert.equal(s.queuePaused, false); // enqueue made the queue
  assert.deepEqual(s.messages.filter(m => m.role === 'user').map(m => m.text), ['First', 'Second']);
  assert.deepEqual(f.writes.map(w => w.data), ['\x1b[200~First\x1b[201~', '\r', '\x1b[200~Second\x1b[201~', '\r']);
  assert.equal(f.starts.length, 1); assert.deepEqual(f.kills, []); assert.equal(chat.live.get(s.id), transport);
});

test('restart reattaches a running native conversation and replays tool history without relaunching', async t => {
  const f = fixture(t), first = f.chat();
  const s = first.create(f.dir, false, 'cursor'); s.threadId = threadId;
  await first.setView(s.id, 'terminal'); const original = first.live.get(s.id) as Interactive; clearInterval(original.timer); // this fixture's chats make native terminal transports
  f.append([user('Keep running', 'active'), answer('Working')]);
  fs.appendFileSync(original.journal, jsonl([
    { conversation_id: threadId, hook_event_name: 'preToolUse', tool_use_id: 'tool', tool_name: 'Shell', tool_input: { command: 'pwd' } },
    { conversation_id: threadId, hook_event_name: 'postToolUse', tool_use_id: 'tool', tool_name: 'Shell', tool_output: 'repository' },
  ]));
  await original.scan(); first.close();
  const second = f.chat(); await second.restoring;
  const restored = second.get(s.id), observer = second.live.get(s.id) as Interactive; clearInterval(observer.timer); // reattached as a native terminal transport
  assert.equal(restored.threadId, threadId); assert.equal(restored.terminalId, 'pty'); assert.equal(restored.state, 'working');
  assert.equal(restored.turnId, 'active'); assert.equal(restored.recovery, '');
  assert.deepEqual(restored.messages.map(m => m.role), ['user', 'assistant', 'tool']);
  assert.equal(restored.messages[2].status, 'completed'); assert.match(restored.messages[2].detail!, /repository/); // the tool's output
  assert.equal(f.starts.length, 1); assert.deepEqual(f.writes, []); assert.deepEqual(f.kills, []);
  f.append([answer('Finished after restart'), ended]); await observer.scan();
  assert.equal(restored.state, 'idle'); assert.equal(restored.messages.at(-1)!.text, 'Finished after restart');
});

for (const delivering of [false, true]) test(`restart ${delivering ? 'does not duplicate an ambiguously delivered' : 'retains an undelivered'} prompt`, async t => {
  const f = fixture(t);
  f.session.nativePendingPrompt = { id: 'pending', text: 'Exactly once', knownUsers: [], delivering };
  await f.initialize();
  if (delivering) {
    assert.equal(f.transport.pendingPrompt, undefined); assert.equal(f.session.terminalHasInput, true);
    assert.match(f.session.nativeInputNotice!, /Check it there/); // initialize leaves a notice
  } else assert.equal(f.transport.pendingPrompt!.id, 'pending'); // initialize keeps the undelivered prompt
  await f.render('→ Plan, search, build anything'); await f.advance(100); await f.advance(100);
  assert.deepEqual(f.writes.map(w => w.data), delivering ? [] : ['\x1b[200~Exactly once\x1b[201~', '\r']);
});


test('setup replies allow a waiting Chat prompt to deliver once the native editor is empty', async t => {
  const f = fixture(t, 'claude'), chat = f.chat();
  const s = chat.create(f.dir, false, 'claude'); s.threadId = threadId;
  await chat.send(s.id, 'Build after setup');
  const transport = chat.live.get(s.id) as Interactive; clearInterval(transport.timer); // this fixture's chats make native terminal transports
  await chat.setView(s.id, 'terminal');
  await f.render('Do you trust this folder?', transport);
  assert.equal(chat.acceptsTerminalInput('pty', '\r'), true);
  chat.recordTerminalInput('pty', '\r'); assert.equal(s.terminalHasInput, true);
  assert.deepEqual<PtyWrite[]>(f.writes, []); // typed, as an empty [] would leave writes typed never[] for the reads below
  await f.render('❯ ', transport);
  assert.equal(s.terminalHasInput, false);
  assert.equal(chat.acceptsTerminalInput('pty', 'accidental typing'), false, 'paste delivery owns the input until Enter');
  assert.equal(chat.terminalInputBlock('pty'), 'delivering', 'and an answer to a question there says why it waits');
  assert.deepEqual(f.writes.map(w => w.data), ['\x1b[200~Build after setup\x1b[201~']);
  await f.advance(100);
  assert.equal(chat.acceptsTerminalInput('pty', 'follow-up draft'), true);
  assert.equal(chat.terminalInputBlock('pty'), null);
  assert.deepEqual(f.writes.map(w => w.data), ['\x1b[200~Build after setup\x1b[201~', '\r']);
});

for (const accepted of [false, true]) test(`restart ${accepted ? 'recognizes a new native copy of' : 'does not confuse old identical history with'} a pending prompt`, async t => {
  const f = fixture(t);
  f.append([user('continue', 'old'), answer('Old reply'), ended]); await f.initialize();
  await f.transport.request('turn/start', { input: [{ type: 'text', text: 'continue' }] });
  assert.deepEqual(f.session.nativePendingPrompt!.knownUsers, ['cursor-native-0']); // turn/start left the prompt pending
  f.transport.close();
  if (accepted) f.append([user('continue', 'new')]);
  const restored = f.make(); await f.initialize(restored);
  if (accepted) {
    assert.equal(f.session.nativePendingPrompt, null); assert.equal(restored.pendingPrompt, undefined);
  } else assert.equal(restored.pendingPrompt!.text, 'continue'); // initialize keeps the prompt it didn't find in history
  await f.render('→ Add a follow-up', restored); await f.advance(100);
  assert.deepEqual(f.writes.map(w => w.data), accepted ? [] : ['\x1b[200~continue\x1b[201~', '\r']);
  assert.equal(f.starts.length, 1);
});

for (const source of ['busy-status', 'terminal-Escape']) test(`Claude ${source} can finish on fresh idle without a Stop hook`, async t => {
  const f = fixture(t, 'claude'); await f.initialize();
  f.hooks([{ hook_event_name: 'UserPromptSubmit', prompt_id: 'active' }]); await f.transport.scanHooks();
  if (source === 'busy-status') await f.transport.syncClaudeStatus();
  else f.transport.noteInput('\x1b');
  fs.writeFileSync(f.status, JSON.stringify([{ sessionId: threadId, status: 'idle' }]));
  await f.advance(1001); await f.transport.syncClaudeStatus();
  assert.equal(f.transport.turnId, null);
  assert.equal(f.events.filter(e => e.method === 'turn/completed').length, 1);
  assert.deepEqual(f.writes, [], 'observing native Escape does not send a second interrupt');
});

test('archiving during native CLI startup terminates the late PTY without restoring the archived session', async t => {
  const f = fixture(t), chat = f.chat();
  const s = chat.create(f.dir, false, 'cursor'); s.threadId = threadId;
  let release!: (id: string) => void, announce!: () => void; // set by the promise just below and by the stand-in start, before the test calls them
  const entered = new Promise<void>(resolve => { announce = resolve; });
  f.terminal.start = async (_cwd, options) => { f.starts.push(options); announce(); return new Promise<string>(resolve => { release = resolve; }); };
  const sending = chat.send(s.id, 'Do not survive archive');
  await entered;
  const opening = chat.live.get(s.id) as Interactive; // this fixture's chats make native terminal transports
  await chat.archive(s.id);
  assert.equal(opening.closed, true); assert.equal(s.archived, true); assert.equal(chat.live.has(s.id), false);
  release('late-pty'); await sending;
  assert.deepEqual(f.kills, ['late-pty']); assert.deepEqual(f.writes, []);
  assert.equal(s.terminalId, null); assert.equal(s.state, 'idle'); assert.equal(s.nativePendingPrompt, null);
});


test('a native image-sized transcript record does not stall all subsequent messages', async t => {
  const f = fixture(t); await f.initialize();
  const image = 'x'.repeat(17 * 1024 * 1024);
  f.append([{ role: 'assistant', message: { content: [{ type: 'image', data: image }] } }, answer('After the large image')]);
  await f.transport.scan();
  assert.ok([...f.transport.items.values()].some(({ item }) => item.text === 'After the large image'));
  f.append([user('Continue'), answer('Still observing')]); await f.transport.scan();
  assert.ok([...f.transport.items.values()].some(({ item }) => item.text === 'Still observing'));
});
