import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as github from '../src/main/github';
import * as recents from '../src/main/recents';
import * as projectState from '../src/main/projectState';
import * as devPids from '../src/main/devPids';
import { tmpDir } from './support/tmp';

const tmp = (p: string) => tmpDir(p);

// A fake working copy: enough .git for origin detection, no real git needed.
function fakeClone(parent: string, name: string, originUrl: string) {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  return dir;
}

test('repoIdent normalizes ssh/https/.git spellings to one identity', () => {
  const want = 'acme-co/marketing-site';
  assert.equal(github.repoIdent('https://github.com/acme-co/marketing-site'), want);
  assert.equal(github.repoIdent('https://github.com/acme-co/marketing-site.git'), want);
  assert.equal(github.repoIdent('git@github.com:acme-co/marketing-site.git'), want);
  assert.equal(github.repoIdent('https://github.com/Acme-Co/Marketing-Site'), want);
  assert.equal(github.repoIdent('not a url'), null);
});

test('findLocalCopy prefers paths Radial already knows', () => {
  const root = tmp('flc-known-');
  const mine = fakeClone(root, 'my-site', 'git@github.com:zz-fake-owner-a1b2/zz-fake-repo-a1b2.git');
  const other = fakeClone(root, 'other', 'git@github.com:someone/else.git');
  const found = github.findLocalCopy('https://github.com/zz-fake-owner-a1b2/zz-fake-repo-a1b2', {
    knownPaths: [other, mine],
    skipScan: true,
  });
  assert.equal(found, fs.realpathSync.native(mine));
});

test('findLocalCopy discovers a copy by scanning dev roots', () => {
  const root = tmp('flc-scan-');
  const mine = fakeClone(path.join(root, 'sites'), 'deep-site', 'https://github.com/zz-fake-owner-c3d4/zz-fake-repo-c3d4.git');
  fs.mkdirSync(path.join(root, 'sites'), { recursive: true });
  const found = github.findLocalCopy('git@github.com:zz-fake-owner-c3d4/zz-fake-repo-c3d4.git', {
    knownPaths: [],
    extraRoots: [root],
  });
  assert.equal(found, fs.realpathSync.native(mine));
});

test('findLocalCopy returns null when nothing matches', () => {
  const root = tmp('flc-none-');
  fakeClone(root, 'unrelated', 'https://github.com/someone/else.git');
  const found = github.findLocalCopy('https://github.com/zz-fake-owner-e5f6/zz-fake-repo-e5f6', {
    knownPaths: [path.join(root, 'unrelated')],
    skipScan: true,
  });
  assert.equal(found, null);
});

test('recents.rekey follows a moved project through recents and the session', () => {
  const ud = tmp('rk-recents-');
  // Real dirs: listRecents/getSession drop paths that don't exist on disk.
  const oldDir = tmp('rk-old-');
  const newDir = tmp('rk-new-');
  recents.init(ud);
  recents.addRecent(oldDir, 'Site');
  recents.setSession([oldDir], oldDir);
  recents.rekey(oldDir, newDir);
  assert.ok(recents.listRecents().some((r) => r.path === newDir));
  assert.ok(!recents.listRecents().some((r) => r.path === oldDir));
  const sess = recents.getSession();
  assert.deepEqual(sess.open, [newDir]);
  assert.equal(sess.active, newDir);
});

test('projectState.rekey moves chats/drafts to the new path key', () => {
  const ud = tmp('rk-state-');
  projectState.init(ud);
  projectState.set('/old/site', { chats: [{ id: 'main' }], draft: 'hello' });
  projectState.rekey('/old/site', '/new/site');
  assert.equal(projectState.get('/new/site').draft, 'hello');
  assert.deepEqual(projectState.get('/old/site'), {});
});

test('devPids.rekey keeps orphan bookkeeping pointed at the new path', () => {
  const ud = tmp('rk-pids-');
  devPids.init(ud);
  devPids.set('/old/site', 4242);
  devPids.rekey('/old/site', '/new/site');
  assert.equal(devPids.get('/new/site')!.pid, 4242);
  assert.equal(devPids.get('/old/site'), null);
});
