// The window's API (window.radial, which the preload puts there through
// contextBridge) and the shapes that cross IPC between the main process and the
// window. Types only, with no Electron or Node imports: the window's type-check
// reads this file (src/renderer/globals.d.ts), and the window has no Node at
// runtime (contextIsolation, no nodeIntegration). The preload implements
// RadialApi (preload.ts `const api: RadialApi`); main's ipcMain handlers produce
// these results, and main modules import the shapes from here, so the window
// never imports main code.

import type { StylePlan, StyleSource } from '../renderer/adjustDirect';
import type { TaskLabel } from '../renderer/taskTitle';
import type { PreviewMode, PreviewView } from '../renderer/threadPreview';
import type { ChatEngine, ClaudeDefaultMode, ClaudePermissionMode, PermissionMode } from './chatPermissions';

// ── What the main process answers (its ipcMain handlers in main.ts) ─────────
// Most results are a discriminated `ok`; failure reasons are the literal strings
// the handlers return.

/** Omit applied to each member of a union (plain Omit keeps only the shared keys). */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** Every main → window event that names a project carries its folder. */
export interface RepoDirEvent { repoDir: string }
/** The common failure: a message to show. */
export type OkOrError = { ok: true } | { ok: false; error: string };

// ── Projects ──

export type PackageManager = 'npm' | 'pnpm' | 'yarn';
/** How a folder runs as a website (devServer.detectProject). */
export type DetectedProject =
  | { type: 'node'; framework: 'node' | 'next' | 'astro' | 'vite' | 'gatsby'; devScript: 'dev' | 'start'; buildScript: 'build' | null; pm: PackageManager; name: string }
  | { type: 'static'; framework: 'static'; staticRoot: string; name: string }
  | { type: 'unknown'; name: string };
/**
 * A project that runs: an open or refreshed project is never `unknown`
 * (startRepo refuses it, devServer.start throws for it, refreshProject answers
 * reason 'unknown' instead).
 */
export type RunnableProject = Exclude<DetectedProject, { type: 'unknown' }>;
/** A page of the site; Home comes first (project.listPages). */
export interface ProjectPage { route: string; label: string; file: string | null }
export interface PageGroup { name: string; routes: string[] }
/** A project's .radial.json over its defaults (publish.readConfig). */
export interface RadialConfig {
  productionPublish: 'direct' | 'pr';
  productionBranch: string;
  stagingBranch: string;
  commitConfig: boolean;
  hiddenPages: string[];
  pageGroups?: PageGroup[];
  /** The sidebar's top-level order: routes, 'g:Name' groups, 'a:seg' auto groups. */
  pageOrder?: string[];
  autoOrder?: Record<string, string[]>;
  siteUrl?: string | null;
  stagingUrl?: string;
  productionUrl?: string;
}
/** How a recent project was opened; every entry so far is a local folder. */
export type RecentKind = 'local';
/** One row of the Home screen's recent projects, newest first (recents.ts). */
export interface RecentProject {
  path: string;
  name: string;
  kind: RecentKind;
  lastOpened: number;
  /** The site's favicon as a data URL once the project has loaded; entries saved before favicons were cached have none. */
  favicon?: string | null;
}
/** A folder in the projects folder that looks like a website. */
export interface AvailableProject { path: string; name: string }
/** What the Home screen lists (recents.snapshot). */
export interface RecentsSnapshot { recents: RecentProject[]; projectsDir: string | null; available: AvailableProject[] }
/** The open-projects session restored at launch. */
export interface RestoreSession { open: string[]; active: string | null; crashed: boolean }

/**
 * What the app stores with a pty in the terminal daemon, so it survives an app
 * restart (terminal.ts). setMeta merges into it, so every field is optional.
 */
export interface PtyMeta extends TaskLabel {
  /** The agent CLI it runs; a plain shell has none. */
  engine?: ChatEngine | null;
  /** Claude Code's --session-id, what makes the agent resumable after it sleeps. */
  sessionId?: string | null;
  /** The Home workspace agent, not a project's. */
  home?: boolean;
  preview?: PreviewView | null;
  previewSelectedAt?: number;
  recentTaskAt?: number;
  /** recentTaskAt's name in older daemons. */
  recentOpenedAt?: number;
  recentPinnedAt?: number;
  /** Never parked; the Mac stays awake while it runs. */
  keepAwake?: boolean;
  /** The chat this terminal is the native view of. */
  nativeChatId?: string;
  nativeThreadId?: string;
}
/**
 * A pty alive in the daemon (term:list, the daemon's `list` reply unchanged).
 * An outdated daemon kept running for its live agents leaves out what it
 * predates: lastDataAt (v3), attached (v4), lastBellAt (v5), startedAt, cols
 * and rows (v6), lastInputAt (v7), pid (v10).
 */
export interface PtyInfo {
  id: string;
  repoDir: string;
  meta: PtyMeta;
  alive: boolean;
  pid?: number | null;
  startedAt?: number;
  lastDataAt?: number;
  lastBellAt?: number;
  lastInputAt?: number;
  cols?: number;
  rows?: number;
  attached?: boolean;
}
/**
 * An agent put to sleep with its project; waking relaunches it (with --resume
 * when it has a Claude session). Apart from id, label and sleptAt, the fields
 * are copied from its pty's meta. Records stay until the agent is woken or
 * discarded: before 0.35.0 a record held only id, engine, label, sessionId and
 * sleptAt.
 */
export interface SleptAgent extends TaskLabel {
  /** The pty id it had. */
  id: string;
  engine?: ChatEngine | null;
  label: string;
  sessionId?: string | null;
  preview?: PreviewView | null;
  previewSelectedAt?: number;
  recentTaskAt?: number;
  /** Never stored in a slept record: main and the window read it as recentTaskAt's fallback, as they do in pty meta. */
  recentOpenedAt?: number;
  recentPinnedAt?: number;
  sleptAt: number;
}
/** One undoable file write: the whole file before and after. */
export interface EditRecord { file: string; relFile: string; prev: string; next: string }
/** A project's undo and redo stacks, oldest first. */
export interface EditHistory { undo: EditRecord[]; redo: EditRecord[] }
/** Per-project state saved in userData (projectState.get); every field is optional and stateSave merges a patch. */
export interface ProjectState {
  sleptAgents?: SleptAgent[];
  undoHistory?: EditHistory;
  /** The last successful launch-check scan. */
  launchCheck?: LaunchCheckScan;
  autoCommit?: boolean;
  /** The Vercel scope and project saved when the project was connected. */
  vercel?: { scope: string | null; project: string | null };
  /** The preview's last page title, for a sleeping tab's rail row. */
  pageTitle?: string;
  previewMode?: PreviewMode;
  sharedPreview?: PreviewView | null;
  // Written by earlier versions (composer draft, chat transcript, agent session); nothing reads them now.
  draft?: string;
  chat?: unknown[];
  chats?: unknown[];
  agentSessionId?: string | null;
}

export type OpenedFromGitHub =
  | { action: 'reused-local'; localPath: string }
  | { action: 'opened-local' | 'kept-dirty' | 'kept-detached' | 'kept-local' | 'pulled' | 'cloned'; dirty: boolean; defaultBranch: string };
export interface OpenProjectOptions { cold?: boolean }
export interface OpenedProject {
  ok: true;
  repoDir: string;
  /** The preview's dev server; null while the project sleeps. */
  url: string | null;
  project: RunnableProject;
  pages: ProjectPage[];
  status: RepoState;
  config: RadialConfig;
  previewMode: PreviewMode;
  sharedPreview: PreviewView | null;
  /** It was open already; this is its session. */
  already?: true;
  suspended?: boolean;
  sleptAgents?: SleptAgent[];
  favicon?: string | null;
  pageTitle?: string | null;
  github?: OpenedFromGitHub;
}
export type OpenProjectResult = OpenedProject | { ok: false; error: string; reason?: 'node-missing' };
export type OpenGitHubResult = OpenProjectResult | { ok: false; reason: 'choose-copy'; copies: LibraryEntry[]; url: string };
export type RefreshProjectResult =
  | { ok: true; restarted: boolean; project: RunnableProject; url: string | null; pages: ProjectPage[] }
  | { ok: false; reason: 'not-open' | 'unknown' }
  | { ok: false; reason: 'start-failed'; error: string };
/** Who asked for a dev-server restart (telemetry and the log). */
export interface DevRestartOptions { via?: 'app' | 'menu' | 'agent' | 'cli' | 'memory' }
export type DevRestartResult =
  | { ok: true; url: string | null }
  | { ok: false; reason: 'not-open' | 'external' }
  | { ok: false; reason: 'start-failed'; error: string };
export type SetActiveResult =
  | { ok: true; resumed: boolean; url: string | null }
  | { ok: false; error?: string };
export type MoveProjectResult = { ok: true; newDir: string } | { ok: false; cancelled: true } | { ok: false; error: string };

export interface ProjectTemplate { id: 'astro' | 'next' | 'html'; label: string; desc: string; needsNode: boolean }
export interface NewProjectInfo { templates: ProjectTemplate[]; npmAvailable: boolean; defaultParent: string }
export interface NewProjectArgs {
  templateId: ProjectTemplate['id'];
  name: string;
  parentDir: string;
  /** Also put it on GitHub (private), under this owner ('' = you). */
  github?: { create: boolean; owner: string } | null;
}
export type NewProjectResult =
  | { ok: true; dir: string; displayName: string; github?: { url: string; nameWithOwner: string }; githubError?: string }
  | { ok: false; stage: 'busy' | 'preflight' | 'scaffold' | 'cancelled'; error: string }
  | { ok: false; stage: 'git'; dir: string; error: string };
export type GhOptions = { available: true; user: string; owners: string[] } | { available: false; reason: 'no-gh' | 'not-authed' | 'error' };

export type StoragePreference = 'default' | 'local' | 'project';
/** Where a project's Radial files live: in the repo, or in Radial's local data folder (projectData.status). */
export interface ProjectStorageStatus {
  defaultLocal: boolean;
  preference: StoragePreference;
  local: boolean;
  /** A switch waits for the project's terminals to close. */
  pending: boolean;
  // The rest is missing before projectData.init().
  folder?: string;
  contextPath?: string | null;
  rulesPath?: string | null;
  existingFiles?: ('.radial' | '.radial.json' | '.context')[];
}
/**
 * projectData:set — with repoDir, that project's preference; without, the
 * machine default. projectData.set checks it: the window sends the picker's
 * value as it is, and set() refuses anything but a StoragePreference.
 */
export interface ProjectStoragePatch { repoDir?: string | null; preference?: string; defaultLocal?: boolean }
export type ProjectStorageSetResult = ({ ok: true } & ProjectStorageStatus) | { ok: false; error: string };

// ── Git (repository.ts, integration.ts) ──

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'sequencer';
/** One `git status --porcelain` entry. */
export interface GitChange {
  status: string;
  index: string;
  worktree: string;
  file: string;
  untracked: boolean;
  conflicted: boolean;
  originalFile?: string;
}
/** A readable checkout (repository.state). */
export interface RepoStatus {
  ok: true;
  isRepo: true;
  branch: string | null;
  head: string | null;
  detached: boolean;
  unborn: boolean;
  remote: string | null;
  operation: GitOperation | null;
  changes: GitChange[];
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: string[];
  observedAt: number;
}
export type RepoStateFailure =
  | { ok: false; isRepo: false; reason: 'not-a-repo'; message: string; branch: null; changes: [] }
  | { ok: false; isRepo: true; reason: 'status-failed'; message: string; changes: null };
export type RepoState = RepoStatus | RepoStateFailure;
/** How the branch relates to its upstream (repository.compare). */
export type UpstreamRelation =
  | { exists: false; targetBranch: string; ahead: null; behind: null }
  | { exists: true; targetBranch: string; upstream: string; sha: string; ahead: number; behind: number; fetchedAt: number | null };
/** The checkout plus its upstream (repository.syncStatus). */
export type RepoSync =
  | RepoStateFailure
  | (Omit<RepoStatus, 'ok'> & { ok: false; reason: 'unborn' | 'detached' | 'no-remote' | 'checkout-changed' })
  | (Omit<RepoStatus, 'ok'> & { ok: false; reason: 'fetch-failed'; message: string })
  | (Omit<RepoStatus, 'ok'> & UpstreamRelation & { ok: true; remoteName: string; reason: 'no-upstream' | null });
/** sync:status — the files list moves to `files`, and `changes` becomes its count. */
export type SyncStatus = OmitEach<RepoSync, 'changes'> & { files: GitChange[] | [] | null; changes: number | null };
export interface IncomingCommit { hash: string; subject: string; author: string }
export interface IncomingPreview { incoming: IncomingCommit[]; changed: { status: string; file: string }[] }
/** A pending Radial integration (pull, merge, rebase or stash-and-switch), saved in .git. */
export interface IntegrationRecord {
  id: string;
  strategy: 'ff' | 'merge' | 'rebase' | 'switch';
  branch: string;
  startBranch?: string;
  startHead: string;
  integratedHead: string;
  target: string;
  behind: number;
  phase: 'prepared' | 'stashing' | 'integrating' | 'replay';
  localFiles: string[];
  preview: Partial<IncomingPreview>;
  recoveryRef: string;
  stash: string | null;
  stashBefore?: string | null;
}
/** An integration stopped for the person: conflicts to resolve, or a step that failed. */
export interface IntegrationPaused extends Partial<IncomingPreview> {
  ok: false;
  reason: 'conflict' | 'integration-paused' | 'checkout-changed';
  branch: string;
  pulled: number;
  files: string[];
  localFiles: string[];
  operation: IntegrationRecord;
  message?: string;
}
export interface IntegrationDone extends Partial<IncomingPreview> {
  ok: true;
  branch: string;
  pulled: number;
  keptLocal: boolean;
  localFiles: string[];
  recoveryRef: string;
}
/** branch:pull and sync:run (integration.start). */
export type IntegrationResult =
  | Extract<RepoSync, { ok: false }>
  | IntegrationPaused
  | IntegrationDone
  | { ok: true; upToDate: true; branch: string | null }
  | { ok: false; reason: 'diverged'; ahead: number; behind: number; branch: string | null }
  | { ok: false; reason: 'operation-in-progress' | 'no-upstream' | 'ignored-collision' | 'published-history' | 'integration-failed'; message: string };
export interface SyncOptions { strategy?: 'merge' | 'rebase'; target?: string }
export type BranchSwitchResult =
  | { ok: true; branch: string | null }
  | { ok: false; reason: 'not-a-repo' | 'no-name' }
  | { ok: false; reason: 'conflict'; files: string[] }
  | { ok: false; reason: 'operation-in-progress'; message?: string }
  | { ok: false; reason: 'git-error' | 'switch-failed'; message: string }
  | IntegrationPaused
  | (IntegrationDone & { stashed: true })
  | (IntegrationPaused & { stashed: true; popConflict: false })
  | (Omit<IntegrationPaused, 'ok'> & { ok: true; stashed: true; popConflict: true });
export interface BranchList { ok: boolean; current: string | null; branches: string[]; remoteOnly: string[] }
export interface ConflictFile {
  file: string;
  binary: boolean;
  /** Ours and theirs are swapped (a rebase, or replaying saved work). */
  reversed: boolean;
  fingerprint: string;
  working: string | null;
  base: string | null;
  mine: string | null;
  incoming: string | null;
}
export type ConflictsResult =
  | RepoStateFailure
  | { ok: true; operation: IntegrationRecord | null; externalOperation: GitOperation | null; files: ConflictFile[] };
export interface ConflictResolution { file: string; strategy: 'mine' | 'theirs' | 'manual'; text?: string; deleted?: boolean; expectedFingerprint?: string }
export type FinalizeResult =
  | RepoStateFailure
  | IntegrationPaused
  | IntegrationDone
  | { ok: true; recoveryRef: string }
  | { ok: false; reason: 'no-operation' | 'unresolved'; message: string };
export type ResolveResult =
  | RepoStateFailure
  | FinalizeResult
  | { ok: true; file: string }
  | { ok: false; reason: 'not-conflicted' | 'conflict-changed' | 'resolution-failed'; message: string };
export type AbortResult =
  | RepoStateFailure
  | { ok: true; recoveryRef: string; message: string }
  | { ok: false; reason: 'no-operation' }
  | { ok: false; reason: 'abort-failed'; message: string };
export type FileDiff =
  | RepoStateFailure
  | { ok: false; error: string }
  | { ok: true; text: string; binary?: boolean; addedFile?: { name: string; contents: string } | null };

// ── Home library (projectLibrary.ts) and GitHub ──

export type LibraryStatus = RepoSync & {
  dir: string;
  slug: string | null;
  operationRecord: IntegrationRecord | null;
  checkedAt: number | null;
  canUpdate: boolean;
};
export type LibraryEntry = LibraryStatus | { dir: string; ok: false; reason: 'status-failed'; message: string };
export type LibraryUpdateResult =
  | { ok: true; action: 'updated'; branch: string | null; pulled: number | null }
  | { ok: false; reason: 'checkout-changed' | 'review-required'; message: string; state?: LibraryStatus }
  | { ok: false; reason: 'update-failed'; message: string };
export interface GitHubRepo {
  nameWithOwner: string;
  name: string;
  owner: string;
  description: string;
  updatedAt: string;
  isPrivate: boolean;
  url: string;
  /** Already cloned into ~/Radial. */
  cloned?: boolean;
}
/** A failed `gh api` call (githubReview.request). */
export interface GitHubApiFailure { ok: false; error: string; status?: number | null }
export type GitHubRepoList =
  | { ok: true; repos: GitHubRepo[]; truncated?: boolean }
  | { ok: false; reason: 'no-gh' | 'not-authed' | 'parse'; repos: [] }
  | { ok: false; reason: 'gh-error'; error: string; repos: [] }
  | (GitHubApiFailure & { repos: [] });
export type GitHubOwners = { ok: true; user: string; orgs: string[] } | { ok: false; reason: 'no-gh' | 'not-authed' };
/** github:createRepo — a new GitHub repo for the project, with origin pointed at it. */
export interface CreateRepoArgs { repoDir: string; owner: string; name: string; isPrivate?: boolean }
export type CreateRepoResult =
  | { ok: true; url: string; nameWithOwner: string; branch: string }
  | { ok: false; reason?: 'no-gh' | 'not-authed' | 'exists'; error: string };
/** github:connectExisting — point origin at a repo that already exists. */
export interface ConnectRepoArgs { repoDir: string; url: string }
export type ConnectRepoResult =
  | { ok: true; url: string; nameWithOwner: string; branch: string }
  | { ok: false; error: string }
  | { ok: false; reason: 'push-rejected' | 'auth' | 'push-failed'; remote: string; branch: string; error: string };
export interface GhStatus { installed: boolean; authed: boolean; user: string | null }
/** Can this Mac push to origin (publish.checkPushAuth)? */
export interface PushAuth {
  isRepo: boolean;
  hasRemote: boolean;
  remote: string | null;
  ready: boolean;
  status: 'not-a-repo' | 'no-remote' | 'ready' | 'need-gh-install' | 'need-gh-login' | 'gh-not-wired' | 'ssh-failed' | 'unreachable';
  hint?: string;
  gh?: GhStatus;
  parsed?: { host: string; protocol: 'ssh' | 'https'; owner: string; repo: string } | null;
  protocol?: 'ssh' | 'https' | null;
  isGitHub?: boolean;
  error?: string;
}
export type GhSetupResult = { ok: boolean; error: string | null };

// ── Hosting (vercel.ts, hostingProjects.ts) ──

export interface VercelTeam { slug: string | null; name: string | null }
export interface VercelDomain { name: string; verified: boolean; gitBranch: string | null; redirect: string | null }
export type VercelLink =
  | { linked: false }
  | { linked: true; projectId: string | null; orgId: string | null; name: string | null; liveUrl?: string; scope?: string; dashboardUrl?: string };
export interface VercelCliStatus { installed: boolean; authed: boolean; user: string | null }
export type VercelStatus = VercelCliStatus & { link: VercelLink };
/** vercel:deploy — a CLI deploy of the project's own link. */
export interface VercelDeployArgs { repoDir: string; prod?: boolean; scope?: string }
/** vercel:deployAlt — a deploy to the dedicated `<name>-staging` project; main ignores `kind`. */
export interface VercelDeployAltArgs { repoDir: string; prod?: boolean; kind?: 'client-preview' }
export type VercelDeployResult =
  | { ok: true; url: string | null; inspectorUrl: string | null; prod: boolean; project: string | null }
  | { ok: false; reason?: 'no-cli' | 'not-authed'; error: string };
export interface VercelScope { slug: string; name: string; type: 'personal' | 'team' }
export type VercelScopes = { ok: true; user: string; scopes: VercelScope[] } | { ok: false; reason: 'no-cli' | 'not-authed'; scopes: [] };
/** vercel:projects — one page of a scope's projects. */
export interface VercelProjectsQuery { scope?: string; search?: string; until?: number | null }
export type VercelProjects =
  | { ok: true; projects: { id: string; name: string; orgId: string }[]; next: number | null }
  | { ok: false; error: string };
/** vercel:linkExisting — link the project to a Vercel project that already exists. */
export interface VercelLinkArgs { repoDir: string; projectId: string; orgId: string }
export type VercelLinkResult = { ok: true; project: string } | { ok: false; error: string };
/** vercel:connect — link (creating the Vercel project if needed) and wire git so pushes deploy. */
export interface VercelConnectArgs { repoDir: string; scope?: string; name?: string }
export type VercelConnectResult =
  | { ok: true; project: string | null; scope: string | null; gitConnected: boolean; projectId: string | null }
  | { ok: false; reason?: 'no-cli' | 'not-authed'; error: string };
export type VercelProjectInfo =
  | { linked: false }
  | {
    linked: true;
    project: string | null;
    team: VercelTeam | null;
    dashboardUrl: string | null;
    urls: { production: string | null; staging: string | null };
    /** Why the API couldn't say: no-token, timeout, network, http-<status>… */
    reason: string | null;
  };
export interface PublishLinkState { repoLinked: boolean; staging: boolean; urls: { staging: string | null; production: string | null } }
/** The linked Vercel project as collaboration.hosting reports it. */
export type HostingInfo =
  | { ok: false; state: 'unknown'; reason: string }
  | {
    ok: true;
    url: string | null;
    domains: VercelDomain[];
    team: VercelTeam | null;
    gitRepo: string | null;
    productionBranch: string | null;
    autoAssignCustomDomains: boolean | null;
    projectId: string | null;
    orgId: string | null;
    /** vercel.json git.deploymentEnabled: everywhere, or per branch. */
    enabled: boolean | Record<string, boolean> | null;
    provider: 'Vercel';
  };
/** What a push to a branch should deploy (collaboration.destination). */
export type DeploymentDestination =
  | { state: 'unknown' | 'disabled'; label: string }
  | { state: 'configured'; production: boolean; branch: string; provider: 'Vercel'; label: string };
/** The deployment a reviewed plan expected; a publish refuses if it changed. */
export interface DeploymentEffect { state: DeploymentDestination['state']; production: boolean; projectId: string | null; orgId: string | null }
/** The deployment Vercel reports for a pushed commit (collaboration.deployment). */
export type DeploymentObservation =
  | { state: 'unknown'; reason: 'not-pushed' | 'not-connected' | `http-${number}` }
  | { state: 'unknown'; reason: 'unreachable'; message: string }
  | { state: 'unobserved'; sha: string; label: string }
  | { state: 'ready' | 'failed' | 'canceled' | 'building' | 'queued' | 'unknown'; id: string; sha: string; url: string | null; environment: string; observedAt: number };

// ── Publishing (publish.ts, deploy.ts, collaboration.ts, githubReview.ts) ──

export type PublishTarget = 'staging' | 'production' | 'branch';
export interface PublishOptions {
  target?: PublishTarget;
  branch?: string;
  /** false commits locally and stops there. */
  push?: boolean;
  pr?: boolean;
  /** false pushes what's committed without committing first. */
  commit?: boolean;
  /** staged commits only what's staged. */
  scope?: 'all' | 'staged';
  message?: string;
  squashAutosaves?: boolean;
  // A reviewed plan: the publish refuses when one of these changed since.
  expectedHead?: string | null;
  expectedRemote?: string | null;
  expectedPr?: boolean;
  expectedDeployment?: DeploymentEffect;
  expectedFingerprint?: string;
}
/** The local build check before a push (deploy.buildGate). */
export interface BuildGate { status: 'ok' | 'failed' | 'skipped'; reason?: string; log?: string; cmd?: string }
export interface BuildGateSummary { gate: BuildGate['status']; reason?: string; log?: string; cmd?: string; sha?: string }
/** A publish that got as far as a commit; saved as .git/radial-publish.json. */
export interface PublishReceipt {
  ok: true;
  at: number;
  target: PublishTarget;
  mode: 'pr' | 'preview' | 'direct';
  branch: string;
  /** The pull request's base. */
  base: string | null;
  from: string;
  sha: string;
  /** False when it stopped before the push (push: false, no remote), or while the push is still running. */
  pushed: boolean;
  remote: string | null;
  steps: string[];
  deployment: { state: 'unknown' };
  deploy?: BuildGateSummary;
  prUrl?: string;
  prNumber?: number;
}
/**
 * A publish that failed after its receipt was written, saved in its place:
 * the build gate failed (build-failed, with the gate's summary in `deploy`),
 * the branch was pushed but its pull request didn't open (pr-failed), or git
 * threw (pr-required, integration-required, git-error).
 */
export type FailedPublishReceipt = Omit<PublishReceipt, 'ok'> & {
  ok: false;
  reason: 'build-failed' | 'pr-failed' | 'pr-required' | 'integration-required' | 'git-error';
  message: string;
};
/** A pull request merged from the Review pane, saved as the last receipt. */
export interface MergeReceipt {
  ok: true;
  sha: string;
  merged: true;
  branch: string;
  url: string;
  at: number;
  pushed: true;
  mode: 'merge';
  prNumber: number;
  remote: string | null;
}
export type StoredReceipt = PublishReceipt | FailedPublishReceipt | MergeReceipt;
/**
 * A publish refused after the build, before the push, because another tool
 * switched branches or the repository connection changed meanwhile: the
 * receipt's fields (the commit is saved locally, nothing was pushed), returned
 * without being saved.
 */
export type PublishRefusedAfterBuild = Omit<FailedPublishReceipt, 'reason' | 'pushed'> & { reason: 'checkout-changed' | 'remote-changed'; pushed: false };
export type PublishResult =
  | PublishReceipt
  | FailedPublishReceipt
  | PublishRefusedAfterBuild
  | Extract<RepoStateFailure, { isRepo: true }>
  // Refused before a commit.
  | { ok: false; reason: 'not-a-git-repo' | 'detached' | 'operation-in-progress' | 'checkout-changed' | 'remote-changed' | 'production-mismatch' | 'plan-changed' | 'permission' | 'github-required' | 'push-target-mismatch'; message: string }
  | { ok: false; reason: 'integration-required'; branch: string; ahead: number; behind: number; message: string }
  // git threw before the receipt was written.
  | (Partial<Omit<PublishReceipt, 'ok'>> & { ok: false; reason: 'pr-required' | 'integration-required' | 'git-error'; message: string; steps: string[] });
/** publish:deploy — the build gate's summary, and a ready prompt for the agent when it can fix the failure. */
export type PublishDeployResult = PublishResult & { deploy: BuildGateSummary; fixPrompt?: string; fixLabel?: string };
export type PublishEvent = RepoDirEvent & ({ kind: 'status' | 'build_log'; text: string } | ({ kind: 'gate' } & BuildGate));
export type AutoCommitResult =
  | { ok: true; committed: true; branch: string; sha: string; subject: string }
  | { ok: true; skipped: 'clean' }
  | { ok: false; reason: 'not-a-repo' | 'detached' | 'production' | 'merge-in-progress' | 'min-interval' }
  | { ok: false; reason: 'commit-failed'; message: string };
export interface ConfigInfo { config: RadialConfig; remote: string | null; isRepo: boolean; effectiveStaging: string }
export type ConfigSetResult = { ok: true; config: RadialConfig; remote: string | null } | { ok: false; error: string };
export type PreflightResult = { ok: true; skipped: true } | { ok: boolean; output: string };
export type MergeMethod = 'merge' | 'squash' | 'rebase';
/** What GitHub allows on a branch for the connected account (githubReview.capabilities). */
export type GitHubCapabilities =
  | { ok: false; error: string; state: 'unknown' }
  | {
    ok: true;
    state: 'known' | 'partial';
    branch: string;
    actor: string | null;
    canPush: boolean | null;
    isAdmin: boolean | null;
    protected: boolean | null;
    requiresPr: boolean;
    bypass: 'unknown';
    mergeQueue: boolean;
    linearHistory: boolean;
    rules: { type: string; parameters?: unknown }[];
    requiredChecks: string[];
    mergeMethods: MergeMethod[];
    defaultBranch: string;
    url: string;
    checkedAt: number;
  };
export interface CollaborationStateOptions { fetch?: boolean; target?: string }
export type CollaborationState =
  | Extract<RepoStateFailure, { isRepo: false }>
  | (Exclude<RepoSync, { isRepo: false }> & { operationRecord: IntegrationRecord | null; receipt: StoredReceipt | null; slug: string | null; incoming: IncomingPreview | null });
export interface CollaborationPlanOptions { target?: PublishTarget; branch?: string; pr?: boolean }
export interface CollaborationPlan {
  ok: true;
  /** The checkout as it stood when the plan was made: a plan whose HEAD or branch moved answers checkout-changed instead. */
  local: RepoStatus;
  fingerprint: string;
  target: PublishTarget;
  branch: string;
  pr: boolean;
  capabilities: GitHubCapabilities | null;
  hosting: HostingInfo;
  deployment: DeploymentDestination;
  relation: RepoSync | null;
  slug: string | null;
  /** Production publishes to a branch Vercel doesn't treat as production. */
  mismatch: boolean | '' | null;
  outgoing: string | null;
}
export type CollaborationPlanResult =
  | CollaborationPlan
  | RepoStateFailure
  | { ok: false; reason: 'push-target-mismatch' | 'detached' | 'checkout-changed'; message: string };
export interface PullRequestSummary { number: number; title: string; url: string; author: string; head: string; base: string; sha: string; draft: boolean; updatedAt: string }
export interface PullRequestDetail {
  ok: true;
  pr: {
    number: number;
    title: string;
    body: string | null;
    author: string;
    url: string;
    state: string;
    merged: boolean;
    mergeSha: string | null;
    sha: string;
    head: string;
    base: string;
    baseSha: string;
    draft: boolean;
    mergeable: boolean | null;
    mergeState: string;
  };
  files: { file: string; previousFile?: string; status: string; additions: number; deletions: number; patch: string | null }[];
  filesError: string | null;
  filesTruncated: boolean;
  reviews: { author: string; state: string; body: string; sha: string }[];
  checks: { name: string; state: string; url: string | null }[];
  statuses: { name: string; state: string; url: string | null }[];
  checksKnown: boolean;
  reviewsKnown: boolean;
  capabilities: GitHubCapabilities;
  previews: { id: number; sha: string; environment: string; state: string; url: string | null }[];
}
export type ReviewAction = 'list' | 'detail' | 'review' | 'merge';
export interface ReviewOptions {
  list: Record<string, never>;
  detail: { number: number };
  review: { number: number; sha: string; event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body?: string };
  merge: { number: number; sha: string; baseSha?: string; method?: MergeMethod; branch?: string; expectedRemote?: string | null; expectedDeployment?: DeploymentEffect };
}
export type ReviewFailure = GitHubApiFailure | { ok: false; reason: 'changed'; error: string };
export interface ReviewResults {
  list: { ok: true; prs: PullRequestSummary[]; truncated: boolean } | GitHubApiFailure;
  detail: PullRequestDetail | ReviewFailure;
  review: { ok: true; data: unknown } | ReviewFailure;
  merge: MergeReceipt | ReviewFailure;
}

// ── Editing source (editEngine.ts, editInsert.ts, tokens.ts) ──
// Edit results reach the window without the file contents main keeps for undo.

/** One level of an element's DOM ancestor path, element first (overlay.ts buildStructuralPath). */
export interface ElementPathLevel {
  tag: string;
  id: string | null;
  cls: string[];
  own?: string;
  nth: number;
  cnt: number;
  twins?: number;
  src?: string | null;
  href?: string | null;
  alt?: string | null;
  ariaLabel?: string | null;
  placeholder?: string | null;
}
/** What the source resolvers know about a clicked element (a canvas selection, or part of one). */
export interface ElementContext {
  tagName?: string | null;
  id?: string | null;
  classList?: string[];
  text?: string;
  /** The nearest preceding heading's text; a canvas selection sends null when there is none. */
  heading?: string | null;
  /** The element's DOM path: with it, edits pin the exact source node. */
  path?: ElementPathLevel[];
  src?: string | null;
  href?: string | null;
  alt?: string | null;
  ariaLabel?: string | null;
  placeholder?: string | null;
  nthOfTag?: number;
  tagSiblings?: number;
  parent?: { tagName: string; id?: string | null; classList?: string[] } | null;
  /** The page's source file: a match there wins over one elsewhere. */
  preferFile?: string | null;
  /** The edited text is this attribute's value (alt, href), not the element's text. */
  attribute?: string;
  nearbyText?: string[];
  occurrenceIndex?: number;
  /** Weaker locators (an image's file name) for elements with no text, class or id. */
  extraNeedles?: string[];
  styleSource?: StyleSource;
}
export interface TextEdit { originalText: string; newText: string; context?: ElementContext }
export type MatchStrategy = 'none' | 'unique' | 'ambiguous' | 'context-score' | 'occurrence-index' | 'structural';
export interface SourceCandidate { relFile: string; line: number; context: string }
export type TextEditFailure =
  | { ok: false; reason: 'empty-original' | 'invalid-new-text' | 'no-change' }
  /** needs-agent: the text sits where typed text can't go as text (code, a comment, an unquoted attribute). */
  | { ok: false; reason: 'interpolated-text' | 'needs-agent' | 'read-failed' | 'write-failed'; message: string }
  | { ok: false; reason: 'already-applied'; relFile: string; line: number }
  | { ok: false; reason: 'not-found' | 'ambiguous'; strategy: MatchStrategy; candidates: SourceCandidate[] };
export type TextEditResult =
  | { ok: true; file: string; relFile: string; line: number; strategy: MatchStrategy; replaced: string; occurrencesFound: number }
  | TextEditFailure;
export type InsertPosition = 'before' | 'after' | 'inside';
export interface InsertSpec { anchor: ElementContext; position: InsertPosition; markup: string; preferFile?: string | null }
export interface MoveSpec { subject: ElementContext; target: ElementContext; position: InsertPosition; preferFile?: string | null }
export interface SubjectSpec { subject: ElementContext; preferFile?: string | null }
export type StructuralEditResult =
  | { ok: true; file: string; relFile: string; line: number; wrapperClass?: string }
  | { ok: false; reason: 'bad-args' | 'unclosed' | 'count-mismatch' | 'no-anchor' | 'void-parent' | 'cross-file' | 'nested' | 'no-children' };
/** A Design-panel :hover edit: the declaration goes into `${baseSelector}:hover`. */
export interface HoverStylePlan { kind: 'css-hover'; prop: string; value: string; href: string | null; baseSelector: string }
export type StyleEditPlan = StylePlan | HoverStylePlan;
export type StyleEditResult =
  | { ok: true; summary: string; files: { ok: true; file: string; relFile: string }[] }
  | { ok: false; reason: string; message?: string };
export interface ImageSwapResult {
  ok: boolean;
  reason?: TextEditFailure['reason'];
  relFile?: string;
  line?: number;
  candidates?: SourceCandidate[];
  newSrc: string;
  copiedTo: string;
}
export type HeadTagResult =
  | { ok: true; file: string; relFile: string; line: number; replaced?: string }
  | { ok: false; reason: 'invalid' | 'no-head' | 'not-found' }
  | { ok: false; reason: 'read-failed' | 'write-failed'; message: string }
  | { ok: false; reason: 'ambiguous'; candidates: { relFile: string; line: number }[] };
/** A head tag rewritten by locator (the SEO panel's fallback when the value isn't in source). */
export interface HeadTagValue { preferFile?: string | null; locator: string; attr?: string | null; value: string }
export interface StyleRef { relFile: string; selectorText: string; line: number; startLine: number; snippet: string[] }
export type SourceLocation =
  | { ok: true; relFile: string; line: number; col: number; snippet: string[]; startLine: number; strategy: MatchStrategy | 'first' | 'style-only'; styleRefs: StyleRef[] }
  | { ok: false; reason: 'no-project' }
  | { ok: false; reason: 'not-found'; styleRefs: StyleRef[] }
  | { ok: false; reason: 'error'; error: string };
/** code:openInEditor — a file of the project, at a line and column when known. */
export interface OpenInEditorArgs { repoDir: string; relFile: string; line?: number; col?: number }
/** The editor a file opened in: a known one by its URL scheme, else the Mac's default. */
export type EditorName = 'Cursor' | 'VS Code' | 'VSCodium' | 'default';
export type OpenInEditorResult = { ok: true; editor: EditorName } | { ok: false; error: string };
export type TokenType = 'color' | 'font' | 'length' | 'number' | 'duration' | 'easing' | 'shadow' | 'alias' | 'other';
/** One definition of a CSS custom property (tokens.ts), with its file relative to the repo. */
export interface TokenDefinition { file: string; line: number; selector: string; at: string; theme: boolean; value: string; start: number; end: number }
/** A design token (tokens.ts Token): its base definition's fields, every definition, and how often it is used. */
export interface DesignToken {
  name: string;
  value: string;
  type: TokenType;
  /** The token it points at when its value is `var(--other)`. */
  alias: string | null;
  file: string;
  line: number;
  selector: string;
  at: string;
  theme: boolean;
  defs: TokenDefinition[];
  /** One label per definition when there are several, else empty. */
  modes: string[];
  /** `var(--name` references in source files. */
  uses: number;
  /** Files with a reference. */
  files: number;
}
/** tokens.indexTokens: at most 600 tokens; count is the full number. */
export interface TokenIndex { ok: true; tokens: DesignToken[]; count: number; files: string[] }
/** tokens:index — the index, or why the scan threw. */
export type TokenIndexResult = TokenIndex | { ok: false; error: string; tokens: [] };
export interface TokenWrite { name: string; value: string; mode?: string | null; file?: string | null; selector?: string | null }
/** A definition offered when tokens:set can't tell which one was meant. */
export interface TokenChoice { relFile: string; line: number; mode: string; selector: string; at: string; value: string }
export type TokenSetResult =
  | { ok: true; file: string; relFile: string; line: number; name: string; from: string; to: string; mode: string }
  | { ok: false; reason: 'no-change' }
  | { ok: false; reason: 'invalid' | 'not-found' | 'error' | 'write-failed'; message: string }
  | { ok: false; reason: 'ambiguous'; message: string; candidates: TokenChoice[] };
export type HistoryAction = 'edit' | 'undo' | 'redo' | 'jump' | 'jump-error' | 'revert' | 'noop-undo' | 'noop-redo' | 'external-change';
/** The undo timeline after every change to it. */
export interface HistoryState extends RepoDirEvent {
  action: HistoryAction;
  relFile: string | null;
  timeline: { relFile: string }[];
  /** How many of the timeline's edits are applied. */
  cursor: number;
  total: number;
  canUndo: boolean;
  canRedo: boolean;
}

// ── Version history (moments.ts) ──

export type MomentKind = 'agent' | 'edit' | 'publish' | 'restore' | 'external';
export interface Moment { id: string; ts: number; kind: MomentKind; label: string; files: string[]; tree: string; commit: string }
export interface MomentListItem { id: string; ts: number; kind: MomentKind; label: string; files: string[]; thumb: string | null }
export interface MomentList { ok: true; moments: MomentListItem[]; previewing: boolean }
export type MomentRecordResult = { ok: true; moment: Moment } | { ok: true; skipped: 'unchanged'; id: string } | { ok: false; reason: 'no-git' };
/** Writing a moment's files into the working tree failed. */
export type SnapshotFailure =
  | { ok: false; reason: 'operation-in-progress'; message: string }
  | { ok: false; reason: 'no-git' }
  | { ok: false; reason: 'checkout-changed'; message: string; recoveryRef?: string }
  | { ok: false; reason: 'git-error'; message: string; recoveryRef: string };
export type MomentPreviewResult = { ok: true; id: string } | { ok: false; reason: 'not-found' } | SnapshotFailure;
export type BackToNowResult = { ok: true; skipped?: 'not-previewing' } | SnapshotFailure;
export type MomentRestoreResult = MomentRecordResult | SnapshotFailure | { ok: false; reason: 'not-found' | 'unchanged' };
/** moments:created — a moment was recorded; the window attaches a canvas thumbnail. */
export interface MomentCreatedEvent extends RepoDirEvent { id: string }

// ── Context, references, rules, comments ──

export interface ContextFile {
  name: string;
  rel: string;
  mtime: number;
  kind: 'text' | 'file';
  /** Kept out of the repo (this file, or the whole project's Radial data). */
  local: boolean;
  storageLocal: boolean;
  abs: string;
}
export type ContextFileResult = { ok: true; rel: string; name: string } | { ok: false; error: string };
export type ContextReadResult = { ok: true; content: string; abs: string } | { ok: false; error: string };
/** addedAt is null for an entry saved without one (written into .radial.json by hand or by an agent). */
export interface ProjectReference { url: string; kind: 'github' | 'web'; owner?: string; repo?: string; label: string; addedAt: string | null }
export interface ProjectMemory { exists: boolean; content: string; local: boolean; abs: string }
/** What Vercel knows about a Toolbar comment's page and reviewer. */
export interface VercelCommentInfo {
  href: string;
  path: string;
  pageTitle: string;
  branch: string;
  localhost: boolean;
  device: string;
  screen: { w: number; h: number; dpr: number };
  viewport: 'mobile' | 'tablet' | 'desktop';
  tree: string[];
  avatar: string;
}
/** A review comment pinned to a page element or a context-file passage (.radial/comments.json). */
export interface ReviewComment {
  id: string;
  route: string;
  selector: string;
  anchor: string;
  /** Where in the element the pin sits, as 0..1 fractions. */
  offsetX: number | null;
  offsetY: number | null;
  /** Legacy pin: a pixel offset from the element's corner (radial:comment-move sets null once a drag stores the fractions). */
  pinDx?: number | null;
  pinDy?: number | null;
  file: string;
  quote: string;
  text: string;
  who: string;
  /** Attached screenshots; agents edit comments.json too, and theirs may have none. */
  images?: string[];
  resolved: boolean;
  resolvedBy?: string;
  addressed?: boolean;
  createdAt: number;
  // A Vercel Toolbar comment (ids vercel-<thread>).
  source?: 'vercel';
  alt?: string[];
  selText?: string;
  url?: string;
  branch?: string;
  vercel?: VercelCommentInfo;
  attachments?: { url: string; name: string }[];
  vercelResolved?: boolean;
  vercelPushedAt?: number;
}
export type NewComment = Partial<Pick<ReviewComment, 'route' | 'selector' | 'anchor' | 'offsetX' | 'offsetY' | 'file' | 'quote' | 'text' | 'who' | 'images' | 'createdAt'>>;
export type VercelPullResult =
  | { ok: true; total: number; added: number; updated: number; resolved: number; changed: boolean }
  | { ok: false; code: 'not-linked' | 'no-cli' | 'unsupported-cli' | 'not-authed' | 'error'; error: string; vercelCode?: string };
export interface VercelCommentsStatus { linked: boolean; cli: boolean; running: boolean; lastAt: number; result: VercelPullResult | null }
/** comments:vercel — the Vercel comment sync's state changed. */
export interface VercelCommentsEvent extends RepoDirEvent { status: VercelCommentsStatus }

// ── Launch check (launchCheck.ts) ──

export type LaunchCheckStatus = 'pass' | 'warn' | 'fail' | 'na';
export interface LaunchCheckIssue { route: string; sev: 'warn' | 'fail'; msg: string }
export interface LaunchCheckItem {
  id: string;
  label: string;
  category: string;
  hint: string;
  status: LaunchCheckStatus;
  summary: string;
  issues: LaunchCheckIssue[];
}
export interface LaunchCheckScan {
  ok: true;
  scannedAt: number;
  pageCount: number;
  unreachable: { route: string; error: string }[];
  counts: Record<LaunchCheckStatus, number>;
  results: LaunchCheckItem[];
}
export type LaunchCheckReport = LaunchCheckScan | { ok: false; error: string; scannedAt: number };
/** launchCheck:done — a scan an agent asked for (.radial/run-launch-check) finished. */
export interface LaunchCheckDoneEvent extends RepoDirEvent { report: LaunchCheckReport }

// ── Agents, tools and the app ──

/** A CLI's sign-in state (agent.ts, codex.ts, cursor.ts checkAuth). */
export type CliAuth =
  | { ok: true; method: 'api_key' | 'oauth_token' | 'claude_code' | 'keychain' }
  | { ok: boolean; method?: 'chatgpt' | 'api_key' | 'codex'; hasCli: boolean; hasNode: boolean };
export interface SetupCheck {
  tools: Record<'git' | 'node' | 'npm' | 'gh' | 'claude' | 'codex' | 'brew' | 'vercel', boolean>;
  push: PushAuth | null;
  agent: CliAuth;
  codex: CliAuth;
  vercel: VercelCliStatus;
}
export type ToolKind = 'claude' | 'gh' | 'node';
export type ToolInstallResult = { ok: true; path?: string | null; binDir?: string; version?: string } | { ok: false; error: string };
export type ToolAuthResult = { ok: true; already?: true; error?: string } | { ok: false; error: string };
/** tools:ghCode — the device code to type at GitHub's sign-in page. */
export interface GhDeviceCode { code: string; url: string }
/** tools:claudeUrl — the page where Claude Code's sign-in continues. */
export interface ClaudeSignInUrl { url: string }
export type AgentTextResult<K extends string> = ({ ok: true } & Record<K, string>) | { ok: false; error: string };
/** Where a skill or command was found: the open project's .claude, the user's ~/.claude, or an installed plugin. */
export type SkillSource = 'project' | 'user' | 'plugin';
/** One `/name` the composer can offer (skills.list). */
export interface SkillEntry { name: string; description: string; kind: 'command' | 'skill'; source: SkillSource }
/** Where an install lands: the project's .claude/skills or the user's ~/.claude/skills. */
export type SkillScope = 'project' | 'global';
/** What skills.install resolves. */
export interface SkillInstallResult { installed: string[]; errors: string[]; scope: SkillScope }
/** skills:install — the install, or main's fallback when it threw (no scope). */
export type SkillInstallReply = SkillInstallResult | { installed: []; errors: string[] };
export interface AppInfo { version: string; electron: string; node: string; chrome: string; platform: string; userData: string; dev: boolean }
export interface ShortcutBinding { label: string; accelerator: string }
/** shortcuts:used-menu — a shortcut's menu item was clicked instead of its keys pressed. */
export interface ShortcutUsedEvent { id: string; binding: ShortcutBinding }
export type KeepAwakeResult = { ok: true; id: string; on: boolean; daemonOutdated: boolean } | { ok: false; code: 'not-found'; error: string };
/** agents:keepAwake — an agent's keep-awake switch changed (from the CLI or MCP too). */
export interface KeepAwakeEvent extends RepoDirEvent { id: string; on: boolean }
/** agents:slept — agents parked with their project, by pty id. */
export interface AgentsSleptEvent extends RepoDirEvent { slept: string[] }
/** A timing sample for the local perf log (numbers only, never content). */
export interface PerfEntry { kind: string; [metric: string]: string | number }
export interface TelemetryState { enabled: boolean; available: boolean }
/** telemetry:adjust — a Design-panel change was applied or undone. */
export interface TelemetryAdjust { kind: 'applied' | 'undo'; tweaks?: number; direct?: boolean }
/** radial:panels-state — the open tool panels (and saved layouts), for the Panels menu's checkmarks. */
export type PanelsState = string[] | { open: string[]; layouts?: string[] };
/** Where an error happened in a window: the app window, or the site preview. */
export type WindowErrorSurface = 'renderer' | 'preview';
/** A browser error event that carries no error at all: a ResizeObserver loop, a script from another origin (its details hidden), or any other. */
export type WindowErrorKind = 'resize-observer-loop' | 'cross-origin-script' | 'error-event';
/**
 * radial:app-error — the window's uncaught errors and unhandled rejections
 * (windowErrors.ts reads them, main's errorReport.ts names, locates and sends
 * them). The message and stack stay on the Mac: main writes them to its local
 * error log and sends neither.
 */
export interface WindowErrorReport {
  surface: WindowErrorSurface;
  /** How it surfaced: an uncaught error event, or a rejected promise nobody handled. */
  via?: 'error' | 'rejection';
  /** An error event with no error at all: why. */
  kind?: WindowErrorKind;
  /** What was thrown or rejected, when it wasn't an Error: its type ('string', 'undefined', 'null', 'object') or an object's class ('Event', 'CloseEvent'). */
  valueType?: string;
  name?: string;
  message?: string;
  stack?: string;
  /** An error event's own place in a script, for one with no stack (kind 'error-event'). */
  filename?: string;
  lineno?: number;
  colno?: number;
}
export type ProjectActivityState = 'running' | 'asleep' | 'stopped';
export interface ServerActivity {
  url: string;
  pid: number;
  /** null for an external server: when it really started is unknown. */
  startedAt: number | null;
  observedAt: number | null;
  external: boolean;
}
export interface ProjectActivity { repoDir: string; name: string; state: ProjectActivityState; framework: string | null; server: ServerActivity | null }
export type TerminalActivityState = 'waiting' | 'working' | 'idle';
export interface TerminalActivity {
  id: string;
  repoDir: string;
  home: boolean;
  project: string;
  label: string;
  /** null for a plain shell. */
  engine: ChatEngine | null;
  pid: number | null;
  startedAt: number | null;
  keepAwake: boolean;
  state: TerminalActivityState;
}
export interface RecentProjectActivity { name: string; repoDir: string; lastOpened: number | null }
/** workspace:activity — what Home's activity list renders (workspaceActivity.snapshot). */
export interface WorkspaceActivity {
  capturedAt: number;
  projects: ProjectActivity[];
  terminals: TerminalActivity[];
  recentProjects: RecentProjectActivity[];
}
/** A project offered when a name could mean several. */
export interface ResolveChoice { path: string; name: string; open: boolean; suspended: boolean; lastOpened: number | null; reason: 'exact' | 'fuzzy' }
/** A name, path or GitHub link resolved the way the radial CLI does (projectResolve.resolve). */
export type ResolveTargetResult =
  | { ok: true; kind: 'path'; dir: string; repo?: string; match?: 'repo' | 'exact' | 'fuzzy' }
  | { ok: true; kind: 'clone'; url: string }
  | { ok: false; code: 'not-found'; error: string }
  | { ok: false; code: 'ambiguous'; error: string; candidates: ResolveChoice[] };
export interface HomeInfo { cwd: string; sleptAgents: SleptAgent[] }
/** update:ready — an update downloaded; restarting installs it. */
export interface UpdateReadyEvent { version: string }
/** update:refused — macOS won't install a downloaded update in place; url is where to download it. */
export interface UpdateRefusedEvent { version: string; url: string }
/** A reloaded window's question: an update ready to install, or one to download (refused). */
export interface UpdateState { ready: boolean; version: string; refused?: UpdateRefusedEvent }

// ── The control socket's window requests (radial CLI, MCP) ──

/** What the control socket asks of the window (main.ts askRenderer), by op: the request's payload. */
export interface CliRequests {
  /** width: radial serve's page width in CSS pixels; the window shoots its preview as it shows it. */
  shot: { repoDir: string; route?: string | null; width?: number | null };
  fields: { repoDir: string; route?: string | null };
  reload: { repoDir: string };
  close: { repoDir: string };
  visibleAgents: Record<string, never>;
  agent: { repoDir: string; task: string; submit: boolean; engine: ChatEngine | null; label: string | null };
  agentSend: { id: string; text: string; submit: boolean };
  home: { engine?: 'claude' | 'codex' | 'shell' | null };
}
export type CliOp = keyof CliRequests;
/** cli:request — one op and its payload, answered through cliReply with the same reqId. */
export type CliRequest = { [Op in CliOp]: { reqId: string; op: Op; payload: CliRequests[Op] } }[CliOp];
/** One Content-panel field as the page reports it (overlay.ts radial:read-fields), without its thumbnail and focus flag. */
export type ContentField =
  | { kind: 'text'; selector: string; tag: string; role: string; text: string; truncated: boolean; hasMarkup: boolean; group: string; path: ElementPathLevel[] }
  | { kind: 'image'; selector: string; tag: 'img'; role: 'Image'; src: string; alt: string | null; naturalW: number; naturalH: number; group: string; path: ElementPathLevel[] }
  | { kind: 'animated'; selector: string; tag: string; role: 'Animated'; name: string; count: number; group: string };
/** Why a window request failed; each is one of the CLI's error codes (cliProto ErrorCode). */
export type CliFailureCode = 'not-open' | 'no-dev-server' | 'not-found' | 'no-engine' | 'no-browser' | 'timeout' | 'bad-request' | 'error';
/**
 * A failed window request, from the window or from askRenderer itself (window
 * not ready, no answer in time), or the core's own refusal when its host has no
 * window or no browser (radial serve), which can say what to do: the command
 * that clears it (fix), the one that does the job another way meanwhile
 * (instead), or a task to hand an agent (fixPrompt, fixLabel).
 */
export interface CliFailure { ok: false; code: CliFailureCode; error: string; fix?: string; instead?: string; fixPrompt?: string; fixLabel?: string }
/** The window's answer to each op when it worked (renderer.ts onCliRequest); `reload` reports its refusals with a reason instead. */
export interface CliReplies {
  shot: { ok: true; path: string; scale: 1 | 2; route: string };
  fields: { ok: true; route: string; fields: ContentField[] };
  reload: { ok: true } | { ok: false; reason: 'not-open' | 'asleep' };
  close: { ok: true };
  visibleAgents: { ok: true; chatIds: string[]; termIds: string[] };
  /**
   * The core's own send, with no window (radial serve), can also say: waiting,
   * the CLI is asking a question of its own, so the text goes in once that is
   * answered; resumedFrom, the session was asleep, and id is the one that woke
   * with its conversation.
   */
  agentSend: { ok: true; id: string; submitted: boolean; landed: boolean; sentAt: number; waiting?: boolean; resumedFrom?: string };
  home: { ok: true; id: string; engine: ChatEngine | 'shell'; started: boolean };
  /**
   * waiting: the session's CLI asked a question of its own first (signing in,
   * trusting the folder), so nothing was typed into it: submitted, the task is
   * the CLI's first prompt and runs once the person answers; staged, it goes
   * into the CLI's input then.
   */
  agent: { ok: true; id: string; label: string; engine: ChatEngine; submitted: boolean; landed: boolean; reused: boolean; startedAt: number; waiting?: boolean };
}
/** What askRenderer(op) resolves to: the window's reply without its reqId, or a failure. */
export type CliResult<Op extends CliOp = CliOp> = CliReplies[Op] | CliFailure;
/** cli:reply — the window's answer, keyed by the request's reqId. */
export type CliReply = { reqId: string } & CliResult;

// ── The app menu (main.ts menuSend) ──

/** The tool panels the Panels menu toggles. */
export type MenuPanelId = 'adjust' | 'content' | 'motion' | 'inspect' | 'variants' | 'image' | 'a11y' | 'layers' | 'page' | 'reconcile' | 'ask' | 'branches' | 'draw' | 'comments' | 'pages' | 'context' | 'history' | 'publish';
/** radial:menu — a menu command for the window, with its argument when it has one. */
export type MenuCommand =
  /** 1 is Home; n ≥ 2 is the (n-1)th project tab. */
  | { command: 'select-tab'; arg: number }
  | { command: 'toggle-panel'; arg: MenuPanelId }
  | { command: 'set-device'; arg: 'desktop' | 'tablet' | 'mobile' }
  | { command: 'side-pane'; arg: 'context' | 'history' }
  /** '' starts a plain shell. */
  | { command: 'new-agent'; arg: ChatEngine | '' }
  /** A recent project's folder, or a saved panel layout's name. */
  | { command: 'open-path' | 'apply-panel-layout' | 'delete-panel-layout'; arg: string }
  | {
    command: 'new-project' | 'open-local' | 'open-github' | 'go-home' | 'close-tab' | 'undo' | 'redo' | 'cmdk' | 'quick-add'
      | 'toggle-agent' | 'toggle-rail' | 'toggle-left-sidebar' | 'toggle-right-sidebar' | 'toggle-layout-legacy' | 'toggle-chrome-layout'
      | 'open-pages' | 'shot-full' | 'toggle-rulers' | 'clear-guides' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'reload-preview'
      | 'nav-back' | 'nav-fwd' | 'save-panel-layout' | 'toggle-panel-dock' | 'float-panels' | 'focus-agent' | 'shot-agent'
      | 'shot-terminal' | 'publish' | 'sync-project' | 'sleep-project' | 'reveal-project' | 'move-project';
    arg?: undefined;
  };

// ── Site migration ──

export type MigrateFramework = 'astro' | 'next';
export type MigrateCheckResult = { ok: true; url: string; host: string; platform: { id: string; name: string } } | { ok: false; error: string };
export interface MigrateOptions { url: string; framework: MigrateFramework; name?: string | null; dir?: string | null; files?: string[]; engine?: ChatEngine; only?: string[] }
export interface MigratePrepared {
  ok: true;
  dir: string;
  name: string;
  framework: MigrateFramework;
  frameworkLabel: string;
  source: string;
  platform: string;
  pages: number;
  assets: number;
  capture: string;
  engine: ChatEngine;
  task: string;
  chatId: string | null;
}
export type MigratePrepareResult =
  | MigratePrepared
  | Extract<NewProjectResult, { ok: false }>
  | { ok: false; code: 'bad-request' | 'not-found' | 'no-engine' | 'error'; error: string; dir?: string };
/** migrate:launch — the prepared project's agent, started with its task. */
export type MigrateLaunchArgs = Pick<MigratePrepared, 'dir' | 'engine' | 'task' | 'chatId'>;
export type MigrateLaunchResult = { ok: true; engine: ChatEngine; session: string; chatId?: string } | { ok: false; code: string; error: string };

// ── Chats (nativeChat.ts) ──

export type ChatState = 'idle' | 'working' | 'approval' | 'error';
export type ChatView = 'chat' | 'terminal';
/** A local file attached to a chat (chat/resources.ts). */
export interface ChatFile { path: string; name: string; size: number; mime: string }
/** nativeChat:attach — a pasted or dropped file's bytes, saved for the chat. */
export interface ChatAttachmentUpload { name: string; bytes: Uint8Array }
/** A project file offered by the composer's @ menu. */
export interface ChatFileMatch { path: string; name: string }
/** nativeChat:preview — a referenced file's bytes, for the window to show. */
export interface ChatFilePreview { name: string; type: string; bytes: Uint8Array }
export type ChatApprovalMethod = 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval' | 'item/tool/requestUserInput';
export interface ChatQuestion {
  id: string;
  question?: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  optionsOnly?: boolean;
}
/** The CLI's request as it sent it; the fields beyond these vary by CLI. */
export interface ChatApprovalParams { command?: string; questions?: ChatQuestion[]; [field: string]: unknown }
export interface ChatApproval { id: string | number; method: ChatApprovalMethod; params: ChatApprovalParams; commandRule?: string[] }
export interface ChatResponse {
  requestId: string | number;
  decision?: 'accept' | 'acceptForSession' | 'decline' | 'acceptWithExecpolicyAmendment';
  /** Per question id: the chosen option label(s) or typed answer. */
  answers?: Record<string, string | string[]>;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  turnId?: string | null;
  /** The CLI's id for a message Radial added first (a sent prompt). */
  cliId?: string;
  /** A sent prompt as the CLI received it (text is what the chat shows). */
  sourceText?: string;
  attachments?: ChatFile[];
  /** A tool step: what ran, its output and its status. */
  name?: string;
  detail?: string;
  status?: string;
  changes?: { path: string; diff?: string }[];
}
export interface ChatQueuedMessage { id: string; text: string; displayText: string; attachments: ChatFile[] }
export interface ChatSettings { model?: string; modelName?: string | null; effort?: string | null; permissionMode?: PermissionMode }
/** A chat without its messages (nativeChat.list). */
export interface ChatSummary {
  id: string;
  repoDir: string;
  home: boolean;
  engine: ChatEngine;
  title: string;
  titleAuto?: boolean;
  state: ChatState;
  createdAt: number;
  updatedAt: number;
  /** Orders snapshots: an event older than a reply already in hand is dropped. */
  revision?: number;
  threadId: string | null;
  turnId?: string | null;
  approval: ChatApproval | null;
  approvals?: ChatApproval[];
  error?: string;
  recovery?: string;
  unsupportedRequest?: string | null;
  archived?: boolean;
  viewMode?: ChatView;
  terminalId?: string | null;
  terminalEndpoint?: string | null;
  nativeTerminal?: boolean;
  terminalHasInput?: boolean;
  nativeInputNotice?: string;
  nativePendingPrompt?: { text: string; id: string; knownUsers: string[]; delivering?: boolean } | null;
  awaitingTerminalThread?: boolean;
  providerPersisted?: boolean;
  queue?: ChatQueuedMessage[];
  queuePaused?: boolean;
  pendingUserId?: string | null;
  lastSubmittedAt?: number;
  initialPrompt?: string;
  model?: string;
  modelName?: string | null;
  effort?: string | null;
  resolvedModel?: string;
  resolvedEffort?: string;
  resolvedProvider?: string;
  permissionMode?: PermissionMode;
  pendingSettings?: ChatSettings | null;
  /** The CLI's own token report (Codex). */
  tokenUsage?: unknown;
  keepAwake?: boolean;
  recentPinnedAt?: number;
  preview?: PreviewView | null;
  previewSelectedAt?: number;
  parkedAt?: number;
  messageCount: number;
}
export type ChatSession = Omit<ChatSummary, 'messageCount'> & { messages: ChatMessage[] };
/** A chat's change: the summary plus the messages from the first one that changed. */
export interface ChatEvent extends ChatSummary {
  messagePatch: { from: number; messages: ChatMessage[] };
  /** The chat was deleted (nativeChat.discard): the window forgets it. */
  discarded?: true;
}
export interface ChatModel {
  model: string;
  displayName: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string | null;
  /** From the CLI's own model list, which may leave it out. */
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[];
}
export interface ChatUpdate {
  engine?: ChatEngine;
  permissionMode?: PermissionMode;
  preview?: PreviewView;
  previewSelectedAt?: number;
  archived?: boolean;
  title?: string;
  pinned?: boolean;
  keepAwake?: boolean;
}
export type ChatResourceAction = 'describe' | 'reveal' | 'save' | 'open';
export type ChatResourceResult =
  | (ChatFile & { src?: string })
  | { ok: true; editor?: EditorName }
  | { ok: false; canceled: true }
  | { ok: false; error: string };
/** Claude Code's own default for new chats, and its settings file's revision (chat/claudeSettings.ts). */
export interface ClaudeDefaultState { mode: ClaudeDefaultMode; revision: string }

// ── Terminals (terminal.ts, the pty daemon's client) ──

/** term:start — a terminal in the project: an agent CLI when `engine` is set, else a shell. */
export interface TermStartOptions {
  label?: string | null;
  home?: boolean;
  /** The agent's first prompt, typed as it boots. */
  initialText?: string;
  /** Wake this slept agent (its id) instead of starting a new one. */
  restoreOf?: string;
}
/** term:start's payload as main reads it. */
export interface TermStartRequest extends Omit<TermStartOptions, 'home'> { repoDir: string; cols: number; rows: number; engine?: ChatEngine; home: boolean }
/** term:data — a batch of a terminal's output. */
export interface TermData { id: string; data: string }
/** term:exit — a terminal's process ended. */
export interface TermExit { id: string }
/**
 * term:open-url — an agent ran `open <url>` in its terminal (the radial-open
 * shim); termId is null when it ran outside a Radial terminal. The daemon's
 * open message (terminal.ts OpenMessage) without its op.
 */
export interface TermOpenUrl { termId: string | null; repoDir: string | null; url: string }

// ── Other main → window events ──

/** dev:memory-stopped and dev:memory-restarted — the dev server passed its memory limit (gb: its size, one decimal). */
export interface DevMemoryEvent extends RepoDirEvent { gb: string }
/** session:resumed — a sleeping project's dev server is back. */
export interface SessionResumedEvent extends RepoDirEvent { url: string | null }
/** files:changed — files the project's watcher saw change. */
export interface FilesChangedEvent extends RepoDirEvent { files: string[] }
/** radial:build-error — the dev server's build error text. */
export interface BuildErrorEvent extends RepoDirEvent { message: string }
/** autoCommit:done — an automatic commit landed. */
export interface AutoCommitDoneEvent extends RepoDirEvent { sha: string; subject: string }

/**
 * Every main → window channel the preload listens on, with its payload
 * (`undefined`: the event carries none). Main's `send` (main.ts), which every
 * message to the window goes through, and the preload's `on…` listeners both
 * follow this list.
 */
export interface WindowEvents {
  'log': string;
  'loading-status': string;
  'newProject:log': string;
  'migrate:progress': string;
  'tools:log': string;
  'tools:ghCode': GhDeviceCode;
  'tools:claudeUrl': ClaudeSignInUrl;
  'tools:claudePaste': Record<string, never>;
  /** A folder to open (Dock drop, `radial .`, a second launch). */
  'radial:auto-open': string;
  'radial:restore-session': RestoreSession;
  'radial:build-error': BuildErrorEvent;
  'radial:build-error-cleared': RepoDirEvent;
  'radial:menu': MenuCommand;
  'radial:fullscreen': boolean;
  'radial:toggle-edit-mode': undefined;
  'radial:toggle-terminal': undefined;
  'radial:toggle-comments': undefined;
  /** Nothing in main sends this one now. */
  'radial:toggle-sidebar': undefined;
  'radial:toggle-focus': undefined;
  'radial:toggle-log': undefined;
  'radial:toggle-page-settings': undefined;
  'shortcuts:used-menu': ShortcutUsedEvent;
  'shortcuts:changed': undefined;
  'dev:static-changed': RepoDirEvent;
  'dev:memory-stopped': DevMemoryEvent;
  'dev:memory-restarted': DevMemoryEvent;
  'session:suspended': RepoDirEvent;
  'session:resumed': SessionResumedEvent;
  'agents:slept': AgentsSleptEvent;
  'agents:keepAwake': KeepAwakeEvent;
  'watcher:degraded': RepoDirEvent;
  'files:changed': FilesChangedEvent;
  'publish:event': PublishEvent;
  'autoCommit:done': AutoCommitDoneEvent;
  'history:state': HistoryState;
  'moments:created': MomentCreatedEvent;
  'comments:changed': RepoDirEvent;
  'comments:vercel': VercelCommentsEvent;
  'context:changed': RepoDirEvent;
  'launchCheck:done': LaunchCheckDoneEvent;
  'cli:request': CliRequest;
  'nativeChat:event': ChatEvent;
  'term:data': TermData;
  'term:exit': TermExit;
  'term:open-url': TermOpenUrl;
  'update:ready': UpdateReadyEvent;
  'update:refused': UpdateRefusedEvent;
}

// ── window.radial ──

/**
 * The API the preload puts on window.radial (contextBridge.exposeInMainWorld).
 * contextBridge copies what crosses it: a listener's `on…` returns nothing the
 * window can use, except where it returns an unsubscribe function.
 */
export interface RadialApi {
  /** The preview webviews' preload (overlay.js) as a file URL. */
  overlayPreloadUrl: string;

  openRepoDialog(): Promise<string | null>;
  openProject(repoDir: string, opts?: OpenProjectOptions): Promise<OpenProjectResult>;
  openGitHub(url: string, localPath?: string): Promise<OpenGitHubResult>;
  libraryRepos(owner?: string): Promise<GitHubRepoList>;
  libraryStatuses(dirs: string[]): Promise<LibraryEntry[]>;
  libraryStatus(dir: string, fetch?: boolean): Promise<LibraryStatus>;
  libraryCopies(url: string): Promise<LibraryEntry[]>;
  libraryUpdate(dir: string, expected: LibraryStatus): Promise<LibraryUpdateResult>;
  recentsGet(): Promise<RecentsSnapshot>;
  recentsRemove(repoPath: string): Promise<RecentsSnapshot>;
  recentsSetFavicon(repoDir: string, dataUrl: string): void;
  recentsSetProjectsDir(): Promise<RecentsSnapshot>;
  newProjectInfo(): Promise<NewProjectInfo>;
  newProjectCreate(args: NewProjectArgs): Promise<NewProjectResult>;
  newProjectCancel(): void;
  newProjectChooseParent(): Promise<string | null>;
  onNewProjectLog(cb: (line: string) => void): void;
  newProjectGhOptions(): Promise<GhOptions>;
  projectDataGet(repoDir?: string | null): Promise<ProjectStorageStatus>;
  projectDataSet(patch: ProjectStoragePatch): Promise<ProjectStorageSetResult>;
  projectDataReveal(repoDir?: string | null): Promise<void>;
  telemetryGet(): Promise<TelemetryState>;
  telemetrySet(on: boolean): Promise<{ ok: true; enabled: boolean }>;
  telemetryAdjust(kind: TelemetryAdjust['kind'], tweaks?: number, direct?: boolean): void;
  /** Keeps the Panels menu checkmarks honest. */
  panelsState(openIds: PanelsState): void;
  reportError(payload: WindowErrorReport): void;
  termBell(): void;
  onDevStaticChanged(cb: (p: RepoDirEvent) => void): void;
  applyStyleEdit(repoDir: string, plans: StyleEditPlan[], context: ElementContext): Promise<StyleEditResult>;
  appIsDev(): Promise<boolean>;
  toolsInstall(kind: ToolKind): Promise<ToolInstallResult>;
  toolsGhAuth(): Promise<OkOrError>;
  toolsGitEnsure(): Promise<ToolAuthResult>;
  toolsClaudeAuth(): Promise<ToolAuthResult>;
  toolsClaudeAuthInput(text: string): Promise<OkOrError>;
  onToolsLog(cb: (line: string) => void): void;
  onGhCode(cb: (p: GhDeviceCode) => void): void;
  onClaudeUrl(cb: (p: ClaudeSignInUrl) => void): void;
  onClaudePaste(cb: (p: Record<string, never>) => void): void;
  publishLinkState(repoDir: string): Promise<PublishLinkState>;
  vercelDeployAlt(args: VercelDeployAltArgs): Promise<VercelDeployResult>;
  sessionSave(open: string[], active: string | null): void;
  exitFullscreen(): void;
  skillsList(repoDir: string | null): Promise<SkillEntry[]>;
  skillsInstall(repoDir: string | null, scope: SkillScope, paths: string[]): Promise<SkillInstallReply>;
  onRestoreSession(cb: (payload: RestoreSession) => void): void;
  stateGet(repoDir: string): Promise<ProjectState>;
  stateSave(repoDir: string, patch: ProjectState): void;
  launchCheckGet(repoDir: string): Promise<LaunchCheckScan | null>;
  launchCheckRun(repoDir: string): Promise<LaunchCheckReport>;
  githubOwners(): Promise<GitHubOwners>;
  githubListRepos(owner?: string): Promise<GitHubRepoList | { ok: false; reason: 'no-gh' }>;
  ghCreateRepo(args: CreateRepoArgs): Promise<CreateRepoResult>;
  ghConnectExisting(args: ConnectRepoArgs): Promise<ConnectRepoResult>;
  vercelStatus(repoDir?: string | null): Promise<VercelStatus>;
  vercelDeploy(args: VercelDeployArgs): Promise<VercelDeployResult>;
  vercelProjects(opts: VercelProjectsQuery): Promise<VercelProjects>;
  vercelLinkExisting(args: VercelLinkArgs): Promise<VercelLinkResult>;
  vercelScopes(): Promise<VercelScopes>;
  vercelConnect(args: VercelConnectArgs): Promise<VercelConnectResult>;
  vercelProjectInfo(repoDir: string): Promise<VercelProjectInfo>;
  setActive(repoDir: string): Promise<SetActiveResult>;
  closeProject(repoDir: string): Promise<{ ok: true }>;
  sleepProject(repoDir: string): Promise<{ ok: true } | { ok: false; reason: 'not-running' }>;
  moveProject(repoDir: string): Promise<MoveProjectResult>;
  onSessionSuspended(cb: (p: RepoDirEvent) => void): void;
  onDevMemoryStopped(cb: (p: DevMemoryEvent) => void): void;
  onDevMemoryRestarted(cb: (p: DevMemoryEvent) => void): void;
  onSessionResumed(cb: (p: SessionResumedEvent) => void): void;
  onAgentsSlept(cb: (p: AgentsSleptEvent) => void): void;
  onAgentsKeepAwake(cb: (p: KeepAwakeEvent) => void): void;
  termRenameSlept(repoDir: string, sleptId: string, label: string): Promise<{ ok: boolean }>;
  termPinSlept(repoDir: string, sleptId: string, pinnedAt: number): Promise<{ ok: boolean }>;
  termDiscardSlept(repoDir: string, sleptId: string): Promise<{ ok: true }>;
  getStatus(repoDir: string): Promise<RepoState>;
  projectRefresh(repoDir: string, opts?: { forceRestart?: boolean }): Promise<RefreshProjectResult>;
  devRestart(repoDir: string, opts?: DevRestartOptions): Promise<DevRestartResult>;
  onWatcherDegraded(cb: (p: RepoDirEvent) => void): void;
  onFilesChanged(cb: (p: FilesChangedEvent) => void): void;
  revealFolder(repoDir: string): Promise<{ ok: boolean }>;
  prewarm(url: string): Promise<{ ok: boolean }>;
  getPages(repoDir: string): Promise<ProjectPage[]>;

  applyTextEdit(repoDir: string, edit: TextEdit): Promise<TextEditResult>;
  insertElement(repoDir: string, spec: InsertSpec): Promise<StructuralEditResult>;
  moveElement(repoDir: string, spec: MoveSpec): Promise<StructuralEditResult>;
  removeElement(repoDir: string, spec: SubjectSpec): Promise<StructuralEditResult>;
  wrapElement(repoDir: string, spec: SubjectSpec): Promise<StructuralEditResult>;
  unwrapElement(repoDir: string, spec: SubjectSpec): Promise<StructuralEditResult>;
  applyImageEdit(repoDir: string, oldSrc: string): Promise<ImageSwapResult | { ok: false; reason: 'cancelled' }>;
  // Code panel: locate the selected element in source, and open it in the user's IDE.
  codeResolveSource(repoDir: string, sel: ElementContext): Promise<SourceLocation>;
  codeOpenInEditor(args: OpenInEditorArgs): Promise<OpenInEditorResult>;
  metaAddTag(repoDir: string, relFile: string, snippet: string): Promise<HeadTagResult>;
  metaSetTagValue(repoDir: string, args: HeadTagValue): Promise<HeadTagResult>;

  publish(repoDir: string, opts: PublishOptions): Promise<PublishResult>;
  /** Publish with the build gate + agent auto-fix loop ("just make it deploy"). */
  publishDeploy(repoDir: string, opts: PublishOptions): Promise<PublishDeployResult>;
  onPublishEvent(cb: (p: PublishEvent) => void): void;
  configGet(repoDir: string): Promise<ConfigInfo>;
  configSet(repoDir: string, config: Partial<RadialConfig> | null, remote?: string): Promise<ConfigSetResult>;
  preflightRun(repoDir: string): Promise<PreflightResult>;
  checkPushAuth(repoDir: string): Promise<PushAuth>;
  branchList(repoDir: string): Promise<BranchList>;
  branchSwitch(repoDir: string, name: string, opts?: { stash?: boolean }): Promise<BranchSwitchResult>;
  branchPull(repoDir: string): Promise<IntegrationResult>;
  syncStatus(repoDir: string): Promise<SyncStatus>;
  syncIncoming(repoDir: string): Promise<IncomingCommit[]>;
  syncRun(repoDir: string, opts?: SyncOptions): Promise<IntegrationResult>;
  collaborationState(repoDir: string, opts?: CollaborationStateOptions): Promise<CollaborationState>;
  collaborationPlan(repoDir: string, opts?: CollaborationPlanOptions): Promise<CollaborationPlanResult>;
  collaborationDiff(repoDir: string, file: string, staged?: boolean): Promise<FileDiff>;
  collaborationBranch(repoDir: string, opts: { name: string; expectedHead?: string | null }): Promise<{ ok: true; branch: string } | { ok: false; message: string }>;
  collaborationConflicts(repoDir: string): Promise<ConflictsResult>;
  collaborationAbort(repoDir: string): Promise<AbortResult>;
  collaborationDeployment(repoDir: string, receipt?: StoredReceipt | null): Promise<DeploymentObservation>;
  collaborationReview<A extends ReviewAction>(repoDir: string, action: A, opts?: ReviewOptions[A]): Promise<ReviewResults[A] | { ok: false; error: string }>;
  syncResolve(repoDir: string, strategy: 'mine' | 'theirs' | ConflictResolution): Promise<ResolveResult>;
  syncFinalize(repoDir: string): Promise<FinalizeResult>;
  ghSetupGit(): Promise<GhSetupResult>;
  setupCheck(repoDir?: string | null): Promise<SetupCheck>;
  appInfo(): Promise<AppInfo>;
  openExternal(url: string): Promise<OkOrError>;
  // Site migration (plans/site-migration.md): check → prepare (progress events) → launch.
  migrateCheck(url: string): Promise<MigrateCheckResult>;
  migratePrepare(opts: MigrateOptions): Promise<MigratePrepareResult>;
  migrateLaunch(prep: MigrateLaunchArgs): Promise<MigrateLaunchResult>;
  migratePickFiles(): Promise<string[]>;
  /** Progress lines from migratePrepare; returns the unsubscribe. */
  onMigrateProgress(cb: (line: string) => void): () => void;
  setWindowBg(color: string): Promise<{ ok: true }>;
  chromeLayoutChanged(mode: 'classic' | 'strip' | 'vnext'): void;

  onLog(cb: (line: string) => void): void;
  onBuildError(cb: (p: BuildErrorEvent) => void): void;
  onBuildErrorCleared(cb: (p: RepoDirEvent) => void): void;
  onLoadingStatus(cb: (text: string) => void): void;
  onAutoOpen(cb: (dir: string) => void): void;
  /**
   * The control server (CLI / MCP) asking the window for something only it can
   * do (a screenshot of the preview, closing a tab); reply by reqId.
   */
  onCliRequest(cb: (p: CliRequest) => void): void;
  nativeChatResource(id: string, reference: string, action?: ChatResourceAction): Promise<ChatResourceResult>;
  nativeChatAttach(data: ChatAttachmentUpload): Promise<ChatFile>;
  nativeChatFiles(dir: string, query?: string): Promise<ChatFileMatch[]>;
  nativeChatView(id: string, view: ChatView, cols?: number, rows?: number, stopTerminal?: boolean): Promise<ChatSession>;
  nativeChatEnabled(): Promise<boolean>;
  nativeChatRestore(repoDir: string, home?: boolean): Promise<void>;
  nativeChatClaudeDefault(): Promise<ClaudeDefaultState>;
  nativeChatSetClaudeDefault(mode: ClaudePermissionMode, revision: string): Promise<ClaudeDefaultState>;
  /** No dir: every project's chats. */
  nativeChatList(dir?: string | null, includeClosed?: boolean): Promise<ChatSummary[]>;
  nativeChatModels(dir: string, engine?: ChatEngine): Promise<ChatModel[]>;
  nativeChatConfigure(id: string, model: string, effort?: string | null): Promise<ChatSession>;
  nativeChatGet(id: string): Promise<ChatSession>;
  nativeChatCreate(dir: string, home?: boolean, engine?: ChatEngine): Promise<ChatSession>;
  nativeChatSend(id: string, text: string, displayText?: string, attachments?: { path: string }[]): Promise<ChatSession>;
  nativeChatUpdate(id: string, patch: ChatUpdate): Promise<ChatSession>;
  /** Fire-and-forget: the preview is saved as it scrolls, and nothing waits on it. */
  nativeChatSavePreview(id: string, preview: PreviewView, previewSelectedAt: number): void;
  nativeChatArchive(id: string): Promise<ChatSession>;
  /** Deletes a chat nobody has used, and stops its CLI; false when it was used, and is kept. */
  nativeChatDiscard(id: string): Promise<boolean>;
  nativeChatStop(id: string): Promise<ChatSession>;
  nativeChatQueue(id: string, text: string, displayText?: string, attachments?: { path: string }[]): Promise<ChatSession>;
  nativeChatRemoveQueued(id: string, messageId: string): Promise<ChatSession>;
  nativeChatReorderQueue(id: string, messageIds: string[]): Promise<ChatSession>;
  nativeChatPreview(dir: string, reference: string): Promise<ChatFilePreview>;
  nativeChatResumeQueue(id: string): Promise<ChatSession>;
  nativeChatRespond(id: string, response: ChatResponse): Promise<ChatSession>;
  /** Every chat change; returns the unsubscribe. */
  onNativeChatEvent(cb: (session: ChatEvent) => void): () => void;
  homeInfo(): Promise<HomeInfo>;
  workspaceActivity(): Promise<WorkspaceActivity>;
  resolveTarget(text: string): Promise<ResolveTargetResult>;
  cliReply(p: CliReply): void;
  onHistoryState(cb: (s: HistoryState) => void): void;
  historyUndo(): Promise<{ ok: true }>;
  historyRedo(): Promise<{ ok: true }>;
  historyJumpTo(repoDir: string, applied: number): Promise<{ ok: true }>;
  historyLatest(repoDir: string): Promise<{ ok: true }>;
  momentsList(repoDir: string): Promise<MomentList>;
  momentsPreview(repoDir: string, id: string): Promise<MomentPreviewResult>;
  momentsBackToNow(repoDir: string): Promise<BackToNowResult>;
  momentsRestore(repoDir: string, id: string): Promise<MomentRestoreResult>;
  momentsSaveThumb(repoDir: string, id: string, dataUrl: string): Promise<{ ok: boolean }>;
  previewThumbnail(webContentsId: number, width?: number): Promise<string | null>;
  momentsRecord(repoDir: string, kind: MomentKind, label: string): Promise<MomentRecordResult>;
  momentsRevertTo(repoDir: string, id: string, label?: string): Promise<MomentRestoreResult>;
  onMomentCreated(cb: (p: MomentCreatedEvent) => void): void;
  historyRevertHere(repoDir: string): Promise<{ ok: true }>;
  onToggleEditMode(cb: () => void): void;
  onToggleTerminal(cb: () => void): void;
  onToggleComments(cb: () => void): void;
  onToggleSidebar(cb: () => void): void;
  onToggleFocus(cb: () => void): void;
  onToggleLog(cb: () => void): void;
  onTogglePageSettings(cb: () => void): void;
  onShortcutMenuUsed(cb: (p: ShortcutUsedEvent) => void): void;
  shortcutBindings(): Promise<Record<string, ShortcutBinding>>;
  onShortcutBindingsChanged(cb: () => void): void;
  onMenuCommand(cb: (payload: MenuCommand) => void): void;
  onFullscreen(cb: (on: boolean) => void): void;

  termStart(repoDir: string, cols: number, rows: number, engine?: ChatEngine, opts?: TermStartOptions): Promise<{ id?: string }>;
  /**
   * Terminals still alive in the daemon for this project (after an app restart), for reattaching;
   * with no project, every project's (terminal.list).
   */
  termList(repoDir?: string | null): Promise<PtyInfo[]>;
  /** Reattach to a live terminal: replays its scrollback, then streams live output. */
  termAttach(id: string): void;
  perfMark(name: string): void;
  perfLog(entry: PerfEntry): void;
  perfBoot(): Promise<Record<string, number>>;
  /** Persist an updated label (rename / auto-name) or preview into the daemon's pty meta; it merges. */
  termSetMeta(id: string, meta: PtyMeta): void;
  /** Which agent CLIs (Claude Code, Codex, Cursor) are installed. */
  engineAvailable(): Promise<Record<ChatEngine, boolean>>;
  /**
   * Paste composed visual context (comments / elements / screenshot) into a
   * running engine terminal. Staged unless submit=true (then it runs immediately).
   * Nothing goes into a CLI asking a question of its own.
   */
  enginePaste(id: string, text: string, submit?: boolean): void;
  /**
   * Whether a terminal's CLI asks a question of its own now (cliQuestion.ts),
   * read from the PTY daemon's copy of its screen, which a restart's replay
   * hasn't left half drawn; typed: text a send has typed into the CLI's input,
   * whose rows are left out. null when that can't be read.
   */
  termAsking(id: string, typed?: string): Promise<boolean | null>;
  termInput(id: string, data: string): void;
  termResize(id: string, cols: number, rows: number): void;
  termKill(id: string): Promise<{ ok: true }>;
  /**
   * Keep awake: never parked (project sleep, quit, the idle limit) and the Mac
   * stays awake while it runs — for a session driven from a phone.
   */
  termKeepAwake(id: string, on: boolean): Promise<KeepAwakeResult>;
  onTermData(cb: (p: TermData) => void): void;
  onTermExit(cb: (p: TermExit) => void): void;
  /** An agent ran `open <url>` in its terminal; the window decides preview or browser. */
  onTermOpenUrl(cb: (p: TermOpenUrl) => void): void;

  pagesSetGroups(repoDir: string, groups: PageGroup[]): Promise<{ ok: true; config: RadialConfig }>;
  pagesSetHidden(repoDir: string, routes: string[], files: string[]): Promise<{ ok: true; config: RadialConfig }>;

  contextList(repoDir: string): Promise<ContextFile[]>;
  tokensIndex(repoDir: string): Promise<TokenIndexResult>;
  tokensSet(repoDir: string, payload?: TokenWrite | null): Promise<TokenSetResult>;
  contextRead(repoDir: string, rel: string): Promise<ContextReadResult>;
  contextWrite(repoDir: string, rel: string, content: string): Promise<OkOrError>;
  contextCreate(repoDir: string, name: string): Promise<ContextFileResult>;
  contextRename(repoDir: string, rel: string, name: string): Promise<ContextFileResult>;
  contextDelete(repoDir: string, rel: string): Promise<OkOrError>;
  memoryGet(repoDir: string): Promise<ProjectMemory>;
  memoryWrite(repoDir: string, content: string): Promise<{ ok: true }>;
  memoryAddRule(repoDir: string, text: string): Promise<{ ok: boolean }>;
  contextImport(repoDir: string, paths: string[]): Promise<{ ok: true; imported: string[] }>;
  contextImportBytes(repoDir: string, name: string, bytes: Uint8Array): Promise<ContextFileResult>;
  contextAbsPath(repoDir: string, rel: string): Promise<{ abs: string | null }>;
  contextReveal(repoDir: string, rel: string): Promise<{ ok: boolean }>;
  /** A dropped File's real path ('' when it has none); Electron 33 removed File.path. */
  getDroppedPath(file: File): string;
  contextSetLocal(repoDir: string, rel: string, local: boolean): Promise<{ ok: true; local: boolean } | { ok: false; error: string }>;

  refsList(repoDir: string): Promise<ProjectReference[]>;
  refsAdd(repoDir: string, url: string): Promise<{ ok: true; ref: ProjectReference } | { ok: false; error: string }>;
  refsRemove(repoDir: string, url: string): Promise<{ ok: boolean }>;

  commentsList(repoDir: string): Promise<ReviewComment[]>;
  commentsVercelStatus(repoDir: string): Promise<VercelCommentsStatus>;
  commentsVercelPull(repoDir: string): Promise<VercelPullResult>;
  commentsAdd(repoDir: string, comment: NewComment): Promise<ReviewComment | { error: string }>;
  commentsImportImage(repoDir: string, srcPath: string): Promise<{ ok: true; rel: string; abs: string } | { ok: false; error?: string }>;
  commentsSaveImage(repoDir: string, name: string, bytes: Uint8Array): Promise<{ ok: true; rel: string } | { ok: false; error: string }>;
  savePastedImage(repoDir: string, name: string, bytes: Uint8Array): Promise<{ ok: true; abs: string; rel: string } | { ok: false; error: string }>;
  fullPageShot(wcId: number, name: string): Promise<{ ok: true; path: string; scale: 1 | 2 } | { ok: false; error: string }>;
  commentsUpdate(repoDir: string, id: string, patch: Partial<ReviewComment>): Promise<ReviewComment | { error: string } | null>;
  commentsRemove(repoDir: string, id: string): Promise<OkOrError>;
  // Agent state files: main polls .radial/ and pushes when an outside agent
  // edits comments.json or a requested launch-check scan finishes.
  onCommentsChanged(cb: (p: RepoDirEvent) => void): void;
  onContextChanged(cb: (p: RepoDirEvent) => void): void;
  onVercelComments(cb: (p: VercelCommentsEvent) => void): void;
  onLaunchCheckDone(cb: (p: LaunchCheckDoneEvent) => void): void;

  agentCheckAuth(): Promise<Record<ChatEngine, CliAuth>>;
  autoCommitGet(repoDir: string): Promise<{ on: boolean }>;
  autoCommitSet(repoDir: string, on: boolean): Promise<{ ok: true; on: boolean }>;
  autoCommitNow(repoDir: string): Promise<AutoCommitResult>;
  onAutoCommitDone(cb: (p: AutoCommitDoneEvent) => void): void;
  agentSuggestMeta(repoDir: string, context: { route?: string; bodyText?: string }): Promise<{ ok: true; title: string; description: string } | { ok: false; error: string }>;
  agentSuggestAlt(repoDir: string, context: { route?: string; image?: string; bodyText?: string }): Promise<AgentTextResult<'alt'>>;
  agentCommitMessage(repoDir: string): Promise<AgentTextResult<'message'>>;
  agentEnhanceRule(repoDir: string, text: string): Promise<AgentTextResult<'text'>>;
  agentAuditRule(repoDir: string, text: string): Promise<AgentTextResult<'text'>>;
  metaPickImage(repoDir: string, absolute: boolean): Promise<{ ok: true; newSrc: string; relative: boolean } | { ok: false; reason: 'cancelled' } | { ok: false; reason: 'copy-failed'; message: string }>;
  metaSetSiteUrl(repoDir: string, url: string): Promise<{ ok: true; siteUrl: string | null }>;

  // In-app updates: the main process downloads in the background; the window
  // shows a "Restart to update" pill and triggers the install.
  onUpdateReady(cb: (p: UpdateReadyEvent) => void): void;
  onUpdateRefused(cb: (p: UpdateRefusedEvent) => void): void;
  updateState(): Promise<UpdateState>;
  updateRestart(): Promise<{ ok: boolean }>;
}
