// Check the candidate commit in a detached worktree before an ordinary Git push.
// Local build success and hosting deployment success are separate observations.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { childEnv } from './env';
import * as publish from './publish';
import * as devServer from './devServer';
import type { NodeProject, PackageJson, StaticProject } from './devServer';
import type { PublishGate } from './publish';
import type { BuildGate, BuildGateSummary, DetectedProject, PackageManager, PublishDeployResult, PublishEvent, PublishOptions, PublishResult } from '../shared/radialApi';

/** runCmd()'s options: where and how long to run, and a callback for each chunk of output as it arrives. */
interface RunCmdOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; onLog?: (text: string) => void }
/** runCmd(): never rejects; code is the exit code (1 when there's none), out the combined output. */
interface RunCmdResult { ok: boolean; code: number; out: string; timedOut: boolean }
/** detectBuild(): what "build" means for the project, with the project as devServer.detectProject saw it. */
export type BuildPlan =
  | { kind: 'static'; project: StaticProject }
  | { kind: 'unknown'; project: Extract<DetectedProject, { type: 'unknown' }> }
  | { kind: 'no-build-script'; project: NodeProject }
  | { kind: 'node'; project: NodeProject; pm: PackageManager };
/** buildGate()'s options: a callback for the build's output, and the commit to check (without it, a snapshot of the working tree). */
export interface BuildGateOptions { onLog?: (text: string) => void; sha?: string }
/** classifyPublishError()'s input: a publish result, or as much of one as it reads. */
export type PublishOutcome = { ok: true } | { ok: false; reason?: Extract<PublishResult, { ok: false }>['reason']; message?: string };
/** A push rejection the agent can fix (pushFixPrompt's kind). */
export type FixablePushError = 'large-file' | 'non-ff' | 'rejected';
/** classifyPublishError(): whether the agent can fix the failed push, and what kind of failure it is. */
export type PublishErrorDiagnosis =
  | { fixable: false; kind?: 'not-a-repo' | 'protected' | 'auth' | 'other' }
  | { fixable: true; kind: FixablePushError };
/** Omit applied to each member of a union (plain Omit keeps only the shared keys), like radialApi's own OmitEach. */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** publishAndDeploy()'s progress events: radialApi's PublishEvent without the repoDir, which main.ts adds when it forwards them as 'publish:event'. */
export type DeployEvent = OmitEach<PublishEvent, 'repoDir'>;
/** publishAndDeploy()'s hooks: onEvent gets the progress. */
export interface DeployHooks { onEvent?: (event: DeployEvent) => void }
/**
 * publish()'s result as publishAndDeploy reads it across the union: deploy and
 * sha are set once publish() has committed (the receipts, and the
 * checkout-changed/remote-changed refusals after the build, which spread the
 * receipt), and absent on the refusals before a commit.
 */
type PublishResultRead = PublishResult & { deploy?: BuildGateSummary; sha?: string };

const git = publish.git;

const BUILD_TIMEOUT_MS = 4 * 60 * 1000;

/** Run a command, never throwing. Streams combined output via onLog. */
function runCmd(cmd: string, args: string[], { cwd, env, timeout = BUILD_TIMEOUT_MS, onLog = () => {} }: RunCmdOptions = {}): Promise<RunCmdResult> {
  return new Promise((resolve) => {
    let out = '';
    const child = execFile(cmd, args, { cwd, env: childEnv(env), timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        out = (stdout || '') + (stderr || '');
        resolve({ ok: !err, code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), out, timedOut: !!(err && err.killed) });
      });
    const pipe = (buf: string | Buffer): void => { const s = buf.toString(); out += s; onLog(s); };
    if (child.stdout) child.stdout.on('data', pipe);
    if (child.stderr) child.stderr.on('data', pipe);
  });
}

/**
 * What does "build" mean for this project?
 *  - static            → nothing to build; the host serves files as-is.
 *  - node + build cmd  → run it (this is the gate).
 *  - node, no build    → can't meaningfully gate (e.g. a plain `start` server).
 */
function detectBuild(repoDir: string): BuildPlan {
  const project = devServer.detectProject(repoDir);
  if (!project || project.type === 'static') return { kind: 'static', project };
  if (project.type !== 'node') return { kind: 'unknown', project };
  let pkg: PackageJson = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')); } catch {}
  const hasBuild = !!(pkg.scripts && typeof pkg.scripts.build === 'string' && pkg.scripts.build.trim());
  if (!hasBuild) return { kind: 'no-build-script', project };
  return { kind: 'node', project, pm: project.pm || 'npm' };
}

// --- isolated snapshot build ----------------------------------------------

/** Ephemeral commit of the ENTIRE working tree (tracked + untracked) without
 *  touching the index/branch — same temp-index trick as publish.checkpoint. The
 *  returned sha is something we can check out into a throwaway worktree. */
async function snapshotCommit(repoDir: string): Promise<string | null> {
  const head = await git(repoDir, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '');
  if (!head) return null; // no commits yet — nothing to base a snapshot on
  const tmpIndex = path.join(os.tmpdir(), `radial-build-idx-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    await git(repoDir, ['read-tree', 'HEAD'], env);
    await git(repoDir, ['add', '-A'], env);
    const tree = await git(repoDir, ['write-tree'], env);
    return await git(repoDir, [...await publish.snapshotIdentityArgs(repoDir), 'commit-tree', tree, '-p', 'HEAD', '-m', 'radial-build-snapshot'], env);
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmpIndex); } catch {}
  }
}

/**
 * Build the candidate in a detached worktree, keeping build output out of the
 * preview directory. Reuse installed dependencies for speed; build tools may
 * write dependency caches there, so this is a local check, not a hermetic build.
 */
async function buildGate(repoDir: string, build: BuildPlan, { onLog = () => {}, sha }: BuildGateOptions = {}): Promise<BuildGate> {
  if (!sha && build.kind === 'static') return { status: 'skipped', reason: 'static' };
  if (!sha && build.kind === 'no-build-script') return { status: 'skipped', reason: 'no-build-script' };
  if (!sha && build.kind !== 'node') return { status: 'skipped', reason: build.kind };

  const snap = sha || await snapshotCommit(repoDir);
  if (!snap) return { status: 'skipped', reason: 'no-snapshot' };

  const wt = path.join(os.tmpdir(), `radial-build-${process.pid}-${Date.now()}`);
  let added = false;
  try {
    await git(repoDir, ['worktree', 'add', '--detach', '--quiet', wt, snap]);
    added = true;
    if (sha) build = detectBuild(wt);
    if (build.kind !== 'node') return { status: 'skipped', reason: build.kind };

    // Reuse the project's already-installed deps (fast) — the build reads them,
    // may also write dependency caches. Missing deps surface as a build failure.
    const liveNM = path.join(repoDir, 'node_modules');
    if (fs.existsSync(liveNM)) {
      try { fs.symlinkSync(liveNM, path.join(wt, 'node_modules'), 'dir'); } catch {}
    }

    const inv = devServer.pmInvocation(build.pm);
    if (!inv) return { status: 'failed', reason: 'no-package-manager', log: 'The package manager needed to check this commit is unavailable.' };
    const cmd = `${build.pm} run build`;
    const res = await runCmd(inv.cmd, [...inv.pre, 'run', 'build'], { cwd: wt, onLog });
    if (res.ok) return { status: 'ok', cmd };
    const log = tailLog(res.out, res.timedOut ? '(build timed out)' : '');
    return { status: 'failed', cmd, log };
  } catch (e) {
    return { status: 'failed', reason: 'gate-error', log: String((e as Error).message || e).slice(-1000) };
  } finally {
    if (added) { try { await git(repoDir, ['worktree', 'remove', '--force', wt]); } catch {} }
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
    try { await git(repoDir, ['worktree', 'prune']); } catch {}
  }
}

/** Keep the most useful slice of a build log: the tail, where errors land. */
function tailLog(out: string, note: string): string {
  const text = String(out || '').replace(/\[[0-9;]*m/g, ''); // strip ANSI colors
  const lines = text.split('\n');
  const tail = lines.slice(-200).join('\n').trim();
  return (note ? note + '\n' : '') + tail;
}

/** The fix instruction handed to the agent when the build is red. */
function buildFixPrompt(cmd: string, log?: string): string {
  return [
    'Publishing this project pushes it to GitHub so the connected host (Vercel, Netlify, Cloudflare, etc.) can build and deploy it. To make sure it will actually deploy, I ran its production build locally first — and it FAILED.',
    '',
    'Fix the project so the production build succeeds and it can deploy. Work like you would on any build break:',
    '- Read the error below, find the real cause, and fix it at the source (a missing/incorrect dependency, a bad import or path, a type/lint error that fails the build, a wrong or missing config such as package.json/next.config/framework settings, an env var the build needs).',
    '- You may edit, create, or delete files, correct config, and install genuinely-missing dependencies with the project\'s package manager.',
    '- Make the smallest change that genuinely fixes the build — do not redesign or restructure beyond what the failure requires.',
    '- Do NOT start a dev server and do NOT delete the build/cache dir (.next/.vite/dist) — Radial runs the preview; just fix the source and let me re-run the build.',
    '- If the build fails for a reason only the user can resolve (a real secret/API key is missing, or fixing it would mean discarding their content), stop and say exactly what you need instead of guessing.',
    '',
    `Build command: ${cmd}`,
    'Build output:',
    '"""',
    log || '(no output captured)',
    '"""',
  ].join('\n');
}

// Diagnosis is returned for an explicit user-directed repair; never auto-retry.
function classifyPublishError(res: PublishOutcome | null | undefined): PublishErrorDiagnosis {
  if (!res || res.ok) return { fixable: false };
  if (res.reason === 'not-a-git-repo') return { fixable: false, kind: 'not-a-repo' };
  const msg = String(res.message || '').toLowerCase();
  if (res.reason === 'pr-required' || /protected branch|GH006|GH013|repository rule/i.test(res.message || '')) return { fixable: false, kind: 'protected' };
  // Auth/network are the user's to resolve (credentials), not a code fix.
  if (/could not read from remote|permission denied|authentication failed|repository not found|fatal: unable to access|403 forbidden|invalid username or password/.test(msg)) return { fixable: false, kind: 'auth' };
  // Oversized file in history → must be purged from the pushed commits.
  if (/exceeds github's file size|gh001|large files detected|git-lfs|gh\.io\/lfs|maximum file size/.test(msg)) return { fixable: true, kind: 'large-file' };
  // Our branch is behind the remote → integrate before pushing.
  if (/non-fast-forward|fetch first|tip of your current branch is behind|updates were rejected/.test(msg)) return { fixable: true, kind: 'non-ff' };
  // A generic hook/rejection we can still try to diagnose.
  if (/pre-receive hook declined|\[remote rejected\]|push declined|protected branch|hook declined/.test(msg)) return { fixable: true, kind: 'rejected' };
  return { fixable: false, kind: 'other' };
}

function pushFixPrompt(kind: FixablePushError, message: string, opts?: PublishOptions): string {
  const target = opts && opts.target === 'production' ? 'production' : 'staging';
  const lines = [
    `Publishing to ${target} failed: GitHub REJECTED the push. Make this project push successfully — fix the cause so the next push is accepted. Do NOT push yourself; once it's fixable, Radial re-runs the publish.`,
    '',
  ];
  if (kind === 'large-file') {
    lines.push(
      'The push is rejected because a file larger than GitHub\'s 100 MB limit is in the git HISTORY — not just the latest commit. Removing it from the current commit is NOT enough; it has to be gone from every commit being pushed.',
      'This is essentially always committed build output or dependencies (node_modules/, .next/, etc.) that should never be in git. Fix it like this:',
      '- Identify the oversized path(s) from the error.',
      '- Find which commits are not yet on the remote — only those are being pushed: `git log --oneline @{upstream}..HEAD` (or `origin/<branch>..HEAD`). The remote already has everything before that, so DON\'T rewrite it.',
      '- Purge the oversized path(s) from ONLY those un-pushed commits so the push stays a fast-forward and no force-push is needed — e.g. `git filter-repo --path <dir> --invert-paths --refs <remote-base>..HEAD` (install git-filter-repo if missing: `brew install git-filter-repo` or `pip install git-filter-repo`), or an interactive rebase that deletes those files from each commit.',
      '- If the oversized files exist in ALREADY-PUSHED history too, prefer adding them to .gitignore and purging only the new commits; rewriting published history (which needs a force-push) is a last resort — explain before doing it.',
      '- Ensure the path(s) are in .gitignore so they can never be re-added.',
      '- Do NOT use Git LFS for build artifacts — just remove them.',
    );
  } else if (kind === 'non-ff') {
    lines.push('The remote branch has commits your local branch doesn\'t. Integrate them first: fetch and rebase your work onto the remote branch (`git pull --rebase`), resolve any conflicts, and stop — Radial will push.');
  } else {
    lines.push('Diagnose the rejection from the error below and resolve it so the push will be accepted, then stop — Radial will push.');
  }
  lines.push(
    '',
    'Constraints: do NOT start a dev server. Never delete the user\'s actual site source or content to make a push smaller — only remove build artifacts/dependencies that don\'t belong in git.',
    '',
    'The git error:',
    '"""',
    message || '(no message)',
    '"""',
  );
  return lines.join('\n');
}

// Keep the saved commit on failure. A repair is started explicitly in the native terminal.
async function publishAndDeploy(repoDir: string, opts: PublishOptions = {}, { onEvent = () => {} }: DeployHooks = {}): Promise<PublishDeployResult> {
  const build = detectBuild(repoDir);
  let gate: BuildGate = { status: 'skipped', reason: build.kind };
  const beforePush = async (sha: string): Promise<PublishGate> => {
    onEvent({ kind: 'status', text: `Checking ${sha.slice(0, 8)}…` });
    gate = await buildGate(repoDir, build, { sha, onLog: text => onEvent({ kind: 'build_log', text }) });
    onEvent({ kind: 'gate', ...gate });
    return gate.status === 'failed' ? { ok: false, reason: 'build-failed', message: 'The local build failed. Your commit is saved locally; nothing was pushed.', deploy: { gate: 'failed', log: gate.log, cmd: gate.cmd, sha } } : { ok: true, deploy: { gate: gate.status, reason: gate.reason, cmd: gate.cmd, sha } };
  };
  const result: PublishResultRead = await publish.publish(repoDir, { ...opts, beforePush });
  return { ...result, deploy: { ...(result.deploy || {}), gate: gate.status, reason: gate.reason, log: gate.log, cmd: gate.cmd, sha: result.sha } };
}

export { publishAndDeploy, detectBuild, buildGate, snapshotCommit, buildFixPrompt, tailLog, classifyPublishError, pushFixPrompt };
