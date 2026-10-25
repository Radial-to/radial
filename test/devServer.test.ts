import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as devServer from '../src/main/devServer';
import type { BuildResult, DevInfo, NodeProject, PackageJson, StaticProject } from '../src/main/devServer';
import { tmpDir } from './support/tmp';

function tmp(): string { return tmpDir('radial-ds-'); }
function writePkg(dir: string, pkg: PackageJson): void { fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg)); }

test('detectPackageManager honors the packageManager field first', () => {
  const dir = tmp();
  assert.equal(devServer.detectPackageManager(dir, { packageManager: 'pnpm@11.0.8' }), 'pnpm');
  assert.equal(devServer.detectPackageManager(dir, { packageManager: 'yarn@4.1.0' }), 'yarn');
});

test('detectPackageManager falls back to the lockfile', () => {
  const a = tmp(); fs.writeFileSync(path.join(a, 'pnpm-lock.yaml'), '');
  assert.equal(devServer.detectPackageManager(a, {}), 'pnpm');
  const b = tmp(); fs.writeFileSync(path.join(b, 'yarn.lock'), '');
  assert.equal(devServer.detectPackageManager(b, {}), 'yarn');
});

test('detectPackageManager defaults to npm with no signals', () => {
  assert.equal(devServer.detectPackageManager(tmp(), {}), 'npm');
});

test('the packageManager field wins over a conflicting lockfile', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'yarn.lock'), ''); // says yarn
  assert.equal(devServer.detectPackageManager(dir, { packageManager: 'pnpm@9' }), 'pnpm'); // field wins
});

test('detectProject recognizes a Next.js project and its dev script', () => {
  const dir = tmp();
  writePkg(dir, { name: 'site', scripts: { dev: 'next dev' }, dependencies: { next: '14.0.0' } });
  const p = devServer.detectProject(dir) as NodeProject;
  assert.equal(p.type, 'node');
  assert.equal(p.framework, 'next');
  assert.equal(p.devScript, 'dev');
  assert.equal(p.name, 'site');
});

test('detectProject recognizes Astro and prefers dev over start', () => {
  const dir = tmp();
  writePkg(dir, { scripts: { dev: 'astro dev', start: 'astro preview' }, dependencies: { astro: '4.0.0' } });
  const p = devServer.detectProject(dir) as NodeProject;
  assert.equal(p.framework, 'astro');
  assert.equal(p.devScript, 'dev');
});

test('detectProject uses start when there is no dev script', () => {
  const dir = tmp();
  writePkg(dir, { scripts: { start: 'node server.js' } });
  const p = devServer.detectProject(dir) as NodeProject;
  assert.equal(p.type, 'node');
  assert.equal(p.framework, 'node');
  assert.equal(p.devScript, 'start');
});

test('detectProject treats a package with no runnable script but HTML as static', () => {
  const dir = tmp();
  writePkg(dir, { name: 'just-files' }); // no scripts
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');
  const p = devServer.detectProject(dir) as StaticProject;
  assert.equal(p.type, 'static');
  assert.equal(p.framework, 'static');
});

test('detectProject finds a static root under public/', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<h1>hi</h1>');
  const p = devServer.detectProject(dir) as StaticProject;
  assert.equal(p.type, 'static');
  assert.equal(p.staticRoot, path.join(dir, 'public'));
});

test('detectProject carries the detected package manager through', () => {
  const dir = tmp();
  writePkg(dir, { scripts: { dev: 'next dev' }, dependencies: { next: '14' }, packageManager: 'pnpm@9' });
  assert.equal((devServer.detectProject(dir) as NodeProject).pm, 'pnpm');
});

test('detectProject exposes the build script when present (and null when not)', () => {
  const withBuild = tmp();
  writePkg(withBuild, { scripts: { dev: 'astro dev', build: 'astro build' }, dependencies: { astro: '4' } });
  assert.equal((devServer.detectProject(withBuild) as NodeProject).buildScript, 'build');
  const noBuild = tmp();
  writePkg(noBuild, { scripts: { dev: 'astro dev' }, dependencies: { astro: '4' } });
  assert.equal((devServer.detectProject(noBuild) as NodeProject).buildScript, null);
});

test('build() runs the build script and resolves ok on success', async () => {
  const dir = tmp();
  // A build that writes a marker file — proves it actually ran in this repo.
  writePkg(dir, { scripts: { build: "node -e \"require('fs').writeFileSync('built.txt','ok')\"" } });
  const res = await devServer.build(dir, { pm: 'npm', buildScript: 'build' });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'built.txt')), 'the build script ran in the repo');
});

test('build() resolves (not rejects) with ok:false + a log on a red build', async () => {
  const dir = tmp();
  writePkg(dir, { scripts: { build: 'node -e "console.error(\'boom\'); process.exit(1)"' } });
  const res = await devServer.build(dir, { pm: 'npm', buildScript: 'build' }) as Extract<BuildResult, { ok: false }>;
  assert.equal(res.ok, false);
  assert.match(res.error, /build failed/i);
  assert.equal(typeof res.log, 'string'); // a tail is captured for surfacing
});

test('pmInvocation always resolves a runnable command for npm', () => {
  const inv = devServer.pmInvocation('npm');
  // npm should be present in any Node test environment.
  assert.ok(inv && inv.cmd);
  assert.deepEqual(inv.pre, []);
});

test('detectProject survives a malformed package.json (falls back to static)', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), '{ broken json');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');
  const p = devServer.detectProject(dir); // must not throw
  assert.equal(p.type, 'static');
});

test('detectProject reads a package.json that holds null (or any non-object) like a malformed one', () => {
  for (const content of ['null', '"text"', '5', 'true', '[]']) {
    const bare = tmp();
    fs.writeFileSync(path.join(bare, 'package.json'), content);
    assert.equal(devServer.detectProject(bare).type, 'unknown', content);
    fs.writeFileSync(path.join(bare, 'index.html'), '<h1>hi</h1>');
    assert.equal(devServer.detectProject(bare).type, 'static', content);
  }
});

test('detectProject returns unknown for an empty folder (no html to serve)', () => {
  // No package.json and no HTML at all → genuinely nothing to run or serve.
  const dir = tmpDir('radial-ds-empty-');
  const p = devServer.detectProject(dir);
  assert.equal(p.type, 'unknown');
});

test('detectProject falls back to a top-level .html that is not index.html', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'home.html'), '<h1>home</h1>'); // entry not named index.html
  const p = devServer.detectProject(dir) as StaticProject;
  assert.equal(p.type, 'static');
  assert.equal(p.staticRoot, dir);
});

// --- capturedByAncestorWorkspace: the nested-workspace root-cause fix ---------------
// A pnpm project nested under a parent pnpm-workspace.yaml gets installed as the
// parent workspace (its own deps go missing). We detect that to pass
// --ignore-workspace. Only ANCESTOR workspace files count, never the repo's own.

test('captured: a pnpm project nested under a parent workspace is detected', () => {
  const parent = tmp();
  fs.writeFileSync(path.join(parent, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  const project = path.join(parent, 'my-site');
  fs.mkdirSync(project);
  assert.equal(devServer.capturedByAncestorWorkspace(project, 'pnpm'), true);
});

test('captured: a deeper ancestor workspace is still found (walks up the tree)', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  const project = path.join(root, 'a', 'b', 'site');
  fs.mkdirSync(project, { recursive: true });
  assert.equal(devServer.capturedByAncestorWorkspace(project, 'pnpm'), true);
});

test('not captured: the project being its OWN workspace root does not count', () => {
  const project = tmp();
  // The workspace file lives in the repo itself (legit monorepo root), not above.
  fs.writeFileSync(path.join(project, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  assert.equal(devServer.capturedByAncestorWorkspace(project, 'pnpm'), false);
});

test('not captured: a standalone project with no ancestor workspace', () => {
  const parent = tmp();
  const project = path.join(parent, 'site');
  fs.mkdirSync(project);
  assert.equal(devServer.capturedByAncestorWorkspace(project, 'pnpm'), false);
});

test('not captured: only pnpm is affected — npm/yarn ignore ancestor workspaces', () => {
  const parent = tmp();
  fs.writeFileSync(path.join(parent, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
  const project = path.join(parent, 'site');
  fs.mkdirSync(project);
  assert.equal(devServer.capturedByAncestorWorkspace(project, 'npm'), false);
  assert.equal(devServer.capturedByAncestorWorkspace(project, 'yarn'), false);
});

test('start() publishes the preview URL to .radial/dev.json and stop() erases it', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>hi</title>');
  const handle = await devServer.start(dir);
  try {
    const info: DevInfo = JSON.parse(fs.readFileSync(path.join(dir, '.radial', 'dev.json'), 'utf8'));
    assert.equal(info.url, handle.url);
    assert.equal(info.framework, 'static');
    assert.ok(info.pid > 0 && info.startedAt! > 0);
  } finally {
    await handle.stop();
  }
  assert.equal(fs.existsSync(path.join(dir, '.radial', 'dev.json')), false);
});

test('clearDevInfo tolerates a repo with no published dev.json', () => {
  devServer.clearDevInfo(tmp()); // must not throw
});

test('stop() marks the handle so the crash-healer can tell a deliberate stop', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>hi</title>');
  const handle = await devServer.start(dir);
  assert.equal(handle.stopped, undefined);
  await handle.stop();
  assert.equal(handle.stopped, true);
});

test('parseLsofListeners extracts pid/command/port triples', () => {
  const out = 'p812\ncnode\nn127.0.0.1:4321\np944\ncBackground\nn*:7000\np1001\ncnext-server\nn[::1]:3000\n';
  assert.deepEqual(devServer.parseLsofListeners(out), [
    { pid: 812, cmd: 'node', host: '127.0.0.1', port: 4321 },
    { pid: 944, cmd: 'Background', host: '*', port: 7000 },
    { pid: 1001, cmd: 'next-server', host: '::1', port: 3000 },
  ]);
});

test('a listener looks like a dev server by lsof’s name, or by the program it runs when lsof gives its thread’s name (Node 24 on Linux: MainThread)', () => {
  const row = (cmd: string) => ({ pid: 42, cmd, host: '127.0.0.1', port: 4321 });
  let asked = 0;
  const program = (name: string) => (pid: number) => { asked++; assert.equal(pid, 42); return name; };
  assert.equal(devServer.looksLikeDevProcess(row('node'), program('unused')), true);
  assert.equal(asked, 0, 'lsof’s name was enough: no command line read');
  assert.equal(devServer.looksLikeDevProcess(row('MainThread'), program('node')), true, 'a Node server on Linux');
  assert.equal(devServer.looksLikeDevProcess(row('MainThread'), program('python3')), false);
  assert.equal(devServer.looksLikeDevProcess(row('postgres'), program('')), false, 'a command line that can’t be read adds nothing');
});

test('parseLsofListeners tolerates empty and junk input', () => {
  assert.deepEqual(devServer.parseLsofListeners(''), []);
  assert.deepEqual(devServer.parseLsofListeners('garbage\nn:notaport\n'), []);
});

test('parseLsofCwd pulls the cwd path', () => {
  assert.equal(devServer.parseLsofCwd('p812\nfcwd\nn/Users/you/site\n'), '/Users/you/site');
  assert.equal(devServer.parseLsofCwd(''), null);
});

test('start() adopts a dev server already running for the repo (external, never stopped)', async () => {
  const { spawn } = require('child_process') as typeof import('child_process');
  const dir = tmp();
  // A "node project" whose dev script would fail loudly if Radial started its
  // own server — adoption must win before that ever runs.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { dev: 'node -e "process.exit(1)"' }, dependencies: { next: '1' } }));
  // The user's own server: a real node process LISTENing with cwd = the repo,
  // which is exactly what externalServerFor keys on via lsof.
  const child = spawn(process.execPath, ['-e',
    'require("http").createServer((q,r)=>r.end("ok")).listen(0,"127.0.0.1",function(){process.stdout.write(this.address().port+\"\\n\")})'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += String(d);
      const m = buf.match(/(\d+)\n/);
      if (m) resolve(parseInt(m[1], 10));
    });
    child.once('exit', () => reject(new Error('server child died')));
    setTimeout(() => reject(new Error('no port printed: ' + buf)), 8000);
  });
  try {
    const handle = await devServer.start(dir, { timeoutMs: 15000 });
    assert.equal(handle.external, true);
    assert.equal(handle.url, `http://127.0.0.1:${port}/`);
    assert.equal(handle.pid, child.pid);
    const info: DevInfo = JSON.parse(fs.readFileSync(path.join(dir, '.radial', 'dev.json'), 'utf8'));
    assert.equal(info.external, true);
    assert.equal(info.url, handle.url);
    await handle.stop(); // must NOT kill the user's server...
    assert.equal(child.exitCode, null);
    assert.equal(fs.existsSync(path.join(dir, '.radial', 'dev.json')), false); // ...but dev.json is cleaned up
  } finally {
    try { child.kill(); } catch {}
  }
});

test('candidateUrls probes the family the server actually binds (Next 16 is v6-only)', () => {
  assert.deepEqual(devServer.candidateUrls('::1', 65076), ['http://[::1]:65076/']);
  assert.deepEqual(devServer.candidateUrls('127.0.0.1', 4321), ['http://127.0.0.1:4321/']);
  assert.deepEqual(devServer.candidateUrls('*', 3000), ['http://127.0.0.1:3000/', 'http://[::1]:3000/']);
  assert.deepEqual(devServer.candidateUrls('::', 3000), ['http://127.0.0.1:3000/', 'http://[::1]:3000/']);
});

test('start() adopts an IPv6-only (::1) dev server — the Next 16 default bind', async () => {
  const { spawn } = require('child_process') as typeof import('child_process');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { dev: 'node -e "process.exit(1)"' }, dependencies: { next: '1' } }));
  const child = spawn(process.execPath, ['-e',
    'require("http").createServer((q,r)=>r.end("ok")).listen(0,"::1",function(){process.stdout.write(this.address().port+\"\\n\")})'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d: Buffer) => { buf += String(d); const m = buf.match(/(\d+)\n/); if (m) resolve(parseInt(m[1], 10)); });
    child.once('exit', () => reject(new Error('server child died')));
    setTimeout(() => reject(new Error('no port printed: ' + buf)), 8000);
  });
  try {
    const handle = await devServer.start(dir, { timeoutMs: 15000 });
    assert.equal(handle.external, true);
    assert.equal(handle.url, `http://[::1]:${port}/`);
    await handle.stop();
    assert.equal(child.exitCode, null); // the user's server survives
  } finally {
    try { child.kill(); } catch {}
  }
});

test('looksLikeBuildServer separates build/preview servers from live dev servers', () => {
  for (const cmd of [
    'node /x/node_modules/.bin/astro preview',
    'node /x/node_modules/.bin/vite preview --port 4173',
    'npx http-server dist',
    'node /x/node_modules/.bin/sirv dist',
  ]) assert.equal(devServer.looksLikeBuildServer(cmd), true, `build server: ${cmd}`);
  for (const cmd of [
    'node /x/node_modules/.bin/astro dev',
    'node /x/node_modules/.bin/vite',
    'next-server (v16.2.6)',
    'npm run dev',
    '',
  ]) assert.equal(devServer.looksLikeBuildServer(cmd), false, `live server: ${cmd}`);
});

test('dev.json records what is serving (cwd + script)', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>hi</title>');
  const handle = await devServer.start(dir);
  try {
    const info: DevInfo = JSON.parse(fs.readFileSync(path.join(dir, '.radial', 'dev.json'), 'utf8'));
    assert.equal(info.cwd, dir);
  } finally { await handle.stop(); }
});

test('degraded watcher injects chokidar polling env for spawned dev servers', () => {
  const wh = require('../src/main/watcherHealth') as typeof import('../src/main/watcherHealth');
  wh._setForTest(false);
  assert.deepEqual(devServer.watcherEnv(), { CHOKIDAR_USEPOLLING: '1', CHOKIDAR_INTERVAL: '400' });
  wh._setForTest(true);
  assert.deepEqual(devServer.watcherEnv(), {});
  wh._setForTest(undefined);
});

test('wedged watcher: external server is NOT adopted (Radial must own it to auto-restart)', async () => {
  const wh = require('../src/main/watcherHealth') as typeof import('../src/main/watcherHealth');
  const { spawn } = require('child_process') as typeof import('child_process');
  const dir = tmp();
  // Static-root fallback would bypass the node path — make a real astro-ish project
  // whose dev script serves instantly so start() succeeds without adoption.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'x',
    scripts: { dev: 'node -e "require(\\"http\\").createServer((q,r)=>r.end(\\"own\\")).listen(0,\\"127.0.0.1\\",function(){console.log(\\"http://127.0.0.1:\\"+this.address().port+\\"/\\")})"' },
  }));
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true }); // satisfy needsInstall
  // The user's own (external) server, cwd = the repo:
  const child = spawn(process.execPath, ['-e',
    'require("http").createServer((q,r)=>r.end("external")).listen(0,"127.0.0.1",function(){process.stdout.write(this.address().port+"\\n")})'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  const extPort = await new Promise<number>((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d: Buffer) => { buf += String(d); const m = buf.match(/(\d+)\n/); if (m) resolve(parseInt(m[1], 10)); });
    setTimeout(() => reject(new Error('no port')), 8000);
  });
  wh._setForTest(false); // wedged
  try {
    const handle = await devServer.start(dir, { timeoutMs: 20000 });
    assert.notEqual(handle.external, true); // did NOT adopt
    assert.notEqual(handle.url, `http://127.0.0.1:${extPort}/`);
    assert.equal(child.exitCode, null); // user's server untouched
    await handle.stop();
  } finally {
    wh._setForTest(undefined);
    try { child.kill(); } catch {}
  }
});

test('start() fails fast with a "stuck" verdict when the server accepts but never answers', async () => {
  const dir = tmp();
  // A dev script that binds the assigned port, prints a URL, and then never
  // answers any request — the exception-storm shape that once held the open
  // spinner for the full timeout.
  writePkg(dir, { name: 'hung', scripts: { dev: 'node -e "const net=require(\'net\');const s=net.createServer(function(){});s.listen(process.env.PORT,\'127.0.0.1\',function(){console.log(\'serving http://127.0.0.1:\'+process.env.PORT+\'/\')})"' } });
  fs.mkdirSync(path.join(dir, 'node_modules')); // dep-free; skip the install phase
  const statuses: string[] = [];
  const started = Date.now();
  await assert.rejects(
    devServer.start(dir, { timeoutMs: 16000, onStatus: (t) => statuses.push(t) }),
    /looks stuck/,
  );
  // stuckMs = timeoutMs/2 — the verdict must land well before the full timeout.
  assert.ok(Date.now() - started < 15000, `took ${Date.now() - started}ms`);
  // The spinner narrated the wait: raw dev output (throttled, so any line of
  // the boot counts), then the not-responding count.
  assert.ok(statuses.some((t) => /node -e|serving http/.test(t)), `no boot output in ${JSON.stringify(statuses)}`);
  assert.ok(statuses.some((t) => /hasn’t responded yet/.test(t)), `no waiting status in ${JSON.stringify(statuses)}`);
});
