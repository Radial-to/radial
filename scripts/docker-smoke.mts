#!/usr/bin/env node
// The Docker image, end to end from the host (plans/headless-core.md, phase
// 5), the way docker/Dockerfile's comment says to run it:
//
//   node scripts/docker-smoke.mts --image radial [--shot] [--port 4000] [--keep]
//
// The host's client is this checkout's CLI (npm run build first), reaching the
// container only through RADIAL_URL and RADIAL_TOKEN:
//   docker run with the ports published one to one and a volume for /data;
//   serve listens, runs as the node user under tini, and with no token yet
//   refuses every request and logs the docker exec line that makes one;
//   docker exec … radial token create; a static git site made in /work;
//   radial ls, open, edit text --find; the file and the preview (through the
//   project's stable port, with a share link) say the new text;
//   --shot (the browser image): radial shot, fetched to this machine, a PNG;
//   without it, shot refuses with the command that adds a browser.
// It removes its container and its volumes (the named /data one and the
// anonymous /work one) when it's done.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'out', 'main', 'cli.js');

function args(argv: string[]): { image: string; shot: boolean; port: number; keep: boolean } {
  const a = { image: '', shot: false, port: 4000, keep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--image') a.image = argv[++i];
    else if (argv[i] === '--shot') a.shot = true;
    else if (argv[i] === '--port') a.port = Number(argv[++i]);
    else if (argv[i] === '--keep') a.keep = true;
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  if (!a.image) throw new Error('--image <name> is needed');
  return a;
}
const opts = args(process.argv.slice(2));
if (!fs.existsSync(CLI)) throw new Error('out/main/cli.js is missing: npm run build first');
const id = crypto.randomBytes(4).toString('hex');
const name = `radial-smoke-${id}`, volume = `radial-smoke-${id}`;
const base = opts.port, last = base + 20;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rds-'));

function check(ok: unknown, what: string, detail: unknown = ''): void {
  if (!ok) throw new Error(`${what}${detail ? `\n${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}` : ''}`);
  console.log(`ok  ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (a: string[]) => execFileSync('docker', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const logs = () => { try { return execFileSync('docker', ['logs', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return String((e as { stdout?: string }).stdout || ''); } };
async function until<T>(what: string, ms: number, fn: () => T | null | undefined | false | Promise<T | null | undefined | false>): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v as T; await sleep(300); }
  throw new Error(`timed out: ${what}\n--- container log ---\n${logs()}`);
}
/** Whether a port is free on this machine, as Docker would publish it. */
function free(port: number): Promise<boolean> {
  return new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '0.0.0.0', () => s.close(() => resolve(true))); });
}
/** One HTTP request: status, headers and body. */
function request(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent: false }, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c: string) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body })); });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error(`no answer from ${url}`)));
  });
}
/** A browser following a share link: redirects followed, the pass cookie kept. */
async function browse(url: string): Promise<{ status: number; body: string }> {
  let cookie = '';
  for (let i = 0; i < 5; i++) {
    const r = await request(url, cookie ? { cookie } : {});
    const set = r.headers['set-cookie'];
    if (set) cookie = set.map((c) => c.split(';')[0]).join('; ');
    if (r.status >= 300 && r.status < 400 && r.headers.location) { url = new URL(r.headers.location, url).href; continue; }
    return r;
  }
  throw new Error('too many redirects');
}

let token = '';
const env = (): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, RADIAL_URL: `http://127.0.0.1:${base}`, RADIAL_TOKEN: token, RADIAL_CLI_FLAVOR: 'headless', RADIAL_DATA_DIR: path.join(scratch, 'data') };
  for (const k of ['RADIAL_USERDATA', 'RADIAL_CLI_SOCK', 'RADIAL_CLI_APP', 'RADIAL_CLI_APP_ARG', 'ELECTRON_RUN_AS_NODE']) delete e[k];
  return e;
};
interface Run { code: number; stdout: string; stderr: string }
const radial = (a: string[], timeout = 240000) => new Promise<Run>((resolve) => execFile(process.execPath, [CLI, ...a], { env: env(), encoding: 'utf8', timeout }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
const json = async <T,>(a: string[]): Promise<Run & { json: T }> => { const r = await radial([...a, '--json']); let j: T | null = null; try { j = JSON.parse(r.stdout) as T; } catch {} return { ...r, json: j as T }; };

try {
  const taken: number[] = [];
  for (let p = base; p <= last; p++) if (!(await free(p))) taken.push(p);
  check(!taken.length, `ports ${base}-${last} are free here`, `${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} taken on this machine: pass --port <another base>`);
  // The image as the Dockerfile says to run it; another base port runs the same serve on that port.
  const portArgs = base === 4000 ? [] : ['--entrypoint', '/usr/bin/tini'];
  const cmd = base === 4000 ? [] : ['--', 'radial', 'serve', '--listen', `0.0.0.0:${base}`, '--allow-remote'];
  docker(['volume', 'create', volume]);
  docker(['run', '-d', '--name', name, '-p', `${base}-${last}:${base}-${last}`, '-v', `${volume}:/data`, ...portArgs, opts.image, ...cmd]);
  await until('serve listens', 60000, () => new RegExp(`Listening on http://0\\.0\\.0\\.0:${base}`).test(logs()));
  check(true, `serve listens on 0.0.0.0:${base} in the container`);
  const hostname = docker(['exec', name, 'hostname']);
  check(logs().includes(`No API tokens yet, so every HTTP request is refused. Make one from the host: docker exec ${hostname} radial token create <name>`), 'with no token it refuses everything, and logs the docker exec line that makes one', logs());
  check(docker(['exec', name, 'id', '-u']) === '1000', 'it runs as the node user (uid 1000)');
  check(/tini/.test(docker(['exec', name, 'cat', '/proc/1/cmdline'])), 'tini is PID 1');
  const refused = await request(`http://127.0.0.1:${base}/rpc`);
  check(refused.status === 401 && /Bearer/.test(String(refused.headers['www-authenticate'])), 'a request without a token gets 401 from the host');

  const made = JSON.parse(docker(['exec', name, 'radial', 'token', 'create', 'smoke', '--json'])) as { ok: boolean; token: string };
  token = made.token;
  check(/^rcore_/.test(token), 'docker exec … radial token create made a token');
  docker(['exec', name, 'sh', '-c', [
    'mkdir -p /work/site && cd /work/site',
    'printf "<!doctype html><html><head><title>Fixture</title></head><body><h1>Welcome home</h1><p>Some body copy.</p></body></html>\\n" > index.html',
    'git init -q -b main && git add -A && git -c user.name=smoke -c user.email=smoke@example.com commit -q -m init',
  ].join(' && ')]);

  const ls = await json<{ ok: boolean; projects: unknown[] }>(['ls']);
  check(ls.code === 0 && ls.json.ok, 'radial ls from the host, over RADIAL_URL and RADIAL_TOKEN', ls.stdout + ls.stderr);
  const opened = await json<{ ok: boolean; url: string; repoDir: string }>(['open', '/work/site']);
  check(opened.code === 0 && opened.json.repoDir === '/work/site', `radial open /work/site: ${opened.json && opened.json.url}`, opened.stdout + opened.stderr);
  const edited = await json<{ ok: boolean; relFile: string; line: number }>(['edit', 'text', '/work/site', '--find', 'Welcome home', '--to', 'Welcome back']);
  check(edited.code === 0 && edited.json.relFile === 'index.html', 'radial edit text --find', edited.stdout + edited.stderr);
  check(/Welcome back/.test(docker(['exec', name, 'cat', '/work/site/index.html'])), 'the file in the container says the new text');
  const url = await json<{ ok: boolean; url: string }>(['url', '/work/site']);
  check(url.code === 0 && url.json.url === `http://127.0.0.1:${base + 1}/`, `radial url: the project's stable port, ${url.json && url.json.url}`, url.stdout + url.stderr);
  const bare = await request(url.json.url);
  check(bare.status === 401, 'the preview needs a pass from the host (--allow-remote)');
  const share = await json<{ ok: boolean; share: { url: string } }>(['url', '/work/site', '--share']);
  check(share.code === 0 && share.json.share && share.json.share.url, 'radial url --share made a link', share.stdout + share.stderr);
  const link = new URL(share.json.share.url); link.hostname = '127.0.0.1'; // the container's guess at its address is its own network's; the host reaches the published port on loopback
  const page = await until('the preview shows the edit', 30000, async () => { const r = await browse(link.href); return r.status === 200 && /Welcome back/.test(r.body) ? r : null; });
  check(page, 'the share link opens the preview from the host, with the new text');

  if (opts.shot) {
    const shot = await json<{ ok: boolean; path: string; width: number; height: number }>(['shot', '/work/site']);
    check(shot.code === 0 && shot.json.path && fs.existsSync(shot.json.path), `radial shot, fetched to this machine: ${shot.json && shot.json.path}`, shot.stdout + shot.stderr);
    const png = fs.readFileSync(shot.json.path);
    check(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0, `it is a PNG, ${png.readUInt32BE(16)}×${png.readUInt32BE(20)}`);
    const doctor = docker(['exec', name, 'radial', 'doctor']);
    check(/ok {7}browser/.test(doctor), 'radial doctor in the container finds the browser', doctor);
  } else {
    const shot = await json<{ ok: boolean; code: string; fix: string }>(['shot', '/work/site']);
    check(shot.code !== 0 && shot.json.code === 'no-browser' && /radial browser install/.test(shot.json.fix), 'radial shot refuses: no browser in this image, and says what adds one', shot.stdout + shot.stderr);
  }
  console.log(`\nThe image ${opts.image} works from this machine.`);
} catch (e) {
  console.error(`\nFAILED: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  if (!opts.keep) {
    try { execFileSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' }); } catch {} // -v: the image's /work volume too, which this run left anonymous
    try { execFileSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' }); } catch {}
  } else console.log(`Kept the container ${name} and the volume ${volume}.`);
  fs.rmSync(scratch, { recursive: true, force: true });
}
