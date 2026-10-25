// `radial serve`'s pieces (src/headless/serve.ts) that run without starting a
// core: --idle's times, the events it logs, the Node platform and serve's
// options, and `status`, `stop` and `--detach` against a stand-in control
// server on a tmp data dir. test/headless.e2e.mts runs the real thing.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

import * as serve from '../src/headless/serve';
import * as cli from '../src/main/cli';
import * as cliServer from '../src/main/cliServer';
import * as dataDirs from '../src/main/dataDirs';
import type { CliApi, ControlServer, HelloInfo } from '../src/main/cliServer';
import type { CliIo } from '../src/main/cli';
import { tmpDir } from './support/tmp';

test('--idle takes 30m, 2h, 90s or a bare number of minutes; off, never and 0 mean no idle sleep', () => {
  assert.equal(serve.parseIdle('30m'), 30 * 60000);
  assert.equal(serve.parseIdle('2h'), 2 * 3600000);
  assert.equal(serve.parseIdle('90s'), 90000);
  assert.equal(serve.parseIdle('45'), 45 * 60000);
  assert.equal(serve.parseIdle('1.5h'), 5400000);
  for (const off of ['off', 'never', '0', undefined, false]) assert.equal(serve.parseIdle(off), null, String(off));
  for (const bad of ['soon', '30x', '-5m', '', true]) assert.ok(Number.isNaN(serve.parseIdle(bad)), String(bad));
});

test('the core’s events become log lines: dev server output as it is, the rest by channel, terminal output and UI refreshes left out', () => {
  const lines: string[] = [];
  const events = serve.eventLog((l) => lines.push(l));
  events.send('log', '[site] ready on http://localhost:4321/');
  events.send('session:resumed', { repoDir: '/site', url: 'http://localhost:5555/' });
  events.send('newProject:log', 'Installing…');
  events.send('term:data', { id: 'p1', data: 'lots of output' });
  events.send('files:changed', { repoDir: '/site', files: ['index.html'] });
  events.send('history:state', { repoDir: '/site', action: 'edit', relFile: 'index.html', timeline: [], cursor: 1, total: 1, canUndo: true, canRedo: false });
  events.send('radial:build-error', { repoDir: '/site', message: 'x'.repeat(1000) });
  assert.deepEqual(lines.slice(0, 3), ['[site] ready on http://localhost:4321/', '[session:resumed] {"repoDir":"/site","url":"http://localhost:5555/"}', '[newProject:log] Installing…']);
  assert.equal(lines.length, 4, 'terminal output, file pings and the history timeline are not logged');
  assert.ok(lines[3].startsWith('[radial:build-error] {"repoDir":"/site"') && lines[3].endsWith('…') && lines[3].length < 450, 'a long payload is cut');
  assert.equal(events.listening(), false, 'nobody watches live');
});

test('the page hears the core’s events too, after the log: a static site’s change, a project going to sleep', () => {
  const lines: string[] = [];
  const heard: [string, unknown][] = [];
  const events = serve.withPage(serve.eventLog((l) => lines.push(l)), { onEvent: (channel, payload) => heard.push([channel, payload]) });
  events.send('dev:static-changed', { repoDir: '/site' });
  events.send('session:suspended', { repoDir: '/site' });
  events.send('term:data', { id: 'p1', data: 'output' });
  assert.deepEqual(heard, [['dev:static-changed', { repoDir: '/site' }], ['session:suspended', { repoDir: '/site' }], ['term:data', { id: 'p1', data: 'output' }]], 'every event: the page picks what it needs');
  assert.deepEqual(lines, ['[dev:static-changed] {"repoDir":"/site"}', '[session:suspended] {"repoDir":"/site"}'], 'the log is as before');
  assert.equal(events.listening(), false);
});

test('the Node platform: the headless flavor, the package version, this machine, and the checkout’s bin/radial for agent terminals', () => {
  const p = serve.nodePlatform('/data');
  assert.equal(p.flavor, 'headless');
  assert.equal(p.version, (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version);
  assert.equal(p.dataDir, '/data');
  assert.equal(p.home, os.homedir());
  assert.equal(p.cliBin, path.join(__dirname, '..', 'bin', 'radial'));
  assert.doesNotThrow(() => p.keepAwake(true));
});

test('serve’s os_version is the OS’s own version as the Mac app sends it: macOS’s on a Mac, never the Darwin kernel’s; no Electron', () => {
  const plist = (v: string) => `<?xml version="1.0"?><plist version="1.0"><dict>\n\t<key>ProductBuildVersion</key>\n\t<string>26A428</string>\n\t<key>ProductVersion</key>\n\t<string>${v}</string>\n</dict></plist>`;
  assert.equal(serve.osVersion({ platform: 'darwin', readPlist: () => plist('27.0'), release: '27.0.0', type: 'Darwin' }), '27.0.0', 'macOS 27.0, three parts like process.getSystemVersion');
  assert.equal(serve.osVersion({ platform: 'darwin', readPlist: () => plist('26.5.2'), release: '25.5.0', type: 'Darwin' }), '26.5.2', 'macOS 26.5.2 on Darwin 25: the macOS version, not the kernel');
  assert.equal(serve.osVersion({ platform: 'darwin', readPlist: () => { throw new Error('ENOENT'); }, release: '25.5.0', type: 'Darwin' }), 'macOS', 'never the kernel’s, even when the plist can’t be read');
  assert.equal(serve.osVersion({ platform: 'linux', release: '6.8.0-1012-aws', type: 'Linux' }), 'Linux 6.8.0', 'the kernel\'s version only: no -aws');
  assert.equal(serve.osVersion({ platform: 'linux', release: '5.15.153.1-microsoft-standard-WSL2', type: 'Linux' }), 'Linux 5.15.153.1', 'no -WSL2');
  assert.equal(serve.osVersion({ platform: 'freebsd', release: 'weird', type: 'FreeBSD' }), 'FreeBSD', 'no version that isn\'t digits and dots');
  assert.equal(serve.nodePlatform('/data').electronVersion, undefined);
  if (process.platform === 'darwin') assert.match(serve.nodePlatform('/data').osVersion, /^\d+\.\d+\.\d+$/);
});

test('serve’s crash handler never throws, whatever was thrown and even when its log does: Node would exit with code 7', () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const hostile: [string, unknown][] = [
    ['a revoked proxy', revoked.proxy],
    ['a proxy whose get throws', new Proxy({}, { get() { throw new Error('trap'); } })],
    ['an Error whose stack getter throws', Object.defineProperty(new Error('x'), 'stack', { get() { throw new Error('getter'); } })],
    ['undefined', undefined],
  ];
  const lines: string[] = [];
  for (const [label, value] of hostile) {
    assert.doesNotThrow(() => serve.onUncaught((line) => lines.push(line))(value), label);
    assert.doesNotThrow(() => serve.onUncaught(() => { throw new Error('EPIPE on stderr'); })(value), `${label}, with a log that throws`);
  }
  assert.equal(lines.length, hostile.length, 'each is logged');
  assert.match(lines[0], /^\[radial\] uncaught error: an error that could not be read$/);
  const quiet: string[] = [];
  serve.onUncaught((line) => quiet.push(line))(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.deepEqual(quiet, [], 'a reader that went away is not an error');
});

test('serve’s options: no idle sleep unless asked, parking left to the daemon, half the memory, no browser shims', () => {
  assert.deepEqual(serve.serveOptions(null), { idleSleepMs: null, parkAgents: false, devMemoryLimitMb: Math.round(serve.machineMemory() / 1048576 / 2), browserShims: false });
  assert.equal(serve.serveOptions(1800000).idleSleepMs, 1800000);
});

test('the memory serve shares out is the container’s when it caps it (docker run -m), which os.totalmem() doesn’t see', () => {
  const gb = 1024 ** 3;
  assert.equal(serve.machineMemory(16 * gb, 0), 16 * gb, 'no cap: the machine’s');
  assert.equal(serve.machineMemory(16 * gb, 2 * gb), 2 * gb, 'a 2 GB container: 2 GB, so a dev server restarts at 1 GB, not 8');
  assert.equal(serve.machineMemory(16 * gb, 2 ** 62), 16 * gb, 'an unlimited cgroup reports more than the machine has');
  assert.ok(serve.machineMemory() <= os.totalmem());
});

test('with no token yet, serve says every request is refused and how to make one; in a container, with docker exec from the host', () => {
  assert.equal(serve.noTokenNote(false), 'No API tokens yet, so every HTTP request is refused: `radial token create <name>` makes one.');
  assert.equal(serve.noTokenNote(true, '3f2a91c0b7de'), 'No API tokens yet, so every HTTP request is refused. Make one from the host: docker exec 3f2a91c0b7de radial token create <name> (it shows once).');
  assert.equal(serve.inContainer({ RADIAL_CONTAINER: 'docker' }, () => false), true, 'the image says so');
  assert.equal(serve.inContainer({}, (f) => f === '/.dockerenv'), true, 'or Docker’s marker file');
  assert.equal(serve.inContainer({}, () => false), false);
});

/** A control server on a data dir that answers hello as the given Radial (a stand-in for a running serve or app). */
function standIn(dataDir: string, info: HelloInfo): ControlServer {
  fs.mkdirSync(dataDir, { recursive: true });
  const api = { info: () => info, telemetry: () => {} } as unknown as CliApi; // only hello is asked
  return cliServer.start({ socketPath: dataDirs.cliSocket(dataDir), api });
}
/** The CLI's io for `radial serve …` on a data dir, and what it printed. */
function io(dataDir: string) {
  let out = '', err = '';
  const x: CliIo = {
    stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
    env: { RADIAL_DATA_DIR: dataDir }, cwd: '/', isTTY: false,
    connect: () => Promise.reject(new Error('not expected')), launch: () => { throw new Error('launch not expected'); },
  };
  return { io: x, out: () => out, err: () => err };
}

test('serve status says where a running one is, and exits 4 when none runs', async () => {
  const dataDir = path.join(tmpDir('rsv-'), 'data');
  const none = io(dataDir);
  assert.equal(await cli.main(['serve', 'status'], none.io), 4);
  assert.match(none.err(), /Radial isn't running on /);
  const srv = standIn(dataDir, { version: '9.9.9', flavor: 'headless', pid: 4242, windowReady: false, browser: false });
  try {
    await srv.ready;
    const up = io(dataDir);
    assert.equal(await cli.main(['serve', 'status'], up.io), 0);
    assert.match(up.out(), /^Radial is running without a window \(pid 4242, 9\.9\.9\)\.\n  Data: .*\n  Control socket: .*cli\.sock\n  Log: .*logs\/core\.log\n$/);
    const json = io(dataDir);
    await cli.main(['serve', 'status', '--json'], json.io);
    assert.deepEqual(JSON.parse(json.out()), { ok: true, state: 'running', dataDir, socket: dataDirs.cliSocket(dataDir), log: serve.logFile(dataDir), pid: 4242, version: '9.9.9' });
  } finally { srv.stop(); }
});

test('serve --detach and a second serve refuse while one runs (exit 6), saying how to stop it', async () => {
  const dataDir = path.join(tmpDir('rsv-'), 'data');
  const srv = standIn(dataDir, { version: '9.9.9', flavor: 'headless', pid: 4242, windowReady: false, browser: false });
  try {
    await srv.ready;
    const r = io(dataDir);
    assert.equal(await cli.main(['serve', '--detach'], r.io), 6);
    assert.equal(r.err(), `radial: Radial is already running on ${dataDir} (pid 4242). \`radial serve stop\` stops it.\n`);
    const lines: string[] = [];
    assert.equal(await serve.run({ dataDir, idleSleepMs: null, log: (l) => lines.push(l) }), 6, 'a foreground serve refuses too');
    assert.deepEqual(lines, [`Radial is already running on ${dataDir} (pid 4242). \`radial serve stop\` stops it.`]);
  } finally { srv.stop(); }
});

test('serve stop sends SIGTERM to the serve that answers and waits until it and its socket are gone; it leaves Radial for Mac alone', async () => {
  const dataDir = path.join(tmpDir('rsv-'), 'data');
  // A stand-in serve: a process that dies on SIGTERM, and a control server that stops when it does.
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const srv = standIn(dataDir, { version: '9.9.9', flavor: 'headless', pid: proc.pid!, windowReady: false, browser: false });
  proc.on('exit', () => setTimeout(() => srv.stop(), 300));
  await srv.ready;
  const r = io(dataDir);
  assert.equal(await cli.main(['serve', 'stop'], r.io), 0);
  assert.equal(r.out(), `Stopped Radial (pid ${proc.pid}).\n`);
  assert.equal(proc.signalCode, 'SIGTERM');
  assert.equal(fs.existsSync(dataDirs.cliSocket(dataDir)), false);
  const again = io(dataDir);
  assert.equal(await cli.main(['serve', 'stop'], again.io), 0, 'stopping what isn’t running is fine');
  assert.equal(again.out(), `Radial isn't running on ${dataDir}.\n`);

  const app = standIn(dataDir, { version: '9.9.9', flavor: 'packaged', pid: process.pid, windowReady: true, browser: true });
  try {
    await app.ready;
    const mac = io(dataDir);
    assert.equal(await cli.main(['serve', 'stop'], mac.io), 6);
    assert.match(mac.err(), /Radial for Mac answers on .* Quit it from its window\./);
  } finally { app.stop(); }
});

test('serve’s usage errors exit 2: an unknown action, an --idle that isn’t a time', async () => {
  const dataDir = path.join(tmpDir('rsv-'), 'data');
  const bogus = io(dataDir);
  assert.equal(await cli.main(['serve', 'restart'], bogus.io), 2);
  assert.match(bogus.err(), /Unknown serve command: restart/);
  const idle = io(dataDir);
  assert.equal(await cli.main(['serve', '--idle', 'soon'], idle.io), 2);
  assert.match(idle.err(), /--idle takes a time like 30m, 2h or 90s \(or off\), not soon/);
});

test('--listen: loopback by default; an address other machines reach is refused without --allow-remote, with a word about SSH and Tailscale; its companions need it', async () => {
  const parse = (args: string[]) => serve.listenConfig(cli.parseArgs(['serve', ...args]).flags);
  assert.equal(parse([]), null);
  assert.deepEqual(parse(['--listen', '4000']), { address: { host: '127.0.0.1', port: 4000 }, allowRemote: false, allowHosts: [], allowOrigins: [] });
  assert.deepEqual(parse(['--listen', '[::1]:4000']), { address: { host: '::1', port: 4000 }, allowRemote: false, allowHosts: [], allowOrigins: [] });
  const refused = parse(['--listen', '0.0.0.0:4000']) as { error: string };
  assert.match(refused.error, /^0\.0\.0\.0 can be reached from other machines, and radial serve listens only on this machine's own address unless you pass --allow-remote\. To reach it from elsewhere, put SSH or Tailscale in front of 127\.0\.0\.1 \(ssh -L 4000:127\.0\.0\.1:4000 <this machine>\), or pass --allow-remote and keep the tokens secret\.$/);
  assert.ok('error' in (parse(['--listen', '192.168.1.5:4000']) as object), 'a LAN address too');
  assert.deepEqual(parse(['--listen', '0.0.0.0:4000', '--allow-remote', '--allow-host', 'myvm.tail.ts.net', '--allow-host', 'myvm', '--allow-origin', 'https://tools.example']), { address: { host: '0.0.0.0', port: 4000 }, allowRemote: true, allowHosts: ['myvm.tail.ts.net', 'myvm'], allowOrigins: ['https://tools.example'] });
  assert.match((parse(['--allow-remote']) as { error: string }).error, /go with --listen/);
  assert.match((parse(['--listen', '4000', '--allow-host', 'a b']) as { error: string }).error, /--allow-host takes a host name/);
  assert.match((parse(['--listen', '4000', '--allow-origin', 'tools.example']) as { error: string }).error, /--allow-origin takes a web page's origin, like https:\/\/example\.com, not tools\.example/);
  assert.match((parse(['--listen', '4000', '--allow-origin', 'https://tools.example/path']) as { error: string }).error, /--allow-origin takes/);
  // The detached serve gets the same flags back.
  const config = parse(['--listen', '[::]:4000', '--allow-remote', '--allow-host', 'myvm']) as serve.ListenConfig;
  assert.deepEqual(serve.listenArgs(config), ['--listen', '[::]:4000', '--allow-remote', '--allow-host', 'myvm']);
  assert.deepEqual(parse(serve.listenArgs(config)), config, 'a round trip');
  const dataDir = path.join(tmpDir('rsv-'), 'data');
  const cliRefused = io(dataDir);
  assert.equal(await cli.main(['serve', '--listen', '0.0.0.0:4000'], cliRefused.io), 2);
  assert.match(cliRefused.err(), /^radial: 0\.0\.0\.0 can be reached from other machines/);
});

test('serve status says where a serve with --listen takes HTTP', async () => {
  const dataDir = path.join(tmpDir('rsv-'), 'data');
  const srv = standIn(dataDir, { version: '9.9.9', flavor: 'headless', pid: 4242, windowReady: false, browser: false, listen: 'http://127.0.0.1:4000' });
  try {
    await srv.ready;
    const up = io(dataDir);
    assert.equal(await cli.main(['serve', 'status'], up.io), 0);
    assert.match(up.out(), /\n  Listening: http:\/\/127\.0\.0\.1:4000 \(MCP at \/mcp, the CLI at \/rpc, events at \/events; `radial token create` makes a token\)\n  Log: /);
    const json = io(dataDir);
    await cli.main(['serve', 'status', '--json'], json.io);
    assert.equal((JSON.parse(json.out()) as { listen: string }).listen, 'http://127.0.0.1:4000');
  } finally { srv.stop(); }
});

test('the core’s events reach the listener’s /events streams too, less the terminals’ raw output; with a stream open, someone watches', () => {
  const published: [string, unknown][] = [];
  let watchers = 0;
  const events = serve.withWatchers(serve.eventLog(() => {}), () => ({ publish: (channel, payload) => { published.push([channel, payload]); }, watchers: () => watchers }));
  events.send('session:resumed', { repoDir: '/site', url: 'http://localhost:5555/' });
  events.send('term:data', { id: 'p1', data: 'output' });
  events.send('files:changed', { repoDir: '/site', files: ['index.html'] });
  assert.deepEqual(published.map(([c]) => c), ['session:resumed', 'files:changed']);
  assert.equal(events.listening(), false);
  watchers = 1;
  assert.equal(events.listening(), true);
  const none = serve.withWatchers(serve.eventLog(() => {}), () => null);
  none.send('session:suspended', { repoDir: '/site' });
  assert.equal(none.listening(), false, 'no listener, nobody watches');
});
