import { test } from 'node:test';
import assert from 'node:assert';

import * as wh from '../src/main/watcherHealth';

test('probe() resolves a boolean verdict within its timeout', async () => {
  const t0 = Date.now();
  const ok = await wh.probe(2000);
  assert.equal(typeof ok, 'boolean');
  assert.ok(Date.now() - t0 < 3500);
});

test('healthy() is optimistic before the first probe lands and honors the test seam', () => {
  wh._setForTest(false);
  assert.equal(wh.healthy(), false);
  wh._setForTest(true);
  assert.equal(wh.healthy(), true);
  wh._setForTest(undefined);
});

test('check() coalesces concurrent probes', async () => {
  const [a, b] = await Promise.all([wh.check(), wh.check()]);
  assert.equal(a, b);
});
