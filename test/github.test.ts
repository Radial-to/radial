import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import * as github from '../src/main/github';
import * as publish from '../src/main/publish';
import type { PublishReceipt } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

/** Files to commit, by path relative to the repo. */
function gitRepo(files: Record<string, string>) {
  const dir = tmpDir('radial-gh-');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@e.com']);
  g(['config', 'user.name', 'T']);
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);
  return dir;
}

test('parseRepoUrl handles common forms', () => {
  assert.deepEqual(github.parseRepoUrl('https://github.com/acme-co/acme-site'), { owner: 'acme-co', repo: 'acme-site' });
  assert.deepEqual(github.parseRepoUrl('https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(github.parseRepoUrl('git@github.com:owner/repo.git'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(github.parseRepoUrl('https://github.com/owner/repo/tree/main/x'), { owner: 'owner', repo: 'repo' });
  assert.equal(github.parseRepoUrl('not a url'), null);
});

test('config defaults and round-trip', () => {
  const dir = gitRepo({ 'index.html': '<h1>x</h1>' });
  assert.equal(publish.readConfig(dir).productionPublish, 'direct');
  publish.writeConfig(dir, { productionPublish: 'pr' });
  assert.equal(publish.readConfig(dir).productionPublish, 'pr');
  assert.equal(publish.readConfig(dir).stagingBranch, 'staging');
});

test('ensureEditBranch creates the edit branch from main', async () => {
  const dir = gitRepo({ 'index.html': '<h1>x</h1>' });
  await publish.ensureEditBranch(dir, 'main', 'staging');
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).toString().trim();
  assert.equal(branch, 'staging');
});

test('staging publish without a remote saves locally without creating a staging mirror', async () => {
  const dir = gitRepo({ 'index.html': '<h1>x</h1>' });
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>edited</h1>');
  const res = await publish.publish(dir, { target: 'staging', push: true }) as PublishReceipt;
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'preview');
  assert.equal(res.branch, 'staging'); // the preview target
  assert.equal(res.from, 'main');      // where the work lives
  // You never leave your branch; the commit lands where you work.
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).toString().trim();
  assert.equal(branch, 'main');
  assert.match(execFileSync('git', ['show', 'main:index.html'], { cwd: dir }).toString(), /edited/);
  assert.equal(res.pushed, false);
  assert.equal(execFileSync('git', ['branch', '--list', 'staging'], { cwd: dir }).toString().trim(), '');
});

test('production (direct) from main commits and stays on main', async () => {
  const dir = gitRepo({ 'index.html': '<h1>x</h1>' });
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>live</h1>');
  const res = await publish.publish(dir, { target: 'production', push: false }) as PublishReceipt;
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'direct');
  // main now contains the edit — no merge dance, no branch switch
  assert.match(execFileSync('git', ['show', 'main:index.html'], { cwd: dir }).toString(), /live/);
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).toString().trim();
  assert.equal(branch, 'main');
});

test('production with push disabled saves the feature branch without changing main', async () => {
  const dir = gitRepo({ 'index.html': '<h1>x</h1>' });
  execFileSync('git', ['checkout', '-b', 'feature'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>live</h1>');
  const res = await publish.publish(dir, { target: 'production', push: false }) as PublishReceipt;
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'direct');
  assert.match(execFileSync('git', ['show', 'main:index.html'], { cwd: dir }).toString(), /<h1>x<\/h1>/);
  // returned to the branch you were working on
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).toString().trim();
  assert.equal(branch, 'feature');
});

test('production PR intent from main uses a distinct contribution branch name', async () => {
  const dir = gitRepo({ 'index.html': '<h1>x</h1>' });
  publish.writeConfig(dir, { productionPublish: 'pr' });
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>pr</h1>');
  const res = await publish.publish(dir, { target: 'production', push: true }) as PublishReceipt;
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'pr');
  assert.match(res.branch, /^radial\/update-/);
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).toString().trim();
  assert.equal(branch, 'main');
  assert.match(execFileSync('git', ['show', 'main:index.html'], { cwd: dir }).toString(), /pr/);
  assert.equal(res.pushed, false);
});

// ── collaborator helpers (pure mappers; gh itself isn't spawned in tests) ──

test('repoSlug reads owner/repo from a working copy origin', () => {
  const dir = tmpDir('radial-slug-');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'config'),
    '[remote "origin"]\n\turl = git@github.com:acme/site.git\n');
  assert.equal(github.repoSlug(dir), 'acme/site');
  assert.equal(github.repoSlug(tmpDir('radial-noslug-')), null);
});
