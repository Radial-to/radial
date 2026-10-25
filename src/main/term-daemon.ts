/**
 * Persistent PTY service (Solo/tmux style). Runs DETACHED from the Radial app so
 * agent terminals keep running when Radial is closed — on reopen, Radial
 * reconnects and reattaches to the still-running processes, replaying each one's
 * buffered output so you land exactly where you left off.
 *
 * Launched via Electron-as-node (ELECTRON_RUN_AS_NODE=1) so node-pty's native
 * binding — built against Electron's ABI — loads. argv[2] is the unix socket path.
 *
 * Wire protocol: newline-delimited JSON, both directions.
 *   client→daemon: {op:start|list|attach|detach|input|resize|kill|setMeta, ...}
 *   daemon→client: {op:reply, reqId, ...} | {op:data, id, data} | {op:exit, id}
 */

import net from 'net';
import fs from 'fs';
import path from 'path';
import * as pty from 'node-pty';
import { childEnv, userShell } from './env';
import { relayOpen } from './openRelay';
import { spawn } from 'child_process';
import { pickExpired, isKeptAwake } from './agentSleep';
import { bellScanner } from './termBell';
import { probeSocket } from './socketProbe';
import type { ChildProcess } from 'child_process';
import type { ClientMessage, DaemonMessage, PtyMeta, ReapedPty, TermCommand } from './terminal';
import type { RelayClient } from './openRelay';

/** A pty this daemon runs: its process, replayable scrollback and activity stamps. */
interface PtyRecord {
  id: string;
  repoDir: string;
  meta: PtyMeta;
  proc: pty.IPty;
  /** Recent output, oldest first, kept near BUF_CAP bytes. */
  chunks: string[];
  bytes: number;
  exited: boolean;
  startedAt: number;
  lastDataAt: number;
  lastBellAt: number;
  lastInputAt: number;
}
/** A connection: the app (isApp once it subscribes), or a radial-open shim passing through. */
interface DaemonClient extends RelayClient {
  sock: net.Socket;
  /** The ptys whose output and exit it gets. */
  attached: Set<string>;
}

// Bumped when the daemon's spawn behavior changes (e.g. the pinned color env).
// The app hellos on connect and rolls an OUTDATED, IDLE daemon so fixes ship
// without waiting for a natural idle-exit. A daemon with live ptys is never
// rolled — session persistence outranks freshness.
// v3: list() reports lastDataAt so the app can tell idle agents from working
// ones (agent sleep). A v2 daemon omits it, which safely disables reaping.
// v4: the daemon expires parked agents ITSELF (agentSleep.pickExpired ceiling),
// logging each reap to <sock>.reaped.jsonl so the app can turn resumable ones
// into slept records. Persistence is for agents someone comes back to — not for
// sessions parked for days maxing out swap while Radial isn't even running.
const DAEMON_VERSION = 12; // v12: never replaces a live daemon's socket; the browser shim's env only when the shim is there; v11: exits within seconds once the app has left and nothing runs; v5: RADIAL_CLI_SOCK in the pty env, lastBellAt, the `tail` op; v6: startedAt, cols/rows; v7: lastInputAt (plans/radial-agent-native.md); v8: keep-awake (meta.keepAwake skips the ceiling, caffeinate holds the Mac — plans/radial-keep-awake.md); v9: FORCE_HYPERLINK in the pty env; v10: a bell is a bare BEL, not the end of a title or link

const SOCK = process.argv[2];
if (!SOCK) process.exit(1);
// --ephemeral: spawned by a throwaway app instance (tests, the smoke, screenshot
// scripts). When its last client disconnects, this daemon takes every pty down
// and exits, so nothing outlives the run even if the app was killed mid-quit.
const EPHEMERAL = process.argv.includes('--ephemeral');

const BUF_CAP = 1_000_000; // ~1MB of replayable scrollback per terminal
let seq = 0;
const ptys = new Map<string | null, PtyRecord>();   // id -> { id, repoDir, meta, proc, chunks:[], bytes, exited } (never a null key, but `open` looks up a shim's null termId)
const clients = new Set<DaemonClient>(); // { sock, attached:Set<id> }

function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return userShell();
}
function sendTo(client: DaemonClient, msg: DaemonMessage): void { try { client.sock.write(JSON.stringify(msg) + '\n'); } catch {} }
function broadcastData(id: string, data: string): void { for (const c of clients) if (c.attached.has(id)) sendTo(c, { op: 'data', id, data }); }
function broadcastExit(id: string): void { for (const c of clients) if (c.attached.has(id)) sendTo(c, { op: 'exit', id }); }

function appendBuf(rec: PtyRecord, data: string): void {
  rec.chunks.push(data);
  rec.bytes += Buffer.byteLength(data);
  while (rec.bytes > BUF_CAP && rec.chunks.length > 1) rec.bytes -= Buffer.byteLength(rec.chunks.shift()!);
}

function startPty(repoDir: string, command: TermCommand | null | undefined, cols: number | undefined, rows: number | undefined, meta: PtyMeta | undefined, shimDir: string | null | undefined): PtyRecord {
  const id = 'pty' + (++seq) + Date.now().toString(36);
  const file = command && command.bin ? command.bin : defaultShell();
  const args = command && command.args ? command.args : [];
  // Color env is baked into the PTY at spawn: a Finder-launched app has no
  // COLORTERM/FORCE_COLOR in its launchd env, and CLIs spawned then render
  // monochrome for the pty's whole life (even across reattaches). Pin them.
  // FORCE_HYPERLINK: the app's xterm opens OSC 8 links in the browser, so CLIs
  // that check it (Claude Code) print whole links even when a long URL wraps.
  const env = childEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '3', FORCE_HYPERLINK: '1' });
  // Browser shim — SCOPED to this PTY only (NOT global childEnv, which 14 other
  // modules share for git/gh/vercel/deploy). Shadowing `open`/`xdg-open` and
  // setting $BROWSER here lets an agent's browser launch be caught and routed
  // into Radial's preview instead of escaping to the system browser. The shim
  // calls back over THIS daemon's socket, tagged with this pty's id for routing.
  if (shimDir) {
    env.PATH = shimDir + path.delimiter + (env.PATH || '');
    // The browser shim only when the app wrote one: `radial serve` has no
    // preview for a launch to land in, and writes just the `radial` shim.
    if (fs.existsSync(path.join(shimDir, 'radial-open'))) {
      env.BROWSER = path.join(shimDir, 'radial-open');
      env.RADIAL_OPEN_SOCK = SOCK;
      env.RADIAL_TERM_ID = id;
      env.RADIAL_SHIM_HELPER = path.join(shimDir, 'radial-open-helper.js');
    }
    env.RADIAL_CLI_SOCK = path.join(path.dirname(SOCK), 'cli.sock'); // the app's control socket, for the `radial` CLI in this terminal
  }
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: cols || 80, rows: rows || 24,
    cwd: repoDir,
    env,
  });
  const rec: PtyRecord = { id, repoDir, meta: meta || {}, proc, chunks: [], bytes: 0, exited: false, startedAt: Date.now(), lastDataAt: Date.now(), lastBellAt: 0, lastInputAt: 0 };
  ptys.set(id, rec);
  // lastDataAt = last pty OUTPUT (typing echoes, so it covers input too). The
  // app reads it via list() to tell idle agents from working ones (agent sleep).
  // lastBellAt: Claude Code rings BEL when a turn completes or it needs attention —
  // the completion signal `radial agent wait` and Home's activity read. Only a
  // bare BEL counts: titles and links end in BEL too (termBell.js).
  const isBell = bellScanner();
  proc.onData((data) => { rec.lastDataAt = Date.now(); if (isBell(data)) rec.lastBellAt = rec.lastDataAt; appendBuf(rec, data); broadcastData(id, data); });
  proc.onExit(() => { rec.exited = true; broadcastExit(id); ptys.delete(id); syncAwake(); });
  return rec;
}

function handle(client: DaemonClient, msg: ClientMessage): void {
  switch (msg.op) {
    case 'hello': {
      const alive = [...ptys.values()].filter((r) => !r.exited).length;
      sendTo(client, { op: 'reply', reqId: msg.reqId, version: DAEMON_VERSION, alive });
      break;
    }
    case 'shutdown': {
      // force: take every pty down with the daemon — how a throwaway app instance
      // (tests, smoke, screenshot scripts: RADIAL_DAEMON_EPHEMERAL) leaves nothing
      // behind. A real app never forces: persistence is the whole point.
      if (msg.force) { for (const r of ptys.values()) { try { r.proc.kill(); } catch {} } ptys.clear(); }
      const alive = [...ptys.values()].filter((r) => !r.exited).length;
      sendTo(client, { op: 'reply', reqId: msg.reqId, ok: alive === 0 });
      if (alive === 0) setTimeout(() => process.exit(0), 50);
      break;
    }
    case 'start': {
      const rec = startPty(msg.repoDir, msg.command, msg.cols, msg.rows, msg.meta, msg.shimDir);
      client.attached.add(rec.id);
      syncAwake();
      sendTo(client, { op: 'reply', reqId: msg.reqId, id: rec.id });
      break;
    }
    // The app (main) marks itself a subscriber so `open` broadcasts reach it and
    // the delivery ack can tell a transient shim whether anyone was listening.
    case 'subscribe': { client.isApp = true; break; }
    // The radial-open shim relays an agent's browser launch. Resolve the pty's
    // repoDir (identity → which project's preview), broadcast to app subscribers,
    // and ACK whether at least one received it — so the shim never reports a
    // dropped open as success (the exact "says copied but didn't" failure class).
    case 'open': {
      const rec = ptys.get(msg.termId);
      const repoDir = rec ? rec.repoDir : null;
      const delivered = relayOpen(clients, client, { termId: msg.termId, repoDir, url: msg.url }, sendTo);
      sendTo(client, { op: 'reply', reqId: msg.reqId, ok: delivered > 0 });
      break;
    }
    case 'list': {
      const list = [...ptys.values()]
        .filter((r) => !msg.repoDir || r.repoDir === msg.repoDir)
        .map((r) => ({ id: r.id, repoDir: r.repoDir, meta: r.meta, alive: !r.exited, pid: r.proc.pid || null, startedAt: r.startedAt || 0, lastDataAt: r.lastDataAt, lastBellAt: r.lastBellAt || 0, lastInputAt: r.lastInputAt || 0, cols: r.proc.cols, rows: r.proc.rows, attached: isAttached(r.id) }));
      sendTo(client, { op: 'reply', reqId: msg.reqId, ptys: list });
      break;
    }
    case 'attach': {
      const rec = ptys.get(msg.id);
      if (!rec) { sendTo(client, { op: 'exit', id: msg.id }); break; }
      client.attached.add(rec.id);
      // Replay buffered scrollback so the terminal shows its history, then live.
      const replay = rec.chunks.join('');
      if (replay) sendTo(client, { op: 'data', id: rec.id, data: replay });
      break;
    }
    // The last N bytes of a pty's scrollback WITHOUT attaching — how the CLI/MCP
    // read an agent's recent output (`radial agent output`).
    case 'tail': {
      const rec = ptys.get(msg.id);
      if (!rec) { sendTo(client, { op: 'reply', reqId: msg.reqId, ok: false, code: 'not-found' }); break; }
      const all = rec.chunks.join('');
      const n = Math.max(0, Math.min(Number(msg.bytes) || 16000, 200000));
      sendTo(client, { op: 'reply', reqId: msg.reqId, ok: true, id: rec.id, data: all.slice(-n), alive: !rec.exited, startedAt: rec.startedAt || 0, lastDataAt: rec.lastDataAt, lastBellAt: rec.lastBellAt || 0, lastInputAt: rec.lastInputAt || 0, cols: rec.proc.cols, rows: rec.proc.rows, meta: rec.meta, repoDir: rec.repoDir });
      break;
    }
    case 'detach': { client.attached.delete(msg.id); break; }
    case 'input': { const r = ptys.get(msg.id); if (r) { r.lastInputAt = Date.now(); try { r.proc.write(msg.data); } catch {} } break; } // lastInputAt: `radial agent wait` counts a bell only after the latest input
    case 'resize': { const r = ptys.get(msg.id); if (r && msg.cols > 0 && msg.rows > 0) try { r.proc.resize(msg.cols, msg.rows); } catch {} break; }
    case 'kill': { const r = ptys.get(msg.id); if (r) { try { r.proc.kill(); } catch {} ptys.delete(msg.id); } syncAwake(); break; }
    case 'setMeta': { const r = ptys.get(msg.id); if (r) r.meta = { ...r.meta, ...(msg.meta || {}) }; syncAwake(); break; } // keepAwake rides on meta
    case 'ping': { sendTo(client, { op: 'reply', reqId: msg.reqId, pong: true }); break; }
  }
}

let hadClient = false; // an app has connected at least once
const server = net.createServer((sock) => {
  hadClient = true;
  const client: DaemonClient = { sock, attached: new Set() };
  clients.add(client);
  let partial = '';
  sock.on('data', (chunk) => {
    partial += chunk.toString('utf8');
    let nl;
    while ((nl = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, nl); partial = partial.slice(nl + 1);
      if (!line.trim()) continue;
      let parsed: unknown; try { parsed = JSON.parse(line); } catch { continue; }
      // Not a message unless it's an object, as cliProto.makeDecoder reads its lines: a `null` line would
      // throw in handle and again in the catch below, out of this listener, and take every pty down with the daemon.
      if (!parsed || typeof parsed !== 'object') continue;
      const msg = parsed as ClientMessage & { reqId?: string }; // a line the app (terminal.ts) or its radial-open shim wrote: its fields are trusted
      try { handle(client, msg); } catch (error) { if (msg.reqId) sendTo(client, { op: 'reply', reqId: msg.reqId, error: (error as Error).message }); }
    }
  });
  const drop = () => {
    clients.delete(client); // disconnect ≠ kill; ptys stay alive (a real app reattaches later)
    if (EPHEMERAL && clients.size === 0) setTimeout(() => { // a grace beat: the same run may reconnect
      if (clients.size) return;
      for (const r of ptys.values()) { try { r.proc.kill(); } catch {} }
      ptys.clear();
      setTimeout(() => process.exit(0), 100);
    }, 1500);
  };
  sock.on('close', drop); sock.on('error', drop);
});
server.on('error', () => process.exit(1)); // socket in use → another daemon owns it
// Two clients that both found no daemon (two quick launches, or `radial serve`
// started twice on one data dir) each spawn one. The socket file is replaced
// only when nothing answers there (left by a daemon that died); when a live
// daemon answers, this one leaves, so its terminals stay reachable to every
// client instead of being cut off behind a newer daemon's socket.
probeSocket(SOCK).then((found) => {
  if (found === 'live') process.exit(0);
  if (found !== 'dead') process.exit(1); // can't tell whether it's in use: leave it be
  try { fs.unlinkSync(SOCK); } catch {}
  server.listen(SOCK, () => {
    // Restrict the control socket to the owner (it accepts input/kill/open). Best
    // effort: listen() perms are umask-dependent, so set it explicitly.
    try { fs.chmodSync(SOCK, 0o700); } catch {}
    // A daemon that exits takes its socket file with it (it's this daemon's: no
    // other replaces a live one), so none is left for a reader to mistake.
    process.on('exit', () => { try { fs.unlinkSync(SOCK); } catch {} });
  });
});
// Asked to stop (pkill by socket path, a container's shutdown): exit the same way, through 'exit'.
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0));

function isAttached(id: string): boolean { for (const c of clients) if (c.attached.has(id)) return true; return false; }

// Keep the Mac awake while any kept-awake session (meta.keepAwake) is alive:
// `caffeinate -i` holds a no-idle-sleep assertion (the display may still sleep;
// closing a MacBook's lid still sleeps it), `-w` ties it to this daemon so it can
// never outlive us. Held HERE rather than in the app so a session someone is
// driving from their phone keeps answering after Radial itself is closed — the
// app holds its own assertion while it runs (main.js syncKeepAwake). Throwaway
// (ephemeral) daemons never touch the Mac's power state.
let caff: ChildProcess | null = null;
function syncAwake(): void {
  if (process.platform !== 'darwin' || EPHEMERAL || process.env.RADIAL_NO_CAFFEINATE) return;
  const want = [...ptys.values()].some((r) => !r.exited && isKeptAwake(r));
  if (want && !caff) {
    try {
      const c = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      c.on('exit', () => { if (caff === c) caff = null; });
      c.on('error', () => { if (caff === c) caff = null; });
      caff = c;
    } catch { caff = null; }
  } else if (!want && caff) {
    const c = caff; caff = null;
    try { c.kill(); } catch {}
  }
}

// Expire parked agents (the founder-machine swap incident: ~20 idle claude
// sessions aged 12h-2.7d under this daemon, nothing ever reaping them). Runs
// HERE, not in the app, because the leak's worst case is exactly when Radial
// isn't running. Each reap is logged so the app, next time it connects, turns
// resumable (claude --session-id) ones into slept records that come back via
// --resume; the rest were unrecoverable parked processes and are simply gone.
const REAP_LOG = SOCK + '.reaped.jsonl';
setInterval(() => {
  const now = Date.now();
  const snapshot = [...ptys.values()].map((r) => ({ id: r.id, repoDir: r.repoDir, meta: r.meta, alive: !r.exited, lastDataAt: r.lastDataAt, attached: isAttached(r.id) }));
  for (const p of pickExpired(snapshot, now)) {
    const rec = ptys.get(p.id);
    if (!rec) continue;
    try { fs.appendFileSync(REAP_LOG, JSON.stringify({ id: rec.id, repoDir: rec.repoDir, meta: rec.meta, reapedAt: now } satisfies ReapedPty) + '\n'); } catch {}
    try { rec.proc.kill(); } catch {}
    ptys.delete(rec.id); // same semantics as the 'kill' op
  }
  syncAwake();
}, 5 * 60_000);

// Exit only when there's truly nothing to keep alive (no ptys, no clients), so a
// stray launch doesn't leave a zombie but real sessions persist. Once the app has
// connected and left (quit) with nothing running, go within seconds; a daemon no
// app ever reached still waits a minute for its first connection.
let emptySince = 0;
setInterval(() => {
  if (ptys.size || clients.size) { emptySince = 0; return; }
  emptySince ||= Date.now();
  if (Date.now() - emptySince >= (hadClient ? 3000 : 60_000)) process.exit(0);
}, 1000);
