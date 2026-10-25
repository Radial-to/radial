/**
 * Radial's core: what both hosts run, the Mac app's main process and
 * `radial serve`, the headless host for agents in a VM or a container. It never
 * loads Electron (plans/headless-core.md):
 * - sessions.ts: open, start, wake, sleep and restart, and the sweeps;
 * - history.ts: edit history, undo and redo, and moments;
 * - agents.ts: agent terminals, parking and keep-awake;
 * - edits.ts and flows.ts: page edits, new projects, migration and publish;
 * - hosting.ts: a project's Vercel hosting, for the window;
 * - api.ts: the control socket's CliApi, and control.ts, the socket itself;
 * - fallbacks.ts: what the core does itself with no window or no browser;
 * - here, createCore() and the boot: the stores, telemetry, the control
 *   socket and the PTY daemon, then the sweeps.
 *
 * A host hands createCore() four seams (host.ts): platform (version, flavor,
 * data dir, keep-awake), page (screenshots, the Content panel's fields,
 * reloads; null with no browser, and radial serve's says whether its browser
 * is installed yet), viewer (an attached window's flows; null with no window)
 * and events (what happened, for whoever watches).
 *
 * test/coreBoundary.test.ts walks the import graph from here and from
 * src/headless/index.ts, and fails if electron or electron-updater is
 * reachable.
 */
import * as projectData from '../main/projectData';
import * as dataDirs from '../main/dataDirs';
import * as recents from '../main/recents';
import * as projectState from '../main/projectState';
import * as devPids from '../main/devPids';
import * as telemetry from '../main/telemetry';
import * as errorReport from '../main/errorReport';
import * as agentSleep from '../main/agentSleep';
import type { CoreHost, CoreOptions } from './host';
import { bindHost, desktopOptions, options, platform } from './host';
import { activitySnapshot, checkDevMemory, checkExternalServers, checkIdle, configSet, getSiteUrl, isOpen, listPages, markUsed, moveProject, openProjects, openRepo, previewNow, pullVercelComments, pullVercelCommentsOnFocus, reapAllOrphans, refreshProject, restartDevServer, runLaunchCheck, setActive, setHiddenPages, setPageGroups, stopAll, stopSession, suspendSession, vcStatus, wake } from './sessions';
import { autoCommitEnabled, doRedo, doUndo, jumpTo, jumpToLatest, notifyMomentCreated, revertHere } from './history';
import { discardSleptRecord, homeCwd, homeInfo, initTerminalDaemon, mergeDaemonReaps, parkIdleAgents, reapExpiredAgents, setKeepAwake, startTerminal, syncKeepAwake } from './agents';
import { sessionAsking } from './questions';
import { applyStyleEdit, applyTextEdit, insertElement, metaAddTag, metaSetTagValue, moveElement, removeElement, swapImageFile, tokensSet, unwrapElement, wrapElement } from './edits';
import { createNewProject, DEMO_FRESH, migrateLaunch, migratePrepare, migrationPlaybook, publishDeploy, publishPlain, syncCtxIndex } from './flows';
import { vercelConnect, vercelDeployStaging, vercelLinkState, vercelProjectInfo, vercelStatus } from './hosting';
import { cliApi } from './api';
import { controlReady, dispatch, openProject, startControlServer, stopControlServer } from './control';

export type { CoreHost, CoreOptions, Events, Listener, Page, Platform, Viewer, ViewerChats } from './host';
export type { PreviewNow } from './sessions';
export { desktopOptions } from './host';

/**
 * The core, for a host: it binds the host's seams and options (the Mac app's
 * unless it passes others), opens the per-project data store in the data dir,
 * and answers what the host calls (the desktop's IPC handlers, `radial
 * serve`'s lifecycle). One per process: the core's state lives in its modules.
 */
export function createCore(host: CoreHost, opts: Partial<CoreOptions> = {}) {
  bindHost(host, { ...desktopOptions(), ...opts });
  projectData.init(host.platform.dataDir);
  return {
    // The run: boot before the window, the sweeps once it's up, and quitting.
    start, startSweeps, stopAll, stopControlServer, controlReady,
    // The control socket's API (the Home search box resolves with it too), and its ops for radial serve's HTTP listener.
    cliApi, dispatch,
    // Open projects (sessions.ts).
    openProject, openRepo, setActive, isOpen, openProjects, previewNow, markUsed, wake, listPages, stopSession, suspendSession, restartDevServer, refreshProject, runLaunchCheck,
    configSet, setHiddenPages, setPageGroups, getSiteUrl, moveProject, activitySnapshot,
    vcStatus, pullVercelComments, pullVercelCommentsOnFocus,
    // Hosting (hosting.ts).
    vercelLinkState, vercelProjectInfo, vercelStatus, vercelConnect, vercelDeployStaging,
    // Edit history and moments (history.ts).
    doUndo, doRedo, jumpTo, jumpToLatest, revertHere, autoCommitEnabled, notifyMomentCreated,
    // Agent terminals (agents.ts), and whether one's CLI asks a question of its own (questions.ts).
    homeCwd, homeInfo, startTerminal, discardSleptRecord, setKeepAwake, sessionAsking,
    // The window's edits (edits.ts).
    applyTextEdit, insertElement, moveElement, removeElement, wrapElement, unwrapElement, applyStyleEdit, metaAddTag, metaSetTagValue, tokensSet, swapImageFile,
    // New projects, migration and publishing (flows.ts).
    DEMO_FRESH, createNewProject, migratePrepare, migrateLaunch, migrationPlaybook, publishPlain, publishDeploy, syncCtxIndex,
  };
}
/** What createCore() answers. */
export type Core = ReturnType<typeof createCore>;

// Anonymous usage stats. Sending is confined to real installs: dev flavor and
// RADIAL_USERDATA (smoke/e2e) runs never send, RADIAL_TELEMETRY_FORCE=1 lets a
// dev build send for verifying the pipeline. The module itself enforces the
// event allowlist, the Settings off switch, and the local audit log.
// The headless core (`radial serve`) follows the same contract in the official
// radial-cli package, and is also off with CI or DO_NOT_TRACK set
// (telemetry.sendAllowedFor). Where it can't send (built from source, CI,
// DO_NOT_TRACK, a throwaway data dir) it writes nothing either: no install id.
// serve.ts counts its own start (serve_started) once it knows about --listen.
function initTelemetry(): void {
  const headless = platform().flavor === 'headless';
  const sendAllowed = telemetry.sendAllowedFor(platform().flavor, process.env);
  if (headless && !(sendAllowed && telemetry.POSTHOG_KEY)) { errorReport.init(platform().dataDir, {}); return; }
  telemetry.init(platform().dataDir, {
    appVersion: platform().version,
    osVersion: platform().osVersion,
    electronVersion: platform().electronVersion || null,
    sendAllowed,
    makeClient: () => {
      const { PostHog } = require('posthog-node') as typeof import('posthog-node');
      return new PostHog(telemetry.POSTHOG_KEY!, { host: telemetry.POSTHOG_HOST, flushAt: 5, flushInterval: 15000 }); // init() calls makeClient only with a key
    },
  });
  if (!headless) telemetry.capture('app_opened');
  errorReport.init(platform().dataDir, { capture: telemetry.capture });
}

let idleTimer: NodeJS.Timeout | null = null;

/** The core's boot, before the window: its stores, telemetry, the control socket and the PTY daemon. */
export function start(): void {
  recents.init(platform().dataDir);
  projectState.init(platform().dataDir);
  devPids.init(platform().dataDir);
  initTelemetry();
  // The sockets live in the data dir, or in a short folder when its path is too long for one (dataDirs.ts).
  try { dataDirs.prepareSocketDir(platform().dataDir); } catch (e) { console.error('[cli] no folder for the sockets:', (e as Error).message); }
  startControlServer(cliApi());
  initTerminalDaemon();
}

/** The sweeps, once the app is up: orphaned dev servers, idle projects and agents, and dev-server memory. */
export function startSweeps(): void {
  // Orphan reaping scales with stale runs — off the boot-critical path (the
  // same treatment installCliShim already gets).
  setTimeout(() => { try { reapAllOrphans(); mergeDaemonReaps(); } catch {} }, 2500);
  idleTimer = setInterval(() => { checkIdle(); checkExternalServers(); reapExpiredAgents().catch(() => {}); mergeDaemonReaps(); syncKeepAwake().catch(() => {}); }, 60 * 1000);
  // Once a minute in real use; a test's short RADIAL_AGENT_PARK_MS sweeps sooner.
  // Without parking (radial serve), idle agents live until the daemon's ceiling.
  if (options().parkAgents) setInterval(() => { parkIdleAgents().catch(() => {}); }, Math.min(60 * 1000, Math.max(2000, agentSleep.AGENT_PARK_MS / 2)));
  // treeRssMb spawns ps per server; once a minute is plenty for a 3 GB limit.
  setInterval(() => { checkDevMemory().catch(() => {}); }, Number(process.env.RADIAL_DEV_MEM_CHECK_MS) > 0 ? Number(process.env.RADIAL_DEV_MEM_CHECK_MS) : 60 * 1000); // env: e2e seam
}
