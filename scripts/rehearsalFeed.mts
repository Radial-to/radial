// The pure parts of the update rehearsal (scripts/update-rehearsal.mts): semver
// order, the feed folder it serves (latest-mac.yml, the zip and its blockmap),
// the server for that folder, the app's control socket, and what macOS's
// signing tools and `ps` print. No Electron and no child processes, so the unit
// suite runs them directly (test/updateRehearsal.test.ts).
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

// js-yaml comes with electron-builder (scripts/releaseCheck.mts reads it the same way).
const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(text: string): unknown };

// ── Versions ─────────────────────────────────────────────────────────────────

/** A semver version: its three numbers and its pre-release identifiers (numeric ones as numbers). */
export interface SemVer { major: number; minor: number; patch: number; pre: (string | number)[] }

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** '1.0.0-rc.2' → its parts; null when it isn't a semver version (build metadata is dropped). */
export function parseVersion(v: string): SemVer | null {
  const m = SEMVER.exec(String(v).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [] };
}

/**
 * Semver precedence, the order electron-updater uses to decide an update is
 * newer: -1 when a comes first, 1 when b does, 0 when equal. A pre-release comes
 * before its release (1.0.0-rc.2 < 1.0.0); numeric identifiers compare as
 * numbers (rc.2 < rc.10) and before word ones. Throws on a non-version.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x) throw new Error(`not a semver version: ${JSON.stringify(a)}`);
  if (!y) throw new Error(`not a semver version: ${JSON.stringify(b)}`);
  const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return sign(x[k] - y[k]);
  if (!x.pre.length || !y.pre.length) return sign(y.pre.length - x.pre.length); // a release outranks its pre-releases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return sign(p - q);
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// ── The update feed ──────────────────────────────────────────────────────────

/** The update feed's file name: electron-builder's macOS channel file. */
export const FEED_YML = 'latest-mac.yml';

/** One file latest-mac.yml lists. */
export interface FeedFile { url: string; sha512?: string; size?: number }

/** latest-mac.yml, as far as the rehearsal reads it, with its text. */
export interface Feed {
  version: string;
  /** The update zip's file name. */
  path: string;
  files: FeedFile[];
  /** The Darwin version an update needs (absent: any). */
  minimumSystemVersion: string | null;
  text: string;
}

/** A build folder's latest-mac.yml. Throws with a plain reason when it is missing or isn't one. */
export function readFeed(dir: string): Feed {
  const file = path.join(dir, FEED_YML);
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new Error(`${file} is missing: is ${dir} a build folder?`); }
  const doc = yaml.load(text) as { version?: unknown; path?: unknown; files?: unknown; minimumSystemVersion?: unknown } | null;
  if (!doc || typeof doc !== 'object') throw new Error(`${file} is not a YAML mapping`);
  const version = typeof doc.version === 'string' ? doc.version : String(doc.version ?? '');
  if (!parseVersion(version)) throw new Error(`${file} has no semver version (${JSON.stringify(doc.version)})`);
  if (typeof doc.path !== 'string' || !doc.path) throw new Error(`${file} names no update file (path)`);
  const files = (Array.isArray(doc.files) ? doc.files : []).filter((f): f is FeedFile => !!f && typeof f === 'object' && typeof (f as FeedFile).url === 'string');
  const min = doc.minimumSystemVersion;
  return { version, path: doc.path, files, minimumSystemVersion: min == null ? null : String(min), text };
}

/**
 * latest-mac.yml's text with minimumSystemVersion set to `version` (the line
 * replaced, or added at the end), or removed when `version` is null. The same
 * edit release.mts makes with releaseCheck's withMinimumSystemVersion, for any value.
 */
export function setMinimumSystemVersion(yml: string, version: string | null): string {
  const line = /^minimumSystemVersion:.*(?:\r?\n|$)/m;
  if (version === null) return yml.replace(line, '');
  if (line.test(yml)) return yml.replace(/^minimumSystemVersion:.*$/m, `minimumSystemVersion: ${version}`);
  return yml.replace(/\n*$/, '\n') + `minimumSystemVersion: ${version}\n`;
}

/** sha512 of a file, base64, the way latest-mac.yml writes it. */
export function sha512File(file: string): string {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

/** writeFeed's result: the feed folder, the version it offers and the files it holds. */
export interface WrittenFeed { dir: string; version: string; zip: string; files: string[] }

/**
 * Makes a feed folder from a build folder: latest-mac.yml (with
 * minimumSystemVersion set when given, removed when null, as built when left
 * out) and every file it lists plus the zip's blockmap, hard-linked (copied
 * across volumes). Checks each listed file's size and sha512 against the yml
 * first, so a feed never mixes two builds. `to` must not exist yet.
 */
export function writeFeed(from: string, to: string, opts: { minimumSystemVersion?: string | null; verify?: boolean } = {}): WrittenFeed {
  const feed = readFeed(from);
  const names = new Set<string>([...feed.files.map((f) => f.url), feed.path]);
  const blockmap = `${feed.path}.blockmap`;
  if (fs.existsSync(path.join(from, blockmap))) names.add(blockmap);
  for (const name of names) {
    if (name !== path.basename(name)) throw new Error(`${FEED_YML} lists ${name}, which isn't a file beside it`);
    if (!fs.existsSync(path.join(from, name))) throw new Error(`${FEED_YML} lists ${name}, which is not in ${from}`);
  }
  if (opts.verify !== false) {
    for (const f of feed.files) {
      const file = path.join(from, f.url);
      const size = fs.statSync(file).size;
      if (typeof f.size === 'number' && size !== f.size) throw new Error(`${f.url} is ${size} bytes, ${FEED_YML} says ${f.size}: mixed build outputs`);
      if (f.sha512 && sha512File(file) !== f.sha512) throw new Error(`${f.url}'s sha512 doesn't match ${FEED_YML}: mixed build outputs`);
    }
  }
  if (fs.existsSync(to)) throw new Error(`${to} already exists`);
  fs.mkdirSync(to, { recursive: true });
  for (const name of names) {
    try { fs.linkSync(path.join(from, name), path.join(to, name)); }
    catch { fs.copyFileSync(path.join(from, name), path.join(to, name)); }
  }
  const text = opts.minimumSystemVersion === undefined ? feed.text : setMinimumSystemVersion(feed.text, opts.minimumSystemVersion);
  fs.writeFileSync(path.join(to, FEED_YML), text);
  return { dir: to, version: feed.version, zip: feed.path, files: [FEED_YML, ...names] };
}

// ── Serving it ───────────────────────────────────────────────────────────────

/** A request the feed server answered. */
export interface FeedRequest { at: number; method: string; path: string; status: number; bytes: number; range: string | null }

/** A running feed server: what it served, and the folder it serves now. */
export interface FeedServer {
  url: string;
  port: number;
  requests: FeedRequest[];
  /** Serve another folder from the next request on. */
  serve(dir: string): void;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = { '.yml': 'text/yaml', '.zip': 'application/zip', '.blockmap': 'application/octet-stream', '.json': 'application/json' };

/**
 * A static server for a feed folder on the loopback address: GET and HEAD,
 * query strings ignored (electron-updater adds ?noCache=…), one byte range at
 * a time (several ranges get the whole file), nothing outside the folder.
 * Rejects when the port is taken.
 */
export function startFeedServer(dir: string, { port = 0, host = '127.0.0.1' }: { port?: number; host?: string } = {}): Promise<FeedServer> {
  let root = path.resolve(dir);
  const requests: FeedRequest[] = [];
  const server = http.createServer((req, res) => {
    let pathname = '';
    try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://feed').pathname); } catch { pathname = req.url || ''; }
    const record = (status: number, bytes: number) => requests.push({ at: Date.now(), method: req.method || '', path: pathname, status, bytes, range: req.headers.range || null });
    const end = (status: number) => { res.writeHead(status, { 'Content-Length': 0 }); res.end(); record(status, 0); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(405);
    const file = path.join(root, path.normalize(pathname));
    if (pathname.includes('\0') || !file.startsWith(root + path.sep)) return end(404);
    let size: number;
    try { const st = fs.statSync(file); if (!st.isFile()) return end(404); size = st.size; } catch { return end(404); }
    const headers: Record<string, string | number> = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    let start = 0, last = size - 1, status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && (range[1] || range[2])) {
      if (range[1]) { start = Number(range[1]); if (range[2]) last = Math.min(Number(range[2]), size - 1); }
      else { start = Math.max(0, size - Number(range[2])); }
      if (start > last || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': 0 }); res.end(); record(416, 0); return; }
      status = 206; headers['Content-Range'] = `bytes ${start}-${last}/${size}`;
    }
    const length = size === 0 ? 0 : last - start + 1;
    headers['Content-Length'] = length;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || length === 0) { res.end(); record(status, 0); return; }
    const stream = fs.createReadStream(file, { start, end: last });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    res.on('finish', () => record(status, length));
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE' ? new Error(`port ${port} on ${host} is taken: stop whatever listens there, or build with another --port`) : e));
    server.listen(port, host, () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        url: `http://${host}:${address.port}/`,
        port: address.port,
        requests,
        serve(next: string) { root = path.resolve(next); },
        close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}

// ── The app's control socket ─────────────────────────────────────────────────

/**
 * One request to a running Radial's control socket (cli.sock, newline-delimited
 * JSON: src/main/cliProto.ts): progress frames are skipped and the reply frame
 * comes back. Null when nothing answers there in time.
 */
export function controlRequest(sock: string, frame: Record<string, unknown>, timeoutMs = 3000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let done = false, buffered = '';
    const s = net.createConnection(sock);
    const finish = (value: Record<string, unknown> | null) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    s.setEncoding('utf8');
    s.on('connect', () => s.write(JSON.stringify({ reqId: 'rehearsal-' + Date.now().toString(36), cwd: process.cwd(), tty: false, ...frame }) + '\n'));
    s.on('data', (chunk: string) => {
      buffered += chunk;
      let nl;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl); buffered = buffered.slice(nl + 1);
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.op === 'reply') return finish(msg);
      }
    });
    s.on('error', () => finish(null));
    s.on('close', () => finish(null));
  });
}

// ── What macOS's tools print ─────────────────────────────────────────────────

/** A bundle's signature, from `codesign -dv --verbose=4` (it prints to stderr). */
export interface Signature {
  signed: boolean;
  adhoc: boolean;
  identifier: string | null;
  teamId: string | null;
  authorities: string[];
  /** Signed with a Developer ID Application certificate. */
  developerId: boolean;
  hardenedRuntime: boolean;
  /** A notarization ticket is stapled to it. */
  stapled: boolean;
}

export function parseCodesign(text: string): Signature {
  const field = (name: string) => { const m = new RegExp(`^${name}=(.*)$`, 'm').exec(text); return m ? m[1].trim() : null; };
  const authorities = [...text.matchAll(/^Authority=(.*)$/gm)].map((m) => m[1].trim());
  const flags = /^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(text);
  const team = field('TeamIdentifier');
  const notSigned = /code object is not signed at all/.test(text);
  const adhoc = /^Signature=adhoc$/m.test(text) || !!(flags && /\badhoc\b/.test(flags[1]));
  return {
    signed: !notSigned && (authorities.length > 0 || adhoc),
    adhoc,
    identifier: field('Identifier'),
    teamId: team && team !== 'not set' ? team : null,
    authorities,
    developerId: authorities.some((a) => a.startsWith('Developer ID Application:')),
    hardenedRuntime: !!(flags && /\bruntime\b/.test(flags[1])),
    stapled: /^Notarization Ticket=stapled$/m.test(text),
  };
}

/** `spctl --assess --type execute -vv`'s verdict: accepted, and on what grounds (source=…). */
export function parseSpctl(text: string): { accepted: boolean; source: string | null; origin: string | null } {
  const field = (name: string) => { const m = new RegExp(`^${name}=(.*)$`, 'm').exec(text); return m ? m[1].trim() : null; };
  return { accepted: /: accepted$/m.test(text), source: field('source'), origin: field('origin') };
}

/** The processes in `ps -axww -o pid=,command=` output whose command line contains any of `needles`. */
export function processesMatching(psOutput: string, needles: string[]): { pid: number; command: string }[] {
  const found: { pid: number; command: string }[] = [];
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && needles.some((n) => n && m[2].includes(n))) found.push({ pid: Number(m[1]), command: m[2] });
  }
  return found;
}

// ── The environment the rehearsal's processes get ────────────────────────────

/**
 * The caller's environment without what must not reach the app under test or
 * its CLI: every RADIAL_ variable (a Radial terminal's RADIAL_CLI_SOCK would
 * point the CLI at the person's own Radial), the run-as-Node switch, agent
 * session markers, and credentials (signing and notarizing keys, tokens,
 * passwords), which an app and its agents never need.
 */
export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k.startsWith('RADIAL_') || k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
    if (/^(APPLE_|CSC_|AWS_)/.test(k) || /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIALS?)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// ── The release gate's packaged tests ────────────────────────────────────────

/** The end-to-end tests scripts/release.mts runs against the packaged app, read from its source, in its order. */
export function gateTestFiles(releaseSource: string): string[] {
  return [...new Set([...releaseSource.matchAll(/'(test\/[^'\s]+\.e2e\.mts)'/g)].map((m) => m[1]))];
}

// ── Rehearsal builds ─────────────────────────────────────────────────────────

/** A build folder (one with latest-mac.yml) and the version it holds. */
export interface BuildDir { dir: string; version: string }

/** The build folders directly under `root`, oldest version first. */
export function rehearsalBuilds(root: string): BuildDir[] {
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const builds: BuildDir[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    try { builds.push({ dir, version: readFeed(dir).version }); } catch { /* not a build folder */ }
  }
  return builds.sort((a, b) => compareVersions(a.version, b.version));
}

/** The rehearsal's pair: the oldest build updates to the newest. Throws unless there are two different versions. */
export function pickPair(builds: BuildDir[]): { from: BuildDir; to: BuildDir } {
  if (builds.length < 2) throw new Error(`the rehearsal needs two builds, found ${builds.length}: run \`build --version <a>,<b>\` first`);
  const from = builds[0], to = builds[builds.length - 1];
  if (compareVersions(from.version, to.version) >= 0) throw new Error(`the builds are all version ${from.version}: build a higher one to update to`);
  return { from, to };
}

// ── The app's own update config ──────────────────────────────────────────────

/** The packaged app's app-update.yml (Contents/Resources): where it looks for updates and where it keeps them. */
export interface AppUpdateConfig { provider: string | null; url: string | null; owner: string | null; repo: string | null; channel: string | null; updaterCacheDirName: string | null }

export function readAppUpdateConfig(text: string): AppUpdateConfig {
  const doc = (yaml.load(text) || {}) as Record<string, unknown>;
  const str = (k: string) => (typeof doc[k] === 'string' && doc[k] ? doc[k] as string : null);
  return { provider: str('provider'), url: str('url'), owner: str('owner'), repo: str('repo'), channel: str('channel'), updaterCacheDirName: str('updaterCacheDirName') };
}

/** The port of a rehearsal feed URL. Throws unless it is plain http on this Mac's loopback address. */
export function feedPort(url: string): number {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`not a URL: ${url}`); }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error(`the feed ${url} isn't on this Mac (http://127.0.0.1:<port>/)`);
  return Number(u.port || 80);
}
