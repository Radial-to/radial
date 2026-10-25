// The data shapes the window scripts share. Ambient: no top-level import or
// export, so every name here is global, like the window scripts' own
// top-level declarations (they share one scope, in index.html's order).
// Shapes that come from the main process are RadialApi's own types
// (src/shared/radialApi.ts), and what the preview's overlay
// (src/overlay/overlay.ts) reports about the page is its messages' types
// (src/shared/overlayMessages.ts), both reached through the aliases below; the
// rest are what the window builds itself (tabs, terminals, the panels' saved
// state…), some of them views of those shapes.

// ── Types from the typed modules ────────────────────────────────────────────

type RadialApi = import('../shared/radialApi').RadialApi;
type ChatEngine = import('../shared/chatPermissions').ChatEngine;
type PermissionMode = import('../shared/chatPermissions').PermissionMode;
type ChatSession = import('../shared/radialApi').ChatSession;
type ChatSummary = import('../shared/radialApi').ChatSummary;
type ChatFile = import('../shared/radialApi').ChatFile;
type ChatFileMatch = import('../shared/radialApi').ChatFileMatch;
type ChatModel = import('../shared/radialApi').ChatModel;
type ChatSettings = import('../shared/radialApi').ChatSettings;
type ChatView = import('../shared/radialApi').ChatView;
type ChatResourceAction = import('../shared/radialApi').ChatResourceAction;
type ChatResourceResult = import('../shared/radialApi').ChatResourceResult;
type ConfigSetResult = import('../shared/radialApi').ConfigSetResult;
type ContentField = import('../shared/radialApi').ContentField;
type DeploymentObservation = import('../shared/radialApi').DeploymentObservation;
type DesignToken = import('../shared/radialApi').DesignToken;
type ElementContext = import('../shared/radialApi').ElementContext;
type ElementPathLevel = import('../shared/radialApi').ElementPathLevel;
type HistoryState = import('../shared/radialApi').HistoryState;
type LibraryEntry = import('../shared/radialApi').LibraryEntry;
type LibraryStatus = import('../shared/radialApi').LibraryStatus;
type OpenedFromGitHub = import('../shared/radialApi').OpenedFromGitHub;
type OpenGitHubResult = import('../shared/radialApi').OpenGitHubResult;
type OpenProjectResult = import('../shared/radialApi').OpenProjectResult;
type ProjectPage = import('../shared/radialApi').ProjectPage;
type ProjectReference = import('../shared/radialApi').ProjectReference;
type ProjectStorageStatus = import('../shared/radialApi').ProjectStorageStatus;
type PublishTarget = import('../shared/radialApi').PublishTarget;
type RadialConfig = import('../shared/radialApi').RadialConfig;
type RepoState = import('../shared/radialApi').RepoState;
type ReviewComment = import('../shared/radialApi').ReviewComment;
type RunnableProject = import('../shared/radialApi').RunnableProject;
type ServerActivity = import('../shared/radialApi').ServerActivity;
type ShortcutBinding = import('../shared/radialApi').ShortcutBinding;
type SkillEntry = import('../shared/radialApi').SkillEntry;
type SkillScope = import('../shared/radialApi').SkillScope;
type ContextFile = import('../shared/radialApi').ContextFile;
type AppInfo = import('../shared/radialApi').AppInfo;
type BranchList = import('../shared/radialApi').BranchList;
type CliAuth = import('../shared/radialApi').CliAuth;
type GhOptions = import('../shared/radialApi').GhOptions;
type GitHubRepo = import('../shared/radialApi').GitHubRepo;
type GitHubCapabilities = import('../shared/radialApi').GitHubCapabilities;
type MergeMethod = import('../shared/radialApi').MergeMethod;
type PullRequestDetail = import('../shared/radialApi').PullRequestDetail;
// radialApi's InsertPosition ('before' | 'after' | 'inside') can't be a global
// alias here: lib.dom's global InsertPosition ('beforebegin'…) owns the name.
// renderer.ts names it TpInsertPosition.
type LaunchCheckScan = import('../shared/radialApi').LaunchCheckScan;
type LaunchCheckReport = import('../shared/radialApi').LaunchCheckReport;
type MigrateCheckResult = import('../shared/radialApi').MigrateCheckResult;
type MigrateFramework = import('../shared/radialApi').MigrateFramework;
type NewProjectInfo = import('../shared/radialApi').NewProjectInfo;
type ProjectTemplate = import('../shared/radialApi').ProjectTemplate;
type OpenProjectOptions = import('../shared/radialApi').OpenProjectOptions;
type PushAuth = import('../shared/radialApi').PushAuth;
type RecentProject = import('../shared/radialApi').RecentProject;
type SetupCheck = import('../shared/radialApi').SetupCheck;
type VercelStatus = import('../shared/radialApi').VercelStatus;
type ArtboardViewport = import('./viewport').ArtboardViewport;
type SleptAgent = import('../shared/radialApi').SleptAgent;
type StoredReceipt = import('../shared/radialApi').StoredReceipt;
type TerminalActivity = import('../shared/radialApi').TerminalActivity;
type TokenIndex = import('../shared/radialApi').TokenIndex;
type VercelCommentsStatus = import('../shared/radialApi').VercelCommentsStatus;
type VercelScopes = import('../shared/radialApi').VercelScopes;
type WorkspaceActivity = import('../shared/radialApi').WorkspaceActivity;
type LabelSource = import('./taskTitle').LabelSource;
type PreviewMode = import('./threadPreview').PreviewMode;
type PreviewView = import('./threadPreview').PreviewView;
type ViewportMode = import('./threadPreview').ViewportMode;
type ThreadPreview<Term> = import('./threadPreview').ThreadPreview<Term>;
type PendingNavigation = import('./navigation').PendingNavigation;
type Artboard = import('./viewport').Artboard;
type StyleSource = import('./adjustDirect').StyleSource;
type StyleDeltas = import('./adjustDirect').StyleDeltas;
type StyleAnchor = import('./adjustDirect').StyleAnchor;

// What the preview's overlay sends (src/shared/overlayMessages.ts, the
// contract the overlay and the window share). The window's own views of these
// shapes (PreviewSelection and the rest, below) derive from them.
type OverlayToHostPayloads = import('../shared/overlayMessages').OverlayToHostPayloads;
type HostToOverlayPayloads = import('../shared/overlayMessages').HostToOverlayPayloads;
/** What follows a channel in a message: nothing, or the one payload. */
type OverlayMessageArgs<P> = import('../shared/overlayMessages').MessageArgs<P>;
type CapturedSelection = import('../shared/overlayMessages').CapturedSelection;
type AdjustReadout = import('../shared/overlayMessages').AdjustReadout;
type SelectEnrichPayload = import('../shared/overlayMessages').SelectEnrichPayload;
type StyleSourceReadout = import('../shared/overlayMessages').StyleSourceReadout;
/** radial:canvas-move: the overlay moved an element on the canvas: the element, the neighbour or parent it moved to, and where. */
type CanvasMove = import('../shared/overlayMessages').CanvasMove;
type PageTreeResult = import('../shared/overlayMessages').PageTreeResult;
type StyleAuditResult = import('../shared/overlayMessages').StyleAuditResult;
type ImageReadout = import('../shared/overlayMessages').ImageReadout;

/** Every key of every member of a union. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
/**
 * A union whose members each read the other members' fields as undefined:
 * how the window code reads a main-process answer without narrowing it first
 * (`state?.branch` on a failure). Narrowing on the discriminant still works.
 */
type LooseUnion<T, All = T> = T extends unknown ? T & { [K in Exclude<KeysOfUnion<All>, keyof T>]?: undefined } : never;

/** A timer id, as the window's setTimeout and setInterval hand them out. */
type TimerId = number;
/** A point on the draw layer or the canvas, [x, y] in CSS px. */
type Point = [number, number];

// ── The page's elements ─────────────────────────────────────────────────────

/**
 * The elements index.html declares, by id, with their element types. The
 * window scripts run at the end of <body>, so each of these is there from the
 * start, and no script removes one (the React chat composer replaces
 * #nativeChatInput with its own textarea under the same id). #appSplash is
 * left out: boot removes it. Keep in step with index.html.
 */
interface RadialDomIds {
  app: HTMLDivElement;
  projectsRail: HTMLElement;
  railCollapse: HTMLButtonElement;
  railProjects: HTMLDivElement;
  settingsBtn: HTMLButtonElement;
  settingsDot: HTMLSpanElement;
  feedbackBtn: HTMLButtonElement;
  railReopen: HTMLButtonElement;
  topbar: HTMLElement;
  tabBar: HTMLDivElement;
  contextToggle: HTMLButtonElement;
  branchSwitch: HTMLButtonElement;
  openExtBtn: HTMLButtonElement;
  focusBtn: HTMLButtonElement;
  publishBtn: HTMLButtonElement;
  browserNav: HTMLDivElement;
  pagesBtn: HTMLButtonElement;
  deviceSwitch: HTMLDivElement;
  lockBtn: HTMLButtonElement;
  widthInput: HTMLInputElement;
  deviceCycle: HTMLButtonElement;
  navBack: HTMLButtonElement;
  navFwd: HTMLButtonElement;
  navReload: HTMLButtonElement;
  navFavicon: HTMLImageElement;
  navUrlPrefix: HTMLSpanElement;
  navUrl: HTMLInputElement;
  navPageSettings: HTMLButtonElement;
  bnToolsDock: HTMLSpanElement;
  navOpenExt: HTMLButtonElement;
  navFocus: HTMLButtonElement;
  navPublish: HTMLButtonElement;
  canvasHeader: HTMLDivElement;
  toolStrip: HTMLDivElement;
  tsShot: HTMLButtonElement;
  navPause: HTMLButtonElement;
  branchMenu: HTMLDivElement;
  publishMenu: HTMLDivElement;
  body: HTMLDivElement;
  sidebar: HTMLElement;
  sidebarClose: HTMLButtonElement;
  sideSearch: HTMLDivElement;
  pageSearch: HTMLInputElement;
  'pane-pages': HTMLDivElement;
  pagesRefresh: HTMLButtonElement;
  sitemapBtn: HTMLButtonElement;
  groupAdd: HTMLButtonElement;
  pageAdd: HTMLButtonElement;
  pageList: HTMLUListElement;
  'pane-launch': HTMLDivElement;
  launchBody: HTMLDivElement;
  'pane-home': HTMLDivElement;
  homeOpenHead: HTMLDivElement;
  homeOpenList: HTMLUListElement;
  homeRecentList: HTMLUListElement;
  preview: HTMLElement;
  emptyState: HTMLDivElement;
  homeGrid: HTMLDivElement;
  hgSearchIcon: HTMLSpanElement;
  hgSearch: HTMLInputElement;
  hgNew: HTMLButtonElement;
  hgNewIcon: HTMLSpanElement;
  hgToolbar: HTMLDivElement;
  hgCount: HTMLSpanElement;
  hgSort: HTMLButtonElement;
  hgActivitySummary: HTMLButtonElement;
  hgWorkspaceChat: HTMLElement;
  hgChatTitle: HTMLHeadingElement;
  hgChatForm: HTMLFormElement;
  hgChatInput: HTMLTextAreaElement;
  hgChatSend: HTMLButtonElement;
  hgChatStatus: HTMLParagraphElement;
  hgChatCancel: HTMLButtonElement;
  hgActivity: HTMLElement;
  hgStarters: HTMLElement;
  hgStartersTitle: HTMLHeadingElement;
  hgStarterCards: HTMLDivElement;
  hgListHead: HTMLDivElement;
  hgCards: HTMLDivElement;
  hgGithub: HTMLDivElement;
  hgCheckout: HTMLElement;
  hgSummary: HTMLParagraphElement;
  frBack: HTMLButtonElement;
  frTitle: HTMLHeadingElement;
  openSection: HTMLDivElement;
  openList: HTMLUListElement;
  recentSection: HTMLDivElement;
  recentList: HTMLUListElement;
  'fr-template': HTMLDivElement;
  npTemplates: HTMLDivElement;
  npName: HTMLInputElement;
  npPathPreview: HTMLSpanElement;
  npChangeDir: HTMLButtonElement;
  npGhRow: HTMLLabelElement;
  npGh: HTMLInputElement;
  npGhOwner: HTMLSelectElement;
  npStatus: HTMLDivElement;
  npCreate: HTMLButtonElement;
  npCancel: HTMLButtonElement;
  'fr-github': HTMLDivElement;
  githubUrl: HTMLInputElement;
  openGithubBtn: HTMLButtonElement;
  ghSection: HTMLDivElement;
  ghHeadLabel: HTMLSpanElement;
  ghOwner: HTMLSelectElement;
  ghSearch: HTMLInputElement;
  ghRefresh: HTMLButtonElement;
  ghRepoList: HTMLUListElement;
  'fr-migrate': HTMLDivElement;
  mgUrl: HTMLInputElement;
  mgCheck: HTMLButtonElement;
  mgFound: HTMLParagraphElement;
  mgDrop: HTMLDivElement;
  mgFiles: HTMLDivElement;
  mgAddFiles: HTMLButtonElement;
  mgCmsHelp: HTMLParagraphElement;
  mgName: HTMLInputElement;
  mgPath: HTMLSpanElement;
  mgStatus: HTMLDivElement;
  mgStart: HTMLButtonElement;
  'fr-folder': HTMLDivElement;
  openBtn2: HTMLButtonElement;
  availableSection: HTMLDivElement;
  folderHead: HTMLSpanElement;
  setFolderBtn: HTMLButtonElement;
  availableList: HTMLUListElement;
  previewProgress: HTMLDivElement;
  previews: HTMLDivElement;
  rulerLayer: HTMLDivElement;
  rulerCorner: HTMLDivElement;
  rulerTop: HTMLDivElement;
  rulerLeft: HTMLDivElement;
  guideLayer: HTMLDivElement;
  sitemapView: HTMLDivElement;
  smTitle: HTMLSpanElement;
  smScroll: HTMLDivElement;
  smSize: HTMLDivElement;
  smCanvas: HTMLDivElement;
  smZoomOut: HTMLButtonElement;
  smZoomLabel: HTMLButtonElement;
  smZoomIn: HTMLButtonElement;
  smZoomFit: HTMLButtonElement;
  settingsView: HTMLDivElement;
  settingsNav: HTMLElement;
  settingsBack: HTMLButtonElement;
  settingsTitle: HTMLHeadingElement;
  settingsDescription: HTMLParagraphElement;
  settingsRecheck: HTMLButtonElement;
  settingsClose: HTMLButtonElement;
  settingsBody: HTMLDivElement;
  onboardView: HTMLDivElement;
  onboardProgress: HTMLSpanElement;
  onboardRecheck: HTMLButtonElement;
  onboardClose: HTMLButtonElement;
  onboardBody: HTMLDivElement;
  linkPickerView: HTMLDivElement;
  lpClose: HTMLButtonElement;
  lpOwner: HTMLSelectElement;
  lpSearch: HTMLInputElement;
  lpRepoList: HTMLUListElement;
  lpUrl: HTMLInputElement;
  lpUrlBtn: HTMLButtonElement;
  contextView: HTMLDivElement;
  ctxRail: HTMLDivElement;
  contextAdd: HTMLButtonElement;
  contextList: HTMLUListElement;
  linkAdd: HTMLButtonElement;
  linkedList: HTMLUListElement;
  ctxTitle: HTMLInputElement;
  ctxSaved: HTMLSpanElement;
  ctxAudit: HTMLButtonElement;
  ctxEnhance: HTMLButtonElement;
  ctxDelete: HTMLButtonElement;
  ctxClose: HTMLButtonElement;
  ctxAuditBox: HTMLDivElement;
  ctxEditor: HTMLTextAreaElement;
  ctxImageWrap: HTMLDivElement;
  ctxImage: HTMLImageElement;
  ctxEmpty: HTMLDivElement;
  ctxDropzone: HTMLButtonElement;
  ctxFile: HTMLInputElement;
  resizeHandle: HTMLDivElement;
  widthLabel: HTMLDivElement;
  dragMask: HTMLDivElement;
  previewLoading: HTMLDivElement;
  loadingText: HTMLDivElement;
  commentComposer: HTMLDivElement;
  quickEdit: HTMLDivElement;
  adjustUndo: HTMLDivElement;
  commentPopover: HTMLDivElement;
  buildErrorBanner: HTMLDivElement;
  confirmModal: HTMLDivElement;
  confirmTitle: HTMLHeadingElement;
  confirmMsg: HTMLParagraphElement;
  confirmCancel: HTMLButtonElement;
  confirmOk: HTMLButtonElement;
  rightDock: HTMLDivElement;
  rightDockResize: HTMLDivElement;
  commentsCount: HTMLSpanElement;
  historyBtn: HTMLButtonElement;
  pdFixedL: HTMLDivElement;
  'rp-terminal': HTMLElement;
  nativeChatToolbar: HTMLDivElement;
  nativeChatTitle: HTMLSpanElement;
  nativeChatViewStatus: HTMLSpanElement;
  nativeChatPanel: HTMLDivElement;
  nativeChatMessages: HTMLDivElement;
  nativeChatApproval: HTMLDivElement;
  nativeChatForm: HTMLFormElement;
  nativeChatInput: HTMLTextAreaElement;
  nativeChatModel: HTMLButtonElement;
  nativeChatEffort: HTMLButtonElement;
  nativeChatPermissions: HTMLButtonElement;
  nativeChatStatus: HTMLDivElement;
  nativeChatStop: HTMLButtonElement;
  nativeChatSend: HTMLButtonElement;
  terminals: HTMLDivElement;
  termEmpty: HTMLDivElement;
  termOpening: HTMLDivElement;
  agentInputBar: HTMLDivElement;
  composerActions: HTMLDivElement;
  composerQueued: HTMLDivElement;
  agentInput: HTMLDivElement;
  composerAttachments: HTMLDivElement;
  composerAttach: HTMLButtonElement;
  composerShot: HTMLButtonElement;
  agentSend: HTMLButtonElement;
  composerFile: HTMLInputElement;
  'rp-history': HTMLElement;
  momentBanner: HTMLDivElement;
  momentList: HTMLDivElement;
  'rp-comments': HTMLElement;
  commentsFilterBtn: HTMLButtonElement;
  commentsMoreBtn: HTMLButtonElement;
  commentsList: HTMLDivElement;
  commentsFoot: HTMLDivElement;
  commentsVercel: HTMLDivElement;
  commentsReview: HTMLButtonElement;
  commentsSendAll: HTMLButtonElement;
  pageDrawer: HTMLDivElement;
  psRoute: HTMLSpanElement;
  psClose: HTMLButtonElement;
  psBody: HTMLDivElement;
  linkModal: HTMLDivElement;
  linkModalText: HTMLParagraphElement;
  linkUrlInput: HTMLInputElement;
  cancelLink: HTMLButtonElement;
  confirmLink: HTMLButtonElement;
  skillModal: HTMLDivElement;
  skillClose: HTMLButtonElement;
  skillScope: HTMLDivElement;
  skillDrop: HTMLButtonElement;
  skillFile: HTMLInputElement;
  skillDescribe: HTMLButtonElement;
  connectModal: HTMLDivElement;
  cgSubtitle: HTMLParagraphElement;
  'cg-create': HTMLDivElement;
  cgOwner: HTMLSelectElement;
  cgName: HTMLInputElement;
  cgPrivate: HTMLInputElement;
  'cg-existing': HTMLDivElement;
  cgExOwner: HTMLSelectElement;
  cgExSearch: HTMLInputElement;
  cgRepoList: HTMLUListElement;
  cgUrl: HTMLInputElement;
  cgVercelSection: HTMLDivElement;
  cgVercel: HTMLInputElement;
  cgVercelScopeRow: HTMLLabelElement;
  cgVercelScope: HTMLSelectElement;
  cgVercelNote: HTMLDivElement;
  cgStatus: HTMLDivElement;
  cgCancel: HTMLButtonElement;
  cgSubmit: HTMLButtonElement;
  nodeModal: HTMLDivElement;
  nodeStatus: HTMLDivElement;
  nodeCancelX: HTMLButtonElement;
  nodeCancel: HTMLButtonElement;
  nodeGo: HTMLButtonElement;
  cmdk: HTMLDivElement;
  cmdkInput: HTMLInputElement;
  cmdkList: HTMLDivElement;
  toolPanelLayer: HTMLDivElement;
  panelDock: HTMLElement;
  pdResize: HTMLDivElement;
  pdShip: HTMLDivElement;
  pdSections: HTMLDivElement;
  panelDockL: HTMLElement;
  pdSectionsL: HTMLDivElement;
  toast: HTMLDivElement;
  updateCard: HTMLDivElement;
  ucX: HTMLButtonElement;
  ucSub: HTMLParagraphElement;
  ucRestart: HTMLButtonElement;
  ucLater: HTMLButtonElement;
  logPane: HTMLDivElement;
  toggleLog: HTMLButtonElement;
  logBody: HTMLPreElement;
}

/**
 * What `$(id)` returns: the element index.html declares under that id, or,
 * for an id the scripts create (or a computed one), whatever element the page
 * has under it, if any.
 */
type ElementById<K extends string> = K extends keyof RadialDomIds ? RadialDomIds[K] : HTMLElement | null;

// ── Electron's <webview> (the site preview) ─────────────────────────────────

/** A capture of the preview (Electron NativeImage), as far as the window uses one. */
interface PreviewImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  crop(rect: { x: number; y: number; width: number; height: number }): PreviewImage;
  resize(options: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }): PreviewImage;
  toPNG(): Uint8Array;
  toDataURL(): string;
}
/**
 * ipc-message: a message the preview's overlay sent with ipcRenderer.sendToHost,
 * one member per channel, so testing `channel` narrows `args` to what the
 * overlay sends on it.
 */
type PreviewIpcMessageEvent = Event & { [C in keyof OverlayToHostPayloads]: { channel: C; args: OverlayMessageArgs<OverlayToHostPayloads[C]> } }[keyof OverlayToHostPayloads];
/** did-fail-load. */
interface PreviewLoadFailEvent extends Event { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }
/** did-navigate and did-navigate-in-page. */
interface PreviewNavigateEvent extends Event { url: string; isMainFrame?: boolean }
interface PreviewWebviewEvents {
  'ipc-message': PreviewIpcMessageEvent;
  'did-fail-load': PreviewLoadFailEvent;
  'did-navigate': PreviewNavigateEvent;
  'did-navigate-in-page': PreviewNavigateEvent;
  'dom-ready': Event;
  'did-finish-load': Event;
  'did-start-loading': Event;
  'did-stop-loading': Event;
  'render-process-gone': Event;
}
/**
 * The preview: Electron's <webview> element (WebviewTag), with the methods and
 * events the window uses. Its preload is the overlay; `send` reaches it.
 */
interface RadialWebview extends HTMLElement {
  src: string;
  /** A message to the overlay: its payload as HostToOverlayPayloads has it for the channel. */
  send<C extends keyof HostToOverlayPayloads>(channel: C, ...args: OverlayMessageArgs<HostToOverlayPayloads[C]>): void;
  getWebContentsId(): number;
  capturePage(): Promise<PreviewImage>;
  executeJavaScript(code: string): Promise<unknown>;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  reload(): void;
  reloadIgnoringCache(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  setZoomFactor(factor: number): void;
  addEventListener<K extends keyof PreviewWebviewEvents>(type: K, listener: (event: PreviewWebviewEvents[K]) => void, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof PreviewWebviewEvents>(type: K, listener: (event: PreviewWebviewEvents[K]) => void, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

// ── Terminals (xterm.js) ────────────────────────────────────────────────────

type XtermTerminal = import('@xterm/xterm').Terminal;
type XtermFitAddon = import('@xterm/addon-fit').FitAddon;
/** An xterm the window mounted, with the session it belongs to (its onBell reads it back). */
interface RadialXterm extends XtermTerminal { _radialTerm?: TermSession }

/**
 * One agent or shell session in a tab's list (renderer newTerminal,
 * reattachProjectTerminals, nativeChat termFor): a pty in the terminal daemon
 * (its xterm mounted when shown), a slept agent's row, or a native chat's
 * stand-in (id 'native:<chat id>'). Fields with a leading _ are the window's
 * own bookkeeping.
 */
interface TermSession {
  /** The daemon's pty id; 'new<n>' until termStart answers, 'slept:<id>' for a slept row, 'native:<id>' for a chat. */
  id: string;
  /** The agent CLI it runs; null for a plain shell. */
  engine: ChatEngine | null;
  label: string;
  labelSource?: LabelSource;
  /** The person renamed it: auto-naming leaves it alone. */
  _renamed?: boolean;
  /** The chat this terminal belongs to (a chat's terminal view, or a chat's stand-in row). */
  _nativeChatId?: string | null;
  preview?: PreviewView | null;
  previewSelectedAt?: number;
  recentTaskAt?: number;
  recentPinnedAt?: number;
  keepAwake?: boolean;
  /** Live in the daemon, xterm not mounted (yet). */
  detached?: boolean;
  _exited?: boolean;
  /** A slept agent's row: no pty until it relaunches. */
  _slept?: boolean;
  /** The slept record's id (SleptAgent.id), while the row is asleep. */
  sleptId?: string;
  _spawnedAt?: number;
  // Mounted: the xterm and its DOM.
  xterm?: RadialXterm | null;
  fit?: XtermFitAddon | null;
  el?: HTMLDivElement | null;
  _fitObs?: ResizeObserver | null;
  /** Its scrollback is replaying (reattach): OSC 52 copies and the bell stay quiet. */
  _replaying?: boolean;
  // Agent status (renderer markTermActivity).
  _working?: boolean;
  _needsReview?: boolean;
  _idleTimer?: TimerId;
  _lastDataAt?: number;
  /** The CLI drew its prompt: input can go in (renderer engineSend). */
  _ready?: boolean;
  _readyWaiters?: (() => void)[];
  _pasteReady?: boolean;
  // Typed input, for auto-naming.
  _typeBuf?: string;
  _typedAt?: number;
  _pendingTaskLabel?: string;
  // A native chat's model, as its stand-in shows it (nativeChat termFor).
  model?: string;
  modelName?: string | null;
  effort?: string | null;
  modelProvider?: string;
}

// ── Tabs ────────────────────────────────────────────────────────────────────

/** An image pasted or dropped into the agent composer: saved to disk, shown from a blob URL. */
interface ComposerImage { abs: string; blobUrl: string }

/**
 * What a project tab and the Home pseudo-tab have in common: the agent
 * terminals, and the bookkeeping the terminal code keeps on whichever one it
 * was handed (agentTab, tabById).
 */
interface AgentHost {
  id: string;
  name: string;
  pageTitle: string | null;
  /**
   * A project tab has none until its terminals are listed or one starts
   * (createTab leaves them out; reattachProjectTerminals and newTerminal set them).
   */
  terminals?: TermSession[];
  activeTerminalId?: string | null;
  /** The terminal shown in the agent pane. */
  term?: TermSession | null;
  composerImages?: ComposerImage[];
  /** Agents that slept with the project, until reattachProjectTerminals turns them into rows. */
  _sleptAgents?: SleptAgent[] | null;
  /** The reattach that lists its daemon terminals (createTab); the Home tab has none. */
  _terminalsReady?: Promise<void>;
  _sleptRelaunching?: boolean;
  /** A slept row the person picked while it relaunches. */
  _pendingSleptSelect?: string | null;
  _creatingDefaultTerm?: boolean;
  /** Being closed (closeTab): a relaunch of its parked agents stops, and kills one that started meanwhile. */
  _closed?: boolean;
  /** Opened cold: no dev server until it wakes. */
  suspended?: boolean;
  /** A launch-check fix in flight: rescan on the agent's quiet beats until it passes. */
  _launchRescan?: { id: string; at: number; lastScan: number } | null;
}

/** A guide line dragged out of a ruler: screen-fixed, `off` px into the preview. */
interface RulerGuide { axis: 'v' | 'h'; off: number }

/** An in-flight preview navigation (renderer navigateWebview). */
interface PreviewNavigation extends PendingNavigation {
  /** The document URL a full load falls back to. */
  full: string;
  startedAt: number;
  onComplete: (() => void)[];
  ackTimer: TimerId | null;
  fallbackTimer: TimerId | null;
  /** It fell back to a document load. */
  document?: boolean;
}

/** The page's head and text as the overlay reads them (overlay gatherMeta). */
type PageMeta = import('../shared/overlayMessages').PageMeta;

/**
 * A Content-panel field as the preview reports it (overlay radial:fields-result):
 * a ContentField, plus whether it is inside the focused element and, for an
 * image, its thumbnail (the CLI's answer leaves both out). Read without
 * narrowing (a field another kind has reads as undefined).
 */
type PreviewContentField = LooseUnion<import('../shared/overlayMessages').ContentFieldReadout>;

/** One row of the page's layer tree (overlay radial:read-tree). */
type LayerTreeNode = import('../shared/overlayMessages').LayerTreeNode;
/** The page's layer tree (overlay radial:tree-result), with the route it was read on. */
interface PreviewPageTree extends PageTreeResult { _route: string }

/** The colours, type and sizes a page (or a subtree) uses, counted (overlay radial:style-audit-result), with the route it was read on. */
interface PreviewStyleAudit extends StyleAuditResult { _route: string }

/** The project's design tokens as the Tokens panel caches them. */
type TokenIndexCache = (TokenIndex | { ok: false; tokens: DesignToken[]; error?: string }) & { _at?: number; _stale?: boolean };

/**
 * One open project (renderer createTab). Fields with a leading _ are the
 * window's caches and in-flight state, set as the features that own them run.
 */
interface Tab extends AgentHost {
  home?: undefined;
  repoDir: string;
  framework: RunnableProject['framework'];
  /** The dev server; null while the project sleeps. */
  baseUrl: string | null;
  pages: ProjectPage[];
  config: RadialConfig;
  status: RepoState;
  previewMode: PreviewMode;
  sharedPreview: PreviewView | null;
  suspended: boolean;
  favicon: string | null;
  autoApprove: boolean;
  viewportMode: ViewportMode;
  width: number;
  /** Never set: a saved field from an older viewport model. */
  viewportAspect: null;
  /** The preview's browser zoom. */
  zoom: number;
  currentRoute: string;
  /** The current page's source file, when the project lists it. */
  currentFile: string | null;
  // The undo history (history:state).
  timeline: HistoryState['timeline'];
  cursor: number;
  total: number;
  /**
   * The preview. createTab builds the tab with null here and sets the
   * webview before anything else reads it or the tab joins `tabs`.
   */
  webview: RadialWebview;
  /** Select mode is the canvas's resting mode. */
  editMode: boolean;
  guides: RulerGuide[];
  rulersOn: boolean;
  _openSeq?: number;
  /** The latest switch to this tab (switchTab), settled once it has finished. */
  _switching?: Promise<void>;
  /** What waits for this sleeping project's wake to be over (whenWoken), done or not. */
  _wokenWaiters?: (() => void)[];
  /** What waits for this project to be the one shown again (whenShown). */
  _shownWaiters?: (() => void)[];
  _railCollapsed?: boolean;
  _thumb?: string;
  _thumbAt?: number;
  // The preview.
  _previewReady?: boolean;
  _documentLoading?: boolean;
  _documentLoadingAt?: number;
  /** The page a document load started by loadDocumentForNavigation is for, until that load stops or fails. */
  _documentUrl?: string | null;
  /** The URL the preview last committed (did-navigate), reset when a document load starts. */
  _committedUrl?: string | null;
  _loadRetries?: number;
  _nav?: PreviewNavigation | null;
  _previewLocation?: string;
  _previewScroll?: { x: number; y: number };
  _restoringScroll?: number | null;
  _threadScrollRequest?: number;
  _threadPreview?: ThreadPreview<TermSession>;
  _previewModeChange?: Promise<void>;
  _prewarmed?: Set<string>;
  _prewarming?: Set<string>;
  _prewarmTimer?: TimerId;
  _pendingStaticReload?: boolean;
  _structuralHoldUntil?: number;
  _structQ?: Promise<void>;
  _inlineEditing?: boolean;
  _dragHintAt?: number;
  /** The route the page tree was last prefetched for. */
  __treePrefetched?: string;
  animPaused?: boolean;
  // The fitted canvas and visual zoom.
  fitScale?: number;
  artboard?: Artboard | null;
  /** Visual zoom and pan. */
  vz?: number;
  vtx?: number;
  vty?: number;
  _zoomedSent?: boolean;
  // What the preview's overlay reported about the page.
  meta?: PageMeta;
  _fields?: PreviewContentField[] | null;
  _fieldsFocus?: string | null;
  _fieldsPending?: boolean;
  _fieldsStale?: boolean;
  _pageTree?: PreviewPageTree | null;
  _pageTreeReq?: { route: string; at: number };
  _treeReadAt?: number;
  _styleAudit?: PreviewStyleAudit | null;
  _styleAuditReq?: { scope: string; route: string; at: number };
  _tokens?: TokenIndexCache;
  _tokensReq?: number;
  /** Token values as the page computes them, and true for each one an inline style sets (overlay radial:tokens-result). */
  _tokensLive?: Record<string, string>;
  _tokensInline?: Record<string, boolean>;
  // Layers.
  _lastSel?: string;
  _stepIx?: number | null;
  _stepT?: TimerId;
  _reselT?: TimerId;
  _reselT2?: TimerId;
  _lyCollapsed?: Set<string>;
  _lyCollV?: number;
  _lyExpandedFor?: string;
  // Pages: the sidebar's order.
  _top?: string[];
  _childOrder?: Record<string, string[]>;
  // Git and publishing.
  branch?: string | null;
  _branchInfo?: import('../shared/radialApi').BranchList;
  _connInfo?: import('../shared/radialApi').PushAuth | null;
  _vstatInfo?: import('../shared/radialApi').VercelStatus | null;
  _ahead?: number | null;
  _behind?: number | null;
  _hasUpstream?: boolean;
  _localChangeCount?: number;
  _unsaved?: number;
  _syncUnknown?: boolean;
  _lastFetchedAt?: number | null;
  _syncedAt?: number;
  _lastSyncCheck?: number;
  _lastAutoCommitAt?: number;
  // Build errors handed to the agent.
  _buildError?: string | null;
  _buildFixActive?: boolean;
  /** Fix attempts that reached the agent. */
  _buildFixAttempts?: number;
  _buildFixLastAt?: number;
  /** An attempt waits for the agent CLI's own question to be answered: no other goes until it's in. */
  _buildFixWaiting?: boolean;
  _buildFixTimer?: TimerId;
  // Context, comments and history.
  projectStorage?: ProjectStorageStatus;
  _refsCache?: ProjectReference[];
  comments?: ReviewComment[];
  /** Open comments are on their way to the agent (waiting, maybe, for its CLI's own question): no second pull meanwhile. */
  _commentsSending?: boolean;
  _vercel?: VercelCommentsStatus;
  _tpCommentsRequested?: boolean;
  _momentPreviewId?: string | null;
}

/** What the Home pseudo-tab has of its own. */
interface HomeTabFields extends AgentHost {
  id: 'home';
  home: true;
  name: 'Home';
  pageTitle: null;
  repoDir: string | null;
  terminals: TermSession[];
  activeTerminalId: string | null;
  term: TermSession | null;
  composerImages: ComposerImage[];
}
/**
 * The Home workspace's agent (renderer homeTab): shaped like a tab so every
 * terminal path works on it, but outside `tabs`. Its folder is the projects
 * folder, known once initHomeTab has asked main. It has none of a project's
 * own fields (no preview, pages or Git state): they read as undefined.
 */
type HomeTab = HomeTabFields & { [K in Exclude<keyof Tab, keyof HomeTabFields>]?: undefined };

/** A tab the agent code works with: a project, or Home. */
type AnyTab = Tab | HomeTab;

/** What a Recent row's closed project has (renderer recentThreadRows builds it for a saved chat). */
interface ClosedProjectFields { id: string; repoDir: string; name: string; home: false; terminals: TermSession[] }
/**
 * A Recent row's project when that project is closed: shaped like a tab for
 * the rail and the terminal helpers, with none of an open project's other
 * fields (they read as undefined).
 */
type ClosedProjectRow = ClosedProjectFields & { [K in Exclude<keyof Tab, keyof ClosedProjectFields>]?: undefined };

/** A Recents row of the rail (renderer recentThreadRows): a chat or terminal, its project (open, or a closed one's row), and when it last had a task. */
interface RailRecentThreadRow { tab: AnyTab | ClosedProjectRow; term: TermSession; at: number }

// ── Canvas selections (the overlay's captureSelection) ──────────────────────

/** How the Layers panel and the selection label show an element (overlay layerKind). */
type LayerKind = import('../shared/overlayMessages').LayerKind;

/**
 * An element picked on the canvas, as the overlay reports it (captureSelection,
 * its computed styles in `adjust`), with what arrives later (radial:select-enrich:
 * styleSource and the page scans) and what the window caches on it. The
 * renderer's panels all read the same object (quickEdit.sels).
 */
interface PreviewSelection extends Omit<CapturedSelection, 'styleSource'>, Partial<Pick<SelectEnrichPayload, 'styleSource' | 'typeScale' | 'palette'>> {
  /** ⇧-click: add to the selection. */
  additive?: boolean;
  /** The stylesheet rule the element's own styles live in, once resolved (the Adjust planner reads it). */
  anchor?: StyleAnchor | null;
  // What the panels asked the overlay for, and its answers.
  _anchorRequested?: boolean;
  _hoverSrcRequested?: boolean;
  /** Where each property's value comes from, by CSS property ('*anchor': the element's own rule). */
  _styleSources?: Record<string, PreviewPropSource>;
  _variantsRequested?: boolean;
  _variants?: VariantsResult | null;
  _motion?: MotionReadout;
  _image?: PreviewImageInfo;
  _a11y?: A11yReadout;
  _selColors?: ColorCount[];
  _codeReq?: boolean;
  _codeSrc?: import('../shared/radialApi').SourceLocation | { ok: false };
}

/**
 * Where a property's value comes from on the page (overlay radial:resolve-style →
 * radial:style-source), read without narrowing (a field another kind has reads
 * as undefined).
 */
type PreviewPropSource = LooseUnion<import('../shared/overlayMessages').StyleOrigin>;
/** The selection's transition and animation (overlay radial:motion-result); times in ms. */
type MotionReadout = import('../shared/overlayMessages').MotionReadout;
/** An image selection's geometry and weight (overlay radial:image-result). */
type PreviewImageInfo = ImageReadout;
/** The selection's accessible name, role and contrast, and the page's counts (overlay radial:a11y-result). */
type A11yReadout = import('../shared/overlayMessages').A11yReadout;
/** A colour the selection uses, counted (overlay radial:selcolors-result). */
type ColorCount = import('../shared/overlayMessages').ColorCount;
/** The page's button-like elements grouped by look (overlay radial:variants-result). */
type VariantsResult = import('../shared/overlayMessages').VariantsResult;
type VariantCluster = import('../shared/overlayMessages').VariantCluster;
/** A button style's look (a VariantCluster's signature). */
type ButtonSignature = import('../shared/overlayMessages').ButtonSignature;
/** The selection fields the overlay's per-selection answers fill (handleWebviewMessage). */
type OverlaySelResultField = '_motion' | '_image' | '_a11y' | '_selColors';
/** The payload key each of those answers carries its value under. */
type OverlaySelResultKey = 'motion' | 'image' | 'a11y' | 'colors';

/** One box-shadow layer as the Design panel edits it (renderer tpParseShadows). */
interface CssShadow { color: string; x: number; y: number; blur: number; spread: number; inset: boolean; hidden?: boolean }
/** A background gradient as the Design panel edits it (renderer tpParseGradient). */
interface CssGradient { type: string; angle: number; stops: { color: string; pos: number | null }[] }
/** The four everyday filter functions (renderer tpFlt); brightness, contrast and saturate in %. */
interface CssFilters { blur: number; brightness: number; contrast: number; saturate: number }

/**
 * A selection's styles as the Design panel shows them now: the overlay's
 * numbers, where a number (an inset's too) can also be the raw CSS typed into
 * the panel ('4rem', 'auto', '100%', 'fit-content'), shown as typed (renderer
 * qaApplyRaw, the size-mode menu). maxWidth stays the overlay's: max-width
 * steps through named rungs (qaStepNamed writes maxWidthName), never typed.
 * aspectRatio, the overlay's CSS text, can also be a number the steppers
 * wrote (qaApplyValue('aspect', 1.5)).
 */
type AdjustCurrent = { [K in keyof AdjustReadout]: K extends 'maxWidth' ? AdjustReadout[K] : K extends 'aspectRatio' ? AdjustReadout[K] | number : AdjustReadout[K] extends number | null ? AdjustReadout[K] | string : AdjustReadout[K] } & {
  /** The Tailwind max-width step, once the max-width stepper moved (qaStepNamed); a selection's own readout has none. */
  maxWidthName?: string;
};

/** The Adjust steppers' state for a single selection: its styles now, and the nudges not yet written. */
interface QuickAdjust {
  sel: PreviewSelection;
  cur: AdjustCurrent;
  deltas: StyleDeltas;
  /** :hover nudges. */
  hdeltas?: StyleDeltas;
  _enrichWaited?: boolean;
  /** Size dimensions already written directly (renderer qaApplyDirect). */
  _applied?: Record<string, boolean>;
  // The Design panel's parsed views of composite values, built on first use.
  _shadows?: CssShadow[];
  _grad?: CssGradient | null;
  _flt?: CssFilters;
  _tr?: { x: number; y: number };
  /** Show the image fill controls before the element has one (set when an image layer is added). */
  _layerOverride?: 'image' | null;
}

/**
 * The Motion panel's typed edits (quickEdit._motionEdits): duration and delay
 * in ms (the data-motion wells write numbers), and the easing as CSS text (a
 * preset, or the curve editor's cubic-bezier()).
 */
interface TpMotionEdits { duration?: number; delay?: number; easing?: string }

/**
 * The selection the quick-edit pill and the panels work on (renderer
 * showQuickEdit): the tab it is in, the picked elements, and the Adjust state
 * while exactly one is picked. Fields with a leading _ are the panels' choices.
 */
interface QuickEditState {
  tab: Tab;
  sels: PreviewSelection[];
  adj?: QuickAdjust | null;
  images?: ComposerImage[];
  /** The Design panel's state toggle (data-ds-state): edits apply at rest, or on :hover. */
  _dsMode?: 'base' | 'hover';
  /** Colour edits' scope: 'system' (the shared style or variable) or just this instance. */
  _colorScope?: 'system' | 'instance';
  /** The variant the Variants panel picked (its key). */
  _variantPick?: string | null;
  /** Motion values typed in the Motion panel. */
  _motionEdits?: TpMotionEdits | null;
  /** The Accessibility panel's findings, for "Fix with the agent". */
  _a11yIssues?: string[];
}

// ── Tool panels ─────────────────────────────────────────────────────────────

/** The tool panels (renderer TOOL_PANELS). */
type ToolPanelId = 'adjust' | 'content' | 'motion' | 'inspect' | 'code' | 'variants' | 'image' | 'a11y' | 'tokens' | 'insert' | 'layers' | 'page' | 'reconcile' | 'ask' | 'draw' | 'comments' | 'pages' | 'context' | 'history' | 'terminal' | 'publish' | 'branches';

/** A tool panel's definition (renderer TOOL_PANELS). */
interface ToolPanelDef {
  id: ToolPanelId;
  title: string;
  /** Hidden unless experimental mode is on. */
  experimental?: boolean;
  /** Other names a panel search finds it by. */
  aliases?: string[];
  /** Never merged into a float tab group. */
  independent?: boolean;
  /** Hosts a real, stateful surface (reparented through mount/unmount, never rebuilt). */
  live?: boolean;
  mount?: (body: HTMLElement) => void;
  unmount?: () => void;
}

/** A floating panel's (or group's) position and size, in px. */
interface ToolPanelPos { left?: number; top?: number; w?: number; h?: number }

/** Where one panel is and how it shows (saved in localStorage radial.toolPanels). */
interface ToolPanelPlacement {
  open: boolean;
  pos: ToolPanelPos | null;
  /**
   * Docked: in the right sidebar, or 'home' (the agent's slot). false floats it.
   * Older saves have true (pinned, before docks had sides) and 'left' (the
   * retired left dock); tpState migrates both.
   */
  pinned?: boolean | 'left' | 'right' | 'home';
  /** Shown inside another panel's body (v14: Inspect at the top of Layers). */
  host?: 'layers' | null;
  collapsed?: boolean;
  /** Docked in the fixed strip above the dock's scroller (with the agent), not in the scroller. */
  top?: boolean;
}

/** Floating panels merged into one tabbed window. */
interface ToolPanelGroup { panels: ToolPanelId[]; active: ToolPanelId; pos: ToolPanelPos | null }

/** A panel group's tab strip, faded at whichever end overflows: watchPanelTabOverflow sets __updFade. */
interface PanelTabStripElement extends HTMLElement { __updFade?: () => void }
/** A panel's header (buildFloatHead): what it was last built from, to skip a rebuild that changes nothing. */
interface PanelHeadElement extends HTMLElement { __built?: { html: string; group: ToolPanelGroup | null; placement: ToolPanelPlacement } }
/**
 * A panel surface that fades its clipped edges while it overflows: attachScrollFade
 * sets both fields, and renderPanelDock and toggleDockAddMenu read __updateFade.
 */
interface ScrollFadeTarget extends Element { __fadeWired?: boolean; __updateFade?: () => void }
/** A sidebar pane a live panel hosts (mountSidebarPane): where it sat in the page, to put it back. */
interface TpHostedPaneEl extends HTMLElement { __home?: { parent: HTMLElement; next: ChildNode | null } }

/**
 * The panels' saved state (renderer tpState): a placement per panel, plus
 * keys with a leading _ for the layout as a whole.
 */
type ToolPanelState = { [Id in ToolPanelId]: ToolPanelPlacement } & {
  /** The schema version tpState migrates from. */
  _v?: number;
  /** v2's all-or-nothing dock; no longer read. */
  _docked?: boolean;
  /** The docks' section order. */
  _order?: ToolPanelId[];
  _groups?: Record<string, ToolPanelGroup>;
  /** The floating quick-edit pill; false: selections feed the panels only. */
  _qeFloat?: boolean;
  /** The agent section's height in the home slot. */
  _pdAgentH?: number;
  /** The fixed strip's height per side, as dragged. */
  _pdFixedH?: number;
  _pdFixedLH?: number;
  /** The Design panel's sub-section states. */
  _ds?: Record<string, boolean>;
  _swapOpen?: boolean;
};

// ── Draw mode ───────────────────────────────────────────────────────────────

type DrawTool = 'pen' | 'rect' | 'arrow' | 'label' | 'move';
/** One mark on the draw layer, in the layer's CSS px. */
type DrawStroke =
  | { tool: 'pen'; points: Point[] }
  | { tool: 'rect' | 'arrow'; from: Point; to: Point }
  | { tool: 'label'; text: string; at: Point };
/** Draw mode while it is on (renderer enterDrawMode). */
interface DrawState {
  tab: Tab;
  canvas: HTMLCanvasElement;
  tools: HTMLDivElement;
  strokes: DrawStroke[];
  tool: DrawTool;
  /** The mark being drawn: a pen line, box or arrow (a label goes straight onto strokes). */
  cur: Exclude<DrawStroke, { tool: 'label' }> | null;
  /** The move tool's pick, and where its drag last was. */
  selected?: DrawStroke | null;
  dragLast?: Point | null;
  /** The text field of a label being typed. */
  labelEditor?: { el: HTMLInputElement; at: Point } | null;
  onKey?: (event: KeyboardEvent) => void;
  onResize?: () => void;
}

// ── Context files ───────────────────────────────────────────────────────────

/** The context file open in the editor (renderer openContextFile): a note, an image, or the project's rules. */
interface ContextFileState {
  rel: string;
  name: string;
  content?: string;
  abs?: string;
  /** An image: shown, not edited. */
  image?: boolean;
  /** The project's rules (AGENTS.md, or its local copy), rel '__AGENTS__'. */
  memory?: boolean;
  dirty: boolean;
}

// ── Menus and the command palette ───────────────────────────────────────────

/** A row of a popup menu (renderer openHomeMenu, the chat menus). */
interface MenuAction {
  label: string;
  action: () => unknown;
  /** A radio row; undefined for a plain one. */
  checked?: boolean;
  /** An icon's SVG markup. */
  icon?: string;
  disabled?: boolean;
}
/** The popup menu that is open (renderer homeMenu). */
interface OpenMenu { anchor: HTMLElement; close: (restore?: boolean) => void; reanchor(next: HTMLElement): void }
/** Opens a popup menu under `anchor`; `last` focuses its last row. */
type OpenMenuFn = (anchor: HTMLElement, items: MenuAction[], last?: boolean) => void;

/** A command palette row (renderer buildCommands, openCmdK). */
interface CommandItem {
  label: string;
  /** The shortcut or detail shown on the right. */
  hint?: string;
  /** More text the search matches. */
  keywords?: string;
  /** The menu shortcut whose binding replaces `hint`. */
  shortcutId?: string;
  /** A project row's favicon. */
  favicon?: string | null;
  /** A project row's last open, for the recency bonus. */
  when?: number;
  run: () => unknown;
}

/** An icon from the generated set, as markup (renderer icon). */
type IconFn = (name: string, size?: number) => string;

// ── The window scripts' APIs ────────────────────────────────────────────────

/** A chat as the native chat panel caches it: from the list (a summary) or fetched whole. */
type NativeChatRecord = ChatSummary | ChatSession;
/** Model, effort, permissions or engine picked before the chat they are for exists. */
type PendingChatSettings = ChatSettings & { engine?: ChatEngine };

/** What the native chat (nativeChat.ts) asks of the renderer (RadialNativeChat.configure). */
interface NativeChatHooks {
  icon: IconFn;
  providerLogo: (provider: string | null | undefined, size?: number) => string;
  radialLogo: () => string;
  moreIcon: string;
  markdown: (text: string) => string;
  confirm: (message: string, options?: ConfirmOptions) => Promise<boolean>;
  canPreview: (url: string) => boolean;
  /** Open a URL in the preview; with none, bring the preview forward. */
  openPreview: (url?: string) => void;
  reviewChanges: () => unknown;
  /**
   * Show a chat's terminal view in the agent pane, unless `wanted` says no once
   * the project's terminals are listed (something else went on screen in that
   * wait). True when it shows it.
   */
  openTerminal: (session: ChatSession, wanted?: () => boolean) => Promise<boolean>;
  openOtherCLI: () => unknown;
  /** The engine a new chat starts with: the first installed CLI. */
  defaultEngine?: () => Promise<ChatEngine | null>;
  renderRail: () => void;
  menu: OpenMenuFn;
  selectPreview: (session: ChatSession) => Promise<void> | void;
  notify?: (message: string) => void;
  /** Bring a chat's project (or Home) forward; false: the person declined to reopen it. */
  openContext: (session: NativeChatRecord) => Promise<boolean>;
  /** The project (or Home) the chat panel is for. */
  context: () => NativeChatContext;
}
interface NativeChatContext { repoDir: string | null | undefined; home: boolean; name: string }
/** The native chat panel (nativeChat.ts). */
interface RadialNativeChatApi {
  configure(hooks: NativeChatHooks): Promise<void>;
  refresh(): Promise<void> | undefined;
  /** Sends the composer's text (or `text`); false when it couldn't. */
  send(text?: string, displayText?: string, allowQueue?: boolean): Promise<boolean>;
  /** Every chat with its rail stand-in, for Recent. */
  history(): { session: NativeChatRecord; term: TermSession }[];
  sendError(): string;
  /** The tab's open chats as rail rows. */
  terms(tab: AnyTab | ClosedProjectRow | null | undefined): TermSession[];
  wireRow(row: HTMLElement): void;
  /** A new chat, shown as New chat shows one; `message` is sent as its first message before it shows. Answers the chat as it was made. */
  createFor(tab: AnyTab, engine?: ChatEngine, message?: string): Promise<ChatSession>;
  select(id: string): Promise<void>;
  /**
   * The project's (or Home's) first chat, the one the panel started when it
   * showed it, once the panel has settled there; null when it started none or
   * someone has used it since.
   */
  firstChat(tab: AnyTab): Promise<ChatSession | null>;
  /** Deletes a chat nobody has used, and forgets it; false when it was used, and is kept. */
  discard(id: string): Promise<boolean>;
  persistPreview(term: TermSession): void;
  selected(id: string): boolean;
  visibleId(): string | null;
  enabled(): boolean;
  active(): boolean;
  /**
   * The chat whose terminal view the agent pane shows; none for a plain
   * terminal. `pickedIn`: the project (or Home) where someone chose it, which
   * a refresh or a first chat already starting there then leaves on screen;
   * none when the window only puts back what the project showed.
   */
  terminal(id?: string | null, pickedIn?: AnyTab | null): void;
  stage(text: string): boolean;
}

/** One running process on Home's activity list (workspaceHome render). */
type WorkspaceRuntimeRow =
  | ({ kind: 'server'; name: string; repoDir: string; detail: string; state: 'External' | 'Running'; id?: undefined; home?: undefined } & ServerActivity)
  | ({ kind: 'terminal'; name: string; detail: string; url?: undefined; external?: undefined; observedAt?: undefined } & TerminalActivity);
/** What Home's workspace panel (workspaceHome.ts) asks of the renderer. */
interface WorkspaceHomeHooks {
  icon: IconFn;
  visible: () => boolean;
  openActivity: () => void;
  /**
   * Sent (true), not (false), or waiting for the agent CLI's own question to be answered first: delivered says when it
   * went in, typing when it starts to go in, and cancel calls it off until then (true), never after (false).
   */
  send: (payload: { text: string; label: string; submit: boolean }) => Promise<boolean | { waiting: true; delivered: Promise<boolean>; typing: Promise<void>; cancel(): boolean }>;
  sendError?: () => string;
  openRuntime: (row: WorkspaceRuntimeRow) => Promise<void>;
}
interface RadialWorkspaceHomeApi {
  configure(hooks: WorkspaceHomeHooks): void;
  refresh(): Promise<WorkspaceActivity | null>;
  render(): void;
}

/** What the project library (projectLibrary.ts) asks of the renderer. */
interface ProjectLibraryContext {
  icon: IconFn;
  openMenu: OpenMenuFn;
  home: () => void;
  render: () => void;
  openLocal: (dir: string) => Promise<OpenProjectResult>;
  openGithub: (url: string, localPath?: string) => Promise<OpenGitHubResult | { ok: false; error: string }>;
  notify: (text: string) => void;
  isCurrent: (dir: string) => boolean;
  review: (dir: string) => void;
}
/** A library status as projectLibrary caches it, read without narrowing (a failed read's fields are undefined). */
type LibraryCacheEntry = LooseUnion<LibraryEntry> & { readAt: number };
/** Home's GitHub repository list (projectLibrary renderGithub). */
interface LibraryGithubView {
  host: HTMLElement;
  list: HTMLDivElement;
  note: HTMLParagraphElement;
  /** The search box's text. */
  query: string;
  repos: GitHubRepo[];
  /** Counts loads, so a stale answer is dropped. */
  version: number;
  loading?: boolean;
  error?: boolean;
  truncated?: boolean;
}
interface RadialProjectLibraryApi {
  configure(context: ProjectLibraryContext): void;
  observeRows(items: { path: string }[]): Promise<void>;
  paintRows(): void;
  renderGithub(host: HTMLElement, query?: string): void;
  choose(url: string, supplied?: LibraryEntry[] | null, localDir?: string): Promise<void>;
  check(dir: string, fetch?: boolean): Promise<LooseUnion<LibraryEntry>>;
  label(status: LooseUnion<LibraryEntry> | null | undefined): string;
  metadata(dir: string): LibraryCacheEntry | undefined;
  inspect(dir: string): Promise<void>;
  opened(dir: string): Promise<void>;
  openMessage(result: OpenedFromGitHub): string;
}

/**
 * A page of the publish surfaces: publish settings (publishSettings.ts), or a
 * page of the Git dialog (collaboration.ts open), which shows the changes for
 * any name it doesn't know.
 */
type PublishPage = 'settings' | 'repository' | 'hosting' | 'changes' | 'pulls' | 'pull' | 'deployments' | 'conflicts' | 'incoming' | 'commit' | 'local-deploy' | 'review';
/** What the publish surfaces and the Git dialog do for the renderer (renderer collaborationContext). */
interface CollaborationContext {
  repoDir: string;
  settings?: () => unknown;
  /**
   * A publish action made a commit (its result has a sha), or a merge finished.
   * Read without narrowing (the renderer's handler reads `steps`, which a merge's
   * receipt lacks); a plain PublishSurfaceReceipt assigns to it.
   */
  onResult?: (result: LooseUnion<PublishSurfaceReceipt>) => void;
  onChanged?: () => Promise<void> | void;
  sendAgent?: (text: string) => Promise<unknown> | unknown;
  onBusy?: (busy: boolean) => void;
  onClose?: () => void;
  /** The pull request a 'pull' page opens. */
  number?: number;
  /** Sign in to Vercel's CLI (publishSurfaceContext). */
  setupHosting?: (reason: Extract<VercelScopes, { ok: false }>['reason']) => Promise<void> | void;
  /** Publish settings saved (publishSettings calls it only once the save succeeded). */
  settingsChanged?: (result: LooseUnion<Extract<ConfigSetResult, { ok: true }> | Extract<import('../shared/radialApi').VercelLinkResult, { ok: true }>>) => Promise<void> | void;
}
/**
 * The receipt of a local-files deploy (collaboration localDeploy): the local
 * commit's (a publish with push: false, so nothing was pushed), deployed to
 * Vercel, with the deployment's URL, null when the CLI printed none (vercel.ts
 * parseDeployUrls). Every reader tests it first (collaboration link(), and the
 * publish panel's https checks).
 */
type LocalDeployReceipt = Omit<import('../shared/radialApi').PublishReceipt, 'mode' | 'pushed'> & { mode: 'vercel'; url: string | null; pushed: false };
/** A pull request the publish panel merged (publishWorkflow merge): the target it was for, and the checkout's head before the merge. */
type WindowMergeReceipt = import('../shared/radialApi').MergeReceipt & { target: PublishTarget; sourceHead: string | null | undefined };
/** A publish action's result that made a commit: it has a sha (a failure after the commit is a FailedPublishReceipt). */
type CommittedPublishResult = Extract<import('../shared/radialApi').PublishResult | import('../shared/radialApi').PublishDeployResult, { sha: string }>;
/**
 * A receipt as the publish surfaces hand it on (onResult) and keep it
 * (PublishDraft.receipt): a publish's result once it made a commit, a local
 * deploy's, a merge's, or the one main saved.
 */
type PublishSurfaceReceipt = StoredReceipt | CommittedPublishResult | LocalDeployReceipt | WindowMergeReceipt;
/** What a Git dialog publish step overrides in the draft (collaboration preparePublish). */
type PublishActionOverrides = import('../shared/radialApi').PublishOptions & { commitOnly?: boolean };
/** A project's publish run, shared by its publish surfaces (publishWorkflow job). */
interface PublishJob {
  busy: boolean;
  /** The build output so far. */
  log: string;
  kind?: 'settings' | 'integration' | 'publish';
  progress?: string;
  error?: string;
  /** The last action's answer: a publish's, an integration's, or a merge's receipt. */
  result?: LooseUnion<import('../shared/radialApi').PublishDeployResult | import('../shared/radialApi').IntegrationResult | WindowMergeReceipt> | null;
}
/** The publish choices kept per project (publishWorkflow draft, localStorage radial.publish:<dir>). */
interface PublishDraft {
  target: PublishTarget;
  /** What a publish commits first: every change, the staged ones, or none (push existing commits only). */
  scope: 'all' | 'staged' | 'none';
  message: string;
  receipt?: LooseUnion<PublishSurfaceReceipt> | null;
  /** The receipt's deployment as last observed; read without narrowing (a field another state lacks is undefined). */
  deployment?: LooseUnion<DeploymentObservation | { state: 'unknown' }> | null;
}
/** A mounted publish panel's controls (publishWorkflow mount). */
interface PublishSurfaceUi {
  task: HTMLDivElement;
  history: HTMLButtonElement;
  status: HTMLSpanElement;
  time: HTMLSpanElement;
  receiptChevron: HTMLSpanElement;
  files: HTMLButtonElement;
  targets: HTMLFieldSetElement;
  current: HTMLParagraphElement;
  details: HTMLDetailsElement;
  connection: HTMLSpanElement;
  repo: HTMLParagraphElement;
  edit: HTMLButtonElement;
  branch: HTMLElement;
  outgoing: HTMLSpanElement;
  remoteStatus: HTMLSpanElement;
  fetch: HTMLButtonElement;
  github: HTMLButtonElement;
  pulls: HTMLButtonElement;
  remoteRows: HTMLDivElement;
  sites: HTMLDivElement;
  deploymentNote: HTMLParagraphElement;
  error: HTMLParagraphElement;
  retry: HTMLButtonElement;
  incoming: HTMLButtonElement;
  integrationNote: HTMLParagraphElement;
  prFields: HTMLDivElement;
  prTitle: HTMLInputElement;
  prBranch: HTMLElement;
  prNote: HTMLParagraphElement;
  hint: HTMLParagraphElement;
  progress: HTMLParagraphElement;
  prReview: HTMLButtonElement;
  prStatus: HTMLParagraphElement;
  mergeMethod: HTMLSelectElement;
  mergeField: HTMLLabelElement;
  liveLog: HTMLDetailsElement;
  liveLogText: HTMLPreElement;
  logs: HTMLDivElement;
  receiptSummary: HTMLParagraphElement;
  receiptMessage: HTMLParagraphElement;
  receiptBuild: HTMLParagraphElement;
  receiptDeployment: HTMLParagraphElement;
  receiptOutput: HTMLDetailsElement;
  receiptLog: HTMLPreElement;
  receiptAgent: HTMLButtonElement;
  receiptLink: HTMLButtonElement;
  action: HTMLButtonElement;
  settings: HTMLButtonElement;
}
type CollaborationPlan = import('../shared/radialApi').CollaborationPlan;
type CollaborationState = import('../shared/radialApi').CollaborationState;
/**
 * A destination check with its parts read without narrowing (a field one state
 * lacks reads as undefined), as the publish panel (publishWorkflow paint,
 * execute) and the Git dialog (collaboration PlanResult) read it.
 */
type LoosePlan = Omit<CollaborationPlan, 'capabilities' | 'hosting' | 'deployment' | 'relation'> & {
  capabilities: LooseUnion<GitHubCapabilities> | null;
  hosting: LooseUnion<import('../shared/radialApi').HostingInfo>;
  deployment: LooseUnion<import('../shared/radialApi').DeploymentDestination>;
  relation: LooseUnion<import('../shared/radialApi').RepoSync> | null;
};
/** A pull request's detail, its capabilities read without narrowing (a failed check has no merge methods): publishWorkflow PullStatus, collaboration PullResult. */
type LoosePullRequestDetail = Omit<PullRequestDetail, 'capabilities'> & { capabilities: LooseUnion<GitHubCapabilities> };
/** A mounted publish panel (publishWorkflow mount): its project, what it last read, and its controls. */
interface PublishSurface {
  host: HTMLElement;
  context: CollaborationContext;
  /** Counts invalidations, so a stale answer is dropped. */
  revision: number;
  /** The destination checks per target, fresh for 30 s. */
  plans: Map<PublishTarget, { key: string; plan: CollaborationPlan; at: number }>;
  pendingPlans: Map<PublishTarget, { key: string; version: number; promise?: Promise<void> }>;
  /** Filled in by mount as it builds the panel. */
  ui: PublishSurfaceUi;
  config?: import('../shared/radialApi').ConfigInfo;
  state?: LooseUnion<CollaborationState>;
  links?: import('../shared/radialApi').PublishLinkState;
  plan?: CollaborationPlan | null;
  /** How the checkout relates to the destination. */
  relation?: LooseUnion<CollaborationState | import('../shared/radialApi').RepoSync> | null;
  error?: string;
  /** The open task page. */
  task?: PublishPage | null;
  receiptOpen?: boolean;
  fetching?: boolean;
  loading?: boolean;
  /** The last receipt's pull request, as GitHub reports it. */
  prStatus?: import('../shared/radialApi').ReviewResults['detail'] | { ok: false; error: string } | null;
  prKey?: string;
  prAt?: number;
  deploymentAt?: number;
}
interface RadialPublishApi {
  draft(dir: string): PublishDraft;
  update(dir: string, patch: Partial<PublishDraft>): PublishDraft;
  mount(host: HTMLElement, context: CollaborationContext): void;
  refresh(): void;
  receiptFor(dir: string, state?: LooseUnion<CollaborationState> | null): LooseUnion<PublishSurfaceReceipt> | undefined;
  open(host: HTMLElement, page: PublishPage): void;
}
interface PublishSettingsOptions {
  repoDir: string;
  page?: 'settings' | 'repository' | 'hosting';
  done: () => void;
  changed?: CollaborationContext['settingsChanged'];
  busy?: (busy: boolean) => void;
  setup?: CollaborationContext['setupHosting'];
}
interface RadialPublishSettingsApi { mount(host: HTMLElement, options: PublishSettingsOptions): void }
interface RadialProjectStorageSettingsApi { mount(host: HTMLElement, repoDir?: string | null): Promise<void> }
interface RadialCollaborationApi {
  open(options: CollaborationContext, page?: PublishPage, host?: HTMLElement): boolean;
  publish(options: CollaborationContext, opts?: Partial<PublishDraft>): void;
  close(): boolean;
  isBusy(): boolean;
}

/** A file's contents for the diff viewer. */
interface DiffViewFile { name: string; contents: string }
/** What the diff viewer (diffView.ts) shows: a patch, two versions of a file, or one file. */
type DiffViewData = DiffViewPatch | DiffViewFiles | DiffViewSingleFile;
/** A unified diff of one file. */
interface DiffViewPatch {
  kind: 'patch';
  /** Missing or empty: the viewer says there are no text changes. */
  patch?: string | null;
  /** A GitHub per-file patch: hunks with no headers. */
  hunksOnly?: boolean;
  name?: string;
  previousName?: string;
  /** GitHub's file status ('added', 'removed', …). */
  status?: string;
}
/** Two versions of a file, diffed by the viewer. */
interface DiffViewFiles {
  kind: 'files';
  /** null for an added file. */
  oldFile: DiffViewFile | null;
  newFile: DiffViewFile;
  name?: string;
}
/** One file's contents, shown without a diff. */
interface DiffViewSingleFile { kind: 'file'; file: DiffViewFile; name?: string }
/** vendor/diffs/diffs.js: @pierre/diffs's exports the diff viewer uses (scripts/diffs-entry.mts). */
type DiffsBundle = Pick<typeof import('@pierre/diffs'), 'File' | 'FileDiff' | 'parsePatchFiles'>;
/** A diff viewer mounted in a host element (diffView render). */
type DiffsFileDiff = import('@pierre/diffs').FileDiff<undefined, undefined>;
type DiffsFile = import('@pierre/diffs').File<undefined, undefined>;
/** The options one diff viewer builds, for a FileDiff or a File. */
type DiffsViewOptions = import('@pierre/diffs').FileDiffOptions<undefined, undefined> & import('@pierre/diffs').FileOptions<undefined, undefined>;
interface DiffViewState {
  instance: DiffsFileDiff | DiffsFile | null;
  /** The unified / split toggle. */
  buttons: HTMLButtonElement[];
  isDiff: boolean;
}
interface RadialDiffsApi {
  render(host: HTMLElement, data: DiffViewData): Promise<void>;
  clear(root: HTMLElement): void;
}

/** What the color picker opens with (colorPicker.ts). */
interface ColorPickerOptions {
  color?: string | null;
  anchorRect?: DOMRect | { left: number; right: number; top: number } | null;
  title?: string;
  /** Every live change, as CSS. */
  onChange?: (css: string) => void;
  /** On close: the committed colour, or null when nothing changed. */
  onClose?: (css: string | null) => void;
}
/** The color picker's format tabs. */
type ColorPickerTab = 'hex' | 'rgb' | 'oklch';
/** The color picker while it is open (colorPicker open): hue, saturation, value and alpha, 0–1 except hue (degrees). */
interface ColorPickerState {
  h: number;
  s: number;
  v: number;
  a: number;
  /** The format tab. */
  tab: ColorPickerTab;
  onChange?: ColorPickerOptions['onChange'];
  onClose?: ColorPickerOptions['onClose'];
  dirty: boolean;
}
interface RadialColorPickerApi {
  open(options: ColorPickerOptions): void;
  close(commit?: boolean): void;
  isOpen(): boolean;
}

/** The canvas tools' one-key shortcuts (shortcuts.ts); the overlay forwards the same keys (radial:tool-key). */
type CanvasToolMode = import('../shared/overlayMessages').CanvasToolMode;
/** Looked up by any pressed key: a key that isn't a tool's reads undefined. */
type RadialToolKeyMap = Readonly<Partial<Record<string, CanvasToolMode>>>;
interface RadialShortcutPromoterApi {
  bindingLabel(id: string): string;
  manual(id: string, event?: MouseEvent | KeyboardEvent | null): void;
  mountSettings(host: HTMLElement): void;
}

/** What the chat composer (chat/composer.ts) is built on. */
interface ChatComposerOptions {
  input: HTMLTextAreaElement;
  form: HTMLFormElement;
  /** The draft the attachments belong to (the chat, or the project before one exists). */
  key: () => string;
  context: () => NativeChatContext;
  /** Something changed: repaint; with an error message to show. */
  changed: (error?: string) => void;
  menu: OpenMenuFn;
  icon: IconFn;
  commands: () => { name: string; action: () => unknown }[];
  previewImage: (item: ChatImagePreview) => void;
}
/** An image the chat shows full size (nativeChat previewImage): its name and a URL to load it from. */
interface ChatImagePreview { name: string; src: string }
/** An attachment in the composer: a saved file, or a project file referenced by path. */
type ChatAttachment = ChatFile | ChatFileMatch;
interface ChatComposer {
  files(): ChatAttachment[];
  refresh(): void;
  closePicker(): void;
  clear(target: string): void;
  busy(): boolean;
  take(): ChatAttachment[];
  restore(list: ChatAttachment[], target?: string): void;
}
interface RadialChatComposerApi { create(options: ChatComposerOptions): ChatComposer }

/** What a rendered chat response can do (chat/responses.ts render). */
interface ChatResponseActions {
  /** The response is still streaming: skip highlighting and image previews. */
  streaming?: boolean;
  canPreview?: (url: string) => boolean;
  /** Called only for a link canPreview accepted. */
  preview?: (url: string) => void;
  file: (reference: string, action: ChatResourceAction) => unknown;
  /** A referenced image's file and a URL for it (nativeChatResource); render shows it only when it has a src. */
  describe: (reference: string) => Promise<LooseUnion<ChatResourceResult>>;
  previewImage: (item: ChatImagePreview) => void;
}
/** A button chat/responses.ts copies from: it keeps its label to put back. */
interface CopyButton extends HTMLElement {
  _copyOriginal?: { html: string; label: string | null; tip: string | undefined };
  _copyTimer?: TimerId;
}
interface RadialChatResponsesApi {
  render(body: HTMLElement, text: string, actions: ChatResponseActions): void;
  copy(text: string, target: CopyButton, copiedIcon?: string): Promise<void>;
  button(text: string, action: (event: MouseEvent) => unknown): HTMLButtonElement;
}

/** The chat's markdown, sanitizer and highlighter, bundled by scripts/build-chat.mts (vendor/chat/content.js). */
interface RadialChatContentBundle {
  Marked: typeof import('marked').Marked;
  DOMPurify: typeof import('dompurify').default;
  hljs: typeof import('highlight.js').default;
}

/**
 * A row of a chat's activity (fluid ThinkingSteps): a tool message, whose name
 * and status can be missing (the bridge shows 'Tool' and a finished step).
 * bridge.tsx's own copy (activity's parameter) still requires name and
 * status; widen it to match when the fluid project is typed.
 */
interface FluidActivityTool { id: string; name?: string; status?: string; node: HTMLElement }
/** A response's action button (fluid ResponseAction). */
interface FluidMessageAction { id: string; label: string; icon: string; disabled?: boolean; action?: () => void; copyText?: string }
/**
 * A question the agent asked (fluid QuestionFlow): a ChatQuestion, whose text
 * can be missing. bridge.tsx's own copy (AgentQuestion) still requires
 * `question`; widen it to match when the fluid project is typed.
 */
interface FluidQuestion { id: string; question?: string; multiSelect?: boolean; optionsOnly?: boolean; options?: { label: string; description?: string }[] }
interface FluidAttachment { path: string; name: string; size?: number; mime?: string }
interface FluidAttachmentsProps {
  items: FluidAttachment[];
  repoDir: string;
  remove?: (item: FluidAttachment) => void;
  open?: (item: FluidAttachment) => void;
  preview: (item: ChatImagePreview) => void;
}
interface FluidQueueProps {
  items: { id: string; text: string; displayText?: string; attachments?: unknown[] }[];
  paused: boolean;
  reorder: (ids: string[]) => Promise<boolean>;
  edit: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  resume: () => Promise<boolean>;
}
/**
 * The React chat UI's islands (src/renderer/fluid/bridge.tsx, bundled by
 * scripts/build-fluid.mts into vendor/fluid/chat.js as window.RadialFluidChat).
 */
interface RadialFluidChatApi {
  clear(container: HTMLElement): void;
  activity(host: HTMLElement, tools: FluidActivityTool[]): void;
  actions(host: HTMLElement, items: FluidMessageAction[]): void;
  attachments(host: HTMLElement, props: FluidAttachmentsProps): void;
  queue(host: HTMLElement, props: FluidQueueProps): void;
  questions(host: HTMLElement, items: FluidQuestion[], submit: (answers: Record<string, string[]>) => Promise<boolean>): void;
  mount(form: HTMLFormElement): void;
  sync(): void;
  dismiss(): void;
  menu(anchor: HTMLElement, items: MenuAction[]): void;
}

// ── Renderer helpers' options and small shapes ─────────────────────────────

/**
 * A prompt for the agent (renderer engineSend, engineSendQuiet, quickEditToTerminal):
 * the text, the canvas selections it is about and images by path, composed by
 * composeForEngine.
 */
interface AgentPrompt {
  text?: string;
  selections?: PreviewSelection[];
  /** Absolute paths of images the agent should read. */
  images?: string[];
  /** Run it now; otherwise it is staged in the terminal for review. */
  submit?: boolean;
  /** The thread's name for it (defaults to a summary of the text). */
  label?: string | null;
  /** The CLI to send to; the active terminal's otherwise. */
  engine?: ChatEngine;
}

/** The agent pane's tab (renderer setRightTab); 'agent' is an old name for 'terminal'. */
type RightTab = 'agent' | 'terminal' | 'comments' | 'history';

/** The global settings' pages (renderer settingsPages). */
type SettingsPage = 'general' | 'connections' | 'privacy' | 'about';
/**
 * One integration row on a Settings page (renderer setItem): a brand icon, a
 * title and description, and either a Connect button (its element id and
 * label) or a Connected mark. The global page's rows carry what the button
 * runs (SettingsSetupRow, wired by wireSetupBtns); the project page wires its
 * one button itself.
 */
interface SettingsIntegrationRow { icon?: string; title: string; desc?: string; action?: { id: string; label: string }; ok?: boolean }
/** A Settings row's Connect button and what it runs (agentSetupRow and the other row builders; wireSetupBtns attaches run). */
interface SettingsRowAction { id: string; label: string; run: () => unknown }
/** An integration row the global Settings page builds, its button's action included. */
type SettingsSetupRow = SettingsIntegrationRow & { action?: SettingsRowAction };
/** A step of the setup checklist (renderer renderOnboarding, obStepHtml): a command to run or a link to open, and why the person runs it. */
interface OnboardingStep {
  id: string;
  done: boolean;
  title: string;
  /** Markup. */
  body: string;
  optional?: boolean;
  cmd?: string | null;
  link?: string | null;
  /** Markup. */
  why?: string | null;
}

/** A Layers row pressed and about to drag (renderer lyDragArm). */
interface LayerDragArm { row: HTMLElement; selector: string; x: number; y: number }

/** An element the Add panel inserts (renderer ADD_ELEMENTS); {{u}} in the markup becomes a unique suffix. */
interface AddElementDef { label: string; markup: string }

/** A link the preview's link badge asks to edit (overlay radial:edit-link). */
type EditLinkRequest = import('../shared/overlayMessages').EditLinkRequest;

/** A Design-panel value changed by hand this session, for the Reconcile panel (renderer recordTweaks). */
interface SessionTweak {
  id: string;
  repoDir: string;
  route: string;
  tag: string;
  prop: string;
  from: string;
  to: string;
  /** The rule it came from: '.class' or 'inline'. */
  source: string;
  /** Off the page's type scale, its 4px lattice or its palette. */
  offScale: boolean;
  selRef: PreviewSelection;
}

/** A head tag the Page settings panel edits (renderer META_FIELDS). */
interface MetaFieldDef {
  group: string;
  key: keyof PageMeta;
  label: string;
  /** The <title> element rather than an attribute. */
  kind?: 'title';
  attr?: string;
  /** What finds the tag in source. */
  locator: string;
  multiline?: boolean;
  image?: boolean;
}

/** An @ mention the composer offers: a context doc or a page's source file (renderer mentionCandidates). */
interface MentionItem { label: string; path: string; kind: 'doc' | 'page'; desc: string }

/** A button whose icon cross-fades between two (renderer iconSwap): the pair's wrapper, once built. */
interface IconSwapButton extends HTMLElement { _swap?: HTMLElement }

/** A tab's view, kept in sessionStorage across a development reload (renderer saveDevReloadState). */
interface DevReloadTab {
  repoDir: string;
  currentRoute: string;
  /** Saves from older builds can hold 'desktop'. */
  viewportMode: ViewportMode | 'desktop';
  width: number;
  viewportAspect: null;
  editMode: boolean;
}
interface DevReloadState { activeRepoDir?: string | null; tabs: DevReloadTab[] }

/** confirmAction's options. */
interface ConfirmOptions { title?: string; okLabel?: string; danger?: boolean }
/** promptText's options. */
interface PromptOptions { placeholder?: string; okLabel?: string; initial?: string }
/** A toast's look: '' plain, 'ok' success, 'err' failure. */
type ToastKind = '' | 'ok' | 'err';
