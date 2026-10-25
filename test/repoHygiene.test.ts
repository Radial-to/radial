// Publish must self-heal a repo so a deploy can't choke on committed build junk:
// a stray `.next/`, `dist/`, or vendored `node_modules/` that a blanket `git add
// -A` swept in. (A committed `.next` on a plain static site makes Vercel assume a
// Next App-Router project and the deploy dies hunting for an `app/` dir that
// doesn't exist — "ENOENT … scandir …/app".)

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import * as publish from '../src/main/publish';
import type { PublishReceipt } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

// A throwaway repo on `staging` (auto-commit/publish only run off production),
// with a build dir committed by mistake and no .gitignore.
function dirtyRepo() {
  const dir = tmpDir('radial-hyg-');
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  fs.mkdirSync(path.join(dir, '.next', 'server', 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.next', 'server', 'app', 'page.js'), 'module.exports = {}');
  fs.mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), '');
  git(['add', '-A']); // sweeps in .next + node_modules — the bug
  git(['commit', '-q', '-m', 'init']);
  git(['checkout', '-q', '-b', 'staging']);
  return { dir, git };
}
const tracked = (dir: string) => execFileSync('git', ['ls-files'], { cwd: dir }).toString().split('\n').filter(Boolean);

test('ensureRepoHygiene untracks committed build artifacts and writes .gitignore', async () => {
  const { dir } = dirtyRepo();
  assert.ok(tracked(dir).some((f) => f.startsWith('.next/')), 'precondition: .next is tracked');

  const note = await publish.ensureRepoHygiene(dir);
  assert.deepEqual(note.untracked.sort(), ['.next', 'node_modules']);

  const now = tracked(dir);
  assert.ok(!now.some((f) => f.startsWith('.next/')), '.next untracked');
  assert.ok(!now.some((f) => f.startsWith('node_modules/')), 'node_modules untracked');
  assert.ok(now.includes('index.html'), 'real source stays tracked');

  // Working copy is preserved — we only stop shipping it, never delete it.
  assert.ok(fs.existsSync(path.join(dir, '.next', 'server', 'app', 'page.js')), '.next kept on disk');

  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.ok(gi.includes('.next/') && gi.includes('node_modules/'), '.gitignore covers them now');
});

test('ensureGitignoreLines is idempotent and preserves user entries', () => {
  const dir = tmpDir('radial-hyg-');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.next/\n# mine\nsecret.env\n');
  const added = publish.ensureGitignoreLines(dir);
  assert.ok(!added.includes('.next/'), 'does not re-add an existing entry');
  assert.ok(added.includes('dist/'), 'adds the ones that were missing');
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.ok(gi.includes('secret.env') && gi.includes('# mine'), 'user lines preserved');
  assert.deepEqual(publish.ensureGitignoreLines(dir), [], 'second run is a no-op');
});

test('publish does not silently remove tracked artifacts or rewrite configuration', async () => {
  const { dir } = dirtyRepo();
  const res = await publish.publish(dir, { target: 'staging', push: false }) as PublishReceipt;
  assert.equal(res.ok, true);
  assert.ok(!res.steps.some(s => /build artifacts/.test(s)));
  const now = tracked(dir);
  assert.ok(now.some(f => f.startsWith('.next/')), 'tracked files are preserved');
  assert.ok(!now.includes('.gitignore'), 'publish does not add configuration implicitly');
});
