// Regression: ISSUE-001 — remote Codex resumes rejected permission CLI flags.
// Found by /qa on 2026-10-04.
// Report: .gstack/qa-reports/qa-report-radial-2026-10-04.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NativeChatTerminal, NativeChatTransport, NativeChatTransportOptions } from '../src/main/nativeChat';
import type { FakeTerminal, FakeTransport, NativeStart } from './support/nativeChat';
import { tmpDir } from './support/tmp';
const fs = require('fs') as typeof import('fs'), os = require('os') as typeof import('os'), path = require('path') as typeof import('path');
const { NativeChat } = require('../src/main/nativeChat') as typeof import('../src/main/nativeChat');
test('shared terminal receives permissions through RPC, never forbidden remote launch flags', async () => {
  const dir = tmpDir('radial-remote-permissions-');
  let callbacks!: NativeChatTransportOptions, launch!: NativeStart; // set by the stand-ins once setView connects and opens the terminal
  const chat = new NativeChat({ file: path.join(dir, 'chats.json'), context: () => '', emit: () => {},
    transport: options => { callbacks = options; return { initialize: async () => {}, close() {}, endpoint: 'unix:///fixture', bin: 'codex', request: async () => ({thread: {id: 'same-thread'}}) } as FakeTransport<'initialize' | 'close' | 'endpoint' | 'bin'> as NativeChatTransport; },
    terminal: { list: async () => [], start: async (_, options) => { launch = options; return 'pty'; }, kill() {} } as FakeTerminal<'list' | 'kill'> as NativeChatTerminal,
  });
  try {
    const s = chat.create(dir); s.permissionMode = 'full'; s.threadId = 'same-thread';
    await chat.setView(s.id, 'terminal');
    assert.ok(launch.command.args.includes('--remote'));
    assert.ok(!launch.command.args.includes('--sandbox'));
    assert.ok(!launch.command.args.includes('--ask-for-approval'));
    assert.deepEqual(callbacks.terminalParams!('thread/resume', {threadId: 'same-thread'}), {threadId: 'same-thread', sandbox: 'danger-full-access', approvalPolicy: 'never'}); // connect gives every transport one
    assert.deepEqual(callbacks.terminalParams!('thread/read', {threadId: 'same-thread'}), {threadId: 'same-thread'});
  } finally { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
