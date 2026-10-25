/**
 * On-demand, userland tool provisioning — for machines that arrive with
 * nothing: no Homebrew, no Node, no gh, no terminal knowledge. Everything
 * installs without sudo into the user's own space (~/.local/bin for CLIs the
 * user should also have in their shell; a private tools dir for Node), so
 * someone new to all this gets running without ever opening Terminal.
 *
 * Tooled machines never pay: callers check `which()` first and skip all of
 * this. Electron-free on purpose (paths and fetch injectable) so the logic is
 * unit-testable; main.js owns IPC, progress events, and PATH registration.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { childEnv, which } from './env';
import type { IPty } from 'node-pty';
import type { OkOrError, ToolAuthResult, ToolInstallResult } from '../shared/radialApi';

/** A progress line for the window (main sends each one as tools:log). */
export type ToolLog = (line: string) => void;
/** A step that couldn't finish: a message to show (OkOrError's failure branch). */
export type ToolFailure = Extract<OkOrError, { ok: false }>;
/** The part of fetch these installs use; tests can pass a stand-in. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Pick<Response, 'ok' | 'status' | 'json' | 'arrayBuffer'>>;
export interface RunOptions { timeout?: number; env?: NodeJS.ProcessEnv; onLog?: ToolLog }
/** A finished command; `ok` is false when it failed, timed out or couldn't start. */
export interface RunResult { ok: boolean; stdout: string; stderr: string }
export interface DownloadOptions { fetchImpl?: FetchLike; timeoutMs?: number }
export interface ClaudeInstallOptions { onLog?: ToolLog; home?: string; timeout?: number }
// ClaudeInstallResult, GhInstallResult and NodeInstallResult are members of
// radialApi's ToolInstallResult: main returns them unchanged from tools:install.
export type ClaudeInstallResult = { ok: true; path: string | null } | ToolFailure;
/** The part of a cli/cli GitHub release that ghAssetUrl reads. */
export interface GhRelease { assets?: ({ name?: string; browser_download_url?: string } | null)[] }
export interface GhInstallOptions { onLog?: ToolLog; home?: string; fetchImpl?: FetchLike }
export type GhInstallResult = { ok: true; path: string } | ToolFailure;
/** What `gh auth login --web` has printed so far. */
export interface GhAuthSignals { code: string | null; url: string | null; wantsEnter: boolean; wantsReauth: boolean }
export interface GhAuthOptions {
  onCode?: (code: string, url: string) => void;
  onLog?: ToolLog;
  ghBin?: string;
  timeoutMs?: number;
}
/** What Claude Code's onboarding has printed so far (hints only; see parseClaudeAuthChunk). */
export interface ClaudeAuthSignals {
  wantsTheme: boolean;
  wantsMethod: boolean;
  wantsEnter: boolean;
  wantsPaste: boolean;
  url: string | null;
  success: boolean;
}
export interface ClaudeAuthOptions {
  onLog?: ToolLog;
  onUrl?: (url: string) => void;
  onPasteNeeded?: () => void;
  /** Whether the credential has landed (main passes agent.checkAuth). */
  authed?: () => boolean;
  claudeBin?: string;
  pollMs?: number;
  timeoutMs?: number;
}
/** radialApi's ToolAuthResult success branch: main returns claudeAuthLogin's and cltInstall's results unchanged (tools:claudeAuth, tools:gitEnsure), each with the fields it sets. */
type ToolAuthOk = Extract<ToolAuthResult, { ok: true }>;
/** A timeout still reports ok when the credential landed, with the timeout message alongside. */
export type ClaudeAuthResult = Pick<ToolAuthOk, 'ok' | 'error'> | ToolFailure;
export interface ClaudeAuthSession {
  done: Promise<ClaudeAuthResult>;
  /** Types a pasted sign-in code into the CLI. */
  write: (text: string) => void;
}
export interface CltInstallOptions { onLog?: ToolLog; pollMs?: number; timeoutMs?: number }
/** `already`: a working one was there before anything was installed. */
export type CltInstallResult = Pick<ToolAuthOk, 'ok' | 'already'> | ToolFailure;
/** One row of nodejs.org/dist/index.json (`lts` is the release line's codename, or false). */
export interface NodeDistEntry { version: string; lts: string | false }
export interface NodeInstallOptions { toolsDir?: string; onLog?: ToolLog; fetchImpl?: FetchLike }
export type NodeInstallResult = { ok: true; binDir: string; version: string } | ToolFailure;
/** Compile-time only: T must be assignable to U. */
type Fits<T extends U, U> = T;
/** What claudeInstall, ghInstall or nodeInstall return. Fits keeps it within radialApi's ToolInstallResult, the payload the window reads (a type error here means the two drifted apart). */
export type InstallResult = Fits<ClaudeInstallResult | GhInstallResult | NodeInstallResult, ToolInstallResult>;

const ARCH = 'arm64'; // Radial ships arm64-only builds; provision to match.

function run(cmd: string, args: string[], { timeout = 120000, env, onLog }: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = execFile(cmd, args, { env: childEnv(env || {}), maxBuffer: 16 * 1024 * 1024, timeout },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    if (onLog && child.stderr) child.stderr.on('data', (d: string | Buffer) => String(d).split('\n').filter(Boolean).forEach(onLog));
    if (onLog && child.stdout) child.stdout.on('data', (d: string | Buffer) => String(d).split('\n').filter(Boolean).forEach(onLog));
  });
}

/** Download url → destFile (follows redirects — GitHub assets 302 to a CDN). */
async function dl(url: string, destFile: string, { fetchImpl, timeoutMs = 300000 }: DownloadOptions = {}): Promise<{ ok: true; bytes: number }> {
  const f = fetchImpl || fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await f(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destFile, buf);
    return { ok: true, bytes: buf.length };
  } finally {
    clearTimeout(t);
  }
}

const localBin = (home?: string): string => path.join(home || os.homedir(), '.local', 'bin');

// ── Claude Code ────────────────────────────────────────────────────────────
// The official native installer: standalone binary, no Node, lands in
// ~/.local/bin (already on Radial's child PATH). We just run it headlessly.
async function claudeInstall({ onLog, home, timeout = 300000 }: ClaudeInstallOptions = {}): Promise<ClaudeInstallResult> {
  const log = onLog || (() => {});
  log('Downloading Claude Code (official installer)…');
  const env = home ? { HOME: home } : {};
  const r = await run('/bin/sh', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'], { timeout, env, onLog: log });
  const bin = path.join(localBin(home), 'claude');
  const installed = fs.existsSync(bin) || !!which('claude');
  if (!installed) {
    const tail = (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(-2).join(' ');
    return { ok: false, error: `Claude Code install didn’t finish: ${tail || 'unknown error'}` };
  }
  log('Claude Code installed.');
  return { ok: true, path: fs.existsSync(bin) ? bin : which('claude') };
}

// ── GitHub CLI ─────────────────────────────────────────────────────────────

/** Pick the macOS asset URL from a cli/cli release JSON (pure, tested). */
function ghAssetUrl(releaseJson: GhRelease | null | undefined, arch: string = ARCH): string | null {
  const assets = (releaseJson && releaseJson.assets) || [];
  const want = new RegExp(`macOS_${arch}\\.zip$`, 'i');
  const a = assets.find((x) => x && want.test(x.name || ''));
  return (a && a.browser_download_url) || null;
}

async function ghInstall({ onLog, home, fetchImpl }: GhInstallOptions = {}): Promise<GhInstallResult> {
  const log = onLog || (() => {});
  const f = fetchImpl || fetch;
  log('Finding the latest GitHub CLI…');
  const rel = await f('https://api.github.com/repos/cli/cli/releases/latest');
  if (!rel.ok) return { ok: false, error: `couldn’t reach GitHub releases (HTTP ${rel.status})` };
  const url = ghAssetUrl(await rel.json() as GhRelease);
  if (!url) return { ok: false, error: 'no macOS build found in the latest gh release' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-gh-'));
  try {
    log('Downloading the GitHub CLI…');
    await dl(url, path.join(tmp, 'gh.zip'), { fetchImpl });
    const ex = await run('/usr/bin/ditto', ['-xk', path.join(tmp, 'gh.zip'), tmp]);
    if (!ex.ok) return { ok: false, error: 'couldn’t unpack the GitHub CLI' };
    const root = fs.readdirSync(tmp).find((n) => /^gh_/.test(n));
    const src = root && path.join(tmp, root, 'bin', 'gh');
    if (!src || !fs.existsSync(src)) return { ok: false, error: 'unexpected gh archive layout' };
    const bin = localBin(home);
    fs.mkdirSync(bin, { recursive: true });
    const dest = path.join(bin, 'gh');
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
    const v = await run(dest, ['--version'], { timeout: 15000 });
    if (!v.ok) return { ok: false, error: 'gh installed but won’t run' };
    log(`GitHub CLI installed (${v.stdout.split('\n')[0].trim()}).`);
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/** Terminal-query replies a bare PTY consumer must send (pure, tested).
 *  gh's prompt library probes its terminal before rendering anything — OSC 11
 *  ("what's your background color?") and DSR ("where's the cursor?") — and
 *  waits on the answers. A real emulator replies automatically; we're the
 *  emulator here, so reply once per query or gh sits silent forever. */
function termQueryReplies(chunk: string): string {
  const s = String(chunk);
  let out = '';
  const bg = (s.match(/\x1b\]11;\?/g) || []).length;
  for (let i = 0; i < bg; i++) out += '\x1b]11;rgb:1c1c/1b1b/1a1a\x1b\\';
  const dsr = (s.match(/\x1b\[6n/g) || []).length;
  for (let i = 0; i < dsr; i++) out += '\x1b[1;1R';
  return out;
}

/** Pull the one-time device code out of `gh auth login --web` output (pure).
 *  Also spots the two questions gh can ask along the way: the Enter-to-open
 *  pause, and the re-authenticate confirm on machines that are already
 *  signed in (e.g. authed as the wrong account, or authed but not invited). */
function parseGhAuthChunk(text: string): GhAuthSignals {
  // Strip ANSI (CSI color/cursor codes + OSC sequences) first — gh colors
  // the code itself, so `code: \x1b[0;1;39m6526-9879` breaks a raw match.
  const s = String(text)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '');
  const code = (s.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i) || [])[1] || null;
  const url = (s.match(/https:\/\/github\.com\/login\/device[^\s'")]*/) || [])[0] || null;
  const wantsEnter = /press enter/i.test(s);
  const wantsReauth = /already logged in|re-?authenticate/i.test(s);
  return { code, url, wantsEnter, wantsReauth };
}

/**
 * Drive `gh auth login --web` headlessly in a PTY: parse the one-time code,
 * hand it to the caller (clipboard + browser are main's job via onCode), press
 * Enter for the user, and resolve when gh reports success. Afterwards wire
 * git to gh's credential helper so plain `git clone` of private repos works.
 */
function ghAuthLogin({ onCode, onLog, ghBin, timeoutMs = 5 * 60 * 1000 }: GhAuthOptions = {}): Promise<OkOrError> {
  const log = onLog || (() => {});
  return new Promise<OkOrError>((resolve) => {
    let pty: typeof import('node-pty');
    try { pty = require('node-pty') as typeof import('node-pty'); } catch (e) { return resolve({ ok: false, error: 'terminal engine unavailable: ' + (e as Error).message }); }
    const bin = ghBin || which('gh') || 'gh';
    let p: IPty;
    try {
      p = pty.spawn(bin, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'],
        { name: 'xterm-256color', cols: 120, rows: 30, env: childEnv({ GH_NO_UPDATE_NOTIFIER: '1' }) });
    } catch (e) { return resolve({ ok: false, error: (e as Error).message }); }
    let buf = '';
    let sentEnter = false;
    let sentReauth = false;
    let announced = false;
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ ok: false, error: 'GitHub sign-in timed out.' }); }, timeoutMs);
    p.onData((d) => {
      const replies = termQueryReplies(d);
      if (replies) p.write(replies);
      buf += d;
      const seen = parseGhAuthChunk(buf);
      // Already signed in (wrong account, or right account but not invited):
      // the caller decided a fresh sign-in is wanted — confirm it.
      if (seen.wantsReauth && !sentReauth) { sentReauth = true; p.write('y\r'); }
      if (seen.code && !announced) { announced = true; log('One-time code ready.'); if (onCode) onCode(seen.code, seen.url || 'https://github.com/login/device'); }
      // gh waits on Enter before opening the browser — we ARE the browser
      // opener (main uses openExternal), so just press it.
      if (seen.wantsEnter && !sentEnter) { sentEnter = true; p.write('\r'); }
    });
    p.onExit(async ({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0) {
        const tail = buf.split('\n').map((s) => s.trim()).filter(Boolean).slice(-2).join(' ');
        return resolve({ ok: false, error: tail.slice(-200) || 'GitHub sign-in didn’t finish.' });
      }
      // Credential helper: lets plain git (the clone!) use gh's token.
      await run(bin, ['auth', 'setup-git'], { timeout: 20000 }).catch(() => {});
      log('GitHub connected.');
      resolve({ ok: true });
    });
  });
}

// ── Claude sign-in ─────────────────────────────────────────────────────────

/** Read the signals out of Claude Code's onboarding output (pure, tested).
 *  We drive the CLI's own first-run flow rather than reimplementing OAuth:
 *  theme pick and login-method pick both take Enter (the defaults are right),
 *  the CLI opens the browser itself, and the localhost callback finishes the
 *  exchange with no typing. Text here is a HINT for prompt-driving only — the
 *  authoritative success signal is the credential landing on disk/Keychain
 *  (the caller polls `authed()`), so a reworded screen can't fake success. */
function parseClaudeAuthChunk(text: string): ClaudeAuthSignals {
  const s = String(text)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '');
  return {
    wantsTheme: /(text style|theme).*(looks best|select|choose)|(select|choose).*(text style|theme)/is.test(s),
    wantsMethod: /log ?in method|claude account|console account/i.test(s),
    wantsEnter: /press enter/i.test(s),
    wantsPaste: /paste (the )?code|authorization code/i.test(s),
    url: (s.match(/https:\/\/(?:claude\.ai|console\.anthropic\.com)\/[^\s'")\]]*oauth[^\s'")\]]*/i) || [])[0] || null,
    success: /log ?in successful|logged in as|authenticated/i.test(s),
  };
}

/**
 * Drive Claude Code's first-run sign-in headlessly in a PTY. Success is
 * `authed()` flipping true (main passes agent.checkAuth), polled every couple
 * of seconds — never the screen text. After auth we linger briefly, pressing
 * Enter through the remaining onboarding screens so the user's first real
 * agent run doesn't open on a leftover prompt, then kill the PTY.
 *
 * Returns { done, write }: `write` feeds the paste-code fallback (some
 * networks block the localhost callback and the CLI asks for the code
 * instead — onPasteNeeded tells the caller to surface an input).
 */
function claudeAuthLogin({ onLog, onUrl, onPasteNeeded, authed, claudeBin, pollMs = 2000, timeoutMs = 10 * 60 * 1000 }: ClaudeAuthOptions = {}): ClaudeAuthSession {
  const log = onLog || (() => {});
  const isAuthed = authed || (() => false);
  let p: IPty | null = null;
  const write = (text: string) => { try { if (p && text) p.write(String(text).trim() + '\r'); } catch {} };
  const done = new Promise<ClaudeAuthResult>((resolve) => {
    let pty: typeof import('node-pty');
    try { pty = require('node-pty') as typeof import('node-pty'); } catch (e) { return resolve({ ok: false, error: 'terminal engine unavailable: ' + (e as Error).message }); }
    const bin = claudeBin || which('claude') || path.join(localBin(), 'claude');
    try {
      p = pty.spawn(bin, [], { name: 'xterm-256color', cols: 120, rows: 30, cwd: os.homedir(), env: childEnv({}) });
    } catch (e) { return resolve({ ok: false, error: (e as Error).message }); }
    let buf = '';
    let settled = false;
    const sent = { theme: false, method: false, url: false, paste: false };
    let lastEnterAt = 0;
    const finish = (r: ClaudeAuthResult) => {
      if (settled) return;
      settled = true;
      clearInterval(poll); clearTimeout(timer);
      try { p!.kill(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: isAuthed(), error: 'Claude sign-in timed out.' }), timeoutMs);
    let authedAt = 0;
    const poll = setInterval(() => {
      if (!authedAt && isAuthed()) {
        authedAt = Date.now();
        log('Claude connected.');
      }
      // Linger ~6s after auth so Enter can walk the last onboarding screens.
      if (authedAt && Date.now() - authedAt > 6000) finish({ ok: true });
    }, pollMs);
    p.onData((d) => {
      const replies = termQueryReplies(d);
      if (replies) p!.write(replies);
      buf += d;
      const seen = parseClaudeAuthChunk(buf);
      if (seen.wantsTheme && !sent.theme) { sent.theme = true; p!.write('\r'); return; }
      if (seen.wantsMethod && !sent.method) { sent.method = true; p!.write('\r'); return; }
      if (seen.url && !sent.url) {
        sent.url = true;
        log('Waiting for you to approve in the browser…');
        if (onUrl) onUrl(seen.url);
      }
      if (seen.wantsPaste && !sent.paste && !isAuthed()) {
        sent.paste = true;
        if (onPasteNeeded) onPasteNeeded();
      }
      // Enter moves past "press enter to continue" screens; rate-limit so a
      // repainting TUI doesn't read as an endless stream of new prompts.
      if (parseClaudeAuthChunk(d).wantsEnter && Date.now() - lastEnterAt > 1500) {
        lastEnterAt = Date.now();
        p!.write('\r');
      }
    });
    p.onExit(() => {
      // The CLI exiting on its own is fine if the credential landed.
      if (isAuthed()) return finish({ ok: true });
      const tail = buf.split('\n').map((s) => s.trim()).filter(Boolean).slice(-2).join(' ');
      finish({ ok: false, error: (tail.slice(-200)) || 'Claude sign-in didn’t finish.' });
    });
  });
  return { done, write };
}

// ── Git (Apple command line tools) ─────────────────────────────────────────

/** A FUNCTIONAL git check. On a fresh Mac /usr/bin/git exists but is only
 *  Apple's shim — `which git` says yes while every git command dies with
 *  "invalid active developer path". Run it for real. */
async function gitWorks(): Promise<boolean> {
  const bin = which('git') || '/usr/bin/git';
  const r = await run(bin, ['--version'], { timeout: 8000 });
  return r.ok;
}

/**
 * Get a working git by triggering macOS's own Command Line Tools installer
 * (`xcode-select --install` pops the system dialog — Apple owns the download
 * and the sudo-free install), then poll until git answers. The user can
 * cancel the dialog; the timeout turns that into an honest failure instead
 * of a forever-spinner.
 */
async function cltInstall({ onLog, pollMs = 3000, timeoutMs = 20 * 60 * 1000 }: CltInstallOptions = {}): Promise<CltInstallResult> {
  const log = onLog || (() => {});
  if (await gitWorks()) return { ok: true, already: true };
  log('Asking macOS to install its command line developer tools…');
  await run('/usr/bin/xcode-select', ['--install'], { timeout: 20000 });
  log('Click Install in the macOS prompt — the download can take a few minutes.');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (await gitWorks()) { log('Git is ready.'); return { ok: true }; }
  }
  return { ok: false, error: 'The developer tools install didn’t finish. Run it again, or install git from git-scm.com.' };
}

// ── Node.js ────────────────────────────────────────────────────────────────

/** Pick the newest LTS version from nodejs.org/dist/index.json (pure). */
function nodeIndexPick(indexJson: NodeDistEntry[] | null | undefined): string | null {
  const list = Array.isArray(indexJson) ? indexJson : [];
  const lts = list.find((e) => e && e.lts); // index.json is newest-first
  return lts ? String(lts.version).replace(/^v/, '') : null;
}

/**
 * Provision Node into `toolsDir` (userData/tools) — no admin, no brew, and
 * invisible to the user's shell. main.js prepends the returned binDir to the
 * child PATH so dev servers and npm installs just work.
 */
async function nodeInstall({ toolsDir, onLog, fetchImpl }: NodeInstallOptions = {}): Promise<NodeInstallResult> {
  const log = onLog || (() => {});
  if (!toolsDir) return { ok: false, error: 'no tools dir' };
  const f = fetchImpl || fetch;
  log('Finding the current Node.js LTS…');
  const idx = await f('https://nodejs.org/dist/index.json');
  if (!idx.ok) return { ok: false, error: `couldn’t reach nodejs.org (HTTP ${idx.status})` };
  const ver = nodeIndexPick(await idx.json() as NodeDistEntry[]);
  if (!ver) return { ok: false, error: 'no LTS found in the Node index' };
  const name = `node-v${ver}-darwin-${ARCH}`;
  const url = `https://nodejs.org/dist/v${ver}/${name}.tar.gz`;
  const tarball = path.join(toolsDir, `${name}.tar.gz`);
  try {
    log(`Downloading Node.js ${ver} (~50 MB)…`);
    await dl(url, tarball, { fetchImpl });
    log('Unpacking…');
    fs.mkdirSync(toolsDir, { recursive: true });
    const ex = await run('/usr/bin/tar', ['-xzf', tarball, '-C', toolsDir], { timeout: 120000 });
    if (!ex.ok) return { ok: false, error: 'couldn’t unpack Node' };
    const binDir = path.join(toolsDir, name, 'bin');
    const v = await run(path.join(binDir, 'node'), ['-v'], { timeout: 15000 });
    if (!v.ok) return { ok: false, error: 'Node installed but won’t run' };
    // Stable pointer so PATH registration survives version bumps.
    const current = path.join(toolsDir, 'node-current');
    try { fs.rmSync(current, { force: true }); } catch {}
    try { fs.symlinkSync(path.join(toolsDir, name), current); } catch {}
    log(`Node.js ${v.stdout.trim()} ready.`);
    return { ok: true, binDir: path.join(current, 'bin'), version: ver };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    try { fs.rmSync(tarball, { force: true }); } catch {}
  }
}

export { claudeInstall, ghInstall, ghAuthLogin, nodeInstall, ghAssetUrl, nodeIndexPick, parseGhAuthChunk, termQueryReplies, dl, localBin, parseClaudeAuthChunk, claudeAuthLogin, gitWorks, cltInstall };
