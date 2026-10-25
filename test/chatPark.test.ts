// Idle chats are parked: the CLI stops, the conversation stays, and nothing on
// screen, kept awake, mid-turn or holding unsent input is touched
// (docs/memory-leak-report-2026-10-11.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NativeChatTerminal, NativeChatTransport } from '../src/main/nativeChat';
import type { ChatSession } from '../src/shared/radialApi';
import type { FakeTerminal, FakeTransport, SavedChat } from './support/nativeChat';
import { tmpDir } from './support/tmp';
const fs = require('node:fs') as typeof import('node:fs'), os = require('node:os') as typeof import('node:os'), path = require('node:path') as typeof import('node:path');
const { NativeChat } = require('../src/main/nativeChat') as typeof import('../src/main/nativeChat');
/** The chats this test saves, one for each case. */
type ChatId = 'idle' | 'onscreen' | 'awake' | 'recent' | 'working' | 'typing' | 'elsewhere';

test('parkIdle stops idle chat CLIs and keeps every exemption running', async t => {
  const dir = tmpDir('radial-park-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'chats.json');
  const now = Date.now(), H = 60 * 60 * 1000;
  const chats: Record<ChatId, Partial<ChatSession>> = { idle: {}, onscreen: {}, awake: { keepAwake: true }, recent: {}, working: { state: 'working' }, typing: { terminalHasInput: true }, elsewhere: { repoDir: dir + '/other' } };
  const ago: Record<ChatId, number> = { idle: 3 * H, onscreen: 3 * H, awake: 3 * H, recent: 10 * 60 * 1000, working: 3 * H, typing: 3 * H, elsewhere: 3 * H };
  fs.writeFileSync(file, JSON.stringify(Object.entries(chats).map(([id, extra]): SavedChat => ({ id, engine: 'claude', threadId: 'thread-' + id, repoDir: dir, home: false, messages: [{ id: 'm', role: 'user', text: 'hi' }], state: 'idle', nativeTerminal: true, terminalId: 'pty-' + id, ...extra }))));
  const killed: string[] = [];
  const terminal: FakeTerminal<'list' | 'kill'> = { list: async () => (Object.keys(chats) as ChatId[]).map(id => ({ id: 'pty-' + id, repoDir: chats[id].repoDir || dir, alive: true, lastDataAt: now - ago[id], lastInputAt: 0, meta: { nativeChatId: id, engine: 'claude' } })), kill: id => killed.push(id), start: async () => null };
  const chat = new NativeChat({ file, terminal: terminal as NativeChatTerminal, context: () => '', emit: () => {}, transport: () => ({ initialize: async () => {}, request: async (_m, p) => ({ thread: { id: p?.threadId } }), close() {}, nativeTerminal: true }) as FakeTransport<'initialize' | 'close' | 'nativeTerminal'> as NativeChatTransport });
  t.after(() => chat.close());
  await chat.restoring;
  for (const id of ['working', 'typing'] as const) Object.assign(chat.get(id), chats[id]); // a restart resets state; set what this test is about

  const parked = await chat.parkIdle({ idleMs: 2 * H, visible: ['onscreen'], repoDir: dir, now });
  assert.deepEqual(parked, ['idle']);
  assert.deepEqual(killed, ['pty-idle']);
  const s = chat.get('idle');
  assert.equal(s.terminalId, null); assert.equal(s.state, 'idle'); assert.equal(s.error, ''); assert.ok(s.parkedAt! > 0); // park stamps it
  assert.equal(s.threadId, 'thread-idle', 'the conversation is kept for --resume');
  assert.equal(chat.live.has('idle'), false);

  chat.terminalExited('pty-idle');
  assert.equal(chat.get('idle').error, '', "a parked chat's exit is not reported as a crash");
  for (const id of ['onscreen', 'awake', 'recent', 'working', 'typing', 'elsewhere']) assert.equal(chat.get(id).terminalId, 'pty-' + id, id + ' keeps running');

  assert.deepEqual(await chat.parkIdle({ idleMs: 2 * H, now }), ['onscreen', 'elsewhere'], 'without a repo or screen filter the rest that qualify are parked');
});

test('parkIdle without a usable idle time parks nothing', async t => {
  const dir = tmpDir('radial-park-none-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'chats.json'), now = Date.now();
  fs.writeFileSync(file, JSON.stringify([{ id: 'recent', engine: 'claude', threadId: 'thread-recent', repoDir: dir, home: false, messages: [{ id: 'm', role: 'user', text: 'hi' }], state: 'idle', nativeTerminal: true, terminalId: 'pty-recent' }] satisfies SavedChat[]));
  const killed: string[] = [];
  const terminal: FakeTerminal<'list' | 'kill'> = { list: async () => [{ id: 'pty-recent', repoDir: dir, alive: true, lastDataAt: now - 1000, lastInputAt: 0, meta: { nativeChatId: 'recent', engine: 'claude' } }], kill: id => killed.push(id), start: async () => null };
  const chat = new NativeChat({ file, terminal: terminal as NativeChatTerminal, context: () => '', emit: () => {}, transport: () => ({ initialize: async () => {}, request: async (_m, p) => ({ thread: { id: p?.threadId } }), close() {}, nativeTerminal: true }) as FakeTransport<'initialize' | 'close' | 'nativeTerminal'> as NativeChatTransport });
  t.after(() => chat.close());
  await chat.restoring;
  // @ts-expect-error -- no idleMs on purpose: the type requires it, and a call without one must not park a chat used a second ago
  assert.deepEqual(await chat.parkIdle({ now }), []);
  assert.deepEqual(await chat.parkIdle({ idleMs: NaN, now }), []);
  assert.deepEqual(killed, []); assert.equal(chat.get('recent').terminalId, 'pty-recent');
});
