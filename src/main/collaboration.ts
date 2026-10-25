import fs from 'fs';
import * as repository from './repository';
import * as integration from './integration';
import * as publish from './publish';
import * as github from './githubReview';
import * as vercel from './vercel';
import type { GitHubCapabilitiesResult } from './githubReview';
import type { VercelFetch } from './vercel';
import type { VercelJson } from './publish';
import type { CollaborationPlanOptions, CollaborationPlanResult, CollaborationState, CollaborationStateOptions, DeploymentDestination, DeploymentObservation, HostingInfo, RadialApi, RepoState, RepoStatus, RepoSync, StoredReceipt } from '../shared/radialApi';

/** Every key of every member of a union. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
/**
 * A union whose members each read the other members' fields as undefined, so
 * code can read a field before narrowing (the window's LooseUnion, in
 * src/renderer/types.d.ts). Narrowing on the discriminant still works.
 */
type LooseUnion<T, All = T> = T extends unknown ? T & { [K in Exclude<KeysOfUnion<All>, keyof T>]?: undefined } : never;

type HostedProject = Extract<HostingInfo, { ok: true }>;
/**
 * hosting(): radialApi's HostingInfo, with the linked project's fields on the
 * failure as undefined. publish (and main.ts's merge) read projectId and orgId
 * without checking ok, so an unknown host reads as no project.
 */
export type HostingResult = LooseUnion<HostingInfo>;
/**
 * destination(): radialApi's DeploymentDestination, with a configured
 * deployment's fields on the others as undefined. publish (and main.ts's
 * merge) read `production` without checking the state, so an unverified
 * destination reads as not production.
 */
export type DestinationResult = LooseUnion<DeploymentDestination>;
/**
 * The receipt fields deployment() reads: every StoredReceipt (publishReceipt's,
 * or the one the window holds) has them. radialApi's collaborationDeployment
 * declares the window's receipt as a whole StoredReceipt.
 */
export type DeploymentReceipt = Pick<StoredReceipt, 'sha' | 'pushed' | 'branch'>;
/** deployment()'s options: `token` overrides the Vercel CLI's token (null means none); tests pass a fake fetch. */
export interface DeploymentOptions { fetchImpl?: VercelFetch; token?: string | null }
/** createBranch()'s options: the new branch's name, and the HEAD the window reviewed (radialApi's collaborationBranch). */
export type CreateBranchOptions = Parameters<RadialApi['collaborationBranch']>[1];
/** createBranch(): the branch now checked out, or why not (radialApi's collaborationBranch). */
export type CreateBranchResult = Awaited<ReturnType<RadialApi['collaborationBranch']>>;
/** What deployment() reports for a deployment it found (radialApi's DeploymentObservation). */
type ObservedState = Extract<DeploymentObservation, { id: string }>['state'];

// The part of the Vercel API's deployment list this module reads. Like the
// JavaScript, it trusts a listed deployment to have an id.
/** One deployment from GET /v6/deployments (the v6 list names every one by `uid`). */
interface VercelDeploymentBody {
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
interface VercelDeploymentsBody { deployments?: VercelDeploymentBody[] }

async function hosting(dir: string): Promise<HostingResult> {
  const link = vercel.readLink(dir);
  if (!link.linked) return { ok: false, state: 'unknown', reason: 'not-linked' };
  const info = await vercel.projectInfo(link);
  if (!info.ok) return { ...info, state: 'unknown' };
  let enabled: HostedProject['enabled'] = null;
  try {
    const config = JSON.parse(fs.readFileSync((require('path') as typeof import('path')).join(dir, 'vercel.json'), 'utf8')) as VercelJson;
    // The cast: like the JavaScript, this trusts the person's vercel.json to hold what Vercel's schema allows here (true or false, everywhere or per branch). It reaches the window as HostingInfo.enabled.
    enabled = config.git?.deploymentEnabled as HostedProject['enabled'] | undefined ?? null;
  } catch {}
  return { ...info, projectId: link.projectId, orgId: link.orgId, enabled, provider: 'Vercel' };
}

function destination(host: HostingResult, branch: string, slug: string | null): DestinationResult {
  if (!host.ok || !host.gitRepo || host.gitRepo.toLowerCase() !== (slug || '').toLowerCase()) return { state: 'unknown', label: 'Deployment behavior is not verified.' };
  // The cast: `true` has no branch keys, so indexing it reads undefined, like a map without this branch.
  if (host.enabled === false || (host.enabled as Record<string, boolean> | null)?.[branch] === false) return { state: 'disabled', label: 'Automatic Git deployments are disabled for this branch.' };
  if (!host.productionBranch) return { state: 'unknown', label: 'The production branch is not verified.' };
  const production = branch === host.productionBranch;
  return { state: 'configured', production, branch, provider: 'Vercel', label: production ? 'Configured for a Vercel production deployment. Build rules may skip deployment.' : 'Configured for a Vercel preview deployment. Build rules may skip deployment.' };
}

async function deployment(dir: string, receipt: DeploymentReceipt | null, { fetchImpl = fetch, token }: DeploymentOptions = {}): Promise<DeploymentObservation> {
  if (!receipt?.sha || !receipt.pushed) return { state: 'unknown', reason: 'not-pushed' };
  const link = vercel.readLink(dir);
  const credential = token === undefined ? vercel.vercelToken() : token;
  // readLink() reports a .vercel/project.json without a projectId as linked; like projectInfo, that is no project to ask about.
  if (!link.linked || !link.projectId || !credential) return { state: 'unknown', reason: 'not-connected' };
  const params = new URLSearchParams({ projectId: link.projectId, limit: '100', 'meta-githubCommitSha': receipt.sha });
  if (link.orgId) params.set('teamId', link.orgId);
  try {
    const res = await fetchImpl(`https://api.vercel.com/v6/deployments?${params}`, { headers: { authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return { state: 'unknown', reason: `http-${res.status}` };
    const data = await res.json() as VercelDeploymentsBody;
    const matches = (data.deployments || []).filter(d => d.meta?.githubCommitSha === receipt.sha && (!d.meta.githubCommitRef || d.meta.githubCommitRef === receipt.branch));
    const found = matches.sort((a, b) => (b.created || b.createdAt || 0) - (a.created || a.createdAt || 0))[0];
    if (!found) return { state: 'unobserved', sha: receipt.sha, label: 'No deployment has been reported for this commit.' };
    const raw = found.readyState || found.state;
    // A missing state indexes as the key "undefined", which no entry has.
    const state = ({ READY: 'ready', ERROR: 'failed', CANCELED: 'canceled', BUILDING: 'building', QUEUED: 'queued', INITIALIZING: 'queued' } as Partial<Record<string, ObservedState>>)[raw as string] || 'unknown';
    // The `!`: the list names every deployment by a uid (the body type above), so this has one; TypeScript can't rule out an empty uid falling through to a missing id.
    return { state, id: (found.uid || found.id)!, sha: receipt.sha, url: found.url ? `https://${found.url.replace(/^https:\/\//, '')}` : null, environment: found.target || 'preview', observedAt: Date.now() };
  } catch (error) { return { state: 'unknown', reason: 'unreachable', message: (error as Error).message }; }
}

async function state(dir: string, opts: CollaborationStateOptions = {}): Promise<CollaborationState> {
  const local = await repository.syncStatus(dir, { fetch: !!opts.fetch, target: opts.target });
  if (!local.isRepo) return local;
  const operation = await integration.read(dir);
  const receipt = await publish.publishReceipt(dir);
  const name = await github.slug(dir);
  const incoming = opts.fetch && local.ok && local.exists ? await integration.preview(dir, local.sha) : null;
  return { ...local, operationRecord: operation, receipt, slug: name, incoming };
}

async function plan(dir: string, { target = 'branch', branch, pr = false }: CollaborationPlanOptions = {}): Promise<CollaborationPlanResult> {
  const local = await repository.state(dir);
  if (!local.ok) return local;
  if (local.remote) {
    const target = await repository.pushTarget(dir, local.remote);
    if (!target.ok) return target;
  }
  const config = publish.readConfig(dir);
  const destinationBranch = branch || (target === 'production' ? config.productionBranch : target === 'staging' ? await publish.resolveEditBranchName(dir, config) : local.branch);
  if (!destinationBranch) return { ok: false, reason: 'detached', message: 'Create or switch to a branch first.' };
  const name = await github.slug(dir);
  // A relation without an upstream (exists: false), or a failed one, has no sha.
  const [capabilities, host, relation]: [GitHubCapabilitiesResult | null, HostingResult, LooseUnion<RepoSync> | null] = await Promise.all([
    name ? github.capabilities(name, destinationBranch) : null, hosting(dir),
    local.head && local.remote ? repository.syncStatus(dir, { target: destinationBranch }) : null,
  ]);
  const wantsPr = pr || capabilities?.requiresPr || (target === 'production' && config.productionPublish === 'pr');
  const fingerprint = await repository.fingerprint(dir);
  // A failed state() has no head (nor, unreadable, a branch).
  const latest: LooseUnion<RepoState> = await repository.state(dir);
  if (latest.head !== local.head || latest.branch !== local.branch) return { ok: false, reason: 'checkout-changed', message: 'The checkout changed. Review the action again.' };
  // The cast: a failed state()'s undefined head never equals local.head (a string or null), so it returned above.
  return { ok: true, local: latest as RepoStatus, fingerprint, target, branch: destinationBranch, pr: !!wantsPr, capabilities, hosting: host,
    deployment: destination(host, destinationBranch, name), relation, slug: name,
    mismatch: target === 'production' && host.ok && host.gitRepo?.toLowerCase() === name?.toLowerCase() && host.productionBranch && host.productionBranch !== destinationBranch,
    outgoing: relation?.ok && relation.sha ? await repository.run(dir, ['log', '-30', '--format=%h %s', `${relation.sha}..HEAD`]) : null };
}

async function createBranch(dir: string, { name, expectedHead }: CreateBranchOptions): Promise<CreateBranchResult> {
  return publish.withRepoLock(dir, async () => {
    try {
      await repository.run(dir, ['check-ref-format', '--branch', name]);
      const local = await repository.state(dir);
      if (!local.ok || !local.head || local.operation || local.conflicts.length || await integration.read(dir)) return { ok: false, message: 'Finish the current Git operation before creating a branch.' };
      if (expectedHead && expectedHead !== local.head) return { ok: false, message: 'The checkout changed. Refresh first.' };
      await repository.run(dir, ['switch', '-c', name]);
      return { ok: true, branch: name };
    } catch (error) { return { ok: false, message: (error as Error).message }; }
  });
}

export { state, plan, hosting, destination, deployment, createBranch };
