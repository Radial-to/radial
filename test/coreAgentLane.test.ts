// The core's own agent lane (src/core/agentLane.ts) against a terminal service
// from before `tail` (PTY daemon v6 and older), which the core keeps when an
// update lands while agent sessions are live. The core reads a session's
// screen through tail to see a paste land; without it, it would paste again
// and again into a session it can't see. So agent start and send refuse,
// saying why, as agent output and wait already do. A stand-in daemon answers
// hello as v6 with a live session.

import { test, after } from 'node:test';
import assert from 'node:assert';
import net from 'net';
import path from 'path';
import { createCore } from '../src/core';
import type { CoreHost } from '../src/core';
import * as terminal from '../src/main/terminal';
import { tmpDir } from './support/tmp';

const dataDir = tmpDir('radial-lane-old-');
const sock = path.join(dataDir, 'old-daemon.sock');
const host: CoreHost = {
  platform: { version: '9.9.9', flavor: 'headless', dataDir, home: dataDir, osVersion: 'test', cliBin: path.join(dataDir, 'radial'), keepAwake() {} },
  page: null, viewer: null, events: { send() {}, listening: () => false },
};
const api = createCore(host, { idleSleepMs: null, parkAgents: false, browserShims: false }).cliApi();

// A daemon from before tail: it answers hello (v6, one live session) and list, and nothing else.
const clients = new Set<net.Socket>();
const old = net.createServer((s) => {
  clients.add(s);
  let buf = '';
  s.on('data', (d) => {
    buf += d.toString('utf8');
    for (let nl; (nl = buf.indexOf('\n')) >= 0;) {
      const msg = JSON.parse(buf.slice(0, nl)) as { op: string; reqId?: string }; buf = buf.slice(nl + 1);
      if (msg.op === 'hello') s.write(JSON.stringify({ op: 'reply', reqId: msg.reqId, version: 6, alive: 1 }) + '\n');
      if (msg.op === 'list') s.write(JSON.stringify({ op: 'reply', reqId: msg.reqId, ptys: [{ id: 'pty1', repoDir: dataDir, meta: { engine: 'claude' }, alive: true }] }) + '\n');
    }
  });
});
after(() => { for (const s of clients) s.destroy(); old.close(); }); // the core's connection goes with them, so the test process can end

test('with a terminal service too old to show a session’s screen, agent start and send refuse instead of typing blind', async () => {
  await new Promise<void>((resolve) => old.listen(sock, resolve));
  terminal.init({ socketPath: sock, daemonScript: path.join(dataDir, 'no-daemon.js') });
  await terminal.connect(); // hellos, and keeps the old daemon for its live session
  assert.equal(terminal.tailSupported(), false);
  const start = await api.agentStart(dataDir, { task: 'Fix the hero', submit: false, engine: 'claude', label: null });
  assert.ok(!start.ok && /terminal service is still the previous version/.test(start.error), JSON.stringify(start));
  const send = await api.agentSend('pty1', { text: 'Also the footer', submit: true });
  assert.ok(!send.ok && /terminal service is still the previous version/.test(send.error), JSON.stringify(send));
});
