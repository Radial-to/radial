#!/usr/bin/env node
// The update rehearsal: an installed Radial updates itself to a newer build
// from a feed on this Mac, the way it will from the real feed, before a release
// depends on it (plans/electron-upgrade.md, step 5).
//
//   node scripts/update-rehearsal.mts preflight [--signed]
//   node scripts/update-rehearsal.mts build --version 1.0.0-rc.1,1.0.0-rc.2 [--signed] [--no-notarize] [--serial] [--port 8765] [--dmg] [--keep-app]
//   node scripts/update-rehearsal.mts fresh-install [--from <build folder>] [--chat-tests] [--expect signed|unsigned] [--keep]
//   node scripts/update-rehearsal.mts run [--from <build folder>] [--to <build folder>] [--expect signed|unsigned] [--skip-floor] [--keep]
//   node scripts/update-rehearsal.mts clean [--builds]
//
// build: official-style apps (the updater on, no analytics key) whose update
// feed is http://127.0.0.1:<port>/, in dist-rehearsal/<version>. Unsigned
// unless --signed, which signs with the Developer ID identity in the keychain
// and notarizes with APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID
// from the environment, as scripts/official-build.mts does (it runs the same
// compile and electron-builder; only the feed, the version and the analytics key
// differ). latest-mac.yml gets minimumSystemVersion like a release's. Several
// versions build side by side (their notarization waits overlap) unless --serial.
//
// fresh-install: installs a build from its zip into a temporary Applications
// folder, checks Gatekeeper (codesign --verify --deep --strict, spctl, the
// stapled ticket), runs scripts/smoke.mts against it and, with --chat-tests,
// the release gate's packaged tests (read from scripts/release.mts).
//
// run: installs the lower version (A) from its zip, serves the higher one's
// (B's) feed, launches A isolated (RADIAL_USERDATA) and starts a stand-in agent
// (test/fixtures/native-interactive.cjs) in a turn that keeps running. Then:
//   1. floor: a feed whose latest-mac.yml says minimumSystemVersion 99.0.0, and
//      Check for Updates must answer that Radial is up to date;
//   2. update: Check for Updates finds B, electron-updater downloads it and
//      hands it to Squirrel.Mac. Signed, Squirrel stages it, the app says it's
//      ready, and Restart Now installs and relaunches it. Unsigned, Squirrel.Mac
//      refuses the update (it only installs signed ones), the app offers the
//      download instead of a Restart, and that's the expected stop; the
//      rehearsal then swaps the bundle and relaunches it
//      through LaunchServices the way Squirrel.Mac's ShipIt does, so everything
//      after the restart is still tested;
//   3. after the restart: B answers on the same profile with its version, the
//      bundled `radial` CLI works, and the agent and the terminal daemon are the
//      same processes as before.
// The relaunch comes from launchd, not from this script, so the profile reaches
// it through `launchctl setenv` from the update check until B answers (a probe
// app checks that first); it is unset again right after. Electron-updater's and
// Squirrel.Mac's caches are set aside for the run and put back afterwards.
//
// Ctrl-C undoes a run on the way out. clean undoes what a run that couldn't
// (killed, or the Mac restarted) left, from dist-rehearsal/journal.json:
// launchd variables, processes, temporary apps, the caches it set aside.
// --builds also removes dist-rehearsal.
//
// Never needs to run from a Radial terminal: it drops every RADIAL_ variable
// (and any credentials) from what the app and its CLI get.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { ElectronApplication, Page } from 'playwright-core';
import { check, withMinimumSystemVersion, MIN_DARWIN } from './releaseCheck.mts';
import {
  FEED_YML, compareVersions, controlRequest, feedPort, gateTestFiles, parseCodesign, parseSpctl, parseVersion, pickPair,
  processesMatching, readAppUpdateConfig, readFeed, rehearsalBuilds, scrubEnv, startFeedServer, writeFeed,
} from './rehearsalFeed.mts';
import type { BuildDir, FeedServer, Signature } from './rehearsalFeed.mts';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
interface Pkg { name: string; version: string; productName?: string; build: { appId: string; productName?: string } }
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Pkg;
const APP_ID = PKG.build.appId;
const PRODUCT = PKG.build.productName || PKG.productName || 'Radial';
const BUILDS = path.join(ROOT, 'dist-rehearsal');
const JOURNAL = path.join(BUILDS, 'journal.json');
/** Every temporary folder the rehearsal makes starts with this (short, so socket paths stay short). */
const WORK_PREFIX = '/tmp/radial-rehearsal-';
const LIBRARY = path.join(os.homedir(), 'Library');
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const FLOOR = '99.0.0';
const DEFAULT_PORT = 8765;
const MENU_ITEM = 'Check for Updates…';
const TASK = 'Rehearsal: keep this turn running through the update';
const MARK = 'Rehearsal: still running after the update';
const AFTER = 'Rehearsal: typed in after the update';

// ── Command line ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
const flags = new Map<string, string | true>();
for (let i = 1; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const next = argv[i + 1];
  if (next !== undefined && !next.startsWith('--')) { flags.set(argv[i].slice(2), next); i++; }
  else flags.set(argv[i].slice(2), true);
}
const str = (name: string): string | null => { const v = flags.get(name); return typeof v === 'string' ? v : null; };

// ── Reporting ────────────────────────────────────────────────────────────────

/** A check's outcome. expected: a failure the mode makes certain (an unsigned build and Gatekeeper). */
interface Outcome { name: string; ok: boolean; detail: string; seconds: number; expected?: boolean }
const outcomes: Outcome[] = [];
let lastMark = Date.now();
const startedAt = Date.now();

/** Thrown to stop a command with a plain reason (no stack). */
class Stop extends Error {}

function heading(title: string): void { console.log(`\n▸ ${title}`); lastMark = Date.now(); }
function record(name: string, ok: boolean, detail = '', opts: { expected?: boolean } = {}): boolean {
  const seconds = Math.round((Date.now() - lastMark) / 100) / 10;
  outcomes.push({ name, ok, detail, seconds, ...opts });
  const mark = opts.expected ? '•' : ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? ': ' + detail : ''} (${seconds}s)`);
  lastMark = Date.now();
  return ok;
}
function note(text: string): void { console.log(`    ${text}`); }
function summary(title: string): number {
  const failed = outcomes.filter((o) => !o.ok && !o.expected);
  const minutes = Math.round((Date.now() - startedAt) / 6000) / 10;
  console.log(`\n${failed.length ? '✗' : '✓'} ${title}: ${outcomes.length - failed.length} of ${outcomes.length} checks passed in ${minutes} min${failed.length ? '. Failed:\n  - ' + failed.map((f) => `${f.name}: ${f.detail}`).join('\n  - ') : ''}`);
  return failed.length ? 1 : 0;
}
function saveReport(kind: string, extra: Record<string, unknown>): string {
  fs.mkdirSync(BUILDS, { recursive: true });
  const file = path.join(BUILDS, `report-${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ command: argv.join(' '), startedAt: new Date(startedAt).toISOString(), outcomes, ...extra }, null, 2) + '\n');
  return file;
}

// ── Small tools ──────────────────────────────────────────────────────────────

interface Ran { status: number | null; stdout: string; stderr: string }
function sh(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number } = {}): Ran {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: (r.stderr || '') + (r.error ? r.error.message : '') };
}
const lastLine = (text: string): string => text.trim().split('\n').filter(Boolean).pop() || '';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function sleepSync(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function realpath(p: string): string { try { return fs.realpathSync(p); } catch { return p; } }

/** Polls fn until it answers something truthy; throws Stop with the label and its last answer after ms. */
async function until<T>(label: string, ms: number, fn: () => T | Promise<T>, every = 250): Promise<NonNullable<Awaited<T>>> {
  const t0 = Date.now();
  let last: unknown;
  for (;;) {
    try { const v = await fn(); if (v) return v as NonNullable<Awaited<T>>; last = v; } catch (e) { last = (e as Error).message; }
    if (Date.now() - t0 >= ms) throw new Stop(`timed out after ${Math.round(ms / 1000)}s waiting for ${label} (last: ${JSON.stringify(last)})`);
    await sleep(every);
  }
}

function plist(app: string, key: string): string | null {
  const r = sh('plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]);
  return r.status === 0 ? r.stdout.trim() : null;
}
function signature(app: string): Signature { return parseCodesign(sh('codesign', ['-dv', '--verbose=4', app]).stderr); }
function describe(sig: Signature): string {
  if (!sig.signed) return 'not signed';
  if (sig.adhoc && !sig.developerId) return 'ad-hoc signature only (no Developer ID)';
  return `${sig.authorities[0] || 'signed'}, team ${sig.teamId}, ${sig.hardenedRuntime ? 'hardened runtime' : 'NO hardened runtime'}${sig.stapled ? ', ticket stapled' : ''}`;
}
function ps(): string { return sh('ps', ['-axww', '-o', 'pid=,command=']).stdout; }
function freeBytes(dir: string): number { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); }
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** The app inside a build's zip, unpacked into `into` with ditto (which keeps the bundle's links and signature). */
function installZip(zip: string, into: string): string {
  fs.mkdirSync(into, { recursive: true });
  const r = sh('ditto', ['-x', '-k', zip, into]);
  const app = path.join(into, `${PRODUCT}.app`);
  if (r.status !== 0 || !fs.existsSync(app)) throw new Stop(`couldn't unpack ${zip}: ${lastLine(r.stderr) || 'no ' + PRODUCT + '.app inside'}`);
  return app;
}
function zipOf(build: BuildDir): string { return path.join(build.dir, readFeed(build.dir).path); }
function buildAt(dir: string): BuildDir { const abs = path.resolve(dir); return { dir: abs, version: readFeed(abs).version }; }

/** The release gate's own Gatekeeper-facing checks on an installed app. */
function gatekeeper(app: string, signed: boolean): void {
  const verify = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const assess = sh('spctl', ['--assess', '--type', 'execute', '-vv', app]);
  const verdict = parseSpctl(assess.stdout + assess.stderr);
  const staple = sh('xcrun', ['stapler', 'validate', app]);
  if (signed) {
    record('codesign --verify --deep --strict', verify.status === 0, lastLine(verify.stderr));
    record('Gatekeeper accepts it (spctl --assess)', verdict.accepted && verdict.source === 'Notarized Developer ID', `${verdict.accepted ? 'accepted' : 'rejected'}, source=${verdict.source}${verdict.origin ? ', ' + verdict.origin : ''}`);
    record('notarization ticket stapled (stapler validate)', staple.status === 0, lastLine(staple.stdout + staple.stderr));
  } else {
    const why = 'unsigned build';
    record('codesign --verify --deep --strict', false, `${why}: ${lastLine(verify.stderr)}`, { expected: true });
    record('Gatekeeper (spctl --assess)', false, `${why}: ${verdict.accepted ? 'accepted' : 'rejected'}${verdict.source ? ', source=' + verdict.source : ''}`, { expected: true });
    record('notarization ticket (stapler validate)', false, `${why}: ${lastLine(staple.stdout + staple.stderr)}`, { expected: true });
  }
}

// ── The journal: what a run changed outside its own folder, so it can be undone ──

interface Journal {
  /** Folders moved aside for the run, put back afterwards. */
  backups: { original: string; backup: string }[];
  /** Folders the run made (they didn't exist before), removed afterwards. */
  created: string[];
  /** launchd environment variables the run set, unset afterwards while they still hold its value. */
  launchctl: { name: string; value: string }[];
  /** launchd jobs the run's update created (Squirrel.Mac's ShipIt), removed afterwards. */
  jobs: string[];
  /** The run's temporary folders. */
  work: string[];
  /** App bundles LaunchServices registered during the run. */
  registered: string[];
}
const emptyJournal = (): Journal => ({ backups: [], created: [], launchctl: [], jobs: [], work: [], registered: [] });
function readJournal(): Journal {
  try { return { ...emptyJournal(), ...(JSON.parse(fs.readFileSync(JOURNAL, 'utf8')) as Partial<Journal>) }; } catch { return emptyJournal(); }
}
function writeJournal(j: Journal): void { fs.mkdirSync(BUILDS, { recursive: true }); fs.writeFileSync(JOURNAL, JSON.stringify(j, null, 2) + '\n'); }
const journalEmpty = (j: Journal) => !j.backups.length && !j.created.length && !j.launchctl.length && !j.jobs.length && !j.work.length && !j.registered.length;

/** Sets a folder aside for the run (or notes that the run will create it). */
function setAside(j: Journal, original: string): string {
  if (fs.existsSync(original)) {
    const backup = `${original}.rehearsal-backup`;
    if (fs.existsSync(backup)) throw new Stop(`${backup} is left from an earlier rehearsal: run \`node scripts/update-rehearsal.mts clean\` first`);
    fs.renameSync(original, backup);
    j.backups.push({ original, backup }); writeJournal(j);
    return 'set aside';
  }
  j.created.push(original); writeJournal(j);
  return 'not there';
}
function noteIfNew(j: Journal, p: string): void { if (!fs.existsSync(p)) { j.created.push(p); writeJournal(j); } }

function launchctlGet(name: string): string { return sh('launchctl', ['getenv', name]).stdout.trim(); }
function setLaunchdEnv(j: Journal, vars: Record<string, string>): void {
  for (const [name, value] of Object.entries(vars)) {
    j.launchctl.push({ name, value }); writeJournal(j);
    sh('launchctl', ['setenv', name, value]);
  }
}
function unsetLaunchdEnv(j: Journal): string[] {
  const undone: string[] = [];
  for (const { name, value } of j.launchctl) if (launchctlGet(name) === value) { sh('launchctl', ['unsetenv', name]); undone.push(name); }
  j.launchctl = []; writeJournal(j);
  return undone;
}

/** The rehearsal folders in /tmp, whether or not a journal remembers them. */
function workFolders(): string[] {
  try { return fs.readdirSync('/tmp').filter((n) => n.startsWith(path.basename(WORK_PREFIX))).map((n) => path.join('/tmp', n)); } catch { return []; }
}
/**
 * Ends every process whose command line runs from one of `dirs` (TERM, then
 * KILL), and looks again: an app that quits can start a new terminal daemon on
 * its way out. Answers how many it ended.
 */
function killUnder(dirs: string[]): number {
  const needles = [...new Set(dirs.flatMap((d) => [d, realpath(d)]))].map((d) => d + '/');
  const ended = new Set<number>();
  for (let round = 0; round < 4; round++) {
    const pids = processesMatching(ps(), needles).map((p) => p.pid).filter((pid) => pid !== process.pid);
    if (!pids.length) break;
    for (const pid of pids) { ended.add(pid); try { process.kill(pid, round ? 'SIGKILL' : 'SIGTERM'); } catch {} }
    for (let i = 0; i < 25 && pids.some(alive); i++) sleepSync(200);
    for (const pid of pids.filter(alive)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    sleepSync(500);
  }
  return ended.size;
}
function jobLoaded(label: string): boolean { return sh('launchctl', ['list', label]).status === 0; }

/** Undoes a journal: launchd variables, processes, registrations, folders, the caches set aside. Answers what it did. */
function undo(j: Journal): string[] {
  const did: string[] = [];
  const unset = unsetLaunchdEnv(j);
  if (unset.length) did.push(`unset ${unset.join(', ')} in launchd's environment`);
  const stray = launchctlGet('RADIAL_USERDATA');
  if (stray.startsWith(WORK_PREFIX) || stray.startsWith('/private' + WORK_PREFIX)) {
    for (const name of ['RADIAL_USERDATA', 'RADIAL_DAEMON_EPHEMERAL', 'RADIAL_CHAT_TEST_CLAUDE']) sh('launchctl', ['unsetenv', name]);
    did.push('unset a rehearsal profile left in launchd\'s environment');
  }
  const dirs = [...new Set([...j.work, ...workFolders()])];
  const killed = killUnder(dirs);
  if (killed) did.push(`ended ${killed} process(es) running from the rehearsal's folders`);
  for (const label of j.jobs) if (jobLoaded(label)) { sh('launchctl', ['remove', label]); did.push(`removed the launchd job ${label}`); }
  for (const app of j.registered) sh(LSREGISTER, ['-u', app]);
  // The person's own caches go back first: a folder that won't go must never keep them set aside.
  for (const { original, backup } of j.backups) {
    if (!fs.existsSync(backup)) continue;
    fs.rmSync(original, { recursive: true, force: true });
    fs.renameSync(backup, original);
    did.push(`put back ${original}`);
  }
  // A privileged update install (Squirrel.Mac's ShipIt as root, after an admin prompt) leaves the
  // installed app owned by root, which this user can't remove: say so and carry on.
  const remove = (d: string) => {
    try { fs.rmSync(d, { recursive: true, force: true }); did.push(`removed ${d}`); }
    catch (e) { did.push(`couldn't remove ${d} (${(e as NodeJS.ErrnoException).code || 'error'}: part of it is owned by root, as a privileged update install leaves it); \`sudo rm -rf ${d}\` removes it, and a restart clears /tmp`); }
  };
  for (const d of dirs) remove(d);
  for (const p of j.created) if (fs.existsSync(p)) remove(p);
  writeJournal(emptyJournal());
  return did;
}

/**
 * Ctrl-C (or a closed terminal) undoes the run before exiting: launchd's
 * environment, the caches set aside, the apps and their processes. Registered
 * before Playwright's own handlers, so it runs first.
 */
function undoOnSignals(): void {
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`\n✗ ${signal}: undoing what this run changed`);
    for (const line of undo(readJournal())) note(line);
    process.exit(130);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, onSignal);
}

function makeWork(kind: string, j: Journal): string {
  const dir = fs.mkdtempSync(WORK_PREFIX + kind + '-');
  j.work.push(dir); writeJournal(j);
  return dir;
}

// ── The app under test ───────────────────────────────────────────────────────

/** What the rehearsal keeps in the main process of the app it drives (instrument()). */
interface MainRecord {
  /** Squirrel.Mac's events (Electron's autoUpdater), and what the stubs saw. */
  events: { at: number; kind: string; text: string }[];
  /** The app's update dialogs, answered by the stub. */
  dialogs: { at: number; message: string; detail: string; response: number }[];
  /** Answer "is ready to install" with Restart Now (else Later). */
  restart: boolean;
}
type MainGlobal = { __rehearsal?: MainRecord };
/** The update state the window's preload answers (src/shared/radialApi.ts UpdateState). */
type WindowGlobal = { radial: { updateState(): Promise<UpdateStateNow> } };
interface UpdateStateNow { ready: boolean; version: string; refused?: { version: string; url: string } }
/** The control socket's hello (src/main/cliServer.ts HelloInfo). */
interface Hello { version: string; flavor: string; pid: number; windowReady: boolean }

interface Launched { app: ElectronApplication; win: Page; log: string[] }

async function launch(bin: string, env: Record<string, string>, logFile: string): Promise<Launched> {
  let electron: typeof import('playwright-core')._electron;
  try { electron = (require('playwright-core') as typeof import('playwright-core'))._electron; }
  catch { throw new Stop('playwright-core is not installed: run npm ci'); }
  const app = await electron.launch({ executablePath: bin, env, timeout: 60_000 });
  const log: string[] = [];
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  const take = (chunk: Buffer) => { const text = chunk.toString('utf8'); out.write(text); for (const line of text.split('\n')) if (line.trim()) log.push(line); };
  app.process().stdout?.on('data', take);
  app.process().stderr?.on('data', take);
  const win = await app.firstWindow({ timeout: 30_000 });
  return { app, win, log };
}

/** Records Squirrel.Mac's events and answers the app's dialogs (never opening a browser). */
async function instrument(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ autoUpdater, dialog, shell }) => {
    const g = globalThis as unknown as MainGlobal;
    if (g.__rehearsal) return;
    const r: MainRecord = { events: [], dialogs: [], restart: false };
    g.__rehearsal = r;
    const note = (kind: string, text = '') => { r.events.push({ at: Date.now(), kind, text }); console.log(`[rehearsal] ${kind}${text ? ': ' + text : ''}`); };
    autoUpdater.on('error', (e: Error) => note('squirrel-error', String((e && e.message) || e)));
    autoUpdater.on('checking-for-update', () => note('squirrel-checking'));
    autoUpdater.on('update-available', () => note('squirrel-available'));
    autoUpdater.on('update-not-available', () => note('squirrel-not-available'));
    autoUpdater.on('update-downloaded', () => note('squirrel-downloaded'));
    autoUpdater.on('before-quit-for-update', () => note('before-quit-for-update'));
    shell.openExternal = async (url: string) => { note('open-external', url); };
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const opts = (args.find((a) => !!a && typeof a === 'object' && 'message' in a) || { message: '' }) as { message: string; detail?: string; buttons?: string[]; cancelId?: number };
      const response = /ready to install/.test(opts.message) && r.restart ? 0 : (opts.cancelId ?? 0);
      r.dialogs.push({ at: Date.now(), message: opts.message, detail: opts.detail || '', response });
      note('dialog', `${opts.message} → ${(opts.buttons || ['OK'])[response] ?? response}`);
      return { response, checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  });
}

/** Clicks Radial ▸ Check for Updates… the way a person would (the click runs after this returns: it may quit the app). */
async function clickCheckForUpdates(app: ElectronApplication, restart: boolean): Promise<number> {
  const count = await app.evaluate((_electron, wantRestart: boolean) => {
    const r = (globalThis as unknown as MainGlobal).__rehearsal;
    if (!r) return -1;
    r.restart = wantRestart;
    return r.dialogs.length;
  }, restart);
  if (count < 0) throw new Stop('the app isn\'t instrumented');
  const clicked = await app.evaluate(({ Menu }, label: string) => {
    interface Item { label: string; submenu?: { items: Item[] } | null; click: (...args: unknown[]) => void }
    const find = (items: Item[]): Item | null => {
      for (const it of items) { if (it.label === label) return it; const sub = it.submenu ? find(it.submenu.items) : null; if (sub) return sub; }
      return null;
    };
    const menu = Menu.getApplicationMenu();
    const item = menu ? find(menu.items as unknown as Item[]) : null;
    if (!item) return false;
    setTimeout(() => item.click(), 0);
    return true;
  }, MENU_ITEM);
  if (!clicked) throw new Stop(`the app menu has no "${MENU_ITEM}" item`);
  return count;
}
async function nextDialog(app: ElectronApplication, after: number, ms: number): Promise<MainRecord['dialogs'][number]> {
  return until('the Check for Updates dialog', ms, () => app.evaluate((_electron, n: number) => (globalThis as unknown as MainGlobal).__rehearsal?.dialogs[n] || null, after));
}
async function squirrelOutcome(app: ElectronApplication): Promise<MainRecord['events'][number] | null> {
  return app.evaluate(() => (globalThis as unknown as MainGlobal).__rehearsal?.events.find((e) => e.kind === 'squirrel-downloaded' || e.kind === 'squirrel-error') || null);
}
async function updateState(win: Page): Promise<UpdateStateNow> {
  return win.evaluate(() => (globalThis as unknown as WindowGlobal).radial.updateState());
}
async function closeApp(app: ElectronApplication): Promise<void> {
  const pid = app.process().pid;
  await Promise.race([app.close().catch(() => {}), sleep(20_000)]);
  if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

async function hello(sock: string): Promise<Hello | null> {
  const r = await controlRequest(sock, { op: 'hello' }, 2000);
  return r && r.ok === true && typeof r.version === 'string' ? { version: r.version, flavor: String(r.flavor), pid: Number(r.pid), windowReady: !!r.windowReady } : null;
}

/**
 * Waits for the relaunched app to answer on the rehearsal's own control socket
 * as `version` with its window up. An app from this bundle that runs but never
 * answers there started on another profile (yours): it is ended within 30
 * seconds, and the run stops.
 */
async function waitForB(appPath: string, sock: string, version: string): Promise<Hello> {
  const mains = [...new Set([appPath, realpath(appPath)])].map((a) => path.join(a, 'Contents', 'MacOS', PRODUCT));
  const t0 = Date.now();
  let strangerSince = 0, last = 'nothing answered';
  while (Date.now() - t0 < 180_000) {
    const h = await hello(sock);
    if (h && h.version === version && h.windowReady) return h;
    if (h) last = `${h.version} answered, window ${h.windowReady ? 'up' : 'not up yet'}`;
    const apps = processesMatching(ps(), mains).filter((p) => mains.some((m) => p.command === m || p.command.startsWith(m + ' ')) && !/term-daemon|out\/main\/cli\.js/.test(p.command));
    if (apps.length && !h) {
      strangerSince ||= Date.now();
      if (Date.now() - strangerSince > 30_000) {
        for (const p of apps) { try { process.kill(p.pid, 'SIGKILL'); } catch {} }
        throw new Stop(`the relaunched app (pid ${apps.map((p) => p.pid).join(', ')}) never answered on the scratch profile, so it was ended: it may have started on your own profile`);
      }
    } else strangerSince = 0;
    await sleep(500);
  }
  const onDisk = plist(appPath, 'CFBundleShortVersionString');
  throw new Stop(`nothing answered as ${version} within 3 minutes (${last}); the bundle on disk is ${onDisk}${onDisk === version ? ': installed, but not relaunched' : ': the update was not installed'}. ShipIt's log is kept with the run's logs`);
}

/** A run of the installed app's own `radial` CLI (Contents/Resources/bin/radial) and its --json answer. */
interface CliRun { code: number; stdout: string; stderr: string; json: Record<string, unknown> | null }
function radialCli(app: string, args: string[], env: Record<string, string>, timeout = 120_000): Promise<CliRun> {
  const shim = path.join(app, 'Contents', 'Resources', 'bin', 'radial');
  return new Promise((resolve) => execFile('/bin/sh', [shim, ...args], { env, encoding: 'utf8', timeout }, (err, stdout, stderr) => {
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(String(stdout)); } catch {}
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), json });
  }));
}

/** The stand-in agent's record (test/fixtures/native-interactive.cjs writes it on every change). */
interface FixtureState { sessionId: string; pid: number; prompts: string[]; outputs: string[]; status: string; draft: string }
function fixtureState(profile: string, prompt: string): FixtureState | null {
  const dir = path.join(profile, 'native-fixture');
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.state.json')); } catch { return null; }
  for (const name of names) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as FixtureState;
      if (Array.isArray(s.prompts) && s.prompts.includes(prompt)) return s;
    } catch { /* being rewritten */ }
  }
  return null;
}
function tellFixture(profile: string, sessionId: string, cmd: Record<string, unknown>): void {
  fs.appendFileSync(path.join(profile, 'native-fixture', `${sessionId}.commands.jsonl`), JSON.stringify(cmd) + '\n');
}
function daemonPids(profile: string): number[] {
  return processesMatching(ps(), [path.join(profile, 'term-daemon.sock')]).filter((p) => /term-daemon/.test(p.command)).map((p) => p.pid);
}

/** The stand-in for Claude Code, on this Node, keeping its folders in the profile even when a relaunched app starts it. */
function writeStandIn(bin: string, profile: string): string {
  fs.mkdirSync(bin, { recursive: true });
  const wrapper = path.join(bin, 'claude');
  fs.writeFileSync(wrapper, [
    '#!/bin/sh',
    '# The update rehearsal\'s stand-in for Claude Code (scripts/update-rehearsal.mts).',
    'if [ "$1" = "--version" ]; then echo "99.0.0 (Claude Code)"; exit 0; fi',
    `: "\${RADIAL_USERDATA:=${profile}}" "\${CLAUDE_CONFIG_DIR:=${profile}/claude}" "\${CURSOR_CONFIG_DIR:=${profile}/cursor}"`,
    'export RADIAL_USERDATA CLAUDE_CONFIG_DIR CURSOR_CONFIG_DIR',
    `exec ${shQuote(process.execPath)} ${shQuote(path.join(ROOT, 'test', 'fixtures', 'native-interactive.cjs'))} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return wrapper;
}
function writeSite(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>Rehearsal</title></head><body><h1>Update rehearsal</h1></body></html>\n');
}
function plistXml(entries: Record<string, string | boolean>): string {
  const body = Object.entries(entries).map(([k, v]) => `<key>${k}</key>${typeof v === 'boolean' ? (v ? '<true/>' : '<false/>') : `<string>${v}</string>`}`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${body}\n</dict></plist>\n`;
}
/**
 * Launches a one-line app through LaunchServices, the way Squirrel.Mac relaunches
 * Radial, and reads back the environment it got: proof that `vars` (set with
 * launchctl setenv) reach a relaunched app.
 */
function probeIsolation(dir: string, vars: Record<string, string>, j: Journal): { ok: boolean; detail: string } {
  const app = path.join(dir, 'Probe.app'), out = path.join(dir, 'probe.out');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plistXml({ CFBundleExecutable: 'probe', CFBundleIdentifier: `${APP_ID}.rehearsal-probe`, CFBundleName: 'Rehearsal probe', CFBundlePackageType: 'APPL', LSBackgroundOnly: true }));
  const names = Object.keys(vars);
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'probe'), `#!/bin/sh\n{ ${names.map((n) => `printf '%s=%s\\n' ${n} "\${${n}-}"`).join('; ')}; } > ${shQuote(out)}\n`, { mode: 0o755 });
  j.registered.push(app); writeJournal(j);
  const r = sh('open', ['-n', '-W', app], { timeout: 30_000 });
  sh(LSREGISTER, ['-u', app]);
  if (r.status !== 0) return { ok: false, detail: `open couldn't launch the probe: ${lastLine(r.stderr)}` };
  let got: Record<string, string> = {};
  try { got = Object.fromEntries(fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])); } catch {}
  const wrong = names.filter((n) => got[n] !== vars[n]);
  return wrong.length ? { ok: false, detail: `a relaunched app didn't get ${wrong.join(', ')}` } : { ok: true, detail: `a LaunchServices launch gets ${names.join(', ')}` };
}

// ── preflight ────────────────────────────────────────────────────────────────

async function cmdPreflight(): Promise<number> {
  const signed = flags.has('signed');
  heading(`this Mac (${signed ? 'signed' : 'unsigned'} rehearsal)`);
  record('macOS on Apple silicon', process.platform === 'darwin' && process.arch === 'arm64', `${sh('sw_vers', ['-productVersion']).stdout.trim()} (Darwin ${os.release()}), ${process.arch}`);
  const [maj, min] = process.versions.node.split('.').map(Number);
  record('Node 22.18 or newer', maj > 22 || (maj === 22 && min >= 18), process.versions.node);
  const version = (p: string) => { try { return (JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', p, 'package.json'), 'utf8')) as { version: string }).version; } catch { return null; } };
  const tools = ['electron', 'electron-builder', 'electron-updater', 'playwright-core'].map((p) => `${p} ${version(p) ?? 'MISSING'}`);
  record('node_modules installed', !tools.some((t) => t.endsWith('MISSING')) && fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app')), tools.join(', '));
  const free = freeBytes(ROOT);
  record('free disk', free > 5e9, `${gb(free)} free (the session peaks near 2 GB: two builds being made, an update mid-install, or the dry run; 5 GB leaves room)`);
  const leftovers = Object.keys(process.env).filter((k) => /^RADIAL_(CLI_SOCK|USERDATA|DATA_DIR)$/.test(k));
  record('shell is not a Radial terminal', !leftovers.length, leftovers.length ? `${leftovers.join(', ')} set: run from Terminal, or \`unset ${leftovers.join(' ')}\` (the release dry run's smoke would otherwise reach your own Radial)` : 'no RADIAL_ variables');
  const stray = launchctlGet('RADIAL_USERDATA');
  record('launchd environment clean', !stray, stray ? `RADIAL_USERDATA=${stray} is set for every app: run clean` : 'no RADIAL_USERDATA');
  const j = readJournal();
  const backups = fs.existsSync(path.join(LIBRARY, 'Caches')) ? fs.readdirSync(path.join(LIBRARY, 'Caches')).filter((n) => n.endsWith('.rehearsal-backup')) : [];
  record('no earlier rehearsal left behind', journalEmpty(j) && !backups.length && !workFolders().length, journalEmpty(j) && !backups.length && !workFolders().length ? 'nothing to undo' : 'run `node scripts/update-rehearsal.mts clean`');
  const port = Number(str('port') || DEFAULT_PORT);
  try { const s = await startFeedServer(os.tmpdir(), { port }); await s.close(); record(`port ${port} free`, true, 'for the local feed'); }
  catch (e) { record(`port ${port} free`, false, (e as Error).message); }
  const installed = path.join('/Applications', `${PRODUCT}.app`);
  if (fs.existsSync(installed)) {
    const id = plist(installed, 'CFBundleIdentifier'), v = plist(installed, 'CFBundleShortVersionString');
    const running = processesMatching(ps(), [installed + '/Contents/MacOS/']).length > 0;
    note(`${installed} is ${id} ${v}${running ? ', running' : ''}: the rehearsal never opens it or its data. Leave it running: if a test build ever started without its scratch profile, your app's single-instance lock would turn it away.`);
  }
  if (signed) {
    heading('signing and notarizing');
    const ids = sh('security', ['find-identity', '-v', '-p', 'codesigning']).stdout.split('\n').filter((l) => /Developer ID Application:/.test(l)).map((l) => (/"([^"]+)"/.exec(l) || [])[1]).filter(Boolean);
    record('Developer ID identity in the keychain', ids.length > 0, ids.join('; ') || 'none (security find-identity -v -p codesigning)');
    const missing = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].filter((k) => !process.env[k]);
    record('notarization credentials in the environment', !missing.length, missing.length ? `missing ${missing.join(', ')} (names only checked): run with node --env-file=<.env.local>` : 'APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID set (values not read)');
    record('notarytool and stapler', sh('xcrun', ['--find', 'notarytool']).status === 0 && sh('xcrun', ['--find', 'stapler']).status === 0, 'xcrun finds both');
    record('CSC_IDENTITY_AUTO_DISCOVERY not false', process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false', process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false' ? 'it turns signing off: unset it' : 'signing can find the identity');
    const envLocal = path.join(ROOT, '.env.local');
    const hasKey = fs.existsSync(envLocal) && /^\s*(export\s+)?RADIAL_POSTHOG_KEY=\S+/m.test(fs.readFileSync(envLocal, 'utf8'));
    record('.env.local for the release dry run', hasKey, hasKey ? `${envLocal}${fs.lstatSync(envLocal).isSymbolicLink() ? ' → ' + fs.readlinkSync(envLocal) : ''} names RADIAL_POSTHOG_KEY` : `${envLocal} is missing or has no RADIAL_POSTHOG_KEY: link the shared one (ln -s <path to>/.env.local .env.local)`);
    record('gh signed in (the dry run checks the release tag)', sh('gh', ['auth', 'status', '--hostname', 'github.com']).status === 0, 'gh auth status');
  }
  const builds = rehearsalBuilds(BUILDS);
  if (builds.length) {
    heading('rehearsal builds');
    for (const b of builds) note(`${b.version}: ${b.dir}`);
  }
  return summary('preflight');
}

// ── build ────────────────────────────────────────────────────────────────────

async function cmdBuild(): Promise<number> {
  const versions = String(str('version') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!versions.length) throw new Stop('build needs --version <a>[,<b>…], e.g. --version 1.0.0-rc.1,1.0.0-rc.2');
  for (const v of versions) if (!parseVersion(v)) throw new Stop(`${v} is not a semver version`);
  const signed = flags.has('signed');
  const notarize = signed && !flags.has('no-notarize');
  const dmg = flags.has('dmg');
  const port = Number(str('port') || DEFAULT_PORT);
  const feedUrl = `http://127.0.0.1:${port}/`;
  if (signed) {
    if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') throw new Stop('CSC_IDENTITY_AUTO_DISCOVERY=false turns signing off: unset it for --signed');
    if (!/Developer ID Application:/.test(sh('security', ['find-identity', '-v', '-p', 'codesigning']).stdout)) throw new Stop('no Developer ID Application identity in the keychain');
    const missing = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].filter((k) => !process.env[k]);
    if (notarize && missing.length) throw new Stop(`notarizing needs ${missing.join(', ')} in the environment: node --env-file=<.env.local> scripts/update-rehearsal.mts build … --signed (or --no-notarize)`);
  }
  if (freeBytes(ROOT) < versions.length * 0.8e9 + 0.5e9) throw new Stop(`only ${gb(freeBytes(ROOT))} free: each build needs about 0.8 GB while it's made, and the disk must not fill`);
  const configFile = path.join(ROOT, 'src', 'main', 'official-build.json');
  if (fs.existsSync(configFile)) throw new Stop(`${configFile} exists: another official or rehearsal build is running (or one crashed; then remove it)`);
  fs.mkdirSync(BUILDS, { recursive: true });
  // What official-build writes, without the analytics key: the packaged app is
  // official (officialBuild.isOfficial), so its updater runs, and it sends nothing.
  fs.writeFileSync(configFile, JSON.stringify({ posthogKey: '', posthogHost: '' }, null, 2) + '\n');
  // Two builds run side by side unless --serial: compiling is shared, and most
  // of a signed build is Apple's notarization queue, which then overlaps.
  const parallel = versions.length > 1 && !flags.has('serial');
  const kind = signed ? (notarize ? 'signed and notarized' : 'signed, not notarized') : 'unsigned';
  try {
    heading('compile (scripts/build.mts)');
    const { buildAll } = await import('./build.mts');
    await buildAll();
    record('compiled', true, 'out/ with official-build.json');
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (!signed) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    const builder = (version: string) => {
      const out = path.join(BUILDS, version);
      fs.rmSync(out, { recursive: true, force: true });
      return { version, out, args: ['--mac', 'zip', ...(dmg ? ['dmg'] : []), '--publish', 'never',
        '-c.publish.provider=generic', `-c.publish.url=${feedUrl}`, '-c.detectUpdateChannel=false',
        `-c.extraMetadata.version=${version}`, `-c.directories.output=${out}`,
        ...(notarize ? [] : ['-c.mac.notarize=false'])] };
    };
    if (signed) note('codesign may ask to use the Developer ID key in the keychain: Always Allow');
    if (parallel) {
      // Each electron-builder rebuilds native modules (node-pty) for Electron
      // unless they already are: do it once first, so the two never compile
      // into the same folder at the same time (after a fresh npm ci).
      heading('native modules for Electron (once, before the builds run side by side)');
      const deps = await electronBuilder(['install-app-deps'], env, null);
      if (!record('native modules built for Electron', deps === 0, `electron-builder install-app-deps, exit ${deps}`)) throw new Stop('install-app-deps failed');
      heading(`${versions.join(' and ')} side by side, ${kind} (each one's output prefixed; full logs in dist-rehearsal/<version>.build.log)`);
      const runs = versions.map(builder);
      const codes = await Promise.all(runs.map((b) => electronBuilder(b.args, env, b.version)));
      runs.forEach((b, i) => record(`electron-builder ${b.version}`, codes[i] === 0, `exit ${codes[i]}`));
      if (codes.some((c) => c !== 0)) throw new Stop('electron-builder failed: see the logs in dist-rehearsal');
      for (const b of runs) { heading(`check ${b.version}`); verifyBuild(b.out, b.version, { signed, notarize, feedUrl, dmg }); }
    } else {
      for (const version of versions) {
        const b = builder(version);
        heading(`${version}: ${kind}`);
        const code = await electronBuilder(b.args, env, null);
        if (!record('electron-builder', code === 0, `exit ${code}`)) throw new Stop(`electron-builder failed for ${version}`);
        verifyBuild(b.out, version, { signed, notarize, feedUrl, dmg });
      }
    }
  } finally {
    fs.rmSync(configFile, { force: true });
    fs.rmSync(path.join(ROOT, 'out', 'main', 'official-build.json'), { force: true });
  }
  saveReport('build', { versions, signed, notarize });
  return summary(`build ${versions.join(', ')}`);
}

/**
 * Runs electron-builder (the repo's own, as official-build does) and answers its
 * exit code. With a label, its output goes to dist-rehearsal/<label>.build.log
 * and to the terminal line by line with the label in front, so two can run at once.
 */
function electronBuilder(args: string[], env: NodeJS.ProcessEnv, label: string | null): Promise<number> {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'electron-builder');
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: ROOT, env, stdio: label ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    if (label) {
      const log = fs.createWriteStream(path.join(BUILDS, `${label}.build.log`));
      const prefix = (stream: NodeJS.ReadableStream) => {
        let partial = '';
        stream.on('data', (chunk: Buffer) => {
          const text = partial + chunk.toString('utf8');
          log.write(chunk);
          const lines = text.split('\n'); partial = lines.pop() || '';
          for (const line of lines) if (line.trim()) console.log(`  [${label}] ${line}`);
        });
      };
      prefix(child.stdout!); prefix(child.stderr!);
      child.on('close', () => log.end());
    }
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code === null ? 1 : code));
  });
}

/** The checks a rehearsal build passes before it's used: the release contract, the feed it was given, its signature. */
function verifyBuild(out: string, version: string, { signed, notarize, feedUrl, dmg }: { signed: boolean; notarize: boolean; feedUrl: string; dmg: boolean }): void {
  // A release's latest-mac.yml carries minimumSystemVersion (release.mts adds it); so does the rehearsal's.
  const yml = path.join(out, FEED_YML);
  fs.writeFileSync(yml, withMinimumSystemVersion(fs.readFileSync(yml, 'utf8')));
  const feed = readFeed(out);
  const zipName = `${PRODUCT}-${version}-arm64-mac.zip`;
  record('update feed', feed.version === version && feed.path === zipName && feed.minimumSystemVersion === MIN_DARWIN, `${FEED_YML} offers ${feed.path}, minimumSystemVersion ${feed.minimumSystemVersion}`);
  const app = path.join(out, 'mac-arm64', `${PRODUCT}.app`);
  const appUpdateYml = path.join(app, 'Contents', 'Resources', 'app-update.yml');
  // The release gate's contract check, less what a rehearsal build differs in on purpose.
  const result = check({ distDir: out, version, appUpdateYml });
  const onPurpose = (p: string) => p.startsWith('app-update.yml feed is') || (!dmg && p.startsWith(`${PRODUCT}-${version}-arm64.dmg missing`));
  const problems = result.problems.filter((p) => !onPurpose(p));
  record('release contract (scripts/releaseCheck.mts)', !problems.length, problems.length ? problems.join('; ') : 'yml, zip with its framework links, blockmap, licenses in the app, `radial --version` through the app binary');
  const cfg = fs.existsSync(appUpdateYml) ? readAppUpdateConfig(fs.readFileSync(appUpdateYml, 'utf8')) : null;
  record('feed baked into the app', !!cfg && cfg.provider === 'generic' && cfg.url === feedUrl && !cfg.channel, cfg ? `${cfg.provider} ${cfg.url}${cfg.channel ? ', channel ' + cfg.channel : ''}; downloads kept in ~/Library/Caches/${cfg.updaterCacheDirName}` : 'no app-update.yml');
  const v = plist(app, 'CFBundleShortVersionString'), id = plist(app, 'CFBundleIdentifier');
  record('Info.plist', v === version && id === APP_ID, `${id} ${v}, macOS ${plist(app, 'LSMinimumSystemVersion')} or later`);
  const { listPackage } = require('@electron/asar') as { listPackage(archive: string, options?: object): string[] };
  const packaged = listPackage(path.join(app, 'Contents', 'Resources', 'app.asar')).map((f) => f.replace(/\\/g, '/'));
  record('updater on (official-build.json packaged, no analytics key)', packaged.includes('/out/main/official-build.json'), 'out/main/official-build.json');
  const sig = signature(app);
  if (signed) {
    record('signed with the Developer ID', sig.developerId && sig.hardenedRuntime && sig.identifier === APP_ID, describe(sig));
    const verify = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    record('codesign --verify --deep --strict', verify.status === 0, lastLine(verify.stderr));
    if (notarize) {
      const staple = sh('xcrun', ['stapler', 'validate', app]);
      record('notarized, ticket stapled', staple.status === 0, lastLine(staple.stdout + staple.stderr));
    }
  } else {
    record('unsigned (as asked)', !sig.developerId, describe(sig));
  }
  // Installs come from the zip; the unpacked app is ~400 MB more on disk.
  if (!flags.has('keep-app')) fs.rmSync(path.join(out, 'mac-arm64'), { recursive: true, force: true });
}

// ── fresh-install ────────────────────────────────────────────────────────────

async function cmdFreshInstall(): Promise<number> {
  const from = str('from') ? buildAt(str('from')!) : rehearsalBuilds(BUILDS)[0];
  if (!from) throw new Stop('no build to install: pass --from <build folder> (dist-rehearsal/<version>, or dist after a release dry run)');
  const j = readJournal();
  if (!journalEmpty(j)) throw new Stop('an earlier rehearsal left things to undo: run `node scripts/update-rehearsal.mts clean` first');
  undoOnSignals();
  const work = makeWork('fresh', j);
  let failed = true;
  try {
    heading(`install ${from.version} from its zip`);
    const app = installZip(zipOf(from), path.join(work, 'Applications'));
    const sig = signature(app);
    record('installed', true, `${app}: ${plist(app, 'CFBundleIdentifier')} ${plist(app, 'CFBundleShortVersionString')}, ${describe(sig)}`);
    const expect = str('expect');
    if (expect && (expect === 'signed') !== sig.developerId) record(`a ${expect} build`, false, describe(sig));
    heading('Gatekeeper');
    gatekeeper(app, sig.developerId);
    const bin = path.join(app, 'Contents', 'MacOS', PRODUCT);
    const env = { ...scrubEnv(process.env), RADIAL_APP_PATH: bin };
    heading('smoke (scripts/smoke.mts against the installed app, isolated profile)');
    const smoke = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'smoke.mts')], { cwd: ROOT, env, stdio: 'inherit' });
    record('smoke', smoke.status === 0, `exit ${smoke.status}`);
    if (flags.has('chat-tests')) {
      const files = gateTestFiles(fs.readFileSync(path.join(ROOT, 'scripts', 'release.mts'), 'utf8'));
      heading(`the release gate's packaged tests (${files.length} files from scripts/release.mts)`);
      const t = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: ROOT, env, stdio: 'inherit' });
      record('packaged chat tests', t.status === 0, `exit ${t.status}`);
    }
    failed = outcomes.some((o) => !o.ok && !o.expected);
  } finally {
    if (flags.has('keep')) note(`kept ${work} (clean removes it)`);
    else for (const line of undo(readJournal())) note(line);
  }
  saveReport('fresh-install', { build: from });
  return summary(`fresh install of ${from.version}`) || (failed ? 1 : 0);
}

// ── run ──────────────────────────────────────────────────────────────────────

async function cmdRun(): Promise<number> {
  const pair = str('from') || str('to')
    ? { from: buildAt(str('from') || rehearsalBuilds(BUILDS)[0]?.dir || '.'), to: buildAt(str('to') || rehearsalBuilds(BUILDS).at(-1)?.dir || '.') }
    : pickPair(rehearsalBuilds(BUILDS));
  if (compareVersions(pair.from.version, pair.to.version) >= 0) throw new Stop(`${pair.to.version} isn't newer than ${pair.from.version}`);
  const j = readJournal();
  if (!journalEmpty(j)) throw new Stop('an earlier rehearsal left things to undo: run `node scripts/update-rehearsal.mts clean` first');
  if (launchctlGet('RADIAL_USERDATA')) throw new Stop('RADIAL_USERDATA is set in launchd\'s environment already: run clean (or unset it) first');
  undoOnSignals();
  const work = makeWork('run', j);
  const dirs = {
    apps: path.join(work, 'Applications'), profile: path.join(work, 'profile'), site: path.join(work, 'site'), bin: path.join(work, 'bin'),
    logs: path.join(work, 'logs'), feed: path.join(work, 'feed'), floor: path.join(work, 'feed-floor'), probe: path.join(work, 'probe'),
    staging: path.join(work, 'staging'), replaced: path.join(work, 'replaced'),
  };
  for (const d of [dirs.profile, dirs.logs, dirs.probe, dirs.replaced]) fs.mkdirSync(d, { recursive: true });
  const sock = path.join(dirs.profile, 'cli.sock');
  const cliEnv = { ...scrubEnv(process.env), RADIAL_USERDATA: dirs.profile };
  let launched: Launched | null = null, server: FeedServer | null = null;
  let appPath = '', signed = false, agentId: string | null = null, bPid: number | null = null, daemonBefore: number[] = [];
  let shipItLogs = '';

  try {
    heading(`install ${pair.from.version} (A) into ${dirs.apps}`);
    appPath = installZip(zipOf(pair.from), dirs.apps);
    const sig = signature(appPath);
    signed = sig.developerId;
    record('installed A', plist(appPath, 'CFBundleShortVersionString') === pair.from.version, `${plist(appPath, 'CFBundleIdentifier')} ${plist(appPath, 'CFBundleShortVersionString')}, ${describe(sig)}`);
    const expect = str('expect');
    if (expect && (expect === 'signed') !== signed) throw new Stop(`asked for a ${expect} rehearsal, but A is ${describe(sig)}`);
    note(signed ? 'signed: the update goes all the way through Squirrel.Mac' : 'unsigned: Squirrel.Mac will refuse the update; the rehearsal then installs it the way Squirrel.Mac would');
    const cfg = readAppUpdateConfig(fs.readFileSync(path.join(appPath, 'Contents', 'Resources', 'app-update.yml'), 'utf8'));
    if (cfg.provider !== 'generic' || !cfg.url) throw new Stop(`A updates from ${cfg.provider} ${cfg.owner || ''}/${cfg.repo || ''}, not a local feed: make the builds with \`build\``);
    const port = feedPort(cfg.url);

    heading('set aside the update caches (put back afterwards)');
    const caches = [path.join(LIBRARY, 'Caches', cfg.updaterCacheDirName || `${PKG.name}-updater`), path.join(LIBRARY, 'Caches', `${APP_ID}.ShipIt`)];
    for (const c of caches) note(`${c}: ${setAside(j, c)}`);
    for (const p of [path.join(LIBRARY, 'Caches', APP_ID), path.join(LIBRARY, 'HTTPStorages', APP_ID), path.join(LIBRARY, 'HTTPStorages', `${APP_ID}.binarycookies`), path.join(LIBRARY, 'Saved Application State', `${APP_ID}.savedState`)]) noteIfNew(j, p);
    if (!jobLoaded(`${APP_ID}.ShipIt`)) { j.jobs.push(`${APP_ID}.ShipIt`); writeJournal(j); }
    record('caches set aside', true, 'electron-updater\'s and Squirrel.Mac\'s');

    heading(`feeds for ${pair.to.version} (B)`);
    const floorFeed = writeFeed(pair.to.dir, dirs.floor, { minimumSystemVersion: FLOOR });
    const realFeed = writeFeed(pair.to.dir, dirs.feed);
    server = await startFeedServer(dirs.floor, { port });
    record('feed server', true, `${server.url}: ${floorFeed.version}, first with minimumSystemVersion ${FLOOR}, then as built (${readFeed(dirs.feed).minimumSystemVersion})`);

    heading(`launch A isolated (RADIAL_USERDATA=${dirs.profile})`);
    writeSite(dirs.site);
    const standIn = writeStandIn(dirs.bin, dirs.profile);
    const isolation = { RADIAL_USERDATA: dirs.profile, RADIAL_DAEMON_EPHEMERAL: '0', RADIAL_CHAT_TEST_CLAUDE: standIn };
    const envA: Record<string, string> = {
      ...scrubEnv(process.env), ...isolation,
      PATH: `${dirs.bin}:${process.env.PATH || '/usr/bin:/bin'}`, // the stand-in is the newest `claude` this app can find
      CLAUDE_CONFIG_DIR: path.join(dirs.profile, 'claude'), RADIAL_OPEN: dirs.site,
    };
    launched = await launch(path.join(appPath, 'Contents', 'MacOS', PRODUCT), envA, path.join(dirs.logs, 'app-a.log'));
    const helloA = await until('A on its control socket', 60_000, async () => { const h = await hello(sock); return h && h.windowReady ? h : null; });
    record('A is up', helloA.version === pair.from.version && helloA.flavor === 'packaged', `${helloA.version} (${helloA.flavor}), pid ${helloA.pid}, window up`);
    await instrument(launched.app);

    heading('an agent working through the update');
    const start = await radialCli(appPath, ['agent', 'start', dirs.site, TASK, '--submit', '--label', 'Rehearsal', '--json'], cliEnv);
    agentId = start.json && typeof start.json.id === 'string' ? start.json.id : null;
    if (!record('agent started', start.code === 0 && !!agentId, agentId ? `${agentId} (${start.json!.reused ? 'the project\'s first chat' : 'a new session'})` : (start.stderr || start.stdout).trim())) throw new Stop('no agent to carry through the update');
    const before = await until('the stand-in agent to take the task', 60_000, () => fixtureState(dirs.profile, TASK));
    daemonBefore = daemonPids(dirs.profile);
    record('agent busy, daemon up', before.status === 'busy' && daemonBefore.length === 1, `stand-in pid ${before.pid} in a running turn; terminal daemon pid ${daemonBefore.join(', ') || 'none'}`);

    if (!flags.has('skip-floor')) {
      heading(`floor: B's feed with minimumSystemVersion ${FLOOR}`);
      const n = await clickCheckForUpdates(launched.app, false);
      const d = await nextDialog(launched.app, n, 120_000);
      record('Check for Updates says up to date', /up to date/i.test(d.message), `"${d.message}" ${d.detail}`);
      const line = launched.log.find((l) => /less than the minimum OS version required/.test(l));
      record('electron-updater skipped it for the macOS floor', !!line, (line || 'no "less than the minimum OS version" line in the app log').trim());
      record('nothing downloaded', !server.requests.some((r) => r.path.endsWith('.zip')), server.requests.map((r) => `${r.method} ${r.path} ${r.status}`).join(', '));
    }

    heading('the relaunch gets the same profile');
    setLaunchdEnv(j, isolation);
    const probe = probeIsolation(dirs.probe, isolation, j);
    if (!record('launchd hands the profile to a relaunched app', probe.ok, probe.detail)) throw new Stop('a relaunched app would open the real profile: stopping before anything restarts');

    heading(`update ${pair.from.version} → ${pair.to.version}`);
    server.serve(dirs.feed);
    const served = server.requests.length;
    const n = await clickCheckForUpdates(launched.app, false);
    const found = await nextDialog(launched.app, n, 120_000);
    record('Check for Updates finds B', found.message.includes(pair.to.version), `"${found.message}"`);
    const win = launched.win;
    // The app says ready only once Squirrel.Mac has staged it, and offers the download when Squirrel refuses (src/main/updater.ts).
    const settled = await until('electron-updater to download B and Squirrel.Mac to take or refuse it', 300_000, async () => { const s = await updateState(win); return s.ready || s.refused ? s : null; });
    const got = settled.ready ? settled.version : settled.refused ? settled.refused.version : '';
    const zipGet = server.requests.slice(served).find((r) => r.path === '/' + realFeed.zip && (r.status === 200 || r.status === 206));
    record('electron-updater downloads and checks it', got === pair.to.version && !!zipGet, `${got}: ${zipGet ? `${(zipGet.bytes / 1e6).toFixed(1)} MB from ${server.url}` : 'no zip request'}, sha512 matched`);
    const squirrel = await until('Squirrel.Mac to take or refuse it', 300_000, () => squirrelOutcome(launched!.app), 500);
    if (signed) {
      if (!record('Squirrel.Mac verifies and stages it', squirrel.kind === 'squirrel-downloaded', squirrel.text || squirrel.kind)) throw new Stop('Squirrel.Mac refused a signed update');
      if (!record('the app says it\'s ready to install', settled.ready && !settled.refused, settled.ready ? `Radial ${settled.version}` : 'it offers the download instead')) throw new Stop('the app didn\'t offer Restart for an update Squirrel.Mac staged');
    } else {
      record('Squirrel.Mac refuses the unsigned update (the expected stop)', squirrel.kind === 'squirrel-error', squirrel.text, { expected: squirrel.kind === 'squirrel-error' });
      if (squirrel.kind !== 'squirrel-error') throw new Stop('Squirrel.Mac took an unsigned update, which it never should');
      record('the app offers the download, not a Restart that would do nothing', !settled.ready && !!settled.refused, settled.refused ? `download at ${settled.refused.url}` : 'it says ready to install');
    }

    const aPid = launched.app.process().pid!;
    if (signed) {
      heading('Restart Now');
      await clickCheckForUpdates(launched.app, true);
      await until('A to quit for the update', 120_000, () => !alive(aPid), 250);
      const said = launched.log.find((l) => /\[rehearsal\] dialog: .*ready to install/.test(l));
      record('Restart Now quits A', true, `${(said || '').replace(/^.*\[rehearsal\] dialog: /, '')}; pid ${aPid} gone`);
      launched = null;
    } else {
      heading('install B the way Squirrel.Mac\'s ShipIt does, and relaunch it');
      await closeApp(launched.app); launched = null;
      record('A quits', !alive(aPid), `pid ${aPid} gone; the daemon and the agent keep running`);
      const staged = installZip(zipOf(pair.to), dirs.staging);
      fs.renameSync(appPath, path.join(dirs.replaced, `${PRODUCT}.app`));
      fs.renameSync(staged, appPath);
      fs.rmSync(dirs.replaced, { recursive: true, force: true });
      j.registered.push(appPath); writeJournal(j);
      const opened = sh('open', ['-n', appPath]);
      record('swapped the bundle and relaunched it through LaunchServices', opened.status === 0 && plist(appPath, 'CFBundleShortVersionString') === pair.to.version, opened.status === 0 ? `${appPath} is ${plist(appPath, 'CFBundleShortVersionString')}` : lastLine(opened.stderr));
    }

    heading(`B on the same profile`);
    let helloB: Hello | null = null;
    try {
      helloB = await waitForB(appPath, sock, pair.to.version);
    } finally {
      const unset = unsetLaunchdEnv(j);
      note(`launchd's environment restored (${unset.join(', ') || 'nothing left to unset'})`);
    }
    bPid = helloB.pid;
    if (!j.registered.includes(appPath)) { j.registered.push(appPath); writeJournal(j); }
    record(signed ? 'relaunched into B by Squirrel.Mac, on the scratch profile' : 'B is up on the scratch profile', bPid !== aPid, `${helloB.version}, pid ${bPid}, window up`);

    heading('after the restart');
    const onDisk = plist(appPath, 'CFBundleShortVersionString');
    record('the installed app is B', onDisk === pair.to.version, `${appPath} says ${onDisk}`);
    if (signed) {
      const verify = sh('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
      record('B still verifies (codesign --verify --deep --strict)', verify.status === 0, lastLine(verify.stderr));
    }
    const version = await radialCli(appPath, ['--version'], cliEnv);
    record('`radial --version`', version.stdout.trim() === pair.to.version, version.stdout.trim() || version.stderr.trim());
    const ls = await radialCli(appPath, ['ls', '--json'], cliEnv);
    const projects = ls.json && Array.isArray(ls.json.projects) ? (ls.json.projects as { repoDir: string }[]) : [];
    record('`radial ls` reaches B', ls.code === 0 && projects.some((p) => realpath(p.repoDir) === realpath(dirs.site)), projects.map((p) => p.repoDir).join(', ') || (ls.stderr || ls.stdout).trim());
    const daemonAfter = daemonPids(dirs.profile);
    record('the terminal daemon survived', daemonAfter.length === 1 && daemonAfter[0] === daemonBefore[0], `pid ${daemonBefore.join(', ')} before, ${daemonAfter.join(', ') || 'none'} after`);
    const list = await radialCli(appPath, ['agent', 'list', '--json'], cliEnv);
    const rows = list.json && Array.isArray(list.json.agents) ? (list.json.agents as { id: string; alive: boolean; state?: string }[]) : [];
    const row = rows.find((r) => r.id === agentId);
    record('`radial agent list` shows the agent alive', !!row && row.alive, row ? `${row.id} ${row.state || ''}` : `${agentId} not among ${rows.map((r) => r.id).join(', ') || 'no agents'}`);
    const now = fixtureState(dirs.profile, TASK);
    record('the agent is the same process', !!now && now.pid === before.pid && alive(before.pid), `stand-in pid ${before.pid} ${alive(before.pid) ? 'still running' : 'gone'}`);
    tellFixture(dirs.profile, before.sessionId, { type: 'output', text: MARK });
    const printed = await until('the agent to print on request', 15_000, () => fixtureState(dirs.profile, TASK)?.outputs.includes(MARK)).catch(() => false);
    record('the agent still runs', !!printed, printed ? 'it printed what it was asked to' : 'it printed nothing');
    tellFixture(dirs.profile, before.sessionId, { type: 'finish' });
    await until('the agent to finish its turn', 15_000, () => fixtureState(dirs.profile, TASK)?.status === 'idle').catch(() => false);
    const send = await radialCli(appPath, ['agent', 'send', agentId!, AFTER, '--json'], cliEnv);
    const typed = await until('the typed prompt to reach the agent', 30_000, () => fixtureState(dirs.profile, TASK)?.prompts.includes(AFTER)).catch(() => false);
    record('B types into the surviving agent (`radial agent send`)', send.code === 0 && !!typed, typed ? 'the agent got the prompt' : (send.stderr || send.stdout).trim() || 'the prompt never arrived');
  } catch (e) {
    if (e instanceof Stop) record('stopped', false, e.message);
    else record('crashed', false, (e as Error).stack || String(e));
  } finally {
    heading('clean up');
    const shipIt = path.join(LIBRARY, 'Caches', `${APP_ID}.ShipIt`);
    for (const name of ['ShipIt_stderr.log', 'ShipIt_stdout.log']) {
      try { fs.copyFileSync(path.join(shipIt, name), path.join(dirs.logs, name)); shipItLogs = path.join(dirs.logs, name); } catch {}
    }
    if (bPid && agentId && alive(bPid)) await radialCli(appPath, ['agent', 'kill', agentId, '--yes', '--json'], cliEnv, 30_000);
    if (launched) await closeApp(launched.app);
    if (bPid && alive(bPid)) {
      try { process.kill(bPid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 80 && alive(bPid); i++) await sleep(250);
      if (alive(bPid)) { try { process.kill(bPid, 'SIGKILL'); } catch {} }
    }
    for (const pid of daemonPids(dirs.profile)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    // The stand-in runs this Node from the repo, so killUnder can't find it by the work folder.
    const standIn = fixtureState(dirs.profile, TASK);
    if (standIn && alive(standIn.pid)) { try { process.kill(standIn.pid, 'SIGTERM'); } catch {} }
    if (server) await server.close();
    // The app's log and ShipIt's are small and the record of what happened: always kept.
    const keep = path.join(BUILDS, 'logs', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(keep, { recursive: true });
    for (const name of fs.existsSync(dirs.logs) ? fs.readdirSync(dirs.logs) : []) fs.copyFileSync(path.join(dirs.logs, name), path.join(keep, name));
    note(`logs kept in ${keep}`);
    if (flags.has('keep')) note(`kept ${work}; \`clean\` removes it and puts the caches back`);
    else for (const line of undo(readJournal())) note(line);
    if (shipItLogs) note(`ShipIt's log was copied before the cleanup (${path.basename(shipItLogs)})`);
  }
  const report = saveReport('run', { from: pair.from, to: pair.to, signed, requests: server ? server.requests : [] });
  note(`report: ${report}`);
  return summary(`update rehearsal ${pair.from.version} → ${pair.to.version} (${signed ? 'signed' : 'unsigned'})`);
}

// ── clean ────────────────────────────────────────────────────────────────────

function cmdClean(): number {
  heading('undo what rehearsals left');
  const did = undo(readJournal());
  for (const name of fs.existsSync(path.join(LIBRARY, 'Caches')) ? fs.readdirSync(path.join(LIBRARY, 'Caches')) : []) {
    if (!name.endsWith('.rehearsal-backup')) continue;
    const backup = path.join(LIBRARY, 'Caches', name), original = backup.slice(0, -'.rehearsal-backup'.length);
    fs.rmSync(original, { recursive: true, force: true });
    fs.renameSync(backup, original);
    did.push(`put back ${original}`);
  }
  // A rehearsal build killed mid-way leaves its official config (no analytics key) behind.
  const configFile = path.join(ROOT, 'src', 'main', 'official-build.json');
  try {
    if ((JSON.parse(fs.readFileSync(configFile, 'utf8')) as { posthogKey?: string }).posthogKey === '') {
      fs.rmSync(configFile, { force: true });
      fs.rmSync(path.join(ROOT, 'out', 'main', 'official-build.json'), { force: true });
      did.push(`removed a rehearsal build's ${path.relative(ROOT, configFile)}`);
    }
  } catch { /* none, or a real official build's: not ours to touch */ }
  for (const line of did) note(line);
  record('cleaned', true, did.length ? `${did.length} thing(s) undone` : 'nothing was left');
  if (flags.has('builds')) { fs.rmSync(BUILDS, { recursive: true, force: true }); record('removed the builds', true, BUILDS); }
  return summary('clean');
}

function help(): number {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1).filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n').split('\nNever needs')[0]);
  return command === 'help' ? 0 : 2;
}

// ── main ─────────────────────────────────────────────────────────────────────

const commands: Record<string, () => Promise<number> | number> = { preflight: cmdPreflight, build: cmdBuild, 'fresh-install': cmdFreshInstall, run: cmdRun, clean: cmdClean, help };
const run = commands[command] || help;
try {
  process.exitCode = await run();
} catch (e) {
  // A Stop, or a plain Error (rehearsalFeed's checks of a build folder, a file
  // that isn't there), is a reason to print; anything else is a bug, with its stack.
  if (e instanceof Stop || (e instanceof Error && e.constructor === Error)) { console.error(`\n✗ ${(e as Error).message}`); process.exitCode = 1; }
  else throw e;
}
