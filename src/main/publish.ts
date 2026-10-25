import * as projectData from './projectData';

// Commit local work and push an explicit branch. Hosting determines deployment.

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { childEnv, which } from './env';
import * as repository from './repository';
import * as integration from './integration';
import crypto from 'crypto';
import type { SyncStatusOptions } from './repository';
import type { GitHubApiResult, GitHubPullRequest } from './githubReview';
import type { AbortResult, AutoCommitResult, BranchList, BranchSwitchResult, BuildGateSummary, DeploymentEffect, FailedPublishReceipt, FinalizeResult, GhSetupResult, GhStatus, IncomingCommit, IntegrationResult, MergeReceipt, PublishOptions, PublishReceipt, PublishResult, PublishTarget, PushAuth, RadialApi, RadialConfig, RepoState, RepoSync, ResolveResult, StoredReceipt, SyncOptions } from '../shared/radialApi';

/** checkpoint(): the snapshot commit and the shadow ref it's on, or why there's none. */
export type CheckpointResult =
  | { ok: true; ref: string; commit: string }
  | { ok: true; skipped: 'clean' }
  | { ok: false; reason: 'not-a-repo' | 'no-head' }
  | { ok: false; reason: 'git-error'; message: string };
/** ensureRepoHygiene(): the .gitignore lines it added and the build folders it stopped tracking. */
export interface RepoHygieneNote { ignored: string[]; untracked: string[] }
/** switchBranch()'s options (radialApi's branchSwitch): `stash` carries local edits that clash with the target branch across the switch. */
export type SwitchBranchOptions = NonNullable<Parameters<RadialApi['branchSwitch']>[2]>;
/** resolveSync()'s strategy (radialApi's syncResolve): one side for every conflicted file, or one file's resolution. */
export type SyncResolveStrategy = Parameters<RadialApi['syncResolve']>[1];
/** autoCommit()'s options: `force` skips the minimum interval between automatic commits. */
export interface AutoCommitOptions { force?: boolean }
/**
 * What opts.beforePush answers for the commit about to be pushed (deploy.ts's
 * build gate): push it, with the gate's summary for the receipt, or stop and
 * keep the commit local. deploy.ts always sends the summary; tests may not.
 */
export type PublishGate =
  | { ok: true; deploy?: BuildGateSummary }
  | { ok: false; reason: 'build-failed'; message: string; deploy: BuildGateSummary };
/** publish()'s options: the window's PublishOptions, plus the check deploy.ts runs before the push. */
export interface PublishRunOptions extends PublishOptions { beforePush?: (sha: string) => Promise<PublishGate> }
/**
 * The last receipt (radialApi's StoredReceipt) as _publish reads it: with a
 * failure's reason and message on the others as undefined, since it reads
 * `reason` without checking ok.
 */
type SavedReceipt = FailedPublishReceipt | ((PublishReceipt | MergeReceipt) & { reason?: undefined; message?: undefined });
/**
 * The receipt _publish saves as it goes. It starts as a PublishReceipt. A
 * failed build gate replaces it with a failed copy that adds the gate's deploy
 * summary, and a failed pull request sets ok, reason and message in place, so
 * it has the fields of both.
 */
type DraftReceipt = Omit<PublishReceipt, 'ok'> & { ok: boolean; reason?: FailedPublishReceipt['reason']; message?: string };
/** What run() saw. It never rejects: a failure is ok: false, with the exit code (1 when there's none). */
interface RunResult { ok: boolean; code: number; stdout: string; stderr: string }
/**
 * The part of a project's vercel.json the app reads (collaboration's
 * hosting()). The person writes the file, so its values are unknown here.
 */
export interface VercelJson { git?: { deploymentEnabled?: unknown } }

function git(repoDir: string, args: readonly string[], extraEnv?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(which('git') || 'git', args, { cwd: repoDir, env: childEnv(extraEnv), maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

// --- per-repo serialization (one real-index git op at a time) --------------
// Electron ipcMain.handle callbacks run concurrently with NO mutual exclusion,
// so an auto-commit firing while the user hits Publish (or Sync, or a branch
// switch) would collide on `.git/index.lock` and one of them dies — possibly
// Publish itself, silently. Every op that stages/commits/merges/stashes the
// REAL index runs through this per-repoDir queue. (checkpoint() is exempt: it
// writes a throwaway temp index via GIT_INDEX_FILE and never takes index.lock.)
const _repoLocks = new Map<string, Promise<void>>(); // repoDir -> tail Promise of the queue
async function withRepoLock<T>(repoDir: string, fn: () => T | PromiseLike<T>): Promise<T> {
  try { repoDir = fs.realpathSync.native(repoDir); } catch {}
  try { repoDir = fs.realpathSync(path.resolve(repoDir, await repository.run(repoDir, ['rev-parse', '--git-common-dir']))); } catch {}
  const prev = _repoLocks.get(repoDir) || Promise.resolve();
  const runResult = prev.then(() => fn());
  // The stored tail never rejects, so one failed op can't wedge the queue.
  _repoLocks.set(repoDir, runResult.then(() => {}, () => {}));
  return runResult;
}

const autosaveRef = (dir: string): string => 'refs/auto-save/snapshot-' + crypto.createHash('sha256').update(fs.realpathSync(dir)).digest('hex').slice(0, 16);

/**
 * Snapshot the entire working tree (tracked + untracked) into a commit on a
 * shadow ref — WITHOUT touching the working index, the branch, or its history.
 * It's invisible to normal git (no branch noise for teammates) but fully
 * recoverable, so an accidental discard/reset can't lose work. No-op on a clean
 * tree or a repo with no commits yet.
 */
async function checkpoint(repoDir: string): Promise<CheckpointResult> {
  if (!isGitRepo(repoDir)) return { ok: false, reason: 'not-a-repo' };
  const head = await git(repoDir, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '');
  if (!head) return { ok: false, reason: 'no-head' }; // nothing to base a snapshot on
  if (!(await isDirty(repoDir))) return { ok: true, skipped: 'clean' };
  const tmpIndex = path.join(os.tmpdir(), `radial-idx-${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    await git(repoDir, ['read-tree', 'HEAD'], env); // seed temp index from HEAD
    await git(repoDir, ['add', '-A'], env);         // stage tracked + untracked into temp index
    const tree = await git(repoDir, ['write-tree'], env);
    const branch = await currentBranch(repoDir);
    const msg = `Auto-save snapshot (${branch || 'detached'})`;
    const commit = await git(repoDir, [...await snapshotIdentityArgs(repoDir), 'commit-tree', tree, '-p', 'HEAD', '-m', msg], env);
    await git(repoDir, ['update-ref', '-m', msg, autosaveRef(repoDir), commit]);
    return { ok: true, ref: autosaveRef(repoDir), commit };
  } catch (e) {
    return { ok: false, reason: 'git-error', message: (e as Error).message };
  } finally {
    try { fs.unlinkSync(tmpIndex); } catch {}
  }
}

function isGitRepo(repoDir: string): boolean {
  return fs.existsSync(path.join(repoDir, '.git'));
}

/** Origin's fetch URL, or null if there's none. */
async function getRemote(repoDir: string): Promise<string | null> {
  if (!isGitRepo(repoDir)) return null;
  try { return await git(repoDir, ['remote', 'get-url', 'origin']); } catch { return null; }
}

/** Point `origin` at a URL (adding or updating it). Empty url is a no-op. */
async function changeRemote(repoDir: string, url: string): Promise<string | null> {
  if (!isGitRepo(repoDir)) throw new Error('This project is not a git repository.');
  url = (url || '').trim();
  if (!url) return getRemote(repoDir);
  if (url.startsWith('-') || /[\r\n\0]/.test(url)) throw new Error('Enter a valid repository URL.');
  const existing = await getRemote(repoDir);
  if (existing) await git(repoDir, ['remote', 'set-url', 'origin', url]);
  else await git(repoDir, ['remote', 'add', 'origin', url]);
  const pushOverride = await git(repoDir, ['config', '--get-all', 'remote.origin.pushurl']).catch(() => '');
  if (pushOverride) await git(repoDir, ['config', '--replace-all', 'remote.origin.pushurl', url]);
  return url;
}

const setRemote = (repoDir: string, url: string): Promise<string | null> => withRepoLock(repoDir, () => changeRemote(repoDir, url));

const status = (repoDir: string): Promise<RepoState> => repository.state(repoDir);

// Default to the conventional, *shared* "staging" branch — not a Radial-specific
// namespace — so Radial users and teammates who don't use Radial collaborate on
// the same branch and nobody is forked off / locked in.
const LEGACY_STAGING_BRANCH = 'radial/staging';
const DEFAULT_CONFIG: RadialConfig = {
  productionPublish: 'direct', // 'direct' | 'pr'
  productionBranch: 'main',
  stagingBranch: 'staging',
  commitConfig: false, // commit .radial.json (branch policy, page groups) vs keep local
  hiddenPages: [], // routes marked "draft" — excluded from the deployed site
};

/** Per-project config in `.radial.json` — gitignored/local by default.
 *  Set commitConfig to share it via git. */
function readConfig(repoDir: string): RadialConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(projectData.configPath(repoDir), 'utf8')) as Partial<RadialConfig>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// --- repo hygiene: keep build artifacts out of git -------------------------
// Build output & tool caches that must never be committed. A committed build dir
// bloats the repo AND can mislead the host's framework detection: a stray `.next/`
// left on a plain static site makes Vercel assume a Next App-Router project, then
// the deploy dies hunting for an `app/` source dir that doesn't exist
// ("ENOENT … scandir …/app"). These almost always slip in via a blanket
// `git add -A` on a repo with no .gitignore. Publish ignores them and untracks
// any that already got committed, so the deploy "just works".
const ARTIFACT_IGNORE_LINES = [
  'node_modules/', '.next/', '.nuxt/', '.svelte-kit/', '.astro/',
  '.turbo/', '.vercel/', '.cache/', 'dist/', 'build/', 'out/', 'coverage/', '.DS_Store',
];
const ARTIFACT_IGNORE_HEADER = '# Build output (not committed)';
// Pure caches/deps that are NEVER legitimately tracked — safe to force-untrack.
// (dist/build/out/coverage are only ignored going forward, since a few repos
// deliberately commit built output, e.g. for GitHub Pages.)
const ARTIFACT_UNTRACK_DIRS = ['node_modules', '.next', '.nuxt', '.svelte-kit', '.astro', '.turbo', '.cache'];

// Append any missing lines to .gitignore under one comment header. Idempotent;
// preserves the user's existing entries and Radial's other managed lines. Returns
// the lines it actually added (empty when already covered). Sync + best-effort.
function ensureGitignoreLines(repoDir: string, lines: readonly string[] = ARTIFACT_IGNORE_LINES, header: string = ARTIFACT_IGNORE_HEADER): string[] {
  const gi = path.join(repoDir, '.gitignore');
  let content = '';
  try { content = fs.readFileSync(gi, 'utf8'); } catch {}
  const present = new Set(content.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => !present.has(l));
  if (!missing.length) return [];
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gi, content + `${prefix}${header}\n${missing.join('\n')}\n`, 'utf8');
  return missing;
}

// Untrack already-committed build/cache dirs (keeps the working copy — just stops
// shipping them and re-staging them). One ls-files pass tells us which are really
// tracked, so the returned list is accurate for the steps log.
async function untrackArtifacts(repoDir: string): Promise<string[]> {
  const tracked = (await git(repoDir, ['ls-files']).catch(() => '')).split('\n');
  const removed: string[] = [];
  for (const dir of ARTIFACT_UNTRACK_DIRS) {
    if (!tracked.some((f) => f === dir || f.startsWith(dir + '/'))) continue;
    try { await git(repoDir, ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', dir]); removed.push(dir); }
    catch { /* not a repo / nothing staged — best effort */ }
  }
  return removed;
}

// Self-heal the repo so a deploy can't choke on committed build junk: ignore the
// artifacts and untrack any that were committed by mistake. Best-effort; the
// caller runs this before `git add -A` so the fixes land in the publish commit.
async function ensureRepoHygiene(repoDir: string): Promise<RepoHygieneNote> {
  const note: RepoHygieneNote = { ignored: [], untracked: [] };
  try { note.ignored = ensureGitignoreLines(repoDir); } catch {}
  try { note.untracked = await untrackArtifacts(repoDir); } catch {}
  return note;
}

// Maintain a managed block in .vercelignore listing draft pages' source files, so
// "hidden" pages are kept in the repo but excluded from the Vercel deploy (the
// route simply won't exist on the live site). Reversible; rewritten each change.
function writeHiddenPagesIgnore(repoDir: string, files: readonly string[]): void {
  const vi = path.join(repoDir, '.vercelignore');
  const START = '# drafts — not deployed';
  const END = '# end drafts';
  // Recognize the older Radial-branded markers too, so a half-migrated file
  // collapses to the neutral form instead of accumulating a second block.
  const STARTS = new Set([START, '# Radial: hidden pages (draft — not deployed)']);
  const ENDS = new Set([END, '# Radial: end hidden pages']);
  let lines: string[] = [];
  try { lines = fs.readFileSync(vi, 'utf8').split('\n'); } catch {}
  const out: string[] = [];
  let skip = false;
  for (const l of lines) {
    if (STARTS.has(l.trim())) { skip = true; continue; }
    if (ENDS.has(l.trim())) { skip = false; continue; }
    if (!skip) out.push(l);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  if (files && files.length) {
    if (out.length) out.push('');
    out.push(START, ...files, END);
  }
  if (!out.length) { try { fs.unlinkSync(vi); } catch {} return; }
  fs.writeFileSync(vi, out.join('\n') + '\n', 'utf8');
}

function writeConfig(repoDir: string, config: Partial<RadialConfig>): RadialConfig {
  const merged = { ...readConfig(repoDir), ...config };
  fs.writeFileSync(projectData.configPath(repoDir), JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

/**
 * Put the working tree on the dedicated edit branch so main is never dirtied
 * directly and a half-finished edit can't go live. Created from the base branch
 * if it doesn't exist yet.
 */
async function currentBranch(repoDir: string): Promise<string | null> {
  return git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null);
}

async function isDirty(repoDir: string): Promise<boolean> {
  const state = await repository.state(repoDir);
  if (!state.ok) throw new Error(state.message || 'Could not read Git status.');
  return state.changes.length > 0;
}

/** Local branches + remote-only branches, and which one is checked out. */
async function listBranches(repoDir: string): Promise<BranchList> {
  if (!isGitRepo(repoDir)) return { ok: false, current: null, branches: [], remoteOnly: [] };
  const current = await currentBranch(repoDir);
  let local: string[] = [];
  try { local = (await git(repoDir, ['branch', '--format=%(refname:short)'])).split('\n').map((s) => s.trim()).filter(Boolean); } catch {}
  let remoteOnly: string[] = [];
  try {
    const localSet = new Set(local);
    const r = (await git(repoDir, ['branch', '-r', '--format=%(refname:short)'])).split('\n').map((s) => s.trim()).filter(Boolean);
    remoteOnly = [...new Set(r.filter((b) => !/\/HEAD$/.test(b)).map((b) => b.replace(/^[^/]+\//, '')))].filter((b) => b && !localSet.has(b));
  } catch {}
  return { ok: true, current, branches: local, remoteOnly };
}

/**
 * Check out a branch. We let git carry non-conflicting local changes across the
 * switch (its normal behavior) instead of pre-refusing on any dirty tree — our
 * own metadata writes (.radial.json, etc.) would otherwise block every switch.
 * git only aborts when a changed file genuinely differs between the branches;
 * that's the one case we surface as "commit/stash first".
 */
async function _switchBranch(repoDir: string, name: string, opts: SwitchBranchOptions = {}): Promise<BranchSwitchResult> {
  if (!isGitRepo(repoDir)) return { ok: false, reason: 'not-a-repo' };
  name = (name || '').trim();
  if (!name) return { ok: false, reason: 'no-name' };
  if ((await currentBranch(repoDir)) === name) return { ok: true, branch: name };
  try {
    if (await integration.read(repoDir) || await repository.operation(repoDir)) return { ok: false, reason: 'operation-in-progress', message: 'Finish the current Git operation first.' };
    await git(repoDir, ['check-ref-format', '--branch', name]);
    await git(repoDir, ['checkout', '--no-overwrite-ignore', name]);
    return { ok: true, branch: await currentBranch(repoDir) };
  } catch (e) {
    const msg = (e as Error).message || '';
    if (/overwritten by checkout|local changes|would be overwritten/i.test(msg)) {
      // Local edits (often the agent's) clash with the target branch's version.
      if (opts.stash) return await stashAndSwitch(repoDir, name);
      // Pull the conflicting file names out of git's message for a useful hint.
      const files = (msg.match(/^\t(.+)$/gm) || []).map((l) => l.trim());
      return { ok: false, reason: 'conflict', files };
    }
    return { ok: false, reason: 'git-error', message: msg };
  }
}

// "Stash & switch": carry the uncommitted edits across the branch change
// (stash → checkout → pop) so a working edit never blocks switching. If the
// edits then conflict with the target branch's version, they're re-applied with
// conflict markers on the new branch and we surface them for the agent to merge.
async function stashAndSwitch(repoDir: string, name: string): Promise<BranchSwitchResult> {
  const result = await integration.switchTo(repoDir, name);
  // A switched checkout with replay conflicts is a completed switch, with an
  // integration operation still available for explicit resolution or abort.
  return result.popConflict ? { ...result, ok: true } : result;
}

/**
 * Which branch should edits land on?
 *  - If the user explicitly configured a staging branch, honor it.
 *  - Otherwise prefer the branch they're already on (so a repo that already uses
 *    its own `staging`/`develop` branch "just works"), unless that's production.
 *  - Else fall back to the default edit branch.
 */
function effectiveEditBranch(cfg: RadialConfig, current: string | null): string {
  // A saved `radial/staging` is the OLD default — treat it as "not configured"
  // so existing projects migrate to the shared `staging` (or their current branch).
  const sb = cfg.stagingBranch;
  const configured = sb && sb !== DEFAULT_CONFIG.stagingBranch && sb !== LEGACY_STAGING_BRANCH;
  if (configured) return sb;
  // Prefer the branch they're already on (e.g. a team's `staging`/`develop`),
  // but never the old `radial/staging` — migrate that to the shared `staging`.
  if (current && current !== cfg.productionBranch && current !== LEGACY_STAGING_BRANCH) return current;
  return DEFAULT_CONFIG.stagingBranch;
}

/**
 * Get onto the edit branch WITHOUT ever clobbering uncommitted edits. Returns
 * the branch we actually ended up on (the caller commits/pushes that).
 *  - Already on it → done.
 *  - Exists, tree clean → switch to it.
 *  - Exists, tree dirty → stay put (switching could abort / lose work); commit here.
 *  - Doesn't exist → create it from the CURRENT HEAD so the working tree (and any
 *    in-progress edits) is preserved. Basing it off another branch resets the tree
 *    and aborts when there are uncommitted changes — the bug we're avoiding.
 */
async function ensureEditBranch(repoDir: string, _baseBranch: string, editBranch: string): Promise<string | null> {
  if (!isGitRepo(repoDir)) return null;
  const current = await currentBranch(repoDir);
  if (current === editBranch) return editBranch;
  const exists = (await git(repoDir, ['branch', '--list', editBranch]).catch(() => '')).trim();
  if (exists) {
    if (await isDirty(repoDir)) return current; // don't risk the dirty tree
    await git(repoDir, ['checkout', editBranch]);
    return editBranch;
  }
  await git(repoDir, ['checkout', '-b', editBranch]); // from current HEAD — never conflicts
  return editBranch;
}

/**
 * Resolve + get onto the branch edits should live on, given the repo's config.
 * Used both when opening a project and when publishing, so they always agree.
 */
async function prepareEditBranch(repoDir: string, cfg: RadialConfig): Promise<string> {
  const current = await currentBranch(repoDir);
  const desired = effectiveEditBranch(cfg, current);
  return (await ensureEditBranch(repoDir, cfg.productionBranch, desired)) || desired;
}

/** The branch a staging publish would actually use right now (no switching). */
async function resolveEditBranchName(repoDir: string, cfg: RadialConfig): Promise<string> {
  if (!isGitRepo(repoDir)) return cfg.stagingBranch || DEFAULT_CONFIG.stagingBranch;
  return effectiveEditBranch(cfg, await currentBranch(repoDir));
}

/**
 * Pull the latest from origin for the current branch (fast-forward only, so we
 * never create surprise merge commits). Falls back to an explicit
 * `pull origin <branch>` when the branch has no upstream configured yet.
 */
const pull = (repoDir: string): Promise<IntegrationResult> => withRepoLock(repoDir, () => integration.start(repoDir));

const syncStatus = (repoDir: string, opts?: SyncStatusOptions): Promise<RepoSync> => repository.syncStatus(repoDir, opts);
async function incomingCommits(repoDir: string): Promise<IncomingCommit[]> {
  const state = await syncStatus(repoDir, { fetch: false });
  if (!state.ok || !state.exists) return [];
  return (await integration.preview(repoDir, state.sha)).incoming;
}
const _sync = (repoDir: string, opts?: SyncOptions) => integration.start(repoDir, opts);
async function resolveSync(repoDir: string, strategy: SyncResolveStrategy): Promise<ResolveResult> {
  return withRepoLock(repoDir, async () => {
    if (typeof strategy === 'object') return integration.resolve(repoDir, strategy);
    const info = await integration.conflicts(repoDir);
    if (!info.ok) return info;
    for (const { file } of info.files) {
      const result = await integration.resolve(repoDir, { file, strategy });
      if (!result.ok) return result;
    }
    return integration.finalize(repoDir);
  });
}
const finalizeSync = (repoDir: string): Promise<FinalizeResult> => withRepoLock(repoDir, () => integration.finalize(repoDir));
const abortSync = (repoDir: string): Promise<AbortResult> => withRepoLock(repoDir, () => integration.abort(repoDir));

function hasGh(): Promise<boolean> {
  return new Promise((resolve) => {
    (require('child_process') as typeof import('child_process')).execFile(which('gh') || 'gh', ['--version'], { env: childEnv() }, (err) => resolve(!err));
  });
}

/** Run a command without ever throwing. Returns { ok, code, stdout, stderr }. */
function run(bin: string, args: readonly string[], extraEnv?: NodeJS.ProcessEnv, cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env: childEnv(extraEnv), timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      }));
  });
}

/** GitHub CLI presence + sign-in state (gh, once authed, can serve git creds). */
async function ghStatus(): Promise<GhStatus> {
  const bin = which('gh');
  if (!bin) return { installed: false, authed: false, user: null };
  const r = await run(bin, ['auth', 'status']);
  const blob = `${r.stderr}\n${r.stdout}`;
  const m = blob.match(/Logged in to \S+ (?:as|account) (\S+)/i) || blob.match(/account (\S+)/i);
  return { installed: true, authed: r.ok, user: m ? m[1] : null };
}

/** Parse a git remote URL into { host, protocol, owner, repo }, or null. */
function parseRemote(url: string): NonNullable<PushAuth['parsed']> | null {
  if (!url) return null;
  let m = url.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (m) return { host: m[1], protocol: 'ssh', owner: m[2], repo: m[3] };
  m = url.match(/^ssh:\/\/git@([^/:]+)(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (m) return { host: m[1], protocol: 'ssh', owner: m[2], repo: m[3] };
  m = url.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (m) return { host: m[1], protocol: 'https', owner: m[2], repo: m[3] };
  return null;
}

/**
 * Will `git push` to origin actually succeed on this machine? We can't truly
 * test write access without writing, so we exercise the *exact* credential path
 * a push uses with a read-only `git ls-remote` — prompts disabled so it fails
 * fast instead of hanging. Success ⇒ the remote is reachable and credentials
 * resolve. We also report gh state and tailor a fix hint by protocol, so a
 * tester learns this *before* making edits, not when the push blows up.
 */
async function checkPushAuth(repoDir: string): Promise<PushAuth> {
  // `status` is set before every return.
  const res = { isRepo: isGitRepo(repoDir), hasRemote: false, remote: null, ready: false } as PushAuth;
  if (!res.isRepo) { res.status = 'not-a-repo'; res.hint = 'This folder isn’t a git repository, so it can’t publish.'; return res; }

  const remote = await getRemote(repoDir);
  res.remote = remote; res.hasRemote = !!remote;
  res.gh = await ghStatus();

  if (!remote) { res.status = 'no-remote'; res.hint = 'No “origin” remote yet. Add your GitHub repo URL below.'; return res; }

  const p = parseRemote(remote);
  res.parsed = p;
  res.protocol = p ? p.protocol : null;
  res.isGitHub = !!(p && /(^|\.)github\.com$/i.test(p.host));

  const ls = await run(which('git') || 'git', ['ls-remote', '--heads', 'origin'], {
    GIT_TERMINAL_PROMPT: '0', // don't block on a credential prompt
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    GCM_INTERACTIVE: 'never',
  }, repoDir);

  if (ls.ok) { res.ready = true; res.status = 'ready'; return res; }
  res.error = (ls.stderr || 'Could not reach the remote.').slice(-400);

  if (res.isGitHub && res.protocol === 'https') {
    if (!res.gh.installed) {
      res.status = 'need-gh-install';
      res.hint = 'Sign in to GitHub to push. Install the GitHub CLI (run “brew install gh”), then click Connect.';
    } else if (!res.gh.authed) {
      res.status = 'need-gh-login';
      res.hint = 'You’re not signed in to GitHub. Click Connect to run “gh auth login” in the terminal.';
    } else {
      res.status = 'gh-not-wired';
      res.hint = 'Signed in to GitHub, but git isn’t using that login yet. Click Connect to wire it up.';
    }
  } else if (res.protocol === 'ssh') {
    res.status = 'ssh-failed';
    res.hint = 'Your SSH key isn’t set up for this remote. Add your key to GitHub, or switch the remote to an https:// URL below and Connect.';
  } else {
    res.status = 'unreachable';
    res.hint = 'Couldn’t authenticate to the remote. Check the URL and your credentials.';
  }
  return res;
}

/** One-click fix for the "gh authed but git not wired" case (non-interactive). */
async function ghSetupGit(): Promise<GhSetupResult> {
  const bin = which('gh');
  if (!bin) return { ok: false, error: 'GitHub CLI not installed.' };
  const r = await run(bin, ['auth', 'setup-git']);
  return { ok: r.ok, error: r.ok ? null : (r.stderr || 'gh auth setup-git failed') };
}

function compareUrlFromRemote(remote: string, base: string, head: string): string | null {
  // git@github.com:owner/repo.git  or  https://github.com/owner/repo(.git)
  let m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/compare/${base}...${encodeURIComponent(head)}?expand=1`;
}

// --- auto-commit (local, never pushed) -------------------------------------
// Marks each auto-commit with a git trailer so Publish can find and squash the
// run. A trailer is robust where a body grep is not (a generated message could
// contain a bracket marker; a user's terminal commit won't carry this trailer).
const AUTO_TRAILER = 'Auto-Save: true';
// Older auto-saves carried this trailer; still recognized so an in-flight run
// from a previous version squashes cleanly instead of leaking to the remote.
const LEGACY_AUTO_TRAILER = 'Radial-Auto: true';
const AUTO_MIN_INTERVAL_MS = 60 * 1000;
const _lastAutoCommit = new Map<string, number>(); // repoDir -> ms timestamp of last auto-commit

async function mergeOrRebaseInProgress(repoDir: string): Promise<boolean> {
  return !!(await repository.operation(repoDir)) || !!(await integration.read(repoDir));
}

async function hasGitIdentity(repoDir: string): Promise<boolean> {
  const name = await git(repoDir, ['config', 'user.name']).catch(() => '');
  const email = await git(repoDir, ['config', 'user.email']).catch(() => '');
  return !!(name && email);
}
// Inline identity so a repo with no configured user can still commit (matches
// the fallback in github.commitAll). Only applied when none is configured —
// attributed to the OS user, never to Radial, so pushed history stays neutral.
function identityArgs(has: boolean): string[] {
  if (has) return [];
  const n = repository.fallbackName();
  return ['-c', `user.name=${n}`, '-c', `user.email=${n}@localhost`];
}
/**
 * The identity Radial's own snapshot commits need (moments, the auto-save
 * checkpoint, a publish build's snapshot): what the repo doesn't configure,
 * filled in as the OS user (repository.missingIdentityArgs).
 */
const snapshotIdentityArgs = (repoDir: string): Promise<string[]> => repository.missingIdentityArgs(repoDir);

async function isAutoCommit(repoDir: string, sha: string): Promise<boolean> {
  const body = await git(repoDir, ['log', '-1', '--format=%B', sha]).catch(() => '');
  return body.split('\n').some((l) => { const t = l.trim(); return t === AUTO_TRAILER || t === LEGACY_AUTO_TRAILER; });
}
async function parentsOf(repoDir: string, sha: string): Promise<string[]> {
  const out = await git(repoDir, ['rev-list', '--parents', '-n', '1', sha]).catch(() => '');
  return out.split(/\s+/).filter(Boolean).slice(1); // drop sha; keep parents
}
async function isAncestor(repoDir: string, sha: string, ref: string): Promise<boolean> {
  try { await git(repoDir, ['merge-base', '--is-ancestor', sha, ref]); return true; }
  catch { return false; }
}

/**
 * The commit to `reset --soft` onto to collapse the unpushed [Radial-Auto] run at
 * the tip of `branch` into one commit. Walks first-parent from HEAD while each
 * commit is auto-marked AND single-parent AND not yet pushed. Returns null (→ no
 * squash) the instant any condition fails, or when HEAD is detached or a
 * merge/rebase is mid-flight. Never crosses a pushed or real commit, so the
 * follow-up Publish push stays fast-forward and teammates' merged commits are
 * never rewritten — the exact failure model (A) was chosen to avoid.
 */
async function autoSquashBase(repoDir: string, branch: string): Promise<string | null> {
  const cur = await currentBranch(repoDir);
  if (!cur || cur === 'HEAD') return null;           // detached HEAD
  if (await mergeOrRebaseInProgress(repoDir)) return null; // mid-merge / mid-rebase
  const upstream = `origin/${branch}`;
  const hasUpstream = !!(await git(repoDir, ['rev-parse', '--verify', '-q', upstream]).catch(() => ''));
  let sha = await git(repoDir, ['rev-parse', 'HEAD']).catch(() => '');
  let base: string | null = null;
  while (sha) {
    const parents = await parentsOf(repoDir, sha);
    if (parents.length !== 1) break;                                   // merge or root
    if (!(await isAutoCommit(repoDir, sha))) break;                    // a real commit
    if (hasUpstream && (await isAncestor(repoDir, sha, upstream))) break; // already pushed
    base = parents[0];
    sha = parents[0];
  }
  return base;
}

/** Collapse the unpushed [Radial-Auto] run into the staged index (caller commits
 *  it as one clean commit). No-op + false when there's no safe run to squash. */
async function squashAutoRun(repoDir: string, branch: string): Promise<boolean> {
  const base = await autoSquashBase(repoDir, branch);
  if (!base) return false;
  await git(repoDir, ['reset', '--soft', base]); // keep tree+index, move branch tip to base
  return true;
}

/**
 * Deterministic commit subject from `git status --porcelain` output:
 * "Update hero.html", "Update hero.html and styles.css", "Update hero.html,
 * styles.css and 2 more files". No agent involved — background commits and
 * publish must never spend the user's AI quota. Returns '' when nothing parses.
 */
function subjectFromStatus(porcelain: string): string {
  const files = String(porcelain || '').split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const p = l.replace(/^\S+\s+/, ''); // strip the XY status column
      const arrow = p.indexOf(' -> '); // rename lines: keep the new path
      return (arrow >= 0 ? p.slice(arrow + 4) : p).replace(/^"|"$/g, '');
    })
    .filter(Boolean);
  if (!files.length) return '';
  const names = [...new Set(files.map((f) => path.basename(f)))];
  let subject: string;
  if (names.length === 1) subject = `Update ${names[0]}`;
  else if (names.length === 2) subject = `Update ${names[0]} and ${names[1]}`;
  else subject = `Update ${names[0]}, ${names[1]} and ${names.length - 2} more file${names.length - 2 === 1 ? '' : 's'}`;
  if (subject.length > 72) subject = `Update ${names.length} file${names.length === 1 ? '' : 's'}`;
  return subject;
}

/**
 * Auto-commit the working tree onto the current edit branch as a distinct
 * [Radial-Auto] commit — local only, never pushed, never on production. Serialized
 * per repo (withRepoLock) so it can't race Publish/Sync on `.git/index.lock`.
 * Skips: clean tree, too-soon repeat (min-interval), production/detached HEAD,
 * mid-merge/rebase. The subject is derived deterministically from the staged
 * file list (subjectFromStatus) — no agent call, so background saves never
 * consume the user's AI quota. The message is read from the STAGED snapshot and
 * the commit commits the index, so a concurrent edit can't change what lands
 * (it's picked up on the next trigger).
 */
async function autoCommit(repoDir: string, opts: AutoCommitOptions = {}): Promise<AutoCommitResult> {
  return withRepoLock(repoDir, async () => {
    if (!isGitRepo(repoDir)) return { ok: false, reason: 'not-a-repo' };
    const cfg = readConfig(repoDir);
    const branch = await currentBranch(repoDir);
    if (!branch || branch === 'HEAD') return { ok: false, reason: 'detached' };
    if (branch === cfg.productionBranch) return { ok: false, reason: 'production' };
    if (await mergeOrRebaseInProgress(repoDir)) return { ok: false, reason: 'merge-in-progress' };
    if (!opts.force) {
      const last = _lastAutoCommit.get(repoDir) || 0;
      if (Date.now() - last < AUTO_MIN_INTERVAL_MS) return { ok: false, reason: 'min-interval' };
    }
    // A genuinely clean tree is a no-op — don't even touch .gitignore, so an idle
    // repo never produces a spurious artifact-ignore commit.
    if (!(await isDirty(repoDir))) return { ok: true, skipped: 'clean' };
    // There's something to save: keep build artifacts out of it first (a stray
    // .next/, dist/, etc. must never be swept in by `add -A` — that's how they get
    // committed in the first place). If only artifacts changed, the staged set
    // comes back empty below and we still skip. Heavier untracking runs at publish.
    try { ensureGitignoreLines(repoDir); } catch {}
    await git(repoDir, ['add', '-A']);
    const staged = (await git(repoDir, ['status', '--porcelain']).catch(() => '')).trim();
    if (!staged) return { ok: true, skipped: 'clean' };
    const subject = subjectFromStatus(staged) || 'Auto-save';
    const has = await hasGitIdentity(repoDir);
    try {
      await git(repoDir, [...identityArgs(has), 'commit', '-m', subject, '-m', AUTO_TRAILER]);
    } catch (e) {
      return { ok: false, reason: 'commit-failed', message: String((e as Error).message).slice(-200) };
    }
    _lastAutoCommit.set(repoDir, Date.now());
    const sha = await git(repoDir, ['rev-parse', '--short', 'HEAD']).catch(() => '');
    return { ok: true, committed: true, branch, sha, subject };
  });
}

async function _publish(repoDir: string, opts: PublishRunOptions = {}): Promise<PublishResult> {
  const steps: string[] = [];
  let receipt: DraftReceipt | null = null;
  try {
    const initial = await repository.state(repoDir);
    if (!initial.isRepo) return { ok: false, reason: 'not-a-git-repo', message: 'This project is not a git repository.' };
    if (!initial.ok) return initial;
    if (!initial.branch) return { ok: false, reason: 'detached', message: 'Create or switch to a branch before publishing.' };
    if (initial.operation || initial.conflicts.length || await integration.read(repoDir)) return { ok: false, reason: 'operation-in-progress', message: 'Finish or abort the current integration before publishing.' };
    if (opts.expectedHead && initial.head !== opts.expectedHead) return { ok: false, reason: 'checkout-changed', message: 'The checkout changed. Review the publish action again.' };
    const cfg = readConfig(repoDir);
    const current = initial.branch;
    const target = opts.target || 'staging';
    if (!['staging', 'production', 'branch'].includes(target)) throw new Error('Choose a publish destination.');
    const destination = opts.branch || (target === 'production' ? cfg.productionBranch : target === 'branch' ? current : effectiveEditBranch(cfg, current));
    await repository.run(repoDir, ['check-ref-format', `refs/heads/${destination}`]);
    const remote = initial.remote;
    if (opts.expectedRemote !== undefined && opts.expectedRemote !== remote) return { ok: false, reason: 'remote-changed', message: 'The repository connection changed. Review the destination again before pushing.' };
    const shouldPush = opts.push !== false && !!remote;
    const pushTarget = shouldPush ? await repository.pushTarget(repoDir, remote) : null;
    if (pushTarget && !pushTarget.ok) return pushTarget;
    const review = require('./githubReview') as typeof import('./githubReview');
    const slug = shouldPush ? await review.slug(repoDir) : null;
    const capabilities = slug ? await review.capabilities(slug, destination) : null;
    const collaboration = require('./collaboration') as typeof import('./collaboration');
    const host = (shouldPush && target === 'production') || opts.expectedDeployment ? await collaboration.hosting(repoDir) : null;
    // The `!`s on host: hosting() ran for a production push and whenever a deployment was expected.
    if (shouldPush && target === 'production') {
      if (host!.ok && host!.gitRepo?.toLowerCase() === slug?.toLowerCase() && host!.productionBranch && host!.productionBranch !== destination) return { ok: false, reason: 'production-mismatch', message: `Publish settings target ${destination}, but Vercel reports ${host!.productionBranch} as production. Update the project settings before continuing.` };
    }
    const wantsPr = !!opts.pr || (target === 'production' && cfg.productionPublish === 'pr') || capabilities?.requiresPr;
    if (opts.expectedPr !== undefined && !!wantsPr !== opts.expectedPr) return { ok: false, reason: 'plan-changed', message: 'The GitHub workflow changed. Check the updated action before publishing.' };
    if (opts.expectedDeployment) {
      const effect = collaboration.destination(host!, destination, slug);
      const actual: DeploymentEffect = { state: effect.state, production: !!effect.production, projectId: host!.projectId || null, orgId: host!.orgId || null };
      if (JSON.stringify(actual) !== JSON.stringify(opts.expectedDeployment)) return { ok: false, reason: 'plan-changed', message: 'The hosting destination changed. Check the updated deployment action before publishing.' };
    }
    if (wantsPr && capabilities?.canPush === false) return { ok: false, reason: 'permission', message: 'The connected GitHub API account cannot submit this contribution. Check the connected account or ask a repository administrator.' };
    let pushBranch = destination;
    if (wantsPr) {
      if (!slug && shouldPush) return { ok: false, reason: 'github-required', message: 'Connect GitHub to open a pull request.' };
      pushBranch = current !== destination ? current : `${projectData.isLocal(repoDir) ? 'update' : 'radial/update'}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      if (current === destination) {
        const previous: SavedReceipt | null = await publishReceipt(repoDir);
        if (previous?.mode === 'pr' && previous.from === current && previous.base === destination) {
          const open = previous.prNumber && slug ? await review.request(`repos/${slug}/pulls/${previous.prNumber}`) as GitHubApiResult<GitHubPullRequest> : null;
          if (previous.reason === 'pr-failed' || (open?.ok && open.data.state === 'open')) pushBranch = previous.branch;
        }
      }
    }
    if (shouldPush && initial.head) {
      const relation = await repository.compare(repoDir, { remote: 'origin', branch: pushBranch, ref: `refs/remotes/origin/${pushBranch}` });
      if (relation.exists && relation.behind > 0) return { ok: false, reason: 'integration-required', branch: pushBranch, ahead: relation.ahead, behind: relation.behind,
        message: `${pushBranch} has ${relation.behind} incoming commit(s). Integrate that branch before pushing; your local work has not been changed.` };
    }
    if (opts.expectedFingerprint && await repository.fingerprint(repoDir) !== opts.expectedFingerprint) return { ok: false, reason: 'checkout-changed', message: 'Files or staging changed since this action was reviewed. Refresh and review the latest changes.' };
    if (shouldPush && (!(await repository.pushTarget(repoDir, remote)).ok || await getRemote(repoDir) !== remote)) return { ok: false, reason: 'remote-changed', message: 'The repository connection changed. Refresh before publishing.' };
    // Automatic commits are opt-in. Only collapse their unpublished tail after
    // refreshing the destination; preserve user-created commits and staging.
    if (opts.squashAutosaves && opts.scope !== 'staged' && opts.commit !== false && await squashAutoRun(repoDir, current)) steps.push('squashed auto-saves');
    if (opts.commit !== false) {
      if (opts.scope !== 'staged') await git(repoDir, ['add', '-A']);
      const pending = await repository.run(repoDir, ['diff', '--cached', '--name-only', '-z'], { raw: true });
      if (pending) {
        const branch = await currentBranch(repoDir);
        if (branch !== current) throw new Error('Another tool switched branches. Review the checkout before committing.');
        const files = pending.split('\0').filter(Boolean);
        const message = (opts.message || '').trim() || (files.length === 1 ? `Update ${path.basename(files[0])}` : `Update ${files.length} files`);
        await git(repoDir, [...identityArgs(await hasGitIdentity(repoDir)), 'commit', '-m', message]);
        steps.push('committed edits');
      } else steps.push('nothing new to commit');
    }
    const sha = await git(repoDir, ['rev-parse', '--verify', 'HEAD']);
    receipt = { ok: true, at: Date.now(), target, mode: wantsPr ? 'pr' : target === 'staging' ? 'preview' : 'direct', branch: pushBranch, base: wantsPr ? destination : null,
      from: current, sha, pushed: false, remote, steps, deployment: { state: 'unknown' } };
    const receiptFile = await repository.gitPath(repoDir, 'radial-publish.json');
    const remember = () => fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
    remember();
    if (typeof opts.beforePush === 'function') {
      const gate = await opts.beforePush(sha);
      if (!gate.ok) { receipt = { ...receipt, ...gate, ok: false, steps }; remember(); return receipt as FailedPublishReceipt; }
      if (gate.deploy) { receipt.deploy = gate.deploy; remember(); }
    }
    if (!shouldPush) { steps.push(remote ? 'saved locally; push skipped' : 'no origin remote; saved locally'); remember(); return receipt as PublishReceipt; }
    if (current !== await currentBranch(repoDir)) return { ...receipt, ok: false, reason: 'checkout-changed', message: 'Another tool switched branches during the build. Review the destination before pushing.' };
    if (await getRemote(repoDir) !== remote) return { ...receipt, ok: false, reason: 'remote-changed', message: 'The repository connection changed during the build. Your commit is saved locally. Review the destination again.' };
    const currentTarget = await repository.pushTarget(repoDir, remote);
    // The `!`s on pushTarget: it was read (and was ok) because shouldPush is true.
    if (!currentTarget.ok || currentTarget.url !== pushTarget!.url) return { ...receipt, ok: false, reason: 'remote-changed', message: 'The Git push destination changed during the build. Your commit is saved locally. Refresh before publishing.' };
    // Pin the checked URL so a later origin.pushurl change cannot redirect this push.
    await repository.run(repoDir, ['push', '--', pushTarget!.url, `${sha}:refs/heads/${pushBranch}`], { timeout: 120000 });
    receipt.pushed = true;
    steps.push(`pushed ${sha.slice(0, 8)} → ${pushBranch}`);
    remember();
    if (pushBranch === current && !(await git(repoDir, ['config', '--get', `branch.${current}.remote`]).catch(() => ''))) {
      await git(repoDir, ['config', `branch.${current}.remote`, 'origin']);
      await git(repoDir, ['config', `branch.${current}.merge`, `refs/heads/${pushBranch}`]);
    }
    if (wantsPr) {
      if (current === destination) {
        const existing = await git(repoDir, ['show-ref', '--verify', `refs/heads/${pushBranch}`]).catch(() => null);
        if (!existing) { await git(repoDir, ['branch', pushBranch, sha]); steps.push(`created local branch ${pushBranch}`); }
      }
      // The `!`: wanting a pull request with a push and no slug returned github-required above.
      const pr = await review.create(slug!, { head: pushBranch, base: destination, title: opts.message || `Update site (${pushBranch})` });
      if (!pr.ok) { receipt.ok = false; receipt.reason = 'pr-failed'; receipt.message = `The branch was pushed, but the pull request could not be opened: ${pr.error}`; }
      else { receipt.prUrl = pr.pr.html_url; receipt.prNumber = pr.pr.number; steps.push(pr.existing ? 'updated existing pull request' : 'opened pull request'); }
    }
    remember();
    return receipt as PublishReceipt | FailedPublishReceipt;
  } catch (error) {
    const protection = /protected branch|GH006|GH013|changes must be made through a pull request|repository rule/i.test((error as Error).message);
    const rejected = /non-fast-forward|fetch first|updates were rejected/i.test((error as Error).message);
    const result: PublishResult = { ...(receipt || {}), ok: false, reason: protection ? 'pr-required' : rejected ? 'integration-required' : 'git-error', message: (error as Error).message, steps };
    if (receipt) fs.writeFileSync(await repository.gitPath(repoDir, 'radial-publish.json'), JSON.stringify(result, null, 2));
    return result;
  }
}

async function publishReceipt(repoDir: string): Promise<StoredReceipt | null> {
  const file = await repository.gitPath(repoDir, 'radial-publish.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as StoredReceipt; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

// Public entry points that mutate the REAL git index run one-at-a-time per repo
// (withRepoLock), so concurrent IPC calls (auto-commit vs Publish vs Sync vs a
// branch switch) can't collide on `.git/index.lock`. autoCommit acquires the
// same lock internally.
const publish = (repoDir: string, opts?: PublishRunOptions): Promise<PublishResult> => withRepoLock(repoDir, () => _publish(repoDir, opts));
const sync = (repoDir: string, opts?: SyncOptions): Promise<IntegrationResult> => withRepoLock(repoDir, () => _sync(repoDir, opts));
const switchBranch = (repoDir: string, name: string, opts?: SwitchBranchOptions): Promise<BranchSwitchResult> => withRepoLock(repoDir, () => _switchBranch(repoDir, name, opts));

/**
 * Where a publish to target would push now, as _publish picks it: the branch,
 * and whether it is the project's production branch. An agent's publish needs
 * --yes whenever it lands there, whatever target named it: pushing the
 * current branch while that branch is production goes live too.
 */
async function destination(repoDir: string, target: PublishTarget): Promise<{ branch: string | null; production: boolean }> {
  const cfg = readConfig(repoDir);
  let current: string | null = null;
  try { const st = await repository.state(repoDir); if (st.isRepo && st.ok) current = st.branch || null; } catch {}
  const branch = target === 'production' ? cfg.productionBranch : target === 'branch' ? current : effectiveEditBranch(cfg, current);
  return { branch, production: target === 'production' || (!!branch && branch === cfg.productionBranch) };
}

export { destination, status, publish, publishReceipt, isGitRepo, git, snapshotIdentityArgs, readConfig, writeConfig, writeHiddenPagesIgnore, ensureEditBranch, prepareEditBranch, resolveEditBranchName, getRemote, setRemote, checkPushAuth, ghSetupGit, listBranches, switchBranch, pull, checkpoint, syncStatus, incomingCommits, sync, resolveSync, finalizeSync, abortSync, ensureGitignoreLines, untrackArtifacts, ensureRepoHygiene, autoCommit, squashAutoRun, withRepoLock, subjectFromStatus };
