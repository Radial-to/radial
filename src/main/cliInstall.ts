// Puts the `radial` command on PATH so terminal agents (and people) can run
// `radial .` to open the current project in the app. The command itself ships
// inside the bundle (Contents/Resources/bin/radial, via build.extraResources);
// installing is just a symlink. Two candidate locations, tried in order, never
// with elevation:
//   /usr/local/bin — on PATH for every shell, but not always writable
//   ~/.local/bin   — user-owned; created if missing (the common convention)
// Best-effort by design: a failed install must never affect app boot, and a
// `radial` we didn't create — any non-symlink, or a symlink pointing outside
// a Radial bundle — is left alone.

import fs from 'fs';
import path from 'path';
import os from 'os';

/** A place `radial` may be linked into, and whether to create the folder when it's missing. */
export interface InstallDir {
  dir: string;
  create: boolean;
}

/** ensureInstalled's options. */
export interface EnsureInstalledOptions {
  dirs?: InstallDir[];
  home?: string;
}

/**
 * Where `radial` was linked, or null with why not: 'no-shim',
 * 'no-writable-location', 'foreign-file', 'foreign-link', a system error code
 * (EACCES…) or 'error'.
 */
export type InstallResult =
  | { installed: string; reason?: never }
  | { installed: null; reason: string };

/** The bundled shim, verified executable, or null (dev runs have none). */
function shimPath(resourcesPath: string | undefined): string | null {
  const p = path.join(resourcesPath || '', 'bin', 'radial');
  try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { return null; }
}

function candidates(home?: string): InstallDir[] {
  return [
    { dir: '/usr/local/bin', create: false },
    { dir: path.join(home || os.homedir(), '.local', 'bin'), create: true },
  ];
}

// A link is ours to replace only if it already points at a Radial bundle's
// shim (the app was moved or updated) or at nothing at all (dangling).
function replaceable(link: string): boolean {
  let target: string;
  try { target = fs.readlinkSync(link); } catch { return false; } // not a symlink
  if (/\.app\/Contents\/Resources\/bin\/radial$/.test(target)) return true;
  const abs = path.resolve(path.dirname(link), target);
  return !fs.existsSync(abs);
}

/**
 * Ensure a `radial` symlink on PATH points at `shim`.
 * @param shim absolute path of the bundled script (shimPath()).
 * @param [opts]
 *   dirs — candidate locations, injectable for tests (default: candidates()).
 * @returns where it was linked, or null and why not (InstallResult).
 */
function ensureInstalled(shim: string | null, opts: EnsureInstalledOptions = {}): InstallResult {
  if (!shim) return { installed: null, reason: 'no-shim' };
  const dirs = opts.dirs || candidates(opts.home);
  let reason = 'no-writable-location';
  for (const c of dirs) {
    const link = path.join(c.dir, 'radial');
    try {
      if (!fs.existsSync(c.dir)) {
        if (!c.create) continue;
        fs.mkdirSync(c.dir, { recursive: true });
      }
      let st: fs.Stats | null = null;
      try { st = fs.lstatSync(link); } catch {}
      if (st) {
        if (fs.existsSync(link) && !st.isSymbolicLink()) { reason = 'foreign-file'; continue; }
        if (st.isSymbolicLink() && fs.readlinkSync(link) === shim) return { installed: link };
        if (!replaceable(link)) { reason = 'foreign-link'; continue; }
        fs.unlinkSync(link);
      }
      fs.symlinkSync(shim, link);
      return { installed: link };
    } catch (e) {
      reason = ((e as NodeJS.ErrnoException) && (e as NodeJS.ErrnoException).code) || 'error';
    }
  }
  return { installed: null, reason };
}

export { shimPath, candidates, ensureInstalled, replaceable };
