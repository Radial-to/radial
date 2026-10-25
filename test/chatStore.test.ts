// The chat store and chat events stay cheap as conversations grow: one file per
// chat written only when it changes, tool output capped for display, and events
// that carry only the messages the window doesn't have yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { NativeChatTransport } from '../src/main/nativeChat';
import type { ChatEvent, ChatSession } from '../src/shared/radialApi';
import type { SavedChat } from './support/nativeChat';
import { tmpDir } from './support/tmp';
const fs = require('fs') as typeof import('fs'), os = require('os') as typeof import('os'), path = require('path') as typeof import('path');
const { NativeChat, capDetail } = require('../src/main/nativeChat') as typeof import('../src/main/nativeChat');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 250));

function store(t: TestContext, saved: SavedChat[]) {
  const dir = tmpDir('radial-chat-store-'), file = path.join(dir, 'native-chats.json'), events: ChatEvent[] = [];
  if (saved) fs.writeFileSync(file, JSON.stringify(saved));
  const open = () => new NativeChat({ file, context: () => '', emit: event => events.push(event) });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file, events, open };
}
const chat = (id: string, extra: Partial<ChatSession> = {}): SavedChat => ({ id, engine: 'codex', repoDir: '/tmp', home: false, title: id, state: 'idle', messages: [], createdAt: 1, updatedAt: 1, ...extra });

test('the single legacy store moves to a file per chat once, and only changed chats are rewritten', async t => {
  const big = 'x'.repeat(100_000);
  const s = store(t, [chat('a', { messages: [{ id: 'm1', role: 'tool', name: 'Bash', text: 'ls', detail: big }] }), chat('b', { createdAt: 2 })]);
  const one = s.open();
  assert.deepEqual([...one.sessions.keys()], ['a', 'b']);
  assert.ok(!fs.existsSync(s.file) && fs.existsSync(s.file + '.migrated'), 'the old file is kept aside');
  assert.deepEqual(fs.readdirSync(path.join(s.dir, 'native-chats')).sort(), ['a.json', 'b.json']);
  assert.ok(one.get('a').messages[0].detail!.length < 17_000, 'migrated tool output is capped'); // the tool message saved above has its output
  const before = fs.statSync(path.join(s.dir, 'native-chats', 'b.json')).mtimeMs;
  one.update('a', { title: 'Renamed' });
  await settle();
  assert.equal((JSON.parse(fs.readFileSync(path.join(s.dir, 'native-chats', 'a.json'), 'utf8')) as ChatSession).title, 'Renamed'); // a chat file the store wrote
  assert.equal(fs.statSync(path.join(s.dir, 'native-chats', 'b.json')).mtimeMs, before, 'an unchanged chat is not rewritten');
  one.update('b', { title: 'Unsaved at quit' }); one.close(); // quit writes what the debounce hadn't
  const two = s.open();
  assert.equal(two.get('a').title, 'Renamed'); assert.equal(two.get('b').title, 'Unsaved at quit');
  two.close();
});

test('tool output keeps its start and end, and keeps counting what it cut', () => {
  const message = { detail: 'A'.repeat(12 * 1024) + 'B'.repeat(50_000) + 'C'.repeat(4 * 1024) };
  capDetail(message);
  assert.ok(message.detail.startsWith('A'.repeat(12 * 1024) + '\n\n… 50,000 characters not shown …\n\n'));
  assert.ok(message.detail.endsWith('C'.repeat(4 * 1024)));
  message.detail += 'D'.repeat(10_000); capDetail(message); // streamed output keeps arriving
  assert.match(message.detail, /… 60,000 characters not shown …/);
  assert.ok(message.detail.endsWith('D'.repeat(4 * 1024)));
  const small = { detail: 'short' }; capDetail(small); assert.equal(small.detail, 'short');
});

test('events carry only new and changed messages', async t => {
  const s = store(t, [chat('a', { messages: [{ id: 'u1', role: 'user', text: 'hi' }, { id: 'r1', role: 'assistant', text: 'Hel' }] })]);
  const c = s.open(), a = c.get('a');
  c.changed(a);
  assert.equal(s.events.length, 1); assert.equal((s.events[0] as Partial<ChatSession>).messages, undefined, 'no full message list'); // read as a chat, which has a message list, to check the event leaves it out
  assert.deepEqual(s.events[0].messagePatch, { from: 0, messages: a.messages }, 'the first event carries the list');
  c.event(a, { method: 'item/agentMessage/delta', params: { itemId: 'r1', delta: 'lo' } });
  c.event(a, { method: 'item/agentMessage/delta', params: { itemId: 'r1', delta: '!' } });
  assert.equal(s.events.length, 3);
  assert.deepEqual(s.events[2].messagePatch, { from: 1, messages: [{ id: 'r1', role: 'assistant', text: 'Hello!' }] }, 'only the reply that changed');
  c.event(a, { method: 'item/completed', params: { item: { id: 'r2', type: 'agentMessage', text: 'More' } } });
  assert.equal(s.events[3].messagePatch.from, 2); assert.deepEqual(s.events[3].messagePatch.messages.map(m => m.id), ['r2']);
  a.messages = [...a.messages]; c.changed(a); // a replaced list (history reload) goes whole
  assert.equal(s.events[4].messagePatch.from, 0); assert.equal(s.events[4].messagePatch.messages.length, 3);
  assert.equal(s.events[4].messageCount, 3);
  c.close();
});

test('typing in a terminal chat emits only when unsent input appears or clears', async t => {
  const s = store(t, [chat('a', { engine: 'claude', nativeTerminal: true, terminalId: 'pty' })]);
  const c = s.open(), a = c.get('a');
  c.live.set('a', { nativeTerminal: true, noteInput(data) { a.terminalHasInput = data !== '\x15'; } } satisfies Partial<NativeChatTransport> as NativeChatTransport); // a stand-in native terminal: recordTerminalInput only hands it the input
  for (const key of 'hello') c.recordTerminalInput('pty', key);
  await tick();
  assert.equal(s.events.length, 1, 'five keystrokes, one event');
  c.recordTerminalInput('pty', '\x15'); await tick();
  assert.equal(s.events.length, 2); assert.equal(s.events[1].terminalHasInput, false);
  c.live.clear(); c.close();
});
