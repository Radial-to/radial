/**
 * The seams a host hands the core (plans/headless-core.md): what the core needs
 * from the app around it, without reaching Electron. The Mac app's main.ts
 * fills them from its window; `radial serve` (src/headless) has no window, so
 * no viewer, and its page is Playwright's headless browser (src/headless/page.ts),
 * which works once `radial browser install` has fetched it.
 * - platform: the app and the machine around the core (version, flavor, data
 *   dir, keep-awake, and what only the host does, like radial serve's HTTP
 *   listener and preview proxies);
 * - page: a browser on the projects' pages (screenshots, the Content panel's
 *   fields, reloads, and the migration's screenshots and PNG codec), or null;
 * - viewer: an attached window's flows (open, close, focus, the window's agent
 *   start, send and Home, what's on screen, and its chats), or null;
 * - events: what happened, for whoever watches (radialApi's WindowEvents).
 * Without a viewer or a page the core does what it can itself (fallbacks.ts).
 */
import type { CliRequests, CliResult, WindowEvents } from '../shared/radialApi';
import type { ChatEngine } from '../shared/chatPermissions';
import type { CompareSiteOptions, Shooter } from '../main/migrate';
import type { Flavor, PreviewAddress, PreviewAsk } from '../main/cliServer';
import os from 'os';
import * as devMemory from '../main/devMemory';

/** The app and the machine around the core. */
export interface Platform {
  /** The app's version. */
  readonly version: string;
  /** An installed app, a checkout's build, or the headless core (`radial serve`): hello reports it, and only an installed app sends telemetry. */
  readonly flavor: Flavor;
  /** Where Radial keeps its state: recents, project state, its sockets, the shims, the migration playbook. */
  readonly dataDir: string;
  /** The person's home folder: new projects go to ~/Radial when no projects folder was chosen. */
  readonly home: string;
  /** The OS's own version, for telemetry: macOS's ("27.0.0", as process.getSystemVersion gives it) on a Mac, never the Darwin kernel's. */
  readonly osVersion: string;
  /** The Mac app's Electron version, for telemetry; radial serve runs on plain Node and has none. */
  readonly electronVersion?: string | null;
  /** The `radial` command the terminals' shim runs: this app's own copy. */
  readonly cliBin: string;
  /** Keeps the machine from sleeping (true) or lets it sleep again (false), while a kept-awake agent lives. */
  keepAwake(on: boolean): void;
  /** The recent projects changed (a project opened): the desktop rebuilds its Open Recent menu. */
  recentsChanged?(): void;
  /** radial serve --listen's HTTP listener, once it listens (src/headless/listen.ts); none in the Mac app, or without --listen. */
  listener?(): Listener | null;
}

/**
 * radial serve's HTTP listener as the core asks it (plans/headless-core.md,
 * phase 4): where it listens, for hello, and each open project's preview
 * proxy, for `radial url`.
 */
export interface Listener {
  /** Where it takes requests: http://127.0.0.1:4000. */
  readonly address: string;
  /** A project's preview at its proxy's stable address (the proxy opens on the first ask), with a share link when asked; null for a project that isn't open. */
  preview(repoDir: string, ask: PreviewAsk): Promise<PreviewAddress | null>;
}

/**
 * A browser on the projects' pages. The desktop's is its window: the preview
 * webviews, and a hidden window for the migration's screenshots. `radial
 * serve`'s is Playwright's Chrome Headless Shell (src/headless/page.ts), once
 * `radial browser install` has fetched it. Its answers never reject: a
 * failure is a CliResult with ok false and a code.
 */
export interface Page {
  /**
   * Whether it can work now. radial serve's browser arrives with `radial
   * browser install`, which can run while serve does; a host that leaves this
   * out always has its browser.
   */
  available?(): boolean;
  /**
   * A full-page screenshot of a project's preview, a route first when given
   * (`radial shot`). width is the page's in CSS pixels, for radial serve's
   * browser; the desktop shoots the preview at the width it shows.
   */
  shot(repoDir: string, route: string | null, width?: number | null): Promise<CliResult<'shot'>>;
  /** The Content panel's fields on a project's page, a route first when given (`radial fields`). */
  fields(repoDir: string, route: string | null): Promise<CliResult<'fields'>>;
  /** Reloads a project's preview: after a write from outside the window, and `radial reload`. */
  reload(repoDir: string): Promise<CliResult<'reload'>>;
  /** The migration's full-page screenshots of a URL at each width. */
  readonly shoot: Shooter;
  /** The migration compare's PNG decode and encode. */
  readonly decode: CompareSiteOptions['decode'];
  readonly encode: CompareSiteOptions['encode'];
}

/**
 * An attached window's flows: the desktop's. Each keeps the window's own
 * behavior (an open shows its loading overlay and Node-missing modal; an agent
 * start reuses the project's untouched session or first chat). `radial serve`
 * has no window, and the core runs its own versions of these (fallbacks.ts).
 */
export interface Viewer {
  /** Opens a folder the way the window does; the outcome comes back through the core's openProject. */
  open(repoDir: string): void;
  /** Brings the window forward. */
  focus(): void;
  /** Whether the window is up and answering (hello's windowReady). */
  ready(): boolean;
  /** Whether the window is in front: the Vercel comment poll and the context watcher run sooner for it. */
  focused(): boolean;
  /** Closes a project's tab, and its terminals with it (`radial close`). */
  close(repoDir: string): Promise<CliResult<'close'>>;
  /** The sessions on screen, which parking leaves alone. */
  visibleAgents(): Promise<CliResult<'visibleAgents'>>;
  /** Starts an agent on a task in a project's terminal (`radial agent start`, a migration's agent). */
  agentStart(request: CliRequests['agent']): Promise<CliResult<'agent'>>;
  /** Types into a running session (`radial agent send`). */
  agentSend(request: CliRequests['agentSend']): Promise<CliResult<'agentSend'>>;
  /** Brings Home forward with its agent (`radial home`). */
  home(request: CliRequests['home']): Promise<CliResult<'home'>>;
  /** The window's chats (the Chat UI's conversations), when this app runs them. */
  readonly chats: ViewerChats | null;
}

/** The window's chats, as far as the core reaches them. */
export interface ViewerChats {
  /** Parks chats quiet for idleMs, in one project or all, except those on screen; nothing before the Chat UI has started. */
  parkIdle(options: { idleMs: number; repoDir?: string | null; visible?: string[] }): Promise<unknown>;
  /** A terminal's output, for the chat that runs in it. */
  terminalData(id: string, data: string): void;
  /** A terminal's exit, for the chat that ran in it. */
  terminalExited(id: string): void;
  /** Why a terminal takes no typed input now: its chat shows in Chat view, is switching views, or is delivering a message to its CLI; null when it takes keys (an answer to its CLI's question waits for that). */
  inputBlock(id: string): 'chat-view' | 'switching' | 'delivering' | null;
  /** A project's first chat, carrying a task: opening the project shows it, and its CLI boots with the task. Answers its id. */
  createTaskChat(repoDir: string, engine: ChatEngine, title: string, task: string): string;
  /** Starts a task chat's CLI in its terminal view; answers the chat. */
  startTaskChat(id: string): Promise<{ title: string }>;
}

/** A window event's payload as send() takes it: none when the event carries nothing. */
export type EventPayload<C extends keyof WindowEvents> = WindowEvents[C] extends undefined ? [] : [WindowEvents[C]];

/**
 * What the core tells whoever watches it: the desktop forwards each event to
 * its window; a headless host logs them (and later streams them).
 */
export interface Events {
  /** One event: a channel of radialApi's WindowEvents and its payload. */
  send<C extends keyof WindowEvents>(channel: C, ...payload: EventPayload<C>): void;
  /**
   * Whether anyone watches. The core skips work that only feeds a watcher when
   * nobody does: the history timeline, the Vercel comment sync's status.
   */
  listening(): boolean;
}

/** Everything the host hands the core: a window (viewer) and a browser (page) only when it has them. */
export interface CoreHost {
  platform: Platform;
  page: Page | null;
  viewer: Viewer | null;
  events: Events;
}

/**
 * How the core's sweeps and terminals behave for a host (createCore's second
 * argument). The Mac app keeps the defaults, made for a person at a window;
 * `radial serve` serves agents, who work with nobody at a window, so it puts
 * nothing to sleep unless asked, leaves parking to the PTY daemon's ceiling,
 * gives a dev server a share of a small machine's memory, and has no
 * preview for a browser shim to land in.
 */
export interface CoreOptions {
  /** Put an open project to sleep once it's this long unused (the Mac app: 5 minutes); null never does. */
  idleSleepMs: number | null;
  /**
   * Park idle agents: those quiet past agentSleep.AGENT_PARK_MS, idle ones at
   * quit, and a sleeping project's. false leaves them to the PTY daemon's
   * two-hour ceiling (and an explicit `radial sleep`).
   */
  parkAgents: boolean;
  /** How big a dev server Radial runs may grow, in MB, before it's restarted (devMemory.ts says when). */
  devMemoryLimitMb: number;
  /** Shadow open and xdg-open in agent terminals, so a browser launch lands in the window's preview; false writes only the `radial` shim. */
  browserShims: boolean;
}

/** The Mac app's options: a person at a window. */
export function desktopOptions(): CoreOptions {
  return { idleSleepMs: 5 * 60 * 1000, parkAgents: true, devMemoryLimitMb: devMemory.limitMb(os.totalmem()), browserShims: true };
}

let bound: CoreHost | null = null;
let boundOptions: CoreOptions | null = null;

/** The host gives the core its seams and options, before anything in the core runs. */
export function bindHost(host: CoreHost, opts: CoreOptions = desktopOptions()): void { bound = host; boundOptions = opts; }

function host(): CoreHost {
  if (!bound) throw new Error('The core ran before its host gave it its seams.');
  return bound;
}

export function platform(): Platform { return host().platform; }
/** The host's browser on the projects' pages, or null when it has none. */
export function page(): Page | null { return host().page; }
/** The host's browser when it can work now: null with none, or while radial serve's isn't installed yet (Page.available). */
export function browserPage(): Page | null {
  const pg = page();
  return pg && (!pg.available || pg.available()) ? pg : null;
}
/** The host's window, or null when it has none (radial serve). */
export function viewer(): Viewer | null { return host().viewer; }
export function events(): Events { return host().events; }
/** The options the host started the core with. */
export function options(): CoreOptions { host(); return boundOptions!; } // bound together with the host

/** Tells whoever watches what happened (the desktop's window: main.ts's send()). */
export function send<C extends keyof WindowEvents>(channel: C, ...payload: EventPayload<C>): void {
  events().send(channel, ...payload);
}
