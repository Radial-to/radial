/**
 * Tracks the dev-server processes Radial has spawned (keyed by repoDir), so that
 * after a hard crash / force-quit — where our normal teardown never runs — the
 * next launch can recognize and reap its own orphans. Also lets us tell a
 * Radial-spawned server apart from one the user started outside the app, so we
 * never kill something that isn't ours. Stored in userData, not the repo.
 */

import fs from 'fs';
import path from 'path';

/** One dev server Radial started: its pid (the process-group leader) and when it was recorded. */
export interface DevPidRecord {
  pid: number;
  at: number;
}

/** A record with the repo it belongs to, for the orphan sweep at startup. */
export interface DevPidEntry extends DevPidRecord {
  repoDir: string;
}

/** radial-devservers.json in userData. */
export type DevPidStore = Record<string, DevPidRecord>;

let filePath: string | null = null;
let store: DevPidStore = {}; // repoDir -> { pid, at }

function init(userDataDir: string): void {
  filePath = path.join(userDataDir, 'radial-devservers.json');
  try { store = (JSON.parse(fs.readFileSync(filePath, 'utf8')) as DevPidStore | null) || {}; } catch { store = {}; } // only the app writes this file
}
function save(): void { try { fs.writeFileSync(filePath!, JSON.stringify(store)); } catch {} } // filePath: set by init() before the first write; null would throw into the catch

function set(repoDir: string, pid: number | undefined): void { if (!repoDir || !pid) return; store[repoDir] = { pid, at: Date.now() }; save(); }
function get(repoDir: string): DevPidRecord | null { return (repoDir && store[repoDir]) || null; }
function clear(repoDir: string): void { if (repoDir && store[repoDir]) { delete store[repoDir]; save(); } }
// Every pid we've recorded as a dev server we started (across all open repos).
function allPids(): Set<number> { return new Set(Object.values(store).map((v) => v && v.pid).filter(Boolean)); }
// All recorded { repoDir, pid } records — for a global orphan sweep at startup.
function entries(): DevPidEntry[] { return Object.entries(store).map(([repoDir, v]) => ({ repoDir, pid: v && v.pid, at: (v && v.at) || 0 })).filter((e) => e.pid); }
function clearAll(): void { store = {}; save(); }

// A project moved on disk — keep the orphan-reaping bookkeeping accurate.
function rekey(oldDir: string, newDir: string): void {
  if (!oldDir || !newDir || !store[oldDir]) return;
  store[newDir] = store[oldDir];
  delete store[oldDir];
  save();
}

export { init, set, get, clear, allPids, entries, clearAll, rekey };
