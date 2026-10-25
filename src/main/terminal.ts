/**
 * Terminal layer — a CLIENT of the persistent PTY daemon (term-daemon.js). The
 * PTYs live in the daemon, not here, so they survive Radial being closed: on
 * launch we reconnect and reattach (replaying each terminal's buffered output),
 * exactly like Solo/Conductor. The daemon is spawned on first use via
 * Electron-as-node so node-pty's native binding loads.
 */

import net from 'net';
import { spawn } from 'child_process';
import type { ENGINES } from './engine';

// ── The daemon's wire protocol (term-daemon.js): newline-delimited JSON. ──────

/** The agent CLI a pty runs (engine.js ENGINES); a plain shell has none. */
export type PtyEngine = keyof typeof ENGINES;
/**
 * The window's preview view for a session (the object renderer.ts readThreadPreview
 * builds and threadPreview.ts saves and restores). It is stored in a pty's meta
 * here, so a reattach restores it, and also in projectState.sharedPreview, in
 * slept-agent records (sleptAgents[].preview), in native chat sessions
 * (nativeChat.ts `s.preview`) and on the window's term rows. When threadPreview.ts
 * (a DUAL shared module) is typed, move this type there and import it here.
 */
export interface PreviewView { route: string; scroll: { x: number; y: number }; viewportMode?: string; width?: number; zoom?: number; visualZoom?: number; panX?: number; panY?: number }
/** What the app stores with a pty in the daemon, so it survives an app restart. setMeta merges into it. */
export interface PtyMeta {
  engine?: PtyEngine | null;
  label?: string | null;
  labelSource?: 'auto' | 'manual';
  sessionId?: string | null;      // claude --session-id: how a slept agent resumes
  home?: boolean;                 // the Home workspace agent, not a project's
  preview?: PreviewView | null;
  previewSelectedAt?: number;
  recentTaskAt?: number;
  recentOpenedAt?: number;        // recentTaskAt's older name
  recentPinnedAt?: number;
  nativeChatId?: string;          // the native chat that owns this pty
  nativeThreadId?: string;
  keepAwake?: boolean;            // never parked; the Mac stays awake while it runs
}
/** A program to run instead of the login shell (engine.spawnSpec). */
export interface TermCommand { bin: string; args?: string[] }
/**
 * One pty as `list` reports it. An outdated daemon kept alive for its live ptys
 * leaves out what it predates: lastDataAt (v3), attached (v4), lastBellAt (v5),
 * startedAt, cols and rows (v6), lastInputAt (v7), pid (v10).
 */
export interface PtyInfo {
  id: string; repoDir: string; meta: PtyMeta; alive: boolean;
  pid?: number | null; startedAt?: number; lastDataAt?: number; lastBellAt?: number; lastInputAt?: number;
  cols?: number; rows?: number; attached?: boolean;
}
/** A pty's recent scrollback (`tail`, v5+) and its activity stamps. */
export type PtyTail = Required<Omit<PtyInfo, 'pid' | 'attached'>> & { ok: true; data: string };
/** A line of the daemon's reap log (<sock>.reaped.jsonl): an agent it expired on its own. */
export interface ReapedPty { id: string; repoDir: string; meta: PtyMeta; reapedAt: number }

// app (or the radial-open shim) → daemon: ops the daemon answers, by reqId.
export interface HelloRequest { op: 'hello' }
export interface ShutdownRequest { op: 'shutdown'; force?: boolean }
export type StartRequest = { op: 'start'; repoDir: string; shimDir?: string | null } & TerminalStartOptions;
export interface ListRequest { op: 'list'; repoDir?: string | null }
export interface TailRequest { op: 'tail'; id: string; bytes?: number }
/** From the radial-open shim: termId is null when it runs outside a Radial terminal (no RADIAL_TERM_ID). */
export interface OpenRequest { op: 'open'; termId: string | null; url: string }
export interface PingRequest { op: 'ping' }
export type DaemonRequest = HelloRequest | ShutdownRequest | StartRequest | ListRequest | TailRequest | OpenRequest | PingRequest;
// app → daemon: ops with no reply.
export type DaemonCommand =
  | { op: 'subscribe' }
  | { op: 'attach'; id: string }
  | { op: 'detach'; id: string }
  | { op: 'input'; id: string; data: string }
  | { op: 'resize'; id: string; cols: number; rows: number }
  | { op: 'kill'; id: string }
  | { op: 'setMeta'; id: string; meta: PtyMeta };
/** Every line a client sends. */
export type ClientMessage = DaemonCommand | (DaemonRequest & { reqId: string });

// daemon → client: a reply carries the request's reqId; an op that threw replies with only `error`.
export interface ReplyBase { op: 'reply'; reqId: string; error?: string }
export interface ErrorReply extends ReplyBase { error: string }
export interface HelloReply extends ReplyBase { version: number; alive: number }
export interface ShutdownReply extends ReplyBase { ok: boolean }
export interface StartReply extends ReplyBase { id: string }
export interface ListReply extends ReplyBase { ptys: PtyInfo[] }
export type TailReply = ReplyBase & ({ ok: false; code: 'not-found' } | PtyTail);
export interface OpenReply extends ReplyBase { ok: boolean }
export interface PingReply extends ReplyBase { pong: true }
/** The reply to each request op. */
export interface DaemonReplies { hello: HelloReply; shutdown: ShutdownReply; start: StartReply; list: ListReply; tail: TailReply; open: OpenReply; ping: PingReply }
export type DaemonReply = DaemonReplies[keyof DaemonReplies];
// daemon → client, unasked: output and exits of attached ptys, and an agent's browser launch (app subscribers only).
export interface DataMessage { op: 'data'; id: string; data: string }
export interface ExitMessage { op: 'exit'; id: string }
export interface OpenMessage { op: 'open'; termId: string | null; repoDir: string | null; url: string }
/** Every line the daemon sends. */
export type DaemonMessage = DaemonReply | ErrorReply | DataMessage | ExitMessage | OpenMessage;

// ── This client ──────────────────────────────────────────────────────────────

export interface TerminalInit { socketPath: string; daemonScript: string; shimDir?: string | null }
export interface TerminalHandlers {
  onData: (id: string, data: string) => void;
  onExit: (id: string) => void;
  onOpenUrl?: ((termId: string | null, repoDir: string | null, url: string) => void) | null;
}
export interface TerminalStartOptions { cols?: number; rows?: number; command?: TermCommand | null; meta?: PtyMeta }
/** tail()'s answer: the scrollback, or why there is none. */
export type TailResult = TailReply | { ok: false; code: 'daemon-outdated' | 'timeout' };
interface PendingRequest { resolve: (reply: ReplyBase) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; socket: net.Socket }

let SOCK: string | null = null, DAEMON: string | null = null;
let conn: net.Socket | null = null, connecting: Promise<net.Socket> | null = null;
let reqSeq = 0;
const pending = new Map<string, PendingRequest>();              // reqId -> resolve
let onAnyData: TerminalHandlers['onData'] | null = null, onAnyExit: TerminalHandlers['onExit'] | null = null, onAnyOpenUrl: TerminalHandlers['onOpenUrl'] = null; // forward pty output/exit/browser-open
let shimDir: string | null = null; // dir of the radial-open browser shim, injected per-terminal

function init({ socketPath, daemonScript, shimDir: sd }: TerminalInit): void { SOCK = socketPath; DAEMON = daemonScript; shimDir = sd || null; }
function setGlobalHandlers({ onData, onExit, onOpenUrl }: TerminalHandlers): void { onAnyData = onData; onAnyExit = onExit; onAnyOpenUrl = onOpenUrl || null; }

// A throwaway instance (RADIAL_USERDATA: tests, the smoke, scripts) takes its
// daemon and agents down with it unless it opts out with RADIAL_DAEMON_EPHEMERAL=0.
// Left persistent, test runs leaked daemons with live agents under PPID 1
// (docs/memory-leak-report-2026-10-11.md).
function ephemeral(): boolean { return process.env.RADIAL_DAEMON_EPHEMERAL === '1' || (process.env.RADIAL_DAEMON_EPHEMERAL !== '0' && !!process.env.RADIAL_USERDATA); }

function spawnDaemon() {
  try {
    spawn(process.execPath, [DAEMON!, SOCK!, ...(ephemeral() ? ['--ephemeral'] : [])], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      detached: true, stdio: 'ignore',
    }).unref();
  } catch {}
}

function tryConnect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCK!);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

async function ensureConn(): Promise<net.Socket> {
  if (conn) return conn;
  if (connecting) return connecting;
  connecting = (async () => {
    for (let i = 0; i < 40; i++) {
      try {
        const s = await tryConnect(); wire(s); conn = s;
        // Mark this (the app) as a subscriber so the daemon delivers `open`
        // broadcasts here and can ack the shim that someone was listening.
        try { s.write(JSON.stringify({ op: 'subscribe' }) + '\n'); } catch {}
        return s;
      }
      catch { if (i === 0) spawnDaemon(); await new Promise((r) => setTimeout(r, 150)); }
    }
    throw new Error('term daemon unavailable');
  })().finally(() => { connecting = null; });
  return connecting;
}

// Warm a standing connection at startup so a browser-open works even before any
// terminal is opened (otherwise the daemon has no app subscriber and the shim's
// open is dropped — the lazy-connect gap Codex flagged).
function connect(): Promise<void> { return ensureConn().then(() => rollIfOutdated()).catch(() => {}); }

// Daemon versioning: an old daemon (predating {op:'hello'}) never replies —
// treat a 1s timeout as version 0. If outdated AND idle, ask it to exit
// (old daemons ignore 'shutdown', so fall back to pkill by socket path) and
// reconnect to a freshly spawned one. With live ptys we keep the old daemon:
// persistence outranks freshness; it heals when the agents close.
const REQUIRED_DAEMON_VERSION = 12; // v12: leaves a live daemon's socket alone, browser shim env only with the shim; v11: quick exit after the app leaves; v3: list() reports lastDataAt; v4: daemon expires parked agents itself; v5: RADIAL_CLI_SOCK env, lastBellAt, tail; v6: startedAt, cols/rows; v7: lastInputAt; v8: keep-awake (meta.keepAwake skips the ceiling, caffeinate holds the Mac); v9: FORCE_HYPERLINK so CLIs print OSC 8 links; v10: only a bare BEL is a bell
let rolledOnce = false;
let daemonVersion: number | null = null; // from hello; null until the first connect answers
async function rollIfOutdated(): Promise<void> {
  if (rolledOnce) return;
  rolledOnce = true;
  try {
    const hello = await Promise.race([
      request({ op: 'hello' }),
      new Promise<null>((r) => setTimeout(() => r(null), 1000)),
    ]);
    daemonVersion = hello ? (hello.version || 0) : 0;
    if (hello && hello.version >= REQUIRED_DAEMON_VERSION) return;
    const alive = hello ? hello.alive : (await list(null)).filter((p) => p.alive !== false).length;
    if (alive > 0) { console.log('[term] daemon is outdated but has live agents — keeping it until they close'); return; }
    console.log('[term] rolling outdated idle daemon');
    if (hello) await request({ op: 'shutdown' });
    else { try { (require('child_process') as typeof import('child_process')).execFileSync('pkill', ['-f', SOCK!]); } catch {} }
    if (conn) { try { conn.destroy(); } catch {} conn = null; }
    await new Promise((r) => setTimeout(r, 400));
    await ensureConn(); // respawns the daemon from the current script
    daemonVersion = REQUIRED_DAEMON_VERSION;
  } catch {}
}
// What the app is actually talking to: an outdated daemon kept alive for its
// live ptys ignores ops it predates (`tail`), so callers can say so instead of
// hanging (`radial agent output` on a daemon that predates v5).
function tailSupported(): boolean { return daemonVersion == null || daemonVersion >= 7; }
// A v8 daemon holds the Mac awake (caffeinate) for kept-awake sessions and skips
// them in its own expiry sweep. An older daemon kept alive for its live ptys
// does neither: the app's sweeps already skip them and the app holds the Mac
// while it runs (main.js syncKeepAwake), so the only gap is "Radial closed +
// old daemon" — callers say so instead of promising.
function keepAwakeSupported(): boolean { return daemonVersion == null || daemonVersion >= 8; }

function wire(s: net.Socket): void {
  let partial = '';
  s.on('data', (chunk) => {
    partial += chunk.toString('utf8');
    let nl;
    while ((nl = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, nl); partial = partial.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: DaemonMessage; try { msg = JSON.parse(line); } catch { continue; }
      route(msg);
    }
  });
  const disconnected = () => {
    if (conn === s) conn = null;
    for (const [id, request] of pending) if (request.socket === s) { clearTimeout(request.timer); pending.delete(id); request.reject(new Error('The terminal connection closed. Reconnect to continue.')); }
  };
  s.on('close', disconnected);
  s.on('error', disconnected);
}

function route(msg: DaemonMessage): void {
  if (msg.op === 'reply') { const r = pending.get(msg.reqId); if (r) { pending.delete(msg.reqId); clearTimeout(r.timer); msg.error ? r.reject(new Error(msg.error)) : r.resolve(msg); } return; }
  if (msg.op === 'data') { if (onAnyData) onAnyData(msg.id, msg.data); return; }
  if (msg.op === 'exit') { inputs.delete(msg.id); if (onAnyExit) onAnyExit(msg.id); return; }
  if (msg.op === 'open') { if (onAnyOpenUrl) onAnyOpenUrl(msg.termId, msg.repoDir, msg.url); return; }
}

async function send(msg: DaemonCommand): Promise<void> { const s = await ensureConn(); s.write(JSON.stringify(msg) + '\n'); }

// How many inputs each pty has had through this process (write): what a person
// types in the window, a chat's delivery, Radial's own sends and answers. Not a
// terminal's own replies to its CLI (cursor position, colors, focus in and out:
// the window's xterm answers them through the same input), or the mouse just
// moving: those change nothing a CLI asks. src/core/questions.ts counts a
// question's occurrences by it: one anyone typed into since it was read is
// another occurrence, and an answer types only while no other input comes.
const inputs = new Map<string, number>();
const REPLIES = /\x1b\[(?:[?>]?\d+(?:;\d+)*c|\d+;\d+R|\d+n|\?\d+u|[IO])|\x1b\](?:1[0-2]|4;\d+);rgb:[0-9a-f/]+(?:\x07|\x1b\\)|\x1b\[<(?:3[2-9]|[45]\d|6[0-3]);\d+;\d+[Mm]/gi;
/** Whether input is typing (keys, a paste, a click), not only a terminal's replies or mouse moves. */
function typedInput(data: string): boolean { return !!String(data).replace(REPLIES, ''); }
/** How many inputs that were typing a pty has had through write. */
function inputEpoch(id: string): number { return inputs.get(id) || 0; }
// Resolves with the reply to msg's op (route() rejects a reply that carries an error).
async function request<K extends DaemonRequest['op']>(msg: Extract<DaemonRequest, { op: K }>): Promise<DaemonReplies[K]> {
  return requestOn(await ensureConn(), msg);
}
// The same, on a connection already made.
function requestOn<K extends DaemonRequest['op']>(s: net.Socket, msg: Extract<DaemonRequest, { op: K }>): Promise<DaemonReplies[K]> {
  const reqId = 'r' + (++reqSeq);
  return new Promise<ReplyBase>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(reqId); reject(new Error('The terminal did not respond. Reconnect to continue.')); }, 10000);
    pending.set(reqId, { resolve, reject, timer, socket: s });
    s.write(JSON.stringify({ ...msg, reqId }) + '\n');
  }) as Promise<DaemonReplies[K]>;
}

// Start a new terminal (returns its id). `command` ({ bin, args }) runs a specific
// program (the real Claude Code / Codex CLI) instead of a shell. `meta`
// (engine/label) is stored in the daemon so it survives a restart and comes back
// via list() for relabeling on reattach.
async function start(repoDir: string, { cols, rows, command, meta }: TerminalStartOptions = {}): Promise<string> {
  const rep = await request({ op: 'start', repoDir, command, cols, rows, meta, shimDir });
  return rep && rep.id;
}
// The project's still-alive terminals (after an app restart) — for reattaching.
async function list(repoDir?: string | null): Promise<PtyInfo[]> { const rep = await request({ op: 'list', repoDir }); return (rep && rep.ptys) || []; }
// How many terminals are running, from the daemon this process is already
// connected to; null when it isn't. It never connects, so it never starts a
// daemon (a crash report reads it: processWatch.ts).
async function liveCount(): Promise<number | null> {
  const s = conn;
  if (!s || s.destroyed) return null;
  try { const rep = await requestOn(s, { op: 'list', repoDir: null }); return ((rep && rep.ptys) || []).filter((p) => p.alive !== false).length; }
  catch { return null; }
}
// Reattach to a live terminal: replays its buffered scrollback, then streams live.
function attach(id: string): void { send({ op: 'attach', id }).catch(() => {}); }
// Stop streaming a terminal's output here. A terminal no client is attached to
// is one nobody shows, which the daemon's idle ceiling parks (agentSleep.pickExpired).
function detach(id: string): void { send({ op: 'detach', id }).catch(() => {}); }
function write(id: string, data: string): void { if (typedInput(data)) inputs.set(id, inputEpoch(id) + 1); send({ op: 'input', id, data }).catch(() => {}); }
function resize(id: string, cols: number, rows: number): void { send({ op: 'resize', id, cols, rows }).catch(() => {}); }
function kill(id: string): void { send({ op: 'kill', id }).catch(() => {}); }
function setMeta(id: string, meta: PtyMeta): void { send({ op: 'setMeta', id, meta }).catch(() => {}); }
// The last `bytes` of a pty's scrollback plus its bell/activity stamps, without attaching.
async function tail(id: string, bytes: number): Promise<TailResult> {
  if (!tailSupported()) return { ok: false, code: 'daemon-outdated' };
  return Promise.race([request({ op: 'tail', id, bytes }), new Promise<TailResult>((r) => setTimeout(() => r({ ok: false, code: 'timeout' }), 5000))]); // never hang a CLI caller on a silent daemon
}
// No-op: the daemon keeps PTYs alive across app close (that's the whole point).
// Take the daemon and every pty down (RADIAL_DAEMON_EPHEMERAL instances only):
// ask nicely with force, and fall back to killing it by socket path when it
// predates the flag or doesn't answer. Bounded: quitting must never hang on it.
async function killAll(): Promise<void> {
  let ok = false;
  try { const r = await Promise.race([request({ op: 'shutdown', force: true }), new Promise<null>((res) => setTimeout(() => res(null), 1500))]); ok = !!(r && r.ok); } catch {}
  if (!ok) { try { (require('child_process') as typeof import('child_process')).execFileSync('pkill', ['-f', SOCK!]); } catch {} }
  if (conn) { try { conn.destroy(); } catch {} conn = null; }
}

// Agents the daemon expired on its own (parked past the idle ceiling, possibly
// while the app wasn't running) — drained from its reap log. The caller turns
// resumable ones into slept records; consuming empties the log.
function takeReaped(): ReapedPty[] {
  if (!SOCK) return [];
  const p = SOCK + '.reaped.jsonl';
  let txt = '';
  try { txt = (require('fs') as typeof import('fs')).readFileSync(p, 'utf8'); (require('fs') as typeof import('fs')).unlinkSync(p); } catch { return []; }
  return txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as ReapedPty; } catch { return null; } }).filter(Boolean) as ReapedPty[]; // the daemon writes each line (term-daemon.ts)
}

export { init, setGlobalHandlers, connect, start, list, liveCount, attach, detach, write, resize, kill, setMeta, tail, tailSupported, keepAwakeSupported, killAll, takeReaped, ephemeral, inputEpoch, typedInput };
