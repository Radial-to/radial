/**
 * Edit history and version history, per open project: the undo and redo
 * stacks of the edits Radial wrote (persisted, so Undo survives a restart),
 * the moments a burst of edits or an outside change records, the repo watcher
 * that notices agents' and editors' changes, and the git checkpoint and
 * auto-commit an edit schedules. Moved from main.ts (plans/headless-core.md,
 * phase 1); the window hears about it through history:state, files:changed,
 * moments:created and autoCommit:done.
 */
import * as projectState from '../main/projectState';
import * as editHistory from '../main/editHistory';
import * as moments from '../main/moments';
import * as terminal from '../main/terminal';
import * as publish from '../main/publish';
import type { EditHistory, EditRecord, FileEdit } from '../main/editHistory';
import type { RepoWatcher } from '../main/moments';
import type { CheckpointResult } from '../main/publish';
import type { AutoCommitResult, HistoryAction, MomentKind, MomentRestoreResult } from '../shared/radialApi';
import type { AnswerTo, ArgTo, LooseUnion } from './types';
import { events, send } from './host';
import { activeRepoDir } from './sessions';

/** A burst of the person's own edits to a project, waiting MOMENT_EDIT_IDLE to become one moment. */
interface PendingEditMoment { files: Set<string>; timer: NodeJS.Timeout | null }

// --- edit history (undo/redo), per project -------------------------------
// Each record stores the full file content before and after an edit, so undo
// is a simple, robust file restore regardless of how positions shifted.
export const histories = new Map<string, EditHistory>(); // repoDir -> { undo: [], redo: [] }

export function historyFor(repoDir: string): EditHistory {
  if (!histories.has(repoDir)) histories.set(repoDir, { undo: [], redo: [] });
  return histories.get(repoDir)!; // set just above
}

// Undo/redo must survive an app restart. The stacks live in memory, but the
// chat (with its per-turn cursors) is persisted — so after a restart the UI
// shows old turns while the stack is empty, and Undo silently does nothing.
// Mirror the stacks into the same per-project store and reload them on open.
function persistHistory(repoDir: string): void {
  if (!repoDir || !histories.has(repoDir)) return;
  const h = histories.get(repoDir)!; // checked just above
  try { projectState.set(repoDir, { undoHistory: { undo: h.undo, redo: h.redo } }); } catch {}
}
export function loadHistory(repoDir: string): void {
  let saved: EditHistory | null | undefined = null;
  try { saved = projectState.get(repoDir).undoHistory; } catch {}
  const valid = (r: Partial<EditRecord> | null | undefined) => r && typeof r.file === 'string' && typeof r.relFile === 'string'
    && typeof r.prev === 'string' && typeof r.next === 'string';
  const undo = Array.isArray(saved && saved.undo) ? saved!.undo.filter(valid) : []; // saved: checked by isArray
  const redo = Array.isArray(saved && saved.redo) ? saved!.redo.filter(valid) : [];
  const h = { undo, redo };
  const trimmed = editHistory.cap(h); // stores from before the cap existed can be huge
  histories.set(repoDir, h);
  if (trimmed) persistHistory(repoDir); // shrink the on-disk copy now, not at the next edit
}

export function recordEdit(repoDir: string, result: FileEdit | { ok: false }): void {
  if (!result || !result.ok || result.prevContent === undefined) return;
  const h = historyFor(repoDir);
  h.undo.push({ file: result.file, relFile: result.relFile, prev: result.prevContent, next: result.newContent! }); // set together with prevContent
  h.redo.length = 0;
  editHistory.cap(h); // oldest edits fall off past the entry/byte budget
  sendHistoryState(repoDir, 'edit', result.relFile);
  scheduleCheckpoint(repoDir); // snapshot work to the recoverable shadow ref
  scheduleAutoCommit(repoDir, 90000); // manual-edit idle (~90s); agent turns reschedule to 1.5s
  scheduleEditMoment(repoDir, result.relFile); // version history: coalesced "you edited" moment
}

// ── Version history (moments) ────────────────────────────────────────────────
// Figma-style timeline: agent turns record a moment immediately (labeled by the
// ask); a burst of the user's own inline edits coalesces into one moment after
// a short idle. The renderer is pinged so it can attach a canvas thumbnail.
const momentEditPending = new Map<string, PendingEditMoment>(); // repoDir -> { files: Set, timer }
const MOMENT_EDIT_IDLE = Number(process.env.RADIAL_MOMENT_DEBOUNCE) || 20000;

export function notifyMomentCreated(repoDir: string, res: LooseUnion<MomentRestoreResult> | null): void {
  if (res && res.ok && res.moment) send('moments:created', { repoDir, id: res.moment.id });
}
function scheduleEditMoment(repoDir: string, relFile: string): void {
  let p = momentEditPending.get(repoDir);
  if (!p) { p = { files: new Set(), timer: null }; momentEditPending.set(repoDir, p); }
  if (relFile) p.files.add(relFile);
  clearTimeout(p.timer!); // null for a new burst: the ! is knowingly loose, clearTimeout ignores null
  p.timer = setTimeout(() => {
    momentEditPending.delete(repoDir);
    const files = [...p.files];
    const label = files.length === 1 ? `Edited ${files[0]}` : `Edited ${files.length} files`;
    moments.record(repoDir, { kind: 'edit', label, files }).then((r) => notifyMomentCreated(repoDir, r)).catch(() => {});
  }, MOMENT_EDIT_IDLE);
}

// Terminal agents (the CLI in the PTY pane) and outside editors change files
// with no turn-end signal, so the SDK-chat hook never fires for them — that
// left History blind to terminal-agent work. A per-project watcher coalesces
// those bursts into moments instead. Identical-tree dedupe in moments.record
// keeps this from double-logging changes the chat/edit pipelines already
// snapshotted; SDK turns additionally pause it (their own hook labels better).
const momentWatchers = new Map<string, RepoWatcher>(); // repoDir -> { close }
const MOMENT_WATCH_IDLE = Number(process.env.RADIAL_REPO_WATCH_IDLE) || 30000;

export function startMomentWatcher(repoDir: string): void {
  stopMomentWatcher(repoDir);
  momentWatchers.set(repoDir, moments.watchRepo(repoDir, {
    idleMs: MOMENT_WATCH_IDLE,
    // Fast ping (short debounce, same watcher): a terminal agent just touched
    // source files — let the sidebar pick up new/removed pages right away
    // instead of waiting for a project reopen.
    onTouch: (files) => {
      send('files:changed', { repoDir, files });
    },
    onBurst: async (files) => {
      let kind: MomentKind = 'external', label = 'Changed outside Radial';
      try {
        const ptys = await terminal.list(repoDir);
        const live = (ptys || []).find((p) => p.alive !== false);
        if (live) {
          kind = 'agent';
          const l = live.meta && live.meta.label;
          label = l ? String(l).slice(0, 90) : 'Terminal agent changes';
        }
      } catch {}
      const r = await moments.record(repoDir, { kind, label, files }).catch(() => null);
      notifyMomentCreated(repoDir, r);
    },
  }));
}
export function stopMomentWatcher(repoDir: string): void {
  const w = momentWatchers.get(repoDir);
  if (w) { w.close(); momentWatchers.delete(repoDir); }
}

// Debounced git auto-checkpoint: snapshot the working tree to the recoverable
// shadow ref so an accidental discard/reset (or a later mishap) can't lose work.
const checkpointTimers = new Map<string, NodeJS.Timeout>();
function scheduleCheckpoint(repoDir: string, delay = 4000): void {
  if (!repoDir) return;
  clearTimeout(checkpointTimers.get(repoDir));
  checkpointTimers.set(repoDir, setTimeout(() => {
    checkpointTimers.delete(repoDir);
    publish.checkpoint(repoDir).catch(() => {});
  }, delay));
}
export function checkpointNow(repoDir: string): Promise<CheckpointResult | void> {
  clearTimeout(checkpointTimers.get(repoDir));
  checkpointTimers.delete(repoDir);
  return publish.checkpoint(repoDir).catch(() => {});
}

// Debounced auto-commit (opt-in per project, default OFF). Distinct from the
// shadow-ref checkpoint above: the checkpoint is the always-on recovery net;
// this writes a real [Radial-Auto] commit on the edit branch so Publish arrives
// at an already-committed tree. publish.autoCommit serializes per repo (so it
// can't race Publish/Sync on .git/index.lock) and guards clean tree / production
// / detached HEAD / min-interval itself — this layer only schedules + debounces.
const autoCommitTimers = new Map<string, NodeJS.Timeout>();
export function autoCommitEnabled(repoDir: string): boolean {
  try { return !!(projectState.get(repoDir) || {}).autoCommit; } catch { return false; }
}
function scheduleAutoCommit(repoDir: string, delay = 1500): void {
  if (!repoDir || !autoCommitEnabled(repoDir)) return;
  clearTimeout(autoCommitTimers.get(repoDir));
  autoCommitTimers.set(repoDir, setTimeout(async () => {
    autoCommitTimers.delete(repoDir);
    if (!autoCommitEnabled(repoDir)) return; // toggled off during the debounce
    const res: LooseUnion<AutoCommitResult> | null = await publish.autoCommit(repoDir).catch(() => null);
    if (res && res.committed) send('autoCommit:done', { repoDir, sha: res.sha, subject: res.subject });
  }, delay));
}

function sendHistoryState(repoDir: string, action: HistoryAction, relFile: string | null): void {
  persistHistory(repoDir); // keep the on-disk copy in step with every mutation
  if (!events().listening()) return;
  const h = historyFor(repoDir);
  // Full chronological timeline = applied edits (oldest→newest) then the
  // "future" undone edits (also chronological). cursor = how many are applied.
  const future = [...h.redo].reverse();
  const timeline = h.undo.concat(future).map((r) => ({ relFile: r.relFile }));
  send('history:state', {
    repoDir,
    action,
    relFile,
    timeline,
    cursor: h.undo.length,
    total: timeline.length,
    canUndo: h.undo.length > 0,
    canRedo: h.redo.length > 0,
  });
}

// Non-destructive jump to a point in history: apply or revert edits until
// exactly `target` of them are applied. The rest stay re-appliable.
export function jumpTo(repoDir: string, target: number): void {
  const h = historyFor(repoDir);
  const total = h.undo.length + h.redo.length;
  target = Math.max(0, Math.min(target, total));
  let failed = 0;
  while (h.undo.length > target) { const rec = h.undo.pop(); if (!rec) break; if (!editHistory.applyRecord(rec, 'undo')) { h.undo.push(rec); failed++; break; } h.redo.push(rec); }
  while (!failed && h.undo.length < target) { const rec = h.redo.pop(); if (!rec) break; if (!editHistory.applyRecord(rec, 'redo')) { h.redo.push(rec); failed++; break; } h.undo.push(rec); }
  sendHistoryState(repoDir, failed ? 'jump-error' : 'jump', null);
}

// Commit the current preview: discard the "future" edits for good.
export function revertHere(repoDir: string): void {
  const h = historyFor(repoDir);
  h.redo.length = 0;
  sendHistoryState(repoDir, 'revert', null);
}

export function doUndo(repoDir: string | null = activeRepoDir): EditRecord | null {
  if (!repoDir) return null;
  const h = historyFor(repoDir);
  const rec = h.undo.pop();
  if (!rec) { sendHistoryState(repoDir, 'noop-undo', null); return null; }
  if (!editHistory.applyRecord(rec, 'undo')) { h.undo.push(rec); sendHistoryState(repoDir, 'external-change', rec.relFile); return null; }
  h.redo.push(rec);
  sendHistoryState(repoDir, 'undo', rec.relFile);
  return rec;
}

export function doRedo(repoDir: string | null = activeRepoDir): EditRecord | null {
  if (!repoDir) return null;
  const h = historyFor(repoDir);
  const rec = h.redo.pop();
  if (!rec) { sendHistoryState(repoDir, 'noop-redo', null); return null; }
  if (!editHistory.applyRecord(rec, 'redo')) { h.redo.push(rec); sendHistoryState(repoDir, 'external-change', rec.relFile); return null; }
  h.undo.push(rec);
  sendHistoryState(repoDir, 'redo', rec.relFile);
  return rec;
}

// history:latest: back to the newest edit.
export async function jumpToLatest(repoDir: ArgTo<'historyLatest', 0>): Promise<AnswerTo<'historyLatest'>> { const h = historyFor(repoDir); jumpTo(repoDir, h.undo.length + h.redo.length); return { ok: true }; }
