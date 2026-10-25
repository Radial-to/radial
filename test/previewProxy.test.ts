// radial serve's preview proxies (src/headless/previewProxy.ts) in front of
// stand-in dev servers (test/fixtures/ws-dev-server.cjs): a stable port that
// follows the dev server across restarts, websocket upgrades passed through
// (only on the dev server's 101, only from the preview's own pages, and never
// a pass cookie the dev server sets), a sleeping project woken by a visit,
// ports remembered, the Host check, and, with --allow-remote, passes from
// every browser: a share link's one-time ticket swapped for an HttpOnly cookie
// of that proxy's own, which never reaches the dev server, binds to the
// project, and ends its websockets when it dies.
// test/headlessRemote.e2e.mts runs them in a real radial serve.

import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';

import { createProxies, cookieName, parseCookies, stripPasses, sameOrigin, landingPath, PASS_PATH, PASS_MS, TICKET_MS } from '../src/headless/previewProxy';
import type { ProxyOptions, PreviewProxies } from '../src/headless/previewProxy';
import { hostAllowed } from '../src/headless/listen';
import type { PreviewNow } from '../src/core/sessions';
import type { HttpCaller, ShareLink } from '../src/main/cliServer';
import { wsRoundTrip, wsOpen } from './support/ws.mts';
import { tmpDir } from './support/tmp';

const devFixture = require('./fixtures/ws-dev-server.cjs') as { attachEcho(server: http.Server, label?: string): void; handle(req: http.IncomingMessage, res: http.ServerResponse, port: number): void };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in dev server on a port of the OS's choosing; what reached it on a connection after it refused an upgrade. */
interface Dev { url: string; port: number; server: http.Server; close(): Promise<void> }
const servers: Dev[] = [];
async function dev(): Promise<Dev> {
  let port = 0;
  const server = http.createServer((req, res) => devFixture.handle(req, res, port));
  devFixture.attachEcho(server);
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as net.AddressInfo).port;
  const d: Dev = { url: `http://127.0.0.1:${port}/`, port, server, close: () => new Promise((resolve) => { server.close(() => resolve()); for (const s of sockets) s.destroy(); }) };
  servers.push(d);
  return d;
}
/** A port nothing listens on now (the OS's pick, released). */
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}
/** One HTTP request: its status, headers and body. */
function request(url: string, { method = 'GET', headers = {} }: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body })); });
    req.on('error', reject);
    req.end();
  });
}

const all: PreviewProxies[] = [];
after(async () => { for (const p of all) await p.close(); for (const d of servers) await d.close(); });

/** Proxies for a scratch data dir, the previews the test sets, a clock it moves, and the tokens still accepted. */
async function setup(over: Partial<ProxyOptions> = {}) {
  const dataDir = tmpDir('rproxy-');
  const previews = new Map<string, PreviewNow>();
  const woke: string[] = [];
  const used: string[] = [];
  const live = new Set(['tok1']);
  let clock = 1_000_000;
  const basePort = over.basePort ?? await freePort();
  const allowHosts = ['myvm.example'];
  const proxies = createProxies({
    dataDir, bindHost: '127.0.0.1', basePort, remote: false,
    hostAllowed: (h) => hostAllowed(h, { bindHost: '127.0.0.1', allowHosts }),
    preview: (dir) => previews.get(dir) || { ok: false, code: 'not-open', error: `${dir} is not open.` },
    wake: async (dir) => { woke.push(dir); const d = await dev(); previews.set(dir, { ok: true, url: d.url, name: 'site' }); return null; },
    used: (dir) => { used.push(dir); },
    tokenLive: (id) => live.has(id),
    now: () => clock,
    ...over,
  });
  all.push(proxies);
  /** A project's proxy address (and share link), which the test expects there to be. */
  const address = async (dir: string, ask: { http: HttpCaller | null; share: boolean }) => {
    const a = await proxies.preview(dir, ask);
    assert.ok(a && a.ok, JSON.stringify(a));
    return a as { ok: true; url: string; share?: ShareLink };
  };
  return { dataDir, previews, woke, used, live, basePort, proxies, address, tick: (ms: number) => { clock += ms; } };
}
const json = <T>(body: string) => JSON.parse(body) as T;
interface Echo { method: string; path: string; host: string | null; cookie: string | null; port: number }
interface WsEcho { echo: string; path: string; cookie: string | null }

test('the proxy follows its project’s dev server across restarts on new ports, websocket upgrades included, with the Host as the browser sent it', async () => {
  const { previews, proxies, used, address } = await setup();
  const one = await dev();
  previews.set('/site', { ok: true, url: one.url, name: 'site' });
  const addr = await address('/site', { http: null, share: false });
  assert.match(addr.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const url = addr.url;
  const port = Number(new URL(url).port);
  const first = await request(url + 'echo');
  assert.equal(first.status, 200);
  assert.deepEqual([json<Echo>(first.body).port, json<Echo>(first.body).host], [one.port, `127.0.0.1:${port}`], 'the dev server answered, with the Host the browser sent');
  assert.deepEqual(first.headers['set-cookie'], ['site_session=from-the-site; Path=/'], 'the site’s own headers come back, but never a cookie posing as a proxy’s pass');
  assert.match((await request(url)).body, /Hello from the dev server/);
  const ws = await wsRoundTrip(url + 'hmr?x=1', 'ping', { Origin: `http://127.0.0.1:${port}` });
  assert.equal(ws.status, 101);
  assert.deepEqual([json<WsEcho>(ws.message!).echo, json<WsEcho>(ws.message!).path], ['ping', '/hmr?x=1'], 'hot reload’s websocket goes through');
  assert.match(ws.head, /\r\nSet-Cookie: hmr_session=1; Path=\//i, 'the 101’s own cookies too');
  assert.ok(!/radial_pass_/i.test(ws.head), 'but not one posing as a pass');
  // A restart: a new server on a new port, and the same address.
  await one.close();
  const two = await dev();
  previews.set('/site', { ok: true, url: two.url, name: 'site' });
  assert.equal(json<Echo>((await request(url + 'echo')).body).port, two.port);
  assert.equal(json<WsEcho>((await wsRoundTrip(url + 'hmr', 'again')).message!).echo, 'again');
  assert.deepEqual(await proxies.preview('/site', { http: null, share: false }), addr, 'the same address');
  // Between two servers, a GET waits for the next one rather than failing.
  await two.close();
  const pending = request(url + 'echo');
  await sleep(400);
  const three = await dev();
  previews.set('/site', { ok: true, url: three.url, name: 'site' });
  const waited = await pending;
  assert.equal(waited.status, 200); assert.equal(json<Echo>(waited.body).port, three.port);
  assert.ok(used.length >= 3 && used.every((d) => d === '/site'), 'each visit starts the idle clock again');
  // A POST isn't sent twice: with nothing there it says so at once.
  await three.close();
  const post = await request(url + 'echo', { method: 'POST' });
  assert.equal(post.status, 502); assert.match(post.body, /didn't answer \(ECONNREFUSED\)/);
});

test('a websocket only from the preview’s own pages, and joined only on the dev server’s 101: another answer is refused and the connection closes', async () => {
  const { previews, address } = await setup();
  const d = await dev();
  previews.set('/site', { ok: true, url: d.url, name: 'site' });
  const url = (await address('/site', { http: null, share: false })).url;
  const port = Number(new URL(url).port);
  assert.equal((await wsRoundTrip(url + 'hmr', 'x', { Origin: 'https://attacker.example' })).status, 403, 'another site’s page can’t open it');
  assert.equal((await wsRoundTrip(url + 'hmr', 'x', { Origin: 'null' })).status, 403);
  assert.equal((await wsRoundTrip(url + 'hmr', 'x', { Origin: `http://localhost:${port}`, Host: `localhost:${port}` })).status, 101, 'its own page, by any of its names');
  // The dev server answers 404 on a connection it keeps open: the proxy passes the refusal on and closes, so nothing can follow on it.
  const after: string[] = [];
  d.server.on('after-refusal', (text: string) => after.push(text));
  const refused = await wsOpen(url + 'no-ws');
  assert.equal(refused.status, 404);
  assert.match(refused.head, /\r\nconnection: close/i);
  refused.socket.write('GET /echo HTTP/1.1\r\nHost: smuggled.example\r\n\r\n');
  await Promise.race([refused.closed, sleep(2000).then(() => { throw new Error('the connection stayed open'); })]);
  await sleep(100);
  assert.deepEqual(after, [], 'nothing reached the dev server after its refusal');
});

test('a sleeping project wakes on its first visit; a closed one is gone, and its proxy closes at the sweep; its port is kept for it', async () => {
  const { previews, proxies, woke, basePort, dataDir, address } = await setup();
  previews.set('/site', { ok: false, code: 'no-dev-server', error: '/site is asleep; wake it first (radial wake).' });
  const url = (await address('/site', { http: null, share: false })).url;
  assert.equal(Number(new URL(url).port), basePort + 1, 'the first port after the listener’s'); // nothing else has started since freePort released it
  const r = await request(url);
  assert.equal(r.status, 200); assert.match(r.body, /Hello from the dev server/);
  assert.deepEqual(woke, ['/site'], 'woken by the visit');
  previews.delete('/site');
  const gone = await request(url);
  assert.equal(gone.status, 404); assert.match(gone.body, /This project isn't open/);
  await proxies.sweep();
  assert.deepEqual(proxies.ports(), {});
  await assert.rejects(request(url), /ECONNREFUSED/, 'its port closed with it');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'preview-ports.json'), 'utf8')), { '/site': basePort + 1 }, 'and is kept for it');
  // Another project takes the next port; the first one gets its own back when it opens again.
  previews.set('/other', { ok: true, url: (await dev()).url, name: 'other' });
  previews.set('/site', { ok: true, url: (await dev()).url, name: 'site' });
  const other = await address('/other', { http: null, share: false });
  assert.ok(Number(new URL(other.url).port) > basePort + 1, 'another port after the listener’s, not /site’s');
  assert.equal((await address('/site', { http: null, share: false })).url, url);
});

test('a port another program holds is skipped; the address is in the caller’s terms; a Host that isn’t this machine’s is refused, and the refusal closes the connection', async () => {
  const basePort = await freePort();
  const squatter = net.createServer();
  await new Promise<void>((resolve) => squatter.listen(basePort + 1, '127.0.0.1', resolve));
  try {
    const { previews, proxies, address } = await setup({ basePort });
    previews.set('/site', { ok: true, url: (await dev()).url, name: 'site' });
    const viaHttp = await address('/site', { http: { tokenId: 'tok1', host: 'myvm.example' }, share: false });
    const port = Number(new URL(viaHttp.url).port);
    assert.ok(port > basePort + 1, `${port}: past the held one`); // the OS may have handed the next one to the dev server
    assert.equal(viaHttp.url, `http://myvm.example:${port}/`, 'the name the HTTP caller used');
    assert.equal((await address('/site', { http: { tokenId: 'tok1', host: '::1' }, share: false })).url, `http://[::1]:${port}/`);
    const local = `http://127.0.0.1:${port}/`;
    const rebound = await request(local, { headers: { Host: 'evil.example' } });
    assert.equal(rebound.status, 403, 'a DNS name that points here isn’t ours');
    assert.equal(rebound.headers.connection, 'close');
    assert.equal((await request(local, { headers: { Host: `localhost:${port}` } })).status, 200);
    assert.equal((await request(local, { headers: { Host: `myvm.example:${port}` } })).status, 200, 'an allowed name');
    assert.equal((await wsRoundTrip(local, 'x', { Host: 'evil.example' })).status, 403, 'nor for an upgrade');
    const share = await proxies.preview('/site', { http: null, share: true });
    assert.ok(share && !share.ok && /--allow-remote/.test(share.error), 'no share link on loopback');
  } finally { squatter.close(); }
});

test('with --allow-remote, every browser needs a pass, this machine’s too: a share link’s ticket, used once and in time, becomes this proxy’s HttpOnly cookie, which the dev server never sees', async () => {
  const { previews, proxies, tick, live, address } = await setup({ remote: true });
  previews.set('/site', { ok: true, url: (await dev()).url, name: 'site' });
  previews.set('/other', { ok: true, url: (await dev()).url, name: 'other' });
  const caller = { tokenId: 'tok1', host: 'myvm.example' };
  const plain = await address('/site', { http: caller, share: false });
  const port = Number(new URL(plain.url).port);
  const local = `http://127.0.0.1:${port}`;
  const Host = `myvm.example:${port}`;
  const refused = await request(local + '/', { headers: { Host } });
  assert.equal(refused.status, 401); assert.match(refused.body, /This preview needs a pass/); assert.match(refused.body, /radial url &lt;project&gt; --share/);
  assert.equal(refused.headers.connection, 'close', 'the refusal reads nothing more from the connection');
  assert.equal((await request(local + '/')).status, 401, 'from this machine too: a tunnel to the port would make anyone local');
  assert.equal((await wsRoundTrip(local + '/hmr', 'x', { Host })).status, 401, 'nor an upgrade');
  // An agent on this machine asks over the socket: no proxy address, so `radial url` answers the dev server's own.
  assert.equal(await proxies.preview('/site', { http: null, share: false }), null);
  // The link.
  const shared = await address('/site', { http: caller, share: true });
  const link = new URL(shared.share!.url);
  assert.deepEqual([link.origin, link.pathname], [`http://myvm.example:${port}`, PASS_PATH]);
  assert.equal(shared.share!.expiresAt, 1_000_000 + TICKET_MS);
  const swap = await request(`${local}${link.pathname}${link.search}&to=${encodeURIComponent('/echo?from=link')}`, { headers: { Host } });
  assert.equal(swap.status, 302);
  assert.equal(swap.headers.location, '/echo?from=link');
  assert.equal(swap.headers['referrer-policy'], 'no-referrer');
  const cookie = swap.headers['set-cookie']![0];
  assert.match(cookie, new RegExp(`^${cookieName(port)}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${PASS_MS / 1000}$`));
  const pass = cookie.split(';')[0];
  // With the pass: in, and the dev server sees the site's own cookies but never the pass.
  const echoed = await request(local + '/echo', { headers: { Host, Cookie: `theme=dark; ${pass}; other=1` } });
  assert.equal(echoed.status, 200);
  assert.equal(json<Echo>(echoed.body).cookie, 'theme=dark; other=1');
  const ws = await wsRoundTrip(local + '/hmr', 'hi', { Host, Cookie: `${pass}` });
  assert.equal(ws.status, 101); assert.equal(json<WsEcho>(ws.message!).cookie, null, 'nor over the websocket');
  // The ticket worked once.
  const again = await request(`${local}${link.pathname}${link.search}`, { headers: { Host } });
  assert.equal(again.status, 401); assert.match(again.body, /expired or was used/);
  // A pass is this proxy's only: another project's proxy refuses it, and a ticket made for one is spent at another.
  const otherPort = Number(new URL((await address('/other', { http: caller, share: false })).url).port);
  assert.equal((await request(`http://127.0.0.1:${otherPort}/`, { headers: { Host: `myvm.example:${otherPort}`, Cookie: pass.replace(String(port), String(otherPort)) } })).status, 401);
  const forSite = new URL((await address('/site', { http: caller, share: true })).share!.url);
  assert.equal((await request(`http://127.0.0.1:${otherPort}${forSite.pathname}${forSite.search}`, { headers: { Host: `myvm.example:${otherPort}` } })).status, 401);
  assert.equal((await request(`${local}${forSite.pathname}${forSite.search}`, { headers: { Host } })).status, 401, 'spent there');
  // Only a path on this preview: never another site, however it's spelled.
  for (const to of ['//evil.example/x', '/\t/evil.example', '/\\evil.example', 'https://evil.example/']) {
    const open = new URL((await address('/site', { http: caller, share: true })).share!.url);
    const offsite = await request(`${local}${open.pathname}${open.search}&to=${encodeURIComponent(to)}`, { headers: { Host } });
    assert.equal(offsite.headers.location, '/', JSON.stringify(to));
  }
  // A ticket used too late, a pass past its twelve hours, and a pass whose token was revoked: refused.
  const late = new URL((await address('/site', { http: caller, share: true })).share!.url);
  tick(TICKET_MS + 1);
  assert.equal((await request(`${local}${late.pathname}${late.search}`, { headers: { Host } })).status, 401);
  assert.equal((await request(local + '/', { headers: { Host, Cookie: pass } })).status, 200, 'the pass outlives its ticket');
  live.delete('tok1');
  assert.equal((await request(local + '/', { headers: { Host, Cookie: pass } })).status, 401, 'it dies with the token that made its link');
  live.add('tok1');
  tick(PASS_MS);
  assert.equal((await request(local + '/', { headers: { Host, Cookie: pass } })).status, 401, 'and after twelve hours');
});

test('with --allow-remote, an open websocket ends with its pass; a closed proxy’s passes go with it, so its port can’t let anyone into the next project', async () => {
  const { previews, proxies, live, address } = await setup({ remote: true });
  previews.set('/site', { ok: true, url: (await dev()).url, name: 'site' });
  const caller = { tokenId: 'tok1', host: 'myvm.example' };
  const swapFor = async () => {
    const link = new URL((await address('/site', { http: caller, share: true })).share!.url);
    const swap = await request(`http://127.0.0.1:${link.port}${link.pathname}${link.search}`, { headers: { Host: link.host } });
    return { port: Number(link.port), pass: String(swap.headers['set-cookie']![0]).split(';')[0] };
  };
  const { port, pass } = await swapFor();
  const open = await wsOpen(`http://127.0.0.1:${port}/hmr`, { Host: `myvm.example:${port}`, Cookie: pass });
  assert.equal(open.status, 101);
  live.delete('tok1'); // the token that made the link is revoked
  await proxies.sweep();
  await Promise.race([open.closed, sleep(2000).then(() => { throw new Error('the websocket outlived its pass'); })]);
  // The project closes, and opens again on the same port: the old pass doesn't open it.
  live.add('tok1');
  const second = await swapFor();
  assert.equal((await request(`http://127.0.0.1:${second.port}/`, { headers: { Host: `myvm.example:${second.port}`, Cookie: second.pass } })).status, 200);
  previews.delete('/site');
  await proxies.sweep();
  previews.set('/site', { ok: true, url: (await dev()).url, name: 'site' });
  const reopened = await address('/site', { http: caller, share: false });
  assert.equal(Number(new URL(reopened.url).port), second.port, 'the same port');
  assert.equal((await request(`http://127.0.0.1:${second.port}/`, { headers: { Host: `myvm.example:${second.port}`, Cookie: second.pass } })).status, 401, 'its old pass went with the closed proxy');
});

// On macOS a wildcard bind succeeds on a port another program holds on 127.0.0.1 alone, and loopback requests then
// reach that program: the remote gate's "this machine needs a pass too" once got 403 from another local server on the
// proxy's port, not the proxy's 401.
test('with a wildcard bind, a port another program holds on loopback alone is skipped: loopback requests would reach it', async () => {
  const basePort = await freePort();
  // It answers 403, as the server in the flaky run did; the proxy's look at the port resets its connection.
  const squatter = net.createServer((s) => { s.on('error', () => {}); s.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); });
  await new Promise<void>((resolve) => squatter.listen(basePort + 1, '127.0.0.1', resolve));
  try {
    const { previews, address } = await setup({ basePort, bindHost: '0.0.0.0' });
    previews.set('/site', { ok: true, url: (await dev()).url, name: 'site' });
    const addr = await address('/site', { http: null, share: false });
    const port = Number(new URL(addr.url).port);
    assert.notEqual(port, basePort + 1, 'not the port held on 127.0.0.1');
    assert.equal((await request(`http://127.0.0.1:${port}/echo`)).status, 200, 'loopback reaches the proxy');
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});

test('cookies parsed by name, radial’s passes taken out; an Origin is the preview’s own or not; a landing path stays on the preview', () => {
  assert.deepEqual(parseCookies('a=1; radial_pass_4001=xyz;b=2=3; =x; junk'), [['a', '1'], ['radial_pass_4001', 'xyz'], ['b', '2=3']]);
  assert.equal(stripPasses('a=1; radial_pass_4001=xyz; b=2; radial_pass_4002=q'), 'a=1; b=2');
  assert.equal(stripPasses('radial_pass_4001=xyz'), undefined);
  assert.equal(stripPasses(undefined), undefined);
  assert.equal(sameOrigin(undefined, '127.0.0.1:4001'), true, 'no Origin: not a page');
  assert.equal(sameOrigin('http://127.0.0.1:4001', '127.0.0.1:4001'), true);
  assert.equal(sameOrigin('http://MyVM.example:4001', 'myvm.example:4001'), true);
  for (const o of ['http://127.0.0.1:4002', 'https://evil.example', 'null', 'not a url']) assert.equal(sameOrigin(o, '127.0.0.1:4001'), false, o);
  for (const [to, path_] of [['/pricing', '/pricing'], ['/a?b=1#c', '/a?b=1#c'], ['//evil.example', '/'], ['/\t/evil.example', '/'], ['/\\evil.example', '/'], ['/.//evil.example/x', '/'], ['https://evil.example', '/'], ['javascript:alert(1)', '/'], ['', '/']]) assert.equal(landingPath(to), path_, JSON.stringify(to));
});
