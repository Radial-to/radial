import * as projectData from './projectData';

/**
 * Framework-agnostic dev-server control.
 *
 * For a real framework repo we just run its OWN dev script (`npm run dev`) and
 * sniff stdout for the local URL — works for Next.js, Astro, Vite, etc. without
 * knowing anything framework-specific.
 *
 * For a plain static HTML site (no dev script) we serve it with a tiny built-in
 * static server so the rest of the app behaves identically.
 */

import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { childEnv, which } from './env';
import * as watcherHealth from './watcherHealth';
import * as devPids from './devPids';
import { watchTree } from './treeWatch';
import type { TreeWatch } from './treeWatch';
import type { ChildProcess } from 'child_process';
import type { AddressInfo } from 'net';
import type { DetectedProject, PackageManager, RunnableProject } from '../shared/radialApi';

/** A project run by its package.json dev script (detectProject's 'node' answer). */
export type NodeProject = Extract<DetectedProject, { type: 'node' }>;
/** A plain HTML site, served by the built-in static server. */
export type StaticProject = Extract<DetectedProject, { type: 'static' }>;
/** The framework detectProject names for a node project ('node' when it knows none). */
export type NodeFramework = NodeProject['framework'];

/**
 * The parts of a project's package.json that detection reads. The file is the
 * project's own JSON, parsed unchecked: `packageManager` is checked to be a
 * string before use.
 */
export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: unknown;
}

/** How to run a package manager: the binary, the args before its subcommand (`corepack pnpm`), and whether npm stands in for a missing pnpm/yarn. */
export interface PmInvocation {
  cmd: string;
  pre: string[];
  fellBackToNpm?: true;
}

/** What install() and build() read from a project; without them they use npm and the `build` script. */
export type PmProject = Partial<Pick<NodeProject, 'pm' | 'buildScript'>>;

/** Streams one line of output to the caller. */
export type OnLog = (line: string) => void;
/** install()'s and build()'s options. */
export interface PmRunOptions { onLog?: OnLog }
/** Reports a coarse phase, or the latest output line, to the loading spinner. */
export type OnStatus = (text: string) => void;
/** Is this pid one of the dev servers Radial started (main.ts ownsPid)? */
export type OwnsPid = (pid: number) => boolean;

/** build()'s answer: a red build resolves ok:false with a tail of its output; `code` is NODE_NOT_FOUND or the spawn error's code. */
export type BuildResult =
  | { ok: true }
  | { ok: false; error: string; code?: string; log?: string };

/** start()'s options. */
export interface StartOptions {
  onLog?: OnLog;
  onStatus?: OnStatus;
  /** Called (debounced) when a static site's files change; no watcher without it. */
  onChanged?: (() => void) | null;
  timeoutMs?: number;
  ownsPid?: OwnsPid | null;
}

/**
 * What every dev-server handle has. publishDevInfo stamps the times (an adopted
 * server keeps no startedAt) and wraps stop(), which sets `stopped`.
 */
interface ServerHandleBase {
  url: string;
  stop: () => Promise<void>;
  startedAt?: number;
  observedAt?: number;
  stopped?: boolean;
}

/** Radial's own dev server for a node project: the process it spawned (startNode). */
export interface NodeServerHandle extends ServerHandleBase {
  project: NodeProject;
  /** The dev server process Radial spawned, its process group's leader. */
  child: ChildProcess;
  external?: undefined;
  pid?: undefined;
  command?: undefined;
}

/** The built-in static server for a plain HTML site (startStatic). */
export interface StaticServerHandle extends ServerHandleBase {
  project: StaticProject;
  child?: undefined;
  external?: undefined;
  pid?: undefined;
  command?: undefined;
}

/** A dev server the user started outside Radial (adoptExternal): never stopped or restarted. */
export interface ExternalServerHandle extends ServerHandleBase {
  project: NodeProject;
  child?: undefined;
  external: true;
  /** The adopted server's pid. */
  pid: number;
  /** The adopted server's command line (first 200 characters). */
  command: string;
}

/** A server Radial runs and may stop or restart. */
export type OwnServerHandle = NodeServerHandle | StaticServerHandle;

/**
 * A running dev server, start()'s answer: Radial's own (`child`), the built-in
 * static server, or an adopted one the user started (`external`, `pid`,
 * `command`). Narrow on `child` or `external`.
 */
export type DevServerHandle = OwnServerHandle | ExternalServerHandle;

/** The parts of a handle dev.json records; only a node project has a devScript. */
type DevInfoHandle = Omit<DevServerHandle, 'project'> & {
  project: Pick<RunnableProject, 'type' | 'framework'> & { devScript?: NodeProject['devScript'] };
};

/**
 * `.radial/dev.json`, where agents and the CLI find the live preview
 * (writeDevInfo writes it while a server is up; main.ts readDevJson and
 * cli.ts readDevUrl read it). `framework` is the project's framework,
 * `pid` the server's (or Radial's for the static server), `script` the
 * node project's dev script, `external` marks an adopted server, and
 * `startedAt` is when Radial started the server, or first saw an adopted one.
 */
export interface DevInfo {
  url: string;
  framework: RunnableProject['framework'];
  pid: number;
  cwd: string;
  script?: NodeProject['devScript'];
  command?: string;
  external?: true;
  startedAt?: number;
}

/** A LISTENing socket from lsof: the owning process and where it listens. */
export interface LsofListener {
  pid: number;
  cmd: string;
  host: string;
  port: number;
}

/** What execFileSync throws when the command fails: an Error that still carries its output (a string with encoding 'utf8'). */
type ExecFileSyncError = Error & { stdout?: string };

// When OS file-watching is wedged (see watcherHealth.js), tell chokidar-based
// dev servers to poll instead — CHOKIDAR_USEPOLLING is honored by chokidar 3
// (vite 5 and friends). Harmlessly ignored by watchers that don't read it;
// newer stacks that ignore it are covered by the edit-turn auto-restart.
function watcherEnv(): Record<string, string> {
  return watcherHealth.healthy() === false ? { CHOKIDAR_USEPOLLING: '1', CHOKIDAR_INTERVAL: '400' } : {};
}

// Thrown (as err.code) when Node/npm can't be found on the user's machine, so
// the UI can show install guidance instead of a raw ENOENT.
const NODE_NOT_FOUND = 'NODE_NOT_FOUND';

// The port is REQUIRED: dev servers always bind one, and matching a port-less
// prefix poisons the ready-probe — npm's command echo can contain literal
// "http://localhost:" text (the dev script's own source) before the real URL.
const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1):\d+[^\s)'"]*)/i;
// Strip ANSI color/escape sequences — dev servers (Astro/Vite) colorize output
// even with FORCE_COLOR=0, and the codes leak into a naive URL match.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*m/g;

const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain',
};

/** Inspect a repo and decide how to run it. */
function detectProject(repoDir: string): DetectedProject {
  const pkgPath = path.join(repoDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    let pkg: PackageJson = {};
    // Only a JSON object counts: a file holding null, a string or an array reads like one that doesn't parse.
    try { const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) pkg = parsed as PackageJson; } catch {}
    const scripts = pkg.scripts || {};
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    let framework: NodeFramework = 'node';
    if (deps.next) framework = 'next';
    else if (deps.astro) framework = 'astro';
    else if (deps.vite) framework = 'vite';
    else if (deps.gatsby) framework = 'gatsby';
    const devScript = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
    if (devScript) {
      return { type: 'node', framework, devScript, buildScript: scripts.build ? 'build' : null, pm: detectPackageManager(repoDir, pkg), name: pkg.name || path.basename(repoDir) };
    }
  }
  // No runnable dev script — treat as static if there's any HTML.
  const root = findStaticRoot(repoDir);
  if (root) return { type: 'static', framework: 'static', staticRoot: root, name: path.basename(repoDir) };
  return { type: 'unknown', name: path.basename(repoDir) };
}

// Which package manager does this repo use? Honor the explicit `packageManager`
// field, then the lockfile, defaulting to npm.
function detectPackageManager(repoDir: string, pkg?: PackageJson | null): PackageManager {
  const declared = pkg && typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0].trim() : '';
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'npm') return declared;
  if (fs.existsSync(path.join(repoDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(repoDir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

// How to invoke a package manager. For pnpm/yarn we prefer `corepack <pm>` —
// corepack ships with Node and auto-provisions the EXACT pinned version, so the
// user doesn't need pnpm/yarn pre-installed. Falls back to a direct binary, then
// npm as a last resort.
function pmInvocation(pm: PackageManager): PmInvocation | null {
  if (pm === 'npm') { const n = which('npm'); return n ? { cmd: n, pre: [] } : null; }
  const corepack = which('corepack');
  if (corepack) return { cmd: corepack, pre: [pm] };
  const direct = which(pm);
  if (direct) return { cmd: direct, pre: [] };
  const n = which('npm');
  return n ? { cmd: n, pre: [], fellBackToNpm: true } : null;
}

function findStaticRoot(repoDir: string): string | null {
  for (const candidate of ['', 'public', 'src', 'site', 'www']) {
    const dir = path.join(repoDir, candidate);
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  // fall back: repo root only if it actually has an .html file at the top level
  // (without this guard, *any* folder — even an empty one — looked like a static
  // site and would start a server with nothing to serve).
  try {
    if (fs.readdirSync(repoDir).some((f) => f.toLowerCase().endsWith('.html'))) return repoDir;
  } catch {}
  return null;
}

/**
 * Does this node project still need `npm install`? True when there's no
 * node_modules at all, or the framework's dev binary is missing from it.
 */
function needsInstall(repoDir: string, project: DetectedProject | null | undefined): boolean {
  if (!project || project.type !== 'node') return false;
  const nm = path.join(repoDir, 'node_modules');
  if (!fs.existsSync(nm)) return true;
  // A pnpm project whose node_modules has no `.pnpm` store was installed by the
  // wrong manager (or partially) — reinstall it properly.
  if (project.pm === 'pnpm' && !fs.existsSync(path.join(nm, '.pnpm'))) return true;
  const binByFramework: Partial<Record<NodeFramework, string>> = { next: 'next', astro: 'astro', vite: 'vite', gatsby: 'gatsby' };
  const bin = binByFramework[project.framework];
  if (bin && !fs.existsSync(path.join(nm, '.bin', bin))) return true;
  return false;
}

// A pnpm project gets hijacked when an ANCESTOR directory has a
// pnpm-workspace.yaml: pnpm walks up, roots at that ancestor, and installs the
// parent workspace instead of this project — leaving this project's own deps
// missing. (Radial clones projects into a projects folder; if that folder, or
// anything above it, is itself a pnpm workspace, every clone is captured.) When
// that's the case we pass `--ignore-workspace` so the project installs/runs as
// the standalone repo it actually is. Only ANCESTORS count — a workspace file
// in the repo root is the project legitimately being its own workspace.
function capturedByAncestorWorkspace(repoDir: string, pm: PackageManager): boolean {
  if (pm !== 'pnpm') return false;
  let dir = path.dirname(path.resolve(repoDir));
  while (true) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/** Install dependencies with the project's package manager, streaming output. */
function install(repoDir: string, project: PmProject | null | undefined, { onLog = () => {} }: PmRunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const pm = (project && project.pm) || 'npm';
    const inv = pmInvocation(pm);
    if (!inv && process.platform !== 'win32') {
      const e: NodeJS.ErrnoException = new Error('Node.js / npm not found on your PATH.'); e.code = NODE_NOT_FOUND; return reject(e);
    }
    if (inv && inv.fellBackToNpm) onLog(`[radial] ${pm} unavailable — using npm (deps may differ; install ${pm} or enable Node’s corepack)`);
    const args = [...((inv && inv.pre) || []), 'install'];
    if (pm === 'pnpm') {
      // We run non-interactively (no TTY). If pnpm needs to purge a node_modules
      // that was built against the wrong root, it would otherwise abort waiting
      // for a confirmation it can never get (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
      args.push('--config.confirm-modules-purge=false');
      if (capturedByAncestorWorkspace(repoDir, pm)) {
        onLog('[radial] this project sits inside a parent pnpm workspace — installing it standalone (--ignore-workspace)');
        args.push('--ignore-workspace');
      }
    }
    if (pm === 'npm') args.push('--no-audit', '--no-fund');
    const child = spawn((inv && inv.cmd) || 'npm', args, {
      cwd: repoDir,
      env: childEnv({ FORCE_COLOR: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }),
      shell: process.platform === 'win32',
    });
    // Guard against a hung install (network stall, an interactive prompt) so the
    // user never sits on "Installing dependencies…" forever. Reset on output.
    let done = false;
    const INSTALL_TIMEOUT = 8 * 60 * 1000;
    let timer = setTimeout(onStall, INSTALL_TIMEOUT);
    function onStall() {
      if (done) return; done = true;
      try { child.kill(); } catch {}
      reject(new Error(`${pm} install stalled (no progress for 8 min). Check your network, or run \`${pm} install\` in the terminal. Radial’s log has the details.`));
    }
    const bump = () => { clearTimeout(timer); timer = setTimeout(onStall, INSTALL_TIMEOUT); };
    const onData = (buf: Buffer) => { bump(); buf.toString().replace(ANSI_RE, '').split(/\r?\n/).forEach((l) => { if (l.trim()) onLog(l); }); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (done) return; done = true; clearTimeout(timer);
      if (e.code === 'ENOENT') { e.code = NODE_NOT_FOUND; }
      reject(e);
    });
    child.on('exit', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${pm} install failed (exit code ${code}). Radial’s log has the details.`));
    });
  });
}

/**
 * Run the project's build script with its package manager, streaming output.
 * Unlike install(), this RESOLVES on failure ({ ok:false, error, log }) rather
 * than rejecting — a red build is a normal outcome the caller handles (offer to
 * ship the last build anyway), not an exception. `log` is a tail of the output
 * so the failure can be surfaced without opening the full Log.
 */
function build(repoDir: string, project: PmProject | null | undefined, { onLog = () => {} }: PmRunOptions = {}): Promise<BuildResult> {
  return new Promise((resolve) => {
    const pm = (project && project.pm) || 'npm';
    const inv = pmInvocation(pm);
    if (!inv && process.platform !== 'win32') {
      return resolve({ ok: false, code: NODE_NOT_FOUND, error: 'Node.js / npm not found on your PATH.' });
    }
    if (inv && inv.fellBackToNpm) onLog(`[radial] ${pm} unavailable — building with npm (install ${pm} or enable Node’s corepack)`);
    const script = (project && project.buildScript) || 'build';
    const args = [...((inv && inv.pre) || []), 'run', script];
    const child = spawn((inv && inv.cmd) || 'npm', args, {
      cwd: repoDir,
      env: childEnv({ FORCE_COLOR: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }),
      shell: process.platform === 'win32',
    });
    // A build can go quiet for a while (bundling, image optimization), so only a
    // truly stuck build should time out. Reset the clock on any output.
    const tail: string[] = [];
    let done = false;
    const BUILD_TIMEOUT = 10 * 60 * 1000;
    let timer = setTimeout(onStall, BUILD_TIMEOUT);
    function finish(result: BuildResult) { if (done) return; done = true; clearTimeout(timer); resolve(result); }
    function onStall() {
      try { child.kill(); } catch {}
      finish({ ok: false, error: `${pm} run ${script} stalled (no output for 10 min). Run \`${pm} run ${script}\` in the terminal to see what’s wrong.`, log: tail.join('\n') });
    }
    const bump = () => { clearTimeout(timer); timer = setTimeout(onStall, BUILD_TIMEOUT); };
    const onData = (buf: Buffer) => {
      bump();
      buf.toString().replace(ANSI_RE, '').split(/\r?\n/).forEach((l) => {
        if (!l.trim()) return;
        onLog(l);
        tail.push(l); if (tail.length > 40) tail.shift();
      });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e: NodeJS.ErrnoException) => finish({
      ok: false,
      code: e.code === 'ENOENT' ? NODE_NOT_FOUND : e.code,
      error: e.code === 'ENOENT' ? 'Node.js / npm not found on your PATH.' : (e.message || 'Build failed to start.'),
      log: tail.join('\n'),
    }));
    child.on('exit', (code) => finish(code === 0
      ? { ok: true }
      : { ok: false, error: `The site build failed (${pm} run ${script}, exit code ${code}).`, log: tail.join('\n') }));
  });
}

/**
 * Start a dev session. Returns a handle with { url, stop, project }.
 * onLog(line) streams server output to the caller.
 * onStatus(text) reports coarse phase changes (e.g. installing) to the UI.
 */
// Publish the live preview's URL where agent terminals can find it. Ports are
// OS-assigned per run (see freePort), so an agent can't guess them — the seeded
// prompt (engine.js) points at .radial/dev.json as the source of truth. .radial/
// is already local-only (context.js git-excludes it; static serving blocks dotdirs).
function devInfoPath(repoDir: string): string { return projectData.dataDir(repoDir, 'dev.json'); }
function writeDevInfo(repoDir: string, handle: DevInfoHandle): void {
  try {
    fs.mkdirSync(projectData.dataDir(repoDir), { recursive: true });
    fs.writeFileSync(devInfoPath(repoDir), JSON.stringify({
      url: handle.url,
      framework: handle.project.framework || handle.project.type,
      pid: (handle.child && handle.child.pid) || handle.pid || process.pid,
      // What is actually serving — lets an agent tell a live dev server from
      // a build-serving one at a glance, and confirms WHICH project this is.
      cwd: repoDir,
      ...(handle.project.devScript ? { script: handle.project.devScript } : {}),
      ...(handle.command ? { command: handle.command } : {}),
      // An adopted server (started by the user outside Radial) — Radial won't
      // stop or restart it, so a wedged one needs a manual restart in ITS terminal.
      ...(handle.external ? { external: true } : {}),
      startedAt: handle.startedAt || handle.observedAt,
    } satisfies DevInfo, null, 2) + '\n', 'utf8');
  } catch { /* best effort — the preview itself is unaffected */ }
}
function clearDevInfo(repoDir: string): void { try { fs.unlinkSync(devInfoPath(repoDir)); } catch {} }

// Wrap a fresh handle: record its URL on disk now, erase it when it stops — so
// dev.json is only ever present (and current) while a server is actually up.
// stop() also marks the handle, so the crash-healer (main.js) can tell a
// deliberate stop from a server that died on its own.
function publishDevInfo(repoDir: string, handle: DevServerHandle): DevServerHandle {
  handle.observedAt = Date.now();
  if (!handle.external) handle.startedAt = handle.observedAt;
  writeDevInfo(repoDir, handle);
  const stop = handle.stop;
  handle.stop = () => { handle.stopped = true; clearDevInfo(repoDir); return stop(); };
  return handle;
}

// --- adopting a dev server the user already runs -----------------------------
// Someone working in a terminal often has `npm run dev` going before they open
// the project in Radial. Starting a second server is wasteful at best (two
// astro/vite processes on different ports) and fatal at worst (Next refuses to
// boot beside another instance, and we rightly never kill a process that isn't
// ours). So: find a LISTENing dev-looking process whose cwd is this repo,
// confirm it answers HTTP, and point the preview at it instead.

// Parse `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` into [{ pid, cmd, host, port }].
function parseLsofListeners(out: string | null | undefined): LsofListener[] {
  const rows: LsofListener[] = [];
  let pid: number | null = null, cmd: string | null = null;
  for (const line of String(out || '').split('\n')) {
    const tag = line[0], val = line.slice(1);
    if (tag === 'p') { pid = parseInt(val, 10); cmd = null; }
    else if (tag === 'c') cmd = val;
    else if (tag === 'n') {
      // e.g. `127.0.0.1:4321`, `*:3000`, `[::1]:3000` — host + trailing port.
      const m = val.match(/^(.*?)[:.](\d+)$/);
      if (m && pid) rows.push({ pid, cmd: cmd || '', host: m[1].replace(/^\[|\]$/g, ''), port: parseInt(m[2], 10) });
    }
  }
  return rows;
}

// URLs worth probing for a listener. Next 16 binds `::1` (v6 localhost ONLY)
// on modern macOS, so assuming 127.0.0.1 misses it entirely; wildcards accept
// either family, so try v4 first (friendlier URL) then v6.
function candidateUrls(host: string, port: number): string[] {
  if (host === '*' || host === '0.0.0.0' || host === '::') {
    return [`http://127.0.0.1:${port}/`, `http://[::1]:${port}/`];
  }
  return [host.includes(':') ? `http://[${host}]:${port}/` : `http://${host}:${port}/`];
}

// Parse `lsof -a -p <pid> -d cwd -Fn` → the process's cwd (or null).
function parseLsofCwd(out: string | null | undefined): string | null {
  const m = String(out || '').match(/^n(.+)$/m);
  return m ? m[1] : null;
}

function pidCwd(pid: number): string | null {
  try {
    return parseLsofCwd((require('child_process') as typeof import('child_process')).execFileSync(
      'lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 4000 }));
  } catch { return null; }
}

// The program a process runs: the first word of its command line (node, bun,
// deno), from /proc on Linux and ps elsewhere; '' when it can't be read.
function programName(pid: number): string {
  try { return path.basename(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0]); } catch {}
  return path.basename(String(devProcessCommand(pid) || '').split(/\s+/)[0] || '');
}

// Whether a LISTENing process looks like a dev server. lsof's command is the
// process's comm, which on Linux is its main thread's name, and Node 24 names
// that thread MainThread: a Node dev server never looked like one there, so it
// was never adopted. When lsof's name doesn't say, the program it runs does.
function looksLikeDevProcess(row: LsofListener, programOf: (pid: number) => string = programName): boolean {
  return DEV_PROC_RE.test(row.cmd) || DEV_PROC_RE.test(programOf(row.pid));
}

// All listening sockets of dev-server processes working out of `repoDir`.
// One pid can hold several (e.g. v4 + v6, or an HMR side-channel).
function externalServersFor(repoDir: string): LsofListener[] {
  if (process.platform === 'win32') return [];
  let out = '';
  try {
    out = (require('child_process') as typeof import('child_process')).execFileSync(
      'lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { encoding: 'utf8', timeout: 5000 });
  } catch (e) { out = String((e && (e as ExecFileSyncError).stdout) || ''); } // lsof exits non-zero on any denied pid; stdout is still good
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  const want = real(repoDir);
  const cwdCache = new Map<number, boolean>(); // pid -> matches repo?
  const rows: LsofListener[] = [];
  for (const row of parseLsofListeners(out)) {
    if (row.port <= 1024 || !looksLikeDevProcess(row)) continue;
    if (!cwdCache.has(row.pid)) {
      const cwd = pidCwd(row.pid);
      cwdCache.set(row.pid, !!cwd && real(cwd) === want);
    }
    if (cwdCache.get(row.pid)) rows.push(row);
  }
  return rows;
}

// A command line that serves a BUILD rather than live source (`astro preview`,
// `vite preview`, static file servers). Adopting one gives a preview that
// never reflects edits — worse than no preview, because it looks alive.
// (Next's `start` runs the same `next-server` process name as dev, so it's
// not distinguishable here; astro/vite — the common case — are.)
function looksLikeBuildServer(cmd: string | null | undefined): boolean {
  const c = String(cmd || '');
  if (/\bdev\b/i.test(c)) return false;
  return /\bpreview\b|\bhttp-server\b|\bsuperstatic\b|\bsirv\b/i.test(c);
}

// Does the port actually answer HTTP? (A pid can hold a socket while wedged.)
function answers(url: string, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.destroy(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

// Adopt the user's server: preview points at it, stop() leaves it alone.
async function adoptExternal(repoDir: string, project: NodeProject, onLog: OnLog, ownsPid: OwnsPid | null): Promise<ExternalServerHandle | null> {
  for (const found of externalServersFor(repoDir)) {
    if (ownsPid && ownsPid(found.pid)) continue; // one of ours → normal reap/start flow owns it
    const command = devProcessCommand(found.pid) || '';
    if (looksLikeBuildServer(command)) {
      onLog(`[radial] ignoring ${command.includes('preview') ? 'a `preview`' : 'a build/static'} server running for this project (pid ${found.pid}) — it serves the BUILT site, not live source, so edits would never show. Starting a live dev server instead.`);
      continue;
    }
    for (const url of candidateUrls(found.host, found.port)) {
      if (!(await answers(url))) continue;
      onLog(`[radial] found your dev server already running for this project (pid ${found.pid}) — using ${url} for the preview. Radial won't stop or restart it; manage it from where you started it.`);
      return {
        url,
        project,
        external: true,
        pid: found.pid,
        command: command.slice(0, 200),
        stop: () => Promise.resolve(), // never touch a server we didn't start
      };
    }
  }
  return null;
}

async function start(repoDir: string, { onLog = () => {}, onStatus = () => {}, onChanged = null, timeoutMs = 60000, ownsPid = null }: StartOptions = {}): Promise<DevServerHandle> {
  const project = detectProject(repoDir);

  if (project.type === 'static') {
    return publishDevInfo(repoDir, await startStatic(repoDir, project, onLog, onChanged));
  }
  if (project.type === 'node') {
    // The user may already be running this project's dev server from their own
    // terminal — use it rather than racing it (fatal for Next, wasteful for the
    // rest). EXCEPT when OS file-watching is wedged: an adopted server is just
    // as blind as any other, but Radial can't restart a server it doesn't own,
    // so degraded mode (restart after every agent edit) only works on OUR OWN
    // server. Next stays adopt-only — a second instance refuses to boot.
    const wedged = watcherHealth.healthy() === false;
    if (!wedged || project.framework === 'next') {
      const adopted = await adoptExternal(repoDir, project, onLog, ownsPid);
      if (adopted) return publishDevInfo(repoDir, adopted);
    } else {
      onLog('[radial] macOS file-watching is down, so Radial is starting its OWN dev server (a server it owns can be auto-restarted after each edit). Any server you started yourself keeps running untouched.');
    }
    // If a pnpm project's node_modules was built by a different manager, wipe it
    // so the reinstall is clean (avoids half-foreign trees missing packages).
    const nm = path.join(repoDir, 'node_modules');
    if (project.pm === 'pnpm' && fs.existsSync(nm) && !fs.existsSync(path.join(nm, '.pnpm'))) {
      onLog('[radial] node_modules was built by a different package manager — reinstalling with pnpm');
      try { fs.rmSync(nm, { recursive: true, force: true }); } catch {}
    }
    if (needsInstall(repoDir, project)) {
      onStatus('Installing dependencies… (first run can take a minute)');
      onLog(`[radial] installing dependencies with ${project.pm}`);
      await install(repoDir, project, { onLog });
      onStatus('Starting dev server…');
    }
    return publishDevInfo(repoDir, await startNode(repoDir, project, onLog, onStatus, timeoutMs, 0, ownsPid));
  }
  throw new Error('Could not detect how to run this project (no dev script, no index.html).');
}

function startStatic(repoDir: string, project: StaticProject, onLog: OnLog, onChanged: (() => void) | null): Promise<StaticServerHandle> {
  return new Promise((resolve, reject) => {
    const root = project.staticRoot;
    // Live reload for the static path: real framework dev servers HMR on their
    // own, but this tiny server just reads files — without a watcher the user
    // must refresh manually after every edit (their own, the agent's, or a
    // Radial text edit). Recursive fs.watch (FSEvents on macOS), debounced so
    // a multi-file agent edit lands as one reload. If the OS watcher is
    // unavailable/wedged, behavior degrades to exactly what it was before.
    let watcher: TreeWatch | null = null;
    let changeTimer: NodeJS.Timeout | null = null;
    if (typeof onChanged === 'function') {
      try {
        const watchStart = Date.now();
        watcher = watchTree(root, () => {
          // FSEvents replays events from just before the watcher existed (the
          // project files being read/written during open) — a short grace
          // window absorbs that instead of reloading a page that just loaded.
          if (Date.now() - watchStart < 1000) return;
          clearTimeout(changeTimer as NodeJS.Timeout | undefined); // null is a no-op; @types/node leaves it out
          changeTimer = setTimeout(() => { try { onChanged(); } catch {} }, 300);
        }, { skip: (seg) => seg.startsWith('.') }); // .git/.radial etc.
      } catch {}
    }
    const server = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        // Never serve dotfiles/dirs (e.g. .radial/, .git/) — mirrors real hosts
        // and keeps Radial's context files out of the previewed site. Also keep
        // project-memory files (AGENTS.md / CLAUDE.md) private.
        if (urlPath.split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')
          || /^\/(AGENTS|CLAUDE)\.md$/i.test(urlPath)) {
          res.writeHead(404); res.end('Not found'); return;
        }
        let filePath = path.join(root, urlPath);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
          filePath = path.join(filePath, 'index.html');
        }
        if (!fs.existsSync(filePath)) {
          // try .html extension (clean URLs)
          if (fs.existsSync(filePath + '.html')) filePath += '.html';
          else { res.writeHead(404); res.end('Not found'); return; }
        }
        // prevent path traversal
        if (!path.resolve(filePath).startsWith(path.resolve(root))) {
          res.writeHead(403); res.end('Forbidden'); return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        fs.createReadStream(filePath).pipe(res);
      } catch (e) {
        res.writeHead(500); res.end(String(e));
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/`;
      onLog(`[radial] static server on ${url}`);
      resolve({
        url,
        project,
        stop: () => new Promise((r) => {
          clearTimeout(changeTimer as NodeJS.Timeout | undefined); // null is a no-op; @types/node leaves it out
          try { if (watcher) watcher.close(); } catch {}
          server.close(() => r());
        }),
      });
    });
  });
}

// Kill a process and its whole group/tree (a dev server spawns workers that a
// plain kill leaves orphaned — Next 16 then refuses to start again). SIGTERM
// then SIGKILL; on Windows, taskkill /T. `pid` is the spawned group leader.
function killGroup(pid: number | null | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try { (require('child_process') as typeof import('child_process')).execFile('taskkill', ['/pid', String(pid), '/T', '/F']); } catch {}
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }, 2000);
}
function killTree(child: ChildProcess | null | undefined): void { if (child && child.pid) killGroup(child.pid); }

// The command line of a live pid (null if it's not running). Used to confirm a
// recorded pid is still a dev server before reaping it (guards against pid reuse).
function devProcessCommand(pid: number | null | undefined): string | null {
  if (!pid || process.platform === 'win32') return null;
  try { return (require('child_process') as typeof import('child_process')).execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() || null; }
  catch { return null; }
}

// The process group (pgid) of a pid, or null. We spawn dev servers detached, so
// the spawned pid IS its group's leader/pgid — every worker shares that pgid.
function pidGroup(pid: number | null | undefined): number | null {
  if (!pid || process.platform === 'win32') return null;
  try { const o = (require('child_process') as typeof import('child_process')).execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim(); return o ? parseInt(o, 10) : null; }
  catch { return null; }
}

// One shared "is this one of our dev-server processes" test.
const DEV_PROC_RE = /node|next|vite|astro|gatsby|remix|nuxt|npm|pnpm|yarn|serve|workerd/i;

// Snapshot of running processes (`pid pgid command` per line), or null if `ps`
// is unavailable. One call covers a whole sweep.
function listProcesses(): string | null {
  if (process.platform === 'win32') return null;
  try { return (require('child_process') as typeof import('child_process')).execFileSync('ps', ['axo', 'pid=,pgid=,command='], { encoding: 'utf8' }); }
  catch { return null; }
}

// Every pid in process group `pgid` (empty when ps is unavailable). A dev
// server's workers share the leader's pgid but have their own pids — killing
// ANY of them breaks the preview, so guards need the full member list.
function groupMemberPids(pgid: number | null | undefined, psOutput?: string | null): number[] {
  if (!pgid) return [];
  const out = psOutput != null ? psOutput : listProcesses();
  if (!out) return [];
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s/);
    if (m && parseInt(m[2], 10) === pgid) pids.push(parseInt(m[1], 10));
  }
  return pids;
}

// Pure predicate (exported for tests): does a LIVING member of process group
// `pgid` look like a dev server? This is what makes reaping safe against pid
// reuse — a recycled pid is a normal process that inherits its parent's pgid,
// not one equal to itself, so it won't match a recorded group leader.
function groupHasDevMember(pgid: number | null | undefined, listing: string | null | undefined): boolean {
  if (!pgid || !listing) return false;
  return listing.split('\n').some((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m && parseInt(m[2], 10) === pgid && DEV_PROC_RE.test(m[3]);
  });
}

// Kill each recorded dev-server group, but only if a living member still looks
// like a dev server (catches a child that outlived its leader; reuse-safe).
// One `ps` pass for the whole batch. If `ps` fails we SKIP rather than blind-kill
// the wrong group — a missed orphan is reaped on the next boot sweep; a wrongly
// killed group is someone else's process.
function reapGroups(pgids: readonly (number | null | undefined)[] | null | undefined): void {
  const list = (pgids || []).filter(Boolean);
  if (!list.length) return;
  if (process.platform === 'win32') { list.forEach(killGroup); return; } // win: no pgid scan, best-effort
  const listing = listProcesses();
  if (listing == null) return; // ps unavailable → skip, don't blind-kill
  for (const pgid of list) if (groupHasDevMember(pgid, listing)) killGroup(pgid);
}
function reapGroup(pgid: number | null | undefined): void { reapGroups([pgid]); }

// Grab a port the OS just confirmed is free (bind to 0, read it, release). We
// hand this to the dev server so it never collides with a leftover one on the
// framework's default port (the usual cause of EADDRINUSE on open).
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); });
  });
}

async function startNode(repoDir: string, project: NodeProject, onLog: OnLog, onStatus: OnStatus, timeoutMs: number, _attempt: number, ownsPid: OwnsPid | null, _healed?: boolean, _port?: number | null): Promise<NodeServerHandle> {
  let port = _port || null;
  if (!port) { try { port = await freePort(); } catch { port = null; } }
  return new Promise((resolve, reject) => {
    const pm = (project && project.pm) || 'npm';
    const inv = pmInvocation(pm);
    if (!inv && process.platform !== 'win32') {
      const e: NodeJS.ErrnoException = new Error('Node.js / npm not found on your PATH.'); e.code = NODE_NOT_FOUND; return reject(e);
    }
    // pnpm 11 verifies node_modules before every `run` and, if it thinks the
    // store is stale (common when a project was installed `--ignore-workspace`
    // but sits inside a parent pnpm workspace), tries to purge+reinstall. We
    // spawn with no TTY, so that prompt aborts the whole command before the dev
    // script ever runs (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`) — leaving
    // nothing listening and an endless connection-refused preview. Skip the
    // pre-run check so the dev script just runs; Radial manages installs itself.
    const runner = inv?.fellBackToNpm ? 'npm' : pm;
    const pmFlags = runner === 'pnpm'
      ? ['--config.verify-deps-before-run=false', ...(capturedByAncestorWorkspace(repoDir, pm) ? ['--ignore-workspace'] : [])]
      : [];
    // Force the dev server onto our pre-checked free port. PORT env covers Next,
    // Gatsby, CRA, Remix, and most custom node servers; vite/astro/gatsby also
    // (or only) read `--port`, so forward that too for those. Don't inject args
    // for an unknown ('node') framework — a custom script may not accept them.
    // npm consumes the separator; pnpm forwards it to the framework CLI.
    const portArgs = (port && ['vite', 'astro', 'gatsby'].includes(project.framework)) ? [...(runner === 'npm' ? ['--'] : []), '--port', String(port)] : [];
    const child = spawn((inv && inv.cmd) || 'npm', [...((inv && inv.pre) || []), ...pmFlags, 'run', project.devScript, ...portArgs], {
      cwd: repoDir,
      env: childEnv({ BROWSER: 'none', FORCE_COLOR: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', ...watcherEnv(), ...(port ? { PORT: String(port) } : {}) }),
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32', // own process group → we can kill the whole tree
    });
    // Record the pid the moment it exists, not after "ready": if Radial dies
    // mid-start (crash, force-quit, a test harness closing it), a not-yet-ready
    // server was invisible to reapAllOrphans and leaked its whole process group
    // to ppid 1 — the founder-machine swap incident. Ready-path bookkeeping in
    // main re-sets the same pid; stop/clear paths already erase it.
    if (child.pid) devPids.set(repoDir, child.pid);

    let settled = false;
    let probing = false;
    let out = ''; // rolling capture so a crash can report WHY it exited
    const deadline = Date.now() + timeoutMs;
    // A server that ACCEPTS connections but never answers them is hung (an
    // exception storm, a compile loop), not booting — waiting out the full
    // timeout there reads as an endless spinner. Give that state its own
    // shorter budget, counted from the later of first-accept and last output,
    // so a slow compile that's still printing progress is never called stuck.
    const stuckMs = Math.min(90000, Math.max(6000, Math.floor(timeoutMs / 2)));
    let acceptedAt = 0; // first probe that connected without getting an answer
    let lastOutputAt = Date.now();
    let lastStatusAt = 0; // throttle for narrating output lines to the spinner
    const hintFrom = (s: string) => {
      const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const err = [...lines].reverse().find((l) => /error|err!|cannot|not found|EADDRINUSE|missing|failed|undefined/i.test(l));
      return (err || lines[lines.length - 1] || '').slice(0, 240);
    };
    const fail = (msg: string) => { if (settled) return; settled = true; clearTimeout(timer); try { killTree(child); } catch {} reject(new Error(msg)); };

    // Only report ready once the server *actually answers* — Next.js prints its
    // URL well before it can serve (and sometimes prints a URL, then exits).
    const waitReady = (url: string) => {
      if (settled || child.exitCode !== null || child.signalCode) return; // exited → exit handler decides
      const now = Date.now();
      if (now > deadline) return fail(`Dev server didn’t become ready within ${Math.round(timeoutMs / 1000)}s. Radial’s log has the details (⌘⇧L in the Mac app).`);
      if (acceptedAt && now - Math.max(acceptedAt, lastOutputAt) > stuckMs) {
        return fail(`The dev server is running but hasn’t answered a request in ${Math.round(stuckMs / 1000)}s and looks stuck. Radial’s log has its output (⌘⇧L in the Mac app).`);
      }
      if (acceptedAt && now - acceptedAt > 3000) onStatus(`Dev server is up but hasn’t responded yet… (${Math.round((now - acceptedAt) / 1000)}s)`);
      let connected = false;
      let rescheduled = false; // 'error' and the probe timeout can both fire — schedule exactly one retry
      const again = () => { if (!rescheduled && !settled) { rescheduled = true; setTimeout(() => waitReady(url), 300); } };
      const req = http.get(url, (res) => { res.destroy(); if (!settled) { settled = true; clearTimeout(timer); resolve({ url, project, stop: () => new Promise((r) => { killTree(child); r(); }), child }); } });
      req.on('socket', (s) => s.once('connect', () => { connected = true; if (!acceptedAt) acceptedAt = Date.now(); }));
      req.on('error', () => { if (!connected) acceptedAt = 0; again(); }); // refused → still booting, restart the stuck clock
      req.setTimeout(2500, () => { req.destroy(); again(); }); // destroy() emits no 'error' — retry explicitly or the probe chain dies
    };
    const timer = setTimeout(() => fail(probing
      ? `Dev server didn’t become ready within ${Math.round(timeoutMs / 1000)}s. Radial’s log has the details (⌘⇧L in the Mac app).`
      : `Dev server didn’t report a URL within ${Math.round(timeoutMs / 1000)}s. Last output: ${hintFrom(out) || '(none)'}. Radial’s log has the details (⌘⇧L in the Mac app).`), timeoutMs);

    const scan = (buf: Buffer) => {
      const text = buf.toString().replace(ANSI_RE, '');
      out = (out + text).slice(-12000);
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      lines.forEach((line) => onLog(line));
      if (lines.length) {
        lastOutputAt = Date.now();
        // Narrate the boot onto the loading spinner — a long "Starting…" with
        // no signs of life is indistinguishable from a hang.
        if (!settled && lastOutputAt - lastStatusAt > 400) {
          lastStatusAt = lastOutputAt;
          onStatus(lines[lines.length - 1].trim().slice(0, 120));
        }
      }
      if (!settled && !probing) {
        // Match the CUMULATIVE buffer, not this chunk: a URL can split across
        // stdout chunks, and a per-chunk match locks onto a port-less prefix
        // ("http://127.0.0.1:") — then probes port 80 until the timeout. Only
        // accept a URL with at least one character after it (its newline),
        // proving the chunk didn't end mid-port.
        const m = out.match(URL_RE);
        if (m && m.index! + m[0].length < out.length) { probing = true; waitReady(m[1].replace(/\/$/, '') + '/'); }
      }
    };

    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('error', (e: NodeJS.ErrnoException) => { if (!settled) { settled = true; clearTimeout(timer); if (e.code === 'ENOENT') e.code = NODE_NOT_FOUND; reject(e); } });
    child.on('exit', (code) => {
      onLog(`[radial] dev process exited with code ${code}`);
      if (settled) return;
      settled = true; clearTimeout(timer);
      // Next.js refuses to start when a leftover dev server for this project is
      // still running. It names the pid — if it's one Radial started, reap it
      // and retry (a few times, in case several stacked up). If it's NOT ours
      // (e.g. a server the user started outside Radial), never kill it.
      const m = out.match(/already running[\s\S]{0,240}?(?:kill|PID:?)\s+(\d+)/i);
      if (m && (_attempt || 0) < 3) {
        const orphan = parseInt(m[1], 10);
        if (ownsPid && !ownsPid(orphan)) {
          return reject(new Error(`Another dev server for this project is already running (pid ${orphan}), and it isn’t one Radial started — stop it, then try again.`));
        }
        onLog(`[radial] a leftover dev server (pid ${orphan}) was blocking — stopping it and retrying…`);
        killGroup(orphan);
        setTimeout(() => startNode(repoDir, project, onLog, onStatus, timeoutMs, (_attempt || 0) + 1, ownsPid, _healed).then(resolve, reject), 1500);
        return;
      }
      // Incomplete node_modules: the dev server crashes on a missing package
      // (e.g. a project nested in a parent pnpm workspace whose own deps never
      // got installed). Install once — now with the right isolation — and retry.
      if (!_healed && /Cannot find module|MODULE_NOT_FOUND|ERR_PNPM|Cannot find package/i.test(out)) {
        onLog('[radial] a dependency is missing — installing, then retrying the dev server…');
        install(repoDir, project, { onLog })
          .then(() => startNode(repoDir, project, onLog, onStatus, timeoutMs, 0, ownsPid, true).then(resolve, reject))
          .catch((e: Error) => reject(new Error(`The dev server couldn’t start — installing dependencies failed: ${e.message}`)));
        return;
      }
      // Port collision despite our pre-assigned port — a framework that ignored
      // it, or something grabbed the port in the race. Retry on a fresh free port.
      if (/EADDRINUSE|address already in use|port\s+\d+\s+is (?:already )?in use/i.test(out) && (_attempt || 0) < 3) {
        onLog('[radial] the port was in use — retrying the dev server on a fresh free port…');
        setTimeout(() => startNode(repoDir, project, onLog, onStatus, timeoutMs, (_attempt || 0) + 1, ownsPid, _healed).then(resolve, reject), 600);
        return;
      }
      const hint = hintFrom(out);
      reject(new Error(`The dev server (\`run ${project.devScript}\`) exited (code ${code}) before it was ready${hint ? `: ${hint}` : ''}. Radial’s log has the full output (⌘⇧L in the Mac app).`));
    });
  });
}

// --- dev-server memory ceiling support ---------------------------------------
// One `ps` snapshot, then a children-walk per root pid. Pure half
// (sumTreeRss) is unit-tested; treeRssMb is the thin exec wrapper.
function sumTreeRss(psText: string | null | undefined, roots: readonly number[]): Map<number, number> {
  const kids = new Map<number, number[]>(); const rss = new Map<number, number>();
  for (const line of String(psText || '').split('\n')) {
    const m = line.trim().split(/\s+/);
    if (m.length < 3) continue;
    const pid = parseInt(m[0], 10), ppid = parseInt(m[1], 10), r = parseInt(m[2], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(r)) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid)!.push(pid);
    rss.set(pid, r);
  }
  const out = new Map<number, number>();
  for (const root of roots) {
    let total = 0; const stack = [root]; const seen = new Set<number>();
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue; seen.add(pid);
      if (rss.has(pid)) total += rss.get(pid)!;
      for (const k of (kids.get(pid) || [])) stack.push(k);
    }
    out.set(root, Math.round(total / 1024)); // KB → MB
  }
  return out;
}

function treeRssMb(roots: readonly number[] | null | undefined): Map<number, number> {
  if (!roots || !roots.length || process.platform === 'win32') return new Map();
  let out = '';
  try {
    out = (require('child_process') as typeof import('child_process')).execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) { out = String((e && (e as ExecFileSyncError).stdout) || ''); }
  return sumTreeRss(out, roots);
}

export { detectProject, detectPackageManager, pmInvocation, start, needsInstall, install, build, capturedByAncestorWorkspace, killGroup, devProcessCommand, pidGroup, reapGroup, reapGroups, groupHasDevMember, groupMemberPids, clearDevInfo, sumTreeRss, treeRssMb, parseLsofListeners, parseLsofCwd, looksLikeDevProcess, candidateUrls, looksLikeBuildServer, watcherEnv, NODE_NOT_FOUND };
