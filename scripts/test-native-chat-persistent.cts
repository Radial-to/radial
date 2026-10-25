// Opt-in integration test: real native CLIs and model credits, no test adapters.
// Claude requires an already-trusted disposable folder as the second argument.
// Cursor trusts only the disposable folder created by this script.
// It loads the app's TypeScript source, so it runs through tsx:
// Run: npx tsx scripts/test-native-chat-persistent.cts claude <trusted-disposable-folder> | cursor
import type { IPty } from 'node-pty';

// What the native chat checks (this test and test-native-chat-live.cts) use of
// src/main/nativeChat.ts and env.ts, declared once here; the live check imports
// them with `import type`. The scripts project can't import the app's types
// (src/ is CommonJS, and the scripts check under verbatimModuleSyntax), so the
// shapes are restated, named after the app's own: ChatEngine in
// src/shared/chatPermissions.ts; ChatState, ChatMessage and ChatSession in
// src/shared/radialApi.ts; PtyMeta, PtyInfo and TerminalStartOptions in
// src/main/terminal.ts; InteractiveTerminal in src/main/chat/interactive.ts.
export type ChatEngine = 'claude' | 'codex' | 'cursor';
export type ChatState = 'idle' | 'working' | 'approval' | 'error';
/** One message in a chat. */
export interface ChatMessage { id: string; role: 'user' | 'assistant' | 'tool'; text: string; status?: string }
/** A chat, as NativeChat keeps it (the object itself, so it changes as the chat runs). */
export interface ChatSession {
  id: string;
  state: ChatState;
  threadId: string | null;
  error?: string;
  permissionMode?: 'cli' | 'default' | 'edits' | 'plan' | 'full' | 'workspace' | 'read-only' | 'custom';
  queue?: { id: string; text: string }[];
  queuePaused?: boolean;
  messages: ChatMessage[];
}
/** What the app stores with a pty in the daemon; a native chat's carries its id. */
export interface PtyMeta { engine?: string | null; label?: string | null; home?: boolean; nativeChatId?: string; nativeThreadId?: string; keepAwake?: boolean }
/**
 * A pty as the terminal's `list` reports it, as far as NativeChat reads it. The
 * daemon also sends repoDir and always sends meta; the checks' stand-ins leave
 * out repoDir, and the live check's leaves out meta too.
 */
export interface PtyInfo { id: string; pid?: number | null; alive: boolean; meta?: PtyMeta }
/** What NativeChat asks the terminal to start for a native chat: always its CLI and the pty's metadata (the app's type has every field optional). */
export interface TerminalStartOptions { cols: number; rows: number; command: { bin: string; args: string[] }; meta: PtyMeta }
/** The PTY daemon's client as NativeChat calls it (terminal.ts's list, attach, start, write, kill); the checks stand in for it. */
export interface InteractiveTerminal {
  list(repoDir?: string | null): Promise<PtyInfo[]>;
  attach?(id: string): void;
  start(cwd: string, options: TerminalStartOptions): Promise<string>;
  write(id: string, data: string): void;
  kill(id: string): void;
}
export interface NativeChatOptions {
  /** Where the chats are saved. */
  file: string;
  /** The project context a new conversation starts with. */
  context: (repoDir: string, home: boolean) => string;
  /** Each change to a chat (a ChatEvent); this test only records the latest, the live check drops them. */
  emit: (event: unknown) => void;
  terminal: InteractiveTerminal;
}
/** The NativeChat calls the checks make. */
export interface NativeChatInstance {
  /** Settles once the chats whose CLI kept running are reattached. */
  restoring: Promise<void>;
  /** The live transports by chat id; this test's chats run in a native terminal, whose transport reads its screen. */
  live: Map<string, { screenText(): string }>;
  create(repoDir: string, home?: boolean, engine?: ChatEngine): ChatSession;
  get(id: string): ChatSession;
  send(id: string, text: string): Promise<ChatSession>;
  enqueue(id: string, text: string): ChatSession;
  removeQueued(id: string, messageId: string): ChatSession;
  setView(id: string, view: 'chat' | 'terminal', cols?: number, rows?: number, stopTerminal?: boolean): Promise<ChatSession>;
  stop(id: string): Promise<ChatSession>;
  // These three take the pty's id, which NativeChat matches to session.terminalId, not a chat id.
  recordTerminalInput(terminalId: string, data: string): void;
  terminalData(terminalId: string, data: string): void;
  terminalExited(terminalId: string): void;
  close(): void;
}
/** What the checks load from src/main/nativeChat.ts. */
export interface NativeChatModule { NativeChat: new (options: NativeChatOptions) => NativeChatInstance }
/** What the checks load from src/main/env.ts. */
export interface EnvModule { childEnv(extra?: NodeJS.ProcessEnv | null): NodeJS.ProcessEnv }

const { NativeChat }: NativeChatModule = require('../src/main/nativeChat');
const { childEnv }: EnvModule = require('../src/main/env');
const pty: typeof import('node-pty') = require('node-pty');
const fs: typeof import('node:fs') = require('node:fs'), os: typeof import('node:os') = require('node:os'), path: typeof import('node:path') = require('node:path');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const engine = process.argv[2];
if (!['claude', 'cursor'].includes(engine) || (engine === 'claude' && !process.argv[3])) {
  console.error('Usage: npx tsx scripts/test-native-chat-persistent.cts claude <trusted-disposable-folder> | cursor');
  process.exit(2);
}
for (const key of ['RADIAL_CHAT_TEST_CLI', 'RADIAL_CHAT_TEST_CLAUDE', 'RADIAL_CHAT_TEST_CURSOR']) delete process.env[key];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-persistent-app-' + engine + '-'));
const cwd = engine === 'claude' ? fs.realpathSync(process.argv[3]) : dir;
let chat: NativeChatInstance | undefined, proc: IPty | undefined, alive = false, record: PtyInfo | undefined, output = '', starts = 0;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const wait = async (predicate: () => boolean | Promise<boolean>, label: string, timeout = 90000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await sleep(100); }
  throw Error('Timed out: ' + label);
};
const terminal: InteractiveTerminal = {
  list: async () => alive ? [record!] : [],
  attach: () => { if (output) chat!.terminalData('live', output); },
  start: async (cwd, options) => {
    starts++;
    proc = pty.spawn(options.command.bin, [...options.command.args, ...(engine === 'cursor' ? ['--trust'] : [])], { cwd, cols: 80, rows: 24, env: { ...childEnv(), TERM: 'xterm-256color' } });
    alive = true; record = { id: 'live', pid: proc.pid, alive: true, meta: options.meta };
    proc.onData(data => { output += data; fs.writeFileSync(path.join(dir, 'terminal.txt'), output); chat!.terminalData('live', data); });
    proc.onExit(() => { alive = false; chat!.terminalExited('live'); });
    return 'live';
  },
  write: (_id, data) => proc!.write(data),
  kill: () => proc?.kill(),
};
const open = () => new NativeChat({ file: path.join(dir, 'chats.json'), context: () => 'This is an isolated Radial reliability test. Change no files.', terminal,
  emit: s => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s, null, 2)) });
(async () => {
  console.log('Evidence:', dir);
  chat = open(); let s = chat.create(cwd, false, engine as ChatEngine); s.permissionMode = 'full';
  await chat.send(s.id, 'Run the shell command sleep 10, then reply only RADIAL_VIEW_OK. Do not change files.');
  await wait(() => s.messages.some(m => m.role === 'tool' && m.status === 'inProgress'), 'native tool start');
  const id = s.id, thread = s.threadId, pid = proc!.pid;
  for (let i = 0; i < 3; i++) {
    await chat.setView(id, 'terminal'); assert.equal(s.state, 'working');
    await chat.setView(id, 'chat'); assert.equal(s.state, 'working');
    assert.equal(proc!.pid, pid); assert.equal(s.threadId, thread);
  }
  // Reopen the app while its daemon-owned CLI keeps working.
  chat.close(); assert.ok(alive); chat = open(); await chat.restoring; s = chat.get(id);
  assert.equal(starts, 1); assert.equal(proc!.pid, pid); assert.equal(s.threadId, thread);
  await wait(() => ['idle', 'error'].includes(s.state), 'completion after app reopen');
  assert.equal(s.state, 'idle', s.error);
  assert.ok(s.messages.some(m => m.role === 'assistant' && m.text.includes('RADIAL_VIEW_OK')));
  // A native Terminal submission is the next turn in this same Chat.
  await chat.setView(id, 'terminal');
  const prompt = 'Reply only RADIAL_TERMINAL_OK. Do not use tools.';
  chat.recordTerminalInput('live', prompt); proc!.write('\x1b[200~' + prompt + '\x1b[201~'); await sleep(200); proc!.write('\r');
  await wait(() => s.messages.some(m => m.role === 'assistant' && m.text.includes('RADIAL_TERMINAL_OK')) && s.state === 'idle', 'terminal turn observed by Chat');
  await chat.setView(id, 'chat');
  assert.equal(s.messages.filter(m => m.role === 'user').length, 2);
  // Only explicit Stop interrupts, and it leaves this same CLI usable.
  await chat.send(id, 'Run the shell command sleep 20, then reply only RADIAL_STOP_TOO_LATE. Do not change files.');
  await wait(() => s.messages.some(m => m.role === 'tool' && m.status === 'inProgress'), 'interruptible native tool');
  chat.enqueue(id, 'Reply only RADIAL_QUEUED. Do not use tools.');
  await chat.setView(id, 'terminal'); await chat.setView(id, 'chat');
  assert.equal(s.state, 'working');
  if (process.argv.includes('--native-stop')) {
    await chat.setView(id, 'terminal');
    const key = engine === 'claude' ? '\x1b' : '\x03'; chat.recordTerminalInput('live', key); proc!.write(key);
    await wait(() => s.state === 'idle', 'native Terminal cancellation');
  } else await chat.stop(id);
  assert.equal(s.state, 'idle'); assert.equal(s.queuePaused, true); assert.equal(s.queue!.length, 1);
  assert.equal(starts, 1); assert.equal(proc!.pid, pid); assert.ok(alive);
  chat.removeQueued(id, s.queue![0].id);
  // A draft never becomes a submitted turn just because views change.
  await chat.setView(id, 'terminal');
  proc!.write('\x1b[200~RADIAL_UNSENT_DRAFT\x1b[201~'); chat.recordTerminalInput('live', 'RADIAL_UNSENT_DRAFT');
  await sleep(300); await chat.setView(id, 'chat');
  await assert.rejects(chat.send(id, 'Do not overwrite my native draft'), /unsent Terminal draft/);
  await chat.setView(id, 'terminal');
  assert.match(chat.live.get(id)!.screenText(), /RADIAL_UNSENT_DRAFT/);
  assert.equal(starts, 1); assert.equal(s.threadId, thread); assert.ok(alive);
  console.log('PASS', engine, 'mid-task view switches, app reopen, native Terminal turn, explicit Stop, and preserved draft; one CLI process and conversation.');
})().catch((error: Error) => { console.error(error.stack); process.exitCode = 1; }).finally(() => { chat?.close(); proc?.kill(); });
