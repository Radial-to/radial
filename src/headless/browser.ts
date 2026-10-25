/**
 * The browser `radial serve` does its page work with (plans/headless-core.md,
 * phase 3): Playwright's Chrome Headless Shell, at the build the pinned
 * playwright-core fetches, in Playwright's own cache (PLAYWRIGHT_BROWSERS_PATH
 * moves it, as for any Playwright install).
 * - browserInfo(): whether playwright-core is here, which browser it fetches,
 *   and whether that's installed;
 * - install(): `radial browser install`. It downloads the browser and nothing
 *   else, and leaves other Playwright installs' browsers alone. On Linux the
 *   browser also needs system libraries: as root it installs them with
 *   Playwright's own installer; anyone else gets the apt line to run;
 * - missingLibraries(): on Debian and Ubuntu, the packages it needs that this
 *   machine lacks, by apt's own simulation;
 * - command(): `radial browser [install]` as the CLI runs it.
 */
import fs from 'fs';
import path from 'path';
import { format } from 'util';
import { spawn } from 'child_process';
import { installRoot, isPackage } from './install';
import type { CliIo, Flags } from '../main/cli';

/** Playwright's name for the browser radial serve uses. */
export const SHELL = 'chromium-headless-shell';
/** What people call it. */
export const SHELL_NAME = 'Chrome Headless Shell';

/**
 * Why a launch with Chrome's sandbox failed for want of one, in a few words,
 * or null when it failed for another reason: Chrome refuses its sandbox as
 * root, and on Linux it needs user namespaces (which a container or a
 * hardened kernel may not give) or a setuid helper. page.ts falls back to no
 * sandbox only for these; doctor says which.
 */
export function sandboxFailure(message: string): string | null {
  if (/Running as root without --no-sandbox/i.test(message)) return 'it runs as root, where Chrome refuses its sandbox';
  if (/No usable sandbox|user namespace|move to new namespace|unprivileged_userns|apparmor/i.test(message)) return 'this machine gives it no user namespaces';
  if (/SUID sandbox|setuid sandbox|sandbox helper|chrome-sandbox/i.test(message)) return 'its sandbox helper isn\'t set up';
  return null;
}
/** browser.json in the data dir: whether radial serve's browser runs with its sandbox, and why not (doctor reads it). */
export interface SandboxRecord { sandbox: boolean; reason: string | null; pid: number; at: number }
export const sandboxFile = (dataDir: string): string => path.join(dataDir, 'browser.json');

/** One browser in Playwright's registry, as far as Radial reads it. */
export interface RegistryExecutable {
  name: string;
  directory?: string;
  browserVersion?: string;
  executablePath(): string | undefined;
}
/** Playwright's browser registry (playwright-core/lib/coreBundle): an internal of the pinned version, read through this shape only. */
export interface Registry {
  findExecutable(name: string): RegistryExecutable | undefined;
  install(executables: RegistryExecutable[], options?: { force?: boolean; gc?: boolean }): Promise<void>;
}
/** What a child process printed and how it ended. */
export interface RunResult { code: number | null; stdout: string; stderr: string; error?: string }

/** The calls deps holds: Playwright's registry and CLI, the platform, and running a command; or a test's stand-ins. */
export interface BrowserDeps {
  /** playwright-core's registry, or null when playwright-core isn't installed. */
  registry(): Registry | null;
  /** The installed playwright-core's version, or null. */
  playwrightVersion(): string | null;
  /** playwright-core's own command line (its cli.js), or null. */
  playwrightCli(): string | null;
  platform: NodeJS.Platform;
  isRoot(): boolean;
  /** Runs a command; onOutput hears its output as it comes. */
  run(command: string, args: string[], onOutput?: (text: string) => void): Promise<RunResult>;
}

const packageJson = (): string | null => { try { return require.resolve('playwright-core/package.json'); } catch { return null; } };
export const deps: BrowserDeps = {
  registry() {
    try { return (require('playwright-core/lib/coreBundle') as { registry: { registry: Registry } }).registry.registry; } catch { return null; }
  },
  playwrightVersion() { const p = packageJson(); try { return p ? (JSON.parse(fs.readFileSync(p, 'utf8')) as { version: string }).version : null; } catch { return null; } },
  playwrightCli() { const p = packageJson(); return p ? path.join(path.dirname(p), 'cli.js') : null; },
  platform: process.platform,
  isRoot: () => typeof process.getuid === 'function' && process.getuid() === 0,
  run(command, args, onOutput) {
    return new Promise((resolve) => {
      let stdout = '', stderr = '';
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); // a command that isn't there is an 'error' event
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d: string) => { stdout += d; onOutput?.(d); });
      child.stderr.on('data', (d: string) => { stderr += d; onOutput?.(d); });
      child.on('error', (e) => resolve({ code: null, stdout, stderr, error: e.message }));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  },
};

/** The browser radial serve uses: whether playwright-core is here, what it fetches, and whether that's installed. */
export interface BrowserInfo {
  /** The installed playwright-core's version; null when it isn't installed next to Radial, and nothing below is known. */
  playwright: string | null;
  name: string;
  /** The browser's version, as Playwright names it. */
  version: string | null;
  /** Where the browser is, or goes once installed. */
  dir: string | null;
  executable: string | null;
  installed: boolean;
}

export function browserInfo(): BrowserInfo {
  const registry = deps.registry();
  const exe = registry?.findExecutable(SHELL);
  const executable = (exe && exe.executablePath()) || null;
  return { playwright: registry ? deps.playwrightVersion() : null, name: SHELL_NAME, version: exe?.browserVersion || null, dir: exe?.directory || null, executable, installed: !!executable && fs.existsSync(executable) };
}

/** Why there's no browser to install: playwright-core itself is missing. */
export function noPlaywright(): string {
  // The npm package has it as an optional dependency, which npm leaves out with --omit=optional (or when it failed to install).
  if (isPackage()) return 'Radial\'s page work needs playwright-core, an optional dependency of radial-cli that isn\'t installed. Install radial-cli again with its optional dependencies (npm install -g radial-cli), then radial browser install.';
  return `Radial's page work needs playwright-core, which isn't installed next to Radial. Run npm install in ${installRoot()} (it's one of Radial's dependencies), then radial browser install.`;
}

/**
 * On Linux, the system packages the browser needs that this machine lacks:
 * Playwright's install-deps in its dry-run mode, which asks apt to simulate the
 * install. [] when nothing is missing; null when that can't be told (not Linux,
 * not Debian or Ubuntu, no apt-get, or no playwright-core).
 */
export async function missingLibraries(): Promise<string[] | null> {
  if (deps.platform !== 'linux') return null;
  const cli = deps.playwrightCli();
  if (!cli || !fs.existsSync(cli)) return null;
  const r = await deps.run(process.execPath, [cli, 'install-deps', '--dry-run', SHELL]);
  if (/All system dependencies are installed/.test(r.stdout)) return [];
  const m = r.stdout.match(/Missing system dependencies \(\d+\):\n((?:[ \t]+\S+\n?)+)/);
  return m ? m[1].split('\n').map((l) => l.trim()).filter(Boolean) : null;
}

/** The apt line that installs these packages, with sudo for anyone but root. */
export function aptLine(packages: string[]): string {
  return `${deps.isRoot() ? '' : 'sudo '}apt-get install -y --no-install-recommends ${packages.join(' ')}`;
}
/** Playwright's own installer for the browser's system libraries, for when apt can't say which are missing (it runs apt-get update first). */
export function depsCommand(): string {
  return `${deps.isRoot() ? '' : 'sudo '}${process.execPath} ${deps.playwrightCli() || 'node_modules/playwright-core/cli.js'} install-deps ${SHELL}`;
}

/**
 * What `radial browser install` answers (and prints with --json). libraries,
 * on Linux: installed (as root, just now), present (nothing was missing), or
 * unknown (apt couldn't simulate the install here; note says what to run if
 * the browser won't start).
 */
export type InstallReply =
  | { ok: true; state: 'installed' | 'already'; name: string; version: string | null; executable: string; libraries?: 'installed' | 'present' | 'unknown'; note?: string }
  | { ok: false; code: 'no-playwright' | 'failed' | 'missing-libraries'; error: string; fix?: string; missing?: string[]; executable?: string };

/**
 * Installs the browser: on Linux as root its system libraries first (when
 * apt says some are missing, or can't tell), with Playwright's own
 * installer; then the browser itself, unless it's there already. Not root on
 * Linux, it checks the libraries afterwards and answers the apt line when
 * some are missing. progress hears what the installers print.
 */
export async function install(progress: (text: string) => void = () => {}): Promise<InstallReply> {
  const registry = deps.registry();
  const exe = registry?.findExecutable(SHELL);
  if (!registry || !exe) return { ok: false, code: 'no-playwright', error: noPlaywright() };
  let libraries: 'installed' | 'present' | 'unknown' | undefined;
  let note: string | undefined;
  const unchecked = () => `Radial couldn't check the system libraries ${SHELL_NAME} needs here. If it doesn't start, run: ${depsCommand()}`;
  if (deps.platform === 'linux' && deps.isRoot()) {
    const missing = await missingLibraries();
    if (missing && !missing.length) libraries = 'present';
    else {
      progress(`Installing the libraries ${SHELL_NAME} needs (Playwright's install-deps)…\n`);
      const r = await deps.run(process.execPath, [deps.playwrightCli()!, 'install-deps', SHELL], progress); // the registry was found, so its cli.js is beside it
      if (r.code !== 0) return { ok: false, code: 'failed', error: `Installing the browser's system libraries failed${r.error ? ` (${r.error})` : ''}. Its output is above.` };
      // Checked again: Playwright's installer does nothing, and says so only in passing, on a Linux it has no package list for.
      const still = await missingLibraries();
      if (still && still.length) return { ok: false, code: 'failed', error: `Playwright's installer ran, but ${still.length} system ${still.length === 1 ? 'package is' : 'packages are'} still missing.`, fix: aptLine(still), missing: still };
      libraries = still ? 'installed' : 'unknown';
      if (!still) note = unchecked();
    }
  }
  const before = browserInfo();
  if (!before.installed) {
    // Playwright's downloader prints its progress with console.log: send it where progress goes (stderr under --json).
    const log = console.log;
    console.log = (...args: unknown[]) => progress(format(...args) + '\n');
    try { await registry.install([exe], { force: false, gc: false }); } // gc: false leaves other Playwright installs' browsers be
    catch (e) { return { ok: false, code: 'failed', error: `Downloading ${SHELL_NAME} failed: ${String((e as Error).message || e).trim().split('\n')[0]}` }; }
    finally { console.log = log; }
  }
  const after = browserInfo();
  if (!after.installed || !after.executable) return { ok: false, code: 'failed', error: `${SHELL_NAME} isn't where Playwright put it (${after.dir || 'unknown'}).` };
  if (deps.platform === 'linux' && !deps.isRoot()) {
    const missing = await missingLibraries();
    if (missing && missing.length) return { ok: false, code: 'missing-libraries', error: `${SHELL_NAME} is installed, but it needs ${missing.length} system ${missing.length === 1 ? 'package' : 'packages'} (libraries and fonts) this machine doesn't have, and installing them needs root.`, fix: aptLine(missing), missing, executable: after.executable };
    libraries = missing ? 'present' : 'unknown';
    if (!missing) note = unchecked();
  }
  return { ok: true, state: before.installed ? 'already' : 'installed', name: SHELL_NAME, version: after.version, executable: after.executable, ...(libraries ? { libraries } : {}), ...(note ? { note } : {}) };
}

/**
 * `radial browser [install]` as the CLI runs it: with no action, whether the
 * browser is installed (exit 0) or not (1); install fetches it (0, or 1 when
 * it couldn't, or the libraries it needs are missing). --json prints one object.
 */
export async function command(positional: string[], flags: Flags, io: Pick<CliIo, 'stdout' | 'stderr'>): Promise<number> {
  const json = !!flags.json;
  const action = positional[0] || null;
  if (action && action !== 'install') {
    const error = `Unknown browser command: ${action}. Use radial browser or radial browser install.`;
    if (json) io.stdout.write(JSON.stringify({ ok: false, code: 'bad-request', error }) + '\n'); else io.stderr.write(`radial: ${error}\n`);
    return 2;
  }
  if (!action) {
    const info = browserInfo();
    if (json) io.stdout.write(JSON.stringify({ ok: true, ...info }) + '\n');
    else if (!info.playwright) io.stdout.write(noPlaywright() + '\n');
    else if (info.installed) io.stdout.write(`${info.name} ${info.version} is installed: ${info.executable}\nradial serve uses it for screenshots, page fields and migration compares.\n`);
    else io.stdout.write(`No browser yet. \`radial browser install\` fetches ${info.name} ${info.version} into ${info.dir}.\n`);
    return info.installed ? 0 : 1;
  }
  const progress = (text: string) => (json ? io.stderr : io.stdout).write(text);
  const r = await install(progress);
  if (json) io.stdout.write(JSON.stringify(r) + '\n');
  else if (r.ok) io.stdout.write(`${r.state === 'already' ? `${r.name} ${r.version} was already installed` : `Installed ${r.name} ${r.version}`}: ${r.executable}\n${r.libraries === 'installed' ? 'Its system libraries are installed too.\n' : ''}${r.note ? r.note + '\n' : ''}A running radial serve uses it from its next page op.\n`);
  else io.stderr.write(`radial: ${r.error}\n${r.fix ? `  Fix: ${r.fix}\n` : ''}`);
  return r.ok ? 0 : 1;
}
