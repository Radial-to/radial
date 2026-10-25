import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import type { ClientMessage, ErrorReply } from '../src/main/terminal';
import { tmpDir } from './support/tmp';
const fs = require('node:fs') as typeof import('node:fs'), os = require('node:os') as typeof import('node:os'), path = require('node:path') as typeof import('node:path'), net = require('node:net') as typeof import('node:net');

for (const failure of ['reply', 'disconnect']) test(`terminal ${failure} failures reject instead of leaving view switches pending`, async () => {
  const dir = tmpDir('radial-terminal-connection-');
  const socketPath = path.join(dir, 'test.sock');
  let socket: Socket | undefined;
  const server = net.createServer(client => {
    socket = client; let buffer = '';
    client.on('data', data => {
      buffer += data;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message: ClientMessage & { reqId?: string } = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (!message.reqId) continue;
        if (failure === 'disconnect') client.destroy();
        else client.write(JSON.stringify({ op: 'reply', reqId: message.reqId, error: 'ENOENT: native CLI missing' } satisfies ErrorReply) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  delete require.cache[require.resolve('../src/main/terminal')];
  const terminal = require('../src/main/terminal') as typeof import('../src/main/terminal');
  terminal.init({ socketPath, daemonScript: 'unused' });
  try {
    await assert.rejects(terminal.start(dir, { command: { bin: '/missing/native-cli', args: [] } }), failure === 'reply' ? /ENOENT/ : /connection closed/);
  } finally {
    socket?.destroy(); await new Promise<Error | undefined>(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the count of running terminals comes only from a daemon already connected: never a connect, so never a spawn', async () => {
  const dir = tmpDir('radial-terminal-count-');
  const socketPath = path.join(dir, 'test.sock');
  let connections = 0;
  const clients: Socket[] = [];
  const server = net.createServer(client => {
    connections++; clients.push(client); let buffer = '';
    client.on('data', data => {
      buffer += data;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message: ClientMessage & { reqId?: string } = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (message.reqId && message.op === 'list') client.write(JSON.stringify({ op: 'reply', reqId: message.reqId, ptys: [{ id: 'a', alive: true }, { id: 'b', alive: false }, { id: 'c', alive: true }] }) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  delete require.cache[require.resolve('../src/main/terminal')];
  const terminal = require('../src/main/terminal') as typeof import('../src/main/terminal');
  terminal.init({ socketPath, daemonScript: 'unused' });
  try {
    assert.equal(await terminal.liveCount(), null, 'not connected: unknown');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(connections, 0, 'and it never tried to connect (which would start a daemon)');
    await terminal.list(null); // the app connects for its own reasons
    assert.equal(await terminal.liveCount(), 2, 'connected: the ones still alive');
  } finally {
    for (const client of clients) client.destroy();
    await new Promise<Error | undefined>(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
