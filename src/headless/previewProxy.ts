/**
 * radial serve's preview proxies (plans/headless-core.md, phase 4): with
 * --listen, each open project gets one port of its own that forwards HTTP
 * requests and websocket upgrades (the dev server's hot reload) to wherever
 * its dev server runs now. The dev server's own port is the OS's pick and
 * changes on every restart; the proxy's stays, and a request in flight during
 * a restart waits for the new server.
 * - Port-based, not path-based: a site's absolute paths (/assets/x.js, the
 *   HMR client's websocket) work as they are. The Host header goes through
 *   unchanged, so absolute URLs a framework builds from it point back here.
 * - The ports: the one the project had last time (preview-ports.json in the
 *   data dir), else the first free one after the listener's port, so Docker
 *   can publish a range (-p 4000-4020:4000-4020).
 * - A proxy opens on the first `radial url` for its project, and closes once
 *   the project does. A sleeping project wakes when its preview is visited.
 * - Like the listener, a proxy refuses a Host that isn't one of this machine's
 *   addresses or names (listen.ts hostAllowed): another site's page in a
 *   browser here can't read the preview through a DNS name it points here.
 *   A websocket upgrade must also come from the preview's own pages (its
 *   Origin), so another site can't open the hot-reload socket on this known
 *   port. Only a dev server's 101 joins the two ends of an upgrade.
 * - Loopback, the default, needs no pass: the same trust as the dev server's
 *   own port. With --allow-remote the proxies listen where the listener does,
 *   and every browser needs a pass, this machine's own too, since a tunnel to
 *   the stable port (ngrok, tailscale funnel, an editor's port forwarding)
 *   would make anyone local. `radial url --share` prints a link with a ticket
 *   (one use, ten minutes) that this proxy swaps for an HttpOnly cookie of its
 *   own; the cookie lasts twelve hours, or until the token that made the link
 *   is revoked, or the proxy closes, and never reaches the dev server. An open
 *   websocket ends with its pass. Over the socket (an agent on this machine),
 *   `radial url` then answers the dev server's own address, which needs none.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import type { Duplex } from 'stream';
import type { PreviewNow } from '../core/sessions';
import type { HttpCaller, PreviewAddress } from '../main/cliServer';

/** Where a share link lands: the ticket is swapped for a pass here, and nothing under it reaches the dev server. */
export const PASS_PATH = '/__radial/pass';
/** A share link's ticket works once, within this long. */
export const TICKET_MS = 10 * 60 * 1000;
/** A pass (the cookie a ticket becomes) lasts this long. */
export const PASS_MS = 12 * 60 * 60 * 1000;
/** How long a GET waits for a restarting dev server before it gives up. */
const RESTART_WAIT_MS = 30 * 1000;
/** How many ports after the listener's a proxy may take before it lets the OS pick. */
const PORT_SPAN = 200;
/** The most a dev server's answer to an upgrade may be before its 101 is in. */
const MAX_UPGRADE_ANSWER = 64 * 1024;
/** A proxy's cookie: one name per port, since cookies are kept by host, not port, and every proxy on a host sees them all. */
export const cookieName = (port: number): string => `radial_pass_${port}`;
const COOKIE_PREFIX = 'radial_pass_';

/** What the proxies need from radial serve. */
export interface ProxyOptions {
  dataDir: string;
  /** Where the proxies listen: the listener's address (loopback unless --allow-remote). */
  bindHost: string;
  /** The listener's port: a proxy takes one of the ports after it. */
  basePort: number;
  /** --allow-remote: every browser needs a pass. */
  remote: boolean;
  /** The listener's Host rule (listen.ts hostAllowed). */
  hostAllowed(host: string | undefined): boolean;
  /** A project's preview as it runs now (sessions.ts previewNow). */
  preview(repoDir: string): PreviewNow;
  /** Wakes a sleeping project; answers why it couldn't, or null once it runs. */
  wake(repoDir: string): Promise<string | null>;
  /** A browser used the preview: the project's idle clock starts again. */
  used(repoDir: string): void;
  /** Whether an API token (by id) is still accepted: a pass dies with the token that made its link. */
  tokenLive(id: string): boolean;
  log?: (line: string) => void;
  now?: () => number;
}

/** The proxies, as the listener holds them. */
export interface PreviewProxies {
  /**
   * A project's preview through its proxy (opening it on the first ask), and a
   * share link when asked; null for an agent on this machine (no HTTP caller)
   * when the proxies need a pass, as the dev server's own address serves it better.
   */
  preview(repoDir: string, ask: { http: HttpCaller | null; share: boolean }): Promise<PreviewAddress | null>;
  /** Closes the proxies of projects that closed, forgets spent tickets and passes, and ends websockets whose pass died. */
  sweep(): Promise<void>;
  /** Closes every proxy (radial serve stopping). */
  close(): Promise<void>;
  /** The open proxies by project, for tests. */
  ports(): Record<string, number>;
}

/** A host as it goes in a URL: an IPv6 address in brackets. */
export const urlHost = (host: string): string => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);
/** Whether a bind address listens everywhere (0.0.0.0 or ::). */
export const isWildcard = (host: string): boolean => host === '0.0.0.0' || host === '::' || host === '[::]';

/** This machine's first address another machine could reach: a share link's best guess when the CLI asked over the socket. */
function reachableAddress(): string {
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address;
  return '127.0.0.1';
}

/** A request's cookies by name (every value, since a name can come twice). */
export function parseCookies(header: string | undefined): [string, string][] {
  return String(header || '').split(';').map((part) => { const eq = part.indexOf('='); return eq < 0 ? null : [part.slice(0, eq).trim(), part.slice(eq + 1).trim()] as [string, string]; }).filter((c): c is [string, string] => !!c && !!c[0]);
}
/** The cookie header without radial's passes, which only the proxies read; undefined when nothing is left. */
export function stripPasses(header: string | undefined): string | undefined {
  const kept = String(header || '').split(';').filter((part) => { const name = part.split('=')[0].trim(); return name && !name.startsWith(COOKIE_PREFIX); }).map((p) => p.trim());
  return kept.length ? kept.join('; ') : undefined;
}
/** Whether an upgrade comes from the preview's own pages: its Origin's host is the Host it was sent to (or there's no Origin: not a page's). */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  try { return new URL(origin).host.toLowerCase() === String(host || '').toLowerCase(); } catch { return false; }
}
/** Where a share link may send the browser after its ticket: a path on this preview, never another site (`//host`, `/\thost` and the like read as one). */
export function landingPath(to: string): string {
  try {
    const u = new URL(to, 'http://preview.invalid');
    const target = u.pathname + u.search + u.hash;
    return u.origin === 'http://preview.invalid' && !/^\/[/\\]/.test(target) ? target : '/';
  } catch { return '/'; }
}

/** Headers that belong to one connection, not the request: never forwarded as they came. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'upgrade']);
const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** A plain page that says why, in the browser the person is looking at. A refusal closes the connection: nothing more is read from it. */
function page(res: http.ServerResponse, status: number, title: string, body: string, { refusal = false }: { refusal?: boolean } = {}): void {
  if (res.headersSent) { res.destroy(); return; }
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:36em;margin:4em auto;padding:0 1em;color:#222"><h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${body}</p></body></html>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...(refusal ? { connection: 'close' } : {}) });
  res.end(html);
}
/** The same refusal on a socket that asked to upgrade: a status line and done. */
function refuseUpgrade(socket: Duplex, status: number): void {
  try { socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Refused'}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`); } catch {}
}

/** An open websocket through a proxy, and the pass that let it in (none on loopback): it ends when the pass does. */
interface Tunnel { socket: Duplex; up: net.Socket; pass: string | null }
interface ProjectProxy { repoDir: string; port: number; server: http.Server; sockets: Set<net.Socket | Duplex>; tunnels: Set<Tunnel> }
/** What a ticket or a pass lets in: one project's proxy, until when, made with which token. */
interface Grant { port: number; repoDir: string; tokenId: string | null; expiresAt: number }

/** The preview proxies for radial serve --listen. Nothing listens until a project's address is asked for. */
export function createProxies(opts: ProxyOptions): PreviewProxies {
  const log = opts.log || (() => {});
  const now = opts.now || Date.now;
  const portsFile = path.join(opts.dataDir, 'preview-ports.json');
  const proxies = new Map<string, ProjectProxy>();
  const opening = new Map<string, Promise<ProjectProxy>>();
  const tickets = new Map<string, Grant>(); // sha256(ticket) → what it lets in
  const passes = new Map<string, Grant>(); // sha256(pass) → what it lets in, until when
  let closed = false;
  const live = (g: Grant): boolean => g.expiresAt > now() && (!g.tokenId || opts.tokenLive(g.tokenId));

  function remembered(): Record<string, number> {
    try { const m = JSON.parse(fs.readFileSync(portsFile, 'utf8')) as unknown; return m && typeof m === 'object' && !Array.isArray(m) ? m as Record<string, number> : {}; } catch { return {}; }
  }
  function remember(repoDir: string, port: number): void {
    const m = remembered();
    if (m[repoDir] === port) return;
    m[repoDir] = port;
    try { fs.writeFileSync(portsFile, JSON.stringify(m, null, 2) + '\n'); } catch {}
  }

  /**
   * Whether another program answers on loopback at a port. A wildcard bind
   * (0.0.0.0, ::) succeeds on macOS while another program holds the port on
   * 127.0.0.1 or ::1 alone, and loopback requests then reach that program, not
   * the proxy: such a port counts as taken.
   */
  function loopbackTaken(port: number): Promise<boolean> {
    const answers = (host: string) => new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const done = (yes: boolean) => { socket.destroy(); resolve(yes); };
      socket.setTimeout(1000, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
    return Promise.all([answers('127.0.0.1'), answers('::1')]).then((r) => r.includes(true));
  }
  /** Listens on a port; false when it's taken. */
  function listenOn(server: http.Server, port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => { server.off('listening', onListening); if (e.code === 'EADDRINUSE' || e.code === 'EACCES') resolve(false); else reject(e); };
      const onListening = () => { server.off('error', onError); resolve(true); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, opts.bindHost);
    });
  }

  async function openProxy(repoDir: string): Promise<ProjectProxy> {
    const pp: ProjectProxy = { repoDir, port: 0, server: http.createServer(), sockets: new Set(), tunnels: new Set() };
    // An upload to the site may take a while, but not forever; nor may headers, and nobody holds a thousand connections.
    pp.server.requestTimeout = 10 * 60 * 1000;
    pp.server.headersTimeout = 60 * 1000;
    pp.server.maxConnections = 1024;
    pp.server.on('connection', (s: net.Socket) => { pp.sockets.add(s); s.on('close', () => pp.sockets.delete(s)); });
    pp.server.on('request', (req, res) => { handle(pp, req, res).catch((e: Error) => page(res, 502, 'The preview had a problem', escapeHtml(e.message))); });
    pp.server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => { upgrade(pp, req, socket, head).catch(() => socket.destroy()); });
    const mine = remembered();
    const taken = new Set(Object.entries(mine).filter(([dir]) => dir !== repoDir).map(([, port]) => port));
    const candidates = [mine[repoDir], ...Array.from({ length: PORT_SPAN }, (_, i) => opts.basePort + 1 + i).filter((p) => !taken.has(p) && p <= 65535)].filter((p): p is number => typeof p === 'number' && p > 0);
    let ok = false;
    for (const port of [...new Set(candidates)]) if ((!isWildcard(opts.bindHost) || !(await loopbackTaken(port))) && (ok = await listenOn(pp.server, port))) break;
    if (!ok && !(await listenOn(pp.server, 0))) throw new Error('No port was free for the preview proxy.');
    pp.port = (pp.server.address() as net.AddressInfo).port;
    remember(repoDir, pp.port);
    proxies.set(repoDir, pp);
    log(`[proxy] ${path.basename(repoDir)}'s preview: port ${pp.port}, following its dev server.`);
    return pp;
  }
  function ensure(repoDir: string): Promise<ProjectProxy> {
    const open = proxies.get(repoDir);
    if (open) return Promise.resolve(open);
    let p = opening.get(repoDir);
    if (!p) {
      p = openProxy(repoDir).finally(() => opening.delete(repoDir));
      opening.set(repoDir, p);
    }
    return p;
  }
  async function closeProxy(pp: ProjectProxy, why: string): Promise<void> {
    if (proxies.get(pp.repoDir) === pp) proxies.delete(pp.repoDir);
    // Its tickets and passes go with it: another project may get this port later.
    for (const [k, g] of tickets) if (g.port === pp.port) tickets.delete(k);
    for (const [k, g] of passes) if (g.port === pp.port) passes.delete(k);
    for (const t of pp.tunnels) { t.socket.destroy(); t.up.destroy(); }
    await new Promise<void>((resolve) => { pp.server.close(() => resolve()); for (const s of pp.sockets) s.destroy(); });
    log(`[proxy] Closed ${path.basename(pp.repoDir)}'s preview port ${pp.port} (${why}).`);
  }

  /**
   * Whether a request may reach the preview: anyone when the proxies listen on
   * loopback only (true); with --allow-remote, only with a live pass for this
   * proxy's project, whose key it answers; null when it may not.
   */
  function admit(pp: ProjectProxy, req: http.IncomingMessage): string | true | null {
    if (!opts.remote) return true;
    const name = cookieName(pp.port);
    for (const [k, v] of parseCookies(req.headers.cookie)) {
      if (k !== name) continue;
      const key = sha(v), pass = passes.get(key);
      if (pass && pass.port === pp.port && pass.repoDir === pp.repoDir && live(pass)) return key;
    }
    return null;
  }
  const NEEDS_PASS = 'Where Radial runs, <code>radial url &lt;project&gt; --share</code> prints a link that lets this browser in for twelve hours.';

  /** Where the dev server is now: waking a sleeping project first. */
  async function upstream(repoDir: string): Promise<{ ok: true; host: string; port: number } | { ok: false; status: number; title: string; error: string }> {
    let where = opts.preview(repoDir);
    if (!where.ok && where.code === 'no-dev-server') {
      const why = await opts.wake(repoDir);
      where = opts.preview(repoDir);
      if (!where.ok) return { ok: false, status: 503, title: 'The preview is asleep', error: why || where.error };
    }
    if (!where.ok) return { ok: false, status: 404, title: 'This project isn\'t open', error: where.error };
    opts.used(repoDir);
    const u = new URL(where.url);
    return { ok: true, host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || 80 };
  }

  /** The request's headers for the dev server: as they came (Host included), less the hop-by-hop ones and radial's passes. */
  function forwardHeaders(req: http.IncomingMessage, keepUpgrade: boolean): string[] {
    const out: string[] = [];
    const raw = req.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      const name = raw[i], lower = name.toLowerCase();
      if (!keepUpgrade && HOP.has(lower)) continue;
      if (lower === 'cookie') { const kept = stripPasses(raw[i + 1]); if (kept) out.push(name, kept); continue; }
      out.push(name, raw[i + 1]);
    }
    return out;
  }
  /** Whether a dev server's Set-Cookie would set (or clear) a proxy's pass: cookies are per host, not per port, so one site could reach another proxy's. */
  const setsPass = (value: string): boolean => value.trim().startsWith(COOKIE_PREFIX);

  async function handle(pp: ProjectProxy, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!opts.hostAllowed(req.headers.host)) { page(res, 403, 'Wrong address', `This preview doesn't answer requests addressed to ${escapeHtml(String(req.headers.host || 'nothing'))}.`, { refusal: true }); return; }
    const url = req.url || '/';
    if (url === PASS_PATH || url.startsWith(PASS_PATH + '?')) { swapTicket(pp, req, res); return; }
    if (admit(pp, req) === null) { page(res, 401, 'This preview needs a pass', NEEDS_PASS, { refusal: true }); return; }
    const idempotent = req.method === 'GET' || req.method === 'HEAD';
    const deadline = Date.now() + RESTART_WAIT_MS;
    let current: http.ClientRequest | null = null;
    res.on('close', () => { if (current) current.destroy(); }); // the browser went: so does the request to the dev server
    for (;;) {
      const to = await upstream(pp.repoDir);
      if (!to.ok) { page(res, to.status, to.title, escapeHtml(to.error)); req.resume(); return; }
      const result = await new Promise<'answered' | 'refused'>((resolve) => {
        const up = http.request({ host: to.host, port: to.port, method: req.method, path: url, headers: forwardHeaders(req, false), agent: false }, (upRes) => {
          const headers: string[] = [];
          for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
            const name = upRes.rawHeaders[i].toLowerCase(), value = upRes.rawHeaders[i + 1];
            if (HOP.has(name) || name === 'transfer-encoding' || (name === 'set-cookie' && setsPass(value))) continue;
            headers.push(upRes.rawHeaders[i], value);
          }
          res.writeHead(upRes.statusCode || 502, upRes.statusMessage, headers);
          upRes.pipe(res);
          upRes.on('error', () => res.destroy());
          resolve('answered');
        });
        current = up;
        up.on('error', (e: NodeJS.ErrnoException) => {
          // Nothing answered (a restart between two servers): a GET can wait for the next one; anything else says so now.
          if (!res.headersSent && idempotent && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET') && Date.now() < deadline && !res.destroyed) { resolve('refused'); return; }
          if (!res.headersSent) page(res, 502, 'The preview didn\'t answer', `Its dev server didn't answer (${escapeHtml(e.code || e.message)}). It may be restarting: reload in a moment.`);
          else res.destroy();
          resolve('answered');
        });
        if (idempotent) { up.end(); req.resume(); } else req.pipe(up);
      });
      if (result === 'answered') return;
      await sleep(250);
    }
  }

  async function upgrade(pp: ProjectProxy, req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => {});
    pp.sockets.add(socket);
    socket.on('close', () => pp.sockets.delete(socket));
    if (!opts.hostAllowed(req.headers.host)) { refuseUpgrade(socket, 403); return; }
    // Only the preview's own pages: another site open in this browser can't reach the hot-reload socket on this known port.
    if (!sameOrigin(req.headers.origin, req.headers.host)) { refuseUpgrade(socket, 403); return; }
    const pass = admit(pp, req);
    if (pass === null) { refuseUpgrade(socket, 401); return; }
    const to = await upstream(pp.repoDir);
    if (!to.ok) { refuseUpgrade(socket, to.status); return; }
    const up = net.connect({ host: to.host, port: to.port });
    up.on('error', () => socket.destroy());
    socket.on('close', () => up.destroy());
    up.on('close', () => socket.destroy());
    up.on('connect', () => {
      // The upgrade request as it came (Connection and Upgrade included), less radial's passes, then the bytes after it.
      const headers = forwardHeaders(req, true);
      let lines = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < headers.length; i += 2) lines += `${headers[i]}: ${headers[i + 1]}\r\n`;
      up.write(lines + '\r\n');
      if (head && head.length) up.write(head);
    });
    // The dev server's answer is read before the two ends are joined: only its 101 joins them (less any pass cookie it sets);
    // anything else is passed on as a refusal and the connection closes, so nothing unchecked can follow on it.
    let answer = Buffer.alloc(0);
    const onAnswer = (d: Buffer) => {
      answer = Buffer.concat([answer, d]);
      const end = answer.indexOf('\r\n\r\n');
      if (end < 0) { if (answer.length > MAX_UPGRADE_ANSWER) { up.destroy(); socket.destroy(); } return; }
      up.off('data', onAnswer);
      up.pause();
      const lines = answer.subarray(0, end).toString('latin1').split('\r\n');
      const status = Number((lines[0] || '').split(' ')[1]) || 0;
      if (status !== 101) { refuseUpgrade(socket, status >= 400 && status < 600 ? status : 502); up.destroy(); return; }
      socket.write(lines.filter((l, i) => i === 0 || !/^set-cookie:/i.test(l) || !setsPass(l.slice(l.indexOf(':') + 1))).join('\r\n') + '\r\n\r\n');
      const rest = answer.subarray(end + 4);
      if (rest.length) socket.write(rest);
      const tunnel: Tunnel = { socket, up, pass: pass === true ? null : pass };
      pp.tunnels.add(tunnel);
      socket.on('close', () => pp.tunnels.delete(tunnel));
      up.pipe(socket);
      socket.pipe(up);
    };
    up.on('data', onAnswer);
  }

  /** A share link's ticket, swapped for this proxy's pass: once, in time, and only on the proxy and project it was made for. */
  function swapTicket(pp: ProjectProxy, req: http.IncomingMessage, res: http.ServerResponse): void {
    let ticket = '', to = '/';
    try { const u = new URL(req.url || '/', 'http://proxy'); ticket = u.searchParams.get('ticket') || ''; to = u.searchParams.get('to') || '/'; } catch {}
    const key = sha(ticket);
    const t = tickets.get(key);
    tickets.delete(key); // one use, whatever happens next
    if (!t || t.port !== pp.port || t.repoDir !== pp.repoDir || !live(t)) {
      page(res, 401, 'This link has expired or was used', 'Each share link works once, within ten minutes. Where Radial runs, <code>radial url &lt;project&gt; --share</code> prints a new one.', { refusal: true });
      return;
    }
    req.resume();
    const pass = crypto.randomBytes(32).toString('base64url');
    passes.set(sha(pass), { port: pp.port, repoDir: pp.repoDir, tokenId: t.tokenId, expiresAt: now() + PASS_MS });
    res.writeHead(302, {
      location: landingPath(to),
      'set-cookie': `${cookieName(pp.port)}=${pass}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(PASS_MS / 1000)}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-length': '0',
    });
    res.end();
    log(`[proxy] A share link let a browser into ${path.basename(pp.repoDir)}'s preview (port ${pp.port}).`);
  }

  async function sweep(): Promise<void> {
    for (const pp of [...proxies.values()]) {
      const where = opts.preview(pp.repoDir);
      if (!where.ok && where.code === 'not-open') await closeProxy(pp, 'its project closed');
    }
    for (const [k, g] of tickets) if (!live(g)) tickets.delete(k);
    for (const [k, g] of passes) if (!live(g)) passes.delete(k);
    // An open websocket lasts only as long as the pass that let it in (expired, or its token revoked).
    for (const pp of proxies.values()) for (const t of [...pp.tunnels]) if (t.pass && !passes.has(t.pass)) { t.socket.destroy(); t.up.destroy(); pp.tunnels.delete(t); }
  }
  let sweeping: Promise<void> | null = null;
  const timer = setInterval(() => { if (!sweeping) sweeping = sweep().catch(() => {}).finally(() => { sweeping = null; }); }, 5000);
  timer.unref();

  return {
    async preview(repoDir, { http: caller, share }) {
      if (closed) return { ok: false, error: 'radial serve is stopping.' };
      if (share && !opts.remote) return { ok: false, error: 'radial serve listens on this machine only, so a browser on another machine can\'t reach the preview. Forward the port over SSH (ssh -L), or restart serve with --allow-remote (with SSH or Tailscale in front).' };
      // With --allow-remote the proxies need a pass from every browser: an agent on this machine is better off with the dev server's own address.
      if (opts.remote && !caller && !share) return null;
      const pp = await ensure(repoDir);
      // The address in the caller's terms: the name an HTTP caller reached us by; over the socket, this machine's own
      // (loopback), or for a share link, the address another machine most likely has for it.
      const host = caller ? caller.host : !isWildcard(opts.bindHost) ? opts.bindHost : share ? reachableAddress() : '127.0.0.1';
      const base = `http://${urlHost(host)}:${pp.port}`;
      if (!share) return { ok: true, url: base + '/' };
      const ticket = crypto.randomBytes(24).toString('base64url');
      const expiresAt = now() + TICKET_MS;
      tickets.set(sha(ticket), { port: pp.port, repoDir, tokenId: caller ? caller.tokenId : null, expiresAt });
      return { ok: true, url: base + '/', share: { url: `${base}${PASS_PATH}?ticket=${ticket}`, expiresAt } };
    },
    sweep,
    async close() {
      closed = true;
      clearInterval(timer);
      for (const pp of [...proxies.values()]) await closeProxy(pp, 'radial serve is stopping');
    },
    ports: () => Object.fromEntries([...proxies.values()].map((pp) => [pp.repoDir, pp.port])),
  };
}
