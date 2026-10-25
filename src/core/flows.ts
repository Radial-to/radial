/**
 * The longer flows: a new project from a starter (and its GitHub repo); site
 * migration, which scaffolds a project, captures the live site, records the
 * intent and starts the agent that rebuilds it, with its playbook; publishing,
 * plain or gated on a production build with a fix prompt for the person's
 * agent when it fails; and the AGENTS.md index of a project's context. Moved
 * from main.ts (plans/headless-core.md, phase 1).
 */
import fs from 'fs';
import path from 'path';
import * as migrate from '../main/migrate';
import * as newProject from '../main/newProject';
import * as github from '../main/github';
import * as recents from '../main/recents';
import * as context from '../main/context';
import * as references from '../main/references';
import * as projectMemory from '../main/projectMemory';
import * as engine from '../main/engine';
import * as telemetry from '../main/telemetry';
import * as publish from '../main/publish';
import * as deploy from '../main/deploy';
import * as moments from '../main/moments';
import type * as RadialIpc from '../shared/radialApi';
import { notifyMomentCreated } from './history';
import { vercelResolveAfterPublish } from './sessions';
import { startAgent } from './agentLane';
import { browserPage, platform, send, viewer } from './host';

// ── Site migration (plans/site-migration.md) ──
// One engine behind `radial migrate`, MCP and the Home wizard: scaffold, capture
// the live site, record the intent, and start the agent that rebuilds it.

let migratePlaybookDir: string | null = null;
export function migrationPlaybook(): string {
  if (!migratePlaybookDir) { migratePlaybookDir = migrate.installPlaybook(platform().dataDir, platform().version); engine.setMigrationPlaybook(path.join(migratePlaybookDir, 'SKILL.md')); }
  return migratePlaybookDir;
}
export function writeMigrationRecord(dir: string, text: string): void {
  context.write(dir, 'migration.md', text);
  try { syncCtxIndex(dir); context.ensureCommitted(dir); } catch {}
}
export async function migratePrepare({ url, framework, name, dir, files = [], engine: wanted, only = [] }: import('../main/cliServer').MigrateRequest, progress: import('../main/cliServer').Progress = () => {}): Promise<import('../main/cliServer').MigratePrepareAnswer> {
  // hasOwn: the window's payload is unchecked, and an index would accept a name every object inherits ('constructor').
  if (!Object.hasOwn(migrate.FRAMEWORKS, framework)) return { ok: false, code: 'bad-request', error: 'Choose Astro or Next.js.' };
  for (const file of files) if (!fs.existsSync(file)) return { ok: false, code: 'not-found', error: `File not found: ${file}` };
  const avail = engine.available();
  const chosen = wanted || (avail.claude ? 'claude' : avail.codex ? 'codex' : avail.cursor ? 'cursor' : null);
  if (!chosen || !avail[chosen]) return { ok: false, code: 'no-engine', error: chosen ? `${chosen} is not installed on this machine.` : 'Install Claude Code, Codex or Cursor to run the migration agent.' };
  let site: import('../main/migrate/capture').ResolvedSite;
  try { site = await (require('../main/migrate/capture') as typeof import('../main/migrate/capture')).resolveSite(url); } catch (e) { return { ok: false, code: 'not-found', error: (e as Error).message }; }
  progress(`${site.host} is a ${site.platform.name === 'Unknown' ? 'website' : site.platform.name + ' site'}.`);
  // Pages to start with must be this site's, checked before a project exists.
  const bare = (h: string) => h.replace(/^www\./, '');
  for (const page of only) { let u = null; try { u = new URL(page, site.origin); } catch {} if (!u || bare(u.hostname) !== bare(site.host)) return { ok: false, code: 'bad-request', error: `Pages to bring in must be on ${site.host}: ${page}` }; }
  const parentDir = dir || recents.getProjectsDir() || path.join(platform().home, 'Radial');
  const base = newProject.sanitizeProjectName(name || site.host.replace(/^www\./, '').split('.')[0]) || 'site';
  let projectName = base;
  for (let n = 2; fs.existsSync(path.join(parentDir, projectName)); n++) projectName = `${base}-${n}`;
  progress(`Creating ${projectName} (${migrate.FRAMEWORKS[framework]})…`);
  const created = await createNewProject({ templateId: framework, name: projectName, parentDir, github: null }, (line) => { progress(line); send('log', `[migrate] ${line}`); });
  if (!created.ok) return created;
  const repoDir = created.dir;
  let captured: import('../main/migrate').SiteCapture;
  try { captured = await migrate.captureSite(repoDir, site.url, { site, shoot: browserPage()?.shoot, files, only, onProgress: progress }); } // no browser: no reference screenshots
  catch (e) { return { ok: false, code: 'error', error: `The project was created at ${repoDir}, but the capture failed: ${(e as Error).message}`, dir: repoDir }; }
  const inv = captured.inventory;
  writeMigrationRecord(repoDir, migrate.intentRecord({ url: site.url, platform: inv.platform.name, framework, captureRef: migrate.captureRef(repoDir, captured.dir), inventory: inv, files }));
  const task = migrate.kickoffPrompt({ url: site.url, platform: inv.platform.name, framework, captureReadme: path.join(captured.dir, 'README.md'), playbook: path.join(migrationPlaybook(), 'SKILL.md'), provided: files.length, scope: inv.scope });
  // The project's first chat carries the task: opening the project shows this
  // chat instead of starting a blank one, and its CLI boots with the task.
  let chatId: string | null = null;
  const chats = viewer()?.chats;
  if (chats) chatId = chats.createTaskChat(repoDir, chosen, `Migrate ${site.host.replace(/^www\./, '')}`, task);
  return { ok: true, dir: repoDir, name: projectName, framework, frameworkLabel: migrate.FRAMEWORKS[framework], source: site.url, platform: inv.platform.name, pages: inv.counts.pages, assets: inv.counts.assets, capture: captured.dir, engine: chosen, task, chatId };
}
export async function migrateLaunch({ dir, engine: chosen, task, chatId }: RadialIpc.MigrateLaunchArgs): ReturnType<import('../main/cliServer').CliApi['migrateLaunch']> {
  const view = viewer();
  const chats = view?.chats;
  if (chatId && chats) {
    try { const s = await chats.startTaskChat(chatId); return { ok: true, engine: chosen, session: s.title, chatId }; }
    catch (e) { return { ok: false, code: 'error', error: (e as Error).message }; }
  }
  // The window's agent start, or with no window (radial serve) the core's own: a session with the task as its first prompt.
  const request = { repoDir: dir, task, submit: true, engine: chosen, label: 'Migration' };
  const res = view ? await view.agentStart(request) : await startAgent(request);
  return res && res.ok ? { ok: true, engine: res.engine, session: res.id } : { ok: false, code: (res && res.code) || 'error', error: (res && res.error) || 'The migration agent did not start.' };
}

// Scaffold a project from a starter (the wizard and the CLI's `new` share this).
export async function createNewProject({ templateId, name, parentDir, github: gh }: RadialIpc.NewProjectArgs, onLog: (line: string) => void): Promise<RadialIpc.NewProjectResult> {
  const res = await newProject.createProject({ templateId, name, parentDir, onLog });
  if (res.ok) telemetry.capture('project_created', { template: String(templateId || '') });
  // Optional rung-2 climb, folded into creation: put the fresh repo on GitHub.
  // Strictly non-fatal — the local project is complete either way.
  if (res.ok && gh && gh.create && !DEMO_FRESH) {
    onLog('[radial] creating the GitHub repo…');
    try {
      const r = await github.createRepo({ dir: res.dir, owner: gh.owner || '', name: path.basename(res.dir), isPrivate: true });
      if (r.ok) { res.github = { url: r.url, nameWithOwner: r.nameWithOwner }; onLog(`[radial] on GitHub: ${r.nameWithOwner}`); }
      else { res.githubError = r.error || 'Could not create the GitHub repo.'; onLog(`[radial] GitHub skipped: ${res.githubError}`); }
    } catch (e) {
      res.githubError = (e as Error).message;
      onLog(`[radial] GitHub skipped: ${(e as Error).message}`);
    }
  }
  return res;
}

// Onboarding preview: pretend this is a fresh machine (no gh, no Claude, not
// signed in) so the setup/onboarding UI can be seen without uninstalling tools.
// Enable with RADIAL_DEMO_FRESH=1. No effect otherwise.
export const DEMO_FRESH = process.env.RADIAL_DEMO_FRESH === '1';

// publish() derives the commit message from the staged file list — no agent
// call, so publishing never spends the user's AI quota in the background. An
// explicit opts.message (typed, or AI-drafted by the user via the button) wins.
// Shared by the Publish button (later targets) and `radial publish --no-gate`.
export async function publishPlain(repoDir: string, opts: RadialIpc.PublishOptions): Promise<RadialIpc.PublishResult> {
  const res = await publish.publish(repoDir, { ...(opts || {}) });
  if (res && res.ok) {
    if (res.pushed) telemetry.capture('site_published', { mode: String(res.mode || '') });
    moments.record(repoDir, { kind: res.pushed ? 'publish' : 'edit', label: res.pushed ? 'Local work after push' : 'Committed locally' }).then((r: RadialIpc.MomentRecordResult) => notifyMomentCreated(repoDir, r)).catch(() => {});
    if (res.pushed) vercelResolveAfterPublish(repoDir);
  }
  return res;
}


// Publish that "just works": run the deterministic preflight and gate on a real
// production build of the working tree, so only a tree that builds gets pushed.
// The build gate needs no Vercel CLI — it runs the project's OWN build, the
// universal signal every host runs — so it works for GitHub-only users too.
// Streams 'publish:event' progress; returns the publish result + a `deploy`
// summary.
//
// A red gate is handed to the user's VISIBLE terminal agent: failures come back
// with a ready `fixPrompt` the renderer pastes into the project's CLI session.
// The old headless fix loop (`claude -p`) is gone — it worked out of sight
// while the UI said "see the chat", so users couldn't tell anything was
// happening and routed around the publish button entirely.
const PUBLISH_HANDOFF_CODA = '\n\nYou are working in the user\'s own terminal session inside Radial. Fix it, verify the fix yourself (for a build failure, re-run the production build until it passes), then summarize what you changed and tell the user to press Publish again.';

// Shared by the Publish button and `radial publish`: the build gate, the push,
// and on failure a ready fix prompt for the user's VISIBLE terminal agent (never
// auto-sent; the renderer offers a button, the CLI prints it).
export async function publishDeploy(repoDir: string, opts: RadialIpc.PublishOptions, { onEvent }: import('../main/deploy').DeployHooks): Promise<RadialIpc.PublishDeployResult> {
  const res = await deploy.publishAndDeploy(repoDir, opts || {}, { onEvent });
  if (res && res.ok) {
    if (res.pushed) telemetry.capture('site_published', { mode: String(res.mode || 'deploy') });
    moments.record(repoDir, { kind: res.pushed ? 'publish' : 'edit', label: res.pushed ? 'Local work after push' : 'Committed locally' }).then((r: RadialIpc.MomentRecordResult) => notifyMomentCreated(repoDir, r)).catch(() => {});
    if (res.pushed) vercelResolveAfterPublish(repoDir);
  } else if (res) {
    if (res.reason === 'build-failed' && res.deploy) {
      res.fixPrompt = deploy.buildFixPrompt(res.deploy.cmd || 'the production build', res.deploy.log) + PUBLISH_HANDOFF_CODA;
      res.fixLabel = 'Publish build fix';
    } else {
      const cls = deploy.classifyPublishError(res);
      if (cls && cls.fixable) {
        res.fixPrompt = deploy.pushFixPrompt(cls.kind, res.message, opts || {}) + PUBLISH_HANDOFF_CODA;
        res.fixLabel = 'Publish push fix';
      }
    }
  }
  return res;
}


// Keep AGENTS.md's "Project context" index in step with .context/ + refs —
// the channel outside agents (and humans without Radial) actually read.
export const syncCtxIndex = (repoDir: string): void => { try { projectMemory.syncContextIndex(repoDir, context.list(repoDir), references.list(repoDir)); } catch {} };
