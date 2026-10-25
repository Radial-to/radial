// LooseUnion, for a test that reads one result's fields across its kinds, is
// the window's ambient type: no module exports it yet.
/// <reference path="../src/renderer/types.d.ts" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import * as repository from '../src/main/repository';
import * as publish from '../src/main/publish';
import * as integration from '../src/main/integration';
import * as review from '../src/main/githubReview';
import * as collaboration from '../src/main/collaboration';
import type { TestContext } from 'node:test';
import type { HostingResult } from '../src/main/collaboration';
import type { GitHubRequestOptions, PullRequestMerged } from '../src/main/githubReview';
import type { ResolveFileResult } from '../src/main/integration';
import type { CheckpointResult } from '../src/main/publish';
import type { VercelFetch } from '../src/main/vercel';
import type { CollaborationPlanResult, ConflictsResult, FailedPublishReceipt, FileDiff, IntegrationPaused, IntegrationRecord, IntegrationResult, PublishResult, RepoStatus, RepoSync, ReviewFailure } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

// The side of a result a test expects: it asserts that side, or reads only its fields.
type PublishRefused = Extract<PublishResult, { ok: false }>;
/** A publish that failed once git had run: it carries the receipt's fields so far (pushed, sha). */
type FailedPublish = Extract<PublishResult, { ok: false; steps: string[] }>;
/**
 * A publish refused after the build because the checkout or the connection
 * changed: publish() spreads the unsaved receipt into it (pushed, sha, steps…).
 * radialApi's PublishResult says so in a comment but lists these two refusals
 * without the receipt's fields, so Extract can't name this one. To become
 * radialApi's own member once it declares one.
 */
type RefusedAfterBuild = Omit<FailedPublishReceipt, 'reason'> & { reason: 'checkout-changed' | 'remote-changed' };
type IntegrationRefused = Extract<IntegrationResult, { ok: false }>;
type Snapshot = Extract<CheckpointResult, { commit: string }>;
type Conflicts = Extract<ConflictsResult, { ok: true }>;
type ResolveRefused = Extract<ResolveFileResult, { ok: false }>;
type Diff = Extract<FileDiff, { ok: true }>;
type PlanRefused = Extract<CollaborationPlanResult, { ok: false }>;
/** GitHub's pull request moved on since it was reviewed. */
type ReviewChanged = Extract<ReviewFailure, { reason: 'changed' }>;
/**
 * A linked Vercel project. The fake leaves out what destination() doesn't read
 * (the URL, domains, team, autoAssignCustomDomains, ids and provider), and
 * leaves out `enabled`, which it does read: undefined there reads like the
 * null hosting() reports without a vercel.json setting.
 */
type LinkedHost = Extract<HostingResult, { ok: true }>;
/** A Vercel reply. The fake leaves out what deployment() never reads on a success: the status. */
type VercelResponse = Awaited<ReturnType<VercelFetch>>;
/**
 * A deployment in the fake Vercel list (GET /v6/deployments): collaboration.ts's
 * VercelDeploymentBody, restated because that module doesn't export it (the
 * reply's json() is unknown, so nothing else ties the fake to what
 * deployment() parses). To become that type once it's exported.
 */
interface FakeDeployment {
  uid: string;
  id?: string;
  meta?: { githubCommitSha?: string; githubCommitRef?: string };
  created?: number;
  createdAt?: number;
  readyState?: string;
  state?: string;
  url?: string;
  target?: string | null;
}
/** A call the fake GitHub API saw. */
interface ApiCall { endpoint: string; opts?: GitHubRequestOptions }

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

test('status preserves filenames, staging distinctions, and native branch changes', async t => {
  const f = fixture(t);
  f.write('index.html', 'staged'); f.git('add', 'index.html'); f.write('index.html', 'unstaged');
  f.write('odd\nname.txt', 'new');
  let state = await repository.state(f.dir) as RepoStatus;
  assert.equal(state.staged, 1); assert.equal(state.unstaged, 1); assert.equal(state.untracked, 1);
  assert.equal(state.changes.find(c => c.file === 'index.html')!.status, 'MM');
  assert.ok(state.changes.some(c => c.file === 'odd\nname.txt'));
  f.git('switch', '-c', 'campaign');
  state = await repository.state(f.dir) as RepoStatus;
  assert.equal(state.branch, 'campaign');
});

test('comparison uses a differently named upstream and reports a new branch honestly', async t => {
  const f = fixture(t);
  f.git('switch', '-c', 'local-work'); f.git('branch', '--set-upstream-to=origin/main');
  f.incoming('about.html', 'team');
  // Read across its kinds: the failure at the end must carry no comparison.
  let state: LooseUnion<RepoSync> = await repository.syncStatus(f.dir);
  assert.equal(state.targetBranch, 'main'); assert.equal(state.behind, 1);
  f.git('switch', '-c', 'unpublished');
  state = await repository.syncStatus(f.dir);
  assert.equal(state.ok, true); assert.equal(state.reason, 'no-upstream'); assert.equal(state.ahead, null);
  f.git('remote', 'set-url', 'origin', path.join(f.root, 'missing.git'));
  state = await repository.syncStatus(f.dir);
  assert.equal(state.ok, false); assert.equal(state.reason, 'fetch-failed'); assert.equal(state.behind, undefined);
});

test('publishing main cannot replace a fetched teammate staging commit', async t => {
  const f = fixture(t);
  f.git('push', 'origin', 'main:staging');
  f.incoming('teammate.html', 'Keep this', 'staging');
  f.git('fetch', 'origin');
  f.write('index.html', 'My uncommitted changes');
  const before = f.git('rev-parse', 'HEAD');
  const result = await publish.publish(f.dir, { target: 'staging' }) as PublishRefused;
  assert.equal(result.reason, 'integration-required'); assert.equal(result.ok, false);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.run(f.remote, 'show', 'staging:teammate.html'), 'Keep this');
  assert.equal(fs.readFileSync(path.join(f.dir, 'index.html'), 'utf8'), 'My uncommitted changes');
});

test('sync preserves staged and unstaged files plus preexisting stashes', async t => {
  const f = fixture(t);
  f.write('older.txt', 'older work'); f.git('stash', 'push', '-u', '-m', 'Existing stash');
  const old = f.git('rev-parse', 'refs/stash');
  f.write('index.html', 'staged'); f.git('add', 'index.html'); f.write('index.html', 'unstaged');
  f.write('draft.txt', 'local draft'); f.incoming('about.html', 'incoming');
  const result = await publish.sync(f.dir);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.git('show', ':index.html'), 'staged');
  assert.equal(fs.readFileSync(path.join(f.dir, 'index.html'), 'utf8'), 'unstaged');
  assert.equal(fs.readFileSync(path.join(f.dir, 'draft.txt'), 'utf8'), 'local draft');
  assert.ok(f.git('stash', 'list', '--format=%H').includes(old));
  assert.equal(await integration.read(f.dir), null);
});

test('conflicts survive restart, reject premature completion, and resolve one file at a time', async t => {
  const f = fixture(t);
  f.write('index.html', 'my change'); f.incoming('index.html', 'incoming change');
  const result = await publish.sync(f.dir) as IntegrationPaused;
  assert.equal(result.reason, 'conflict');
  const record = await integration.read(f.dir) as IntegrationRecord;
  assert.ok(record.stash); assert.equal(record.phase, 'replay');
  assert.equal((await publish.finalizeSync(f.dir)).ok, false);
  const detail = await integration.conflicts(f.dir) as Conflicts;
  assert.equal(detail.files[0].mine, 'my change'); assert.equal(detail.files[0].incoming, 'incoming change');
  const resolved = await publish.resolveSync(f.dir, { file: 'index.html', strategy: 'manual', text: 'Both changes reviewed' });
  assert.equal(resolved.ok, true);
  assert.equal((await publish.finalizeSync(f.dir)).ok, true);
  assert.equal(f.git('show', `${record.recoveryRef}/work:index.html`), 'my change');
});

test('aborting restores original dirty work and retains a copy of the conflict edits', async t => {
  const f = fixture(t);
  const start = f.git('rev-parse', 'HEAD');
  f.write('index.html', 'my change'); f.incoming('index.html', 'incoming');
  await publish.sync(f.dir);
  f.write('index.html', 'manual resolution in progress');
  const result = await publish.abortSync(f.dir);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.git('rev-parse', 'HEAD'), start);
  assert.equal(fs.readFileSync(path.join(f.dir, 'index.html'), 'utf8'), 'my change');
  assert.equal(f.git('show', `${result.recoveryRef}/before-abort:index.html`), 'manual resolution in progress');
});

test('diverged branches require explicit integration and preserve both histories', async t => {
  const f = fixture(t);
  f.write('mine.html', 'my commit'); f.git('add', '.'); f.git('commit', '-qm', 'My commit');
  const mine = f.git('rev-parse', 'HEAD'); f.incoming('theirs.html', 'team commit');
  assert.equal((await publish.sync(f.dir) as IntegrationRefused).reason, 'diverged');
  const result = await publish.sync(f.dir, { strategy: 'merge' });
  assert.equal(result.ok, true, JSON.stringify(result));
  f.git('merge-base', '--is-ancestor', mine, 'HEAD');
  assert.ok(fs.existsSync(path.join(f.dir, 'theirs.html')));
});

test('with no git identity anywhere, sync merges or rebases diverged work as the OS user: a fresh VM or container has no git config', async t => {
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const user = os.userInfo().username;
  for (const strategy of ['merge', 'rebase'] as const) {
    const f = fixture(t);
    f.write('mine.html', 'my commit'); f.git('add', '.'); f.git('commit', '-qm', 'My commit');
    f.incoming('theirs.html', 'team commit');
    f.write('index.html', 'my local edit'); // uncommitted: saved and replayed around the integration
    f.git('config', '--unset', 'user.name'); f.git('config', '--unset', 'user.email');
    for (const k of keys) delete process.env[k];
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'; // no user.name or user.email in any config git reads
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const result = await publish.sync(f.dir, { strategy });
    assert.equal(result.ok, true, `${strategy}: ${JSON.stringify(result)}`);
    assert.equal(f.git('log', '-1', '--format=%cn <%ce>'), `${user} <${user}@localhost>`, `${strategy}: committed as the OS user, never a guess from the host name`);
    if (strategy === 'rebase') assert.equal(f.git('log', '-1', '--format=%an %s'), 'Me My commit', 'a rebased commit keeps its author');
    assert.ok(fs.existsSync(path.join(f.dir, 'theirs.html')), `${strategy}: the team's commit is in`);
    assert.equal(fs.readFileSync(path.join(f.dir, 'index.html'), 'utf8'), 'my local edit', `${strategy}: the local edit is kept`);
  }
});

test('publish stages only selected work and pushes the checked candidate despite a later file edit', async t => {
  const f = fixture(t);
  f.write('index.html', 'staged'); f.git('add', '.'); f.write('index.html', 'later file edit');
  let checked: string | undefined;
  const result = await publish.publish(f.dir, { target: 'production', scope: 'staged', beforePush: async sha => { checked = sha; f.write('new.html', 'written during build'); return { ok: true }; } });
  assert.equal(result.ok, true); assert.equal(result.sha, checked);
  assert.equal(f.run(f.remote, 'show', 'main:index.html'), 'staged');
  assert.equal(fs.readFileSync(path.join(f.dir, 'index.html'), 'utf8'), 'later file edit');
  assert.equal(f.run(f.remote, 'ls-tree', '--name-only', 'main').includes('new.html'), false);
});

test('a native file edit invalidates a reviewed publish action', async t => {
  const f = fixture(t);
  f.write('index.html', 'reviewed'); const fingerprint = await repository.fingerprint(f.dir);
  f.write('index.html', 'new agent work');
  const result = await publish.publish(f.dir, { target: 'production', expectedFingerprint: fingerprint }) as PublishRefused;
  assert.equal(result.reason, 'checkout-changed'); assert.equal(f.git('log', '-1', '--format=%s'), 'Initial');
});

test('linked worktrees detect Git operations through their real metadata directory', async t => {
  const f = fixture(t); const wt = path.join(f.root, 'worktree');
  f.git('worktree', 'add', '-b', 'parallel', wt);
  const state = await repository.state(wt) as RepoStatus;
  assert.equal(state.branch, 'parallel');
  const metadata = await repository.gitPath(wt, 'CHERRY_PICK_HEAD');
  fs.writeFileSync(metadata, state.head!);
  assert.equal((await repository.state(wt) as RepoStatus).operation, 'cherry-pick');
});

test('stale PR approval never submits a review', async () => {
  const calls: ApiCall[] = [];
  const service = review.client(async (endpoint, opts) => { calls.push({ endpoint, opts }); return { ok: true, data: { head: { sha: 'b'.repeat(40) } } }; });
  const result = await service.review('team/site', { number: 1, sha: 'a'.repeat(40), event: 'APPROVE' }) as ReviewChanged;
  assert.equal(result.reason, 'changed'); assert.equal(calls.length, 1);
});

test('capabilities separate rules from unknown actor bypass rights', async () => {
  const service = review.client(async endpoint => {
    if (endpoint === 'user') return { ok: true, data: { login: 'owner' } };
    if (endpoint.endsWith('/rules/branches/release')) return { ok: true, data: [{ type: 'pull_request' }] };
    if (endpoint.endsWith('/protection')) return { ok: false, status: 403, error: 'Not accessible' };
    if (endpoint.includes('/branches/')) return { ok: true, data: { protected: true } };
    return { ok: true, data: { permissions: { admin: true, push: true }, allow_squash_merge: true } };
  });
  const caps = await service.capabilities('team/site', 'release');
  assert.equal(caps.requiresPr, true); assert.equal(caps.bypass, 'unknown'); assert.equal(caps.state, 'partial');
});

test('hosting destination uses verified project and production branch', () => {
  const host = { ok: true, gitRepo: 'team/site', productionBranch: 'release' } as LinkedHost;
  assert.equal(collaboration.destination(host, 'main', 'team/site').production, false);
  assert.equal(collaboration.destination(host, 'release', 'team/site').production, true);
  assert.equal(collaboration.destination(host, 'release', 'another/site').state, 'unknown');
  assert.equal(collaboration.destination({ ...host, enabled: false }, 'release', 'team/site').state, 'disabled');
});

test('deployment observation rejects another revision and reports failures independently of a push', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, '.vercel'));
  fs.writeFileSync(path.join(f.dir, '.vercel/project.json'), JSON.stringify({ projectId: 'project', orgId: 'team' }));
  const receipt = { sha: 'a'.repeat(40), pushed: true, branch: 'release' };
  let deployments: FakeDeployment[] = [{ uid: 'other', meta: { githubCommitSha: 'b'.repeat(40) }, readyState: 'READY' }];
  const fetchImpl = async () => ({ ok: true, json: async () => ({ deployments }) } as VercelResponse);
  assert.equal((await collaboration.deployment(f.dir, receipt, { token: 'test', fetchImpl })).state, 'unobserved');
  deployments = [{ uid: 'failed', meta: { githubCommitSha: receipt.sha, githubCommitRef: 'release' }, readyState: 'ERROR', target: 'production' }];
  assert.equal((await collaboration.deployment(f.dir, receipt, { token: 'test', fetchImpl })).state, 'failed');
});

test('deployment observation of a Vercel link without a project id says not connected and asks Vercel nothing', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, '.vercel'));
  fs.writeFileSync(path.join(f.dir, '.vercel/project.json'), JSON.stringify({ orgId: 'team' }));
  const asked: string[] = [];
  const fetchImpl: VercelFetch = async url => { asked.push(url); return { ok: true, status: 200, json: async () => ({ deployments: [] }) }; };
  const result = await collaboration.deployment(f.dir, { sha: 'a'.repeat(40), pushed: true, branch: 'main' }, { token: 'test', fetchImpl });
  assert.deepEqual(result, { state: 'unknown', reason: 'not-connected' });
  assert.deepEqual(asked, []);
});

test('a teammate push during the build rejects our push and retains both commits', async t => {
  const f = fixture(t);
  f.write('mine.html', 'my update');
  const result = await publish.publish(f.dir, { target: 'production', beforePush: async () => { f.incoming('team.html', 'their update'); return { ok: true }; } }) as FailedPublish;
  assert.equal(result.ok, false); assert.equal(result.reason, 'integration-required');
  assert.equal(result.pushed, false);
  assert.equal(f.git('show', 'HEAD:mine.html'), 'my update');
  assert.equal(f.run(f.remote, 'show', 'main:team.html'), 'their update');
  assert.equal((await publish.publishReceipt(f.dir) as FailedPublishReceipt).reason, 'integration-required');
});

test('ignored directory collisions stop integration before saving or replacing files', async t => {
  const f = fixture(t);
  f.write('.gitignore', 'private/\n'); f.git('add', '.'); f.git('commit', '-qm', 'Ignore private'); f.git('push');
  f.other('pull', '--ff-only');
  fs.mkdirSync(path.join(f.dir, 'private')); f.write('private/secret.txt', 'keep locally');
  f.incoming('private', 'incoming tracked file');
  const head = f.git('rev-parse', 'HEAD');
  assert.equal((await publish.sync(f.dir) as IntegrationRefused).reason, 'ignored-collision');
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(f.dir, 'private/secret.txt'), 'utf8'), 'keep locally');
  assert.equal(await integration.read(f.dir), null);
});

test('each linked worktree has its own checkpoint and shares mutation serialization', async t => {
  const f = fixture(t), wt = path.join(f.root, 'parallel');
  f.git('worktree', 'add', '-b', 'parallel', wt);
  f.write('index.html', 'main dirty'); fs.writeFileSync(path.join(wt, 'index.html'), 'parallel dirty');
  const a = await publish.checkpoint(f.dir) as Snapshot, b = await publish.checkpoint(wt) as Snapshot;
  assert.notEqual(a.ref, b.ref);
  assert.equal(f.git('show', `${a.ref}:index.html`), 'main dirty');
  assert.equal(f.git('show', `${b.ref}:index.html`), 'parallel dirty');
  const sequence: string[] = [];
  let entered: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = publish.withRepoLock(f.dir, async () => { sequence.push('start'); entered(); await new Promise(resolve => setTimeout(resolve, 80)); sequence.push('end'); });
  // Resolving each worktree's Git directory is asynchronous. Assert mutual
  // exclusion after the first task owns the lock, not the order of Git replies.
  await started;
  await Promise.all([first, publish.withRepoLock(wt, () => { sequence.push('next'); })]);
  assert.deepEqual(sequence, ['start', 'end', 'next']);
});

/** The merge methods a fake repository allows, as GitHub's repository JSON names them. */
type RepoMergeFlags = Partial<Record<'allow_merge_commit' | 'allow_squash_merge' | 'allow_rebase_merge', boolean>>;
function reviewFixture({ state = 'clean', queue = false, responseMerged = true, repo = { allow_squash_merge: true } }: { state?: string; queue?: boolean; responseMerged?: boolean; repo?: RepoMergeFlags } = {}) {
  const sha = 'a'.repeat(40), baseSha = 'b'.repeat(40), calls: ApiCall[] = [];
  const pr = { number: 1, user: { login: 'designer' }, head: { sha, ref: 'campaign' }, base: { sha: baseSha, ref: 'main' }, state: 'open', mergeable: true, mergeable_state: state };
  const service = review.client(async (endpoint, opts) => {
    calls.push({ endpoint, opts });
    if (opts?.method === 'PUT') return { ok: true, data: { merged: responseMerged, sha: 'c'.repeat(40), message: 'Not merged' } };
    if (endpoint === 'user') return { ok: true, data: { login: 'reviewer' } };
    if (endpoint === 'repos/team/site/pulls/1') return { ok: true, data: pr };
    if (endpoint.includes('check-runs')) return { ok: true, data: { check_runs: [] } };
    if (endpoint.includes('/status?')) return { ok: true, data: { statuses: [] } };
    if (endpoint.includes('/rules/branches/')) return { ok: true, data: queue ? [{ type: 'merge_queue' }] : [] };
    if (endpoint.includes('/branches/')) return { ok: true, data: { protected: false } };
    if (endpoint === 'repos/team/site') return { ok: true, data: { permissions: { push: true }, ...repo } };
    return { ok: true, data: [] };
  });
  return { service, sha, baseSha, calls };
}

test('capabilities offer every merge method the repository allows, merge commits included', async () => {
  const both = reviewFixture({ repo: { allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: true } });
  assert.deepEqual((await both.service.capabilities('team/site', 'main')).mergeMethods, ['merge', 'rebase']);
  const only = reviewFixture({ repo: { allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false } });
  const merged = await only.service.merge('team/site', { number: 1, sha: only.sha, baseSha: only.baseSha, method: 'merge' });
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.deepEqual(only.calls.find(c => c.opts?.method === 'PUT')!.opts!.body, { sha: only.sha, merge_method: 'merge' });
});

test('PR merge binds the reviewed SHA and requires GitHub to confirm a merge', async () => {
  const f = reviewFixture();
  assert.equal((await f.service.merge('team/site', { number: 1, sha: 'd'.repeat(40), baseSha: f.baseSha }) as ReviewChanged).reason, 'changed');
  assert.equal(f.calls.some(c => c.opts?.method === 'PUT'), false);
  assert.equal((await f.service.merge('team/site', { number: 1, sha: f.sha, baseSha: f.baseSha }) as PullRequestMerged).merged, true);
  assert.deepEqual(f.calls.find(c => c.opts?.method === 'PUT')!.opts!.body, { sha: f.sha, merge_method: 'squash' });
  const rejected = reviewFixture({ responseMerged: false });
  assert.equal((await rejected.service.merge('team/site', { number: 1, sha: rejected.sha })).ok, false);
});

test('merge queue, unstable checks, and unknown merge state require GitHub follow-up', async () => {
  for (const options of [{ queue: true }, { state: 'unstable' }, { state: 'unknown' }]) {
    const f = reviewFixture(options);
    assert.equal((await f.service.merge('team/site', { number: 1, sha: f.sha, baseSha: f.baseSha })).ok, false);
    assert.equal(f.calls.some(c => c.opts?.method === 'PUT'), false);
  }
});

test('undo and redo refuse to overwrite subsequent native edits', t => {
  const f = fixture(t), history = require('../src/main/editHistory') as typeof import('../src/main/editHistory');
  const record = { file: path.join(f.dir, 'index.html'), prev: 'before', next: 'after' };
  f.write('index.html', 'after'); assert.equal(history.applyRecord(record, 'undo'), true);
  f.write('index.html', 'native edit'); assert.equal(history.applyRecord(record, 'redo'), false);
  assert.equal(history.applyRecord(record, 'undo'), false);
  assert.equal(fs.readFileSync(record.file, 'utf8'), 'native edit');
});

test('repository changes update fetch and explicit push URLs without changing local work', async t => {
  const f = fixture(t);
  f.write('draft.txt', 'local client work');
  f.git('config', 'remote.origin.pushurl', f.remote);
  const head = f.git('rev-parse', 'HEAD');
  const destination = path.join(f.root, 'client.git');
  f.run(f.root, 'clone', '--bare', f.remote, destination);
  await publish.setRemote(f.dir, destination);
  assert.equal(f.git('remote', 'get-url', 'origin'), destination);
  assert.equal(f.git('remote', 'get-url', '--push', 'origin'), destination);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(f.dir, 'draft.txt'), 'utf8'), 'local client work');
  assert.equal((await repository.syncStatus(f.dir)).ok, true);
});

test('diff payloads retain untracked contents and full staged rename metadata', async t => {
  const f = fixture(t);
  f.write('odd\nname.md', '<script>not executable</script>\n');
  const added = await repository.fileDiff(f.dir, 'odd\nname.md') as Diff;
  assert.deepEqual(added.addedFile, { name: 'odd\nname.md', contents: '<script>not executable</script>\n' });
  f.git('mv', 'index.html', 'renamed.html');
  const renamed = await repository.fileDiff(f.dir, 'renamed.html', true) as Diff;
  assert.match(renamed.text, /rename from index.html/);
  assert.match(renamed.text, /rename to renamed.html/);
});


test('a reviewed push refuses a changed repository connection without committing local files', async t => {
  const f = fixture(t);
  f.write('index.html', 'Keep this local edit');
  const head = f.git('rev-parse', 'HEAD');
  const result = await publish.publish(f.dir, { target: 'branch', expectedHead: head, expectedRemote: 'https://github.com/previous/repo.git' }) as PublishRefused;
  assert.equal(result.reason, 'remote-changed');
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(f.dir, 'index.html'), 'utf8'), 'Keep this local edit');
});

test('a connection changed by a native tool during the build leaves the commit local', async t => {
  const f = fixture(t);
  const secondRemote = path.join(f.root, 'client.git');
  f.run(f.root, 'init', '--bare', '-q', '-b', 'main', secondRemote);
  const original = f.git('rev-parse', 'HEAD');
  f.write('index.html', 'Reviewed content');
  const result = await publish.publish(f.dir, {
    target: 'branch', expectedRemote: f.remote,
    beforePush: async () => { f.git('remote', 'set-url', 'origin', secondRemote); return { ok: true }; },
  }) as RefusedAfterBuild;
  assert.equal(result.reason, 'remote-changed');
  assert.equal(result.pushed, false);
  assert.notEqual(f.git('rev-parse', 'HEAD'), original);
  assert.equal(f.run(f.root, '--git-dir', f.remote, 'rev-parse', 'main'), original);
  assert.equal(f.run(f.root, '--git-dir', secondRemote, 'for-each-ref').trim(), '');
});

test('a direct publish stops when the required Git workflow changes after preflight', async t => {
  const f = fixture(t); f.write('index.html', 'Local work');
  const head = f.git('rev-parse', 'HEAD');
  publish.writeConfig(f.dir, { productionPublish: 'pr' });
  const result = await publish.publish(f.dir, { target: 'production', expectedHead: head, expectedPr: false }) as PublishRefused;
  assert.equal(result.reason, 'plan-changed'); assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(f.dir, 'index.html'), 'utf8'), 'Local work');
});

test('a separate push URL is rejected before local work is committed', async t => {
  const f = fixture(t), head = f.git('rev-parse', 'HEAD');
  const other = path.join(f.root, 'unreviewed.git');
  f.run(f.root, 'init', '--bare', '-q', other);
  f.write('index.html', 'Keep this edit local');
  f.git('config', 'remote.origin.pushurl', other);
  const plan = await collaboration.plan(f.dir, { target: 'production' }) as PlanRefused;
  assert.equal(plan.reason, 'push-target-mismatch');
  const result = await publish.publish(f.dir, { target: 'production', expectedRemote: f.remote }) as PublishRefused;
  assert.equal(result.reason, 'push-target-mismatch');
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('show', ':index.html'), 'one\ntwo\nthree');
  assert.equal(fs.readFileSync(path.join(f.dir, 'index.html'), 'utf8'), 'Keep this edit local');
  assert.equal(f.run(other, 'for-each-ref'), '');
});

test('a native push URL change during the build never pushes to either remote', async t => {
  const f = fixture(t), head = f.git('rev-parse', 'HEAD');
  const other = path.join(f.root, 'unreviewed.git'); f.run(f.root, 'init', '--bare', '-q', other);
  f.write('index.html', 'Saved candidate');
  const result = await publish.publish(f.dir, { target: 'production', beforePush: async () => {
    f.git('config', 'remote.origin.pushurl', other); return { ok: true };
  } }) as RefusedAfterBuild;
  assert.equal(result.reason, 'remote-changed'); assert.equal(result.pushed, false);
  assert.notEqual(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.run(f.remote, 'rev-parse', 'main'), head);
  assert.equal(f.run(other, 'for-each-ref'), '');
});

test('multiple push URLs and pushInsteadOf rewrites cannot bypass destination checks', async t => {
  const f = fixture(t), other = path.join(f.root, 'unreviewed.git');
  f.run(f.root, 'init', '--bare', '-q', other);
  f.git('config', '--add', 'remote.origin.pushurl', f.remote);
  f.git('config', '--add', 'remote.origin.pushurl', other);
  assert.equal((await publish.publish(f.dir, { target: 'production' }) as PublishRefused).reason, 'push-target-mismatch');
  f.git('config', '--unset-all', 'remote.origin.pushurl');
  f.git('config', `url.${other}.pushInsteadOf`, f.remote);
  assert.equal((await publish.publish(f.dir, { target: 'production' }) as PublishRefused).reason, 'push-target-mismatch');
  assert.equal(f.run(other, 'for-each-ref'), '');
});

test('HTTPS fetch and SSH push are allowed for the same GitHub repository', async t => {
  const f = fixture(t);
  const url = 'https://github.com/team/site.git';
  f.git('remote', 'set-url', 'origin', url);
  f.git('config', 'remote.origin.pushurl', 'git@github.com:team/site.git');
  assert.deepEqual(await repository.pushTarget(f.dir, url), { ok: true, url: 'git@github.com:team/site.git' });
  f.git('config', 'remote.origin.pushurl', 'git@github.com:client/site.git');
  assert.equal((await repository.pushTarget(f.dir, url)).ok, false);
});

test('publish refuses a hosting effect changed since the button was prepared', async t => {
  const f = fixture(t); f.write('index.html', 'Local work');
  const head = f.git('rev-parse', 'HEAD');
  const result = await publish.publish(f.dir, { target: 'production', expectedHead: head, expectedDeployment: { state: 'configured', production: true, projectId: 'old-project', orgId: 'team' } }) as PublishRefused;
  assert.equal(result.reason, 'plan-changed'); assert.equal(f.git('rev-parse', 'HEAD'), head);
});

test('conflict snapshots include the merged file and reject a native edit before save', async t => {
  const f = fixture(t);
  f.write('index.html', 'my headline\ntwo\nthree\n');
  f.incoming('index.html', 'their headline\ntwo\nthree\n');
  const started = await integration.start(f.dir, { target: 'main' }) as IntegrationPaused;
  assert.equal(started.reason, 'conflict');
  const snapshot = await integration.conflicts(f.dir) as Conflicts, file = snapshot.files[0];
  assert.ok(file.working!.includes('<<<<<<<')); assert.ok(file.working!.includes('two\nthree'));
  f.write('index.html', 'Native resolution\ntwo\nthree\n');
  const result = await integration.resolve(f.dir, { file: file.file, strategy: 'manual', text: 'Old resolution', expectedFingerprint: file.fingerprint }) as ResolveRefused;
  assert.equal(result.reason, 'conflict-changed');
  assert.equal(fs.readFileSync(path.join(f.dir, 'index.html'), 'utf8'), 'Native resolution\ntwo\nthree\n');
});
