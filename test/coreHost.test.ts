// The core's seams (src/core/host.ts, plans/headless-core.md). A host hands
// createCore() four of them, platform, page, viewer and events, and the core
// reaches the app around it only through those. A fake host stands in for the
// Mac app here, the way `radial serve` will, and each test drives a piece of
// the core that calls a seam: the control socket's API, undo and redo, closing
// a project, the agent lane, a migration's launch, keep-awake and a move.
// The tests skip start(): it opens the control socket and the PTY daemon.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';

import { createCore } from '../src/core';
import type { Core, CoreHost, ViewerChats } from '../src/core';
import { events, page, platform, viewer } from '../src/core/host';
import { sessions } from '../src/core/sessions';
import type { ProjectTabSession } from '../src/core/sessions';
import { historyFor } from '../src/core/history';
import { syncKeepAwake } from '../src/core/agents';
import * as projectData from '../src/main/projectData';
import * as projectState from '../src/main/projectState';
import * as recents from '../src/main/recents';
import type { DevServerHandle } from '../src/main/devServer';
import type { PtyInfo } from '../src/main/terminal';
import type { CliResult, WindowEvents } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

/** One thing the core asked of its host: the seam member, then what it passed. */
type Asked = [string, ...unknown[]];
const asked: Asked[] = [];
const told: { channel: keyof WindowEvents; payload: unknown }[] = [];
/** What the host was asked since the last take, oldest first. */
function take(): Asked[] { return asked.splice(0); }
/** The events the core sent since the last call, oldest first. */
function heard() { return told.splice(0); }

/** What the fake host answers; each test sets what it reads. */
const fake = {
  ready: false,
  /** Whether the page's browser can work (radial serve's, before and after `radial browser install`). */
  browser: true,
  listening: false,
  chats: null as ViewerChats | null,
  shot: { ok: false, code: 'error', error: 'unset' } as CliResult<'shot'>,
  fields: { ok: false, code: 'error', error: 'unset' } as CliResult<'fields'>,
  reload: { ok: true } as CliResult<'reload'>,
  close: { ok: true } as CliResult<'close'>,
  agent: { ok: false, code: 'error', error: 'unset' } as CliResult<'agent'>,
  agentSend: { ok: false, code: 'error', error: 'unset' } as CliResult<'agentSend'>,
  home: { ok: false, code: 'error', error: 'unset' } as CliResult<'home'>,
};

const dataDir = tmpDir('radial-core-');
const host: CoreHost = {
  platform: {
    version: '9.9.9',
    flavor: 'dev',
    dataDir,
    home: dataDir,
    osVersion: 'test',
    cliBin: path.join(dataDir, 'radial'),
    keepAwake(on) { asked.push(['keepAwake', on]); },
  },
  page: {
    available: () => fake.browser,
    async shot(repoDir, route, width) { asked.push(['shot', repoDir, route, width]); return fake.shot; },
    async fields(repoDir, route) { asked.push(['fields', repoDir, route]); return fake.fields; },
    async reload(repoDir) { asked.push(['reload', repoDir]); return fake.reload; },
    async shoot(url, widths) { asked.push(['shoot', url, widths]); return []; },
    decode() { throw new Error('No PNG codec in these tests.'); },
    encode() { throw new Error('No PNG codec in these tests.'); },
  },
  viewer: {
    open(repoDir) { asked.push(['open', repoDir]); },
    focus() { asked.push(['focus']); },
    ready: () => fake.ready,
    focused: () => false,
    async close(repoDir) { asked.push(['close', repoDir]); return fake.close; },
    async visibleAgents() { return { ok: true, chatIds: [], termIds: [] }; },
    async agentStart(request) { asked.push(['agentStart', request]); return fake.agent; },
    async agentSend(request) { asked.push(['agentSend', request]); return fake.agentSend; },
    async home(request) { asked.push(['home', request]); return fake.home; },
    get chats() { return fake.chats; },
  },
  events: {
    send(channel: keyof WindowEvents, ...payload: unknown[]) { told.push({ channel, payload: payload[0] }); },
    listening: () => fake.listening,
  },
};
// The stores start() would open, in the same data dir.
recents.init(dataDir);
projectState.init(dataDir);

/** A plain HTML site in a new folder. */
function makeSite(html = '<h1>Site</h1>'): string {
  const dir = path.join(tmpDir('radial-core-site-'), 'site');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  return dir;
}
/** Holds a project open in the core, asleep or with a running dev server, the way the API checks it. */
function holdOpen(dir: string, { running = false } = {}): void {
  const handle = running ? { url: 'http://localhost:4321', stop: async () => {} } as DevServerHandle : null;
  const session: Partial<ProjectTabSession> = { handle, suspended: !running, lastActive: Date.now() };
  sessions.set(dir, session as ProjectTabSession);
}

test('the core refuses to run before its host gives it the seams', () => {
  assert.throws(() => platform(), /before its host gave it its seams/);
});

let core: Core;
test('createCore binds the host’s seams and opens the per-project data store in its data dir', () => {
  core = createCore(host);
  assert.equal(platform(), host.platform);
  assert.equal(page(), host.page);
  assert.equal(viewer(), host.viewer);
  assert.equal(events(), host.events);
  assert.equal(projectData.status().folder, path.join(fs.realpathSync(dataDir), 'project-data'));
});

test('hello reports the platform’s version and flavor, whether the viewer is ready, and that the page has a browser', () => {
  const api = core.cliApi();
  assert.deepEqual(api.info(), { version: '9.9.9', flavor: 'dev', pid: process.pid, windowReady: false, browser: true });
  fake.ready = true;
  try { assert.equal(api.info().windowReady, true); } finally { fake.ready = false; }
});

test('a focus and an open go to the viewer', () => {
  const api = core.cliApi();
  api.focus();
  api.requestOpen('/Users/someone/site');
  assert.deepEqual(take(), [['focus'], ['open', '/Users/someone/site']]);
});

test('a screenshot and the Content panel’s fields come from the page, with the route', async () => {
  const api = core.cliApi();
  const site = makeSite();
  fake.shot = { ok: true, path: path.join(site, 'shot.png'), scale: 2, route: '/about' };
  assert.deepEqual(await api.shot(site, '/about', 390), fake.shot);
  fake.fields = { ok: false, code: 'no-dev-server', error: 'The preview is not running yet.' };
  assert.deepEqual(await api.fields(site, null), fake.fields);
  assert.deepEqual(take(), [['shot', site, '/about', 390], ['fields', site, null]], 'the width goes along');
});

test('a page whose browser can’t work yet (radial serve before radial browser install) is left alone: no browser in hello, page work refuses, nothing to reload, a capture takes no screenshots', async () => {
  const api = core.cliApi();
  const site = makeSite();
  const live = http.createServer((req, res) => { res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/html' }); res.end('<!doctype html><html><head><title>Live</title></head><body><h1>Live</h1></body></html>'); });
  await new Promise<void>((resolve) => live.listen(0, '127.0.0.1', resolve));
  fake.browser = false;
  holdOpen(site, { running: true });
  try {
    assert.equal(api.info().browser, false);
    const shot = await api.shot(site, null, 390);
    assert.deepEqual(shot.ok ? null : [shot.code, shot.fix], ['no-browser', 'radial browser install']);
    const fields = await api.fields(site, '/');
    assert.equal(fields.ok ? null : fields.code, 'no-browser');
    assert.deepEqual(await api.reload(site), { headless: true }, 'no page shows the preview');
    const compare = await api.migrateCompare(site, { routes: [], widths: null }, () => {});
    assert.equal(compare.ok ? null : compare.code, 'no-browser');
    const capture = await api.migrateCapture(site, `http://127.0.0.1:${(live.address() as AddressInfo).port}/`, () => {}, { only: [] });
    assert.equal(capture.ok ? null : capture.error, null, 'the capture runs');
    assert.equal(capture.ok && capture.screensSkipped, 'no-browser');
    assert.deepEqual(take(), [], 'nothing reached the page');
    fake.browser = true;
    assert.equal(api.info().browser, true, 'installed while serve runs: the next request sees it');
  } finally { fake.browser = true; sessions.delete(site); live.closeAllConnections(); live.close(); }
});

test('a reload asks the page only for an open project, and reads its answer', async () => {
  const api = core.cliApi();
  const site = makeSite();
  assert.deepEqual(await api.reload(site), { ok: false, code: 'not-open', error: `${site} is not open.` });
  assert.deepEqual(take(), [], 'a project that is not open is never reloaded');
  holdOpen(site);
  try {
    fake.reload = { ok: true };
    assert.deepEqual(await api.reload(site), {});
    fake.reload = { ok: false, reason: 'asleep' };
    assert.deepEqual(await api.reload(site), { ok: false, code: 'no-dev-server', error: `${site} is asleep; wake it first (radial wake).` });
    fake.reload = { ok: false, code: 'timeout', error: 'The window did not answer in time.' };
    assert.deepEqual(await api.reload(site), { ok: false, code: 'timeout', error: 'The window did not answer in time.' });
    fake.reload = { ok: false, reason: 'not-open' };
    assert.deepEqual(await api.reload(site), { ok: false, code: 'error', error: 'Could not reload the preview.' });
    assert.deepEqual(take(), [['reload', site], ['reload', site], ['reload', site], ['reload', site]]);
  } finally { sessions.delete(site); }
});

test('undo and redo reload the page, and tell the events seam only while someone listens', async () => {
  const api = core.cliApi();
  const site = makeSite('<h1>Hi</h1>');
  const file = path.join(site, 'index.html');
  historyFor(site).undo.push({ file, relFile: 'index.html', prev: '<h1>Hello</h1>', next: '<h1>Hi</h1>' });
  try {
    assert.deepEqual(await api.undo(site), { ok: true, relFile: 'index.html' });
    assert.equal(fs.readFileSync(file, 'utf8'), '<h1>Hello</h1>');
    assert.deepEqual(heard(), [], 'nobody listens: no timeline to update');
    assert.equal(projectState.get(site).undoHistory?.redo.length, 1, 'the history is saved all the same');
    fake.listening = true;
    assert.deepEqual(await api.redo(site), { ok: true, relFile: 'index.html' });
    assert.equal(fs.readFileSync(file, 'utf8'), '<h1>Hi</h1>');
    assert.deepEqual(heard(), [{ channel: 'history:state', payload: { repoDir: site, action: 'redo', relFile: 'index.html', timeline: [{ relFile: 'index.html' }], cursor: 1, total: 1, canUndo: true, canRedo: false } }]);
    assert.deepEqual(take(), [['reload', site], ['reload', site]], 'each one reloads the preview');
  } finally { fake.listening = false; }
});

test('closing asks the viewer, and when no window closes the tab the core stops the session itself', async () => {
  const api = core.cliApi();
  const site = makeSite();
  holdOpen(site);
  try {
    fake.close = { ok: true };
    assert.deepEqual(await api.close(site, { yes: true }), { state: 'closed' });
    assert.equal(sessions.has(site), true, 'a window that closed the tab stops the session itself (project:close)');
    fake.close = { ok: false, code: 'timeout', error: 'The window did not answer in time.' };
    assert.deepEqual(await api.close(site, { yes: true }), { state: 'closed' });
    assert.equal(sessions.has(site), false, 'no window answered: the core stopped the session');
    assert.deepEqual(take(), [['close', site], ['close', site]]);
  } finally { sessions.delete(site); }
});

test('the agent lane’s start, send and Home go to the viewer with the request whole', async () => {
  const api = core.cliApi();
  const site = makeSite();
  fake.agent = { ok: true, id: 't1', label: 'Agent', engine: 'claude', submitted: true, landed: true, reused: false, startedAt: 1 };
  assert.deepEqual(await api.agentStart(site, { task: 'Fix the header', submit: true, engine: 'claude', label: null }), fake.agent);
  fake.agentSend = { ok: false, code: 'not-found', error: 'No session t9.' };
  assert.deepEqual(await api.agentSend('t9', { text: 'yes', submit: true }), fake.agentSend);
  fake.home = { ok: true, id: 'h1', engine: 'shell', started: true };
  assert.deepEqual(await api.home({ engine: 'shell' }), fake.home);
  assert.deepEqual(take(), [
    ['agentStart', { repoDir: site, task: 'Fix the header', submit: true, engine: 'claude', label: null }],
    ['agentSend', { id: 't9', text: 'yes', submit: true }],
    ['home', { engine: 'shell' }],
  ]);
});

test('a migration’s agent starts in the viewer’s task chat when it runs chats, and in a terminal otherwise', async () => {
  const api = core.cliApi();
  const site = makeSite();
  const task = 'Migrate example.com';
  const terminalAgent = { repoDir: site, task, submit: true, engine: 'codex', label: 'Migration' };
  // No chats: the window starts a terminal agent on the task, its label Migration.
  fake.agent = { ok: true, id: 't2', label: 'Migration', engine: 'codex', submitted: true, landed: true, reused: false, startedAt: 1 };
  assert.deepEqual(await api.migrateLaunch({ dir: site, engine: 'codex', task, chatId: 'c1' }), { ok: true, engine: 'codex', session: 't2' });
  fake.agent = { ok: false, code: 'no-engine', error: 'Codex is not installed.' };
  assert.deepEqual(await api.migrateLaunch({ dir: site, engine: 'codex', task, chatId: null }), { ok: false, code: 'no-engine', error: 'Codex is not installed.' });
  assert.deepEqual(take(), [['agentStart', terminalAgent], ['agentStart', terminalAgent]]);

  // Chats on: the task chat migratePrepare made starts, and its title names the session.
  let failure: Error | null = null;
  fake.chats = {
    parkIdle: async () => [],
    inputBlock: () => null,
    terminalData() {},
    terminalExited() {},
    createTaskChat() { throw new Error('Not in this test.'); },
    async startTaskChat(id) { asked.push(['startTaskChat', id]); if (failure) throw failure; return { title: task }; },
  };
  try {
    assert.deepEqual(await api.migrateLaunch({ dir: site, engine: 'claude', task, chatId: 'c1' }), { ok: true, engine: 'claude', session: task, chatId: 'c1' });
    failure = new Error('No chat c1.');
    assert.deepEqual(await api.migrateLaunch({ dir: site, engine: 'claude', task, chatId: 'c1' }), { ok: false, code: 'error', error: 'No chat c1.' });
    // Prepared without a chat: a terminal agent all the same.
    fake.agent = { ok: true, id: 't3', label: 'Migration', engine: 'claude', submitted: true, landed: true, reused: false, startedAt: 1 };
    assert.deepEqual(await api.migrateLaunch({ dir: site, engine: 'claude', task, chatId: null }), { ok: true, engine: 'claude', session: 't3' });
    assert.deepEqual(take(), [['startTaskChat', 'c1'], ['startTaskChat', 'c1'], ['agentStart', { ...terminalAgent, engine: 'claude' }]]);
  } finally { fake.chats = null; }
});

test('keep-awake asks the platform to hold the machine awake while a kept-awake agent lives', async () => {
  const pty = (id: string, alive: boolean, keepAwake: boolean): PtyInfo => ({ id, repoDir: '/site', meta: { keepAwake }, alive });
  await syncKeepAwake([pty('a', true, false), pty('b', true, true)]);
  await syncKeepAwake([pty('a', true, false), pty('b', false, true)]);
  await syncKeepAwake([]);
  assert.deepEqual(take(), [['keepAwake', true], ['keepAwake', false], ['keepAwake', false]]);
});

test('a move asks its host for the folder, never for a running project, and follows the project', async () => {
  const site = makeSite();
  const into = tmpDir('radial-core-dest-');
  let picks = 0;
  const pick = (folder: string | null) => async () => { picks++; return folder; };
  holdOpen(site, { running: true });
  try {
    assert.deepEqual(await core.moveProject(site, pick(into)), { ok: false, error: 'Close the project before moving it.' });
    assert.equal(picks, 0, 'no folder picker for a running project');
  } finally { sessions.delete(site); }
  assert.deepEqual(await core.moveProject(site, pick(null)), { ok: false, cancelled: true });
  recents.addRecent(site, 'Site');
  const moved = path.join(into, 'site');
  assert.deepEqual(await core.moveProject(site, pick(into)), { ok: true, newDir: moved });
  assert.equal(picks, 2);
  assert.ok(fs.existsSync(path.join(moved, 'index.html')) && !fs.existsSync(site));
  assert.equal(recents.listRecents()[0].path, moved, 'the recent project follows the move');
});
