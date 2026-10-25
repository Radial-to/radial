import * as projectData from './projectData';

/**
 * Vercel deploys for the local app. Two jobs:
 *  - deploy the working tree for an instant, public *preview* URL (uncommitted
 *    edits included) — the in-the-moment "send this to someone" loop;
 *  - know whether a folder is linked to a Vercel project.
 *
 * Auth piggybacks on the user's own `vercel login` (same model as the gh CLI —
 * no Radial-hosted credentials). The local project link lives in `.vercel/`,
 * which is gitignored like `.radial/` (it's machine-local, never committed).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, type ChildProcess } from 'child_process';
import { childEnv, which } from './env';
import type { HostingInfo, OkOrError, VercelCliStatus, VercelConnectResult, VercelDeployAltArgs, VercelDeployResult, VercelDomain, VercelLink, VercelScope, VercelScopes, VercelTeam } from '../shared/radialApi';

/** run()'s options; `env` adds variables to the CLI's environment. */
export interface VercelRunOptions { cwd?: string; timeout?: number; env?: Record<string, string> }
/** What a Vercel CLI run printed. run() never rejects: a failed run is `ok: false`. */
export interface VercelRunResult { ok: boolean; stdout: string; stderr: string }
/** The folder's own project link (`.vercel/project.json`): radialApi's VercelLink ids, without the extras vercel:status adds. An unlinked folder has no ids. */
export type VercelProjectLink =
  | { linked: false; projectId?: undefined; orgId?: undefined; name?: undefined }
  | ({ linked: true } & Pick<Extract<VercelLink, { linked: true }>, 'projectId' | 'orgId' | 'name'>);
/** `.vercel/project.json` as `vercel link` writes it (hostingProjects.link writes the same shape). */
export interface VercelProjectFile { projectId?: string; orgId?: string; projectName?: string }
/** The one kind of alt project: the stable staging project of the publish ladder. */
export type VercelAltKind = NonNullable<VercelDeployAltArgs['kind']>;
/** `.radial/vercel-<kind>.json`: an alt project's ids, saved only once `vercel link` returned both. readAltLink() returns the file unchecked, as a Partial; ensureAltProject checks the ids before asserting it (the name is trusted as the app writes it). */
export interface VercelAltLink { projectId: string; orgId: string; name: string }
/** ensureAltProject(): the alt project's ids, or why it couldn't be made. */
export type VercelAltProjectResult =
  | ({ ok: true } & VercelAltLink)
  | { ok: false; reason?: 'no-cli' | 'not-authed'; error: string };
/** deploy()'s options; `env` (an alt project's VERCEL_ORG_ID and VERCEL_PROJECT_ID) deploys to another project than the folder's link. */
export interface VercelDeployOptions { prod?: boolean; scope?: string; env?: Record<string, string> }
/** The scope (team or personal slug) and project name for creating or linking a Vercel project. */
export interface VercelProjectOptions { scope?: string; name?: string }
/** deployAlt()'s options: `cwd` is the folder to deploy (the repo by default); prod defaults to true. */
export interface VercelDeployAltOptions extends VercelProjectOptions { cwd?: string; prod?: boolean }
/** connectProject()'s options: `remoteUrl` is the git remote `vercel git connect` wires up. */
export interface VercelConnectOptions extends VercelProjectOptions { remoteUrl?: string | null }
/** link(): the folder's new link, or why linking failed. */
export type VercelLinkFolderResult =
  | ({ ok: true } & VercelProjectLink)
  | { ok: false; reason?: 'no-cli' | 'not-authed'; error: string };
/** gitConnect(): `error` is the CLI's last output line (undefined when it printed nothing). */
export type VercelGitConnectResult =
  | { ok: false; reason: 'no-cli' }
  | { ok: boolean; error: string | null | undefined };
/** A project's ids for the REST API; orgId is a team_ or user id. */
export interface VercelProjectIds { projectId?: string | null; orgId?: string | null }
/** A domain as pickSiteUrl reads it; a missing flag counts as verified, not branch-scoped, not redirecting. */
export interface SiteDomain { name: string; verified?: boolean; gitBranch?: string | null; redirect?: string | null }
/** The slice of fetch projectInfo uses; global fetch fits, and tests pass a fake. */
export type VercelFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
/** projectInfo()'s options: `token` overrides the CLI's token (null means none). */
export interface VercelProjectInfoOptions extends VercelProjectIds { token?: string | null; fetchImpl?: VercelFetch; timeoutMs?: number }
/** What projectInfo() reads about a project: the fields collaboration.hosting spreads into radialApi's HostingInfo. */
export type VercelProjectState = Pick<Extract<HostingInfo, { ok: true }>, 'url' | 'domains' | 'team' | 'gitRepo' | 'productionBranch' | 'autoAssignCustomDomains'>;
/** Why projectInfo() couldn't say (HostingInfo.reason and VercelProjectInfo.reason carry it as a string). */
export type VercelInfoFailure = 'no-token' | 'not-linked' | 'timeout' | 'network' | `http-${number}`;
/**
 * projectInfo(): the project's real hosting state, or why the API couldn't say.
 * Not radialApi's VercelProjectInfo, the vercel:projectInfo reply main.ts builds from this.
 */
export type VercelProjectInfoResult = ({ ok: true } & VercelProjectState) | { ok: false; reason: VercelInfoFailure };

// The parts of the Vercel CLI's and API's JSON this module reads.
interface CliTeams { teams?: { slug?: string; name?: string }[] }
interface DomainsBody { domains?: SiteDomain[] }
interface ProjectBody { link?: { type?: string; org?: string; repo?: string; productionBranch?: string } | null; autoAssignCustomDomains?: unknown }
interface TeamBody { slug?: string; name?: string }

// Every running probe, so quitting can take them down: an app that exits
// mid-probe used to leave `vercel whoami` spinning for minutes at 10-20% CPU
// (execFile's own timeout dies with the parent).
const running = new Set<ChildProcess>();
function vercelRun(args: readonly string[], { cwd, timeout = 25000, env }: VercelRunOptions = {}): Promise<VercelRunResult> {
  return new Promise((resolve) => {
    const child = execFile(which('vercel') || 'vercel', args,
      { cwd, env: childEnv(env || {}), maxBuffer: 8 * 1024 * 1024, timeout },
      (err, stdout, stderr) => { running.delete(child); resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' }); });
    running.add(child);
  });
}
function abortAll(): void { for (const c of running) { try { c.kill('SIGKILL'); } catch {} } running.clear(); }

const errTail = (r: VercelRunResult, fallback: string): string =>
  ((r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(-300)) || fallback;

const hasCli = (): boolean => !!which('vercel');

/** Is the Vercel CLI installed, and is the user signed in? */
async function cliStatus(): Promise<VercelCliStatus> {
  if (!hasCli()) return { installed: false, authed: false, user: null };
  const r = await vercelRun(['whoami']);
  return { installed: true, authed: r.ok, user: r.ok ? r.stdout.trim() : null };
}

/** Read the local project link written by `vercel link` (`.vercel/project.json`). */
function readLink(dir: string): VercelProjectLink {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, '.vercel', 'project.json'), 'utf8')) as VercelProjectFile;
    return { linked: true, projectId: j.projectId || null, orgId: j.orgId || null, name: j.projectName || null };
  } catch { return { linked: false }; }
}

/** Keep the local project link out of git (machine-local, like `.radial/`). */
function ensureIgnore(dir: string): void {
  const gi = path.join(dir, '.gitignore');
  let c = ''; try { c = fs.readFileSync(gi, 'utf8'); } catch {}
  if (c.split(/\r?\n/).some((l) => l.trim() === '.vercel' || l.trim() === '.vercel/')) return;
  const prefix = c && !c.endsWith('\n') ? '\n' : '';
  try { fs.writeFileSync(gi, c + `${prefix}# Vercel — local project link (not committed)\n.vercel\n`, 'utf8'); } catch {}
}

// Pull the deployment URL (stdout) + inspector URL (stderr) out of the
// `vercel deploy` output. The deployment URL is the deploy host (a *.vercel.app
// or custom domain); the inspector URL is a vercel.com dashboard link. Kept pure
// + exported so the parsing — the fragile part — is unit-tested.
function parseDeployUrls(stdout: string, stderr: string): { url: string | null; inspectorUrl: string | null } {
  const urls = (String(stdout || '').match(/https?:\/\/[^\s]+/g) || []).map((u) => u.replace(/[.,]+$/, ''));
  // Prefer a non-dashboard URL (the actual deployment); fall back to the last URL.
  const url = urls.filter((u) => !/(^|\.)vercel\.com(\/|$)/.test(u)).pop() || urls.pop() || null;
  const inspectorUrl = (String(stderr || '').match(/https?:\/\/[^\s]*vercel\.com[^\s]*/g) || [])[0] || null;
  return { url, inspectorUrl };
}

/**
 * Deploy the working tree. `--yes` skips prompts and auto-links the folder to a
 * (new or existing) project on first run, writing `.vercel/`. Returns the public
 * deployment URL parsed from the CLI output.
 */
async function deploy(dir: string, { prod = false, scope, env }: VercelDeployOptions = {}): Promise<VercelDeployResult> {
  if (!hasCli()) return { ok: false, reason: 'no-cli', error: 'The Vercel CLI (vercel) isn’t installed.' };
  const auth = await vercelRun(['whoami']);
  if (!auth.ok) return { ok: false, reason: 'not-authed', error: 'You’re not signed in to Vercel. Connect Vercel first.' };

  if (fs.existsSync(path.join(dir, '.git')) || !env) ensureIgnore(dir);
  const args = ['deploy', '--yes'];
  if (prod) args.push('--prod');
  if (scope) args.push('--scope', scope);

  const r = await vercelRun(args, { cwd: dir, timeout: 180000, env });
  if (!r.ok) {
    const err = (r.stderr || r.stdout || '').trim();
    return { ok: false, error: err.split('\n').filter(Boolean).slice(-3).join(' ').slice(-400) || 'Deploy failed.' };
  }
  const { url, inspectorUrl } = parseDeployUrls(r.stdout, r.stderr);
  return { ok: true, url, inspectorUrl, prod: !!prod, project: env ? null : readLink(dir).name || null };
}

// ── Alt projects — several Vercel projects for one folder ──────────────────
// The repo's own link lives in `.vercel/`. "Alt" links (the stable staging
// project, kind `client-preview`) are persisted under
// `.radial/vercel-<kind>.json` and applied per-deploy via the CLI's
// VERCEL_ORG_ID / VERCEL_PROJECT_ID overrides, so the repo's own link — and
// the repo itself — are never touched.

/** Vercel-project-name safe slug. */
function projectSlug(name: string | null | undefined): string {
  const s = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 63) || 'site';
}

function altLinkPath(repoDir: string, kind: VercelAltKind): string { return projectData.dataDir(repoDir, `vercel-${kind}.json`); }
function readAltLink(repoDir: string, kind: VercelAltKind): Partial<VercelAltLink> | null {
  try { return JSON.parse(fs.readFileSync(altLinkPath(repoDir, kind), 'utf8')) as Partial<VercelAltLink>; } catch { return null; }
}

/**
 * Make sure a named alt project exists and we know its ids. `vercel link`
 * insists on writing `.vercel/` into its cwd, so the create/lookup runs in a
 * throwaway temp dir and only the ids are persisted (under `.radial/`).
 */
async function ensureAltProject(repoDir: string, kind: VercelAltKind, { scope, name }: VercelProjectOptions = {}): Promise<VercelAltProjectResult> {
  const existing = readAltLink(repoDir, kind);
  if (existing && existing.projectId && existing.orgId) return { ok: true, ...existing as VercelAltLink };
  if (!hasCli()) return { ok: false, reason: 'no-cli', error: 'The Vercel CLI (vercel) isn’t installed.' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-vlink-'));
  try {
    const args = ['link', '--yes', '--project', projectSlug(name || kind)];
    if (scope) args.push('--scope', scope);
    const r = await vercelRun(args, { cwd: tmp, timeout: 60000 });
    if (!r.ok) {
      if (/not authorized|forbidden|credentials|log ?in/i.test(r.stderr)) return { ok: false, reason: 'not-authed', error: 'Not signed in to Vercel.' };
      return { ok: false, error: errTail(r, 'Could not create the Vercel project.') };
    }
    const j = JSON.parse(fs.readFileSync(path.join(tmp, '.vercel', 'project.json'), 'utf8')) as VercelProjectFile;
    const link = { projectId: j.projectId || null, orgId: j.orgId || null, name: j.projectName || projectSlug(name || kind) };
    if (!link.projectId || !link.orgId) return { ok: false, error: 'Vercel link did not return project ids.' };
    fs.mkdirSync(path.dirname(altLinkPath(repoDir, kind)), { recursive: true });
    fs.writeFileSync(altLinkPath(repoDir, kind), JSON.stringify(link, null, 2) + '\n', 'utf8');
    return { ok: true, ...link as VercelAltLink };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// The Vercel CLI's own auth token — reused for the few settings the CLI can't
// change (deployment protection). Honors VERCEL_TOKEN, else the CLI's auth.json.
function vercelToken(): string | null {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN.trim();
  const home = os.homedir();
  const files = process.platform === 'darwin'
    ? [path.join(home, 'Library', 'Application Support', 'com.vercel.cli', 'auth.json')]
    : process.platform === 'win32'
      ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'com.vercel.cli', 'auth.json')]
      : [path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'com.vercel.cli', 'auth.json')];
  for (const f of files) { try { const t = (JSON.parse(fs.readFileSync(f, 'utf8')) as { token?: unknown }).token; if (t) return String(t); } catch {} }
  return null;
}

/**
 * Turn OFF Vercel Deployment Protection for a project so its *.vercel.app URLs
 * load with no login. Presentation projects are meant for clients who have no
 * Vercel account — the whole promise is "one link, no login". Best-effort: the
 * CLI has no command for this, so we PATCH the REST API with the CLI's token;
 * on any failure the custom-domain path still bypasses protection.
 */
async function setPublic({ projectId, orgId }: VercelProjectIds): Promise<OkOrError> {
  const token = vercelToken();
  if (!token || !projectId) return { ok: false, error: 'No Vercel token or project id.' };
  try {
    const qs = orgId ? `?teamId=${encodeURIComponent(orgId)}` : '';
    const res = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}${qs}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ssoProtection: null, passwordProtection: null }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// ── Project truth (real domains, team) ─────────────────────────────────────
// The default production domain is NOT always <project>.vercel.app: when the
// bare name is already taken, Vercel silently assigns <project>-<suffix>
// .vercel.app (acme → acme-five.vercel.app), and an attached custom
// domain replaces it as the canonical URL entirely. Anything that DERIVES a
// URL from the project name is therefore a guess; this asks the API for the
// real list, so the app can stop guessing wherever it has the answer.

/** Canonical site URL from a project's domain list (pure, unit-tested).
 *  Branch-scoped and redirecting domains are never canonical; a verified
 *  custom domain beats the *.vercel.app default; ties go to the shortest. */
function pickSiteUrl(domains: SiteDomain[] | null | undefined): string | null {
  const cands = (Array.isArray(domains) ? domains : [])
    .filter((d) => d && d.name && !d.gitBranch && !d.redirect);
  if (!cands.length) return null;
  const rank = (d: SiteDomain): number => (/\.vercel\.app$/i.test(d.name) ? 1 : 0) + (d.verified === false ? 2 : 0);
  cands.sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length || a.name.localeCompare(b.name));
  return `https://${cands[0].name}`;
}

/**
 * The project's real hosting state from the Vercel API (CLI token, same model
 * as setPublic): canonical URL, domain list, team. Best-effort with clear
 * reasons — callers keep the derived guess when this can't answer.
 */
async function projectInfo({ projectId, orgId, token, fetchImpl, timeoutMs = 10000 }: VercelProjectInfoOptions = {}): Promise<VercelProjectInfoResult> {
  const tok = token !== undefined ? token : vercelToken();
  if (!tok) return { ok: false, reason: 'no-token' };
  if (!projectId) return { ok: false, reason: 'not-linked' };
  const f: VercelFetch = fetchImpl || fetch;
  const qs = orgId ? `?teamId=${encodeURIComponent(orgId)}` : '';
  const H = { authorization: `Bearer ${tok}` };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // Domains (the canonical URL) and the project object (its git connection —
    // whether pushes auto-deploy) in parallel; the git half is best-effort.
    const [res, pres] = await Promise.all([
      f(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}/domains${qs}`, { headers: H, signal: ctl.signal }),
      f(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}${qs}`, { headers: H, signal: ctl.signal }).catch(() => null),
    ]);
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    const j = await res.json() as DomainsBody;
    const domains = (j.domains || []).map((d): VercelDomain => ({
      name: d.name, verified: d.verified !== false, gitBranch: d.gitBranch || null, redirect: d.redirect || null,
    }));
    let gitRepo: string | null = null;
    let productionBranch: string | null = null;
    let autoAssignCustomDomains: boolean | null = null;
    try {
      const pj = pres && pres.ok ? await pres.json() as ProjectBody : null;
      const l = pj && pj.link;
      if (l && l.type === 'github' && l.org && l.repo) gitRepo = `${l.org}/${l.repo}`;
      productionBranch = l && l.productionBranch || null;
      autoAssignCustomDomains = typeof pj?.autoAssignCustomDomains === 'boolean' ? pj.autoAssignCustomDomains : null;
    } catch { /* git-connection display is optional */ }
    let team: VercelTeam | null = null;
    if (orgId && /^team_/.test(orgId)) {
      try {
        const tr = await f(`https://api.vercel.com/v2/teams/${encodeURIComponent(orgId)}`, { headers: H, signal: ctl.signal });
        if (tr.ok) { const tj = await tr.json() as TeamBody; team = { slug: tj.slug || null, name: tj.name || tj.slug || null }; }
      } catch { /* team display is optional */ }
    }
    return { ok: true, url: pickSiteUrl(domains), domains, team, gitRepo, productionBranch, autoAssignCustomDomains };
  } catch (e) {
    return { ok: false, reason: e && (e as Error).name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(t);
  }
}

/** Deploy `cwd` (defaults to the repo) to the alt project for `kind`. */
async function deployAlt(repoDir: string, kind: VercelAltKind, { cwd, prod = true, scope, name }: VercelDeployAltOptions = {}): Promise<VercelDeployResult> {
  const link = await ensureAltProject(repoDir, kind, { scope, name });
  if (!link.ok) return link;
  // Client link = no login: drop deployment protection (idempotent, covers
  // projects created before this ran). Never fatal to the deploy.
  await setPublic({ projectId: link.projectId, orgId: link.orgId }).catch(() => {});
  const res = await deploy(cwd || repoDir, {
    prod, scope, env: { VERCEL_ORG_ID: link.orgId, VERCEL_PROJECT_ID: link.projectId },
  });
  if (res.ok) res.project = link.name;
  return res;
}

/** Personal scope + teams, for a scope/team picker. */
async function listScopes(): Promise<VercelScopes> {
  if (!hasCli()) return { ok: false, reason: 'no-cli', scopes: [] };
  const me = await vercelRun(['whoami']);
  if (!me.ok) return { ok: false, reason: 'not-authed', scopes: [] };
  const user = me.stdout.trim();
  const scopes: VercelScope[] = [{ slug: user, name: user, type: 'personal' }];
  const t = await vercelRun(['teams', 'ls', '--format', 'json']);
  if (t.ok) {
    try {
      for (const tm of ((JSON.parse(t.stdout) as CliTeams).teams || [])) {
        if (tm.slug) scopes.push({ slug: tm.slug, name: tm.name || tm.slug, type: 'team' });
      }
    } catch { /* fall back to personal-only */ }
  }
  return { ok: true, user, scopes };
}

/** Link the folder to a (new or existing) Vercel project under `scope`. */
async function link(dir: string, { scope, name }: VercelProjectOptions = {}): Promise<VercelLinkFolderResult> {
  if (!hasCli()) return { ok: false, reason: 'no-cli', error: 'The Vercel CLI isn’t installed.' };
  ensureIgnore(dir);
  const args = ['link', '--yes'];
  if (name) args.push('--project', String(name).replace(/[^A-Za-z0-9._-]/g, '-').toLowerCase());
  if (scope) args.push('--scope', scope);
  const r = await vercelRun(args, { cwd: dir, timeout: 60000 });
  if (!r.ok) {
    if (/not authorized|forbidden|not a member/i.test(r.stderr)) return { ok: false, reason: 'not-authed', error: 'Not signed in to Vercel (or no access to that scope).' };
    return { ok: false, error: (r.stderr || r.stdout || 'Could not link the project.').split('\n').filter(Boolean).slice(-2).join(' ').slice(-300) };
  }
  return { ok: true, ...readLink(dir) };
}

/** Wire the linked project to its Git repo so pushes auto-deploy. */
async function gitConnect(dir: string, { scope, remoteUrl }: VercelConnectOptions = {}): Promise<VercelGitConnectResult> {
  if (!hasCli()) return { ok: false, reason: 'no-cli' };
  const args = ['git', 'connect'];
  if (remoteUrl) args.push(remoteUrl);
  if (scope) args.push('--scope', scope);
  const r = await vercelRun(args, { cwd: dir, timeout: 60000 });
  return { ok: r.ok, error: r.ok ? null : (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(-1)[0] };
}

/**
 * Link the project + wire git so pushes deploy. Git connect is best-effort —
 * even if it fails, the project is linked and the Preview button still deploys.
 */
async function connectProject(dir: string, { scope, name, remoteUrl }: VercelConnectOptions = {}): Promise<VercelConnectResult> {
  const linked = await link(dir, { scope, name });
  if (!linked.ok) return linked;
  const gc = await gitConnect(dir, { scope, remoteUrl });
  return { ok: true, project: linked.name || name || null, scope: scope || null, gitConnected: gc.ok, projectId: linked.projectId || null };
}

export { cliStatus, readLink, ensureIgnore, deploy, listScopes, link, gitConnect, connectProject, parseDeployUrls, vercelToken, projectSlug, readAltLink, ensureAltProject, deployAlt, setPublic, pickSiteUrl, projectInfo, abortAll, vercelRun as run, hasCli };
