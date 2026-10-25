// radial serve end to end (plans/headless-core.md phase 2a): the core under
// plain Node with no window and no browser, no Electron anywhere, driven
// through the real `radial` CLI (bin/radial's Node branch) and `radial mcp`.
// PLAYWRIGHT_BROWSERS_PATH points at an empty folder, so serve has no browser
// whatever this machine has cached (test/headlessBrowser.e2e.mts runs one).
// A scratch data dir (RADIAL_USERDATA, so the PTY daemon goes with serve), a
// static site and a tiny `"dev": "node server.js"` site, each a git repo, and a
// file:// bare remote:
//   serve starts in the background, and a second serve on its data dir refuses;
//   open, url, and the preview serves the page, for both sites;
//   edit text --find, and the preview shows the new text;
//   comments add, list and resolve over MCP (tools/list is the CLI's verbs);
//   status shows the change; moments record, restore --yes; undo;
//   publish --to branch pushes to the bare remote, whose tree has no .radial/;
//   restart gives a new URL; capture takes no screenshots and says so;
//   shot and field ids refuse with radial browser install, and what to do
//   meanwhile; radial browser says none is installed; close;
//   serve stop leaves no dev server, no socket, no daemon and no pid file.
// And its agent lane (phase 2b), with a stand-in for Claude Code first on PATH
// (test/fixtures/fake-claude.cjs, agentLane.e2e.mts's scenarios):
//   agent start --submit, then wait: the bell, with the task on screen;
//   send, output, list and kill; a staged start leaves the prompt unsent;
//   a CLI asking its own question (an untrusted folder) gets nothing typed;
//     agent question reads it and its id, agent answer refuses without the id
//     and the yes and answers with both (and over MCP with expect and confirm),
//     and the task runs, or waits in its input; answering a session that isn't
//     asking is refused;
//   radial sleep parks an idle Claude session but not a kept-awake one, and
//     agent send wakes the parked one with --resume and delivers the text;
//   home, and `radial` inside a session's terminal reaching serve;
//   serve stop leaves no daemon and no agent behind (a throwaway data dir).
// `npm run test:headless`; also part of `npm run test:e2e`. Runs on macOS and Linux.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { test } from 'node:test';
import { execFile, execFileSync, spawn } from 'node:child_process';
import type { ErrorReply } from '../src/main/cliProto.ts';
import type { OpName, OpReplies } from '../src/main/cliServer.ts';
import type { ServeReply } from '../src/headless/serve.ts';

const ROOT = path.join(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'bin', 'radial');

/** A `radial …` run: its exit code and output. */
interface CliRun { code: number; stdout: string; stderr: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(label: string, ms: number, fn: () => T | Promise<T>): Promise<NonNullable<T>> {
  const t0 = Date.now(); let last: unknown;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last as NonNullable<T>; } catch (e) { last = (e as Error).message; } await sleep(200); }
  throw new Error(`timeout: ${label} (${JSON.stringify(last)})`);
}
/** GET a URL: its status and body, or null when nothing answers. */
function get(url: string): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { agent: false }, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode || 0, body })); });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}
/** Whether a process is there (a zombie isn't). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
}
const git = (cwd: string, args: string[]) => String(execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], { cwd, encoding: 'utf8' })).trim();

/** One `radial mcp` session: JSON-RPC requests over stdio, answered by id. */
function mcpSession(env: NodeJS.ProcessEnv) {
  const child = spawn('/bin/sh', [CLI, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const answers = new Map<number, Record<string, unknown>>();
  let buf = '', seq = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => { buf += d; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { const m = JSON.parse(line) as { id: number }; answers.set(m.id, m); } } });
  const call = async (method: string, params: unknown = {}) => {
    const id = ++seq;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return until(`mcp ${method}`, 60000, () => answers.get(id)) as Promise<{ result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean }; error?: unknown }>;
  };
  return { call, close: () => { child.stdin.end(); child.kill(); } };
}

test('radial serve: open, edit, comments, status, moments, undo, publish, restart and close, through the CLI and MCP with no window and no browser', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
  const data = path.join(scratch, 'data');
  const env: NodeJS.ProcessEnv = { ...process.env, RADIAL_CLI_FLAVOR: 'headless', RADIAL_USERDATA: data, RADIAL_AUTO_RELOAD: '0', RADIAL_NO_CAFFEINATE: '1', PLAYWRIGHT_BROWSERS_PATH: path.join(scratch, 'no-browsers') };
  for (const k of ['RADIAL_CLI_SOCK', 'RADIAL_DATA_DIR', 'RADIAL_CLI_APP', 'RADIAL_CLI_APP_ARG', 'ELECTRON_RUN_AS_NODE']) delete env[k];
  const radial = (args: string[], timeout = 180000) => new Promise<CliRun>((resolve) => execFile('/bin/sh', [CLI, ...args], { env, encoding: 'utf8', timeout }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
  // K names the socket op whose reply R the run prints with --json (or an ErrorReply when it fails); nothing checks either.
  const json = async <K extends OpName, R = OpReplies[K]>(args: string[]) => { const r = await radial([...args, '--json']); let j: R | null = null; try { j = JSON.parse(r.stdout); } catch {} return { ...r, json: j! }; };
  const serve = async (args: string[]) => { const r = await radial(['serve', ...args, '--json']); let j: ServeReply | null = null; try { j = JSON.parse(r.stdout); } catch {} return { ...r, json: j! }; };

  // The static site, its bare remote, and the node site.
  const site = path.join(scratch, 'site'); fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><html><head><title>Fixture site</title></head><body><h1>Welcome home</h1><p>Some body copy.</p></body></html>');
  fs.writeFileSync(path.join(site, 'about.html'), '<!doctype html><html><head><title>About</title></head><body><h1>About us</h1></body></html>');
  git(site, ['init', '-q', '-b', 'main']); git(site, ['add', '-A']); git(site, ['commit', '-q', '-m', 'init']);
  const remote = path.join(scratch, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(site, ['remote', 'add', 'origin', 'file://' + remote]); git(site, ['push', '-q', 'origin', 'main']);
  const app = path.join(scratch, 'app'); fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'app', private: true, scripts: { dev: 'node server.js' } }, null, 2));
  fs.writeFileSync(path.join(app, 'server.js'), "const http = require('http'), fs = require('fs');\nconst port = Number(process.env.PORT) || 3000;\nhttp.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(__dirname + '/index.html')); }).listen(port, '127.0.0.1', () => console.log('Listening on http://127.0.0.1:' + port + '/'));\n");
  fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><html><head><title>App</title></head><body><h1>Hello from node</h1></body></html>');
  fs.writeFileSync(path.join(app, '.gitignore'), 'node_modules/\n');
  fs.mkdirSync(path.join(app, 'node_modules')); // nothing to install: the dev script uses Node alone
  git(app, ['init', '-q', '-b', 'main']); git(app, ['add', '-A']); git(app, ['commit', '-q', '-m', 'init']);

  let mcp: ReturnType<typeof mcpSession> | null = null;
  let corePid = 0;
  try {
    // 1. serve starts in the background; a second one on the same data dir refuses.
    const started = await serve(['--detach']);
    assert.equal(started.code, 0, started.stderr + started.stdout);
    assert.ok(started.json.ok && started.json.state === 'started', JSON.stringify(started.json));
    corePid = started.json.ok ? started.json.pid! : 0;
    assert.equal(fs.readFileSync(path.join(data, 'core.pid'), 'utf8').trim(), String(corePid), 'the pid file names the serve');
    assert.ok(fs.existsSync(path.join(data, 'logs', 'core.log')), 'it logs to the data dir');
    const status = await serve(['status']);
    assert.equal(status.code, 0); assert.ok(status.json.ok && status.json.state === 'running' && status.json.pid === corePid);
    const again = await serve(['--detach']);
    assert.equal(again.code, 6, again.stdout + again.stderr); assert.ok(!again.json.ok && again.json.code === 'in-use' && again.json.pid === corePid);
    const foreground = await radial(['serve'], 30000);
    assert.equal(foreground.code, 6, 'a second serve in the foreground refuses too');
    assert.match(foreground.stdout, new RegExp(`Radial is already running on .* \\(pid ${corePid}\\)\\. \`radial serve stop\` stops it\\.`));
    const hello = await radial([]);
    assert.equal(hello.code, 0); assert.match(hello.stdout, /running without a window \(radial serve\)/);

    // 2. open, url, and the preview serves the page: the static site and the node one.
    const opened = await json<'open'>(['open', site]);
    assert.equal(opened.code, 0, opened.stderr); assert.equal(opened.json.state, 'opened'); assert.match(opened.json.url!, /^http:\/\/(127\.0\.0\.1|localhost):\d+\//);
    const url = opened.json.url!;
    assert.equal((await json<'url'>(['url', site])).json.url, url);
    assert.match((await get(url))!.body, /Welcome home/);
    assert.match(fs.readFileSync(path.join(site, '.git', 'info', 'exclude'), 'utf8'), /^\.radial\/$/m, 'the open-time preparation keeps .radial/ out of git');
    const appOpened = await json<'open'>(['open', app]);
    assert.equal(appOpened.code, 0, appOpened.stderr);
    const appUrl = appOpened.json.url!;
    assert.match((await get(appUrl))!.body, /Hello from node/, 'the node site’s own dev script serves it');
    const ls = await json<'ls'>(['ls']);
    assert.deepEqual(ls.json.projects.map((p) => p.repoDir).sort(), [app, site].sort());

    // 3. edit text --find, and the preview shows it (static and node).
    const edit = await json<'editText'>(['edit', 'text', site, '--find', 'Welcome home', '--to', 'Hello from serve']);
    assert.equal(edit.code, 0, edit.stderr); assert.equal(edit.json.relFile, 'index.html');
    assert.match((await get(url))!.body, /Hello from serve/);
    assert.equal((await json<'editText'>(['edit', 'text', app, '--find', 'Hello from node', '--to', 'Changed by serve'])).code, 0);
    assert.match((await get(appUrl))!.body, /Changed by serve/);

    // 4. comments add, list and resolve, over MCP; its tools are the CLI's verbs.
    mcp = mcpSession(env);
    assert.ok((await mcp.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'e2e' } })).result);
    const tools = (await mcp.call('tools/list')).result!.tools!;
    assert.ok(tools.length >= 40 && tools.some((t) => t.name === 'add_comment') && !tools.some((t) => t.name === 'serve'), `tools: ${tools.length}`);
    const added = await mcp.call('tools/call', { name: 'add_comment', arguments: { project: site, text: 'Make the hero bigger', route: '/' } });
    assert.equal(added.result!.isError, false, JSON.stringify(added));
    const comment = (JSON.parse(added.result!.content![0].text) as OpReplies['commentAdd'] & { comment: { id: string } }).comment;
    const listed = JSON.parse((await mcp.call('tools/call', { name: 'list_comments', arguments: { project: site, open: true } })).result!.content![0].text) as OpReplies['comments'];
    assert.deepEqual(listed.comments.map((c) => c.text), ['Make the hero bigger']);
    const resolved = await mcp.call('tools/call', { name: 'resolve_comment', arguments: { project: site, id: comment.id } });
    assert.equal(resolved.result!.isError, false, JSON.stringify(resolved));
    assert.equal((await json<'comments'>(['comments', site, '--open'])).json.comments.length, 0, 'the CLI sees it resolved');
    const noShot = await mcp.call('tools/call', { name: 'screenshot', arguments: { project: site } });
    assert.equal(noShot.result!.isError, true); assert.match(noShot.result!.content![0].text, /^no-browser: .*\nFix: radial browser install\nInstead: radial url /);

    // 5. status shows the change.
    const st = await json<'status'>(['status', site]);
    const repo = st.json.git;
    assert.equal(st.code, 0); assert.equal(st.json.open, true);
    assert.ok(repo && repo.ok, JSON.stringify(repo));
    assert.equal(repo.branch, 'main');
    assert.ok(repo.changes.some((c) => c.file === 'index.html'), JSON.stringify(repo));

    // 6. moments record, then restore with --yes; undo.
    const rec = await json<'momentRecord', Extract<OpReplies['momentRecord'], { moment: unknown }>>(['moments', 'record', site, '--label', 'Hello from serve']);
    assert.equal(rec.code, 0, rec.stderr + rec.stdout); assert.equal(rec.json.moment.label, 'Hello from serve');
    assert.equal((await radial(['edit', 'text', site, '--find', 'Hello from serve', '--to', 'Goodbye'])).code, 0);
    assert.match((await get(url))!.body, /Goodbye/);
    assert.equal((await radial(['moments', 'restore', site, rec.json.moment.id])).code, 6, 'restore needs --yes');
    const restored = await json<'momentRestore'>(['moments', 'restore', site, rec.json.moment.id, '--yes']);
    assert.equal(restored.code, 0, restored.stderr + restored.stdout);
    assert.match((await get(url))!.body, /Hello from serve/, 'the moment is back');
    assert.equal((await radial(['edit', 'text', site, '--find', 'Hello from serve', '--to', 'Howdy'])).code, 0);
    assert.match((await get(url))!.body, /Howdy/);
    const undo = await json<'undo'>(['undo', site]);
    assert.equal(undo.code, 0, undo.stderr + undo.stdout); assert.equal(undo.json.relFile, 'index.html');
    assert.match((await get(url))!.body, /Hello from serve/, 'undo put the text back');

    // 7. publish --to branch: the bare remote gets the commit, and no .radial/. The checkout is on main, the
    // production branch, so the push goes live: it needs --yes like --to production, and nothing moves without it.
    const remoteMain = () => String(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' })).trim();
    const beforePublish = remoteMain();
    const unconfirmed = await json<'publish'>(['publish', site, '--to', 'branch', '--message', 'Edits from radial serve']);
    assert.equal(unconfirmed.code, 6, unconfirmed.stderr + unconfirmed.stdout); assert.match(unconfirmed.stderr + unconfirmed.stdout, /main is this project's production branch/);
    assert.equal(remoteMain(), beforePublish, 'nothing pushed without --yes');
    const pub = await json<'publish'>(['publish', site, '--to', 'branch', '--message', 'Edits from radial serve', '--yes']);
    assert.equal(pub.code, 0, pub.stderr + pub.stdout); assert.equal(pub.json.pushed, true, JSON.stringify(pub.json));
    const pushed = String(execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' })).split('\n').filter(Boolean);
    assert.ok(pushed.includes('index.html'), pushed.join(', '));
    assert.equal(pushed.filter((p) => p === '.radial' || p.startsWith('.radial/')).length, 0, `the pushed tree has no .radial/: ${pushed.join(', ')}`);
    assert.match(String(execFileSync('git', ['--git-dir', remote, 'show', 'main:index.html'], { encoding: 'utf8' })), /Hello from serve/);
    assert.equal(String(execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'main'], { encoding: 'utf8' })).trim(), 'Edits from radial serve');

    // 8. restart gives a new URL, which serves; the old one is gone.
    const restarted = await json<'restart'>(['restart', site]);
    assert.equal(restarted.code, 0, restarted.stderr); assert.ok(restarted.json.url && restarted.json.url !== url, `${url} → ${restarted.json.url}`);
    const url2 = restarted.json.url!;
    assert.match((await get(url2))!.body, /Hello from serve/);
    assert.equal(await get(url), null, 'the old server stopped');

    // 9. A migration capture with no browser takes no screenshots and says so; page work refuses with what to do instead.
    const capture = await radial(['migrate', 'capture', url2, '--project', app]);
    assert.equal(capture.code, 0, capture.stderr + capture.stdout);
    assert.match(capture.stdout, /no reference screenshots \(no browser yet: radial browser install adds one\)/);
    const shot = await radial(['shot', site]);
    assert.equal(shot.code, 6); assert.match(shot.stderr, /no browser for its projects' pages yet \(radial serve\)[^\n]*\n  Fix: radial browser install\n  Instead: radial url /);
    const field = await radial(['edit', 'text', site, '--field', 'f1', '--to', 'x']);
    assert.equal(field.code, 6); assert.match(field.stderr, /Instead: radial edit text .* --find "<current text>"/);
    const none = await radial(['browser', '--json']);
    assert.equal(none.code, 1, 'radial browser: not installed');
    assert.equal((JSON.parse(none.stdout) as { installed: boolean }).installed, false);

    // 10. close: the project goes, and so does its server.
    const closed = await json<'close'>(['close', site]);
    assert.equal(closed.code, 0, closed.stderr); assert.equal(closed.json.state, 'closed');
    assert.deepEqual((await json<'ls'>(['ls'])).json.projects.map((p) => p.repoDir), [app]);
    assert.equal(await get(url2), null, 'the closed project’s server stopped');

    // 11. serve stop: no dev server, no socket, no daemon, no pid file; and no telemetry state was made.
    mcp.close(); mcp = null;
    const stopped = await serve(['stop']);
    assert.equal(stopped.code, 0, stopped.stderr + stopped.stdout); assert.ok(stopped.json.ok && stopped.json.state === 'stopped');
    assert.equal(alive(corePid), false, 'the serve exited');
    assert.equal(await get(appUrl), null, 'the node site’s dev server stopped with it');
    assert.equal(fs.existsSync(path.join(data, 'cli.sock')), false, 'no control socket');
    await until('the daemon goes', 10000, () => !fs.existsSync(path.join(data, 'term-daemon.sock')));
    assert.equal(fs.existsSync(path.join(data, 'core.pid')), false, 'no pid file');
    assert.equal(fs.existsSync(path.join(data, 'radial-telemetry.json')), false, 'telemetry stayed off');
    const log = fs.readFileSync(path.join(data, 'logs', 'core.log'), 'utf8');
    assert.match(log, /is running without a window/); assert.match(log, /Stopping \(SIGTERM\)/); assert.match(log, /Stopped\./);
    assert.match(log, /No browser yet, so screenshots, page fields and migration compares refuse\. `radial browser install` adds one, with no restart\./);
    assert.equal((await serve(['status'])).code, 4, 'status: not running');
  } finally {
    mcp?.close();
    if (corePid && alive(corePid)) { await radial(['serve', 'stop'], 60000); try { process.kill(corePid, 'SIGKILL'); } catch {} }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

/** What the stand-in CLIs logged (test/fixtures/fake-claude.cjs): each one that started, in its folder, and what reached it. */
interface CliEvent { pid: number; cwd: string; event: 'start' | 'resumed' | 'submit' | 'typed-into-question' | 'declined' | 'trusted' | 'run' | 'draft'; task?: string | null; sessionId?: string | null; resume?: string | null; home?: boolean; session?: string; found?: boolean; text?: string }

test('radial serve agent lane: start and wait, send, output, list and kill; staged; a CLI asking its own question, read and answered; a parked session woken by send; Home; no agents left after stop', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rha-'));
  const data = path.join(scratch, 'data');
  const bin = path.join(scratch, 'bin'); fs.mkdirSync(bin);
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'fake-claude.cjs'), path.join(bin, 'claude'));
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const cliLog = path.join(scratch, 'fake-cli.jsonl');
  // Home's folder is the projects folder: a scratch one, never ~/Radial.
  const projects = path.join(scratch, 'projects'); fs.mkdirSync(projects);
  fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'radial-store.json'), JSON.stringify({ projectsDir: projects, recents: [], session: { open: [], active: null } }));
  // Idle a second, a Claude session can be put to sleep (RADIAL_AGENT_IDLE_MS, a test seam); Claude keeps its sessions in the scratch dir;
  // a zsh shell skips the person's own startup files (ZDOTDIR), which can take seconds to draw a prompt.
  const zdot = path.join(scratch, 'zdot'); fs.mkdirSync(zdot);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RADIAL_CLI_FLAVOR: 'headless', RADIAL_USERDATA: data, RADIAL_AUTO_RELOAD: '0', RADIAL_NO_CAFFEINATE: '1', CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'), RADIAL_FAKE_CLI_LOG: cliLog, RADIAL_AGENT_IDLE_MS: '1000', ZDOTDIR: zdot, PLAYWRIGHT_BROWSERS_PATH: path.join(scratch, 'no-browsers') };
  for (const k of ['RADIAL_CLI_SOCK', 'RADIAL_DATA_DIR', 'RADIAL_CLI_APP', 'RADIAL_CLI_APP_ARG', 'ELECTRON_RUN_AS_NODE']) delete env[k];
  const radial = (args: string[], timeout = 180000) => new Promise<CliRun>((resolve) => execFile('/bin/sh', [CLI, ...args], { env, encoding: 'utf8', timeout }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
  const json = async <K extends OpName, R = OpReplies[K]>(args: string[]) => { const r = await radial([...args, '--json']); let j: R | null = null; try { j = JSON.parse(r.stdout); } catch {} return { ...r, json: j! }; };
  const events = (): CliEvent[] => { try { return fs.readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as CliEvent); } catch { return []; } };
  const inFolder = (dir: string) => events().filter((e) => e.cwd === fs.realpathSync(dir));
  const live = async (dir: string) => (await json<'agentList'>(['agent', 'list', dir])).json.agents.filter((a) => a.alive).map((a) => a.id);
  const output = async (id: string) => (await json<'agentOutput'>(['agent', 'output', id])).json.text;
  const daemonSock = path.join(data, 'term-daemon.sock');
  // Static sites, each a git repo; two that Claude Code doesn't trust yet.
  const makeSite = (name: string, { untrusted = false } = {}) => {
    const dir = path.join(scratch, name); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><head><title>${name}</title></head><body><h1>${name}</h1></body></html>`);
    if (untrusted) fs.writeFileSync(path.join(dir, 'UNTRUSTED'), 'Claude Code has not been told to trust this folder.\n');
    git(dir, ['init', '-q', '-b', 'main']); git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'init']);
    return dir;
  };
  const site = makeSite('site'), asked = makeSite('asked', { untrusted: true }), staged = makeSite('staged', { untrusted: true });

  let corePid = 0;
  let mcp: ReturnType<typeof mcpSession> | null = null;
  try {
    const started = await radial(['serve', '--detach', '--json']);
    assert.equal(started.code, 0, started.stderr + started.stdout);
    corePid = (JSON.parse(started.stdout) as Extract<ServeReply, { ok: true }>).pid!;

    // 1. agent start --submit on a project that isn't open: it opens, and a session starts with the task as its first prompt; wait hears the bell.
    const start = await json<'agentStart'>(['agent', 'start', site, 'Fix the hero', '--submit', '--label', 'Hero fix']);
    assert.equal(start.code, 0, start.stderr + start.stdout);
    assert.deepEqual([start.json.engine, start.json.label, start.json.submitted, start.json.landed, start.json.reused, start.json.waiting], ['claude', 'Hero fix', true, true, false, undefined]);
    const id = start.json.id;
    const wait = await json<'agentWait'>(['agent', 'wait', id, '--timeout', '20']);
    assert.equal(wait.code, 0, wait.stderr); assert.equal(wait.json.reason, 'bell', JSON.stringify(wait.json));
    assert.match(wait.json.text, /TASK: Fix the hero/, 'the task is on screen');
    const first = inFolder(site).find((e) => e.event === 'start')!;
    assert.equal(first.task, 'Fix the hero', 'the task rode as the CLI’s first prompt');
    assert.ok(first.sessionId, 'pinned to a session id, so it can sleep and resume');

    // 2. send, then output: the follow-up was submitted, and its answer rang the bell.
    const sent = await json<'agentSend'>(['agent', 'send', id, 'Also fix the footer']);
    assert.equal(sent.code, 0, sent.stderr + sent.stdout);
    assert.deepEqual([sent.json.id, sent.json.submitted, sent.json.landed], [id, true, true]);
    const answered = await json<'agentWait'>(['agent', 'wait', id, '--timeout', '20']);
    assert.equal(answered.json.reason, 'bell', JSON.stringify(answered.json)); assert.match(answered.json.text, /SUBMITTED: Also fix the footer/);
    const out = await radial(['agent', 'output', id, '--lines', '3']);
    assert.equal(out.code, 0); assert.match(out.stdout, /SUBMITTED: Also fix the footer/);

    // 3. A staged start: the prompt is in the CLI's input, unsent. list sees both; kill needs --yes.
    const draft = await json<'agentStart'>(['agent', 'start', site, 'Rewrite the footer']);
    assert.equal(draft.code, 0, draft.stderr + draft.stdout);
    assert.deepEqual([draft.json.submitted, draft.json.landed, draft.json.waiting], [false, true, undefined]);
    await sleep(1000);
    const screen = await output(draft.json.id);
    assert.match(screen, /Rewrite the footer/, 'the prompt is in the terminal'); assert.ok(!/SUBMITTED: Rewrite/.test(screen), 'and was not submitted');
    assert.ok(!inFolder(site).some((e) => e.event === 'submit' && e.text === 'Rewrite the footer'));
    const list = await json<'agentList'>(['agent', 'list', site]);
    assert.deepEqual(list.json.agents.filter((a) => a.alive && a.engine === 'claude').map((a) => a.id).sort(), [id, draft.json.id].sort());
    assert.ok(list.json.agents.some((a) => a.id === id && a.label === 'Hero fix' && a.lastBellAt! > 0), JSON.stringify(list.json.agents));
    assert.equal((await radial(['agent', 'kill', draft.json.id])).code, 6, 'kill needs --yes');
    assert.equal((await radial(['agent', 'kill', draft.json.id, '--yes'])).code, 0);
    await until('the staged session ends', 10000, async () => !(await live(site)).includes(draft.json.id));
    assert.equal((await radial(['agent', 'output', draft.json.id])).code, 3, 'a session that ended is not found');

    // 4. A CLI asking its own question (an untrusted folder) gets nothing typed. Submitted, the task is its first prompt and runs once the folder is trusted.
    const ask = await json<'agentStart'>(['agent', 'start', asked, 'Fix the hero', '--submit']);
    assert.equal(ask.code, 0, ask.stderr + ask.stdout);
    assert.deepEqual([ask.json.submitted, ask.json.waiting], [true, true], 'the reply says its CLI is asking a question of its own');
    assert.match(await output(ask.json.id), /Yes, I trust this folder/, 'agent output shows the question');
    //    agent question reads it: its words, its two options as listed, the focus on "No, exit". agent wait says it asks.
    const question = await json<'agentQuestion'>(['agent', 'question', ask.json.id]);
    assert.equal(question.code, 0, question.stderr + question.stdout);
    assert.deepEqual([question.json.asking, question.json.question!.options.map((o) => o.label), question.json.question!.focused, question.json.question!.takes], [true, ['No, exit', 'Yes, I trust this folder'], 1, 'option']);
    assert.match(question.json.question!.text, /Quick safety check: Is this a project you created or one you trust\?/);
    const qid = question.json.question!.id;
    const shown = await radial(['agent', 'question', ask.json.id]);
    assert.ok(shown.stdout.endsWith(`\n  1. No, exit (focused)\n  2. Yes, I trust this folder\nAnswer: radial agent answer ${ask.json.id} <number or label> --expect ${qid} --yes\n`), shown.stdout);
    assert.equal((await json<'agentWait'>(['agent', 'wait', ask.json.id, '--timeout', '1'])).json.asking, true, 'agent wait says its CLI asks');
    //    Without the question's id or the yes, the answer is refused, saying what it would answer; nothing is typed.
    const unnamed = await radial(['agent', 'answer', ask.json.id, 'Yes, I trust this folder', '--yes']);
    assert.equal(unnamed.code, 6, unnamed.stderr + unnamed.stdout);
    assert.ok(unnamed.stderr.endsWith(`\nAn answer names the question it is for: pass --expect ${qid}, with --yes once the person agrees to answer it with "Yes, I trust this folder".\n`), unnamed.stderr);
    const unconfirmed = await radial(['agent', 'answer', ask.json.id, 'Yes, I trust this folder', '--expect', qid]);
    assert.equal(unconfirmed.code, 6, unconfirmed.stderr + unconfirmed.stdout);
    assert.match(unconfirmed.stderr, new RegExp(`CLI asks:\\n[\\s\\S]*Answering it with "Yes, I trust this folder" goes into its CLI as if you typed it at its terminal[\\s\\S]*Pass --yes to confirm, with --expect ${qid} so the answer goes only to this question\\.`));
    assert.equal((await radial(['agent', 'answer', ask.json.id, 'Yes'])).code, 2, 'an answer that is none of its options');
    await sleep(1000); // anything typed would have reached the question by now
    assert.deepEqual(inFolder(asked).map((e) => [e.event, e.task]), [['start', 'Fix the hero']], 'nothing typed into the question, nothing answered');
    //    With both: the arrow down to "Yes, I trust this folder", then Enter. The folder is trusted, and the task runs.
    assert.equal((await radial(['agent', 'answer', ask.json.id, 'Yes, I trust this folder', '--expect', 'q000000000000', '--yes'])).code, 6, 'named for another question: nothing typed');
    const trusted = await json<'agentAnswer'>(['agent', 'answer', ask.json.id, 'Yes, I trust this folder', '--expect', qid, '--yes']);
    assert.equal(trusted.code, 0, trusted.stderr + trusted.stdout);
    assert.deepEqual([trusted.json.chose, trusted.json.after, trusted.json.next], [{ number: 2, label: 'Yes, I trust this folder' }, 'gone', null]);
    await until('the task runs once the folder is trusted', 10000, () => inFolder(asked).some((e) => e.event === 'run' && e.text === 'Fix the hero'));
    assert.deepEqual(inFolder(asked).map((e) => e.event), ['start', 'trusted', 'run']);
    //    Its CLI at its prompt now: agent question says it isn't asking, and an answer is refused with what its screen shows. Nothing is typed.
    assert.equal((await json<'agentQuestion'>(['agent', 'question', ask.json.id])).json.asking, false);
    const notAsking = await radial(['agent', 'answer', ask.json.id, '2', '--yes']);
    assert.equal(notAsking.code, 6, notAsking.stderr + notAsking.stdout);
    assert.match(notAsking.stderr, /isn't asking a question of its own\. Its screen shows:\n[\s\S]*TASK: Fix the hero[\s\S]*\nTo type into its prompt, use `radial agent send`\.\n$/);
    await sleep(500);
    assert.deepEqual(inFolder(asked).map((e) => e.event), ['start', 'trusted', 'run'], 'nothing typed into its prompt');
    //    Staged, nothing goes in while it asks. Answered over MCP by its number, once confirmed, the task waits in its input, unsent.
    const later = await json<'agentStart'>(['agent', 'start', staged, 'Rewrite the footer']);
    assert.equal(later.code, 0, later.stderr + later.stdout);
    assert.deepEqual([later.json.submitted, later.json.landed, later.json.waiting], [false, false, true]);
    await sleep(1500);
    assert.deepEqual(inFolder(staged).map((e) => e.event), ['start'], 'nothing typed into the question');
    mcp = mcpSession(env);
    assert.ok((await mcp.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'e2e' } })).result);
    const asking = (await mcp.call('tools/call', { name: 'agent_question', arguments: { id: later.json.id } })).result!;
    assert.match(asking.content![0].text, /is asking \(takes: option\):\n[\s\S]*\n1\. No, exit \(focused\)\n2\. Yes, I trust this folder\n/);
    const stagedQid = /expect: "(q[0-9a-f]{12})"/.exec(asking.content![0].text)![1];
    const unconfirmedMcp = (await mcp.call('tools/call', { name: 'agent_answer', arguments: { id: later.json.id, answer: '2' } })).result!;
    assert.equal(unconfirmedMcp.isError, true);
    assert.ok(unconfirmedMcp.content![0].text.startsWith('needs-yes: ') && unconfirmedMcp.content![0].text.endsWith(`\nTo go ahead: ask the person, then call agent_answer again with confirm: true and expect: "${stagedQid}".`), unconfirmedMcp.content![0].text);
    assert.deepEqual(inFolder(staged).map((e) => e.event), ['start'], 'nothing typed without confirm');
    const confirmed = (await mcp.call('tools/call', { name: 'agent_answer', arguments: { id: later.json.id, answer: '2', expect: stagedQid, confirm: true } })).result!;
    assert.equal(confirmed.isError, false, confirmed.content![0].text);
    assert.match(confirmed.content![0].text, /^Chose "Yes, I trust this folder" \(2\) in \S+\. The question is gone: its CLI went on\./);
    mcp.close(); mcp = null;
    await until('the task in the CLI’s input', 15000, () => inFolder(staged).some((e) => e.event === 'draft' && e.text === 'Rewrite the footer'));
    await sleep(500);
    assert.deepEqual(inFolder(staged).filter((e) => e.event !== 'draft').map((e) => e.event), ['start', 'trusted'], 'not submitted, nothing typed into the question');

    // 5. radial sleep parks an idle Claude session but leaves a kept-awake one; send wakes the parked one with its conversation.
    const other = await json<'agentStart'>(['agent', 'start', site, 'Write the about page', '--submit']);
    assert.equal(other.code, 0, other.stderr + other.stdout);
    await json<'agentWait'>(['agent', 'wait', other.json.id, '--timeout', '20']);
    assert.equal((await radial(['agent', 'keep', id])).code, 0);
    await sleep(1500); // both idle past RADIAL_AGENT_IDLE_MS
    const slept = await json<'sleep'>(['sleep', site]);
    assert.equal(slept.code, 0, slept.stderr + slept.stdout);
    await until('the idle session is parked', 15000, async () => !(await live(site)).includes(other.json.id));
    assert.ok((await live(site)).includes(id), 'the kept-awake session is left running');
    const otherSession = inFolder(site).find((e) => e.event === 'start' && e.task === 'Write the about page')!.sessionId;
    // Two sends at once: one wakes it, the other waits for that and follows in the same session (never a second --resume).
    const texts = ['Pick up where you left off', 'Then the contact page'];
    const [woke, also] = await Promise.all(texts.map((text) => json<'agentSend'>(['agent', 'send', other.json.id, text])));
    assert.equal(woke.code, 0, woke.stderr + woke.stdout); assert.equal(also.code, 0, also.stderr + also.stdout);
    assert.equal(woke.json.resumedFrom, other.json.id); assert.notEqual(woke.json.id, other.json.id);
    assert.deepEqual([also.json.id, also.json.resumedFrom], [woke.json.id, other.json.id], 'both sends went to the one woken session');
    assert.deepEqual([woke.json.submitted, woke.json.landed, also.json.submitted, also.json.landed], [true, true, true, true]);
    const resumed = await until('the resumed CLI', 10000, () => inFolder(site).find((e) => e.event === 'start' && e.resume));
    assert.equal(resumed.resume, otherSession, 'claude --resume <its session>');
    assert.ok(texts.includes(resumed.task!), `one send's text is its next prompt: ${resumed.task}`);
    assert.equal(inFolder(site).find((e) => e.event === 'resumed')!.found, true, 'its conversation was there to resume');
    const second = texts.find((t) => t !== resumed.task)!;
    await until('the other text submitted in the same CLI', 15000, () => inFolder(site).some((e) => e.event === 'submit' && e.pid === resumed.pid && e.text === second));
    await sleep(500);
    assert.equal(inFolder(site).filter((e) => e.event === 'start' && e.resume).length, 1, 'woken once');
    const resumedWait = await json<'agentWait'>(['agent', 'wait', woke.json.id, '--timeout', '20']);
    assert.equal(resumedWait.json.reason, 'bell'); assert.match(resumedWait.json.text, new RegExp(`TASK: ${resumed.task}`));

    // 6. Home: a shell in the projects folder, the same one when asked again; `radial` in it reaches serve, as headless whatever it inherited.
    const home = await json<'home'>(['home', '--engine', 'shell']);
    assert.equal(home.code, 0, home.stderr + home.stdout); assert.deepEqual([home.json.engine, home.json.started], ['shell', true]);
    const again = await json<'home'>(['home']);
    assert.deepEqual([again.json.id, again.json.started], [home.json.id, false]);
    const ran = await json<'agentSend'>(['agent', 'send', home.json.id, 'RADIAL_CLI_FLAVOR=dev RADIAL_CLI_DRYRUN=1 radial ls; radial ls']);
    assert.equal(ran.code, 0, ran.stderr + ran.stdout);
    const shell = await until('the shell ran radial', 15000, async () => { const t = await output(home.json.id); return /out\/main\/cli\.js/.test(t) && /\bsite\b.*http:\/\/(127\.0\.0\.1|localhost):\d+|\bsite\b.*asleep/.test(t) ? t : null; });
    assert.ok(!/Electron/.test(shell), `the terminal's radial runs as headless, never as a Mac app's: ${shell}`);

    // 7. serve stop on a throwaway data dir: no daemon, and none of the agents it ran.
    const pids = [...new Set(events().map((e) => e.pid))];
    assert.ok(pids.length >= 5, `the stand-ins ran: ${pids.length}`);
    const stopped = await radial(['serve', 'stop', '--json']);
    assert.equal(stopped.code, 0, stopped.stderr + stopped.stdout);
    await until('the daemon goes', 10000, () => !fs.existsSync(daemonSock));
    await until('every agent goes', 10000, () => pids.every((pid) => !alive(pid)));
  } finally {
    mcp?.close();
    if (corePid && alive(corePid)) { await radial(['serve', 'stop'], 60000); try { process.kill(corePid, 'SIGKILL'); } catch {} }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
