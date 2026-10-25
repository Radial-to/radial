// `radial browser [install]` and `radial doctor` (src/headless/browser.ts and
// doctor.ts): the browser radial serve does page work with, and what serve
// needs on a machine. Playwright's registry, its install-deps and the machine
// are stand-ins here (browser.deps, doctor.deps): nothing is downloaded and
// apt never runs. test/headlessBrowser.e2e.mts runs the real browser.

import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as browser from '../src/headless/browser';
import * as doctor from '../src/headless/doctor';
import * as cli from '../src/main/cli';
import type { BrowserDeps, Registry, RegistryExecutable, RunResult } from '../src/headless/browser';
import type { DoctorDeps } from '../src/headless/doctor';
import type { CliIo } from '../src/main/cli';
import { tmpDir } from './support/tmp';

const realBrowser: BrowserDeps = { ...browser.deps };
const realDoctor: DoctorDeps = { ...doctor.deps };
afterEach(() => { Object.assign(browser.deps, realBrowser); Object.assign(doctor.deps, realDoctor); });

/** Playwright's registry as the stand-in sees it: the shell's executable lives in dir; install writes it and logs the way Playwright does. */
function fakeRegistry(dir: string) {
  const executable = path.join(dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
  const installs: { names: string[]; options: unknown }[] = [];
  const shell: RegistryExecutable = { name: 'chromium-headless-shell', directory: dir, browserVersion: '151.0.7922.34', executablePath: () => executable };
  const registry: Registry = {
    findExecutable: (name) => (name === 'chromium-headless-shell' ? shell : undefined),
    async install(executables, options) {
      installs.push({ names: executables.map((e) => e.name), options });
      console.log('Downloading Chrome Headless Shell 151.0.7922.34 from https://cdn.example/x.zip');
      fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, '');
    },
  };
  return { registry, executable, installs, shell };
}
/** What install-deps --dry-run prints when packages are missing, and when none are. */
const DRY_MISSING = 'Missing system dependencies (3):\n  libasound2\n  libgbm1\n  libnss3\n';
const DRY_NONE = 'All system dependencies are installed.\n';
/** The machine as a test describes it: the platform, root or not, and what each command it runs answers (a list answers in turn, its last one from then on). */
function machine({ platform, root = false, answers = [] }: { platform: NodeJS.Platform; root?: boolean; answers?: [RegExp, RunResult | RunResult[]][] }) {
  const ran: string[] = [];
  Object.assign(browser.deps, {
    platform, isRoot: () => root, playwrightCli: () => __filename, playwrightVersion: () => '1.62.1', // a cli.js that exists
    async run(_command: string, args: string[], onOutput?: (text: string) => void): Promise<RunResult> {
      const line = args.slice(1).join(' ');
      ran.push(line);
      const hit = answers.find(([re]) => re.test(line));
      const answer = hit ? hit[1] : { code: 0, stdout: '', stderr: '' };
      const r = Array.isArray(answer) ? (answer.length > 1 ? answer.shift()! : answer[0]) : answer;
      if (onOutput && r.stdout) onOutput(r.stdout);
      return r;
    },
  });
  return ran;
}
/**
 * doctor's view of a machine that has everything beyond the tools a test
 * names: node-pty prebuilt, plenty of inotify watches, Claude Code signed in
 * with an API key, no Codex. Tests override what they look at.
 */
function readyMachine(): Partial<DoctorDeps> {
  return {
    pty: () => ({ ok: true, from: 'prebuilt', target: 'linux-x64 (glibc)', root: '/radial/node_modules/node-pty' }),
    readFile: (file: string) => (file === '/proc/sys/fs/inotify/max_user_watches' ? '524288\n' : null),
    size: () => null,
    version: (command: string) => (command === 'claude' ? '2.1.282 (Claude Code)' : command === 'codex' ? 'codex-cli 0.163.0' : null),
    keychainHas: () => false,
    env: { ANTHROPIC_API_KEY: 'sk-test-never-printed' },
    home: '/home/someone',
  };
}
/** A CLI io that keeps what's written. */
function io(): Pick<CliIo, 'stdout' | 'stderr'> & { out(): string; err(): string } {
  let out = '', err = '';
  return { stdout: { write: (s: string) => { out += s; } }, stderr: { write: (s: string) => { err += s; } }, out: () => out, err: () => err };
}

test('browserInfo: which browser radial serve uses, where it goes, and whether it is there', () => {
  const fake = fakeRegistry(tmpDir('radial-browser-'));
  browser.deps.registry = () => fake.registry; browser.deps.playwrightVersion = () => '1.62.1';
  assert.deepEqual(browser.browserInfo(), { playwright: '1.62.1', name: 'Chrome Headless Shell', version: '151.0.7922.34', dir: fake.shell.directory, executable: fake.executable, installed: false });
  fs.mkdirSync(path.dirname(fake.executable), { recursive: true }); fs.writeFileSync(fake.executable, '');
  assert.equal(browser.browserInfo().installed, true);
  browser.deps.registry = () => null;
  assert.deepEqual(browser.browserInfo(), { playwright: null, name: 'Chrome Headless Shell', version: null, dir: null, executable: null, installed: false });
});

test('install on a Mac downloads the shell and nothing else, leaves other installs’ browsers be, and says so the second time', async () => {
  const fake = fakeRegistry(tmpDir('radial-browser-'));
  browser.deps.registry = () => fake.registry;
  const ran = machine({ platform: 'darwin' });
  const progress: string[] = [];
  const first = await browser.install((t) => progress.push(t));
  assert.deepEqual(first, { ok: true, state: 'installed', name: 'Chrome Headless Shell', version: '151.0.7922.34', executable: fake.executable });
  assert.deepEqual(fake.installs, [{ names: ['chromium-headless-shell'], options: { force: false, gc: false } }], 'one browser, no garbage collection');
  assert.match(progress.join(''), /^Downloading Chrome Headless Shell/, 'Playwright’s console output goes where progress goes');
  assert.deepEqual(ran, [], 'no system libraries to check on a Mac');
  const again = await browser.install();
  assert.equal(again.ok && again.state, 'already'); assert.equal(fake.installs.length, 1, 'nothing downloaded again');
});

test('install on Linux as root: the libraries first, with Playwright’s installer, only when apt says some are missing, and checked again after', async () => {
  const fake = fakeRegistry(tmpDir('radial-browser-'));
  browser.deps.registry = () => fake.registry;
  const missingThenNone: RunResult[] = [{ code: 1, stdout: DRY_MISSING, stderr: '' }, { code: 0, stdout: DRY_NONE, stderr: '' }];
  let ran = machine({ platform: 'linux', root: true, answers: [[/--dry-run/, missingThenNone], [/^install-deps chromium-headless-shell$/, { code: 0, stdout: 'Installing dependencies...\n', stderr: '' }]] });
  const progress: string[] = [];
  const r = await browser.install((t) => progress.push(t));
  assert.ok(r.ok && r.libraries === 'installed', JSON.stringify(r));
  assert.deepEqual(ran, ['install-deps --dry-run chromium-headless-shell', 'install-deps chromium-headless-shell', 'install-deps --dry-run chromium-headless-shell']);
  assert.match(progress.join(''), /Installing dependencies/);
  ran = machine({ platform: 'linux', root: true, answers: [[/--dry-run/, { code: 0, stdout: DRY_NONE, stderr: '' }]] });
  const present = await browser.install();
  assert.ok(present.ok && present.libraries === 'present' && present.state === 'already', JSON.stringify(present));
  assert.deepEqual(ran, ['install-deps --dry-run chromium-headless-shell'], 'nothing to install');
  machine({ platform: 'linux', root: true, answers: [[/--dry-run/, { code: 1, stdout: DRY_MISSING, stderr: '' }], [/^install-deps/, { code: 1, stdout: '', stderr: 'E: no' }]] });
  const failed = await browser.install();
  assert.deepEqual(failed.ok ? null : [failed.code, failed.error], ['failed', 'Installing the browser\'s system libraries failed. Its output is above.']);
  // A Linux Playwright has no package list for: its installer does nothing, and Radial can't tell, so it says so.
  machine({ platform: 'linux', root: true, answers: [[/--dry-run/, { code: 0, stdout: '', stderr: 'Cannot install dependencies for fedora40-x64' }]] });
  const unknown = await browser.install();
  assert.ok(unknown.ok && unknown.libraries === 'unknown' && /^Radial couldn't check the system libraries/.test(unknown.note!), JSON.stringify(unknown));
  // apt says some are still missing after the installer ran.
  machine({ platform: 'linux', root: true, answers: [[/--dry-run/, { code: 1, stdout: DRY_MISSING, stderr: '' }]] });
  const still = await browser.install();
  assert.deepEqual(still.ok ? null : [still.code, still.error, still.fix], ['failed', 'Playwright\'s installer ran, but 3 system packages are still missing.', 'apt-get install -y --no-install-recommends libasound2 libgbm1 libnss3']);
});

test('install on Linux without root: the browser downloads, and the apt line comes back when libraries are missing', async () => {
  const fake = fakeRegistry(tmpDir('radial-browser-'));
  browser.deps.registry = () => fake.registry;
  machine({ platform: 'linux', answers: [[/--dry-run/, { code: 1, stdout: DRY_MISSING, stderr: '' }]] });
  const r = await browser.install();
  assert.deepEqual(r, { ok: false, code: 'missing-libraries', error: 'Chrome Headless Shell is installed, but it needs 3 system packages (libraries and fonts) this machine doesn\'t have, and installing them needs root.', fix: 'sudo apt-get install -y --no-install-recommends libasound2 libgbm1 libnss3', missing: ['libasound2', 'libgbm1', 'libnss3'], executable: fake.executable });
  assert.ok(fs.existsSync(fake.executable), 'the download itself needs no root');
  machine({ platform: 'linux', answers: [[/--dry-run/, { code: 1, stdout: 'Failed to install browser dependencies\nError: \'apt-get install -s\' exited with code 100', stderr: '' }]] });
  const unknown = await browser.install();
  assert.ok(unknown.ok && unknown.libraries === 'unknown', JSON.stringify(unknown));
  assert.match(unknown.ok ? unknown.note! : '', /^Radial couldn't check the system libraries Chrome Headless Shell needs here\. If it doesn't start, run: sudo .* install-deps chromium-headless-shell$/);
});

test('install without playwright-core says how to get it', async () => {
  browser.deps.registry = () => null;
  const r = await browser.install();
  assert.equal(r.ok ? null : r.code, 'no-playwright');
  assert.match(r.ok ? '' : r.error, /needs playwright-core, which isn't installed next to Radial\. Run npm install in .*, then radial browser install\./);
});

test('missingLibraries reads Playwright’s dry run: the packages, none, or can’t tell', async () => {
  machine({ platform: 'linux', answers: [[/--dry-run/, { code: 1, stdout: DRY_MISSING, stderr: '' }]] });
  assert.deepEqual(await browser.missingLibraries(), ['libasound2', 'libgbm1', 'libnss3']);
  machine({ platform: 'linux', answers: [[/--dry-run/, { code: 0, stdout: DRY_NONE, stderr: '' }]] });
  assert.deepEqual(await browser.missingLibraries(), []);
  machine({ platform: 'linux', answers: [[/--dry-run/, { code: 1, stdout: '', stderr: 'BEWARE: your OS is not officially supported' }]] });
  assert.equal(await browser.missingLibraries(), null);
  machine({ platform: 'darwin' });
  assert.equal(await browser.missingLibraries(), null, 'only Linux has them to check');
});

test('radial browser: whether it is installed (exit 0 or 1), install with --json prints one object and its progress on stderr, a wrong action is a usage error', async () => {
  const fake = fakeRegistry(tmpDir('radial-browser-'));
  browser.deps.registry = () => fake.registry;
  machine({ platform: 'darwin' });
  const before = io(); assert.equal(await browser.command([], {}, before), 1);
  assert.equal(before.out(), `No browser yet. \`radial browser install\` fetches Chrome Headless Shell 151.0.7922.34 into ${fake.shell.directory}.\n`);
  const inst = io(); assert.equal(await browser.command(['install'], { json: true }, inst), 0);
  const reply = JSON.parse(inst.out()) as browser.InstallReply;
  assert.equal(reply.ok && reply.state, 'installed');
  assert.match(inst.err(), /^Downloading Chrome Headless Shell/, 'progress on stderr, so stdout stays one JSON object');
  const after = io(); assert.equal(await browser.command([], { json: true }, after), 0);
  assert.equal((JSON.parse(after.out()) as browser.BrowserInfo).installed, true);
  const human = io(); assert.equal(await browser.command(['install'], {}, human), 0);
  assert.match(human.out(), /^Chrome Headless Shell 151\.0\.7922\.34 was already installed: .*\nA running radial serve uses it from its next page op\.\n$/);
  const bad = io(); assert.equal(await browser.command(['remove'], {}, bad), 2);
  assert.match(bad.err(), /Unknown browser command: remove/);
  machine({ platform: 'linux', answers: [[/--dry-run/, { code: 1, stdout: DRY_MISSING, stderr: '' }]] });
  const missing = io(); assert.equal(await browser.command(['install'], {}, missing), 1);
  assert.match(missing.err(), /^radial: Chrome Headless Shell is installed, but it needs 3 system packages .*\n {2}Fix: sudo apt-get install -y --no-install-recommends libasound2 libgbm1 libnss3\n$/);
});

test('doctor: Node and git are required, ps, lsof and the browser are not, and each missing one says what to run', async () => {
  const fake = fakeRegistry(tmpDir('radial-browser-'));
  browser.deps.registry = () => fake.registry;
  machine({ platform: 'linux', answers: [[/--dry-run/, { code: 1, stdout: DRY_MISSING, stderr: '' }]] });
  Object.assign(doctor.deps, { ...readyMachine(), nodeVersion: '24.12.0', gitVersion: () => '2.39.5', which: (name: string) => (name === 'apt-get' ? '/usr/bin/apt-get' : name === 'ps' ? '/bin/ps' : name === 'claude' ? '/usr/bin/claude' : null) });
  const list = await doctor.checks();
  assert.deepEqual(list.map((c) => [c.name, c.ok, c.required]), [['node', true, true], ['git', true, true], ['node-pty', true, false], ['ps', true, false], ['lsof', false, false], ['inotify', true, false], ['claude', true, false], ['codex', true, false], ['browser', false, false]]);
  assert.equal(list.find((c) => c.name === 'lsof')!.fix, 'sudo apt-get install -y lsof');
  assert.equal(list.find((c) => c.name === 'browser')!.fix, 'radial browser install');
  const out = io(); assert.equal(await doctor.command([], {}, out), 0, 'serve runs without the optional ones');
  assert.match(out.out(), /^What radial serve needs on this machine:\n {2}ok {7}node {7}24\.12\.0\n/);
  assert.match(out.out(), /\n {2}missing {2}lsof .*\n {22}Fix: sudo apt-get install -y lsof\n/);
  assert.match(out.out(), /radial serve runs; it can do more with lsof and the browser\.\n$/);
  // The browser installed: on Linux its libraries are checked too, and whether it runs with Chrome's sandbox (a launch tried now, here a stand-in's answer).
  fs.mkdirSync(path.dirname(fake.executable), { recursive: true }); fs.writeFileSync(fake.executable, '');
  let tried = 0;
  doctor.deps.trySandbox = async () => { tried++; return { sandbox: false, reason: 'it runs as root, where Chrome refuses its sandbox' }; };
  const dataDir = tmpDir('radial-doctor-');
  const withBrowser = await doctor.checks(dataDir);
  const libs = withBrowser.find((c) => c.name === 'libraries')!;
  assert.deepEqual([libs.ok, libs.fix], [false, 'sudo apt-get install -y --no-install-recommends libasound2 libgbm1 libnss3']);
  const sandbox = withBrowser.find((c) => c.name === 'sandbox')!;
  assert.deepEqual([sandbox.ok, sandbox.required, sandbox.fix], [false, false, 'run radial serve as a user other than root']);
  assert.equal(sandbox.detail, 'The browser runs without Chrome\'s sandbox: it runs as root, where Chrome refuses its sandbox. Page work still works, with less protection from the sites it opens.');
  // A running serve's own record wins over a launch: what its browser is doing now.
  fs.writeFileSync(browser.sandboxFile(dataDir), JSON.stringify({ sandbox: true, reason: null, pid: process.pid, at: Date.now() }));
  const running = (await doctor.checks(dataDir)).find((c) => c.name === 'sandbox')!;
  assert.deepEqual([running.ok, running.detail, tried], [true, 'radial serve\'s browser runs with Chrome\'s sandbox.', 1]);
  // A record left by a serve that's gone is ignored.
  fs.writeFileSync(browser.sandboxFile(dataDir), JSON.stringify({ sandbox: true, reason: null, pid: 2 ** 22 + 12345, at: 0 }));
  assert.equal((await doctor.checks(dataDir)).find((c) => c.name === 'sandbox')!.ok, false);
  // A launch that fails for another reason (no libraries): no sandbox line, the other checks say why.
  doctor.deps.trySandbox = async () => null;
  assert.equal((await doctor.checks(dataDir)).some((c) => c.name === 'sandbox'), false);
  assert.equal(browser.sandboxFailure('Running as root without --no-sandbox is not supported. See https://crbug.com/638180.'), 'it runs as root, where Chrome refuses its sandbox');
  assert.equal(browser.sandboxFailure('[FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! If you are running on Ubuntu 23.10+'), 'this machine gives it no user namespaces');
  assert.equal(browser.sandboxFailure('Host system is missing dependencies to run browsers'), null);
  // Too old a Node, and no git: serve can't run.
  Object.assign(doctor.deps, { nodeVersion: '20.11.0', gitVersion: () => null });
  const json = io(); assert.equal(await doctor.command([], { json: true }, json), 1);
  const r = JSON.parse(json.out()) as { ok: boolean; checks: doctor.Check[] };
  assert.equal(r.ok, false);
  assert.match(r.checks[0].detail, /^20\.11\.0 is too old: Radial runs on Node 22\.18 or newer\.$/);
  assert.equal(r.checks[1].fix, 'sudo apt-get install -y git');
  const human = io(); assert.equal(await doctor.command([], {}, human), 1);
  assert.match(human.out(), /\nradial serve can't run without Node 22\.18 or newer and git\.\n$/);
});

test('doctor: node-pty, the inotify watch limit on Linux, and which agent CLIs are installed and signed in, never printing a secret', async () => {
  machine({ platform: 'linux' });
  browser.deps.registry = () => null; // no playwright-core: the browser line says so and nothing launches
  const dir = tmpDir('radial-doctor-agents-');
  const files: Record<string, string> = { '/proc/sys/fs/inotify/max_user_watches': '8192\n' };
  Object.assign(doctor.deps, {
    ...readyMachine(), nodeVersion: '24.12.0', gitVersion: () => '2.39.5',
    which: (name: string) => (['apt-get', 'ps', 'lsof', 'claude', 'codex'].includes(name) ? `/usr/bin/${name}` : null),
    pty: () => ({ ok: false, from: null, target: 'linux-x64 (musl)', root: '/radial/node_modules/node-pty', error: 'Error loading shared library ld-linux-x86-64.so.2', fix: 'sudo apt-get install -y python3 make g++, then npm rebuild -g radial-cli' }),
    readFile: (file: string) => files[file] ?? null,
    size: (file: string) => (files[file] != null ? files[file].length : null),
    env: {}, home: dir,
  });
  const byName = async () => Object.fromEntries((await doctor.checks(dir)).map((c) => [c.name, c]));
  let c = await byName();
  // node-pty doesn't load: agent sessions can't start, serve still runs, and the fix is the build tools then a rebuild.
  assert.deepEqual([c['node-pty'].ok, c['node-pty'].required], [false, false]);
  assert.match(c['node-pty'].detail, /^It doesn't load on linux-x64 \(musl\) \(Error loading shared library ld-linux-x86-64\.so\.2\), so agent sessions can't start; everything else works\.$/);
  assert.match(c['node-pty'].fix!, /^sudo apt-get install -y python3 make g\+\+, then npm rebuild /);
  // 8192 watches is low: the sysctl line, and how to keep it.
  assert.deepEqual([c.inotify.ok, c.inotify.label], [false, 'low']);
  assert.equal(c.inotify.fix, 'sudo sysctl fs.inotify.max_user_watches=524288, and to keep it after a restart: echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/60-radial.conf (in a container, run both on the host)');
  // Both CLIs installed, neither signed in: both say what to run.
  assert.deepEqual([c.claude.ok, c.claude.label, c.codex.ok, c.codex.label], [false, 'sign in', false, 'sign in']);
  assert.match(c.claude.detail, /^2\.1\.282 \(Claude Code\), but no sign-in found\./);
  assert.match(c.claude.fix!, /ANTHROPIC_API_KEY/); assert.match(c.codex.fix!, /codex login --with-api-key/);
  const out = io(); assert.equal(await doctor.command([], {}, out), 0, 'none of these stop serve');
  assert.match(out.out(), /\n {2}low {6}inotify {4}Only 8192 file watches per user\./);
  assert.match(out.out(), /\n {2}sign in {2}claude {5}2\.1\.282/);
  assert.match(out.out(), /radial serve runs; it can do more with node-pty, more file watches, a signed-in Claude Code, a signed-in Codex and the browser\.\n$/);
  // Signed in: Claude Code's credentials file, Codex's auth.json with ChatGPT tokens. Only the kind is said, never what's inside.
  files[path.join(dir, '.claude', '.credentials.json')] = JSON.stringify({ claudeAiOauth: { accessToken: 'secret-access-token-value' } });
  files[path.join(dir, '.codex', 'auth.json')] = JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: 'secret-id-token-value' } });
  files['/proc/sys/fs/inotify/max_user_watches'] = '524288';
  c = await byName();
  assert.deepEqual([c.claude.ok, c.claude.detail, c.codex.ok, c.codex.detail], [true, '2.1.282 (Claude Code), signed in with a Claude account.', true, 'codex-cli 0.163.0, signed in with a ChatGPT account.']);
  assert.deepEqual([c.inotify.ok, c.inotify.detail], [true, '524288 file watches per user.']);
  // An API key in the environment, or Codex's own: named by variable, never by value.
  Object.assign(doctor.deps, { env: { ANTHROPIC_API_KEY: 'sk-test-value-never-printed', CODEX_HOME: path.join(dir, 'elsewhere') } });
  files[path.join(dir, 'elsewhere', 'auth.json')] = JSON.stringify({ OPENAI_API_KEY: 'sk-test-codex-value-never-printed' });
  const json = io(); await doctor.command([], { json: true }, json);
  assert.ok(!/never-printed|secret-/.test(json.out()), 'no secret in the output');
  c = await byName();
  assert.equal(c.claude.detail, '2.1.282 (Claude Code), signed in with an API key (ANTHROPIC_API_KEY).');
  assert.equal(c.codex.detail, 'codex-cli 0.163.0, signed in with an API key (codex login --with-api-key).');
  // Codex alone, signed in: a missing Claude Code is no problem, as sessions run Codex.
  Object.assign(doctor.deps, { env: {}, which: (name: string) => (['apt-get', 'codex'].includes(name) ? `/usr/bin/${name}` : null) });
  files[path.join(dir, '.codex', 'auth.json')] = JSON.stringify({ tokens: { id_token: 'x' } });
  c = await byName();
  assert.deepEqual([c.claude.ok, c.claude.detail, c.claude.fix], [true, 'Not installed. Agent sessions run Codex.', undefined]);
  // Neither installed: Claude Code is what to install; Codex stays optional.
  Object.assign(doctor.deps, { which: () => null });
  c = await byName();
  assert.deepEqual([c.claude.ok, c.codex.ok], [false, true]);
  assert.match(c.claude.fix!, /^npm install -g @anthropic-ai\/claude-code/);
  // Not on Linux: no inotify line.
  machine({ platform: 'darwin' });
  assert.equal((await byName()).inotify, undefined);
});

test('the CLI runs radial browser and radial doctor on this machine, and tells a Mac app’s user they need neither', async () => {
  const fake = fakeRegistry(tmpDir('radial-browser-'));
  browser.deps.registry = () => fake.registry;
  machine({ platform: 'darwin' });
  const mac = { ...io(), env: { RADIAL_CLI_FLAVOR: 'packaged' }, cwd: '/', isTTY: false, connect: () => Promise.reject(new Error('no')), launch: () => {} } as CliIo & { out(): string };
  assert.equal(await cli.main(['browser', 'install'], mac), 0);
  assert.match(mac.out(), /^Radial for Mac shows pages in its own window, so it needs no browser install\. `radial browser` is for radial serve/);
  assert.deepEqual(fake.installs, [], 'nothing downloaded for a Mac app');
  const serve = { ...io(), env: { RADIAL_CLI_FLAVOR: 'headless', RADIAL_DATA_DIR: tmpDir('radial-browser-data-') }, cwd: '/', isTTY: false, connect: () => Promise.reject(new Error('no')), launch: () => {} } as CliIo & { out(): string };
  assert.equal(await cli.main(['browser', '--json'], serve), 1, 'not installed');
  assert.equal((JSON.parse(serve.out()) as browser.BrowserInfo).installed, false);
});
