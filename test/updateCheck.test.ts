// Unit tests for the Check for Updates… flow. Run from platform/:
//   node --test test/updateCheck.test.js

import { test } from 'node:test';
import assert from 'node:assert';

import * as updateCheck from '../src/main/updateCheck';
import type { FetchLike, ReleaseCheckResult } from '../src/main/updateCheck';

// The up-to-date test asserts the check succeeded before it reads updateAvailable.
type UpToDate = Extract<ReleaseCheckResult, { ok: true }>;

const fakeFetch = (body: unknown, status = 200): FetchLike => async () => ({ ok: status < 400, status, json: async () => body });

test('version parsing and comparison', () => {
  assert.deepEqual(updateCheck.parse('v0.5.0'), [0, 5, 0]);
  assert.deepEqual(updateCheck.parse('1.10.2'), [1, 10, 2]);
  assert.equal(updateCheck.parse('latest'), null);
  assert.equal(updateCheck.isNewer('0.5.0', '0.4.2'), true);
  assert.equal(updateCheck.isNewer('0.5.0', '0.5.0'), false);
  assert.equal(updateCheck.isNewer('0.4.9', '0.5.0'), false);
  assert.equal(updateCheck.isNewer('1.0.0', '0.9.9'), true);
  assert.equal(updateCheck.isNewer('0.5.10', '0.5.9'), true); // numeric, not lexicographic
});

test('check reports an available update', async () => {
  const r = await updateCheck.check('0.4.0', { fetchImpl: fakeFetch({ tag_name: 'v0.5.0' }) });
  assert.deepEqual(r, { ok: true, current: '0.4.0', latest: '0.5.0', updateAvailable: true });
});

test('check reports up to date', async () => {
  const r = await updateCheck.check('0.5.0', { fetchImpl: fakeFetch({ tag_name: 'v0.5.0' }) }) as UpToDate;
  assert.equal(r.ok, true);
  assert.equal(r.updateAvailable, false);
});

test('check survives API failure and bad payloads without throwing', async () => {
  assert.equal((await updateCheck.check('0.5.0', { fetchImpl: fakeFetch({}, 503) })).ok, false);
  assert.equal((await updateCheck.check('0.5.0', { fetchImpl: fakeFetch({ tag_name: 'not-a-version' }) })).ok, false);
  assert.equal((await updateCheck.check('0.5.0', { fetchImpl: async () => { throw new Error('offline'); } })).ok, false);
});
