// Provider adapters talk only to installed CLIs over stdio. Authentication,
// tools, project rules and model access remain owned by each CLI.
import { spawn } from 'child_process';
import type { ChildProcessByStdio } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Readable, Writable } from 'stream';
import { randomUUID, createHash } from 'crypto';
import { childEnv, claudeBin } from '../env';
import * as cursor from '../cursor';
import * as permissions from '../../shared/chatPermissions';
import type { ChatEngine, PermissionModeId } from '../../shared/chatPermissions';
import type { ChatApproval, ChatApprovalMethod, ChatModel, ChatQuestion, ChatResponse, ChatSession } from '../../shared/radialApi';

/** The CLIs these adapters drive. Codex has its own transport (nativeChat's CodexTransport). */
export type ProviderEngine = Exclude<ChatEngine, 'codex'>;
/** A request's id: Claude's control request_id, or a JSON-RPC id from Cursor. nativeChat copies it into a ChatApproval. */
export type RequestId = ChatApproval['id'];
/** A part of a prompt from nativeChat: the text, or an attached image file. */
export type ProviderInputPart = { type: 'text'; text: string } | { type: 'localImage'; path: string };
/** A part of a user message item: text, or an attached image as Claude's API takes it. */
export type ProviderUserContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string | undefined; data: string } };
/**
 * A conversation item in Codex app-server's shape, the one nativeChat renders:
 * a user message (content), an agent message (text) or a tool call.
 */
export interface ProviderItem {
  id: string;
  type: 'userMessage' | 'agentMessage' | 'mcpToolCall';
  /** A user message's text and images. */
  content?: ProviderUserContent[];
  /** An agent message's text. */
  text?: string;
  /** A tool call's tool name (Claude's tool_use name, Cursor's title). */
  tool?: string;
  /** A tool call's input as JSON (Codex's MCP server field, reused for display). */
  server?: string;
  /** A tool call's output as text. */
  result?: string;
  /** A tool call's state: 'inProgress', 'completed', 'failed', or Cursor's own status passed through. */
  status?: string;
}
/** An item and the turn it belongs to (thread/items/list's entries). */
export interface ProviderItemEntry { item: ProviderItem; turnId?: string }
/** Each event's params, by method, before the transport adds its threadId. */
export interface ProviderEventParams {
  'item/started': { item: ProviderItem; turnId?: string };
  'item/completed': { item: ProviderItem; turnId?: string };
  'item/agentMessage/delta': { itemId: string; turnId?: string; delta: string };
  'turn/completed': { turn: { id?: string } };
  'error': { error: { message: string } };
  'transport/error': { message: string };
}
export type ProviderEventMethod = keyof ProviderEventParams;
/** An event for nativeChat (onEvent), in Codex app-server's notification shape. */
export type ProviderEvent = { [M in ProviderEventMethod]: { method: M; params: ProviderEventParams[M] & { threadId: string | null | undefined } } }[ProviderEventMethod];
/** A CLI request nativeChat answers with write(): an approval (what to approve) or questions, in Codex app-server's shape. */
export type ProviderRequest =
  | { id: RequestId; method: Extract<ChatApprovalMethod, 'item/commandExecution/requestApproval'>; params: { command: string } }
  | { id: RequestId; method: Extract<ChatApprovalMethod, 'item/tool/requestUserInput'>; params: { questions: ChatQuestion[] } };
/** nativeChat's answer to a ProviderRequest, a JSON-RPC response in Codex app-server's shape. */
export interface ProviderReply {
  id: RequestId;
  /** The approval's decision, or each question's answers by question id. */
  result?: { decision?: ChatResponse['decision']; answers?: Record<string, { answers?: string[] }> };
  error?: { code: number; message: string };
}
/** request()'s params as nativeChat sends them (Codex app-server's): providers read these and ignore the rest. */
export interface ProviderRequestParams { threadId?: string | null; model?: string; input?: ProviderInputPart[]; [field: string]: unknown }
/** turn/start's params, the one method whose params differ: it must carry the prompt (request()'s first overload). */
export type ProviderTurnParams = ProviderRequestParams & { input: ProviderInputPart[] };
/** thread/start and thread/resume's answer: the conversation's id, and the model Cursor reports. */
export interface ProviderThread { thread: { id: string }; model?: string; modelName?: string }
/** request()'s answer, by method. Any other method throws. */
export interface ProviderResults {
  'model/list': { data: ChatModel[]; nextCursor: null };
  'thread/start': ProviderThread;
  'thread/resume': ProviderThread;
  'thread/items/list': { data: ProviderItemEntry[]; nextCursor: null };
  'turn/interrupt': Record<string, never>;
  'turn/start': { turn: { id: string } };
}
export type ProviderMethod = keyof ProviderResults;
/** The chat a transport serves (nativeChat's session): read for its thread and settings, and marked providerPersisted once the CLI has saved it. Every read is guarded, so any field may be missing (the tests pass partial sessions). */
export type ProviderSession = Partial<Pick<ChatSession, 'threadId' | 'model' | 'permissionMode' | 'providerPersisted' | 'messages'>>;
/** What a provider transport is started with. nativeChat passes more fields, which the transport copies but doesn't read. */
export interface ProviderOptions {
  engine: ProviderEngine;
  cwd: string;
  env?: NodeJS.ProcessEnv | null;
  /** Left out to only list models (nativeChat's catalog discovery). */
  session?: ProviderSession;
  /** Radial's project context: Claude's appended system prompt, or sent with Cursor's first prompt. */
  contextText?: string;
  onEvent: (event: ProviderEvent) => void;
  onRequest: (request: ProviderRequest) => void;
}

/** A call() waiting for its answer; the session/prompt call has no timer. */
interface PendingCall { resolve(result: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout | null }
/** Content that may hold text: a string, or blocks whose text is joined. */
type TextContent = string | readonly { type?: string; text?: string }[] | null | undefined;

// ── Claude Code's stream-json (and its saved transcript), as Radial reads it ──
/** A block of a Claude message's content: Radial reads text, tool calls and their results. */
export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input?: unknown }
  | { type: 'tool_result'; tool_use_id: string; content?: string | ClaudeContentBlock[]; is_error?: boolean }
  | { type: 'image' | 'document' | 'thinking' | 'redacted_thinking' };
/** What claudeItems reads from a line: any stream-json line, or a record of the saved transcript (claudeHistory, interactive.ts). */
export interface ClaudeRecord {
  type: string;
  uuid?: string;
  sessionId?: string;
  /** A transcript record's API request: its item's turn in history. */
  requestId?: string;
  parent_tool_use_id?: string | null;
  isSidechain?: boolean;
  message?: { id?: string; content?: string | ClaudeContentBlock[] };
}
/** One of AskUserQuestion's questions. */
interface ClaudeQuestion { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }
/** A can_use_tool control request: a permission prompt, or AskUserQuestion's questions. */
interface ClaudeToolPermission { subtype: 'can_use_tool'; tool_name: string; input: { questions?: ClaudeQuestion[]; [field: string]: unknown } }
/** The stream events Radial reads (Anthropic's streaming API): a message's start, for its id, and its text deltas. receive() guards a missing delta. */
type ClaudeStreamEvent =
  | { type: 'message_start'; message: { id: string } }
  | { type: 'content_block_delta'; delta?: { type: 'text_delta'; text: string } | { type: 'input_json_delta' | 'thinking_delta' | 'signature_delta' } }
  | { type: 'content_block_start' | 'content_block_stop' | 'message_delta' | 'message_stop' | 'ping' };
/** A stream-json line from Claude Code, by type. receive() guards a missing response or event. `request` stays required although receive() reads `m.request || {}`: an optional one would widen that to `{}`. */
type ClaudeLine =
  | (ClaudeRecord & { type: 'control_response'; response?: { subtype: 'success' | 'error'; request_id: string; response?: unknown; error?: string } })
  | (ClaudeRecord & { type: 'control_request'; request_id: string; request: ClaudeToolPermission | { subtype: 'hook_callback' | 'mcp_message' } })
  | (ClaudeRecord & { type: 'stream_event'; event?: ClaudeStreamEvent })
  | (ClaudeRecord & { type: 'user' | 'assistant'; error?: string })
  | (ClaudeRecord & { type: 'result'; is_error?: boolean; errors?: string[]; result?: string })
  | (ClaudeRecord & { type: 'system' });
/** Claude Code's initialize answer: the models it offers. */
interface ClaudeInit { models?: { value: string; displayName: string }[] }

// ── Cursor's ACP (JSON-RPC over `cursor-agent acp`), as Radial reads it ──
/** A content block of a message chunk; Radial shows only text. */
type AcpContentBlock = { type: 'text'; text: string } | { type: 'image' | 'audio' | 'resource' | 'resource_link' };
/**
 * A tool call's output, by type: content (Radial shows its text), an edit's
 * diff (the file's path and its text before, null for a new file, and after:
 * Cursor sends the whole file, or its changed hunks), or a terminal.
 */
type AcpToolCallContent =
  | { type: 'content'; content?: { type: string; text?: string } }
  | { type: 'diff'; path: string; oldText?: string | null; newText?: string }
  | { type: 'terminal'; terminalId?: string };
/** A session/update, by kind: message chunks and tool calls show in the chat, the rest is ignored. */
type CursorSessionUpdate =
  | { sessionUpdate: 'user_message_chunk' | 'agent_message_chunk'; content: AcpContentBlock | ProviderInputPart }
  | { sessionUpdate: 'tool_call' | 'tool_call_update'; toolCallId: string; title?: string | null; rawInput?: unknown; content?: AcpToolCallContent[] | null; status?: string | null }
  | { sessionUpdate: 'agent_thought_chunk' | 'plan' | 'available_commands_update' | 'current_mode_update' };
/** A permission option: allow or reject, once or always. */
interface AcpPermissionOption { optionId: string; name?: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }
/** session/request_permission's params: the tool call to approve and the options to answer with. */
interface CursorPermissionParams { sessionId?: string; toolCall: { title?: string | null; rawInput?: unknown }; options: AcpPermissionOption[] }
/** One of cursor/ask_question's questions; its options are the only answers. Cursor sends a list, maybe empty; receive() and write() also take none. */
interface CursorQuestion { id: string; prompt: string; options?: { id: string; label: string }[]; multiSelect?: boolean }
/** A Cursor request waiting for nativeChat's answer, which write() turns into the reply. */
type CursorPending =
  | { plan: true; questions?: undefined }
  | { questions: CursorQuestion[]; plan?: undefined }
  | (CursorPermissionParams & { plan?: undefined; questions?: undefined });
/** A line from `cursor-agent acp` that receive() handles: the answer to a call(), a session update, or a request. Other requests reach its last line, which refuses them. */
type CursorMessage =
  | { id: RequestId; method?: undefined; result?: unknown; error?: { code?: number; message: string } }
  | { id?: undefined; method: 'session/update'; params: { sessionId?: string; update: CursorSessionUpdate } }
  | { id: RequestId; method: 'session/request_permission'; params: CursorPermissionParams }
  | { id: RequestId; method: 'cursor/create_plan'; params: { plan?: string; overview?: string } }
  | { id: RequestId; method: 'cursor/ask_question'; params: { questions: CursorQuestion[] } };
/** A block of a session/prompt: text, or an image when Cursor takes them. */
type AcpPromptBlock = { type: 'text'; text: string } | { type: 'image'; mimeType: string | undefined; data: string };
/** Cursor's initialize answer: whether a prompt may carry images. */
interface CursorInit { agentCapabilities?: { promptCapabilities?: { image?: boolean } } }
/** session/new and session/load's answer: the new session's id (session/load has none) and the models. */
interface CursorSession { sessionId?: string; models?: { currentModelId?: string; availableModels?: { modelId: string; name: string }[] } }

function imagePart(part: Extract<ProviderInputPart, { type: 'localImage' }>): { mime: string | undefined; data: string } { const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as Partial<Record<string, string>>)[path.extname(part.path).toLowerCase()]; return { mime, data: fs.readFileSync(part.path).toString('base64') }; }
const LABELS: Record<ChatEngine, string> = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor' };
function binary(engine: ProviderEngine): string | null {
  const fixture = process.env.RADIAL_USERDATA && process.env['RADIAL_CHAT_TEST_' + engine.toUpperCase()];
  return fixture || (engine === 'claude' ? claudeBin() : cursor.bin());
}
function modelEntry(value: string, label: string = value): ChatModel { return { model: value, displayName: label, supportedReasoningEfforts: [] }; }
function textContent(content: TextContent): string { return typeof content === 'string' ? content : (content || []).map(c => c.text || '').filter(Boolean).join('\n'); }
/**
 * An edit's output as one line, the way the chat reads a file change: the file
 * (from the project's folder when it's inside it) and the lines added and
 * removed, as Radial's review panel counts them: "src/pages/index.astro · +3 −1".
 */
function editLine(cwd: string, change: Extract<AcpToolCallContent, { type: 'diff' }>): string {
  const { added, removed } = lineChanges(change.oldText || '', change.newText || '');
  const relative = path.relative(cwd, path.resolve(cwd, String(change.path || '')));
  const file = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : change.path;
  return `${file} · +${added} −${removed}`;
}
/**
 * The lines one text became another by, as a line diff counts them: the
 * fewest added plus removed (Myers' algorithm, after the lines both keep at
 * the start and the end). A change so large it would take long to search
 * counts every line between those kept ends instead.
 */
function lineChanges(before: string, after: string): { added: number; removed: number } {
  const lines = (text: string) => text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  const a = lines(before), b = lines(after);
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  // Each step of d costs up to n + m comparisons: a few million at most.
  const limit = Math.min(n + m, Math.max(64, Math.floor(4e6 / (n + m + 1))));
  const furthest = new Int32Array(2 * limit + 2); // the furthest x reached on each diagonal k = x - y, at index limit + k
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && furthest[limit + k - 1] < furthest[limit + k + 1]) ? furthest[limit + k + 1] : furthest[limit + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) { x++; y++; }
      furthest[limit + k] = x;
      if (x >= n && y >= m) return { added: (d + m - n) / 2, removed: (d - m + n) / 2 };
    }
  }
  return { added: m, removed: n };
}
abstract class JsonProcess<Message, Pending> {
  declare engine: ProviderEngine;
  declare cwd: string;
  declare env?: NodeJS.ProcessEnv | null;
  declare session?: ProviderSession;
  declare contextText?: string;
  declare onEvent: (event: ProviderEvent) => void;
  declare onRequest: (request: ProviderRequest) => void;
  declare bin: string;
  declare startedAt: number;
  declare pending: Map<string, PendingCall>;
  declare permissions: Map<RequestId, Pending>;
  declare items: Map<string, ProviderItemEntry>;
  declare seq: number;
  declare child: ChildProcessByStdio<Writable, Readable, Readable>;
  declare stderr: string;
  declare lines: readline.Interface;
  declare exited: Promise<number | null>;
  declare closing?: boolean;
  declare threadId?: string | null;
  declare turnId?: string;
  /** While Cursor replays a loaded session: items are recorded without events. */
  declare loadingHistory?: boolean;
  /** Set by nativeChat.connect: settles once the CLI is initialized and its thread started or resumed. */
  declare connected?: Promise<void>;
  abstract receive(message: Message): void;
  constructor(options: ProviderOptions, bin: string | null, args: string[]) {
    if (!bin) throw new Error(`Install ${LABELS[options.engine]} CLI and sign in first.`);
    Object.assign(this, options); this.cwd = fs.realpathSync(options.cwd); this.bin = bin; this.startedAt = Date.now(); this.pending = new Map(); this.permissions = new Map(); this.items = new Map(); this.seq = 0;
    this.child = spawn(bin, args, { cwd: options.cwd, env: childEnv(options.env), stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderr = ''; this.child.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-2000); });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => { let m: Message; try { m = JSON.parse(line); } catch { return; } try { this.receive(m); } catch (error) { this.fail(error as Error); } });
    this.exited = new Promise<number | null>(resolve => this.child.once('exit', resolve));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', code => { if (!this.closing) this.fail(new Error(this.stderr || `${LABELS[this.engine]} CLI exited (${code}).`)); });
    this.child.stdin.on('error', error => { if (!this.closing) this.fail(error); });
  }
  raw(message: Record<string, unknown>): void { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = String(++this.seq);
    return new Promise<unknown>((resolve, reject) => {
      const timer = method === 'session/prompt' ? null : setTimeout(() => { this.pending.delete(id); reject(new Error(`${LABELS[this.engine]} timed out: ${method}`)); }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      this.raw(this.engine === 'claude' ? { type: 'control_request', request_id: id, request: { subtype: method, ...params } } : { jsonrpc: '2.0', id, method, params });
    });
  }
  resolve(id: RequestId | undefined, result: unknown, error?: string | { message: string } | null): void { const p = this.pending.get(String(id)); if (!p) return; this.pending.delete(String(id)); clearTimeout(p.timer as NodeJS.Timeout | undefined); error ? p.reject(new Error(typeof error === 'string' ? error : error.message)) : p.resolve(result); } // a null timer is a no-op; @types/node leaves null out
  event<M extends ProviderEventMethod>(method: M, params: ProviderEventParams[M]): void;
  event(method: ProviderEventMethod, params: ProviderEventParams[ProviderEventMethod] | Record<string, never> = {}): void { this.onEvent({ method, params: { threadId: this.threadId, ...params } } as ProviderEvent); }
  item(item: ProviderItem, completed = true): void { this.items.set(item.id, { item, turnId: this.turnId }); if (!this.loadingHistory) this.event(completed ? 'item/completed' : 'item/started', { item, turnId: this.turnId }); }
  fail(error: Error): void { for (const p of this.pending.values()) { clearTimeout(p.timer as NodeJS.Timeout | undefined); p.reject(error); } this.pending.clear(); if (!this.closing) this.event('transport/error', { message: error.message }); }
  close(): void { this.closing = true; this.fail(new Error('Chat stopped.')); this.child.kill('SIGTERM'); this.lines.close(); }
  async shutdown(): Promise<void> { this.close(); let timer: NodeJS.Timeout | undefined; await Promise.race([this.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The CLI is still closing. Try again shortly.')), 5000); })]).finally(() => clearTimeout(timer)); }
}
// A user record's text is named by its uuid, an assistant message's by its API id.
// Both are optional on the wire, so a record with neither is skipped: as an item
// with no id it would merge with the next one that has none.
function claudeItems(record: ClaudeRecord): ProviderItem[] {
  if (record.parent_tool_use_id || record.isSidechain || !record.message) return [];
  const message = record.message, content = message.content;
  if (record.type === 'user' && (typeof content === 'string' || content?.some(c => c.type === 'text'))) { const id = record.uuid || message.id; return id ? [{ id, type: 'userMessage', content: [{ type: 'text', text: textContent(content) }] }] : []; }
  const items: ProviderItem[] = [];
  if (record.type === 'assistant') {
    const text = textContent(content), id = message.id || record.uuid; if (text && id) items.push({ id, type: 'agentMessage', text });
    for (const c of (content || []) as ClaudeContentBlock[]) if (c.type === 'tool_use') items.push({ id: c.id, type: 'mcpToolCall', tool: c.name, server: JSON.stringify(c.input || {}), status: 'inProgress' }); // an assistant message's content is blocks
  }
  if (record.type === 'user' && Array.isArray(content)) for (const c of content) if (c.type === 'tool_result') items.push({ id: c.tool_use_id, type: 'mcpToolCall', result: textContent(c.content), status: c.is_error ? 'failed' : 'completed' });
  return items;
}
async function claudeHistory(cwd: string, threadId: string): Promise<ProviderItemEntry[]> {
  if (!/^[a-f0-9-]{36}$/i.test(threadId)) throw new Error('Invalid Claude conversation ID.');
  const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const filename = path.join(root, 'projects', fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'), threadId + '.jsonl');
  let text; try { text = await fs.promises.readFile(filename, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const items = new Map<string, ProviderItemEntry>();
  for (const line of text.split('\n')) {
    let record: ClaudeRecord; try { record = JSON.parse(line); } catch { continue; }
    if (record.sessionId && record.sessionId !== threadId) continue;
    for (const item of claudeItems(record)) if (item.id) items.set(item.id, { item: { ...items.get(item.id)?.item, ...item }, turnId: record.requestId });
  }
  return [...items.values()];
}
class ClaudeTransport extends JsonProcess<ClaudeLine, ClaudeToolPermission> {
  declare threadId: string;
  declare init?: ClaudeInit;
  /** The API id of the assistant message streaming now: its text deltas' item. */
  declare messageId?: string;
  constructor(options: ProviderOptions) {
    const session = options.session;
    const args = [...permissions.args('claude', options.session?.permissionMode as PermissionModeId | undefined), '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--replay-user-messages']; // 'custom' is Codex's alone; args() throws on it
    const threadId = session?.threadId || randomUUID();
    args.push(session?.providerPersisted ? '--resume' : '--session-id', threadId);
    if (session?.model) args.push('--model', session.model);
    if (options.contextText) args.push('--append-system-prompt', options.contextText);
    super({ ...options, engine: 'claude' }, binary('claude'), args); this.threadId = threadId;
  }
  async initialize(): Promise<void> { this.init = await this.call('initialize') as ClaudeInit; /* Claude Code's initialize answer, trusted as the CLI sends it */ }
  override receive(m: ClaudeLine): void {
    if (m.type === 'control_response') { this.resolve(m.response?.request_id, m.response?.response, m.response?.subtype === 'error' ? m.response.error : null); return; }
    if (m.type === 'control_request') {
      const r = m.request || {};
      if (r.subtype !== 'can_use_tool') { this.raw({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Unsupported Radial CLI request.' } }); return; }
      this.permissions.set(m.request_id, r);
      if (r.tool_name === 'AskUserQuestion') this.onRequest({ id: m.request_id, method: 'item/tool/requestUserInput', params: { questions: (r.input.questions || []).map((q, i) => ({ ...q, id: String(i) })) } });
      else this.onRequest({ id: m.request_id, method: 'item/commandExecution/requestApproval', params: { command: r.tool_name + '\n' + JSON.stringify(r.input || {}, null, 2) } }); return;
    }
    if (m.type === 'stream_event' && !m.parent_tool_use_id) {
      const e = m.event;
      if (e?.type === 'message_start') this.messageId = e.message.id;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && this.messageId) this.event('item/agentMessage/delta', { itemId: this.messageId, turnId: this.turnId, delta: e.delta.text });
    }
    if (this.session && ['assistant', 'user'].includes(m.type) && m.message) this.session.providerPersisted = true;
    for (const item of claudeItems(m)) { const previous = this.items.get(item.id)?.item; this.item({ ...previous, ...item }); }
    if (m.type === 'assistant' && m.error) this.event('error', { error: { message: textContent(m.message?.content) || m.error } });
    if (m.type === 'result') {
      if (this.session) this.session.providerPersisted = true;
      if (m.is_error) this.event('error', { error: { message: m.errors?.join('\n') || m.result || 'Claude could not finish this turn.' } });
      this.event('turn/completed', { turn: { id: this.turnId } });
    }
  }
  // Keep identical to CursorTransport's overloads: calls on ClaudeTransport | CursorTransport resolve to them only while both match.
  request(method: 'turn/start', params: ProviderTurnParams): Promise<ProviderResults['turn/start']>;
  request<M extends Exclude<ProviderMethod, 'turn/start'>>(method: M, params?: ProviderRequestParams): Promise<ProviderResults[M]>;
  /** Any other method (or a turn/start without its prompt): it throws (rejects), as an unknown one always did. */
  request(method: string, params?: ProviderRequestParams): Promise<unknown>;
  async request(method: string, params: ProviderRequestParams = {}): Promise<ProviderResults[ProviderMethod]> {
    if (method === 'model/list') return { data: (this.init?.models || []).map(m => modelEntry(m.value, m.displayName)), nextCursor: null };
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: this.threadId } };
    if (method === 'thread/items/list') return { data: await claudeHistory(this.cwd, this.threadId), nextCursor: null };
    if (method === 'turn/interrupt') { await this.call('interrupt'); return {}; }
    if (method === 'turn/start') {
      if (params.model) await this.call('set_model', { model: params.model });
      this.turnId = randomUUID(); const uuid = randomUUID(); const content: ProviderUserContent[] = params.input!.map(part => { if (part.type !== 'localImage') return { type: 'text', text: part.text }; const image = imagePart(part); return { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } }; }); // ProviderTurnParams requires the prompt
      this.item({ id: uuid, type: 'userMessage', content });
      this.raw({ type: 'user', uuid, session_id: this.threadId, message: { role: 'user', content }, parent_tool_use_id: null });
      return { turn: { id: this.turnId } };
    }
    throw new Error(`Unsupported Claude operation: ${method}`);
  }
  write(message: ProviderReply): void {
    const permission = this.permissions.get(message.id); if (!permission) return;
    this.permissions.delete(message.id);
    if (permission.tool_name === 'AskUserQuestion' && message.result?.answers) {
      const answers = Object.fromEntries((permission.input.questions || []).map((q, i) => [q.question, (message.result!.answers![String(i)]?.answers || []).join(', ')])); // checked above; message isn't reassigned
      this.raw({ type: 'control_response', response: { subtype: 'success', request_id: message.id, response: { behavior: 'allow', updatedInput: { ...permission.input, answers } } } }); return;
    }
    this.raw({ type: 'control_response', response: { subtype: 'success', request_id: message.id, response: message.result?.decision === 'accept' ? { behavior: 'allow', updatedInput: permission.input } : { behavior: 'deny', message: 'Declined in Radial.' } } });
  }
}
// Cursor currently uses the same store format at two different paths. Link only
// a Radial-created ACP session, after its writer exits. Never copy or replace a
// native conversation. Unknown layouts/versions fail closed instead of forking.
async function linkCursorStore(cwd: string, threadId: string, root: string, { allowEmpty = false }: { allowEmpty?: boolean } = {}): Promise<void> {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(threadId)) throw new Error('Invalid Cursor conversation ID.');
  const repo = await fs.promises.realpath(cwd);
  const source = path.join(root, 'acp-sessions', threadId);
  const meta = JSON.parse(await fs.promises.readFile(path.join(source, 'meta.json'), 'utf8')) as { schemaVersion?: number; cwd?: string };
  if (meta.schemaVersion !== 1 || meta.cwd !== repo) throw new Error('Cursor conversation storage has changed. Continue in Chat.');
  let db: fs.promises.FileHandle | undefined;
  try { db = await fs.promises.open(path.join(source, 'store.db'), 'r'); }
  catch (error) {
    // A brand-new ACP session has only its native meta.json. Cursor's terminal
    // creates store.db at the shared path when resuming this same session ID.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowEmpty) throw new Error('Cursor has not saved this conversation yet. Continue in Chat and try Terminal after the response finishes.');
  }
  if (db) try {
    const header = Buffer.alloc(16); await db.read(header, 0, 16, 0);
    if (header.toString() !== 'SQLite format 3\0') throw new Error('Cursor conversation storage is not compatible with Terminal.');
  } finally { await db.close(); }
  const destination = path.join(root, 'chats', createHash('md5').update(repo).digest('hex'), threadId);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  try { await fs.promises.symlink(source, destination, 'dir'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = await fs.promises.lstat(destination);
    if (!stat.isSymbolicLink() || await fs.promises.realpath(destination) !== await fs.promises.realpath(source)) {
      throw new Error('Cursor already has separate terminal history for this conversation. Continue in Chat; neither history was changed.');
    }
  }
}
class CursorTransport extends JsonProcess<CursorMessage, CursorPending> {
  declare init?: CursorInit;
  declare historySeq: number;
  /** The kind of message the last text chunk extended; null after a tool call or a new turn. */
  declare lastRole?: 'userMessage' | 'agentMessage' | null;
  /** The item the current message's chunks build; set with lastRole by the first chunk, before anything reads it. */
  declare textId: string;
  constructor(options: ProviderOptions) { super({ ...options, engine: 'cursor' }, binary('cursor'), [...(options.session?.permissionMode === 'full' ? ['--force'] : []), 'acp']); this.historySeq = 0; }
  async initialize(): Promise<void> { this.init = await this.call('initialize', { protocolVersion: 1, clientCapabilities: { _meta: { parameterizedModelPicker: true } }, clientInfo: { name: 'radial', version: '1' } }) as CursorInit; /* Cursor's initialize answer, trusted as the CLI sends it */ }
  override receive(m: CursorMessage): void {
    if (!m.method) { this.resolve(m.id, m.result, m.error); return; }
    if (m.method === 'session/update') { this.update(m.params.update); return; }
    if (m.id === undefined) return;
    if (m.method === 'session/request_permission') {
      this.permissions.set(m.id, m.params);
      const call = m.params.toolCall;
      this.onRequest({ id: m.id, method: 'item/commandExecution/requestApproval', params: { command: call.title || JSON.stringify(call.rawInput || {}) } }); return;
    }
    if (m.method === 'cursor/create_plan') {
      this.permissions.set(m.id, { plan: true });
      this.onRequest({ id: m.id, method: 'item/commandExecution/requestApproval', params: { command: m.params.plan || m.params.overview || 'Approve plan' } }); return;
    }
    if (m.method === 'cursor/ask_question') {
      this.permissions.set(m.id, { questions: m.params.questions });
      this.onRequest({ id: m.id, method: 'item/tool/requestUserInput', params: { questions: m.params.questions.map(q => ({ ...q, question: q.prompt, optionsOnly: true, multiSelect: !!q.multiSelect, options: (q.options || []).map(o => ({ label: o.label, description: o.id })) })) } }); return;
    }
    this.raw({ jsonrpc: '2.0', id: (m as CursorMessage).id, error: { code: -32601, message: 'Unsupported Radial CLI request.' } }); // a request for a method CursorMessage doesn't list
  }
  update(u: CursorSessionUpdate): void {
    if (u.sessionUpdate === 'user_message_chunk' || u.sessionUpdate === 'agent_message_chunk') {
      if (u.content?.type !== 'text') return;
      const role = u.sessionUpdate === 'user_message_chunk' ? 'userMessage' : 'agentMessage';
      if (this.lastRole !== role) { this.textId = 'cursor-message-' + (++this.historySeq); this.lastRole = role; }
      const previous = this.items.get(this.textId)?.item;
      const text = (previous?.text || textContent(previous?.content)) + u.content.text;
      this.item(role === 'userMessage' ? { id: this.textId, type: role, content: [{ type: 'text', text }] } : { id: this.textId, type: role, text });
    } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      this.lastRole = null;
      const previous = this.items.get(u.toolCallId)?.item;
      this.item({ ...previous, id: u.toolCallId, type: 'mcpToolCall', tool: u.title || previous?.tool || 'Tool', server: u.rawInput ? JSON.stringify(u.rawInput) : previous?.server || '', result: u.content ? u.content.map(c => c.type === 'diff' ? editLine(this.cwd, c) : ('content' in c && c.content?.text) || '').join('\n') : previous?.result, status: (['pending', 'in_progress'] as (string | null | undefined)[]).includes(u.status) ? 'inProgress' : u.status || previous?.status });
    }
  }
  // Keep identical to ClaudeTransport's overloads: calls on ClaudeTransport | CursorTransport resolve to them only while both match.
  request(method: 'turn/start', params: ProviderTurnParams): Promise<ProviderResults['turn/start']>;
  request<M extends Exclude<ProviderMethod, 'turn/start'>>(method: M, params?: ProviderRequestParams): Promise<ProviderResults[M]>;
  /** Any other method (or a turn/start without its prompt): it throws (rejects), as an unknown one always did. */
  request(method: string, params?: ProviderRequestParams): Promise<unknown>;
  async request(method: string, params: ProviderRequestParams = {}): Promise<ProviderResults[ProviderMethod]> {
    if (method === 'model/list') { const result = await this.call('cursor/list_available_models') as { models?: { value: string; name: string }[] }; return { data: (result.models || []).map(m => modelEntry(m.value, m.name)), nextCursor: null }; } // Cursor's model list, trusted as the CLI sends it
    if (method === 'thread/start' || method === 'thread/resume') {
      this.items.clear(); this.historySeq = 0; this.lastRole = null; this.threadId = params.threadId; this.loadingHistory = true;
      const result = await this.call(params.threadId ? 'session/load' : 'session/new', { cwd: this.cwd, mcpServers: [], ...(params.threadId ? { sessionId: params.threadId } : {}) }) as CursorSession; // ACP's session/new or session/load answer, trusted as the CLI sends it
      this.threadId ||= result.sessionId; this.loadingHistory = false;
      await this.call('session/set_mode', { sessionId: this.threadId, modeId: this.session?.permissionMode === 'plan' ? 'plan' : 'agent' });
      const model = result.models?.currentModelId;
      return { thread: { id: this.threadId! }, model, modelName: result.models?.availableModels?.find(item => item.modelId === model)?.name }; // the loaded id, or session/new's
    }
    if (method === 'thread/items/list') return { data: [...this.items.values()], nextCursor: null };
    if (method === 'turn/interrupt') { this.raw({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.threadId } }); return {}; }
    if (method === 'turn/start') {
      if (params.model) await this.call('session/set_model', { sessionId: this.threadId, modelId: params.model });
      this.turnId = randomUUID(); this.lastRole = null;
      // ACP does not echo a locally submitted user prompt in every version.
      for (const content of params.input!) this.update({ sessionUpdate: 'user_message_chunk', content }); // ProviderTurnParams requires the prompt
      const turnId = this.turnId;
      this.call('session/prompt', { sessionId: this.threadId, prompt: [...params.input!.flatMap<AcpPromptBlock>(part => { if (part.type !== 'localImage') return [{ type: 'text', text: part.text }]; if (!this.init?.agentCapabilities?.promptCapabilities?.image) return []; const image = imagePart(part); return [{ type: 'image', mimeType: image.mime, data: image.data }]; }), ...(!this.session?.providerPersisted && this.contextText ? [{ type: 'text', text: this.contextText }] : [])] }).then(() => { if (this.session) this.session.providerPersisted = true; this.event('turn/completed', { turn: { id: turnId } }); }, (error: Error) => { if (!this.closing) { this.event('error', { error: { message: error.message } }); this.event('turn/completed', { turn: { id: turnId } }); } });
      return { turn: { id: turnId } };
    }
    throw new Error(`Unsupported Cursor operation: ${method}`);
  }
  write(message: ProviderReply): void {
    const request = this.permissions.get(message.id); if (!request) return; this.permissions.delete(message.id);
    let result;
    if (request.plan) result = { outcome: { outcome: message.result?.decision === 'accept' ? 'accepted' : 'rejected' } };
    else if (request.questions) result = { outcome: { outcome: 'answered', answers: request.questions.map(q => ({ questionId: q.id, selectedOptionIds: (q.options || []).filter(o => message.result?.answers?.[q.id]?.answers?.includes(o.label)).map(o => o.id) })) } };
    else { const kind = message.result?.decision === 'accept' ? 'allow_once' : 'reject_once'; const option = request.options.find(o => o.kind === kind || o.optionId === kind.replace('_', '-')); result = { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } }; }
    this.raw({ jsonrpc: '2.0', id: message.id, result });
  }
}
function providerTransport(options: ProviderOptions): ClaudeTransport | CursorTransport { return options.engine === 'claude' ? new ClaudeTransport(options) : new CursorTransport(options); }
export { binary, LABELS, providerTransport, claudeHistory, claudeItems, ClaudeTransport, CursorTransport, linkCursorStore };
