/**
 * Persisted launcher state: recently opened projects and an optional "projects
 * folder" to scan for available website projects. Stored as JSON in the app's
 * userData directory so it survives restarts.
 */

import fs from 'fs';
import path from 'path';

/** How a recent project was opened; every entry so far is a local folder. */
export type RecentKind = 'local';

/** One row of the Home screen's recent projects, newest first. */
export interface RecentProject {
  path: string;
  name: string;
  kind: RecentKind;
  lastOpened: number;
  /** The site's favicon as a data URL, cached once the project has loaded. */
  favicon: string | null;
}

/** The projects open at quit, reopened on the next launch. */
export interface OpenSession {
  open: string[];
  active: string | null;
}

/** radial-store.json, the launcher's persisted state. */
export interface RecentsStore {
  recents: RecentProject[];
  projectsDir: string | null;
  session?: OpenSession;
  /** False while the app runs, true after a graceful quit. */
  cleanExit?: boolean;
  /** The folder the last pick of migration files came from, where that picker opens next. */
  filesDir?: string | null;
}

/** A folder in the projects folder that looks like a website. */
export interface AvailableProject {
  path: string;
  name: string;
}

/** What the Home screen lists. */
export interface RecentsSnapshot {
  recents: RecentProject[];
  projectsDir: string | null;
  available: AvailableProject[];
}

let filePath: string | null = null;
let store: RecentsStore = { recents: [], projectsDir: null };
let firstRun = false; // no store file at init = a brand-new install
let crashedLast = false; // the run before this one never reached markCleanExit (read at init, before markRunning)

function init(userDataDir: string): void {
  filePath = path.join(userDataDir, 'radial-store.json');
  firstRun = !fs.existsSync(filePath);
  try { store = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { store = { recents: [], projectsDir: null }; }
  store.recents = store.recents || [];
  store.projectsDir = store.projectsDir || null;
  crashedLast = store.cleanExit === false;
}

function isFirstRun(): boolean { return firstRun; }

function save(): void {
  // filePath is null before init(): the `!` is knowingly loose, the catch swallows that write's TypeError.
  try { fs.writeFileSync(filePath!, JSON.stringify(store, null, 2)); } catch {}
}

function addRecent(repoPath: string, name: string, kind: RecentKind = 'local'): void {
  const prev = store.recents.find((r) => r.path === repoPath);
  store.recents = store.recents.filter((r) => r.path !== repoPath);
  // Carry a previously-cached favicon across re-opens so the home screen keeps
  // showing it without waiting for the project to load again.
  store.recents.unshift({ path: repoPath, name, kind, lastOpened: Date.now(), favicon: prev && prev.favicon ? prev.favicon : null });
  store.recents = store.recents.slice(0, 24);
  save();
}

// Cache a project's favicon (data URL) once it has loaded, keyed by repo path.
// dataUrl is what the preview's overlay posted from inside the site's page (a
// FileReader result the window forwards as is), so it is unknown until the
// string check.
function setFavicon(repoPath: string, dataUrl: unknown): void {
  const r = store.recents.find((x) => x.path === repoPath);
  if (r && typeof dataUrl === 'string' && dataUrl !== r.favicon) { r.favicon = dataUrl; save(); }
}
// The cached favicon for a repo (or null) — seeds a restored tab's rail row so
// a project that reopens ASLEEP still looks like itself before its preview
// ever loads.
function faviconFor(repoPath: string): string | null {
  const r = store.recents.find((x) => x.path === repoPath);
  return (r && r.favicon) || null;
}

function removeRecent(repoPath: string): void {
  store.recents = store.recents.filter((r) => r.path !== repoPath);
  save();
}

function listRecents(): RecentProject[] {
  // Drop any that no longer exist on disk.
  store.recents = store.recents.filter((r) => fs.existsSync(r.path));
  return store.recents;
}

function setProjectsDir(dir: string): void { store.projectsDir = dir; save(); }
function getProjectsDir(): string | null { return store.projectsDir; }
function setFilesDir(dir: string): void { store.filesDir = dir; save(); }
function getFilesDir(): string | null { return store.filesDir || null; }

// A project moved on disk — follow it everywhere this store references the path.
function rekey(oldPath: string, newPath: string): void {
  for (const r of store.recents) if (r.path === oldPath) r.path = newPath;
  if (store.session) {
    store.session.open = (store.session.open || []).map((p) => (p === oldPath ? newPath : p));
    if (store.session.active === oldPath) store.session.active = newPath;
  }
  save();
}

// Open-projects session (for Figma-style reopen on next launch).
// `open` is typed as what the window sends (its open tabs' paths, renderer.ts
// saveSession); the Array.isArray check is only defense.
function setSession(open: string[], active?: string | null): void {
  store.session = { open: Array.isArray(open) ? open : [], active: active || null };
  save();
}
function getSession(): OpenSession {
  const s = store.session || { open: [], active: null };
  const open = (s.open || []).filter((p) => fs.existsSync(p)); // drop deleted projects
  return { open, active: (open as readonly (string | null)[]).includes(s.active) ? s.active : (open[0] || null) };
}

// "Clean exit" marker — set false while running, true on a graceful quit, so the
// next launch can tell whether we crashed. The answer is the marker as init
// found it: markRunning has overwritten it by the time the window asks.
function markRunning(): void { store.cleanExit = false; save(); }
function markCleanExit(): void { store.cleanExit = true; save(); }
function crashedLastRun(): boolean { return crashedLast; }

/** Look like a website project? */
function isProject(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, 'index.html'));
}

function scanProjectsDir(): AvailableProject[] {
  const dir = store.projectsDir;
  if (!dir || !fs.existsSync(dir)) return [];
  const out: AvailableProject[] = [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
    if (isProject(full)) out.push({ path: full, name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function snapshot(): RecentsSnapshot {
  return { recents: listRecents(), projectsDir: getProjectsDir(), available: scanProjectsDir() };
}

export { init, addRecent, removeRecent, setFavicon, faviconFor, listRecents, setProjectsDir, getProjectsDir, setFilesDir, getFilesDir, scanProjectsDir, snapshot, setSession, getSession, markRunning, markCleanExit, crashedLastRun, rekey, isFirstRun };
