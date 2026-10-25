/**
 * Hosting: what the window's publish menu and settings show of a project's
 * Vercel hosting (its link files, and the Vercel API's answers, cached for
 * five minutes), connecting a project to Vercel, and its staging deploy. Moved
 * from main.ts (plans/headless-core.md, phase 1); the plan put the cache with
 * the sessions, but nothing here is about an open project's session.
 */
import path from 'path';
import * as vercel from '../main/vercel';
import * as publish from '../main/publish';
import * as projectState from '../main/projectState';
import type * as RadialIpc from '../shared/radialApi';
import type { AnswerTo, ArgTo } from './types';
import { sessions } from './sessions';
import { DEMO_FRESH } from './flows';

/** A Vercel project lookup (vercel.projectInfo), or 'error' when it threw. */
type VercelInfoAnswer = import('../main/vercel').VercelProjectInfoResult | { ok: false; reason: 'error' };
/** A cached Vercel project lookup (vcInfoCache): when it started, the lookup, and its answer once it has one. */
interface VercelInfoCacheEntry { at: number; p: Promise<VercelInfoAnswer>; v?: VercelInfoAnswer }

// The real hosting state per Vercel project, cached: the derived
// <name>.vercel.app guess is wrong whenever Vercel had to suffix the default
// domain (acme → acme-five.vercel.app) or a custom domain took
// over. Cached as a promise so concurrent callers coalesce; the resolved
// value is kept for cheap synchronous consults on menu-speed paths.
const vcInfoCache = new Map<string, VercelInfoCacheEntry>(); // projectId -> { at, p, v? }
const VC_INFO_TTL = 5 * 60 * 1000;
function vercelInfoFor(link: import('../main/vercel').VercelProjectIds | null | undefined): Promise<VercelInfoAnswer> {
  if (!link || !link.projectId) return Promise.resolve({ ok: false, reason: 'not-linked' });
  const hit = vcInfoCache.get(link.projectId);
  if (hit && Date.now() - hit.at < VC_INFO_TTL) return hit.p;
  const entry: VercelInfoCacheEntry = { at: Date.now(), p: vercel.projectInfo({ projectId: link.projectId, orgId: link.orgId }).catch(() => ({ ok: false, reason: 'error' })) };
  entry.p.then((v) => { entry.v = v; });
  vcInfoCache.set(link.projectId, entry);
  return entry.p;
}
// Already-resolved info only (or null) — never blocks, for the menu paths.
function vercelInfoCached(projectId: string | null | undefined): Extract<VercelInfoAnswer, { ok: true }> | null {
  const hit = projectId && vcInfoCache.get(projectId);
  return hit && hit.v && hit.v.ok && Date.now() - hit.at < VC_INFO_TTL ? hit.v : null;
}

// Cheap, local-only link state for the publish menu's rung chips.
export async function vercelLinkState(repoDir: ArgTo<'publishLinkState', 0>): Promise<AnswerTo<'publishLinkState'>> {
  const link = vercel.readLink(repoDir);
  const alt = vercel.readAltLink(repoDir, 'client-preview');
  // Site URLs: the API-detected truth when the cache is warm (settings and
  // the publish menu warm it), else the local guess from the link files.
  // Manual config (stagingUrl/productionUrl in .radial.json) wins over both
  // in the UI, e.g. for a custom domain Vercel doesn't know is primary yet.
  const cachedUrl = (l: import('../main/vercel').VercelProjectIds | null) => { const v = l && vercelInfoCached(l.projectId); return (v && v.url) || null; };
  return {
    repoLinked: link.linked,
    staging: !!alt,
    urls: {
      staging: cachedUrl(alt) || (alt && alt.name ? `https://${alt.name}.vercel.app` : null),
      production: cachedUrl(link) || (link.linked && link.name ? `https://${link.name}.vercel.app` : null),
    },
  };
}
// The full hosting picture for the settings panel: linked project, team,
// detected real URLs. Awaits the API (cached 5 min) — callers show a spinner.
export async function vercelProjectInfo(repoDir: ArgTo<'vercelProjectInfo', 0>): Promise<AnswerTo<'vercelProjectInfo'>> {
  if (DEMO_FRESH) return { linked: false };
  const link = vercel.readLink(repoDir);
  if (!link.linked) return { linked: false };
  const alt = vercel.readAltLink(repoDir, 'client-preview');
  const [info, stag] = await Promise.all([vercelInfoFor(link), alt ? vercelInfoFor(alt) : null]);
  const st = projectState.get(repoDir);
  const scope = (info.ok && info.team && info.team.slug) || (st && st.vercel && st.vercel.scope) || null;
  return {
    linked: true,
    project: link.name,
    team: info.ok ? info.team : null, // null = personal scope (or unknown)
    dashboardUrl: scope && link.name ? `https://vercel.com/${scope}/${link.name}` : null,
    urls: {
      production: (info.ok && info.url) || null,
      staging: (stag && stag.ok && stag.url) || null,
    },
    reason: info.ok ? null : info.reason,
  };
}
// The Vercel CLI's status (installed, signed in), with the project's link: its
// dashboard and live URLs.
export async function vercelStatus(repoDir?: ArgTo<'vercelStatus', 0>): Promise<AnswerTo<'vercelStatus'>> {
  if (DEMO_FRESH) return { installed: false, authed: false, user: null, link: { linked: false } };
  const s: RadialIpc.VercelCliStatus & { link?: RadialIpc.VercelLink } = await vercel.cliStatus();
  const link: RadialIpc.VercelLink = repoDir ? vercel.readLink(repoDir) : { linked: false };
  // Build a deterministic dashboard URL from the scope/project we saved at connect.
  if (link.linked && repoDir) {
    const st = projectState.get(repoDir);
    const scope = st && st.vercel && st.vercel.scope;
    const proj = (st && st.vercel && st.vercel.project) || link.name;
    // Live URL: detected truth when warm (the default domain isn't always
    // <project>.vercel.app — Vercel suffixes taken names), else the guess.
    const detected = vercelInfoCached(link.projectId);
    if (detected && detected.url) link.liveUrl = detected.url;
    else if (proj) link.liveUrl = `https://${String(proj).toLowerCase()}.vercel.app`;
    if (scope && proj) { link.scope = scope; link.dashboardUrl = `https://vercel.com/${scope}/${proj}`; }
  }
  s.link = link;
  return s as RadialIpc.VercelStatus; // with the link just set
}
// Deploy to a dedicated alt project (stable URL, repo's own .vercel untouched)
// — the no-remote staging target of the publish ladder.
export async function vercelDeployStaging({ repoDir, prod }: ArgTo<'vercelDeployAlt', 0>): Promise<AnswerTo<'vercelDeployAlt'>> {
  if (DEMO_FRESH) return { ok: false, reason: 'no-cli', error: 'Vercel isn’t available in demo mode.' };
  const s = sessions.get(repoDir);
  const projectName = (s && s.project && s.project.name) || path.basename(repoDir);
  const st = projectState.get(repoDir);
  return vercel.deployAlt(repoDir, 'client-preview', {
    prod: prod !== false,
    scope: (st && st.vercel && st.vercel.scope) || undefined,
    name: `${vercel.projectSlug(projectName)}-staging`,
  });
}
// Link the project + wire git so pushes deploy. We resolve the git remote here
// so the renderer doesn't have to.
export async function vercelConnect({ repoDir, scope, name }: ArgTo<'vercelConnect', 0>): Promise<AnswerTo<'vercelConnect'>> {
  if (DEMO_FRESH) return { ok: false, reason: 'no-cli', error: 'Vercel isn’t available in demo mode.' };
  const remoteUrl = await publish.getRemote(repoDir).catch(() => null);
  const r = await vercel.connectProject(repoDir, { scope, name, remoteUrl });
  // Persist scope + project so we can build the dashboard/deploy link later.
  if (r && r.ok) { try { projectState.set(repoDir, { vercel: { scope: r.scope || scope || null, project: r.project || null } }); } catch {} }
  vcInfoCache.clear(); // a relink changes the truth — refetch on next ask
  return r;
}
