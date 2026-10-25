import { test } from 'node:test';
import assert from 'node:assert';

import * as editHistory from '../src/main/editHistory';
import type { EditHistory, EditRecord } from '../src/main/editHistory';

const rec = (id: number | string, bytes = 10): EditRecord => ({ file: `/r/${id}`, relFile: String(id), prev: 'a'.repeat(bytes), next: 'b'.repeat(bytes) });

test('cap is a no-op under budget', () => {
  const h = { undo: [rec(1), rec(2)], redo: [rec(3)] };
  assert.equal(editHistory.cap(h), false);
  assert.deepEqual(h.undo.map((r) => r.relFile), ['1', '2']);
  assert.deepEqual(h.redo.map((r) => r.relFile), ['3']);
});

test('cap drops the OLDEST undo entries past the entry budget', () => {
  const h: EditHistory = { undo: [], redo: [] };
  for (let i = 0; i < editHistory.MAX_ENTRIES + 20; i++) h.undo.push(rec(i));
  assert.equal(editHistory.cap(h), true);
  assert.equal(h.undo.length, editHistory.MAX_ENTRIES);
  assert.equal(h.undo[0].relFile, '20'); // 0..19 fell off the bottom
  assert.equal(h.undo[h.undo.length - 1].relFile, String(editHistory.MAX_ENTRIES + 19)); // newest kept
});

test('cap enforces the byte budget on big file bodies', () => {
  const big = Math.ceil(editHistory.MAX_BYTES / 8); // each record ~2 slices of the budget
  const h = { undo: [rec(1, big), rec(2, big), rec(3, big), rec(4, big), rec(5, big), rec(6, big)], redo: [] };
  editHistory.cap(h);
  const total = h.undo.reduce((n, r) => n + r.prev.length + r.next.length, 0);
  assert.ok(total <= editHistory.MAX_BYTES, `still ${total} bytes`);
  assert.equal(h.undo[h.undo.length - 1].relFile, '6'); // newest edit survives
});

test('cap never drains a stack to zero on byte pressure', () => {
  const giant = editHistory.MAX_BYTES; // a single record alone busts the budget
  const h = { undo: [rec(1, giant)], redo: [rec(2, giant)] };
  editHistory.cap(h);
  assert.equal(h.undo.length, 1); // the edit just made stays undoable
  assert.equal(h.redo.length, 1); // the nearest redo stays reachable
});

test('cap trims undo before touching redo, and redo from its far end', () => {
  const h: EditHistory = { undo: [], redo: [] };
  // Mid-undo-chain shape: redo[0] is the furthest-future step.
  for (let i = 0; i < 60; i++) h.undo.push(rec('u' + i));
  for (let i = 0; i < 60; i++) h.redo.push(rec('r' + i));
  editHistory.cap(h);
  assert.equal(h.undo.length + h.redo.length, editHistory.MAX_ENTRIES);
  assert.equal(h.redo.length, 60); // redo untouched while undo could still give
  assert.equal(h.undo[0].relFile, 'u40');
  // Now force byte pressure with undo already at one entry: redo trims from index 0.
  const big = editHistory.MAX_BYTES / 4;
  const h2 = { undo: [rec('u', 10)], redo: [rec('r0', big), rec('r1', big), rec('r2', big)] };
  editHistory.cap(h2);
  assert.equal(h2.redo[h2.redo.length - 1].relFile, 'r2'); // nearest redo step kept
  assert.ok(!h2.redo.find((r) => r.relFile === 'r0')); // furthest dropped first
});
