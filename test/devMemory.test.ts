// When a dev server is over its memory limit, Radial restarts it (at most once
// per quiet window, sooner if it doubles past the limit) and stops it only when
// it doubles past again right after two restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitMb, headlessLimitMb, decide, QUIET_MS, RUNAWAY_MS } from '../src/main/devMemory';
const GB = 1024 ** 3, MIN = 60 * 1000;

test('the limit is a quarter of the Mac, never under 4 GB', () => {
  assert.equal(limitMb(18 * GB), 4608);
  assert.equal(limitMb(8 * GB), 4096);
  assert.equal(limitMb(64 * GB), 16384);
});

test('radial serve’s limit is half the machine, with no floor: the Mac’s 4 GB would be all of a small VM', () => {
  assert.equal(headlessLimitMb(4 * GB), 2048);
  assert.equal(headlessLimitMb(2 * GB), 1024);
  assert.equal(headlessLimitMb(64 * GB), 32768);
});

test('a busy server is restarted, not stopped, and not restarted again right away', () => {
  const now = 100 * MIN, limit = 4608;
  assert.equal(decide({ mb: 4000, limit, now }), 'ok');
  assert.equal(decide({ mb: 5000, limit, now }), 'restart', 'over the limit: restart');
  assert.equal(decide({ mb: 5000, limit, restarts: [now - 5 * MIN], now }), 'wait', 'restarted 5 min ago: give it the quiet window');
  assert.equal(decide({ mb: 5000, limit, restarts: [now - QUIET_MS - 1], now }), 'restart', 'after the window: restart again');
  assert.equal(decide({ mb: 9000, limit, restarts: [now - 20 * MIN], now }), 'restart', 'a restart 20 minutes ago does not hold it back');
});

test('only a server that doubles past the limit right after two restarts is stopped', () => {
  const now = 100 * MIN, limit = 4608;
  assert.equal(decide({ mb: 9300, limit, restarts: [now - 1 * MIN], now }), 'restart', 'doubled: restart without waiting');
  assert.equal(decide({ mb: 9300, limit, restarts: [now - 1 * MIN, now - 3 * MIN], now }), 'stop');
  assert.equal(decide({ mb: 6000, limit, restarts: [now - 1 * MIN, now - 3 * MIN], now }), 'wait', 'over but not doubled: never stopped');
  assert.equal(decide({ mb: 9300, limit, restarts: [now - 1 * MIN, now - RUNAWAY_MS - 1], now }), 'restart', 'restarts spread out: not a runaway');
});
