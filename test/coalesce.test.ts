import { test } from 'node:test';
import assert from 'node:assert';

import { makeCoalescer } from '../src/main/coalesce';

// Resolve `fn` only when we say so, so we can hold several calls "in flight".
function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('concurrent calls for the same key run fn once and share the result', async () => {
  const coalesce = makeCoalescer();
  let runs = 0;
  const d = deferred();
  const fn = () => { runs++; return d.promise; };

  // Three opens of the same project while the first is still booting.
  const a = coalesce('repo', fn);
  const b = coalesce('repo', fn);
  const c = coalesce('repo', fn);

  assert.equal(runs, 1, 'fn runs exactly once — no duplicate dev server spawned');
  d.resolve('url');
  assert.deepEqual(await Promise.all([a, b, c]), ['url', 'url', 'url']);
});

test('different keys run independently', async () => {
  const coalesce = makeCoalescer();
  let runs = 0;
  const fn = () => { runs++; return Promise.resolve('x'); };
  await Promise.all([coalesce('a', fn), coalesce('b', fn)]);
  assert.equal(runs, 2);
});

test('key is freed after settle so a later call runs fresh', async () => {
  const coalesce = makeCoalescer();
  let runs = 0;
  const fn = () => { runs++; return Promise.resolve('x'); };

  await coalesce('repo', fn);
  assert.equal(coalesce.has('repo'), false, 'freed once settled');
  await coalesce('repo', fn);
  assert.equal(runs, 2, 'a sequential second open re-runs fn');
});

test('a rejection frees the key and propagates to every caller', async () => {
  const coalesce = makeCoalescer();
  let runs = 0;
  const d = deferred();
  const fn = () => { runs++; return d.promise; };

  const a = coalesce('repo', fn);
  const b = coalesce('repo', fn);
  assert.equal(runs, 1);
  d.reject(new Error('boom'));

  await assert.rejects(a, /boom/);
  await assert.rejects(b, /boom/);
  assert.equal(coalesce.has('repo'), false, 'a failed open does not wedge the key');

  // After failure, retrying actually retries.
  const c = coalesce('repo', () => Promise.resolve('ok'));
  assert.equal(await c, 'ok');
});

test('a synchronous throw in fn is captured, not leaked, and frees the key', async () => {
  const coalesce = makeCoalescer();
  const p = coalesce('repo', () => { throw new Error('sync'); });
  await assert.rejects(p, /sync/);
  assert.equal(coalesce.has('repo'), false);
});
