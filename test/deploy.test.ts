// Real build checks and retained local commits on failure.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import * as deploy from '../src/main/deploy';
import { which } from '../src/main/env';
import type { DeployEvent, PublishOutcome } from '../src/main/deploy';
import type { PublishDeployResult } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

/** A publish that failed once git had run (a red build, a rejected push, a git error), with the receipt's fields where it got that far. */
type DeployFailed = Extract<PublishDeployResult, { ok: false; steps: string[] }>;

const HAS_NPM = !!which('npm');

function repo() {
  const dir = tmpDir('radial-dep-');
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  return { dir, git, commit: (m: string) => { git(['add', '-A']); git(['commit', '-q', '-m', m]); } };
}
const w = (dir: string, rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };

// A node project whose build only succeeds when a file named OK is present.
function nodeProject(dir: string) {
  w(dir, 'package.json', JSON.stringify({ name: 'site', version: '1.0.0', scripts: { start: 'node server.js', build: 'node build.js' } }, null, 2));
  w(dir, 'build.js', "process.exit(require('fs').existsSync('OK') ? 0 : 1);");
  w(dir, 'index.html', '<h1>hi</h1>');
}

test('static site skips the build gate and publishes', async () => {
  const { dir, commit } = repo();
  w(dir, 'index.html', '<h1>hello</h1>');
  commit('init');
  const events: DeployEvent[] = [];
  const res = await deploy.publishAndDeploy(dir, { target: 'staging', push: true }, { onEvent: (e) => events.push(e) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.deploy.gate, 'skipped');
  assert.ok(events.some((e) => e.kind === 'gate' && e.status === 'skipped'));
});

test('a passing build is gated then published, no fixer needed', { skip: !HAS_NPM && 'npm not on PATH' }, async () => {
  const { dir, commit } = repo();
  nodeProject(dir);
  w(dir, 'OK', ''); // build will pass
  commit('init');
  const events: DeployEvent[] = [];
  const res = await deploy.publishAndDeploy(dir, { target: 'staging', push: true }, { onEvent: (e) => events.push(e) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.deploy.gate, 'ok');
  assert.equal(events.filter((e) => e.kind === 'gate').length, 1, 'built once');
});

test('a failed candidate remains local and never starts an automatic agent fix', { skip: !HAS_NPM && 'npm not on PATH' }, async () => {
  const { dir, git, commit } = repo();
  nodeProject(dir);
  commit('init');
  const before = git(['rev-parse', 'HEAD']).toString().trim();
  const events: DeployEvent[] = [];
  const res = await deploy.publishAndDeploy(dir, { target: 'staging', push: true }, { onEvent: (e) => events.push(e) }) as DeployFailed;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'build-failed');
  assert.equal(res.pushed, false);
  // A fix round would change the project and build it again.
  assert.equal(events.filter((e) => e.kind === 'gate').length, 1, 'built once, no fix-and-rebuild round');
  assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), before, 'no fix was committed');
  assert.ok(res.deploy.log);
  assert.ok(res.sha, 'the saved candidate can be inspected and retried');
});

test('detectBuild classifies projects', () => {
  const { dir } = repo();
  w(dir, 'index.html', '<h1>x</h1>');
  assert.equal(deploy.detectBuild(dir).kind, 'static');
  nodeProject(dir);
  assert.equal(deploy.detectBuild(dir).kind, 'node');
  // node project without a build script can't be gated
  w(dir, 'package.json', JSON.stringify({ name: 's', version: '1', scripts: { start: 'node s.js' } }));
  assert.equal(deploy.detectBuild(dir).kind, 'no-build-script');
});

test('buildFixPrompt carries the command and log', () => {
  const p = deploy.buildFixPrompt('npm run build', 'Error: Cannot find module "react"');
  assert.match(p, /npm run build/);
  assert.match(p, /Cannot find module/);
  assert.match(p, /do not delete the build\/cache dir/i);
});

test('classifyPublishError routes push rejections', () => {
  const big: PublishOutcome = { ok: false, reason: 'git-error', message: "remote: error: File node_modules/x.node is 116 MB; this exceeds GitHub's file size limit of 100.00 MB\nGH001: Large files detected." };
  assert.deepEqual(deploy.classifyPublishError(big), { fixable: true, kind: 'large-file' });
  assert.equal(deploy.classifyPublishError({ ok: false, message: 'Updates were rejected because the tip of your current branch is behind' }).kind, 'non-ff');
  assert.equal(deploy.classifyPublishError({ ok: false, message: 'fatal: Authentication failed for https://github.com/x' }).fixable, false);
  assert.equal(deploy.classifyPublishError({ ok: true }).fixable, false);
});

test('pushFixPrompt for a large file targets history, not just the tip', () => {
  const p = deploy.pushFixPrompt('large-file', "File node_modules/x.node is 116 MB; exceeds GitHub's file size limit", { target: 'production' });
  assert.match(p, /history/i);
  assert.match(p, /filter-repo|interactive rebase/i);
  assert.match(p, /\.gitignore/);
  assert.match(p, /do NOT use Git LFS/i);
});

test('a rejected push preserves history and does not automatically rewrite it', { skip: !HAS_NPM && 'npm not on PATH' }, async () => {
  const { dir, git, commit } = repo();
  // A bare "remote" we can actually push to, with a pre-receive hook that rejects
  // any pushed blob over ~1MB — standing in for GitHub's 100MB limit.
  const remote = tmpDir('radial-remote-');
  execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe' });
  const hook = path.join(remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook,
    '#!/bin/sh\n' +
    'while read old new ref; do\n' +
    '  for sha in $(git rev-list "$new" 2>/dev/null); do\n' +
    '    for blob in $(git ls-tree -r --long "$sha" 2>/dev/null | awk \'$4 > 1000000 {print $3}\'); do\n' +
    '      echo "remote: error: large file detected; GH001: Large files detected." 1>&2; exit 1\n' +
    '    done\n' +
    '  done\n' +
    'done\nexit 0\n');
  fs.chmodSync(hook, 0o755);

  // index.html committed and pushed clean first (so origin/main is a base).
  w(dir, 'index.html', '<h1>site</h1>');
  commit('init');
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-q', '-u', 'origin', 'main']);

  // Now a later commit drags in a "node_modules" blob over the limit (the bug) —
  // as an auto-save on the edit branch would in the real flow.
  w(dir, 'node_modules/big/blob.node', 'x'.repeat(1_500_000));
  commit('add deps by mistake');

  const before = git(['rev-parse', 'HEAD']).toString().trim();
  const events: DeployEvent[] = [];
  const res = await deploy.publishAndDeploy(dir, { target: 'staging', push: true }, { onEvent: (e) => events.push(e) }) as DeployFailed;
  assert.equal(res.ok, false);
  assert.equal(res.pushed, false);
  // Each push attempt checks the candidate first: one check, one attempt.
  assert.equal(events.filter((e) => e.kind === 'gate').length, 1, 'pushed once, no fix-and-retry round');
  assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), before);
  assert.match(res.message, /large file/i);
});
