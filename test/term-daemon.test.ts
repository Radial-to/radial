// The terminal daemon (term-daemon.ts) as its own process on a tmp socket, the
// way the app runs it. --ephemeral: it takes everything down once the test's
// client leaves, and the finally kills it either way.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { tmpDir } from './support/tmp';

const DAEMON = path.join(__dirname, '..', 'src', 'main', 'term-daemon.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ENV = { ...process.env, RADIAL_NO_CAFFEINATE: '1' };

/** A daemon on sock, the way the app starts one. */
function startDaemon(sock: string): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', DAEMON, sock, '--ephemeral'], { stdio: 'ignore', env: ENV });
}
/** A client of the daemon on sock, once it answers: ask() sends one request and resolves its reply. */
async function connectTo(sock: string) {
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await sleep(100);
  const client = await new Promise<net.Socket>((resolve, reject) => { const s = net.createConnection(sock); s.once('connect', () => resolve(s)); s.once('error', reject); });
  let buf = '', seq = 0;
  const replies = new Map<string, Record<string, unknown>>();
  client.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>; buf = buf.slice(nl + 1); if (typeof m.reqId === 'string') replies.set(m.reqId, m); }
  });
  const ask = async (msg: Record<string, unknown>) => {
    const reqId = 'q' + (++seq);
    client.write(JSON.stringify({ ...msg, reqId }) + '\n');
    for (let i = 0; i < 100 && !replies.has(reqId); i++) await sleep(50);
    return replies.get(reqId);
  };
  return { client, ask };
}

test('a socket line that parses to null (or any non-object) is skipped, and the daemon keeps answering', async () => {
  const sock = path.join(tmpDir('radial-td-'), 'd.sock');
  const daemon = startDaemon(sock);
  let exited = false;
  daemon.on('exit', () => { exited = true; });
  let client: net.Socket | null = null;
  try {
    const d = await connectTo(sock);
    client = d.client;
    assert.equal(typeof (await d.ask({ op: 'hello' }))?.version, 'number', 'the daemon answers');
    client.write('null\n5\n"text"\ntrue\n[]\n');
    const after = await d.ask({ op: 'hello' });
    assert.equal(exited, false, 'the daemon is still running');
    assert.equal(typeof after?.version, 'number', 'and still answers');
  } finally {
    client?.destroy();
    daemon.kill();
  }
});

test('a second daemon started on a live daemon’s socket leaves, and new clients still reach the first one’s terminals', async () => {
  const dir = tmpDir('radial-td-');
  const sock = path.join(dir, 'd.sock');
  const first = startDaemon(sock);
  let second: ChildProcess | null = null;
  const clients: net.Socket[] = [];
  try {
    const a = await connectTo(sock); clients.push(a.client);
    const started = await a.ask({ op: 'start', repoDir: dir, command: { bin: '/bin/sh', args: ['-c', 'sleep 30'] } });
    assert.equal(typeof started?.id, 'string', 'the first daemon runs a terminal');
    second = startDaemon(sock);
    const code = await new Promise<number | null | 'still running'>((resolve) => {
      const timer = setTimeout(() => resolve('still running'), 8000);
      second!.once('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 0, 'the second daemon found the first answering and left');
    const b = await connectTo(sock); clients.push(b.client);
    const listed = await b.ask({ op: 'list' });
    assert.deepEqual((listed?.ptys as { id: string }[] | undefined)?.map((p) => p.id), [started!.id], 'a new client reaches the first daemon and its terminal');
  } finally {
    for (const c of clients) c.destroy();
    second?.kill();
    first.kill();
  }
});

test('a daemon that exits takes its socket file with it, asked to (shutdown) or told to (SIGTERM)', async () => {
  for (const how of ['shutdown', 'SIGTERM'] as const) {
    const sock = path.join(tmpDir('radial-td-'), 'd.sock');
    const daemon = startDaemon(sock);
    const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()));
    const d = await connectTo(sock);
    try {
      assert.ok(fs.existsSync(sock));
      if (how === 'shutdown') await d.ask({ op: 'shutdown', force: true });
      else daemon.kill('SIGTERM');
      await exited;
      assert.equal(fs.existsSync(sock), false, `after ${how}, no socket file is left`);
    } finally { d.client.destroy(); daemon.kill(); }
  }
});
