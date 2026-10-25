import * as projectData from './projectData';

/**
 * Version history, Figma-style: a timeline of "moments" — whole-tree snapshots
 * a user can view and restore visually, with no git vocabulary.
 *
 * Each moment is a real git commit built through a temporary index (tracked +
 * untracked files, never touching the branch, index, or HEAD — same technique
 * as publish.checkpoint) and pinned under refs/radial/moments/<id> so gc can't
 * prune it. Metadata (kind, label, files, timestamps) lives in
 * `.radial/history/moments.jsonl`; thumbnails in `.radial/history/thumbs/`.
 * All of `.radial/` is gitignored and deploy-excluded, and — because moments
 * are ordinary git objects in the repo itself — history travels with the
 * project if the folder moves.
 *
 * Viewing/restoring is non-destructive, exactly like Figma: before the working
 * tree is rewound to an older moment, "now" is snapshotted to
 * refs/radial/preview-return; Restore keeps the old version and records a new
 * 'restore' moment (nothing is ever deleted), Back-to-now reapplies the saved
 * present.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import * as publish from './publish';
import type { BackToNowResult, Moment, MomentKind, MomentList, MomentPreviewResult, MomentRecordResult, MomentRestoreResult, SnapshotFailure } from '../shared/radialApi';
import { watchTree } from './treeWatch';
import type { TreeWatch } from './treeWatch';

/** snapshot(): the working tree as a tree and a commit on top of HEAD. */
export interface MomentSnapshot { tree: string; commit: string }
/** record()'s options: what kind of moment, its label, and the files it touched. */
export interface MomentRecordOptions { kind?: MomentKind; label?: string; files?: string[] }
/** list(): the window's MomentList without `previewing`, which main.ts adds before the window sees it; the moments newest first. */
export type MomentListWithoutPreview = Omit<MomentList, 'previewing'>;
/** applySnapshot(): the working tree now matches the commit; the starting files stay on recoveryRef. */
export type ApplySnapshotResult = { ok: true; recoveryRef: string } | SnapshotFailure;
/** watchRepo()'s options: the idle windows and the callbacks that get the touched paths (at most 40). */
export interface WatchRepoOptions {
  idleMs?: number;
  onBurst?: (files: string[]) => void;
  touchMs?: number;
  onTouch?: ((files: string[]) => void) | null;
}
/** watchRepo(): stops the watcher and its pending timers. */
export interface RepoWatcher { close: () => void }

const REF_PREFIX = 'refs/radial/moments/';
const RETURN_REF = (dir: string): string => 'refs/radial/preview-return-' + crypto.createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0, 16);
const PREVIEW_REF = (dir: string): string => RETURN_REF(dir) + '-viewing';
const MAX_MOMENTS = 100;
const KINDS = new Set<MomentKind>(['agent', 'edit', 'publish', 'restore', 'external']);

const histDir = (repoDir: string): string => projectData.dataDir(repoDir, 'history');
const logFile = (repoDir: string): string => path.join(histDir(repoDir), 'moments.jsonl');
const thumbsDir = (repoDir: string): string => path.join(histDir(repoDir), 'thumbs');
const thumbPath = (repoDir: string, id: string): string => path.join(thumbsDir(repoDir), `${id}.png`);

function readLog(repoDir: string): Moment[] {
  try {
    return fs.readFileSync(logFile(repoDir), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Moment; } catch { return null; } })
      .filter((m) => m && m.id && m.commit) as Moment[];
  } catch { return []; }
}
function writeLog(repoDir: string, entries: Moment[]): void {
  fs.mkdirSync(histDir(repoDir), { recursive: true });
  fs.writeFileSync(logFile(repoDir), entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

// Snapshot the working tree (tracked + untracked) to a commit without touching
// the real index/branch. Returns { tree, commit } or null when impossible.
async function snapshot(repoDir: string): Promise<MomentSnapshot | null> {
  if (!publish.isGitRepo(repoDir)) return null;
  const head = await publish.git(repoDir, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '');
  if (!head) return null;
  const tmpIndex = path.join(os.tmpdir(), `radial-moment-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    await publish.git(repoDir, ['read-tree', 'HEAD'], env);
    await publish.git(repoDir, ['add', '-A'], env);
    const tree = await publish.git(repoDir, ['write-tree'], env);
    const commit = await publish.git(repoDir, [...await publish.snapshotIdentityArgs(repoDir), 'commit-tree', tree, '-p', 'HEAD', '-m', 'radial-moment'], env);
    return { tree, commit };
  } catch { return null; }
  finally { try { fs.unlinkSync(tmpIndex); } catch {} }
}

/**
 * Record a moment of the current working tree. Consecutive identical trees are
 * skipped (except 'publish' and 'restore', which are meaningful markers even
 * when nothing changed since the last snapshot).
 */
async function record(repoDir: string, { kind = 'edit', label = '', files = [] }: MomentRecordOptions = {}): Promise<MomentRecordResult> {
  if (!KINDS.has(kind)) kind = 'edit';
  const snap = await snapshot(repoDir);
  if (!snap) return { ok: false, reason: 'no-git' };
  const entries = readLog(repoDir);
  const last = entries[entries.length - 1];
  if (last && last.tree === snap.tree && kind !== 'publish' && kind !== 'restore') {
    return { ok: true, skipped: 'unchanged', id: last.id };
  }
  const id = Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  await publish.git(repoDir, ['update-ref', REF_PREFIX + id, snap.commit]);
  const entry: Moment = {
    id,
    ts: Date.now(),
    kind,
    label: String(label || '').slice(0, 140),
    files: (Array.isArray(files) ? files : []).slice(0, 40),
    tree: snap.tree,
    commit: snap.commit,
  };
  entries.push(entry);
  // Cap history: drop oldest beyond the limit (ref + thumb + log line).
  while (entries.length > MAX_MOMENTS) {
    const dead = entries.shift()!;
    await publish.git(repoDir, ['update-ref', '-d', REF_PREFIX + dead.id]).catch(() => {});
    try { fs.unlinkSync(thumbPath(repoDir, dead.id)); } catch {}
  }
  writeLog(repoDir, entries);
  return { ok: true, moment: entry };
}

/** Newest-first list for the UI, with thumbnail paths where one exists. */
function list(repoDir: string): MomentListWithoutPreview {
  const entries = readLog(repoDir).map((e) => ({
    id: e.id, ts: e.ts, kind: e.kind, label: e.label, files: e.files,
    thumb: fs.existsSync(thumbPath(repoDir, e.id)) ? thumbPath(repoDir, e.id) : null,
  }));
  entries.reverse();
  return { ok: true, moments: entries };
}

// Make the working tree match `commit`'s tree exactly: write every file from
// the snapshot, then delete files that exist now but not in the snapshot.
// (.radial/ is gitignored, so snapshots never contain it and it's never touched.)
async function applySnapshot(repoDir: string, commit: string): Promise<ApplySnapshotResult> {
  const repository = require('./repository') as typeof import('./repository');
  const state = await repository.state(repoDir);
  if (!state.ok || state.operation || state.conflicts.length || await (require('./integration') as typeof import('./integration')).read(repoDir)) return { ok: false, reason: 'operation-in-progress', message: 'Finish the Git operation before restoring history.' };
  const fingerprint = await repository.fingerprint(repoDir);
  const now = await snapshot(repoDir);
  if (!now) return { ok: false, reason: 'no-git' };
  const recoveryRef = 'refs/radial/recovery/restore-' + crypto.randomUUID();
  await publish.git(repoDir, ['update-ref', recoveryRef, now.commit]);
  const tmpIndex = path.join(os.tmpdir(), 'radial-apply-' + crypto.randomUUID());
  const env = { GIT_INDEX_FILE: tmpIndex };
  const startingIndex = tmpIndex + '-start';
  try {
    await publish.git(repoDir, ['read-tree', now.commit], { GIT_INDEX_FILE: startingIndex });
    if (await repository.fingerprint(repoDir) !== fingerprint) return { ok: false, reason: 'checkout-changed', message: 'The files changed while preparing the restore. Your latest work was kept.' };
    const fields = (await repository.run(repoDir, ['diff-tree', '-r', '--name-status', '-z', '--no-renames', now.commit, commit], { raw: true })).split('\0');
    await publish.git(repoDir, ['read-tree', commit], env);
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = fields[i], file = fields[i + 1];
      // Recheck each affected file against the saved starting tree. Outside
      // writers can keep running; a detected change stops this restore.
      const changed = await repository.run(repoDir, ['diff', '--no-ext-diff', '--no-textconv', '--', file], { raw: true, env: { GIT_INDEX_FILE: startingIndex } });
      if (changed) return { ok: false, reason: 'checkout-changed', recoveryRef, message: `Another tool changed ${file}. Restore stopped; the starting files remain in recovery.` };
      if (status === 'D') fs.unlinkSync(path.join(repoDir, file));
      else await publish.git(repoDir, ['checkout-index', '-f', '--', file], env);
    }
    return { ok: true, recoveryRef };
  } catch (error) { return { ok: false, reason: 'git-error', message: (error as Error).message, recoveryRef }; }
  finally { fs.rmSync(tmpIndex, { force: true }); fs.rmSync(startingIndex, { force: true }); }
}

/**
 * Rewind the canvas to a moment. The first preview in a session pins the
 * current tree to RETURN_REF so Back-to-now (or a crash recovery) can reapply
 * it; previewing another moment while already previewing keeps that pin.
 */
async function preview(repoDir: string, id: string): Promise<MomentPreviewResult> {
  const entry = readLog(repoDir).find((e) => e.id === id);
  if (!entry) return { ok: false, reason: 'not-found' };
  const existing = await publish.git(repoDir, ['rev-parse', '--verify', '-q', RETURN_REF(repoDir)]).catch(() => '');
  if (!existing) {
    const now = await snapshot(repoDir);
    if (!now) return { ok: false, reason: 'no-git' };
    await publish.git(repoDir, ['update-ref', RETURN_REF(repoDir), now.commit]);
  }
  const applied = await applySnapshot(repoDir, entry.commit);
  if (applied.ok) await publish.git(repoDir, ['update-ref', PREVIEW_REF(repoDir), entry.commit]);
  return applied.ok ? { ok: true, id } : applied;
}

/** Leave preview, reapplying the pinned present. */
async function backToNow(repoDir: string): Promise<BackToNowResult> {
  const ret = await publish.git(repoDir, ['rev-parse', '--verify', '-q', RETURN_REF(repoDir)]).catch(() => '');
  if (!ret) return { ok: true, skipped: 'not-previewing' };
  const expected = await publish.git(repoDir, ['rev-parse', '--verify', '-q', PREVIEW_REF(repoDir) + '^{tree}']).catch(() => null);
  const current = await snapshot(repoDir);
  if (expected && current?.tree !== expected) return { ok: false, reason: 'checkout-changed', message: 'Files changed while viewing history. Save those edits with your Git tool before returning; the original present is retained in ' + RETURN_REF(repoDir) + '.' };
  const applied = await applySnapshot(repoDir, ret);
  if (!applied.ok) return applied;
  await publish.git(repoDir, ['update-ref', '-d', RETURN_REF(repoDir)]).catch(() => {});
  await publish.git(repoDir, ['update-ref', '-d', PREVIEW_REF(repoDir)]).catch(() => {});
  return { ok: true };
}

/** Keep the currently previewed moment: it becomes the present, recorded as a
 *  new 'restore' moment — the abandoned present stays in history untouched. */
async function restore(repoDir: string, id: string): Promise<MomentRestoreResult> {
  const entry = readLog(repoDir).find((e) => e.id === id);
  if (!entry) return { ok: false, reason: 'not-found' };
  const applied = await applySnapshot(repoDir, entry.commit);
  if (!applied.ok) return applied;
  await publish.git(repoDir, ['update-ref', '-d', RETURN_REF(repoDir)]).catch(() => {});
  await publish.git(repoDir, ['update-ref', '-d', PREVIEW_REF(repoDir)]).catch(() => {});
  const when = new Date(entry.ts);
  const hh = when.getHours() % 12 || 12, mm = String(when.getMinutes()).padStart(2, '0');
  const label = entry.label ? `Restored: ${entry.label}` : `Restored version from ${hh}:${mm}`;
  return record(repoDir, { kind: 'restore', label, files: entry.files });
}

/**
 * One-click revert to a checkpoint moment (the adjust pill's Undo). Unlike
 * restore(), this refuses when the tree hasn't changed since the checkpoint —
 * the agent hasn't landed its edit yet, and "reverting" to an identical tree
 * would read as Undo doing nothing right before the change appears anyway.
 */
async function revertTo(repoDir: string, id: string, label = ''): Promise<MomentRestoreResult> {
  const entry = readLog(repoDir).find((e) => e.id === id);
  if (!entry) return { ok: false, reason: 'not-found' };
  const now = await snapshot(repoDir);
  if (!now) return { ok: false, reason: 'no-git' };
  if (now.tree === entry.tree) return { ok: false, reason: 'unchanged' };
  const applied = await applySnapshot(repoDir, entry.commit);
  if (!applied.ok) return applied;
  return record(repoDir, {
    kind: 'restore',
    label: label || (entry.label ? `Reverted: ${entry.label}` : 'Reverted'),
    files: entry.files,
  });
}

/** True when the repo is rewound to a previewed moment (survives restarts). */
async function isPreviewing(repoDir: string): Promise<boolean> {
  if (!publish.isGitRepo(repoDir)) return false;
  const ret = await publish.git(repoDir, ['rev-parse', '--verify', '-q', RETURN_REF(repoDir)]).catch(() => '');
  return !!ret;
}

/** Store a renderer-captured PNG thumbnail (data URL) for a moment. */
function saveThumb(repoDir: string, id: string, dataUrl: string): { ok: boolean } {
  const entry = readLog(repoDir).find((e) => e.id === id);
  const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
  if (!entry || !m) return { ok: false };
  try {
    fs.mkdirSync(thumbsDir(repoDir), { recursive: true });
    fs.writeFileSync(thumbPath(repoDir, id), Buffer.from(m[1], 'base64'));
    return { ok: true };
  } catch { return { ok: false }; }
}

// Directories that churn without meaning a content change the user made.
const WATCH_SKIP = new Set(['node_modules', 'dist', 'build', 'out', '.next', '.astro', '.cache', 'coverage']);

/**
 * Watch a repo for change bursts made OUTSIDE Radial's own pipelines —
 * terminal agents (Claude Code CLI in the PTY writes files with no turn-end
 * signal Radial can see), external editors, anything. Collects touched paths
 * and fires onBurst(files) once the burst goes idle; the caller decides the
 * moment's kind/label. Recording is naturally deduped against pipeline-made
 * moments because record() skips identical trees.
 *
 * onTouch(files) is the fast sibling: the same touched paths on a short
 * debounce (touchMs), for UI that should react while the agent is still
 * working — e.g. a new page file appearing in the sidebar — without waiting
 * out the long moment-idle window.
 */
function watchRepo(repoDir: string, { idleMs = 30000, onBurst = () => {}, touchMs = 900, onTouch = null }: WatchRepoOptions = {}): RepoWatcher {
  let watcher: TreeWatch | null = null;
  let timer: NodeJS.Timeout | null = null;
  let touchTimer: NodeJS.Timeout | null = null;
  const files = new Set<string>();
  const touched = new Set<string>();
  const started = Date.now();
  try {
    // .git, .radial and the dependency and build folders never count (treeWatch.ts doesn't even watch them on Linux).
    watcher = watchTree(repoDir, (_ev, f) => {
      if (Date.now() - started < 1000) return; // FSEvents replays pre-watch events
      files.add(f);
      clearTimeout(timer as NodeJS.Timeout | undefined); // null is a no-op; @types/node leaves it out
      timer = setTimeout(() => {
        const burst = [...files].slice(0, 40);
        files.clear();
        try { onBurst(burst); } catch {}
      }, idleMs);
      if (!onTouch) return;
      touched.add(f);
      clearTimeout(touchTimer as NodeJS.Timeout | undefined);
      touchTimer = setTimeout(() => {
        const t = [...touched].slice(0, 40);
        touched.clear();
        try { onTouch(t); } catch {}
      }, touchMs);
    }, { skip: (s) => s.startsWith('.') || WATCH_SKIP.has(s) });
  } catch { /* the repo can't be watched: no external moments, nothing breaks */ }
  return { close: () => { clearTimeout(timer as NodeJS.Timeout | undefined); clearTimeout(touchTimer as NodeJS.Timeout | undefined); try { if (watcher) watcher.close(); } catch {} } };
}

const locked = <A extends unknown[], R>(fn: (dir: string, ...args: A) => Promise<R>) => (dir: string, ...args: A): Promise<R> => publish.withRepoLock(dir, () => fn(dir, ...args));

// The commands that move the working tree take the repo's lock.
const lockedPreview = locked(preview);
const lockedBackToNow = locked(backToNow);
const lockedRestore = locked(restore);
const lockedRevertTo = locked(revertTo);
export { record, list, lockedPreview as preview, lockedBackToNow as backToNow, lockedRestore as restore, lockedRevertTo as revertTo, isPreviewing, saveThumb, snapshot, applySnapshot, readLog, thumbPath, watchRepo, MAX_MOMENTS };
