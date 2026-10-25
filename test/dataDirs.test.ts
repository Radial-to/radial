// Where a Radial keeps its state and its sockets (src/main/dataDirs.ts): the
// headless core's data dir on each OS and its overrides, and the short socket
// folder a data dir too deep for a unix socket's address gets.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import net from 'net';
import path from 'path';

import * as dataDirs from '../src/main/dataDirs';
import { tmpDir } from './support/tmp';

const home = '/home/someone';

test('the headless core keeps its own data dir: ~/.config/Radial on Linux, Radial Core on macOS', () => {
  assert.equal(dataDirs.defaultHeadlessDataDir({}, { platform: 'linux', home }), '/home/someone/.config/Radial');
  assert.equal(dataDirs.defaultHeadlessDataDir({ XDG_CONFIG_HOME: '/srv/config' }, { platform: 'linux', home }), '/srv/config/Radial');
  assert.equal(dataDirs.defaultHeadlessDataDir({ XDG_CONFIG_HOME: 'relative/config' }, { platform: 'linux', home }), '/home/someone/.config/Radial', 'a relative XDG_CONFIG_HOME is ignored, as the spec says');
  assert.equal(dataDirs.defaultHeadlessDataDir({}, { platform: 'darwin', home: '/Users/someone' }), '/Users/someone/Library/Application Support/Radial Core', 'never the app’s own Radial folder');
});

test('--data-dir (RADIAL_DATA_DIR) wins, then RADIAL_USERDATA, then the machine’s default', () => {
  assert.equal(dataDirs.headlessDataDir({ RADIAL_DATA_DIR: '/data', RADIAL_USERDATA: '/scratch' }, { platform: 'linux', home }), '/data');
  assert.equal(dataDirs.headlessDataDir({ RADIAL_USERDATA: '/scratch' }, { platform: 'linux', home }), '/scratch');
  assert.equal(dataDirs.headlessDataDir({}, { platform: 'linux', home }), '/home/someone/.config/Radial');
  assert.equal(dataDirs.headlessDataDir({ RADIAL_DATA_DIR: 'radial-data' }, { platform: 'linux', home }), path.resolve('radial-data'), 'a relative one resolves against the working folder');
});

test('a data dir with a short path holds its own sockets', () => {
  const dir = '/home/someone/.config/Radial';
  assert.equal(dataDirs.socketDir(dir, {}), dir);
  assert.equal(dataDirs.cliSocket(dir, {}), path.join(dir, 'cli.sock'));
  assert.equal(dataDirs.daemonSocket(dir, {}), path.join(dir, 'term-daemon.sock'));
});

test('a data dir too deep for a socket gets a short folder of its own, keyed by it, the same for every process', () => {
  const deep = path.join('/work', 'a'.repeat(60), 'b'.repeat(40), 'radial-data');
  const runtime = tmpDir('rdd-');
  const inRuntime = dataDirs.socketDir(deep, { XDG_RUNTIME_DIR: runtime });
  assert.equal(path.dirname(inRuntime), runtime, 'XDG_RUNTIME_DIR first: it is this user’s alone');
  assert.match(path.basename(inRuntime), /^radial-[0-9a-f]{12}$/);
  assert.equal(dataDirs.socketDir(deep, { XDG_RUNTIME_DIR: runtime }), inRuntime, 'the same folder every time');
  assert.notEqual(dataDirs.socketDir(deep + '-2', { XDG_RUNTIME_DIR: runtime }), inRuntime, 'another data dir, another folder');
  const inTmp = dataDirs.socketDir(deep, {});
  assert.equal(path.dirname(inTmp), '/tmp');
  assert.match(path.basename(inTmp), new RegExp(`^radial-${process.getuid!()}-[0-9a-f]{12}$`), 'in /tmp, named for the user too');
  for (const sock of [dataDirs.cliSocket(deep, {}), dataDirs.daemonSocket(deep, {})]) assert.ok(dataDirs.fitsSocket(sock), `${sock} fits a socket address`);
});

test('prepareSocketDir makes the short folder private and notes its data dir; a socket there works, and leads back to the data dir', async () => {
  const deep = path.join(tmpDir('rdd-deep-'), 'x'.repeat(70), 'radial-data');
  fs.mkdirSync(deep, { recursive: true });
  const runtime = tmpDir('rdd-');
  const env = { XDG_RUNTIME_DIR: runtime };
  const dir = dataDirs.prepareSocketDir(deep, env);
  assert.equal(dir, dataDirs.socketDir(deep, env));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const sock = dataDirs.cliSocket(deep, env);
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(sock, () => resolve()); });
  try {
    await new Promise<void>((resolve, reject) => { const c = net.connect(sock); c.once('connect', () => { c.destroy(); resolve(); }); c.once('error', reject); });
  } finally { server.close(); }
  assert.equal(dataDirs.dataDirOfSocket(sock), deep, 'an agent terminal’s RADIAL_CLI_SOCK leads back to the data dir');
  assert.equal(dataDirs.dataDirOfSocket('/home/someone/.config/Radial/cli.sock'), '/home/someone/.config/Radial', 'a socket in its data dir is its own folder');
  assert.equal(dataDirs.prepareSocketDir(deep, env), dir, 'preparing again finds the same folder');
});

test('prepareSocketDir refuses a short folder someone else could reach', () => {
  const deep = path.join('/work', 'c'.repeat(100), 'radial-data');
  const runtime = tmpDir('rdd-');
  const env = { XDG_RUNTIME_DIR: runtime };
  fs.mkdirSync(dataDirs.socketDir(deep, env), { mode: 0o755 });
  fs.chmodSync(dataDirs.socketDir(deep, env), 0o755);
  assert.throws(() => dataDirs.prepareSocketDir(deep, env), /not a private folder/);
});

test('a data dir that fits keeps its sockets where they always were, and preparing makes the data dir', () => {
  const dir = path.join(tmpDir('rdd-'), 'data');
  assert.equal(dataDirs.prepareSocketDir(dir, {}), dir);
  assert.ok(fs.statSync(dir).isDirectory());
});
