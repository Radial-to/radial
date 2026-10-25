/**
 * The open projects, one per tab: opening a project's repo and starting its dev
 * server, sleeping and waking it, restarting and stopping it; the sweeps that
 * put idle projects to sleep, restart a dev server past its memory limit and
 * heal one that crashed; the restart requests and state files agents leave in
 * .radial/; the Vercel comment sync; the launch check; and the Vercel project
 * info cache. Moved from main.ts (plans/headless-core.md, phase 1); the window
 * hears about it through the session:, dev:, comments: and log events.
 */
import fs from 'fs';
import path from 'path';
import * as devServer from '../main/devServer';
import * as project from '../main/project';
import * as publish from '../main/publish';
import * as vercel from '../main/vercel';
import * as terminal from '../main/terminal';
import * as recents from '../main/recents';
import * as projectState from '../main/projectState';
import * as projectData from '../main/projectData';
import * as devPids from '../main/devPids';
import * as devHeal from '../main/devHeal';
import * as restartRequests from '../main/restartRequests';
import * as watcherHealth from '../main/watcherHealth';
import * as context from '../main/context';
import * as projectMemory from '../main/projectMemory';
import * as vercelComments from '../main/vercelComments';
import * as launchCheck from '../main/launchCheck';
import * as telemetry from '../main/telemetry';
import * as agentSleep from '../main/agentSleep';
import { makeCoalescer } from '../main/coalesce';
import type { CliApi } from '../main/cliServer';
import type { DevServerHandle } from '../main/devServer';
import type { PtyInfo } from '../main/terminal';
import type { OpenProjectResult, RadialConfig, RunnableProject } from '../shared/radialApi';
import type * as RadialIpc from '../shared/radialApi';
import type { AnswerTo, ArgTo, LooseUnion } from './types';
import { checkpointNow, histories, loadHistory, startMomentWatcher, stopMomentWatcher } from './history';
import { homeCwd, reapIdleAgents } from './agents';
import { events, options, platform, send, viewer } from './host';

/**
 * An open project, one per tab, keyed by its folder in `sessions`. devHeal's
 * HealSession and workspaceActivity's ActivitySession read it.
 */
export interface ProjectTabSession {
  /** The project's dev server; null while it sleeps, and from a crash or restart until the resume. */
  handle: DevServerHandle | null;
  /** How it runs: devServer.detectProject's answer, then the running server's. */
  project: RunnableProject;
  /** publish.readConfig, with the site URL getSiteUrl found. */
  config: RadialConfig;
  suspended: boolean;
  /** Restored asleep at boot (startRepoCold): the open prep runs at its first wake. */
  cold?: boolean;
  /** That open prep, once something started it (prepareCold): its first wake, or an agent starting first. */
  prepared?: Promise<void>;
  /** When it was last used; the idle sweep puts it to sleep options().idleSleepMs later. */
  lastActive: number;
  /** When checkDevMemory restarted its dev server, within devMemory.QUIET_MS. */
  memRestarts?: number[];
  /** When the crash healer restarted its dev server (devHeal.decide). */
  heals?: number[];
}
/** One project's Vercel comment sync (vcState): the pull in flight, and when the last one ran and what it answered. */
interface VercelCommentSync { running?: Promise<RadialIpc.VercelPullResult> | null; lastAt?: number; lastResult?: RadialIpc.VercelPullResult; nextAt?: number }
/** A project's dev-server build-error state (buildErr): whether an error shows, its last lines, and the send's debounce. */
interface BuildErrorWatch { active: boolean; buf: string[]; timer: NodeJS.Timeout | null }

// Multiple open projects, one per tab, keyed by repoDir.
export const sessions = new Map<string, ProjectTabSession>(); // repoDir -> { handle, project, config }
export let activeRepoDir: string | null = null;    // which tab the menu accelerators act on
// One dev-server start per repoDir at a time. Opening and resuming both await a
// minute-long `devServer.start` before recording the session/pid; without this,
// a concurrent call for the same repo spawns a duplicate, leaked dev server. See
// coalesce.js. Concurrent opens share one start, and so do concurrent resumes.
// An open and a resume of the same repo can overlap (a restart request found as
// a restored tab opens, `radial wake` mid-open, reopening a project whose wake is
// still starting), so the two kinds take turns (inTurn): each runs its own start
// and answers its own result, never the other's.
const coalesceOpen = makeCoalescer<string, OpenProjectResult>();
const coalesceResume = makeCoalescer<string, string | null>();
const startTurns = new Map<string, Promise<void>>(); // repoDir -> settles once the last start queued for it has
function inTurn<T>(repoDir: string, start: () => Promise<T>): Promise<T> {
  const turn = (startTurns.get(repoDir) || Promise.resolve()).then(start);
  const settled = turn.then(() => {}, () => {});
  startTurns.set(repoDir, settled);
  settled.then(() => { if (startTurns.get(repoDir) === settled) startTurns.delete(repoDir); });
  return turn;
}


export function notifyCommentsChanged(dir: string): void { send('comments:changed', { repoDir: dir }); }

export async function stopSession(repoDir: string): Promise<void> {
  const s = sessions.get(repoDir);
  unwatchRestartRequests(repoDir);
  unwatchAgentStateFiles(repoDir);
  stopMomentWatcher(repoDir);
  if (s && s.handle && s.handle.stop) {
    try { await s.handle.stop(); } catch {}
  }
  devPids.clear(repoDir); // cleanly stopped → no orphan to reap next time
  buildErr.delete(repoDir);
  sessions.delete(repoDir);
  projectData.release(repoDir);
  histories.delete(repoDir);
  if (activeRepoDir === repoDir) activeRepoDir = null;
}

export async function stopAll(): Promise<void> {
  // Final safety snapshot of every open project before we tear down.
  for (const repoDir of [...sessions.keys()]) { try { await checkpointNow(repoDir); } catch {} }
  // Idle Claude agents sleep at quit (they come back via --resume on wake); an
  // agent still WORKING keeps running in the daemon — you can close Radial
  // while it finishes. Reap before the flush so the slept records land on disk.
  // Without parking (radial serve), every agent stays up for whoever comes back.
  if (options().parkAgents) {
    for (const repoDir of [...sessions.keys()]) { try { await reapIdleAgents(repoDir); } catch {} }
    try { await reapIdleAgents(homeCwd()); } catch {} // Home agents sleep at quit like project agents
  }
  // Chats know when a turn is running (hooks, transcripts), so they don't need
  // the 90s output silence plain terminals do: any chat between turns that has
  // been quiet a few seconds is parked. Working and kept-awake ones outlive the app.
  try { await viewer()?.chats?.parkIdle({ idleMs: 10 * 1000 }); } catch {}
  try { projectState.flush(); } catch {} // persist any pending chat/draft/slept-agent writes
  // NOTE: we deliberately do NOT kill working terminals here. The PTY daemon
  // keeps agent sessions running after Radial closes (Solo/Conductor style); we
  // reattach to them on next launch.
  for (const repoDir of [...sessions.keys()]) await stopSession(repoDir);
  await telemetry.shutdown(); // best-effort flush, capped at 2s
}

// --- idle dev-server suspension ------------------------------------------
// After options().idleSleepMs unused: 5 minutes in the Mac app, never in
// radial serve unless it was started with --idle.

function resumeSession(repoDir: string): Promise<string | null> {
  // Coalesce concurrent resumes (tab click + idle-timer race, repeated IPC) so a
  // suspended project is only ever brought back up by one dev-server start.
  return coalesceResume(repoDir, () => inTurn(repoDir, () => doResumeSession(repoDir)));
}

// Static-server live reload: the built-in static server has no HMR, so its
// file watcher pings here and the renderer refreshes that project's preview.
function notifyStaticChanged(repoDir: string): void {
  send('dev:static-changed', { repoDir });
}

// A cold session (restored asleep at boot — startRepoCold) skipped the open prep
// along with the dev server: its history, the Radial files' migration and the
// AGENTS.md notes. It runs once, for whichever comes first: the first wake, or an
// agent starting in the project (startTerminal), which reads those notes as it
// starts, so they are there before it. None of it waits on the dev server.
export function prepareCold(repoDir: string): Promise<void> {
  const s = sessions.get(repoDir);
  if (!s || !s.cold) return Promise.resolve();
  return s.prepared ||= (async () => {
    loadHistory(repoDir);
    try { await context.migrate(repoDir, publish.git, { commitConfig: s.config.commitConfig }); } catch {}
    try {
      if (projectMemory.exists(repoDir)) {
        projectMemory.excludeFromDeploy(repoDir);
        projectMemory.ensurePreviewNote(repoDir);
        projectMemory.ensureStateFilesNote(repoDir);
        projectMemory.ensureCliNote(repoDir);
      }
    } catch {}
  })();
}

async function doResumeSession(repoDir: string): Promise<string | null> {
  const s = sessions.get(repoDir);
  if (!s || !s.suspended) return s && s.handle ? s.handle.url : null;
  await prepareCold(repoDir);
  reapStaleDevServer(repoDir);
  const handle = await devServer.start(repoDir, {
    onLog: (line: string) => devLog(repoDir, s.project.name, line),
    onChanged: () => notifyStaticChanged(repoDir),
    timeoutMs: s.cold ? 180000 : 90000, // a cold wake can be the project's first-run install
    ownsPid,
  });
  // Closed while the server started (stopSession had no handle to stop): stop it
  // here, or it runs on unseen, still advertised in dev.json, until an open reaps it.
  if (sessions.get(repoDir) !== s) {
    try { await handle.stop(); } catch {}
    devPids.clear(repoDir);
    return null;
  }
  if (handle.child) devPids.set(repoDir, handle.child.pid);
  s.handle = handle;
  if (s.cold) {
    s.cold = false;
    s.project = handle.project || s.project;
    recents.addRecent(repoDir, s.project.name);
    platform().recentsChanged?.();
    telemetry.capture('project_opened'); // counted at first USE, not at cold restore
  }
  s.suspended = false;
  s.lastActive = Date.now();
  watchDevServer(repoDir);
  send('session:resumed', { repoDir, url: handle.url });
  return handle.url;
}

// Put a project to sleep: stop its dev server AND its idle Claude agents, keep
// the tab. Used by the idle sweeper and by the rail menu's manual "Sleep" (which
// may target the ACTIVE project — waking is just activating/using it again).
export async function suspendSession(repoDir: string): Promise<AnswerTo<'sleepProject'>> {
  const s = sessions.get(repoDir);
  if (!s || s.suspended || !s.handle) return { ok: false, reason: 'not-running' };
  try { await s.handle.stop(); } catch {}
  devPids.clear(repoDir);
  s.handle = null;
  s.suspended = true;
  send('session:suspended', { repoDir });
  reapIdleAgents(repoDir).catch(() => {});
  viewer()?.chats?.parkIdle({ idleMs: agentSleep.AGENT_IDLE_MS, repoDir }).catch(() => {});
  return { ok: true };
}

// A dev server Radial runs may not grow past its limit: in the Mac app a
// quarter of the Mac's memory (at least 4 GB), in radial serve half the
// machine's (options().devMemoryLimitMb). Over it, Radial restarts the server;
// the rules for when it waits or, for a true runaway, stops it are in
// devMemory.js. RSS of the whole tree.
const devMemory = require('../main/devMemory') as typeof import('../main/devMemory');
const devMemLimitMb = (): number => Number(process.env.RADIAL_DEV_MEM_LIMIT_MB) > 0 ? Number(process.env.RADIAL_DEV_MEM_LIMIT_MB) : options().devMemoryLimitMb; // env: e2e seam
export async function checkDevMemory(): Promise<void> {
  const DEV_MEM_LIMIT_MB = devMemLimitMb();
  const roots: { repoDir: string; s: ProjectTabSession; pid: number; external: boolean }[] = [];
  for (const [repoDir, s] of sessions) {
    const pid = s.handle && (s.handle.child ? s.handle.child.pid : (s.handle.external ? s.handle.pid : null));
    if (pid && !s.suspended) roots.push({ repoDir, s, pid, external: !!s.handle!.external }); // pid was read from s.handle
  }
  if (!roots.length) return;
  const rss = devServer.treeRssMb(roots.map((r) => r.pid));
  for (const r of roots) {
    const mb = rss.get(r.pid) || 0;
    if (mb <= DEV_MEM_LIMIT_MB) continue;
    const gb = (mb / 1024).toFixed(1);
    if (r.external) {
      // Not ours to kill — warn loudly and leave it to the terminal that owns it.
      devLog(r.repoDir, r.s.project.name, `[radial] your dev server (started outside Radial) is using ${gb} GB. That's usually a build-tool bug. Consider restarting it from its own terminal before it destabilizes this machine.`);
      continue;
    }
    const now = Date.now();
    r.s.memRestarts = (r.s.memRestarts || []).filter((t: number) => now - t < devMemory.QUIET_MS);
    const action = devMemory.decide({ mb, limit: DEV_MEM_LIMIT_MB, restarts: r.s.memRestarts, now });
    if (action === 'wait') continue;
    if (action === 'restart') {
      r.s.memRestarts.push(now);
      devLog(r.repoDir, r.s.project.name, `[radial] the dev server was using ${gb} GB, so Radial restarted it to free the memory.`);
      send('dev:memory-restarted', { repoDir: r.repoDir, gb });
      telemetry.capture('dev_server_memory_restarted');
      restartDevServer(r.repoDir, { via: 'memory' }).catch(() => {});
      continue;
    }
    devLog(r.repoDir, r.s.project.name, `[radial] the dev server climbed past ${gb} GB again right after two restarts, so it was stopped to protect this machine. That usually means a bug in the project's build tool. Wake the project to start it again (its tab in the app, or \`radial wake\`).`);
    if (r.s.handle) r.s.handle.stopped = true; // the crash-healer must not resurrect it
    try { devServer.reapGroup(r.pid); } catch {}
    devPids.clear(r.repoDir);
    try { devServer.clearDevInfo(r.repoDir); } catch {}
    r.s.handle = null;
    r.s.suspended = true;
    send('session:suspended', { repoDir: r.repoDir });
    send('dev:memory-stopped', { repoDir: r.repoDir, gb });
    telemetry.capture('dev_server_memory_stopped');
  }
}

export async function checkIdle(): Promise<void> {
  const now = Date.now();
  const { idleSleepMs, parkAgents } = options();
  for (const [repoDir, s] of sessions) {
    if (repoDir === activeRepoDir) continue; // never touch the project in front of the user
    // Already-sleeping projects: sweep up agents that went idle AFTER the
    // project slept (they were mid-task at sleep time and have since finished).
    if (s.suspended) { if (parkAgents) reapIdleAgents(repoDir).catch(() => {}); continue; }
    if (!s.handle) continue;
    if (idleSleepMs != null && now - (s.lastActive || now) > idleSleepMs) await suspendSession(repoDir);
  }
}

// Adopted (external) servers have no child process to watch, so the crash
// healer can't see them die. Poll on the same minute tick: a vanished pid
// means the preview is orphaned — or worse, a DIFFERENT process now answers
// on that port (e.g. `astro preview` serving a stale build) while dev.json
// still vouches for it. Resume cleanly: re-adopt a live dev server if one
// exists, otherwise start our own.
export async function checkExternalServers(): Promise<void> {
  for (const [repoDir, s] of sessions) {
    const h = s.handle;
    if (!h || !h.external || s.suspended) continue;
    let alive = false;
    try { process.kill(h.pid, 0); alive = true; } catch {}
    if (alive) continue;
    devLog(repoDir, s.project.name, `[radial] the dev server you were running (pid ${h.pid}) has exited; getting the preview a live server…`);
    try { devServer.clearDevInfo(repoDir); } catch {}
    s.handle = null;
    s.suspended = true;
    try {
      await resumeSession(repoDir);
    } catch (e) {
      devLog(repoDir, s.project.name, `[radial] couldn’t restart the preview: ${(e && (e as Error).message) || e}. Wake the project to try again (its tab in the app, or \`radial wake\`).`);
      send('session:suspended', { repoDir });
    }
  }
}

// --- dev-server crash healing ----------------------------------------------
// A dev server can die AFTER it was ready (OOM, framework crash, killed from
// outside). Nothing else notices: the session keeps the dead handle and the
// preview silently shows its last render, so fresh edits "don't show up".
// Watch each server's child; when it exits without stop() having been called,
// restart it (policy in devHeal.js) and repoint the preview via the normal
// resume path. Static servers run in-process and have no child to watch.
function watchDevServer(repoDir: string): void {
  const s = sessions.get(repoDir);
  const handle = s && s.handle;
  const child = handle && handle.child;
  if (!child) return;
  const onExit = () => setTimeout(() => healDevServer(repoDir, handle), 500);
  // The child may already be gone by the time we attach (crash right after ready).
  if (child.exitCode !== null || child.signalCode) onExit();
  else child.once('exit', onExit);
}

async function healDevServer(repoDir: string, deadHandle: import('../main/devServer').DevServerHandle): Promise<void> {
  const s = sessions.get(repoDir);
  const { action, heals } = devHeal.decide({ session: s, deadHandle, now: Date.now() });
  if (action === 'ignore') return; // decide answers 'ignore' when there is no session, so the `s!` below hold
  s!.heals = heals;
  // The crash bypassed stop(), so dev.json still advertises the dead port —
  // erase it now so agents see "not running" instead of a URL that refuses.
  devPids.clear(repoDir);
  try { devServer.clearDevInfo(repoDir); } catch {}
  s!.handle = null;
  s!.suspended = true; // resumeSession() is the one sanctioned way back up
  if (action === 'give-up') {
    devLog(repoDir, s!.project.name, '[radial] the dev server keeps crashing, so it has been left stopped. Its crash output is above; wake the project to try again (its tab in the app, or `radial wake`).');
    send('session:suspended', { repoDir });
    return;
  }
  devLog(repoDir, s!.project.name, '[radial] the dev server exited unexpectedly; restarting it…');
  try {
    await resumeSession(repoDir); // sends session:resumed with the fresh URL
  } catch (e) {
    devLog(repoDir, s!.project.name, `[radial] restart failed: ${(e && (e as Error).message) || e}. Wake the project to try again (its tab in the app, or \`radial wake\`).`);
    send('session:suspended', { repoDir });
  }
}

// --- agent-requested restarts ----------------------------------------------
// Vite/Astro HMR can wedge: the server answers, but keeps serving pre-edit CSS
// until restarted. When an agent detects that (served output ≠ disk), it asks
// for a clean restart by touching .radial/restart-dev-server (contract in
// restartRequests.js + the shared preview notes) instead of killing processes.
const restartWatchers = new Map<string, () => void>(); // repoDir -> disposer

function watchRestartRequests(repoDir: string): void {
  if (restartWatchers.has(repoDir)) return;
  restartWatchers.set(repoDir, restartRequests.watch(repoDir, () => restartDevServer(repoDir, { via: 'agent' })));
}
function unwatchRestartRequests(repoDir: string): void {
  const dispose = restartWatchers.get(repoDir);
  restartWatchers.delete(repoDir);
  if (dispose) { try { dispose(); } catch {} }
}

// Agent state files (plans/agent-state-files.md): agents ask for a launch-check
// rescan by touching .radial/run-launch-check, and external edits to
// .radial/comments.json (an agent flipping `resolved`) mirror back into the UI.
// Same poll transport as restart requests — fs.watch on .radial/ is
// undeliverable on macOS (see restartRequests.js).
const agentFileWatchers = new Map<string, (() => void)[]>(); // repoDir -> disposer[]

// ── Vercel Toolbar comments (vercelComments.js) ─────────────────────────────
// Pulled into .radial/comments.json while a linked project is open: every 3
// minutes with the window in front, every 15 in the background, on demand from
// the Comments pane or `radial comments pull`, and once right after the project
// opens. Resolved-here comments reach Vercel after a publish. The Vercel CLI is
// the user's own (their `vercel login`); no Radial credentials, no agent.
export const VC_POLL_MS = 3 * 60 * 1000, VC_BLURRED_MS = 15 * 60 * 1000, VC_BACKOFF_MS = 30 * 60 * 1000;
export const vcState = new Map<string, VercelCommentSync>(); // repoDir -> { running: Promise|null, lastAt, lastResult, nextAt }
let vcUnsupportedCli = false; // this run saw a CLI without `comments`; a manual pull probes again
function vcScopeFor(repoDir: string) {
  const st = projectState.get(repoDir);
  const link = vercel.readLink(repoDir);
  return { linked: !!link.linked, scope: (st && st.vercel && st.vercel.scope) || undefined, orgId: link.orgId || undefined };
}
export function vcStatus(repoDir: string): RadialIpc.VercelCommentsStatus {
  const s: VercelCommentSync = vcState.get(repoDir) || {};
  return { linked: vercel.readLink(repoDir).linked === true, cli: vercel.hasCli(), running: !!s.running, lastAt: s.lastAt || 0, result: s.lastResult || null };
}
// The listening check first: vcStatus reads the link file and looks for the CLI, only worth it for a viewer to show.
function notifyVercelComments(repoDir: string): void { if (events().listening()) send('comments:vercel', { repoDir, status: vcStatus(repoDir) }); }
const vcRun: import('../main/vercelComments').VercelCliRun = (args, o) => vercel.run(args, { ...(o || {}), timeout: 90000 });
export async function pullVercelComments(repoDir: string, { manual = false }: { manual?: boolean } = {}): Promise<RadialIpc.VercelPullResult> {
  const s: VercelCommentSync = vcState.get(repoDir) || {}; vcState.set(repoDir, s);
  if (s.running) return s.running;
  const { linked, scope, orgId } = vcScopeFor(repoDir);
  if (!linked) return { ok: false, code: 'not-linked', error: 'This folder is not linked to a Vercel project (vercel link).' };
  if (!vercel.hasCli()) return { ok: false, code: 'no-cli', error: 'Vercel comments need the Vercel CLI (npm i -g vercel).' };
  if (vcUnsupportedCli && !manual) return { ok: false, code: 'unsupported-cli', error: 'Vercel comments need the Vercel CLI 59.1 or newer (npm i -g vercel@latest).' };
  s.running = (async () => {
    notifyVercelComments(repoDir);
    let r: import('../main/vercelComments').VercelPullOutcome;
    try { r = await vercelComments.pull(repoDir, { run: vcRun, scope, orgId, fetchImpl: globalThis.fetch }); }
    catch (e) { r = { ok: false, code: 'error', error: ((e as Error) && (e as Error).message) || String(e) }; }
    s.running = null; s.lastAt = Date.now(); s.lastResult = r;
    vcUnsupportedCli = r.code === 'unsupported-cli';
    s.nextAt = Date.now() + (r.ok ? VC_POLL_MS : VC_BACKOFF_MS);
    if (r.ok && r.changed) notifyCommentsChanged(repoDir);
    notifyVercelComments(repoDir);
    return r;
  })();
  return s.running;
}
// After a publish: mirror Radial-side resolves to Vercel with the pushed commit
// in the closing note. Fire and forget; a failure stays pending for next time.
export function vercelResolveAfterPublish(repoDir: string): void {
  try {
    const { linked, scope, orgId } = vcScopeFor(repoDir);
    if (!linked || !vercel.hasCli() || vcUnsupportedCli) return;
    if (!vercelComments.pendingResolves(repoDir).length) return;
    publish.git(repoDir, ['rev-parse', '--short', 'HEAD']).catch(() => '')
      .then((sha: string) => vercelComments.resolvePushed(repoDir, { run: vcRun, scope, orgId, sha: String(sha || '').trim() }))
      .then((r: import('../main/vercelComments').VercelResolveResult) => { if (r && r.done) notifyCommentsChanged(repoDir); })
      .catch(() => {});
  } catch {}
}

function watchAgentStateFiles(repoDir: string): void {
  if (agentFileWatchers.has(repoDir)) return;
  const disposers: (() => void)[] = [];
  if (vercel.readLink(repoDir).linked) {
    const first = setTimeout(() => pullVercelComments(repoDir).catch(() => {}), 4000);
    const poll = setInterval(() => {
      const s: VercelCommentSync = vcState.get(repoDir) || {};
      const focused = viewer()?.focused() ?? false;
      if (s.running || Date.now() < (s.nextAt || 0)) return;
      if (Date.now() - (s.lastAt || 0) < (focused ? VC_POLL_MS : VC_BLURRED_MS)) return;
      pullVercelComments(repoDir).catch(() => {});
    }, 30000);
    if (first.unref) first.unref();
    if (poll.unref) poll.unref();
    disposers.push(() => { clearTimeout(first); clearInterval(poll); });
  }
  disposers.push(restartRequests.watch(repoDir, async () => {
    const report = await runLaunchCheck(repoDir, 'agent');
    send('launchCheck:done', { repoDir, report });
  }, undefined, 'run-launch-check'));
  // comments.json change signal: mtime+size signature per poll. Radial's own
  // saves fire it too — the renderer refresh is idempotent, so provenance
  // tracking isn't worth the bookkeeping.
  const cf = projectData.dataDir(repoDir, 'comments.json');
  const readSig = () => { try { const st = fs.statSync(cf); return st.mtimeMs + ':' + st.size; } catch { return null; } };
  let sig = readSig();
  const contextSignatures = () => {
    if (!projectData.isLocal(repoDir)) return '';
    const files = [projectMemory.agentsPath(repoDir), ...context.list(repoDir).map((f: RadialIpc.ContextFile) => f.abs)];
    return files.map(file => { try { const st = fs.statSync(file); return file + ':' + st.mtimeMs + ':' + st.size; } catch { return file; } }).join('|');
  };
  let contextSig = contextSignatures();
  let contextCheckedAt = 0;
  const timer = setInterval(() => {
    if (repoDir === activeRepoDir && viewer()?.focused() && Date.now() - contextCheckedAt >= 2000) {
      contextCheckedAt = Date.now();
      const nextContext = contextSignatures();
      if (nextContext !== contextSig) {
        contextSig = nextContext;
        send('context:changed', { repoDir });
      }
    }
    const next = readSig();
    if (next === sig) return;
    sig = next;
    send('comments:changed', { repoDir });
  }, 1000);
  if (timer.unref) timer.unref();
  disposers.push(() => clearInterval(timer));
  agentFileWatchers.set(repoDir, disposers);
}

function unwatchAgentStateFiles(repoDir: string): void {
  const ds = agentFileWatchers.get(repoDir);
  agentFileWatchers.delete(repoDir);
  for (const d of ds || []) { try { d(); } catch {} }
}

// A clean dev-server restart: fresh port, dev.json republished, the preview
// repointed (all through resumeSession). Reached from the project's rail menu,
// `radial restart`, and the agent touch-file channel. Says what happened so the
// caller can: { ok, url } or { ok: false, reason: not-open|external|start-failed }.
export async function restartDevServer(repoDir: string, { via = 'app' }: RadialIpc.DevRestartOptions = {}): Promise<RadialIpc.DevRestartResult> {
  const s = sessions.get(repoDir);
  if (!s) return { ok: false, reason: 'not-open' };
  if (s.handle && s.handle.external) {
    devLog(repoDir, s.project.name, '[radial] restart requested, but the preview uses YOUR dev server (started outside Radial). Restart it from the terminal where you started it.');
    return { ok: false, reason: 'external' };
  }
  const why = via === 'agent' ? 'an agent asked through .radial/restart-dev-server' : via === 'cli' ? 'radial restart' : via === 'menu' ? 'the project menu' : via === 'memory' ? 'it went over the memory limit' : 'the app';
  devLog(repoDir, s.project.name, `[radial] restarting the dev server (${why})…`);
  if (s.handle) { try { await s.handle.stop(); } catch {} } // marks it stopped → the crash-healer ignores this exit
  devPids.clear(repoDir);
  s.handle = null;
  s.suspended = true; // resume is the one sanctioned way back up (coalesced, republishes dev.json, repoints the preview)
  try {
    const url = await resumeSession(repoDir);
    return { ok: true, url };
  } catch (e) {
    devLog(repoDir, s.project.name, `[radial] restart failed: ${(e && (e as Error).message) || e}. Wake the project to try again (its tab in the app, or \`radial wake\`).`);
    send('session:suspended', { repoDir });
    return { ok: false, reason: 'start-failed', error: ((e as Error) && (e as Error).message) || String(e) };
  }
}


// Production base URL for the site — used to make OG/social image links absolute
// (crawlers require absolute URLs). Order: explicit .radial.json siteUrl, then
// common framework config (Astro `site:`, Next `metadataBase`).
function detectSiteUrl(repoDir: string): string | null {
  for (const name of ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.cjs']) {
    const p = path.join(repoDir, name);
    if (fs.existsSync(p)) {
      const m = fs.readFileSync(p, 'utf8').match(/site\s*:\s*['"]([^'"]+)['"]/);
      if (m) return m[1].replace(/\/$/, '');
    }
  }
  for (const name of ['next.config.js', 'next.config.mjs', 'next.config.ts']) {
    const p = path.join(repoDir, name);
    if (fs.existsSync(p)) {
      const m = fs.readFileSync(p, 'utf8').match(/metadataBase[^'"`]*['"`]([^'"`]+)['"`]/);
      if (m) return m[1].replace(/\/$/, '');
    }
  }
  return null;
}

export function getSiteUrl(repoDir: string): string | null {
  const cfg = publish.readConfig(repoDir);
  return (cfg.siteUrl || detectSiteUrl(repoDir) || '').replace(/\/$/, '') || null;
}

// Before starting a dev server, reap any prior one *we* started for this repo
// that's still alive (a hard crash / force-quit can leave one orphaned). We
// verify the pid is still a dev process so a reused pid is never killed.
function reapStaleDevServer(repoDir: string): void {
  const rec = devPids.get(repoDir);
  if (rec && rec.pid) { try { devServer.reapGroup(rec.pid); } catch {} }
  devPids.clear(repoDir);
  // A crash skips the handle's stop() wrapper, so the published preview URL
  // (.radial/dev.json) can survive the server it described. Erase it here —
  // start() republishes the fresh one moments later.
  try { devServer.clearDevInfo(repoDir); } catch {}
}

// Global sweep at startup: reap EVERY dev server we recorded that's still alive.
// Normal teardown clears records on clean stop, so anything left here is an
// orphan from a crash, force-quit, or a dev hot-reload — the source of ports
// piling up over time. reapGroup kills the whole group (catching a child that
// outlived its leader) and is pid-reuse-safe. Runs once, on boot.
// Only servers a PREVIOUS run recorded. This sweep runs 2.5s after launch, and
// by then a fast project may already have started (and recorded) its server.
const BOOT_AT = Date.now();
export function reapAllOrphans(): void {
  const stale = devPids.entries().filter((e: import('../main/devPids').DevPidEntry) => e.at < BOOT_AT);
  try { devServer.reapGroups(stale.map((e: import('../main/devPids').DevPidEntry) => e.pid)); } catch {}
  for (const e of stale) { try { devServer.clearDevInfo(e.repoDir); } catch {} devPids.clear(e.repoDir); }
}
// Treat a pid as ours if we recorded it, OR if it's a member of a process group
// we started — a leftover server (e.g. `next-server`) reports its own pid, which
// differs from the group-leader pid we recorded but shares its pgid.
const ownsPid: import('../main/devServer').OwnsPid = (pid) => {
  const ours = devPids.allPids();
  if (ours.has(pid)) return true;
  const g = devServer.pidGroup(pid);
  return g != null && ours.has(g);
};

// --- preview build-error detection ---------------------------------------
// Parse dev-server output for compile/build errors that blank the preview, so
// the renderer can offer a one-click agent fix. Cleared when it compiles again.
const buildErr = new Map<string, BuildErrorWatch>(); // repoDir -> { active, buf, timer }
const BUILD_ERR_RE = /(Failed to compile|Module not found|Cannot find module|Type error:|SyntaxError|Unhandled Runtime Error|^\s*⨯ )/i;
const BUILD_OK_RE = /(compiled\s+(?:client and server\s+)?successfully|✓\s*Compiled|compiled in \d|✓ Ready|Ready in )/i;
function devLog(repoDir: string, name: string, line: string): void {
  send('log', `[${name}] ${line}`);
  const st: BuildErrorWatch = buildErr.get(repoDir) || { active: false, buf: [], timer: null };
  if (BUILD_OK_RE.test(line)) {
    if (st.active) { st.active = false; st.buf = []; clearTimeout(st.timer as NodeJS.Timeout | undefined); send('radial:build-error-cleared', { repoDir }); } // null is a no-op; @types/node leaves it out
    buildErr.set(repoDir, st);
    return;
  }
  if (BUILD_ERR_RE.test(line) || (st.active && line.trim())) {
    st.active = true;
    st.buf.push(line.replace(/\s+$/, ''));
    if (st.buf.length > 14) st.buf.shift();
    clearTimeout(st.timer as NodeJS.Timeout | undefined);
    st.timer = setTimeout(() => send('radial:build-error', { repoDir, message: st.buf.join('\n').trim() }), 500);
    buildErr.set(repoDir, st);
  }
}

export async function openRepo(repoDir: string, { cold = false }: RadialIpc.OpenProjectOptions = {}): Promise<RadialIpc.OpenProjectResult> {
  if (!repoDir || !fs.existsSync(repoDir)) return { ok: false, error: 'Folder not found.' };

  // Already open? Just hand back its existing session (the renderer will focus it).
  if (sessions.has(repoDir)) {
    const s = sessions.get(repoDir)!;
    if (s.suspended && !cold) { try { await resumeSession(repoDir); } catch {} }
    const pages = project.listPages(repoDir, s.project);
    const status = await publish.status(repoDir);
    return { ok: true, already: true, url: s.handle ? s.handle.url : null, suspended: !!s.suspended, project: s.project, pages, status, config: s.config, repoDir, ...projectPreviewState(repoDir) };
  }

  // Not open yet — start it. Coalesce concurrent opens of the same project onto
  // one start (see coalesce.js): the `sessions` guard above isn't set until the
  // dev server finishes booting, so without this each racing call would spawn its
  // own dev server and the extras would leak as untracked, CPU-pinned orphans.
  return coalesceOpen(repoDir, () => inTurn(repoDir, () => (cold ? startRepoCold(repoDir) : startRepo(repoDir))))
    .catch((error: Error) => ({ ok: false, error: error.message }));
}

// Open a project ASLEEP: session + watchers only, no dev server and none of the
// open prep (branch switch, migrations, history) — that all runs on first wake
// (doResumeSession). This is how a restored session boots: ten open projects
// cost nothing until one is used. The agent-facing watchers DO start, so a
// still-working agent (which survives quit in the PTY daemon) can wake the
// project itself by touching .radial/restart-dev-server.
async function activateProjectStorage(repoDir: string): Promise<void> {
  const pending = projectData.status(repoDir).pending;
  const live = pending ? await terminal.list(repoDir) : [];
  projectData.activate(repoDir, { defer: live.some((t: PtyInfo) => t.alive !== false) });
}

function projectPreviewState(repoDir: string): Pick<RadialIpc.OpenedProject, 'previewMode' | 'sharedPreview'> {
  const saved = projectState.get(repoDir);
  return { previewMode: saved.previewMode === 'shared' ? 'shared' : 'agent', sharedPreview: saved.sharedPreview || null };
}

async function startRepoCold(repoDir: string): Promise<RadialIpc.OpenProjectResult> {
  await activateProjectStorage(repoDir);
  const detected = devServer.detectProject(repoDir);
  if (detected.type === 'unknown') {
    return { ok: false, error: 'Could not detect a website here (no dev script and no index.html).' };
  }
  const config = publish.readConfig(repoDir);
  config.siteUrl = getSiteUrl(repoDir);
  sessions.set(repoDir, { handle: null, project: detected, config, suspended: true, cold: true, lastActive: Date.now() });
  watchRestartRequests(repoDir);
  startMomentWatcher(repoDir); // agent/outside edits still make History moments while asleep
  watchAgentStateFiles(repoDir);
  const pages = project.listPages(repoDir, detected);
  const status = await publish.status(repoDir);
  return {
    ok: true, url: null, suspended: true, project: detected, pages, status, config, repoDir,
    sleptAgents: projectState.get(repoDir).sleptAgents || [],
    ...projectPreviewState(repoDir),
    // A sleeping tab has no preview to learn these from — restore the last
    // known look so the rail row is accurate before first wake.
    favicon: recents.faviconFor(repoDir),
    pageTitle: projectState.get(repoDir).pageTitle || null,
  };
}

async function startRepo(repoDir: string): Promise<RadialIpc.OpenProjectResult> {
  await activateProjectStorage(repoDir);
  const detected = devServer.detectProject(repoDir);
  if (detected.type === 'unknown') {
    return { ok: false, error: 'Could not detect a website here (no dev script and no index.html).' };
  }

  const config = publish.readConfig(repoDir);
  config.siteUrl = getSiteUrl(repoDir);
  loadHistory(repoDir); // restore the undo/redo stacks so Undo works after a restart

  // vNext branch model: opening never switches branches — you work on whatever
  // the repo is on (git itself remembers). Staging is a publish TARGET; the
  // snapshot-and-push happens in publish(), not here.
  // Migrate the project's Radial files to the current layout: context → committed
  // `.context/`, and the local-only working data (`.radial/`, `.radial.json`)
  // gitignored + untracked. Idempotent; also cleans repos that previously
  // committed these so they stop reading messy.
  try { await context.migrate(repoDir, publish.git, { commitConfig: config.commitConfig }); } catch {}
  // If project memory (AGENTS.md) exists, make sure it's never deployed — and
  // that it tells agents where the live preview URL lives (.radial/dev.json),
  // since Codex/Cursor read AGENTS.md rather than a Radial-seeded prompt.
  try {
    if (projectMemory.exists(repoDir)) {
      projectMemory.excludeFromDeploy(repoDir);
      projectMemory.ensurePreviewNote(repoDir);
      projectMemory.ensureStateFilesNote(repoDir);
      projectMemory.ensureCliNote(repoDir);
    }
  } catch {}

  reapStaleDevServer(repoDir); // clear out a crashed-session orphan first
  try {
    const handle = await devServer.start(repoDir, {
      onLog: (line: string) => devLog(repoDir, detected.name, line),
      onStatus: (text: string) => send('loading-status', text),
      onChanged: () => notifyStaticChanged(repoDir),
      timeoutMs: 180000, // first-run installs can be slow
      ownsPid,
    });
    if (handle.child) devPids.set(repoDir, handle.child.pid);
    sessions.set(repoDir, { handle, project: handle.project, config, suspended: false, lastActive: Date.now() });
    watchDevServer(repoDir);
    watchRestartRequests(repoDir);
    startMomentWatcher(repoDir); // version history for terminal-agent + outside edits
    watchAgentStateFiles(repoDir);
    // Degraded-watcher notice: when the OS stops delivering file events
    // (wedged fseventsd — hot reload silently dead machine-wide), say so
    // instead of letting "edits don't show up" look like a Radial bug, and
    // let the renderer switch to restart-after-edits mode.
    watcherHealth.check().then(async (ok: boolean) => {
      if (ok) return;
      devLog(repoDir, handle.project.name, '[radial] macOS file-watching is not delivering events (this happens after long uptimes; a reboot fixes it). Hot reload won\'t work; Radial will refresh the preview after each agent edit instead.');
      send('watcher:degraded', { repoDir });
      // If this boot ADOPTED the user's server before the verdict landed, swap
      // to a Radial-owned one now — degraded mode can only restart what it
      // owns. (start() skips adoption while wedged, so the resume re-lands on
      // an owned server; Next is the exception and keeps the adopted one.)
      const s = sessions.get(repoDir);
      if (s && s.handle && s.handle.external && (s.handle.project || {}).framework !== 'next') {
        devLog(repoDir, handle.project.name, '[radial] switching the preview to a Radial-owned dev server so it can be refreshed automatically. Your own server keeps running untouched.');
        try { await s.handle.stop(); } catch {} // no-op for external, but marks it stopped
        s.handle = null;
        s.suspended = true;
        try { await resumeSession(repoDir); } catch {}
      }
    });
    activeRepoDir = repoDir;
    recents.addRecent(repoDir, handle.project.name);
    platform().recentsChanged?.(); // refresh Open Recent
    const pages = project.listPages(repoDir, handle.project);
    const status = await publish.status(repoDir);
    telemetry.capture('project_opened');
    return {
      ok: true, url: handle.url, project: handle.project, pages, status, config, repoDir,
      sleptAgents: projectState.get(repoDir).sleptAgents || [],
      ...projectPreviewState(repoDir),
      // Last known look, so the rail/tab don't flash the package name and a
      // blank favicon during the seconds before the preview reports in.
      favicon: recents.faviconFor(repoDir),
      pageTitle: projectState.get(repoDir).pageTitle || null,
    };
  } catch (e) {
    histories.delete(repoDir);
    if (e && (e as NodeJS.ErrnoException).code === devServer.NODE_NOT_FOUND) {
      // reason lets the renderer offer the one-click userland Node install
      // (tools:install) instead of sending the user to a download page.
      return { ok: false, reason: 'node-missing', error: 'Node.js wasn’t found. Radial needs Node to run this project.' };
    }
    return { ok: false, error: (e as Error).message };
  }
}


// After a sync / branch switch the project can change shape (e.g. a static site
// became a Next.js app). Re-detect; if the type/framework/dev-script changed,
// restart the dev server so the preview + page list aren't stale.
export async function refreshProject(repoDir: string, { forceRestart = false }: NonNullable<ArgTo<'projectRefresh', 1>> = {}): Promise<RadialIpc.RefreshProjectResult> {
  const s = sessions.get(repoDir);
  if (!s) return { ok: false, reason: 'not-open' };
  let detected: LooseUnion<RadialIpc.DetectedProject> | null = null;
  try { detected = devServer.detectProject(repoDir); } catch {}
  if (!detected || detected.type === 'unknown') return { ok: false, reason: 'unknown' };
  const cur: LooseUnion<RadialIpc.RunnableProject> = s.project || {};
  // forceRestart: a branch switch rewrites many files at once — exactly where
  // file-watchers drop events, leaving the dev server compiled against the OLD
  // branch. A clean restart is deterministic; trusting HMR across a checkout
  // is not.
  const changed = forceRestart || detected.type !== cur.type || detected.framework !== cur.framework || detected.devScript !== cur.devScript;
  if (!changed) {
    return { ok: true, restarted: false, project: cur, url: s.handle && s.handle.url, pages: project.listPages(repoDir, cur) };
  }
  // s.handle is null while the project sleeps, and the dev-memory pill's 'Start again' (or a branch switch after a crash give-up) force-restarts a sleeping project: the `!` is knowingly loose, the catch swallows the TypeError.
  try { await s.handle!.stop(); } catch {}
  devPids.clear(repoDir);
  reapStaleDevServer(repoDir);
  try {
    const handle = await devServer.start(repoDir, {
      onLog: (line: string) => devLog(repoDir, detected.name, line),
      onStatus: (text: string) => send('loading-status', text),
      onChanged: () => notifyStaticChanged(repoDir),
      timeoutMs: 180000, // a fresh framework may need to install first
      ownsPid,
    });
    if (handle.child) devPids.set(repoDir, handle.child.pid);
    s.handle = handle; s.project = handle.project; s.suspended = false;
    watchDevServer(repoDir);
    return { ok: true, restarted: true, project: handle.project, url: handle.url, pages: project.listPages(repoDir, handle.project) };
  } catch (e) {
    return { ok: false, reason: 'start-failed', error: ((e as Error) && (e as Error).message) || String(e) };
  }
}

// Pre-launch checklist: deterministic readiness checks over the running preview.
// launchCheck:get returns the last cached report; run scans live and caches it.
// Shared by the Launch pane button and the agent's .radial/run-launch-check
// request; every report — including failures — mirrors to the agent-facing
// .radial/launch-check.json so whoever asked can read the outcome.
export async function runLaunchCheck(repoDir: string, source: 'ui' | 'agent'): Promise<RadialIpc.LaunchCheckReport> {
  const s = sessions.get(repoDir);
  const url = s && s.handle && s.handle.url;
  let report: RadialIpc.LaunchCheckReport;
  if (!url) {
    report = { ok: false, error: 'Open the project first. The dev server must be running to scan its pages.', scannedAt: Date.now() };
  } else {
    try {
      const pages = project.listPages(repoDir, s.project);
      report = { ok: true, ...(await launchCheck.scan(url, pages)) };
      try { projectState.set(repoDir, { launchCheck: report }); } catch {}
      telemetry.capture('launch_check_run', { issue_count: (report.counts.fail || 0) + (report.counts.warn || 0), source: source || 'ui' });
    } catch (e) {
      report = { ok: false, error: String((e && (e as Error).message) || e), scannedAt: Date.now() };
    }
  }
  try { launchCheck.persist(repoDir, report); } catch {}
  return report;
}

// session:setActive: the window's tab switch.
export async function setActive(repoDir: ArgTo<'setActive', 0>): Promise<AnswerTo<'setActive'>> {
  // The tab we're leaving starts its idle clock now.
  if (activeRepoDir && sessions.has(activeRepoDir)) sessions.get(activeRepoDir)!.lastActive = Date.now();
  if (!sessions.has(repoDir)) return { ok: false };
  activeRepoDir = repoDir;
  const s = sessions.get(repoDir)!;
  s.lastActive = Date.now();
  if (s.suspended) {
    try { const url = await resumeSession(repoDir); return { ok: true, resumed: true, url }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  }
  return { ok: true, resumed: false, url: s.handle!.url }; // every path that clears a session's handle also marks it suspended
}

// `radial wake`: the project comes forward, waking if it sleeps.
export async function wake(dir: string): ReturnType<CliApi['wake']> {
  const s = sessions.get(dir);
  if (!s) return { ok: false, code: 'not-open', error: `${dir} is not open.` };
  if (activeRepoDir && sessions.has(activeRepoDir)) sessions.get(activeRepoDir)!.lastActive = Date.now();
  activeRepoDir = dir; s.lastActive = Date.now();
  if (s.suspended) { try { const url = await resumeSession(dir); return { state: 'running', url }; } catch (e) { return { ok: false, code: 'error', error: (e as Error).message }; } }
  return { state: 'running', url: s.handle!.url }; // awake: it has a server
}

/** Where a project's preview runs right now, for a browser on it: its URL and name, or why there's none. */
export type PreviewNow = { ok: true; url: string; name: string } | { ok: false; code: 'not-open' | 'no-dev-server'; error: string };
/**
 * A project's preview as it runs now (radial serve's browser, src/headless/page.ts,
 * opens its page here): not dev.json's last URL, which outlives a sleep.
 */
export function previewNow(repoDir: string): PreviewNow {
  const s = sessions.get(repoDir);
  if (!s) return { ok: false, code: 'not-open', error: `${repoDir} is not open. Run \`radial open ${repoDir}\` first.` };
  if (s.suspended || !s.handle || !s.handle.url) return { ok: false, code: 'no-dev-server', error: `${repoDir} is asleep; wake it first (radial wake).` };
  return { ok: true, url: s.handle.url, name: (s.project && s.project.name) || path.basename(repoDir) };
}

/** The open projects' folders (radial serve's preview proxies follow them). */
export function openProjects(): string[] { return [...sessions.keys()]; }
/** Someone used a project's preview without an API call (a browser on radial serve's preview proxy): its idle clock starts again. */
export function markUsed(repoDir: string): void { const s = sessions.get(repoDir); if (s) s.lastActive = Date.now(); }

// ── For the window ──
/** Whether a project is open (nativeChat:restore checks before resuming its chats). */
export function isOpen(repoDir: string): boolean { return sessions.has(repoDir); }

// The window came forward: pull each open project's Vercel comments that are due.
export function pullVercelCommentsOnFocus(): void {
  for (const [dir] of sessions) {
    const s = vcState.get(dir);
    if (s && !s.running && Date.now() >= (s.nextAt || 0) && Date.now() - (s.lastAt || 0) >= VC_POLL_MS) pullVercelComments(dir).catch(() => {});
  }
}

// The Home dashboard's activity: the open projects and their dev servers, with
// the agents the window lists (its terminals, and its chats as rows).
export function activitySnapshot(agents: Parameters<typeof import('../main/workspaceActivity').snapshot>[0]['agents']): ReturnType<typeof import('../main/workspaceActivity').snapshot> {
  return (require('../main/workspaceActivity') as typeof import('../main/workspaceActivity')).snapshot({ sessions, agents, recents: recents.listRecents(), pid: process.pid });
}

// Move a project's working copy to a user-chosen folder, with every
// path-keyed store following (recents, session, chats/drafts, dev-server
// bookkeeping). This is the escape hatch for the duplicate-clone problem:
// projects cloned into ~/radial can be relocated to wherever the user
// actually keeps their code, without losing Radial state. pickFolder is the
// window's folder picker (null when cancelled).
export async function moveProject(repoDir: ArgTo<'moveProject', 0>, pickFolder: () => Promise<string | null>): Promise<AnswerTo<'moveProject'>> {
  const s = sessions.get(repoDir);
  if (s && s.handle && !s.suspended) return { ok: false, error: 'Close the project before moving it.' };
  const folder = await pickFolder();
  if (!folder) return { ok: false, cancelled: true };
  const dest = path.join(folder, path.basename(repoDir));
  if (dest === repoDir) return { ok: false, cancelled: true };
  if (repoDir.startsWith(dest + path.sep) || dest.startsWith(repoDir + path.sep)) {
    return { ok: false, error: 'That folder is inside the project itself.' };
  }
  if (fs.existsSync(dest)) return { ok: false, error: `${dest} already exists.` };
  try {
    projectData.checkMove(repoDir, dest);
    try { fs.renameSync(repoDir, dest); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e; // different volume: copy + delete
      fs.cpSync(repoDir, dest, { recursive: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  } catch (e) {
    return { ok: false, error: `Move failed: ${(e as Error).message}` };
  }
  recents.rekey(repoDir, dest);
  projectState.rekey(repoDir, dest);
  projectData.rekey(repoDir, dest);
  devPids.rekey(repoDir, dest);
  sessions.delete(repoDir);
  histories.delete(repoDir);
  return { ok: true, newDir: dest };
}

// ── Project config, as the window's settings change it ──
export async function listPages(repoDir: ArgTo<'getPages', 0>): Promise<AnswerTo<'getPages'>> {
  const s = sessions.get(repoDir);
  if (!s) return [];
  return project.listPages(repoDir, s.project);
}
// Persist branch/policy to .radial.json and (optionally) point origin at a URL.
export async function configSet(repoDir: ArgTo<'configSet', 0>, config: ArgTo<'configSet', 1>, remote: ArgTo<'configSet', 2>): Promise<AnswerTo<'configSet'>> {
  try {
    const merged = config ? publish.writeConfig(repoDir, config) : publish.readConfig(repoDir);
    let savedRemote: string | null;
    if (typeof remote === 'string' && remote.trim()) savedRemote = await publish.setRemote(repoDir, remote.trim());
    else savedRemote = await publish.getRemote(repoDir);
    const s = sessions.get(repoDir);
    if (s) s.config = merged; // so the open session publishes with the new settings
    return { ok: true, config: merged, remote: savedRemote };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
// Mark pages as "draft" (hidden from the live site): store routes in .radial.json
// and exclude their source files from the Vercel deploy via .vercelignore.
export async function setHiddenPages(repoDir: ArgTo<'pagesSetHidden', 0>, routes: ArgTo<'pagesSetHidden', 1>, files: ArgTo<'pagesSetHidden', 2>): Promise<AnswerTo<'pagesSetHidden'>> {
  const merged = publish.writeConfig(repoDir, { hiddenPages: Array.isArray(routes) ? routes : [] });
  try { publish.writeHiddenPagesIgnore(repoDir, (files || []).filter(Boolean)); } catch {}
  const s = sessions.get(repoDir);
  if (s) s.config = merged;
  return { ok: true, config: merged };
}
// Persist sidebar page groups (committed to .radial.json so they travel).
export async function setPageGroups(repoDir: ArgTo<'pagesSetGroups', 0>, groups: ArgTo<'pagesSetGroups', 1>): Promise<AnswerTo<'pagesSetGroups'>> {
  const merged = publish.writeConfig(repoDir, { pageGroups: Array.isArray(groups) ? groups : [] });
  const s = sessions.get(repoDir);
  if (s) s.config = merged;
  return { ok: true, config: merged };
}
