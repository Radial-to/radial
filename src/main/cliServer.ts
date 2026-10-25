/**
 * The app's control server — the one API behind the `radial` CLI, `radial mcp`
 * and the Home agent (plans/radial-agent-native.md). Listens on a unix socket
 * in userData (0700: same trust as the user's own shell), speaks cliProto, and
 * delegates every piece of real work to an injected `api` that main.js builds
 * from closures over its session state. Electron-free, so a test can start it
 * on a tmp socket with a fake api. radial serve --listen runs its HTTP
 * callers' requests through the same ops with dispatch() (src/headless/listen.ts).
 *
 * Opens keep the renderer in charge: the server never starts a project itself.
 * It asks the app to open a folder exactly the way `radial .` always has
 * (api.requestOpen → radial:auto-open → the renderer's openProjectPath), and
 * learns the outcome through the open-result bus: main.js calls settleOpen()
 * with openRepo's result when the renderer's project:open lands. The renderer
 * keeps its loading overlay, cap modal, Node modal and tab focus untouched.
 */

import net from 'net';
import fs from 'fs';
import path from 'path';
import { encode, makeDecoder, PROTOCOL, err } from './cliProto';
import { META_TAGS, ENGINES } from './cliSpec';
import { probeSocket } from './socketProbe';
import type { RequestFrame, Reply, OkReply, ErrorReply, ServerFrame } from './cliProto';
import type { Engine, MetaTag } from './cliSpec';
import type { ResolveResult, ResolvedPath } from './projectResolve';
import type { TokenIndex, SetTokenResult, SetTokenRequest, TokenSummary } from './tokens';
import type { PageEntry, DiscoveredPages } from './project';
import type { ProjectStorageStatus } from './projectData';
import type { FileEdit } from './editHistory';
import type { PtyEngine } from './terminal';
import type { TerminalActivityState, RecentProjectActivity } from './workspaceActivity';
import type { AnswerAfter, QuestionOption, ShownQuestion } from '../shared/cliQuestion';
import type { BitmapDiff, DiffBand } from './migrate/diff';
import type { Inventory } from './migrate/capture';
import type {
  CliRequests, CliResult, CliFailure, ContentField, ElementPathLevel, OpenedFromGitHub, NewProjectResult, ProjectTemplate, RepoState,
  TextEditResult, ImageSwapResult, HeadTagResult, ReviewComment, NewComment, VercelPullResult, IntegrationResult, SyncOptions,
  PublishResult, PublishDeployResult, PublishTarget, PublishOptions, BuildGateSummary, MomentList, MomentRecordResult,
  MomentRestoreResult, ProjectReference, MigrateFramework, MigrateOptions, MigratePrepared, MigratePrepareResult, MigrateLaunchArgs,
  MigrateLaunchResult, KeepAwakeResult,
} from '../shared/radialApi';
const HOME_ENGINES = ['claude', 'codex', 'shell'] as const satisfies readonly HomeEngine[];

const OPEN_WAIT_MS = 180000;
const TEMPLATES = ['astro', 'next', 'html'] as const satisfies readonly Template[];
const AGENT_WAIT_MAX_MS = 3600000;
const AGENT_IDLE_MS = 20000;

/** A starter `new` scaffolds from (the window's template ids, which main.ts createNewProject takes). */
export type Template = ProjectTemplate['id'];
/** An engine the Home agent can run (`shell` is a plain terminal). */
export type HomeEngine = NonNullable<CliRequests['home']['engine']>;

// ── The request side ──

/** Streams one line of progress to the caller, ahead of the reply. */
export type Progress = (text: string) => void;

/**
 * A request as the ops read it: the frame's common block plus each op's own
 * arguments, typed the way the app's own clients send them (cli.ts
 * buildPayload). Nothing checks them on arrival: the socket trusts its caller
 * (0700). mcp.ts checks the types of an MCP client's arguments against the
 * tool's schema before argsToPayload passes them on.
 */
export interface OpRequest extends RequestFrame {
  // new, migrate start, context add, tokens set
  name?: string | null;
  template?: string | null;
  /** The parent folder of a new project. */
  dir?: string | null;
  github?: boolean;
  // fields, edit text, edit image, meta set, context add
  /** A field id from the last `fields` listing (f1, f2…). */
  field?: string | null;
  find?: string | null;
  to?: string | null;
  file?: string | null;
  src?: string | null;
  tag?: string | null;
  value?: string | null;
  mode?: string | null;
  text?: string | null;
  selector?: string | null;
  replace?: boolean;
  url?: string | null;
  /** A comment, moment or agent session id. */
  id?: string | null;
  // sync, publish, moments
  strategy?: string | null;
  branch?: string | null;
  message?: string | null;
  gate?: boolean;
  scope?: string | null;
  pr?: boolean;
  commit?: boolean;
  label?: string | null;
  // migrate
  framework?: string | null;
  engine?: string | null;
  files?: string[];
  only?: string[];
  routes?: string[];
  widths?: number[] | null;
  // shot
  /** The page's width in CSS pixels (radial serve's browser; the Mac app shoots the preview at the width it shows). */
  width?: number | null;
  // url
  /** A link with a one-time pass for a browser on another machine (radial serve --listen --allow-remote). */
  share?: boolean;
  // agents
  task?: string | null;
  submit?: boolean;
  /** agent answer: the option, by its number or its label, and the id of the question it is for (agent question gives it). */
  answer?: string | null;
  expect?: string | null;
  lines?: number | null;
  waitMs?: number;
  since?: number | null;
  off?: boolean;
}

/**
 * An HTTP caller of radial serve --listen (src/headless/listen.ts), which the
 * listener vouches for: the token it showed, and the name it reached this
 * machine by (its Host header's, checked against the listener's own).
 */
export interface HttpCaller {
  /** The API token's id (never the token itself). */
  tokenId: string;
  /** The Host header's name or address, without the port: what addresses printed for this caller use. */
  host: string;
}

/** What every op gets besides its request. */
export interface OpContext {
  /** The caller's working directory (relative paths and the default project resolve against it). */
  cwd: string;
  tty: boolean;
  progress: Progress;
  /** Set by radial serve's HTTP listener for its callers; a socket caller has none. */
  http?: HttpCaller | null;
}

/** How a request comes when it isn't over the socket: radial serve's HTTP listener runs it through dispatch(). */
export interface DispatchVia {
  progress?: Progress;
  http?: HttpCaller | null;
}

/** What an op answers: a Reply (OpReplies has each op's own). */
export type OpReply = Reply;

/** One socket op: its request in, exactly one reply out. */
export type Op = (p: OpRequest, ctx: OpContext) => Promise<OpReply>;

// ── What the app answers (the injected api, built by main.ts cliApi) ──

/** Which Radial answers: an installed Mac app, a checkout's build, or the headless core (`radial serve`). */
export type Flavor = 'packaged' | 'dev' | 'headless';
/**
 * hello: which app is answering. windowReady: a window is up and answering;
 * browser: it can work on the projects' pages (screenshots, fields), which
 * `radial serve` can't until `radial browser install`; listen: where radial
 * serve --listen takes HTTP requests (http://127.0.0.1:4000), when it does.
 */
export interface HelloInfo { version: string; flavor: Flavor; pid: number; windowReady: boolean; browser: boolean; listen?: string }

/** What `url` asks of radial serve's preview proxy: who asks (an HTTP caller, or none over the socket), and whether for a share link. */
export interface PreviewAsk { http: HttpCaller | null; share: boolean }
/** A one-time link that lets a browser on another machine into a project's preview proxy (radial serve --allow-remote). */
export interface ShareLink { url: string; expiresAt: number }
/** A project's preview through radial serve's proxy: its stable address, and a share link when one was asked for. */
export type PreviewAddress = { ok: true; url: string; share?: ShareLink } | { ok: false; error: string };

/** How a GitHub target's local copy came about (github.cloneOrPull). */
export type CloneInfo = Exclude<OpenedFromGitHub, { action: 'reused-local' }>;

/** A project open in the app, with what needs a person there (ls). */
export interface OpenProjectRow {
  repoDir: string;
  name: string;
  /** The preview's dev server, while it runs. */
  url: string | null;
  state: 'running' | 'asleep';
  /** The project the window shows. */
  active: boolean;
  /** Live agent terminals, and how many of them wait on the person. */
  terminals: number;
  waiting: number;
  openComments: number;
  /** Uncommitted changes; null when it isn't a repo or git failed. */
  changes: number | null;
}
/** A recent project that isn't open (ls --all): Home's recent-project row, built from the same recents.listRecents. */
export type RecentProjectRow = RecentProjectActivity;
/** ls: the open projects, plus the recent ones with --all. */
export type ProjectList = { projects: OpenProjectRow[]; recents?: RecentProjectRow[] };

/** status, spread into its reply. */
export interface ProjectStatus {
  name: string;
  open: boolean;
  suspended: boolean;
  url: string | null;
  /** publish.status; null when it threw. */
  git: RepoState | null;
  /** .radial/dev.json as the dev server last wrote it, read unchecked (devServer owns its shape); null without one. */
  dev: unknown;
}

/** A .context document: markdown and text inline, anything else by its size. */
export type ContextDoc =
  | { file: string; local?: boolean; content: string; bytes?: undefined }
  | { file: string; local?: boolean; bytes: number; content?: undefined };
/**
 * Everything the app knows about a site, for an agent: `context` (main.ts), and
 * the same read from disk while the app is closed (cli.ts offlineContext).
 */
export type ProjectContext = {
  name: string;
  /** AGENTS.md as the agent reads it. */
  rules: string;
  docs: ContextDoc[];
  references: ProjectReference[];
  /** null while the project isn't open (or the app is closed). */
  pages: PageEntry[] | null;
  url: string | null;
  /** null when the app is closed and the comments couldn't be read. */
  openComments: number | null;
  /** Colors, fonts and lengths (at most 80); null when the scan failed. */
  tokens: TokenSummary[] | null;
  /** Where the project's Radial files live; only the running app reports it. */
  storage?: ProjectStorageStatus;
};
/** context's reply. */
export type ContextReply = OkReply<{ repoDir: string } & ProjectContext>;

/** pages: a plain list, or (what the app answers) the list with how it was found and why it is empty. */
export type PagesAnswer = PageEntry[] | DiscoveredPages | { pages: []; framework: null; router: null; source: null; reason: 'not-open' };

/** A field as the window reports it; a thumbnail, if one comes along, stays in the app. */
export type PageField = ContentField & { thumb?: string | null };
/** fields: the page's editable fields, or why they can't be read. */
export type FieldsAnswer = { ok: true; route: string; fields: PageField[] } | Exclude<CliResult<'fields'>, { ok: true }>;
/** A field in a `fields` reply, with the id `edit text --field` takes. */
export type ListedField = ContentField & { id: string };
/** The last `fields` listing of a project. */
interface FieldListing { route: string; at: number; fields: ListedField[] }

/** new: what to scaffold (main.ts createNewProject). */
export interface NewSiteRequest { name: string; template: Template; dir: string | null; github: boolean }

/** A success with nothing to add: the reply's own ok stands. */
export interface NothingToAdd { ok?: undefined }
/** A success with no window to show it in (`radial serve`): focus and reload have nothing to do there. */
export interface Headless { ok?: undefined; headless: true }

/** The whole file before and after an edit, kept for undo; moduleResult never sends them. */
type Contents = Pick<FileEdit, 'prevContent' | 'newContent'>;
/** A module's answer whose success carries the file contents too. */
type WithContents<R> = R extends { ok: true } ? R & Contents : R;
/** A result whose ok is a plain boolean, split so each side reads as one. */
type SplitOk<R extends { ok: boolean }> = (Omit<R, 'ok'> & { ok: true }) | (Omit<R, 'ok'> & { ok: false });
/** A write-lane refusal in the renderer's vocabulary. */
type Refusal<R extends string> = { ok: false; reason: R; message: string };
/** A result's success fields without its ok, for spreading after the reply's own `ok: true`. */
type Success<R> = Omit<Extract<R, { ok: true }>, 'ok'>;

/** edit text: the text to find (or the field's), where to look, and the new text. */
export interface TextEditRequest {
  find: string;
  to: string;
  route: string | null;
  file: string | null;
  /** The field's structural pin, from `radial fields`. */
  path: ElementPathLevel[] | null;
}

/** meta set: which head tag, its new value, and where to look. */
export interface MetaSetRequest { tag: MetaTag; value: string; route: string | null; file: string | null }

/** publish: where to, and how. */
export interface PublishRequest {
  to: PublishTarget;
  message: string | null;
  /** false skips the local build check. */
  gate: boolean;
  scope: NonNullable<PublishOptions['scope']>;
  pr: boolean;
  commit: boolean;
}

/**
 * migrate start's preparation request (main.ts migratePrepare, which the
 * migrate:prepare IPC calls too): radialApi's MigrateOptions, except that the
 * engine may be null (no --engine: main picks one). Once MigrateOptions.engine
 * allows null, this is MigrateOptions.
 */
export type MigrateRequest = Omit<MigrateOptions, 'engine'> & { engine?: MigrateOptions['engine'] | null };

/** A sync strategy: fast-forward only (the default), or how to bring in diverged history. */
export type SyncStrategy = 'ff' | NonNullable<SyncOptions['strategy']>;
/**
 * sync's options as the op passes them on (main.ts publish.sync, which the
 * sync:run IPC calls with SyncOptions): SyncOptions plus 'ff' and nulls. An
 * empty or null strategy reads as none, the default, the same as 'ff' does
 * (integration.start). Once SyncOptions widens to this, this is SyncOptions.
 */
export interface SyncRequest {
  strategy?: SyncStrategy | '' | null;
  /** The branch to pull from; null for the upstream. */
  target?: SyncOptions['target'] | null;
}
/** The prepared project, a refusal in the protocol's terms, or the scaffold's own failure. */
export type MigratePrepareAnswer =
  | MigratePrepared
  | Extract<MigratePrepareResult, { code: string }>
  | (Extract<NewProjectResult, { ok: false }> & { code?: undefined });

/** migrate capture: where the capture landed and what it holds. */
export interface CaptureSummary {
  ok: true;
  /** The capture folder; its README.md comes first. */
  capture: string;
  readme: string;
  source: string;
  platform: string;
  /** The routes asked for; null for the whole site. */
  scope: Inventory['scope'];
  pages: number;
  assets: number;
  screens: number;
  /** Why it took no reference screenshots: this Radial has no browser (`radial serve`). */
  screensSkipped?: 'no-browser';
  /** The migration playbook's SKILL.md. */
  playbook: string;
}
/**
 * One route at one width in a comparison: a row migrate/index.ts compareSite
 * builds and writes to report.json (cli.ts and test/migrate.e2e.mts read them
 * too). migrate owns this shape: when migrate/index.ts is typed, it exports
 * the row type and this one imports it.
 */
export type CompareRow =
  | { route: string; width: number; error: string }
  | { route: string; width: number; changedPercent: number; heights: BitmapDiff['heights']; bands: DiffBand[]; files: { live: string; local: string; diff: string } };
/** migrate compare: the comparison folder, its report and the rows. */
export interface CompareSummary { ok: true; dir: string; report: string; rows: CompareRow[] }

/** An agent session's identity and activity stamps (main.ts tailSummary); a stamp is null until it happens. */
export type AgentSummary = {
  id: string;
  repoDir: string | null;
  engine: PtyEngine | null;
  label: string | null;
  alive: boolean;
  startedAt: number | null;
  lastDataAt: number | null;
  lastBellAt: number | null;
  lastInputAt: number | null;
};
/** Why `agent wait` stopped waiting. */
export type AgentWaitReason = 'bell' | 'exit' | 'idle' | 'timeout';
/** What a session is doing: rang its bell after the last input (waiting), printing (working), neither (Home's activity rule), or gone. */
export type AgentState = TerminalActivityState | 'exited';
/** A session in `agent list`. */
export interface AgentRow extends Omit<AgentSummary, 'repoDir'> {
  repoDir: string;
  /** The project's name, or Home. */
  name: string;
  home: boolean;
  keepAwake: boolean;
  state: AgentState;
}

/**
 * The app behind the socket: closures over main.ts's session state (cliApi), or
 * a fake in a test. The server validates each request, then hands the real work
 * here; it never starts a project itself (requestOpen, then the open bus).
 */
export interface CliApi {
  info(): HelloInfo;
  isOpen(dir: string): boolean;
  /** Brings the window forward; with none (`radial serve`), says so. */
  focus(): NothingToAdd | Headless;
  /** Counts a command by its op name, never its arguments; via says it came through radial serve's HTTP listener (never who sent it or from where). */
  telemetry(op: string, via?: { http: boolean }): void;
  /** Asks the window to open a folder the way `radial .` does; the outcome comes back through settleOpen. */
  requestOpen(dir: string): void;
  resolve(target: string | null | undefined, cwd: string): Promise<ResolveResult>;
  clone(url: string, progress: Progress): Promise<{ ok: true; dir: string; github: CloneInfo } | ErrorReply>;
  projects(opts: { all: boolean }): Promise<ProjectList>;
  previewUrl(dir: string): string | null;
  /**
   * radial serve --listen's preview proxy for an open project: a stable address
   * that follows its dev server's restarts, and a share link when asked. null
   * when there's no proxy (the Mac app, serve without --listen) or the project
   * isn't open.
   */
  previewAddress(dir: string, ask: PreviewAsk): Promise<PreviewAddress | null>;
  status(dir: string): Promise<ProjectStatus>;
  context(dir: string): Promise<ProjectContext>;
  pages(dir: string): Promise<PagesAnswer>;
  comments(dir: string, opts: { open: boolean }): Promise<ReviewComment[]>;
  /** A full-page screenshot; width (CSS pixels) is radial serve's, and the Mac app shoots the preview at the width it shows. */
  shot(dir: string, route: string | null, width?: number | null): Promise<CliResult<'shot'>>;
  create(site: NewSiteRequest, progress: Progress): Promise<NewProjectResult>;
  sleep(dir: string): Promise<{ state: 'asleep' } | ErrorReply>;
  wake(dir: string): Promise<{ state: 'running'; url: string | null } | ErrorReply>;
  reload(dir: string): Promise<NothingToAdd | Headless | ErrorReply>;
  restart(dir: string): Promise<{ url: string | null } | ErrorReply>;
  close(dir: string, opts: { yes: boolean }): Promise<{ state: 'closed' }>;
  liveTerminals(dir: string): Promise<number>;

  // write lane: the panels' own engines
  fileExists(file: string): boolean;
  editText(dir: string, edit: TextEditRequest): Promise<WithContents<TextEditResult>>;
  editImage(dir: string, swap: { src: string; file: string }): Promise<SplitOk<ImageSwapResult>>;
  metaSet(dir: string, set: MetaSetRequest): Promise<WithContents<HeadTagResult> | Refusal<'invalid'>>;
  commentAdd(dir: string, comment: Required<Pick<NewComment, 'text' | 'route' | 'selector'>>): Promise<{ ok: true; comment: ReviewComment } | Refusal<'error'>>;
  commentResolve(dir: string, id: string): Promise<{ ok: true; comment: ReviewComment } | Refusal<'error'> | { ok: false; reason: 'not-found' }>;
  commentsPull(dir: string): Promise<VercelPullResult>;
  sync(dir: string, opts: SyncRequest): Promise<IntegrationResult>;
  publish(dir: string, opts: PublishRequest, progress: Progress): Promise<PublishResult | PublishDeployResult>;
  /** Where a publish to `to` would push now (publish.ts destination): an agent's needs --yes whenever it lands on the production branch. */
  publishDestination(dir: string, to: PublishTarget): Promise<{ branch: string | null; production: boolean }>;
  momentsList(dir: string): Promise<MomentList>;
  momentRecord(dir: string, label: string | null): Promise<MomentRecordResult>;
  momentRestore(dir: string, id: string): Promise<MomentRestoreResult>;
  fields(dir: string, route: string | null): Promise<FieldsAnswer>;
  tokens(dir: string): Promise<TokenIndex>;
  /** The name and value as the op checked them, and SetTokenRequest's mode. */
  tokenSet(dir: string, set: { name: string; value: string } & Required<Pick<SetTokenRequest, 'mode'>>): Promise<SetTokenResult>;
  contextAdd(dir: string, add: { name: string | null; text: string | null; file: string | null; replace: boolean }): Promise<{ ok: true; rel: string; imported: true } | { ok: true; rel: string; replaced: boolean } | Refusal<'error' | 'exists'>>;
  refAdd(dir: string, url: string): Promise<{ ok: true; ref: ProjectReference } | Refusal<'error'>>;
  refRemove(dir: string, url: string): Promise<{ ok: true; url: string } | { ok: false; reason: 'not-found' }>;
  ruleAdd(dir: string, text: string): Promise<{ ok: true; file: 'AGENTS.md' } | Refusal<'invalid'>>;
  undo(dir: string): Promise<{ ok: true; relFile: string } | Refusal<'nothing'>>;
  redo(dir: string): Promise<{ ok: true; relFile: string } | Refusal<'nothing'>>;

  // site migration
  migratePrepare(opts: MigrateRequest, progress: Progress): Promise<MigratePrepareAnswer>;
  /**
   * Fails with 'error' or the window's own CliFailureCode (askRenderer). Once
   * radialApi's MigrateLaunchResult says so too (its failure is CliFailure),
   * this answers MigrateLaunchResult.
   */
  migrateLaunch(prep: MigrateLaunchArgs): Promise<Extract<MigrateLaunchResult, { ok: true }> | CliFailure>;
  migrateCapture(dir: string, url: string, progress: Progress, opts: { only: string[] }): Promise<CaptureSummary | ErrorReply>;
  migrateCompare(dir: string, opts: { routes: string[]; widths: number[] | null }, progress: Progress): Promise<CompareSummary | ErrorReply>;

  // agent lane: visible sessions in the app's terminals
  agentStart(dir: string, opts: Omit<CliRequests['agent'], 'repoDir'>): Promise<CliResult<'agent'>>;
  agentSend(id: string, opts: Omit<CliRequests['agentSend'], 'id'>): Promise<CliResult<'agentSend'>>;
  home(opts: CliRequests['home']): Promise<CliResult<'home'>>;
  agentOutput(id: string, opts: { lines: number | null }): Promise<AgentOutputReply | ErrorReply>;
  /** Whether the session's CLI asks a question of its own now, and the question with its id (src/core/questions.ts). */
  agentQuestion(id: string): Promise<AgentQuestionReply | ErrorReply>;
  /** Types an answer into that question as a person would at its terminal, given the yes and the question's id; without them, what it would do. */
  agentAnswer(id: string, ask: AnswerAsk): Promise<AgentAnswerReply | AnswerRefusal>;
  agentWait(id: string, opts: { waitMs: number; since: number | null; idleMs: number }): Promise<AgentWaitReply | ErrorReply>;
  agentList(dir: string | null): Promise<AgentRow[]>;
  agentKill(id: string): Promise<{ ok: true; id: string } | ErrorReply>;
  agentKeep(id: string, opts: { on: boolean }): Promise<KeepAwakeResult>;
}

/** A module's success: its own fields, plus file contents it may carry for undo. */
export interface ModuleDone { ok: true; prevContent?: string; newContent?: string }
/** A module's failure in the renderer's vocabulary: a reason, a message, and the detail moduleResult passes on. */
export interface ModuleFailure {
  ok: false;
  code?: undefined;
  reason?: string;
  message?: string;
  error?: string;
  /** already-applied: where the text already is. */
  relFile?: string;
  line?: number;
  /** ambiguous: the places it could mean. */
  candidates?: { relFile: string; line: number }[];
  fixPrompt?: string;
  fixLabel?: string;
  deploy?: BuildGateSummary;
  /** Conflicting files. */
  files?: string[];
}
/** What moduleResult maps to a reply: a module's answer, or an error reply already in the protocol's terms. */
export type ModuleResult = ModuleDone | ModuleFailure | ErrorReply;

// ── The open bus ──

/**
 * What main.ts hands settleOpen: openRepo's result for the renderer's
 * project:open (radialApi OpenProjectResult), as far as the server reads it.
 */
export type OpenOutcome =
  | { ok: true; already?: boolean; repoDir?: string; project?: { name: string } | null; url?: string | null; suspended?: boolean }
  | { ok: false; code?: undefined; reason?: string; error?: string };
/** What a waiter gets: the outcome, or a timeout (or quit) error. */
export type OpenSettled = OpenOutcome | ErrorReply;
interface OpenWaiter { resolve: (res: OpenSettled) => void; timer?: NodeJS.Timeout }

/** open's reply (openDir's, which new and migrate start build their own replies on): the project is up, or queued with --no-wait. */
export type OpenedReply = {
  ok: true;
  state: 'opened' | 'focused' | 'queued';
  repoDir: string;
  name?: string | null;
  url?: string | null;
  suspended?: boolean;
  github?: CloneInfo;
};

// ── What each op answers: the replies the CLI (cli.ts printHuman) and the MCP server (mcp.ts renderResult) read ──

/** An answer of the api, by method. */
type ApiAnswer<K extends keyof CliApi> = Awaited<ReturnType<CliApi[K]>>;
/** The success a module's answer R becomes: its own fields without the file contents, under the project. */
type ModuleDoneReply<R> = R extends { ok: true } ? OkReply<{ repoDir: string } & Omit<R, 'ok' | keyof Contents>> : never;
/** A module's already-applied refusal, which moduleResult answers as a success: where the text already is. */
type AlreadyAppliedReply<R> =
  R extends { ok: false; reason: 'already-applied'; relFile: infer F; line: infer L } ? OkReply<{ repoDir: string; already: true; relFile: F; line: L }>
  : R extends { ok: false; reason?: infer W } ? ('already-applied' extends W ? OkReply<{ repoDir: string; already: true; relFile: string | undefined; line: number | undefined }> : never)
  : never;
/** moduleResult's success for a module's answer R (each answer may also map to an ErrorReply). */
export type ModuleSuccess<R> = ModuleDoneReply<R> | AlreadyAppliedReply<R>;

/** status. */
export type StatusReply = OkReply<{ repoDir: string } & ProjectStatus>;
/**
 * url, from the app or (the app closed) from .radial/dev.json. Under radial
 * serve --listen, url is the preview proxy's stable address and devUrl the dev
 * server's own; share is the one-time link `url --share` asked for.
 */
export type UrlReply = OkReply<{ repoDir: string; url: string; devUrl?: string; share?: ShareLink }>;
/** What new adds to open's reply: the folder it created, and the GitHub repo it made, or why it couldn't. */
export interface NewProjectExtras {
  created: string;
  github: NonNullable<Extract<NewProjectResult, { ok: true }>['github']> | null;
  githubError: string | null;
}
/** new: open's reply for the new folder (never a clone), with what it created. */
export type NewReply = Omit<OpenedReply, 'github'> & NewProjectExtras;
/** new, when the project was created but didn't open: the error still says what was created. */
export type NewOpenFailure = ErrorReply & NewProjectExtras;
/** fields: the page's fields with their ids (the last listing, which `edit text --field` reads). */
export type FieldsReply = OkReply<{ repoDir: string; route: string; fields: ListedField[] }>;
/** tokens, from the app or (the app closed) straight from tokens.indexTokens. */
export type TokensReply = OkReply<{ repoDir: string } & Omit<TokenIndex, 'ok'>>;
/** comments pull: how the Vercel threads changed .radial/comments.json. */
export type CommentsPullReply = OkReply<{ repoDir: string } & Success<VercelPullResult>>;
/** migrate start: the project, its capture, and the agent rebuilding it. */
export type MigrateStartReply = OkReply<
  & {
    repoDir: string;
    /** The framework's label (Astro, Next.js). */
    framework: MigratePrepared['frameworkLabel'];
    /** The routes asked for; null for the whole site. */
    scope: string[] | null;
    /** The preview's dev server. */
    url: string | null;
  }
  & Pick<MigratePrepared, 'name' | 'source' | 'platform' | 'pages' | 'assets' | 'capture'>
  & Pick<Extract<MigrateLaunchResult, { ok: true }>, 'engine' | 'session'>
>;
/** agent output: the session's stamps and the tail of its screen. */
export type AgentOutputReply = OkReply<AgentSummary & { text: string }>;
/** agent wait: why it stopped waiting, and the tail of the screen then; asking when its CLI then asks a question of its own. */
export type AgentWaitReply = OkReply<AgentSummary & { reason: AgentWaitReason; text: string; asking?: true }>;
/**
 * agent question: whether the session's CLI asks a question of its own now
 * (signing in, trusting the folder, approving a command), the question as its
 * screen shows it when it does, with its id (one occurrence of it), and the
 * screen (left out for a question that takes text, whose field may show what
 * was typed so far).
 */
export type AgentQuestionReply = OkReply<{ id: string; engine: PtyEngine | null; alive: boolean; asking: boolean; question: ShownQuestion | null; text: string }>;
/** What an answer gives, the id of the question it is for, the yes, and when its caller stops waiting (ms since the epoch). */
export interface AnswerAsk { answer: string | null; text: string | null; expect: string | null; yes: boolean; deadline?: number | null }
/** An answer that didn't go in: why, with the question the session asks now (and its id), or the screen when it asks none. */
export type AnswerRefusal = ErrorReply & { question?: ShownQuestion; text?: string };
/**
 * agent answer: the question answered (as it was, with its id), the option
 * chosen (null for text or Enter alone), and what the session shows after: the
 * question gone, the next one (with its own id), or the session ended.
 */
export type AgentAnswerReply = OkReply<{ id: string; question: ShownQuestion; chose: QuestionOption | null; after: AnswerAfter; next: ShownQuestion | null; text: string; answeredAt: number }>;
/** agent keep: the switch as it now stands; daemonOutdated: the terminal service can't hold the Mac awake yet, only the app can. */
export type AgentKeepReply = OkReply<Success<KeepAwakeResult>>;

/** Each socket op's reply when it works; every op may answer an ErrorReply instead. */
export interface OpReplies {
  hello: OkReply<{ protocol: number } & HelloInfo>;
  focus: { ok: true; headless?: true };
  resolve:
    | OkReply<{ kind: 'clone'; url: string }>
    | OkReply<{ kind: 'path'; repoDir: string; open: boolean; match: NonNullable<ResolvedPath['match']> | 'path' }>;
  open: OpenedReply;
  ls: OkReply<ProjectList>;
  status: StatusReply;
  url: UrlReply;
  context: ContextReply;
  /** The list, with how it was found and why it is empty. */
  pages: OkReply<{ repoDir: string; pages: PageEntry[] }> | OkReply<{ repoDir: string } & Exclude<PagesAnswer, PageEntry[]>>;
  comments: OkReply<{ repoDir: string; comments: ReviewComment[] }>;
  shot: OkReply<{ repoDir: string } & Success<CliResult<'shot'>>>;
  new: NewReply | NewOpenFailure;
  sleep: OkReply<{ repoDir: string; state: 'asleep' }>;
  wake: OkReply<{ repoDir: string; state: 'running'; url: string | null }>;
  reload: OkReply<{ repoDir: string; headless?: true }>;
  restart: OkReply<{ repoDir: string; url: string | null }>;
  close: OkReply<{ repoDir: string; state: 'closed' }>;
  fields: FieldsReply;
  editText: ModuleSuccess<ApiAnswer<'editText'>>;
  editImage: ModuleSuccess<ApiAnswer<'editImage'>>;
  metaSet: ModuleSuccess<ApiAnswer<'metaSet'>>;
  commentAdd: ModuleSuccess<ApiAnswer<'commentAdd'>>;
  commentResolve: ModuleSuccess<ApiAnswer<'commentResolve'>>;
  commentsPull: CommentsPullReply;
  sync: ModuleSuccess<ApiAnswer<'sync'>>;
  /** The publish, and where it went. */
  publish: ModuleSuccess<ApiAnswer<'publish'>> & { target: PublishTarget };
  moments: ModuleSuccess<ApiAnswer<'momentsList'>>;
  momentRecord: ModuleSuccess<ApiAnswer<'momentRecord'>>;
  momentRestore: ModuleSuccess<ApiAnswer<'momentRestore'>>;
  tokens: TokensReply;
  tokenSet: ModuleSuccess<ApiAnswer<'tokenSet'>>;
  contextAdd: ModuleSuccess<ApiAnswer<'contextAdd'>>;
  refAdd: ModuleSuccess<ApiAnswer<'refAdd'>>;
  refRemove: ModuleSuccess<ApiAnswer<'refRemove'>>;
  ruleAdd: ModuleSuccess<ApiAnswer<'ruleAdd'>>;
  undo: ModuleSuccess<ApiAnswer<'undo'>>;
  redo: ModuleSuccess<ApiAnswer<'redo'>>;
  migrateStart: MigrateStartReply;
  migrateCapture: OkReply<{ repoDir: string } & Success<CaptureSummary>>;
  migrateCompare: OkReply<{ repoDir: string } & Success<CompareSummary>>;
  agentStart: OkReply<{ repoDir: string } & Success<CliResult<'agent'>>>;
  agentSend: OkReply<Success<CliResult<'agentSend'>>>;
  home: OkReply<Success<CliResult<'home'>>>;
  agentOutput: AgentOutputReply;
  agentWait: AgentWaitReply;
  agentQuestion: AgentQuestionReply;
  agentAnswer: AgentAnswerReply;
  /** repoDir when the listing was for one project. */
  agentList: OkReply<{ repoDir?: string; agents: AgentRow[] }>;
  agentKill: OkReply<{ id: string }>;
  agentKeep: AgentKeepReply;
}
/** A socket op's name (cliSpec's `op`, else the verb, plus hello). */
export type OpName = keyof OpReplies;
/** The op table: each op answers its own reply, or an error. */
export type OpTable = { [K in OpName]: (p: OpRequest, ctx: OpContext) => Promise<OpReplies[K] | ErrorReply> };

/** A target resolved to a local folder; a GitHub target cloned on the way says how. */
type LocalTarget = ResolvedPath & { github?: CloneInfo | null };

export interface StartOptions {
  socketPath: string;
  api: CliApi;
  log?: (line: string) => void;
}
/**
 * How starting went with the socket: this server listens on it, or another live
 * server already answers there (a second process on the same data dir) and
 * keeps it, or the socket couldn't be set up.
 */
export type SocketClaim = { ok: true } | { ok: false; code: 'in-use' | 'error'; error: string };
/** The running server, as main.ts holds it. */
export interface ControlServer {
  stop(): void;
  /** main.ts calls it with openRepo's result when the renderer's project:open lands. */
  settleOpen(dir: string, res: OpenOutcome): void;
  waitForOpen(dir: string, timeoutMs?: number): Promise<OpenSettled>;
  socketPath: string;
  /** Settles once the server listens, or knows it won't (see SocketClaim). */
  ready: Promise<SocketClaim>;
  /**
   * Runs one request the way the socket does (the same ops, checks and
   * replies), for a caller that isn't on the socket: radial serve's HTTP
   * listener, whose /rpc streams the progress and whose /mcp answers tools.
   */
  dispatch(msg: OpRequest, via?: DispatchVia): Promise<Reply>;
  /** The op table, for tests. */
  _ops: OpTable;
}

/** What needs a browser on a project's page: a screenshot, its fields, a field id (which comes from them), a migration compare. */
export type BrowserNeed = 'shot' | 'fields' | 'field-text' | 'field-image' | 'compare';
/** A no-browser refusal: why, the command that adds a browser, and the one that does the job without it. */
export interface NoBrowserReply { ok: false; code: 'no-browser'; error: string; repoDir: string; fix: string; instead: string }
/** The page widths `radial shot --width` takes, in CSS pixels: a small phone to a 4K screen. */
export const SHOT_WIDTHS = [240, 3840] as const;
/** The command that gives radial serve a browser (src/headless/browser.ts). */
export const BROWSER_INSTALL = 'radial browser install';
/**
 * The refusal of a Radial with no browser on its projects' pages (`radial
 * serve` before `radial browser install`): what it can't do, in fix the command
 * that adds the browser, and in instead the one that does the job another way
 * meanwhile. Exit 6, like the CLI's other refusals.
 */
export function noBrowser(need: BrowserNeed, dir: string): NoBrowserReply {
  const site = /[^\w./~-]/.test(dir) ? JSON.stringify(dir) : dir; // quoted when a shell would split it
  const without = 'This Radial has no browser for its projects\' pages yet (radial serve)';
  const fromFields = 'Field ids come from `radial fields`, which needs a browser, and this Radial has none yet (radial serve).';
  const editText = `radial edit text ${site} --find "<current text>" --to "<new text>"`;
  const reply = (error: string, instead: string): NoBrowserReply => ({ ok: false, code: 'no-browser', error, repoDir: dir, fix: BROWSER_INSTALL, instead });
  switch (need) {
    case 'shot': return reply(`${without}, so it can't take screenshots. Until it has one, open the preview's address in a browser you have.`, `radial url ${site}`);
    case 'fields': return reply(`${without}, so it can't read a page's fields. Until it has one, edit text by its current wording.`, editText);
    case 'field-text': return reply(`${fromFields} Until it has one, edit the text by its current wording.`, editText);
    case 'field-image': return reply(`${fromFields} Until it has one, name the image by its current src.`, `radial edit image ${site} --src <current src> --file <image path>`);
    case 'compare': return reply(`${without}, so it can't screenshot the live site and the preview to compare them. Until it has one, open both in a browser you have.`, `radial url ${site}`);
  }
}

// An edit engine / module result → a protocol reply. Module results say
// {ok:false, reason} (the renderer's vocabulary); the wire says {ok:false, code}.
function moduleResult<R extends ModuleResult>(dir: string, res: R, labels?: { notFound?: string; ambiguous?: string }): ModuleSuccess<R> | ErrorReply;
function moduleResult(dir: string, res: ModuleResult, { notFound = 'Nothing matched.', ambiguous = 'More than one match.' }: { notFound?: string; ambiguous?: string } = {}): Reply {
  if (!res) return err('error', 'No answer.');
  if (res.ok) { const { prevContent, newContent, ...slim }: Partial<ModuleDone> = res; return { ok: true, repoDir: dir, ...slim }; } // Partial: slim's ok reads optional, the reply sets its own
  if (res.code) return res; // already a protocol error
  const msg = res.message || res.error || null;
  switch (res.reason) {
    case 'already-applied': return { ok: true, repoDir: dir, already: true, relFile: res.relFile, line: res.line };
    case 'not-found': return err('not-found', msg || notFound, { repoDir: dir, reason: res.reason });
    case 'ambiguous': return err('ambiguous', msg || ambiguous, { repoDir: dir, reason: res.reason, pick: false, candidates: (res.candidates || []).map((c) => ({ name: `${c.relFile}:${c.line}`, path: c.relFile, line: c.line })) });
    case 'no-dev-server': return err('no-dev-server', msg || 'The preview is not running. Open the project first.', { repoDir: dir });
    case 'empty-original': case 'invalid-new-text': case 'no-change': case 'invalid': case 'exists':
      return err('bad-request', msg || `Bad request (${res.reason}).`, { repoDir: dir, reason: res.reason });
    default: return err('error', msg || `${res.reason || 'failed'}.`, { repoDir: dir, ...(res.reason ? { reason: res.reason } : {}), ...(res.fixPrompt ? { fixPrompt: res.fixPrompt, fixLabel: res.fixLabel } : {}), ...(res.deploy ? { deploy: res.deploy } : {}), ...(res.files ? { files: res.files } : {}) });
  }
}

function start({ socketPath, api, log = () => {} }: StartOptions): ControlServer {
  // ── open-result bus ──
  const waiters = new Map<string, OpenWaiter[]>(); // dir → [{ resolve, timer }]
  function settleOpen(dir: string, res: OpenOutcome): void {
    const list = waiters.get(dir); if (!list) return;
    waiters.delete(dir);
    for (const w of list) { clearTimeout(w.timer); w.resolve(res); }
  }
  function waitForOpen(dir: string, timeoutMs = OPEN_WAIT_MS): Promise<OpenSettled> {
    return new Promise((resolve) => {
      const w: OpenWaiter = { resolve };
      w.timer = setTimeout(() => {
        waiters.set(dir, (waiters.get(dir) || []).filter((x) => x !== w));
        resolve(err('timeout', 'Timed out waiting for the app to open the project.'));
      }, timeoutMs);
      waiters.set(dir, [...(waiters.get(dir) || []), w]);
    });
  }
  const hasWaiter = (dir: string) => (waiters.get(dir) || []).length > 0;

  // ── the open flow, shared by open / new / anything that wants a project up ──
  async function openDir(dir: string, { wait = true, timeoutMs, github = null }: { wait?: boolean; timeoutMs?: number; github?: CloneInfo | null } = {}): Promise<OpenedReply | ErrorReply> {
    if (wait === false) { api.requestOpen(dir); return { ok: true, state: 'queued', repoDir: dir }; }
    const p = waitForOpen(dir, timeoutMs);
    if (!hasWaiter(dir) || (waiters.get(dir) || []).length === 1) api.requestOpen(dir); // concurrent opens of one dir share the request
    const res = await p;
    return openResult(res, dir, github);
  }
  function openResult(res: OpenSettled, dir: string, github: CloneInfo | null): OpenedReply | ErrorReply {
    if (!res) return err('error', 'The app gave no answer.');
    if (res.ok === false && res.code) return res; // already a protocol error (timeout)
    if (res.ok) {
      const out: OpenedReply = { ok: true, state: res.already ? 'focused' : 'opened', repoDir: res.repoDir || dir, name: res.project && res.project.name, url: res.url || null, suspended: !!res.suspended };
      if (github) out.github = github;
      return out;
    }
    if (res.reason === 'node-missing') return err('node-missing', res.error || 'Node.js was not found.');
    return err('error', res.error || 'Could not open the project.');
  }

  // Resolve a target to a local folder; `clone` says whether a GitHub target may be cloned.
  async function target(payload: OpRequest, ctx: OpContext, { clone = false }: { clone?: boolean } = {}): Promise<LocalTarget | ErrorReply> {
    const r = await api.resolve(payload.target, ctx.cwd);
    if (!r.ok) return r;
    if (r.kind === 'clone') {
      if (!clone) return err('not-found', `${r.url} is not on this machine yet. Run \`radial open ${r.url}\` first.`);
      const c = await api.clone(r.url, ctx.progress);
      if (!c.ok) return c;
      return { ok: true, kind: 'path', dir: c.dir, github: c.github || null };
    }
    return r;
  }

  // The last `fields` listing per project: `edit text --field f3` resolves the
  // id here (its text and structural path), so an agent never retypes either.
  const lastFields = new Map<string, FieldListing>(); // repoDir → { route, at, fields }
  function fieldFrom<K extends ListedField['kind']>(dir: string, id: string, kind: K): { ok: true; field: Extract<ListedField, { kind: K }>; route: string } | ErrorReply {
    if (api.info().browser === false) return noBrowser(kind === 'image' ? 'field-image' : 'field-text', dir); // no browser, no listing to read ids from
    const c = lastFields.get(dir);
    if (!c) return err('bad-request', `Run \`radial fields ${dir}\` first; field ids come from that listing.`);
    const f = c.fields.find((x) => x.id === id);
    if (!f) return err('not-found', `No field ${id} in the last listing of ${c.route} (${c.fields.length} fields). Run \`radial fields\` again.`);
    if (kind && f.kind !== kind) return err('bad-request', `${id} is ${f.kind === 'image' ? 'an image' : f.kind === 'animated' ? 'an animated block' : 'text'}, not ${kind === 'image' ? 'an image' : 'text'}.`);
    return { ok: true, field: f as Extract<ListedField, { kind: K }>, route: c.route }; // the kind check above
  }

  const ops: OpTable = {
    async hello() { return { ok: true, protocol: PROTOCOL, ...api.info() }; },
    async focus() { const r = api.focus(); return 'headless' in r && r.headless ? { ok: true, headless: true } : { ok: true }; },
    async resolve(p, ctx) {
      const r = await api.resolve(p.target, ctx.cwd);
      if (!r.ok) return r;
      if (r.kind === 'clone') return { ok: true, kind: 'clone', url: r.url };
      return { ok: true, kind: 'path', repoDir: r.dir, open: api.isOpen(r.dir), match: r.match || 'path' };
    },
    async open(p, ctx) {
      const r = await target(p, ctx, { clone: true });
      if (!r.ok) return r;
      return openDir(r.dir, { wait: p.wait !== false, timeoutMs: p.timeoutMs, github: r.github || null });
    },
    async ls(p) { return { ok: true, ...(await api.projects({ all: !!p.all })) }; },
    async status(p, ctx) { const r = await target(p, ctx); if (!r.ok) return r; return { ok: true, repoDir: r.dir, ...(await api.status(r.dir)) }; },
    async url(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      const u = api.previewUrl(r.dir);
      if (!u) return err('no-dev-server', `${r.dir} is not running in Radial. Run \`radial open ${r.dir}\` first.`, { repoDir: r.dir });
      // radial serve --listen: the preview proxy's stable address, which follows the dev server's restarts.
      const proxied = typeof api.previewAddress === 'function' ? await api.previewAddress(r.dir, { http: ctx.http || null, share: !!p.share }) : null; // a test's stand-in api may have none
      if (proxied && !proxied.ok) return err('bad-request', proxied.error, { repoDir: r.dir });
      if (proxied) return { ok: true, repoDir: r.dir, url: proxied.url, devUrl: u, ...(proxied.share ? { share: proxied.share } : {}) };
      if (p.share) return err('bad-request', 'A share link needs radial serve with --listen and --allow-remote: it lets a browser on another machine open the preview through its proxy.', { repoDir: r.dir });
      return { ok: true, repoDir: r.dir, url: u };
    },
    async context(p, ctx) { const r = await target(p, ctx); if (!r.ok) return r; return { ok: true, repoDir: r.dir, ...(await api.context(r.dir)) }; },
    async pages(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      if (!api.isOpen(r.dir)) return err('not-open', `${r.dir} is not open in Radial. Run \`radial open ${r.dir}\` first.`, { repoDir: r.dir });
      const d = await api.pages(r.dir);
      return Array.isArray(d) ? { ok: true, repoDir: r.dir, pages: d } : { ok: true, repoDir: r.dir, ...d }; // pages + framework/router/source/reason (why an empty list is empty)
    },
    async comments(p, ctx) { const r = await target(p, ctx); if (!r.ok) return r; return { ok: true, repoDir: r.dir, comments: await api.comments(r.dir, { open: !!p.open }) }; },
    async shot(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      if (api.info().browser === false) return noBrowser('shot', r.dir); // first: opening the project wouldn't help
      if (p.width != null && !(Number.isInteger(p.width) && p.width >= SHOT_WIDTHS[0] && p.width <= SHOT_WIDTHS[1])) return err('bad-request', `--width takes the page's width in CSS pixels, from ${SHOT_WIDTHS[0]} to ${SHOT_WIDTHS[1]}.`, { repoDir: r.dir });
      if (!api.previewUrl(r.dir)) return err('no-dev-server', `${r.dir} has no running preview. Run \`radial open ${r.dir}\` first.`, { repoDir: r.dir });
      const s = await api.shot(r.dir, p.route || null, p.width ?? null);
      return s.ok ? { ok: true, repoDir: r.dir, ...(s as Success<CliResult<'shot'>>) } : (s.code ? s : err('error', s.error || 'Screenshot failed.'));
    },
    async new(p, ctx) {
      const name = String(p.name || '').trim();
      if (!name) return err('bad-request', 'new needs a name: radial new <name> --template astro|next|html');
      if (!TEMPLATES.includes(p.template as Template)) return err('bad-request', `--template must be one of ${TEMPLATES.join(', ')}`);
      const res = await api.create({ name, template: p.template as Template, dir: p.dir || null, github: !!p.github }, ctx.progress);
      if (!res.ok) return err('error', res.error || 'Could not create the project.');
      const opened = await openDir(res.dir, { wait: p.wait !== false, timeoutMs: p.timeoutMs });
      return { ...opened, created: res.dir, github: res.github || null, githubError: res.githubError || null };
    },
    async sleep(p, ctx) { const r = await target(p, ctx); if (!r.ok) return r; return { ok: true, repoDir: r.dir, ...(await api.sleep(r.dir)) }; },
    async wake(p, ctx) { const r = await target(p, ctx); if (!r.ok) return r; return { ok: true, repoDir: r.dir, ...(await api.wake(r.dir)) }; },
    async reload(p, ctx) { const r = await target(p, ctx); if (!r.ok) return r; return { ok: true, repoDir: r.dir, ...(await api.reload(r.dir)) }; },
    async restart(p, ctx) { const r = await target(p, ctx); if (!r.ok) return r; return { ok: true, repoDir: r.dir, ...(await api.restart(r.dir)) }; },
    async close(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      if (!api.isOpen(r.dir)) return err('not-open', `${r.dir} is not open.`, { repoDir: r.dir });
      const live = await api.liveTerminals(r.dir);
      if (live > 0 && !p.yes) return err('needs-yes', `${r.dir} has ${live} live agent terminal${live === 1 ? '' : 's'}. Pass --yes to close it anyway.`, { repoDir: r.dir, terminals: live });
      return { ok: true, repoDir: r.dir, ...(await api.close(r.dir, { yes: !!p.yes })) };
    },

    // ── write lane: deterministic, no agent (the same engines the panels use) ──
    async fields(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      if (api.info().browser === false) return noBrowser('fields', r.dir);
      if (!api.isOpen(r.dir)) return err('not-open', `${r.dir} is not open in Radial. Run \`radial open ${r.dir}\` first.`, { repoDir: r.dir });
      const res = await api.fields(r.dir, p.route || null);
      if (!res || !res.ok) return res && res.code ? res : err('error', (res && res.error) || 'Could not read the page.');
      const fields = (res.fields || []).map(({ thumb, ...f }, i) => ({ id: 'f' + (i + 1), ...f }));
      lastFields.set(r.dir, { route: res.route || '/', at: Date.now(), fields });
      return { ok: true, repoDir: r.dir, route: res.route || '/', fields };
    },
    async editText(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      let find = p.find, route = p.route || null, fieldPath = null;
      if (p.field) {
        const fr = fieldFrom(r.dir, p.field, 'text'); if (!fr.ok) return fr;
        if (!find) { if (fr.field.truncated) return err('bad-request', `${p.field}'s text is longer than the listing shows; pass --find with the full current text.`); find = fr.field.text; }
        fieldPath = fr.field.path || null; route = route || fr.route;
      }
      if (!find || p.to == null) return err('bad-request', 'edit text needs --field <id> (from `radial fields`) or --find "<current text>", and --to "<new text>".');
      return moduleResult(r.dir, await api.editText(r.dir, { find, to: p.to, route, file: p.file || null, path: fieldPath }), { notFound: `"${find}" is not in the site's source as visible text (or it is dynamic).`, ambiguous: `"${find}" appears in several places; pin it with --field, --route or --file.` });
    },
    async editImage(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      let src = p.src;
      if (p.field) { const fr = fieldFrom(r.dir, p.field, 'image'); if (!fr.ok) return fr; src = fr.field.src; }
      if (!src || !p.file) return err('bad-request', 'edit image needs --field <id> or --src <current src>, and --file <image path>.');
      const file = path.isAbsolute(p.file) ? p.file : path.resolve(ctx.cwd, p.file);
      if (!api.fileExists(file)) return err('not-found', `No file at ${file}.`);
      return moduleResult(r.dir, await api.editImage(r.dir, { src, file }), { notFound: `No image with src ${src} in the site's source.` });
    },
    async metaSet(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      if (!p.tag || p.value == null) return err('bad-request', 'meta set needs <tag> and "<value>".');
      if (!META_TAGS.includes(p.tag as MetaTag)) return err('bad-request', `Unknown tag ${p.tag}. One of: ${META_TAGS.join(', ')}.`);
      return moduleResult(r.dir, await api.metaSet(r.dir, { tag: p.tag as MetaTag, value: p.value, route: p.route || null, file: p.file || null }), { notFound: `No ${p.tag} tag in the site's head; it may come from a layout or framework config.`, ambiguous: `${p.tag} is set in several files; pin it with --route or --file.` });
    },
    async commentAdd(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      if (!p.text) return err('bad-request', 'comments add needs --text "<text>".');
      return moduleResult(r.dir, await api.commentAdd(r.dir, { text: p.text, route: p.route || '/', selector: p.selector || '' }));
    },
    async commentResolve(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      if (!p.id) return err('bad-request', 'comments resolve needs the comment id (radial comments lists them).');
      return moduleResult(r.dir, await api.commentResolve(r.dir, p.id), { notFound: `No comment ${p.id}.` });
    },
    async commentsPull(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      const res = await api.commentsPull(r.dir);
      if (!res || !res.ok) return { ok: false, code: 'error', error: (res && res.error) || 'Could not pull Vercel comments.', reason: res && res.code };
      return { ok: true, repoDir: r.dir, ...(res as Success<VercelPullResult>) };
    },
    async sync(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      if (p.strategy && !['ff', 'merge', 'rebase'].includes(p.strategy)) return err('bad-request', '--strategy must be ff, merge, or rebase.');
      return moduleResult(r.dir, await api.sync(r.dir, { strategy: p.strategy as SyncRequest['strategy'], target: p.branch })); // strategy: checked above
    },
    async publish(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      const to = p.to || 'staging';
      if (!['branch', 'staging', 'production'].includes(to)) return err('bad-request', '--to must be branch, staging, or production.');
      if (to === 'production' && !p.yes) return err('needs-yes', 'Pushing to the configured production branch may trigger deployment or open a pull request. Pass --yes to confirm.', { repoDir: r.dir });
      if (!p.yes) { // any publish that lands on the production branch goes live, whatever --to named it (the current branch, while it is production)
        const dest = await api.publishDestination(r.dir, to as PublishTarget).catch(() => null); // to: checked above
        if (dest && dest.production) return err('needs-yes', `${dest.branch} is this project's production branch, so this publish may trigger deployment or open a pull request. Pass --yes to confirm.`, { repoDir: r.dir });
      }
      if (p.scope && !['all', 'staged'].includes(p.scope)) return err('bad-request', '--scope must be all or staged.');
      const res = await api.publish(r.dir, { to: to as PublishTarget, message: p.message || null, gate: p.gate !== false, scope: (p.scope || 'all') as PublishRequest['scope'], pr: !!p.pr, commit: p.commit !== false }, ctx.progress); // to and scope: checked above
      const out = moduleResult(r.dir, res);
      return out.ok ? { ...out, target: to as PublishTarget } : out; // to: checked above
    },
    async moments(p, ctx) { const r = await target(p, ctx); if (!r.ok) return r; return moduleResult(r.dir, await api.momentsList(r.dir)); },
    async momentRecord(p, ctx) { const r = await target(p, ctx); if (!r.ok) return r; return moduleResult(r.dir, await api.momentRecord(r.dir, p.label || null)); },
    async momentRestore(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      if (!p.id) return err('bad-request', 'moments restore needs the moment id (radial moments lists them).');
      if (!p.yes) return err('needs-yes', 'Restoring rewrites the working tree (the current state is recorded first). Pass --yes to confirm.', { repoDir: r.dir });
      return moduleResult(r.dir, await api.momentRestore(r.dir, p.id), { notFound: `No moment ${p.id}.` });
    },

    // ── design tokens: read from authored stylesheets, written in place ──
    async tokens(p, ctx) { const r = await target(p, ctx); if (!r.ok) return r; return moduleResult(r.dir, await api.tokens(r.dir)); },
    async tokenSet(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      if (!p.name || p.value == null) return err('bad-request', 'tokens set needs the token name and a value: radial tokens set <project> --brand "#8665f6".');
      const res = await api.tokenSet(r.dir, { name: String(p.name), value: String(p.value), mode: p.mode || null });
      if (res && !res.ok && res.reason === 'ambiguous') return err('ambiguous', res.message, { repoDir: r.dir, reason: 'ambiguous', pick: false, candidates: (res.candidates || []).map((c) => ({ name: `${c.mode} (${c.relFile}:${c.line})`, path: c.relFile, mode: c.mode, value: c.value })) });
      return moduleResult(r.dir, res, { notFound: `${p.name} is not defined in the project's stylesheets.` });
    },

    // ── context contributions + undo: what an agent learned goes back into the site ──
    async contextAdd(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      if (!p.name && !p.file) return err('bad-request', 'context add needs a name: radial context add <project> <name> --text "…" (or --file <path>).');
      if (p.text == null && !p.file) return err('bad-request', 'context add needs --text "<markdown>" or --file <path>.');
      let file = null;
      if (p.file) { file = path.isAbsolute(p.file) ? p.file : path.resolve(ctx.cwd, p.file); if (!api.fileExists(file)) return err('not-found', `No file at ${file}.`); }
      return moduleResult(r.dir, await api.contextAdd(r.dir, { name: p.name || null, text: p.text == null ? null : String(p.text), file, replace: !!p.replace }));
    },
    async refAdd(p, ctx) { const r = await target(p, ctx); if (!r.ok) return r; if (!p.url) return err('bad-request', 'refs add needs a URL.'); return moduleResult(r.dir, await api.refAdd(r.dir, String(p.url))); },
    async refRemove(p, ctx) { const r = await target(p, ctx); if (!r.ok) return r; if (!p.url) return err('bad-request', 'refs remove needs a URL.'); return moduleResult(r.dir, await api.refRemove(r.dir, String(p.url)), { notFound: `${p.url} is not attached.` }); },
    async ruleAdd(p, ctx) { const r = await target(p, ctx); if (!r.ok) return r; if (!p.text || !String(p.text).trim()) return err('bad-request', 'rules add needs the rule text.'); return moduleResult(r.dir, await api.ruleAdd(r.dir, String(p.text))); },
    async undo(p, ctx) { const r = await target(p, ctx); if (!r.ok) return r; return moduleResult(r.dir, await api.undo(r.dir)); },
    async redo(p, ctx) { const r = await target(p, ctx); if (!r.ok) return r; return moduleResult(r.dir, await api.redo(r.dir)); },

    // ── site migration (plans/site-migration.md): one engine for the CLI, MCP and the Home wizard ──
    async migrateStart(p, ctx) {
      const url = String(p.url || '').trim();
      if (!url) return err('bad-request', 'migrate start needs the site: radial migrate start <url> --framework astro|next');
      if (!['astro', 'next'].includes(p.framework as MigrateFramework)) return err('bad-request', 'Say which framework: --framework astro or --framework next. Ask the person if they have not chosen.');
      if (p.engine && !ENGINES.includes(p.engine as Engine)) return err('bad-request', `--engine must be one of ${ENGINES.join(', ')}.`);
      const files = ([] as string[]).concat(p.files || []).map((f) => path.resolve(ctx.cwd || process.cwd(), String(f)));
      const only = ([] as string[]).concat(p.only || []).map(String).filter(Boolean);
      const prep = await api.migratePrepare({ url, framework: p.framework as MigrateFramework, name: p.name || null, dir: p.dir || null, files, engine: (p.engine || null) as Engine | null, only }, ctx.progress); // framework and engine: checked above
      if (!prep.ok) return prep.code ? prep : err('error', prep.error || 'Could not start the migration.');
      const opened = await openDir(prep.dir, { wait: true, timeoutMs: p.timeoutMs });
      if (!opened.ok) return opened;
      const launched = await api.migrateLaunch(prep);
      if (!launched.ok) return launched.code ? launched : err('error', launched.error || 'The migration agent did not start.');
      return { ok: true, repoDir: prep.dir, name: prep.name, framework: prep.frameworkLabel, source: prep.source, platform: prep.platform, scope: only.length ? only : null, pages: prep.pages, assets: prep.assets, capture: prep.capture, engine: launched.engine, session: launched.session, url: opened.url || null };
    },
    async migrateCapture(p, ctx) {
      const url = String(p.url || '').trim();
      if (!url) return err('bad-request', 'migrate capture needs the site: radial migrate capture <url> [--project <project>]');
      const r = await target(p, ctx); if (!r.ok) return r;
      const res = await api.migrateCapture(r.dir, url, ctx.progress, { only: ([] as string[]).concat(p.only || []).map(String).filter(Boolean) });
      return res.ok ? { ok: true, repoDir: r.dir, ...(res as Success<CaptureSummary>) } : (res.code ? res : err('error', res.error || 'Capture failed.'));
    },
    async migrateCompare(p, ctx) {
      const r = await target(p, ctx); if (!r.ok) return r;
      if (api.info().browser === false) return noBrowser('compare', r.dir);
      if (!api.isOpen(r.dir)) return err('not-open', 'Open the project first so its preview runs: radial open <project>.');
      const res = await api.migrateCompare(r.dir, { routes: ([] as string[]).concat(p.routes || []).filter(Boolean), widths: p.widths || null }, ctx.progress);
      return res.ok ? { ok: true, repoDir: r.dir, ...(res as Success<CompareSummary>) } : (res.code ? res : err('error', res.error || 'Compare failed.'));
    },

    // ── agent lane: real, visible sessions in the app's terminals ──
    async agentStart(p, ctx) {
      if (!p.task || !String(p.task).trim()) return err('bad-request', 'agent start needs the task: radial agent start <project> "<task>".');
      if (p.engine && !ENGINES.includes(p.engine as Engine)) return err('bad-request', `--engine must be one of ${ENGINES.join(', ')}.`);
      const r = await target(p, ctx); if (!r.ok) return r;
      if (!api.isOpen(r.dir)) { // the session lives in the project's terminal: open it first
        const o = await openDir(r.dir, { wait: true, timeoutMs: p.timeoutMs });
        if (!o.ok) return o;
      }
      const res = await api.agentStart(r.dir, { task: String(p.task), submit: !!p.submit, engine: (p.engine || null) as Engine | null, label: p.label || null }); // engine: checked above
      return res.ok ? { ok: true, repoDir: r.dir, ...(res as Success<CliResult<'agent'>>) } : (res.code ? res : err('error', res.error || 'Could not start the session.'));
    },
    async agentSend(p) {
      if (!p.id) return err('bad-request', 'agent send needs the session id (radial agent list).');
      if (!p.text || !String(p.text).trim()) return err('bad-request', 'agent send needs the text: radial agent send <id> "<text>".');
      const res = await api.agentSend(p.id, { text: String(p.text), submit: p.submit !== false });
      return res.ok ? { ok: true, ...(res as Success<CliResult<'agentSend'>>) } : (res.code ? res : err('error', res.error || 'Could not send.'));
    },
    async home(p) {
      if (p.engine && !(HOME_ENGINES as readonly string[]).includes(p.engine)) return err('bad-request', `--engine must be one of ${HOME_ENGINES.join(', ')}.`);
      const res = await api.home({ engine: (p.engine || null) as HomeEngine | null }); // checked above
      return res.ok ? { ok: true, ...(res as Success<CliResult<'home'>>) } : (res.code ? res : err('error', res.error || 'Could not start the Home agent.'));
    },
    async agentOutput(p) {
      if (!p.id) return err('bad-request', 'agent output needs the session id (radial agent list).');
      const res = await api.agentOutput(p.id, { lines: p.lines ? Number(p.lines) : null });
      return res.ok ? res : (res.code ? res : err('error', res.error || 'No output.'));
    },
    async agentWait(p) {
      if (!p.id) return err('bad-request', 'agent wait needs the session id (radial agent list).');
      const waitMs = Math.max(1000, Math.min(AGENT_WAIT_MAX_MS, Number(p.waitMs) || 120000));
      const res = await api.agentWait(p.id, { waitMs, since: p.since ? Number(p.since) : null, idleMs: AGENT_IDLE_MS });
      return res.ok ? res : (res.code ? res : err('error', res.error || 'Wait failed.'));
    },
    async agentQuestion(p) {
      if (!p.id) return err('bad-request', 'agent question needs the session id (radial agent list).');
      const res = await api.agentQuestion(p.id);
      return res.ok ? res : (res.code ? res : err('error', res.error || 'Could not read the session.'));
    },
    // A CLI's own question answered as a person would at its terminal (src/core/questions.ts): the core answers
    // only with the yes and the id of the question the answer is for, and without them says what it would do.
    // The caller waits this long, and nothing is typed after: its timeout, less a margin for the reply.
    async agentAnswer(p) {
      if (!p.id) return err('bad-request', 'agent answer needs the session id (radial agent list).');
      const given = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
      const answer = given(p.answer) != null && String(p.answer).trim() ? String(p.answer) : null, text = given(p.text), expect = given(p.expect);
      if (answer != null && text != null) return err('bad-request', 'Answer with one of its options (its number or its label) or with --text, not both.');
      if (text != null && !text.trim()) return err('bad-request', '--text needs the text to type.');
      const deadline = Date.now() + Math.max(1000, Math.min(Number(p.timeoutMs) || 60000, 600000) - 5000);
      const res = await api.agentAnswer(p.id, { answer, text, expect, yes: !!p.yes, deadline });
      return res.ok ? res : (res.code ? res : err('error', res.error || 'Could not answer.'));
    },
    async agentList(p, ctx) {
      let dir = null;
      if (p.target) { const r = await target(p, ctx); if (!r.ok) return r; dir = r.dir; }
      return { ok: true, ...(dir ? { repoDir: dir } : {}), agents: await api.agentList(dir) };
    },
    async agentKill(p) {
      if (!p.id) return err('bad-request', 'agent kill needs the session id (radial agent list).');
      if (!p.yes) return err('needs-yes', `Ending ${p.id} stops that session for good. Pass --yes to confirm.`);
      const res = await api.agentKill(p.id);
      return res.ok ? { ok: true, id: p.id } : (res.code ? res : err('error', res.error || 'Could not end the session.'));
    },
    async agentKeep(p) {
      if (!p.id) return err('bad-request', 'agent keep needs the session id (radial agent list).');
      const res = await api.agentKeep(p.id, { on: !p.off });
      return res.ok ? { ok: true, ...(res as Success<KeepAwakeResult>) } : (res.code ? res : err('error', res.error || 'Could not change that session.'));
    },
  };

  /** One request's op, run with its context: its reply, an unknown op's refusal, or what it threw as an error. */
  async function run(msg: OpRequest, ctx: OpContext): Promise<Reply> {
    const op = Object.hasOwn(ops, msg.op) ? (ops as Partial<Record<string, Op>>)[msg.op] : undefined; // own ops only: a name only Object.prototype has (constructor, toString) is unknown too
    if (!op) return err('bad-request', `Unknown command: ${msg.op}`);
    try { if (ctx.http) api.telemetry(msg.op, { http: true }); else api.telemetry(msg.op); } catch {}
    try { return await op(msg, ctx); }
    catch (e) { return err('error', ((e as Error) && (e as Error).message) || String(e)); }
  }
  async function handle(msg: OpRequest, write: (frame: ServerFrame) => void): Promise<void> {
    const reqId = msg.reqId;
    const ctx: OpContext = { cwd: msg.cwd || process.cwd(), tty: !!msg.tty, progress: (text) => write({ op: 'progress', reqId, text: String(text) }) };
    write({ op: 'reply', reqId, ...(await run(msg, ctx)) });
  }
  // The HTTP listener's way in: the caller it vouches for comes in via, never in the request itself.
  function dispatch(msg: OpRequest, { progress = () => {}, http = null }: DispatchVia = {}): Promise<Reply> {
    return run(msg, { cwd: msg.cwd || process.cwd(), tty: !!msg.tty, progress: (text) => progress(String(text)), http });
  }

  // ── the socket ──
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    const write = (m: ServerFrame) => { try { sock.write(encode(m)); } catch {} };
    sock.on('data', makeDecoder((m) => handle(m as OpRequest, write))); // a frame the app's own client wrote (OpRequest says what goes unchecked)
    sock.on('error', () => {});
  });
  let owned = false; // listening on socketPath, so stopping removes the file
  let stopped = false;
  let settle: (claim: SocketClaim) => void = () => {};
  const ready = new Promise<SocketClaim>((resolve) => { settle = resolve; });
  server.on('error', (e) => {
    log(`[cli] server error: ${e.message}`);
    if (!owned) settle({ ok: false, code: 'error', error: e.message });
  });
  function listen(): void {
    if (stopped) return;
    server.listen(socketPath, () => {
      owned = true;
      try { fs.chmodSync(socketPath, 0o700); } catch {}
      log(`[cli] control socket at ${socketPath}`);
      settle({ ok: true });
    });
  }
  // A socket file left by an app that died refuses connections; a live one
  // answers. Only a dead one is replaced: a second process on the same data dir
  // leaves a running app's socket alone instead of silently taking it over.
  if (!fs.existsSync(socketPath)) listen();
  else {
    probeSocket(socketPath).then((found) => {
      if (found === 'dead') { try { fs.unlinkSync(socketPath); } catch {} listen(); return; }
      if (stopped) return;
      const claim: SocketClaim = found === 'live'
        ? { ok: false, code: 'in-use', error: `Another Radial is already listening on ${socketPath}.` }
        : { ok: false, code: 'error', error: `Could not tell whether ${socketPath} is in use (${found.code || found.message}).` };
      log(`[cli] ${claim.error} It stays as it is, and this one runs without a control socket.`);
      settle(claim);
    });
  }

  function stop() {
    stopped = true;
    try { server.close(); } catch {}
    if (owned) { try { fs.unlinkSync(socketPath); } catch {} } // never a socket this server found live: that one belongs to another process
    settle({ ok: false, code: 'error', error: 'The server stopped before it listened.' }); // does nothing once ready has settled
    for (const [, list] of waiters) for (const w of list) { clearTimeout(w.timer); w.resolve(err('error', 'The app is quitting.')); }
    waiters.clear();
  }

  return { stop, settleOpen, waitForOpen, socketPath, ready, dispatch, _ops: ops };
}

export { start, moduleResult, OPEN_WAIT_MS, AGENT_IDLE_MS, AGENT_WAIT_MAX_MS };
