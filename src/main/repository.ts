import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { childEnv, which } from './env';
import type { CollaborationStateOptions, FileDiff, GitChange, GitOperation, RepoState, RepoSync, UpstreamRelation } from '../shared/radialApi';

/** run()'s options: `raw` keeps git's output untrimmed. */
export interface GitRunOptions { raw?: boolean; env?: NodeJS.ProcessEnv; timeout?: number }
/** A failed git command: stderr (or the spawn error) as the message, with git's exit code or the spawn error's code. */
export interface GitError extends Error { code?: string | number | null }
/** Where pushes to origin go, when that is a single repository (pushTarget). */
export type PushTarget =
  | { ok: true; url: string }
  | { ok: false; reason: 'push-target-mismatch'; message: string };
/** A branch's upstream: the remote (`.` for a local branch), the branch there, and the ref that tracks it here. */
export interface UpstreamTarget { remote: string; branch: string; ref: string }
/** compare(): how HEAD relates to the upstream, plus `remote`: the remote's name (origin, or . for a local branch), not its URL; syncStatus reports it as remoteName. */
export type UpstreamComparison = UpstreamRelation & { remote: string };
/**
 * syncStatus()'s options: fetch first; compare with origin/<target> instead of
 * the tracked upstream. The same fields collaboration.state takes and passes
 * through, but fetch defaults to true here and to false there.
 */
export type SyncStatusOptions = CollaborationStateOptions;

const NONINTERACTIVE = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };

function run(dir: string, args: readonly string[], { raw = false, env, timeout = 30000 }: GitRunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(which('git') || 'git', args, { cwd: dir, env: childEnv({ ...NONINTERACTIVE, ...env }), timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const failure: GitError = new Error((stderr || error.message).trim());
        failure.code = error.code;
        reject(failure);
      } else resolve(raw ? stdout : stdout.trim());
    });
  });
}

/** The OS user's name: who a commit in a repo with no git identity is attributed to, never Radial. */
function fallbackName(): string {
  try { return os.userInfo().username || 'user'; } catch { return 'user'; }
}
/**
 * The identity a commit Radial makes needs, as `-c` arguments for what the
 * repo doesn't configure: the OS user's name and <user>@localhost. Git
 * refuses to commit without a name and an email it trusts, and a fresh VM or
 * container has no git config: there every moment, auto-save checkpoint,
 * merge and rebase failed. A name or email in the environment (GIT_AUTHOR_*,
 * GIT_COMMITTER_*, EMAIL) still wins.
 */
async function missingIdentityArgs(dir: string): Promise<string[]> {
  const [name, email] = await Promise.all([run(dir, ['config', 'user.name']).catch(() => ''), run(dir, ['config', 'user.email']).catch(() => '')]);
  const n = fallbackName();
  return [...(name ? [] : ['-c', `user.name=${n}`]), ...(email || process.env.EMAIL ? [] : ['-c', `user.email=${n}@localhost`])];
}

function parseStatus(output: string): GitChange[] {
  const fields = output.split('\0');
  const changes: GitChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const change: GitChange = { status: xy.trim(), index: xy[0], worktree: xy[1], file: entry.slice(3), untracked: xy === '??', conflicted: /U/.test(xy) || xy === 'AA' || xy === 'DD' };
    if (/[RC]/.test(xy)) change.originalFile = fields[++i];
    changes.push(change);
  }
  return changes;
}

async function gitPath(dir: string, name: string): Promise<string> {
  return path.resolve(dir, await run(dir, ['rev-parse', '--git-path', name]));
}

function remoteIdentity(url: string): string {
  const github = url.match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
  return github ? 'github.com/' + github[1].toLowerCase() : url;
}

async function pushTarget(dir: string, remote: string): Promise<PushTarget> {
  const urls = (await run(dir, ['remote', 'get-url', '--push', '--all', 'origin'])).split('\n');
  if (urls.length !== 1 || remoteIdentity(urls[0]) !== remoteIdentity(remote)) {
    return { ok: false, reason: 'push-target-mismatch', message: 'Origin has a different push repository or multiple push URLs. Edit the repository connection to choose one destination before publishing in Radial.' };
  }
  return { ok: true, url: urls[0] };
}

async function operation(dir: string): Promise<GitOperation | null> {
  for (const [file, kind] of [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['sequencer', 'sequencer']] as const) {
    if (fs.existsSync(await gitPath(dir, file))) return kind;
  }
  return null;
}

async function state(dir: string): Promise<RepoState> {
  try {
    await run(dir, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    return { ok: false, isRepo: false, reason: 'not-a-repo', message: (error as Error).message, branch: null, changes: [] };
  }
  try {
    const [output, branch, head, remote, inProgress] = await Promise.all([
      run(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { raw: true }),
      run(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null),
      run(dir, ['rev-parse', '--verify', 'HEAD']).catch(() => null),
      run(dir, ['remote', 'get-url', 'origin']).catch(() => null),
      operation(dir),
    ]);
    const changes = parseStatus(output);
    return { ok: true, isRepo: true, branch, head, detached: !branch && !!head, unborn: !head, remote, operation: inProgress, changes,
      staged: changes.filter(c => !c.untracked && c.index !== ' ').length,
      unstaged: changes.filter(c => !c.untracked && c.worktree !== ' ').length,
      untracked: changes.filter(c => c.untracked).length,
      conflicts: changes.filter(c => c.conflicted).map(c => c.file), observedAt: Date.now() };
  } catch (error) {
    return { ok: false, isRepo: true, reason: 'status-failed', message: (error as Error).message, changes: null };
  }
}

async function tracking(dir: string, branch: string | null | undefined): Promise<UpstreamTarget | null> {
  if (!branch) return null;
  const remote = await run(dir, ['config', '--get', `branch.${branch}.remote`]).catch(() => 'origin');
  const merge = await run(dir, ['config', '--get', `branch.${branch}.merge`]).catch(() => `refs/heads/${branch}`);
  if (!merge.startsWith('refs/heads/')) throw new Error('The upstream is not a branch.');
  const name = merge.slice(11);
  return { remote, branch: name, ref: remote === '.' ? merge : `refs/remotes/${remote}/${name}` };
}

async function compare(dir: string, { remote, branch, ref }: UpstreamTarget, fetch = true): Promise<UpstreamComparison> {
  await run(dir, ['check-ref-format', `refs/heads/${branch}`]);
  if (!remote || remote.startsWith('-')) throw new Error('Invalid Git remote.');
  if (fetch && remote !== '.') {
    const exists = await run(dir, ['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`]).catch((error: GitError) => {
      if (error.code === 2) return '';
      throw error;
    });
    if (!exists) return { exists: false, remote, targetBranch: branch, ahead: null, behind: null };
    await run(dir, ['fetch', '--no-tags', remote, `+refs/heads/${branch}:${ref}`]);
  }
  const sha = await run(dir, ['rev-parse', '--verify', ref]).catch(() => null);
  if (!sha) return { exists: false, remote, targetBranch: branch, ahead: null, behind: null };
  const counts = (await run(dir, ['rev-list', '--left-right', '--count', `HEAD...${sha}`])).split(/\s+/).map(Number);
  return { exists: true, remote, targetBranch: branch, upstream: ref, sha, ahead: counts[0], behind: counts[1], fetchedAt: fetch ? Date.now() : null };
}

async function syncStatus(dir: string, { fetch = true, target }: SyncStatusOptions = {}): Promise<RepoSync> {
  const local = await state(dir);
  if (!local.ok) return local;
  if (!local.head || !local.branch) return { ...local, ok: false, reason: local.unborn ? 'unborn' : 'detached' };
  try {
    // The `!`: local.branch is non-empty (checked above), and tracking() returns null only for an empty branch.
    const upstream = target ? { remote: 'origin', branch: target, ref: `refs/remotes/origin/${target}` } : (await tracking(dir, local.branch))!;
    if (upstream.remote !== '.' && !(await run(dir, ['remote']).then(s => s.split('\n').includes(upstream.remote)))) return { ...local, ok: false, reason: 'no-remote' };
    const relation = await compare(dir, upstream, fetch);
    const head = await run(dir, ['rev-parse', 'HEAD']);
    const branch = await run(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
    if (head !== local.head || branch !== local.branch) return { ...local, ok: false, reason: 'checkout-changed' };
    return { ...local, ...relation, remote: local.remote, remoteName: upstream.remote, ok: true, reason: relation.exists ? null : 'no-upstream' };
  } catch (error) {
    return { ...local, ok: false, reason: 'fetch-failed', message: (error as Error).message };
  }
}

async function fileDiff(dir: string, file: string, staged = false): Promise<FileDiff> {
  const local = await state(dir);
  if (!local.ok) return local;
  const change = local.changes.find(c => c.file === file);
  if (!change) return { ok: false, error: 'This file is no longer changed. Refresh the file list.' };
  if (change.untracked) {
    const abs = path.resolve(dir, file);
    if (!abs.startsWith(path.resolve(dir) + path.sep) || fs.lstatSync(abs).isSymbolicLink()) return { ok: false, error: 'Open this file in your editor.' };
    if (fs.statSync(abs).size > 1024 * 1024) return { ok: true, binary: true, text: 'File is too large for the inline diff.' };
    const data = fs.readFileSync(abs);
    return { ok: true, binary: data.includes(0), addedFile: data.includes(0) ? null : { name: file, contents: data.toString('utf8') }, text: data.includes(0) ? 'Binary file' : data.toString('utf8').split('\n').map(l => '+' + l).join('\n') };
  }
  return { ok: true, text: await run(dir, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', ...(staged ? ['--cached'] : []), '--', file, ...(change.originalFile ? [change.originalFile] : [])], { raw: true }) };
}

async function fingerprint(dir: string): Promise<string> {
  const local = await state(dir);
  if (!local.ok) throw new Error(local.message || 'Could not read the checkout.');
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ head: local.head, branch: local.branch, changes: local.changes }));
  for (const args of [['diff', '--binary', '--no-ext-diff', '--no-textconv'], ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv']]) hash.update(await run(dir, args, { raw: true }));
  for (const file of local.changes.filter(c => c.untracked)) {
    const abs = path.resolve(dir, file.file);
    hash.update(file.file);
    if (fs.lstatSync(abs).isSymbolicLink()) hash.update(fs.readlinkSync(abs));
    else hash.update(await run(dir, ['hash-object', '--', file.file]));
  }
  return hash.digest('hex');
}

export { run, fallbackName, missingIdentityArgs, parseStatus, gitPath, operation, state, tracking, compare, syncStatus, fileDiff, fingerprint, pushTarget };
