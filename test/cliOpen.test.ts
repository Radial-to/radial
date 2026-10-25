import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import * as cliOpen from '../src/main/cliOpen';
import { tmpDir } from './support/tmp';

function tmp() { return tmpDir('radial-cli-'); }

test('parseOpenPaths picks --open-path= flags and ignores everything else', () => {
  const dir = tmp();
  const paths = cliOpen.parseOpenPaths([
    '/Applications/Radial.app/Contents/MacOS/Radial',
    '--inspect=9229',            // debugger noise
    `--open-path=${dir}`,
    dir,                         // positional — not this module's business
    '--open-path=/nope/definitely/missing',
  ]);
  assert.deepEqual(paths, [dir]);
});

test('parseOpenPaths dedupes and keeps order', () => {
  const a = tmp();
  const b = tmp();
  const paths = cliOpen.parseOpenPaths([
    `--open-path=${b}`, `--open-path=${a}`, `--open-path=${b}`,
  ]);
  assert.deepEqual(paths, [b, a]);
});

test('parseOpenPaths resolves relative paths against the given cwd', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'site'));
  assert.deepEqual(cliOpen.parseOpenPaths(['--open-path=site'], dir), [path.join(dir, 'site')]);
  assert.deepEqual(cliOpen.parseOpenPaths(['--open-path=.'], dir), [dir]);
});

test('normalizeOpenPath maps a file to its folder and rejects junk', () => {
  const dir = tmp();
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, 'hi');
  assert.equal(cliOpen.normalizeOpenPath(file), dir);
  assert.equal(cliOpen.normalizeOpenPath(dir), dir);
  assert.equal(cliOpen.normalizeOpenPath(path.join(dir, 'gone')), null);
  assert.equal(cliOpen.normalizeOpenPath(''), null);
  assert.equal(cliOpen.normalizeOpenPath(null), null);
});

// The shell shim is a locator now: it must find the app and the client next to
// itself and pass every argument through untouched — run it for real with the
// dry-run hook. Where there's no Mac app (a checkout on Linux), it runs the
// client on the system's Node: the headless flavor.
function runShim(args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}): string[] {
  const shim = path.join(__dirname, '..', 'bin', 'radial');
  const env: NodeJS.ProcessEnv = { ...process.env, RADIAL_CLI_DRYRUN: '1', ...extra };
  if (!extra.RADIAL_CLI_FLAVOR) delete env.RADIAL_CLI_FLAVOR;
  const out = execFileSync('/bin/sh', [shim, ...args], { cwd, env });
  return String(out).trim().split('\n');
}
const macApp = fs.existsSync(path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'));
const systemNode = () => String(execFileSync('/bin/sh', ['-c', 'command -v node'])).trim();

test('shim (dry run): resolves the app binary (Node where there is no Mac app) and the client entry, then passes every argument through untouched', () => {
  const dir = tmpDir('radial cli ');
  const lines = runShim(['open', '.', '--json'], dir);
  if (macApp) assert.ok(/\/(MacOS\/Radial|MacOS\/Electron)$/.test(lines[0]), `app binary: ${lines[0]}`);
  else assert.equal(lines[0], systemNode(), 'no Mac app here: the system’s Node');
  assert.ok(lines[1].endsWith('/out/main/cli.js'), `client entry: ${lines[1]}`);
  assert.deepEqual(lines.slice(2), ['open', '.', '--json']);
});

test('shim (dry run): RADIAL_CLI_FLAVOR=headless runs the client on the system’s Node, even beside the Mac app', () => {
  const lines = runShim(['serve', '--detach'], os.tmpdir(), { RADIAL_CLI_FLAVOR: 'headless' });
  assert.equal(lines[0], systemNode());
  assert.ok(lines[1].endsWith('/out/main/cli.js'), `client entry: ${lines[1]}`);
  assert.deepEqual(lines.slice(2), ['serve', '--detach']);
});

test('shim (dry run): a bare `radial` carries no arguments; names and paths are the client’s business', () => {
  assert.equal(runShim([], os.tmpdir()).length, 2);
  const lines = runShim(['moment site', '/definitely/not/here'], os.tmpdir());
  assert.deepEqual(lines.slice(2), ['moment site', '/definitely/not/here']);
});
