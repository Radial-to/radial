// radial serve --listen's HTTP listener (src/headless/listen.ts) in front of a
// real control server with a stand-in api: every path needs a token (none, a
// wrong one and a revoked one get 401 with WWW-Authenticate); a foreign Host
// or a web page's Origin is refused first; /rpc streams the socket's frames;
// /mcp answers what `radial mcp` answers; /events streams events and ends when
// its token is revoked; /files serves shots and compares and nothing else; and
// `url` answers the preview proxy's address in the caller's terms.
// test/headlessRemote.e2e.mts runs the real radial serve.

import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';

import { startListener, parseListen, hostAllowed, originAllowed, isLoopbackHost, hostName, servable, openServable, fileRoots, withFileUrls } from '../src/headless/listen';
import type { HttpListener } from '../src/headless/listen';
import * as apiTokens from '../src/headless/apiTokens';
import * as cliServer from '../src/main/cliServer';
import * as mcp from '../src/main/mcp';
import * as spec from '../src/main/cliSpec';
import { encodePng } from '../src/headless/png';
import type { CliApi } from '../src/main/cliServer';
import type { PreviewNow } from '../src/core/sessions';
import { tmpDir } from './support/tmp';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('--listen: an address and port, a bare port, :port or [v6]:port; IP addresses only; localhost is 127.0.0.1', () => {
  assert.deepEqual(parseListen('127.0.0.1:4000'), { host: '127.0.0.1', port: 4000 });
  assert.deepEqual(parseListen('4000'), { host: '127.0.0.1', port: 4000 });
  assert.deepEqual(parseListen(':4100'), { host: '127.0.0.1', port: 4100 });
  assert.deepEqual(parseListen('localhost:0'), { host: '127.0.0.1', port: 0 });
  assert.deepEqual(parseListen('[::1]:4000'), { host: '::1', port: 4000 });
  assert.deepEqual(parseListen('0.0.0.0:4000'), { host: '0.0.0.0', port: 4000 });
  for (const bad of ['', '127.0.0.1', '127.0.0.1:99999', '::1:4000', 'http://127.0.0.1:4000', '1.2.3.4:x']) assert.ok('error' in parseListen(bad), bad);
  assert.match((parseListen('myvm:4000') as { error: string }).error, /not the name myvm\. A name requests may come addressed to goes in --allow-host/);
  assert.ok('error' in parseListen(undefined) && 'error' in parseListen(true));
});

test('which Host a request may name: loopback and localhost always; the bind address; any IP address on a wildcard bind; --allow-host names. Which Origin: none, or one allowed', () => {
  const loop = { bindHost: '127.0.0.1', allowHosts: [] };
  for (const h of ['127.0.0.1:4000', 'localhost:4000', 'LOCALHOST', '[::1]:4000', '127.0.0.2']) assert.equal(hostAllowed(h, loop), true, h);
  for (const h of [undefined, '', 'evil.example', 'evil.example:4000', '10.0.0.5:4000', 'localhost.evil.example', '127.0.0.1.nip.io']) assert.equal(hostAllowed(h, loop), false, String(h));
  const wild = { bindHost: '0.0.0.0', allowHosts: ['MyVM.example.ts.net'] };
  for (const h of ['10.0.0.5:4000', '100.64.1.2', '[fd7a::1]:4000', 'myvm.example.ts.net:4000']) assert.equal(hostAllowed(h, wild), true, h);
  assert.equal(hostAllowed('evil.example:4000', wild), false, 'a name: only an allowed one');
  const one = { bindHost: '100.64.1.2', allowHosts: [] };
  assert.equal(hostAllowed('100.64.1.2:4000', one), true); assert.equal(hostAllowed('100.64.1.3:4000', one), false);
  assert.equal(hostName('[::1]:4000'), '::1'); assert.equal(hostName('Example.COM:80'), 'example.com'); assert.equal(hostName(''), null);
  assert.equal(isLoopbackHost('::ffff:127.0.0.1'), true); assert.equal(isLoopbackHost('128.0.0.1'), false);
  assert.equal(originAllowed(undefined, []), true, 'not a web page’s call');
  assert.equal(originAllowed('https://evil.example', []), false);
  assert.equal(originAllowed('null', []), false, 'a sandboxed page or a file');
  assert.equal(originAllowed('https://Tools.Example', ['https://tools.example/']), true);
});

// ── A listener in front of a control server with a stand-in api ──
const dataDir = tmpDir('rlisten-');
const repo = path.join(tmpDir('rlisten-site-'), 'site');
fs.mkdirSync(repo);
const shots = path.join(dataDir, 'shots');
fs.mkdirSync(shots);
const shotFile = path.join(shots, 'site-home-full@2x-1.png');
fs.writeFileSync(shotFile, encodePng({ width: 4, height: 4, data: Buffer.alloc(64, 255) }));
const made = apiTokens.create(dataDir, 'test');
const other = apiTokens.create(dataDir, 'other');
if (!made.ok || !other.ok) throw new Error('no tokens');
const tokens = apiTokens.store(dataDir, { watchMs: 20 });
let listener: HttpListener | null = null;
const previews = new Map<string, PreviewNow>();
const api = {
  info: () => ({ version: '9.9.9', flavor: 'headless', pid: process.pid, windowReady: false, browser: true }),
  isOpen: (d: string) => d === repo, telemetry: () => {}, focus: () => ({ headless: true }),
  resolve: async (t: string | null | undefined) => ({ ok: true, kind: 'path', dir: t || repo }),
  previewUrl: (d: string) => (d === repo ? 'http://127.0.0.1:9/' : null),
  previewAddress: (d: string, ask: Parameters<CliApi['previewAddress']>[1]) => listener!.preview(d, ask),
  projects: async () => ({ projects: [{ repoDir: repo, name: 'site', url: 'http://127.0.0.1:9/', state: 'running', active: true, terminals: 0, waiting: 0, openComments: 0, changes: 0 }] }),
  shot: async () => ({ ok: true, path: shotFile, scale: 2, route: '/' }),
  publish: async (_d: string, _o: unknown, progress: (t: string) => void) => { progress('Committing…'); await sleep(20); progress('Pushing…'); return { ok: true, pushed: true, branch: 'main', mode: 'push' }; },
  publishDestination: async () => ({ branch: 'staging', production: false }), // a publish that stays off the production branch
} as unknown as CliApi; // a stand-in: the methods these tests drive
const control = cliServer.start({ socketPath: path.join(dataDir, 'cli.sock'), api });
const ready = (async () => {
  listener = await startListener({
    address: { host: '127.0.0.1', port: 0 }, allowRemote: false, allowHosts: [], allowOrigins: ['https://tools.example'],
    dataDir, version: '9.9.9', tokens, dispatch: control.dispatch, projects: () => [repo],
    preview: (d) => previews.get(d) || { ok: false, code: 'not-open', error: `${d} is not open.` },
    wake: async () => null, used: () => {}, log: () => {},
  });
  return listener;
})();
after(async () => { if (listener) await listener.close(); tokens.close(); control.stop(); });

/** One request to the listener: its status, headers and body; Host is the listener's own unless given. */
async function call(method: string, route: string, { token = made.ok ? made.token : '', headers = {}, body }: { token?: string | null; headers?: Record<string, string>; body?: string } = {}) {
  const l = await ready;
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: l.port, method, path: route, agent: false, headers: { Host: `127.0.0.1:${l.port}`, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const rpcFrames = (body: string) => body.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);

test('every path needs a token: none, a wrong one and a revoked one get 401 with WWW-Authenticate, on /mcp, /rpc, /events, /files and paths that don’t exist', async () => {
  const doomed = apiTokens.create(dataDir, 'doomed');
  assert.ok(doomed.ok);
  assert.equal((await call('POST', '/rpc', { token: doomed.token, body: '{"op":"hello"}' })).status, 200, 'it works before');
  apiTokens.revoke(dataDir, 'doomed');
  const wrong = `rcore_${'A'.repeat(43)}`;
  const routes: [string, string, string | undefined][] = [['POST', '/mcp', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'], ['POST', '/rpc', '{"op":"ls"}'], ['GET', '/events', undefined], ['GET', `/files?path=${encodeURIComponent(shotFile)}`, undefined], ['GET', '/', undefined], ['GET', '/nothing/here', undefined]];
  for (const [method, route, body] of routes) {
    for (const [why, token] of [['no token', null], ['a wrong token', wrong], ['a revoked token', doomed.token], ['not even a token', 'hunter2']] as const) {
      const r = await call(method, route, { token, body });
      assert.equal(r.status, 401, `${method} ${route} with ${why}`);
      assert.match(String(r.headers['www-authenticate']), /^Bearer realm="radial"/, `${route}: the challenge`);
      if (token) assert.match(String(r.headers['www-authenticate']), /error="invalid_token"/);
      if (route === '/mcp') { const j = JSON.parse(r.body) as { jsonrpc: string; error: { code: number; message: string } }; assert.deepEqual([j.jsonrpc, j.error.code], ['2.0', -32001], 'a JSON-RPC error'); }
      else assert.equal((JSON.parse(r.body) as { code: string }).code, 'unauthorized');
      assert.ok(!r.body.includes(String(token)) || !token, 'the token is never echoed');
    }
  }
  assert.match((await call('GET', '/rpc', { token: null })).body, /radial token create/, 'the refusal says how to get one');
  assert.equal((await call('GET', '/nothing/here')).status, 404, 'with a token, a path that doesn’t exist is a 404');
});

test('a foreign Host or a web page’s Origin is refused before the token is looked at; an allowed origin gets CORS, and its preflight needs no token', async () => {
  for (const host of ['evil.example', 'evil.example:4000', '10.1.2.3']) {
    const r = await call('POST', '/rpc', { headers: { Host: host }, body: '{"op":"ls"}' });
    assert.equal(r.status, 403, host); assert.match(r.body, /doesn't answer requests addressed to/);
  }
  assert.equal((await call('POST', '/rpc', { headers: { Host: `localhost:${(await ready).port}` }, body: '{"op":"hello"}' })).status, 200, 'localhost is this machine');
  const page = await call('POST', '/mcp', { headers: { Origin: 'https://evil.example' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(page.status, 403); assert.match(page.body, /refuses calls from web pages \(this one came from https:\/\/evil\.example\)/);
  assert.equal(page.headers['access-control-allow-origin'], undefined, 'no CORS for it');
  assert.equal((await call('GET', '/events', { headers: { Origin: 'null' } })).status, 403);
  const preflight = await call('OPTIONS', '/mcp', { token: null, headers: { Origin: 'https://tools.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'https://tools.example');
  assert.match(String(preflight.headers['access-control-allow-headers']), /authorization/);
  const allowed = await call('POST', '/rpc', { headers: { Origin: 'https://tools.example' }, body: '{"op":"hello"}' });
  assert.equal(allowed.status, 200); assert.equal(allowed.headers['access-control-allow-origin'], 'https://tools.example');
  assert.equal((await call('POST', '/rpc', { token: null, headers: { Origin: 'https://tools.example' }, body: '{"op":"hello"}' })).status, 401, 'an allowed page still needs a token');
});

test('/rpc runs the socket’s ops: its progress frames as they come, then the reply, one JSON line each; a bad body is a 400', async () => {
  const r = await call('POST', '/rpc', { body: JSON.stringify({ op: 'publish', reqId: 'r1', target: repo, to: 'branch' }) });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /^application\/x-ndjson/);
  const frames = rpcFrames(r.body);
  assert.deepEqual(frames.map((f) => [f.op, f.reqId, f.text]), [['progress', 'r1', 'Committing…'], ['progress', 'r1', 'Pushing…'], ['reply', 'r1', undefined]]);
  assert.deepEqual([frames[2].ok, frames[2].branch, frames[2].target], [true, 'main', 'branch']);
  const hello = rpcFrames((await call('POST', '/rpc', { body: '{"op":"hello"}' })).body)[0];
  assert.deepEqual([hello.op, hello.ok, hello.version, hello.flavor], ['reply', true, '9.9.9', 'headless']);
  const unknown = rpcFrames((await call('POST', '/rpc', { body: '{"op":"rm -rf"}' })).body)[0];
  assert.deepEqual([unknown.ok, unknown.code], [false, 'bad-request']);
  for (const bad of ['not json', '[1,2]', '{"no":"op"}']) assert.equal((await call('POST', '/rpc', { body: bad })).status, 400, bad);
  assert.equal((await call('GET', '/rpc')).status, 405);
  assert.equal((await call('POST', '/rpc', { body: '{"op":"x","pad":"' + 'x'.repeat(9 * 1024 * 1024) + '"}' })).status, 413, 'a body past 8 MB');
});

test('/mcp answers what `radial mcp` answers: the same tools/list; a notification gets 202; GET gets 405; a shot’s reply names its file by url, and carries the image', async () => {
  const post = async (msg: unknown) => { const r = await call('POST', '/mcp', { body: JSON.stringify(msg) }); return { status: r.status, json: r.body ? JSON.parse(r.body) as { result?: Record<string, unknown>; error?: { code: number } } : null }; };
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(init.status, 200); assert.equal(init.json!.result!.protocolVersion, '2025-03-26');
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  // stdio's, from the same handler over any api: the list doesn't depend on the transport.
  const stdio = await mcp.createHandler(mcp.apiOver({ version: () => '9.9.9', call: async () => ({ ok: true }) }))({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(listed.json!.result, (stdio as { result: unknown }).result);
  assert.equal((listed.json!.result!.tools as unknown[]).length, spec.mcpTools().length);
  const shot = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'screenshot', arguments: { project: repo } } });
  const content = shot.json!.result!.content as ({ type: 'text'; text: string } | { type: 'image'; data: string })[];
  const reply = JSON.parse((content[0] as { text: string }).text) as { path: string; url: string };
  const port = (await ready).port;
  assert.equal(reply.url, `http://127.0.0.1:${port}/files?path=${encodeURIComponent(shotFile)}`, 'the url names the file on this listener, as the caller reached it');
  assert.deepEqual(content.map((c) => c.type), ['text', 'text', 'image']);
  const batch = await call('POST', '/mcp', { body: JSON.stringify([{ jsonrpc: '2.0', id: 4, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/cancelled' }]) });
  assert.deepEqual(JSON.parse(batch.body), [{ jsonrpc: '2.0', id: 4, result: {} }], 'a batch: an answer for each request');
  assert.equal((await call('GET', '/mcp')).status, 405);
  assert.equal((await call('POST', '/mcp', { body: '{"id":1}' })).status, 400, 'not JSON-RPC 2.0');
  assert.equal((await call('POST', '/mcp', { headers: { 'MCP-Protocol-Version': '2025-06-18' }, body: '{"jsonrpc":"2.0","id":5,"method":"ping"}' })).status, 200, 'a version it speaks');
  const unknownVersion = await call('POST', '/mcp', { headers: { 'MCP-Protocol-Version': '1999-01-01' }, body: '{"jsonrpc":"2.0","id":6,"method":"ping"}' });
  assert.equal(unknownVersion.status, 400); assert.match(unknownVersion.body, /speaks MCP 2025-06-18, 2025-03-26, 2024-11-05, not 1999-01-01/);
});

test('/events streams the core’s events as they happen, and ends the moment its token is revoked', async () => {
  const l = await ready;
  const streamer = apiTokens.create(dataDir, 'streamer');
  assert.ok(streamer.ok);
  const got: string[] = [];
  let ended = false;
  const req = http.request({ host: '127.0.0.1', port: l.port, path: '/events', agent: false, headers: { Host: `127.0.0.1:${l.port}`, Authorization: `Bearer ${streamer.token}` } }, (res) => {
    assert.equal(res.statusCode, 200); assert.match(String(res.headers['content-type']), /^text\/event-stream/);
    res.setEncoding('utf8');
    res.on('data', (c: string) => got.push(c));
    res.on('end', () => { ended = true; });
  });
  req.end();
  for (let i = 0; i < 100 && !got.join('').includes('event: ready'); i++) await sleep(20);
  assert.equal(l.watchers(), 1);
  l.publish('session:resumed', { repoDir: repo, url: 'http://127.0.0.1:9/' });
  l.publish('page:browser', { state: 'started' });
  for (let i = 0; i < 100 && !got.join('').includes('page:browser'); i++) await sleep(20);
  assert.match(got.join(''), new RegExp(`event: session:resumed\\ndata: \\{"repoDir":"${repo.replace(/[/\\.]/g, '\\$&')}","url":"http://127.0.0.1:9/"\\}\\n\\n`));
  assert.match(got.join(''), /event: page:browser\ndata: \{"state":"started"\}\n\n/);
  apiTokens.revoke(dataDir, 'streamer');
  for (let i = 0; i < 100 && !ended; i++) await sleep(20);
  assert.equal(ended, true, 'the revoked token’s stream ended');
  assert.equal(l.watchers(), 0);
});

test('/events drops a reader that stopped reading rather than holding everything for it, and one token holds 16 streams at most', async () => {
  const l = await ready;
  const slow = apiTokens.create(dataDir, 'slow');
  assert.ok(slow.ok);
  // A reader that never reads: a raw connection that asks for the stream, then sits.
  const sock = net.connect(l.port, '127.0.0.1');
  await new Promise((r) => sock.on('connect', r));
  sock.write(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${l.port}\r\nAuthorization: Bearer ${slow.token}\r\n\r\n`);
  sock.pause();
  for (let i = 0; i < 100 && l.watchers() === 0; i++) await sleep(10);
  assert.equal(l.watchers(), 1);
  const big = { text: 'x'.repeat(64 * 1024) };
  for (let i = 0; i < 400 && l.watchers() > 0; i++) { l.publish('log', big); if (i % 20 === 0) await sleep(5); }
  assert.equal(l.watchers(), 0, 'dropped once it fell more than a megabyte behind');
  sock.destroy();
  // The cap: sixteen streams for one token, the seventeenth refused.
  const many = apiTokens.create(dataDir, 'many');
  assert.ok(many.ok);
  const open: http.ClientRequest[] = [];
  for (let i = 0; i < 16; i++) open.push(http.get({ host: '127.0.0.1', port: l.port, path: '/events', agent: false, headers: { Authorization: `Bearer ${many.token}` } }, (res) => res.resume()));
  for (let i = 0; i < 200 && l.watchers() < 16; i++) await sleep(10);
  assert.equal(l.watchers(), 16);
  const refused = await call('GET', '/events', { token: many.token });
  assert.equal(refused.status, 429); assert.match(refused.body, /16 event streams/);
  for (const r of open) r.destroy();
  for (let i = 0; i < 200 && l.watchers() > 0; i++) await sleep(10);
  assert.equal(l.watchers(), 0);
});

test('/files serves shots and migration compares by the path a reply gave; nothing else: not outside them, not through a link, not another kind of file', async () => {
  const fetch = (file: string) => call('GET', `/files?path=${encodeURIComponent(file)}`);
  const ok = await fetch(shotFile);
  assert.equal(ok.status, 200); assert.equal(ok.headers['content-type'], 'image/png');
  assert.equal(Number(ok.headers['content-length']), fs.statSync(shotFile).size);
  const compare = path.join(repo, '.radial', 'migrate', 'compare', '2026-10-17T21-00-00');
  fs.mkdirSync(compare, { recursive: true });
  fs.writeFileSync(path.join(compare, 'report.md'), '# Report\n');
  fs.writeFileSync(path.join(compare, 'home@1440.diff.png'), fs.readFileSync(shotFile));
  assert.equal((await fetch(path.join(compare, 'report.md'))).body, '# Report\n');
  assert.equal((await fetch(path.join(compare, 'home@1440.diff.png'))).status, 200);
  // Nothing else.
  fs.writeFileSync(path.join(shots, 'notes.txt'), 'secret');
  fs.writeFileSync(path.join(dataDir, 'secret.png'), 'x');
  fs.symlinkSync('/etc', path.join(shots, 'etc'));
  fs.symlinkSync(path.join(dataDir, 'secret.png'), path.join(shots, 'linked.png'));
  const outside = path.join(repo, '.radial', 'migrate', 'capture', 'screens', 'home@1440.png');
  fs.mkdirSync(path.dirname(outside), { recursive: true }); fs.writeFileSync(outside, 'x');
  for (const file of [path.join(shots, 'notes.txt'), path.join(dataDir, 'secret.png'), path.join(shots, 'etc', 'hosts'), path.join(shots, 'linked.png'), `${shots}/../secret.png`, outside, apiTokens.tokensFile(dataDir), '/etc/hosts', 'shots/site-home-full@2x-1.png', '']) {
    const r = await fetch(file);
    assert.equal(r.status, 404, file);
  }
  // A hard link in the shots folder to a file elsewhere (a second name for it): refused, though its path looks fine.
  fs.writeFileSync(path.join(dataDir, 'credentials.png'), 'not for anyone');
  fs.linkSync(path.join(dataDir, 'credentials.png'), path.join(shots, 'hardlinked.png'));
  assert.equal(servable(path.join(shots, 'hardlinked.png'), fileRoots(dataDir, [])), true, 'by its path it would pass');
  assert.equal(openServable(path.join(shots, 'hardlinked.png'), fileRoots(dataDir, [])), null);
  assert.equal((await fetch(path.join(shots, 'hardlinked.png'))).status, 404);
  // A project's own .radial as a link elsewhere (a repo can carry one): refused too.
  const evil = path.join(tmpDir('rlisten-evil-'), 'site');
  fs.mkdirSync(evil);
  fs.symlinkSync(dataDir, path.join(evil, '.radial'));
  assert.equal(servable(path.join(evil, '.radial', 'shots', 'site-home-full@2x-1.png'), fileRoots(dataDir, [evil])), false);
  assert.equal(servable(shotFile, fileRoots(dataDir, [])), true);
  // A compare reply over HTTP names each file by url as well.
  const rows = withFileUrls('migrateCompare', { ok: true, dir: compare, report: path.join(compare, 'report.md'), rows: [{ route: '/', width: 1440, files: { diff: path.join(compare, 'home@1440.diff.png') } }] }, 'http://h:1') as unknown as { reportUrl: string; rows: { urls: { diff: string } }[] }; // the compare reply, with the urls it adds
  assert.equal(rows.reportUrl, `http://h:1/files?path=${encodeURIComponent(path.join(compare, 'report.md'))}`);
  assert.equal(rows.rows[0].urls.diff, `http://h:1/files?path=${encodeURIComponent(path.join(compare, 'home@1440.diff.png'))}`);
});

test('url over HTTP: the preview proxy’s address, by the name the caller reached the listener with; no share link on loopback', async () => {
  const l = await ready;
  const devServer = http.createServer((req, res) => { res.end('dev'); });
  await new Promise<void>((resolve) => devServer.listen(0, '127.0.0.1', resolve));
  try {
    previews.set(repo, { ok: true, url: `http://127.0.0.1:${(devServer.address() as { port: number }).port}/`, name: 'site' });
    const viaLocalhost = rpcFrames((await call('POST', '/rpc', { headers: { Host: `localhost:${l.port}` }, body: JSON.stringify({ op: 'url', target: repo }) })).body)[0];
    assert.equal(viaLocalhost.ok, true, JSON.stringify(viaLocalhost));
    assert.match(String(viaLocalhost.url), /^http:\/\/localhost:\d+\/$/);
    assert.equal(viaLocalhost.devUrl, 'http://127.0.0.1:9/');
    const proxyPort = Number(new URL(String(viaLocalhost.url)).port);
    assert.ok(proxyPort > l.port, 'a port after the listener’s');
    const shared = rpcFrames((await call('POST', '/rpc', { body: JSON.stringify({ op: 'url', target: repo, share: true }) })).body)[0];
    assert.deepEqual([shared.ok, shared.code], [false, 'bad-request']); assert.match(String(shared.error), /--allow-remote/);
    // And the proxy serves the preview.
    const page = await new Promise<string>((resolve, reject) => http.get(`http://127.0.0.1:${proxyPort}/`, { agent: false }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b)); }).on('error', reject));
    assert.equal(page, 'dev');
  } finally { devServer.close(); }
});
