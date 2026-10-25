/**
 * Budget for the per-project undo/redo stacks. Each record carries the FULL
 * before and after contents of the edited file (that's what makes undo a
 * straight file restore), so a long session on big files snowballs — one
 * project's persisted history once reached 23MB, and the whole store is
 * JSON.stringified synchronously on the main process every time it saves.
 * Oldest edits fall off first; history deeper than ⌘Z reach lives in version
 * history (moments), which snapshots the whole tree anyway.
 */

/** One undoable edit: the whole file before and after (persisted in projectState's undoHistory). */
export interface EditRecord {
  file: string;
  relFile: string;
  prev: string;
  next: string;
}

/**
 * A successful write as the edit producers return it (editEngine, editInsert,
 * tokens.setToken; each adds its own fields). main.ts recordEdit turns it into
 * an EditRecord; cliServer and the IPC replies strip the two contents first.
 */
export interface FileEdit {
  ok: true;
  /** Absolute path. */
  file: string;
  /** Relative to the repo. */
  relFile: string;
  line?: number;
  /** The whole file before and after; set together, and both missing on a dry run (nothing written). */
  prevContent?: string;
  newContent?: string;
}

/** A project's undo and redo stacks, oldest first. */
export interface EditHistory {
  undo: EditRecord[];
  redo: EditRecord[];
}

const MAX_ENTRIES = 80;
// Per project. The store persists EVERY project's history in one file that is
// stringified whole on each save, so this bounds that file at roughly
// 2MB × open projects — while still holding 10–30 edits of undo depth for
// typical page-sized files.
const MAX_BYTES = 2 * 1024 * 1024;

// Rough persisted size of one record: the two file bodies dominate; the
// constant covers paths and JSON syntax.
function recordSize(r: Pick<EditRecord, 'prev' | 'next'>): number {
  return ((r.prev && r.prev.length) || 0) + ((r.next && r.next.length) || 0) + 200;
}

/**
 * Trim {undo, redo} in place to the budget. Drops the oldest undo entries
 * first, then the furthest-future redo entries (redo[0] — the last step a
 * redo-spree would reach). Never drains a stack completely on byte pressure:
 * the record nearest the user's current position stays reachable even if it
 * alone busts the byte budget. Returns true if anything was dropped.
 */
function cap(h: EditHistory): boolean {
  let total = 0;
  for (const r of h.undo) total += recordSize(r);
  for (const r of h.redo) total += recordSize(r);
  const over = () => h.undo.length + h.redo.length > MAX_ENTRIES || total > MAX_BYTES;
  let dropped = false;
  while (over() && h.undo.length > 1) { total -= recordSize(h.undo.shift()!); dropped = true; }
  while (over() && h.redo.length > 1) { total -= recordSize(h.redo.shift()!); dropped = true; }
  return dropped;
}

function applyRecord(record: Pick<EditRecord, 'file' | 'prev' | 'next'>, direction: 'undo' | 'redo'): boolean {
  const fs = require('fs') as typeof import('fs');
  const expected = direction === 'undo' ? record.next : record.prev;
  const replacement = direction === 'undo' ? record.prev : record.next;
  try {
    if (fs.readFileSync(record.file, 'utf8') !== expected) return false;
    fs.writeFileSync(record.file, replacement, 'utf8');
    return true;
  } catch { return false; }
}

export { cap, applyRecord, MAX_ENTRIES, MAX_BYTES };
