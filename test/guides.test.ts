// Rulers/guides are temporary screen-fixed overlay lines (screen px over #preview).
// The only error-prone bits are the offset clamp and the tick generation, so they
// live in a pure module and get fixed-expectation tests (not a round-trip that
// could pass with a matching wrong transform in both directions).

import { test } from 'node:test';
import assert from 'node:assert';
import { clampOffset, rulerTicks } from '../src/renderer/guides';

test('clampOffset: interior point maps to client - edge', () => {
  assert.equal(clampOffset(420, 100, 800), 320);
  assert.equal(clampOffset(100, 100, 800), 0); // exactly on the edge
});

test('clampOffset: clamps left/above the area to 0', () => {
  assert.equal(clampOffset(40, 100, 800), 0);
  assert.equal(clampOffset(-50, 0, 800), 0);
});

test('clampOffset: clamps right/below the area to size', () => {
  assert.equal(clampOffset(2000, 100, 800), 800);
  assert.equal(clampOffset(900, 100, 800), 800); // 800 over a 800-wide area
});

test('rulerTicks: count covers 0..size inclusive at step spacing', () => {
  const ticks = rulerTicks(100, 10);
  assert.equal(ticks.length, 11); // 0,10,...,100
  assert.equal(ticks[0].off, 0);
  assert.equal(ticks[ticks.length - 1].off, 100);
});

test('rulerTicks: every 5th tick is major and labeled with its px value', () => {
  const ticks = rulerTicks(100, 10);
  const majors = ticks.filter((t) => t.major);
  assert.deepEqual(majors.map((t) => t.off), [0, 50, 100]);
  assert.deepEqual(majors.map((t) => t.label), ['0', '50', '100']);
  // minors carry no label
  assert.ok(ticks.filter((t) => !t.major).every((t) => t.label === ''));
});

test('rulerTicks: defaults to a 10px step when given a non-positive step', () => {
  assert.deepEqual(rulerTicks(20, 0).map((t) => t.off), [0, 10, 20]);
  assert.deepEqual(rulerTicks(20, -5).map((t) => t.off), [0, 10, 20]);
});
