import * as projectData from './projectData';

/**
 * The `radial` command — the terminal client of the app's control socket
 * (cliServer.js), run by bin/radial through the app binary itself as Node
 * (ELECTRON_RUN_AS_NODE) so no system Node is needed, or on the system's Node
 * where there's no Mac app (the headless flavor). Pure Node: no Electron
 * imports, so it also runs under `node out/main/cli.js` and node --test.
 *
 * Verbs come from cliSpec.js (the one table). A few read-only verbs answer with
 * the app closed straight from disk (`url`, `context`, names from the recents
 * file); everything else launches the app if it isn't running (or, headless,
 * starts `radial serve` in the background), waits for the socket, and talks
 * cliProto. `radial serve` itself runs here (src/headless). Human output on
 * stdout, progress on stderr; `--json` prints exactly one object. Exit codes:
 * cliProto.exitCodeFor.
 *
 * With RADIAL_URL and RADIAL_TOKEN set, every verb goes to that radial serve
 * --listen over HTTP instead (its /rpc: the same frames, progress streamed),
 * and nothing is read from this machine's disk; `radial serve`, `token`,
 * `browser` and `doctor` stay about this machine. A remote shot is fetched into
 * this machine's own data dir, so its path is one this machine can open.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import http from 'http';
import https from 'https';
import { spawn } from 'child_process';
import * as proto from './cliProto';
import * as spec from './cliSpec';
import * as dataDirs from './dataDirs';
import { describeQuestion } from '../shared/cliQuestion';
const many = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
import * as projectResolve from './projectResolve';
import { normalizeOpenPath } from './cliOpen';
import type { Socket } from 'net';
import type { RequestFrame, Reply, ErrorReply, Candidate, ExitCode } from './cliProto';
import type { OpRequest, OpReplies, OpName, ProjectContext, CloneInfo, NewProjectExtras, CompareRow, ListedField, AgentWaitReason, Flavor } from './cliServer';
import type { ProjectSources, ResolveFuzzy, ResolveResult } from './projectResolve';
import type { McpInput, InstallResult } from './mcp';
import type { RecentsStore, AvailableProject } from './recents';
import type { DevInfo } from './devServer';
import type { TokenIndex, Token } from './tokens';
import type { PageEntry } from './project';
import type { ShownQuestion } from '../shared/cliQuestion';

// Keyed by socket op (cliSpec's `op`, else the verb). `agent wait` sets its own from --timeout.
const TIMEOUTS: Partial<Record<string, number>> = { hello: 2000, open: 180000, new: 600000, ls: 10000, status: 10000, resolve: 10000, url: 10000, context: 15000, pages: 10000, comments: 10000, shot: 60000, focus: 5000, sleep: 90000, wake: 90000, close: 90000, moments: 10000,
  editText: 30000, editImage: 30000, metaSet: 30000, commentAdd: 10000, commentResolve: 10000, commentsPull: 180000, sync: 120000, publish: 900000, momentRecord: 60000, momentRestore: 120000,
  agentStart: 240000, agentOutput: 15000, agentList: 10000, agentKill: 10000, agentKeep: 10000, agentSend: 60000, agentQuestion: 15000, agentAnswer: 90000, reload: 10000, restart: 200000, home: 60000,
  fields: 30000, tokens: 15000, tokenSet: 15000, contextAdd: 10000, refAdd: 10000, refRemove: 10000, ruleAdd: 10000, undo: 10000, redo: 10000,
  migrateStart: 1800000, migrateCapture: 1800000, migrateCompare: 1200000 } satisfies Partial<Record<OpName, number>>;
const LAUNCH_TIMEOUT_MS = 20000;
const FLAGS_WITH_VALUE = new Set(['timeout', 'template', 'dir', 'config', 'install', 'route', 'lines', 'engine', 'label', 'find', 'to', 'src', 'file', 'message', 'text', 'selector', 'since', 'field', 'name', 'mode', 'framework', 'include', 'project', 'widths', 'width', 'only', 'dataDir', 'idle', 'listen', 'allowHost', 'allowOrigin', 'expect']);
const REPEATABLE = new Set(['include', 'route', 'only', 'allowHost', 'allowOrigin']); // given more than once, these collect into a list
const AGENT_WAIT_DEFAULT_S = 120;

// ── argv ──
/** A repeatable flag (include, route, only) given more than once: its values in order. */
export type FlagList = string[];
/**
 * A flag as parseArgs leaves it: true when bare, false for --no-<flag>, the
 * value after = or the next word, or a FlagList. A value flag given last with
 * no next word leaves undefined (Flags' undefined), or a repeatable one's list as it was.
 */
export type FlagValue = string | boolean | FlagList;
/** The flags by name, camelCased (--no-wait sets wait: false). */
export interface Flags { [flag: string]: FlagValue | undefined }
/** argv as parseArgs reads it. */
export interface ParsedArgs {
  /** One word or `group action`; `open` for a bare path or name, `focus` when argv is empty. */
  verb: string;
  positional: string[];
  flags: Flags;
  /** A group named alone (`radial agent`): print its verbs. */
  usage?: boolean;
}
// Flags `tokens set` itself understands; any other `--word` after it is the token's name.
const TOKENS_SET_FLAGS = new Set(['mode', 'json', 'timeout', 'yes', 'help', 'h', 'version', 'v', 'no-wait', 'wait']);
function parseArgs(argv: string[]): ParsedArgs {
  const out: Omit<ParsedArgs, 'verb'> & { verb: string | null } = { verb: null, positional: [], flags: {} };
  const rest: string[] = [];
  const tokensSet = argv[0] === 'tokens' && argv[1] === 'set';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    // A token name looks like a flag (`--brand`): after `tokens set`, an unknown one is the name.
    if (tokensSet && i > 1 && /^--[A-Za-z0-9][A-Za-z0-9_-]*$/.test(a) && !TOKENS_SET_FLAGS.has(a.slice(2).split('=')[0])) { rest.push(a); continue; }
    if (a === '-h' || a === '--help') { out.flags.help = true; continue; }
    if (a === '-v' || a === '--version') { out.flags.version = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = (eq === -1 ? a.slice(2) : a.slice(2, eq)).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      const raw = eq === -1 ? null : a.slice(eq + 1);
      if (key.startsWith('no') && key.length > 2 && raw === null && /^[A-Z]/.test(key[2])) { out.flags[key[2].toLowerCase() + key.slice(3)] = false; continue; } // --no-wait
      if (FLAGS_WITH_VALUE.has(key)) {
        const v: string | undefined = raw !== null ? raw : argv[++i]; // undefined when the flag is the last word
        const prev = out.flags[key];
        // A repeatable flag collects the values given: a --no-<flag> before them, or the flag given last with no value, adds none.
        if (REPEATABLE.has(key) && (typeof prev === 'string' || Array.isArray(prev))) { if (v !== undefined) out.flags[key] = ([] as FlagList).concat(prev, v); }
        else out.flags[key] = v;
        continue;
      }
      out.flags[key] = raw !== null ? raw : true;
      continue;
    }
    rest.push(a);
  }
  const two = rest.length >= 2 ? spec.byName(rest[0] + ' ' + rest[1]) : null; // `edit text`, `agent start`
  if (two) { out.verb = two.name; out.positional = rest.slice(2); }
  else if (rest.length && spec.byName(rest[0])) { out.verb = rest[0]; out.positional = rest.slice(1); }
  else if (rest.length && spec.groups().includes(rest[0])) { out.verb = rest[0]; out.positional = rest.slice(1); out.usage = true; } // `radial agent` alone: usage, not an open
  else if (rest.length) { out.verb = 'open'; out.positional = rest; } // `radial .`, `radial ~/site`, `radial moment`
  else out.verb = 'focus';
  return out as ParsedArgs; // every branch above names the verb
}

// The request for a verb: cliSpec's op plus the verb's own arguments.
const str = (v: FlagValue | undefined): string | null => (typeof v === 'string' ? v : null);
/** A repeatable flag's values: none, the one given, or the list parseArgs collected. */
const list = (v: FlagValue | undefined): FlagList => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []);
function buildPayload(verb: string, positional: string[], flags: Flags, io: Pick<CliIo, 'cwd' | 'isTTY'>): OpRequest {
  const c = spec.byName(verb);
  const p: OpRequest = { op: (c && c.op) || verb, cwd: io.cwd, tty: !!io.isTTY, target: positional[0] || null, wait: flags.wait !== false, yes: !!flags.yes, all: !!flags.all, open: !!flags.open, route: str(flags.route) };
  switch (verb) {
    case 'new': Object.assign(p, { name: positional[0] || null, template: str(flags.template), dir: str(flags.dir), github: !!flags.github, target: null }); break;
    case 'url': p.share = !!flags.share; break;
    case 'shot': p.route = positional[1] || str(flags.route); p.width = flags.width != null && flags.width !== false ? Number(flags.width) : null; break;
    case 'fields': p.route = positional[1] || str(flags.route); break;
    case 'edit text': Object.assign(p, { field: str(flags.field), find: str(flags.find), to: str(flags.to), file: str(flags.file) }); break;
    case 'edit image': Object.assign(p, { field: str(flags.field), src: str(flags.src), file: str(flags.file) }); break;
    case 'context add': Object.assign(p, { name: positional[1] || null, text: str(flags.text), file: str(flags.file), replace: !!flags.replace }); break;
    case 'refs add': case 'refs remove': p.url = positional[1] || null; break;
    case 'rules add': p.text = positional[1] != null ? String(positional[1]) : null; break;
    case 'tokens set': Object.assign(p, { name: positional[1] || null, value: positional[2] != null ? String(positional[2]) : null, mode: str(flags.mode) }); break;
    case 'agent send': Object.assign(p, { id: positional[0] || null, text: positional[1] != null ? String(positional[1]) : null, submit: flags.submit !== false, target: null }); break;
    case 'home': Object.assign(p, { engine: str(flags.engine), target: null }); break;
    case 'meta set': Object.assign(p, { tag: positional[1] || null, value: positional[2] != null ? String(positional[2]) : null, file: str(flags.file) }); break;
    case 'comments add': Object.assign(p, { text: str(flags.text), selector: str(flags.selector) }); break;
    case 'comments resolve': p.id = positional[1] || null; break;
    case 'sync': Object.assign(p, { strategy: str(flags.strategy), branch: str(flags.branch) }); break;
    case 'publish': Object.assign(p, { to: str(flags.to) || 'staging', message: str(flags.message), gate: flags.gate !== false, scope: str(flags.scope) || 'all', pr: !!flags.pr, commit: flags.commit !== false }); break;
    case 'moments record': p.label = str(flags.label); break;
    case 'moments restore': p.id = positional[1] || null; break;
    case 'agent start': Object.assign(p, { task: positional[1] != null ? String(positional[1]) : null, submit: !!flags.submit, engine: str(flags.engine), label: str(flags.label) }); break;
    case 'agent output': Object.assign(p, { id: positional[0] || null, lines: flags.lines ? Number(flags.lines) : null, target: null }); break;
    case 'agent question': Object.assign(p, { id: positional[0] || null, target: null }); break;
    case 'agent answer': Object.assign(p, { id: positional[0] || null, answer: positional[1] != null ? String(positional[1]) : null, text: str(flags.text), expect: str(flags.expect), target: null }); break;
    case 'agent wait': Object.assign(p, { id: positional[0] || null, waitMs: (flags.timeout ? Number(flags.timeout) : AGENT_WAIT_DEFAULT_S) * 1000, since: flags.since ? Number(flags.since) : null, target: null }); break;
    case 'agent kill': Object.assign(p, { id: positional[0] || null, target: null }); break;
    case 'agent keep': Object.assign(p, { id: positional[0] || null, off: !!flags.off, target: null }); break;
    case 'migrate start': Object.assign(p, { url: positional[0] || null, framework: str(flags.framework), name: str(flags.name), dir: str(flags.dir), files: list(flags.include), only: list(flags.only), engine: str(flags.engine), target: null }); break;
    case 'migrate capture': Object.assign(p, { url: positional[0] || null, only: list(flags.only), target: str(flags.project) }); break;
    case 'migrate compare': Object.assign(p, { routes: list(flags.route), widths: str(flags.widths) ? (flags.widths as string).split(',').map(Number).filter(Boolean) : null }); break;
    default: break;
  }
  return p;
}

// ── where the app lives ──
/**
 * Which Radial this CLI drives: the Mac app bin/radial found (packaged, or a
 * checkout's dev build), or, with no app to launch, the headless core it
 * starts itself (`radial serve`). bin/radial says which in RADIAL_CLI_FLAVOR.
 */
function cliFlavor(env: NodeJS.ProcessEnv): Flavor {
  const f = env.RADIAL_CLI_FLAVOR;
  if (f === 'packaged' || f === 'dev' || f === 'headless') return f;
  return env.RADIAL_CLI_APP ? 'packaged' : 'headless';
}
function flavorName(env: NodeJS.ProcessEnv): string { return env.RADIAL_CLI_FLAVOR === 'dev' ? 'Radial Dev' : 'Radial'; }
function userDataDir(env: NodeJS.ProcessEnv): string {
  if (env.RADIAL_DATA_DIR) return path.resolve(env.RADIAL_DATA_DIR); // --data-dir
  if (env.RADIAL_USERDATA) return env.RADIAL_USERDATA;
  if (env.RADIAL_CLI_SOCK) return dataDirs.dataDirOfSocket(env.RADIAL_CLI_SOCK);
  if (cliFlavor(env) === 'headless') return dataDirs.defaultHeadlessDataDir(env); // radial serve's own, never the app's
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', flavorName(env));
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), flavorName(env));
}
// The data dir's socket, or the short folder's when the data dir's path is too long for one (dataDirs.ts).
function socketPath(env: NodeJS.ProcessEnv): string { return env.RADIAL_CLI_SOCK || dataDirs.cliSocket(userDataDir(env), env); }

function defaultLaunch(env: NodeJS.ProcessEnv): void {
  // No Mac app to launch (Linux, a server, a container): start the headless core in the background.
  if (cliFlavor(env) === 'headless') { (require('../headless') as typeof import('../headless')).spawnDetached(userDataDir(env), { env }); return; }
  const bin = env.RADIAL_CLI_APP;
  if (!bin) throw new Error('RADIAL_CLI_APP is not set (run through bin/radial)');
  const args = env.RADIAL_CLI_APP_ARG ? [env.RADIAL_CLI_APP_ARG] : [];
  const childEnv = { ...env }; delete childEnv.ELECTRON_RUN_AS_NODE; // we run as node; the app must not
  const child = spawn(bin, args, { detached: true, stdio: 'ignore', env: childEnv });
  child.unref();
}

// ── the socket client ──
function connectOnce(sock: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}
async function connect(io: CliIo, { launch = true }: { launch?: boolean } = {}): Promise<Socket> {
  const sock = socketPath(io.env);
  try { return await io.connect(sock); }
  catch (e) {
    if (!launch || !(['ENOENT', 'ECONNREFUSED'] as (string | undefined)[]).includes((e as NodeJS.ErrnoException).code)) throw Object.assign(new Error(`Radial is not reachable at ${sock} (${(e as NodeJS.ErrnoException).code || (e as NodeJS.ErrnoException).message})`), { code: 'unreachable' });
  }
  io.stderr.write(cliFlavor(io.env) === 'headless' ? 'Starting Radial in the background (radial serve)…\n' : 'Starting Radial…\n');
  if (cliFlavor(io.env) === 'headless') { // radial serve's one-time note about usage events, the first time one starts on this data dir
    try { const note = (require('../headless/usage') as typeof import('../headless/usage')).notice(userDataDir(io.env), io.env); if (note) io.stderr.write(note + '\n'); } catch {}
  }
  io.launch(io.env);
  const deadline = Date.now() + (io.launchTimeoutMs || LAUNCH_TIMEOUT_MS);
  let last: NodeJS.ErrnoException | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    try { return await io.connect(sock); } catch (e) { last = e as NodeJS.ErrnoException; }
  }
  throw Object.assign(new Error(`Radial did not come up within ${Math.round((io.launchTimeoutMs || LAUNCH_TIMEOUT_MS) / 1000)}s (${last && last.code})`), { code: 'unreachable' });
}

function request(s: Socket, msg: RequestFrame, { timeoutMs, onProgress }: { timeoutMs: number; onProgress?: (text: string) => void }): Promise<Reply> {
  return new Promise((resolve) => {
    const reqId = 'c' + Date.now().toString(36);
    let done = false;
    const finish = (r: Reply) => { if (done) return; done = true; clearTimeout(timer); try { s.end(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish(proto.err('timeout', `No answer from Radial within ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs);
    s.setEncoding('utf8');
    // The frames are the app's own (cliServer): a progress frame's text is a string, and a reply frame less its op and reqId is the Reply.
    s.on('data', proto.makeDecoder((m) => {
      if (m.reqId !== reqId) return;
      if (m.op === 'progress') { if (onProgress) onProgress(m.text as string); return; }
      if (m.op === 'reply') { const { op, reqId: _r, ...rest } = m; finish(rest as Reply); }
    }));
    s.on('error', (e) => finish(proto.err('unreachable', e.message)));
    s.on('close', () => finish(proto.err('unreachable', 'Radial closed the connection.')));
    s.write(proto.encode({ ...msg, reqId }));
  });
}

// ── RADIAL_URL: a radial serve --listen elsewhere, over HTTP ──
/** RADIAL_URL and RADIAL_TOKEN as the CLI reads them: where the radial serve listens, and the token it sends. */
export interface RemoteCore { url: URL; token: string }
/** The radial serve RADIAL_URL names, an error when RADIAL_URL or RADIAL_TOKEN is wrong, or null without RADIAL_URL (the socket, as ever). */
function remoteOf(env: NodeJS.ProcessEnv): RemoteCore | ErrorReply | null {
  const raw = (env.RADIAL_URL || '').trim();
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return proto.err('bad-request', `RADIAL_URL should be a radial serve --listen address, like http://127.0.0.1:4000, not ${raw}.`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return proto.err('bad-request', `RADIAL_URL should start with http:// or https://, not ${url.protocol}//.`);
  if (url.username || url.password || url.search) return proto.err('bad-request', 'RADIAL_URL takes the address alone: the token goes in RADIAL_TOKEN, never in the URL.');
  const token = (env.RADIAL_TOKEN || '').trim();
  if (!token) return proto.err('unauthorized', 'RADIAL_URL is set, but RADIAL_TOKEN isn\'t. Where Radial runs, `radial token create` makes a token.');
  return { url, token };
}
function isRemote(env: NodeJS.ProcessEnv): boolean { return !!(env.RADIAL_URL || '').trim(); }
/** A path on the radial serve at RADIAL_URL (it may sit under a path of its own, behind a proxy). */
function remoteEndpoint(remote: RemoteCore, p: string, query = ''): URL {
  const u = new URL(remote.url.href);
  u.pathname = u.pathname.replace(/\/+$/, '') + p;
  u.search = query;
  return u;
}
/** A refusal's message, from the JSON the listener answered with (never the request's token). */
function refusalOf(status: number, body: string): ErrorReply {
  let message = '';
  try { const j = JSON.parse(body) as { error?: unknown }; if (typeof j.error === 'string') message = j.error; else if (j.error && typeof (j.error as { message?: unknown }).message === 'string') message = (j.error as { message: string }).message; } catch {}
  if (status === 401) return proto.err('unauthorized', message || 'Radial refused the token in RADIAL_TOKEN.');
  return proto.err('error', message || `Radial answered HTTP ${status}.`);
}

/** One request to the radial serve at RADIAL_URL: a POST to /rpc, its frames read as they stream, as the socket's are. */
function requestRemote(remote: RemoteCore, msg: RequestFrame, { timeoutMs, onProgress }: { timeoutMs: number; onProgress?: (text: string) => void }): Promise<Reply> {
  return new Promise((resolve) => {
    const reqId = 'c' + Date.now().toString(36);
    const body = JSON.stringify({ ...msg, reqId });
    let done = false;
    const finish = (r: Reply) => { if (done) return; done = true; clearTimeout(timer); req.destroy(); resolve(r); };
    const timer = setTimeout(() => finish(proto.err('timeout', `No answer from Radial within ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs);
    const req = (remote.url.protocol === 'https:' ? https : http).request(remoteEndpoint(remote, '/rpc'), { method: 'POST', agent: false, headers: { authorization: `Bearer ${remote.token}`, 'content-type': 'application/json', accept: 'application/x-ndjson', 'content-length': Buffer.byteLength(body) } }, (res) => {
      res.setEncoding('utf8');
      if (res.statusCode !== 200) { let text = ''; res.on('data', (d: string) => { text += d; }); res.on('end', () => finish(refusalOf(res.statusCode || 0, text))); return; }
      // The listener's frames: progress lines, then the reply (a blank line now and then keeps a slow op's connection open).
      res.on('data', proto.makeDecoder((m) => {
        if (m.reqId !== reqId) return;
        if (m.op === 'progress') { if (onProgress) onProgress(m.text as string); return; }
        if (m.op === 'reply') { const { op, reqId: _r, ...rest } = m; finish(rest as Reply); }
      }));
      res.on('end', () => finish(proto.err('unreachable', 'Radial ended the response without a reply.')));
      res.on('error', (e) => finish(proto.err('unreachable', e.message)));
    });
    req.on('error', (e: NodeJS.ErrnoException) => finish(proto.err('unreachable', `Radial isn't answering at ${remote.url.origin} (${e.code || e.message}).`)));
    req.end(body);
  });
}

/** One request to the Radial this CLI drives: RADIAL_URL's radial serve over HTTP, or the socket (starting Radial first when launch allows). */
async function send(io: CliIo, msg: RequestFrame, { timeoutMs, onProgress, launch = true }: { timeoutMs: number; onProgress?: (text: string) => void; launch?: boolean }): Promise<Reply> {
  const remote = remoteOf(io.env);
  if (remote && 'ok' in remote) return remote; // RADIAL_URL or RADIAL_TOKEN is wrong
  if (remote) return requestRemote(remote, msg, { timeoutMs, onProgress });
  let sock: Socket;
  try { sock = await connect(io, { launch }); }
  catch (e) { return proto.err('unreachable', (e as Error).message); }
  return request(sock, msg, { timeoutMs, onProgress });
}

/** A file of the radial serve at RADIAL_URL (a shot's PNG), fetched from its /files with the token. */
function fetchFile(io: Pick<CliIo, 'env'>, file: string, { timeoutMs = 120000 }: { timeoutMs?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const remote = remoteOf(io.env);
    if (!remote || 'ok' in remote) { reject(new Error(remote ? remote.error : 'RADIAL_URL is not set.')); return; }
    // Built from RADIAL_URL, never from a URL in a reply: the token goes only where RADIAL_URL says.
    const req = (remote.url.protocol === 'https:' ? https : http).get(remoteEndpoint(remote, '/files', `?path=${encodeURIComponent(file)}`), { agent: false, headers: { authorization: `Bearer ${remote.token}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => { const body = Buffer.concat(chunks); if (res.statusCode === 200) resolve(body); else reject(new Error(refusalOf(res.statusCode || 0, body.toString('utf8')).error)); });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`No file from Radial within ${Math.round(timeoutMs / 1000)}s.`)));
    req.on('error', reject);
  });
}

// ── offline helpers (the app closed) ──
function readJson(p: string): unknown { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function offlineSources(env: NodeJS.ProcessEnv): ProjectSources {
  const store = (readJson(path.join(userDataDir(env), 'radial-store.json')) || {}) as Partial<RecentsStore>; // the app's own store file (recents.ts)
  const recents = (store.recents || []).filter((r) => r && r.path && fs.existsSync(r.path));
  const available: AvailableProject[] = [];
  if (store.projectsDir) {
    try {
      for (const d of fs.readdirSync(store.projectsDir, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue;
        const p = path.join(store.projectsDir, d.name);
        if (fs.existsSync(path.join(p, 'package.json')) || fs.existsSync(path.join(p, 'index.html'))) available.push({ path: p, name: d.name });
      }
    } catch {}
  }
  return { open: [], recents, available, workspace: [] };
}
function offlineResolve(target: string | null | undefined, io: Pick<CliIo, 'cwd' | 'env'>): ResolveResult {
  let fuzzy: ResolveFuzzy | null = null; try { fuzzy = require('../renderer/fuzzy.js') as typeof import('../renderer/fuzzy.js'); } catch {}
  let urlFromText: typeof import('./github').urlFromText | null = null; try { ({ urlFromText } = require('./github') as typeof import('./github')); } catch {}
  return projectResolve.resolve(target, { cwd: io.cwd, sources: offlineSources(io.env), normalizeOpenPath, urlFromText, findLocalCopy: null, fuzzy });
}
function readDevUrl(dir: string): string | null { const j = readJson(projectData.dataDir(dir, 'dev.json')) as DevInfo | null; return j && j.url ? j.url : null; } // devServer writes dev.json
function offlineContext(dir: string): ProjectContext {
  const bundle: ProjectContext = { name: path.basename(dir), rules: '', docs: [], references: [], pages: null, url: readDevUrl(dir), openComments: null, tokens: null };
  try { const t = (require('./tokens') as typeof import('./tokens')).indexTokens(dir); bundle.tokens = t.tokens.filter((x) => x.type === 'color' || x.type === 'font' || x.type === 'length').slice(0, 80).map((x) => ({ name: x.name, value: x.value, type: x.type, modes: x.modes })); } catch {}
  try { bundle.rules = (require('./projectMemory') as typeof import('./projectMemory')).readForAgent(dir); } catch {}
  try {
    const cdir = projectData.contextDir(dir);
    for (const f of fs.readdirSync(cdir).sort()) {
      const p = path.join(cdir, f); if (!fs.statSync(p).isFile()) continue;
      if (/\.(md|mdx|txt)$/i.test(f)) bundle.docs.push({ file: f, content: fs.readFileSync(p, 'utf8') });
      else bundle.docs.push({ file: f, bytes: fs.statSync(p).size });
    }
  } catch {}
  try { const refs = require('./references') as typeof import('./references'); bundle.references = refs.list(dir) || []; } catch {}
  try { const c = require('./comments') as typeof import('./comments'); bundle.openComments = (c.list(dir) || []).filter((x) => !x.resolved).length; } catch {}
  return bundle;
}

// ── output ──
/** The success replies of every socket op (cliServer's OpReplies). */
type AnySuccess = Extract<OpReplies[OpName], { ok: true }>;
/** Every key of every member of a union. */
type KeyOfEach<U> = U extends unknown ? keyof U : never;
/** Field K's type in the members of union U that have it. */
type FieldOfEach<U, K extends PropertyKey> = U extends unknown ? (K extends keyof U ? U[K] : never) : never;
/**
 * A success reply as printHuman reads it. The verb says which op answered, so
 * each field is typed as the ops that send it have it; a field whose type
 * differs between ops is cast to the verb's own where it is read. main casts
 * its replies to it: nothing checks a reply against it where printHuman is called.
 */
export type HumanReply = { ok: true } & { [K in KeyOfEach<AnySuccess>]?: FieldOfEach<AnySuccess, K> };
/** migrate compare's rows: one compared at a width, or one whose comparison failed. */
type ComparedRow = Exclude<CompareRow, { error: string }>;
type FailedRow = Extract<CompareRow, { error: string }>;
function printHuman(io: Pick<CliIo, 'stdout'>, verb: string, r: HumanReply, flags: Flags): void {
  const out = (s: string) => io.stdout.write(s + '\n');
  const name = r.name || (r.repoDir ? path.basename(r.repoDir) : '');
  switch (verb) {
    case 'focus': return out(r.headless ? 'Radial is running without a window (radial serve). `radial ls` lists the open projects.' : 'Radial is up.');
    case 'open':
      if (r.state === 'queued') return out(`Opening ${r.repoDir}…`);
      return out(`${r.state === 'focused' ? 'Focused' : 'Opened'} ${name}${r.url ? ` → ${r.url}` : r.suspended ? ' (asleep)' : ''}${r.github && (r.github as CloneInfo).action ? ` [${(r.github as CloneInfo).action}]` : ''}`);
    case 'new':
      out(`Created ${r.created}${r.github ? ` · GitHub: ${(r.github as NonNullable<NewProjectExtras['github']>).nameWithOwner}` : ''}${r.githubError ? ` · GitHub skipped: ${r.githubError}` : ''}`);
      return out(`${r.state === 'focused' ? 'Focused' : r.state === 'queued' ? 'Opening' : 'Opened'} ${name}${r.url ? ` → ${r.url}` : ''}`);
    case 'ls': {
      const rows = r.projects || [];
      if (!rows.length && !(r.recents || []).length) return out('No projects open. `radial ls --all` lists recent ones; `radial open <path>` opens one.');
      for (const p of rows) {
        const meta: string[] = [];
        if (p.terminals) meta.push(`${p.terminals} agent${p.terminals === 1 ? '' : 's'}${p.waiting ? ` (${p.waiting} waiting on you)` : ''}`);
        if (p.openComments) meta.push(`${p.openComments} open comment${p.openComments === 1 ? '' : 's'}`);
        if (p.changes) meta.push(`${p.changes} unpublished change${p.changes === 1 ? '' : 's'}`);
        out(`${p.active ? '▶' : '●'} ${p.name.padEnd(22)} ${(p.state === 'running' ? p.url || '' : `(${p.state})`).padEnd(30)} ${meta.length ? meta.join(' · ') + '  ' : ''}${p.repoDir}`);
      }
      for (const p of r.recents || []) out(`  ${p.name.padEnd(22)} ${'(recent)'.padEnd(30)} ${p.repoDir}`);
      return;
    }
    case 'status':
      out(`${name}  ${r.repoDir}`);
      out(`open: ${r.open ? (r.suspended ? 'asleep' : 'running') : 'no'}${r.url ? `  url: ${r.url}` : ''}`);
      if (r.git) {
        const git = r.git;
        // A repository whose `git status` failed (status-failed) has no branch, remote or changes to count.
        out(`git: ${!git.isRepo ? 'not a repository' : !git.ok ? `could not read the status${git.message ? ` (${git.message.split('\n')[0]})` : ''}` : `${git.branch || '?'}${git.remote ? ` · ${git.remote}` : ''} · ${git.changes.length} change${git.changes.length === 1 ? '' : 's'}`}`);
      }
      return;
    case 'url':
      if (r.share) return out(`${r.share.url}\n(One use, within ten minutes: it lets a browser on another machine open ${r.url} for twelve hours.)`);
      return out(r.url!);
    case 'migrate start':
      out(`Created ${r.repoDir} (${r.framework}) from ${r.source} (${r.platform}: ${many(r.pages as number, 'page')}, ${many(r.assets!, 'asset')}).`);
      out(`Capture: ${r.capture}`);
      out(r.session ? `Migration agent started (${r.engine}): ${r.session}. ${r.engine === 'claude' ? 'Claude Code may ask to trust the new folder; choose Yes. ' : ''}Follow it in Radial or with \`radial agent output\`.` : 'Project is open; start the agent with the task above.');
      return out('For best results, use one of the latest frontier models at high to max effort.');
    case 'migrate capture':
      out(`Captured ${r.source} (${r.platform}): ${many(r.pages as number, 'page')}, ${many(r.assets!, 'asset')}, ${r.screensSkipped ? 'no reference screenshots (no browser yet: radial browser install adds one)' : many(r.screens!, 'reference screenshot')}.`);
      return out(`Read ${r.readme}`);
    case 'migrate compare': {
      for (const row of r.rows || []) out((row as Partial<FailedRow>).error ? `${row.route} @${row.width}: ${(row as FailedRow).error}` : `${row.route} @${row.width}: ${(row as ComparedRow).changedPercent}% changed, height ${(row as ComparedRow).heights.live} → ${(row as ComparedRow).heights.local}  ${(row as ComparedRow).files.diff}`);
      return out(`Report: ${r.report}`);
    }
    case 'pages': {
      if (!((r.pages as PageEntry[]) || []).length) return out(r.reason === 'unsupported-router' ? `No pages found. Radial maps routes for static HTML, Next.js, Astro, TanStack Start, SvelteKit and Remix; this project looks like ${r.framework || 'unknown'}.` : r.reason === 'no-source-files' ? `No pages found in the usual folders for ${r.router || r.framework || 'this project'}.` : 'No pages found.');
      return ((r.pages as PageEntry[]) || []).forEach((p) => out(`${(p.route || '/').padEnd(28)} ${p.label || ''}${p.file ? `  ${p.file}` : ''}`));
    }
    case 'comments': {
      const list = r.comments || [];
      if (!list.length) return out('No comments.');
      return list.forEach((c) => out(`${c.resolved ? '[done]' : '[open]'} ${c.route || ''} ${c.selector || c.file || ''}: ${(c.text || '').replace(/\s+/g, ' ')}`));
    }
    case 'comments pull': {
      const parts: string[] = [];
      if (r.added) parts.push(`${r.added} new`);
      if (r.updated) parts.push(`${r.updated} updated`);
      if (r.resolved) parts.push(`${r.resolved} resolved`);
      return out(parts.length ? `Pulled Vercel comments: ${parts.join(', ')} (${r.total} thread${r.total === 1 ? '' : 's'}).` : (r.total ? `Up to date: ${r.total} Vercel thread${r.total === 1 ? '' : 's'}, nothing new.` : 'No Vercel comments on this project yet.'));
    }
    case 'shot': return out(r.path!);
    case 'context': {
      out(`# ${name}${r.url ? `  (preview: ${r.url})` : ''}`);
      if (r.rules) out(`\n${r.rules.trim()}`);
      for (const d of r.docs || []) out(d.content != null ? `\n---\n## .context/${d.file}\n\n${d.content.trim()}` : `\n---\n## .context/${d.file} (${d.bytes} bytes, not text)`);
      if ((r.references || []).length) { out('\n---\n## References (pointers)'); r.references!.forEach((x) => out(`- ${x.label || ''}: ${x.url}`)); }
      if (r.pages) { out('\n---\n## Pages'); (r.pages as PageEntry[]).forEach((p) => out(`- ${p.route}${p.label ? `  ${p.label}` : ''}`)); }
      if (r.tokens && r.tokens.length) { out('\n---\n## Design tokens (radial tokens has all of them)'); r.tokens.forEach((t) => out(`- ${t.name}: ${t.value}${t.modes && t.modes.length ? `  (modes: ${t.modes.join(', ')})` : ''}`)); }
      if (r.openComments) out(`\n${r.openComments} open comment${r.openComments === 1 ? '' : 's'} (radial comments --open)`);
      return;
    }
    case 'sleep': return out(`Asleep: ${name}`);
    case 'wake': return out(`Awake: ${name}${r.url ? ` → ${r.url}` : ''}`);
    case 'reload': return out(r.headless ? `Nothing to reload: no window or browser shows ${name} here (radial serve). Fetch the page from \`radial url\` again.` : `Reloaded: ${name}`);
    case 'restart': return out(`Restarted: ${name}${r.url ? ` → ${r.url}` : ''}`);
    case 'close': return out(`Closed: ${name}`);
    case 'edit text': case 'meta set': return out(r.already ? `Already says that (${r.relFile}:${r.line})` : `Saved → ${r.relFile}:${r.line}`);
    case 'fields': {
      const list = r.fields || [];
      out(`${r.route || '/'}: ${list.length} field${list.length === 1 ? '' : 's'}`);
      const val = (f: ListedField) => f.kind === 'image' ? `${f.src || ''}${f.naturalW ? ` (${f.naturalW}×${f.naturalH})` : ''}${f.alt ? `  alt: ${f.alt}` : ''}` : f.kind === 'animated' ? `(${f.count} elements change by themselves)` : JSON.stringify(f.text.length > 90 ? f.text.slice(0, 90) + '…' : f.text);
      return list.forEach((f) => out(`${String(f.id).padEnd(5)} ${String(f.role || '').padEnd(10)} ${String(f.tag || '').padEnd(7)} ${val(f)}`));
    }
    case 'tokens': {
      const list = (r.tokens as Token[]) || [];
      if (!list.length) return out('No CSS variables in this project’s stylesheets.');
      out(`${r.count || list.length} token${list.length === 1 ? '' : 's'} in ${(r.files || []).length} file${(r.files || []).length === 1 ? '' : 's'}`);
      let last: Token['type'] | null = null;
      for (const t of list) {
        if (t.type !== last) { out(`\n${t.type}`); last = t.type; }
        out(`  ${t.name.padEnd(28)} ${String(t.value).length > 44 ? String(t.value).slice(0, 44) + '…' : String(t.value).padEnd(44)} ${t.modes.length ? `${t.modes.length} modes (${t.modes.join(', ')})` : ''}${t.uses ? `  ${t.uses}×` : '  unused'}  ${t.file}:${t.line}`);
      }
      return;
    }
    case 'tokens set': return out(`Saved ${r.name} → ${r.to}${r.mode && r.mode !== 'default' ? ` (${r.mode})` : ''} in ${r.relFile}:${r.line}`);
    case 'context add': return out(`${r.replaced ? 'Replaced' : 'Added'} .context/${r.rel}`);
    case 'refs add': return out(`Attached ${r.ref && r.ref.url ? r.ref.url : ''}`);
    case 'refs remove': return out(`Detached ${r.url}`);
    case 'rules add': return out('Added the rule to AGENTS.md.');
    case 'undo': return out(`Undid the last edit (${r.relFile}).`);
    case 'redo': return out(`Redid the edit (${r.relFile}).`);
    case 'agent send': return out(`${r.resumedFrom ? `Woke ${r.resumedFrom} with its conversation as ${r.id}, and ${r.submitted ? 'sent' : 'staged'} the text` : `${r.submitted ? 'Sent' : 'Staged'} into ${r.id}`}${r.waiting
      ? ` (its CLI is asking a question of its own first, which \`radial agent question ${r.id}\` shows; the text goes in once that is answered)`
      : r.landed === false ? ' (could not confirm it landed; check the terminal)' : ''}`);
    case 'home': return out(`Home agent ${r.started ? 'started' : 'already running'}: ${r.id} (${r.engine})`);
    // already: the file was copied and the source already pointed at it; the reply has no newSrc or copiedTo.
    case 'edit image': return out(r.already ? `Already uses that image (${r.relFile}:${r.line})` : `Saved → ${r.relFile}:${r.line}  src: ${r.newSrc}  (copied to ${r.copiedTo})`);
    case 'comments add': return out(`Added comment ${r.comment!.id} on ${r.comment!.route}${r.comment!.selector ? ` at ${r.comment!.selector}` : ''}`);
    case 'comments resolve': return out(`Resolved ${r.comment!.id}`);
    case 'sync': return out(r.upToDate ? `Up to date (${r.branch})` : `Pulled ${r.pulled} commit${r.pulled === 1 ? '' : 's'} on ${r.branch}${r.keptLocal ? ' (your local edits were kept)' : ''}`);
    case 'publish': {
      out(`${r.pushed ? 'Pushed' : 'Saved locally for'} ${r.branch || r.target}${r.mode ? ` (${r.mode})` : ''}${r.prUrl ? ` → ${r.prUrl}` : ''}`);
      (r.steps || []).forEach((st) => out(`  ${st}`));
      return;
    }
    case 'moments': {
      const list = r.moments || [];
      if (!list.length) return out('No moments yet.');
      return list.forEach((m) => out(`${String(m.id).padEnd(14)} ${new Date(m.ts).toLocaleString()}  ${String(m.kind || '').padEnd(8)} ${m.label || ''}`));
    }
    case 'moments record': return out(r.skipped ? `Nothing changed since the last moment (${r.id}).` : `Recorded ${r.moment!.id}${r.moment!.label ? `: ${r.moment!.label}` : ''}`);
    case 'moments restore': return out(`Restored.${r.moment ? ` Recorded ${r.moment.id}: ${r.moment.label}` : ''}`);
    case 'agent start': return out(`${r.submitted ? 'Started' : 'Staged'} ${r.engine} session ${r.id} in ${name}${r.label ? `: ${r.label}` : ''}${r.waiting
      ? ` (its CLI is asking a question of its own first, which \`radial agent question ${r.id}\` shows; once that is answered, the task ${r.submitted ? 'runs' : 'goes into its input for you to run'})`
      : `${r.submitted ? '' : ' (press Enter in the session to run it)'}${r.landed === false ? ' (could not confirm the prompt landed; check the terminal)' : ''}`}`);
    case 'agent output': return out(r.text || '(no output yet)');
    case 'agent wait': {
      const why = { bell: 'bell: the session finished a turn, or needs you', idle: 'idle: no output for a while (waiting on input?)', exit: 'exit: the session ended', timeout: 'timeout: still working' }[r.reason as AgentWaitReason] || (r.reason as AgentWaitReason);
      out(why);
      if (r.text) out(`---\n${r.text}`);
      if (r.asking) out(`---\nIts CLI is asking a question of its own: \`radial agent question ${r.id}\` shows it, and \`radial agent answer\` answers it.`);
      return;
    }
    case 'agent question': {
      if (!r.question) return out(`${r.id} isn't asking a question of its own${r.alive === false ? ': the session has ended' : ''}.${r.text ? ` Its screen shows:\n${r.text.split('\n').slice(-12).map((l) => (l ? '  ' + l : l)).join('\n')}` : ''}`);
      out(`${r.id}${r.engine ? ` (${r.engine})` : ''} is asking:\n${describeQuestion(r.question)}`);
      return out(howToAnswer(r.id!, r.question));
    }
    case 'agent answer': {
      const did = r.chose ? `Chose "${r.chose.label}"` : r.question && r.question.takes === 'text' ? 'Typed the text and pressed Enter' : 'Pressed Enter';
      if (r.after === 'exited') return out(`${did} in ${r.id}, and the session ended.`);
      if (r.after === 'gone' || !r.next) return out(`${did} in ${r.id}. The question is gone: its CLI went on.`);
      out(`${did} in ${r.id}. Its CLI asks another question now:\n${describeQuestion(r.next)}`);
      return out(howToAnswer(r.id!, r.next));
    }
    case 'agent list': {
      const list = r.agents || [];
      if (!list.length) return out('No sessions running.');
      const ago = (t: number | null) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))}s ago` : 'never');
      return list.forEach((a) => out(`${String(a.id).padEnd(18)} ${(a.engine || 'shell').padEnd(7)} ${String(a.name || '').padEnd(18)} ${String(a.state || (a.alive ? 'live' : 'exited')).padEnd(8)} output ${ago(a.lastDataAt)} · bell ${ago(a.lastBellAt)}${a.keepAwake ? ' · kept awake' : ''}${a.label ? `  ${a.label}` : ''}`));
    }
    case 'agent kill': return out(`Ended ${r.id}`);
    case 'agent keep': return out(r.on
      ? `Kept awake: ${r.id} is never parked${process.platform === 'darwin' ? ', and this Mac stays awake while it runs' : ''}.${r.daemonOutdated ? ' (Until Radial\'s terminal service restarts — it does once every agent has closed — the Mac stays awake only while Radial is open.)' : ''}`
      : `${r.id} can be parked again.`);
    default: return out(JSON.stringify(r));
  }
}

// How `agent answer` answers a question, by what it takes; --expect keeps the answer to this question.
function howToAnswer(id: string, q: ShownQuestion): string {
  if (q.takes === 'option') return `Answer: radial agent answer ${id} <number or label> --expect ${q.id} --yes`;
  if (q.takes === 'text') return `It takes a line of text: radial agent answer ${id} --text "<text>" --expect ${q.id} --yes (--text - reads it from stdin)`;
  if (q.takes === 'enter') return `It asks for Enter alone: radial agent answer ${id} --expect ${q.id} --yes`;
  if (q.hidden) return 'Radial won\'t answer a question it can\'t show whole: answer it in its terminal.';
  return 'Radial can\'t read its options, so it won\'t answer it: answer it in its terminal.';
}

function printError(io: Pick<CliIo, 'stderr'>, r: ErrorReply): void {
  io.stderr.write(`radial: ${r.error || r.code || 'error'}\n`);
  if (r.fix) io.stderr.write(`  Fix: ${r.fix}\n`);
  if (r.instead) io.stderr.write(`  Instead: ${r.instead}\n`);
  if (r.code === 'ambiguous' && r.candidates) r.candidates.forEach((c, i) => io.stderr.write(`  ${i + 1}. ${c.name}${c.open ? (c.suspended ? ' (asleep)' : ' (open)') : ''}  ${c.path}\n`));
}

// An ambiguous project (resolve's answer) always lists its candidates.
async function pickCandidate(io: CliIo, r: ErrorReply & { candidates: Candidate[] }): Promise<string | null> {
  if (!io.isTTY || !io.readline) return null;
  io.stderr.write(`${r.error}\n`);
  r.candidates.forEach((c, i) => io.stderr.write(`  ${i + 1}. ${c.name}${c.open ? (c.suspended ? ' (asleep)' : ' (open)') : ''}  ${c.path}\n`));
  io.stderr.write('Which one? [number, Enter to cancel] ');
  const ans = await io.readline('');
  const n = parseInt(String(ans || '').trim(), 10);
  return n >= 1 && n <= r.candidates.length ? r.candidates[n - 1].path : null;
}

// ── main ──
/**
 * Where the CLI reads and writes, and how it reaches the app: the process's own
 * (defaultIo), or a test's. It is also the io `radial mcp` hands socketApi.
 */
export interface CliIo {
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  env: NodeJS.ProcessEnv;
  /** Relative paths and the default project resolve against it. */
  cwd: string;
  /** A person at a terminal: the CLI may ask (which project, a production publish). */
  isTTY: boolean;
  /** Opens the app's control socket. */
  connect(sock: string): Promise<Socket>;
  /** Starts the app when its socket isn't there (or, headless, `radial serve` in the background), for this env. */
  launch(env: NodeJS.ProcessEnv): void;
  /** Asks a question at the terminal; without it, the CLI never asks. */
  readline?(question: string): Promise<string>;
  /** How long to wait for a launched app; LAUNCH_TIMEOUT_MS when not set. */
  launchTimeoutMs?: number;
  /** Where `radial mcp` reads requests; process.stdin when not set. */
  stdin?: McpInput;
  /** All of stdin, for `agent answer --text -`; process.stdin's when not set. */
  readStdin?(): Promise<string>;
  /** Stands in for mcp.installConfig (`radial mcp --install`). */
  installConfig?(kind: string, shimPath: string | null): InstallResult;
}
function defaultIo(): CliIo {
  return {
    stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd(),
    isTTY: !!(process.stdin.isTTY && process.stdout.isTTY),
    connect: connectOnce,
    launch: (env) => defaultLaunch(env),
    readline: (q) => new Promise((res) => { const rl = (require('readline') as typeof import('readline')).createInterface({ input: process.stdin, output: process.stderr }); rl.question(q, (a) => { rl.close(); res(a); }); }),
  };
}

/** All of process.stdin, as text. */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { text += chunk; });
    process.stdin.once('end', () => resolve(text));
    process.stdin.once('error', reject);
  });
}

async function main(argv: string[], io: CliIo = defaultIo()): Promise<ExitCode> {
  const { verb, positional, flags, usage } = parseArgs(argv);
  // --data-dir: the Radial on that data dir, for this run and a `radial serve` it starts.
  if (typeof flags.dataDir === 'string') io = { ...io, env: { ...io.env, RADIAL_DATA_DIR: path.resolve(io.cwd, flags.dataDir) } };
  projectData.init(userDataDir(io.env), { readOnly: true });
  const json = !!flags.json;
  if (flags.version) { io.stdout.write(`${appVersion()}\n`); return 0; }
  if (flags.help || verb === 'help') { io.stdout.write(spec.helpText() + '\n'); return 0; }
  if (usage) { // `radial agent`, `radial edit`: the group's verbs, exit 2
    const rows = spec.COMMANDS.filter((c) => c.name.startsWith(verb + ' ')).map((c) => `  radial ${c.name}${c.args ? ' ' + c.args : ''}\n      ${c.summary}`);
    io.stderr.write(`radial ${verb} needs one of:\n${rows.join('\n')}\n`);
    return 2;
  }
  if (verb === 'serve') return (await (require('../headless') as typeof import('../headless')).command(positional, flags, io)) as ExitCode; // serve's codes are the CLI's
  if (verb === 'token') {
    // radial serve's API tokens, in the headless data dir; create says where a running serve listens, when it does.
    const headless = require('../headless') as typeof import('../headless');
    const running = positional[0] === 'create' && !flags.json ? await headless.hello(dataDirs.cliSocket(dataDirs.headlessDataDir(io.env), io.env), 1000) : null;
    return (await headless.tokenCommand(positional, flags, io, (running && running.listen) || null)) as ExitCode; // 0, 2, 3 or 6, as the CLI's
  }
  if (verb === 'browser' || verb === 'doctor') {
    // About radial serve's machine; Radial for Mac shows pages in its own window.
    if (cliFlavor(io.env) === 'packaged') { io.stdout.write(`Radial for Mac shows pages in its own window, so it needs no browser install. \`radial ${verb}\` is for radial serve (a VM, a container, a Linux server).\n`); return 0; }
    const run = verb === 'browser' ? (require('../headless/browser') as typeof import('../headless/browser')).command : (require('../headless/doctor') as typeof import('../headless/doctor')).command;
    return (await run(positional, flags, io)) as ExitCode; // 0, 1 or 2, as the CLI's
  }
  if (verb === 'setup' || verb === 'telemetry') {
    // About radial serve on this machine. Radial for Mac (and a checkout's dev app) sets itself up, and keeps its usage switch in Settings.
    if (cliFlavor(io.env) !== 'headless') {
      io.stdout.write(verb === 'setup'
        ? 'Radial for Mac sets itself up. `radial setup` is for radial serve (a VM, a container, a Linux server); to add Radial to Claude Code here, run radial mcp --install claude-code.\n'
        : 'Radial for Mac keeps its usage switch in Settings. `radial telemetry` is for radial serve (a VM, a container, a Linux server).\n');
      return 0;
    }
    const run = verb === 'setup' ? (require('../headless/setup') as typeof import('../headless/setup')).command : (require('../headless/usage') as typeof import('../headless/usage')).command;
    return (await run(positional, flags, io)) as ExitCode; // 0, 1, 2 or 6, as the CLI's
  }
  if (verb === 'mcp') {
    const mcp = require('./mcp') as typeof import('./mcp');
    if (flags.config) { io.stdout.write(mcp.configSnippet(String(flags.config), io.env.RADIAL_CLI_SHIM || null)); return 0; }
    if (flags.install) {
      try { const r = (io.installConfig || mcp.installConfig)(String(flags.install), io.env.RADIAL_CLI_SHIM || null); io.stdout.write(`${r.action === 'already' ? 'Already configured' : r.action === 'updated' ? 'Updated' : 'Wrote'} ${r.path}${r.action === 'already' ? '' : '. Restart the client to pick it up.'}\n`); return 0; }
      catch (e) { io.stderr.write(`radial: ${(e as Error).message}\n`); return 1; }
    }
    await mcp.serve({ input: io.stdin || process.stdin, output: io.stdout, log: (m) => io.stderr.write(m + '\n'), api: mcp.socketApi(module.exports as typeof import('./cli'), io) });
    return 0;
  }
  const payload = buildPayload(verb, positional, flags, io);
  // agent answer --text -: the text from stdin, so a key stays out of the shell's history and the process list.
  if (verb === 'agent answer' && payload.text === '-') {
    const typed = (await (io.readStdin || readStdin)()).replace(/\r?\n$/, '');
    if (!typed) { const e = proto.err('bad-request', '--text - reads the text to type from stdin, and stdin had none.'); if (json) io.stdout.write(JSON.stringify(e) + '\n'); else printError(io, e); return proto.exitCodeFor(e); }
    payload.text = typed;
  }
  const target = payload.target;
  const timeoutMs = verb === 'agent wait' ? payload.waitMs! + 10000 : flags.timeout ? Number(flags.timeout) * 1000 : (TIMEOUTS[payload.op] || 30000); // buildPayload sets waitMs for agent wait
  payload.timeoutMs = timeoutMs;

  // Production may trigger deployment; interactive callers confirm the destination.
  if (verb === 'publish' && payload.to === 'production' && !payload.yes && io.isTTY && io.readline && !json) {
    io.stderr.write('Push to the configured production branch? This may trigger deployment or open a pull request. [y/N] ');
    const ans = await io.readline('');
    if (/^y(es)?$/i.test(String(ans || '').trim())) payload.yes = true;
    else { io.stderr.write('Cancelled.\n'); return proto.exitCodeFor(proto.err('needs-yes', 'cancelled')); }
  }

  // Offline fast paths: `url` and `context` need only the disk when the app isn't running (not a radial serve elsewhere's: RADIAL_URL).
  const remote = isRemote(io.env);
  if (!remote && (verb === 'url' || verb === 'context' || verb === 'tokens') && !fs.existsSync(socketPath(io.env))) {
    const r = offlineResolve(target, io);
    if (!r.ok) { if (!json) printError(io, r); else io.stdout.write(JSON.stringify(r) + '\n'); return proto.exitCodeFor(r); }
    if (r.kind === 'clone') { const e = proto.err('not-found', `${r.url} is not on this machine yet. Run \`radial open ${r.url}\` first.`); if (json) io.stdout.write(JSON.stringify(e) + '\n'); else printError(io, e); return proto.exitCodeFor(e); }
    const reply: ErrorReply | HumanReply = verb === 'url'
      ? (readDevUrl(r.dir) ? { ok: true, repoDir: r.dir, url: readDevUrl(r.dir) } : proto.err('no-dev-server', `${r.dir} is not running in Radial. Run \`radial open ${r.dir}\` first.`))
      : verb === 'tokens' ? { ok: true, repoDir: r.dir, ...((require('./tokens') as typeof import('./tokens')).indexTokens(r.dir) as Omit<TokenIndex, 'ok'>) } // Omit only quiets TS2783: indexTokens' own ok (always true) overwrites the literal one
      : { ok: true, repoDir: r.dir, ...offlineContext(r.dir) };
    if (json) io.stdout.write(JSON.stringify(reply) + '\n'); else if (reply.ok) printHuman(io, verb, reply, flags); else printError(io, reply);
    return proto.exitCodeFor(reply);
  }

  const onProgress = (t: string) => io.stderr.write(t.endsWith('\n') ? t : t + '\n');
  let reply = await send(io, payload, { timeoutMs, onProgress, launch: true });
  if (!reply.ok && reply.code === 'ambiguous' && reply.pick !== false && !json) { // pick:false = an ambiguous EDIT, not a project
    const pick = await pickCandidate(io, reply as ErrorReply & { candidates: Candidate[] });
    if (pick) reply = await send(io, { ...payload, target: pick }, { timeoutMs, onProgress, launch: false });
  }
  // A shot of a radial serve elsewhere is on its disk, not this one's: fetch it into this machine's own Radial
  // data dir (this user's, unlike a shared /tmp), as a serve here keeps its shots, so the path printed opens here.
  if (remote && verb === 'shot' && reply.ok) {
    const shot = reply as OpReplies['shot'];
    try {
      const local = path.join(userDataDir(io.env), 'shots', path.basename(shot.path));
      fs.mkdirSync(path.dirname(local), { recursive: true, mode: 0o700 });
      fs.writeFileSync(local, await fetchFile(io, shot.path));
      reply = { ...shot, serverPath: shot.path, path: local };
    } catch (e) { io.stderr.write(`radial: the shot is on Radial's machine at ${shot.path}, and fetching it failed: ${(e as Error).message}\n`); }
  }
  if (json) io.stdout.write(JSON.stringify(reply) + '\n');
  else if (reply.ok) printHuman(io, verb, reply as HumanReply, flags); // the app's own reply to this verb's op (cliServer's OpReplies); printHuman reads it per verb
  else printError(io, reply);
  return proto.exitCodeFor(reply);
}

function appVersion(): string { try { return (require('../../package.json') as { version: string }).version; } catch { return 'unknown'; } }

/**
 * Runs the CLI as this process: main on argv, its answer as the exit code.
 * bin/radial runs this file; the radial-cli package's bin calls it through
 * src/headless/npmBin.ts.
 */
function run(argv: string[]): void {
  // `radial moments | head`: a closed pipe is the reader's choice, not an error.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e && e.code === 'EPIPE') process.exit(0); });
  main(argv).then((code) => { process.exitCode = code; }, (e: unknown) => { process.stderr.write(`radial: ${e && (e as Error).message || e}\n`); process.exitCode = 1; });
}

export { main, run, parseArgs, buildPayload, socketPath, userDataDir, cliFlavor, offlineContext, offlineSources, offlineResolve, readDevUrl, connect, request, send, isRemote, remoteOf, fetchFile, appVersion, printHuman, TIMEOUTS, AGENT_WAIT_DEFAULT_S };

if (require.main === module) run(process.argv.slice(2));
