/**
 * `radial serve`: Radial's core (src/core) under plain Node, with no window and
 * no browser, for a coding agent in a VM, a container or a Linux server
 * (plans/headless-core.md, phase 2a). The `radial` CLI runs it:
 *
 *   radial serve [--data-dir <dir>] [--idle <time>]   until Ctrl-C, SIGINT or SIGTERM
 *   radial serve --detach                             in the background, its log in <data dir>/logs/core.log
 *   radial serve status                               whether one runs on the data dir, and where
 *   radial serve stop                                 stops it, and waits until it has
 *   radial serve --listen 127.0.0.1:4000              also over HTTP, with API tokens (phase 4, listen.ts)
 *     [--allow-remote] [--allow-host <name>]… [--allow-origin <origin>]…
 *
 * The CLI also starts one in the background when nothing answers and there's
 * no Mac app to launch (cli.ts defaultLaunch). One serve per data dir: the
 * control socket is the lock, and a second serve finds it live and refuses
 * (cliServer's socket probe says in-use). On SIGINT or SIGTERM it stops every
 * project's dev server and its control socket, and leaves the PTY daemon and
 * its agents running, as the Mac app does when it quits; a throwaway data dir
 * (RADIAL_USERDATA, as in the tests) takes them down too.
 *
 * The core gets the Node platform, no viewer (src/core/fallbacks.ts does its
 * work), Playwright's headless browser as its page (page.ts, once `radial
 * browser install` has fetched it; until then page work refuses no-browser),
 * events written to the log and passed to the page, and serve's options: no
 * idle sleep unless --idle, parking left to the daemon's ceiling, half the
 * machine's memory for a dev server, and only the `radial` shim in agent
 * terminals.
 *
 * With --listen, once it holds the control socket it also listens for HTTP
 * (listen.ts: /mcp, /rpc, /events and /files, every request with a `radial
 * token`), streams the core's events to /events, and gives each open
 * project's preview a stable port (previewProxy.ts). It listens on loopback
 * only, unless --allow-remote: a non-loopback --listen without it is refused,
 * with a word about putting SSH or Tailscale in front.
 */
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createCore } from '../core';
import type { Core, CoreOptions, Events, Platform } from '../core';
import type { WindowEvents } from '../shared/radialApi';
import type { CliIo, Flags } from '../main/cli';
import type { HelloInfo } from '../main/cliServer';
import * as proto from '../main/cliProto';
import * as dataDirs from '../main/dataDirs';
import * as devMemory from '../main/devMemory';
import * as terminal from '../main/terminal';
import * as errorReport from '../main/errorReport';
import * as recents from '../main/recents';
import * as telemetry from '../main/telemetry';
import * as usage from './usage';
import { probeSocket } from '../main/socketProbe';
import { createPageHost } from './page';
import type { PageHost } from './page';
import * as apiTokens from './apiTokens';
import { isLoopbackHost, parseListen, startListener } from './listen';
import type { HttpListener, ListenAddress } from './listen';
import { urlHost } from './previewProxy';

/** What `radial serve` writes as it runs: one line at a time. */
export type Log = (line: string) => void;

/** The core's events as log lines: what happened, for whoever reads the log. Nobody watches live, so listening() is false. */
const QUIET = new Set<keyof WindowEvents>(['term:data', 'files:changed', 'history:state', 'loading-status', 'nativeChat:event', 'cli:request']); // terminal output, UI refreshes, and the dev server's lines again as status
export function eventLog(log: Log): Events {
  return {
    send(channel: keyof WindowEvents, ...payload: unknown[]) {
      if (QUIET.has(channel)) return;
      const p = payload[0];
      if (typeof p === 'string') { log(channel === 'log' ? p : `[${channel}] ${p}`); return; }
      const json = p === undefined ? '' : JSON.stringify(p);
      log(`[${channel}]${json ? ' ' + (json.length > 400 ? json.slice(0, 400) + '…' : json) : ''}`);
    },
    listening: () => false,
  };
}

/** The core's events to the log, and to the page too: a static site's change reloads its page, a sleeping project's page goes. */
export function withPage(events: Events, page: Pick<PageHost, 'onEvent'>): Events {
  return {
    send(channel: keyof WindowEvents, ...payload: unknown[]) {
      (events.send as (channel: keyof WindowEvents, ...payload: unknown[]) => void)(channel, ...payload);
      page.onEvent(channel, payload[0]);
    },
    listening: () => events.listening(),
  };
}

/** What /events doesn't stream: the terminals' raw output (agent output reads a session's screen), and the window's own traffic. */
const UNSTREAMED = new Set<keyof WindowEvents>(['term:data', 'nativeChat:event', 'cli:request']);
/** The core's events to the listener's /events streams too, once it listens; with a stream open, someone watches (listening()). */
export function withWatchers(events: Events, watchers: () => Pick<HttpListener, 'publish' | 'watchers'> | null): Events {
  return {
    send(channel: keyof WindowEvents, ...payload: unknown[]) {
      (events.send as (channel: keyof WindowEvents, ...payload: unknown[]) => void)(channel, ...payload);
      const w = watchers();
      if (w && !UNSTREAMED.has(channel)) w.publish(channel, payload[0]);
    },
    listening: () => { const w = watchers(); return events.listening() || (!!w && w.watchers() > 0); },
  };
}

/** --listen and the flags that go with it, as serve runs them. */
export interface ListenConfig { address: ListenAddress; allowRemote: boolean; allowHosts: string[]; allowOrigins: string[] }
/** A repeatable flag's values (the CLI collects one given twice into a list). */
const many = (v: Flags[string]): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []);
/**
 * --listen and its companions from the CLI's flags: what to listen with, an
 * error to print (a bad address, a name or origin that isn't one, or an address
 * beyond this machine without --allow-remote), or null with no --listen.
 */
export function listenConfig(flags: Flags): ListenConfig | { error: string } | null {
  const allowHosts = many(flags.allowHost), allowOrigins = many(flags.allowOrigin);
  if (flags.listen == null || flags.listen === false) {
    if (flags.allowRemote || allowHosts.length || allowOrigins.length) return { error: '--allow-remote, --allow-host and --allow-origin go with --listen, like radial serve --listen 127.0.0.1:4000.' };
    return null;
  }
  const address = parseListen(flags.listen);
  if ('error' in address) return address;
  const bad = allowHosts.find((h) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(h));
  if (bad !== undefined) return { error: `--allow-host takes a host name, like myvm.example.ts.net, not ${bad || 'nothing'}.` };
  const badOrigin = allowOrigins.find((o) => { try { const u = new URL(o); return !/^https?:$/.test(u.protocol) || u.origin !== o.replace(/\/+$/, ''); } catch { return true; } });
  if (badOrigin !== undefined) return { error: `--allow-origin takes a web page's origin, like https://example.com, not ${badOrigin || 'nothing'}.` };
  if (!isLoopbackHost(address.host) && !flags.allowRemote) {
    return { error: `${address.host} can be reached from other machines, and radial serve listens only on this machine's own address unless you pass --allow-remote. To reach it from elsewhere, put SSH or Tailscale in front of 127.0.0.1 (ssh -L ${address.port || 4000}:127.0.0.1:${address.port || 4000} <this machine>), or pass --allow-remote and keep the tokens secret.` };
  }
  return { address, allowRemote: !!flags.allowRemote, allowHosts, allowOrigins };
}
/** The same flags as argv again, for a detached serve. */
export function listenArgs(listen: ListenConfig | null): string[] {
  if (!listen) return [];
  return ['--listen', `${urlHost(listen.address.host)}:${listen.address.port}`, ...(listen.allowRemote ? ['--allow-remote'] : []), ...listen.allowHosts.flatMap((h) => ['--allow-host', h]), ...listen.allowOrigins.flatMap((o) => ['--allow-origin', o])];
}

/** How long the browser's pages stay up unused (page.ts IDLE_MS); RADIAL_PAGE_IDLE_MS is a test seam. */
function pageIdleMs(): number | undefined { const ms = Number(process.env.RADIAL_PAGE_IDLE_MS); return ms > 0 ? ms : undefined; }

/**
 * The OS's own version, as the Mac app's process.getSystemVersion gives it:
 * on a Mac, macOS's ("27.0.0", from SystemVersion.plist), never the Darwin
 * kernel's that os.release() gives; elsewhere the system's name and the
 * kernel's version, digits and dots only ("Linux 6.8.0", never a build's
 * suffix like -aws or -WSL2).
 */
export function osVersion({ platform = process.platform, readPlist = () => fs.readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8'), release = os.release(), type = os.type() }: { platform?: NodeJS.Platform; readPlist?: () => string; release?: string; type?: string } = {}): string {
  if (platform === 'darwin') {
    try {
      const m = /<key>ProductVersion<\/key>\s*<string>(\d+(?:\.\d+){0,2})<\/string>/.exec(readPlist());
      if (m) { const parts = m[1].split('.'); while (parts.length < 3) parts.push('0'); return parts.join('.'); }
    } catch {}
    return 'macOS';
  }
  const version = /^\d+(?:\.\d+){0,3}/.exec(release);
  return version ? `${type} ${version[0]}` : type;
}

/** The machine around the core, for plain Node. */
export function nodePlatform(dataDir: string): Platform {
  return {
    version: appVersion(),
    flavor: 'headless',
    dataDir,
    home: os.homedir(),
    osVersion: osVersion(),
    cliBin: path.join(__dirname, '..', '..', 'bin', 'radial'), // out/headless → bin/radial, which runs the CLI on Node where there's no Mac app
    // Nothing to hold. On macOS the PTY daemon keeps the Mac awake for a
    // kept-awake agent itself (caffeinate, term-daemon.ts); a server doesn't
    // idle-sleep, and systemd-inhibit needs a session most VMs don't give.
    keepAwake() {},
  };
}

/**
 * The memory this process may use: the machine's, or less when a container
 * or a cgroup caps it (docker run -m 2g), which os.totalmem() doesn't see.
 */
export function machineMemory(total: number = os.totalmem(), constrained: number = (process as { constrainedMemory?: () => number | undefined }).constrainedMemory?.() || 0): number {
  return constrained > 0 && constrained < total ? constrained : total;
}

/** radial serve's options for the core (see CoreOptions): idleSleepMs from --idle, null without it. */
export function serveOptions(idleSleepMs: number | null): CoreOptions {
  return { idleSleepMs, parkAgents: false, devMemoryLimitMb: devMemory.headlessLimitMb(machineMemory()), browserShims: false };
}

/** Whether serve runs in a container: the image says so (RADIAL_CONTAINER, docker/Dockerfile), or Docker's own marker file is there. */
export function inContainer(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): boolean {
  return !!env.RADIAL_CONTAINER || exists('/.dockerenv');
}
/** What serve says when it listens with no token yet: every request is refused until one is made, and how to make one (from the host, for a container). */
export function noTokenNote(container: boolean, hostname: string = os.hostname()): string {
  return container
    ? `No API tokens yet, so every HTTP request is refused. Make one from the host: docker exec ${hostname} radial token create <name> (it shows once).`
    : 'No API tokens yet, so every HTTP request is refused: `radial token create <name>` makes one.';
}

/** --idle's value in ms: 30m, 2h, 90s, a bare number of minutes, or off (0, off, never) for null; NaN when it isn't one. */
export function parseIdle(value: string | boolean | string[] | undefined): number | null {
  if (value == null || value === false) return null;
  const v = String(value).trim().toLowerCase();
  if (v === 'off' || v === 'never' || v === '0') return null;
  const m = v.match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/);
  if (!m) return NaN;
  return Math.round(Number(m[1]) * ({ s: 1000, m: 60000, h: 3600000 }[(m[2] || 'm') as 's' | 'm' | 'h']));
}

function appVersion(): string { try { return (require('../../package.json') as { version: string }).version; } catch { return 'unknown'; } }
const pidFile = (dataDir: string): string => path.join(dataDir, 'core.pid');
/** Where a detached serve writes its log. */
export const logFile = (dataDir: string): string => path.join(dataDir, 'logs', 'core.log');

/** hello on a control socket: who answers there, or null when nothing does. */
export function hello(sock: string, timeoutMs = 2000): Promise<HelloInfo | null> {
  return new Promise((resolve) => {
    const s = net.connect(sock);
    let done = false;
    const finish = (r: HelloInfo | null) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); resolve(r); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    s.setEncoding('utf8');
    s.on('data', proto.makeDecoder((m) => { if (m.op === 'reply' && m.reqId === 'serve') finish(m.ok ? m as unknown as HelloInfo : null); })); // the server's own hello reply
    s.on('error', () => finish(null));
    s.on('connect', () => s.write(proto.encode({ op: 'hello', reqId: 'serve' })));
  });
}

/** Whether a process is still there; a zombie (exited, its parent not reaping it: a container's PID 1 without --init) isn't. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; } // no /proc (macOS): kill's answer stands
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What serve does with an error nothing caught: a crash must not take the
 * agents' Radial down, so it logs it, reports it and keeps serving. Nothing in
 * it may throw (Node exits with code 7 when an uncaughtException listener
 * does), and what was thrown can be anything: a revoked Proxy, a getter that
 * throws.
 */
export function onUncaught(log: Log): (err: unknown) => void {
  return (err) => {
    let code: unknown;
    try { code = (err as NodeJS.ErrnoException | undefined)?.code; } catch {}
    if (code === 'EPIPE' || code === 'EIO' || code === 'ERR_STREAM_DESTROYED') return; // a reader went away
    let details: string;
    try { details = String((err as Error | undefined)?.stack || err); } catch { details = 'an error that could not be read'; }
    try { log(`[radial] uncaught error: ${details}`); } catch {}
    try { errorReport.report('main', err, { via: 'exception' }); } catch {}
  };
}

/**
 * Runs the core until SIGINT or SIGTERM, then stops it and answers the exit
 * code. 6 when another Radial already runs on the data dir. The caller exits
 * the process with it: the core's sweeps and watchers keep Node running.
 */
export async function run({ dataDir, idleSleepMs, log, listen = null }: { dataDir: string; idleSleepMs: number | null; log: Log; listen?: ListenConfig | null }): Promise<number> {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); // a new one is this user's alone: its tokens, logs and shots
  const sock = dataDirs.cliSocket(dataDir);
  if (await probeSocket(sock) === 'live') { // first, before the core touches anything of the running one's
    const other = await hello(sock);
    log(`Radial is already running on ${dataDir}${other ? ` (pid ${other.pid})` : ''}. \`radial serve stop\` stops it.`);
    return 6;
  }
  process.on('uncaughtException', onUncaught(log));
  process.on('unhandledRejection', (reason) => { try { errorReport.report('main', reason, { via: 'rejection' }); } catch {} });

  let core: Core | null = null;
  let listener: HttpListener | null = null; // with --listen, once it listens
  const page = createPageHost({
    dataDir, log, idleMs: pageIdleMs(),
    preview: (dir) => core ? core.previewNow(dir) : { ok: false, code: 'not-open', error: `${dir} is not open.` },
    notify: (channel, payload) => listener?.publish(channel, payload), // the browser's own events, for /events
  });
  const platform: Platform = { ...nodePlatform(dataDir), listener: () => listener };
  core = createCore({ platform, page, viewer: null, events: withWatchers(withPage(eventLog(log), page), () => listener) }, serveOptions(idleSleepMs));
  core.start();
  const claim = await core.controlReady();
  if (!claim.ok) {
    core.stopControlServer();
    if (claim.code === 'in-use') { // started at the same moment as another serve, which won the socket
      const other = await hello(sock);
      log(`Radial is already running on ${dataDir}${other ? ` (pid ${other.pid})` : ''}. \`radial serve stop\` stops it.`);
      return 6;
    }
    log(`Radial couldn't open its control socket at ${sock}: ${claim.error}`);
    return 1;
  }

  /** Everything serve started, stopped: HTTP first, then the socket (no new requests), the browser, the dev servers. */
  const shutdown = async (tokens: apiTokens.TokenStore | null): Promise<void> => {
    if (listener) { try { await listener.close(); } catch {} listener = null; }
    if (tokens) tokens.close();
    core!.stopControlServer();
    try { await page.close(); } catch {} // the browser, if it runs
    try { (require('../main/newProject') as typeof import('../main/newProject')).abortForQuit(); } catch {}
    try { (require('../main/vercel') as typeof import('../main/vercel')).abortAll(); } catch {}
    // A throwaway data dir (tests) takes its daemon and agents down with it, as the app's do; a real one leaves them running.
    if (terminal.ephemeral()) { try { await terminal.killAll(); } catch {} }
    try { await core!.stopAll(); } catch (e) { log(`[radial] stopping: ${(e as Error).message}`); }
  };

  // --listen: HTTP beside the socket, once this serve holds the data dir.
  let tokens: apiTokens.TokenStore | null = null;
  if (listen) {
    tokens = apiTokens.store(dataDir);
    const c = core;
    try {
      listener = await startListener({
        address: listen.address, allowRemote: listen.allowRemote, allowHosts: listen.allowHosts, allowOrigins: listen.allowOrigins,
        dataDir, version: appVersion(), tokens, log,
        dispatch: (msg, via) => c.dispatch(msg, via),
        projects: () => [...new Set([...c.openProjects(), ...recents.listRecents().map((r) => r.path)])],
        preview: (dir) => c.previewNow(dir),
        wake: async (dir) => { const r = await c.wake(dir); return 'code' in r ? r.error : null; },
        used: (dir) => c.markUsed(dir),
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      log(`Radial couldn't listen on ${urlHost(listen.address.host)}:${listen.address.port}: ${code === 'EADDRINUSE' ? 'something else uses that port' : code === 'EADDRNOTAVAIL' ? 'this machine has no such address' : (e as Error).message}.`);
      await shutdown(tokens);
      return 1;
    }
  }
  try { fs.writeFileSync(pidFile(dataDir), `${process.pid}\n`); } catch {}
  core.startSweeps();
  log(`Radial ${appVersion()} is running without a window (pid ${process.pid}${idleSleepMs ? `, projects sleep after ${Math.round(idleSleepMs / 60000)} min unused` : ''}).`);
  log(`Data: ${dataDir}. Control socket: ${sock}. \`radial serve stop\` or Ctrl-C stops it.`);
  if (listener && listen) {
    log(`Listening on ${listener.address} (MCP at /mcp, the CLI at /rpc, events at /events), every request with a token${listen.allowRemote ? '; beyond this machine too, so previews need a share link from other machines' : ', on this machine only'}. Each open project's preview gets a port after ${listener.port}: \`radial url\` prints it.`);
    if (!tokens!.count()) log(noTokenNote(inContainer()));
  }
  // Usage events (usage.ts): the one-time note, unless the command that started this serve already showed it; then the start, counted as an event only.
  const note = usage.notice(dataDir);
  if (note) for (const line of note.split('\n')) log(line);
  telemetry.capture('serve_started', { listen: !!listener, remote: !!(listener && listen && listen.allowRemote) });
  const shell = (() => { try { return (require('./browser') as typeof import('./browser')).browserInfo(); } catch { return null; } })(); // also loads Playwright's registry now, not during a request
  log(shell && shell.installed ? `Page work (screenshots, page fields, migration compares) uses ${shell.name} ${shell.version}; it starts with the first one.` : 'No browser yet, so screenshots, page fields and migration compares refuse. `radial browser install` adds one, with no restart.');

  const signal = await new Promise<NodeJS.Signals>((resolve) => {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => resolve(sig));
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { log('Stopping now, without waiting.'); process.exit(1); }); // a second one: stop waiting
  log(`Stopping (${signal}): ${terminal.ephemeral() ? 'the dev servers and the agents stop, as this data dir is a throwaway one' : 'the dev servers stop, and agents keep running in the terminal service'}.`);
  await shutdown(tokens);
  try { if (fs.readFileSync(pidFile(dataDir), 'utf8').trim() === String(process.pid)) fs.rmSync(pidFile(dataDir)); } catch {}
  log('Stopped.');
  return 0;
}

/**
 * Starts a serve in the background and returns at once: the child runs this
 * CLI's `serve` on the data dir, its output appended to the data dir's
 * logs/core.log. The caller waits for its socket (cli.ts connect, or detach()).
 */
export function spawnDetached(dataDir: string, { env = process.env, idle = null, listen = null }: { env?: NodeJS.ProcessEnv; idle?: string | null; listen?: ListenConfig | null } = {}): { pid: number | undefined; log: string } {
  const log = logFile(dataDir);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  try { if (fs.statSync(log).size > 5 * 1024 * 1024) fs.renameSync(log, log + '.1'); } catch {} // one old log kept
  const fd = fs.openSync(log, 'a');
  try {
    const entry = path.join(__dirname, '..', 'main', 'cli.js'); // the CLI next to this file in out/
    const child = spawn(process.execPath, [entry, 'serve', '--data-dir', dataDir, ...(idle ? ['--idle', idle] : []), ...listenArgs(listen)], { detached: true, stdio: ['ignore', fd, fd], env, cwd: dataDir });
    child.unref();
    return { pid: child.pid, log };
  } finally { fs.closeSync(fd); }
}

/** What `radial serve --detach`, `status` and `stop` answer (and print with --json); listen is where a serve with --listen takes HTTP. */
export type ServeReply =
  | { ok: true; state: 'running' | 'started' | 'stopped' | 'not-running'; dataDir: string; socket: string; log: string; pid?: number; version?: string; listen?: string }
  | { ok: false; code: 'in-use' | 'not-running' | 'failed' | 'not-headless' | 'bad-request'; error: string; dataDir: string; pid?: number };

/** `radial serve --detach`: a serve in the background, once its socket answers (and, with --listen, it listens). */
export async function detach(dataDir: string, { env = process.env, idle = null, listen = null, timeoutMs = 30000 }: { env?: NodeJS.ProcessEnv; idle?: string | null; listen?: ListenConfig | null; timeoutMs?: number } = {}): Promise<ServeReply> {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const sock = dataDirs.cliSocket(dataDir, env);
  const running = await hello(sock);
  if (running) return { ok: false, code: 'in-use', error: `Radial is already running on ${dataDir} (pid ${running.pid}). \`radial serve stop\` stops it.`, dataDir, pid: running.pid };
  const child = spawnDetached(dataDir, { env, idle, listen });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(100);
    const h = await hello(sock, 1000);
    if (h && h.pid === child.pid && (!listen || h.listen)) return { ok: true, state: 'started', dataDir, socket: sock, log: child.log, pid: h.pid, version: h.version, ...(h.listen ? { listen: h.listen } : {}) };
    if (child.pid && !alive(child.pid)) break;
  }
  const tail = (() => { try { return fs.readFileSync(child.log, 'utf8').trim().split('\n').slice(-5).join('\n'); } catch { return ''; } })();
  return { ok: false, code: 'failed', error: `Radial didn't start${tail ? `:\n${tail}` : '.'}\nThe log is at ${child.log}.`, dataDir, pid: child.pid };
}

/** `radial serve status`: whether a serve answers on the data dir. */
export async function status(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<ServeReply> {
  const sock = dataDirs.cliSocket(dataDir, env);
  const h = await hello(sock);
  if (h) return { ok: true, state: 'running', dataDir, socket: sock, log: logFile(dataDir), pid: h.pid, version: h.version, ...(h.listen ? { listen: h.listen } : {}) };
  clearStalePid(dataDir);
  return { ok: false, code: 'not-running', error: `Radial isn't running on ${dataDir}.`, dataDir };
}

/** `radial serve stop`: SIGTERM to the serve that answers on the data dir, then wait until it's gone. */
export async function stop(dataDir: string, { env = process.env, timeoutMs = 60000 }: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<ServeReply> {
  const sock = dataDirs.cliSocket(dataDir, env);
  const h = await hello(sock);
  if (!h) { clearStalePid(dataDir); return { ok: true, state: 'not-running', dataDir, socket: sock, log: logFile(dataDir) }; }
  if (h.flavor !== 'headless') return { ok: false, code: 'not-headless', error: `Radial for Mac answers on ${dataDir} (pid ${h.pid}). Quit it from its window.`, dataDir, pid: h.pid };
  try { process.kill(h.pid, 'SIGTERM'); } catch (e) { return { ok: false, code: 'failed', error: `Couldn't stop pid ${h.pid}: ${(e as Error).message}`, dataDir, pid: h.pid }; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(100);
    if (!alive(h.pid) && !fs.existsSync(sock)) return { ok: true, state: 'stopped', dataDir, socket: sock, log: logFile(dataDir), pid: h.pid };
  }
  return { ok: false, code: 'failed', error: `Radial (pid ${h.pid}) is still stopping after ${Math.round(timeoutMs / 1000)}s. Its log is at ${logFile(dataDir)}.`, dataDir, pid: h.pid };
}

/** A pid file whose process is gone (a serve that was killed) goes. */
function clearStalePid(dataDir: string): void {
  try { const pid = Number(fs.readFileSync(pidFile(dataDir), 'utf8').trim()); if (!pid || !alive(pid)) fs.rmSync(pidFile(dataDir)); } catch {}
}

/**
 * `radial serve [status|stop] [--detach] [--data-dir <dir>] [--idle <time>]
 * [--listen <address> [--allow-remote] [--allow-host <name>]…
 * [--allow-origin <origin>]…]`, as the CLI calls it (its io and parsed flags).
 * The data dir is the headless core's (dataDirs.headlessDataDir), which
 * --data-dir sets through RADIAL_DATA_DIR. Answers the exit code: 0, 1 failed,
 * 2 usage (a non-loopback --listen without --allow-remote too), 4 not running
 * (status), 6 refused (already running). The foreground run ends the process
 * itself when it stops.
 */
export async function command(positional: string[], flags: Flags, io: Pick<CliIo, 'stdout' | 'stderr' | 'env'>): Promise<number> {
  const dataDir = dataDirs.headlessDataDir(io.env);
  const json = !!flags.json;
  const print = (r: ServeReply, human: string): number => {
    if (json) io.stdout.write(JSON.stringify(r) + '\n');
    else if (r.ok) io.stdout.write(human + '\n');
    else io.stderr.write(`radial: ${r.error}\n`);
    return r.ok ? 0 : r.code === 'in-use' || r.code === 'not-headless' ? 6 : r.code === 'not-running' ? 4 : r.code === 'bad-request' ? 2 : 1;
  };
  const listening = (r: Extract<ServeReply, { ok: true }>) => (r.listen ? `\n  Listening: ${r.listen} (MCP at /mcp, the CLI at /rpc, events at /events; \`radial token create\` makes a token)` : '');
  const action = positional[0] || null;
  if (action === 'status') {
    const r = await status(dataDir, io.env);
    return print(r, r.ok ? `Radial is running without a window (pid ${r.pid}, ${r.version}).\n  Data: ${r.dataDir}\n  Control socket: ${r.socket}${listening(r)}\n  Log: ${r.log}` : '');
  }
  if (action === 'stop') {
    const r = await stop(dataDir, { env: io.env });
    return print(r, r.ok && r.state === 'stopped' ? `Stopped Radial (pid ${r.pid}).` : `Radial isn't running on ${dataDir}.`);
  }
  if (action) return print({ ok: false, code: 'bad-request', error: `Unknown serve command: ${action}. Use radial serve, radial serve status or radial serve stop.`, dataDir }, '');
  const idleArg = typeof flags.idle === 'string' ? flags.idle : null;
  const idleSleepMs = parseIdle(flags.idle);
  if (Number.isNaN(idleSleepMs)) return print({ ok: false, code: 'bad-request', error: `--idle takes a time like 30m, 2h or 90s (or off), not ${idleArg}.`, dataDir }, '');
  const listen = listenConfig(flags);
  if (listen && 'error' in listen) return print({ ok: false, code: 'bad-request', error: listen.error, dataDir }, '');
  if (flags.detach) {
    const note = usage.notice(dataDir, io.env); // the one-time note goes to this terminal, not only the serve's log
    if (note) io.stderr.write(note + '\n');
    const r = await detach(dataDir, { env: io.env, idle: idleArg, listen });
    return print(r, r.ok ? `Radial is running in the background (pid ${r.pid}). Log: ${r.log}. \`radial serve stop\` stops it.${r.listen ? `\nListening on ${r.listen}: \`radial token create\` makes a token for it.` : ''}` : '');
  }
  const log: Log = (line) => io.stdout.write(`${new Date().toISOString()} ${line}\n`);
  const code = await run({ dataDir, idleSleepMs, log, listen });
  // The core's sweeps, watchers and daemon connection would keep Node running: exit once the log is out.
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  process.exit(code);
}
