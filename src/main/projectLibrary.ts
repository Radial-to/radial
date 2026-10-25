import * as repository from './repository';
import * as github from './github';
import * as review from './githubReview';
import * as integration from './integration';
import * as publish from './publish';
import type { LocalCopyOptions } from './github';
import type { GitHubApiResult, GitHubRequest } from './githubReview';
import type { GitHubRepo, GitHubRepoList, LibraryEntry, LibraryStatus, LibraryUpdateResult, RepoState } from '../shared/radialApi';

/** The calls deps holds: repository.syncStatus and githubReview.request, or a test's stand-ins. */
export interface ProjectLibraryDeps {
  syncStatus: typeof repository.syncStatus;
  request: GitHubRequest;
}
/** status()'s options: `fetch` fetches the upstream first (the checkout itself isn't touched); without it the status compares with the upstream as last fetched and never offers an update. */
export interface LibraryStatusOptions { fetch?: boolean }
/** Every key of every member of a union. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
/**
 * A union whose members each read the other members' fields as undefined, so
 * update() can compare fields before narrowing (the window's LooseUnion, in
 * src/renderer/types.d.ts). Narrowing on the discriminant still works.
 */
type LooseUnion<T, All = T> = T extends unknown ? T & { [K in Exclude<KeysOfUnion<All>, keyof T>]?: undefined } : never;
// The part of GitHub's REST JSON accessibleRepos reads. Like the JavaScript it
// came from, it trusts pushed_at, which GitHub's schema allows to be null, to
// be set, and passes it on as GitHubRepo.updatedAt.
/** One repository from GET user/repos. */
interface GitHubUserRepo {
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  html_url: string;
  pushed_at: string;
  private: boolean;
  archived: boolean;
}

// What this module reads from Git and GitHub, held in one object so a test can
// swap a call (module exports are read-only once compiled).
export const deps: ProjectLibraryDeps = { syncStatus: repository.syncStatus, request: review.request };

async function status(dir: string, { fetch = false }: LibraryStatusOptions = {}): Promise<LibraryStatus> {
  const state = await deps.syncStatus(dir, { fetch });
  const operationRecord = state.isRepo ? await integration.read(dir) : null;
  return { ...state, dir, slug: state.isRepo ? await review.slug(dir) : null, operationRecord,
    checkedAt: fetch && state.ok ? Date.now() : null,
    canUpdate: !!(fetch && state.ok && state.exists && state.behind > 0 && state.ahead === 0 && !state.changes?.length && !state.operation && !operationRecord),
  };
}

async function statuses(dirs: readonly string[]): Promise<LibraryEntry[]> {
  const queue = [...new Set(dirs)].slice(0, 200), result: LibraryEntry[] = [];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const dir = queue.shift()!;
      try { result.push(await status(dir)); }
      catch (error) { result.push({ dir, ok: false, reason: 'status-failed', message: (error as Error).message }); }
    }
  }));
  return result;
}

async function copies(url: string, options?: LocalCopyOptions): Promise<LibraryEntry[]> {
  return statuses(github.findLocalCopies(url, options));
}

async function update(dir: string, expected: LooseUnion<LibraryStatus> | null | undefined): Promise<LibraryUpdateResult> {
  return publish.withRepoLock(dir, async () => {
    try {
      const latest: LooseUnion<LibraryStatus> = await status(dir, { fetch: true });
      if (!expected || (['head', 'branch', 'remote', 'remoteName', 'targetBranch', 'sha'] as const).some(key => latest[key] !== expected[key])) {
        return { ok: false, reason: 'checkout-changed', message: 'The checkout or incoming commits changed. Check updates again.', state: latest };
      }
      if (!latest.canUpdate) return { ok: false, reason: 'review-required', message: 'Review local changes and incoming commits before updating.', state: latest };
      const local: LooseUnion<RepoState> = await repository.state(dir);
      const upstream = await repository.tracking(dir, local.branch);
      if (!local.ok || local.changes?.length || local.operation || await integration.read(dir)
        || (['head', 'branch', 'remote'] as const).some(key => local[key] !== latest[key])
        || upstream?.remote !== latest.remoteName || upstream?.branch !== latest.targetBranch) {
        return { ok: false, reason: 'checkout-changed', message: 'Local work changed while checking updates. Check again before updating.' };
      }
      // Never stash, switch branches, or merge diverged history from Home.
      // The `!`s: canUpdate (checked above) is true only for a fetched checkout
      // on a branch whose upstream exists, so the branch, sha and behind are set.
      await repository.run(dir, ['merge', '--ff-only', '--no-overwrite-ignore', latest.sha!]);
      return { ok: true, action: 'updated', branch: latest.branch!, pulled: latest.behind! };
    } catch (error) { return { ok: false, reason: 'update-failed', message: (error as Error).message }; }
  });
}

async function accessibleRepos(owner = ''): Promise<GitHubRepoList> {
  if (owner) return github.listRepos(owner);
  const repos: GitHubRepo[] = [];
  for (let page = 1; page <= 2; page++) {
    const result = await deps.request(`user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100&page=${page}`) as GitHubApiResult<GitHubUserRepo[]>;
    if (!result.ok) return { ...result, repos: [] };
    for (const r of result.data) if (!r.archived) repos.push({ nameWithOwner: r.full_name, name: r.name, owner: r.owner.login, description: r.description || '', url: r.html_url, updatedAt: r.pushed_at, isPrivate: r.private });
    if (result.data.length < 100) return { ok: true, repos, truncated: false };
  }
  return { ok: true, repos, truncated: true };
}

export { status, statuses, copies, update, accessibleRepos };
