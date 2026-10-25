/**
 * Resolve the user's real shell PATH and a sane child-process environment.
 *
 * A macOS app launched from Finder/Dock does NOT inherit the login shell's
 * PATH — it gets a minimal `/usr/bin:/bin:/usr/sbin:/sbin`. That means
 * `npm`, `node`, `git`, and `claude` (all of which live in Homebrew / nvm /
 * Volta dirs) are invisible to spawned processes, so dev servers and the
 * agent silently fail with ENOENT. We fix this once, at startup, by asking
 * the login shell for its PATH and merging in the usual install locations.
 *
 * In dev (`npm start`) PATH is already correct, so this is a harmless no-op.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

let cachedPath: string | null = null;

// With SHELL unset, the first of these that exists: zsh is the Mac's, bash and
// sh cover Linux images that have no zsh.
const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash', '/bin/sh'];

/**
 * The person's shell: SHELL, or when it's unset (Docker and other containers
 * set none) the first of zsh, bash and sh that exists. Not for Windows.
 * `env` and `exists` are seams for the tests.
 */
export function userShell(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): string {
  if (env.SHELL) return env.SHELL;
  return FALLBACK_SHELLS.find((file) => exists(file)) || '/bin/sh';
}

function loginShellPath(): string {
  if (process.platform === 'win32') return process.env.PATH || '';
  const shell = userShell();
  const D = '__RADIAL_PATH__';
  try {
    // -i -l -c so rc files (which set up nvm/Volta/Homebrew) are sourced.
    const out = execFileSync(shell, ['-ilc', `printf '%s' "${D}$PATH${D}"`], {
      encoding: 'utf8',
      timeout: 6000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(new RegExp(D + '([^]*?)' + D));
    if (m && m[1]) return m[1];
  } catch {
    /* fall through to the static fallback below */
  }
  return process.env.PATH || '';
}

// Bin dirs registered at runtime — Radial-provisioned tools (tools.js), e.g.
// userData/tools/node-current/bin after a userland Node install. Listed with
// the common dirs, so the login shell's own PATH still wins when it has the
// tool (a machine with its own Node never sees the provisioned one).
const extraBinDirs: string[] = [];
export function registerExtraBin(dir: string | null | undefined): void {
  if (!dir || extraBinDirs.includes(dir)) return;
  extraBinDirs.push(dir);
  cachedPath = null; // recompute on next childEnv/which
  cachedClaude = undefined;
}

function commonBinDirs(): string[] {
  const home = os.homedir();
  return [
    ...extraBinDirs,
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    '/usr/local/bin', '/usr/local/sbin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    path.join(home, '.volta', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    // npm's "global installs without sudo" convention (npm config prefix) —
    // where `npm i -g @anthropic-ai/claude-code` lands for many users.
    path.join(home, '.npm-global', 'bin'),
    // Claude Code's local-install location (`claude install` / migrate-installer).
    path.join(home, '.claude', 'local'),
    // nvm: include the most recent installed version's bin, if any.
    ...nvmBinDirs(home),
  ];
}

function nvmBinDirs(home: string): string[] {
  const versionsDir = path.join(home, '.nvm', 'versions', 'node');
  try {
    return fs.readdirSync(versionsDir)
      .sort()
      .reverse()
      .map((v) => path.join(versionsDir, v, 'bin'));
  } catch {
    return [];
  }
}

/** The merged PATH: login shell first, then current env, then common dirs. */
export function enhancedPath(): string {
  if (cachedPath) return cachedPath;
  const seen = new Set<string>();
  const parts: string[] = [];
  const add = (p: string) => { if (p && !seen.has(p)) { seen.add(p); parts.push(p); } };
  loginShellPath().split(path.delimiter).forEach(add);
  (process.env.PATH || '').split(path.delimiter).forEach(add);
  commonBinDirs().forEach(add);
  cachedPath = parts.filter(Boolean).join(path.delimiter);
  return cachedPath;
}

// Env vars that must NOT propagate into the CLIs/processes Radial spawns. If
// Radial was launched from inside a Claude Code session (or any nested agent),
// process.env carries that session's runtime markers — and a real `claude` CLI
// started in a Radial terminal would see CLAUDECODE / CLAUDE_CODE_CHILD_SESSION
// and decide it's a nested child session, disabling session persistence (so its
// agents / backgrounding break). ELECTRON_RUN_AS_NODE is only meant for the PTY
// daemon process itself; leaking it would make child node/electron procs run as
// plain node. We scrub all of these so every spawned process starts clean. So
// are the e2e suites' background and foreground switches (e2eBackground.ts):
// they are for the app under test, never for what runs in its terminals.
const STRIP_ENV = new Set(['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'AI_AGENT', 'RADIAL_E2E_BACKGROUND', 'RADIAL_E2E_FOREGROUND']);
// Claude Code's own settings, which the person sets and every CLI Radial starts
// should keep: the Bedrock, Vertex and Foundry switches and their auth skips,
// a sign-in token (`claude setup-token`), a client certificate, the key helper's
// cache and the output limit. Every other CLAUDE_CODE_ variable is a session's
// runtime marker and goes.
const KEEP_CLAUDE_CODE = new Set([
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
]);
function isInheritedAgentVar(key: string): boolean {
  return STRIP_ENV.has(key) || (key.startsWith('CLAUDE_CODE_') && !KEEP_CLAUDE_CODE.has(key));
}

/** process.env with the enhanced PATH merged in (plus any overrides), minus the
 *  inherited agent-session markers that would confuse a freshly spawned CLI. */
export function childEnv(extra?: NodeJS.ProcessEnv | null): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) { if (!isInheritedAgentVar(k)) out[k] = v; }
  // PATH must be set AFTER the process.env copy — a Finder launch has the
  // minimal /usr/bin:/bin PATH in process.env, and letting it clobber the
  // enhanced one makes every npm shebang die with `env: node: No such file
  // or directory` in packaged builds (dev launches mask this: their
  // process.env.PATH is already the full shell PATH).
  out.PATH = enhancedPath();
  return { ...out, ...(extra || {}) };
}

/** Absolute path to an executable on the enhanced PATH, or null. */
export function which(cmd: string): string | null {
  if (process.platform === 'win32') return cmd; // let the shell resolve it
  for (const dir of enhancedPath().split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

/** Every match for an executable across the enhanced PATH, deduped by realpath. */
export function whichAll(cmd: string): string[] {
  if (process.platform === 'win32') return [cmd];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of enhancedPath().split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (!fs.statSync(p).isFile()) continue;
      const real = (() => { try { return fs.realpathSync(p); } catch { return p; } })();
      if (!seen.has(real)) { seen.add(real); out.push(p); }
    } catch { /* keep looking */ }
  }
  return out;
}

// A machine can hold several `claude` installs (npm-global, ~/.local/bin, a
// stale root install in /usr/local/bin). Their PATH order comes from the login
// shell, which a Finder launch can't always reproduce — the fallback ordering
// put /usr/local/bin first, so a forgotten old CLI there shadowed the real one
// and new flags/models broke ("error: unknown option '--effort'"). So pick by
// VERSION, not by PATH position. Keep that selection while it is executable.
let cachedClaude: string | null | undefined; // undefined = not probed yet; null = no claude installed
let claudeProbedAt = 0;
export function claudeBin(): string | null {
  if (cachedClaude) {
    try {
      fs.accessSync(cachedClaude, fs.constants.X_OK);
      if (fs.statSync(cachedClaude).isFile()) return cachedClaude;
    } catch { /* A self-update can remove or relocate the selected executable. */ }
    cachedClaude = undefined;
    cachedPath = null;
  } else if (cachedClaude === null) {
    if (Date.now() - claudeProbedAt < 5000) return null;
    cachedPath = null;
  }
  type Version = [number, number, number];
  const cmp = (a: Version, b: Version) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
  let best: string | null = null, bestV: Version | null = null;
  for (const p of whichAll('claude')) {
    let v: Version | null = null;
    try {
      const out = execFileSync(p, ['--version'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
      if (m) v = [+m[1], +m[2], +m[3]];
    } catch { /* unprobeable — usable only as a last resort */ }
    if (!best) { best = p; bestV = v; }
    else if (v && (!bestV || cmp(v, bestV) > 0)) { best = p; bestV = v; }
  }
  cachedClaude = best;
  claudeProbedAt = Date.now();
  return cachedClaude;
}
