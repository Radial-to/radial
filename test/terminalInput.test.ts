// How many inputs each pty has had through this process (terminal.ts inputEpoch):
// what src/core/questions.ts tells one occurrence of a question from the next by,
// and an answer checks before each key. Typing counts; a terminal's own replies
// to its CLI and the mouse just moving don't.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { tmpDir } from './support/tmp';
const fs = require('node:fs') as typeof import('node:fs'), path = require('node:path') as typeof import('node:path'), net = require('node:net') as typeof import('node:net');

test('typedInput: keys, pastes, clicks and the wheel are typing; cursor, color and focus replies and mouse moves are not', () => {
  const { typedInput } = require('../src/main/terminal') as typeof import('../src/main/terminal');
  for (const keys of ['\x1b[B', '\r', 'y', '\x1b[200~sk-1\x1b[201~', '\x1b[<0;12;5M', '\x1b[<0;12;5m', '\x1b[<64;12;5M', '\x1b[I\x1b[B']) assert.equal(typedInput(keys), true, JSON.stringify(keys));
  for (const reply of ['\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[0n', '\x1b[?62;22c', '\x1b[>0;276;0c', '\x1b[?1u', '\x1b]11;rgb:1e1e/1e1e/1e1e\x07', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\', '\x1b[<35;12;5M', '\x1b[<32;13;5M', '\x1b[I\x1b[12;40R']) assert.equal(typedInput(reply), false, JSON.stringify(reply));
});

test('inputEpoch counts each pty\'s typing as it goes to the daemon, and forgets a pty once it exits', async () => {
  const dir = tmpDir('radial-terminal-input-');
  const socketPath = path.join(dir, 'test.sock');
  const sent: string[] = [];
  let socket: Socket | undefined;
  const server = net.createServer((client) => {
    socket = client; let buffer = '';
    client.on('data', (data) => { buffer += data; let nl; while ((nl = buffer.indexOf('\n')) >= 0) { const m = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); if (m.op === 'input') sent.push(`${m.id}:${m.data}`); } });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  delete require.cache[require.resolve('../src/main/terminal')];
  const terminal = require('../src/main/terminal') as typeof import('../src/main/terminal');
  terminal.init({ socketPath, daemonScript: 'unused' });
  try {
    assert.equal(terminal.inputEpoch('pty1'), 0);
    terminal.write('pty1', '\x1b[B'); terminal.write('pty1', '\x1b[12;40R'); terminal.write('pty1', '\x1b[I'); terminal.write('pty1', '\x1b[<35;3;4M');
    assert.equal(terminal.inputEpoch('pty1'), 1, 'one key; the replies and the move don\'t count');
    terminal.write('pty1', '\r'); terminal.write('pty2', 'x');
    assert.deepEqual([terminal.inputEpoch('pty1'), terminal.inputEpoch('pty2')], [2, 1], 'each pty its own');
    for (let i = 0; i < 100 && sent.length < 6; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(sent, ['pty1:\x1b[B', 'pty1:\x1b[12;40R', 'pty1:\x1b[I', 'pty1:\x1b[<35;3;4M', 'pty1:\r', 'pty2:x'], 'every input still goes in');
    socket!.write(JSON.stringify({ op: 'exit', id: 'pty1' }) + '\n');
    for (let i = 0; i < 100 && terminal.inputEpoch('pty1'); i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual([terminal.inputEpoch('pty1'), terminal.inputEpoch('pty2')], [0, 1]);
  } finally {
    socket?.destroy(); await new Promise<Error | undefined>((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
