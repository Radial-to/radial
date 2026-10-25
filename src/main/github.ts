/**
 * GitHub linking for the local version: point at a repo URL and work from it.
 * "Grab the latest" = clone if we don't have it yet, otherwise fetch and
 * fast-forward to the latest default branch. Auth piggybacks on the machine's
 * existing git credentials (SSH key / keychain credential helper) — no new
 * login for the local app.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { git, setRemote } from './publish';
import * as context from './context';
import { childEnv, which } from './env';
import type { ConnectRepoArgs, ConnectRepoResult, CreateRepoArgs, CreateRepoResult, GitHubOwners, GitHubRepo, GitHubRepoList, OpenedFromGitHub } from '../shared/radialApi';

/** A GitHub repo named by its owner and name (parseRepoUrl). */
export interface RepoRef { owner: string; repo: string }
/** findLocalCopies()'s options: checkouts already known, more folders to scan (empty entries are skipped), or no scan at all. */
export interface LocalCopyOptions { knownPaths?: readonly string[]; extraRoots?: readonly (string | null)[]; skipScan?: boolean }
/** cloneOrPull()'s options: `identity` names the checkout when the URL isn't github.com; `update: false` opens an existing clone as it is. */
export interface CloneOptions { identity?: RepoRef; update?: boolean }
/** What cloneOrPull() did with the checkout: opened, kept, pulled or cloned it (never 'reused-local'). */
export type GitHubCheckout = Exclude<OpenedFromGitHub, { action: 'reused-local' }>;
/** cloneOrPull(): where the checkout is, what happened to it, and the repo it holds. */
export type CloneResult = GitHubCheckout & RepoRef & { dir: string };
/** createRepo()'s options: the window's CreateRepoArgs, with the folder as `dir`. */
export type CreateRepoOptions = Omit<CreateRepoArgs, 'repoDir'> & { dir: string };
/** connectExisting()'s options: the window's ConnectRepoArgs, with the folder as `dir`. */
export type ConnectRepoOptions = Omit<ConnectRepoArgs, 'repoDir'> & { dir: string };
/** A clone in the workspace (listWorkspaceDirs), with its owner/repo when the folder name carries one. */
export interface WorkspaceDir { path: string; name: string; repo: string | null }
/** What a `gh` command printed; ok is false when it failed or couldn't start. */
interface GhRunResult { ok: boolean; stdout: string; stderr: string }
/** One repo as `gh repo list --json` prints the fields listRepos asks for. */
interface GhRepoJson {
  nameWithOwner: string;
  name: string;
  owner: { login?: string; name?: string } | null;
  description: string | null;
  updatedAt: string;
  isPrivate: boolean;
  url: string;
}

function ghRun(args: string[], timeout = 25000): Promise<GhRunResult> {
  return new Promise((resolve) => {
    execFile(which('gh') || 'gh', args, { env: childEnv(), maxBuffer: 8 * 1024 * 1024, timeout },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' }));
  });
}

/** Default workspace where Radial clones repos (mirrors github:open). */
// Canonical case matters: the dir on disk may be `radial` (case-insensitive
// APFS accepts either spelling), but path-string comparisons (session keys,
// lsof cwd matching in server adoption) don't. Resolve to the on-disk case.
function workspaceRoot(): string {
  if (workspaceOverride) return workspaceOverride;
  const p = path.join(os.homedir(), 'Radial');
  try { return fs.realpathSync.native(p); } catch { return p; }
}
// The e2e background mode keeps the workspace in its throwaway profile (main.ts),
// so a test run never clones, creates or writes AGENTS.md in the person's ~/Radial.
let workspaceOverride: string | null = null;
function useWorkspaceRoot(dir: string): void { workspaceOverride = dir; }

/** The signed-in user plus the orgs they belong to (the selectable workspaces). */
async function listOwners(): Promise<GitHubOwners> {
  if (!which('gh')) return { ok: false, reason: 'no-gh' };
  const auth = await ghRun(['auth', 'status']);
  if (!auth.ok) return { ok: false, reason: 'not-authed' };
  const u = await ghRun(['api', 'user', '--jq', '.login']);
  const user = (u.stdout || '').trim();
  let orgs: string[] = [];
  const o = await ghRun(['api', '--paginate', 'user/orgs', '--jq', '.[].login']);
  if (o.ok) orgs = [...new Set(o.stdout.split('\n').map((s) => s.trim()).filter(Boolean))];
  return { ok: true, user, orgs };
}

/**
 * Repositories for a workspace via the GitHub CLI (no OAuth app — reuses the
 * `gh` auth we already require for publishing). With no owner, lists the signed-
 * in user's own repos (incl. private); with an owner, lists that org/user's.
 * Marks which are already cloned locally so the UI can show Open vs Clone.
 */
async function listRepos(owner = '', limit = 200): Promise<GitHubRepoList> {
  if (!which('gh')) return { ok: false, reason: 'no-gh', repos: [] };
  const auth = await ghRun(['auth', 'status']);
  if (!auth.ok) return { ok: false, reason: 'not-authed', repos: [] };
  const fields = 'nameWithOwner,name,owner,description,updatedAt,isPrivate,url';
  const args = ['repo', 'list'];
  if (owner && owner.trim()) args.push(owner.trim());
  args.push('--no-archived', '--limit', String(limit), '--json', fields);
  const r = await ghRun(args);
  if (!r.ok) return { ok: false, reason: 'gh-error', error: (r.stderr || '').trim(), repos: [] };
  let repos: GitHubRepo[] = [];
  try {
    const root = workspaceRoot();
    repos = (JSON.parse(r.stdout) as GhRepoJson[]).map((x) => {
      const owner = (x.owner && (x.owner.login || x.owner.name)) || (x.nameWithOwner || '').split('/')[0];
      const cloned = fs.existsSync(path.join(workspaceDirFor(root, owner, x.name), '.git'));
      return {
        nameWithOwner: x.nameWithOwner, name: x.name, owner,
        description: x.description || '', updatedAt: x.updatedAt || '',
        isPrivate: !!x.isPrivate, url: x.url, cloned,
      };
    });
  } catch { return { ok: false, reason: 'parse', repos: [] }; }
  repos.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return { ok: true, repos };
}

/** Parse owner/repo from the common GitHub URL forms. */
function parseRepoUrl(url: string | null): RepoRef | null {
  const clean = String(url || '').trim();
  // git@github.com:owner/repo(.git)
  let m = clean.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (m) return { owner: m[1], repo: m[2] };
  // https://github.com/owner/repo(.git)(/tree/...)
  m = clean.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|blob)\/.*)?\/?$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

function workspaceDirFor(workspaceRoot: string, owner: string, repo: string): string {
  return path.join(workspaceRoot, `${owner}__${repo}`);
}

/** Normalize any GitHub remote URL to a lowercase "owner/repo" identity. */
function repoIdent(url: string | null): string | null {
  if (!/^(?:https?:\/\/github\.com\/|git@github\.com:)/i.test(String(url || '').trim())) return null;
  const p = parseRepoUrl(url || '');
  return p ? `${p.owner}/${p.repo}`.toLowerCase() : null;
}

/** The origin URL of a working copy, read straight from .git/config (no git spawn). */
function originOf(dir: string): string | null {
  try {
    let metadata = path.join(dir, '.git');
    if (fs.statSync(metadata).isFile()) metadata = path.resolve(dir, fs.readFileSync(metadata, 'utf8').trim().replace(/^gitdir:\s*/, ''));
    const common = path.join(metadata, 'commondir');
    if (fs.existsSync(common)) metadata = path.resolve(metadata, fs.readFileSync(common, 'utf8').trim());
    const cfg = fs.readFileSync(path.join(metadata, 'config'), 'utf8');
    const m = cfg.match(/\[remote "origin"\][^[]*?url\s*=\s*([^\n]+)/);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

/** Find known checkouts plus a bounded scan of common project folders.
 * Return every distinct real path so users can choose between local copies.
 */
function findLocalCopies(url: string, { knownPaths = [], extraRoots = [], skipScan = false }: LocalCopyOptions = {}): string[] {
  const want = repoIdent(url);
  if (!want) return [];
  const matches = (dir: string): boolean => repoIdent(originOf(dir)) === want;
  const found = new Set<string>();

  for (const p of knownPaths) {
    try { if (p && matches(p)) found.add(fs.realpathSync.native(p)); } catch {}
  }
  if (skipScan) return [...found];

  const home = os.homedir();
  const roots = [...new Set([
    ...extraRoots,
    workspaceRoot(),
    ...['Projects', 'projects', 'Developer', 'dev', 'code', 'src', 'Sites', 'Documents', 'Desktop']
      .map((n) => path.join(home, n)),
  ].filter(Boolean) as string[])];
  const queue: { dir: string; depth: number }[] = [];
  for (const r of roots) { try { if (fs.statSync(r).isDirectory()) queue.push({ dir: r, depth: 0 }); } catch {} }
  const seen = new Set<string>();
  const MAX_DEPTH = 3, MAX_DIRS = 4000;
  while (queue.length && seen.size < MAX_DIRS) {
    const { dir, depth } = queue.shift()!;
    let real: string; try { real = fs.realpathSync.native(dir); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    if (fs.existsSync(path.join(dir, '.git'))) {
      if (matches(dir)) found.add(real);
      continue; // a different repo — never descend into it
    }
    if (depth >= MAX_DEPTH) continue;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'Library') continue;
      queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return [...found];
}

function findLocalCopy(url: string, opts?: LocalCopyOptions): string | null { return findLocalCopies(url, opts)[0] || null; }

async function getDefaultBranch(dir: string): Promise<string> {
  try {
    const ref = await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    return ref.replace(/^origin\//, '');
  } catch {}
  try {
    return await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {}
  return 'main';
}

async function isClean(dir: string): Promise<boolean> {
  const out = await git(dir, ['status', '--porcelain']).catch(() => '');
  return out.trim() === '';
}

/**
 * Clone the repo or, if already present, fetch + fast-forward the default
 * branch to the latest. Never discards uncommitted local edits — if the clone
 * is dirty, it reports `dirty: true` and skips the pull so the caller can warn.
 */
async function cloneOrPull(url: string, workspaceRoot: string, onLog: (line: string) => void = () => {}, { identity, update = true }: CloneOptions = {}): Promise<CloneResult> {
  // `identity` names the checkout when `url` isn't a github.com URL (a mirror
  // or proxy of the same repo), so it lands in the same owner__repo directory.
  const parsed = identity || parseRepoUrl(url);
  if (!parsed) throw new Error('That doesn\'t look like a GitHub repo URL.');
  const { owner, repo } = parsed;
  const dir = workspaceDirFor(workspaceRoot, owner, repo);

  if (fs.existsSync(path.join(dir, '.git'))) {
    if (!identity && repoIdent(originOf(dir)) !== repoIdent(url)) throw new Error('That workspace folder is connected to a different repository. Choose its local copy or move the existing folder before cloning.');
    if (!update) return { dir, defaultBranch: await getDefaultBranch(dir), action: 'opened-local', dirty: !(await isClean(dir)), owner, repo };
    onLog(`[radial] found existing clone, fetching latest…`);
    await git(dir, ['fetch', 'origin']);
    const defaultBranch = await getDefaultBranch(dir);
    if (!(await isClean(dir))) {
      onLog('[radial] opening with your local edits (didn\'t pull remote updates over them — commit or stash to sync)');
      return { dir, defaultBranch, action: 'kept-dirty', dirty: true, owner, repo };
    }
    const current = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
    if (!current) return { dir, defaultBranch, action: 'kept-detached', dirty: false, owner, repo };
    try {
      const upstream = await git(dir, ['rev-parse', '--abbrev-ref', '@{upstream}']).catch(() => null);
      if (!upstream) return { dir, defaultBranch, action: 'kept-local', dirty: false, owner, repo };
      await git(dir, ['merge', '--ff-only', '--no-overwrite-ignore', upstream]);
      onLog(`[radial] fast-forwarded ${current} to latest`);
    } catch (e) {
      onLog(`[radial] could not fast-forward (${(e as Error).message}) — using local copy`);
      return { dir, defaultBranch, action: 'kept-local', dirty: false, owner, repo };
    }
    return { dir, defaultBranch, action: 'pulled', dirty: false, owner, repo };
  }

  fs.mkdirSync(workspaceRoot, { recursive: true });
  onLog(`[radial] cloning ${owner}/${repo}…`);
  await git(workspaceRoot, ['clone', url, dir]);
  const defaultBranch = await getDefaultBranch(dir);
  onLog(`[radial] cloned to ${dir}`);
  return { dir, defaultBranch, action: 'cloned', dirty: false, owner, repo };
}

// --- connecting a local folder to GitHub ---------------------------------
// A folder opened from disk may not be a git repo at all, or may be a repo with
// no `origin`. These helpers let the user create a brand-new GitHub repo from it
// or push it to an existing one — initialising git + a first commit as needed.

/** `git init` (+ a `main` branch) if this folder isn't a repo yet. */
async function ensureGitRepo(dir: string): Promise<{ created: boolean }> {
  if (fs.existsSync(path.join(dir, '.git'))) return { created: false };
  await git(dir, ['init']);
  // Point the (still unborn) HEAD at `main` so the first commit lands there.
  try { await git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']); } catch {}
  return { created: true };
}

/** Never commit deps / OS cruft from a freshly-initialised folder. */
function ensureBaselineIgnore(dir: string): void {
  const giPath = path.join(dir, '.gitignore');
  let gi = ''; try { gi = fs.readFileSync(giPath, 'utf8'); } catch {}
  const lines = gi.split(/\r?\n/).map((l) => l.trim());
  const has = (v: string): boolean => lines.includes(v) || lines.includes(v + '/');
  const need: string[] = [];
  if (fs.existsSync(path.join(dir, 'node_modules')) && !has('node_modules')) need.push('node_modules');
  if (!has('.DS_Store')) need.push('.DS_Store');
  // `.vercel` is the machine-local project link (from `vercel link`) — a generic
  // Vercel artifact (not a Radial fingerprint), so it belongs in the baseline.
  if (fs.existsSync(path.join(dir, '.vercel')) && !has('.vercel')) need.push('.vercel');
  if (need.length) {
    const prefix = gi && !gi.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(giPath, gi + prefix + need.join('\n') + '\n', 'utf8');
  }
}

async function hasCommits(dir: string): Promise<boolean> {
  try { await git(dir, ['rev-parse', 'HEAD']); return true; } catch { return false; }
}

/** Commit, falling back to a neutral identity if git has none configured. The
 *  fallback is attributed to the OS user, never to Radial, so the connected
 *  repo's history carries no record of Radial. */
async function commitAll(dir: string, message: string, allowEmpty: boolean): Promise<void> {
  const base = ['commit', '-m', message]; if (allowEmpty) base.push('--allow-empty');
  try { await git(dir, base); }
  catch (e) {
    if (/tell me who you are|user\.(email|name)|empty ident/i.test((e as Error).message || '')) {
      let name = 'user';
      try { name = os.userInfo().username || name; } catch {}
      await git(dir, ['-c', `user.name=${name}`, '-c', `user.email=${name}@localhost`, ...base]);
    } else throw e;
  }
}

/** Make sure there's at least one commit to push. */
async function ensureInitialCommit(dir: string): Promise<void> {
  if (await hasCommits(dir)) return;
  ensureBaselineIgnore(dir);
  // Now that `.git` exists, apply Radial's ignore policy: its local working data
  // (.radial/, .radial.json) goes to the never-committed .git/info/exclude, so the
  // first commit can't sweep it in. (Safe no-op for the exclude before this point.)
  try { context.ensureIgnores(dir); } catch {}
  await git(dir, ['add', '-A']);
  const staged = await git(dir, ['status', '--porcelain']).catch(() => '');
  await commitAll(dir, 'Initial commit', !staged.trim());
}

/**
 * Create a brand-new GitHub repo from a local folder and push to it.
 * Initialises git + a first commit if needed, then `gh repo create --source --push`.
 */
async function createRepo({ dir, owner, name, isPrivate = true }: CreateRepoOptions): Promise<CreateRepoResult> {
  if (!which('gh')) return { ok: false, reason: 'no-gh', error: 'The GitHub CLI (gh) isn’t installed.' };
  const auth = await ghRun(['auth', 'status']);
  if (!auth.ok) return { ok: false, reason: 'not-authed', error: 'You’re not signed in to GitHub. Connect GitHub first.' };

  const clean = String(name || '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '');
  if (!clean) return { ok: false, error: 'Enter a repository name.' };

  try {
    await ensureGitRepo(dir);
    await ensureInitialCommit(dir);
  } catch (e) { return { ok: false, error: ((e as Error).message || 'Could not initialise git here.').slice(-300) }; }

  const slug = owner && owner.trim() ? `${owner.trim()}/${clean}` : clean;
  const r = await ghRun(['repo', 'create', slug, isPrivate ? '--private' : '--public',
    '--source', dir, '--remote', 'origin', '--push'], 120000);
  if (!r.ok) {
    const err = (r.stderr || r.stdout || '').trim();
    if (/already exists/i.test(err)) return { ok: false, reason: 'exists', error: `A repo named “${clean}” already exists.` };
    return { ok: false, error: err.split('\n').filter(Boolean).slice(-2).join(' ').slice(-300) || 'Could not create the repository.' };
  }

  let url = '';
  const v = await ghRun(['repo', 'view', slug, '--json', 'url', '--jq', '.url']);
  if (v.ok) url = v.stdout.trim();
  if (!url) { const m = (r.stdout || '').match(/https?:\/\/\S+/); if (m) url = m[0].replace(/\.git$/, ''); }
  const branch = await getDefaultBranch(dir);
  return { ok: true, url, nameWithOwner: slug, branch };
}

/**
 * Point a local folder at an EXISTING GitHub repo and push to it.
 */
async function connectExisting({ dir, url }: ConnectRepoOptions): Promise<ConnectRepoResult> {
  const parsed = parseRepoUrl(url);
  if (!parsed) return { ok: false, error: 'That doesn’t look like a GitHub repo URL.' };
  try {
    await ensureGitRepo(dir);
    await ensureInitialCommit(dir);
    await setRemote(dir, String(url).trim());
  } catch (e) { return { ok: false, error: ((e as Error).message || 'Could not set up git here.').slice(-300) }; }

  const branch = await getDefaultBranch(dir);
  const remote = String(url).trim();
  try {
    await git(dir, ['push', '-u', 'origin', branch]);
  } catch (e) {
    const msg = (e as Error).message || '';
    if (/rejected|non-fast-forward|fetch first|Updates were rejected/i.test(msg)) {
      return { ok: false, reason: 'push-rejected', remote, branch,
        error: 'That repo already has commits. Sync it first (or use an empty repo), then publish.' };
    }
    if (/Authentication|could not read Username|terminal prompts disabled|Permission denied|denied/i.test(msg)) {
      return { ok: false, reason: 'auth', remote, branch,
        error: 'Remote set, but the push needs GitHub sign-in. Connect GitHub, then Publish.' };
    }
    return { ok: false, reason: 'push-failed', remote, branch,
      error: (msg.split('\n').filter(Boolean).slice(-1)[0] || 'Push failed.').slice(-300) };
  }
  return { ok: true, url: remote, nameWithOwner: `${parsed.owner}/${parsed.repo}`, branch };
}

/** 'owner/repo' for a working copy, from its origin remote. */
function repoSlug(dir: string): string | null {
  const r = parseRepoUrl(originOf(dir));
  return r ? `${r.owner}/${r.repo}` : null;
}

/**
 * A GitHub repo from free text: `git@github.com:o/r`, any github.com URL
 * (with or without scheme/www/.git/trailing path), or — when allowBare — a bare
 * `owner/repo`. Returns the canonical https URL, or null. Ported verbatim from
 * the renderer's githubUrlFromText so the CLI/MCP resolver and the home search
 * box agree on what counts as a link.
 */
function urlFromText(t: string, allowBare?: boolean): string | null {
  t = String(t || '').trim();
  if (!t || t.length > 300 || /\s/.test(t)) return null;
  let m = t.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  if (m) return `https://github.com/${m[1]}/${m[2]}`;
  m = t.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[\/?#].*)?$/i);
  if (m && !['orgs', 'settings', 'features', 'topics', 'marketplace', 'sponsors', 'about'].includes(m[1].toLowerCase())) {
    return `https://github.com/${m[1]}/${m[2]}`;
  }
  if (allowBare) {
    m = t.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (m) return `https://github.com/${m[1]}/${m[2]}`;
  }
  return null;
}

/** Clones living in the workspace (~/Radial/<owner>__<repo>), as resolver candidates. */
function listWorkspaceDirs(): WorkspaceDir[] {
  const out: WorkspaceDir[] = [];
  let root: string; try { root = workspaceRoot(); } catch { return out; }
  let entries: fs.Dirent[]; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const p = path.join(root, d.name);
    if (!fs.existsSync(path.join(p, '.git'))) continue;
    const m = d.name.match(/^([^_].*?)__(.+)$/);
    out.push({ path: p, name: d.name, repo: m ? `${m[1]}/${m[2]}` : null });
  }
  return out;
}

export { urlFromText, listWorkspaceDirs, parseRepoUrl, repoIdent, originOf, findLocalCopy, findLocalCopies, cloneOrPull, getDefaultBranch, workspaceRoot, useWorkspaceRoot, workspaceDirFor, listRepos, listOwners, createRepo, connectExisting, ensureGitRepo, ensureInitialCommit, repoSlug };
