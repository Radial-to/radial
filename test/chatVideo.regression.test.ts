import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NativeChatApprovalParams, NativeChatReply, NativeChatTerminal, NativeChatTransport } from '../src/main/nativeChat';
import type { InteractiveOptions } from '../src/main/chat/interactive';
import type { FakeList, FakeTerminal, FakeTransport, NativeStart, PtyWrite } from './support/nativeChat';
import { tmpDir } from './support/tmp';
const fs = require('fs') as typeof import('fs'), os = require('os') as typeof import('os'), path = require('path') as typeof import('path');
const { NativeChat } = require('../src/main/nativeChat') as typeof import('../src/main/nativeChat');
const { InteractiveTransport } = require('../src/main/chat/interactive') as typeof import('../src/main/chat/interactive');
/** What was written: input to the terminal (write), or an answer NativeChat wrote to a CLI. */
type Written = (PtyWrite & { result?: undefined }) | NativeChatReply;
function setup() {
  const dir = tmpDir('radial-video-');
  const writes: Written[] = [], starts: NativeStart[] = [], kills: string[] = []; let alive = false;
  const chat = new NativeChat({ file: path.join(dir, 'chats.json'), context: () => '', emit: () => {},
    terminal: { start: async (_cwd, options) => { alive = true; starts.push(options); return 'pty'; }, list: async () => alive ? [{ id: 'pty', alive, meta: starts[0].meta }] : [], write: (id, data) => writes.push({ id, data }), kill: id => { kills.push(id); alive = false; } } as FakeTerminal<'write' | 'kill'> & FakeList<'id' | 'alive' | 'meta'> as NativeChatTerminal,
    transport: options => {
      if (options.engine === 'codex') return { initialize: async () => {}, close() {}, write: m => writes.push(m), request: async () => ({ data: [] }) } as FakeTransport<'initialize' | 'close' | 'write'> as NativeChatTransport; // a Codex chat's CLI, which lists no models and records answers
      const env = { RADIAL_USERDATA: dir, ['RADIAL_CHAT_TEST_' + options.engine.toUpperCase()]: process.execPath };
      const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
      Object.assign(process.env, env);
      try {
        const transport = new InteractiveTransport({ ...options, env: { CURSOR_CONFIG_DIR: dir } } as InteractiveOptions); // a Claude or Cursor chat (Codex returned above), which connect gives its session, the terminal and runtimeRoot
        transport.transcript = path.join(dir, 'transcript.jsonl'); return transport;
      } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
    },
  });
  return { chat, dir, writes, starts, kills, close() { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
test('a saved command approval uses only the exact rule proposed by Codex', () => {
  const f = setup();
  try {
    const s = f.chat.create(f.dir, true); f.chat.live.set(s.id, { write: m => f.writes.push(m), close() {} } as Pick<NativeChatTransport, 'write' | 'close'> as NativeChatTransport); // a stand-in Codex CLI: requestFromCli and respond only write it answers
    f.chat.requestFromCli(s, { id: 1, method: 'item/commandExecution/requestApproval', params: { command: 'radial open /sites/one', proposedExecpolicyAmendment: ['radial', 'open'] } });
    assert.deepEqual(s.approval!.commandRule, ['radial', 'open']); // the request is waiting
    assert.equal(f.writes.length, 0, 'saving a rule requires an explicit click');
    // @ts-expect-error -- commandRule on purpose: respond() never takes a rule from the window, only the one Codex proposed (approval.commandRule)
    f.chat.respond(s.id, { requestId: 1, decision: 'acceptWithExecpolicyAmendment', commandRule: ['sh'] });
    assert.deepEqual(f.writes.at(-1)!.result, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['radial', 'open'] } } }); // respond just wrote the answer
    assert.equal(s.permissionMode, undefined, 'does not enable full access');
    for (const [id, params] of [[2, {}], [3, { proposedExecpolicyAmendment: [] }], [4, { proposedExecpolicyAmendment: ['radial'], availableDecisions: ['accept', 'decline'] }]] satisfies [number, NativeChatApprovalParams][]) {
      f.chat.requestFromCli(s, { id, method: 'item/commandExecution/requestApproval', params });
      assert.throws(() => f.chat.respond(s.id, { requestId: id, decision: 'acceptWithExecpolicyAmendment' }), /available approval/);
      f.chat.respond(s.id, { requestId: id, decision: 'decline' });
    }
    const rule = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['radial', 'ls'] } };
    f.chat.requestFromCli(s, { id: 5, method: 'item/commandExecution/requestApproval', params: { availableDecisions: ['accept', rule, 'decline'] } });
    assert.deepEqual(s.approval!.commandRule, ['radial', 'ls']); // the request is waiting
    f.chat.respond(s.id, { requestId: 5, decision: 'acceptWithExecpolicyAmendment' });
    assert.deepEqual(f.writes.at(-1)!.result!.decision, rule); // respond just wrote the answer
  } finally { f.close(); }
});
test('Claude view switching preserves a typed draft without any confirmation or CLI input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = setup();
  try {
    const s = f.chat.create(f.dir, false, 'claude');
    await f.chat.setView(s.id, 'terminal');
    const transport = f.chat.live.get(s.id), threadId = s.threadId;
    assert.equal(s.terminalHasInput, false);
    f.chat.recordTerminalInput('pty', '\x1b[?1;2c\x1b[>0;276;0c\x1b[1;1R\x1b]11;rgb:1111/2222/3333\x1b\\');
    assert.equal(s.terminalHasInput, false, 'terminal capability replies are not a draft');
    await f.chat.setView(s.id, 'chat');
    await f.chat.setView(s.id, 'terminal');
    f.chat.recordTerminalInput('pty', 'Keep my unsent draft');
    await f.chat.setView(s.id, 'chat');
    assert.equal(s.viewMode, 'chat'); assert.equal(s.terminalHasInput, true);
    assert.equal(s.threadId, threadId); assert.equal(f.chat.live.get(s.id), transport);
    await assert.rejects(f.chat.send(s.id, 'Do not overwrite it'), /unsent Terminal draft/);
    assert.equal(f.starts.length, 1); assert.deepEqual(f.writes, []); assert.deepEqual(f.kills, []);
  } finally { f.close(); }
});

test('an empty saved Cursor conversation opens one native CLI using its original ID', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = setup();
  try {
    const s = f.chat.create(f.dir, false, 'cursor');
    s.threadId = '12345678-1234-1234-1234-123456789abc';
    await f.chat.setView(s.id, 'terminal');
    assert.equal(s.viewMode, 'terminal');
    assert.deepEqual(f.starts[0].command.args.slice(0, 2), ['--resume', s.threadId]);
    assert.equal(f.starts[0].meta.nativeThreadId, s.threadId);
    await f.chat.setView(s.id, 'chat'); await f.chat.setView(s.id, 'terminal');
    assert.equal(f.starts.length, 1); assert.deepEqual(f.writes, []); assert.deepEqual(f.kills, []);
  } finally { f.close(); }
});
