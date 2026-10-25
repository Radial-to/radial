import * as projectData from './projectData';
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron';
import type {
  ChatAttachmentUpload, ChatFile, ChatFileMatch, ChatFilePreview, ChatModel, ChatResourceAction, ChatResourceResult, ChatResponse,
  ChatSession, ChatSummary, ChatUpdate, ChatView, ClaudeDefaultState, CliOp, CliReply, CliRequest, CliRequests, CliResult,
  HomeInfo, MenuCommand, OpenInEditorResult, RadialApi, ResolveTargetResult, ShortcutBinding,
  UpdateState, WindowEvents, WorkspaceActivity,
} from '../shared/radialApi';
import type { AnswerTo, ArgTo, LooseUnion, PackedArgs } from '../core/types';
import type { StoredSleptAgent, TermStartPayload } from '../core/agents';
import type { ChatEngine, ClaudePermissionMode } from '../shared/chatPermissions';
import type { PreviewView } from '../renderer/threadPreview';
import type { StoredComment } from './comments';
import type { NativeChat } from './nativeChat';
import type { PtyInfo } from './terminal';

/** A menu command's argument (radialApi MenuCommand), by command; undefined for a command that takes none. */
type MenuSendArg<C extends MenuCommand['command'], M = MenuCommand> = M extends { command: infer K; arg?: infer A } ? (C extends K ? A : never) : never;
/**
 * An item of the app menu's template (buildMenu): its submenus are item lists,
 * never built Menus. An array spread into the template gets no contextual type,
 * so it says `satisfies AppMenuTemplateItem[]`.
 */
interface AppMenuTemplateItem extends MenuItemConstructorOptions { submenu?: AppMenuTemplateItem[] }

import { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, shell, webContents, clipboard, powerSaveBlocker, session as webSessions } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn, execFile } from 'child_process';
import { projectsFolder, imagesFolder, besideProject, lastUsedFolder } from './dialogFolders';
import { enginePaster } from './enginePaste';
import { backgroundWindowOptions, e2eBackground, enterBackgroundMode, showInBackground } from './e2eBackground';
import { watchProcesses } from './processWatch';
import type { FolderDeps } from './dialogFolders';

// Dev and installed builds must be FULLY isolated. The name keys userData
// (~/Library/Application Support/<name>), and userData keys everything that
// must never be shared across instances: the PTY daemon socket (or `electron .`
// would attach to the installed app's live agent terminals), devPids (boot-time
// reapAllOrphans would kill the installed app's running dev servers), recents,
// project state, and the safeStorage keychain scope. So `electron .` runs as
// "Radial Dev" with its own userData; only a packaged build is "Radial".
// RADIAL_USERDATA points either flavor at a throwaway dir (smoke tests, e2e).
const APP_FLAVOR = app.isPackaged ? 'Radial' : process.env.RADIAL_CHAT_EXPERIMENT === '1' ? 'Radial Chat Lab' : 'Radial Dev';
app.setName(APP_FLAVOR); // menu bar, About/Hide/Quit labels (esp. in dev)
app.setPath('userData', process.env.RADIAL_USERDATA || path.join(app.getPath('appData'), APP_FLAVOR)); // the core opens its per-project data store there (createCore)
// The desktop e2e suites' background mode (e2eBackground.ts): nothing on screen,
// nothing forward, no sound, the Mac's clipboard left alone, and only with a
// throwaway profile. Its native dialogs answer as cancelled. A stand-in that
// won't take ends the launch here, before anything can show: an exception this
// early would put up Electron's own error box.
const background = e2eBackground();
if (background) {
  try { enterBackgroundMode({ app, shell, dialog, clipboard, session: webSessions }); }
  catch (error) { console.error(`[e2e background] ${(error as Error).message} Quitting, so nothing shows.`); process.exit(1); }
}

// Logging must never crash the app: if the process that launched us goes away
// (terminal closed, parent pipe gone), stdout/stderr writes fail with EPIPE and
// an unhandled stream error becomes an Uncaught Exception dialog. Swallow write
// errors on both streams — every console.log in the main process routes here.
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') stream.on('error', () => {});
}

// The error reporter loads before the handlers below use it: an exception
// while the rest of main.ts loads would otherwise find it not there yet.
const errorReport = require('./errorReport') as typeof import('./errorReport');

// Same philosophy one level up: a broken pipe must never take the app down.
// A child process (the agent CLI, a dev server) can die between our write
// being queued and completing — that surfaces as an async EPIPE with no
// stream to attach a handler to, and Electron's default response is the
// "Uncaught Exception" dialog. Swallow ONLY pipe-shaped errors (the write's
// caller sees the failure through the child's exit); everything else keeps
// the loud dialog, because silently eating real bugs is worse.
// Nothing in these handlers may throw: an exception from an uncaughtException
// listener ends the app (Node exits with code 7), and what was thrown can be
// anything, a revoked Proxy or a getter that throws included.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  let code: unknown;
  try { code = err && err.code; } catch {}
  if (code === 'EPIPE' || code === 'EIO' || code === 'ERR_STREAM_DESTROYED') {
    try { console.error('[radial] ignored broken-pipe error:', err.message); } catch {}
    return;
  }
  try { errorReport.report('main', err, { via: 'exception' }); } catch {}
  let details: string;
  try { details = (err && err.stack) || String(err); } catch { details = 'An error that could not be read.'; }
  try { dialog.showErrorBox('JavaScript error', 'Uncaught Exception:\n' + details); } catch {}
});
// Rejections are reported but never get the scary dialog — most are recoverable
// async paths (a probe that lost its server, a fetch that timed out).
process.on('unhandledRejection', (reason) => { try { errorReport.report('main', reason, { via: 'rejection' }); } catch {} });

// Dock icon in dev (packaged builds use build/icon.icns via the bundle). The
// background mode has no Dock tile to draw.
if (process.platform === 'darwin' && !background) {
  app.whenReady().then(() => {
    try {
      const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.png'));
      if (!icon.isEmpty() && app.dock) app.dock.setIcon(icon);
    } catch {}
  });
}

const editEngine = require('./editEngine') as typeof import('./editEngine');
const project = require('./project') as typeof import('./project');
const publish = require('./publish') as typeof import('./publish');
const github = require('./github') as typeof import('./github');
if (background) github.useWorkspaceRoot(path.join(app.getPath('userData'), 'Radial')); // never the person's ~/Radial
const vercel = require('./vercel') as typeof import('./vercel');
const terminal = require('./terminal') as typeof import('./terminal');
const recents = require('./recents') as typeof import('./recents');
const projectState = require('./projectState') as typeof import('./projectState');
const devPids = require('./devPids') as typeof import('./devPids');
const http = require('http') as typeof import('http');
const https = require('https') as typeof import('https');
const references = require('./references') as typeof import('./references');
const projectMemory = require('./projectMemory') as typeof import('./projectMemory');
const agent = require('./agent') as typeof import('./agent');
const codex = require('./codex') as typeof import('./codex');
const cursor = require('./cursor') as typeof import('./cursor');
const engine = require('./engine') as typeof import('./engine');
const deploy = require('./deploy') as typeof import('./deploy');
const context = require('./context') as typeof import('./context');
const comments = require('./comments') as typeof import('./comments');
const { childEnv, which, claudeBin, registerExtraBin } = require('./env') as typeof import('./env');
const devReload = require('./devReload') as typeof import('./devReload');
const newProject = require('./newProject') as typeof import('./newProject');
const launchCheck = require('./launchCheck') as typeof import('./launchCheck');
const telemetry = require('./telemetry') as typeof import('./telemetry');
const officialBuild = require('./officialBuild') as typeof import('./officialBuild'); // official builds: analytics key + update feed
const moments = require('./moments') as typeof import('./moments');
const updateCheck = require('./updateCheck') as typeof import('./updateCheck');
const updater = require('./updater') as typeof import('./updater');
const cliOpen = require('./cliOpen') as typeof import('./cliOpen');
const tokens = require('./tokens') as typeof import('./tokens');
const cliInstall = require('./cliInstall') as typeof import('./cliInstall');
const provision = require('./tools') as typeof import('./tools'); // userland tool installs (Claude Code, gh, Node)

let mainWindow: BrowserWindow | null = null;
// A process that goes away (the window's renderer, a preview's, the GPU or a
// utility process) is reported with its reason and exit code and a few counts,
// never a minidump (processWatch.ts).
watchProcesses({
  app, webContents, report: errorReport.reportGone,
  isAppWindow: (contents) => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents === contents,
  terminals: () => terminal.liveCount(), // only from a daemon already connected: a crash report never starts one
});
/**
 * Tells the window something: every main → window message goes through here,
 * typed by radialApi's WindowEvents (the channel, and its payload, or none when
 * the event carries nothing). With no window, or one that's closing, nobody is
 * there to tell, and nothing is sent.
 */
function send<C extends keyof WindowEvents>(channel: C, ...payload: WindowEvents[C] extends undefined ? [] : [WindowEvents[C]]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...payload);
}
let stopDevReload: (() => void) | null = null;
let devRestarting = false;

// ── The core (src/core, plans/headless-core.md) ──────────────────────────
// The orchestration this app shares with `radial serve`: open projects, edit
// history, agent terminals, edits, flows and the control socket. This file is
// its shell (the window, menus, dialogs, the updater, the native chat) and
// hands it the seams it reaches the app through: platform, page, viewer and
// events. The IPC handlers below that need the core call it in one line.
const { createCore } = require('../core') as typeof import('../core');
// The power-save assertion the app holds while a kept-awake agent lives (the
// daemon holds its own; agents.ts's syncKeepAwake says when).
let awakeBlockerId: number | null = null;
const core = createCore({
  // Read when the core asks, as the code that now lives there read Electron.
  platform: {
    get version() { return app.getVersion(); },
    get flavor() { return app.isPackaged ? 'packaged' : 'dev'; },
    get dataDir() { return app.getPath('userData'); },
    get home() { return app.getPath('home'); },
    get osVersion() { return process.getSystemVersion(); }, // macOS's own version ("27.0.0"), never os.release()'s Darwin
    get electronVersion() { return process.versions.electron; },
    get cliBin() { return app.isPackaged ? path.join(process.resourcesPath, 'bin', 'radial') : path.join(app.getAppPath(), 'bin', 'radial'); },
    keepAwake(want: boolean) {
      if (want && awakeBlockerId == null) { try { awakeBlockerId = powerSaveBlocker.start('prevent-app-suspension'); } catch { awakeBlockerId = null; } }
      else if (!want && awakeBlockerId != null) { try { powerSaveBlocker.stop(awakeBlockerId); } catch {} awakeBlockerId = null; }
    },
    recentsChanged: () => buildMenu(), // Open Recent
  },
  // The window's preview answers for its pages (askRenderer), and a hidden
  // window takes the migration's screenshots (loaded when first used).
  page: {
    shot: (repoDir, route) => askRenderer('shot', { repoDir, route }, 60000),
    fields: (repoDir, route) => askRenderer('fields', { repoDir, route }, 30000),
    reload: (repoDir) => askRenderer('reload', { repoDir }, 5000),
    get shoot() { return (require('./migrate/shots') as typeof import('./migrate/shots')).shoot; },
    get decode() { return migrateDecode; },
    get encode() { return migrateEncode; },
  },
  // The window: its open (loading overlay, Node modal, tab focus), its agent
  // ops (askRenderer, same timeouts), and its chats when this app runs them.
  viewer: {
    open: (repoDir) => openPathRequest(repoDir),
    focus: () => focusMainWindow(),
    ready: () => !!(mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()),
    focused: () => !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()),
    close: (repoDir) => askRenderer('close', { repoDir }, 90000),
    visibleAgents: () => askRenderer('visibleAgents', {}, 5000),
    agentStart: (request) => askRenderer('agent', request, 120000),
    agentSend: (request) => askRenderer('agentSend', request, 60000),
    home: (request) => askRenderer('home', request, 60000),
    get chats() { return nativeChatEnabled ? chatsForCore : null; },
  },
  // The core's events go to the window, when one is open (send() checks).
  events: { send, listening: () => !!mainWindow && !mainWindow.isDestroyed() },
});

// ── CLI / Finder opens (`radial .`, `open -a Radial <folder>`) ────────────
// bin/radial (shipped in the bundle, symlinked onto PATH by cliInstall)
// spawns a second app instance with --open-path=<abs> flags; the single-
// instance lock hands that argv here and the extra instance exits, so one
// command works whether or not the app was already running. The lock is keyed
// to userData, so `electron .` ("Radial Dev") and the installed app still run
// side by side. open-file is the LaunchServices half: `open -a Radial <dir>`
// and folders dropped on the Dock icon (public.folder document type in the
// build config). These are the only remote-open rails on purpose — unlike a
// radial:// URL, none of them can be fired by a webpage, and opening a folder
// runs its dev script.
if (!app.requestSingleInstanceLock()) {
  // requestSingleInstanceLock already delivered our argv to the running
  // instance. Exit HARD: app.quit() is graceful — 'ready' would still fire
  // and run the whole boot chain (term-daemon spawn, reapAllOrphans against
  // the live instance's dev servers) before dying.
  app.exit(0);
} else {
  app.on('second-instance', (_e, argv, workingDir) => {
    const dirs = cliOpen.parseOpenPaths(argv, workingDir);
    for (const dir of dirs) openPathRequest(dir);
    if (!dirs.length) focusMainWindow(); // bare `radial` — just bring the app up
  });
}

app.on('open-file', (event, p) => {
  event.preventDefault();
  const dir = cliOpen.normalizeOpenPath(p);
  if (dir) openPathRequest(dir);
});

// Opens that arrive before the renderer can take them (cold launch, window
// closed, mid-reload) wait here; createWindow drains the list on every
// did-finish-load. The renderer side is the existing radial:auto-open →
// openProjectPath rail, which re-focuses a tab that's already open.
const pendingOpenPaths: string[] = [];
function openPathRequest(dir: string): void {
  focusMainWindow();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    send('radial:auto-open', dir);
  } else {
    pendingOpenPaths.push(dir);
    // All windows closed but the app alive (macOS) — same recreate as 'activate'.
    if (app.isReady() && (!mainWindow || mainWindow.isDestroyed())) createWindow();
  }
}

function focusMainWindow(): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (background) { showInBackground(mainWindow); return; } // never forward in the e2e background mode
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  } catch {}
}

// ── The control socket (plans/radial-agent-native.md) ─────────────────────
// The core serves it (src/core/index.ts, api.ts). Opens it asks for go through
// openPathRequest so the renderer keeps its overlay, cap modal and tab focus;
// the result comes back through the project:open handler. Some ops only the
// window can answer (a preview screenshot, closing a tab): askRenderer asks.
const cliPending = new Map<string, (r: CliResult) => void>();
let cliSeq = 0;
// Ask the renderer for something only the window can do (a preview screenshot,
// closing a tab). Replies arrive on 'cli:reply' keyed by reqId.
function askRenderer<Op extends CliOp>(op: Op, payload: CliRequests[Op], timeoutMs = 30000): Promise<CliResult<Op>> {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) { resolve({ ok: false, code: 'error', error: 'The app window is not ready.' }); return; }
    const reqId = 'w' + (++cliSeq);
    const timer = setTimeout(() => { cliPending.delete(reqId); resolve({ ok: false, code: 'timeout', error: 'The app window did not answer.' }); }, timeoutMs);
    cliPending.set(reqId, (r) => { clearTimeout(timer); resolve(r as CliResult<Op>); }); // the reply to this reqId answers this op
    send('cli:request', { reqId, op, payload } as CliRequest); // op and payload are one op's (this function's parameters tie them), which TypeScript can't follow into CliRequest's union
  });
}
ipcMain.on('cli:reply', (_e, p: CliReply) => {
  const r = p && cliPending.get(p.reqId);
  if (!r) return;
  cliPending.delete(p.reqId);
  const { reqId, ...rest } = p; r(rest);
});
ipcMain.handle('home:info', (): Promise<HomeInfo> => core.homeInfo());
const nativeChatEnabled = process.env.RADIAL_CHAT_EXPERIMENT !== '0'
  && (app.isPackaged || process.env.RADIAL_CHAT_EXPERIMENT === '1');
let nativeChat: NativeChat | undefined, nativeChatAwakeId: number | null = null;
function syncNativeChatAwake(): void {
  const awake = nativeChat && [...nativeChat.live.keys()].some(id => nativeChat!.get(id).keepAwake); // checked just before
  if (awake && nativeChatAwakeId === null) nativeChatAwakeId = powerSaveBlocker.start('prevent-app-suspension');
  if (!awake && nativeChatAwakeId !== null) { powerSaveBlocker.stop(nativeChatAwakeId); nativeChatAwakeId = null; }
}
function chatExperiment(): NativeChat {
  if (!nativeChatEnabled) throw new Error('Chat UI is disabled.');
  if (!nativeChat) {
    const { NativeChat } = require('./nativeChat') as typeof import('./nativeChat');
    nativeChat = new NativeChat({ terminal, file: path.join(app.getPath('userData'), 'native-chats.json'),
      context: (dir, home) => home ? engine.homeContext(dir) : engine.contextFor(dir),
      emit: session => { syncNativeChatAwake(); send('nativeChat:event', session); },
    });
  }
  return nativeChat;
}
// The chats as the core reaches them (its viewer's chats, when chats are on):
// parked by its sweeps, fed by the terminals it runs, a migration's first chat.
const chatsForCore: import('../core/host').ViewerChats = {
  parkIdle: (options) => nativeChat ? nativeChat.parkIdle(options) : Promise.resolve([]), // nothing to park before the Chat UI starts
  terminalData: (id, data) => nativeChat?.terminalData(id, data),
  terminalExited: (id) => nativeChat?.terminalExited(id),
  inputBlock: (id) => (nativeChat ? nativeChat.terminalInputBlock(id) : null),
  createTaskChat(repoDir, engine, title, task) {
    const chat = chatExperiment();
    const s = chat.create(repoDir, false, engine);
    Object.assign(s, { title, titleAuto: false, initialPrompt: task });
    chat.changed(s);
    return s.id;
  },
  startTaskChat: (id) => chatExperiment().setView(id, 'terminal'),
};
const { ChatResources } = require('./chat/resources') as typeof import('./chat/resources');
const chatResources = new ChatResources(path.join(app.getPath('userData'), 'chat-attachments'));
ipcMain.handle('nativeChat:resource', async (_event, id: string, reference: string, action: ChatResourceAction = 'describe'): Promise<ChatResourceResult> => {
  const session = chatExperiment().get(id);
  if (action === 'describe') return chatResources.describe(session, reference, true);
  const item = chatResources.resolve(session, reference);
  if (action === 'reveal') { shell.showItemInFolder(item.file); return { ok: true }; }
  if (action === 'save') {
    const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: item.name }); // the window asking is mainWindow
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    if (path.resolve(result.filePath) !== item.file) await fs.promises.copyFile(item.file, result.filePath);
    return { ok: true };
  }
  if (action !== 'open') throw new Error('Unknown file action.');
  // Never execute a file named by an assistant response. Documents open in an
  // editor; images and binary outputs are revealed for explicit user handling.
  if (/\.(?:md|txt|json|js|jsx|ts|tsx|css|html|xml|svg|yaml|yml|toml|py|rb|go|rs|sh|csv|sql)$/i.test(item.file)) return openInEditor(item.file, item.line, 1) as Promise<OpenInEditorResult>; // bridge: openInEditor is typed in the other range; drop the cast at merge
  shell.showItemInFolder(item.file); return { ok: true };
});
ipcMain.handle('nativeChat:attach', (_event, data: ChatAttachmentUpload): ChatFile => chatResources.import(data));
ipcMain.handle('nativeChat:preview', (_event, dir: string, reference: string): ChatFilePreview => {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Select a project first.');
  return chatResources.preview({ repoDir: dir }, reference);
});
ipcMain.handle('nativeChat:files', (_event, dir: string, query?: string): Promise<ChatFileMatch[]> => {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Select a project first.');
  return chatResources.list({ repoDir: dir }, query);
});
ipcMain.handle('nativeChat:view', (_event, id: string, view: ChatView, cols?: number, rows?: number, stopTerminal?: boolean): Promise<ChatSession> => chatExperiment().setView(id, view, cols, rows, stopTerminal === true));
ipcMain.handle('nativeChat:enabled', (): boolean => nativeChatEnabled);
ipcMain.handle('nativeChat:restore', (_event, repoDir: string, home?: boolean): Promise<void> | undefined => {
  if (!nativeChatEnabled) return;
  if (home ? repoDir !== core.homeCwd() : !core.isOpen(repoDir)) throw new Error('Open this project before resuming its chats.');
  return chatExperiment().restoreProject(repoDir, home === true);
});
ipcMain.handle('nativeChat:claudeDefault', (): ClaudeDefaultState => (require('./chat/claudeSettings') as typeof import('./chat/claudeSettings')).get());
ipcMain.handle('nativeChat:setClaudeDefault', (_event, mode: ClaudePermissionMode, revision: string): ClaudeDefaultState => (require('./chat/claudeSettings') as typeof import('./chat/claudeSettings')).set(mode, revision));
ipcMain.handle('nativeChat:list', (_event, dir?: string | null, includeClosed?: boolean): ChatSummary[] => chatExperiment().list(dir, includeClosed === true));
ipcMain.handle('nativeChat:models', (_event, dir: string, engine?: ChatEngine): Promise<ChatModel[]> => chatExperiment().models(dir, engine));
ipcMain.handle('nativeChat:configure', (_event, id: string, model: string, effort?: string | null): Promise<ChatSession> => chatExperiment().configure(id, model, effort));
ipcMain.handle('nativeChat:get', (_event, id: string): ChatSession => chatExperiment().get(id));
ipcMain.handle('nativeChat:create', (_event, dir: string, home?: boolean, engine?: ChatEngine): ChatSession => chatExperiment().create(dir, !!home, engine));
ipcMain.handle('nativeChat:send', (_event, id: string, text: string, displayText?: string, attachments?: Parameters<RadialApi['nativeChatSend']>[3]): Promise<ChatSession> => chatExperiment().send(id, text, displayText, attachments));
ipcMain.handle('nativeChat:update', (_event, id: string, patch: ChatUpdate): ChatSession | Promise<ChatSession> => chatExperiment().update(id, patch));
ipcMain.on('nativeChat:savePreview', (_event, id: string, preview: PreviewView, previewSelectedAt: number) => { try { chatExperiment().update(id, { preview, previewSelectedAt }); } catch {} });
ipcMain.handle('nativeChat:archive', (_event, id: string): Promise<ChatSession> => chatExperiment().archive(id));
ipcMain.handle('nativeChat:discard', (_event, id: string): Promise<boolean> => chatExperiment().discard(id));
ipcMain.handle('nativeChat:stop', (_event, id: string): Promise<ChatSession> => chatExperiment().stop(id));
ipcMain.handle('nativeChat:queue', (_event, id: string, text: string, displayText?: string, attachments?: Parameters<RadialApi['nativeChatQueue']>[3]): ChatSession => chatExperiment().enqueue(id, text, displayText, attachments));
ipcMain.handle('nativeChat:removeQueued', (_event, id: string, messageId: string): ChatSession => chatExperiment().removeQueued(id, messageId));
ipcMain.handle('nativeChat:reorderQueue', (_event, id: string, messageIds: string[]): ChatSession => chatExperiment().reorderQueue(id, messageIds));
ipcMain.handle('nativeChat:resumeQueue', (_event, id: string): ChatSession => chatExperiment().resumeQueue(id));
ipcMain.handle('nativeChat:respond', (_event, id: string, response: ChatResponse): ChatSession => chatExperiment().respond(id, response));
app.on('before-quit', () => { nativeChat?.close(); syncNativeChatAwake(); });
ipcMain.handle('workspace:activity', async (): Promise<WorkspaceActivity> => {
  const terminals = await terminal.list(null);
  const agents = terminals.filter(agent => !agent.meta?.nativeChatId || !nativeChat?.live.has(agent.meta.nativeChatId));
  if (nativeChat) for (const [id, transport] of nativeChat.live) {
    const chat = nativeChat.get(id), nativeTerminal = terminals.find(term => term.id === chat.terminalId);
    agents.push({ id: 'native:' + id, repoDir: chat.repoDir, alive: true, pid: nativeTerminal?.pid || transport.child?.pid, startedAt: nativeTerminal?.startedAt || transport.startedAt, lastDataAt: chat.state === 'working' ? Date.now() : 0, lastBellAt: chat.state === 'approval' ? Date.now() : 0, meta: { engine: chat.engine, label: chat.title, home: chat.home } });
  }
  return core.activitySnapshot(agents);
});
// The Home search box resolves names/links the same way the CLI does.
ipcMain.handle('project:resolveTarget', async (_e, text: string): Promise<ResolveTargetResult> => core.cliApi().resolve(String(text || ''), app.getPath('home')));

// Symlink the bundled `radial` command onto PATH (best effort, no elevation,
// never touches a radial we didn't create — see cliInstall.js). Deferred a
// few seconds so a slow disk can't tax boot; failure only costs the shortcut,
// `open -a Radial <folder>` still works without it.
function installCliShim(): void {
  if (!app.isPackaged || process.env.RADIAL_USERDATA) return; // dev / e2e / smoke
  setTimeout(() => {
    try {
      const r = cliInstall.ensureInstalled(cliInstall.shimPath(process.resourcesPath));
      console.log(r.installed ? `[cli] radial command installed at ${r.installed}` : `[cli] radial command not installed (${r.reason})`);
    } catch (e) {
      console.log('[cli] install failed:', e && (e as Error).message);
    }
  }, 3000);
}

// Overloads: a command MenuCommand gives an argument must be sent with one, and a command without one is sent bare.
function menuSend(command: Extract<MenuCommand, { arg?: undefined }>['command']): void;
function menuSend<C extends Exclude<MenuCommand, { arg?: undefined }>['command']>(command: C, arg: MenuSendArg<C>): void;
function menuSend(command: MenuCommand['command'], arg?: MenuCommand['arg']): void {
  send('radial:menu', { command, arg } as MenuCommand); // the overloads above pair each command with its argument, which this signature can't say
}

function shortPath(p: string): string {
  const home = app.getPath('home');
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function recentMenuItems(): AppMenuTemplateItem[] {
  const list = recents.listRecents();
  if (!list.length) return [{ label: 'No recent projects', enabled: false }];
  return list.slice(0, 12).map((r) => ({
    label: `${r.name}: ${shortPath(r.path)}`,
    click: () => menuSend('open-path', r.path),
  }));
}

// "Check for Updates…" from the app menu. In an official build the in-app
// updater (updater.js, electron-updater) checks, downloads in the background,
// and installs on a user-chosen restart; if it's unusable, fall back to the
// old website flow (updateCheck.js → radial.to/download). A build from source
// never updates itself, so the item explains that instead.
async function checkForUpdates(): Promise<void> {
  const win = (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined) as BrowserWindow; // undefined: no parent window; the as is knowingly loose, Electron's dialogs take undefined though their types leave it out
  const r = await updater.check({ isPackaged: app.isPackaged, isOfficial: officialBuild.isOfficial(), currentVersion: app.getVersion() });
  if (r.state === 'source-build') {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      message: 'This copy doesn’t update itself',
      detail: 'It was built from source. Pull the latest code and build it again, or download the official app from radial.to, which keeps itself up to date.',
      buttons: ['Download the app', 'OK'], defaultId: 1, cancelId: 1,
    });
    if (response === 0) shell.openExternal(updateCheck.DOWNLOAD_URL);
    return;
  }
  if (r.state === 'downloaded') {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      message: `Radial ${r.version} is ready to install`,
      detail: 'Restart to finish updating. Agent terminals pick up where they left off.',
      buttons: ['Restart Now', 'Later'], defaultId: 0, cancelId: 1,
    });
    if (response === 0) updater.restart();
    return;
  }
  if (r.state === 'refused') {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      message: `Radial ${r.version || 'update'} needs a download`,
      detail: 'macOS won’t let this copy update itself to it. Download it from radial.to, then drag Radial into Applications to replace this one. Your projects and settings stay put.',
      buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1,
    });
    if (response === 0) shell.openExternal(updateCheck.DOWNLOAD_URL);
    return;
  }
  if (r.state === 'available') {
    await dialog.showMessageBox(win, {
      type: 'info',
      message: `Radial ${r.version} is available`,
      detail: 'Downloading in the background. A small Update ready card will appear in the corner when it’s ready.',
      buttons: ['OK'],
    });
    return;
  }
  if (r.state === 'none') {
    await dialog.showMessageBox(win, { type: 'info', message: 'You’re up to date', detail: `Radial ${r.version} is the latest version.`, buttons: ['OK'] });
    return;
  }
  // Updater unusable — legacy website flow.
  const legacy = await updateCheck.check(app.getVersion());
  if (!legacy.ok) {
    await dialog.showMessageBox(win, { type: 'warning', message: 'Couldn’t check for updates', detail: 'Check your internet connection and try again.', buttons: ['OK'] });
    return;
  }
  if (!legacy.updateAvailable) {
    await dialog.showMessageBox(win, { type: 'info', message: 'You’re up to date', detail: `Radial ${legacy.current} is the latest version.`, buttons: ['OK'] });
    return;
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    message: `Radial ${legacy.latest} is available`,
    detail: `You have ${legacy.current}. Download the new version, then drag Radial into Applications to replace this one. Your projects and settings stay put.`,
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) shell.openExternal(updateCheck.DOWNLOAD_URL);
}

// Background updater: quiet check + download, then the renderer shows a small
// "Restart to update" pill. Skipped for smoke/e2e runs (RADIAL_USERDATA), which
// must never swap the app out from under a test.
function initUpdater(): void {
  if (process.env.RADIAL_USERDATA) return;
  updater.init({
    isPackaged: app.isPackaged,
    isOfficial: officialBuild.isOfficial(),
    onDownloaded: (info) => {
      send('update:ready', { version: (info && info.version) || '' });
    },
    // macOS refused it (another signing team or app ID): the card offers the download instead of a Restart that would do nothing.
    onRefused: (info) => {
      send('update:refused', { version: info.version || '', url: updateCheck.DOWNLOAD_URL });
    },
  });
}
// A reloaded renderer re-asks; a ready update must survive the round trip.
ipcMain.handle('update:state', async (): Promise<UpdateState> => {
  const info = updater.ready();
  const refused = updater.refusal();
  return { ready: !!info, version: (info && info.version) || '', ...(refused ? { refused: { version: refused.version || '', url: updateCheck.DOWNLOAD_URL } } : {}) };
});
ipcMain.handle('update:restart', async (): ReturnType<RadialApi['updateRestart']> => ({ ok: updater.restart() }));


// Saved panel-layout names (from the renderer) — rendered into the Panels menu.
let panelLayoutNames: string[] = [];
function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: AppMenuTemplateItem[] = [
    ...(isMac ? [{
      label: 'Radial',
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => checkForUpdates() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] satisfies AppMenuTemplateItem[] : []),
    {
      label: 'File',
      submenu: [
        { id: 'shortcut-open-project', label: 'Open Project…', accelerator: 'CmdOrCtrl+N', click: () => menuSend('new-project') }, // the home screen's Open project flow (start, import, or open a folder)
        { id: 'shortcut-open-folder', label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => menuSend('open-local') },
        { id: 'shortcut-open-github', label: 'Open from GitHub…', accelerator: 'CmdOrCtrl+Shift+O', click: () => menuSend('open-github') },
        { label: 'Open Recent', submenu: recentMenuItems() },
        { type: 'separator' },
        { label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', click: () => menuSend('go-home') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => menuSend('close-tab') },
        {
          label: 'Go to Tab',
          submenu: [
            { label: 'Home', accelerator: 'CmdOrCtrl+1', click: () => menuSend('select-tab', 1) },
            ...Array.from({ length: 8 }, (_, i) => ({
              label: `Tab ${i + 2}`,
              accelerator: `CmdOrCtrl+${i + 2}`,
              click: () => menuSend('select-tab', i + 2),
            })),
          ],
        },
        ...(isMac ? [] : [{ role: 'quit' }] satisfies AppMenuTemplateItem[]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => menuSend('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => menuSend('redo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', acceleratorWorksWhenHidden: true, visible: false, click: () => menuSend('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { id: 'shortcut-command-palette', label: 'Command Palette', accelerator: 'CmdOrCtrl+K', click: () => menuSend('cmdk') },
        { type: 'separator' },
        // ⌘E belongs to Add (Webflow muscle memory: ⌘E → div → ⌘E →
        // element inside it). The text tool keeps T; edit-mode toggle stays a
        // menu item, just without the accelerator.
        { label: 'Add Element… (Experimental)', accelerator: 'CmdOrCtrl+E', click: () => menuSend('quick-add') },
        { label: 'Toggle Edit Mode', click: () => send('radial:toggle-edit-mode') },
        { id: 'shortcut-agent', label: 'Agent Panel', accelerator: 'CmdOrCtrl+I', click: () => menuSend('toggle-agent') },
        { id: 'shortcut-terminal', label: 'Terminal', accelerator: 'CmdOrCtrl+J', click: () => send('radial:toggle-terminal') },
        { id: 'shortcut-comments', label: 'Comments', accelerator: 'CmdOrCtrl+Shift+C', click: () => send('radial:toggle-comments') },
        { id: 'shortcut-projects-sidebar', label: 'Hide/Show Projects Sidebar', accelerator: 'CmdOrCtrl+Shift+A', click: () => menuSend('toggle-rail') }, // ⌘⇧A/S/D: home row, left to right across the window, one-handed; ⌘⇧S is the browsers' sidebar key,
        { id: 'shortcut-agent-sidebar', label: 'Hide/Show Agent Sidebar', accelerator: 'CmdOrCtrl+Shift+S', click: () => menuSend('toggle-left-sidebar') },
        { id: 'shortcut-panels-sidebar', label: 'Hide/Show Panels Sidebar', accelerator: 'CmdOrCtrl+Shift+D', click: () => menuSend('toggle-right-sidebar') },
        { label: 'Toggle Legacy Top Layout', click: () => menuSend('toggle-layout-legacy') },
        { id: 'chrome-strip', label: 'Vertical Tool Strip', type: 'checkbox', checked: false, click: () => menuSend('toggle-chrome-layout') },
        { type: 'separator' },
        {
          label: 'Sidebar',
          submenu: [
            { id: 'shortcut-pages', label: 'Pages', accelerator: 'CmdOrCtrl+P', click: () => menuSend('open-pages') },
            { label: 'Context', click: () => menuSend('side-pane', 'context') },
            { label: 'History', click: () => menuSend('side-pane', 'history') },
          ],
        },
        { id: 'shortcut-page-settings', label: 'Page Settings', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('radial:toggle-page-settings') },
        { id: 'shortcut-preview', label: 'Preview (Focus Mode)', accelerator: 'CmdOrCtrl+\\', click: () => send('radial:toggle-focus') },
        { type: 'separator' },
        {
          label: 'Preview Width',
          submenu: [
            { label: 'Desktop', click: () => menuSend('set-device', 'desktop') },
            { label: 'Tablet (768)', click: () => menuSend('set-device', 'tablet') },
            { label: 'Mobile (390)', click: () => menuSend('set-device', 'mobile') },
          ],
        },
        { type: 'separator' },
        // Screenshot + rulers live here (and on their hotkeys) — deliberately
        // not in the quick toolbar.
        { id: 'shortcut-screenshot', label: 'Save Full-Page Screenshot (2×)', accelerator: 'CmdOrCtrl+Shift+F', click: () => menuSend('shot-full') },
        { type: 'separator' },
        // ⇧R is handled in the renderer — shown here for discoverability only,
        // same pattern as Reload Preview's ⌘R.
        { label: 'Rulers & Guides', accelerator: 'Shift+R', registerAccelerator: false, click: () => menuSend('toggle-rulers') },
        { label: 'Clear All Guides', click: () => menuSend('clear-guides') },
        { type: 'separator' },
        { id: 'shortcut-zoom-in', label: 'Zoom In Preview', accelerator: 'CmdOrCtrl+Plus', click: () => menuSend('zoom-in') },
        { label: 'Zoom In Preview', accelerator: 'CmdOrCtrl+=', visible: false, acceleratorWorksWhenHidden: true, click: () => menuSend('zoom-in') },
        { id: 'shortcut-zoom-out', label: 'Zoom Out Preview', accelerator: 'CmdOrCtrl+-', click: () => menuSend('zoom-out') },
        { id: 'shortcut-zoom-reset', label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => menuSend('zoom-reset') },
        { type: 'separator' },
        { label: 'Toggle Log', accelerator: 'CmdOrCtrl+Shift+L', click: () => send('radial:toggle-log') },
        { type: 'separator' },
        // Shows ⌘R in the menu for discoverability, but doesn't register the
        // accelerator — the before-input-event handler below is the single trigger
        // (so it works with the preview webview focused too, without double-firing).
        { id: 'shortcut-reload-preview', label: 'Reload Preview', accelerator: 'CmdOrCtrl+R', registerAccelerator: false, click: () => menuSend('reload-preview') },
        { id: 'shortcut-back', label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => menuSend('nav-back') },
        { id: 'shortcut-forward', label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => menuSend('nav-fwd') },
        { label: 'Reload App', accelerator: 'CmdOrCtrl+Shift+R', role: 'forceReload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Panels',
      submenu: [
        { id: 'panel-adjust', type: 'checkbox', label: 'Design', click: () => menuSend('toggle-panel', 'adjust') },
        { id: 'panel-content', type: 'checkbox', label: 'Content', click: () => menuSend('toggle-panel', 'content') },
        { id: 'panel-motion', type: 'checkbox', label: 'Motion', click: () => menuSend('toggle-panel', 'motion') },
        { id: 'panel-inspect', type: 'checkbox', label: 'Inspect', click: () => menuSend('toggle-panel', 'inspect') },
        { id: 'panel-variants', type: 'checkbox', label: 'Variants', click: () => menuSend('toggle-panel', 'variants') },
        { id: 'panel-image', type: 'checkbox', label: 'Image', click: () => menuSend('toggle-panel', 'image') },
        { id: 'panel-a11y', type: 'checkbox', label: 'Accessibility', click: () => menuSend('toggle-panel', 'a11y') },
        { id: 'panel-layers', type: 'checkbox', label: 'Layers', click: () => menuSend('toggle-panel', 'layers') },
        { id: 'panel-page', type: 'checkbox', label: 'Page Info', click: () => menuSend('toggle-panel', 'page') },
        { id: 'panel-reconcile', type: 'checkbox', label: 'Reconcile', click: () => menuSend('toggle-panel', 'reconcile') },
        { id: 'panel-ask', type: 'checkbox', label: 'Agent Input', click: () => menuSend('toggle-panel', 'ask') },
        { id: 'panel-branches', type: 'checkbox', label: 'Branches', click: () => menuSend('toggle-panel', 'branches') },
        { id: 'panel-draw', type: 'checkbox', label: 'Draw', click: () => menuSend('toggle-panel', 'draw') },
        { id: 'panel-comments', type: 'checkbox', label: 'Comments', click: () => menuSend('toggle-panel', 'comments') },
        { id: 'panel-pages', type: 'checkbox', label: 'Pages', click: () => menuSend('toggle-panel', 'pages') },
        { id: 'panel-context', type: 'checkbox', label: 'Context', click: () => menuSend('toggle-panel', 'context') },
        { id: 'panel-history', type: 'checkbox', label: 'History', click: () => menuSend('toggle-panel', 'history') },
        { id: 'panel-publish', type: 'checkbox', label: 'Publish', click: () => menuSend('toggle-panel', 'publish') },
        { type: 'separator' },
        // Saved layouts (Photoshop workspaces): names arrive with the
        // renderer's panels-state; the menu rebuilds when the list changes.
        ...panelLayoutNames.map((n) => ({ label: n, click: () => menuSend('apply-panel-layout', n) })),
        { label: 'Save Layout…', click: () => menuSend('save-panel-layout') },
        ...(panelLayoutNames.length ? [{
          label: 'Delete Layout',
          submenu: panelLayoutNames.map((n) => ({ label: n, click: () => menuSend('delete-panel-layout', n) })),
        }] : []),
        { type: 'separator' },
        { label: 'Pin to the Right', accelerator: 'Alt+CmdOrCtrl+P', click: () => menuSend('toggle-panel-dock') },
        { label: 'Float All Panels', click: () => menuSend('float-panels') },
      ],
    },
    {
      label: 'Agent',
      submenu: [
        { label: 'New Claude Code Chat', accelerator: 'CmdOrCtrl+T', click: () => menuSend('new-agent', 'claude') },
        { label: 'New Codex Chat', click: () => menuSend('new-agent', 'codex') },
        { label: 'New Cursor Chat', click: () => menuSend('new-agent', 'cursor') },
        { label: 'New Shell', click: () => menuSend('new-agent', '') },
        { type: 'separator' },
        { label: 'Focus Composer', accelerator: 'CmdOrCtrl+L', click: () => menuSend('focus-agent') },
        { type: 'separator' },
        { label: 'Screenshot to Agent', accelerator: 'CmdOrCtrl+Shift+I', click: () => menuSend('shot-agent') },
        { label: 'Screenshot to Terminal', click: () => menuSend('shot-terminal') },
      ],
    },
    {
      label: 'Project',
      submenu: [
        { id: 'shortcut-publish', label: 'Publish…', accelerator: 'CmdOrCtrl+Shift+Return', click: () => menuSend('publish') },
        // Team sharing (review links, editors, publishing together) lives in
        // Radial Cloud; the app stays single player.
        { label: 'Share with Radial Cloud', click: () => { try { shell.openExternal('https://radial.to/cloud'); } catch {} } },
        { type: 'separator' },
        { label: 'Pull Latest from GitHub', click: () => menuSend('sync-project') },
        { label: 'Sleep / Wake', click: () => menuSend('sleep-project') },
        { type: 'separator' },
        { label: 'Page Settings…', click: () => send('radial:toggle-page-settings') },
        { type: 'separator' },
        { label: 'Reveal in Finder', click: () => menuSend('reveal-project') },
        { label: 'Move Project…', click: () => menuSend('move-project') },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Radial Docs', click: () => { try { shell.openExternal('https://radial.to/docs'); } catch {} } },
      ],
    },
  ];
  function wireShortcutHints(items: AppMenuTemplateItem[]): void {
    for (const item of items) {
      if (item.submenu) wireShortcutHints(item.submenu);
      if (!item.id?.startsWith('shortcut-') || !item.click) continue;
      const run = item.click;
      item.click = (menuItem, win, event) => {
        run(menuItem, win, event);
        if (event?.triggeredByAccelerator === false) {
          send('shortcuts:used-menu', { id: item.id!.slice(9), binding: { label: menuItem.label, accelerator: menuItem.accelerator! } }); // item.id: checked above; every shortcut- item in the template above sets an accelerator
        }
      };
    }
  }
  wireShortcutHints(template);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  send('shortcuts:changed');
}

ipcMain.handle('shortcuts:get', (): Record<string, ShortcutBinding> => {
  const bindings: Record<string, ShortcutBinding> = {};
  function visit(menu: Menu | null | undefined): void {
    for (const item of menu?.items || []) {
      if (item.id?.startsWith('shortcut-') && item.accelerator && item.enabled) {
        bindings[item.id.slice(9)] = { label: item.label, accelerator: item.accelerator };
      }
      if (item.submenu) visit(item.submenu);
    }
  }
  visit(Menu.getApplicationMenu());
  return bindings;
});

// A window's options: as given, or in the e2e background mode made hidden and never throttled (shown with
// showInBackground once made).
const windowOptions = (options: BrowserWindowConstructorOptions): BrowserWindowConstructorOptions => (background ? backgroundWindowOptions(options) : options);

function createWindow(): void {
  mainWindow = new BrowserWindow(windowOptions({
    width: 1400,
    height: 900,
    title: 'Radial',
    // Glass sidebar: a transparent window background lets the macOS 'sidebar'
    // vibrancy show through any transparent region (the projects rail). Opaque
    // columns paint over it everywhere else. roundedCorners keeps the native
    // ~11px window squircle + shadow.
    backgroundColor: '#00000000',
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    roundedCorners: true,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 11, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  }));
  if (background) showInBackground(mainWindow);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
  // Surface renderer warnings/errors to the process log (helps debug far-from-devtools).
  // The event carries the details; its positional arguments are deprecated.
  mainWindow.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    if (level === 'warning' || level === 'error') console.log(`[renderer] ${message} (${String(sourceId).split('/').pop()}:${lineNumber})`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, d) => { console.log('[render-process-gone]', JSON.stringify(d)); }); // reported by processWatch

  // No traffic lights in fullscreen → the toolbar can use the full left edge.
  const notifyFs = (on: boolean) => send('radial:fullscreen', on);
  mainWindow.on('enter-full-screen', () => notifyFs(true));
  mainWindow.on('leave-full-screen', () => notifyFs(false));
  // Transition events alone drift out of sync: a renderer reload (dev auto-reload)
  // drops the class with no event to restore it, and returning from another Space
  // can leave it stale. Re-assert the *real* OS state on load + focus + show.
  const syncFs = () => notifyFs(mainWindow!.isFullScreen()); // the window's own events: it is still open
  mainWindow.webContents.on('did-finish-load', syncFs);
  mainWindow.on('focus', syncFs);
  mainWindow.on('focus', () => core.pullVercelCommentsOnFocus());
  mainWindow.on('show', syncFs);

  // Auto-open a repo passed via RADIAL_OPEN env var or as the last CLI arg.
  // The app's own path never counts: `electron .` puts the app dir in argv, and
  // debuggers (Playwright) shove their flags BEFORE it — so `.` can land past
  // slice(2) and would auto-open Radial's own source as a "project", shadowing
  // session restore (and its `start` script would spawn a second Radial).
  const appPath = app.getAppPath();
  const autoOpenRaw = process.env.RADIAL_OPEN ||
    process.argv.slice(2).filter((a) => !a.startsWith('-') && fs.existsSync(a) && path.resolve(a) !== appPath).join(',');
  if (autoOpenRaw && !process.env.RADIAL_SMOKE) {
    const paths = autoOpenRaw.split(',').map((p) => p.trim()).filter(Boolean);
    mainWindow.webContents.once('did-finish-load', () => {
      paths.forEach((p) => send('radial:auto-open', path.resolve(p)));
    });
  } else if (!process.env.RADIAL_SMOKE) {
    // Figma-style: reopen the projects that were open last time.
    const session = recents.getSession();
    if (session.open.length) {
      mainWindow.webContents.once('did-finish-load', () => {
        send('radial:restore-session', { ...session, crashed: recents.crashedLastRun() });
      });
    }
  }
  // A cold `radial <path>` launch: unlike the dev/test argv above, the CLI's
  // flag form ADDS to the restored session instead of replacing it — an agent
  // running `radial .` must not cost the user their open workspace. Queued
  // behind the restore-session send (registered above, .once before .on) so a
  // path that was already part of the session just gets its tab focused.
  for (const dir of cliOpen.parseOpenPaths(process.argv)) pendingOpenPaths.push(dir);
  mainWindow.webContents.on('did-finish-load', () => {
    for (const dir of pendingOpenPaths.splice(0)) send('radial:auto-open', dir);
  });

  if (process.env.RADIAL_SHOT) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try { fs.writeFileSync(process.env.RADIAL_SHOT!, (await mainWindow!.webContents.capturePage()).toPNG()); } catch (e) { console.error(e); } // set (checked above); a closed window throws into the catch
        app.quit();
      }, 9000);
    });
  }

  // Smoke-test hook: confirm the window boots and renderer loads, then exit.
  if (process.env.RADIAL_SMOKE) {
    const hardExit = setTimeout(() => { console.error('RADIAL_SMOKE: timed out'); process.exit(2); }, 20000);
    mainWindow.webContents.on('did-finish-load', () => {
      clearTimeout(hardExit);
      console.log('RADIAL_SMOKE: renderer loaded OK');
      setTimeout(() => app.quit(), 500);
    });
    mainWindow.webContents.on('render-process-gone', (_e, d) => {
      console.error('RADIAL_SMOKE: renderer gone', d);
      process.exit(1);
    });
  }
}

// Renderer edits can use the existing Electron process and existing project
// servers. Main-process edits need a clean relaunch to reload IPC handlers.
function reloadRendererForDevelopment(files: string[]): void {
  if (!mainWindow || mainWindow.isDestroyed() || devRestarting) return;
  const restoredSession = recents.getSession();
  console.log(`[dev-reload] Reloading renderer (${files.join(', ')})`);
  mainWindow.webContents.once('did-finish-load', () => {
    if (!restoredSession.open.length) return;
    send('radial:restore-session', { ...restoredSession, crashed: false });
  });
  mainWindow.webContents.reloadIgnoringCache();
}

async function restartForDevelopment(files: string[]): Promise<void> {
  if (devRestarting) return;
  devRestarting = true;
  console.log(`[dev-reload] Restarting Electron (${files.join(', ')})`);
  if (stopDevReload) { stopDevReload(); stopDevReload = null; }
  // Do this cleanup before exiting rather than leaving project servers or
  // terminal children behind for the relaunched process to inherit.
  try { await core.stopAll(); recents.markCleanExit(); } catch {}
  app.relaunch();
  app.exit(0);
}

// Compiles the changed source files into out/ with the repo's build script.
// It runs on the developer's Node (the build scripts are TypeScript, which
// Node 22.18+ runs directly; Electron's own Node is older).
function rebuildForDevelopment(rootDir: string, files: string[]): Promise<void> {
  const sources = files.map((f) => f.split(path.sep).join('/')).filter((f) => f.startsWith('src/')).map((f) => f.slice(4));
  if (!sources.length) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    execFile(which('node') || 'node', [path.join(rootDir, 'scripts', 'build.mts'), '--files', sources.join(',')], {
      cwd: rootDir, env: childEnv(), timeout: 60000,
    }, (error, _stdout, stderr) => (error ? reject(new Error(String(stderr || error.message).trim())) : resolve()));
  });
}

function startDevelopmentReload(): void {
  if (!devReload.enabled(app)) return;
  const rootDir = path.join(__dirname, '..', '..');
  stopDevReload = devReload.watchSources({
    rootDir,
    onReload: reloadRendererForDevelopment,
    onRestart: restartForDevelopment,
    rebuild: (files) => rebuildForDevelopment(rootDir, files),
  });
  console.log('[dev-reload] Watching src/ for changes, compiling them into out/ (set RADIAL_AUTO_RELOAD=0 to disable).');
}


// The window's contract, read as RadialIpc.X so these names can't collide with
// the imports at the top of the file. LooseUnion is src/core/types.ts's and
// PtyInfo is terminal.ts's, both imported there.
import type * as RadialIpc from '../shared/radialApi';
/**
 * collaboration:review's options as the handler reads them: one variable holds
 * whichever action's ReviewOptions came (radialApi's collaborationReview ties
 * them to the action, which a destructured parameter with a default can't
 * follow). A field only some actions send reads as possibly undefined; `number`
 * reads as a number, because every action that reads it (detail, review and
 * merge) sends it. 'list' sends nothing, and `{}` is the handler's default.
 */
type ReviewOptionsOfAnyAction = LooseUnion<RadialIpc.ReviewOptions['detail' | 'review' | 'merge']> | RadialIpc.ReviewOptions['list'];
/**
 * RADIAL_DEMO_FRESH's push status (DEMO_PUSH): its gh status has no user, which
 * radialApi's GhStatus always has (null when signed out). publish:checkAuth and
 * setup:check add it to their results until the contract lists it.
 */
type DemoPushAuth = Omit<RadialIpc.PushAuth, 'gh'> & { gh: Omit<RadialIpc.GhStatus, 'user'> };
/** The parts of CDP's Page.getLayoutMetrics answer shot:fullPage reads (the css* sizes are missing before Chrome 89). */
interface CdpLayoutMetrics {
  cssLayoutViewport?: { clientWidth: number; clientHeight: number };
  layoutViewport: { clientWidth: number; clientHeight: number };
  cssContentSize?: { height: number };
  contentSize: { height: number };
}

ipcMain.handle('session:suspend', async (_e, repoDir: ArgTo<'sleepProject', 0>): Promise<AnswerTo<'sleepProject'>> => core.suspendSession(repoDir));

ipcMain.handle('term:keepAwake', async (_e, { id, on }: PackedArgs<'termKeepAwake', ['id', 'on']>): Promise<AnswerTo<'termKeepAwake'>> => core.setKeepAwake(id, on));

// --- IPC ------------------------------------------------------------------

// What decides where each file picker opens (dialogFolders.ts): Electron 43+
// opens a picker without a defaultPath in ~/Downloads.
const folderDeps = (): FolderDeps => ({ projectsDir: recents.getProjectsDir(), workspaceRoot: github.workspaceRoot(), home: app.getPath('home') });

ipcMain.handle('dialog:openRepo', async (): Promise<AnswerTo<'openRepoDialog'>> => {
  // only the main window's preload invokes this, so the window is there
  const res = await dialog.showOpenDialog(mainWindow!, {
    title: 'Open a website project',
    defaultPath: projectsFolder(folderDeps()),
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('project:open', (_e, repoDir: ArgTo<'openProject', 0>, opts?: ArgTo<'openProject', 1>): Promise<AnswerTo<'openProject'>> => core.openProject(repoDir, opts));

ipcMain.handle('project:refresh', async (_e, repoDir: ArgTo<'projectRefresh', 0>, opts?: ArgTo<'projectRefresh', 1>): Promise<AnswerTo<'projectRefresh'>> => core.refreshProject(repoDir, opts || {}));
// Renderer-requested clean dev-server restart (degraded-watcher mode: after an
// agent turn edits files, HMR can't be trusted, so the server restarts).
ipcMain.handle('dev:restart', async (_e, repoDir: ArgTo<'devRestart', 0>, opts: NonNullable<ArgTo<'devRestart', 1>> | null): Promise<AnswerTo<'devRestart'>> => core.restartDevServer(repoDir, { via: (opts && opts.via) || 'app' }));

ipcMain.handle('recents:get', async (): Promise<AnswerTo<'recentsGet'>> => recents.snapshot());
ipcMain.on('recents:setFavicon', (_e, { repoDir, dataUrl }: PackedArgs<'recentsSetFavicon', ['repoDir', 'dataUrl']>) => recents.setFavicon(repoDir, dataUrl));
// Persist the set of open projects so we can reopen them next launch.
ipcMain.on('session:save', (_e, { open, active }: PackedArgs<'sessionSave', ['open', 'active']>) => recents.setSession(open, active));
// Esc in the renderer leaves native fullscreen.
ipcMain.on('window:exitFullscreen', () => { if (mainWindow && mainWindow.isFullScreen()) mainWindow.setFullScreen(false); });
// Installed Claude Code skills + slash commands, for the composer's / menu.
ipcMain.handle('skills:list', async (_e, repoDir: ArgTo<'skillsList', 0>): Promise<AnswerTo<'skillsList'>> => { try { return (require('./skills') as typeof import('./skills')).list(repoDir); } catch { return []; } });
ipcMain.handle('skills:install', async (_e, { repoDir, scope, paths }: PackedArgs<'skillsInstall', ['repoDir', 'scope', 'paths']>): Promise<AnswerTo<'skillsInstall'>> => { try { return await (require('./skills') as typeof import('./skills')).install(repoDir, scope, paths); } catch (e) { return { installed: [], errors: [(e as Error).message] }; } });
// Per-project state (agent chat transcript, composer draft) — persists across sessions.
// (projectState types launchCheck as unknown: it is runLaunchCheck's scan. Every
// preview view the window has saved has every field projectState.ts's PreviewView
// requires: readThreadPreview has set them all since per-agent previews arrived in
// 0.35.0, see recordSleptAgents; threadPreview.ts leaves them optional for a field added later.)
ipcMain.handle('state:get', async (_e, repoDir: ArgTo<'stateGet', 0>): Promise<AnswerTo<'stateGet'>> => projectState.get(repoDir) as RadialIpc.ProjectState);
ipcMain.on('state:save', (_e, { repoDir, patch }: PackedArgs<'stateSave', ['repoDir', 'patch']>) => projectState.set(repoDir, patch as import('./projectState').ProjectState));
// The scan runLaunchCheck stored (projectState keeps it as unknown).
ipcMain.handle('launchCheck:get', async (_e, repoDir: ArgTo<'launchCheckGet', 0>): Promise<AnswerTo<'launchCheckGet'>> => ((projectState.get(repoDir) || {}).launchCheck as RadialIpc.LaunchCheckScan | undefined) || null);
ipcMain.handle('launchCheck:run', async (_e, repoDir: ArgTo<'launchCheckRun', 0>): Promise<AnswerTo<'launchCheckRun'>> => core.runLaunchCheck(repoDir, 'ui'));
ipcMain.handle('recents:remove', async (_e, repoPath: ArgTo<'recentsRemove', 0>): Promise<AnswerTo<'recentsRemove'>> => { recents.removeRecent(repoPath); buildMenu(); return recents.snapshot(); });
ipcMain.handle('recents:setProjectsDir', async (): Promise<AnswerTo<'recentsSetProjectsDir'>> => {
  // only the main window's preload invokes this, so the window is there
  const res = await dialog.showOpenDialog(mainWindow!, {
    title: 'Choose a folder that holds your website projects',
    defaultPath: projectsFolder(folderDeps()),
    properties: ['openDirectory'],
  });
  if (!res.canceled && res.filePaths.length) recents.setProjectsDir(res.filePaths[0]);
  return recents.snapshot();
});

// --- New Project — scaffold a net-new site from a baseline ---------------
// (plans/new-project-from-baseline.md). Official create CLIs for Next/Astro;
// built-in starter for plain HTML. The result opens via the normal pipeline.
ipcMain.handle('newProject:info', async (): Promise<AnswerTo<'newProjectInfo'>> => ({
  templates: newProject.TEMPLATES,
  npmAvailable: !!which('npm'),
  defaultParent: recents.getProjectsDir() || github.workspaceRoot(),
}));
ipcMain.handle('newProject:create', async (_e, { templateId, name, parentDir, github: gh }: ArgTo<'newProjectCreate', 0>): Promise<AnswerTo<'newProjectCreate'>> =>
  core.createNewProject({ templateId, name, parentDir, github: gh }, (line) => { send('newProject:log', line); send('log', `[new-project] ${line}`); }));
// The migration engine, and the PNG decode and encode its compare takes (Electron's nativeImage).
const migrate = require('./migrate') as typeof import('./migrate');
const migrateDecode: import('./migrate').CompareSiteOptions['decode'] = (png) => { const img = nativeImage.createFromBuffer(png); const { width, height } = img.getSize(); return { width, height, data: img.toBitmap() }; };
const migrateEncode: import('./migrate').CompareSiteOptions['encode'] = ({ width, height, data }) => nativeImage.createFromBitmap(data, { width, height }).toPNG();
// The Home wizard: check an address, prepare (with progress lines), launch.
ipcMain.handle('migrate:check', async (_e, url: ArgTo<'migrateCheck', 0>): Promise<AnswerTo<'migrateCheck'>> => {
  try { const s = await (require('./migrate/capture') as typeof import('./migrate/capture')).resolveSite(url); return { ok: true, url: s.url, host: s.host, platform: s.platform }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
});
ipcMain.handle('migrate:prepare', (_e, opts: ArgTo<'migratePrepare', 0>): Promise<AnswerTo<'migratePrepare'>> => core.migratePrepare(opts || {}, (line) => send('migrate:progress', line)));
ipcMain.handle('migrate:launch', (_e, prep: ArgTo<'migrateLaunch', 0>): Promise<AnswerTo<'migrateLaunch'>> => core.migrateLaunch(prep || {}));
ipcMain.handle('migrate:pickFiles', async (): Promise<AnswerTo<'migratePickFiles'>> => {
  const r = await dialog.showOpenDialog(mainWindow!, { title: 'Add files from your site', message: 'CMS exports, logos, fonts, brand guidelines, copy docs: anything that helps.', defaultPath: lastUsedFolder(recents.getFilesDir(), folderDeps()), properties: ['openFile', 'openDirectory', 'multiSelections'] }); // only the main window's preload invokes this, so the window is there
  if (r.canceled || !r.filePaths.length) return [];
  recents.setFilesDir(path.dirname(r.filePaths[0])); // the folder this pick came from: the next one opens there
  return r.filePaths;
});

// gh readiness + owner list for the wizard's GitHub checkbox (lazy — fetched
// after the modal opens so ⌘N never waits on the network).
ipcMain.handle('newProject:ghOptions', async (): Promise<AnswerTo<'newProjectGhOptions'>> => {
  if (DEMO_FRESH) return { available: false, reason: 'no-gh' };
  const r = await github.listOwners().catch(() => null);
  if (!r || !r.ok) return { available: false, reason: (r && r.reason) || 'error' };
  return { available: true, user: r.user, owners: [r.user, ...(r.orgs || [])].filter(Boolean) };
});

ipcMain.handle('telemetry:get', async (): Promise<AnswerTo<'telemetryGet'>> => ({ enabled: telemetry.isEnabled(), available: telemetry.isAvailable() }));
ipcMain.handle('telemetry:set', async (_e, on: ArgTo<'telemetrySet', 0>): Promise<AnswerTo<'telemetrySet'>> => telemetry.setEnabled(!!on));
// Terminal bell → the system alert sound. Claude Code rings BEL when an agent
// finishes or needs attention; xterm 5+ parses it but plays nothing, which is
// how the "agent finished" ding silently vanished for anyone who moved from
// Terminal.app into Radial. shell.beep() respects the user's chosen alert
// sound and volume. Renderer throttles; this is fire-and-forget.
ipcMain.on('term:bell', () => { try { (require('electron') as typeof import('electron')).shell.beep(); } catch {} });
// Adjust steppers: an apply batch went to the agent / its checkpoint was
// reverted. Only the tweak count crosses; the closed vocabulary is here.
ipcMain.on('telemetry:adjust', (_e, p: PackedArgs<'telemetryAdjust', ['kind', 'tweaks', 'direct']>) => {
  const kind = p && p.kind;
  if (kind === 'applied') telemetry.capture('adjust_applied', { tweaks: Number(p.tweaks) || 0, direct: !!p.direct });
  else if (kind === 'undo') telemetry.capture('adjust_undo');
});
// Panels menu checkmarks + saved-layout names follow the renderer's state.
// The menu only REBUILDS when the layout list changes (save/delete); plain
// open/close updates just flip checkmarks on the existing items.
ipcMain.on('radial:panels-state', (_e, payload: LooseUnion<ArgTo<'panelsState', 0>>) => {
  const openIds = Array.isArray(payload) ? payload : ((payload && payload.open) || []);
  const layouts = (payload && Array.isArray(payload.layouts)) ? payload.layouts : panelLayoutNames;
  if (JSON.stringify(layouts) !== JSON.stringify(panelLayoutNames)) {
    panelLayoutNames = layouts.slice();
    buildMenu();
  }
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  ['adjust', 'type', 'content', 'color', 'motion', 'inspect', 'variants', 'image', 'a11y', 'layers', 'page', 'reconcile', 'draw', 'comments', 'pages', 'designref', 'context', 'history', 'terminal', 'publish'].forEach((id) => {
    const item = menu.getMenuItemById('panel-' + id);
    if (item) item.checked = openIds.includes(id);
  });
});
// The window's uncaught errors and unhandled rejections arrive here
// (windowErrors.ts), from the app's own window only: a preview's page isn't
// isolated from its preload, so a site could send one. errorReport names and
// locates them, and enforces the allowlist and the dedupe.
ipcMain.on('radial:app-error', (e, p: ArgTo<'reportError', 0>) => { if (!mainWindow || e.sender !== mainWindow.webContents) return; try { errorReport.reportWindow(p); } catch {} });

ipcMain.handle('publish:linkState', (_e, repoDir: ArgTo<'publishLinkState', 0>): Promise<AnswerTo<'publishLinkState'>> => core.vercelLinkState(repoDir));

ipcMain.handle('vercel:projectInfo', (_e, repoDir: ArgTo<'vercelProjectInfo', 0>): Promise<AnswerTo<'vercelProjectInfo'>> => core.vercelProjectInfo(repoDir));
ipcMain.on('newProject:cancel', () => newProject.cancel());
ipcMain.handle('newProject:chooseParent', async (): Promise<AnswerTo<'newProjectChooseParent'>> => {
  // only the main window's preload invokes this, so the window is there
  const res = await dialog.showOpenDialog(mainWindow!, {
    title: 'Choose where to create the project',
    defaultPath: projectsFolder(folderDeps()),
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

// Onboarding preview (RADIAL_DEMO_FRESH=1, the core's DEMO_FRESH, which new
// projects read too): pretend this is a fresh machine (no gh, no Claude, not
// signed in) so the setup and onboarding UI can be seen without uninstalling tools.
const { DEMO_FRESH } = core;
const DEMO_AGENT = { ok: false, hasCli: false, hasNode: true };
const DEMO_PUSH: DemoPushAuth = { isRepo: true, hasRemote: false, remote: null, ready: false, status: 'no-remote',
  hint: 'No “origin” remote yet. Add your GitHub repo URL to publish.', gh: { installed: false, authed: false } };

// GitHub workspaces (your account + orgs) and their repos, for the home browser.
ipcMain.handle('github:owners', async (): Promise<AnswerTo<'githubOwners'>> => DEMO_FRESH ? { ok: false, reason: 'no-gh' } : github.listOwners());
ipcMain.handle('github:list', async (_e, owner?: ArgTo<'githubListRepos', 0>): Promise<AnswerTo<'githubListRepos'>> => DEMO_FRESH ? { ok: false, reason: 'no-gh' } : github.listRepos(owner || ''));

const projectLibrary = require('./projectLibrary') as typeof import('./projectLibrary');
const libraryPaths = () => ({ knownPaths: [...recents.listRecents().map((r: import('./recents').RecentProject) => r.path), ...recents.getSession().open], extraRoots: [recents.getProjectsDir()].filter(Boolean) });
ipcMain.handle('library:repos', (_e, owner?: ArgTo<'libraryRepos', 0>): Promise<AnswerTo<'libraryRepos'>> => projectLibrary.accessibleRepos(owner || ''));
ipcMain.handle('library:statuses', (_e, dirs: ArgTo<'libraryStatuses', 0>): Promise<AnswerTo<'libraryStatuses'>> => projectLibrary.statuses(dirs));
ipcMain.handle('library:status', (_e, { dir, fetch }: PackedArgs<'libraryStatus', ['dir', 'fetch']> & { fetch: boolean }): Promise<AnswerTo<'libraryStatus'>> => projectLibrary.status(dir, { fetch }));
ipcMain.handle('library:copies', (_e, url: ArgTo<'libraryCopies', 0>): Promise<AnswerTo<'libraryCopies'>> => projectLibrary.copies(url, libraryPaths()));
ipcMain.handle('library:update', (_e, { dir, expected }: PackedArgs<'libraryUpdate', ['dir', 'expected']>): Promise<AnswerTo<'libraryUpdate'>> => projectLibrary.update(dir, expected));
// The preload sends { url, localPath }; a bare URL string is accepted too.
ipcMain.handle('github:open', async (_e, input: string | PackedArgs<'openGitHub', ['url', 'localPath']>): Promise<AnswerTo<'openGitHub'>> => {
  const { url, localPath } = typeof input === 'string' ? { url: input } : input;
  try {
    if (!github.repoIdent(url)) return { ok: false, error: 'Enter a GitHub repository URL.' };
    if (localPath) {
      if ((await (require('./githubReview') as typeof import('./githubReview')).slug(localPath))?.toLowerCase() !== github.repoIdent(url)) return { ok: false, error: 'This local copy is now connected to a different repository. Check its connection before opening.' };
      const opened = await core.openRepo(localPath);
      if (opened.ok) opened.github = { action: 'reused-local', localPath };
      return opened;
    }
    const copies = await projectLibrary.copies(url, libraryPaths());
    if (copies.length > 1) return { ok: false, reason: 'choose-copy', copies, url };
    if (copies.length === 1) {
      const opened = await core.openRepo(copies[0].dir);
      if (opened.ok) opened.github = { action: 'reused-local', localPath: copies[0].dir };
      return opened;
    }
    const result = await github.cloneOrPull(url, github.workspaceRoot(), (line: string) => send('log', line), { update: false });
    const opened = await core.openRepo(result.dir);
    if (opened.ok) opened.github = { action: result.action, dirty: result.dirty, defaultBranch: result.defaultBranch };
    return opened;
  } catch (error) { return { ok: false, error: (error as Error).message }; }
});

// Connect a local (often non-git) folder to GitHub: create a new repo from it,
// or push it to an existing one. Both init git + a first commit as needed.
ipcMain.handle('github:createRepo', async (_e, { repoDir, owner, name, isPrivate }: ArgTo<'ghCreateRepo', 0>): Promise<AnswerTo<'ghCreateRepo'>> => {
  if (DEMO_FRESH) return { ok: false, reason: 'no-gh', error: 'GitHub isn’t available in demo mode.' };
  return github.createRepo({ dir: repoDir, owner, name, isPrivate });
});
// Demo mode answers reason 'no-gh', which radialApi's ConnectRepoResult doesn't
// list (CreateRepoResult does, and the window's connect flow tests for it), so
// the result adds it here until the contract does.
ipcMain.handle('github:connectExisting', async (_e, { repoDir, url }: ArgTo<'ghConnectExisting', 0>): Promise<AnswerTo<'ghConnectExisting'> | { ok: false; reason: 'no-gh'; error: string }> => {
  if (DEMO_FRESH) return { ok: false, reason: 'no-gh', error: 'GitHub isn’t available in demo mode.' };
  return github.connectExisting({ dir: repoDir, url });
});


// ── Userland tool provisioning ─────────────────────────────────────────────
// For a Mac missing a tool (Node when a project won't start; the installers
// also cover Claude Code, gh and git). No sudo, no Homebrew, no terminal.
const toolsDir = () => path.join(app.getPath('userData'), 'tools');
function toolsLog(line: string): void { try { send('tools:log', String(line)); } catch {} }

ipcMain.handle('tools:install', async (_e, { kind }: PackedArgs<'toolsInstall', ['kind']>): Promise<AnswerTo<'toolsInstall'>> => {
  if (kind === 'claude') {
    const r = await provision.claudeInstall({ onLog: toolsLog });
    if (r.ok) telemetry.capture('tool_provisioned', { kind: 'claude' });
    return r;
  }
  if (kind === 'gh') {
    const r = await provision.ghInstall({ onLog: toolsLog });
    if (r.ok) telemetry.capture('tool_provisioned', { kind: 'gh' });
    return r;
  }
  if (kind === 'node') {
    const r = await provision.nodeInstall({ toolsDir: toolsDir(), onLog: toolsLog });
    if (r.ok) {
      registerExtraBin(r.binDir);
      telemetry.capture('tool_provisioned', { kind: 'node' });
    }
    return r;
  }
  return { ok: false, error: 'unknown tool' };
});

// Drive `gh auth login --web` for the user: we run it in a hidden PTY, put
// the one-time code on their clipboard, and wire git's credential helper on
// success (so the private-repo clone works). gh opens github.com/login/device
// ITSELF once the driver presses Enter — opening it here too made two tabs.
ipcMain.handle('tools:ghAuth', async (): Promise<AnswerTo<'toolsGhAuth'>> => {
  const r = await provision.ghAuthLogin({
    onLog: toolsLog,
    onCode: (code: string, url: string) => {
      // clipboard.writeText returns a promise (Electron 44): a copy that fails
      // rejects instead of throwing. The window shows the code either way.
      clipboard.writeText(code).catch(() => {});
      try { send('tools:ghCode', { code, url }); } catch {}
    },
  });
  if (r.ok) telemetry.capture('tool_provisioned', { kind: 'gh-auth' });
  return r;
});

// A working git via Apple's own Command Line Tools installer: we fire the
// system dialog (Apple owns the download, no sudo from us) and poll until
// git answers for real. Cancelling the dialog becomes an honest failure.
ipcMain.handle('tools:gitEnsure', async (): Promise<AnswerTo<'toolsGitEnsure'>> => {
  const r = await provision.cltInstall({ onLog: toolsLog });
  if (r.ok && !r.already) telemetry.capture('tool_provisioned', { kind: 'clt' });
  return r;
});

// Drive Claude Code's own first-run sign-in in a hidden PTY. The CLI opens
// the browser itself and its localhost callback finishes the OAuth exchange,
// so normally the user just clicks Approve. Success = the credential landing
// (agent.checkAuth), never screen text. If the callback is blocked and the
// CLI asks for a pasted code, tools:claudePaste tells the renderer to show
// an input; tools:claudeAuthInput feeds it back. tools:claudeUrl carries the
// sign-in URL as a user-clickable fallback — never auto-opened, the CLI
// already opened one tab and two is worse than a link.
let claudeAuthSession: import('./tools').ClaudeAuthSession | null = null;
ipcMain.handle('tools:claudeAuth', async (): Promise<AnswerTo<'toolsClaudeAuth'>> => {
  if (claudeAuthSession) return { ok: false, error: 'A Claude sign-in is already running.' };
  try { if (agent.checkAuth().ok) return { ok: true, already: true }; } catch {}
  claudeAuthSession = provision.claudeAuthLogin({
    onLog: toolsLog,
    authed: () => { try { return !!agent.checkAuth().ok; } catch { return false; } },
    claudeBin: claudeBin() || undefined,
    onUrl: (url: string) => { try { send('tools:claudeUrl', { url }); } catch {} },
    onPasteNeeded: () => { try { send('tools:claudePaste', {}); } catch {} },
  });
  const r = await claudeAuthSession.done;
  claudeAuthSession = null;
  if (r.ok) telemetry.capture('tool_provisioned', { kind: 'claude-auth' });
  return r;
});
ipcMain.handle('tools:claudeAuthInput', async (_e, { text }: PackedArgs<'toolsClaudeAuthInput', ['text']>): Promise<AnswerTo<'toolsClaudeAuthInput'>> => {
  if (!claudeAuthSession) return { ok: false, error: 'no sign-in running' };
  claudeAuthSession.write(String(text || ''));
  return { ok: true };
});


// A previously provisioned Node survives restarts — put it back on the child
// PATH at boot (its dir only exists if tools:install ran on this machine).
function registerProvisionedTools(): void {
  try {
    const bin = path.join(toolsDir(), 'node-current', 'bin');
    if (fs.existsSync(bin)) registerExtraBin(bin);
  } catch {}
}


ipcMain.handle('app:isDev', (): AnswerTo<'appIsDev'> => !app.isPackaged);

// Vercel — instant preview deploys (the working tree, uncommitted edits included)
// and CLI/auth status. Production still goes through git-push (Vercel's git
// integration builds it). Auth is the user's own `vercel login`.
ipcMain.handle('vercel:status', (_e, repoDir?: ArgTo<'vercelStatus', 0>): Promise<AnswerTo<'vercelStatus'>> => core.vercelStatus(repoDir));
ipcMain.handle('vercel:deploy', async (_e, { repoDir, prod, scope }: ArgTo<'vercelDeploy', 0>): Promise<AnswerTo<'vercelDeploy'>> => {
  if (DEMO_FRESH) return { ok: false, reason: 'no-cli', error: 'Vercel isn’t available in demo mode.' };
  return vercel.deploy(repoDir, { prod: !!prod, scope });
});
ipcMain.handle('vercel:deployAlt', (_e, args: ArgTo<'vercelDeployAlt', 0>): Promise<AnswerTo<'vercelDeployAlt'>> => core.vercelDeployStaging(args));
ipcMain.handle('vercel:projects', (_e, opts: ArgTo<'vercelProjects', 0>): Promise<AnswerTo<'vercelProjects'>> => (require('./hostingProjects') as typeof import('./hostingProjects')).projects(opts));
ipcMain.handle('vercel:linkExisting', (_e, { repoDir, ...opts }: ArgTo<'vercelLinkExisting', 0>): Promise<AnswerTo<'vercelLinkExisting'>> => publish.withRepoLock(repoDir, () => (require('./hostingProjects') as typeof import('./hostingProjects')).link(repoDir, opts)));
ipcMain.handle('vercel:scopes', async (): Promise<AnswerTo<'vercelScopes'>> => DEMO_FRESH ? { ok: false, reason: 'no-cli', scopes: [] } : vercel.listScopes());
ipcMain.handle('vercel:connect', (_e, args: ArgTo<'vercelConnect', 0>): Promise<AnswerTo<'vercelConnect'>> => core.vercelConnect(args));

ipcMain.handle('project:status', async (_e, repoDir: ArgTo<'getStatus', 0>): Promise<AnswerTo<'getStatus'>> => {
  return publish.status(repoDir);
});

ipcMain.handle('project:pages', (_e, repoDir: ArgTo<'getPages', 0>): Promise<AnswerTo<'getPages'>> => core.listPages(repoDir));

ipcMain.handle('history:undo', async (): Promise<AnswerTo<'historyUndo'>> => { core.doUndo(); return { ok: true }; });
ipcMain.handle('history:redo', async (): Promise<AnswerTo<'historyRedo'>> => { core.doRedo(); return { ok: true }; });
ipcMain.handle('history:jumpTo', async (_e, { repoDir, applied }: PackedArgs<'historyJumpTo', ['repoDir', 'applied']>): Promise<AnswerTo<'historyJumpTo'>> => { core.jumpTo(repoDir, applied); return { ok: true }; });
ipcMain.handle('history:latest', (_e, repoDir: ArgTo<'historyLatest', 0>): Promise<AnswerTo<'historyLatest'>> => core.jumpToLatest(repoDir));
ipcMain.handle('history:revertHere', async (_e, repoDir: ArgTo<'historyRevertHere', 0>): Promise<AnswerTo<'historyRevertHere'>> => { core.revertHere(repoDir); return { ok: true }; });

ipcMain.handle('session:setActive', (_e, repoDir: ArgTo<'setActive', 0>): Promise<AnswerTo<'setActive'>> => core.setActive(repoDir));

ipcMain.handle('project:close', async (_e, repoDir: ArgTo<'closeProject', 0>): Promise<AnswerTo<'closeProject'>> => {
  await core.stopSession(repoDir);
  return { ok: true };
});

// Move a project's working copy (core.moveProject); the window asks where to.
ipcMain.handle('project:move', (_e, repoDir: ArgTo<'moveProject', 0>): Promise<AnswerTo<'moveProject'>> => core.moveProject(repoDir, async () => {
  // only the main window's preload invokes this, so the window is there
  const pick = await dialog.showOpenDialog(mainWindow!, {
    title: 'Move project',
    message: `Choose the folder to move “${path.basename(repoDir)}” into`,
    defaultPath: besideProject(repoDir, folderDeps()),
    properties: ['openDirectory', 'createDirectory'],
  });
  return pick.canceled || !pick.filePaths[0] ? null : pick.filePaths[0];
}));

ipcMain.handle('edit:applyText', (_e, { repoDir, edit }: PackedArgs<'applyTextEdit', ['repoDir', 'edit']>): Promise<AnswerTo<'applyTextEdit'>> => core.applyTextEdit(repoDir, edit));

ipcMain.handle('edit:insertElement', (_e, { repoDir, spec }: PackedArgs<'insertElement', ['repoDir', 'spec']>): Promise<AnswerTo<'insertElement'>> => core.insertElement(repoDir, spec));
ipcMain.handle('edit:moveElement', (_e, { repoDir, spec }: PackedArgs<'moveElement', ['repoDir', 'spec']>): Promise<AnswerTo<'moveElement'>> => core.moveElement(repoDir, spec));
ipcMain.handle('edit:removeElement', (_e, { repoDir, spec }: PackedArgs<'removeElement', ['repoDir', 'spec']>): Promise<AnswerTo<'removeElement'>> => core.removeElement(repoDir, spec));
ipcMain.handle('edit:wrapElement', (_e, { repoDir, spec }: PackedArgs<'wrapElement', ['repoDir', 'spec']>): Promise<AnswerTo<'wrapElement'>> => core.wrapElement(repoDir, spec));
ipcMain.handle('edit:unwrapElement', (_e, { repoDir, spec }: PackedArgs<'unwrapElement', ['repoDir', 'spec']>): Promise<AnswerTo<'unwrapElement'>> => core.unwrapElement(repoDir, spec));

ipcMain.handle('edit:applyStyle', (_e, { repoDir, plans, context }: PackedArgs<'applyStyleEdit', ['repoDir', 'plans', 'context']>): Promise<AnswerTo<'applyStyleEdit'>> => core.applyStyleEdit(repoDir, plans, context));

ipcMain.handle('meta:addTag', (_e, { repoDir, relFile, snippet }: PackedArgs<'metaAddTag', ['repoDir', 'relFile', 'snippet']>): Promise<AnswerTo<'metaAddTag'>> => core.metaAddTag(repoDir, relFile, snippet));

ipcMain.handle('meta:setTagValue', (_e, { repoDir, args }: PackedArgs<'metaSetTagValue', ['repoDir', 'args']>): Promise<AnswerTo<'metaSetTagValue'>> => core.metaSetTagValue(repoDir, args));

ipcMain.handle('edit:applyImage', async (_e, { repoDir, oldSrc }: PackedArgs<'applyImageEdit', ['repoDir', 'oldSrc']>): Promise<AnswerTo<'applyImageEdit'>> => {
  // only the main window's preload invokes this, so the window is there
  const res = await dialog.showOpenDialog(mainWindow!, {
    title: 'Choose a replacement image',
    defaultPath: imagesFolder(repoDir, folderDeps()),
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif'] }],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, reason: 'cancelled' };
  return core.swapImageFile(repoDir, oldSrc, res.filePaths[0]);
});
ipcMain.handle('publish', async (_e, { repoDir, opts }: PackedArgs<'publish', ['repoDir', 'opts']>): Promise<AnswerTo<'publish'>> => core.publishPlain(repoDir, opts));
// ── Version history IPC ─────────────────────────────────────────────────────
ipcMain.handle('moments:list', async (_e, repoDir: ArgTo<'momentsList', 0>): Promise<AnswerTo<'momentsList'>> => {
  const res: import('./moments').MomentListWithoutPreview & { previewing?: boolean } = moments.list(repoDir);
  res.previewing = await moments.isPreviewing(repoDir);
  return res as RadialIpc.MomentList; // with previewing just set
});
ipcMain.handle('moments:preview', async (_e, { repoDir, id }: PackedArgs<'momentsPreview', ['repoDir', 'id']>): Promise<AnswerTo<'momentsPreview'>> => moments.preview(repoDir, id));
ipcMain.handle('moments:backToNow', async (_e, repoDir: ArgTo<'momentsBackToNow', 0>): Promise<AnswerTo<'momentsBackToNow'>> => moments.backToNow(repoDir));
ipcMain.handle('moments:restore', async (_e, { repoDir, id }: PackedArgs<'momentsRestore', ['repoDir', 'id']>): Promise<AnswerTo<'momentsRestore'>> => {
  const res = await moments.restore(repoDir, id);
  core.notifyMomentCreated(repoDir, res);
  return res;
});
ipcMain.handle('moments:saveThumb', async (_e, { repoDir, id, dataUrl }: PackedArgs<'momentsSaveThumb', ['repoDir', 'id', 'dataUrl']>): Promise<AnswerTo<'momentsSaveThumb'>> => moments.saveThumb(repoDir, id, dataUrl));
// A small picture of a preview. Capturing in the window shipped the full-size
// bitmap (~20 MB on a Retina screen) through this process: 150-300 ms during
// which every terminal stalled. Shrunk here, only a few KB cross over.
ipcMain.handle('preview:thumbnail', async (_e, { webContentsId, width }: PackedArgs<'previewThumbnail', ['webContentsId', 'width']>): Promise<AnswerTo<'previewThumbnail'>> => {
  const wc = webContents.fromId(Number(webContentsId));
  if (!wc || wc.isDestroyed()) return null;
  const img = await wc.capturePage();
  if (!img || img.isEmpty()) return null;
  return img.resize({ width: Math.max(64, Math.min(800, Number(width) || 360)), quality: 'good' }).toDataURL();
});
// The adjust pill's safety pair: record a checkpoint of the tree BEFORE the
// agent writes a stepper tweak, and one-click revert back to that exact tree.
ipcMain.handle('moments:record', async (_e, { repoDir, kind, label }: PackedArgs<'momentsRecord', ['repoDir', 'kind', 'label']>): Promise<AnswerTo<'momentsRecord'>> => {
  const res = await moments.record(repoDir, { kind, label });
  core.notifyMomentCreated(repoDir, res);
  return res;
});
ipcMain.handle('moments:revertTo', async (_e, { repoDir, id, label }: PackedArgs<'momentsRevertTo', ['repoDir', 'id', 'label']>): Promise<AnswerTo<'momentsRevertTo'>> => {
  const res = await moments.revertTo(repoDir, id, label);
  core.notifyMomentCreated(repoDir, res);
  return res;
});

// Read the publish config + current remote, for the Publish settings UI.
ipcMain.handle('config:get', async (_e, repoDir: ArgTo<'configGet', 0>): Promise<AnswerTo<'configGet'>> => {
  const config = publish.readConfig(repoDir);
  return {
    config,
    remote: await publish.getRemote(repoDir),
    isRepo: publish.isGitRepo(repoDir),
    // The branch a staging publish would actually use (config may defer to the
    // branch you're currently on) — so the UI shows the real target.
    effectiveStaging: await publish.resolveEditBranchName(repoDir, config),
  };
});

ipcMain.handle('config:set', (_e, { repoDir, config, remote }: PackedArgs<'configSet', ['repoDir', 'config', 'remote']>): Promise<AnswerTo<'configSet'>> => core.configSet(repoDir, config, remote));

// Can this machine actually push to origin? Read-only credential probe so a
// tester learns about a broken GitHub connection before editing, not at publish.
ipcMain.handle('publish:checkAuth', async (_e, repoDir: ArgTo<'checkPushAuth', 0>): Promise<AnswerTo<'checkPushAuth'> | DemoPushAuth> => DEMO_FRESH ? DEMO_PUSH : publish.checkPushAuth(repoDir));

// One-click wire-up: make git use the gh login for credentials.
ipcMain.handle('gh:setupGit', async (): Promise<AnswerTo<'ghSetupGit'>> => publish.ghSetupGit());

// Branch switcher (preview): list branches + check one out.
ipcMain.handle('branch:list', async (_e, repoDir: ArgTo<'branchList', 0>): Promise<AnswerTo<'branchList'>> => publish.listBranches(repoDir));
ipcMain.handle('branch:switch', async (_e, { repoDir, name, opts }: PackedArgs<'branchSwitch', ['repoDir', 'name', 'opts']>): Promise<AnswerTo<'branchSwitch'>> => publish.switchBranch(repoDir, name, opts || {}));
ipcMain.handle('branch:pull', async (_e, repoDir: ArgTo<'branchPull', 0>): Promise<AnswerTo<'branchPull'>> => publish.pull(repoDir));

// Sync with the remote (someone/another tool pushed new commits).
ipcMain.handle('sync:status', async (_e, repoDir: ArgTo<'syncStatus', 0>): Promise<AnswerTo<'syncStatus'>> => {
  const state = await publish.syncStatus(repoDir);
  return { ...state, files: state.changes, changes: Array.isArray(state.changes) ? state.changes.length : null };
});
const collaborationService = require('./collaboration') as typeof import('./collaboration');
const repositoryService = require('./repository') as typeof import('./repository');
const integrationService = require('./integration') as typeof import('./integration');
const githubReviewService = require('./githubReview') as typeof import('./githubReview');
ipcMain.handle('collaboration:state', (_e, { repoDir, opts }: PackedArgs<'collaborationState', ['repoDir', 'opts']>): Promise<AnswerTo<'collaborationState'>> => collaborationService.state(repoDir, opts));
ipcMain.handle('collaboration:plan', (_e, { repoDir, opts }: PackedArgs<'collaborationPlan', ['repoDir', 'opts']>): Promise<AnswerTo<'collaborationPlan'>> => collaborationService.plan(repoDir, opts));
ipcMain.handle('collaboration:diff', (_e, { repoDir, file, staged }: PackedArgs<'collaborationDiff', ['repoDir', 'file', 'staged']>): Promise<AnswerTo<'collaborationDiff'>> => repositoryService.fileDiff(repoDir, file, staged));
ipcMain.handle('collaboration:branch', (_e, { repoDir, opts }: PackedArgs<'collaborationBranch', ['repoDir', 'opts']>): Promise<AnswerTo<'collaborationBranch'>> => collaborationService.createBranch(repoDir, opts));
ipcMain.handle('collaboration:conflicts', (_e, repoDir: ArgTo<'collaborationConflicts', 0>): Promise<AnswerTo<'collaborationConflicts'>> => integrationService.conflicts(repoDir));
ipcMain.handle('collaboration:abort', (_e, repoDir: ArgTo<'collaborationAbort', 0>): Promise<AnswerTo<'collaborationAbort'>> => publish.abortSync(repoDir));
ipcMain.handle('collaboration:deployment', async (_e, { repoDir, receipt }: PackedArgs<'collaborationDeployment', ['repoDir', 'receipt']>): Promise<AnswerTo<'collaborationDeployment'>> => collaborationService.deployment(repoDir, receipt || await publish.publishReceipt(repoDir)));
ipcMain.handle('collaboration:review', async (_e, { repoDir, action, opts = {} }: { repoDir: ArgTo<'collaborationReview', 0>; action: ArgTo<'collaborationReview', 1>; opts?: ReviewOptionsOfAnyAction }): Promise<AnswerTo<'collaborationReview'>> => {
  const name = await githubReviewService.slug(repoDir);
  if (!name) return { ok: false, error: 'Connect your GitHub account and a github.com origin to review pull requests.' };
  if (action === 'list') return githubReviewService.list(name);
  if (action === 'detail') return githubReviewService.detail(name, Number(opts.number));
  // The review and merge casts: the window sends the action's own options (radialApi's collaborationReview ties them to the action).
  if (action === 'review') return githubReviewService.review(name, opts as RadialIpc.ReviewOptions['review']);
  if (action === 'merge') {
    if (opts.expectedRemote !== undefined && opts.expectedRemote !== await publish.getRemote(repoDir)) return { ok: false, error: 'The GitHub repository changed. Refresh before merging.' };
    if (opts.expectedDeployment) {
      const host = await collaborationService.hosting(repoDir);
      const deployment = collaborationService.destination(host, opts.branch!, name); // the window sends the PR's base with every merge (collaboration.ts and publishWorkflow.ts), though radialApi's ReviewOptions['merge'] keeps branch optional
      const effect = { state: deployment.state, production: !!deployment.production, projectId: host.projectId || null, orgId: host.orgId || null };
      if (JSON.stringify(effect) !== JSON.stringify(opts.expectedDeployment)) return { ok: false, error: 'The deployment destination changed. Refresh before merging.' };
    }
    const result = await githubReviewService.merge(name, opts as RadialIpc.ReviewOptions['merge']);
    if (result.ok) {
      const file = await repositoryService.gitPath(repoDir, 'radial-publish.json');
      const receipt: RadialIpc.MergeReceipt = { ...result, at: Date.now(), pushed: true, mode: 'merge', prNumber: opts.number, remote: await publish.getRemote(repoDir) };
      fs.writeFileSync(file, JSON.stringify(receipt));
      return receipt;
    }
    return result;
  }
  return { ok: false, error: 'Unknown review action.' };
});
// Design tokens: the project's CSS custom properties from its authored
// stylesheets (tokens.js), and an in-place write to one declaration that
// lands in the same undo history as every panel edit.
ipcMain.handle('tokens:index', async (_e, repoDir: ArgTo<'tokensIndex', 0>): Promise<AnswerTo<'tokensIndex'>> => { try { return tokens.indexTokens(repoDir); } catch (e) { return { ok: false, error: (e as Error).message, tokens: [] }; } });
ipcMain.handle('tokens:set', (_e, { repoDir, ...set }: { repoDir: ArgTo<'tokensSet', 0> } & Partial<NonNullable<ArgTo<'tokensSet', 1>>>): Promise<AnswerTo<'tokensSet'>> => core.tokensSet(repoDir, set));
ipcMain.handle('sync:incoming', async (_e, repoDir: ArgTo<'syncIncoming', 0>): Promise<AnswerTo<'syncIncoming'>> => publish.incomingCommits(repoDir));
// The preload sends { repoDir, opts }; a bare folder string is accepted too.
ipcMain.handle('sync:run', async (_e, arg: string | PackedArgs<'syncRun', ['repoDir', 'opts']>): Promise<AnswerTo<'syncRun'>> => typeof arg === 'string' ? publish.sync(arg) : publish.sync(arg.repoDir, arg.opts));
ipcMain.handle('sync:resolve', async (_e, { repoDir, strategy }: PackedArgs<'syncResolve', ['repoDir', 'strategy']>): Promise<AnswerTo<'syncResolve'>> => publish.resolveSync(repoDir, strategy));
ipcMain.handle('sync:finalize', async (_e, repoDir: ArgTo<'syncFinalize', 0>): Promise<AnswerTo<'syncFinalize'>> => publish.finalizeSync(repoDir));

// Unified "are you set up to use Radial?" probe — git/node/npm presence, the
// GitHub push connection, and the available coding-agent logins — so the UI can guide a
// new tester through anything missing in one place.
ipcMain.handle('setup:check', async (_e, repoDir?: ArgTo<'setupCheck', 0>): Promise<AnswerTo<'setupCheck'> | (Omit<AnswerTo<'setupCheck'>, 'push'> & { push: DemoPushAuth | null })> => {
  if (DEMO_FRESH) {
    // Fresh machine: node/npm/git present (you need them to run), but no gh,
    // no coding agent — Homebrew present so the one-click install path shows.
    return {
      tools: { git: true, node: true, npm: true, gh: false, claude: false, codex: false, brew: true, vercel: false },
      push: repoDir ? DEMO_PUSH : null,
      agent: DEMO_AGENT,
      codex: { ok: false, hasCli: false, hasNode: true },
      vercel: { installed: false, authed: false, user: null },
    };
  }
  const tools = {
    git: !!which('git'),
    node: !!which('node'),
    npm: !!which('npm'),
    gh: !!which('gh'),
    claude: !!which('claude'),
    codex: !!which('codex'),
    brew: !!which('brew'), // gates the one-click "install with Homebrew" path
    vercel: !!which('vercel'), // enables one-click preview/production deploys
  };
  const push = repoDir ? await publish.checkPushAuth(repoDir) : null;
  const agentAuth = agent.checkAuth();
  const codexAuth = codex.checkAuth();
  const vercelStatus = await vercel.cliStatus();
  return { tools, push, agent: agentAuth, codex: codexAuth, vercel: vercelStatus };
});

// Update the native window background at runtime (matches the light/dark theme,
// so the rounded corners + resize gutter don't flash the wrong color).
// Keep the View-menu checkbox in step with the renderer's persisted layout.
ipcMain.on('app:chromeLayout', (_e, mode: ArgTo<'chromeLayoutChanged', 0>) => {
  try { const mi = Menu.getApplicationMenu()!.getMenuItemById('chrome-strip'); if (mi) mi.checked = mode !== 'classic'; } catch {} // buildMenu runs before createWindow, so the menu is set
});
ipcMain.handle('app:setWindowBg', async (_e, color: ArgTo<'setWindowBg', 0>): Promise<AnswerTo<'setWindowBg'>> => {
  // Keep the window transparent so the sidebar vibrancy stays visible — an
  // opaque theme color would paint over the glass. (Body bg handles the theme.)
  try { if (mainWindow) mainWindow.setBackgroundColor('#00000000'); } catch {}
  return { ok: true };
});

// Open an https link in the user's default browser (e.g. tool download pages).
ipcMain.handle('app:openExternal', async (_e, url: ArgTo<'openExternal', 0>): Promise<AnswerTo<'openExternal'>> => {
  try { if (/^https?:\/\//i.test(url)) { await shell.openExternal(url); return { ok: true }; } }
  catch (e) { return { ok: false, error: (e as Error).message }; }
  return { ok: false, error: 'blocked' };
});

// ── Code panel: read-only source locate + "open in your editor" ───────────────
// The design-engineer "dig in" surface. locateElement reuses the text-edit
// finder to map a clicked element to its authored source (and its CSS rule);
// openInEditor jumps there via the editor's URL scheme. We use the scheme, not
// `code`/`cursor` on PATH, because a packaged GUI app inherits a stripped PATH
// (the same reason git/CLI lookups here go through absolute paths). Cursor + VS
// Code today; falls back to the OS default text editor.
ipcMain.handle('code:resolveSource', async (_e, { repoDir, sel }: PackedArgs<'codeResolveSource', ['repoDir', 'sel']>): Promise<AnswerTo<'codeResolveSource'>> => {
  try { return editEngine.locateElement(repoDir, sel || {}); }
  catch (e) { return { ok: false, reason: 'error', error: (e as Error).message }; }
});

ipcMain.handle('code:openInEditor', async (_e, { repoDir, relFile, line, col }: ArgTo<'codeOpenInEditor', 0>): Promise<AnswerTo<'codeOpenInEditor'>> => {
  try {
    if (!repoDir || !relFile) return { ok: false, error: 'no-target' };
    const file = path.join(repoDir, relFile);
    if (!fs.existsSync(file)) return { ok: false, error: 'missing' };
    return await openInEditor(file, Math.max(1, line || 1), Math.max(1, col || 1));
  } catch (e) { return { ok: false, error: (e as Error).message }; }
});

function detectEditor(): { name: Exclude<RadialIpc.EditorName, 'default'>; scheme: string } | null {
  const os = require('os') as typeof import('os');
  const dirs = ['/Applications', path.join(os.homedir(), 'Applications')];
  const has = (app: string) => dirs.some((d) => { try { return fs.existsSync(path.join(d, app)); } catch { return false; } });
  if (has('Cursor.app')) return { name: 'Cursor', scheme: 'cursor' };
  if (has('Visual Studio Code.app')) return { name: 'VS Code', scheme: 'vscode' };
  if (has('VSCodium.app')) return { name: 'VSCodium', scheme: 'vscodium' };
  return null;
}

async function openInEditor(file: string, line: number, col: number): Promise<RadialIpc.OpenInEditorResult> {
  const ed = detectEditor();
  if (ed) {
    // <scheme>://file<abs-path>:<line>:<col> — needs no PATH. Spaces encoded;
    // the colons/slashes stay literal so the editor parses the line target.
    const url = `${ed.scheme}://file${encodeURI(file)}:${line}:${col}`;
    try { await shell.openExternal(url); return { ok: true, editor: ed.name }; } catch {}
  }
  // No known editor (or the scheme failed): OS default text editor, then default app.
  // In the e2e background mode neither opens: shell.openPath's stand-in logs it.
  const openedText = !background && await new Promise<boolean>((res) => { try { execFile('open', ['-t', file], (err) => res(!err)); } catch { res(false); } });
  if (openedText) return { ok: true, editor: 'default' };
  try { await shell.openPath(file); return { ok: true, editor: 'default' }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

// Pre-warm a route: a background GET so the dev server compiles it (Next.js dev
// compiles per-route on first visit) before the user actually clicks it. The
// renderer only records a route as warm after this reports success, which lets
// it retry after a server restart or transient failure.
ipcMain.handle('preview:prewarm', async (_e, rawUrl: ArgTo<'prewarm', 0>): Promise<AnswerTo<'prewarm'>> => new Promise((resolve) => {
  let url: URL;
  try { url = new URL(rawUrl); } catch { resolve({ ok: false }); return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { resolve({ ok: false }); return; }
  const client = url.protocol === 'https:' ? https : http;
  let done = false;
  const finish = (result: AnswerTo<'prewarm'>) => { if (!done) { done = true; resolve(result); } };
  try {
    const req = client.get(url, (res: import('http').IncomingMessage) => {
      res.resume();
      res.once('end', () => finish({ ok: res.statusCode! >= 200 && res.statusCode! < 400 })); // a client response always has its status
    });
    req.once('error', () => finish({ ok: false }));
    req.setTimeout(8000, () => { req.destroy(); finish({ ok: false }); });
  } catch { finish({ ok: false }); }
}));

// App + environment info for the Settings page (version, runtime, data dir).
// projectData's existingFiles is a string[] holding only the names radialApi lists.
ipcMain.handle('projectData:get', (_e, repoDir?: ArgTo<'projectDataGet', 0>): AnswerTo<'projectDataGet'> => projectData.status(repoDir || null) as RadialIpc.ProjectStorageStatus);
ipcMain.handle('projectData:set', (_e, patch: ArgTo<'projectDataSet', 0>): AnswerTo<'projectDataSet'> => {
  try { return { ok: true, ...(projectData.set(patch) as RadialIpc.ProjectStorageStatus) }; }
  catch (error) { return { ok: false, error: (error as Error).message }; }
});
ipcMain.handle('projectData:reveal', (_e, repoDir?: ArgTo<'projectDataReveal', 0>): AnswerTo<'projectDataReveal'> => {
  const folder = projectData.status(repoDir || null).folder!; // set once projectData.init ran, at startup
  fs.mkdirSync(folder, { recursive: true });
  shell.openPath(folder);
});
ipcMain.handle('app:info', async (): Promise<AnswerTo<'appInfo'>> => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  platform: `${process.platform} ${process.arch}`,
  userData: app.getPath('userData'),
  // Dev flavor only (electron .) — the renderer gates in-progress UI on this
  // so packaged builds keep shipping the current layout.
  dev: !app.isPackaged,
}));

// Pre-publish build check (deterministic — no AI). Runs the repo's build script
// and reports pass/fail + output, so a broken site never goes live.
ipcMain.handle('preflight:run', async (_e, repoDir: ArgTo<'preflightRun', 0>): Promise<AnswerTo<'preflightRun'>> => {
  let hasBuild = false;
  try {
    const pkg: import('./devServer').PackageJson = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
    hasBuild = !!(pkg.scripts && pkg.scripts.build);
  } catch {}
  if (!hasBuild) return { ok: true, skipped: true };

  const buildLog = (line: string) => send('log', `[build] ${line}`);
  return new Promise((resolve) => {
    const child = spawn(which('npm') || 'npm', ['run', 'build'], {
      cwd: repoDir,
      env: childEnv({ FORCE_COLOR: '0', CI: '1' }),
      shell: process.platform === 'win32',
    });
    let out = '';
    const onData = (b: Buffer) => {
      const s = b.toString();
      out += s;
      if (out.length > 30000) out = out.slice(-30000);
      s.split(/\r?\n/).forEach((l) => l.trim() && buildLog(l));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, output: out + '\n[radial] build timed out after 240s' }); }, 240000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: (out + '\n' + e.message).slice(-5000) }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out.slice(-5000) }); });
  });
});

// --- terminals ------------------------------------------------------------

ipcMain.handle('term:start', (_e, payload: TermStartPayload): Promise<AnswerTo<'termStart'>> => core.startTerminal(payload));
// Drop a slept agent's record without relaunching it (the × on its rail row).
ipcMain.handle('term:discardSlept', async (_e, { repoDir, sleptId }: PackedArgs<'termDiscardSlept', ['repoDir', 'sleptId']>): Promise<AnswerTo<'termDiscardSlept'>> => { core.discardSleptRecord(repoDir, sleptId); return { ok: true }; });
ipcMain.handle('term:renameSlept', (_e, { repoDir, sleptId, label }: PackedArgs<'termRenameSlept', ['repoDir', 'sleptId', 'label']>): AnswerTo<'termRenameSlept'> => {
  const sleptAgents: StoredSleptAgent[] = projectState.get(repoDir).sleptAgents || [];
  const record = sleptAgents.find(agent => agent.id === sleptId);
  if (!record || typeof label !== 'string' || !label.trim()) return { ok: false };
  record.label = label.trim(); record.labelSource = 'manual';
  projectState.set(repoDir, { sleptAgents });
  return { ok: true };
});
ipcMain.handle('term:pinSlept', (_e, { repoDir, sleptId, pinnedAt }: PackedArgs<'termPinSlept', ['repoDir', 'sleptId', 'pinnedAt']>): AnswerTo<'termPinSlept'> => {
  const sleptAgents: StoredSleptAgent[] = projectState.get(repoDir).sleptAgents || [];
  const record = sleptAgents.find(agent => agent.id === sleptId);
  if (!record) return { ok: false };
  record.recentPinnedAt = Number.isFinite(pinnedAt) && pinnedAt > 0 ? pinnedAt : 0;
  projectState.set(repoDir, { sleptAgents });
  return { ok: true };
});
// Terminals still alive in the daemon for this project (after an app restart),
// so the renderer can reattach to each and replay its scrollback.
// (A pty's meta is what the window stored there, which terminal.ts types more
// loosely than radialApi: its preview's viewportMode is any string, not a ViewportMode.)
ipcMain.handle('term:list', async (_e, repoDir: ArgTo<'termList', 0>): Promise<AnswerTo<'termList'>> => terminal.list(repoDir) as Promise<RadialIpc.PtyInfo[]>);
// Reattach to a live daemon terminal: replays buffered output, then streams live.
ipcMain.on('term:attach', (_e, id: ArgTo<'termAttach', 0>) => terminal.attach(id));
// Persist an updated label (rename / auto-name) into the daemon's pty meta.
// (The cast asserts terminal.ts's stricter preview, whose scroll is required: the
// window's meta.preview always carries one, since readThreadPreview and
// routeAgentUrl's route-change spread both set it.)
ipcMain.on('term:setMeta', (_e, { id, meta }: PackedArgs<'termSetMeta', ['id', 'meta']>) => terminal.setMeta(id, meta as import('./terminal').PtyMeta));
// Which agent CLIs are installed, so the terminal can offer to launch them.
ipcMain.handle('engine:available', async (): Promise<AnswerTo<'engineAvailable'>> => engine.available());
// Inject Radial's visual context (comments, selected elements, a screenshot path)
// into a running engine terminal as a bracketed paste, so a multi-line prompt
// lands cleanly in the real CLI's input without submitting line-by-line, and
// never into a CLI asking a question of its own (enginePaste.ts).
const pasteIntoEngine = enginePaster({
  accepts: (id) => nativeChat?.acceptsTerminalInput(id) !== false,
  asking: (id, typed) => core.sessionAsking(id, typed),
  record: (id, text) => nativeChat?.recordTerminalInput(id, text),
  write: (id, data) => terminal.write(id, data),
  pasteSequence: (text) => engine.pasteSequence(text),
});
ipcMain.on('engine:paste', (_e, { id, text, submit }: PackedArgs<'enginePaste', ['id', 'text', 'submit']>) => { void pasteIntoEngine(id, text, !!submit); });
ipcMain.handle('term:asking', (_e, { id, typed }: PackedArgs<'termAsking', ['id', 'typed']>): Promise<AnswerTo<'termAsking'>> => core.sessionAsking(id, typed));

ipcMain.on('term:input', (_e, { id, data }: PackedArgs<'termInput', ['id', 'data']>) => { if (nativeChat?.acceptsTerminalInput(id, data) !== false) { terminal.write(id, data); nativeChat?.recordTerminalInput(id, data); } }); // the key first, bookkeeping after
ipcMain.on('term:resize', (_e, { id, cols, rows }: PackedArgs<'termResize', ['id', 'cols', 'rows']>) => { nativeChat?.terminalResize(id, cols, rows); terminal.resize(id, cols, rows); });
ipcMain.handle('term:kill', async (_e, id: ArgTo<'termKill', 0>): Promise<AnswerTo<'termKill'>> => { terminal.kill(id); return { ok: true }; });

ipcMain.handle('publish:deploy', async (_e, { repoDir, opts }: PackedArgs<'publishDeploy', ['repoDir', 'opts']>): Promise<AnswerTo<'publishDeploy'>> => core.publishDeploy(repoDir, opts || {}, {
  onEvent: (payload) => send('publish:event', { repoDir, ...payload }),
}));
// Auto-commit toggle (per project, persisted, default OFF — it changes git history).
ipcMain.handle('autoCommit:get', async (_e, repoDir: ArgTo<'autoCommitGet', 0>): Promise<AnswerTo<'autoCommitGet'>> => ({ on: core.autoCommitEnabled(repoDir) }));
ipcMain.handle('autoCommit:set', async (_e, { repoDir, on }: PackedArgs<'autoCommitSet', ['repoDir', 'on']>): Promise<AnswerTo<'autoCommitSet'>> => { try { projectState.set(repoDir, { autoCommit: !!on }); } catch {} return { ok: true, on: !!on }; });
// Manual "commit now" (force, bypasses the min-interval) — for the chip's click.
ipcMain.handle('autoCommit:now', async (_e, repoDir: ArgTo<'autoCommitNow', 0>): Promise<AnswerTo<'autoCommitNow'>> => publish.autoCommit(repoDir, { force: true }));
// --- Design references (Figma) ---------------------------------------------
// Lightweight pointers only: link + node id + role + label per page, stored in
// .radial.json and injected into every agent session (engine.contextFor). The
// agent pulls the design itself via the Figma MCP — no snapshot pipeline here.

const designErr = (e: NodeJS.ErrnoException) => ({ ok: false, code: e.code || 'InvalidFigmaUrl', message: e.message || String(e) });


ipcMain.handle('pages:setHidden', (_e, { repoDir, routes, files }: PackedArgs<'pagesSetHidden', ['repoDir', 'routes', 'files']>): Promise<AnswerTo<'pagesSetHidden'>> => core.setHiddenPages(repoDir, routes, files));

ipcMain.handle('pages:setGroups', (_e, { repoDir, groups }: PackedArgs<'pagesSetGroups', ['repoDir', 'groups']>): Promise<AnswerTo<'pagesSetGroups'>> => core.setPageGroups(repoDir, groups));

// Context files (markdown notes/docs that live with the project, not the site).
ipcMain.handle('context:list', async (_e, repoDir: ArgTo<'contextList', 0>): Promise<AnswerTo<'contextList'>> => { const l = context.list(repoDir); try { projectMemory.syncContextIndex(repoDir, l, references.list(repoDir)); } catch {} return l; });
ipcMain.handle('context:read', async (_e, { repoDir, rel }: PackedArgs<'contextRead', ['repoDir', 'rel']>): Promise<AnswerTo<'contextRead'>> => context.read(repoDir, rel));
ipcMain.handle('context:write', async (_e, { repoDir, rel, content }: PackedArgs<'contextWrite', ['repoDir', 'rel', 'content']>): Promise<AnswerTo<'contextWrite'>> => { const r = context.write(repoDir, rel, content); core.syncCtxIndex(repoDir); return r; });
ipcMain.handle('context:create', async (_e, { repoDir, name }: PackedArgs<'contextCreate', ['repoDir', 'name']>): Promise<AnswerTo<'contextCreate'>> => {
  const res = context.create(repoDir, name);
  try { context.ensureCommitted(repoDir); } catch {}
  core.syncCtxIndex(repoDir);
  return res;
});
// Per-file local override: keep just this file out of the repo (gitignored).
ipcMain.handle('context:setLocal', async (_e, { repoDir, rel, local }: PackedArgs<'contextSetLocal', ['repoDir', 'rel', 'local']>): Promise<AnswerTo<'contextSetLocal'>> => {
  const res = context.setLocal(repoDir, rel, !!local);
  // Going local: untrack it so it leaves the repo on the next commit.
  if (local && !projectData.isLocal(repoDir)) { try { await publish.git(repoDir, ['rm', '--cached', '--ignore-unmatch', `.context/${rel}`]); } catch {} }
  core.syncCtxIndex(repoDir); // local flips move files in/out of the shared index
  return res;
});
ipcMain.handle('context:rename', async (_e, { repoDir, rel, name }: PackedArgs<'contextRename', ['repoDir', 'rel', 'name']>): Promise<AnswerTo<'contextRename'>> => { const r = context.rename(repoDir, rel, name); core.syncCtxIndex(repoDir); return r; });
ipcMain.handle('context:delete', async (_e, { repoDir, rel }: PackedArgs<'contextDelete', ['repoDir', 'rel']>): Promise<AnswerTo<'contextDelete'>> => { const r = context.remove(repoDir, rel); core.syncCtxIndex(repoDir); return r; });
// Project memory / agent rules (AGENTS.md) — read, edit, and quick-add a rule.
ipcMain.handle('memory:get', async (_e, repoDir: ArgTo<'memoryGet', 0>): Promise<AnswerTo<'memoryGet'>> => ({ exists: projectMemory.exists(repoDir), content: projectMemory.read(repoDir), local: projectData.isLocal(repoDir), abs: projectMemory.agentsPath(repoDir) }));
ipcMain.handle('memory:write', async (_e, { repoDir, content }: PackedArgs<'memoryWrite', ['repoDir', 'content']>): Promise<AnswerTo<'memoryWrite'>> => { projectMemory.ensure(repoDir); (require('fs') as typeof import('fs')).writeFileSync(projectMemory.agentsPath(repoDir), content == null ? '' : String(content), 'utf8'); return { ok: true }; });
ipcMain.handle('memory:addRule', async (_e, { repoDir, text }: PackedArgs<'memoryAddRule', ['repoDir', 'text']>): Promise<AnswerTo<'memoryAddRule'>> => projectMemory.addRule(repoDir, text));
// Drag-and-drop import: copy any dropped files into .context/.
ipcMain.handle('context:import', async (_e, { repoDir, paths }: PackedArgs<'contextImport', ['repoDir', 'paths']>): Promise<AnswerTo<'contextImport'>> => { const r = context.importFiles(repoDir, paths); core.syncCtxIndex(repoDir); return r; });
// Paste import: write clipboard bytes (a pasted screenshot) into .context/.
ipcMain.handle('context:importBytes', async (_e, { repoDir, name, bytes }: PackedArgs<'contextImportBytes', ['repoDir', 'name', 'bytes']>): Promise<AnswerTo<'contextImportBytes'>> => { const r = context.importBytes(repoDir, name, bytes); core.syncCtxIndex(repoDir); return r; });
// Absolute path of a context file — lets the renderer preview images via file://.
ipcMain.handle('context:absPath', async (_e, { repoDir, rel }: PackedArgs<'contextAbsPath', ['repoDir', 'rel']>): Promise<AnswerTo<'contextAbsPath'>> => ({ abs: context.absPath(repoDir, rel) }));
// Reveal a non-text context file in Finder (it can't open in the markdown viewer).
ipcMain.handle('context:reveal', async (_e, { repoDir, rel }: PackedArgs<'contextReveal', ['repoDir', 'rel']>): Promise<AnswerTo<'contextReveal'>> => {
  const abs = context.absPath(repoDir, rel);
  if (abs) shell.showItemInFolder(abs);
  return { ok: !!abs };
});

// Open a project's working folder in Finder/Explorer (project settings).
ipcMain.handle('project:revealFolder', async (_e, repoDir: ArgTo<'revealFolder', 0>): Promise<AnswerTo<'revealFolder'>> => {
  if (repoDir && fs.existsSync(repoDir)) { shell.openPath(repoDir); return { ok: true }; }
  return { ok: false };
});

// Project references — URL pointers (GitHub repos, docs, any page) stored in
// .radial.json and injected into every agent session (engine.contextFor). The
// agent pulls each source itself — no cloning or fetching on Radial's side.
ipcMain.handle('refs:list', async (_e, repoDir: ArgTo<'refsList', 0>): Promise<AnswerTo<'refsList'>> => references.list(repoDir));
ipcMain.handle('refs:add', async (_e, { repoDir, url }: PackedArgs<'refsAdd', ['repoDir', 'url']>): Promise<AnswerTo<'refsAdd'>> => {
  try { const ref = references.add(repoDir, url); core.syncCtxIndex(repoDir); return { ok: true, ref }; }
  catch (e) { return { ok: false, error: (e as Error).message || String(e) }; }
});
ipcMain.handle('refs:remove', async (_e, { repoDir, url }: PackedArgs<'refsRemove', ['repoDir', 'url']>): Promise<AnswerTo<'refsRemove'>> => { const ok = references.remove(repoDir, url); core.syncCtxIndex(repoDir); return { ok }; });

// Review comments (pinned to a page + element). These answer comments as
// comments.json stores them (comments.ts StoredComment), whose attachments are
// the downloaded copies, not the { url, name } radialApi's ReviewComment declares.
// (The contract is the one that's off: nothing in the window reads a review
// comment's attachments. Once radialApi declares them as comments.ts's
// StoredCommentAttachment, comments:list, add and update take AnswerTo and ArgTo.)
ipcMain.handle('comments:list', async (_e, repoDir: ArgTo<'commentsList', 0>): Promise<import('./comments').StoredComment[]> => comments.list(repoDir));
ipcMain.handle('comments:vercelStatus', async (_e, repoDir: ArgTo<'commentsVercelStatus', 0>): Promise<AnswerTo<'commentsVercelStatus'>> => core.vcStatus(repoDir));
ipcMain.handle('comments:vercelPull', async (_e, { repoDir }: PackedArgs<'commentsVercelPull', ['repoDir']>): Promise<AnswerTo<'commentsVercelPull'>> => core.pullVercelComments(repoDir, { manual: true }));
ipcMain.handle('comments:add', async (_e, { repoDir, comment }: PackedArgs<'commentsAdd', ['repoDir', 'comment']>): Promise<import('./comments').StoredComment | import('./comments').CommentsRefusal> => comments.add(repoDir, comment));
ipcMain.handle('comments:importImage', async (_e, { repoDir, srcPath }: PackedArgs<'commentsImportImage', ['repoDir', 'srcPath']>): Promise<AnswerTo<'commentsImportImage'>> => comments.importImage(repoDir, srcPath));
ipcMain.handle('comments:saveImage', async (_e, { repoDir, name, bytes }: PackedArgs<'commentsSaveImage', ['repoDir', 'name', 'bytes']>): Promise<AnswerTo<'commentsSaveImage'>> => comments.saveImage(repoDir, name, bytes));

// Full-page screenshot of the preview webview: CDP Page.captureScreenshot with
// captureBeyondViewport takes the whole scroll height in ONE shot (no
// stitching), and a device-metrics override pins deviceScaleFactor to 2 so the
// export is 2x on any display. Saves to ~/Downloads.
ipcMain.handle('shot:fullPage', async (_e, { wcId, name }: PackedArgs<'fullPageShot', ['wcId', 'name']>): Promise<AnswerTo<'fullPageShot'>> => {
  const wc = webContents.fromId(wcId);
  if (!wc) return { ok: false, error: 'preview not found' };
  const dbg = wc.debugger;
  let attached = false;
  try {
    dbg.attach('1.3');
    attached = true;
    const metrics: CdpLayoutMetrics = await dbg.sendCommand('Page.getLayoutMetrics');
    const layout = metrics.cssLayoutViewport || metrics.layoutViewport;
    const content = metrics.cssContentSize || metrics.contentSize;
    // Keep the CSS viewport width (media queries unchanged); only bump the
    // scale factor. GPU texture limit ≈16384px — drop to 1x before clipping.
    const scale = Math.ceil(content.height) * 2 <= 16000 ? 2 : 1;
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: Math.ceil(layout.clientWidth),
      height: Math.ceil(layout.clientHeight),
      deviceScaleFactor: scale,
      mobile: false,
    });
    const shot: { data: string } = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await dbg.sendCommand('Emulation.clearDeviceMetricsOverride');
    const dir = app.getPath('downloads');
    let safe = (name || 'page').replace(/[^a-zA-Z0-9._@-]/g, '-');
    let abs = path.join(dir, safe + '.png');
    for (let i = 2; fs.existsSync(abs); i++) abs = path.join(dir, `${safe}-${i}.png`);
    fs.writeFileSync(abs, Buffer.from(shot.data, 'base64'));
    return { ok: true, path: abs, scale };
  } catch (e) {
    return { ok: false, error: String((e && (e as Error).message) || e) };
  } finally {
    if (attached) { try { dbg.detach(); } catch (e) {} }
  }
});

// Save a pasted/dropped image into .radial/pasted/ so the agent can Read it (by
// path) and the terminal can reference it. Scratch — gitignored, never deployed.
ipcMain.handle('media:savePasted', async (_e, { repoDir, name, bytes }: PackedArgs<'savePastedImage', ['repoDir', 'name', 'bytes']>): Promise<AnswerTo<'savePastedImage'>> => {
  try {
    const dir = projectData.dataDir(repoDir, 'pasted');
    fs.mkdirSync(dir, { recursive: true });
    let safe = (name || 'pasted.png').replace(/[^a-zA-Z0-9._-]/g, '-');
    if (!/\.[a-z0-9]+$/i.test(safe)) safe += '.png';
    const ext = path.extname(safe); const base = safe.slice(0, -ext.length);
    let fname = safe, i = 2;
    while (fs.existsSync(path.join(dir, fname))) { fname = `${base}-${i}${ext}`; i++; }
    const abs = path.join(dir, fname);
    fs.writeFileSync(abs, Buffer.from(bytes));
    // Keep scratch out of git and deploys.
    const ensure = (file: string, line: string) => {
      let c = ''; try { c = fs.readFileSync(file, 'utf8'); } catch {}
      if (c.split(/\r?\n/).some((l) => l.trim() === line)) return;
      fs.writeFileSync(file, c + (c && !c.endsWith('\n') ? '\n' : '') + line + '\n');
    };
    if (!projectData.isLocal(repoDir)) {
      try { ensure(path.join(repoDir, '.gitignore'), '.radial/pasted/'); } catch {}
      try { ensure(path.join(repoDir, '.vercelignore'), '.radial/'); } catch {}
    }
    return { ok: true, abs, rel: projectData.reference(repoDir, abs) };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
});
ipcMain.handle('comments:update', async (_e, { repoDir, id, patch }: PackedArgs<'commentsUpdate', ['repoDir', 'id']> & { patch: Partial<import('./comments').StoredComment> }): Promise<import('./comments').StoredComment | import('./comments').CommentsRefusal | null> => comments.update(repoDir, id, patch));
ipcMain.handle('comments:remove', async (_e, { repoDir, id }: PackedArgs<'commentsRemove', ['repoDir', 'id']>): Promise<AnswerTo<'commentsRemove'>> => comments.remove(repoDir, id));

ipcMain.handle('agent:checkAuth', async (): Promise<AnswerTo<'agentCheckAuth'>> => DEMO_FRESH
  ? { claude: DEMO_AGENT, codex: { ok: false, hasCli: false, hasNode: true }, cursor: { ok: false, hasCli: false, hasNode: true } }
  : { claude: agent.checkAuth(), codex: codex.checkAuth(), cursor: cursor.checkAuth() });
ipcMain.handle('agent:suggestMeta', async (_e, { repoDir, context }: PackedArgs<'agentSuggestMeta', ['repoDir', 'context']>): Promise<AnswerTo<'agentSuggestMeta'>> => agent.suggestMeta(repoDir, context));
ipcMain.handle('agent:suggestAlt', async (_e, { repoDir, context }: PackedArgs<'agentSuggestAlt', ['repoDir', 'context']>): Promise<AnswerTo<'agentSuggestAlt'>> => agent.suggestAlt(repoDir, context));
ipcMain.handle('agent:commitMessage', async (_e, repoDir: ArgTo<'agentCommitMessage', 0>): Promise<AnswerTo<'agentCommitMessage'>> => agent.suggestCommitMessage(repoDir));
ipcMain.handle('agent:enhanceRule', async (_e, { repoDir, text }: PackedArgs<'agentEnhanceRule', ['repoDir', 'text']>): Promise<AnswerTo<'agentEnhanceRule'>> => agent.enhanceRule(repoDir, text));
ipcMain.handle('agent:auditRule', async (_e, { repoDir, text }: PackedArgs<'agentAuditRule', ['repoDir', 'text']>): Promise<AnswerTo<'agentAuditRule'>> => agent.auditRule(repoDir, text));

// Generic: pick a local image, copy it into the site, return the URL path.
// The renderer then writes it into the chosen meta field (edit or add).
ipcMain.handle('meta:pickImage', async (_e, { repoDir, absolute }: PackedArgs<'metaPickImage', ['repoDir', 'absolute']>): Promise<AnswerTo<'metaPickImage'>> => {
  // only the main window's preload invokes this, so the window is there
  const res = await dialog.showOpenDialog(mainWindow!, {
    title: 'Choose an image',
    defaultPath: imagesFolder(repoDir, folderDeps()),
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'ico', 'avif'] }],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, reason: 'cancelled' };
  const chosen = res.filePaths[0];
  const publicDir = fs.existsSync(path.join(repoDir, 'public')) ? path.join(repoDir, 'public') : repoDir;
  const destName = path.basename(chosen).replace(/\s+/g, '-');
  try { fs.copyFileSync(chosen, path.join(publicDir, destName)); } catch (e) { return { ok: false, reason: 'copy-failed', message: (e as Error).message }; }

  let newSrc = '/' + destName;
  let relative = false;
  if (absolute) {
    const site = core.getSiteUrl(repoDir);
    if (site) newSrc = site + '/' + destName;
    else relative = true; // no known site URL — fell back to a relative path
  }
  return { ok: true, newSrc, relative };
});

ipcMain.handle('meta:setSiteUrl', async (_e, { repoDir, url }: PackedArgs<'metaSetSiteUrl', ['repoDir', 'url']>): Promise<AnswerTo<'metaSetSiteUrl'>> => {
  publish.writeConfig(repoDir, { siteUrl: (url || '').replace(/\/$/, '') });
  return { ok: true, siteUrl: core.getSiteUrl(repoDir) };
});

// Cmd/Ctrl+R refreshes the live PREVIEW only — never the Radial UI itself. We
// intercept it on every web-contents (the host window AND each preview webview,
// whichever has focus) so it behaves identically wherever the cursor is, and the
// host renderer can never get force-reloaded out from under your work.
app.on('web-contents-created', (_e, contents) => {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (mod && !input.shift && !input.alt && (input.key === 'r' || input.key === 'R')) {
      event.preventDefault();
      menuSend('reload-preview'); // → renderer reloads the active tab's webview
    }
  });

  // The app window never opens child windows or leaves its own page. A link in
  // a chat reply (target=_blank, ⌘-click, middle-click) or a terminal belongs in
  // the default browser; Electron's default would open a bare Radial window, and
  // a plain link click would swap the whole UI for the site.
  // Only Radial's own pages (file:) are guarded; a hidden window that renders a
  // live site for migration screenshots keeps its own redirects and popups closed.
  if (contents.getType && contents.getType() === 'window') {
    const appPage = () => contents.getURL().startsWith('file:');
    contents.setWindowOpenHandler(({ url }) => {
      try { if (appPage() && /^https?:\/\//i.test(url)) shell.openExternal(url); } catch {}
      return { action: 'deny' };
    });
    contents.on('will-navigate', (ev, url) => {
      if (!appPage() || url.split(/[?#]/)[0] === contents.getURL().split(/[?#]/)[0]) return; // reloading the app page itself
      ev.preventDefault();
      try { if (/^https?:\/\//i.test(url)) shell.openExternal(url); } catch {}
    });
  }

  // Preview <webview> is privileged (sandbox=no, contextIsolation=no, overlay
  // preload). Checking only the URL we hand to loadURL is NOT enough — a permitted
  // dev page could redirect or pop up to an external origin and inherit that
  // preload. Enforce at the navigation boundary. The threat is a NON-loopback
  // origin inheriting the preload; other local dev servers (a redirect to a
  // different localhost port, or localhost↔127.0.0.1) are the same trust level
  // as the preview, so allow those — only bounce non-loopback origins out. Gating
  // on bare cross-origin would break legitimate dev redirects and same-origin popups.
  if (contents.getType && contents.getType() === 'webview') {
    const isLoopbackUrl = (u: string) => {
      try {
        const url = new URL(u);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false; // foo://localhost is NOT loopback
        const h = url.hostname;
        return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
      } catch { return false; }
    };
    // ⌘-click and middle-click ask for a background tab: the person wants the
    // page in their browser, so it opens in the default one, like a link that
    // leaves the preview, instead of a bare preview window. The site's own
    // popups on a local address (target=_blank, window.open) stay allowed.
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (isLoopbackUrl(url) && disposition !== 'background-tab') return background ? { action: 'allow', overrideBrowserWindowOptions: windowOptions({}) } : { action: 'allow' };
      try { if (/^https?:\/\//i.test(url)) shell.openExternal(url); } catch {}
      return { action: 'deny' };
    });
    if (background) contents.on('did-create-window', (win) => showInBackground(win));
    contents.on('will-navigate', (ev, url) => {
      try {
        const cur = contents.getURL();
        if (cur && new URL(cur).origin !== new URL(url).origin && !isLoopbackUrl(url)) {
          ev.preventDefault();
          if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        }
      } catch {}
    });
  }
});

// ── Performance marks ────────────────────────────────────────────────────
// Timing numbers only (never content): boot milestones + per-interaction
// latencies land in a local ring (perf-log.jsonl), one boot entry per launch,
// so a regression shows up without a repro. None of it is sent anywhere.
const BOOT_PERF: { t0: number; marks: Record<string, number>; sent: boolean } = { t0: Date.now(), marks: {}, sent: false };
function perfMark(name: string): void {
  if (!name || name in BOOT_PERF.marks) return;
  BOOT_PERF.marks[name] = Date.now() - BOOT_PERF.t0;
  if (name === 'first-preview' && !BOOT_PERF.sent) {
    BOOT_PERF.sent = true;
    perfLogAppend({ kind: 'boot', ...BOOT_PERF.marks });
  }
}
function perfLogAppend(entry: RadialIpc.PerfEntry): void {
  try {
    const file = path.join(app.getPath('userData'), 'perf-log.jsonl');
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
    // Ring: trim when the log doubles past its cap.
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length > 400) fs.writeFileSync(file, lines.slice(-200).join('\n') + '\n');
  } catch {}
}
ipcMain.on('perf:mark', (_e, p: PackedArgs<'perfMark', ['name']>) => perfMark(p && p.name));
ipcMain.on('perf:log', (_e, entry: ArgTo<'perfLog', 0>) => { if (entry && typeof entry === 'object') perfLogAppend(entry); });
ipcMain.handle('perf:boot', (): AnswerTo<'perfBoot'> => ({ ...BOOT_PERF.marks }));

// The core boots before the window (its stores, telemetry, the control socket,
// the PTY daemon) and starts its sweeps once the app is up (src/core/index.ts).
app.whenReady().then(() => { perfMark('ready'); core.start(); initUpdater(); installCliShim(); registerProvisionedTools(); recents.markRunning(); buildMenu(); createWindow(); perfMark('window-created'); try { core.migrationPlaybook(); } catch (e) { console.log('[migrate] playbook install failed:', (e as Error).message); } startDevelopmentReload();
  core.startSweeps(); });

app.on('window-all-closed', async () => { await core.stopAll(); recents.markCleanExit(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', async () => {
  // Electron does not await async lifecycle listeners. Persist accepted UI
  // state before the first await; parking agents can outlast process exit.
  try { projectState.flush(); } catch {}
  core.stopControlServer();
  if (stopDevReload) { stopDevReload(); stopDevReload = null; }
  newProject.abortForQuit();
  try { vercel.abortAll(); } catch {} // no hosting probe outlives the app
  // A throwaway instance (tests, smoke, screenshot scripts) takes its daemon and
  // every agent session down with it, FIRST, before the parking work in stopAll
  // (which can outlast the process when a test harness kills the app); a real
  // app leaves them running by design. The daemon it spawned also self-destructs
  // when this connection drops (--ephemeral), so a hard kill is covered too.
  if (terminal.ephemeral()) { try { await terminal.killAll(); } catch {} }
  await core.stopAll();
  recents.markCleanExit();
});
