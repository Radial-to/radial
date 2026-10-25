import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import * as library from '../src/main/projectLibrary';
import * as github from '../src/main/github';
import * as review from '../src/main/githubReview';
import * as repository from '../src/main/repository';
import type { TestContext } from 'node:test';
import type { ProjectLibraryDeps } from '../src/main/projectLibrary';
import type { GitHubRepoList, LibraryStatus, LibraryUpdateResult } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

// The side of a result each test reads; its assertions fail on the other side.
/** A checkout on a branch whose upstream exists: the status that counts the incoming commits. */
type Tracking = Extract<LibraryStatus, { ok: true; exists: true }>;
type UpdateRefused = Extract<LibraryUpdateResult, { ok: false }>;
type RepoListed = Extract<GitHubRepoList, { ok: true }>;

function fixture(t: TestContext) {
  const root = tmpDir('radial-team-test-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
  const remote = path.join(root, 'remote.git');
  const dir = path.join(root, 'mine');
  const peer = path.join(root, 'peer');
  run(root, 'init', '--bare', '-q', '-b', 'main', remote);
  run(root, 'init', '-q', '-b', 'main', dir);
  const git = (...args: string[]) => run(dir, ...args);
  git('config', 'user.name', 'Me'); git('config', 'user.email', 'me@example.invalid');
  fs.writeFileSync(path.join(dir, 'index.html'), 'one\ntwo\nthree\n');
  git('add', '.'); git('commit', '-qm', 'Initial'); git('remote', 'add', 'origin', remote); git('push', '-qu', 'origin', 'main');
  run(root, 'clone', '-q', remote, peer);
  const other = (...args: string[]) => run(peer, ...args);
  other('config', 'user.name', 'Teammate'); other('config', 'user.email', 'teammate@example.invalid');
  const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
  const incoming = (file: string, text: string, branch = 'main') => { fs.writeFileSync(path.join(peer, file), text); other('add', '.'); other('commit', '-qm', 'Teammate update'); other('push', '-q', 'origin', `HEAD:${branch}`); };
  return { root, dir, peer, remote, run, git, other, write, incoming };
}

test('fetch is read-only; explicit update fast-forwards the current upstream', async t => {
  const f = fixture(t); f.git('switch', '-c', 'client-work'); f.git('branch', '--set-upstream-to=origin/main');
  const before = f.git('rev-parse', 'HEAD'); f.incoming('about.html', 'teammate');
  const state = await library.status(f.dir, { fetch: true }) as Tracking;
  assert.equal(f.git('rev-parse', 'HEAD'), before); assert.equal(fs.existsSync(path.join(f.dir, 'about.html')), false);
  assert.equal(state.canUpdate, true); assert.equal(state.behind, 1);
  const result = await library.update(f.dir, state);
  assert.equal(result.ok, true); assert.equal(f.git('branch', '--show-current'), 'client-work');
  assert.equal(f.git('rev-parse', 'HEAD'), f.other('rev-parse', 'HEAD'));
});

test('dirty, staged, untracked and diverged copies require review without changing files or stashing', async t => {
  for (const mode of ['dirty', 'staged', 'untracked', 'diverged']) {
    const f = fixture(t); f.incoming('about.html', 'teammate');
    f.write(mode === 'untracked' ? 'draft.html' : 'index.html', 'my work');
    if (mode === 'staged' || mode === 'diverged') f.git('add', '.');
    if (mode === 'diverged') f.git('commit', '-qm', 'My work');
    const before = f.git('status', '--porcelain'), head = f.git('rev-parse', 'HEAD');
    const state = await library.status(f.dir, { fetch: true });
    assert.equal(state.canUpdate, false, mode);
    assert.equal((await library.update(f.dir, state) as UpdateRefused).reason, 'review-required');
    assert.equal(f.git('status', '--porcelain'), before); assert.equal(f.git('rev-parse', 'HEAD'), head);
    assert.equal(f.git('stash', 'list'), '');
  }
});

test('new remote commits invalidate the reviewed update', async t => {
  const f = fixture(t); f.incoming('about.html', 'first');
  const state = await library.status(f.dir, { fetch: true }), head = f.git('rev-parse', 'HEAD');
  f.incoming('about.html', 'second');
  assert.equal((await library.update(f.dir, state) as UpdateRefused).reason, 'checkout-changed');
  assert.equal(f.git('rev-parse', 'HEAD'), head);
});

test('local edits arriving during fetch block update', async t => {
  const f = fixture(t); f.incoming('about.html', 'first');
  const state = await library.status(f.dir, { fetch: true });
  const original = library.deps.syncStatus;
  t.mock.method(library.deps, 'syncStatus', async (...args: Parameters<typeof original>) => {
    const value = await original(...args); f.write('index.html', 'arrived during fetch'); return value;
  });
  assert.equal((await library.update(f.dir, state) as UpdateRefused).reason, 'checkout-changed');
  assert.equal(fs.readFileSync(path.join(f.dir, 'index.html'), 'utf8'), 'arrived during fetch');
});

test('offline, detached and unpublished branches never offer update', async t => {
  const f = fixture(t); f.git('switch', '-c', 'new-work');
  assert.equal((await library.status(f.dir, { fetch: true })).canUpdate, false);
  f.git('checkout', '--detach');
  assert.equal((await library.status(f.dir, { fetch: true })).reason, 'detached');
  f.git('switch', 'main'); f.git('remote', 'set-url', 'origin', path.join(f.root, 'missing.git'));
  const state = await library.status(f.dir, { fetch: true });
  assert.equal(state.reason, 'fetch-failed'); assert.equal(state.checkedAt, null); assert.equal(state.canUpdate, false);
});

test('copy discovery returns multiple paths including linked worktrees', t => {
  const f = fixture(t), linked = path.join(f.root, 'linked');
  f.git('remote', 'set-url', 'origin', 'git@github.com:Client/site.git');
  f.other('remote', 'set-url', 'origin', 'https://github.com/client/site');
  f.git('worktree', 'add', '-b', 'campaign', linked);
  const copies = github.findLocalCopies('https://github.com/client/site', { knownPaths: [f.dir, f.peer, linked, f.dir], skipScan: true });
  assert.deepEqual(new Set(copies), new Set([f.dir, f.peer, linked].map(p => fs.realpathSync(p))));
});

test('opening an existing workspace copy does not implicitly pull', async t => {
  const f = fixture(t), workspace = path.join(f.root, 'workspace');
  fs.mkdirSync(workspace); const dir = path.join(workspace, 'client__site');
  f.run(f.root, 'clone', '-q', f.remote, dir); const head = f.run(dir, 'rev-parse', 'HEAD');
  f.incoming('about.html', 'team');
  const result = await github.cloneOrPull(f.remote, workspace, () => {}, { identity: { owner: 'client', repo: 'site' }, update: false });
  assert.equal(result.action, 'opened-local'); assert.equal(f.run(dir, 'rev-parse', 'HEAD'), head);
});

test('accessible repositories include collaborator repositories and report pagination limit', async t => {
  const calls: string[] = [];
  t.mock.method(library.deps, 'request', async (endpoint: Parameters<ProjectLibraryDeps['request']>[0]): ReturnType<ProjectLibraryDeps['request']> => {
    calls.push(endpoint);
    return { ok: true, data: Array.from({ length: 100 }, (_, i) => ({ full_name: `client/site-${calls.length}-${i}`, name: `site-${i}`, owner: { login: 'client' }, html_url: 'https://github.com/client/site', private: true })) };
  });
  const result = await library.accessibleRepos() as RepoListed;
  assert.equal(result.repos.length, 200); assert.equal(result.truncated, true);
  assert.match(calls[0], /affiliation=owner,collaborator,organization_member/); assert.match(calls[1], /page=2$/);
});
