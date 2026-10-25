import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import * as publish from '../src/main/publish';
import type { CheckpointResult } from '../src/main/publish';
import type { BranchSwitchResult, IncomingPreview, IntegrationDone, IntegrationPaused, IntegrationResult, RepoSync } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

// Each test asserts which way the call went before it reads that side's fields.
type Switched = Extract<BranchSwitchResult, { ok: true }>;
type SwitchRefused = Extract<BranchSwitchResult, { ok: false }>;
/** A stash-and-switch whose carried edits clash with the target branch: switched, with the conflict left to resolve. */
type SwitchedWithConflict = Extract<BranchSwitchResult, { popConflict: true }>;
type IntegrationRefused = Extract<IntegrationResult, { ok: false }>;
type Snapshot = Extract<CheckpointResult, { commit: string }>;
type SnapshotSkipped = Extract<CheckpointResult, { skipped: 'clean' }>;
type SnapshotRefused = Extract<CheckpointResult, { ok: false }>;
/** A branch with an upstream to compare against. */
type Tracking = Extract<RepoSync, { ok: true; exists: true }>;
// A sync carries its incoming preview (a stash-and-switch has none, so the shared types leave it optional).
type Synced = IntegrationDone & IncomingPreview;
type SyncConflict = IntegrationPaused & IncomingPreview;

// A throwaway git repo with one commit on `main`.
function gitRepo() {
  const dir = tmpDir('radial-br-');
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return { dir, git };
}

test('listBranches reports the current branch and local branches', async () => {
  const { dir, git } = gitRepo();
  git(['branch', 'staging']);
  const res = await publish.listBranches(dir);
  assert.equal(res.ok, true);
  assert.equal(res.current, 'main');
  assert.ok(res.branches.includes('main'));
  assert.ok(res.branches.includes('staging'));
});

test('listBranches on a non-repo is a clean negative, not a throw', async () => {
  const dir = tmpDir('radial-br-');
  const res = await publish.listBranches(dir);
  assert.equal(res.ok, false);
  assert.deepEqual(res.branches, []);
});

test('switchBranch checks out an existing branch', async () => {
  const { dir, git } = gitRepo();
  git(['branch', 'staging']);
  const res = await publish.switchBranch(dir, 'staging') as Switched;
  assert.equal(res.ok, true);
  assert.equal(res.branch, 'staging');
  const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).toString().trim();
  assert.equal(head, 'staging');
});

test('switching to the branch you are already on is a no-op success', async () => {
  const { dir } = gitRepo();
  const res = await publish.switchBranch(dir, 'main') as Switched;
  assert.equal(res.ok, true);
  assert.equal(res.branch, 'main');
});

test('switchBranch to a nonexistent branch fails without changing HEAD', async () => {
  const { dir } = gitRepo();
  const res = await publish.switchBranch(dir, 'does-not-exist') as SwitchRefused;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'git-error');
  const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).toString().trim();
  assert.equal(head, 'main');
});

test('switchBranch carries non-conflicting local edits across the switch', async () => {
  const { dir, git } = gitRepo();
  git(['branch', 'staging']);
  // A new untracked file is non-conflicting — git keeps it across checkout.
  fs.writeFileSync(path.join(dir, 'draft.txt'), 'wip');
  const res = await publish.switchBranch(dir, 'staging');
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'draft.txt')));
});

test('switchBranch surfaces a real conflict as reason "conflict"', async () => {
  const { dir, git } = gitRepo();
  // Make the same file differ between branches, with an uncommitted change that
  // would be overwritten by the checkout — git aborts and we report it.
  git(['checkout', '-q', '-b', 'staging']);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>staging</h1>');
  git(['commit', '-q', '-am', 'staging change']);
  git(['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>uncommitted</h1>'); // dirty + differs
  const res = await publish.switchBranch(dir, 'staging') as SwitchRefused;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'conflict');
});

test('switchBranch with {stash} carries a blocking edit onto the target branch', async () => {
  const { dir, git } = gitRepo();
  // 'staging' has its own committed README; 'main' has an uncommitted edit to a
  // DIFFERENT file so the carried edit applies cleanly after the switch.
  git(['checkout', '-q', '-b', 'staging']);
  fs.writeFileSync(path.join(dir, 'staging-only.txt'), 'hi');
  git(['add', '-A']); git(['commit', '-q', '-m', 'staging file']);
  git(['checkout', '-q', 'main']);
  // Make index.html differ between branches AND be dirty so a plain checkout aborts.
  git(['checkout', '-q', '-b', 'staging2', 'staging']);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>staging</h1>');
  git(['commit', '-q', '-am', 'staging2 index']);
  git(['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>my edit</h1>'); // dirty + differs vs staging2
  const res = await publish.switchBranch(dir, 'staging2', { stash: true }) as SwitchedWithConflict;
  assert.equal(res.ok, true);
  assert.equal(res.branch, 'staging2');
  assert.equal(res.stashed, true);
  // The edit came along, with a conflict against staging2's version surfaced.
  assert.equal(res.popConflict, true);
  assert.ok(res.files.includes('index.html'));
});

test('pull without a remote reports no-remote', async () => {
  const { dir } = gitRepo();
  const res = await publish.pull(dir) as IntegrationRefused;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-remote');
});

test('pull on a non-repo reports not-a-repo', async () => {
  const dir = tmpDir('radial-br-');
  const res = await publish.pull(dir) as IntegrationRefused;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-a-repo');
});

test('checkpoint skips a clean tree', async () => {
  const { dir } = gitRepo();
  const res = await publish.checkpoint(dir) as SnapshotSkipped;
  assert.equal(res.ok, true);
  assert.equal(res.skipped, 'clean');
});

test('checkpoint snapshots a dirty tree to the autosave ref without moving the branch', async () => {
  const { dir } = gitRepo();
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>edited</h1>'); // tracked, dirty
  fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked too');      // untracked
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  const res = await publish.checkpoint(dir) as Snapshot;
  assert.equal(res.ok, true);
  assert.ok(res.commit);
  // The autosave ref now exists.
  const ref = execFileSync('git', ['rev-parse', '--verify', res.ref], { cwd: dir }).toString().trim();
  assert.equal(ref, res.commit);
  // The branch HEAD is untouched (autosave is a side ref, not a commit on main).
  const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  assert.equal(after, before);
  // The working tree still has the user's edits (autosave didn't reset anything).
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /edited/);
});

test('checkpoint on a non-repo reports not-a-repo', async () => {
  const dir = tmpDir('radial-br-');
  const res = await publish.checkpoint(dir) as SnapshotRefused;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-a-repo');
});

// --- which branch do edits land on? (the staging-migration logic) ----------

test('a repo on production main sends edits to the shared staging branch', async () => {
  const { dir } = gitRepo(); // on main
  const name = await publish.resolveEditBranchName(dir, publish.readConfig(dir));
  assert.equal(name, 'staging');
});

test("a team's own current branch is honored (not forced onto staging)", async () => {
  const { dir, git } = gitRepo();
  git(['checkout', '-q', '-b', 'develop']);
  const name = await publish.resolveEditBranchName(dir, publish.readConfig(dir));
  assert.equal(name, 'develop');
});

test('the legacy radial/staging branch migrates to the shared staging', async () => {
  const { dir, git } = gitRepo();
  git(['checkout', '-q', '-b', 'radial/staging']);
  const name = await publish.resolveEditBranchName(dir, publish.readConfig(dir));
  assert.equal(name, 'staging'); // never sticks on the old radial/ namespace
});

test('an explicitly configured staging branch wins regardless of current branch', async () => {
  const { dir, git } = gitRepo();
  git(['checkout', '-q', '-b', 'develop']);
  const cfg = { ...publish.readConfig(dir), stagingBranch: 'release' };
  const name = await publish.resolveEditBranchName(dir, cfg);
  assert.equal(name, 'release');
});

// --- sync with the remote -------------------------------------------------

test('syncStatus / sync report no-remote and not-a-repo cleanly', async () => {
  const { dir } = gitRepo(); // no origin
  assert.equal((await publish.syncStatus(dir)).reason, 'no-remote');
  assert.equal((await publish.sync(dir) as IntegrationRefused).reason, 'no-remote');
  const bare = tmpDir('radial-br-');
  assert.equal((await publish.syncStatus(bare)).reason, 'not-a-repo');
});

// A repo wired to a local bare "remote", plus a helper to push a commit to it
// as if a teammate / another tool did.
function repoWithRemote() {
  const remote = tmpDir('radial-remote-');
  execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: remote, stdio: 'pipe' });
  const { dir, git } = gitRepo();
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-u', '-q', 'origin', 'main']);
  return { dir, git, remote };
}
function pushUpstream(remote: string, file: string, body: string) {
  const work = tmpDir('radial-up-');
  const g = (args: string[]) => execFileSync('git', args, { cwd: work, stdio: 'pipe' });
  g(['clone', '-q', remote, '.']);
  g(['config', 'user.email', 'mate@example.com']); g(['config', 'user.name', 'Mate']);
  fs.writeFileSync(path.join(work, file), body);
  g(['add', '-A']); g(['commit', '-q', '-m', 'upstream change']); g(['push', '-q', 'origin', 'main']);
}

test('syncStatus detects when the remote is ahead', async () => {
  const { dir, remote } = repoWithRemote();
  let s = await publish.syncStatus(dir) as Tracking;
  assert.equal(s.ok, true); assert.equal(s.behind, 0);
  pushUpstream(remote, 'about.html', '<h1>about</h1>');
  s = await publish.syncStatus(dir) as Tracking;
  assert.equal(s.behind, 1); assert.equal(s.ahead, 0);
});

test('sync fast-forwards a clean tree to the latest', async () => {
  const { dir, remote } = repoWithRemote();
  pushUpstream(remote, 'about.html', '<h1>about</h1>');
  const res = await publish.sync(dir) as IntegrationDone;
  assert.equal(res.ok, true);
  assert.equal(res.pulled, 1);
  assert.ok(fs.existsSync(path.join(dir, 'about.html'))); // the incoming file landed
});

test('sync keeps local edits on top when the tree is dirty (no conflict)', async () => {
  const { dir, remote } = repoWithRemote();
  pushUpstream(remote, 'about.html', '<h1>about</h1>');   // touches a different file
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Local edit</h1>'); // dirty, non-conflicting
  const res = await publish.sync(dir) as IntegrationDone;
  assert.equal(res.ok, true);
  assert.equal(res.keptLocal, true);
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /Local edit/); // edit preserved
  assert.ok(fs.existsSync(path.join(dir, 'about.html')));                            // incoming applied
});

test('sync surfaces a conflict when local + incoming touch the same file', async () => {
  const { dir, remote } = repoWithRemote();
  pushUpstream(remote, 'index.html', '<h1>Remote version</h1>'); // same file...
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>My version</h1>'); // ...edited locally
  const res = await publish.sync(dir) as IntegrationPaused;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'conflict');
  assert.ok(res.files.includes('index.html'));
  // Resolving "mine" keeps the local edit and clears the conflict.
  const r = await publish.resolveSync(dir, 'mine');
  assert.equal(r.ok, true);
  assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /My version/);
});

test('sync reports the incoming commits and changed files (for the summary card)', async () => {
  const { dir, remote } = repoWithRemote();
  pushUpstream(remote, 'about.html', '<h1>about</h1>'); // a brand-new file
  const res = await publish.sync(dir) as Synced;
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.incoming) && res.incoming.length === 1);
  assert.equal(res.incoming[0].subject, 'upstream change');
  assert.equal(res.incoming[0].author, 'Mate');
  assert.ok(res.incoming[0].hash); // short hash present
  assert.ok(res.changed.some((c) => c.file === 'about.html' && c.status === 'A'));
});

test('sync names the in-flight local files it replayed on top', async () => {
  const { dir, remote } = repoWithRemote();
  pushUpstream(remote, 'about.html', '<h1>about</h1>'); // different file → no conflict
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Local edit</h1>');
  const res = await publish.sync(dir) as Synced;
  assert.equal(res.keptLocal, true);
  assert.ok(res.localFiles.includes('index.html'));         // what was carried across
  assert.ok(res.changed.some((c) => c.file === 'about.html')); // incoming preview still attached
});

test('a conflict result still carries the incoming preview + local files', async () => {
  const { dir, remote } = repoWithRemote();
  pushUpstream(remote, 'index.html', '<h1>Remote version</h1>');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>My version</h1>');
  const res = await publish.sync(dir) as SyncConflict;
  assert.equal(res.reason, 'conflict');
  assert.ok(res.incoming.length === 1);
  assert.ok(res.changed.some((c) => c.file === 'index.html'));
  assert.ok(res.localFiles.includes('index.html'));
});
