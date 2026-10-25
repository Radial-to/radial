import fs from 'fs';
import path from 'path';
import * as vercel from './vercel';
import type { VercelProjectFile, VercelProjectInfoOptions } from './vercel';
import type { VercelLinkArgs, VercelLinkResult, VercelProjects, VercelProjectsQuery } from '../shared/radialApi';

/** The Vercel API seams projects() and link() pass to request(), as vercel.projectInfo takes them: the token (undefined: the CLI's, null: not signed in) and fetch. Tests pass both. */
export type HostingRequestDeps = Pick<VercelProjectInfoOptions, 'token' | 'fetchImpl'>;
/** A Vercel REST answer: the parsed JSON, or a message to show. */
type HostingReply<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

// The parts of Vercel's REST JSON this module reads.
interface ProjectBody { id: string; name: string; accountId: string }
interface ProjectsBody { projects?: ProjectBody[]; pagination?: { next?: number | null } }

async function request(endpoint: string, { token = vercel.vercelToken(), fetchImpl = fetch }: HostingRequestDeps = {}): Promise<HostingReply> {
  if (!token) return { ok: false, error: 'Sign in to the Vercel CLI to choose a project.' };
  try {
    const response = await fetchImpl(`https://api.vercel.com/${endpoint}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) return { ok: false, error: `Vercel could not read this account or project (${response.status}).` };
    return { ok: true, data: await response.json() };
  } catch (error) { return { ok: false, error: (error as Error).message }; }
}
async function projects({ scope, search = '', until }: VercelProjectsQuery = {}, deps?: HostingRequestDeps): Promise<VercelProjects> {
  const params = new URLSearchParams({ limit: '20', search });
  if (scope) params.set('slug', scope);
  if (until) params.set('until', String(until));
  const result = await request(`v9/projects?${params}`, deps) as HostingReply<ProjectsBody>;
  if (!result.ok) return result;
  return { ok: true, projects: (result.data.projects || []).map(p => ({ id: p.id, name: p.name, orgId: p.accountId })), next: result.data.pagination?.next || null };
}
async function link(dir: string, { projectId, orgId }: Pick<VercelLinkArgs, 'projectId' | 'orgId'>, deps?: HostingRequestDeps): Promise<VercelLinkResult> {
  if (!projectId || !orgId) return { ok: false, error: 'Choose a hosting project first.' };
  const params = new URLSearchParams();
  if (orgId.startsWith('team_')) params.set('teamId', orgId);
  const result = await request(`v9/projects/${encodeURIComponent(projectId)}?${params}`, deps) as HostingReply<ProjectBody>;
  if (!result.ok) return result;
  const project = result.data;
  if (project.id !== projectId || project.accountId !== orgId) return { ok: false, error: 'The selected project changed. Refresh the project list.' };
  const folder = path.join(dir, '.vercel');
  if (fs.existsSync(folder) && fs.lstatSync(folder).isSymbolicLink()) return { ok: false, error: 'The .vercel folder is a symbolic link. Change this link in your terminal.' };
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'project.json');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) return { ok: false, error: 'The Vercel project link is a symbolic link. Change it in your terminal.' };
  fs.writeFileSync(file, JSON.stringify({ projectId: project.id, orgId: project.accountId, projectName: project.name } satisfies VercelProjectFile, null, 2) + '\n');
  vercel.ensureIgnore(dir);
  return { ok: true, project: project.name };
}
export { projects, link };
