/**
 * node-pty, the native module the PTY daemon runs agent terminals with
 * (term-daemon.ts), on this machine (plans/headless-core.md, phase 5).
 *
 * node-pty loads the first binary it finds: build/Release (compiled on this
 * machine), then prebuilds/<platform>-<arch>. Its own releases carry
 * prebuilt binaries for macOS and Windows only; the radial-cli package adds
 * Linux x64 and arm64 ones built against glibc 2.28 (scripts/pty-prebuild.mts),
 * which load with no install script at all.
 *
 * Install scripts are where npm versions differ. npm 11 and older run a
 * bundled dependency's: node-pty's compiles (node-gyp: python3, make and a C++
 * compiler) when it has no prebuilds folder for the platform and
 * architecture, and it can't tell glibc from musl (on Alpine it keeps the
 * glibc binary, which crashes on its first pty). npm 12 never runs a bundled
 * dependency's scripts, and runs a package's own only when allowed
 * (--allow-scripts=radial-cli). So radial-cli's own postinstall does the
 * compile itself when it's needed (npm 12's advice: forward the bundled
 * dependency's script as one of your own).
 * - status(): whether node-pty loads here and starts a shell, and which binary;
 * - ensure(): radial-cli's postinstall. When node-pty doesn't load, it
 *   compiles it here. It never fails the install: what's missing is printed,
 *   `radial doctor` says it again, and radial serve runs meanwhile (only
 *   agent sessions need node-pty);
 * - fix(): what to run when it doesn't load, for doctor and ensure().
 * `node out/headless/nodePty.js install` runs ensure() (the package's postinstall).
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { installRoot, isPackage } from './install';

/** Which C library a Linux machine runs on: glibc, musl, or null where it doesn't apply or can't be told. */
export type Libc = 'glibc' | 'musl' | null;

/** The calls deps holds: where node-pty is, the machine, and running things; or a test's stand-ins. */
export interface PtyDeps {
  /** node-pty's folder (where its package.json is), or null when it isn't installed. */
  root(): string | null;
  platform: NodeJS.Platform;
  arch: string;
  libc(): Libc;
  exists(file: string): boolean;
  /**
   * Loads node-pty in a fresh Node from its folder and starts a shell on a
   * pty: null when that works, else the error, in a line.
   */
  tryLoad(root: string): string | null;
  /** node-gyp rebuild in node-pty's folder, its output going to onOutput: whether it built, and why not. */
  compile(root: string, onOutput: (text: string) => void): { ok: boolean; error?: string };
  /** Gives the macOS spawn-helpers their execute bit back (node-pty 1.1's prebuilds ship without it). */
  fixHelpers(root: string): void;
  /** Whether apt-get is on PATH, for the fix. */
  hasApt(): boolean;
  isRoot(): boolean;
}

/** A command's full path on PATH, or null. */
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return null;
}

/**
 * The line that says what went wrong, from a child's output: a missing build
 * tool first (node-gyp names it), then an error's own message (Node prints the
 * throwing source line above it), then any line that sounds like an error.
 */
export function firstError(text: string): string {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /find Python|Python is not set|not found: (make|g\+\+|c\+\+|cc)\b|make: not found|g\+\+: not found|No such file or directory.*(make|g\+\+)/i.test(l))
    || lines.find((l) => /^[A-Za-z]*Error: /.test(l))
    || lines.find((l) => !/^(at |throw |\^)/.test(l) && /Error|error:|cannot|not found|failed/i.test(l)) || lines[0] || 'it did not load';
  return line.replace(/^Error:\s*/, '').slice(0, 400);
}

/**
 * node-gyp, the way npm runs it: npm sets npm_config_node_gyp for install
 * scripts; outside one, a node-gyp on PATH, or the one in Node's own npm.
 */
function nodeGyp(): { command: string; args: string[] } | null {
  const fromNpm = process.env.npm_config_node_gyp;
  if (fromNpm && fs.existsSync(fromNpm)) return { command: process.execPath, args: [fromNpm] };
  const bin = onPath('node-gyp');
  if (bin) return { command: bin, args: [] };
  const bundled = path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  return fs.existsSync(bundled) ? { command: process.execPath, args: [bundled] } : null;
}

export const deps: PtyDeps = {
  root() { try { return path.dirname(require.resolve('node-pty/package.json')); } catch { return null; } },
  platform: process.platform,
  arch: process.arch,
  libc() {
    if (process.platform !== 'linux') return null;
    try {
      const report = process.report as unknown as { excludeNetwork?: boolean; getReport(): { header?: { glibcVersionRuntime?: string } } };
      report.excludeNetwork = true;
      if (report.getReport().header?.glibcVersionRuntime) return 'glibc';
    } catch {}
    try { if (fs.readdirSync('/lib').some((f) => f.startsWith('ld-musl-'))) return 'musl'; } catch {}
    return null;
  },
  exists: (file) => fs.existsSync(file),
  tryLoad(root) {
    // A shell on a pty, not just the require: on macOS the spawn-helper's execute bit matters too.
    const script = `const pty = require(${JSON.stringify(root)}); const p = pty.spawn('/bin/sh', ['-c', 'exit 0'], { name: 'xterm', cols: 80, rows: 24 }); p.onExit(() => process.exit(0)); setTimeout(() => { console.error('Error: the shell on a pty never exited'); process.exit(3); }, 10000);`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000, cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    if (r.status === 0) return null;
    // A binary for another C library can load and then crash on its first pty (glibc's on musl does): no message, just the signal.
    if (r.signal && !String(r.stderr || '').trim()) return `it crashed (${r.signal}) starting a shell, as a binary built for another C library does`;
    return firstError(`${r.stderr || ''}\n${r.error ? r.error.message : ''}`);
  },
  compile(root, onOutput) {
    const gyp = nodeGyp();
    if (!gyp) return { ok: false, error: 'node-gyp is not here (it comes with npm)' };
    // Node's own headers when this Node carries them (the official tarballs and images do), so nothing is downloaded for them.
    const prefix = path.dirname(path.dirname(process.execPath));
    const env = { ...process.env, ...(!process.env.npm_config_nodedir && fs.existsSync(path.join(prefix, 'include', 'node', 'node_api.h')) ? { npm_config_nodedir: prefix } : {}) };
    const r = spawnSync(gyp.command, [...gyp.args, 'rebuild'], { cwd: root, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 });
    onOutput(`${r.stdout || ''}${r.stderr || ''}`);
    if (r.status === 0) return { ok: true };
    return { ok: false, error: r.error ? r.error.message : firstError(r.stderr || r.stdout || '') };
  },
  fixHelpers(root) {
    const files = [path.join(root, 'build', 'Release', 'spawn-helper')];
    try { for (const d of fs.readdirSync(path.join(root, 'prebuilds'))) if (d.startsWith('darwin')) files.push(path.join(root, 'prebuilds', d, 'spawn-helper')); } catch {}
    for (const f of files) { try { const mode = fs.statSync(f).mode; if ((mode & 0o111) !== 0o111) fs.chmodSync(f, mode | 0o755); } catch {} }
  },
  hasApt: () => !!onPath('apt-get'),
  isRoot: () => typeof process.getuid === 'function' && process.getuid() === 0,
};

/** Whether node-pty loads here, which binary it loads, and why not when it doesn't. */
export interface PtyStatus {
  ok: boolean;
  /** compiled: build/Release, made on this machine (node-pty tries it first); prebuilt: prebuilds/<platform>-<arch>. Null when none loads. */
  from: 'compiled' | 'prebuilt' | null;
  /** The platform and architecture, with the C library on Linux: linux-x64 (glibc). */
  target: string;
  /** node-pty's folder; null when it isn't installed. */
  root: string | null;
  /** Why it doesn't load. */
  error?: string;
  /** What to run when it doesn't load (fix()). */
  fix?: string;
}

/** linux-x64 (glibc), darwin-arm64. */
function target(): string {
  const libc = deps.libc();
  return `${deps.platform}-${deps.arch}${libc ? ` (${libc})` : ''}`;
}

/** Whether node-pty loads here and starts a shell, and from which binary. */
export function status(): PtyStatus {
  const root = deps.root();
  if (!root) return { ok: false, from: null, target: target(), root: null, error: 'node-pty is not installed next to Radial', fix: isPackage() ? 'npm install -g radial-cli' : `npm install (in ${installRoot()})` };
  const error = deps.tryLoad(root);
  if (error) return { ok: false, from: null, target: target(), root, error, fix: fix() };
  const compiled = deps.exists(path.join(root, 'build', 'Release', 'pty.node'));
  return { ok: true, from: compiled ? 'compiled' : 'prebuilt', target: target(), root };
}

/**
 * npm rebuild for this install: the package's (with the prefix it's in, when
 * that isn't npm's default one), which runs its postinstall, allowed for
 * npm 12 (older npm runs it anyway); or node-pty's in a checkout.
 */
export function rebuildCommand(root: string = installRoot()): string {
  if (!isPackage(root)) return `npm rebuild node-pty (in ${root})`;
  const m = /^(.*)[\\/]lib[\\/]node_modules[\\/]radial-cli$/.exec(root) || /^(.*)[\\/]node_modules[\\/]radial-cli$/.exec(root);
  const prefix = m ? m[1] : null;
  const defaultPrefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX || path.dirname(path.dirname(process.execPath));
  return `npm rebuild -g radial-cli --allow-scripts=radial-cli${prefix && path.resolve(prefix) !== path.resolve(defaultPrefix) ? ` --prefix ${prefix}` : ''}`;
}

/** What to run when node-pty doesn't load: the build tools where it compiles, then npm rebuild. */
export function fix(): string {
  if (deps.platform === 'linux') {
    const tools = deps.hasApt() ? `${deps.isRoot() ? '' : 'sudo '}apt-get install -y python3 make g++` : 'install python3, make and a C++ compiler (g++) with this machine\'s package manager';
    return `${tools}, then ${rebuildCommand()}`;
  }
  if (deps.platform === 'darwin') return `xcode-select --install (Apple's command line tools), then ${rebuildCommand()}`;
  return rebuildCommand();
}

/**
 * radial-cli's postinstall: makes sure node-pty loads, compiling it here
 * when its binary doesn't (no prebuilt one for this machine, or a glibc one
 * on musl). Never throws and never fails the install: log hears what
 * happened, and what to run when it still doesn't load.
 */
export function ensure(log: (line: string) => void = (line) => process.stderr.write(line + '\n'), output: (text: string) => void = (text) => process.stderr.write(text)): PtyStatus {
  const root = deps.root();
  if (!root) { log('radial: node-pty is not installed, so agent sessions can\'t start. Reinstall radial-cli.'); return status(); }
  if (deps.platform === 'darwin') deps.fixHelpers(root);
  let s = status();
  if (s.ok) { log(`radial: agent terminals use node-pty's ${s.from === 'compiled' ? 'binary compiled on this machine' : `prebuilt binary for ${s.target}`}.`); return s; }
  if (deps.platform === 'win32') { log(`radial: node-pty doesn't load here (${s.error}). Radial without a window runs on macOS and Linux.`); return s; }
  log(`radial: node-pty's binary doesn't load on ${s.target} (${s.error}). Compiling it for this machine (node-gyp)…`);
  const built = deps.compile(root, output);
  if (built.ok) { if (deps.platform === 'darwin') deps.fixHelpers(root); s = status(); }
  if (s.ok) { log('radial: compiled node-pty for this machine; agent terminals use it.'); return s; }
  log(`radial: node-pty couldn't be compiled here (${built.ok ? s.error : built.error}), so agent sessions can't start until it is; everything else in Radial works. To fix it: ${fix()}.`);
  return s;
}

if (require.main === module) {
  const action = process.argv[2];
  if (action === 'install') { ensure(); process.exit(0); } // never fails the install: doctor says what's missing
  const s = status();
  process.stdout.write(JSON.stringify(s) + '\n');
  process.exit(s.ok ? 0 : 1);
}
