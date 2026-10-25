// radial serve --listen end to end (plans/headless-core.md phase 4): the real
// `radial serve` under plain Node, no Electron anywhere, reached over HTTP by
// clients that have only its address and a token, as an agent on another
// machine would:
//   no token, a wrong one and a revoked one get 401 on every path;
//   a foreign Host and a web page's Origin are refused;
//   tools/list over HTTP is stdio's (`radial mcp`), and a tool answers;
//   the CLI through RADIAL_URL and RADIAL_TOKEN answers as over the socket,
//     its progress streamed;
//   /events delivers the core's events, and a revoked token's stream ends;
//   the preview proxy's address keeps working across a dev-server restart on
//     a new port, and a websocket upgrade passes through (a stand-in dev server
//     in plain node:http, test/fixtures/ws-dev-server.cjs);
//   a shot's image is fetched over HTTP with only its url and the token, and
//     the MCP result carries a copy; doctor says whether Chrome's sandbox is on;
//   a non-loopback --listen is refused without --allow-remote;
//   with --allow-remote, the proxy refuses another machine (this one's LAN
//     address), and this one, without a pass, and lets it in after the share
//     link, whose ticket works once and whose cookie never reaches the dev
//     server; over the socket, radial url then answers the dev server's own
//     address.
// `npm run test:headless:remote` (it requires the browser for the shot:
// `radial browser install`); also part of `npm run test:e2e`, which skips the
// shot without one. Runs on macOS and Linux.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { test } from 'node:test';
import { execFile, execFileSync, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { OpName, OpReplies } from '../src/main/cliServer.ts';
import type { ServeReply } from '../src/headless/serve.ts';
import type { BrowserInfo } from '../src/headless/browser.ts';
import { wsRoundTrip } from './support/ws.mts';

const ROOT = path.join(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'bin', 'radial');

/** A `radial …` run: its exit code and output. */
interface CliRun { code: number; stdout: string; stderr: string }
/** An HTTP response, its body as text. */
interface Res { status: number; headers: http.IncomingHttpHeaders; body: string; raw: Buffer }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(label: string, ms: number, fn: () => T | Promise<T>): Promise<NonNullable<T>> {
  const t0 = Date.now(); let last: unknown;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last as NonNullable<T>; } catch (e) { last = (e as Error).message; } await sleep(200); }
  throw new Error(`timeout: ${label} (${JSON.stringify(last)})`);
}
/** One HTTP request, with whatever headers the test says (Host and Origin included). */
function request(url: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks); resolve({ status: res.statusCode || 0, headers: res.headers, body: raw.toString('utf8'), raw }); });
    });
    req.setTimeout(120000, () => req.destroy(new Error(`no answer from ${url}`)));
    req.on('error', reject);
    req.end(body);
  });
}
/** Whether a process is there (a zombie isn't). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
}
const git = (cwd: string, args: string[]) => String(execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], { cwd, encoding: 'utf8' })).trim();
/** This machine's first IPv4 address another machine could use: the --allow-remote checks come from it, so they don't count as this machine's own. */
const lanAddress = (): string | null => { for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address; return null; };

/** A site whose dev script is the stand-in dev server (a page, /echo, and a websocket echo), in a git repo. */
function devSite(dir: string): string {
  fs.mkdirSync(dir);
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'ws-dev-server.cjs'), path.join(dir, 'server.cjs'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), private: true, scripts: { dev: 'node server.cjs' } }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>App</title></head><body><h1>Hello from the dev server</h1></body></html>');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  fs.mkdirSync(path.join(dir, 'node_modules')); // nothing to install: the dev script uses Node alone
  git(dir, ['init', '-q', '-b', 'main']); git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

/** The CLI on a scratch data dir (RADIAL_USERDATA, so the PTY daemon goes with serve), and the same CLI sent elsewhere with RADIAL_URL. */
function cliFor(data: string, extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, RADIAL_CLI_FLAVOR: 'headless', RADIAL_USERDATA: data, RADIAL_AUTO_RELOAD: '0', RADIAL_NO_CAFFEINATE: '1', ...extra };
  for (const k of ['RADIAL_CLI_SOCK', 'RADIAL_DATA_DIR', 'RADIAL_CLI_APP', 'RADIAL_CLI_APP_ARG', 'ELECTRON_RUN_AS_NODE', 'RADIAL_URL', 'RADIAL_TOKEN']) if (!(k in extra)) delete env[k];
  const radial = (args: string[], timeout = 300000) => new Promise<CliRun>((resolve) => execFile('/bin/sh', [CLI, ...args], { env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
  // K names the socket op whose reply R the run prints with --json (or an ErrorReply when it fails); nothing checks either.
  const json = async <K extends OpName, R = OpReplies[K]>(args: string[]) => { const r = await radial([...args, '--json']); let j: R | null = null; try { j = JSON.parse(r.stdout); } catch {} return { ...r, json: j! }; };
  return { env, radial, json };
}

/** One `radial mcp` session over stdio: JSON-RPC requests, answered by id. */
function mcpSession(env: NodeJS.ProcessEnv) {
  const child = spawn('/bin/sh', [CLI, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const answers = new Map<number, Record<string, unknown>>();
  let buf = '', seq = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { buf += d; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { const m = JSON.parse(line) as { id: number }; answers.set(m.id, m); } } });
  const call = async (method: string, params: unknown = {}) => {
    const id = ++seq;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return until(`mcp ${method}`, 60000, () => answers.get(id)) as Promise<{ result?: Record<string, unknown>; error?: unknown }>;
  };
  return { call, close: () => { child.stdin.end(); child.kill(); } };
}

test('radial serve --listen: tokens on every path, Host and Origin checks, MCP and the CLI over HTTP, events, the preview proxy across a restart with its websocket, a shot by url, loopback unless --allow-remote, and share links', { timeout: 900000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rhr-'));
  const data = path.join(scratch, 'data');
  const elsewhere = path.join(scratch, 'elsewhere'); // the remote CLI's own data dir: empty, no socket, as on another machine
  fs.mkdirSync(elsewhere);
  const local = cliFor(data);
  const pids: number[] = [];
  const live = http.createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/index.html') { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>Not found</h1>'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html><head><title>Live</title></head><body><h1>The live site</h1><p>Copy.</p></body></html>');
  });
  await new Promise<void>((resolve) => live.listen(0, '127.0.0.1', resolve));
  const liveUrl = `http://127.0.0.1:${(live.address() as AddressInfo).port}/`;
  let mcp: ReturnType<typeof mcpSession> | null = null;
  try {
    const shell = await local.radial(['browser', '--json']);
    const browser = (() => { try { return JSON.parse(shell.stdout) as BrowserInfo; } catch { return null; } })();
    const hasBrowser = !!(browser && browser.installed);
    if (!hasBrowser && process.env.RADIAL_BROWSER_REQUIRED === '1') assert.fail(`No browser for radial serve: run \`radial browser install\` first.\n${shell.stdout}${shell.stderr}`);

    // 1. Tokens before serve; serve on loopback, port of the OS's choosing.
    const tok = await local.radial(['token', 'create', 'e2e', '--json']);
    assert.equal(tok.code, 0, tok.stderr);
    const token = (JSON.parse(tok.stdout) as { token: string }).token;
    const tokenRaw = fs.readFileSync(path.join(data, 'api-tokens.json'), 'utf8');
    assert.ok(!tokenRaw.includes(token), 'only the hash is kept');
    assert.equal(fs.statSync(path.join(data, 'api-tokens.json')).mode & 0o777, 0o600);
    const started = await local.radial(['serve', '--detach', '--listen', '127.0.0.1:0', '--json']);
    assert.equal(started.code, 0, started.stderr + started.stdout);
    const serveReply = JSON.parse(started.stdout) as Extract<ServeReply, { ok: true }>;
    pids.push(serveReply.pid!);
    const base = serveReply.listen!;
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
    const port = Number(new URL(base).port);
    assert.match((await local.radial(['serve', 'status'])).stdout, new RegExp(`\\n  Listening: ${base.replace(/[.]/g, '\\.')} \\(MCP at /mcp, the CLI at /rpc`));
    const auth = { Authorization: `Bearer ${token}` };
    const remote = cliFor(elsewhere, { RADIAL_URL: base, RADIAL_TOKEN: token });

    const app = devSite(path.join(scratch, 'app'));
    const opened = await local.json<'open'>(['open', app]);
    assert.equal(opened.code, 0, opened.stderr);
    const devUrl1 = opened.json.url!;

    // 2. Every path needs a token: none, a wrong one, and a revoked one get 401 (with WWW-Authenticate).
    const doomed = JSON.parse((await local.radial(['token', 'create', 'doomed', '--json'])).stdout) as { token: string };
    assert.equal((await request(`${base}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${doomed.token}` }, body: '{"op":"hello"}' })).status, 200, 'it works until it’s revoked');
    assert.equal((await local.radial(['token', 'revoke', 'doomed'])).code, 0);
    const shotsDir = path.join(data, 'shots');
    const paths: [string, string, string | undefined][] = [['POST', '/mcp', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'], ['POST', '/rpc', '{"op":"ls"}'], ['GET', '/events', undefined], ['GET', `/files?path=${encodeURIComponent(path.join(shotsDir, 'x.png'))}`, undefined], ['GET', '/', undefined]];
    for (const [method, route, body] of paths) {
      for (const [why, header] of [['no token', {}], ['a wrong token', { Authorization: `Bearer rcore_${'Q'.repeat(43)}` }], ['a revoked token', { Authorization: `Bearer ${doomed.token}` }]] as const) {
        const r = await request(base + route, { method, headers: header, body });
        assert.equal(r.status, 401, `${method} ${route} with ${why}: ${r.body}`);
        assert.match(String(r.headers['www-authenticate']), /^Bearer realm="radial"/);
      }
    }

    // 3. A foreign Host (DNS rebinding) and a web page's Origin are refused.
    const rebound = await request(`${base}/rpc`, { method: 'POST', headers: { ...auth, Host: `attacker.example:${port}` }, body: '{"op":"ls"}' });
    assert.equal(rebound.status, 403); assert.match(rebound.body, /doesn't answer requests addressed to attacker\.example/);
    const page = await request(`${base}/mcp`, { method: 'POST', headers: { ...auth, Origin: 'https://attacker.example' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(page.status, 403); assert.match(page.body, /refuses calls from web pages/);

    // 4. MCP over HTTP: tools/list is stdio's, and a tool answers.
    const post = async (msg: unknown) => JSON.parse((await request(`${base}/mcp`, { method: 'POST', headers: { ...auth, Accept: 'application/json, text/event-stream' }, body: JSON.stringify(msg) })).body) as { result: Record<string, unknown> };
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-http', version: '1' } } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal((await request(`${base}/mcp`, { method: 'POST', headers: auth, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' })).status, 202);
    const overHttp = (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result;
    mcp = mcpSession(local.env);
    await mcp.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'e2e-stdio' } });
    const overStdio = (await mcp.call('tools/list')).result!;
    assert.deepEqual(overHttp, overStdio, 'the same tools, schemas and hints');
    const tools = overHttp.tools as { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] }; annotations: { destructiveHint: boolean } }[];
    const kill = tools.find((x) => x.name === 'kill_agent')!;
    assert.deepEqual([kill.annotations.destructiveHint, !!kill.inputSchema.properties.confirm, kill.inputSchema.required!.includes('confirm')], [true, true, true]);
    const projects = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } });
    const listed = JSON.parse((projects.result.content as { text: string }[])[0].text) as OpReplies['ls'];
    assert.deepEqual(listed.projects.map((p) => p.repoDir), [app]);

    // 5. The CLI through RADIAL_URL and RADIAL_TOKEN answers as the socket does, with its progress streamed.
    // The same answer either way, less when git's status was read.
    const settled = (text: string) => JSON.parse(text, (k, v: unknown) => (k === 'observedAt' ? undefined : v)) as unknown;
    for (const args of [['ls', '--json'], ['status', app, '--json'], ['context', app], ['pages', app]]) {
      const [viaSocket, viaHttp] = [await local.radial(args), await remote.radial(args)];
      assert.equal(viaHttp.code, viaSocket.code, `${args.join(' ')}: ${viaHttp.stderr}`);
      if (args.includes('--json')) assert.deepEqual(settled(viaHttp.stdout), settled(viaSocket.stdout), args.join(' '));
      else assert.equal(viaHttp.stdout, viaSocket.stdout, args.join(' '));
    }
    const captured = await remote.radial(['migrate', 'capture', liveUrl, '--project', app, '--only', '/']);
    assert.equal(captured.code, 0, captured.stderr + captured.stdout);
    assert.match(captured.stderr, /^Reading 127\.0\.0\.1 \(.*\)…\n/m, 'progress, as it came');
    assert.match(captured.stderr, /^Captured 1 page/m);
    assert.match(captured.stdout, /^Captured http:\/\/127\.0\.0\.1:\d+/);
    const noToken = cliFor(elsewhere, { RADIAL_URL: base, RADIAL_TOKEN: `rcore_${'Q'.repeat(43)}` });
    const refused = await noToken.radial(['ls']);
    assert.equal(refused.code, 6); assert.match(refused.stderr, /doesn't accept that token/);

    // 6. /events delivers the core's events; revoking the token ends the stream.
    const viewer = JSON.parse((await local.radial(['token', 'create', 'viewer', '--json'])).stdout) as { token: string };
    const heard: string[] = [];
    let ended = false;
    const stream = http.get(`${base}/events`, { agent: false, headers: { Authorization: `Bearer ${viewer.token}` } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => heard.push(c));
      res.on('end', () => { ended = true; });
    });
    stream.on('error', () => { ended = true; });
    await until('the stream is ready', 10000, () => heard.join('').includes('event: ready'));
    assert.equal((await remote.radial(['comments', 'add', app, '--text', 'Bigger hero'])).code, 0);
    await until('the comment’s event', 10000, () => heard.join('').includes('event: comments:changed'));
    assert.match(heard.join(''), new RegExp(`event: comments:changed\\ndata: \\{"repoDir":"${app.replace(/[/.\\]/g, '\\$&')}"\\}`));
    assert.equal((await local.radial(['token', 'revoke', 'viewer'])).code, 0);
    await until('the revoked token’s stream ends', 10000, () => ended);

    // 7. The preview proxy: one address that follows the dev server across a restart, websocket upgrades included.
    const addr = await remote.json<'url'>(['url', app]);
    assert.equal(addr.code, 0, addr.stderr);
    const proxyUrl = addr.json.url;
    assert.match(proxyUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(addr.json.devUrl, devUrl1);
    assert.equal((await local.json<'url'>(['url', app])).json.url, proxyUrl, 'the socket’s radial url says the same');
    const echo1 = JSON.parse((await request(proxyUrl + 'echo')).body) as { port: number; host: string };
    assert.equal(echo1.port, Number(new URL(devUrl1).port), 'the dev server answered through it');
    assert.equal(echo1.host, new URL(proxyUrl).host, 'with the Host the browser used');
    const ws1 = await wsRoundTrip(proxyUrl + 'hmr', 'ping');
    assert.equal(ws1.status, 101); assert.equal((JSON.parse(ws1.message!) as { echo: string }).echo, 'ping');
    const restarted = await remote.json<'restart'>(['restart', app]);
    assert.equal(restarted.code, 0, restarted.stderr);
    assert.ok(restarted.json.url && restarted.json.url !== devUrl1, `${devUrl1} → ${restarted.json.url}`);
    assert.equal((await remote.json<'url'>(['url', app])).json.url, proxyUrl, 'the same address after the restart');
    const echo2 = JSON.parse((await request(proxyUrl + 'echo')).body) as { port: number };
    assert.equal(echo2.port, Number(new URL(restarted.json.url!).port), 'now the new server answers');
    const ws2 = await wsRoundTrip(proxyUrl + 'hmr', 'pong');
    assert.equal((JSON.parse(ws2.message!) as { echo: string }).echo, 'pong');
    assert.equal((await request(proxyUrl, { headers: { Host: 'attacker.example' } })).status, 403, 'the proxy checks the Host too');

    // 8. A shot by url, with only the url and the token; the MCP result carries a copy. Doctor says whether Chrome's sandbox is on.
    if (!hasBrowser) t.diagnostic('No browser: the shot and the sandbox check are skipped (radial browser install).');
    else {
      const shot = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'screenshot', arguments: { project: app, width: 800 } } });
      const content = shot.result.content as ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
      assert.equal(shot.result.isError, false, JSON.stringify(content[0]));
      const reply = JSON.parse((content[0] as { text: string }).text) as { path: string; url: string; scale: number };
      assert.match(reply.url, new RegExp(`^${base.replace(/[.]/g, '\\.')}/files\\?path=`));
      const image = await request(reply.url, { headers: auth });
      assert.equal(image.status, 200); assert.equal(image.headers['content-type'], 'image/png');
      assert.ok(image.raw.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'a PNG');
      assert.ok(image.raw.equals(fs.readFileSync(reply.path)), 'the shot itself');
      assert.equal(image.raw.readUInt32BE(16), 800 * reply.scale, 'at the width asked for');
      assert.equal((await request(reply.url)).status, 401, 'not without the token');
      const copy = content.find((c) => c.type === 'image') as { data: string; mimeType: string };
      assert.equal(copy.mimeType, 'image/png');
      assert.equal(Buffer.from(copy.data, 'base64').readUInt32BE(16), 800, 'the copy at 1x');
      const cliShot = await remote.radial(['shot', app]);
      assert.equal(cliShot.code, 0, cliShot.stderr);
      const fetched = cliShot.stdout.trim();
      assert.ok(fetched.startsWith(path.join(elsewhere, 'shots') + path.sep) && fs.existsSync(fetched), `the remote CLI fetched the shot into its own data dir: ${fetched}`);
      const doctor = JSON.parse((await local.radial(['doctor', '--json'])).stdout) as { checks: { name: string; ok: boolean; detail: string }[] };
      const sandbox = doctor.checks.find((c) => c.name === 'sandbox');
      assert.ok(sandbox, 'doctor reports the sandbox mode');
      assert.match(sandbox!.detail, /^radial serve's browser runs (with|without) Chrome's sandbox/, 'the running serve’s');
      if (process.platform === 'darwin') assert.equal(sandbox!.ok, true, 'macOS gives Chrome its sandbox');
      t.diagnostic(`sandbox: ${sandbox!.detail}`);
    }

    // 9. Stop: no listener, no proxy.
    mcp.close(); mcp = null;
    assert.equal((await local.radial(['serve', 'stop'])).code, 0);
    await assert.rejects(request(`${base}/rpc`, { method: 'POST', headers: auth, body: '{"op":"hello"}' }), /ECONNREFUSED/);
    await assert.rejects(request(proxyUrl), /ECONNREFUSED/);

    // 10. Loopback only, unless --allow-remote: a non-loopback --listen is refused, with what to do instead.
    const data2 = path.join(scratch, 'data2');
    const local2 = cliFor(data2);
    const wide = await local2.radial(['serve', '--listen', '0.0.0.0:0']);
    assert.equal(wide.code, 2);
    assert.match(wide.stderr, /0\.0\.0\.0 can be reached from other machines, .* unless you pass --allow-remote\. To reach it from elsewhere, put SSH or Tailscale in front/);
    assert.equal(fs.existsSync(path.join(data2, 'cli.sock')), false, 'nothing started');

    // 11. --allow-remote: the API still needs a token from anywhere, and the preview needs a pass from another machine: a share link's.
    const lan = lanAddress();
    if (!lan) { t.diagnostic('No non-loopback IPv4 address here: the --allow-remote checks are skipped.'); return; }
    const tok2 = JSON.parse((await local2.radial(['token', 'create', 'laptop', '--json'])).stdout) as { token: string };
    const started2 = await local2.radial(['serve', '--detach', '--listen', '0.0.0.0:0', '--allow-remote', '--json']);
    assert.equal(started2.code, 0, started2.stderr + started2.stdout);
    const reply2 = JSON.parse(started2.stdout) as Extract<ServeReply, { ok: true }>;
    pids.push(reply2.pid!);
    const port2 = Number(new URL(reply2.listen!).port);
    const base2 = `http://${lan}:${port2}`;
    assert.equal((await request(`${base2}/rpc`, { method: 'POST', body: '{"op":"hello"}' })).status, 401, 'no token, from the LAN');
    const fromLan = cliFor(elsewhere, { RADIAL_URL: base2, RADIAL_TOKEN: tok2.token });
    const app2 = devSite(path.join(scratch, 'app2'));
    const opened2 = await fromLan.json<'open'>(['open', app2]);
    assert.equal(opened2.code, 0, opened2.stderr);
    const shared = await fromLan.json<'url'>(['url', app2, '--share']);
    assert.equal(shared.code, 0, shared.stderr);
    const proxy2 = new URL(shared.json.url);
    assert.equal(proxy2.hostname, lan, 'the address the caller reached Radial by');
    const link = new URL(shared.json.share!.url);
    assert.deepEqual([link.hostname, link.port, link.pathname], [lan, proxy2.port, '/__radial/pass']);
    const human = await fromLan.radial(['url', app2, '--share']);
    assert.match(human.stdout, /^http:\/\/.*\/__radial\/pass\?ticket=\S+\n\(One use, within ten minutes/);
    const denied = await request(proxy2.href);
    assert.equal(denied.status, 401); assert.match(denied.body, /This preview needs a pass/);
    assert.equal((await wsRoundTrip(proxy2.href + 'hmr', 'x')).status, 401, 'nor its websocket');
    const swap = await request(link.href);
    assert.equal(swap.status, 302);
    const cookie = String(swap.headers['set-cookie']![0]);
    assert.match(cookie, /^radial_pass_\d+=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
    const pass = cookie.split(';')[0];
    const inside = await request(proxy2.href, { headers: { Cookie: pass } });
    assert.equal(inside.status, 200); assert.match(inside.body, /Hello from the dev server/);
    const echoed = JSON.parse((await request(proxy2.href + 'echo', { headers: { Cookie: `theme=dark; ${pass}` } })).body) as { cookie: string };
    assert.equal(echoed.cookie, 'theme=dark', 'the dev server never sees the pass');
    assert.equal((await wsRoundTrip(proxy2.href + 'hmr', 'hi', { Cookie: pass, Origin: proxy2.origin })).status, 101, 'and its websocket goes through');
    assert.equal((await wsRoundTrip(proxy2.href + 'hmr', 'hi', { Cookie: pass, Origin: 'https://attacker.example' })).status, 403, 'but not from another site’s page');
    assert.equal((await request(link.href)).status, 401, 'the ticket worked once');
    const own = await request(`http://127.0.0.1:${proxy2.port}/`);
    assert.equal(own.status, 401, 'this machine needs a pass too: a tunnel to the port would make anyone local');
    const devOwn = await local2.json<'url'>(['url', app2]);
    assert.deepEqual([devOwn.json.url, devOwn.json.devUrl], [opened2.json.url, undefined], 'over the socket, radial url answers the dev server’s own address');
    assert.match((await request(devOwn.json.url)).body, /Hello from the dev server/, 'which an agent on this machine opens as is');
    assert.equal((await local2.radial(['serve', 'stop'])).code, 0);
    await until('serve stopped', 30000, () => pids.every((pid) => !alive(pid)));
  } finally {
    mcp?.close();
    for (const [cli, pid] of [[local, pids[0]], [cliFor(path.join(scratch, 'data2')), pids[1]]] as const) {
      if (pid && alive(pid)) { await cli.radial(['serve', 'stop'], 60000); try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    live.closeAllConnections(); live.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
