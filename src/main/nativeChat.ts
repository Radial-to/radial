// Experimental local CLI transport. No provider SDK, hosted API, or API key.
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import * as taskTitle from '../renderer/taskTitle';
import { spawn } from 'child_process';
import readline from 'readline';
import http from 'http';
import os from 'os';
import WebSocket from 'ws';
import type { ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import { providerTransport, LABELS } from './chat/providers';
import type { ProviderInputPart, ProviderOptions, ProviderResults, RequestId } from './chat/providers';
import { InteractiveTransport, terminalReply } from './chat/interactive';
import type { InteractiveOptions, InteractiveResults, InteractiveTerminal } from './chat/interactive';
import * as permissions from '../shared/chatPermissions';
import type { ChatEngine, CodexPermissions, CodexSandboxPolicy, PermissionMode } from '../shared/chatPermissions';
import { ChatResources } from './chat/resources';
import { childEnv, which } from './env';
import { cliSocket } from './dataDirs';
import type { PtyInfo } from './terminal';
import type { ChatApproval, ChatApprovalMethod, ChatApprovalParams, ChatEvent, ChatFile, ChatMessage, ChatModel, ChatResponse, ChatSession, ChatState, ChatSummary, ChatUpdate, ChatView } from '../shared/radialApi';

// ── Conversation items (Codex app-server's ThreadItem shape), as itemMessage renders them ──
/** A file a file change touched, and its diff (a ChatMessage's changes). */
type NativeChatItemChange = NonNullable<ChatMessage['changes']>[number];
/** A part of a user message: its text, or an attached image's path or url. */
export interface NativeChatItemContent { type: string; text?: string; path?: string; url?: string }
/**
 * A conversation item in Codex app-server's shape (ThreadItem): what itemMessage
 * turns into a ChatMessage. Codex sends it as JSON (trusted as the CLI sends it);
 * the provider and native-terminal transports build the same shape (ProviderItem,
 * InteractiveItem). Fields beyond id and type belong to some types only. It stays
 * in the main process: the window gets the ChatMessage.
 */
export interface NativeChatItem {
  id: string;
  /** userMessage, agentMessage, commandExecution, fileChange, mcpToolCall, webSearch, plan, reasoning, contextCompaction, or another the CLI adds (shown as generic activity). */
  type: string;
  /** userMessage: its text and attachments. */
  content?: readonly NativeChatItemContent[];
  /** agentMessage, plan: the text. */
  text?: string;
  /** commandExecution: the command and its output so far, which Codex may send as null. */
  command?: string;
  aggregatedOutput?: string | null;
  /** fileChange: each file and its diff. */
  changes?: NativeChatItemChange[];
  /** mcpToolCall: the tool, its server (the providers put the tool's input there), and its result or error. */
  tool?: string;
  server?: string;
  result?: unknown;
  error?: unknown;
  /** webSearch: the query. */
  query?: string;
  /** inProgress, completed, failed, or the CLI's own status. */
  status?: string;
}
/** No item: an event without one passes {} to itemMessage, which returns null for it. */
type NoItem = { id?: undefined; type?: undefined };
/** An item and the turn it belongs to (thread/items/list's entries); null or unset between turns. */
export interface NativeChatItemEntry { item: NativeChatItem; turnId?: string | null }
/** The rendered tool output capDetail trims: a ChatMessage's detail. */
type DetailMessage = Pick<ChatMessage, 'detail'>;

// ── Codex app-server (JSON-RPC over `codex app-server --stdio`), as Radial reads it ──
/** A request's params as Radial sends them (Codex app-server's): an open object, with the conversation's id when it's about one. Every transport takes this shape. */
export type CodexParams = { threadId?: string | null; [field: string]: unknown };
/** Codex's named approval policies (config approval_policy, a thread's approvalPolicy). */
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
/** A structured approval policy from newer Codex configs: Radial leaves it to the CLI. */
type CodexStructuredPolicy = Record<string, unknown>;
/**
 * What a Codex chat sends for its permissions (codexPermissions): one of Radial's
 * presets (CodexPermissions), or the user's own Codex settings, whose approval
 * policy may be one of Codex's others, or none when it's structured.
 */
export interface CodexPolicy { sandbox: CodexPermissions['sandbox']; approvalPolicy: CodexApprovalPolicy | undefined; sandboxPolicy: CodexSandboxPolicy }
/**
 * The permission settings of a Codex config layer or profile (config.toml), as
 * config/read reports them: null where the config sets nothing (codex-cli 0.160.1
 * sends every unset field as null). codexConfigPermissions reads null as unset.
 */
interface CodexPermissionConfig {
  approval_policy?: CodexApprovalPolicy | CodexStructuredPolicy | null;
  sandbox_mode?: CodexPermissions['sandbox'] | null;
  sandbox_workspace_write?: { writable_roots?: string[]; network_access?: boolean; exclude_slash_tmp?: boolean; exclude_tmpdir_env_var?: boolean } | null;
}
/** config/read's answer: the user's effective Codex config, with its active profile (null when none is) and the profiles. */
export interface CodexConfigRead { config?: CodexPermissionConfig & { profile?: string | null; profiles?: Record<string, CodexPermissionConfig> } }
/** model/list's answer: a page of the CLI's models. */
export interface NativeChatModelPage { data?: ChatModel[]; nextCursor?: string | null }
/** A Codex conversation (thread/read's thread): its id, its rollout file, and its turns when asked for them. */
export interface CodexThread { id: string; path?: string | null; turns?: { id: string; items?: NativeChatItem[] }[] }
/**
 * thread/start and thread/resume's answer from Codex: the thread and the model it
 * runs. Codex may send a null reasoningEffort (codex-cli 0.160.1). The type leaves
 * null out only because connect copies it into ChatSummary.resolvedEffort, which
 * radialApi.ts types without null; both should say string | null.
 */
export interface CodexThreadStarted { thread: CodexThread; model?: string; reasoningEffort?: string; modelProvider?: string }
/** A page of a conversation's history (thread/items/list). */
export interface NativeChatHistoryPage { data: NativeChatItemEntry[]; nextCursor?: string | null }
/** request()'s answer from Codex, by method (its JSON, trusted as the CLI sends it). Any other method answers unknown. */
export interface CodexResults {
  /** Kept as it is, for the terminal view's own initialize. */
  'initialize': unknown;
  'config/read': CodexConfigRead;
  'model/list': NativeChatModelPage;
  'thread/start': CodexThreadStarted;
  'thread/resume': CodexThreadStarted;
  'thread/read': { thread: CodexThread };
  'thread/items/list': NativeChatHistoryPage;
  'turn/start': NativeChatTurnStarted;
  'turn/interrupt': Record<string, never>;
}
/** Codex's thread status (thread/status/changed). */
interface CodexThreadStatus { type: string }
/** Settings changed in the terminal view (thread/settings/updated); Codex may send a null effort. */
interface CodexThreadSettings {
  model?: string;
  effort?: string | null;
  approvalPolicy?: CodexApprovalPolicy | CodexStructuredPolicy;
  sandboxPolicy?: { type: string; networkAccess?: boolean; writableRoots?: string[] };
  modelProvider?: string;
}
/**
 * An event's params, as event() reads them: one bag for every method, since
 * event() takes params apart before it looks at the method. Each field comes
 * with the methods noted; the provider and native-terminal transports send the
 * same shapes (ProviderEvent, InteractiveEvent).
 */
export interface NativeChatEventParams {
  /** The conversation it's about: an event for another thread is dropped. */
  threadId?: string | null;
  /** native/state: the native CLI's state. thread/status/changed: Codex's thread status. */
  status?: Exclude<ChatState, 'error'> | CodexThreadStatus;
  /** thread/started: the thread the terminal view created. */
  thread?: { id: string };
  /** item/agentMessage/delta, item/commandExecution/outputDelta: the item the text adds to, and the text. */
  itemId?: string;
  delta?: string;
  /** item/*, turn/plan/updated: the turn it belongs to. */
  turnId?: string | null;
  /** item/started, item/completed */
  item?: NativeChatItem;
  /** turn/started, turn/completed: the turn, how it ended and why it failed. */
  turn?: { id?: string | null; status?: string; error?: { message?: string } | null };
  /** turn/plan/updated */
  explanation?: string | null;
  plan?: { step: string; status: string }[];
  /** thread/tokenUsage/updated: the CLI's token report, kept as it is. */
  tokenUsage?: unknown;
  /** serverRequest/resolved: the request the CLI no longer waits on. */
  requestId?: RequestId;
  /** thread/settings/updated */
  threadSettings?: CodexThreadSettings;
  /** transport/error's message, or native/input's new notice. */
  message?: string;
  /** error */
  error?: { message?: string };
}
/** An event from a chat's transport (onEvent), in Codex app-server's notification shape: Codex's own, a ProviderEvent or an InteractiveEvent. Methods event() doesn't know are ignored. */
export interface NativeChatEvent { method: string; params?: NativeChatEventParams }
/** A decision Codex offers for a command: a name ('accept', 'decline'…), which has no amendment, or an object: the one that also saves an exec-policy rule, which Radial reads, or another (codex-cli 0.160.1 also offers applyNetworkPolicyAmendment). */
type CodexDecision = (string & { acceptWithExecpolicyAmendment?: undefined }) | { acceptWithExecpolicyAmendment?: { execpolicy_amendment?: string[] } };
/** A CLI request's params (kept as the approval's params), with the decisions Codex offers for a command and the rule it proposes, either of which Codex may send as null. */
export type NativeChatApprovalParams = ChatApprovalParams & { availableDecisions?: CodexDecision[] | null; proposedExecpolicyAmendment?: string[] | null };
/** A request from a chat's CLI for Radial to answer (onRequest): Codex's server requests, or a ProviderRequest. Only approvals and questions are supported (requestFromCli). */
export interface NativeChatRequest { id: RequestId; method: string; params: NativeChatApprovalParams }
/** An approval's decision: one of ChatResponse's, or Codex's rule-saving one. */
export type NativeChatDecision = NonNullable<ChatResponse['decision']> | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } };
/** Radial's answer to a NativeChatRequest (a JSON-RPC response): the decision or each question's answers by id, or an error. Radial always sends answers; they're optional for ProviderReply's sake. */
export interface NativeChatReply {
  id: RequestId;
  result?: { decision?: NativeChatDecision; answers?: Record<string, { answers?: string[] }> };
  error?: { code: number; message: string };
}
/** A request or notification from the Codex TUI over the shared socket. */
export interface CodexClientRequest { id?: RequestId; method: string; params?: CodexParams }
/** The TUI's answer to a request the CLI sent it, passed on to the CLI. */
interface CodexClientReply { id?: RequestId; method?: undefined; result?: unknown; error?: unknown }
/** A message from the Codex TUI over the shared socket. */
type CodexClientMessage = CodexClientRequest | CodexClientReply;
/** A message for the CLI's stdin, or for a TUI client: a request, a notification or an answer. */
type CodexOutgoing = { id?: RequestId; method?: string; params?: CodexParams; result?: unknown; error?: unknown };
/** A line from `codex app-server` (trusted as the CLI sends it): a notification, a request for Radial to answer, or the answer to one of Radial's (by its numeric id). */
type CodexLine =
  | (NativeChatEvent & { id?: undefined; result?: undefined; error?: undefined })
  | (NativeChatRequest & { result?: undefined; error?: undefined })
  | { id: number; method?: undefined; params?: undefined; result?: unknown; error?: { message?: string } | null };
/** A request() waiting for its answer. */
interface CodexPending { resolve(result: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
/** Rewrites a terminal request's params before they reach the CLI (nativeChat sets the chat's model and permissions). */
export type CodexTerminalParams = (method: string, params: CodexParams | undefined) => CodexParams | undefined;
/** A client of the shared terminal socket, marked initialized once it says so. */
type CodexTerminalClient = WebSocket & { initialized?: boolean };
/** What CodexTransport is started with. nativeChat passes the same options as to its other transports; this one ignores the rest. */
export interface CodexTransportOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv | null;
  onEvent: (event: NativeChatEvent) => void;
  onRequest: (request: NativeChatRequest) => void;
  /** Also serve the CLI's connection to its own terminal view, on a unix socket (endpoint). */
  shared?: boolean;
  canTerminalReply?: () => boolean;
  allowTerminalRequest?: (request: CodexClientRequest) => boolean;
  terminalParams?: CodexTerminalParams;
  /** The codex binary; left out (or unset) finds it on PATH. */
  bin?: string | null;
}

// ── NativeChat's transports ──
/** RADIAL_CLI_SOCK: this profile's control socket, for the `radial` commands the CLIs run. */
export type NativeChatEnv = { RADIAL_CLI_SOCK: string };
/**
 * The PTY daemon's client as NativeChat uses it: terminal.ts itself, which the
 * main process passes. A Codex chat's terminal view starts, lists and kills
 * terminals, and a native terminal transport gets the same client
 * (InteractiveTerminal), which also writes to them. The tests' stand-ins are
 * partial; they're untyped for now.
 */
export type NativeChatTerminal = InteractiveTerminal;
/**
 * thread/start and thread/resume's answer from every transport: the thread (a
 * native terminal's is the session's, null until the CLI has one) and the model it
 * runs. Codex's reasoningEffort may be null (see CodexThreadStarted).
 */
export interface NativeChatThreadStarted { thread: { id: string | null | undefined }; model?: string; modelName?: string; reasoningEffort?: string; modelProvider?: string }
/** turn/start's answer from every transport: the turn it started. */
export interface NativeChatTurnStarted { turn: { id: string } }
/** A part of a prompt as Radial sends it (turn/start's input): a provider transport's (ProviderInputPart), whose text part also carries Codex's text_elements, which Radial leaves empty. */
export type NativeChatInput = (Extract<ProviderInputPart, { type: 'text' }> & { text_elements: never[] }) | Exclude<ProviderInputPart, { type: 'text' }>;
/**
 * A chat's connection to its CLI: CodexTransport, a provider transport
 * (ClaudeTransport, CursorTransport) or a native terminal (InteractiveTransport).
 * The optional members belong to some of them only. request()'s typed answers
 * are each transport's own (CheckedAnswers below checks them).
 */
export interface NativeChatTransport {
  initialize(): Promise<void>;
  request(method: 'thread/start' | 'thread/resume', params: CodexParams): Promise<NativeChatThreadStarted>;
  request(method: 'thread/items/list', params: CodexParams): Promise<NativeChatHistoryPage>;
  /** turn/start carries the prompt, which every transport reads; without one, the call falls to the catch-all below. */
  request(method: 'turn/start', params: CodexParams & { input: NativeChatInput[] }): Promise<NativeChatTurnStarted>;
  /** Any other method: its answer as the CLI sends it, or a rejection when the transport doesn't know it. */
  request(method: string, params?: CodexParams): Promise<unknown>;
  /** Answers a request (onRequest). A native terminal has none: its CLI asks in the terminal. */
  write?(message: NativeChatReply): void;
  close(): void;
  /** Closes the CLI and waits for it to exit (provider transports); a native terminal refuses. Codex has none. */
  shutdown?(): Promise<void>;
  /** Set by connect: settles once the transport is initialized and its thread started or resumed. */
  connected?: Promise<void>;
  /** Set on a native terminal (InteractiveTransport). */
  nativeTerminal?: boolean;
  bin: string;
  startedAt: number;
  child?: { readonly pid?: number };
  /** Codex's shared socket, for its terminal view. */
  endpoint?: string;
  /** Set by connect on a Codex chat: the permissions of the user's own Codex settings. */
  inherited?: CodexPolicy;
  threadId?: string | null;
  turnId?: string | null;
  /** A native terminal's items so far. */
  items?: ReadonlyMap<string, NativeChatItemEntry>;
  /** A native terminal's prompt waiting for delivery into the terminal. */
  pendingPrompt?: { delivering?: boolean } | null;
  /** A native terminal's view of the PTY: input typed there, its output and its size. */
  noteInput?(data: string): void;
  data?(data: string): void;
  resize?(cols: number, rows: number): void;
}
/** Answer must fit Expected: a compile-time check. */
type Fits<Answer extends Expected, Expected> = Answer;
/**
 * Every transport's answers fit NativeChatTransport's typed request() overloads.
 * TypeScript erases the transports' generic overloads when it relates them to
 * these, so it can't check this from the classes themselves.
 */
type CheckedAnswers = [
  Fits<ProviderResults['thread/start' | 'thread/resume'] | InteractiveResults['thread/start' | 'thread/resume'] | CodexResults['thread/start' | 'thread/resume'], NativeChatThreadStarted>,
  Fits<ProviderResults['thread/items/list'] | InteractiveResults['thread/items/list'] | CodexResults['thread/items/list'], NativeChatHistoryPage>,
  Fits<ProviderResults['turn/start'] | InteractiveResults['turn/start'] | CodexResults['turn/start'], NativeChatTurnStarted>,
];
/** What a transport is started with. Catalog discovery (models) passes only the first five. */
export interface NativeChatTransportOptions {
  engine: ChatEngine;
  cwd: string;
  env: NativeChatEnv;
  onEvent: (event: NativeChatEvent) => void;
  onRequest: (request: NativeChatRequest) => void;
  session?: ChatSession;
  terminal?: NativeChatTerminal;
  /** Where a native terminal keeps each chat's hook journal and settings. */
  runtimeRoot?: string;
  /** Radial's project context for the CLI. */
  contextText?: string;
  /** Codex: also serve its terminal view (endpoint). */
  shared?: boolean;
  terminalParams?: CodexTerminalParams;
  canTerminalReply?: () => boolean;
  allowTerminalRequest?: (request: CodexClientRequest) => boolean;
}
/** Makes a chat's transport; the tests pass their own. */
export type NativeChatTransportFactory = (options: NativeChatTransportOptions) => NativeChatTransport;
/** What the main process starts NativeChat with. */
export interface NativeChatOptions {
  /** The chat store: native-chats.json, the old single file, beside the native-chats/ folder that replaced it. */
  file: string;
  /** Radial's context for a project (or Home) agent. */
  context: (repoDir: string, home: boolean) => string;
  /** Sends each chat change to the window (nativeChat:event). */
  emit: (event: ChatEvent) => void;
  terminal?: NativeChatTerminal;
  transport?: NativeChatTransportFactory;
}
/** parkIdle's options: how long a chat's terminal must be quiet to be parked, the chats on screen, the one project to sweep (every one when unset), and the time now. */
export interface ParkOptions { idleMs: number; visible?: string[]; repoDir?: string | null; now?: number }
/** A model catalog being read (models), shared for a minute. */
interface CatalogEntry { at: number; promise: Promise<ChatModel[]> }
/** A line of a Codex rollout file (the CLI's own transcript): readRollout reads the session's id and its completed items. */
interface RolloutRecord { type?: string; payload?: { id?: string; session_id?: string; type?: string; turn_id?: string; item?: RolloutItem } }
/** A completed item as the rollout saves it: PascalCase type and status, snake_case command output, and a file change's changes keyed by path. */
interface RolloutItem extends Omit<NativeChatItem, 'changes'> {
  aggregated_output?: string;
  changes?: NativeChatItemChange[] | Record<string, { unified_diff?: string; content?: string }>;
}
/** A file attached to a message as the window sends it (nativeChatSend, nativeChatQueue): one it attached earlier, by path. radialApi.ts writes this shape inline in both. */
type NativeChatAttachmentRef = Pick<ChatFile, 'path'>;
/** thread/start and thread/resume's params as connect sends them. */
type ThreadOptions = { cwd: string; approvalPolicy?: CodexApprovalPolicy; sandbox?: CodexPermissions['sandbox']; approvalsReviewer: 'user'; developerInstructions: string; model?: string };
/** What acceptsPendingFullAccess reads: a CLI request, or an approval still waiting (ChatApproval), whose params are the request's. */
type ApprovalRequest = { method: string; params?: NativeChatApprovalParams };

class CodexTransport {
  declare startedAt: number;
  declare bin: string;
  declare clients: Set<CodexTerminalClient>;
  declare canTerminalReply: () => boolean;
  declare allowTerminalRequest: (request: CodexClientRequest) => boolean;
  declare terminalParams: CodexTerminalParams;
  /** Radial's requests by id (seq); a line's answer is looked up by the id it carries, which a malformed line may lack. */
  declare pending: Map<RequestId | undefined, CodexPending>;
  declare seq: number;
  declare stderr: string;
  /** Shared only: the socket's private folder and path, and the endpoint the terminal view connects to. */
  declare socketDir?: string;
  declare socketPath?: string;
  declare endpoint?: string;
  declare child: ChildProcessByStdio<Writable, Readable, Readable>;
  declare lines: readline.Interface;
  /** Shared only: settles once the socket listens. */
  declare ready?: Promise<void>;
  declare fail: (error: Error) => void;
  declare closing?: boolean;
  declare server?: http.Server;
  declare webSockets?: WebSocket.Server;
  /** Codex's initialize answer, given to each terminal view's initialize. */
  declare initializationResult?: unknown;
  /** Set by nativeChat.connect: settles once the CLI is initialized and its thread started or resumed. */
  declare connected?: Promise<void>;
  /** Set by nativeChat.connect: the permissions of the user's own Codex settings. */
  declare inherited?: CodexPolicy;
  constructor({ cwd, onEvent, onRequest, shared = false, canTerminalReply = () => true, allowTerminalRequest = () => true, terminalParams = (_method, params) => params, env, bin = which('codex') }: CodexTransportOptions) {
    if (!bin) throw new Error('Install Codex CLI and sign in to start a chat.');
    this.startedAt = Date.now(); this.bin = bin; this.clients = new Set(); this.canTerminalReply = canTerminalReply; this.allowTerminalRequest = allowTerminalRequest; this.terminalParams = terminalParams;
    this.pending = new Map(); this.seq = 0; this.stderr = '';
    if (shared) {
      this.socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-codex-'));
      fs.chmodSync(this.socketDir, 0o700);
      this.socketPath = path.join(this.socketDir, 'control.sock');
      this.endpoint = 'unix://' + this.socketPath;
    }
    this.child = spawn(bin, ['app-server', '--stdio'], { cwd, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk).slice(-3000); });
    const receive = (line: string) => {
      let message: CodexLine; try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        for (const client of this.clients) if (client.initialized && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
        if (message.id !== undefined) onRequest(message);
        else onEvent(message);
      } else {
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        message.error ? pending.reject(new Error(message.error.message || 'Codex request failed')) : pending.resolve(message.result);
      }
    };
    this.lines = readline.createInterface({ input: this.child.stdout }); this.lines.on('line', receive);
    if (shared) this.ready = this.openTerminalSocket();
    const fail = (error: Error) => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
      if (!this.closing) onEvent({ method: 'transport/error', params: { message: error.message } });
    };
    this.fail = fail;
    this.child.on('error', fail);
    this.child.on('exit', code => { fail(new Error(this.stderr || `Codex CLI exited (${code ?? 'signal'}).`)); if (this.socketDir) fs.rmSync(this.socketDir, { recursive: true, force: true }); });
    this.child.stdin.on('error', fail);
  }
  openTerminalSocket(): Promise<void> {
    // Both UIs use ONE initialized CLI connection. The local terminal bridge
    // remaps its RPC IDs, so approvals, subscriptions and turn events cannot
    // drift between independent clients or separate agent processes.
    this.server = http.createServer();
    this.webSockets = new WebSocket.Server({ server: this.server, maxPayload: 128 * 1024 * 1024 });
    this.webSockets.on('connection', (client: CodexTerminalClient) => {
      this.clients.add(client);
      const reply = (message: CodexOutgoing) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message)); };
      client.on('close', () => this.clients.delete(client));
      client.on('error', () => client.terminate());
      client.on('message', async raw => {
        let message: CodexClientMessage; try { message = JSON.parse(raw as unknown as string); } catch { return; } // JSON.parse reads the Buffer as its text
        if (!message.method) { if (client.initialized && this.canTerminalReply()) this.write(message); return; }
        if (message.method === 'initialize') { reply({ id: message.id, result: this.initializationResult }); return; }
        if (message.method === 'initialized') { client.initialized = true; return; }
        if (!client.initialized) { reply({ id: message.id, error: { code: -32000, message: 'Initialize the terminal connection first.' } }); return; }
        // Closing/changing the terminal view must not unsubscribe the chat UI.
        if (message.method === 'thread/unsubscribe') { reply({ id: message.id, result: { status: 'unsubscribed' } }); return; }
        try {
          if (!this.allowTerminalRequest(message)) throw new Error('Select or create this conversation in the Radial sidebar.');
          if (message.id === undefined) { this.write(message); return; }
          const result = await this.request(message.method, this.terminalParams(message.method, message.params));
          reply({ id: message.id, result });
        } catch (error) { reply({ id: message.id, error: { code: -32000, message: (error as Error).message } }); }
      });
    });
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject); // set just above
      this.server!.listen(this.socketPath!, () => { fs.chmodSync(this.socketPath!, 0o600); resolve(); }); // shared, the only time this runs: the constructor set socketPath
    });
  }
  write(message: CodexOutgoing): void { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request<M extends keyof CodexResults>(method: M, params?: CodexParams): Promise<CodexResults[M]>;
  /** Any other method (a terminal view's request): the CLI's answer as it sends it. */
  request(method: string, params?: CodexParams): Promise<unknown>;
  request(method: string, params?: CodexParams): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex timed out: ${method}`)); }, 45000);
      this.pending.set(id, { resolve, reject, timer }); this.write({ id, method, params });
    });
  }
  async initialize(): Promise<void> {
    await this.ready;
    this.initializationResult = await this.request('initialize', { clientInfo: { name: 'radial_chat_experiment', title: 'Radial', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized', params: {} });
  }
  close(): void { this.closing = true; for (const client of this.clients) client.terminate(); this.webSockets?.close(); this.server?.close(); this.child.kill('SIGTERM'); this.lines?.close(); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Chat stopped.')); } this.pending.clear(); }
}

// "Use Codex settings": the permissions the user's Codex config sets, read
// through the CLI so profiles and every config layer count. Radial fills in
// workspace access only where that config sets nothing.
async function codexConfigPermissions(transport: Pick<NativeChatTransport, 'request'>, cwd: string): Promise<CodexPolicy> {
  const fallback = permissions.codex('workspace');
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([(transport.request('config/read', { cwd, includeLayers: false }) as Promise<CodexConfigRead>).catch(() => null), new Promise<null>(resolve => { timer = setTimeout(resolve, 3000, null); })]); // only a Codex chat asks: its answer, trusted as the CLI sends it
  clearTimeout(timer);
  const config = result?.config || {}, profile = (config.profile && config.profiles?.[config.profile]) || {};
  const approval = profile.approval_policy ?? config.approval_policy, sandbox = profile.sandbox_mode ?? config.sandbox_mode ?? fallback.sandbox;
  const write = { ...config.sandbox_workspace_write, ...profile.sandbox_workspace_write };
  return {
    sandbox,
    // An unset policy (null or missing) gets Radial's; a structured one stays with
    // the CLI rather than being re-shaped here.
    approvalPolicy: approval == null ? fallback.approvalPolicy : typeof approval === 'string' ? approval : undefined,
    sandboxPolicy: sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' } : sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: write.writable_roots || [], networkAccess: !!write.network_access, excludeSlashTmp: !!write.exclude_slash_tmp, excludeTmpdirEnvVar: !!write.exclude_tmpdir_env_var },
  };
}

// Tool output in a chat is a display copy: the CLI's own transcript keeps all of
// it. Past 16 KB keep the start and the end, so a long log still shows how it
// began and how it finished. Full copies made a long-running store 65 MB.
const DETAIL_CAP = 16 * 1024, DETAIL_HEAD = 12 * 1024, DETAIL_TAIL = 4 * 1024;
const CUT = /^\n\n… ([\d,]+) characters not shown …\n\n/;
function capDetail<M extends DetailMessage | null>(message: M): M {
  const detail = message?.detail;
  if (typeof detail !== 'string' || detail.length <= DETAIL_CAP) return message;
  const marker = CUT.exec(detail.slice(DETAIL_HEAD, DETAIL_HEAD + 64)); // already cut once: keep counting
  const rest = detail.slice(DETAIL_HEAD + (marker ? marker[0].length : 0));
  const cut = (marker ? Number(marker[1].replace(/,/g, '')) : 0) + Math.max(0, rest.length - DETAIL_TAIL);
  message!.detail = detail.slice(0, DETAIL_HEAD) + `\n\n… ${cut.toLocaleString('en-US')} characters not shown …\n\n` + rest.slice(-DETAIL_TAIL); // detail is a string, so there is a message
  return message;
}
/** A tool call's result or error as its step shows it: text as it reads (Claude's and Cursor's providers give a line of text), anything else as JSON. */
function toolOutput(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value); }
function itemMessage(item: NativeChatItem | NoItem): ChatMessage | null { return capDetail(chatMessage(item)); }
function chatMessage(item: NativeChatItem | NoItem): ChatMessage | null {
  if (item.type === 'userMessage') return { id: item.id, role: 'user', text: (item.content || []).map(part => part.text ?? part.path ?? part.url ?? '').filter(Boolean).join('\n') };
  if (item.type === 'agentMessage') return { id: item.id, role: 'assistant', text: item.text || '' };
  if (item.type === 'commandExecution') return { id: item.id, role: 'tool', name: 'Terminal', text: item.command || '', detail: item.aggregatedOutput || '', status: item.status || 'inProgress' };
  if (item.type === 'fileChange') return { id: item.id, role: 'tool', name: 'File changes', text: (item.changes || []).map(c => c.path).join('\n'), detail: (item.changes || []).map(c => c.diff || '').join('\n'), changes: item.changes || [], status: item.status || 'inProgress' };
  if (item.type === 'mcpToolCall') return { id: item.id, role: 'tool', name: item.tool || 'Tool', text: item.server || '', detail: toolOutput(item.result || item.error || ''), status: item.status || 'inProgress' };
  if (item.type === 'webSearch') return { id: item.id, role: 'tool', name: 'Search', text: item.query || '', status: 'completed' };
  if (item.type === 'plan') return { id: item.id, role: 'assistant', text: item.text || '' };
  if ((['reasoning', 'contextCompaction'] as (string | undefined)[]).includes(item.type)) return null;
  if (item.type && item.id) return { id: item.id, role: 'tool', name: item.type.replace(/([a-z])([A-Z])/g, '$1 $2'), text: 'Additional CLI activity', detail: JSON.stringify(item, null, 2).slice(0, 20000), status: item.status || 'completed' };
  return null;
}
// Compatibility with local CLI builds whose paginated history APIs are stubs.
// Read only the rollout identified by the CLI for this exact thread. Completed
// items use the CLI's persisted enum names and snake_case tool fields.
async function readRollout(thread: Pick<CodexThread, 'id' | 'path'>): Promise<NativeChatItemEntry[]> {
  if (!thread.path || !fs.existsSync(thread.path)) return [];
  const input = fs.createReadStream(thread.path, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const items = new Map<string, NativeChatItemEntry>(); let matched = false;
  try {
    for await (const line of lines) {
      let record: RolloutRecord; try { record = JSON.parse(line); } catch { continue; } // May end in a currently-writing line.
      const payload = record.payload || {};
      if (record.type === 'session_meta') {
        if ((payload.id || payload.session_id) !== thread.id) throw new Error('Codex history belongs to a different conversation.');
        matched = true;
      }
      if (record.type !== 'event_msg' || payload.type !== 'item_completed') continue;
      const saved = payload.item!, /* item_completed carries its item */ item = { ...saved, type: saved.type[0].toLowerCase() + saved.type.slice(1) };
      if (item.type === 'agentMessage') item.text = (saved.content || []).map(part => part.text || '').join('');
      if (item.type === 'commandExecution') item.aggregatedOutput = saved.aggregated_output || '';
      if (item.type === 'fileChange' && !Array.isArray(saved.changes)) item.changes = Object.entries(saved.changes || {}).map(([path, change]) => ({ path, diff: change.unified_diff || change.content || '' }));
      if (item.status) item.status = item.status[0].toLowerCase() + item.status.slice(1);
      items.set(item.id, { item: item as NativeChatItem, turnId: payload.turn_id }); // changes is a list now: converted above where the rollout keyed it by path
    }
  } finally { lines.close(); input.destroy(); }
  if (!matched) throw new Error('Codex history is not ready. Try switching again in a moment.');
  return [...items.values()];
}
/**
 * Nobody has used this chat: nothing sent, typed, queued or waiting to be sent,
 * and no name, pin or keep-awake of its own. Its settings (model, permissions)
 * don't count. The window asks the same of the first chat it hands an API
 * caller's task to (renderer/nativeChat.ts unused).
 */
function unused(s: ChatSession): boolean {
  return !s.archived && !s.messages.length && !s.lastSubmittedAt && !s.queue?.length && !s.terminalHasInput && !s.nativePendingPrompt && !s.providerPersisted && !s.initialPrompt
    && s.titleAuto === true && !s.recentPinnedAt && !s.keepAwake && !['working', 'approval'].includes(s.state);
}
class NativeChat {
  declare resources: ChatResources;
  /** Each chat's next queued message, about to be sent. */
  declare queueTimers: Map<string, NodeJS.Timeout>;
  declare file: string;
  declare cliEnv: NativeChatEnv;
  declare context: NativeChatOptions['context'];
  declare emit: NativeChatOptions['emit'];
  declare terminal?: NativeChatTerminal;
  declare transportFactory: NativeChatTransportFactory;
  /** A view, permission or provider change in progress, by chat id: what it settles to. */
  declare handoffs: Map<string, Promise<ChatSession>>;
  /** A send between its start and turn/start's answer, by chat id; stop replaces the token to drop the answer. */
  declare starting: Map<string, symbol>;
  declare stopping: Map<string, Promise<ChatSession>>;
  declare sessions: Map<string, ChatSession>;
  /** Each chat's connected transport. */
  declare live: Map<string, NativeChatTransport>;
  /** Model catalogs, by engine and folder. */
  declare catalogs: Map<string, CatalogEntry>;
  /** The native-chats/ folder: a file per chat. */
  declare dir: string;
  declare dirty: Set<string>;
  declare writes: Map<string, Promise<void>>;
  /** Messages changed in place since a chat's last event. */
  declare touched: Map<string, Set<ChatMessage>>;
  /** The message list each chat's last event was cut from, and its length then. */
  declare sent: Map<string, { list: ChatMessage[]; length: number }>;
  declare restoring: Promise<void>;
  declare projectRestores?: Map<string, Promise<void>>;
  declare dirtySince?: number;
  declare saveTimer?: NodeJS.Timeout | null;
  declare closing?: boolean;
  /** A finished turn's CLI, closed after a minute idle. */
  declare idleTimers?: Map<string, NodeJS.Timeout>;
  constructor({ file, context, emit, terminal, transport = options => options.engine && options.engine !== 'codex' ? (options.session && options.terminal ? new InteractiveTransport(options as InteractiveOptions) : providerTransport(options as ProviderOptions)) : new CodexTransport({ ...options, bin: process.env.RADIAL_USERDATA && process.env.RADIAL_CHAT_TEST_CLI || undefined }) }: NativeChatOptions) { // a provider engine (checked); a native terminal only with a session and a terminal, as connect passes them
    this.resources = new ChatResources(path.join(path.dirname(file), 'chat-attachments')); this.queueTimers = new Map();
    this.file = file; this.cliEnv = { RADIAL_CLI_SOCK: cliSocket(path.dirname(file)) }; this.context = context; this.emit = emit; this.terminal = terminal; this.transportFactory = transport; this.handoffs = new Map(); this.starting = new Map(); this.stopping = new Map();
    this.sessions = new Map(); this.live = new Map(); this.catalogs = new Map();
    // One file per chat (native-chats/<id>.json), written only when that chat
    // changes, off the main thread. The single native-chats.json it replaces was
    // rewritten whole and synchronously after any change: on a 65 MB store that
    // blocked every terminal for ~120 ms per save, and typing scheduled saves.
    this.dir = path.join(path.dirname(file), path.basename(file, '.json'));
    this.dirty = new Set(); this.writes = new Map(); this.touched = new Map(); this.sent = new Map();
    try { for (const s of this.load(file)) this.sessions.set(s.id, { ...s, ...(s.engine === 'codex' && (!s.permissionMode || s.permissionMode === 'default') ? { permissionMode: 'cli' as const } : {}), ...(s.title === 'New chat' && s.titleAuto !== false && !s.messages.length ? { title: LABELS[s.engine], titleAuto: true } : {}), recovery: ['working', 'approval'].includes(s.state) ? 'Radial closed before this turn finished. You can retry your last message or continue the conversation.' : s.recovery, queuePaused: s.nativeTerminal ? s.queuePaused : true, state: s.nativeTerminal && s.terminalId ? s.state : 'idle', approval: null, approvals: [], turnId: null, viewMode: 'chat', terminalId: s.nativeTerminal ? s.terminalId : null, awaitingTerminalThread: false }); } catch {}
    this.restoring = this.restoreNativeTerminals();
  }
  load(file: string): ChatSession[] {
    if (fs.existsSync(this.dir)) {
      return (fs.readdirSync(this.dir).filter(name => name.endsWith('.json')).map(name => { try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as ChatSession; } catch { return null; } }) // a chat this app saved
        .filter(s => s?.id && Array.isArray(s.messages)) as ChatSession[]).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); // the filter drops the nulls
    }
    let saved: ChatSession[]; try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } // the single store this app saved before, checked just below
    if (!Array.isArray(saved)) return [];
    for (const s of saved) for (const m of s.messages || []) capDetail(m);
    // Move to a file per chat once: build the folder beside it, then swap it in,
    // so an interrupted move leaves the old file to retry from. The old file is
    // kept as .migrated.
    try {
      const staging = this.dir + '.moving';
      fs.rmSync(staging, { recursive: true, force: true }); fs.mkdirSync(staging, { recursive: true });
      for (const s of saved) fs.writeFileSync(path.join(staging, s.id + '.json'), JSON.stringify(s));
      fs.renameSync(staging, this.dir); fs.renameSync(file, file + '.migrated');
    } catch {}
    return saved;
  }
  async restoreNativeTerminals(): Promise<void> {
    if (!this.terminal?.list) return;
    const sessions = [...this.sessions.values()].filter(s => s.nativeTerminal && !s.archived && s.terminalId);
    if (!sessions.length) return;
    let alive: PtyInfo[];
    try { alive = await this.terminal.list(); }
    catch { for (const s of sessions) { s.nativeInputNotice = 'Could not reconnect to the native CLI. Open Terminal to retry.'; this.changed(s); } return; }
    await Promise.all(sessions.map(async s => {
      if (!alive.some(t => t.alive !== false && t.meta?.nativeChatId === s.id)) { s.terminalId = null; s.state = 'idle'; s.queuePaused = true; this.changed(s); return; }
      try { await this.connect(s); s.recovery = ''; }
      catch (error) { s.error = (error as Error).message; s.state = 'error'; this.changed(s); }
    }));
  }
  async restoreProject(repoDir: string, home = false): Promise<void> {
    await this.restoring;
    // Only projects being reopened/woken resume their saved agents. Recents
    // belonging to closed projects and empty, never-started chats stay inert.
    this.projectRestores ||= new Map();
    const key = JSON.stringify([repoDir, home]);
    if (this.projectRestores.has(key)) return this.projectRestores.get(key);
    const job = (async () => {
      // Reattach only chats whose CLI is still running in the daemon. The rest
      // start when someone opens or sends to them: one CLI per past conversation
      // at every open was a memory leak (docs/memory-leak-report-2026-10-11.md).
      let running = new Set<string>();
      try { running = new Set(((await this.terminal?.list?.(repoDir)) || []).filter(t => t.alive !== false && t.meta?.nativeChatId).map(t => t.meta.nativeChatId!)); } catch {} // kept only with one
      const sessions = [...this.sessions.values()].filter(s => s.repoDir === repoDir && !!s.home === home && !s.archived && s.threadId && running.has(s.id));
      await Promise.all(sessions.map(async s => {
        if (this.closing || this.live.has(s.id)) return;
        try {
          await this.connect(s);
          // Restoring a connection is not permission to repeat an interrupted
          // prompt or drain a queue left behind by a stopped CLI.
          s.error = ''; this.changed(s);
        } catch (error) {
          if (this.closing || s.archived) return;
          s.error = 'Could not resume this conversation: ' + (error as Error).message;
          s.state = 'error'; this.changed(s);
        }
      }));
    })();
    this.projectRestores.set(key, job);
    try { await job; } finally { this.projectRestores.delete(key); }
  }
  // 150 ms after the last change, and at least every 2 s while changes keep coming.
  // (Keep the first wait under 200 ms: interactive tests step a mock clock by 200 ms,
  // and a later timer there starves xterm's zero-delay write timer.)
  save(s: ChatSession): void {
    if (this.closing) { this.writeSync(s.id); return; }
    this.dirty.add(s.id); this.dirtySince ||= Date.now();
    clearTimeout(this.saveTimer as NodeJS.Timeout | undefined); // a null timer is a no-op; @types/node leaves null out
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.dirtySince = 0; for (const id of this.dirty) this.write(id); this.dirty.clear(); }, Math.max(0, Math.min(150, this.dirtySince + 2000 - Date.now())));
  }
  // One write in flight per chat; the next waits for it and writes the latest state.
  write(id: string): Promise<void> {
    const job = (this.writes.get(id) || Promise.resolve()).then(async () => {
      const s = this.sessions.get(id); if (!s || this.closing) return;
      const target = path.join(this.dir, id + '.json');
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(target + '.tmp', JSON.stringify(s));
      if (!this.closing) await fs.promises.rename(target + '.tmp', target); // quit wrote the latest itself
    }).catch(() => {});
    this.writes.set(id, job);
    job.then(() => { if (this.writes.get(id) === job) this.writes.delete(id); });
    return job;
  }
  writeSync(id: string): void {
    const s = this.sessions.get(id); if (!s) return;
    const target = path.join(this.dir, id + '.json');
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(target + '.quit', JSON.stringify(s)); fs.renameSync(target + '.quit', target); } catch {}
  }
  // revision orders snapshots: the renderer drops an event older than a reply it already has.
  changed(s: ChatSession): void {
    s.updatedAt = Date.now(); s.revision = (s.revision || 0) + 1; this.save(s);
    // At once, not batched: the window expects an action's event before its reply.
    this.emit(this.payload(s));
  }
  // A message changed in place; the next event must carry it.
  touch(s: ChatSession, message: ChatMessage): void { let set = this.touched.get(s.id); if (!set) this.touched.set(s.id, set = new Set()); set.add(message); }
  // What an event carries: the session without its message list, plus the part
  // of the list the window doesn't have yet. Messages only grow at the end or
  // change near it (a streaming reply, a tool finishing), so that is the tail
  // from the first changed message. A replaced list (history reload) goes whole.
  payload(s: ChatSession): ChatEvent {
    const { messages, ...session } = s, sent = this.sent.get(s.id);
    let from = 0;
    if (sent && sent.list === messages) {
      from = Math.min(sent.length, messages.length);
      for (const message of this.touched.get(s.id) || []) { const i = messages.lastIndexOf(message); if (i >= 0 && i < from) from = i; }
    }
    this.touched.delete(s.id); this.sent.set(s.id, { list: messages, length: messages.length });
    return { ...session, messageCount: messages.length, messagePatch: { from, messages: messages.slice(from) } };
  }
  list(repoDir?: string | null, includeClosed = false): ChatSummary[] { return [...this.sessions.values()].filter(s => (includeClosed || !s.archived) && (!repoDir || s.repoDir === repoDir)).map(({ messages, ...s }) => ({ ...s, messageCount: messages.length })).sort((a,b) => b.updatedAt - a.updatedAt); }
  get(id: string): ChatSession { const s = this.sessions.get(id); if (!s) throw new Error('Chat not found.'); return s; }
  /** repoDir is the window's project folder: none from Home before initHomeTab, or with no project open. */
  create(repoDir: string | null | undefined, home = false, engine: ChatEngine = 'codex'): ChatSession {
    if (!LABELS[engine]) throw new Error('Use the regular terminal for this CLI.');
    if (typeof repoDir !== 'string' || !path.isAbsolute(repoDir) || !fs.statSync(repoDir).isDirectory()) throw new Error('Open a local project first.');
    const s: ChatSession = { id: randomUUID(), repoDir, home, engine, title: LABELS[engine], titleAuto: true, state: 'idle', messages: [], createdAt: Date.now(), updatedAt: Date.now(), threadId: null, approval: null };
    this.sessions.set(s.id, s); this.changed(s); return s;
  }
  nameFromMessage(s: ChatSession, text: string): void {
    if (s.titleAuto === true || (s.titleAuto !== false && s.title === 'New chat')) {
      const title = taskTitle.summarize(text);
      if (title) { s.title = title; s.titleAuto = false; }
    }
  }
  async models(repoDir: string, engine: ChatEngine = 'codex'): Promise<ChatModel[]> {
    if (!LABELS[engine]) throw new Error('Unknown chat provider.');
    const catalogKey = engine + ':' + repoDir;
    if (typeof repoDir !== 'string' || !path.isAbsolute(repoDir) || !fs.statSync(repoDir).isDirectory()) throw new Error('Open a local project first.');
    const cached = this.catalogs.get(catalogKey);
    if (cached && Date.now() - cached.at < 60000) return cached.promise;
    // Catalog discovery never creates a thread or submits a prompt.
    const promise = (async () => {
      const transport: NativeChatTransport = this.transportFactory({ engine, cwd: repoDir, env: this.cliEnv, onEvent: () => {}, onRequest: request => transport.write!({ id: request.id, error: { code: -32601, message: 'Catalog discovery cannot answer interactive requests.' } }) });
      try {
        await transport.initialize();
        const models = new Map<string, ChatModel>(), cursors = new Set<string | null | undefined>();
        let cursor: string | null | undefined = null;
        do {
          const page = await transport.request('model/list', { cursor, limit: 100, includeHidden: false }) as NativeChatModelPage; // a catalog transport (Codex or a provider) asks only its CLI
          for (const model of page.data || []) if (!model.hidden) models.set(model.model, model);
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error('Codex returned a repeated model page.');
          cursors.add(cursor);
        } while (cursor);
        return [...models.values()];
      } finally { transport.close(); }
    })();
    const entry: CatalogEntry = { at: Date.now(), promise }; this.catalogs.set(catalogKey, entry);
    try { return await promise; }
    catch (error) { if (this.catalogs.get(catalogKey) === entry) this.catalogs.delete(catalogKey); throw error; }
  }
  async configure(id: string, model: string, effort?: string | null): Promise<ChatSession> {
    const s = this.get(id), engine = s.engine;
    if (s.nativeTerminal && s.terminalId) throw new Error('Change the model in the running native Terminal.');
    const assertIdle = () => { if (s.archived || s.viewMode === 'terminal' || this.handoffs.has(id)) throw new Error('Switch to Chat before changing its model.'); };
    assertIdle();
    const available = (await this.models(s.repoDir, s.engine)).find(item => item.model === model);
    assertIdle(); // A turn may have started while the catalog was loading.
    if (s.engine !== engine) throw new Error('The provider changed. Choose a model from the current provider.');
    if (!available) throw new Error('This model is not available from your ' + LABELS[s.engine] + ' CLI.');
    const selectedEffort = effort ?? available.defaultReasoningEffort;
    if (selectedEffort != null && !(available.supportedReasoningEfforts || []).some(item => item.reasoningEffort === selectedEffort)) throw new Error('This model does not support that reasoning effort.');
    const selection = { model: available.model, modelName: available.displayName, effort: selectedEffort };
    if (this.starting.has(id) || ['working', 'approval'].includes(s.state) || s.pendingSettings) s.pendingSettings = { ...s.pendingSettings, ...selection };
    else Object.assign(s, selection);
    this.changed(s); return s;
  }
  async connect(s: ChatSession, attachOnly = false): Promise<NativeChatTransport> {
    clearTimeout(this.idleTimers?.get(s.id));
    if (this.live.has(s.id)) { const existing = this.live.get(s.id)!; await existing.connected; return existing; }
    const transport: NativeChatTransport = this.transportFactory({ engine: s.engine, session: s, terminal: this.terminal, runtimeRoot: path.join(path.dirname(this.file), 'native-cli-sessions'), env: this.cliEnv, contextText: this.context(s.repoDir, s.home), cwd: s.repoDir, shared: true,
      terminalParams: (method, params) => {
        if (method === 'turn/start' && s.pendingSettings) {
          this.consumePendingSettings(s);
          const policy = this.codexPermissions(s, transport);
          return { ...params, ...(s.model ? { model: s.model, effort: s.effort } : {}), ...(policy ? { approvalPolicy: policy.approvalPolicy, sandboxPolicy: policy.sandboxPolicy } : {}) };
        }
        const policy = ['thread/start', 'thread/resume'].includes(method) && this.codexPermissions(s, transport);
        if (policy) return { ...params, sandbox: policy.sandbox, approvalPolicy: policy.approvalPolicy };
        return params;
      },
      canTerminalReply: () => s.viewMode === 'terminal' && !this.handoffs.has(s.id),
      allowTerminalRequest: request => {
        if (request.method === 'thread/start') return !s.threadId;
        if (request.method === 'thread/fork') return false;
        if (request.method === 'thread/resume') return request.params?.threadId === s.threadId;
        if (['turn/start', 'turn/steer', 'turn/interrupt'].includes(request.method)) return s.viewMode === 'terminal' && !this.handoffs.has(s.id) && request.params?.threadId === s.threadId;
        return true;
      }, onEvent: event => this.event(s, event), onRequest: request => this.requestFromCli(s, request) });
    this.live.set(s.id, transport);
    transport.connected = (async () => {
      await transport.initialize();
      if (this.closing || s.archived) throw new Error('This conversation was closed while its CLI was opening.');
      if (s.engine === 'codex') transport.inherited = await codexConfigPermissions(transport, s.repoDir);
      if (attachOnly && !s.threadId && s.engine === 'codex') return;
      // Recover an empty Cursor session whose earlier handoff failed before
      // the terminal could create its database. Keep its original native ID.
      if (!transport.nativeTerminal && attachOnly && s.engine === 'cursor' && s.threadId && !s.providerPersisted && !s.messages.length) { transport.threadId = s.threadId; return; }
      const policy = s.engine === 'codex' && this.codexPermissions(s, transport);
      const options: ThreadOptions = { cwd: s.repoDir, ...(policy ? { approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox } : {}), approvalsReviewer: 'user', developerInstructions: this.context(s.repoDir, s.home) };
      if (s.model) options.model = s.model;
      const result = await transport.request(s.threadId ? 'thread/resume' : 'thread/start', s.threadId ? { ...options, threadId: s.threadId } : options);
      s.threadId = result.thread.id as string | null; /* a native terminal's is the session's own (string or null) once initialized; the others' a string */ if (result.model) s.resolvedModel = result.model; if (result.modelName) s.modelName = result.modelName; s.resolvedEffort = result.reasoningEffort; s.resolvedProvider = result.modelProvider || s.resolvedProvider; if (transport.nativeTerminal && transport.items!.size) await this.hydrate(s, transport); /* a native terminal keeps items */ this.changed(s);
    })();
    try { await transport.connected; return transport; } catch (error) { transport.close(); this.live.delete(s.id); throw error; }
  }
  async send(id: string, text: string, displayText: string = text, attachments: NativeChatAttachmentRef[] = [], fromQueue = false): Promise<ChatSession> {
    await this.restoring;
    const s = this.get(id);
    if (s.archived) throw new Error('Reopen this conversation before sending.');
    if ((!fromQueue && s.viewMode === 'terminal') || this.handoffs.has(id)) throw new Error('Switch this conversation to Chat before sending.');
    if (s.nativeTerminal && s.terminalHasInput) throw new Error('Your unsent Terminal draft is still there. Finish or clear it in Terminal before sending this message.');
    if (this.stopping.has(id) || this.starting.has(id) || s.state === 'working' || s.state === 'approval') throw new Error('Wait for this turn or stop it before sending another message.');
    if (typeof text !== 'string' || !text.trim() || text.length > 200000) throw new Error('Enter a message under 200,000 characters.');
    if (!Array.isArray(attachments) || attachments.length > 10) throw new Error('Attach up to 10 files per message.');
    const files = attachments.map(item => { const file = this.resources.describe(s, item.path); if (file.mime && file.size > 20 * 1024 * 1024) throw new Error('Previewable attachments must be under 20 MB.'); return file; });
    const prompt = text + (files.length ? '\n\nAttached files (read these local files for context):\n' + files.map(item => JSON.stringify(item.path)).join('\n') : '');
    const input: NativeChatInput[] = [{ type: 'text', text: prompt, text_elements: [] }, ...files.filter(item => item.mime.startsWith('image/')).map((item): NativeChatInput => ({ type: 'localImage', path: item.path }))];
    s.recovery = ''; s.unsupportedRequest = null;
    const token = Symbol(); this.starting.set(id, token);
    s.pendingUserId = randomUUID();
    s.messages.push({ id: s.pendingUserId, role: 'user', text: typeof displayText === 'string' ? displayText : text, sourceText: text, attachments: files });
    this.nameFromMessage(s, displayText);
    s.lastSubmittedAt = Date.now(); s.state = 'working'; s.error = ''; this.changed(s);
    try {
      await this.applyPendingSettings(s);
      const transport = await this.connect(s);
      if (this.starting.get(id) !== token) return s; // Stop while connecting.
      s.state = 'working';
      const policy = s.engine === 'codex' && this.codexPermissions(s, transport);
      const result = await transport.request('turn/start', { threadId: s.threadId, input, ...(policy ? { approvalPolicy: policy.approvalPolicy, sandboxPolicy: policy.sandboxPolicy } : {}), ...(s.model ? { model: s.model, effort: s.effort } : {}) });
      s.turnId = result.turn.id; this.changed(s);
    } catch (error) { if (this.starting.get(id) === token) { s.state = 'error'; s.error = (error as Error).message; this.changed(s); } }
    finally { if (this.starting.get(id) === token) this.starting.delete(id); }
    return s;
  }
  enqueue(id: string, text: string, displayText: string = text, attachments: NativeChatAttachmentRef[] = []): ChatSession {
    const s = this.get(id);
    if (s.archived || s.viewMode === 'terminal' || this.handoffs.has(id)) throw new Error('Switch to Chat before queuing a message.');
    if (typeof text !== 'string' || !text.trim() || text.length > 200000) throw new Error('Enter a message under 200,000 characters.');
    if (!Array.isArray(attachments) || attachments.length > 10) throw new Error('Attach up to 10 files per message.');
    const files = attachments.map(item => { const file = this.resources.describe(s, item.path); if (file.mime && file.size > 20 * 1024 * 1024) throw new Error('Previewable attachments must be under 20 MB.'); return file; });
    if ((s.queue || []).length >= 5) throw new Error('You can queue up to 5 messages.');
    s.queue ||= []; s.queue.push({ id: randomUUID(), text, displayText, attachments: files }); s.queuePaused = false; this.changed(s);
    if (s.state === 'idle') this.scheduleQueue(s);
    return s;
  }
  removeQueued(id: string, messageId: string): ChatSession {
    const s = this.get(id);
    if (!s.queue?.some(item => item.id === messageId)) throw new Error('That message has already left the queue.');
    s.queue = s.queue.filter(item => item.id !== messageId); this.changed(s); return s;
  }
  reorderQueue(id: string, messageIds: string[]): ChatSession {
    const s = this.get(id), queued = s.queue || [];
    if (!Array.isArray(messageIds) || messageIds.length !== queued.length || new Set(messageIds).size !== queued.length || messageIds.some(key => !queued.some(item => item.id === key))) {
      throw new Error('The queue changed. Try moving the message again.');
    }
    s.queue = messageIds.map(key => queued.find(item => item.id === key)!); // each key was found just above
    this.changed(s); return s;
  }
  resumeQueue(id: string): ChatSession { const s = this.get(id); if (s.archived || s.viewMode === 'terminal') throw new Error('Switch to Chat before resuming queued messages.'); if (s.state === 'error') { s.state = 'idle'; s.error = ''; } s.queuePaused = false; this.changed(s); this.scheduleQueue(s); return s; }
  scheduleQueue(s: ChatSession): void {
    clearTimeout(this.queueTimers.get(s.id));
    if (this.closing || s.queuePaused || !s.queue?.length || s.state !== 'idle' || s.error || s.archived) return;
    this.queueTimers.set(s.id, setTimeout(async () => {
      this.queueTimers.delete(s.id);
      if (this.closing || s.queuePaused || !s.queue?.length || s.state !== 'idle' || s.error || s.archived || (s.nativeTerminal && s.terminalHasInput) || this.handoffs.has(s.id) || this.starting.has(s.id) || this.stopping.has(s.id)) return;
      const next = s.queue.shift()!; this.changed(s); // the queue isn't empty: checked above
      try { await this.send(s.id, next.text, next.displayText, next.attachments, true); if ((s.state as ChatState) === 'error') { /* send changed it: TypeScript still has it 'idle' from the check above */ s.queuePaused = true; this.changed(s); } }
      catch (error) { s.queue.unshift(next); s.queuePaused = true; s.error = (error as Error).message; this.changed(s); }
    }, 100));
  }
  async hydrate(s: ChatSession, transport: Pick<NativeChatTransport, 'request' | 'nativeTerminal'>): Promise<void> {
    const before = new Map(s.messages.map(message => [message.id, JSON.stringify(message)]));
    const items: NativeChatItemEntry[] = [], cursors = new Set<string | null | undefined>(); let cursor: string | null | undefined = null;
    do {
      let page: NativeChatHistoryPage;
      try { page = await transport.request('thread/items/list', { threadId: s.threadId, sortDirection: 'asc', cursor, limit: 100 }); }
      catch (error) {
        if (cursor || !/not supported|unknown method|method not found/i.test((error as Error).message)) throw error;
        // Some installed CLIs publish the pagination schema before enabling
        // it. Their established thread/read API still returns full history.
        try {
          const result = await transport.request('thread/read', { threadId: s.threadId, includeTurns: true }) as CodexResults['thread/read']; // only Codex reaches here: the others list their items
          page = { data: (result.thread.turns || []).flatMap(turn => (turn.items || []).map(item => ({ item, turnId: turn.id }))), nextCursor: null };
        } catch (historyError) {
          if (!/not supported|unknown method|method not found/i.test((historyError as Error).message)) throw historyError;
          const result = await transport.request('thread/read', { threadId: s.threadId, includeTurns: false }) as CodexResults['thread/read'];
          page = { data: await readRollout(result.thread), nextCursor: null };
        }
      }
      if (!Array.isArray(page.data)) throw new Error('Codex did not return conversation history.');
      items.push(...page.data); cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Codex returned a repeated history page.');
      cursors.add(cursor);
    } while (cursor);
    if (s.engine !== 'codex' && !items.length && s.messages.length) throw new Error('The CLI has not saved its conversation yet. Try again shortly.');
    const old = new Map(s.messages.map(message => [message.cliId || message.id, message]));
    const users = s.messages.filter(message => message.role === 'user'); let userIndex = 0;
    const messages: ChatMessage[] = [];
    for (const entry of items) {
      const message = itemMessage(entry.item); if (!message) continue; message.turnId = entry.turnId;
      let previous = old.get(message.id);
      if (message.role === 'user') {
        const candidate = users[userIndex++];
        // Older Radial chats predate canonical item IDs. Preserve their clean
        // display prompt while the CLI retains the full visual-context input.
        if (!previous && candidate && (candidate.sourceText === message.text || message.text.includes(candidate.text))) previous = candidate;
        if (previous) { message.cliId = message.id; message.id = previous.id; message.text = previous.text; message.sourceText = previous.sourceText; message.attachments = previous.attachments; }
      }
      const latest = old.get(message.cliId || message.id);
      messages.push(latest && before.get(latest.id) !== JSON.stringify(latest) ? latest : message);
    }
    // A locally submitted prompt may be waiting for turn/start persistence.
    const pending = s.messages.find(message => message.id === s.pendingUserId);
    if (pending && !messages.some(message => message.id === pending.id)) messages.push(pending);
    // Events continue to render while history pages load. Keep new live items
    // and changed streamed items, rather than replaying deltas already present
    // in a history snapshot (which would duplicate text).
    const ids = new Set(messages.map(item => item.id));
    for (const message of s.messages) if ((!before.has(message.id) || (s.turnId && message.turnId === s.turnId && ['working', 'approval'].includes(s.state))) && !ids.has(message.id)) { messages.push(message); ids.add(message.id); }
    if (transport.nativeTerminal) {
      const canonical = new Set(messages.map(m => m.cliId || m.id));
      s.messages = [...s.messages.filter(m => !canonical.has(m.cliId || m.id) && !ids.has(m.id)), ...messages];
    } else s.messages = messages;
    this.changed(s);
  }
  /**
   * Switches a chat to Chat or Terminal; cols and rows size a new terminal view.
   * stopTerminal is ignored: a view change never stops the chat's CLI (45a322f).
   * main.ts's nativeChat:view handler still passes it, as preload.ts and
   * radialApi.ts still declare it.
   */
  setView(id: string, view: ChatView, cols?: number, rows?: number, stopTerminal?: boolean): Promise<ChatSession>;
  setView(id: string, view: ChatView, cols = 80, rows = 24): Promise<ChatSession> {
    if (!['chat', 'terminal'].includes(view)) return Promise.reject(new Error('Unknown conversation view.'));
    if (this.stopping.has(id)) return this.stopping.get(id)!.then(() => this.setView(id, view, cols, rows));
    if (this.handoffs.has(id)) return this.handoffs.get(id)!;
    const s = this.get(id);
    const job = Promise.resolve(this.restoring).then(() => this.changeView(s, view, cols, rows)).catch((error: unknown) => {
      // A failed Terminal-first launch must leave Chat able to create a thread.
      if (!s.terminalId && !s.threadId) {
        s.awaitingTerminalThread = false;
        this.live.get(id)?.close(); this.live.delete(id);
        this.changed(s);
      }
      throw error;
    });
    this.handoffs.set(id, job);
    return job.finally(() => this.handoffs.delete(id));
  }
  async changeView(s: ChatSession, view: ChatView, cols: number, rows: number): Promise<ChatSession> {
    if (s.archived) throw new Error('This conversation is closed.');
    if (s.engine !== 'codex') return this.changeProviderView(s, view);
    if (view === 'chat' && s.awaitingTerminalThread) throw new Error('Finish opening the terminal before switching back to Chat.');
    if (view === 'terminal' && !s.threadId) s.awaitingTerminalThread = true;
    const transport = await this.connect(s, view === 'terminal' && !s.threadId);
    if (view === 'terminal') {
      if (!transport.endpoint || !this.terminal) throw new Error('This Codex CLI cannot share its terminal view.');
      const live = s.terminalId && s.terminalEndpoint === transport.endpoint && (await this.terminal.list(s.repoDir)).some(term => term.id === s.terminalId && term.alive !== false);
      if (!live) {
        if (s.terminalId) this.terminal.kill(s.terminalId);
        const id = await this.terminal.start(s.repoDir, {
          cols: Math.max(20, Math.min(500, Number(cols) || 80)), rows: Math.max(5, Math.min(200, Number(rows) || 24)),
          command: { bin: transport.bin, args: [...(s.threadId ? ['resume', s.threadId] : []), '--remote', transport.endpoint, '--no-alt-screen', '-c', 'check_for_update_on_startup=false', ...(!s.threadId ? ['-c', 'developer_instructions=' + JSON.stringify(this.context(s.repoDir, s.home))] : []), ...(s.model || s.resolvedModel ? ['--model', s.model || s.resolvedModel!] : []), ...(s.effort || s.resolvedEffort ? ['-c', 'model_reasoning_effort=' + JSON.stringify(s.effort || s.resolvedEffort)] : []), ...(s.initialPrompt && !s.threadId ? [s.initialPrompt] : [])] },
          meta: { engine: 'codex', label: s.title, home: s.home, nativeChatId: s.id, keepAwake: !!s.keepAwake },
        });
        if (!id) throw new Error('The terminal view could not be opened.');
        s.terminalId = id; s.terminalEndpoint = transport.endpoint; delete s.initialPrompt;
      }
    } else if (s.threadId) await this.hydrate(s, transport);
    s.viewMode = view; this.changed(s); return s;
  }
  /** A Claude or Cursor chat's view change. Its CLI already runs in its own native terminal, so there is no terminal to start or size here. */
  async changeProviderView(s: ChatSession, view: ChatView): Promise<ChatSession> {
    const transport = await this.connect(s);
    if (!transport.nativeTerminal || !s.terminalId) throw new Error('This CLI adapter cannot share a live terminal. The current task has not been stopped.');
    // The PTY, turn, approvals, native input and queue all belong to the session.
    // A view change changes none of them, including while a turn is starting.
    s.viewMode = view; this.changed(s); return s;
  }
  terminalData(id: string, data: string): void {
    const s = [...this.sessions.values()].find(s => s.terminalId === id);
    if (s) this.live.get(s.id)?.data?.(data);
  }
  terminalResize(id: string, cols: number, rows: number): void {
    const s = [...this.sessions.values()].find(s => s.terminalId === id);
    if (s) this.live.get(s.id)?.resize?.(cols, rows);
  }
  /** Why a chat's terminal takes no typed input now (acceptsTerminalInput's reasons, for an answer's refusal), else null. */
  terminalInputBlock(id: string): 'chat-view' | 'switching' | 'delivering' | null {
    const session = [...this.sessions.values()].find(s => s.terminalId === id);
    if (!session) return null;
    const transport = this.live.get(session.id);
    if (transport?.nativeTerminal && transport.pendingPrompt?.delivering) return 'delivering';
    if (this.handoffs.has(session.id)) return 'switching';
    return session.viewMode === 'terminal' ? null : 'chat-view';
  }
  acceptsTerminalInput(id: string, data = ''): boolean {
    const session = [...this.sessions.values()].find(s => s.terminalId === id);
    const transport = session && this.live.get(session.id);
    if (transport?.nativeTerminal && data && terminalReply(data)) return false; // headless terminal owns capability replies
    if (transport?.nativeTerminal && transport.pendingPrompt?.delivering) return false;
    return !session || (session.viewMode === 'terminal' && !this.handoffs.has(session.id));
  }
  recordTerminalInput(id: string, data: string): void {
    if (typeof data !== 'string' || !data) return;
    // xterm answers CLI capability/cursor queries through the same input pipe.
    // Only recognized replies are ignored; unknown input retains the warning.
    const input = data.replace(/\x1b\[(?:[?>]?\d+(?:;\d+)*c|\d+;\d+R|[0-9]+n|\?\d+u|[IO])/g, '').replace(/\x1b\](?:10|11);rgb:[0-9a-f/]+(?:\x07|\x1b\\)/gi, '');
    if (!input) return;
    const s = [...this.sessions.values()].find(session => session.terminalId === id);
    if (s && this.live.get(s.id)?.nativeTerminal) { const had = s.terminalHasInput; this.live.get(s.id)!.noteInput!(data); /* a native terminal, checked just above */ if (s.terminalHasInput !== had) this.changed(s); return; }
    if (s && s.engine !== 'codex' && s.terminalHasInput !== true) { s.terminalHasInput = true; this.changed(s); }
  }
  terminalExited(id: string): void {
    if (this.closing) return;
    const s = [...this.sessions.values()].find(session => session.terminalId === id);
    if (!s || s.archived) return;
    if (s.nativeTerminal) {
      this.live.get(s.id)?.close(); this.live.delete(s.id); s.terminalId = null; s.state = 'error'; s.turnId = null; s.nativeInputNotice = ''; s.error = 'The native CLI exited. Send a message to resume this conversation.'; this.changed(s); return;
    }
    if (s.engine !== 'codex') {
      s.terminalId = null; s.providerPersisted = true;
      if (!this.handoffs.has(s.id)) this.setView(s.id, 'chat').catch((error: Error) => { s.viewMode = 'chat'; s.error = error.message; this.changed(s); });
      return;
    }
    if (!s.threadId) { this.live.get(s.id)?.close(); this.live.delete(s.id); }
    s.terminalId = null; s.viewMode = 'chat'; s.awaitingTerminalThread = false; this.changed(s);
  }
  event(s: ChatSession, event: NativeChatEvent): void {
    const { method, params = {} } = event; // one bag of params for every method (NativeChatEventParams): the default keeps TypeScript from telling them apart by method
    if (params.threadId && s.threadId && params.threadId !== s.threadId) return;
    if (method === 'native/state') { if (s.state !== params.status) { s.state = params.status as Exclude<ChatState, 'error'>; /* a native terminal's state */ this.changed(s); } return; }
    if (method === 'native/input' || method === 'native/settings') { this.changed(s); if (method === 'native/input') this.scheduleQueue(s); return; }
    if (method === 'thread/started' && s.awaitingTerminalThread) { s.threadId = params.thread!.id; /* thread/started carries its thread */ s.awaitingTerminalThread = false; this.changed(s); return; }
    if (method === 'item/agentMessage/delta') {
      let message = s.messages.find(m => m.id === params.itemId);
      if (!message) { message = { id: params.itemId!, role: 'assistant', text: '', turnId: params.turnId || s.turnId }; s.messages.push(message); } // a delta names its item
      message.text += params.delta; this.touch(s, message);
    } else if (method === 'item/started' || method === 'item/completed') {
      const message = itemMessage(params.item || {}); if (!message) return; message.turnId = params.turnId || s.turnId;
      let existing = s.messages.find(m => (m.cliId || m.id) === message.id);
      if (message.role === 'user' && s.pendingUserId) {
        existing ||= s.messages.find(m => m.id === s.pendingUserId);
        if (existing) { existing.cliId = message.id; existing.turnId = message.turnId; s.pendingUserId = null; this.touch(s, existing); this.changed(s); return; }
      }
      if (message.role === 'user' && !existing) { s.lastSubmittedAt = Date.now(); this.nameFromMessage(s, message.text); }
      if (existing && message.role !== 'user') { Object.assign(existing, message); this.touch(s, existing); } else if (!existing) s.messages.push(message);
    } else if (method === 'turn/started') { s.turnId = params.turn!.id; s.state = 'working'; } // turn events carry their turn
    else if (method === 'turn/completed') { if (s.turnId && params.turn!.id && params.turn!.id !== s.turnId) return; s.state = params.turn!.status === 'failed' || s.error ? 'error' : 'idle'; s.error = params.turn!.error?.message || s.error || ''; if (params.turn!.status === 'interrupted' || s.error) s.queuePaused = true; s.approval = null; s.approvals = []; s.turnId = null; s.pendingUserId = null;
      this.idleTimers ||= new Map();
      if (!s.keepAwake && !s.terminalId) this.idleTimers.set(s.id, setTimeout(() => { this.live.get(s.id)?.close(); this.live.delete(s.id); this.idleTimers!.delete(s.id); }, 60000)); // made just above, never unset
    }
    else if (method === 'turn/plan/updated') {
      const id = 'plan:' + (params.turnId || s.turnId || 'current');
      const plan: ChatMessage = { id, role: 'tool', name: 'Plan', text: params.explanation || 'Work plan', detail: (params.plan || []).map(step => (step.status === 'completed' ? '✓ ' : step.status === 'inProgress' ? '→ ' : '○ ') + step.step).join('\n'), status: 'completed' };
      const existing = s.messages.find(item => item.id === id); if (existing) { Object.assign(existing, plan); this.touch(s, existing); } else s.messages.push(plan);
    }
    else if (method === 'thread/tokenUsage/updated') { s.tokenUsage = params.tokenUsage; }
    else if (method === 'serverRequest/resolved') {
      s.approvals = (s.approvals || []).filter(approval => approval.id !== params.requestId);
      if (s.approval?.id === params.requestId) s.approval = s.approvals.shift() || null;
      if (s.state === 'approval' && !s.approval) s.state = 'working';
    }
    else if (method === 'thread/status/changed') {
      if ((params.status as CodexThreadStatus | undefined)?.type === 'idle' && !this.starting.has(s.id)) { s.state = 'idle'; s.turnId = null; s.approval = null; s.approvals = []; } // Codex's thread status
      else if ((params.status as CodexThreadStatus | undefined)?.type === 'active') s.state = s.approval ? 'approval' : 'working';
    }
    else if (method === 'thread/settings/updated') {
      const settings = params.threadSettings || {};
      if (settings.model) { s.model = settings.model; s.resolvedModel = settings.model; s.modelName = null; }
      if (settings.effort) { s.effort = settings.effort; s.resolvedEffort = settings.effort; }
      const inherited = s.permissionMode !== 'custom' && permissions.inherits('codex', s.permissionMode) && this.live.get(s.id)?.inherited;
      const echo = inherited && settings.approvalPolicy === inherited.approvalPolicy && settings.sandboxPolicy?.type === inherited.sandboxPolicy.type;
      if (settings.sandboxPolicy && settings.approvalPolicy && !echo) {
        const type = settings.sandboxPolicy.type, policy = settings.approvalPolicy;
        s.permissionMode = type === 'dangerFullAccess' && policy === 'never' ? 'full' : type === 'readOnly' && policy === 'on-request' && !settings.sandboxPolicy.networkAccess ? 'read-only' : type === 'workspaceWrite' && policy === 'on-request' && !settings.sandboxPolicy.networkAccess && !settings.sandboxPolicy.writableRoots?.length ? 'workspace' : 'custom';
      }
      if (settings.modelProvider) s.resolvedProvider = settings.modelProvider;
    }
    else if (method === 'item/commandExecution/outputDelta') {
      const message = s.messages.find(item => item.id === params.itemId);
      if (message) { message.detail = (message.detail || '') + params.delta; capDetail(message); this.touch(s, message); }
    }
    else if (method === 'transport/error') { s.state = 'error'; s.error = params.message; this.live.get(s.id)?.close(); this.live.delete(s.id); s.approval = null; s.approvals = []; }
    else if (method === 'error') { s.error = params.error?.message || 'Codex reported an error.'; }
    else return;
    this.changed(s);
    if (method === 'turn/completed') this.scheduleQueue(s);
  }
  acceptsPendingFullAccess(s: ChatSession, request: ApprovalRequest): boolean {
    // A running CLI turn retains its original permission policy. Honor the
    // user's explicit mid-turn Full access choice through the CLI's approval
    // protocol until the next turn starts with the native permission flags.
    // Questions, terminal-owned turns, and restricted decisions stay manual.
    return s.viewMode !== 'terminal' && !this.handoffs.has(s.id) && ['working', 'approval'].includes(s.state) &&
      ['claude', 'codex'].includes(s.engine) && s.pendingSettings?.permissionMode === 'full' &&
      ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method) &&
      (!Array.isArray(request.params?.availableDecisions) || request.params.availableDecisions.includes('accept'));
  }
  applyPendingFullAccess(s: ChatSession): void {
    const transport = this.live.get(s.id);
    if (!transport) return;
    const waiting = [s.approval, ...(s.approvals || [])].filter(Boolean) as ChatApproval[]; // without the null
    const accepted = waiting.filter(request => this.acceptsPendingFullAccess(s, request));
    if (!accepted.length) return;
    const remaining = waiting.filter(request => !accepted.includes(request));
    // Clear first: the native response may synchronously resolve the request.
    s.approval = remaining.shift() || null; s.approvals = remaining;
    if (s.state === 'approval' && !s.approval) s.state = 'working';
    this.changed(s);
    for (const request of accepted) transport.write!({ id: request.id, result: { decision: 'accept' } }); // approvals come only from a transport that asks, which answers through write
  }
  requestFromCli(s: ChatSession, request: NativeChatRequest): void {
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'];
    if (!supported.includes(request.method)) {
      if (s.viewMode === 'terminal') return; // The native CLI handles its richer interactive requests.
      this.live.get(s.id)?.write!({ id: request.id, error: { code: -32601, message: 'This experimental interface does not support this request.' } }); // a transport that asks answers through write
      s.unsupportedRequest = request.method; s.error = `This request needs Terminal: ${request.method}. Stop the turn and switch views to continue with your CLI.`; this.changed(s); return;
    }
    if (s.approval?.id === request.id || s.approvals?.some(approval => approval.id === request.id)) return;
    if (this.acceptsPendingFullAccess(s, request) && this.live.has(s.id)) { this.live.get(s.id)!.write!({ id: request.id, result: { decision: 'accept' } }); return; }
    const approval: ChatApproval = { id: request.id, method: request.method as ChatApprovalMethod, params: request.params }; // one of the supported methods, checked above
    if (s.engine === 'codex' && request.method === 'item/commandExecution/requestApproval') {
      const choices = request.params.availableDecisions;
      const offered = choices?.find(choice => choice?.acceptWithExecpolicyAmendment)?.acceptWithExecpolicyAmendment?.execpolicy_amendment;
      const rule = Array.isArray(choices) ? offered : request.params.proposedExecpolicyAmendment;
      if (Array.isArray(rule) && rule.length && rule.every(word => typeof word === 'string' && word.length && !/[\x00-\x1f\x7f]/.test(word))) approval.commandRule = [...rule];
    }
    if (s.approval) { s.approvals ||= []; s.approvals.push(approval); } else s.approval = approval;
    s.state = 'approval'; this.changed(s);
  }
  respond(id: string, response: ChatResponse): ChatSession {
    const s = this.get(id), approval = s.approval;
    if (s.viewMode === 'terminal' || this.handoffs.has(id)) throw new Error('Respond in the active conversation view.'); if (!approval || String(response.requestId) !== String(approval.id)) throw new Error('This request is no longer pending.');
    let result: NativeChatReply['result'];
    if (approval.method === 'item/tool/requestUserInput') {
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of approval.params.questions || []) {
        const raw = response.answers?.[q.id];
        const values = (Array.isArray(raw) ? raw : [raw]).map(value => String(value ?? '').trim()).filter(Boolean);
        if (!values.length) throw new Error('Answer each question before continuing.');
        if (!q.multiSelect && values.length > 1) throw new Error('Choose one answer for this question.');
        if (q.optionsOnly && values.some(value => !q.options?.some(option => option.label === value))) throw new Error('Choose one of the available options.');
        answers[q.id] = { answers: values };
      }
      result = { answers };
    } else {
      const decisions: ChatResponse['decision'][] = s.engine === 'codex' ? ['accept', 'acceptForSession', 'decline'] : ['accept', 'decline'];
      if (response.decision === 'acceptWithExecpolicyAmendment' && s.engine === 'codex' && approval.commandRule) {
        // Never accept a prefix supplied by the renderer: the CLI owns the rule.
        result = { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: approval.commandRule } } };
      } else {
        if (!decisions.includes(response.decision)) throw new Error('Choose an available approval option.');
        result = { decision: response.decision };
      }
    }
    this.live.get(id)?.write!({ id: approval.id, result }); /* the transport that asked answers through write */ s.approval = s.approvals?.shift() || null; s.state = s.approval ? 'approval' : 'working'; this.changed(s); return s;
  }
  consumePendingSettings(s: ChatSession): void {
    if (!s.pendingSettings) return;
    Object.assign(s, s.pendingSettings); s.pendingSettings = null; this.changed(s);
  }
  async applyPendingSettings(s: ChatSession): Promise<void> {
    if (!s.pendingSettings) return;
    const transport = this.live.get(s.id);
    if (s.pendingSettings.permissionMode && s.engine !== 'codex' && transport) { await transport.shutdown!(); this.live.delete(s.id); } // a provider's or native terminal's transport
    this.consumePendingSettings(s);
  }
  // What a Codex chat sends: its explicit choice, or the user's own Codex
  // settings for "Use Codex settings". A policy made in the terminal sends none.
  codexPermissions(s: ChatSession, transport?: Pick<NativeChatTransport, 'inherited'>): CodexPolicy | null {
    if (s.permissionMode === 'custom') return null;
    return permissions.inherits('codex', s.permissionMode) ? transport?.inherited || permissions.codex('workspace') : permissions.codex(s.permissionMode);
  }
  setPermissions(id: string, mode: PermissionMode | undefined): Promise<ChatSession> {
    const s = this.get(id);
    permissions.validate(s.engine, mode);
    if (s.nativeTerminal && s.terminalId) throw new Error('Change permissions in the running native Terminal.');
    if (s.archived || s.viewMode === 'terminal' || this.handoffs.has(id)) throw new Error('Switch to Chat before changing permissions.');
    if (this.starting.has(id) || ['working', 'approval'].includes(s.state) || s.pendingSettings) { s.pendingSettings = { ...s.pendingSettings, permissionMode: mode }; this.changed(s); this.applyPendingFullAccess(s); return Promise.resolve(s); }
    const job = (async () => {
      const transport = this.live.get(id);
      if (transport) {
        await transport.connected;
        // Codex accepts per-turn overrides. An empty thread cannot be resumed
        // until the CLI has written its first rollout, so apply on the next turn.
        if (s.engine !== 'codex') {
          await transport.shutdown!(); this.live.delete(id); // a provider's or native terminal's transport
        }
      }
      // Reattach the idle terminal with these settings on its next appearance.
      if (s.terminalId) { this.terminal?.kill(s.terminalId); s.terminalId = null; }
      s.permissionMode = mode; this.changed(s); return s;
    })();
    this.handoffs.set(id, job);
    return job.finally(() => this.handoffs.delete(id));
  }
  setProvider(id: string, engine: ChatEngine): Promise<ChatSession> {
    const s = this.get(id);
    if (!LABELS[engine]) throw new Error('Use Terminal for this CLI.');
    if (s.archived || s.viewMode === 'terminal' || !['idle', 'error'].includes(s.state) || s.threadId || s.terminalId || s.providerPersisted || s.messages.length || s.lastSubmittedAt || s.queue?.length || this.starting.has(id) || this.handoffs.has(id) || this.stopping.has(id)) {
      throw new Error('Start a new chat to change providers. This conversation stays with its native CLI.');
    }
    if (s.engine === engine) return Promise.resolve(s);
    const job = (async () => {
      const transport = this.live.get(id);
      if (transport) { await transport.shutdown!(); this.live.delete(id); } // a Codex transport has none: an unstarted Codex chat has no live one
      for (const key of ['model', 'modelName', 'resolvedModel', 'effort', 'resolvedEffort', 'resolvedProvider', 'permissionMode', 'pendingSettings', 'error', 'recovery', 'unsupportedRequest'] as const) delete s[key];
      s.engine = engine; s.state = 'idle';
      if (s.titleAuto !== false) { s.title = LABELS[engine]; s.titleAuto = true; }
      this.changed(s); return s;
    })();
    this.handoffs.set(id, job);
    return job.finally(() => this.handoffs.delete(id));
  }
  update(id: string, patch: ChatUpdate): ChatSession | Promise<ChatSession> {
    if (Object.hasOwn(patch, 'engine')) return this.setProvider(id, patch.engine!); // an unset engine has no label, so setProvider refuses it
    if (Object.hasOwn(patch, 'permissionMode')) return this.setPermissions(id, patch.permissionMode);
    const s = this.get(id);
    // A preview save (nativeChat:savePreview) is kept quietly: no event, no new revision.
    // In shared preview mode a chat can have no view of its own, and the save carries
    // only when it was selected; the chat keeps any view it has.
    if (Object.hasOwn(patch, 'preview') || Object.hasOwn(patch, 'previewSelectedAt')) {
      if (patch.preview && typeof patch.preview === 'object') s.preview = patch.preview;
      s.previewSelectedAt = Number(patch.previewSelectedAt) || Date.now(); this.save(s); return s;
    }
    if (patch.archived === false && s.archived) { s.archived = false; s.viewMode = 'chat'; s.queuePaused = true; }
    if (typeof patch.title === 'string' && patch.title.trim()) { s.title = patch.title.trim().slice(0, 80); s.titleAuto = false; }
    if (typeof patch.pinned === 'boolean') s.recentPinnedAt = patch.pinned ? Date.now() : 0;
    if (typeof patch.keepAwake === 'boolean') { s.keepAwake = patch.keepAwake; if (s.keepAwake) clearTimeout(this.idleTimers?.get(id)); else if (s.state === 'idle' && !s.terminalId) { this.live.get(id)?.close(); this.live.delete(id); } }
    this.changed(s); return s;
  }
  async archive(id: string): Promise<ChatSession> {
    try { await this.handoffs.get(id); } catch {}
    const s = this.get(id);
    s.archived = true; s.queuePaused = true;
    clearTimeout(this.queueTimers.get(id)); this.starting.delete(id);
    if (s.nativeTerminal || this.live.get(id)?.nativeTerminal) {
      // Closing a conversation is explicit termination, unlike changing views.
      // Do not wait for a completion event from the PTY we are about to close.
      const transport = this.live.get(id);
      if (transport) { transport.pendingPrompt = null; transport.close(); this.live.delete(id); }
      const terminalId = s.terminalId; s.terminalId = null;
      if (terminalId) this.terminal?.kill(terminalId);
      s.nativePendingPrompt = null; s.nativeInputNotice = ''; s.terminalHasInput = false;
      s.state = 'idle'; s.turnId = null; s.approval = null; s.approvals = [];
    } else {
      if (s.terminalId) { const terminalId = s.terminalId; s.terminalId = null; this.terminal?.kill(terminalId); }
      await this.stop(id); this.live.get(id)?.close(); this.live.delete(id);
    }
    s.viewMode = 'chat'; this.changed(s); return s;
  }
  /**
   * Deletes a chat nobody has used (unused), like a project's first chat that
   * another chat or terminal took the screen from while it started: its CLI
   * stops, its file goes, and the window forgets it. A used chat is kept: false.
   */
  async discard(id: string): Promise<boolean> {
    try { await this.handoffs.get(id); } catch {}
    const s = this.sessions.get(id);
    if (!s) return true;
    if (!unused(s) || this.handoffs.has(id) || this.starting.has(id) || this.stopping.has(id)) return false;
    clearTimeout(this.queueTimers.get(id)); clearTimeout(this.idleTimers?.get(id));
    const transport = this.live.get(id);
    if (transport) { transport.pendingPrompt = null; transport.close(); this.live.delete(id); }
    // Unlinked first, so the pty's exit finds no chat to report it on.
    const terminalId = s.terminalId; s.terminalId = null;
    if (terminalId) this.terminal?.kill(terminalId);
    s.revision = (s.revision || 0) + 1;
    const event: ChatEvent = { ...this.payload(s), discarded: true };
    this.sessions.delete(id); this.dirty.delete(id); this.touched.delete(id); this.sent.delete(id);
    await this.writes.get(id); // a save already writing finishes first, so the file can't come back
    await fs.promises.rm(path.join(this.dir, id + '.json'), { force: true }).catch(() => {});
    this.emit(event);
    return true;
  }
  async interruptProviderTurn(s: ChatSession): Promise<void> {
    const active = this.live.get(s.id), turnId = s.turnId;
    if (!active || !turnId) throw new Error('The response is still starting. Try again in a moment.');
    s.queuePaused = true;
    clearTimeout(this.queueTimers.get(s.id));
    await active.request('turn/interrupt', { threadId: s.threadId, turnId });
    // Acknowledgement only means the CLI received Stop. Keep its turn busy
    // until completion, so a new prompt or another writer cannot race it.
    for (let attempt = 0; s.turnId === turnId && attempt < 100; attempt++) {
      if (this.live.get(s.id) !== active) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (this.live.get(s.id) !== active || s.turnId === turnId) throw new Error(s.error || 'The CLI is still stopping. Try again shortly.');
  }
  // Park chats nobody is using: stop the CLI, keep the conversation. The next
  // open or send resumes the same thread. Never parked: kept awake, on screen,
  // mid-turn, waiting on an approval, holding unsent Terminal input, or busy
  // starting, stopping or switching view. idleMs counts from the pty's last
  // output or input (without a usable one, nothing is idle); repoDir limits the
  // sweep to one project (project sleep). Returns the parked chats' ids.
  async parkIdle({ idleMs, visible = [], repoDir = null, now = Date.now() }: ParkOptions): Promise<string[]> {
    if (!this.terminal?.list || !(idleMs >= 0)) return [];
    let ptys: PtyInfo[] = [];
    try { ptys = (await this.terminal.list(repoDir || undefined)) || []; } catch { return []; }
    const byChat = new Map(ptys.filter(p => p.alive !== false && p.meta?.nativeChatId).map(p => [p.meta.nativeChatId, p]));
    const onScreen = new Set(visible);
    const parked: string[] = [];
    for (const s of this.sessions.values()) {
      if (repoDir && s.repoDir !== repoDir) continue;
      const pty = s.terminalId && byChat.get(s.id);
      if (!pty || s.archived || s.keepAwake || onScreen.has(s.id)) continue;
      if (['working', 'approval'].includes(s.state) || s.terminalHasInput || this.handoffs.has(s.id) || this.starting.has(s.id) || this.stopping.has(s.id)) continue;
      if (now - Math.max(pty.lastDataAt || 0, pty.lastInputAt || 0) < idleMs) continue;
      this.park(s);
      parked.push(s.id);
    }
    return parked;
  }
  park(s: ChatSession): void {
    clearTimeout(this.idleTimers?.get(s.id));
    const terminalId = s.terminalId;
    // Clear the link first: the pty's exit then finds no session and is not
    // reported as a crash ("The native CLI exited…").
    s.terminalId = null; s.terminalEndpoint = null; s.turnId = null; s.nativeInputNotice = ''; s.error = ''; s.state = 'idle'; s.parkedAt = Date.now();
    if (terminalId) this.terminal?.kill(terminalId);
    this.live.get(s.id)?.close(); this.live.delete(s.id);
    this.changed(s);
  }
  stop(id: string): Promise<ChatSession> {
    if (this.stopping.has(id)) return this.stopping.get(id)!;
    const job = this.stopTurn(id);
    this.stopping.set(id, job);
    return job.finally(() => this.stopping.delete(id));
  }
  async stopTurn(id: string): Promise<ChatSession> {
    this.starting.delete(id);
    clearTimeout(this.queueTimers.get(id)); this.get(id).queuePaused = true;
    const s = this.get(id), transport = this.live.get(id);
    if (transport?.nativeTerminal && transport.pendingPrompt) {
      if (transport.pendingPrompt.delivering) s.terminalHasInput = true;
      transport.pendingPrompt = null; transport.turnId = null; s.nativePendingPrompt = null; s.nativeInputNotice = s.terminalHasInput ? 'Your unsent message is still in Terminal.' : '';
    } else if (transport && s.turnId) {
      if (s.engine === 'codex') await transport.request('turn/interrupt', { threadId: s.threadId, turnId: s.turnId });
      else await this.interruptProviderTurn(s);
    } else if (transport && !transport.nativeTerminal) {
      if (s.engine !== 'codex') await transport.shutdown!(); else transport.close(); // not a native terminal and not Codex: a provider's transport, which has shutdown
      this.live.delete(id);
    }
    s.state = 'idle'; s.approval = null; s.approvals = []; s.turnId = null; this.changed(s); return s;
  }
  close(): void { this.closing = true; const unsaved = new Set([...this.dirty, ...this.writes.keys(), ...this.live.keys(), ...[...this.sessions.values()].filter(s => s.terminalId).map(s => s.id)]); for (const timer of this.queueTimers.values()) clearTimeout(timer); for (const timer of this.idleTimers?.values() || []) clearTimeout(timer); for (const s of this.sessions.values()) if (s.terminalId && !s.nativeTerminal) this.terminal?.kill(s.terminalId); for (const t of this.live.values()) t.close(); this.live.clear(); clearTimeout(this.saveTimer as NodeJS.Timeout | undefined); this.saveTimer = null; for (const id of unsaved) this.writeSync(id); this.dirty.clear(); } // chats with a live CLI too: transports set some fields directly
}
export { NativeChat, CodexTransport, itemMessage, readRollout, capDetail };
