// The core with no window and no browser, the way `radial serve` hosts it
// (src/core/fallbacks.ts and agentLane.ts, plans/headless-core.md phases 2a
// and 2b): the host passes null for the viewer and the page, and the core runs
// its own versions of what they do, with serve's options (no idle sleep,
// parking left to the daemon's ceiling, no browser shims). A fake platform and
// events seam stand in for the Node host. The tests skip start(), which opens
// the control socket and spawns the daemon from the built out/: they start a
// PTY daemon on the data dir's socket themselves, and the core's
// initTerminalDaemon connects to it. Agent sessions run a stand-in for Claude
// Code (test/fixtures/fake-claude.cjs), never the real one.

import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import type { AddressInfo } from 'net';

import { createCore } from '../src/core';
import type { CoreHost, CoreOptions } from '../src/core';
import { bindHost } from '../src/core/host';
import { checkIdle, sessions } from '../src/core/sessions';
import type { ProjectTabSession } from '../src/core/sessions';
import { initTerminalDaemon, parkIdleAgents, startTerminal } from '../src/core/agents';
import { nudgePreview } from '../src/core/edits';
import * as terminal from '../src/main/terminal';
import * as dataDirs from '../src/main/dataDirs';
import * as projectState from '../src/main/projectState';
import * as recents from '../src/main/recents';
import * as devPids from '../src/main/devPids';
import * as agentSleep from '../src/main/agentSleep';
import * as env from '../src/main/env';
import type { SleptAgent } from '../src/main/projectState';
import type { DevServerHandle } from '../src/main/devServer';
import type { WindowEvents } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

const DAEMON = path.join(__dirname, '..', 'src', 'main', 'term-daemon.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(label: string, fn: () => T | Promise<T>, ms = 15000): Promise<NonNullable<T>> {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v as NonNullable<T>; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`); await sleep(50); }
}

const dataDir = tmpDir('radial-headless-');
const told: { channel: keyof WindowEvents; payload: unknown }[] = [];
const host: CoreHost = {
  platform: { version: '9.9.9', flavor: 'headless', dataDir, home: dataDir, osVersion: 'test', cliBin: path.join(dataDir, 'radial'), keepAwake() {} },
  page: null,
  viewer: null,
  events: { send(channel: keyof WindowEvents, ...payload: unknown[]) { told.push({ channel, payload: payload[0] }); }, listening: () => false },
};
// The stores start() would open, in the same data dir.
recents.init(dataDir);
projectState.init(dataDir);
devPids.init(dataDir);
// Home's folder is the projects folder: a scratch one, never ~/Radial.
recents.setProjectsDir(path.join(dataDir, 'projects'));
// The stand-in for Claude Code. Its version (99) wins over any real install the
// machine has, and it keeps its sessions and its log in the data dir; the
// daemon the tests start passes these on to the terminals it runs.
const fakeBin = path.join(dataDir, 'bin');
fs.mkdirSync(fakeBin);
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-claude.cjs'), path.join(fakeBin, 'claude'));
fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);
env.registerExtraBin(fakeBin);
process.env.CLAUDE_CONFIG_DIR = path.join(dataDir, 'claude');
const cliLog = path.join(dataDir, 'fake-cli.jsonl');
process.env.RADIAL_FAKE_CLI_LOG = cliLog;
/** What the stand-in CLIs logged (fake-claude.cjs). */
interface CliEvent { pid: number; cwd: string; event: string; task?: string | null; sessionId?: string | null; resume?: string | null; home?: boolean; agentsNotes?: boolean; session?: string; found?: boolean; text?: string }
const cliEvents = (): CliEvent[] => { try { return fs.readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as CliEvent); } catch { return []; } };
const real = (dir: string) => fs.realpathSync(dir);
// radial serve's options (src/headless/serve.ts).
const serveOptions: CoreOptions = { idleSleepMs: null, parkAgents: false, devMemoryLimitMb: 2048, browserShims: false };
const core = createCore(host, serveOptions);
const api = core.cliApi();
// Browser shims an older run left behind: radial serve's terminals mustn't find them.
fs.mkdirSync(path.join(dataDir, 'shims'));
for (const name of ['open', 'xdg-open', 'radial-open', 'radial-open-helper.js']) fs.writeFileSync(path.join(dataDir, 'shims', name), '#!/bin/sh\n', { mode: 0o755 });

/** A plain HTML site in a git repo with one commit. */
function makeSite(html = '<!doctype html><html><head><title>Fixture</title></head><body><h1>Welcome home</h1></body></html>'): string {
  const dir = path.join(tmpDir('radial-headless-site-'), 'site');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  const git = (args: string[]) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']); git(['add', '-A']); git(['commit', '-q', '-m', 'init']);
  return dir;
}
/** Holds a project open in the core without starting it, the way the API checks it; stopped() says whether its server was stopped. */
function holdOpen(dir: string, { lastActive = Date.now() } = {}): { stopped(): boolean } {
  let stopped = false;
  const session: Partial<ProjectTabSession> = { handle: { url: 'http://localhost:4321', stop: async () => { stopped = true; } } as DevServerHandle, suspended: false, lastActive };
  sessions.set(dir, session as ProjectTabSession);
  return { stopped: () => stopped };
}
const get = (url: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  http.get(url, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode || 0, body })); }).on('error', reject);
});

// A PTY daemon on the data dir's socket, the one the core's initTerminalDaemon
// connects to (with the shims it writes); the close and the sweeps talk to it.
let daemonUp = false;
async function daemon(): Promise<void> {
  if (daemonUp) return;
  daemonUp = true;
  const sock = dataDirs.daemonSocket(dataDir);
  spawn(process.execPath, ['--import', 'tsx', DAEMON, sock, '--ephemeral'], { stdio: 'ignore', env: { ...process.env, RADIAL_NO_CAFFEINATE: '1' } }).unref();
  await until('the daemon', () => fs.existsSync(sock));
  initTerminalDaemon();
}
after(async () => { if (daemonUp) await terminal.killAll(); });

test('hello says headless, with no window and no browser; focus has nothing to bring forward', () => {
  assert.deepEqual(api.info(), { version: '9.9.9', flavor: 'headless', pid: process.pid, windowReady: false, browser: false });
  assert.deepEqual(api.focus(), { headless: true });
});

test('an open with no window runs openRepo itself, with the open-time preparation that keeps .radial/ out of git; reload has nothing to refresh; close stops the server', async () => {
  await daemon();
  const site = makeSite();
  api.requestOpen(site);
  const url = await until('the preview', () => sessions.get(site)?.handle?.url);
  assert.match((await get(url)).body, /Welcome home/, 'the preview serves the site');
  assert.match(fs.readFileSync(path.join(site, '.git', 'info', 'exclude'), 'utf8'), /^\.radial\/$/m, 'startRepo’s preparation ran: .radial/ is excluded from git');
  assert.equal(recents.listRecents()[0].path, site, 'and the project is a recent one, as an open from the window makes it');
  assert.deepEqual(await api.reload(site), { headless: true });
  assert.deepEqual(await api.close(site, { yes: true }), { state: 'closed' });
  assert.equal(sessions.has(site), false);
  await assert.rejects(get(url), 'the preview’s server stopped');
});

test('after an edit, the preview refresh has no browser to ask and is skipped', () => {
  assert.doesNotThrow(() => nudgePreview(makeSite()));
});

test('the agent lane runs the stand-in for Claude Code, never a real one', () => {
  assert.equal(env.claudeBin(), path.join(fakeBin, 'claude'));
});

test('agent start with no window: a session in the project’s folder with the task as its CLI’s first prompt, which no window holds, so the daemon’s ceiling can park it', async () => {
  await daemon();
  const site = makeSite();
  holdOpen(site);
  try {
    const r = await api.agentStart(site, { task: 'Fix the header', submit: true, engine: 'claude', label: null });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual([r.engine, r.label, r.submitted, r.landed, r.reused, r.waiting], ['claude', 'Fix the header', true, true, false, undefined]);
    const started = await until('its CLI', () => cliEvents().find((e) => e.event === 'start' && e.cwd === real(site)));
    assert.equal(started.task, 'Fix the header', 'the task rides as its first prompt: nothing is typed into its first paint');
    assert.ok(started.sessionId, 'pinned to a session id, so it can be put to sleep and resumed');
    const [pty] = await until('its terminal', () => terminal.list(site).then((l) => l.length ? l : null));
    assert.equal(pty.id, r.id); assert.equal(pty.meta.label, 'Fix the header');
    assert.equal(pty.attached, false, 'no window shows it');
    const idle = { ...pty, lastDataAt: Date.now() - agentSleep.AGENT_IDLE_CEILING_MS };
    assert.deepEqual(agentSleep.pickExpired([idle]).map((p) => p.id), [r.id], 'so the daemon parks it once it has idled past the ceiling');
    assert.deepEqual(agentSleep.pickExpired([{ ...idle, meta: { ...idle.meta, keepAwake: true } }]), [], 'unless it is kept awake');
    const wait = await api.agentWait(r.id, { waitMs: 15000, since: null, idleMs: 30000 });
    assert.ok(wait.ok && wait.reason === 'bell' && /TASK: Fix the header/.test(wait.text), JSON.stringify(wait));
  } finally { for (const t of await terminal.list(site)) terminal.kill(t.id); sessions.delete(site); }
});

test('a project restored asleep runs its open prep before its first agent starts, so the agent reads the notes it writes into AGENTS.md; its dev server still waits for a wake', async () => {
  await daemon();
  const site = makeSite();
  fs.writeFileSync(path.join(site, 'AGENTS.md'), '# Project guide\n\nKeep the copy short.\n');
  // As a launch restores it (startRepoCold): no dev server, and none of the open prep yet.
  sessions.set(site, { handle: null, project: { type: 'static', framework: 'static', staticRoot: site, name: 'site' }, config: {}, suspended: true, cold: true, lastActive: Date.now() } as ProjectTabSession);
  try {
    const { id } = await startTerminal({ repoDir: site, cols: 80, rows: 24, engine: 'claude', label: 'Claude Code', home: false });
    assert.ok(id);
    const started = await until('its CLI', () => cliEvents().find((e) => e.event === 'start' && e.cwd === real(site)));
    assert.equal(started.agentsNotes, true, 'AGENTS.md had Radial’s notes before the agent read it');
    assert.match(fs.readFileSync(path.join(site, '.git', 'info', 'exclude'), 'utf8'), /^\.radial\/$/m, 'and the migration ran: .radial/ is out of git');
    assert.deepEqual([sessions.get(site)!.cold, sessions.get(site)!.suspended], [true, true], 'the project is still asleep');
  } finally { for (const t of await terminal.list(site)) terminal.kill(t.id); sessions.delete(site); }
});

test('a staged start pastes the task once the CLI has painted itself, and leaves it unsent', async () => {
  await daemon();
  const site = makeSite();
  holdOpen(site);
  try {
    const r = await api.agentStart(site, { task: 'Rewrite the footer', submit: false, engine: 'claude', label: 'Footer' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual([r.label, r.submitted, r.landed, r.waiting], ['Footer', false, true, undefined]);
    const out = await api.agentOutput(r.id, { lines: null });
    assert.ok(out.ok && /Rewrite the footer/.test(out.text) && !/SUBMITTED/.test(out.text), out.ok ? out.text : JSON.stringify(out));
    await sleep(500);
    assert.deepEqual(cliEvents().filter((e) => e.cwd === real(site) && e.event === 'submit'), [], 'nothing was submitted');
  } finally { for (const t of await terminal.list(site)) terminal.kill(t.id); sessions.delete(site); }
});

test('agent send types into a running session; one the daemon’s ceiling put to sleep wakes with --resume and gets the text', async () => {
  await daemon();
  const site = makeSite();
  holdOpen(site);
  try {
    const r = await api.agentStart(site, { task: 'Fix the header', submit: true, engine: 'claude', label: null });
    assert.ok(r.ok, JSON.stringify(r));
    await api.agentWait(r.id, { waitMs: 15000, since: null, idleMs: 30000 });
    const sent = await api.agentSend(r.id, { text: 'Also fix the footer', submit: true });
    assert.ok(sent.ok, JSON.stringify(sent));
    assert.deepEqual([sent.id, sent.submitted, sent.landed, sent.waiting, sent.resumedFrom], [r.id, true, true, undefined, undefined]);
    const answered = await api.agentWait(r.id, { waitMs: 15000, since: null, idleMs: 30000 });
    assert.ok(answered.ok && answered.reason === 'bell' && /SUBMITTED: Also fix the footer/.test(answered.text), JSON.stringify(answered));
    // The ceiling: the daemon ends a session idle past it and logs the reap; the core keeps a resumable one as a slept record.
    const [pty] = await terminal.list(site);
    terminal.kill(r.id);
    await until('it ended', () => terminal.list(site).then((l) => !l.some((t) => t.id === r.id)));
    fs.appendFileSync(dataDirs.daemonSocket(dataDir) + '.reaped.jsonl', JSON.stringify({ id: r.id, repoDir: site, meta: pty.meta, reapedAt: Date.now() }) + '\n');
    const woke = await api.agentSend(r.id, { text: 'Pick up where you left off', submit: true });
    assert.ok(woke.ok, JSON.stringify(woke));
    assert.equal(woke.resumedFrom, r.id); assert.notEqual(woke.id, r.id, 'a new terminal, with the conversation');
    const resumed = await until('the resumed CLI', () => cliEvents().find((e) => e.event === 'start' && e.resume));
    assert.deepEqual([resumed.resume, resumed.task], [pty.meta.sessionId, 'Pick up where you left off'], 'claude --resume <its session> with the text as its next prompt');
    assert.equal(cliEvents().find((e) => e.event === 'resumed')!.found, true, 'its conversation was there to resume');
    assert.deepEqual(projectState.get(site).sleptAgents || [], [], 'the slept record is used up');
    const wait = await api.agentWait(woke.id, { waitMs: 15000, since: null, idleMs: 30000 });
    assert.ok(wait.ok && /TASK: Pick up where you left off/.test(wait.text), JSON.stringify(wait));
    const missing = await api.agentSend('pty-gone', { text: 'Hello', submit: true });
    assert.deepEqual(missing.ok ? null : missing.code, 'not-found');
  } finally { for (const t of await terminal.list(site)) terminal.kill(t.id); sessions.delete(site); }
});

test('a CLI asking its own question with no window: agent question reads it, agent answer moves to the option and presses Enter, and the task runs', async () => {
  await daemon();
  const site = makeSite();
  fs.writeFileSync(path.join(site, 'UNTRUSTED'), 'The stand-in asks to trust this folder first.\n');
  holdOpen(site);
  try {
    const r = await api.agentStart(site, { task: 'Fix the header', submit: true, engine: 'claude', label: null });
    assert.ok(r.ok && r.waiting === true, JSON.stringify(r));
    const asked = await api.agentQuestion(r.id);
    assert.ok(asked.ok && asked.asking && asked.question, JSON.stringify(asked));
    assert.deepEqual([asked.engine, asked.question.options.map((o) => o.label), asked.question.focused, asked.question.takes], ['claude', ['No, exit', 'Yes, I trust this folder'], 1, 'option']);
    assert.match(asked.question.text, /Quick safety check: Is this a project you created or one you trust\?/);
    const wait = await api.agentWait(r.id, { waitMs: 1000, since: null, idleMs: 30000 });
    assert.ok(wait.ok && wait.asking === true, 'agent wait says its CLI is asking');
    const wrong = await api.agentAnswer(r.id, { answer: 'Yes', text: null, expect: asked.question.id, yes: true });
    assert.ok(!wrong.ok && wrong.code === 'bad-request' && /"Yes" is none of the options/.test(wrong.error), JSON.stringify(wrong));
    const unnamed = await api.agentAnswer(r.id, { answer: 'Yes, I trust this folder', text: null, expect: null, yes: true });
    assert.ok(!unnamed.ok && unnamed.code === 'needs-yes' && unnamed.error.includes(`pass --expect ${asked.question.id}`), JSON.stringify(unnamed));
    const stale = await api.agentAnswer(r.id, { answer: 'Yes, I trust this folder', text: null, expect: 'q000000000000', yes: true });
    assert.ok(!stale.ok && stale.code === 'needs-yes' && stale.error.includes(`--expect ${asked.question.id}`), JSON.stringify(stale));
    assert.deepEqual(cliEvents().filter((e) => e.cwd === real(site)).map((e) => e.event), ['start'], 'nothing typed into the question');
    const done = await api.agentAnswer(r.id, { answer: 'Yes, I trust this folder', text: null, expect: asked.question.id, yes: true });
    assert.ok(done.ok, JSON.stringify(done));
    assert.deepEqual([done.id, done.chose, done.after, done.next], [r.id, { number: 2, label: 'Yes, I trust this folder' }, 'gone', null]);
    assert.match(done.text, /TASK: Fix the header/, 'its screen after: the task, at its prompt');
    await until('the task runs', () => cliEvents().some((e) => e.cwd === real(site) && e.event === 'run'));
    assert.deepEqual(cliEvents().filter((e) => e.cwd === real(site)).map((e) => e.event), ['start', 'trusted', 'run']);
    const after = await api.agentQuestion(r.id);
    assert.ok(after.ok && !after.asking && after.question === null && /\? for shortcuts/.test(after.text), JSON.stringify(after));
    const again = await api.agentAnswer(r.id, { answer: '2', text: null, expect: asked.question.id, yes: true });
    assert.ok(!again.ok && again.code === 'not-asking' && /isn't asking a question of its own\. Its screen shows:/.test(again.error), JSON.stringify(again));
    assert.equal((await api.agentAnswer('pty-gone', { answer: '2', text: null, expect: null, yes: true }) as { code?: string }).code, 'not-found');
  } finally { for (const t of await terminal.list(site)) terminal.kill(t.id); sessions.delete(site); }
});

test('radial home with no window: a session in the Home folder with Home’s brief, the same one when asked again, and a shell when asked', async () => {
  await daemon();
  const home = path.join(dataDir, 'projects');
  const r = await api.home({ engine: 'claude' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.engine, r.started], ['claude', true]);
  const started = await until('the Home CLI', () => cliEvents().find((e) => e.event === 'start' && e.cwd === real(home)));
  assert.equal(started.home, true, 'with Home’s brief instead of a project’s');
  const again = await api.home({});
  assert.ok(again.ok && again.id === r.id && again.started === false, JSON.stringify(again));
  terminal.kill(r.id);
  await until('it ended', () => terminal.list(home).then((l) => !l.length));
  const shell = await api.home({ engine: 'shell' });
  assert.ok(shell.ok && shell.engine === 'shell' && shell.started, JSON.stringify(shell));
  terminal.kill(shell.ok ? shell.id : '');
});

test('a migration’s agent with no window starts in the new project, with the task as its first prompt', async () => {
  await daemon();
  const site = makeSite();
  holdOpen(site);
  try {
    const launch = await api.migrateLaunch({ dir: site, engine: 'claude', task: 'Rebuild example.com in Astro', chatId: null });
    assert.ok(launch.ok, JSON.stringify(launch));
    assert.equal(launch.engine, 'claude');
    const [pty] = await terminal.list(site);
    assert.equal(launch.session, pty.id); assert.equal(pty.meta.label, 'Migration');
    const started = await until('the migration agent', () => cliEvents().find((e) => e.event === 'start' && e.cwd === real(site)));
    assert.equal(started.task, 'Rebuild example.com in Astro');
  } finally { for (const t of await terminal.list(site)) terminal.kill(t.id); sessions.delete(site); }
});

test('screenshots, fields and a compare refuse no-browser, with the command that adds one and the one to run instead', async () => {
  const site = makeSite();
  holdOpen(site);
  try {
    const shot = await api.shot(site, null);
    assert.deepEqual(shot.ok ? null : [shot.code, shot.fix, shot.instead], ['no-browser', 'radial browser install', `radial url ${site}`]);
    const fields = await api.fields(site, '/');
    assert.deepEqual(fields.ok ? null : [fields.code, fields.fix, fields.instead], ['no-browser', 'radial browser install', `radial edit text ${site} --find "<current text>" --to "<new text>"`]);
    const compare = await api.migrateCompare(site, { routes: [], widths: null }, () => {});
    assert.deepEqual(compare.ok ? null : [compare.code, compare.fix, compare.instead], ['no-browser', 'radial browser install', `radial url ${site}`]);
  } finally { sessions.delete(site); }
});

test('a migration capture with no browser takes no reference screenshots, and its reply and README say so', async () => {
  const site = makeSite();
  const live = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html><head><title>Live</title></head><body><h1>Live site</h1></body></html>'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => live.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(live.address() as AddressInfo).port}/`;
    const r = await api.migrateCapture(site, url, () => {}, { only: [] });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.screens, 0);
    assert.equal(r.screensSkipped, 'no-browser');
    assert.match(fs.readFileSync(r.readme, 'utf8'), /Reference screenshots: none\. This capture ran without a browser \(radial serve\)/);
  } finally { live.closeAllConnections(); live.close(); }
});


test('close with no window ends the project’s terminals and drops its slept agents, then stops the session', async () => {
  await daemon();
  const site = makeSite();
  holdOpen(site);
  const other = makeSite();
  const id = await terminal.start(site, { command: { bin: '/bin/sh', args: ['-c', 'sleep 30'] } });
  const elsewhere = await terminal.start(other, { command: { bin: '/bin/sh', args: ['-c', 'sleep 30'] } });
  const slept = { id: 'pty-old', engine: 'claude', label: 'Claude Code', sessionId: 's1', sleptAt: 1 } as SleptAgent;
  projectState.set(site, { sleptAgents: [slept] });
  assert.deepEqual((await terminal.list(site)).map((t) => t.id), [id]);
  assert.deepEqual(await api.close(site, { yes: true }), { state: 'closed' });
  assert.equal(sessions.has(site), false, 'the session stopped');
  assert.deepEqual(await terminal.list(site), [], 'its terminal ended');
  assert.deepEqual(projectState.get(site).sleptAgents, [], 'its slept agents won’t come back on a later open');
  assert.deepEqual((await terminal.list(other)).map((t) => t.id), [elsewhere], 'another project’s terminal is left alone');
  terminal.kill(elsewhere);
});

test('the sweeps that ask a window what’s on screen run without one, and so does stopping everything', async () => {
  await daemon();
  await parkIdleAgents();
  await core.stopAll();
  assert.equal(told.some((e) => e.channel === 'history:state'), false, 'nobody listens: no timeline is sent');
});

test('the idle sweep leaves a project running however long it goes unused, unless serve was started with --idle', async () => {
  const site = makeSite();
  const held = holdOpen(site, { lastActive: Date.now() - 24 * 60 * 60 * 1000 });
  try {
    await checkIdle();
    assert.equal(sessions.get(site)!.suspended, false, 'a day unused, and still running');
    assert.equal(held.stopped(), false);
    bindHost(host, { ...serveOptions, idleSleepMs: 30 * 60 * 1000 }); // radial serve --idle 30m
    await checkIdle();
    assert.equal(sessions.get(site)!.suspended, true, 'with --idle, it sleeps');
    assert.equal(held.stopped(), true);
  } finally { bindHost(host, serveOptions); sessions.delete(site); }
});

test('radial serve writes only the radial shim, and its terminals get no browser shim: a sign-in link opens the system’s way', async () => {
  await daemon();
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'shims')).sort(), ['radial'], 'the open and xdg-open shims an older run left are gone');
  assert.match(fs.readFileSync(path.join(dataDir, 'shims', 'radial'), 'utf8'), /^export RADIAL_CLI_FLAVOR="headless"$/m, 'its `radial` comes back to serve, never to a Mac app');
  const site = makeSite();
  const id = await terminal.start(site, { command: { bin: '/bin/sh', args: ['-c', 'printf "BROWSER=[%s] CLI=[%s] FIRST=[%s]\\n" "$BROWSER" "$RADIAL_CLI_SOCK" "${PATH%%:*}"; sleep 5'] } });
  try {
    const line = await until('the terminal’s env', async () => { const t = await terminal.tail(id, 4000); return t.ok && /BROWSER=\[.*\] CLI=/.test(t.data) ? t.data : null; });
    assert.match(line, /BROWSER=\[\]/, 'no $BROWSER pointing at a shim that isn’t there');
    assert.ok(line.includes(`CLI=[${dataDirs.cliSocket(dataDir)}]`), 'the radial CLI still finds the core');
    assert.ok(line.includes(`FIRST=[${path.join(dataDir, 'shims')}]`), 'and the radial shim comes first on PATH');
  } finally { terminal.kill(id); }
});

test('start() as radial serve runs it: the control socket listens, the daemon connects, and telemetry stays off, with no install id', async () => {
  await daemon();
  core.start();
  try {
    assert.deepEqual(await core.controlReady(), { ok: true });
    assert.ok(fs.existsSync(dataDirs.cliSocket(dataDir)), 'the control socket is up');
    assert.equal(fs.existsSync(path.join(dataDir, 'radial-telemetry.json')), false, 'no telemetry state, not even an install id');
  } finally { core.stopControlServer(); }
  assert.equal(fs.existsSync(dataDirs.cliSocket(dataDir)), false, 'stopping removes the socket');
});
