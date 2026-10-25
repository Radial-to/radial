/**
 * Where a Radial keeps its state, and where its sockets live
 * (plans/headless-core.md, phase 2a).
 *
 * The Mac app's data dir is Electron's userData (main.ts). `radial serve`, the
 * headless core, keeps its own, so the two never share a socket:
 * - Linux and other Unixes: ~/.config/Radial ($XDG_CONFIG_HOME/Radial when set);
 * - macOS: ~/Library/Application Support/Radial Core;
 * - Windows, later: %APPDATA%\Radial.
 * RADIAL_DATA_DIR (what the CLI's --data-dir sets) and RADIAL_USERDATA (a
 * throwaway one: the tests and the smoke) override it, in that order.
 *
 * The control socket (cli.sock) and the PTY daemon's (term-daemon.sock) live in
 * the data dir, unless its path is too long for a unix socket (104 bytes on
 * macOS, 108 on Linux; a deep CI workspace can pass that). Then both live in a
 * short folder of their own, $XDG_RUNTIME_DIR/radial-<hash> or
 * /tmp/radial-<uid>-<hash>, keyed by the data dir, so every process that knows
 * the data dir finds them, and a data-dir file there names it back. The daemon
 * finds the control socket beside its own (term-daemon.ts), which holds either
 * way. Pure Node.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** The longest socket path that works everywhere: macOS's sun_path holds 104 bytes with its NUL, Linux's 108. */
export const MAX_SOCKET_PATH = 103;
/** The longest socket name in a data dir: the PTY daemon's. */
const LONGEST_SOCKET = 'term-daemon.sock';
/** In a short socket folder: the data dir it serves. */
const DATA_DIR_MARK = 'data-dir';

/** Where the machine's folders are: this process's, or a test's. */
export interface MachineDirs { platform?: NodeJS.Platform; home?: string }

/** The headless core's own data dir on this machine, before any override. */
export function defaultHeadlessDataDir(env: NodeJS.ProcessEnv = process.env, { platform = process.platform, home = os.homedir() }: MachineDirs = {}): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Radial Core');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Radial');
  const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  return path.join(config, 'Radial');
}

/** The headless core's data dir: --data-dir (RADIAL_DATA_DIR), then RADIAL_USERDATA, then the machine's default. */
export function headlessDataDir(env: NodeJS.ProcessEnv = process.env, dirs: MachineDirs = {}): string {
  if (env.RADIAL_DATA_DIR) return path.resolve(env.RADIAL_DATA_DIR);
  if (env.RADIAL_USERDATA) return env.RADIAL_USERDATA;
  return defaultHeadlessDataDir(env, dirs);
}

/** Whether a path fits in a unix socket's address, counted in bytes. */
export function fitsSocket(file: string): boolean { return Buffer.byteLength(file) <= MAX_SOCKET_PATH; }

/**
 * The folder that holds a data dir's sockets: the data dir itself, or, when its
 * socket paths would be too long, the short folder keyed by it. Only computes
 * the path; prepareSocketDir() makes the folder.
 */
export function socketDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (fitsSocket(path.join(dataDir, LONGEST_SOCKET))) return dataDir;
  const hash = crypto.createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 12);
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && path.isAbsolute(runtime) && fitsSocket(path.join(runtime, `radial-${hash}`, LONGEST_SOCKET))) return path.join(runtime, `radial-${hash}`);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  return path.join('/tmp', `radial-${uid}-${hash}`);
}

/** The control socket of a data dir (the `radial` CLI and `radial mcp` connect to it). */
export function cliSocket(dataDir: string, env: NodeJS.ProcessEnv = process.env): string { return path.join(socketDir(dataDir, env), 'cli.sock'); }
/** The PTY daemon's socket of a data dir. */
export function daemonSocket(dataDir: string, env: NodeJS.ProcessEnv = process.env): string { return path.join(socketDir(dataDir, env), LONGEST_SOCKET); }

/**
 * Makes the folder for a data dir's sockets and answers it. A short folder
 * outside the data dir must be this user's alone (mode 0700): /tmp is shared,
 * and another user who made the folder first could otherwise listen in Radial's
 * place. It refuses one that isn't, and notes the data dir in it.
 */
export function prepareSocketDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = socketDir(dataDir, env);
  if (dir === dataDir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const st = fs.lstatSync(dir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!st.isDirectory() || (uid !== null && st.uid !== uid) || (st.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not a private folder of this user, so Radial won't put its sockets there. Remove it, or choose a data dir with a shorter path.`);
  }
  fs.writeFileSync(path.join(dir, DATA_DIR_MARK), path.resolve(dataDir) + '\n', { mode: 0o600 });
  return dir;
}

/**
 * The data dir a control socket belongs to (RADIAL_CLI_SOCK, which agent
 * terminals get): the folder it sits in, or, for a short socket folder, the
 * data dir it notes.
 */
export function dataDirOfSocket(sock: string): string {
  const dir = path.dirname(sock);
  try { const named = fs.readFileSync(path.join(dir, DATA_DIR_MARK), 'utf8').trim(); if (named) return named; } catch {}
  return dir;
}
