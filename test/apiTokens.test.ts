// radial serve's API tokens (src/headless/apiTokens.ts): made once and shown
// once, kept only as a SHA-256 in a 0600 file, checked against every stored
// hash, revoked from the next request on (and an open stream's within the
// watch interval), last use noted apart from the tokens, and `radial token`
// as the CLI runs it. test/headlessRemote.e2e.mts uses them against a real serve.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import * as apiTokens from '../src/headless/apiTokens';
import { tmpDir } from './support/tmp';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The CLI's io for `radial token …` on a data dir, and what it printed. */
function io(dataDir: string) {
  let out = '', err = '';
  return { stdout: { write: (s: string) => { out += s; } }, stderr: { write: (s: string) => { err += s; } }, env: { RADIAL_DATA_DIR: dataDir } as NodeJS.ProcessEnv, out: () => out, err: () => err };
}

test('a token is rcore_ and 43 random characters, shown once; the data dir keeps its hash in a 0600 file, never the token', () => {
  const dataDir = tmpDir('rtok-');
  const made = apiTokens.create(dataDir, 'laptop', 1000);
  assert.ok(made.ok);
  assert.match(made.token, /^rcore_[A-Za-z0-9_-]{43}$/);
  assert.ok(!made.token.startsWith('rad_'), 'apart from Radial Cloud’s');
  assert.deepEqual([made.row.name, made.row.prefix, made.row.createdAt, made.row.lastUsedAt], ['laptop', made.token.slice(0, 10), 1000, null]);
  const file = apiTokens.tokensFile(dataDir);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(made.token), 'the token itself is nowhere on disk');
  assert.ok(text.includes(apiTokens.hashToken(made.token)), 'its SHA-256 is');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = apiTokens.create(dataDir, 'ci');
  assert.ok(again.ok && again.token !== made.token, 'each one new');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'still 0600 after a rewrite');
  assert.deepEqual(fs.readdirSync(dataDir).sort(), ['api-tokens.json'], 'no temporary file left behind');
});

test('names: unique, letters and the like, token-1, token-2… when none is given', () => {
  const dataDir = tmpDir('rtok-');
  assert.equal((apiTokens.create(dataDir) as { row: { name: string } }).row.name, 'token-1');
  assert.equal((apiTokens.create(dataDir, null) as { row: { name: string } }).row.name, 'token-2');
  assert.ok(apiTokens.create(dataDir, 'laptop').ok);
  assert.deepEqual(apiTokens.create(dataDir, 'laptop'), { ok: false, code: 'exists', error: 'There is already a token named laptop. Pick another name, or revoke that one first (radial token revoke laptop).' });
  for (const bad of ['two words', 'a/b', 'x'.repeat(41), '$(rm)']) assert.equal((apiTokens.create(dataDir, bad) as { code?: string }).code, 'bad-request', bad);
  assert.deepEqual(apiTokens.list(dataDir).map((t) => t.name), ['token-1', 'token-2', 'laptop']);
});

test('a request’s token: none, the wrong scheme, a malformed or unknown one, and a good one; checked against every stored hash', () => {
  const dataDir = tmpDir('rtok-');
  const a = apiTokens.create(dataDir, 'a'), b = apiTokens.create(dataDir, 'b');
  assert.ok(a.ok && b.ok);
  const store = apiTokens.store(dataDir, { now: () => 5000 });
  try {
    assert.deepEqual(store.check(undefined), { ok: false, why: 'missing' });
    assert.deepEqual(store.check(`Basic ${a.token}`), { ok: false, why: 'missing' }, 'only a Bearer token counts');
    assert.deepEqual(store.check('Bearer'), { ok: false, why: 'missing' });
    assert.deepEqual(store.check('Bearer rcore_short'), { ok: false, why: 'invalid' });
    assert.deepEqual(store.check(`Bearer ${a.token.slice(0, -1)}x`), { ok: false, why: 'invalid' }, 'one character off');
    assert.deepEqual(store.check(`Bearer rad_${a.token.slice(6)}`), { ok: false, why: 'invalid' }, 'a Radial Cloud token is not one');
    assert.deepEqual(store.check(`bearer   ${b.token}  `), { ok: true, id: b.row.id, name: 'b' }, 'the scheme in any case, spaces around');
    assert.deepEqual(store.check([`Bearer ${a.token}`]), { ok: true, id: a.row.id, name: 'a' });
    assert.equal(store.count(), 2);
    assert.equal(apiTokens.bearer('Bearer abc'), 'abc'); assert.equal(apiTokens.bearer('Bearer a b'), null);
  } finally { store.close(); }
  // When each was last used goes in its own file, which list reads; the tokens file isn't touched.
  const before = fs.readFileSync(apiTokens.tokensFile(dataDir), 'utf8');
  assert.deepEqual(apiTokens.list(dataDir).map((t) => [t.name, t.lastUsedAt]), [['a', 5000], ['b', 5000]]);
  assert.equal(fs.readFileSync(apiTokens.tokensFile(dataDir), 'utf8'), before);
});

test('a revoke takes effect at the next request, and watchers hear of it within the watch interval', async () => {
  const dataDir = tmpDir('rtok-');
  const a = apiTokens.create(dataDir, 'a'), b = apiTokens.create(dataDir, 'b');
  assert.ok(a.ok && b.ok);
  const store = apiTokens.store(dataDir, { watchMs: 20 });
  let heard = 0;
  const stop = store.onChange(() => { heard++; });
  try {
    assert.ok(store.check(`Bearer ${a.token}`).ok);
    assert.ok(store.isLive(a.row.id));
    // `radial token revoke`, as another process runs it: by name, then by id.
    assert.deepEqual(apiTokens.revoke(dataDir, 'a'), { ok: true, row: { id: a.row.id, name: 'a', prefix: a.row.prefix, createdAt: a.row.createdAt, lastUsedAt: null } });
    assert.deepEqual(store.check(`Bearer ${a.token}`), { ok: false, why: 'invalid' }, 'refused at once');
    assert.equal(store.isLive(a.row.id), false);
    assert.ok(store.check(`Bearer ${b.token}`).ok, 'the other one still works');
    assert.ok(apiTokens.revoke(dataDir, b.row.id).ok);
    for (let i = 0; i < 50 && heard < 2; i++) await sleep(20);
    assert.ok(heard >= 1, 'the watch heard the file change');
    assert.equal(store.isLive(b.row.id), false);
    assert.deepEqual(apiTokens.revoke(dataDir, 'nobody'), { ok: false, code: 'not-found', error: 'No token nobody. radial token list shows them.' });
    stop();
  } finally { store.close(); }
  // Last use is never written back for a token that's gone.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'api-tokens-used.json'), 'utf8')), {});
});

test('a change is told to the watchers whoever notices it first: a revoke that isLive finds still ends the streams', () => {
  const dataDir = tmpDir('rtok-');
  const a = apiTokens.create(dataDir, 'a');
  assert.ok(a.ok);
  const store = apiTokens.store(dataDir, { watchMs: 60_000 }); // no watch tick within the test: only the calls notice
  let heard = 0;
  store.onChange(() => { heard++; assert.equal(store.isLive(a.row.id), false, 'a listener’s own check sees the new file'); });
  try {
    apiTokens.revoke(dataDir, 'a');
    assert.equal(store.isLive(a.row.id), false);
    assert.equal(heard, 1, 'isLive noticed it, and the listeners heard');
    assert.equal(store.count(), 0);
    assert.equal(heard, 1, 'once');
  } finally { store.close(); }
});

test('two token commands at once take turns, so a create can’t write back a token another just revoked; a lock left by a dead command goes', async () => {
  const dataDir = tmpDir('rtok-');
  assert.ok(apiTokens.create(dataDir, 'first').ok);
  const lock = apiTokens.tokensFile(dataDir) + '.lock';
  // Another command holds the file for a moment (a separate process, as a second `radial token` would be).
  const holder = spawn(process.execPath, ['-e', `const fs = require('fs'); fs.mkdirSync(${JSON.stringify(lock)}); setTimeout(() => fs.rmdirSync(${JSON.stringify(lock)}), 400);`]);
  for (let i = 0; i < 100 && !fs.existsSync(lock); i++) await sleep(10);
  assert.ok(fs.existsSync(lock), 'the other command holds it');
  const t0 = Date.now();
  const made = apiTokens.create(dataDir, 'second');
  assert.ok(made.ok, JSON.stringify(made));
  assert.ok(Date.now() - t0 >= 150, 'it waited its turn');
  await new Promise((resolve) => holder.on('exit', resolve));
  assert.deepEqual(apiTokens.list(dataDir).map((t) => t.name), ['first', 'second']);
  // A lock older than 10 s was left by a command that died: it goes, and the revoke goes ahead.
  fs.mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.ok(apiTokens.revoke(dataDir, 'first').ok);
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(apiTokens.list(dataDir).map((t) => t.name), ['second']);
});

test('radial token create prints the token once and how to use it; list never shows it; revoke says so; exit codes', async () => {
  const dataDir = tmpDir('rtok-');
  const made = io(dataDir);
  assert.equal(await apiTokens.command(['create', 'laptop'], {}, made, 'http://127.0.0.1:4000'), 0);
  const token = made.out().split('\n').find((l) => /^rcore_/.test(l))!;
  assert.match(token, /^rcore_[A-Za-z0-9_-]{43}$/);
  assert.match(made.out(), /^Made the token laptop \(rcore_.{4}…\)\. It shows only now, so keep it somewhere safe:/);
  assert.match(made.out(), /RADIAL_URL=http:\/\/127\.0\.0\.1:4000 RADIAL_TOKEN=<the token> radial ls/);
  assert.match(made.out(), /http:\/\/127\.0\.0\.1:4000\/mcp, with the header Authorization: Bearer <the token>/);
  const json = io(dataDir);
  assert.equal(await apiTokens.command(['create', 'ci'], { json: true }, json), 0);
  const ci = JSON.parse(json.out()) as { ok: true; token: string; id: string; name: string };
  assert.equal(ci.name, 'ci'); assert.match(ci.token, /^rcore_/);
  const listed = io(dataDir);
  assert.equal(await apiTokens.command(['list'], {}, listed), 0);
  assert.ok(!listed.out().includes(token) && !listed.out().includes(ci.token), 'no token in the list');
  assert.match(listed.out(), /^laptop {2}[0-9a-f]{8} {2}rcore_.{4}… {2}made \d{4}-\d\d-\d\d \d\d:\d\d, never used\nci {6}/);
  const dup = io(dataDir);
  assert.equal(await apiTokens.command(['create', 'ci'], {}, dup), 6);
  assert.match(dup.err(), /^radial: There is already a token named ci\./);
  const revoked = io(dataDir);
  assert.equal(await apiTokens.command(['revoke', 'laptop'], {}, revoked), 0);
  assert.match(revoked.out(), /^Revoked laptop \([0-9a-f]{8}\)\. radial serve refuses it from now on\.\n$/);
  assert.equal(await apiTokens.command(['revoke', 'laptop'], {}, io(dataDir)), 3);
  assert.equal(await apiTokens.command(['revoke'], {}, io(dataDir)), 2);
  assert.equal(await apiTokens.command(['rotate'], {}, io(dataDir)), 2);
  const empty = io(tmpDir('rtok-'));
  assert.equal(await apiTokens.command(['list'], {}, empty), 0);
  assert.match(empty.out(), /^No tokens yet\. `radial token create <name>` makes one/);
});
