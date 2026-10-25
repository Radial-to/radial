/**
 * `radial doctor`: what `radial serve` needs on this machine, and what to run
 * for anything missing (plans/headless-core.md). Node and git are required;
 * node-pty runs the agent terminals (a prebuilt binary, or one compiled
 * here); ps and lsof let it adopt and clean up dev servers; on Linux, enough
 * inotify watches for the sites' folders; an agent CLI that is installed and
 * signed in (Claude Code or Codex, found without reading any secret); the
 * browser does its page work (screenshots, page fields, migration compares),
 * and on Linux the browser needs system libraries. It also says whether the
 * browser runs with Chrome's sandbox: as a running serve's browser found
 * (browser.json in the data dir), else by starting it once now. Exit 1 when
 * something required is missing.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import * as browser from './browser';
import * as nodePty from './nodePty';
import * as dataDirs from '../main/dataDirs';
import { sandboxFailure, sandboxFile } from './browser';
import type { SandboxRecord } from './browser';
import type { PtyStatus } from './nodePty';
import type { CliIo, Flags } from '../main/cli';

/** One check: whether it passed, whether serve needs it to run at all, what was found, and what to run when it's missing (label: the word printed when it didn't pass, missing unless it says). */
export interface Check { name: string; ok: boolean; required: boolean; detail: string; fix?: string; label?: string }

/** The oldest Node Radial runs on (package.json engines). */
const MIN_NODE: [number, number] = [22, 18];

/** The calls deps holds: finding a command on PATH and asking git its version; or a test's stand-ins. */
export interface DoctorDeps {
  nodeVersion: string;
  /** A command's full path on PATH, or null. */
  which(name: string): string | null;
  /** `git --version`'s answer, or null when git doesn't run. */
  gitVersion(): string | null;
  /** Starts the browser with its sandbox and closes it: whether it could, and why not; null when it didn't start for another reason. */
  trySandbox(): Promise<{ sandbox: boolean; reason: string | null } | null>;
  /** Whether node-pty loads here, and which binary (nodePty.status). */
  pty(): PtyStatus;
  /** A file's text, or null when it can't be read. */
  readFile(file: string): string | null;
  /** A file's size in bytes, or null when it isn't there. */
  size(file: string): number | null;
  /** The first line `<command> --version` prints, or null when it doesn't run. */
  version(command: string): string | null;
  /** Whether macOS's Keychain has an item for a service: only that it's there, never what it holds. */
  keychainHas(service: string): boolean;
  env: NodeJS.ProcessEnv;
  home: string;
}
export const deps: DoctorDeps = {
  nodeVersion: process.versions.node,
  which(name) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const file = path.join(dir, name);
      try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
    }
    return null;
  },
  gitVersion() {
    const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
    return r.status === 0 ? String(r.stdout).trim().replace(/^git version /, '') : null;
  },
  async trySandbox() {
    let pw: typeof import('playwright-core');
    try { pw = require('playwright-core') as typeof import('playwright-core'); } catch { return null; }
    try { const b = await pw.chromium.launch({ headless: true, chromiumSandbox: true, timeout: 30000 }); await b.close(); return { sandbox: true, reason: null }; }
    catch (e) { const reason = sandboxFailure(String((e as Error)?.message || e)); return reason ? { sandbox: false, reason } : null; }
  },
  pty: () => nodePty.status(),
  readFile(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } },
  size(file) { try { return fs.statSync(file).size; } catch { return null; } },
  version(command) {
    const r = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    return r.status === 0 ? (String(r.stdout).trim().split('\n')[0] || null) : null;
  },
  keychainHas(service) {
    // No -w: security says whether the item is there without reading its secret, and without asking for access.
    return spawnSync('security', ['find-generic-password', '-s', service], { stdio: 'ignore', timeout: 5000 }).status === 0;
  },
  env: process.env,
  home: os.homedir(),
};

/** Whether a process is still there. */
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } }

/** The sandbox check: the mode a running serve's browser is in (browser.json), else what starting the browser now shows. */
async function sandboxCheck(dataDir: string): Promise<Check | null> {
  let found: { sandbox: boolean; reason: string | null } | null = null, running = false;
  try { const rec = JSON.parse(fs.readFileSync(sandboxFile(dataDir), 'utf8')) as SandboxRecord; if (rec && typeof rec.sandbox === 'boolean' && alive(rec.pid)) { found = rec; running = true; } } catch {}
  if (!found) found = await deps.trySandbox();
  if (!found) return null; // the browser didn't start, for a reason the browser and libraries checks cover
  const whose = running ? 'radial serve\'s browser runs' : 'The browser runs';
  if (found.sandbox) return { name: 'sandbox', ok: true, required: false, detail: `${whose} with Chrome's sandbox.` };
  return {
    name: 'sandbox', ok: false, required: false,
    detail: `${whose} without Chrome's sandbox: ${found.reason}. Page work still works, with less protection from the sites it opens.`,
    fix: /root/.test(found.reason || '') ? 'run radial serve as a user other than root' : 'allow unprivileged user namespaces (sysctl kernel.unprivileged_userns_clone=1, or on Ubuntu 23.10 and later an AppArmor profile for the browser)',
  };
}

/** How to get a missing tool: apt where there is apt, else in words. */
function installHint(tool: string, aptPackage: string): string {
  return deps.which('apt-get') ? `${browser.deps.isRoot() ? '' : 'sudo '}apt-get install -y ${aptPackage}` : `install ${tool} with this machine's package manager`;
}

/** node-pty: the agent terminals' native module, prebuilt or compiled here (nodePty.ts). */
function ptyCheck(): Check {
  const s = deps.pty();
  if (s.ok) return { name: 'node-pty', ok: true, required: false, detail: s.from === 'compiled' ? `Compiled on this machine (${s.target}).` : `Prebuilt for ${s.target}.` };
  return { name: 'node-pty', ok: false, required: false, detail: `It doesn't load on ${s.target} (${s.error}), so agent sessions can't start; everything else works.`, ...(s.fix ? { fix: s.fix } : {}) };
}

/** Fewer inotify watches per user than this is low: a site and its dev server watch every folder. */
export const INOTIFY_LOW = 65536;
/** What doctor suggests instead, as editors and dev servers do. */
const INOTIFY_SUGGESTED = 524288;
/** On Linux: how many folders one user may watch (Radial watches each folder of a site, node_modules aside, and dev servers watch more). */
function inotifyCheck(): Check | null {
  const watches = Number((deps.readFile('/proc/sys/fs/inotify/max_user_watches') || '').trim());
  if (!(watches > 0)) return null;
  if (watches >= INOTIFY_LOW) return { name: 'inotify', ok: true, required: false, detail: `${watches} file watches per user.` };
  const sudo = browser.deps.isRoot() ? '' : 'sudo ';
  return {
    name: 'inotify', ok: false, required: false, label: 'low',
    detail: `Only ${watches} file watches per user. Radial and each site's dev server watch the site's folders, and a big site runs out, so changes stop showing up.`,
    fix: `${sudo}sysctl fs.inotify.max_user_watches=${INOTIFY_SUGGESTED}, and to keep it after a restart: echo fs.inotify.max_user_watches=${INOTIFY_SUGGESTED} | ${sudo}tee /etc/sysctl.d/60-radial.conf (in a container, run both on the host)`,
  };
}

/**
 * How Claude Code is signed in for the sessions radial serve starts, as far
 * as can be told without reading a secret: an API key or token in the
 * environment, its credentials file, the macOS Keychain item, or an
 * apiKeyHelper; null when none is found. CLAUDE_CODE_ variables don't count:
 * agent terminals leave every one of them out (env.ts childEnv), so a
 * CLAUDE_CODE_OAUTH_TOKEN here never reaches a session.
 */
function claudeSignIn(): string | null {
  const env = deps.env;
  if (env.ANTHROPIC_API_KEY) return 'an API key (ANTHROPIC_API_KEY)';
  if (env.ANTHROPIC_AUTH_TOKEN) return 'a token (ANTHROPIC_AUTH_TOKEN)';
  const dir = env.CLAUDE_CONFIG_DIR || path.join(deps.home, '.claude');
  if ((deps.size(path.join(dir, '.credentials.json')) || 0) > 2) return 'a Claude account';
  if (browser.deps.platform === 'darwin' && deps.keychainHas('Claude Code-credentials')) return 'a Claude account';
  try { if ((JSON.parse(deps.readFile(path.join(dir, 'settings.json')) || '{}') as { apiKeyHelper?: unknown }).apiKeyHelper) return 'an apiKeyHelper in its settings'; } catch {}
  return null;
}
/** How Codex is signed in: an API key in the environment, or its auth.json (which kind, never what's in it); null when neither. */
function codexSignIn(): string | null {
  const env = deps.env;
  if (env.CODEX_API_KEY || env.OPENAI_API_KEY) return `an API key (${env.CODEX_API_KEY ? 'CODEX_API_KEY' : 'OPENAI_API_KEY'})`;
  const home = env.CODEX_HOME || path.join(deps.home, '.codex');
  try {
    const auth = JSON.parse(deps.readFile(path.join(home, 'auth.json')) || 'null') as { OPENAI_API_KEY?: unknown; tokens?: unknown } | null;
    if (auth && typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) return 'an API key (codex login --with-api-key)';
    if (auth && auth.tokens && typeof auth.tokens === 'object') return 'a ChatGPT account';
  } catch {}
  return null;
}
/**
 * The agent CLIs sessions run: Claude Code and Codex, each installed and
 * signed in or not. Agent sessions use whatever their CLI is signed into; an
 * unattended fleet signs them in with an API key. One that's missing is only
 * a problem when the other isn't ready either.
 */
function agentChecks(): Check[] {
  const claude = deps.which('claude') ? deps.version('claude') : null;
  const codex = deps.which('codex') ? deps.version('codex') : null;
  const claudeAuth = claude ? claudeSignIn() : null, codexAuth = codex ? codexSignIn() : null;
  const out: Check[] = [];
  if (!claude) out.push({ name: 'claude', ok: !!codexAuth, required: false, detail: `Not installed.${codexAuth ? ' Agent sessions run Codex.' : ' Agent sessions run Claude Code (or Codex, with --engine codex).'}`, ...(codexAuth ? {} : { fix: 'npm install -g @anthropic-ai/claude-code, then run claude once and sign in (or set ANTHROPIC_API_KEY)' }) });
  else if (claudeAuth) out.push({ name: 'claude', ok: true, required: false, detail: `${claude}, signed in with ${claudeAuth}.` });
  else out.push({ name: 'claude', ok: !!codexAuth, required: false, label: 'sign in', detail: `${claude}, but no sign-in found. Agent sessions use whatever it's signed into.`, ...(codexAuth ? {} : { fix: 'run claude once and sign in, or set ANTHROPIC_API_KEY for agents that run unattended' }) });
  if (!codex) out.push({ name: 'codex', ok: true, required: false, detail: 'Not installed (optional: sessions with --engine codex use it).' });
  else if (codexAuth) out.push({ name: 'codex', ok: true, required: false, detail: `${codex}, signed in with ${codexAuth}.` });
  else out.push({ name: 'codex', ok: !!claudeAuth, required: false, label: 'sign in', detail: `${codex}, but no sign-in found.`, ...(claudeAuth ? {} : { fix: 'codex login, or codex login --with-api-key for agents that run unattended' }) });
  return out;
}

/** Every check, in the order doctor prints them; dataDir is radial serve's, where a running one notes its browser's sandbox. */
export async function checks(dataDir: string = dataDirs.headlessDataDir()): Promise<Check[]> {
  const out: Check[] = [];
  const [major, minor] = deps.nodeVersion.split('.').map(Number);
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  out.push({ name: 'node', ok: nodeOk, required: true, detail: nodeOk ? deps.nodeVersion : `${deps.nodeVersion} is too old: Radial runs on Node ${MIN_NODE.join('.')} or newer.`, ...(nodeOk ? {} : { fix: `install Node ${MIN_NODE[0]} or newer` }) });
  const git = deps.gitVersion();
  out.push({ name: 'git', ok: !!git, required: true, detail: git || 'Not found. Opening, saving moments and publishing all need it.', ...(git ? {} : { fix: installHint('git', 'git') }) });
  out.push(ptyCheck());
  const ps = deps.which('ps');
  out.push({ name: 'ps', ok: !!ps, required: false, detail: ps || 'Not found. Dev servers left over from a crash aren\'t cleaned up.', ...(ps ? {} : { fix: installHint('ps', 'procps') }) });
  const lsof = deps.which('lsof');
  out.push({ name: 'lsof', ok: !!lsof, required: false, detail: lsof || 'Not found. A dev server you started yourself isn\'t picked up as the preview.', ...(lsof ? {} : { fix: installHint('lsof', 'lsof') }) });
  if (browser.deps.platform === 'linux') { const inotify = inotifyCheck(); if (inotify) out.push(inotify); }
  out.push(...agentChecks());
  const info = browser.browserInfo();
  if (!info.playwright) out.push({ name: 'browser', ok: false, required: false, detail: browser.noPlaywright() });
  else if (!info.installed) out.push({ name: 'browser', ok: false, required: false, detail: `Not installed. Screenshots, page fields and migration compares need ${info.name} ${info.version}.`, fix: 'radial browser install' });
  else {
    out.push({ name: 'browser', ok: true, required: false, detail: `${info.name} ${info.version}: ${info.executable}` });
    if (browser.deps.platform === 'linux') {
      const missing = await browser.missingLibraries();
      if (!missing) out.push({ name: 'libraries', ok: true, required: false, detail: `Couldn't check the system libraries the browser needs (apt can't simulate here). If it doesn't start: ${browser.depsCommand()}` });
      else if (missing.length) out.push({ name: 'libraries', ok: false, required: false, detail: `The browser needs ${missing.length} system ${missing.length === 1 ? 'package' : 'packages'} (libraries and fonts) this machine doesn't have.`, fix: browser.aptLine(missing) });
      else out.push({ name: 'libraries', ok: true, required: false, detail: 'Everything the browser needs is installed.' });
    }
    const sandbox = await sandboxCheck(dataDir);
    if (sandbox) out.push(sandbox);
  }
  return out;
}

/** `radial doctor [--json]` as the CLI runs it: 0, or 1 when something required is missing. done: checks already made (radial setup prints its own). */
export async function command(_positional: string[], flags: Flags, io: Pick<CliIo, 'stdout'> & Partial<Pick<CliIo, 'env'>>, done: Check[] | null = null): Promise<number> {
  const list = done || await checks(dataDirs.headlessDataDir(io.env || process.env));
  const ok = list.every((c) => c.ok || !c.required);
  if (flags.json) { io.stdout.write(JSON.stringify({ ok, checks: list }) + '\n'); return ok ? 0 : 1; }
  const lines = ['What radial serve needs on this machine:'];
  for (const c of list) {
    lines.push(`  ${(c.ok ? 'ok' : c.label || 'missing').padEnd(8)} ${c.name.padEnd(10)} ${c.detail}`);
    if (c.fix) lines.push(`  ${''.padEnd(8)} ${''.padEnd(10)} Fix: ${c.fix}`);
  }
  const missing = (required: boolean) => list.filter((c) => !c.ok && c.required === required).map((c) => NAMES[c.name] || c.name);
  const and = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]);
  lines.push(!ok ? `radial serve can't run without ${and(missing(true))}.` : missing(false).length ? `radial serve runs; it can do more with ${and(missing(false))}.` : 'Everything radial serve needs is here.');
  io.stdout.write(lines.join('\n') + '\n');
  return ok ? 0 : 1;
}
/** How the summary line names a check. */
const NAMES: Partial<Record<string, string>> = { node: `Node ${MIN_NODE.join('.')} or newer`, inotify: 'more file watches', claude: 'a signed-in Claude Code', codex: 'a signed-in Codex', browser: 'the browser', libraries: 'the browser\'s libraries', sandbox: 'the browser\'s sandbox' };
