// Where a publish would push (publish.ts destination), which the control
// server reads before an agent's publish: one that lands on the production
// branch needs --yes, whatever --to named it, including `branch` while the
// current branch is production.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import * as publish from '../src/main/publish';
import { tmpDir } from './support/tmp';

function gitRepo() {
  const dir = tmpDir('radial-dest-');
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return { dir, git };
}

test('on the production branch, publishing the current branch lands on production', async () => {
  const { dir } = gitRepo();
  assert.deepEqual(await publish.destination(dir, 'branch'), { branch: 'main', production: true });
  assert.deepEqual(await publish.destination(dir, 'production'), { branch: 'main', production: true });
  assert.deepEqual(await publish.destination(dir, 'staging'), { branch: 'staging', production: false }, 'staging never picks the production branch it is on');
});

test('on another branch, branch and staging stay off production', async () => {
  const { dir, git } = gitRepo();
  git(['checkout', '-q', '-b', 'feature/hero']);
  assert.deepEqual(await publish.destination(dir, 'branch'), { branch: 'feature/hero', production: false });
  assert.deepEqual(await publish.destination(dir, 'staging'), { branch: 'feature/hero', production: false });
  assert.deepEqual(await publish.destination(dir, 'production'), { branch: 'main', production: true });
});

test('a staging branch set to the production branch counts as production', async () => {
  const { dir, git } = gitRepo();
  git(['checkout', '-q', '-b', 'feature/hero']);
  publish.writeConfig(dir, { stagingBranch: 'main' });
  assert.deepEqual(await publish.destination(dir, 'staging'), { branch: 'main', production: true });
});
