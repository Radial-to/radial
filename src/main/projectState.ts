/**
 * Per-project UI state that should survive a restart/crash — the agent chat
 * transcript and the unsent composer draft. Stored in userData (keyed by repo
 * path), NOT in the repo, since it's personal and not part of the site.
 * (That was the first use; today it holds slept agents, the preview's mode and
 * view, the Vercel link, auto-commit, undo history and the last launch check:
 * see ProjectState below.)
 */

import fs from 'fs';
import path from 'path';
import type { EditHistory } from './editHistory';
import type { ENGINES } from './engine';

/** The window's viewport choice for the preview (renderer.ts sets only these). Moves with PreviewView. */
export type ViewportMode = 'locked' | 'responsive' | 'tablet' | 'mobile' | 'custom';

/**
 * Where the preview stood (route, scroll, viewport, zoom), as the window's
 * threadPreview saves it (readThreadPreview sets every field). A slept agent,
 * the shared preview and the PTY meta all carry it. Its owner is
 * src/renderer/threadPreview.ts, the window module that saves and restores it
 * and that main and the preload can both import (main already imports window
 * modules; no window module imports main). This exact shape moves there once
 * that module is typed, and this file then imports it from there.
 */
export interface PreviewView {
  route: string;
  scroll: { x: number; y: number };
  viewportMode?: ViewportMode;
  width?: number;
  zoom: number;
  visualZoom: number;
  panX: number;
  panY: number;
}

/**
 * An agent terminal put to sleep; waking relaunches it, resuming its Claude
 * session when it has one. Apart from id, label and sleptAt, the fields are
 * copied from the PTY's meta (terminal.ts PtyMeta) with its types. Records stay
 * until the agent is woken or discarded, so old ones are still on disk:
 * before 0.35.0 a record held only id, engine, label, sessionId and sleptAt.
 */
export interface SleptAgent {
  /** The PTY id it had. */
  id: string;
  /** The agent CLI (engine.ts ENGINES); every record so far is 'claude'. */
  engine?: keyof typeof ENGINES | null;
  label: string;
  labelSource?: 'auto' | 'manual';
  sessionId?: string | null;
  /** Missing in records saved before 0.35.0. */
  preview?: PreviewView | null;
  previewSelectedAt?: number;
  /** Missing in records saved before 0.35.0; readers fall back to recentOpenedAt, then 0. */
  recentTaskAt?: number;
  /**
   * Never stored in a slept record: main.ts and the window read it as a
   * fallback for recentTaskAt, as they do in the PTY meta.
   */
  recentOpenedAt?: number;
  /** Missing in records saved before 0.35.0; 0 when not pinned. */
  recentPinnedAt?: number;
  sleptAt: number;
}

/** One project's saved state in radial-project-state.json. Every field is optional; set() merges patches. */
export interface ProjectState {
  sleptAgents?: SleptAgent[];
  /** The preview's last page title, for a sleeping tab's rail row. */
  pageTitle?: string;
  previewMode?: 'agent' | 'shared';
  sharedPreview?: PreviewView | null;
  /** The last launch-check report, stored and handed back as launchCheck.ts made it. */
  launchCheck?: unknown;
  /** The Vercel scope and project saved when the project was connected. */
  vercel?: { scope: string | null; project: string | null };
  autoCommit?: boolean;
  /**
   * Written by main.ts persistHistory. Readers still check each stored record
   * (main.ts loadHistory keeps only well-formed ones): it is read back from disk.
   */
  undoHistory?: EditHistory;
  // Written by earlier versions (composer draft, chat transcript, agent session); nothing reads them now.
  draft?: string;
  chat?: unknown[];
  chats?: unknown[];
  agentSessionId?: string | null;
}

let filePath: string | null = null;
let store: Record<string, ProjectState> = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function init(userDataDir: string): void {
  filePath = path.join(userDataDir, 'radial-project-state.json');
  try { store = JSON.parse(fs.readFileSync(filePath, 'utf8')) || {}; } catch { store = {}; }
}

function flush(): void {
  // saveTimer may be null here: the `!` is knowingly loose, Node's clearTimeout ignores null.
  clearTimeout(saveTimer!); saveTimer = null;
  // filePath is null before init(): the `!` is knowingly loose, the catch swallows that write's TypeError.
  try { fs.writeFileSync(filePath!, JSON.stringify(store)); } catch {}
}
// saveTimer may be null here: the `!` is knowingly loose, Node's clearTimeout ignores null.
function save(): void { clearTimeout(saveTimer!); saveTimer = setTimeout(flush, 400); }

function get(repoDir: string | null | undefined): ProjectState { return (repoDir && store[repoDir]) || {}; }
function set(repoDir: string | null | undefined, patch: ProjectState): void {
  if (!repoDir) return;
  store[repoDir] = { ...(store[repoDir] || {}), ...patch };
  save();
}
function clear(repoDir: string | null | undefined): void { if (repoDir) { delete store[repoDir]; save(); } }
/** Every project with saved state, and its state: how the core finds a slept agent by its id alone. */
function entries(): [string, ProjectState][] { return Object.entries(store); }

// A project moved on disk — its chats/drafts/settings must follow the new key.
function rekey(oldDir: string, newDir: string): void {
  if (!oldDir || !newDir || !(oldDir in store)) return;
  store[newDir] = store[oldDir];
  delete store[oldDir];
  save();
}

export { init, get, set, clear, entries, flush, rekey };
