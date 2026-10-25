import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import * as github from '../src/main/github';
import * as context from '../src/main/context';
import type { ConnectRepoResult } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

function tmp() { return tmpDir('radial-gh-'); }
const gitOut = (dir: string, args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

test('ensureGitRepo inits a fresh folder on a main branch', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>\n');

  const r = await github.ensureGitRepo(dir);
  assert.equal(r.created, true);
  assert.ok(fs.existsSync(path.join(dir, '.git')), '.git created');
  // HEAD points at main even before the first commit.
  assert.equal(gitOut(dir, ['symbolic-ref', '--short', 'HEAD']), 'main');
});

test('ensureGitRepo is idempotent on an existing repo', async () => {
  const dir = tmp();
  execFileSync('git', ['init'], { cwd: dir });

  const r = await github.ensureGitRepo(dir);
  assert.equal(r.created, false, 'does not re-init an existing repo');
});

test('connectExisting rejects a non-GitHub URL before touching git', async () => {
  const dir = tmp(); // not a git repo
  const res = await github.connectExisting({ dir, url: 'not a url' }) as Extract<ConnectRepoResult, { ok: false }>;
  assert.equal(res.ok, false);
  assert.ok(/github repo url/i.test(res.error));
  assert.ok(!fs.existsSync(path.join(dir, '.git')), 'bad URL never initialises git');
});

test('the first commit excludes node_modules, .radial and .vercel', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>\n');
  // Stuff that must never land in the new repo.
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
  fs.mkdirSync(path.join(dir, '.radial'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.radial', 'comments.json'), '[]');
  fs.mkdirSync(path.join(dir, '.vercel'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.vercel', 'project.json'), '{}');

  // openRepo writes the ignore policy (.radial/.vercel) before any connect.
  context.ensureIgnores(dir);
  await github.ensureGitRepo(dir);
  await github.ensureInitialCommit(dir);

  const tracked = gitOut(dir, ['ls-files']).split('\n').filter(Boolean);
  assert.ok(tracked.includes('index.html'), 'site files are committed');
  assert.ok(!tracked.some((f) => f.startsWith('node_modules/')), 'no node_modules');
  assert.ok(!tracked.some((f) => f.startsWith('.radial/')), 'no .radial working data');
  assert.ok(!tracked.some((f) => f.startsWith('.vercel/')), 'no .vercel link');
});
