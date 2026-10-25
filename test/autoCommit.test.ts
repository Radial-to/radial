// LooseUnion, for the race test that reads a message across both calls'
// results, is the window's ambient type: no module exports it yet.
/// <reference path="../src/renderer/types.d.ts" />
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import * as publish from '../src/main/publish';
import type { AutoCommitResult, PublishReceipt, PublishResult, RepoStatus } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

// Each test asserts which way autoCommit or publish went before it reads that side's fields.
type AutoCommitted = Extract<AutoCommitResult, { committed: true }>;
type AutoSkipped = Extract<AutoCommitResult, { skipped: 'clean' }>;
type AutoRefused = Extract<AutoCommitResult, { ok: false }>;

// A throwaway git repo with one commit on `main`, identity configured.
function gitRepo() {
  const dir = tmpDir('radial-ac-');
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return { dir, git };
}
// Auto-commit only runs off production, so most tests work on a staging branch.
function repoOnStaging() {
  const r = gitRepo();
  r.git(['checkout', '-q', '-b', 'staging']);
  return r;
}
const body = (dir: string, ref = 'HEAD') => execFileSync('git', ['log', '-1', '--format=%B', ref], { cwd: dir }).toString();
const count = (dir: string, ref = 'HEAD') => parseInt(execFileSync('git', ['rev-list', '--count', ref], { cwd: dir }).toString().trim(), 10);
const head = (dir: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
const edit = (dir: string, body: string) => fs.writeFileSync(path.join(dir, 'index.html'), body);

// --- guards ---------------------------------------------------------------

test('autoCommit on a non-repo is a clean negative', async () => {
  const dir = tmpDir('radial-ac-');
  const res = await publish.autoCommit(dir, { force: true }) as AutoRefused;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-a-repo');
});

test('autoCommit skips a clean tree', async () => {
  const { dir } = repoOnStaging();
  const res = await publish.autoCommit(dir, { force: true }) as AutoSkipped;
  assert.equal(res.ok, true);
  assert.equal(res.skipped, 'clean');
});

test('autoCommit NEVER commits to the production branch', async () => {
  const { dir } = gitRepo(); // on main (production)
  edit(dir, '<h1>edited</h1>');
  const res = await publish.autoCommit(dir, { force: true }) as AutoRefused;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'production');
});

test('autoCommit skips a detached HEAD', async () => {
  const { dir, git } = repoOnStaging();
  git(['checkout', '-q', '--detach']);
  edit(dir, '<h1>edited</h1>');
  const res = await publish.autoCommit(dir, { force: true }) as AutoRefused;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'detached');
});

test('autoCommit respects the min-interval (force bypasses)', async () => {
  const { dir } = repoOnStaging();
  edit(dir, '<h1>v1</h1>');
  assert.equal((await publish.autoCommit(dir, { force: true }) as AutoCommitted).committed, true);
  edit(dir, '<h1>v2</h1>');
  const throttled = await publish.autoCommit(dir) as AutoRefused; // no force, within 60s
  assert.equal(throttled.ok, false);
  assert.equal(throttled.reason, 'min-interval');
  assert.equal((await publish.autoCommit(dir, { force: true }) as AutoCommitted).committed, true); // force overrides
});

test('autoCommit makes a distinct commit carrying the auto-save trailer', async () => {
  const { dir } = repoOnStaging();
  edit(dir, '<h1>edited</h1>');
  const res = await publish.autoCommit(dir, { force: true }) as AutoCommitted;
  assert.equal(res.committed, true);
  assert.equal(res.branch, 'staging');
  assert.match(body(dir), /Auto-Save: true/);
  assert.doesNotMatch(body(dir), /Radial/); // no Radial fingerprint in the commit
  assert.equal(count(dir), 2); // init + the auto-commit
});

test('autoCommit derives its subject from the changed files (no agent)', async () => {
  const { dir } = repoOnStaging();
  edit(dir, '<h1>edited</h1>');
  const res = await publish.autoCommit(dir, { force: true }) as AutoCommitted;
  assert.equal(res.committed, true);
  assert.match(body(dir), /^Update /);
  assert.match(body(dir), /Auto-Save: true/);
});

test('subjectFromStatus names one, two, and many files', () => {
  assert.equal(publish.subjectFromStatus(' M src/index.html'), 'Update index.html');
  assert.equal(publish.subjectFromStatus(' M a/hero.html\n M css/site.css'), 'Update hero.html and site.css');
  assert.equal(
    publish.subjectFromStatus(' M hero.html\n M site.css\nA  new.js\n?? extra.txt'),
    'Update hero.html, site.css and 2 more files'
  );
  assert.equal(publish.subjectFromStatus('R  old.html -> pages/renamed.html'), 'Update renamed.html');
  assert.equal(publish.subjectFromStatus(''), '');
});

test('autoCommit commits even with no configured git identity (fallback)', async () => {
  const prevG = process.env.GIT_CONFIG_GLOBAL, prevS = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  try {
    const { dir, git } = repoOnStaging();
    git(['config', '--unset', 'user.name']);
    git(['config', '--unset', 'user.email']);
    edit(dir, '<h1>edited</h1>');
    const res = await publish.autoCommit(dir, { force: true }) as AutoCommitted;
    assert.equal(res.committed, true);
    const author = execFileSync('git', ['log', '-1', '--format=%an'], { cwd: dir }).toString().trim();
    // The fallback identity is the OS user — never "Radial" — so the repo carries no record.
    assert.equal(author, os.userInfo().username);
    assert.notEqual(author, 'Radial');
  } finally {
    if (prevG === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevG;
    if (prevS === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = prevS;
  }
});

// --- squash on Publish ----------------------------------------------------

test('Publish preserves existing auto-save commits unless squash is explicitly requested', async () => {
  const { dir } = repoOnStaging();
  for (const v of ['a', 'b', 'c']) { edit(dir, `<h1>${v}</h1>`); assert.equal((await publish.autoCommit(dir, { force: true }) as AutoCommitted).committed, true); }
  assert.equal(count(dir), 4); // init + 3 auto
  const res = await publish.publish(dir, { target: 'staging', message: 'Publish my edits' }) as PublishReceipt;
  assert.equal(res.ok, true);
  assert.ok(!res.steps.includes('squashed auto-saves'));
  assert.equal(count(dir), 4);
  assert.match(body(dir), /Auto-Save: true/);
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /c/); // content preserved
});

test('Publish with no auto-run is a normal single commit (squash no-op)', async () => {
  const { dir } = repoOnStaging();
  edit(dir, '<h1>just dirty</h1>'); // no auto-commits, just uncommitted edits
  const res = await publish.publish(dir, { target: 'staging', message: 'Publish' }) as PublishReceipt;
  assert.equal(res.ok, true);
  assert.ok(!res.steps.includes('squashed auto-saves'));
  assert.equal(count(dir), 2);
});

// --- the A-over-B proof + mutex ------------------------------------------

function repoWithRemote() {
  const remote = tmpDir('radial-acrem-');
  execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: remote, stdio: 'pipe' });
  const { dir, git } = gitRepo();
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-u', '-q', 'origin', 'main']);
  git(['checkout', '-q', '-b', 'staging']);
  return { dir, git, remote };
}

test('CRITICAL: publish -> edit -> auto-commit -> publish AGAIN pushes (fast-forward)', async () => {
  // This is the exact loop rolling-amend (model B) would break: amend would
  // rewrite the already-pushed commit and the second non-force push would reject.
  // Model A only ever adds/squashes UNPUSHED commits, so the push stays ff.
  const { dir } = repoWithRemote();
  edit(dir, '<h1>v1</h1>');
  assert.equal((await publish.autoCommit(dir, { force: true }) as AutoCommitted).committed, true);
  const p1 = await publish.publish(dir, { target: 'staging', message: 'Publish v1' }) as PublishReceipt;
  assert.equal(p1.ok, true);
  assert.equal(p1.pushed, true);

  edit(dir, '<h1>v2</h1>');
  assert.equal((await publish.autoCommit(dir, { force: true }) as AutoCommitted).committed, true); // auto-commit ON TOP of a pushed commit
  const p2 = await publish.publish(dir, { target: 'staging', message: 'Publish v2' }) as PublishReceipt;
  assert.equal(p2.ok, true);
  assert.equal(p2.pushed, true); // <-- would be false / throw under model B
});

test('auto-commit and Publish racing the same repo never collide on index.lock', async () => {
  const { dir } = repoWithRemote();
  edit(dir, '<h1>racing</h1>');
  // Fire both at once; the per-repo lock serializes them.
  const [a, b] = await Promise.all([
    publish.autoCommit(dir, { force: true }),
    publish.publish(dir, { target: 'staging', message: 'Race publish' }),
  ]);
  // Either may be a failure with a message; the members without one read it as undefined.
  for (const r of [a, b] as LooseUnion<AutoCommitResult | PublishResult>[]) {
    if (r && r.message) assert.doesNotMatch(r.message, /index\.lock|Unable to create/i);
  }
  assert.equal(b.ok, true);       // Publish succeeded despite the concurrent auto-commit
  assert.ok(head(dir));           // repo left in a valid state
  assert.equal((await publish.status(dir) as RepoStatus).changes.length, 0); // tree committed, nothing stranded
});
