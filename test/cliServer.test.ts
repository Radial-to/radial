// The control server on a real unix socket with a fake api: framing, the open
// bus, ambiguity, refusals, progress ordering, socket hygiene. Every server is
// stopped in a finally so a failing assertion can never hang the suite.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn } from 'child_process';

import * as cliServer from '../src/main/cliServer';
import * as proto from '../src/main/cliProto';
import type { CliApi, ControlServer, HelloInfo, ListedField, OpName, OpReplies, OpRequest, PublishRequest, TextEditRequest } from '../src/main/cliServer';
import type { ErrorReply, ProgressFrame, RequestId } from '../src/main/cliProto';
import { tmpDir } from './support/tmp';
import { fakeSessions, trustAsk } from './fixtures/fakeSessions';

/**
 * A fake's answer: the real answer's fields, any of them left out. Strings keep
 * their literal types, so a fake answering a reason, code or state the app
 * doesn't have fails to compile.
 */
type Sketch<T> = T extends readonly (infer E)[] ? Sketch<E>[] : T extends object ? { [K in keyof T]?: Sketch<T[K]> } : T;
/** Fake api methods as the contract has them: the real parameters, and a sketch of the real answer. */
type Faked = { [K in keyof CliApi]?: (...args: Parameters<CliApi[K]>) => ReturnType<CliApi[K]> extends Promise<infer V> ? Promise<Sketch<V>> : Sketch<ReturnType<CliApi[K]>> };
/**
 * Fake api methods: Faked, except the two answers that are stand-ins outside the
 * contract: hello's 'test' flavor, and a publish that answers like a merged pull request.
 */
type FakeMethods = Omit<Faked, 'info' | 'publish'> & {
  info?: () => Sketch<Omit<HelloInfo, 'flavor'>> & { flavor?: string };
  publish?: (...args: Parameters<CliApi['publish']>) => Promise<Sketch<Awaited<ReturnType<CliApi['publish']>>> | { ok: true; mode: 'merge'; steps: string[] }>;
};
/** The fake app the server talks to, and the calls it saw. */
type FakeApi = CliApi & { calls: string[] };
/** What a fake api method was given after the project or session it works on. */
type ArgsOf<K extends keyof CliApi> = Parameters<CliApi[K]>[1];
/** Every field of a union's members, each optional and typed as the members that have it say. */
type Fields<U> = { [K in U extends unknown ? keyof U : never]?: U extends unknown ? (K extends keyof U ? U[K] : never) : never };
/** One op's reply as the tests read it: success or error, a field is there when that reply carries it. */
type ReplyOf<K extends OpName> = { op: 'reply'; reqId?: RequestId; ok: boolean } & Fields<OpReplies[K] | ErrorReply>;
/**
 * A reply as the tests read it when they don't name the op: whichever op
 * answered, success or error. File contents (moduleResult) never are.
 */
type TestReply = ReplyOf<OpName> & {
  prevContent?: never;
  newContent?: never;
  /** close's needs-yes refusal: how many agents are live (its err() detail, which ErrorReply leaves out). */
  terminals?: number;
};
/** A frame from the server (the app's own, so the client takes its shape on trust). */
type TestFrame = ProgressFrame | TestReply;
/** A connected client: every frame so far, and a request's reply once it lands. */
interface TestClient {
  frames: TestFrame[];
  send(m: OpRequest): boolean;
  /**
   * The reply to a request: read as any op's (TestReply), or as one op's when the
   * call names it (the client takes the caller's word for which op answers reqId).
   */
  reply<K extends OpName = OpName>(reqId: RequestId): Promise<OpName extends K ? TestReply : ReplyOf<K>>;
  end(): void;
}
/** What a test body gets: the socket, the fake app, the running server and a connected client. */
interface ServerUnderTest { sock: string; api: FakeApi; srv: ControlServer; c: TestClient }

function sockPath() { return path.join(tmpDir('rcli-'), 'cli.sock'); }
function fakeApi(over: FakeMethods = {}): FakeApi {
  const calls: string[] = [];
  return {
    calls,
    info: () => ({ version: '9.9.9', flavor: 'test', pid: 1, windowReady: true }),
    isOpen: (dir) => dir === '/open/site',
    focus: () => { calls.push('focus'); return {}; },
    telemetry: (c) => calls.push('telemetry:' + c),
    requestOpen: (dir) => calls.push('requestOpen:' + dir),
    resolve: async (target) => {
      if (target === 'amb') return { ok: false, code: 'ambiguous', error: 'amb', candidates: [{ path: '/a', name: 'a' }, { path: '/b', name: 'b' }] };
      if (target === 'acme/site') return { ok: true, kind: 'clone', url: 'https://github.com/acme/site' };
      if (!target || target === '.') return { ok: true, kind: 'path', dir: '/cwd' };
      return { ok: true, kind: 'path', dir: target };
    },
    clone: async (url, progress) => { progress('cloning ' + url); return { ok: true, dir: '/cloned/site', github: { action: 'cloned' } }; },
    projects: async ({ all }) => ({ projects: [{ repoDir: '/open/site', name: 'site', url: 'http://x', state: 'running', active: true, terminals: 1 }], ...(all ? { recents: [] } : {}) }),
    previewUrl: (dir) => (dir === '/open/site' ? 'http://localhost:1/' : null),
    status: async (dir) => ({ name: path.basename(dir), open: dir === '/open/site' }),
    context: async (dir) => ({ name: path.basename(dir), rules: '', docs: [], references: [], pages: [], url: null, openComments: 0 }),
    pages: async () => [{ route: '/', label: 'Home' }],
    comments: async (_d, { open }) => (open ? [{ text: 'fix', resolved: false }] : [{ text: 'fix', resolved: false }, { text: 'done', resolved: true }]),
    shot: async (_dir, _route, width) => ({ ok: true, path: width ? `/tmp/shot-${width}.png` : '/tmp/shot.png', scale: 2 }),
    create: async ({ name }, progress) => { progress('scaffolding'); return { ok: true, dir: '/new/' + name }; },
    sleep: async () => ({ state: 'asleep' }),
    wake: async () => ({ state: 'running', url: 'http://x' }),
    close: async () => ({ state: 'closed' }),
    liveTerminals: async (dir) => (dir === '/open/site' ? 2 : 0),
    ...over,
  } satisfies FakeMethods & { calls: string[] } as FakeApi; // a fake: the methods a test drives, answering only the fields it reads; another method's op fails its test
}
function client(sock: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock);
    s.setEncoding('utf8');
    const frames: TestFrame[] = [];
    const waiters: (() => void)[] = [];
    s.on('data', proto.makeDecoder((m) => { frames.push(m as TestFrame); waiters.splice(0).forEach((w) => w()); }));
    s.once('connect', () => resolve({
      frames,
      send: (m) => s.write(proto.encode(m)),
      reply: <K extends OpName = OpName>(reqId: RequestId) => new Promise<OpName extends K ? TestReply : ReplyOf<K>>((res) => { const check = () => { const r = frames.find((f): f is TestReply => f.op === 'reply' && f.reqId === reqId); if (r) res(r as OpName extends K ? TestReply : ReplyOf<K>); else waiters.push(check); }; check(); }),
      end: () => s.end(),
    }));
    s.once('error', reject);
  });
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// Start a server and run the body; the server always stops, the client always ends.
async function withServer(over: FakeMethods, body: (s: ServerUnderTest) => Promise<void>): Promise<string> {
  const sock = sockPath();
  const api = fakeApi(over);
  const srv = cliServer.start({ socketPath: sock, api });
  await tick(50);
  let c: TestClient | null = null;
  try { c = await client(sock); await body({ sock, api, srv, c }); }
  finally { try { if (c) c.end(); } catch {} srv.stop(); }
  return sock;
}

test('hello, focus, unknown op; the socket is user-only; a stale file is replaced; stop removes it', async () => {
  const sock = sockPath();
  fs.writeFileSync(sock, 'stale'); // a crashed app's leftover
  const api = fakeApi();
  const srv = cliServer.start({ socketPath: sock, api });
  let c: TestClient | null = null;
  try {
    await tick(50);
    assert.equal(fs.statSync(sock).mode & 0o777, 0o700);
    c = await client(sock);
    c.send({ op: 'hello', reqId: '1' });
    const h = await c.reply('1');
    assert.equal(h.ok, true); assert.equal(h.version, '9.9.9'); assert.equal(h.protocol, proto.PROTOCOL);
    c.send({ op: 'focus', reqId: '2' }); assert.equal((await c.reply('2')).ok, true); assert.ok(api.calls.includes('focus'));
    c.send({ op: 'nope', reqId: '3' }); const bad = await c.reply('3'); assert.equal(bad.code, 'bad-request');
    assert.ok(api.calls.includes('telemetry:hello') && api.calls.includes('telemetry:focus'), 'known verbs are counted');
    assert.ok(!api.calls.includes('telemetry:nope'), 'unknown ops are not');
  } finally { if (c) c.end(); srv.stop(); }
  assert.equal(fs.existsSync(sock), false, 'stop removes the socket');
});

test('an op through radial serve’s HTTP listener is counted as one, never with the caller’s token or host', async () => {
  const counted: unknown[][] = [];
  const api = fakeApi({ telemetry: (...args: unknown[]) => { counted.push(args); } } as FakeMethods);
  const srv = cliServer.start({ socketPath: sockPath(), api });
  try {
    await srv.dispatch({ op: 'focus', cwd: '/' } as OpRequest, { http: { tokenId: 'tok_1', host: '192.168.1.20' } });
    await srv.dispatch({ op: 'focus', cwd: '/' } as OpRequest);
    assert.deepEqual(counted, [['focus', { http: true }], ['focus']], 'over HTTP it says so, and nothing about who or where');
  } finally { srv.stop(); }
});

test('a second server on a live socket leaves it to the first, which keeps answering after the second stops', async () => {
  const sock = sockPath();
  const first = cliServer.start({ socketPath: sock, api: fakeApi() });
  let second: ControlServer | null = null;
  let c: TestClient | null = null;
  try {
    await tick(50);
    second = cliServer.start({ socketPath: sock, api: fakeApi({ info: () => ({ version: '2.0.0', flavor: 'test', pid: 2, windowReady: true }) }) });
    await tick(50);
    c = await client(sock);
    c.send({ op: 'hello', reqId: '1' });
    assert.equal((await c.reply('1')).version, '9.9.9', 'the first server still answers on its socket');
    const claim = await second.ready;
    assert.equal(claim.ok ? 'ok' : claim.code, 'in-use', 'the second server says the socket is taken');
    second.stop(); second = null;
    await tick(20);
    assert.ok(fs.existsSync(sock), 'the second server stopping leaves the first one’s socket');
    c.end(); c = await client(sock);
    c.send({ op: 'hello', reqId: '2' });
    assert.equal((await c.reply('2')).version, '9.9.9');
    assert.deepEqual(await first.ready, { ok: true });
  } finally { if (c) c.end(); second?.stop(); first.stop(); }
  assert.equal(fs.existsSync(sock), false, 'the first server’s stop removes its socket');
});

test('a socket left by an app that died is taken over', async () => {
  const sock = sockPath();
  // An app killed while listening: its socket file stays, and nothing answers on it.
  const dead = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(sock)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => { dead.stdout.once('data', resolve); dead.once('exit', () => reject(new Error('the stand-in app exited before it listened'))); });
  dead.kill('SIGKILL');
  await new Promise((resolve) => dead.once('exit', resolve));
  assert.ok(fs.existsSync(sock), 'the dead app’s socket file is still there');
  const srv = cliServer.start({ socketPath: sock, api: fakeApi() });
  let c: TestClient | null = null;
  try {
    await tick(50);
    c = await client(sock);
    c.send({ op: 'hello', reqId: '1' });
    assert.equal((await c.reply('1')).version, '9.9.9');
    assert.deepEqual(await srv.ready, { ok: true });
    assert.equal(fs.statSync(sock).mode & 0o777, 0o700);
  } finally { if (c) c.end(); srv.stop(); }
});

test('open asks the app to open the folder and returns openRepo’s result from the bus; concurrent opens share one request', async () => {
  await withServer({}, async ({ api, srv, c }) => {
    c.send({ op: 'open', reqId: 'a', target: '/x/site' });
    c.send({ op: 'open', reqId: 'b', target: '/x/site' });
    await tick();
    assert.equal(api.calls.filter((x) => x === 'requestOpen:/x/site').length, 1, 'one request for two waiters');
    srv.settleOpen('/x/site', { ok: true, url: 'http://localhost:5/', project: { name: 'site' }, repoDir: '/x/site' });
    const a = await c.reply('a'), b = await c.reply('b');
    assert.equal(a.state, 'opened'); assert.equal(a.url, 'http://localhost:5/'); assert.equal(a.name, 'site'); assert.equal(b.state, 'opened');
    // Already open → focused; node missing → its code.
    c.send({ op: 'open', reqId: 'c', target: '/x/site' }); await tick(10); srv.settleOpen('/x/site', { ok: true, already: true, url: 'http://l/', project: { name: 'site' }, repoDir: '/x/site' });
    assert.equal((await c.reply('c')).state, 'focused');
    c.send({ op: 'open', reqId: 'e', target: '/x/site' }); await tick(10); srv.settleOpen('/x/site', { ok: false, reason: 'node-missing', error: 'no node' });
    assert.equal((await c.reply('e')).code, 'node-missing');
    // --no-wait acks the queue and returns at once; a timeout is a protocol error, not a hang.
    c.send({ op: 'open', reqId: 'f', target: '/y', wait: false }); const f = await c.reply('f'); assert.equal(f.state, 'queued'); assert.equal(f.repoDir, '/y');
    c.send({ op: 'open', reqId: 'g', target: '/z', timeoutMs: 40 }); const g = await c.reply('g'); assert.equal(g.code, 'timeout');
  });
});

test('a GitHub target clones first with progress frames before the reply; read verbs refuse to clone', async () => {
  await withServer({}, async ({ srv, c }) => {
    c.send({ op: 'open', reqId: '1', target: 'acme/site' });
    await tick();
    srv.settleOpen('/cloned/site', { ok: true, url: 'http://l/', project: { name: 'site' }, repoDir: '/cloned/site' });
    const r = await c.reply('1');
    assert.equal(r.state, 'opened'); assert.deepEqual(r.github, { action: 'cloned' });
    const progressIdx = c.frames.findIndex((f) => f.op === 'progress' && f.reqId === '1');
    const replyIdx = c.frames.findIndex((f) => f.op === 'reply' && f.reqId === '1');
    assert.ok(progressIdx !== -1 && progressIdx < replyIdx, 'progress precedes the reply');
    c.send({ op: 'status', reqId: '2', target: 'acme/site' }); const s = await c.reply('2');
    assert.equal(s.code, 'not-found'); assert.match(s.error!, /radial open/);
  });
});

test('ambiguity passes candidates through; url/pages/close refuse with the right codes; close needs --yes with live agents', async () => {
  await withServer({}, async ({ c }) => {
    c.send({ op: 'open', reqId: '1', target: 'amb' }); const a = await c.reply('1');
    assert.equal(a.code, 'ambiguous'); assert.equal(a.candidates!.length, 2);
    c.send({ op: 'url', reqId: '2', target: '/open/site' }); assert.equal((await c.reply('2')).url, 'http://localhost:1/');
    c.send({ op: 'url', reqId: '3', target: '/closed/site' }); assert.equal((await c.reply('3')).code, 'no-dev-server');
    c.send({ op: 'pages', reqId: '4', target: '/closed/site' }); assert.equal((await c.reply('4')).code, 'not-open');
    c.send({ op: 'pages', reqId: '5', target: '/open/site' }); assert.deepEqual((await c.reply('5')).pages, [{ route: '/', label: 'Home' }]);
    c.send({ op: 'comments', reqId: '6', target: '/open/site', open: true }); assert.equal((await c.reply('6')).comments!.length, 1);
    c.send({ op: 'close', reqId: '7', target: '/open/site' }); const cl = await c.reply('7'); assert.equal(cl.code, 'needs-yes'); assert.equal(cl.terminals, 2);
    c.send({ op: 'close', reqId: '8', target: '/open/site', yes: true }); assert.equal((await c.reply('8')).state, 'closed');
    c.send({ op: 'close', reqId: '9', target: '/closed/site' }); assert.equal((await c.reply('9')).code, 'not-open');
    c.send({ op: 'shot', reqId: '10', target: '/open/site' }); assert.equal((await c.reply('10')).path, '/tmp/shot.png');
    c.send({ op: 'shot', reqId: '10w', target: '/open/site', width: 390 }); assert.equal((await c.reply('10w')).path, '/tmp/shot-390.png', 'the width goes to the page');
    for (const width of [100, 5000, 390.5]) { c.send({ op: 'shot', reqId: 'bad' + width, target: '/open/site', width }); const bad = await c.reply('bad' + width); assert.equal(bad.code, 'bad-request'); assert.match(bad.error!, /--width takes the page's width in CSS pixels, from 240 to 3840/); }
    c.send({ op: 'new', reqId: '11', name: 'blog', template: 'vue' }); assert.equal((await c.reply('11')).code, 'bad-request');
    c.send({ op: 'new', reqId: '12', name: 'blog', template: 'astro', wait: false }); const n = await c.reply('12'); assert.equal(n.created, '/new/blog'); assert.equal(n.state, 'queued');
    c.send({ op: 'ls', reqId: '13', all: true }); const ls = await c.reply('13'); assert.equal(ls.projects!.length, 1); assert.deepEqual(ls.recents, []);
  });
});

test('an op named after an Object.prototype member is an unknown command, answered and not counted', async () => {
  await withServer({}, async ({ api, c }) => {
    for (const op of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      c.send({ op, reqId: op });
      // A reply that never comes fails here instead of hanging the suite.
      const r = await Promise.race([c.reply(op), tick(2000).then(() => null)]);
      assert.ok(r, `${op}: no reply frame`);
      assert.equal(r.code, 'bad-request', op);
      assert.equal(r.error, `Unknown command: ${op}`);
      assert.ok(!api.calls.includes('telemetry:' + op), `${op} is not counted`);
    }
  });
});

test('an api that throws becomes an error reply, never a dropped request', async () => {
  await withServer({ projects: async () => { throw new Error('boom'); } }, async ({ c }) => {
    c.send({ op: 'ls', reqId: '1' }); const r = await c.reply('1');
    assert.equal(r.ok, false); assert.equal(r.code, 'error'); assert.equal(r.error, 'boom');
  });
});

test('write lane: module results map to the wire; production publish, restore need --yes; a failed gate carries the fix prompt', async () => {
  const calls: (['editText', string, TextEditRequest] | ['publish', string, PublishRequest])[] = [];
  await withServer({
    editText: async (dir, a) => { calls.push(['editText', dir, a]); return a.find === 'twin' ? { ok: false, reason: 'ambiguous', candidates: [{ relFile: 'a.html', line: 3 }, { relFile: 'b.html', line: 9 }] } : a.find === 'gone' ? { ok: false, reason: 'not-found' } : a.find === 'done' ? { ok: false, reason: 'already-applied', relFile: 'index.html', line: 4 } : { ok: true, relFile: 'index.html', line: 12, prevContent: 'x', newContent: 'y' }; },
    editImage: async () => ({ ok: true, relFile: 'index.html', line: 5, newSrc: '/img/hero-radial.png', copiedTo: 'public/img/hero-radial.png' }),
    fileExists: (f) => f === '/tmp/new.png',
    metaSet: async () => ({ ok: true, relFile: 'index.html', line: 3 }),
    commentAdd: async (dir, a) => ({ ok: true, comment: { id: 'c1', route: a.route, selector: a.selector, text: a.text } }),
    commentResolve: async (dir, id) => (id === 'c1' ? { ok: true, comment: { id, resolved: true } } : { ok: false, reason: 'not-found' }),
    commentsPull: async (dir) => (dir === '/open/site' ? { ok: true, total: 2, added: 1, updated: 0, resolved: 1, changed: true } : { ok: false, code: 'not-linked', error: 'This folder is not linked to a Vercel project (vercel link).' }),
    sync: async () => ({ ok: true, upToDate: true, branch: 'main' }),
    publish: async (dir, a, progress) => { calls.push(['publish', dir, a]); progress('Checking the build…'); return a.to === 'production' || a.to === 'branch' ? { ok: true, mode: 'merge', steps: ['pushed'] } : { ok: false, reason: 'build-failed', message: 'The production build failed', fixPrompt: 'fix it', deploy: { gate: 'failed' } }; },
    // The checkout is on main, the production branch: `branch` lands there; staging doesn't.
    publishDestination: async (dir, to) => (to === 'staging' ? { branch: 'staging', production: false } : { branch: 'main', production: true }),
    momentsList: async () => ({ ok: true, moments: [{ id: 'm1', ts: 1, kind: 'edit', label: 'x' }] }),
    momentRecord: async (dir, label) => ({ ok: true, moment: { id: 'm2', label } }),
    momentRestore: async (dir, id) => (id === 'm1' ? { ok: true, moment: { id: 'm3', label: 'Restored: x' } } : { ok: false, reason: 'not-found' }),
  }, async ({ c }) => {
    c.send({ op: 'editText', reqId: 'e1', target: '/open/site', find: 'Hello', to: 'Hi', route: '/' });
    const e1 = await c.reply('e1'); assert.equal(e1.ok, true); assert.equal(e1.relFile, 'index.html'); assert.equal(e1.prevContent, undefined, 'file contents never cross the wire');
    assert.deepEqual(calls.find((x) => x[0] === 'editText')![2], { find: 'Hello', to: 'Hi', route: '/', file: null, path: null });
    c.send({ op: 'editText', reqId: 'e2', target: '/open/site', find: 'done', to: 'Hi' }); const e2 = await c.reply('e2'); assert.equal(e2.ok, true); assert.equal(e2.already, true);
    c.send({ op: 'editText', reqId: 'e3', target: '/open/site', find: 'twin', to: 'Hi' }); const e3 = await c.reply<'editText'>('e3'); assert.equal(e3.code, 'ambiguous'); assert.equal(e3.pick, false); assert.equal(e3.candidates![1].name, 'b.html:9');
    c.send({ op: 'editText', reqId: 'e4', target: '/open/site', find: 'gone', to: 'Hi' }); assert.equal((await c.reply('e4')).code, 'not-found');
    c.send({ op: 'editText', reqId: 'e5', target: '/open/site' }); assert.equal((await c.reply('e5')).code, 'bad-request');
    c.send({ op: 'editImage', reqId: 'i1', target: '/open/site', src: '/img/hero.png', file: 'new.png', cwd: '/tmp' }); const i1 = await c.reply('i1'); assert.equal(i1.ok, true); assert.equal(i1.newSrc, '/img/hero-radial.png');
    c.send({ op: 'editImage', reqId: 'i2', target: '/open/site', src: '/img/hero.png', file: '/nope.png' }); assert.equal((await c.reply('i2')).code, 'not-found');
    c.send({ op: 'metaSet', reqId: 'm1', target: '/open/site', tag: 'og:title', value: 'New' }); assert.equal((await c.reply('m1')).ok, true);
    c.send({ op: 'metaSet', reqId: 'm2', target: '/open/site', tag: 'og:bogus', value: 'New' }); assert.match((await c.reply('m2')).error!, /Unknown tag/);
    c.send({ op: 'commentAdd', reqId: 'c1', target: '/open/site', text: 'Tighten this', route: '/pricing', selector: 'h1' }); const c1 = await c.reply('c1'); assert.equal(c1.comment!.id, 'c1'); assert.equal(c1.comment!.route, '/pricing');
    c.send({ op: 'commentResolve', reqId: 'c2', target: '/open/site', id: 'c1' }); assert.equal((await c.reply('c2')).comment!.resolved, true);
    c.send({ op: 'commentResolve', reqId: 'c3', target: '/open/site', id: 'zz' }); assert.equal((await c.reply('c3')).code, 'not-found');
    c.send({ op: 'commentsPull', reqId: 'c4', target: '/open/site' }); const c4 = await c.reply('c4'); assert.equal(c4.ok, true); assert.equal(c4.added, 1); assert.equal(c4.resolved, 1);
    c.send({ op: 'sync', reqId: 's1', target: '/open/site' }); assert.equal((await c.reply('s1')).upToDate, true);
    c.send({ op: 'publish', reqId: 'p1', target: '/open/site', to: 'production' }); assert.equal((await c.reply('p1')).code, 'needs-yes');
    c.send({ op: 'publish', reqId: 'p2', target: '/open/site', to: 'production', yes: true }); const p2 = await c.reply('p2'); assert.equal(p2.ok, true); assert.equal(p2.target, 'production');
    assert.deepEqual(calls.find((x) => x[0] === 'publish')![2], { to: 'production', message: null, gate: true, scope: 'all', pr: false, commit: true });
    c.send({ op: 'publish', reqId: 'p3', target: '/open/site', gate: false }); const p3 = await c.reply('p3'); assert.equal(p3.ok, false); assert.equal(p3.code, 'error'); assert.equal(p3.reason, 'build-failed'); assert.equal(p3.fixPrompt, 'fix it');
    assert.ok(c.frames.some((f) => f.op === 'progress' && f.reqId === 'p3' && /Checking/.test(f.text)), 'publish streams progress');
    c.send({ op: 'publish', reqId: 'p4', target: '/open/site', to: 'mars' }); assert.equal((await c.reply('p4')).code, 'bad-request');
    // Publishing the current branch while it is the production branch goes live: it needs --yes too, and nothing runs without it.
    const before = calls.filter((x) => x[0] === 'publish').length;
    c.send({ op: 'publish', reqId: 'p5', target: '/open/site', to: 'branch' }); const p5 = await c.reply('p5'); assert.equal(p5.code, 'needs-yes'); assert.match(p5.error!, /main is this project's production branch/);
    assert.equal(calls.filter((x) => x[0] === 'publish').length, before, 'refused before anything ran');
    c.send({ op: 'publish', reqId: 'p6', target: '/open/site', to: 'branch', yes: true }); const p6 = await c.reply('p6'); assert.equal(p6.ok, true); assert.equal(p6.target, 'branch');
    c.send({ op: 'moments', reqId: 'mo1', target: '/open/site' }); assert.equal((await c.reply('mo1')).moments![0].id, 'm1');
    c.send({ op: 'momentRecord', reqId: 'mo2', target: '/open/site', label: 'before' }); assert.equal((await c.reply('mo2')).moment!.label, 'before');
    c.send({ op: 'momentRestore', reqId: 'mo3', target: '/open/site', id: 'm1' }); assert.equal((await c.reply('mo3')).code, 'needs-yes');
    c.send({ op: 'momentRestore', reqId: 'mo4', target: '/open/site', id: 'm1', yes: true }); assert.equal((await c.reply('mo4')).moment!.id, 'm3');
    c.send({ op: 'momentRestore', reqId: 'mo5', target: '/open/site', id: 'zz', yes: true }); assert.equal((await c.reply('mo5')).code, 'not-found');
  });
});

test('agent lane: start opens a closed project through the bus first, then asks the window; output, wait, list; kill needs --yes', async () => {
  type WaitCall = ['agentWait', string, ArgsOf<'agentWait'>];
  const calls: (['agentStart', string, ArgsOf<'agentStart'>] | WaitCall)[] = [];
  await withServer({
    agentStart: async (dir, o) => { calls.push(['agentStart', dir, o]); return { ok: true, id: 'pty9', label: 'Fix hero', engine: 'claude', submitted: o.submit, landed: true, startedAt: 5 }; },
    agentOutput: async (id) => (id === 'pty9' ? { ok: true, id, alive: true, text: 'line1\nline2', lastBellAt: 0 } : { ok: false, code: 'not-found', error: 'no' }),
    agentWait: async (id, o) => { calls.push(['agentWait', id, o]); return { ok: true, id, reason: 'bell', alive: true, text: 'done ✓' }; },
    agentList: async (dir) => [{ id: 'pty9', repoDir: '/open/site', name: 'site', engine: 'claude' as const, label: 'Fix hero', alive: true }].filter((a) => !dir || a.repoDir === dir),
    agentKill: async (id) => (id === 'pty9' ? { ok: true, id } : { ok: false, code: 'not-found', error: 'no' }),
    agentKeep: async (id, o) => (id === 'pty9' ? { ok: true, id, on: o.on } : { ok: false, code: 'not-found', error: 'no' }),
  }, async ({ c, srv, api }) => {
    c.send({ op: 'agentStart', reqId: 'a0', target: '/open/site' }); assert.equal((await c.reply('a0')).code, 'bad-request');
    c.send({ op: 'agentStart', reqId: 'a1', target: '/open/site', task: 'Fix the hero', submit: true });
    const a1 = await c.reply('a1'); assert.equal(a1.ok, true); assert.equal(a1.id, 'pty9'); assert.equal(a1.submitted, true); assert.equal(a1.repoDir, '/open/site');
    assert.ok(!api.calls.some((x) => x.startsWith('requestOpen')), 'an open project is not reopened');
    const pending = c.reply('a2'); c.send({ op: 'agentStart', reqId: 'a2', target: '/closed/site', task: 'Hi' });
    await tick(); assert.ok(api.calls.includes('requestOpen:/closed/site'), 'a closed project is opened first');
    srv.settleOpen('/closed/site', { ok: true, repoDir: '/closed/site', url: 'http://x' });
    const a2 = await pending; assert.equal(a2.ok, true); assert.equal(a2.submitted, false, 'the CLI stages unless --submit');
    c.send({ op: 'agentStart', reqId: 'a3', target: '/open/site', task: 'x', engine: 'gpt' }); assert.equal((await c.reply('a3')).code, 'bad-request');
    c.send({ op: 'agentOutput', reqId: 'o1', id: 'pty9' }); assert.equal((await c.reply('o1')).text, 'line1\nline2');
    c.send({ op: 'agentOutput', reqId: 'o2', id: 'nope' }); assert.equal((await c.reply('o2')).code, 'not-found');
    c.send({ op: 'agentOutput', reqId: 'o3' }); assert.equal((await c.reply('o3')).code, 'bad-request');
    c.send({ op: 'agentWait', reqId: 'w1', id: 'pty9', waitMs: 999999999 }); const w1 = await c.reply('w1'); assert.equal(w1.reason, 'bell');
    assert.equal(calls.find((x): x is WaitCall => x[0] === 'agentWait')![2].waitMs, cliServer.AGENT_WAIT_MAX_MS, 'the wait is clamped');
    c.send({ op: 'agentList', reqId: 'l1' }); assert.equal((await c.reply('l1')).agents!.length, 1);
    c.send({ op: 'agentList', reqId: 'l2', target: '/other' }); assert.equal((await c.reply('l2')).agents!.length, 0);
    c.send({ op: 'agentKeep', reqId: 'ka0' }); assert.equal((await c.reply('ka0')).code, 'bad-request');
    c.send({ op: 'agentKeep', reqId: 'ka1', id: 'pty9' }); const ka1 = await c.reply('ka1'); assert.equal(ka1.ok, true); assert.equal(ka1.on, true, 'keep is the default');
    c.send({ op: 'agentKeep', reqId: 'ka2', id: 'pty9', off: true }); assert.equal((await c.reply('ka2')).on, false, '--off releases');
    c.send({ op: 'agentKeep', reqId: 'ka3', id: 'zz' }); assert.equal((await c.reply('ka3')).code, 'not-found');
    c.send({ op: 'agentKill', reqId: 'k1', id: 'pty9' }); assert.equal((await c.reply('k1')).code, 'needs-yes');
    c.send({ op: 'agentKill', reqId: 'k2', id: 'pty9', yes: true }); assert.equal((await c.reply('k2')).ok, true);
    assert.ok(api.calls.includes('telemetry:agentStart') && api.calls.includes('telemetry:agentKill'), 'each op is counted by name only');
  });
});

test('reload and restart resolve the project and pass the api result through', async () => {
  await withServer({
    reload: async (dir) => (dir === '/open/site' ? {} : { ok: false, code: 'not-open', error: 'no' }),
    restart: async (dir) => (dir === '/open/site' ? { url: 'http://localhost:5555/' } : { ok: false, code: 'not-open', error: 'no' }),
  }, async ({ c }) => {
    c.send({ op: 'reload', reqId: 'r1', target: '/open/site' }); const r1 = await c.reply('r1'); assert.equal(r1.ok, true); assert.equal(r1.repoDir, '/open/site');
    c.send({ op: 'restart', reqId: 'r2', target: '/open/site' }); const r2 = await c.reply('r2'); assert.equal(r2.ok, true); assert.equal(r2.url, 'http://localhost:5555/');
    c.send({ op: 'restart', reqId: 'r3', target: '/closed/site' }); assert.equal((await c.reply('r3')).code, 'not-open', 'a closed project is not started by a restart request');
  });
});

test('fields lists the page with ids and caches it; edit text --field and edit image --field resolve through the cache', async () => {
  type ImageCall = ['editImage', ArgsOf<'editImage'>];
  const calls: (['editText', TextEditRequest] | ImageCall)[] = [];
  await withServer({
    fields: async (dir, route) => ({ ok: true, route: route || '/', fields: [
      { kind: 'text', selector: 'h1', tag: 'h1', role: 'Heading', text: 'Welcome home', path: [{ tag: 'h1', nth: 0, cnt: 1 }], thumb: null },
      { kind: 'image', selector: 'img', tag: 'img', role: 'Image', src: '/img/hero.png', thumb: 'data:...' },
      { kind: 'text', selector: 'p', tag: 'p', role: 'Body', text: 'x'.repeat(400), truncated: true },
    ] }),
    editText: async (dir, a) => { calls.push(['editText', a]); return { ok: true, relFile: 'index.html', line: 3 }; },
    editImage: async (dir, a) => { calls.push(['editImage', a]); return { ok: true, relFile: 'index.html', line: 5, newSrc: '/img/hero-radial.png', copiedTo: 'public/img/hero-radial.png' }; },
    fileExists: () => true,
  }, async ({ c, api }) => {
    c.send({ op: 'editText', reqId: 'e0', target: '/open/site', field: 'f1', to: 'Hi' }); assert.match((await c.reply('e0')).error!, /Run `radial fields/);
    c.send({ op: 'fields', reqId: 'f1', target: '/open/site', route: '/pricing' }); const f1 = await c.reply('f1');
    assert.equal(f1.ok, true); assert.equal(f1.route, '/pricing'); assert.deepEqual(f1.fields!.map((f) => f.id), ['f1', 'f2', 'f3']); assert.equal((f1.fields![1] as ListedField & { thumb?: unknown }).thumb, undefined, 'thumbnails stay in the app'); // probes for the window's field that the reply drops
    c.send({ op: 'fields', reqId: 'f2', target: '/closed/site' }); assert.equal((await c.reply('f2')).code, 'not-open');
    c.send({ op: 'editText', reqId: 'e1', target: '/open/site', field: 'f1', to: 'Welcome back' }); const e1 = await c.reply('e1');
    assert.equal(e1.ok, true);
    assert.deepEqual(calls.find((x) => x[0] === 'editText')![1], { find: 'Welcome home', to: 'Welcome back', route: '/pricing', file: null, path: [{ tag: 'h1', nth: 0, cnt: 1 }] }, 'the field supplies the text, the route and the structural pin');
    c.send({ op: 'editText', reqId: 'e2', target: '/open/site', field: 'f2', to: 'x' }); assert.match((await c.reply('e2')).error!, /is an image, not text/);
    c.send({ op: 'editText', reqId: 'e3', target: '/open/site', field: 'f3', to: 'x' }); assert.match((await c.reply('e3')).error!, /pass --find with the full current text/);
    c.send({ op: 'editText', reqId: 'e4', target: '/open/site', field: 'f9', to: 'x' }); assert.equal((await c.reply('e4')).code, 'not-found');
    c.send({ op: 'editImage', reqId: 'i1', target: '/open/site', field: 'f2', file: '/tmp/new.png' }); assert.equal((await c.reply('i1')).ok, true);
    assert.equal(calls.find((x): x is ImageCall => x[0] === 'editImage')![1].src, '/img/hero.png');
  });
});

test('with no window and no browser (radial serve): hello says so, focus and reload answer headless, page work and field ids refuse with the command that adds a browser, and one to run instead', async () => {
  const asked: string[] = [];
  await withServer({
    info: () => ({ version: '9.9.9', flavor: 'headless', pid: 1, windowReady: false, browser: false }),
    focus: () => ({ headless: true }),
    reload: async () => ({ headless: true }),
    shot: async () => { asked.push('shot'); return { ok: true, path: '/tmp/x.png' }; },
    fields: async () => { asked.push('fields'); return { ok: true, route: '/', fields: [] }; },
    editText: async () => { asked.push('editText'); return { ok: true, relFile: 'index.html', line: 1 }; },
    editImage: async () => { asked.push('editImage'); return { ok: true, relFile: 'index.html', line: 1 }; },
    migrateCompare: async () => { asked.push('migrateCompare'); return { ok: true, dir: '/x', report: '/x/report.md', rows: [] }; },
    fileExists: () => true,
  }, async ({ c }) => {
    c.send({ op: 'hello', reqId: 'h' }); const h = await c.reply<'hello'>('h');
    assert.equal(h.flavor, 'headless'); assert.equal(h.browser, false); assert.equal(h.windowReady, false);
    c.send({ op: 'focus', reqId: 'f' }); assert.deepEqual((({ op, reqId, ...rest }) => rest)(await c.reply('f')), { ok: true, headless: true });
    c.send({ op: 'reload', reqId: 'r', target: '/open/site' }); const r = await c.reply<'reload'>('r'); assert.equal(r.ok, true); assert.equal(r.headless, true);
    const refusals: [string, Partial<OpRequest>, RegExp, RegExp][] = [
      ['shot', {}, /can't take screenshots/, /^radial url \/open\/site$/],
      ['fields', {}, /can't read a page's fields/, /^radial edit text \/open\/site --find "<current text>" --to "<new text>"$/],
      ['editText', { field: 'f1', to: 'Hi' }, /Field ids come from `radial fields`/, /^radial edit text \/open\/site --find/],
      ['editImage', { field: 'f2', file: '/tmp/new.png' }, /current src/, /^radial edit image \/open\/site --src <current src> --file <image path>$/],
      ['migrateCompare', {}, /compare them/, /^radial url \/open\/site$/],
    ];
    for (const [op, extra, error, instead] of refusals) {
      c.send({ op, reqId: op, target: '/open/site', ...extra });
      const reply = await c.reply(op);
      assert.equal(reply.code, 'no-browser', op);
      assert.match(reply.error!, error, op);
      assert.equal(reply.fix, 'radial browser install', op);
      assert.match(reply.instead!, instead, op);
      assert.equal(proto.exitCodeFor(reply as ErrorReply), 6, `${op} exits 6, a refusal`);
    }
    c.send({ op: 'shot', reqId: 'spaced', target: '/my site' }); assert.equal((await c.reply('spaced')).instead, 'radial url "/my site"', 'a path a shell would split is quoted');
    c.send({ op: 'editText', reqId: 'find', target: '/open/site', find: 'Welcome home', to: 'Hi' }); assert.equal((await c.reply('find')).ok, true, 'edit text --find needs no browser');
    assert.deepEqual(asked, ['editText'], 'the refusals never reach the app');
  });
});

test('agent question passes the session\'s question through; agent answer refuses what can\'t go in, says what it would type without the yes and the question\'s id, and types with them', async () => {
  const h = fakeSessions();
  const pty1 = h.add('pty1', { ask: trustAsk() });
  h.add('pty2');
  const answered: [string, ArgsOf<'agentAnswer'>][] = [];
  await withServer({
    agentQuestion: (id) => h.questions.question(id),
    agentAnswer: (id, o) => { answered.push([id, o]); return h.questions.answer(id, o); },
  }, async ({ c, api }) => {
    c.send({ op: 'agentQuestion', reqId: 'q1', id: 'pty1' }); const q1 = await c.reply<'agentQuestion'>('q1');
    assert.deepEqual([q1.ok, q1.asking, q1.question!.options.map((o) => o.label)], [true, true, ['No, exit', 'Yes, I trust this folder']]);
    const trust = q1.question!;
    assert.match(trust.id, /^q[0-9a-f]{12}$/);
    c.send({ op: 'agentQuestion', reqId: 'q2', id: 'pty2' }); const q2 = await c.reply<'agentQuestion'>('q2'); assert.deepEqual([q2.ok, q2.asking, q2.question], [true, false, null], 'not asking is an answer, not an error');
    c.send({ op: 'agentQuestion', reqId: 'q3' }); assert.equal((await c.reply('q3')).code, 'bad-request');
    c.send({ op: 'agentQuestion', reqId: 'q4', id: 'gone' }); assert.equal((await c.reply('q4')).code, 'not-found');
    // Without the yes: what it would answer, and nothing typed.
    c.send({ op: 'agentAnswer', reqId: 'a1', id: 'pty1', answer: 'Yes, I trust this folder', expect: trust.id }); const a1 = await c.reply<'agentAnswer'>('a1');
    assert.equal(a1.code, 'needs-yes');
    assert.match(a1.error!, new RegExp(`^pty1's CLI asks:\\n {2}Accessing workspace:[\\s\\S]*\\n {2}1\\. No, exit \\(focused\\)\\n {2}2\\. Yes, I trust this folder\\nAnswering it with "Yes, I trust this folder" goes into its CLI as if you typed it at its terminal, and an answer can trust a folder or approve a command\\. Pass --yes to confirm, with --expect ${trust.id} so the answer goes only to this question\\.$`));
    assert.deepEqual(a1.question, trust);
    assert.equal(proto.exitCodeFor(a1 as ErrorReply), 6);
    // The yes without the question's id, or with another question's: that one needs its own yes, whatever the answer.
    c.send({ op: 'agentAnswer', reqId: 'n1', id: 'pty1', answer: '2', yes: true }); const n1 = await c.reply<'agentAnswer'>('n1');
    assert.equal(n1.code, 'needs-yes'); assert.match(n1.error!, new RegExp(`\\nAn answer names the question it is for: pass --expect ${trust.id}, with --yes once the person agrees`));
    c.send({ op: 'agentAnswer', reqId: 'x1', id: 'pty1', answer: '2', expect: 'q000000000000', yes: true }); const x1 = await c.reply<'agentAnswer'>('x1');
    assert.equal(x1.code, 'needs-yes'); assert.match(x1.error!, new RegExp(`^pty1's CLI asks another question than the one this answer is for:[\\s\\S]*pass --yes with --expect ${trust.id}\\.$`));
    // Refused with the yes or without: an answer that fits no option, a session not asking, both kinds of answer, empty text.
    for (const yes of [false, true]) {
      c.send({ op: 'agentAnswer', reqId: `m${yes}`, id: 'pty1', answer: 'Maybe', expect: trust.id, yes }); const m = await c.reply<'agentAnswer'>(`m${yes}`);
      assert.equal(m.code, 'bad-request'); assert.match(m.error!, /"Maybe" is none of the options of pty1's question in view\. Its options:\n {2}1\. No, exit \(focused\)\n {2}2\. Yes, I trust this folder/);
    }
    c.send({ op: 'agentAnswer', reqId: 'i1', id: 'pty2', answer: '1' }); const i1 = await c.reply<'agentAnswer'>('i1');
    assert.equal(i1.code, 'not-asking'); assert.match(i1.error!, /^pty2 isn't asking a question of its own\. Its screen shows:\n[\s\S]*To type into its prompt, use `radial agent send`\.$/);
    assert.equal(proto.exitCodeFor(i1 as ErrorReply), 6);
    c.send({ op: 'agentAnswer', reqId: 'b1', id: 'pty1', answer: '2', text: 'yes', yes: true }); assert.equal((await c.reply('b1')).code, 'bad-request');
    c.send({ op: 'agentAnswer', reqId: 'b2', id: 'pty1', text: '  ', yes: true }); assert.equal((await c.reply('b2')).code, 'bad-request');
    c.send({ op: 'agentAnswer', reqId: 'b3', answer: '2', yes: true }); assert.equal((await c.reply('b3')).code, 'bad-request');
    c.send({ op: 'agentAnswer', reqId: 'g1', id: 'gone', answer: '2' }); assert.equal((await c.reply('g1')).code, 'not-found');
    assert.deepEqual(pty1.writes, [], 'nothing typed yet');
    // With the yes and the question's id: the core answers, and the reply passes through.
    c.send({ op: 'agentAnswer', reqId: 'y1', id: 'pty1', answer: 'Yes, I trust this folder', expect: trust.id, yes: true, timeoutMs: 20000 }); const y1 = await c.reply<'agentAnswer'>('y1');
    assert.deepEqual([y1.ok, y1.chose, y1.after, y1.question?.id], [true, { number: 2, label: 'Yes, I trust this folder' }, 'gone', trust.id]);
    assert.equal(pty1.writes.length, 2);
    c.send({ op: 'agentAnswer', reqId: 'y2', id: 'pty1', answer: '   ', text: '', expect: '', yes: true }); assert.equal((await c.reply('y2')).code, 'not-asking');
    const sent = answered.map(([id, o]) => [id, o.answer, o.text, o.expect, o.yes]);
    assert.deepEqual(sent.slice(-2), [['pty1', 'Yes, I trust this folder', null, trust.id, true], ['pty1', null, null, null, true]], 'a blank answer, text or expect is none');
    const late = answered.at(-2)![1].deadline!;
    assert.ok(late > Date.now() + 10000 && late <= Date.now() + 15000, `the caller's timeout less a margin: ${late - Date.now()}`);
    assert.ok(api.calls.includes('telemetry:agentQuestion') && api.calls.includes('telemetry:agentAnswer'));
  });
});

test('context contributions, undo/redo, agent send and home: validation and pass-through', async () => {
  const calls: (['contextAdd', ArgsOf<'contextAdd'>] | ['agentSend', string, ArgsOf<'agentSend'>])[] = [];
  await withServer({
    contextAdd: async (dir, a) => { calls.push(['contextAdd', a]); return a.name === 'taken' && !a.replace ? { ok: false, reason: 'exists', message: 'taken.md already exists' } : { ok: true, rel: (a.name || 'file') + '.md', replaced: !!a.replace }; },
    refAdd: async (dir, url) => ({ ok: true, ref: { url } }),
    refRemove: async (dir, url) => (url === 'https://x.y' ? { ok: true, url } : { ok: false, reason: 'not-found' }),
    ruleAdd: async () => ({ ok: true, file: 'AGENTS.md' }),
    undo: async () => ({ ok: true, relFile: 'index.html' }),
    redo: async () => ({ ok: false, reason: 'nothing', message: 'Nothing to redo.' }),
    agentSend: async (id, o) => { calls.push(['agentSend', id, o]); return { ok: true, id, submitted: o.submit, landed: true }; },
    home: async (o) => ({ ok: true, id: 'ptyH', engine: o.engine || 'claude', started: true }),
    fileExists: (f) => f === '/tmp/notes.md',
  }, async ({ c }) => {
    c.send({ op: 'contextAdd', reqId: 'c0', target: '/open/site', name: 'positioning' }); assert.match((await c.reply('c0')).error!, /--text|--file/);
    c.send({ op: 'contextAdd', reqId: 'c1', target: '/open/site', name: 'positioning', text: '# Bold' }); assert.equal((await c.reply('c1')).rel, 'positioning.md');
    c.send({ op: 'contextAdd', reqId: 'c2', target: '/open/site', name: 'taken', text: 'x' }); const c2 = await c.reply('c2'); assert.equal(c2.code, 'bad-request'); assert.match(c2.error!, /already exists/);
    c.send({ op: 'contextAdd', reqId: 'c3', target: '/open/site', name: 'taken', text: 'x', replace: true }); assert.equal((await c.reply('c3')).replaced, true);
    c.send({ op: 'contextAdd', reqId: 'c4', target: '/open/site', file: 'notes.md', cwd: '/tmp' }); assert.equal((await c.reply('c4')).ok, true);
    assert.equal((calls.find((x) => x[0] === 'contextAdd' && x[1].file)![1] as ArgsOf<'contextAdd'>).file, '/tmp/notes.md', 'relative files resolve against the caller');
    c.send({ op: 'contextAdd', reqId: 'c5', target: '/open/site', file: '/nope.md' }); assert.equal((await c.reply('c5')).code, 'not-found');
    c.send({ op: 'refAdd', reqId: 'r1', target: '/open/site', url: 'https://x.y' }); assert.equal((await c.reply('r1')).ref!.url, 'https://x.y');
    c.send({ op: 'refAdd', reqId: 'r2', target: '/open/site' }); assert.equal((await c.reply('r2')).code, 'bad-request');
    c.send({ op: 'refRemove', reqId: 'r3', target: '/open/site', url: 'https://x.y' }); assert.equal((await c.reply('r3')).ok, true);
    c.send({ op: 'refRemove', reqId: 'r4', target: '/open/site', url: 'https://q.q' }); assert.equal((await c.reply('r4')).code, 'not-found');
    c.send({ op: 'ruleAdd', reqId: 'u1', target: '/open/site', text: 'Never use em dashes' }); assert.equal((await c.reply('u1')).file, 'AGENTS.md');
    c.send({ op: 'ruleAdd', reqId: 'u2', target: '/open/site', text: '  ' }); assert.equal((await c.reply('u2')).code, 'bad-request');
    c.send({ op: 'undo', reqId: 'n1', target: '/open/site' }); assert.equal((await c.reply('n1')).relFile, 'index.html');
    c.send({ op: 'redo', reqId: 'n2', target: '/open/site' }); const n2 = await c.reply('n2'); assert.equal(n2.ok, false); assert.match(n2.error!, /Nothing to redo/);
    c.send({ op: 'agentSend', reqId: 's1', id: 'pty1', text: 'and the footer' }); const s1 = await c.reply('s1'); assert.equal(s1.submitted, true, 'submits unless told not to');
    c.send({ op: 'agentSend', reqId: 's2', id: 'pty1', text: 'later', submit: false }); assert.equal((await c.reply('s2')).submitted, false);
    c.send({ op: 'agentSend', reqId: 's3', id: 'pty1' }); assert.equal((await c.reply('s3')).code, 'bad-request');
    c.send({ op: 'home', reqId: 'h1', engine: 'shell' }); const h1 = await c.reply('h1'); assert.equal(h1.id, 'ptyH'); assert.equal(h1.engine, 'shell');
    c.send({ op: 'home', reqId: 'h2', engine: 'gpt' }); assert.equal((await c.reply('h2')).code, 'bad-request');
  });
});

test('tokens: the index passes through; tokens set validates, maps ambiguity to candidates without a project pick, and not-found', async () => {
  await withServer({
    tokens: async () => ({ ok: true, tokens: [{ name: '--brand', value: '#8665f6', type: 'color', modes: [], uses: 3, files: 2, file: 'styles.css', line: 3 }], count: 1, files: ['styles.css'] }),
    tokenSet: async (dir, a) => a.name === '--purple' && !a.mode ? { ok: false, reason: 'ambiguous', message: 'two', candidates: [{ relFile: 'styles.css', line: 3, mode: 'default', value: '#1' }, { relFile: 'styles.css', line: 9, mode: 'dark', value: '#2' }] } : a.name === '--nope' ? { ok: false, reason: 'not-found' } : { ok: true, relFile: 'styles.css', line: 3, name: a.name, from: '#1', to: a.value, mode: a.mode || 'default', prevContent: 'x', newContent: 'y' },
  }, async ({ c }) => {
    c.send({ op: 'tokens', reqId: 't1', target: '/open/site' }); const t1 = await c.reply('t1'); assert.equal(t1.tokens![0].name, '--brand'); assert.equal(t1.count, 1);
    c.send({ op: 'tokenSet', reqId: 's1', target: '/open/site', name: '--brand', value: '#000' }); const s1 = await c.reply('s1'); assert.equal(s1.ok, true); assert.equal(s1.to, '#000'); assert.equal(s1.prevContent, undefined);
    c.send({ op: 'tokenSet', reqId: 's2', target: '/open/site', name: '--purple', value: '#000' }); const s2 = await c.reply<'tokenSet'>('s2'); assert.equal(s2.code, 'ambiguous'); assert.equal(s2.pick, false); assert.deepEqual(s2.candidates!.map((x) => x.mode), ['default', 'dark']);
    c.send({ op: 'tokenSet', reqId: 's3', target: '/open/site', name: '--purple', value: '#000', mode: 'dark' }); assert.equal((await c.reply('s3')).mode, 'dark');
    c.send({ op: 'tokenSet', reqId: 's4', target: '/open/site', name: '--nope', value: '#000' }); assert.equal((await c.reply('s4')).code, 'not-found');
    c.send({ op: 'tokenSet', reqId: 's5', target: '/open/site', name: '--brand' }); assert.equal((await c.reply('s5')).code, 'bad-request');
  });
});


test('pages passes the discovery answer through: the list plus framework, router, source and reason', async () => {
  await withServer({ pages: async () => ({ pages: [], framework: 'vite', router: null, source: 'fallback', reason: 'unsupported-router' }) }, async ({ c }) => {
    c.send({ op: 'pages', reqId: 'p1', target: '/open/site' }); const p1 = await c.reply('p1');
    assert.deepEqual([p1.ok, p1.pages, p1.framework, p1.reason], [true, [], 'vite', 'unsupported-router']);
  });
});
