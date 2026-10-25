import { execFile } from 'child_process';
import { childEnv, which } from './env';
import * as repo from './repository';
import type { GitHubApiFailure, GitHubCapabilities, MergeMethod, MergeReceipt, PullRequestDetail, ReviewFailure, ReviewOptions, ReviewResults } from '../shared/radialApi';

/** request()'s options: the HTTP method, and a JSON body sent on stdin. */
export interface GitHubRequestOptions { method?: 'GET' | 'POST' | 'PUT'; body?: Record<string, unknown> }
/**
 * What `gh api` answered: the parsed JSON (null for an empty body), or why it
 * failed (`status` is the HTTP status gh printed, when it printed one). Neither
 * side has the other's field, so `data` and `error` read on the union.
 * Callers that know an endpoint's JSON narrow `data` with T.
 */
export type GitHubApiResult<T = unknown> = { ok: true; data: T; error?: undefined } | (GitHubApiFailure & { data?: undefined });
/** A GitHub REST call through gh: request(), or a test's fake that client() takes instead. */
export type GitHubRequest = (endpoint: string, opts?: GitHubRequestOptions) => Promise<GitHubApiResult>;
/** A pull request in GitHub's REST JSON as the list and create endpoints return it (the fields Radial reads). */
export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: { login: string };
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  draft: boolean;
  merge_commit_sha: string | null;
  updated_at: string;
}
/** merge(): GitHub merged the pull request; main.ts saves this, with the time and remote, as the MergeReceipt. */
export type PullRequestMerged = Pick<MergeReceipt, 'ok' | 'sha' | 'merged' | 'branch' | 'url'>;
/** create()'s pull request: `head` into `base`. */
export interface CreatePullRequestOptions { head: string; base: string; title: string; body?: string }
/** create(): the new pull request, or the open one already there for the same head and base (`existing`). */
export type CreatePullRequestResult = { ok: true; pr: GitHubPullRequest; existing?: true } | GitHubApiFailure;
type KnownCapabilities = Extract<GitHubCapabilities, { ok: true }>;
type UnknownCapabilities = Extract<GitHubCapabilities, { ok: false }>;
/**
 * capabilities(): radialApi's GitHubCapabilities, with the known side's fields
 * on the failure as undefined. collaboration.plan and publish read requiresPr
 * and canPush without checking ok, so a failure reads as "no rule". radialApi's
 * own type doesn't say this yet, so the window's reads still need it there.
 */
export type GitHubCapabilitiesResult = KnownCapabilities | (UnknownCapabilities & { [K in Exclude<keyof KnownCapabilities, keyof UnknownCapabilities>]?: undefined });
/** client(): the GitHub calls, through request() or a test's fake. */
export interface GitHubReviewClient {
  capabilities(name: string, branch: string): Promise<GitHubCapabilitiesResult>;
  list(name: string): Promise<ReviewResults['list']>;
  detail(name: string, number: number): Promise<ReviewResults['detail']>;
  review(name: string, opts: ReviewOptions['review']): Promise<ReviewResults['review']>;
  merge(name: string, opts: Pick<ReviewOptions['merge'], 'number' | 'sha' | 'baseSha' | 'method'>): Promise<PullRequestMerged | ReviewFailure>;
  create(name: string, opts: CreatePullRequestOptions): Promise<CreatePullRequestResult>;
}

// The parts of GitHub's REST JSON this module reads. Like the JavaScript it
// came from, the module trusts some fields GitHub's schema allows to be null:
// `user` on a pull request (GitHubPullRequest above) and on a review (a deleted
// account), and a review's `commit_id`. request() also answers data: null for
// an empty body, which only merge's cast admits. Don't read these as guarantees.
/** One pull request (GET repos/:repo/pulls/:number) adds whether and how it can merge. */
interface GitHubPullRequestFull extends GitHubPullRequest { merged: boolean; mergeable: boolean | null; mergeable_state: string }
interface GitHubRepoBody {
  permissions?: { push?: boolean; admin?: boolean };
  default_branch: string;
  html_url: string;
  allow_squash_merge?: boolean;
  allow_rebase_merge?: boolean;
  allow_merge_commit?: boolean;
}
/** The repository flag that allows each merge method: GitHub names the plain one allow_merge_commit. */
const MERGE_FLAGS = { merge: 'allow_merge_commit', squash: 'allow_squash_merge', rebase: 'allow_rebase_merge' } as const satisfies Record<MergeMethod, keyof GitHubRepoBody>;
interface GitHubBranchBody { protected: boolean }
interface GitHubRule { type: string; parameters?: unknown }
interface GitHubProtectionBody {
  required_pull_request_reviews?: Record<string, unknown>;
  required_linear_history?: { enabled: boolean };
  required_status_checks?: { contexts: string[] };
}
interface GitHubFile { filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string }
interface GitHubReview { user: { login: string }; state: string; body: string; commit_id: string }
interface GitHubCheckRuns { check_runs?: { name: string; status: string; conclusion: string | null; details_url: string | null }[] }
interface GitHubCombinedStatus { statuses: { context: string; state: string; target_url: string | null }[] }
interface GitHubDeployment { id: number; sha: string; environment: string }
interface GitHubDeploymentStatus { state: string; environment_url?: string; target_url?: string }
interface GitHubMergeBody { merged: boolean; sha: string; message: string }
/** pages(): every item of a paged list, or the first failure. */
type GitHubPages<T> = { ok: true; data: T[]; truncated: boolean } | (GitHubApiFailure & { truncated?: undefined });
type Reply<T> = Promise<GitHubApiResult<T>>;

function request(endpoint: string, { method = 'GET', body }: GitHubRequestOptions = {}): Promise<GitHubApiResult> {
  return new Promise<GitHubApiResult>((resolve) => {
    const args = ['api', endpoint, '--method', method];
    if (body) args.push('--input', '-');
    const child = execFile(which('gh') || 'gh', args, { env: childEnv({ GH_PROMPT_DISABLED: '1' }), timeout: 25000, maxBuffer: 12 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, error: (stderr || error.message).trim(), status: Number((stderr || '').match(/HTTP (\d+)/)?.[1]) || null });
      try { resolve({ ok: true, data: stdout.trim() ? JSON.parse(stdout) : null }); }
      catch { resolve({ ok: false, error: 'GitHub returned an unreadable response.' }); }
    });
    // execFile pipes stdin, so the child always has one.
    if (body) child.stdin!.end(JSON.stringify(body));
  });
}

async function slug(dir: string): Promise<string | null> {
  const remote = await repo.run(dir, ['remote', 'get-url', 'origin']).catch(() => '');
  const m = remote.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function client(api: GitHubRequest = request): GitHubReviewClient {
  /**
   * T is the caller's unchecked claim about the items' JSON, like the
   * `as Reply<...>` casts on single calls: pages() checks only for an array.
   */
  async function pages<T>(endpoint: string, limit = 10): Promise<GitHubPages<T>> {
    const data: T[] = [];
    for (let page = 1; page <= limit; page++) {
      const res = await api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!res.ok) return res;
      if (!Array.isArray(res.data)) return { ok: false, error: 'Unexpected GitHub list response.' };
      data.push(...res.data as T[]);
      if (res.data.length < 100) return { ok: true, data, truncated: false };
    }
    return { ok: true, data, truncated: true };
  }

  async function capabilities(name: string, branch: string): Promise<GitHubCapabilitiesResult> {
    const b = encodeURIComponent(branch);
    const [info, ref, rules, protection, user] = await Promise.all([
      api(`repos/${name}`) as Reply<GitHubRepoBody>, api(`repos/${name}/branches/${b}`) as Reply<GitHubBranchBody>, api(`repos/${name}/rules/branches/${b}`) as Reply<GitHubRule[]>,
      api(`repos/${name}/branches/${b}/protection`) as Reply<GitHubProtectionBody>, api('user') as Reply<{ login: string }>,
    ]);
    if (!info.ok) return { ok: false, error: info.error, state: 'unknown' };
    const active: GitHubRule[] = rules.ok && Array.isArray(rules.data) ? rules.data : [];
    const prRule = active.find(r => r.type === 'pull_request');
    const legacyPr = protection.ok && protection.data?.required_pull_request_reviews;
    const protectedBranch = ref.ok ? !!ref.data.protected : null;
    const known = rules.ok && (protection.ok || protectedBranch === false);
    return { ok: true, state: known ? 'known' : 'partial', branch, actor: user.ok ? user.data.login : null,
      canPush: info.data.permissions?.push ?? null, isAdmin: info.data.permissions?.admin ?? null,
      protected: protectedBranch, requiresPr: !!(prRule || legacyPr), bypass: 'unknown',
      mergeQueue: active.some(r => r.type === 'merge_queue'), linearHistory: active.some(r => r.type === 'required_linear_history') || !!protection.data?.required_linear_history?.enabled,
      rules: active.map(r => ({ type: r.type, parameters: r.parameters })),
      requiredChecks: protection.data?.required_status_checks?.contexts || [],
      mergeMethods: (['merge', 'squash', 'rebase'] as const).filter(method => info.data[MERGE_FLAGS[method]]),
      defaultBranch: info.data.default_branch, url: info.data.html_url, checkedAt: Date.now() };
  }

  async function list(name: string): Promise<ReviewResults['list']> {
    const result = await pages<GitHubPullRequest>(`repos/${name}/pulls?state=open&sort=updated&direction=desc`);
    return result.ok ? { ok: true, prs: result.data.map(p => ({ number: p.number, title: p.title, url: p.html_url, author: p.user.login, head: p.head.ref, base: p.base.ref, sha: p.head.sha, draft: p.draft, updatedAt: p.updated_at })), truncated: result.truncated } : result;
  }

  async function detail(name: string, number: number): Promise<ReviewResults['detail']> {
    if (!Number.isSafeInteger(number) || number < 1) return { ok: false, error: 'Invalid pull request number.' };
    const endpoint = `repos/${name}/pulls/${number}`;
    const pr = await api(endpoint) as GitHubApiResult<GitHubPullRequestFull>;
    if (!pr.ok) return pr;
    const p = pr.data;
    const [files, reviews, checks, statuses, caps, deployments] = await Promise.all([
      pages<GitHubFile>(`${endpoint}/files`, 30), pages<GitHubReview>(`${endpoint}/reviews`), api(`repos/${name}/commits/${p.head.sha}/check-runs?per_page=100`) as Reply<GitHubCheckRuns>,
      api(`repos/${name}/commits/${p.head.sha}/status?per_page=100`) as Reply<GitHubCombinedStatus>, capabilities(name, p.base.ref),
      api(`repos/${name}/deployments?sha=${p.head.sha}&per_page=20`) as Reply<GitHubDeployment[]>,
    ]);
    const previews: PullRequestDetail['previews'] = [];
    if (deployments.ok) for (const deployment of deployments.data) {
      if (deployment.sha !== p.head.sha) continue;
      const status = await api(`repos/${name}/deployments/${deployment.id}/statuses?per_page=1`) as GitHubApiResult<GitHubDeploymentStatus[]>;
      const last = status.ok && status.data[0];
      if (last) previews.push({ id: deployment.id, sha: deployment.sha, environment: deployment.environment, state: last.state, url: last.environment_url || last.target_url || null });
    }
    const latest = await api(endpoint) as GitHubApiResult<GitHubPullRequestFull>;
    if (!latest.ok || latest.data.head.sha !== p.head.sha || latest.data.base.sha !== p.base.sha) return { ok: false, reason: 'changed', error: 'This pull request changed while loading. Refresh to review the latest revision.' };
    return { ok: true, pr: { number, title: p.title, body: p.body, author: p.user.login, url: p.html_url, state: p.state, merged: p.merged, mergeSha: p.merge_commit_sha,
      sha: p.head.sha, head: p.head.ref, base: p.base.ref, baseSha: p.base.sha, draft: p.draft, mergeable: p.mergeable, mergeState: p.mergeable_state },
      files: files.ok ? files.data.map(f => ({ file: f.filename, previousFile: f.previous_filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch || null })) : [],
      filesError: files.ok ? null : files.error, filesTruncated: files.truncated || false,
      reviews: reviews.ok ? reviews.data.map(r => ({ author: r.user.login, state: r.state, body: r.body, sha: r.commit_id })) : [],
      checks: checks.ok ? (checks.data.check_runs || []).map(c => ({ name: c.name, state: c.conclusion || c.status, url: c.details_url })) : [],
      statuses: statuses.ok ? statuses.data.statuses.map(s => ({ name: s.context, state: s.state, url: s.target_url })) : [],
      checksKnown: checks.ok && statuses.ok, reviewsKnown: reviews.ok, capabilities: caps, previews };
  }

  async function review(name: string, { number, sha, event, body = '' }: ReviewOptions['review']): Promise<ReviewResults['review']> {
    if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(event) || !/^[a-f0-9]{40,64}$/.test(sha || '') || !Number.isSafeInteger(number) || number < 1) return { ok: false, error: 'Invalid review.' };
    if (event === 'REQUEST_CHANGES' && !body.trim()) return { ok: false, error: 'Describe the changes you are requesting.' };
    const current = await api(`repos/${name}/pulls/${number}`) as GitHubApiResult<GitHubPullRequestFull>;
    if (!current.ok) return current;
    if (current.data.head.sha !== sha) return { ok: false, reason: 'changed', error: 'New commits arrived. Refresh and review them first.' };
    return api(`repos/${name}/pulls/${number}/reviews`, { method: 'POST', body: { commit_id: sha, event, body } });
  }

  async function merge(name: string, { number, sha, baseSha, method = 'squash' }: Pick<ReviewOptions['merge'], 'number' | 'sha' | 'baseSha' | 'method'>): Promise<PullRequestMerged | ReviewFailure> {
    if (!Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40,64}$/.test(sha || '') || !['merge', 'squash', 'rebase'].includes(method)) return { ok: false, error: 'Refresh the pull request before merging.' };
    const info = await detail(name, number);
    if (!info.ok) return info;
    if (info.pr.sha !== sha || (baseSha && info.pr.baseSha !== baseSha)) return { ok: false, reason: 'changed', error: 'The pull request changed. Refresh before merging.' };
    if (!info.capabilities.ok || !info.capabilities.mergeMethods.includes(method)) return { ok: false, error: 'This merge method is not available. Open GitHub to inspect the repository rules.' };
    if (!info.checksKnown || !info.reviewsKnown || info.filesError || info.filesTruncated || info.capabilities.mergeQueue || info.pr.draft || info.pr.mergeable !== true || !['clean', 'has_hooks'].includes(info.pr.mergeState)) return { ok: false, error: 'GitHub requires more work before merging. Review the checks and requirements, or open GitHub.' };
    const result = await api(`repos/${name}/pulls/${number}/merge`, { method: 'PUT', body: { sha, merge_method: method } }) as GitHubApiResult<GitHubMergeBody | null>;
    return result.ok && result.data?.merged ? { ok: true, sha: result.data.sha, merged: true, branch: info.pr.base, url: info.pr.url } : { ok: false, error: result.data?.message || result.error || 'GitHub did not merge this pull request.' };
  }

  async function create(name: string, { head, base, title, body = '' }: CreatePullRequestOptions): Promise<CreatePullRequestResult> {
    const existing = await api(`repos/${name}/pulls?state=open&head=${encodeURIComponent(name.split('/')[0] + ':' + head)}&base=${encodeURIComponent(base)}`) as GitHubApiResult<GitHubPullRequest[]>;
    if (!existing.ok) return existing;
    if (existing.data.length) return { ok: true, pr: existing.data[0], existing: true };
    const result = await api(`repos/${name}/pulls`, { method: 'POST', body: { head, base, title, body } }) as GitHubApiResult<GitHubPullRequest>;
    return result.ok ? { ok: true, pr: result.data } : result;
  }

  return { capabilities, list, detail, review, merge, create };
}

// The default client, talking to GitHub through `request`.
export const { capabilities, list, detail, review, merge, create } = client();
export { request, slug, client };
