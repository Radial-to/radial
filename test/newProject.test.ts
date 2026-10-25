import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';

import * as newProject from '../src/main/newProject';
import * as devServer from '../src/main/devServer';
import type { SpawnOptions } from 'child_process';
import type { ScaffoldSpawn } from '../src/main/newProject';
import type { NewProjectResult } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

// The side of createProject's result each test reads; its assertions fail on the other side.
type Created = Extract<NewProjectResult, { ok: true }>;
type CreateFailed = Extract<NewProjectResult, { ok: false }>;

/** The fake scaffolder a test drives: an emitter with output streams to emit on, and a kill that reports a signalled exit. */
interface FakeChild extends EventEmitter { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
/** What createProject spawned: the create CLI, its arguments and the spawn options. */
interface SpawnCall { cmd: string; args: string[]; opts: SpawnOptions }

function tmp() { return tmpDir('radial-np-'); }

// A controllable stand-in for child_process.spawn: emits nothing until the
// test drives it. kill() reports an exit like a real signalled child.
function fakeSpawn(behavior: (child: FakeChild, call: SpawnCall) => void): ScaffoldSpawn {
  return (cmd, args, opts) => {
    const child = new EventEmitter() as FakeChild; // the next three lines add the rest
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { setImmediate(() => child.emit('exit', null, 'SIGTERM')); };
    setImmediate(() => behavior(child, { cmd, args, opts }));
    return child;
  };
}

// --- name sanitization ------------------------------------------------------

test('sanitizeProjectName produces folder/npm-safe kebab slugs', () => {
  const s = newProject.sanitizeProjectName;
  assert.equal(s('My Site'), 'my-site');
  assert.equal(s("Jo's Café + Bar!"), 'jos-caf-bar');
  assert.equal(s('  spaced   out  '), 'spaced-out');
  assert.equal(s('..hidden'), 'hidden');
  assert.equal(s('_underscore'), 'underscore');
  assert.equal(s('trailing---'), 'trailing');
  assert.equal(s('UPPER.case_ok-1'), 'upper.case_ok-1');
  assert.equal(s('日本語'), '');
  assert.equal(s(''), '');
  assert.equal(s(null), '');
  assert.equal(s('a/b\\c'), 'a-b-c'); // no path separators survive
});

// --- scaffold invocations are pinned -----------------------------------------
// If these change, the flags were edited on purpose — re-verify against the
// CLIs' live --help before shipping (see plans/new-project-from-baseline.md).

test('buildScaffoldArgs pins the exact non-interactive invocations', () => {
  const dir = '/tmp/x/site';
  assert.deepEqual(newProject.buildScaffoldArgs('next', dir), {
    cmd: 'npx',
    args: ['--yes', 'create-next-app@latest', dir,
      '--ts', '--tailwind', '--eslint', '--app', '--import-alias', '@/*',
      '--use-npm', '--skip-install', '--disable-git', '--yes'],
  });
  assert.deepEqual(newProject.buildScaffoldArgs('astro', dir), {
    cmd: 'npm',
    args: ['create', '-y', 'astro@latest', '--', dir,
      '--template', 'basics', '--no-install', '--no-git', '--skip-houston', '--yes'],
  });
  assert.equal(newProject.buildScaffoldArgs('html', dir), null);
});

// --- preflight ----------------------------------------------------------------

test('preflight rejects bad input without touching disk', async () => {
  const parent = tmp();
  let r = await newProject.createProject({ templateId: 'nope', name: 'x', parentDir: parent }) as CreateFailed;
  assert.equal(r.stage, 'preflight');
  r = await newProject.createProject({ templateId: 'html', name: '  !!!  ', parentDir: parent }) as CreateFailed;
  assert.equal(r.stage, 'preflight');
  r = await newProject.createProject({ templateId: 'html', name: 'ok', parentDir: '' }) as CreateFailed;
  assert.equal(r.stage, 'preflight');
  assert.equal(fs.readdirSync(parent).length, 0);
});

test('preflight refuses an existing folder and leaves it alone', async () => {
  const parent = tmp();
  const dir = path.join(parent, 'my-site');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'precious');
  const r = await newProject.createProject({ templateId: 'html', name: 'My Site', parentDir: parent }) as CreateFailed;
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'preflight');
  assert.match(r.error, /already exists/);
  assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'precious');
});

// --- plain HTML end-to-end -----------------------------------------------------

test('plain HTML: creates files, replaces the site name, git-ifies, detects as static', async () => {
  const parent = path.join(tmp(), 'nested', 'projects'); // parent is auto-created
  const logs: string[] = [];
  const r = await newProject.createProject({
    templateId: 'html', name: 'Jo & Co', parentDir: parent, onLog: (l) => logs.push(l),
  }) as Created;
  assert.equal(r.ok, true, JSON.stringify(r));
  const dir = path.join(parent, 'jo-co');
  assert.equal(r.dir, dir);
  assert.equal(r.displayName, 'Jo & Co');

  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.ok(html.includes('<title>Jo &amp; Co</title>')); // token replaced, HTML-escaped
  assert.ok(!html.includes('{{SITE_NAME}}'));
  assert.ok(fs.existsSync(path.join(dir, 'styles.css')));
  assert.ok(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes('Jo &amp; Co'));

  // Radial's own detector must recognise the result so the open pipeline works.
  assert.equal(devServer.detectProject(dir).type, 'static');

  // Git-ified with exactly one commit on main.
  assert.ok(fs.existsSync(path.join(dir, '.git')));
  const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir }).toString().trim();
  assert.equal(count, '1');
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: dir }).toString().trim();
  assert.equal(branch, 'main');
});

// --- scaffold path (fake spawn) --------------------------------------------------

test('scaffold success: streams output, then git-ifies the scaffolder output', async () => {
  const parent = tmp();
  const logs: string[] = [];
  const spawnImpl = fakeSpawn((child, { args }) => {
    const dir = args.includes('create-next-app@latest') ? args[2] : args[4];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: 'next dev' }, dependencies: { next: '15.0.0' } }));
    child.stdout.emit('data', Buffer.from('\x1b[32mCreating a new Next.js app…\x1b[0m\n'));
    setImmediate(() => child.emit('exit', 0, null));
  });
  const r = await newProject.createProject({ templateId: 'next', name: 'Demo', parentDir: parent, onLog: (l) => logs.push(l), spawnImpl }) as Created;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(logs.some((l) => l === 'Creating a new Next.js app…')); // ANSI stripped
  assert.ok(fs.existsSync(path.join(r.dir, '.git')));
  const count = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: r.dir }).toString().trim();
  assert.equal(count, '1');
});

test('scaffold failure: reports the stage and removes the partial dir', async () => {
  const parent = tmp();
  const spawnImpl = fakeSpawn((child, { args }) => {
    const dir = args[2];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'partial.txt'), 'half-written');
    child.stderr.emit('data', Buffer.from('npm ERR! network ENOTFOUND registry.npmjs.org\n'));
    setImmediate(() => child.emit('exit', 1, null));
  });
  const r = await newProject.createProject({ templateId: 'next', name: 'Broken', parentDir: parent, spawnImpl }) as CreateFailed;
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'scaffold');
  assert.match(r.error, /exit 1/);
  assert.ok(!fs.existsSync(path.join(parent, 'broken')), 'partial dir should be cleaned up');
});

test('spawn ENOENT: friendly install-node message, nothing left behind', async () => {
  const parent = tmp();
  const spawnImpl = fakeSpawn((child) => {
    const e: NodeJS.ErrnoException = new Error('spawn npx ENOENT'); e.code = 'ENOENT';
    child.emit('error', e);
  });
  const r = await newProject.createProject({ templateId: 'next', name: 'NoNode', parentDir: parent, spawnImpl }) as CreateFailed;
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'scaffold');
  assert.match(r.error, /nodejs\.org/);
  assert.ok(!fs.existsSync(path.join(parent, 'nonode')));
});

test('cancel mid-scaffold: resolves as cancelled and removes the partial dir', async () => {
  const parent = tmp();
  const spawnImpl = fakeSpawn((child, { args }) => {
    const dir = args[2];
    fs.mkdirSync(dir, { recursive: true });
    child.stdout.emit('data', Buffer.from('downloading…\n'));
    // …and then it hangs until killed.
  });
  const pending = newProject.createProject({ templateId: 'next', name: 'Slow Site', parentDir: parent, spawnImpl });
  await new Promise((res) => setTimeout(res, 20)); // let the fake child start
  assert.equal(newProject.cancel(), true);
  const r = await pending as CreateFailed;
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'cancelled');
  assert.ok(!fs.existsSync(path.join(parent, 'slow-site')));
});

test('single-flight: a second create while one is running returns busy', async () => {
  const parent = tmp();
  const spawnImpl = fakeSpawn((child, { args }) => {
    fs.mkdirSync(args[2], { recursive: true });
  });
  const first = newProject.createProject({ templateId: 'next', name: 'First', parentDir: parent, spawnImpl });
  await new Promise((res) => setTimeout(res, 20));
  const second = await newProject.createProject({ templateId: 'html', name: 'Second', parentDir: parent }) as CreateFailed;
  assert.equal(second.stage, 'busy');
  newProject.cancel();
  const r1 = await first as CreateFailed;
  assert.equal(r1.stage, 'cancelled');
  // With the first create finished, creating works again.
  const third = await newProject.createProject({ templateId: 'html', name: 'Third', parentDir: parent });
  assert.equal(third.ok, true, JSON.stringify(third));
});
