// The `radial` client end to end against a real control server with a fake
// api: output, exit codes, --json, --no-wait, offline fast paths, launch-on-
// missing, and the ambiguity pick.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as cli from '../src/main/cli';
import * as cliServer from '../src/main/cliServer';
import * as dataDirs from '../src/main/dataDirs';
import * as apiTokens from '../src/headless/apiTokens';
import { startListener } from '../src/headless/listen';
import type { CliIo } from '../src/main/cli';
import type { CliApi, ControlServer, HelloInfo, OpReplies } from '../src/main/cliServer';
import type { OkReply } from '../src/main/cliProto';
import type { DiscoveredPages } from '../src/main/project';
import { tmpDir } from './support/tmp';
import { claudeLogo, screens } from './fixtures/cliScreens';
import { fakeSessions, trustAsk, apiKeyAsk } from './fixtures/fakeSessions';
import type { FakeAsk } from './fixtures/fakeSessions';

// The fake api's types, shared with mcp.test.ts: it imports them with `import type`,
// which is erased, so its run never loads this file's tests.
/**
 * A fake's answer, and so the server's reply built from one: the real answer's
 * fields, each of them optional. Strings keep their literal types, so a fake
 * answering a reason, code or state the app doesn't have fails to compile.
 */
export type Sketch<T> = T extends readonly (infer E)[] ? Sketch<E>[] : T extends object ? { [K in keyof T]?: Sketch<T[K]> } : T;
/** Fake api methods as the contract has them: the real parameters, and a sketch of the real answer. */
export type Faked = { [K in keyof CliApi]?: (...args: Parameters<CliApi[K]>) => ReturnType<CliApi[K]> extends Promise<infer V> ? Promise<Sketch<V>> : Sketch<ReturnType<CliApi[K]>> };
/**
 * Fake api methods: Faked, except the two answers that are stand-ins outside the
 * contract: hello's 'test' flavor, and a publish that answers like a merged pull
 * request, with or without the steps it took. A reply the server builds from a
 * stand-in carries it too, so a test reads such a reply only as far as the
 * server guarantees (publish: the target it adds).
 */
export type FakeMethods = Omit<Faked, 'info' | 'publish'> & {
  info?: () => Sketch<Omit<HelloInfo, 'flavor'>> & { flavor?: HelloInfo['flavor'] | 'test' };
  publish?: (...args: Parameters<CliApi['publish']>) => Promise<Sketch<Awaited<ReturnType<CliApi['publish']>>> | { ok: true; mode: 'merge'; steps?: string[] }>;
};
/** The io main runs on in a test, and what main has written to stdout and stderr. */
interface TestIo extends CliIo { out(): string; err(): string }

function tmp() { return tmpDir('rclic-'); }
function api(over: FakeMethods = {}): CliApi {
  return {
    info: () => ({ version: '9.9.9', flavor: 'test', pid: 1, windowReady: true }),
    isOpen: (d) => d === '/open/site', focus: () => ({}), telemetry: () => {}, requestOpen: () => {},
    resolve: async (t) => (t === 'amb' ? { ok: false, code: 'ambiguous', error: 'two projects', candidates: [{ path: '/p/a', name: 'a' }, { path: '/p/b', name: 'b' }] } : { ok: true, kind: 'path', dir: t || '/cwd' }),
    clone: async () => ({ ok: false, code: 'error', error: 'no' }),
    projects: async () => ({ projects: [{ repoDir: '/open/site', name: 'site', url: 'http://localhost:7/', state: 'running', active: true, terminals: 0 }] }),
    previewUrl: (d) => (d === '/open/site' ? 'http://localhost:7/' : null),
    status: async () => ({ name: 'site', open: true, url: 'http://localhost:7/', git: { ok: true, isRepo: true, branch: 'main', changes: [] } }),
    context: async () => ({ name: 'site', rules: '## Project rules\n- be nice', docs: [{ file: 'design.md', content: '# Design' }], references: [], pages: [{ route: '/' }], url: 'http://localhost:7/', openComments: 0 }),
    pages: async () => [], comments: async () => [], shot: async () => ({ ok: true, path: '/tmp/s.png' }),
    create: async () => ({ ok: true, dir: '/new/x' }), sleep: async () => ({ state: 'asleep' }), wake: async () => ({ state: 'running' }), close: async () => ({ state: 'closed' }), liveTerminals: async () => 0,
    publishDestination: async (_d, to) => (to === 'production' ? { branch: 'main', production: true } : { branch: 'staging', production: false }), // the checkout isn't on its production branch
    ...over,
  } satisfies FakeMethods as CliApi; // a fake: the methods these tests drive, answering only the fields they read; another method's op fails its test
}
function io(env: NodeJS.ProcessEnv, extra: Partial<TestIo> = {}): TestIo {
  let out = '', err = '';
  return {
    stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
    env, cwd: '/cwd', isTTY: false, launchTimeoutMs: 1500,
    connect: (sock) => new Promise((res, rej) => { const s = (require('net') as typeof import('net')).createConnection(sock); s.once('connect', () => res(s)); s.once('error', rej); }),
    launch: () => { throw new Error('launch not expected'); },
    out: () => out, err: () => err,
    ...extra,
  };
}
async function withServer(over: FakeMethods, fn: (sock: string, srv: ControlServer) => Promise<void>): Promise<void> {
  const sock = path.join(tmp(), 'cli.sock');
  const srv = cliServer.start({ socketPath: sock, api: api(over) });
  await new Promise((r) => setTimeout(r, 40));
  try { return await fn(sock, srv); } finally { srv.stop(); }
}

test('argv: verbs, an implicit open for paths and names, flags with values, --no-wait', () => {
  assert.deepEqual(cli.parseArgs(['ls', '--all']).verb, 'ls');
  assert.equal(cli.parseArgs(['.']).verb, 'open'); assert.deepEqual(cli.parseArgs(['.']).positional, ['.']);
  assert.equal(cli.parseArgs(['summit']).verb, 'open');
  assert.equal(cli.parseArgs([]).verb, 'focus');
  const n = cli.parseArgs(['new', 'blog', '--template', 'astro', '--dir=/tmp/x', '--github', '--no-wait']);
  assert.equal(n.verb, 'new'); assert.deepEqual(n.positional, ['blog']); assert.equal(n.flags.template, 'astro'); assert.equal(n.flags.dir, '/tmp/x'); assert.equal(n.flags.github, true); assert.equal(n.flags.wait, false);
  assert.equal(cli.parseArgs(['--version']).flags.version, true);
  assert.equal(cli.parseArgs(['status', '--timeout', '5']).flags.timeout, '5');
});

test('--help prints the verb table; --version the app version', async () => {
  const i = io({}); assert.equal(await cli.main(['--help'], i), 0); assert.match(i.out(), /radial open/);
  const v = io({}); assert.equal(await cli.main(['--version'], v), 0); assert.match(v.out(), /^\d+\.\d+\.\d+/);
});

test('ls, url, status and context speak to the server; --json is one object; exit codes follow the reply', async () => {
  await withServer({}, async (sock) => {
    const env = { RADIAL_CLI_SOCK: sock };
    const ls = io(env); assert.equal(await cli.main(['ls'], ls), 0); assert.match(ls.out(), /site.*http:\/\/localhost:7\//);
    const lsj = io(env); assert.equal(await cli.main(['ls', '--json'], lsj), 0); assert.equal((JSON.parse(lsj.out()) as Sketch<OpReplies['ls']>).projects![0].name, 'site');
    const url = io(env); assert.equal(await cli.main(['url', '/open/site'], url), 0); assert.equal(url.out(), 'http://localhost:7/\n');
    const nourl = io(env); assert.equal(await cli.main(['url', '/closed/site'], nourl), 6); assert.match(nourl.err(), /not running/);
    const st = io(env); assert.equal(await cli.main(['status', '/open/site'], st), 0); assert.match(st.out(), /git: main/);
    const ctx = io(env); assert.equal(await cli.main(['context', '/open/site'], ctx), 0); assert.match(ctx.out(), /## \.context\/design\.md/); assert.match(ctx.out(), /be nice/);
  });
});

test('open prints the state; --no-wait returns on the queue ack; a timeout exits 4', async () => {
  await withServer({}, async (sock, srv) => {
    const env = { RADIAL_CLI_SOCK: sock };
    const o = io(env);
    const p = cli.main(['open', '/x/site'], o);
    await new Promise((r) => setTimeout(r, 60));
    srv.settleOpen('/x/site', { ok: true, url: 'http://localhost:9/', project: { name: 'site' }, repoDir: '/x/site' });
    assert.equal(await p, 0);
    assert.match(o.out(), /Opened site → http:\/\/localhost:9\//);
    const q = io(env); assert.equal(await cli.main(['open', '/y', '--no-wait'], q), 0); assert.match(q.out(), /Opening \/y/);
    const t = io(env); assert.equal(await cli.main(['open', '/z', '--timeout', '0.05'], t), 4); assert.match(t.err(), /No answer|Timed out/);
  });
});

test('ambiguity: no TTY lists candidates and exits 2; a TTY pick re-sends with the chosen path', async () => {
  await withServer({}, async (sock) => {
    const env = { RADIAL_CLI_SOCK: sock };
    const a = io(env); assert.equal(await cli.main(['url', 'amb'], a), 2); assert.match(a.err(), /1\. a.*\/p\/a/);
    const picked = io(env, { isTTY: true, readline: async () => '2' });
    const code = await cli.main(['status', 'amb'], picked);
    assert.equal(code, 0); assert.match(picked.err(), /Which one/); assert.match(picked.out(), /site/);
  });
});

test('with the app closed, url and context answer from disk and names come from the recents file', async () => {
  const userData = tmp();
  const proj = path.join(tmp(), 'summit-site'); fs.mkdirSync(path.join(proj, '.radial'), { recursive: true }); fs.mkdirSync(path.join(proj, '.context'));
  fs.writeFileSync(path.join(proj, '.radial', 'dev.json'), JSON.stringify({ url: 'http://localhost:4321/' }));
  fs.writeFileSync(path.join(proj, 'AGENTS.md'), '## Project rules\n- brand blue\n');
  fs.writeFileSync(path.join(proj, '.context', 'design-system.md'), '# Tokens\nblue');
  fs.writeFileSync(path.join(userData, 'radial-store.json'), JSON.stringify({ recents: [{ path: proj, name: 'summit-site', lastOpened: 1 }], projectsDir: null }));
  const env = { RADIAL_USERDATA: userData }; // no cli.sock here → offline
  const u = io(env); assert.equal(await cli.main(['url', 'summit'], u), 0); assert.equal(u.out(), 'http://localhost:4321/\n');
  const c = io(env); assert.equal(await cli.main(['context', proj], c), 0); assert.match(c.out(), /brand blue/); assert.match(c.out(), /design-system\.md/); assert.match(c.out(), /Tokens/);
  const cj = io(env); await cli.main(['context', 'summit', '--json'], cj); const j: OpReplies['context'] = JSON.parse(cj.out()); assert.equal(j.docs[0].file, 'design-system.md'); assert.equal(j.url, 'http://localhost:4321/');
  const miss = io(env); assert.equal(await cli.main(['url', 'nothing-like-it'], miss), 3);
});

test('when the socket is missing the client launches the app and waits for it', async () => {
  const sock = path.join(tmp(), 'cli.sock');
  let srv = null as ControlServer | null; // set by the launch callback, which control flow analysis doesn't follow
  const i = io({ RADIAL_CLI_SOCK: sock }, { launch: () => { setTimeout(() => { srv = cliServer.start({ socketPath: sock, api: api() }); }, 200); } });
  try { assert.equal(await cli.main(['ls'], i), 0); assert.match(i.err(), /Starting Radial/); assert.match(i.out(), /site/); }
  finally { if (srv) srv.stop(); }
  const never = io({ RADIAL_CLI_SOCK: path.join(tmp(), 'cli.sock') }, { launch: () => {}, launchTimeoutMs: 300 });
  assert.equal(await cli.main(['ls'], never), 4); assert.match(never.err(), /did not come up/);
});

test('argv: two-word verbs, a bare group is a usage error, per-verb payloads', () => {
  const ctx = { cwd: '/cwd', isTTY: false };
  const a = cli.parseArgs(['agent', 'start', '.', 'Fix the hero', '--submit', '--label', 'Hero']);
  assert.equal(a.verb, 'agent start'); assert.deepEqual(a.positional, ['.', 'Fix the hero']);
  const ap = cli.buildPayload(a.verb, a.positional, a.flags, ctx);
  assert.equal(ap.op, 'agentStart'); assert.equal(ap.task, 'Fix the hero'); assert.equal(ap.submit, true); assert.equal(ap.label, 'Hero'); assert.equal(ap.target, '.');
  const e = cli.parseArgs(['edit', 'text', '~/site', '--find', 'Hello', '--to', 'Hi', '--route', '/']);
  const ep = cli.buildPayload(e.verb, e.positional, e.flags, ctx); assert.equal(ep.op, 'editText'); assert.equal(ep.find, 'Hello'); assert.equal(ep.to, 'Hi'); assert.equal(ep.route, '/');
  assert.equal(cli.parseArgs(['comments', '~/site', '--open']).verb, 'comments');
  assert.equal(cli.parseArgs(['comments', 'add', '.', '--text', 'x']).verb, 'comments add');
  assert.equal(cli.parseArgs(['agent']).usage, true);
  const w = cli.parseArgs(['agent', 'wait', 'pty1', '--timeout', '5']); const wp = cli.buildPayload(w.verb, w.positional, w.flags, ctx); assert.equal(wp.id, 'pty1'); assert.equal(wp.waitMs, 5000); assert.equal(wp.target, null);
  const pub = cli.parseArgs(['publish', '--to', 'production', '--no-gate']); const pp = cli.buildPayload(pub.verb, pub.positional, pub.flags, ctx); assert.equal(pp.to, 'production'); assert.equal(pp.gate, false); assert.equal(pp.yes, false);
  const sh = cli.parseArgs(['shot', '~/s', '/pricing', '--width', '390']); const shp = cli.buildPayload(sh.verb, sh.positional, sh.flags, ctx); assert.equal(shp.route, '/pricing'); assert.equal(shp.width, 390);
  const sd = cli.parseArgs(['shot', '~/s']); assert.equal(cli.buildPayload(sd.verb, sd.positional, sd.flags, ctx).width, null, 'no --width: the page’s own');
  const m = cli.parseArgs(['meta', 'set', '~/s', 'og:title', 'New title']); const mp = cli.buildPayload(m.verb, m.positional, m.flags, ctx); assert.equal(mp.tag, 'og:title'); assert.equal(mp.value, 'New title');
});

test('a bare group prints its verbs and exits 2; a production publish asks at a TTY and refuses without --yes elsewhere', async () => {
  await withServer({ publish: async () => ({ ok: true, mode: 'merge', steps: ['pushed'] }) }, async (sock) => {
    const env = { RADIAL_CLI_SOCK: sock };
    const u = io(env); assert.equal(await cli.main(['agent'], u), 2); assert.match(u.err(), /radial agent start/);
    const n = io(env); assert.equal(await cli.main(['publish', '--to', 'production'], n), 6); assert.match(n.err(), /--yes/);
    const y = io(env, { isTTY: true, readline: async () => 'y' }); assert.equal(await cli.main(['publish', '--to', 'production'], y), 0); assert.match(y.out(), /Saved locally for production/); assert.match(y.err(), /may trigger deployment/);
    const no = io(env, { isTTY: true, readline: async () => '' }); assert.equal(await cli.main(['publish', '--to', 'production'], no), 6); assert.match(no.err(), /Cancelled/);
    const j = io(env); assert.equal(await cli.main(['publish', '.', '--json'], j), 0); assert.equal((JSON.parse(j.out()) as Pick<OpReplies['publish'], 'target'>).target, 'staging'); // the fake's merge stand-in, with the target the server adds
  });
});

test('write and agent verbs print for people: an edit, a comment, a staged and a submitted start, a wait, the list', async () => {
  await withServer({
    editText: async () => ({ ok: true, relFile: 'index.html', line: 7 }),
    commentAdd: async (d, a) => ({ ok: true, comment: { id: 'c1', route: a.route, selector: a.selector } }),
    commentsPull: async () => ({ ok: true, total: 3, added: 2, updated: 0, resolved: 1, changed: true }),
    // A task named 'Trust first' meets a CLI that is asking a question of its own.
    agentStart: async (d, o) => o.task === 'Trust first' ? ({ ok: true, id: 'pty1', label: 'Fix hero', engine: 'claude', submitted: o.submit, landed: o.submit, waiting: true }) : ({ ok: true, id: 'pty1', label: 'Fix hero', engine: 'claude', submitted: o.submit, landed: true }),
    agentWait: async () => ({ ok: true, id: 'pty1', reason: 'bell', alive: true, text: 'All done ✓' }),
    agentList: async () => [{ id: 'pty1', repoDir: '/open/site', name: 'site', engine: 'claude', label: 'Fix hero', alive: true, lastDataAt: Date.now(), lastBellAt: 0 }],
    agentOutput: async () => ({ ok: true, id: 'pty1', alive: true, text: 'screen' }),
    // radial serve's send: into a session asking a question of its own, and into one that was asleep.
    agentSend: async (id) => id === 'pty1' ? ({ ok: true, id, submitted: true, landed: false, sentAt: 1, waiting: true }) : ({ ok: true, id: 'pty7', submitted: true, landed: true, sentAt: 1, resumedFrom: id }),
  }, async (sock) => {
    const env = { RADIAL_CLI_SOCK: sock };
    let t = io(env); assert.equal(await cli.main(['edit', 'text', '/open/site', '--find', 'Hello', '--to', 'Hi'], t), 0); assert.match(t.out(), /Saved → index.html:7/);
    t = io(env); assert.equal(await cli.main(['edit', 'text', '/open/site', '--find', 'Hello'], t), 2); assert.match(t.err(), /--to/);
    t = io(env); assert.equal(await cli.main(['comments', 'add', '/open/site', '--text', 'Tighten', '--route', '/pricing'], t), 0); assert.match(t.out(), /Added comment c1 on \/pricing/);
    t = io(env); assert.equal(await cli.main(['comments', 'pull', '/open/site'], t), 0); assert.match(t.out(), /Pulled Vercel comments: 2 new, 1 resolved \(3 threads\)/);
    t = io(env); assert.equal(await cli.main(['agent', 'start', '/open/site', 'Fix the hero'], t), 0); assert.equal(t.out(), 'Staged claude session pty1 in site: Fix hero (press Enter in the session to run it)\n');
    t = io(env); assert.equal(await cli.main(['agent', 'start', '/open/site', 'Fix the hero', '--submit'], t), 0); assert.match(t.out(), /^Started claude session pty1/);
    t = io(env); assert.equal(await cli.main(['agent', 'start', '/open/site', 'Trust first'], t), 0); assert.equal(t.out(), 'Staged claude session pty1 in site: Fix hero (its CLI is asking a question of its own first, which `radial agent question pty1` shows; once that is answered, the task goes into its input for you to run)\n');
    t = io(env); assert.equal(await cli.main(['agent', 'start', '/open/site', 'Trust first', '--submit'], t), 0); assert.equal(t.out(), 'Started claude session pty1 in site: Fix hero (its CLI is asking a question of its own first, which `radial agent question pty1` shows; once that is answered, the task runs)\n');
    t = io(env); assert.equal(await cli.main(['agent', 'send', 'pty1', 'And the footer'], t), 0); assert.equal(t.out(), 'Sent into pty1 (its CLI is asking a question of its own first, which `radial agent question pty1` shows; the text goes in once that is answered)\n');
    t = io(env); assert.equal(await cli.main(['agent', 'send', 'pty3', 'Pick up where you left off'], t), 0); assert.equal(t.out(), 'Woke pty3 with its conversation as pty7, and sent the text\n');
    t = io(env); assert.equal(await cli.main(['agent', 'wait', 'pty1'], t), 0); assert.match(t.out(), /bell: the session finished a turn/); assert.match(t.out(), /All done/);
    t = io(env); assert.equal(await cli.main(['agent', 'list'], t), 0); assert.match(t.out(), /pty1\s+claude\s+site\s+live/);
    t = io(env); assert.equal(await cli.main(['agent', 'output', 'pty1'], t), 0); assert.equal(t.out(), 'screen\n');
    t = io(env); assert.equal(await cli.main(['agent', 'kill', 'pty1'], t), 6);
  });
});

test('agent question and answer print for people: the question with how to answer it, a refusal with its options, and what came after', async () => {
  const h = fakeSessions();
  h.add('pty1', { ask: trustAsk() });
  h.add('pty2');
  const theme = (then: FakeAsk['then']): FakeAsk => ({ count: 4, focus: 1, then, draw: (f) => [...claudeLogo, " Let's get started.", ' Choose the text style that looks best with your terminal', ...['Auto (match terminal)', 'Dark mode', 'Light mode'].map((l, i) => `${i === f ? ' ❯ ' : '   '}${i + 1}. ${l}`), ' Enter to confirm · Esc to cancel'] });
  h.add('pty3', { ask: theme(() => screens.claudeLogin) });
  const key = h.add('pty4', { engine: 'codex', ask: apiKeyAsk() });
  h.add('pty5', { ask: trustAsk(() => 'exit') });
  const stdin = 'sk-test-0123456789\n';
  await withServer({
    agentQuestion: (id) => h.questions.question(id),
    agentAnswer: (id, o) => h.questions.answer(id, o),
    agentWait: async () => ({ ok: true, id: 'pty1', reason: 'idle', alive: true, text: 'Yes, I trust this folder', asking: true }),
  }, async (sock) => {
    const env = { RADIAL_CLI_SOCK: sock };
    const idOf = async (id: string) => { const t = io(env); await cli.main(['agent', 'question', id, '--json'], t); return JSON.parse(t.out()).question.id as string; };
    const trust = await idOf('pty1');
    let t = io(env); assert.equal(await cli.main(['agent', 'question', 'pty1'], t), 0);
    assert.equal(t.out(), `pty1 (claude) is asking:\n  Accessing workspace:\n  /work/site\n  1. No, exit (focused)\n  2. Yes, I trust this folder\nAnswer: radial agent answer pty1 <number or label> --expect ${trust} --yes\n`);
    t = io(env); assert.equal(await cli.main(['agent', 'question', 'pty4'], t), 0);
    assert.ok(t.out().endsWith(`\nIt takes a line of text: radial agent answer pty4 --text "<text>" --expect ${await idOf('pty4')} --yes (--text - reads it from stdin)\n`), t.out());
    t = io(env); assert.equal(await cli.main(['agent', 'question', 'pty2'], t), 0, 'not asking is said plainly, not an error');
    assert.match(t.out(), /^pty2 isn't asking a question of its own\. Its screen shows:\n {2}─+\n {2}❯\n {2}─+\n {4}\? for shortcuts\n$/);
    t = io(env); assert.equal(await cli.main(['agent', 'answer', 'pty1', 'Yes, I trust this folder'], t), 6, 'needs the yes and the question\'s id');
    assert.ok(t.err().startsWith('radial: pty1\'s CLI asks:\n') && t.err().endsWith(`An answer names the question it is for: pass --expect ${trust}, with --yes once the person agrees to answer it with "Yes, I trust this folder".\n`), t.err());
    t = io(env); assert.equal(await cli.main(['agent', 'answer', 'pty1', 'Yes, I trust this folder', '--expect', trust], t), 6);
    assert.ok(t.err().endsWith(`Pass --yes to confirm, with --expect ${trust} so the answer goes only to this question.\n`), t.err());
    t = io(env); assert.equal(await cli.main(['agent', 'answer', 'pty1', 'Maybe', '--expect', trust, '--yes'], t), 2);
    assert.match(t.err(), /^radial: "Maybe" is none of the options of pty1's question in view\. Its options:\n {2}1\. No, exit \(focused\)\n {2}2\. Yes, I trust this folder\nName one by its number or its label, as listed\.\n$/);
    t = io(env); assert.equal(await cli.main(['agent', 'answer', 'pty2', '1', '--yes'], t), 6); assert.match(t.err(), /^radial: pty2 isn't asking a question of its own\. Its screen shows:/);
    t = io(env); assert.equal(await cli.main(['agent', 'answer', 'pty1', 'Yes, I trust this folder', '--expect', trust, '--yes'], t), 0); assert.equal(t.out(), 'Chose "Yes, I trust this folder" in pty1. The question is gone: its CLI went on.\n');
    t = io(env); assert.equal(await cli.main(['agent', 'answer', 'pty5', '1', '--expect', await idOf('pty5'), '--yes'], t), 0); assert.equal(t.out(), 'Chose "No, exit" in pty5, and the session ended.\n');
    t = io(env); assert.equal(await cli.main(['agent', 'answer', 'pty3', 'Dark mode', '--expect', await idOf('pty3'), '--yes'], t), 0, t.err());
    assert.match(t.out(), /^Chose "Dark mode" in pty3\. Its CLI asks another question now:\n[\s\S]*Select login method:\n {2}1\. Claude account with subscription[\s\S]*\nAnswer: radial agent answer pty3 <number or label> --expect q[0-9a-f]{12} --yes\n$/);
    // --text -: the text from stdin, less its last line break, and never printed.
    const field = await idOf('pty4');
    t = io(env, { readStdin: async () => '' }); assert.equal(await cli.main(['agent', 'answer', 'pty4', '--text', '-', '--expect', field, '--yes'], t), 2);
    assert.equal(t.err(), 'radial: --text - reads the text to type from stdin, and stdin had none.\n');
    t = io(env, { readStdin: async () => stdin }); assert.equal(await cli.main(['agent', 'answer', 'pty4', '--text', '-', '--expect', field, '--yes'], t), 0, t.err());
    assert.equal(t.out(), 'Typed the text and pressed Enter in pty4. The question is gone: its CLI went on.\n');
    assert.deepEqual(key.writes, ['\x1b[200~sk-test-0123456789\x1b[201~', '\r']);
    t = io(env); assert.equal(await cli.main(['agent', 'wait', 'pty1'], t), 0); assert.match(t.out(), /\nIts CLI is asking a question of its own: `radial agent question pty1` shows it, and `radial agent answer` answers it\.\n$/);
  });
});

test('argv: field-pinned edits, context contributions, agent send, home, and mcp --install', async () => {
  const ctx = { cwd: '/cwd', isTTY: false };
  const e = cli.parseArgs(['edit', 'text', '.', '--field', 'f3', '--to', 'New']); const ep = cli.buildPayload(e.verb, e.positional, e.flags, ctx);
  assert.equal(ep.field, 'f3'); assert.equal(ep.find, null); assert.equal(ep.to, 'New');
  const c = cli.parseArgs(['context', 'add', '.', 'positioning', '--text', '# P', '--replace']); const cp = cli.buildPayload(c.verb, c.positional, c.flags, ctx);
  assert.equal(cp.op, 'contextAdd'); assert.equal(cp.name, 'positioning'); assert.equal(cp.text, '# P'); assert.equal(cp.replace, true);
  assert.equal(cli.parseArgs(['context', '~/site']).verb, 'context', 'the one-word read verb still wins');
  const s = cli.parseArgs(['agent', 'send', 'pty1', 'and the footer', '--no-submit']); const sp = cli.buildPayload(s.verb, s.positional, s.flags, ctx);
  assert.equal(sp.op, 'agentSend'); assert.equal(sp.id, 'pty1'); assert.equal(sp.text, 'and the footer'); assert.equal(sp.submit, false);
  assert.equal(cli.buildPayload('agent send', ['pty1', 'x'], {}, ctx).submit, true);
  const keep = cli.buildPayload('agent keep', ['pty1'], { off: true }, ctx); assert.equal(keep.op, 'agentKeep'); assert.equal(keep.id, 'pty1'); assert.equal(keep.off, true); assert.equal(keep.target, null);
  assert.equal(cli.buildPayload('agent keep', ['pty1'], {}, ctx).off, false);
  const q = cli.parseArgs(['agent', 'question', 'pty1']); const qp = cli.buildPayload(q.verb, q.positional, q.flags, ctx);
  assert.deepEqual([qp.op, qp.id, qp.target], ['agentQuestion', 'pty1', null]);
  const a = cli.parseArgs(['agent', 'answer', 'pty1', 'Yes, I trust this folder', '--expect', 'q1234abcd', '--yes']); const ap = cli.buildPayload(a.verb, a.positional, a.flags, ctx);
  assert.deepEqual([ap.op, ap.id, ap.answer, ap.text, ap.expect, ap.yes, ap.target], ['agentAnswer', 'pty1', 'Yes, I trust this folder', null, 'q1234abcd', true, null]);
  const at = cli.parseArgs(['agent', 'answer', 'pty1', '--text', 'sk-test', '--yes']); const atp = cli.buildPayload(at.verb, at.positional, at.flags, ctx);
  assert.deepEqual([atp.answer, atp.text], [null, 'sk-test']);
  assert.deepEqual([cli.buildPayload('agent answer', ['pty1'], { yes: true }, ctx).answer, cli.buildPayload('agent answer', ['pty1'], { yes: true }, ctx).text], [null, null], 'neither: Enter alone');
  const h = cli.parseArgs(['home', '--engine', 'shell']); assert.equal(cli.buildPayload(h.verb, h.positional, h.flags, ctx).engine, 'shell');
  assert.equal(cli.parseArgs(['rules']).usage, true);
  const home = tmp();
  const t = io({ RADIAL_CLI_SHIM: '/x/radial', HOME: home });
  t.installConfig = (kind, shim) => ({ path: `/cfg/${kind}`, action: 'written' });
  assert.equal(await cli.main(['mcp', '--install', 'cursor'], t), 0); assert.match(t.out(), /Wrote \/cfg\/cursor/);
});

test('argv: a repeatable flag sends only the values given, not a last flag with no value or a --no- before it', () => {
  const ctx = { cwd: '/cwd', isTTY: false };
  const payload = (argv: string[]) => { const a = cli.parseArgs(argv); return cli.buildPayload(a.verb, a.positional, a.flags, ctx); };
  assert.deepEqual(payload(['migrate', 'compare', '.', '--route', '/a', '--route']).routes, ['/a']);
  assert.deepEqual(payload(['migrate', 'start', 'https://x.com', '--include', 'a.zip', '--include']).files, ['a.zip']);
  assert.deepEqual(payload(['migrate', 'start', 'https://x.com', '--no-include', '--include', 'a.zip']).files, ['a.zip']);
  const both = payload(['migrate', 'start', 'https://x.com', '--include', 'a.zip', '--include=b.pdf', '--only', '/pricing']);
  assert.deepEqual(both.files, ['a.zip', 'b.pdf']); assert.deepEqual(both.only, ['/pricing']);
  assert.deepEqual(payload(['migrate', 'capture', 'https://x.com', '--only']).only, []);
});

test('tokens: parsed, printed, and answered from disk when the app is closed', async () => {
  const ctx = { cwd: '/cwd', isTTY: false };
  const p = cli.parseArgs(['tokens', 'set', '~/site', '--brand', '#000', '--mode', 'dark']); const pp = cli.buildPayload(p.verb, p.positional, p.flags, ctx);
  assert.equal(pp.op, 'tokenSet'); assert.equal(pp.name, '--brand'); assert.equal(pp.value, '#000'); assert.equal(pp.mode, 'dark');
  const userData = tmp();
  const proj = path.join(tmp(), 'tok-site');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'styles.css'), ':root { --brand: #8665f6; --radius: 8px; }\n.a { color: var(--brand); }\n');
  fs.writeFileSync(path.join(userData, 'radial-store.json'), JSON.stringify({ recents: [{ path: proj, name: 'tok-site', lastOpened: 1 }] }));
  const t = io({ RADIAL_USERDATA: userData });
  assert.equal(await cli.main(['tokens', 'tok-site'], t), 0);
  assert.match(t.out(), /2 tokens in 1 file/); assert.match(t.out(), /--brand\s+#8665f6\s+1×\s+styles\.css:1/); assert.match(t.out(), /--radius.*unused/);
  const j = io({ RADIAL_USERDATA: userData }); assert.equal(await cli.main(['tokens', proj, '--json'], j), 0); assert.equal((JSON.parse(j.out()) as OpReplies['tokens']).tokens[0].type, 'color');
  const c = io({ RADIAL_USERDATA: userData }); assert.equal(await cli.main(['context', proj], c), 0); assert.match(c.out(), /## Design tokens/); assert.match(c.out(), /--brand: #8665f6/);
});


test('status says git could not read the project instead of printing 0 changes', async () => {
  const git = { ok: false, isRepo: true, reason: 'status-failed', message: 'fatal: index file smaller than expected\nmore detail', changes: null } as const;
  await withServer({ status: async () => ({ name: 'site', open: true, url: 'http://localhost:7/', git }) }, async (sock) => {
    const t = io({ RADIAL_CLI_SOCK: sock }); assert.equal(await cli.main(['status', '/open/site'], t), 0);
    assert.doesNotMatch(t.out(), /change/);
    assert.match(t.out(), /^git: could not read the status \(fatal: index file smaller than expected\)$/m);
  });
});

test('edit image says the source already uses the image instead of printing undefined', async () => {
  // swapImageFile copied the file and found the source already pointing at it: moduleResult sends { already, relFile, line } only.
  await withServer({ fileExists: () => true, editImage: async () => ({ ok: false, reason: 'already-applied', relFile: 'index.html', line: 12 }) }, async (sock) => {
    const t = io({ RADIAL_CLI_SOCK: sock }); assert.equal(await cli.main(['edit', 'image', '/open/site', '--src', '/images/hero.png', '--file', '/tmp/new.png'], t), 0);
    assert.doesNotMatch(t.out(), /undefined/);
    assert.equal(t.out(), 'Already uses that image (index.html:12)\n');
  });
});

test('pages prints the reason when discovery is empty', async () => {
  await withServer({ pages: async () => ({ pages: [], framework: 'vite', router: null, source: 'fallback', reason: 'unsupported-router' }) }, async (sock) => {
    const t = io({ RADIAL_CLI_SOCK: sock }); assert.equal(await cli.main(['pages', '/open/site'], t), 0);
    assert.match(t.out(), /No pages found\. Radial maps routes for .*TanStack Start.*; this project looks like vite\./);
    const j = io({ RADIAL_CLI_SOCK: sock }); await cli.main(['pages', '/open/site', '--json'], j); assert.equal((JSON.parse(j.out()) as OkReply<{ repoDir: string } & DiscoveredPages>).reason, 'unsupported-router');
  });
});

test('without a window or a browser (radial serve): focus and reload say so, a capture says it took no screenshots, a refusal prints the fix and what to run instead, and exits 6', async () => {
  await withServer({
    info: () => ({ version: '9.9.9', flavor: 'headless', pid: 1, windowReady: false, browser: false }),
    focus: () => ({ headless: true }),
    reload: async () => ({ headless: true }),
    migrateCapture: async () => ({ ok: true, capture: '/c', readme: '/c/README.md', source: 'https://example.com', platform: 'Webflow', scope: null, pages: 3, assets: 2, screens: 0, screensSkipped: 'no-browser', playbook: '/p/SKILL.md' }),
  }, async (sock) => {
    const env = { RADIAL_CLI_SOCK: sock };
    const f = io(env); assert.equal(await cli.main([], f), 0); assert.match(f.out(), /running without a window \(radial serve\)/);
    const r = io(env); assert.equal(await cli.main(['reload', '/open/site'], r), 0); assert.match(r.out(), /Nothing to reload/);
    const m = io(env); assert.equal(await cli.main(['migrate', 'capture', 'https://example.com', '--project', '/open/site'], m), 0);
    assert.match(m.out(), /3 pages, 2 assets, no reference screenshots \(no browser yet: radial browser install adds one\)/);
    const s = io(env); assert.equal(await cli.main(['shot', '/open/site'], s), 6);
    assert.match(s.err(), /^radial: This Radial has no browser for its projects' pages yet \(radial serve\), so it can't take screenshots/);
    assert.match(s.err(), /\n  Fix: radial browser install\n  Instead: radial url \/open\/site\n$/);
  });
});

test('which Radial the CLI drives: the app bin/radial found, else the headless core with its own data dir; --data-dir wins', () => {
  assert.equal(cli.cliFlavor({ RADIAL_CLI_FLAVOR: 'dev' }), 'dev');
  assert.equal(cli.cliFlavor({ RADIAL_CLI_APP: '/Applications/Radial.app/Contents/MacOS/Radial' }), 'packaged');
  assert.equal(cli.cliFlavor({ RADIAL_CLI_FLAVOR: 'headless', RADIAL_CLI_APP: '/x' }), 'headless');
  assert.equal(cli.cliFlavor({}), 'headless', 'no app to launch');
  assert.equal(cli.userDataDir({}), dataDirs.defaultHeadlessDataDir({}), 'never the Mac app’s folder');
  assert.equal(cli.userDataDir({ RADIAL_DATA_DIR: '/data', RADIAL_USERDATA: '/scratch' }), '/data');
  assert.equal(cli.socketPath({ RADIAL_DATA_DIR: '/data' }), '/data/cli.sock');
  const p = cli.parseArgs(['serve', 'stop', '--data-dir', '/x', '--idle', '30m', '--detach']);
  assert.equal(p.verb, 'serve'); assert.deepEqual(p.positional, ['stop']);
  assert.equal(p.flags.dataDir, '/x'); assert.equal(p.flags.idle, '30m'); assert.equal(p.flags.detach, true);
});

test('--data-dir points a verb at that Radial; with no app to launch the client starts radial serve on it in the background', async () => {
  const dataDir = path.join(tmp(), 'data');
  let launched: NodeJS.ProcessEnv | null = null;
  let srv = null as ControlServer | null; // set by the launch callback
  const i = io({}, { launch: (env) => { launched = env; setTimeout(() => { fs.mkdirSync(dataDir); srv = cliServer.start({ socketPath: dataDirs.cliSocket(dataDir), api: api() }); }, 100); } }); // as serve would: it makes the data dir
  try {
    assert.equal(await cli.main(['ls', '--data-dir', dataDir], i), 0);
    assert.match(i.err(), /^Starting Radial in the background \(radial serve\)…/);
    assert.equal(launched!.RADIAL_DATA_DIR, dataDir, 'the serve it starts gets the same data dir');
    assert.match(i.out(), /site/);
  } finally { if (srv) srv.stop(); }
});

// ── RADIAL_URL and RADIAL_TOKEN: a radial serve --listen elsewhere, over HTTP ──
/** A radial serve --listen in front of a control server with the fake api (made for its data dir): its address, a token for it, and its socket (for the same request both ways). */
async function withRemote(over: FakeMethods | ((dataDir: string) => FakeMethods), fn: (remote: { url: string; token: string; sock: string; dataDir: string }) => Promise<void>): Promise<void> {
  const dataDir = tmp();
  const made = apiTokens.create(dataDir, 'test');
  if (!made.ok) throw new Error(made.error);
  const tokens = apiTokens.store(dataDir);
  const sock = path.join(dataDir, 'cli.sock');
  const srv = cliServer.start({ socketPath: sock, api: api(typeof over === 'function' ? over(dataDir) : over) });
  const listener = await startListener({
    address: { host: '127.0.0.1', port: 0 }, allowRemote: false, allowHosts: [], allowOrigins: [], dataDir, version: '9.9.9', tokens,
    dispatch: srv.dispatch, projects: () => ['/open/site'], preview: () => ({ ok: false, code: 'not-open', error: 'not open' }), wake: async () => null, used: () => {}, log: () => {},
  });
  await new Promise((r) => setTimeout(r, 40));
  try { await fn({ url: listener.address, token: made.token, sock, dataDir }); }
  finally { await listener.close(); tokens.close(); srv.stop(); }
}
/** The CLI's io for a radial serve elsewhere: no socket to connect to and nothing to launch, as on another machine. */
function remoteIo(env: NodeJS.ProcessEnv): TestIo {
  return io({ RADIAL_CLI_FLAVOR: 'headless', ...env }, { connect: () => Promise.reject(new Error('the socket is not for a remote Radial')), launch: () => { throw new Error('nothing to launch for a remote Radial'); } });
}

test('with RADIAL_URL and RADIAL_TOKEN, the CLI reaches that radial serve over HTTP and answers as over the socket, its progress streamed', async () => {
  await withRemote({ publish: async (_d, _o, progress) => { progress('Committing…'); await new Promise((r) => setTimeout(r, 20)); progress('Pushing…'); return { ok: true, mode: 'merge', steps: ['pushed main'] }; } }, async ({ url, token, sock }) => {
    const env = { RADIAL_URL: url, RADIAL_TOKEN: token };
    for (const args of [['ls'], ['status', '/open/site'], ['context', '/open/site'], ['url', '/open/site'], ['ls', '--json'], ['url', '/closed/site']]) {
      const viaSocket = io({ RADIAL_CLI_SOCK: sock }), viaHttp = remoteIo(env);
      const codes = [await cli.main(args, viaSocket), await cli.main(args, viaHttp)];
      assert.equal(codes[1], codes[0], `${args.join(' ')}: the same exit code`);
      assert.equal(viaHttp.out(), viaSocket.out(), `${args.join(' ')}: the same output`);
      assert.equal(viaHttp.err(), viaSocket.err(), `${args.join(' ')}: the same errors`);
    }
    const pub = remoteIo(env);
    assert.equal(await cli.main(['publish', '/open/site', '--to', 'branch'], pub), 0);
    assert.equal(pub.err(), 'Committing…\nPushing…\n', 'the progress, as it came');
    assert.match(pub.out(), /pushed main/);
    // With RADIAL_URL there's no disk answer here: url goes to that Radial even with no socket on this machine.
    const offline = remoteIo({ ...env, RADIAL_DATA_DIR: tmp() });
    assert.equal(await cli.main(['url', '/open/site'], offline), 0); assert.equal(offline.out(), 'http://localhost:7/\n');
  });
});

test('RADIAL_URL without RADIAL_TOKEN, a refused token, a token in the URL, or nothing there: each says so, and the socket is never tried', async () => {
  await withRemote({}, async ({ url }) => {
    const none = remoteIo({ RADIAL_URL: url });
    assert.equal(await cli.main(['ls'], none), 6); assert.match(none.err(), /^radial: RADIAL_URL is set, but RADIAL_TOKEN isn't\. Where Radial runs, `radial token create` makes a token\./);
    const wrong = remoteIo({ RADIAL_URL: url, RADIAL_TOKEN: `rcore_${'x'.repeat(43)}` });
    assert.equal(await cli.main(['ls'], wrong), 6); assert.match(wrong.err(), /doesn't accept that token/);
    const wrongJson = remoteIo({ RADIAL_URL: url, RADIAL_TOKEN: 'nope' });
    assert.equal(await cli.main(['ls', '--json'], wrongJson), 6); assert.equal((JSON.parse(wrongJson.out()) as { code: string }).code, 'unauthorized');
    const inUrl = remoteIo({ RADIAL_URL: url + '/?token=x', RADIAL_TOKEN: 'x' });
    assert.equal(await cli.main(['ls'], inUrl), 2); assert.match(inUrl.err(), /the token goes in RADIAL_TOKEN, never in the URL/);
    const ftp = remoteIo({ RADIAL_URL: 'ftp://127.0.0.1:1', RADIAL_TOKEN: 'x' });
    assert.equal(await cli.main(['ls'], ftp), 2);
  });
  const gone = remoteIo({ RADIAL_URL: 'http://127.0.0.1:1', RADIAL_TOKEN: 'x' });
  assert.equal(await cli.main(['ls'], gone), 4); assert.match(gone.err(), /isn't answering at http:\/\/127\.0\.0\.1:1 \(ECONNREFUSED\)/);
});

test('a shot from a radial serve elsewhere is fetched to this machine, and the path printed is the local one; one it won’t serve stays where it is, and says so', async () => {
  const name = `site-home-full@2x-${process.pid}.png`;
  await withRemote((dataDir) => ({ shot: async () => ({ ok: true, path: path.join(dataDir, 'shots', name), scale: 2, route: '/' }) }), async ({ url, token, dataDir }) => {
    const file = path.join(dataDir, 'shots', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from('a png, as far as this test cares'));
    const here = tmp(); // this machine's own Radial data dir, where a fetched shot lands
    const shot = remoteIo({ RADIAL_URL: url, RADIAL_TOKEN: token, RADIAL_DATA_DIR: here });
    assert.equal(await cli.main(['shot', '/open/site'], shot), 0, shot.err());
    const local = shot.out().trim();
    assert.equal(local, path.join(here, 'shots', name));
    assert.equal(fs.readFileSync(local, 'utf8'), 'a png, as far as this test cares');
    assert.equal(fs.statSync(path.dirname(local)).mode & 0o777, 0o700, 'a folder of this user’s own');
    fs.rmSync(local);
    const json = remoteIo({ RADIAL_URL: url, RADIAL_TOKEN: token, RADIAL_DATA_DIR: here });
    assert.equal(await cli.main(['shot', '/open/site', '--json'], json), 0);
    const reply = JSON.parse(json.out()) as { path: string; serverPath: string; url: string };
    assert.deepEqual([reply.path, reply.serverPath], [local, file]);
    assert.match(reply.url, /\/files\?path=/);
    fs.rmSync(local);
  });
  await withRemote({ shot: async () => ({ ok: true, path: '/etc/hosts.png', scale: 1, route: '/' }) }, async ({ url, token }) => {
    const refused = remoteIo({ RADIAL_URL: url, RADIAL_TOKEN: token });
    assert.equal(await cli.main(['shot', '/open/site'], refused), 0);
    assert.match(refused.err(), /^radial: the shot is on Radial's machine at \/etc\/hosts\.png, and fetching it failed: No such file here/);
    assert.equal(refused.out(), '/etc/hosts.png\n');
  });
});

test('radial token runs on this machine, on the headless data dir, whatever RADIAL_URL says', async () => {
  const dataDir = tmp();
  const made = io({ RADIAL_DATA_DIR: dataDir, RADIAL_URL: 'http://127.0.0.1:1', RADIAL_TOKEN: 'x' });
  assert.equal(await cli.main(['token', 'create', 'laptop', '--json'], made), 0);
  assert.match((JSON.parse(made.out()) as { token: string }).token, /^rcore_/);
  const listed = io({});
  assert.equal(await cli.main(['token', 'list', '--data-dir', dataDir], listed), 0);
  assert.match(listed.out(), /^laptop /);
});
