/**
 * radial serve --listen (plans/headless-core.md, phase 4): Radial over HTTP,
 * for agents and viewers that can't reach its control socket (another
 * machine, another user, a container's host):
 * - POST /mcp: MCP over Streamable HTTP, stateless, answered in JSON, as
 *   radial-cloud's route.ts does it. The methods are `radial mcp`'s own
 *   (mcp.ts createHandler), so tools/list is the same over both, and a
 *   notification gets 202.
 * - POST /rpc: the control socket's protocol. The body is one request; the
 *   response streams its frames, progress then the reply, one JSON line each,
 *   so a slow op (a page op, a migration) reports as it goes and a blank line
 *   every 15 s keeps the connection alive. The CLI uses it when RADIAL_URL and
 *   RADIAL_TOKEN are set.
 * - GET /events: server-sent events for viewers: the core's events (less the
 *   terminals' raw output) and the browser's (it started, it stopped, it kept a
 *   page from leaving loopback).
 * - GET /files?path=<file>: a shot's PNG, or a migration compare's
 *   screenshots, diffs and report: files under the data dir's shots folder
 *   or a known project's compare folder, never anywhere else (servable()).
 *   Replies over HTTP name these files by url as well as by path.
 *
 * Every request, on every path, needs an API token (apiTokens.ts) in its
 * Authorization header, even on loopback, where the other users of a shared
 * machine can reach the port too; a missing, wrong or revoked one gets 401
 * with WWW-Authenticate. Two checks come first, for browsers, since site
 * JavaScript runs on this machine (radial serve's own browser among them):
 * - the Host header must be one of the listener's own addresses (hostAllowed),
 *   so a DNS name that rebinds to this machine reaches nothing;
 * - a request with an Origin header (a web page's fetch) is refused unless
 *   --allow-origin names that origin; there is no CORS otherwise.
 * It listens on loopback unless --allow-remote (parseListen, serve.ts).
 */
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import * as mcp from '../main/mcp';
import * as projectData from '../main/projectData';
import { err } from '../main/cliProto';
import type { Reply } from '../main/cliProto';
import type { DispatchVia, HttpCaller, OpRequest, PreviewAddress, PreviewAsk } from '../main/cliServer';
import type { PreviewNow } from '../core/sessions';
import type { Listener } from '../core/host';
import type { TokenStore } from './apiTokens';
import { createProxies, isWildcard, urlHost } from './previewProxy';
import type { PreviewProxies } from './previewProxy';

/** Where to listen: --listen's host and port. */
export interface ListenAddress { host: string; port: number }

/** The biggest request body taken: a .context doc or a long task fits many times over. */
const MAX_BODY = 8 * 1024 * 1024;
/** How often a quiet /rpc response or /events stream sends something, so nothing between closes it as idle. */
const KEEPALIVE_MS = 15 * 1000;
/** An /events stream whose reader falls this far behind is dropped, rather than serve holding everything for it. */
const MAX_EVENT_BACKLOG = 1024 * 1024;
/** The most /events streams one token may hold open. */
const MAX_STREAMS_PER_TOKEN = 16;
/** What /files serves, by extension: a shot or a compare's images, and its report. */
const FILE_TYPES: Partial<Record<string, string>> = { '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };

/**
 * --listen's value as an address: host:port, [v6]:port, :port or a bare port
 * (both on 127.0.0.1). localhost means 127.0.0.1, so what's printed is what's
 * bound. Port 0 lets the OS pick (serve status says which).
 */
export function parseListen(value: unknown): ListenAddress | { error: string } {
  const v = typeof value === 'string' ? value.trim() : '';
  const usage = { error: `--listen takes an address and port, like 127.0.0.1:4000 or 4000, not ${v || 'nothing'}.` };
  // A bare port or :port, [v6]:port, or host:port; an IPv6 address goes in brackets.
  const m = /^:?(\d{1,5})$/.exec(v) || /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(v) || /^([^:[\]]+):(\d{1,5})$/.exec(v);
  if (!m) return usage;
  const [host0, portText] = m.length === 2 ? ['127.0.0.1', m[1]] : [m[1], m[2]];
  const port = Number(portText);
  if (port > 65535) return usage;
  const host = host0.toLowerCase() === 'localhost' ? '127.0.0.1' : host0;
  if (!net.isIP(host)) return { error: `--listen takes an IP address (127.0.0.1, 0.0.0.0, ::1), not the name ${host}. A name requests may come addressed to goes in --allow-host.` };
  return { host, port };
}

/** Whether an address is this machine's own: 127.0.0.0/8 or ::1 (also IPv4-mapped). */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
  return h === '::1' || h === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** A Host header's name or address, without its port or brackets; null when there's none. */
export function hostName(header: string | undefined): string | null {
  const h = String(header || '').trim().toLowerCase();
  if (!h) return null;
  const m = /^\[([0-9a-f:.]+)\](?::\d+)?$/.exec(h) || /^([^:]+)(?::\d+)?$/.exec(h);
  return m ? m[1] : null;
}

/** What a request's Host may be: the bind address, and the names --allow-host adds. */
export interface HostRule { bindHost: string; allowHosts: string[] }
/**
 * Whether a request's Host header is one of the listener's own addresses, the
 * defence against DNS rebinding: a page's own name that resolves to this
 * machine still says that name. Allowed: a loopback address or localhost,
 * always; the bind address; with a wildcard bind (0.0.0.0, ::), any IP
 * address, since one can't be rebound and the machine may be reached by an
 * address it doesn't know (NAT, a published Docker port); and the names
 * --allow-host gives. The port isn't checked: an SSH tunnel or a published
 * port may change it.
 */
export function hostAllowed(header: string | undefined, rule: HostRule): boolean {
  const name = hostName(header);
  if (!name) return false;
  if (isLoopbackHost(name)) return true;
  if (rule.allowHosts.some((h) => h.toLowerCase() === name)) return true;
  if (!net.isIP(name)) return false;
  return isWildcard(rule.bindHost) || name === rule.bindHost.replace(/^\[|\]$/g, '').toLowerCase();
}

/** Whether a request's Origin may call: none (not a web page's fetch), or one --allow-origin names exactly. */
export function originAllowed(origin: string | undefined, allowOrigins: string[]): boolean {
  if (origin === undefined) return true;
  return allowOrigins.some((o) => o.replace(/\/+$/, '').toLowerCase() === origin.trim().toLowerCase());
}

/** A folder /files may serve from: everything under root, as long as nothing from anchor down is a symbolic link. */
export interface FileRoot { anchor: string; root: string }
/**
 * Whether /files may send a file: an absolute path as written (no ..), inside
 * one of the roots, with no symbolic link from the root's anchor down to it
 * (a site's repo could carry a .radial/migrate/compare link to anywhere), a
 * regular file, and a kind /files serves (PNG, JSON, Markdown).
 */
export function servable(file: string, roots: FileRoot[]): boolean {
  if (!file || !path.isAbsolute(file) || path.normalize(file) !== file || !FILE_TYPES[path.extname(file).toLowerCase()]) return false;
  for (const { anchor, root } of roots) {
    const inside = path.relative(root, file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) continue;
    const below = path.relative(anchor, file);
    if (!below || below.startsWith('..') || path.isAbsolute(below)) continue;
    let at = anchor, ok = true;
    for (const part of below.split(path.sep)) {
      at = path.join(at, part);
      try { if (fs.lstatSync(at).isSymbolicLink()) { ok = false; break; } } catch { ok = false; break; }
    }
    try { if (ok && fs.lstatSync(file).isFile()) return true; } catch {}
  }
  return false;
}

/**
 * Opens a file servable() allows, so what's sent is what was checked: opened
 * without following a link at its last step, then checked again (a folder
 * swapped for a link meanwhile shows), and the file opened must be the one the
 * path names now, a plain file with one name (a hard link in a compare folder
 * would have two, and could be any file of the person's). The caller closes it.
 */
export function openServable(file: string, roots: FileRoot[]): { fd: number; size: number } | null {
  if (!servable(file, roots)) return null;
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); } catch { return null; }
  try {
    const opened = fs.fstatSync(fd);
    if (servable(file, roots)) {
      const named = fs.lstatSync(file);
      if (opened.isFile() && opened.nlink === 1 && opened.dev === named.dev && opened.ino === named.ino) return { fd, size: opened.size };
    }
  } catch {}
  fs.closeSync(fd);
  return null;
}

/** The folders /files serves: the data dir's shots, and each project's migration compares (in its folder, or in the data dir with local storage). */
export function fileRoots(dataDir: string, projects: string[]): FileRoot[] {
  const roots: FileRoot[] = [{ anchor: dataDir, root: path.join(dataDir, 'shots') }];
  for (const repoDir of projects) {
    try {
      const data = projectData.dataDir(repoDir); // <project>/.radial, or the data dir's project-data/<id>/.radial
      roots.push({ anchor: path.dirname(data), root: path.join(data, 'migrate', 'compare') });
    } catch {}
  }
  return roots;
}

/** A file a reply names, as a url on this listener (the way the caller reached it). */
export const fileUrl = (base: string, file: string): string => `${base}/files?path=${encodeURIComponent(file)}`;
/** A reply over HTTP: the files it names (a shot, a compare's images and report) get urls beside their paths. */
export function withFileUrls(op: string, reply: Reply, base: string): Reply {
  if (!reply.ok) return reply;
  const r = reply as Record<string, unknown>;
  if (op === 'shot' && typeof r.path === 'string') return { ...reply, url: fileUrl(base, r.path) };
  if (op === 'migrateCompare' && Array.isArray(r.rows)) {
    const rows = (r.rows as Record<string, unknown>[]).map((row) => {
      const files = row.files as Record<string, string> | undefined;
      return files ? { ...row, urls: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fileUrl(base, f)])) } : row;
    });
    return { ...reply, rows, ...(typeof r.report === 'string' ? { reportUrl: fileUrl(base, r.report) } : {}) };
  }
  return reply;
}

/** What the listener needs from radial serve. */
export interface ListenerOptions {
  address: ListenAddress;
  /** --allow-remote: it may listen beyond loopback, and the previews then need a pass from other machines. */
  allowRemote: boolean;
  allowHosts: string[];
  allowOrigins: string[];
  dataDir: string;
  version: string;
  tokens: TokenStore;
  /** The control socket's ops (the core's dispatch). */
  dispatch(msg: OpRequest, via: DispatchVia): Promise<Reply>;
  /** The projects the core knows (open and recent), whose compare folders /files serves. */
  projects(): string[];
  /** For the preview proxies: a project's preview now, waking one, and noting a browser used it. */
  preview(repoDir: string): PreviewNow;
  wake(repoDir: string): Promise<string | null>;
  used(repoDir: string): void;
  log: (line: string) => void;
  /** The proxies' clock, a test seam. */
  now?: () => number;
}

/** The running listener: the core's Listener seam, and what serve does with it besides. */
export interface HttpListener extends Listener {
  /** The port it listens on (the OS's pick for --listen <host>:0). */
  readonly port: number;
  /** Sends an event to every open /events stream. */
  publish(channel: string, payload: unknown): void;
  /** How many /events streams are open. */
  watchers(): number;
  readonly proxies: PreviewProxies;
  close(): Promise<void>;
}

interface Stream { res: http.ServerResponse; tokenId: string }

/** Starts the listener; rejects when it can't listen there (the port is taken). */
export async function startListener(opts: ListenerOptions): Promise<HttpListener> {
  const { tokens, log } = opts;
  const rule: HostRule = { bindHost: opts.address.host, allowHosts: opts.allowHosts };
  const streams = new Set<Stream>();
  const sockets = new Set<net.Socket>();
  // Refusals are logged once a minute per caller and reason: a scanner can't flood the log.
  const lastRefusal = new Map<string, number>();
  const noteRefusal = (req: http.IncomingMessage, why: string) => {
    const key = `${req.socket.remoteAddress}|${why}`, t = Date.now();
    if ((lastRefusal.get(key) || 0) > t - 60000) return;
    lastRefusal.set(key, t);
    if (lastRefusal.size > 1000) lastRefusal.clear();
    log(`[http] Refused ${req.method} ${(req.url || '').split('?')[0]} from ${req.socket.remoteAddress}: ${why}.`);
  };

  const server = http.createServer();
  server.maxConnections = 1024;
  server.on('connection', (s: net.Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    if (res.headersSent) { res.destroy(); return; }
    const text = JSON.stringify(body);
    // A refused request (no token, a foreign Host or Origin) closes its connection: nothing more is read from it.
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), ...(status === 401 || status === 403 ? { connection: 'close' } : {}), ...headers });
    res.end(text);
  };
  const refuse = (res: http.ServerResponse, status: number, error: string, headers: Record<string, string> = {}) => send(res, status, { ok: false, code: status === 401 ? 'unauthorized' : status === 404 ? 'not-found' : 'bad-request', error }, headers);

  /** A request's body as text; null past MAX_BODY (the rest is read and dropped, so the 413 reaches the caller). Only callers with a token get here. */
  function readBody(req: http.IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      let chunks: Buffer[] | null = [];
      let size = 0;
      req.on('data', (d: Buffer) => { size += d.length; if (size > MAX_BODY) chunks = null; else if (chunks) chunks.push(d); });
      req.on('end', () => resolve(chunks ? Buffer.concat(chunks).toString('utf8') : null));
      req.on('error', () => resolve(null));
    });
  }

  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.on('error', () => {});
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    handle(req, res).catch((e: Error) => { log(`[http] ${req.method} ${(req.url || '').split('?')[0]} failed: ${e.message}`); if (!res.headersSent) send(res, 500, { ok: false, code: 'error', error: 'Radial had a problem with that request.' }); else res.destroy(); });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://radial');
    const route = url.pathname;
    // Browsers first: a name that isn't ours (DNS rebinding), then a web page's call (Origin).
    if (!hostAllowed(req.headers.host, rule)) {
      noteRefusal(req, `Host ${req.headers.host || 'missing'}`);
      return refuse(res, 403, `Radial doesn't answer requests addressed to ${req.headers.host || 'no host'}. Use the address it listens on, or allow the name with radial serve --allow-host <name>.`);
    }
    const origin = req.headers.origin;
    if (!originAllowed(origin, opts.allowOrigins)) {
      noteRefusal(req, `Origin ${origin}`);
      return refuse(res, 403, `Radial refuses calls from web pages (this one came from ${origin}). radial serve --allow-origin <origin> lets one in.`);
    }
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-expose-headers', 'www-authenticate');
      if (req.method === 'OPTIONS') { // a preflight carries no token: it only asks what the real request may send
        res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, last-event-id', 'access-control-max-age': '600' });
        res.end();
        return;
      }
    }
    const auth = tokens.check(req.headers.authorization);
    if (!auth.ok) {
      noteRefusal(req, auth.why === 'missing' ? 'no token' : 'a token it doesn\'t accept');
      const error = auth.why === 'missing'
        ? 'Radial needs an API token in the Authorization header (Bearer). Where Radial runs, `radial token create` makes one.'
        : 'Radial doesn\'t accept that token: it is wrong, or it was revoked. Where Radial runs, `radial token list` shows the ones it takes.';
      const challenge = { 'www-authenticate': `Bearer realm="radial"${auth.why === 'invalid' ? ', error="invalid_token"' : ''}` };
      if (route === '/mcp') return send(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: error } }, challenge);
      return refuse(res, 401, error, challenge);
    }
    const caller: HttpCaller = { tokenId: auth.id, host: hostName(req.headers.host)! }; // hostAllowed found one
    const base = `http://${req.headers.host}`;
    if (route === '/mcp') return req.method === 'POST' ? mcpRequest(req, res, caller, base) : refuse(res, 405, 'POST JSON-RPC to /mcp; this server sends no stream of its own.', { allow: 'POST' });
    if (route === '/rpc') return req.method === 'POST' ? rpc(req, res, caller, base) : refuse(res, 405, 'POST one request to /rpc.', { allow: 'POST' });
    if (route === '/events') return req.method === 'GET' ? events(req, res, caller) : refuse(res, 405, 'GET /events.', { allow: 'GET' });
    if (route === '/files') return req.method === 'GET' || req.method === 'HEAD' ? file(req, res, url.searchParams.get('path') || '') : refuse(res, 405, 'GET /files?path=<file>.', { allow: 'GET, HEAD' });
    req.resume();
    return refuse(res, 404, `Radial has nothing at ${route}. Its paths: /mcp, /rpc, /events and /files.`);
  }

  async function mcpRequest(req: http.IncomingMessage, res: http.ServerResponse, caller: HttpCaller, base: string): Promise<void> {
    // A client names the version initialize agreed on; one this server doesn't speak is a 400, as the transport says.
    const version = req.headers['mcp-protocol-version'];
    if (typeof version === 'string' && !mcp.PROTOCOL_VERSIONS.includes(version)) { req.resume(); return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `This server speaks MCP ${mcp.PROTOCOL_VERSIONS.join(', ')}, not ${version.slice(0, 40)}.` } }); }
    const body = await readBody(req);
    if (body == null) return send(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'The request is too big.' } });
    let message: unknown;
    try { message = JSON.parse(body); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'That isn\'t JSON.' } }); }
    // This caller's tools: the same ops, with replies that name files by url too, and a shot's image read from this disk.
    const handler = mcp.createHandler(mcp.apiOver({
      version: () => opts.version,
      call: async (verb, args) => {
        const payload = mcp.argsToPayload(verb, args || {});
        return withFileUrls(payload.op, await opts.dispatch(payload, { http: caller }), base);
      },
      image: async (shot) => {
        const opened = openServable(shot.path, fileRoots(opts.dataDir, opts.projects()));
        if (!opened) return null;
        try { return fs.readFileSync(opened.fd); } finally { fs.closeSync(opened.fd); }
      },
    }), (line) => log(line));
    const messages = Array.isArray(message) ? message : [message];
    if (!messages.length || messages.some((m) => !m || typeof m !== 'object' || (m as Record<string, unknown>).jsonrpc !== '2.0')) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'That isn\'t a JSON-RPC 2.0 message.' } });
    const answers = (await Promise.all(messages.map((m) => handler(m as Record<string, unknown>)))).filter((a): a is mcp.RpcResponse => !!a);
    // Notifications and a client's own responses get no answer: 202 and nothing more.
    if (!answers.length) { res.writeHead(202, { 'content-length': '0' }); res.end(); return; }
    return send(res, 200, Array.isArray(message) ? answers : answers[0]);
  }

  async function rpc(req: http.IncomingMessage, res: http.ServerResponse, caller: HttpCaller, base: string): Promise<void> {
    const body = await readBody(req);
    if (body == null) return refuse(res, 413, 'The request is too big.');
    let msg: OpRequest;
    try { msg = JSON.parse(body) as OpRequest; } catch { return refuse(res, 400, 'The body should be one request as JSON, like {"op":"ls"}.'); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.op !== 'string') return refuse(res, 400, 'The body should be one request as JSON, like {"op":"ls"}.');
    const reqId = msg.reqId;
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
    res.flushHeaders();
    const keepalive = setInterval(() => res.write('\n'), KEEPALIVE_MS);
    try {
      const reply = await opts.dispatch(msg, { http: caller, progress: (text) => res.write(JSON.stringify({ op: 'progress', reqId, text }) + '\n') });
      res.end(JSON.stringify({ op: 'reply', reqId, ...withFileUrls(msg.op, reply, base) }) + '\n');
    } finally { clearInterval(keepalive); }
  }

  function events(req: http.IncomingMessage, res: http.ServerResponse, caller: HttpCaller): void {
    req.resume();
    if ([...streams].filter((s) => s.tokenId === caller.tokenId).length >= MAX_STREAMS_PER_TOKEN) return refuse(res, 429, `One token may hold ${MAX_STREAMS_PER_TOKEN} event streams open at once.`);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
    res.write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ version: opts.version, pid: process.pid })}\n\n`);
    const stream: Stream = { res, tokenId: caller.tokenId };
    streams.add(stream);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
    res.on('close', () => { clearInterval(keepalive); streams.delete(stream); });
  }
  // A revoked token's streams end at once: the store watches its file.
  const unwatch = tokens.onChange(() => { for (const s of [...streams]) if (!tokens.isLive(s.tokenId)) { streams.delete(s); s.res.end(); } });

  function file(req: http.IncomingMessage, res: http.ServerResponse, wanted: string): void {
    req.resume();
    const opened = openServable(wanted, fileRoots(opts.dataDir, opts.projects()));
    if (!opened) return refuse(res, 404, 'No such file here. /files serves shots and migration compares, by the path a reply gave.');
    res.writeHead(200, { 'content-type': FILE_TYPES[path.extname(wanted).toLowerCase()]!, 'content-length': String(opened.size) }); // servable checked the type
    if (req.method === 'HEAD') { fs.closeSync(opened.fd); res.end(); return; }
    // The descriptor that was checked, not the path again.
    fs.createReadStream(wanted, { fd: opened.fd, autoClose: true }).on('error', () => res.destroy()).pipe(res);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.address.port, opts.address.host, () => { server.off('error', reject); resolve(); });
  });
  server.on('error', (e) => log(`[http] ${e.message}`));
  const port = (server.address() as net.AddressInfo).port;
  const address = `http://${urlHost(opts.address.host)}:${port}`;

  const proxies = createProxies({
    dataDir: opts.dataDir, bindHost: opts.address.host, basePort: port, remote: opts.allowRemote,
    hostAllowed: (h) => hostAllowed(h, rule),
    preview: opts.preview, wake: opts.wake, used: opts.used,
    tokenLive: (id) => tokens.isLive(id), log, now: opts.now,
  });

  return {
    address,
    port,
    proxies,
    preview: (repoDir: string, ask: PreviewAsk): Promise<PreviewAddress | null> => proxies.preview(repoDir, ask),
    publish(channel, payload) {
      if (!streams.size) return;
      const data = `event: ${channel}\ndata: ${JSON.stringify(payload === undefined ? null : payload)}\n\n`;
      for (const s of [...streams]) {
        // A reader that stopped reading is dropped, not buffered for without end.
        if (s.res.writableLength > MAX_EVENT_BACKLOG) { streams.delete(s); s.res.destroy(); continue; }
        s.res.write(data);
      }
    },
    watchers: () => streams.size,
    async close() {
      unwatch();
      for (const s of [...streams]) s.res.end();
      streams.clear();
      await proxies.close();
      await new Promise<void>((resolve) => { server.close(() => resolve()); for (const s of sockets) s.destroy(); });
    },
  };
}
