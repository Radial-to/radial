// A native interactive CLI owns the PTY for its entire lifetime. Chat observes
// the CLI's transcript/hooks; changing views never transfers process ownership.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Terminal } from '@xterm/headless';
import { childEnv } from '../env';
import * as projectData from '../projectData';
import * as permissions from '../../shared/chatPermissions';
import { asksOwnQuestion } from '../../shared/cliQuestion';
import { binary, claudeItems, linkCursorStore } from './providers';
import type { ClaudeRecord, ProviderEngine, ProviderItem, ProviderOptions, ProviderRequestParams, ProviderResults, ProviderTurnParams } from './providers';
import type * as terminalModule from '../terminal';
import type { ClaudePermissionMode, PermissionModeId } from '../../shared/chatPermissions';
import type { ChatSession, ChatState } from '../../shared/radialApi';

/**
 * The chat a native terminal serves (nativeChat's session): read for its thread,
 * title and settings, and updated with the terminal's id, input state and notices.
 */
export type InteractiveSession = Pick<ChatSession, 'id' | 'threadId' | 'turnId' | 'title' | 'home' | 'state' | 'keepAwake' | 'providerPersisted' | 'terminalId' | 'nativeTerminal' | 'terminalHasInput' | 'nativeInputNotice' | 'nativePendingPrompt' | 'permissionMode' | 'model' | 'resolvedModel' | 'modelName' | 'initialPrompt'>;
/**
 * The PTY daemon's client as the transport uses it: terminal.ts's own functions
 * (nativeChat passes the module itself). attach is optional: the tests' stand-ins
 * may leave it out, and the transport calls it with ?.().
 */
export type InteractiveTerminal = Pick<typeof terminalModule, 'list' | 'start' | 'write' | 'kill'> & Partial<Pick<typeof terminalModule, 'attach'>>;
/** A conversation item, as a provider transport's (ProviderItem), except a hook's tool result is the CLI's own JSON. */
export interface InteractiveItem extends Omit<ProviderItem, 'result'> {
  /** A tool call's output: text from the transcript, or a hook's tool_response, tool_output or error as the CLI sent it. */
  result?: unknown;
}
/** An item and the turn it arrived in (thread/items/list's entries); null or unset between turns. */
export interface InteractiveItemEntry { item: InteractiveItem; turnId?: string | null }
/** How a turn ended. */
export type InteractiveTurnStatus = 'completed' | 'failed' | 'interrupted';
/** Each event's params, by method, before the transport adds its threadId. */
export interface InteractiveEventParams {
  'item/completed': InteractiveItemEntry;
  'turn/started': { turn: { id: string } };
  /** The turn's id is the session's when the transport has none. */
  'turn/completed': { turn: { id: string | null | undefined; status: InteractiveTurnStatus } };
  /** A failed delivery's message, or StopFailure's (which may carry none). */
  'error': { error: { message: string | undefined } };
  /** The session's input state or notice changed; message is the new notice. */
  'native/input': { message?: string };
  'native/state': { status: Exclude<ChatState, 'error'> };
  /** The session's model or permission mode changed. */
  'native/settings': Record<string, never>;
}
export type InteractiveEventMethod = keyof InteractiveEventParams;
/** An event for nativeChat (onEvent), in Codex app-server's notification shape. */
export type InteractiveEvent = { [M in InteractiveEventMethod]: { method: M; params: InteractiveEventParams[M] & { threadId: string | null | undefined } } }[InteractiveEventMethod];
/** request()'s answer, by method. Any other method throws. turn/interrupt and turn/start answer as a provider transport does. */
export interface InteractiveResults extends Pick<ProviderResults, 'turn/interrupt' | 'turn/start'> {
  /** The thread's id: unset only when the transport closed while it initialized. */
  'thread/start': { thread: { id: string | null | undefined } };
  'thread/resume': { thread: { id: string | null | undefined } };
  'thread/items/list': { data: InteractiveItemEntry[]; nextCursor: null };
}
export type InteractiveMethod = keyof InteractiveResults;
/**
 * What the transport is started with. nativeChat passes the same options as to
 * its other transports (onRequest, shared, the Codex callbacks), which this one
 * copies but doesn't read.
 */
export interface InteractiveOptions extends Pick<ProviderOptions, 'engine' | 'cwd' | 'env' | 'contextText'> {
  session: InteractiveSession;
  terminal: InteractiveTerminal;
  /** Where each chat's hook journal, settings and observer plugin go (a folder per session id). */
  runtimeRoot: string;
  onEvent: (event: InteractiveEvent) => void;
}

/** A prompt waiting for delivery into the terminal: the session's nativePendingPrompt. */
type PendingPrompt = NonNullable<ChatSession['nativePendingPrompt']>;
/** Content that may hold text: a string, or blocks whose text is joined. */
type TextContent = string | readonly { type?: string; text?: string }[] | null | undefined;
/**
 * Where readRecords stopped in a file: its inode, the byte and line it consumed up
 * to, and the bytes just before (to spot a rewrite). reset marks a rewrite not yet
 * reported: a poll can find the file empty or half written, with no records yet.
 */
interface LogCursor { ino: number; offset: number; line: number; anchor?: Buffer; reset?: boolean }
/** readRecords' complete lines, parsed (not checked); reset on the first batch with records since the file was rewritten and read again from the start. */
type RecordBatch<T> = { record: T; index: number }[] & { reset?: boolean };
/** A transcript line: Claude Code's (a ClaudeRecord, for claudeItems) or Cursor's (a message by role, or turn_ended with its status). */
type TranscriptRecord = Omit<ClaudeRecord, 'type'> & { type?: string; role?: string; generation_id?: string; status?: string };
/** The hooks commandArgs registers: Claude Code's, then Cursor's. */
type HookEventName = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PermissionRequest' | 'Notification' | 'Stop' | 'StopFailure' | 'SessionEnd' | 'preToolUse' | 'postToolUse' | 'postToolUseFailure';
/** A hook's input as observe.cjs journals it (events.jsonl), Claude Code's or Cursor's. Each carries its event name; the rest only some events have. */
interface HookRecord {
  hook_event_name: HookEventName;
  /** Claude Code's conversation id. */
  session_id?: string;
  /** Cursor's conversation id. */
  conversation_id?: string;
  transcript_path?: string;
  model?: string;
  permission_mode?: string;
  prompt_id?: string;
  generation_id?: string;
  notification_type?: string;
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  /** A finished tool's output: Claude Code's tool_response, Cursor's tool_output. */
  tool_response?: unknown;
  tool_output?: unknown;
  /** A failed tool's error, or StopFailure's. */
  error?: string;
  error_details?: string;
  last_assistant_message?: string;
}
/** A session in `claude agents --json`: the code reads waiting, busy and idle. */
interface ClaudeAgentStatus { sessionId?: string; status?: string }
/** One `claude agents --json` launch, shared for a second by every chat in the same folder. */
interface StatusRead { at: number; promise: Promise<ClaudeAgentStatus[]> }

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const textContent = (content: TextContent) => typeof content === 'string' ? content : (content || []).map(c => c.text || '').filter(Boolean).join('\n');
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const statusReads = new Map<string, StatusRead>();
const terminalReply = (data: string): boolean => !data.replace(/\x1b\[(?:[?>]?\d+(?:;\d+)*c|\d+;\d+R|[0-9]+n|\?\d+u|[IO])/g, '').replace(/\x1b\](?:10|11);rgb:[0-9a-f/]+(?:\x07|\x1b\\)/gi, '');

class InteractiveTransport {
  // From the options (Object.assign).
  declare engine: ProviderEngine;
  declare cwd: string;
  declare env?: NodeJS.ProcessEnv | null;
  declare session: InteractiveSession;
  declare terminal: InteractiveTerminal;
  declare contextText?: string;
  declare onEvent: (event: InteractiveEvent) => void;
  declare bin: string;
  declare nativeTerminal: true;
  declare startedAt: number;
  declare items: Map<string, InteractiveItemEntry>;
  /** Each file readRecords reads (the transcript, the hook journal) and where it stopped. */
  declare logs: Map<string, LogCursor>;
  declare runtimeDir: string;
  /** The terminal's screen, mirrored to read the CLI's prompt and dialogs. */
  declare screen: Terminal;
  /** The pty's id in the daemon; set by initialize. */
  declare terminalId?: string;
  declare closed?: boolean;
  declare controlsTimer?: NodeJS.Timeout | null;
  declare controlsDirty?: boolean;
  /** The hook journal (events.jsonl); set by initialize. */
  declare journal: string;
  declare threadId?: string | null;
  declare turnId?: string | null;
  /**
   * The CLI's transcript, once known: reported by a hook's transcript_path or, for
   * Cursor, discovered on disk. Claude Code's default path is derived in
   * transcriptPath() and not stored.
   */
  declare transcript?: string;
  declare lastDiscovery?: number;
  declare activityAt?: number;
  declare inputAt?: number;
  declare observedBusy?: boolean;
  declare timer?: NodeJS.Timeout;
  declare quietTicks: number;
  /** The prompt from Chat waiting to be typed into the terminal. */
  declare pendingPrompt?: PendingPrompt | null;
  /** The CLI's prompt is on screen, so it can take input. */
  declare ready?: boolean;
  declare mayClearDraft?: boolean;
  declare setupInput?: boolean;
  declare interruptRequested?: boolean;
  declare polling?: boolean;
  declare stopObserved?: boolean;
  declare stopFailure?: boolean;
  declare checkedStatus?: boolean;
  declare statusTries?: number;
  declare statusAskedAt?: number;
  /** The next Cursor message's index, its item id. */
  declare cursorMessageIndex?: number;
  /** Set by nativeChat.connect: settles once the transport is initialized and its thread started or resumed. */
  declare connected?: Promise<void>;
  constructor(options: InteractiveOptions) {
    Object.assign(this, options);
    this.bin = binary(this.engine)!; // null throws just below
    if (!this.bin) throw new Error('Install the native CLI and sign in first.');
    fs.accessSync(this.bin, fs.constants.X_OK);
    this.nativeTerminal = true;
    this.startedAt = Date.now();
    this.items = new Map<string, InteractiveItemEntry>(); this.logs = new Map<string, LogCursor>();
    this.runtimeDir = path.join(options.runtimeRoot, this.session.id);
    this.screen = new Terminal({ cols: 80, rows: 24, scrollback: 2000, allowProposedApi: true });
    this.screen.onData(data => { if (this.terminalId) this.terminal.write(this.terminalId, data); });
    // The screen check (24 lines, a few regexes) ran after every parsed chunk,
    // ~30 times a second per working agent. Now: at once for the first chunk,
    // then at most every 50 ms while output keeps coming.
    this.screen.onWriteParsed(() => {
      if (this.closed) return;
      if (this.controlsTimer) { this.controlsDirty = true; return; }
      this.readControls();
      const next = () => { this.controlsTimer = null; if (this.closed || !this.controlsDirty) return; this.controlsDirty = false; this.readControls(); this.controlsTimer = setTimeout(next, 50); this.controlsTimer.unref?.(); };
      this.controlsTimer = setTimeout(next, 50); this.controlsTimer.unref?.();
    });
  }
  event(method: 'native/settings'): void;
  event(method: 'native/input', params?: InteractiveEventParams['native/input']): void;
  event<M extends InteractiveEventMethod>(method: M, params: InteractiveEventParams[M]): void;
  event(method: InteractiveEventMethod, params: InteractiveEventParams[InteractiveEventMethod] = {}): void { if (this.closed) return; this.onEvent({ method, params: { threadId: this.threadId, ...params } } as InteractiveEvent); }
  item(item: InteractiveItem, replay = false): void {
    const previous = this.items.get(item.id)?.item;
    const merged = { ...previous, ...item };
    // Hooks can arrive ahead of their transcript records. An older tool-start
    // record must not revert a completed native tool to running.
    if (item.status === 'inProgress' && (['completed', 'failed'] as (string | undefined)[]).includes(previous?.status)) merged.status = previous!.status;
    if (JSON.stringify(previous) === JSON.stringify(merged)) return;
    this.items.set(item.id, { item: merged, turnId: this.turnId });
    if (!replay) this.event('item/completed', { item: merged, turnId: this.turnId });
  }
  nativeStatus(message: string): void {
    if (this.closed || this.session.nativeInputNotice === message) return;
    this.session.nativeInputNotice = message;
    this.event('native/input', { message });
  }
  async initialize(): Promise<void> {
    fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    this.journal = path.join(this.runtimeDir, 'events.jsonl');
    this.threadId = this.session.threadId;
    const existing = (await this.terminal.list(this.cwd)).find(t => t.alive !== false && t.meta?.nativeChatId === this.session.id);
    if (this.closed) return;
    if (existing) {
      this.threadId ||= existing.meta.nativeThreadId;
      if (!uuid.test(this.threadId || '')) throw new Error('The running CLI has no saved conversation ID. Continue in Terminal.');
      this.terminalId = existing.id;
      this.session.terminalId = existing.id;
      this.session.nativeTerminal = true;
      this.resize(existing.cols || 80, existing.rows || 24);
      await this.scan(true);
      await this.scanHooks(true);
      this.activityAt = Date.now();
      this.observedBusy = ['working', 'approval'].includes(this.session.state);
      if (this.turnId) this.event('turn/started', { turn: { id: this.turnId } });
    } else {
      if (!this.threadId) {
        this.threadId = this.engine === 'claude' ? randomUUID() : (await promisify(execFile)(this.bin, ['create-chat'], { cwd: this.cwd, env: childEnv(this.env), timeout: 15000 })).stdout.trim();
      }
      if (!uuid.test(this.threadId)) throw new Error('The native CLI returned an invalid conversation ID.');
      if (this.engine === 'cursor') {
        const source = path.join(this.cursorRoot(), 'acp-sessions', this.threadId, 'meta.json');
        if (fs.existsSync(source)) await linkCursorStore(this.cwd, this.threadId, this.cursorRoot(), { allowEmpty: !this.session.providerPersisted });
      }
      await this.scan(true); this.turnId = null;
      fs.writeFileSync(this.journal, '', { mode: 0o600 });
      if (this.closed) return;
      const args = this.commandArgs();
      this.terminalId = await this.terminal.start(this.cwd, { cols: 80, rows: 24, command: { bin: this.bin, args }, meta: { engine: this.engine, label: this.session.title, home: this.session.home, nativeChatId: this.session.id, nativeThreadId: this.threadId, keepAwake: !!this.session.keepAwake } });
      if (!this.terminalId) throw new Error('The native terminal could not be opened.');
      if (this.closed) { this.terminal.kill(this.terminalId); return; }
      this.session.terminalId = this.terminalId;
      this.session.nativeTerminal = true;
      this.session.terminalHasInput = false;
    }
    this.session.threadId = this.threadId!; // uuid-checked in either branch above (a running CLI's or a new one), so a string
    this.terminal.attach?.(this.terminalId);
    // Transcript and hook files: every 200 ms while a turn runs or just ran,
    // every second when the chat is quiet (most live chats, most of the time).
    this.timer = setInterval(() => { if (this.turnId || this.pendingPrompt || Date.now() - Math.max(this.activityAt || 0, this.inputAt || 0) < 10000 || ++this.quietTicks % 5 === 0) this.poll(); }, 200);
    this.quietTicks = 0;
    this.timer.unref?.();
    this.nativeStatus('');
    const pending = this.session.nativePendingPrompt;
    if (pending) {
      const accepted = Array.isArray(pending.knownUsers) && [...this.items.values()].some(({ item }) => item.type === 'userMessage' && !pending.knownUsers.includes(item.id) && textContent(item.content) === pending.text);
      if (accepted) this.session.nativePendingPrompt = null;
      else if (!pending.delivering) {
        this.turnId = pending.id; this.pendingPrompt = pending;
        this.deliver(pending).catch((error: Error) => { if (!this.closed) this.nativeStatus(error.message); });
      } else {
        // Delivery may have crossed the quit boundary. Never send it twice.
        this.session.terminalHasInput = true; this.session.nativePendingPrompt = null;
        this.nativeStatus('Your message is still in Terminal. Check it there before continuing.');
        this.event('native/state', { status: 'idle' });
      }
    }
  }
  cursorRoot(): string {
    const env = childEnv(this.env);
    return env.CURSOR_CONFIG_DIR || (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'cursor') : path.join(os.homedir(), '.cursor'));
  }
  commandArgs(): string[] {
    // The hook runs from a copy outside app.asar, and beside it the guard it
    // applies to Claude Code's Bash calls (devGuard, as compiled into out/; run
    // from source, as the unit tests run this, there's none and the hook only
    // records). It reads the preview's dev server from the project's dev.json,
    // wherever the project keeps its data; Home has no dev server.
    const helper = path.join(this.runtimeDir, 'observe.cjs');
    fs.copyFileSync(path.join(__dirname, 'observe.cjs'), helper);
    const guard = path.join(__dirname, '..', 'devGuard.js');
    if (fs.existsSync(guard)) fs.copyFileSync(guard, path.join(this.runtimeDir, 'devGuard.cjs'));
    const devInfo = this.session.home ? null : projectData.dataDir(this.cwd, 'dev.json');
    const command = 'ELECTRON_RUN_AS_NODE=1 ' + quote(process.execPath) + ' ' + quote(helper) + ' ' + quote(this.journal) + (devInfo ? ' ' + quote(devInfo) : '');
    const names: HookEventName[] = this.engine === 'claude'
      ? ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd']
      : ['preToolUse', 'postToolUse', 'postToolUseFailure'];
    const hooks = Object.fromEntries(names.map(name => [name, this.engine === 'claude' ? [{ hooks: [{ type: 'command', command }] }] : [{ command }]]));
    const args = this.engine === 'claude'
      ? [this.session.providerPersisted || this.items.size ? '--resume' : '--session-id', this.threadId!, ...(this.contextText ? ['--append-system-prompt', this.contextText] : [])] // initialize checks the id before it builds the command
      : ['--resume', this.threadId!];
    args.push(...permissions.args(this.engine, this.session.permissionMode as PermissionModeId | undefined)); // 'custom' is Codex's alone; args() throws on it
    if (this.session.model) args.push('--model', this.session.model);
    if (this.engine === 'claude') {
      const settings = path.join(this.runtimeDir, 'settings.json');
      fs.writeFileSync(settings, JSON.stringify({ hooks }), { mode: 0o600 });
      args.push('--settings', settings);
    } else {
      const plugin = path.join(this.runtimeDir, 'observer');
      fs.mkdirSync(path.join(plugin, '.cursor-plugin'), { recursive: true });
      fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(plugin, '.cursor-plugin/plugin.json'), JSON.stringify({ name: 'radial-session-observer', version: '1.0.0' }));
      fs.writeFileSync(path.join(plugin, 'hooks/hooks.json'), JSON.stringify({ version: 1, hooks }));
      args.push('--plugin-dir', plugin);
    }
    // A chat created with a task (site migration) runs it as the CLI boots: no paste race.
    if (this.session.initialPrompt && !this.items.size && !this.session.providerPersisted) { args.push(this.session.initialPrompt); delete this.session.initialPrompt; }
    return args;
  }
  data(data: string): void { if (!this.closed) this.screen.write(data); }
  resize(cols: number, rows: number): void { if (!this.closed) this.screen.resize(Math.max(20, cols), Math.max(5, rows)); }
  screenText(): string {
    const buffer = this.screen.buffer.active;
    return Array.from({ length: this.screen.rows }, (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true) || '').join('\n');
  }
  readControls(): void {
    // These checks only gate input delivery/show native controls. Task state and
    // completion always come from native records, never a spinner/quiet timer.
    const text = this.screenText();
    // A CLI asking its own question (trust this folder, sign in, a first-run or
    // permission menu) isn't at its prompt, though Claude Code's menus put a ❯ on
    // the chosen option: a message delivered there is lost, and its Enter answers
    // the question for the person.
    const asking = asksOwnQuestion(text);
    const prompt = !asking && (this.engine === 'claude' ? /(?:^|\n)\s*❯[ \u00a0]/.test(text) : /(?:^|\n)\s*→ (?:Plan, search, build anything|Add a follow-up)/.test(text));
    this.ready = prompt;
    const input = this.engine === 'claude' ? [...text.matchAll(/(?:^|\n)\s*❯[ \u00a0]([^\n]*)/g)].at(-1)?.[1] : null;
    const empty = this.engine === 'claude' ? input != null && !input.trim() : /(?:^|\n)\s*→ (?:Plan, search, build anything|Add a follow-up)\s*(?:\n|$)/.test(text);
    if ((this.mayClearDraft || this.setupInput) && empty && this.session.terminalHasInput) {
      this.mayClearDraft = false; this.setupInput = false; this.session.terminalHasInput = false; this.event('native/input');
    }
    if (asking || (/trust this (?:folder|workspace)|trust the files|sign in|log in|allow this|approve|run this command|permission required/i.test(text.slice(-2200)) && !prompt)) {
      this.nativeStatus('The CLI needs your input in Terminal.');
    } else if (prompt && this.session.nativeInputNotice === 'The CLI needs your input in Terminal.') this.nativeStatus('');
  }
  noteInput(data: string): void {
    if (terminalReply(data)) return;
    this.inputAt = Date.now(); // someone is typing in Terminal: watch for the prompt they submit
    if (!this.ready && this.pendingPrompt && !this.pendingPrompt.delivering) this.setupInput = true;
    if (this.turnId && data === (this.engine === 'claude' ? '\x1b' : '\x03')) {
      this.interruptRequested = true; this.activityAt = Date.now(); this.mayClearDraft = true; return;
    }
    // Enter might answer a dialog or insert a newline. The native submitted
    // record (not a keystroke) acknowledges delivery and clears the draft.
    if (data) this.session.terminalHasInput = true;
    this.mayClearDraft = /[\x03\x08\x15\x7f]|\x1b\[/.test(data);
  }
  async poll(): Promise<void> {
    if (this.polling || this.closed) return;
    this.polling = true;
    try { await this.scanHooks(); await this.scan(); if (this.statusDue()) await this.syncClaudeStatus(); }
    catch (error) { this.nativeStatus('Could not refresh Chat. The CLI is still running in Terminal.'); }
    finally { this.polling = false; }
  }
  // `claude agents --json` is a whole CLI launch (~0.1 s and ~150 MB each).
  // Ask every second only while its answer decides something: confirming a Stop
  // or an interrupt, clearing an input notice, the first look after attaching.
  // Otherwise every 10 s during a turn, as a safety net for a missed hook.
  statusDue(): boolean {
    if (this.engine !== 'claude') return false;
    const urgent = this.stopObserved || this.interruptRequested || !!this.session.nativeInputNotice || (!this.checkedStatus && (this.statusTries || 0) < 5);
    if (!urgent && !this.turnId && this.checkedStatus) return false;
    return Date.now() - (this.statusAskedAt || 0) >= (urgent ? 1000 : 10000);
  }
  async syncClaudeStatus(): Promise<void> {
    this.statusAskedAt = Date.now(); this.statusTries = (this.statusTries || 0) + 1;
    const key = this.bin + ':' + this.cwd;
    let cached = statusReads.get(key);
    if (!cached || Date.now() - cached.at > 1000) {
      const promise = promisify(execFile)(this.bin, ['agents', '--json', '--cwd', this.cwd], { cwd: this.cwd, env: childEnv(this.env), timeout: 8000 }).then(result => JSON.parse(result.stdout) as ClaudeAgentStatus[]); // the CLI's own JSON, trusted: anything but an array throws at find() below, into poll's catch
      cached = { at: Date.now(), promise }; statusReads.set(key, cached);
    }
    const entries = await cached.promise;
    const state = entries.find(entry => entry.sessionId === this.threadId);
    if (!state) return;
    if (this.closed || cached.at < (this.activityAt || 0)) return;
    this.checkedStatus = true;
    if (state.status === 'waiting') {
      this.nativeStatus('The CLI needs your input in Terminal.');
      this.event('native/state', { status: 'approval' });
    } else if (state.status === 'busy') { this.observedBusy = true; this.event('native/state', { status: 'working' }); }
    else if (state.status === 'idle' && this.turnId && !this.pendingPrompt && (this.stopObserved || this.interruptRequested || this.observedBusy)) {
      await this.scan();
      // Stop hooks may continue the turn. Only the native CLI's idle status
      // confirms completion; a Stop hook by itself is not a finished task.
      this.complete(this.stopFailure ? 'failed' : this.interruptRequested ? 'interrupted' : 'completed'); this.stopFailure = false;
    }
  }
  async transcriptPath(): Promise<string | null> {
    if (this.transcript) return this.transcript;
    if (this.engine === 'claude') return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', fs.realpathSync(this.cwd).replace(/[^a-zA-Z0-9]/g, '-'), this.threadId + '.jsonl');
    if (Date.now() - (this.lastDiscovery || 0) < 1000) return null;
    this.lastDiscovery = Date.now();
    const root = path.join(this.cursorRoot(), 'projects');
    let dirs; try { dirs = await fs.promises.readdir(root, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const file = path.join(root, dir.name, 'agent-transcripts', this.threadId!, this.threadId + '.jsonl'); // initialize checks the id before the first scan
      if (fs.existsSync(file)) return this.transcript = file;
    }
    return null;
  }
  async readRecords(filename: string): Promise<RecordBatch<unknown>> { // parsed, not checked: each caller casts the records to what its file holds
    let stat; try { stat = await fs.promises.stat(filename); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    let cursor = this.logs.get(filename)!; // unset on a file's first read: `same` is then false and a new cursor replaces it before it's dereferenced
    const file = await fs.promises.open(filename, 'r');
    try {
      // Cursor rewrites its final turn marker on the next turn, often without
      // changing inode or shrinking the file. Validate the consumed suffix.
      let same = !!cursor && cursor.ino === stat.ino && stat.size >= cursor.offset; // !!cursor guards a file's first read, which has no cursor whatever the ! above says: keep it
      if (same && cursor.anchor?.length) {
        const anchor = Buffer.alloc(cursor.anchor.length);
        const read = await file.read(anchor, 0, anchor.length, cursor.offset - anchor.length);
        same = read.bytesRead === anchor.length && anchor.equals(cursor.anchor);
      }
      // Cursor rewrites in place, truncating first: the rewrite is reported with the
      // next batch that has records, whatever the polls in between find.
      if (!same) { cursor = { ino: stat.ino, offset: 0, line: 0, reset: true }; this.logs.set(filename, cursor); }
      if (stat.size === cursor.offset) return [];
      let buffer = Buffer.alloc(Math.min(stat.size - cursor.offset, 16 * 1024 * 1024));
      let { bytesRead } = await file.read(buffer, 0, buffer.length, cursor.offset);
      let end = buffer.subarray(0, bytesRead).lastIndexOf(10);
      // Native image records can exceed one read block. Continue that record
      // instead of retrying the same first 16 MB forever.
      while (end < 0 && cursor.offset + bytesRead < stat.size) {
        const next = Buffer.alloc(Math.min(stat.size - cursor.offset - bytesRead, 16 * 1024 * 1024));
        const read = await file.read(next, 0, next.length, cursor.offset + bytesRead);
        if (!read.bytesRead) break;
        buffer = Buffer.concat([buffer.subarray(0, bytesRead), next.subarray(0, read.bytesRead)]);
        bytesRead += read.bytesRead; end = buffer.lastIndexOf(10);
      }
      if (end < 0) return []; // Retain partial JSON/UTF-8 until its newline arrives.
      const records: RecordBatch<unknown> = [];
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        const index = cursor.line++;
        try { records.push({ record: JSON.parse(line), index }); } catch {}
      }
      cursor.offset += end + 1;
      cursor.anchor = Buffer.from(buffer.subarray(Math.max(0, end + 1 - 256), end + 1));
      if (records.length) { records.reset = !!cursor.reset; cursor.reset = false; }
      return records;
    } finally { await file.close(); }
  }
  async scan(replay = false): Promise<void> {
    const filename = await this.transcriptPath(); if (!filename) return;
    // A replay reads to the end. One read stops at 16 MB, and a longer transcript
    // used to finish replaying on later polls, every old item emitted as new.
    for (let records = await this.readRecords(filename) as RecordBatch<TranscriptRecord>; records.length; records = replay ? await this.readRecords(filename) as RecordBatch<TranscriptRecord> : []) this.scanRecords(records, replay); // the CLI's own transcript, trusted
  }
  scanRecords(records: RecordBatch<TranscriptRecord>, replay: boolean): void {
    if (records.reset) this.cursorMessageIndex = 0;
    for (const { record } of records) {
      if (record.sessionId && record.sessionId !== this.threadId) continue;
      if (this.engine === 'claude') {
        for (const item of claudeItems(record as ClaudeRecord)) this.item(item, replay); // Claude Code's transcript lines all carry a type
      } else {
        const id = 'cursor-native-' + (this.cursorMessageIndex || 0);
        if (record.role === 'user' || record.role === 'assistant') this.cursorMessageIndex = (this.cursorMessageIndex || 0) + 1;
        const content = record.message?.content;
        if (record.role === 'user') {
          let text = textContent(content); const query = text.match(/<user_query>\n?([\s\S]*?)\n?<\/user_query>/);
          if (query) text = query[1];
          if (replay) this.turnId = record.generation_id || id;
          else if (!this.items.has(id)) this.begin(record.generation_id || id, true);
          this.item({ id, type: 'userMessage', content: [{ type: 'text', text }] }, replay);
        } else if (record.role === 'assistant') {
          const text = textContent(content); if (text) this.item({ id, type: 'agentMessage', text }, replay);
        } else if (record.type === 'turn_ended') { if (replay) this.turnId = null; else this.complete(record.status === 'aborted' ? 'interrupted' : record.status === 'error' ? 'failed' : 'completed'); }
      }
    }
  }
  begin(id: string | undefined, submitted = false): void {
    this.activityAt = Date.now(); this.stopObserved = false;
    if (!this.turnId || submitted) this.observedBusy = false;
    this.turnId ||= id || randomUUID(); this.session.providerPersisted = true;
    if (submitted) { this.session.terminalHasInput = false; this.session.nativePendingPrompt = null; }
    this.nativeStatus('');
    this.event('turn/started', { turn: { id: this.turnId } });
  }
  complete(status: InteractiveTurnStatus = 'completed'): void {
    const id = this.turnId || this.session.turnId;
    this.event('turn/completed', { turn: { id, status } });
    this.turnId = null; this.observedBusy = false; this.stopObserved = false; this.interruptRequested = false; this.nativeStatus('');
  }
  async scanHooks(replay = false): Promise<void> {
    for (const { record: e } of await this.readRecords(this.journal) as RecordBatch<HookRecord>) { // observe.cjs journals each hook's input as the CLI sent it, trusted
      if ((e.session_id || e.conversation_id) !== this.threadId) continue;
      if (e.transcript_path && path.basename(e.transcript_path) === this.threadId + '.jsonl') this.transcript = e.transcript_path;
      if (e.model) {
        if (e.model !== this.session.resolvedModel && e.model !== this.session.model) this.session.modelName = e.model === 'default' ? 'Auto' : null;
        this.session.model = this.session.resolvedModel = e.model; this.event('native/settings');
      }
      const mode = ({ default: 'default', manual: 'default', acceptEdits: 'edits', plan: 'plan', bypassPermissions: 'full' } as Partial<Record<string, ClaudePermissionMode>>)[e.permission_mode as string]; // no mode looks up 'undefined', which isn't a key
      if (this.engine === 'claude' && mode && mode !== this.session.permissionMode) { this.session.permissionMode = mode; this.event('native/settings'); }
      const name = e.hook_event_name;
      if (replay) {
        if (name === 'UserPromptSubmit') { this.turnId = e.prompt_id || randomUUID(); this.stopObserved = false; }
        if (name === 'Stop' || name === 'StopFailure') this.stopObserved = true;
        if (!['PreToolUse', 'preToolUse', 'PostToolUse', 'postToolUse', 'PostToolUseFailure', 'postToolUseFailure'].includes(name)) continue;
      }
      if (name === 'UserPromptSubmit') this.begin(e.prompt_id, true);
      else if (['PermissionRequest', 'Notification'].includes(name) && (name === 'PermissionRequest' || e.notification_type === 'permission_prompt')) this.nativeStatus('The CLI needs your input in Terminal.');
      else if (['PreToolUse', 'preToolUse'].includes(name)) {
        if (!replay) this.begin(e.prompt_id || e.generation_id);
        this.item({ id: e.tool_use_id!, type: 'mcpToolCall', tool: e.tool_name, server: JSON.stringify(e.tool_input || {}), status: 'inProgress' }, replay); // tool hooks carry their tool_use_id
      } else if (['PostToolUse', 'postToolUse', 'PostToolUseFailure', 'postToolUseFailure'].includes(name)) {
        this.item({ id: e.tool_use_id!, type: 'mcpToolCall', tool: e.tool_name, result: e.tool_response || e.tool_output || e.error, status: /Failure/.test(name) ? 'failed' : 'completed' }, replay); // tool hooks carry their tool_use_id
        if (!replay) this.nativeStatus('');
      } else if (name === 'Stop' || name === 'StopFailure') {
        await this.scan();
        if (name === 'StopFailure') this.event('error', { error: { message: e.last_assistant_message || e.error_details || e.error } });
        this.stopFailure = name === 'StopFailure'; this.stopObserved = true; this.activityAt = Date.now();
      }
    }
  }
  request(method: 'turn/start', params: ProviderTurnParams): Promise<InteractiveResults['turn/start']>;
  request<M extends Exclude<InteractiveMethod, 'turn/start'>>(method: M, params?: ProviderRequestParams): Promise<InteractiveResults[M]>;
  /** Any other method (or a turn/start without its prompt): it throws (rejects), as an unknown one always did. */
  request(method: string, params?: ProviderRequestParams): Promise<unknown>;
  async request(method: string, params: ProviderRequestParams = {}): Promise<InteractiveResults[InteractiveMethod]> {
    if (['thread/start', 'thread/resume'].includes(method)) return { thread: { id: this.threadId } };
    if (method === 'thread/items/list') { await this.poll(); return { data: [...this.items.values()], nextCursor: null }; }
    if (method === 'turn/interrupt') {
      this.pendingPrompt = null; this.session.nativePendingPrompt = null;
      this.interruptRequested = true; this.activityAt = Date.now();
      this.terminal.write(this.terminalId!, this.engine === 'claude' ? '\x1b' : '\x03'); // set by initialize; a turn starts only after it
      return {};
    }
    if (method === 'turn/start') {
      if (this.session.terminalHasInput) throw new Error('Your unsent Terminal draft is still there. Finish or clear it in Terminal before sending this message.');
      let text = params.input!.filter(p => p.type === 'text').map(p => p.text).join('\n'); // ProviderTurnParams requires the prompt
      if (this.engine === 'cursor' && !this.session.providerPersisted && this.contextText) text += '\n\n' + this.contextText;
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error('This message contains terminal control characters. Remove them before sending.');
      this.turnId = randomUUID(); this.stopObserved = false; this.interruptRequested = false; this.activityAt = Date.now();
      const pending = this.pendingPrompt = { text, id: this.turnId, knownUsers: [...this.items.values()].filter(({ item }) => item.type === 'userMessage').map(({ item }) => item.id) };
      this.session.nativePendingPrompt = pending; this.event('native/input');
      this.deliver(pending).catch((error: Error) => { if (!this.closed) { this.nativeStatus(error.message); this.event('error', { error: { message: error.message } }); this.complete('failed'); } });
      return { turn: { id: this.turnId } };
    }
    throw new Error('Unsupported native terminal operation: ' + method);
  }
  async deliver(pending: PendingPrompt): Promise<void> {
    while ((!this.ready || this.session.terminalHasInput) && !this.closed && this.pendingPrompt === pending) {
      this.nativeStatus(this.ready ? 'Your unsent message is still in Terminal. Finish or clear it there before continuing.' : 'Open Terminal to finish CLI setup. Your message is waiting here.');
      await delay(100);
    }
    if (this.closed || this.pendingPrompt !== pending) return;
    this.nativeStatus('');
    pending.delivering = true; this.event('native/input');
    this.terminal.write(this.terminalId!, '\x1b[200~' + pending.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n') + '\x1b[201~'); // initialize sets it before it or turn/start delivers
    await delay(100);
    if (this.closed || this.pendingPrompt !== pending) return;
    this.terminal.write(this.terminalId!, '\r'); this.pendingPrompt = null; this.activityAt = Date.now();
  }
  // Detaching the observer does not terminate the terminal or its work.
  close(): void { this.closed = true; clearInterval(this.timer); clearTimeout(this.controlsTimer as NodeJS.Timeout | undefined); /* a null timer is a no-op; @types/node leaves null out */ this.screen.dispose(); }
  async shutdown(): Promise<never> { throw new Error('Change native CLI settings in Terminal. The running session will be kept.'); }
}

export { InteractiveTransport, terminalReply };
