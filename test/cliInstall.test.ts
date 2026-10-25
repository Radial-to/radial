import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as cliInstall from '../src/main/cliInstall';
import { tmpDir } from './support/tmp';

function tmp() { return tmpDir('radial-cli-inst-'); }

// A fake bundle with an executable shim at the packaged location.
function fakeShim(root: string) {
  const bin = path.join(root, 'Radial.app', 'Contents', 'Resources', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, 'radial');
  fs.writeFileSync(shim, '#!/bin/sh\n');
  fs.chmodSync(shim, 0o755);
  return shim;
}

test('shimPath wants an executable file', () => {
  const root = tmp();
  const shim = fakeShim(root);
  assert.equal(cliInstall.shimPath(path.dirname(path.dirname(shim))), shim);
  fs.chmodSync(shim, 0o644);
  assert.equal(cliInstall.shimPath(path.dirname(path.dirname(shim))), null);
  assert.equal(cliInstall.shimPath(path.join(root, 'nowhere')), null);
});

test('installs a symlink into the first writable candidate', () => {
  const shim = fakeShim(tmp());
  const dir = tmp();
  const r = cliInstall.ensureInstalled(shim, { dirs: [{ dir, create: false }] });
  assert.equal(r.installed, path.join(dir, 'radial'));
  assert.equal(fs.readlinkSync(r.installed!), shim);
});

test('is idempotent when the link is already correct', () => {
  const shim = fakeShim(tmp());
  const dir = tmp();
  cliInstall.ensureInstalled(shim, { dirs: [{ dir, create: false }] });
  const r = cliInstall.ensureInstalled(shim, { dirs: [{ dir, create: false }] });
  assert.equal(r.installed, path.join(dir, 'radial'));
});

test('replaces a stale link that points at another Radial bundle', () => {
  const oldShim = fakeShim(tmp());
  const newShim = fakeShim(tmp());
  const dir = tmp();
  fs.symlinkSync(oldShim, path.join(dir, 'radial'));
  const r = cliInstall.ensureInstalled(newShim, { dirs: [{ dir, create: false }] });
  assert.equal(fs.readlinkSync(r.installed!), newShim);
});

test('replaces a dangling link, whatever it pointed at', () => {
  const shim = fakeShim(tmp());
  const dir = tmp();
  fs.symlinkSync(path.join(tmp(), 'gone-tool'), path.join(dir, 'radial'));
  const r = cliInstall.ensureInstalled(shim, { dirs: [{ dir, create: false }] });
  assert.equal(fs.readlinkSync(r.installed!), shim);
});

test('never touches a foreign radial: regular file, or live link elsewhere', () => {
  const shim = fakeShim(tmp());

  const withFile = tmp();
  fs.writeFileSync(path.join(withFile, 'radial'), 'someone elses tool');
  let r = cliInstall.ensureInstalled(shim, { dirs: [{ dir: withFile, create: false }] });
  assert.equal(r.installed, null);
  assert.equal(r.reason, 'foreign-file');
  assert.equal(fs.readFileSync(path.join(withFile, 'radial'), 'utf8'), 'someone elses tool');

  const withLink = tmp();
  const foreignTool = path.join(tmp(), 'radial-rs');
  fs.writeFileSync(foreignTool, 'bin');
  fs.symlinkSync(foreignTool, path.join(withLink, 'radial'));
  r = cliInstall.ensureInstalled(shim, { dirs: [{ dir: withLink, create: false }] });
  assert.equal(r.installed, null);
  assert.equal(r.reason, 'foreign-link');
  assert.equal(fs.readlinkSync(path.join(withLink, 'radial')), foreignTool);
});

// Root writes through a folder's permissions (a container's tests often run as root), so it has no unwritable folder.
test('falls through an unwritable dir to a creatable one', { skip: process.getuid?.() === 0 && 'root can write to any folder' }, () => {
  const shim = fakeShim(tmp());
  const locked = tmp();
  fs.chmodSync(locked, 0o555);
  const home = tmp();
  const created = path.join(home, '.local', 'bin');
  const r = cliInstall.ensureInstalled(shim, {
    dirs: [{ dir: locked, create: false }, { dir: created, create: true }],
  });
  fs.chmodSync(locked, 0o755); // let tmp cleanup work
  assert.equal(r.installed, path.join(created, 'radial'));
  assert.equal(fs.readlinkSync(r.installed!), shim);
});

test('missing dir is skipped unless creatable', () => {
  const shim = fakeShim(tmp());
  const gone = path.join(tmp(), 'not-here');
  const r = cliInstall.ensureInstalled(shim, { dirs: [{ dir: gone, create: false }] });
  assert.equal(r.installed, null);
  assert.equal(fs.existsSync(gone), false);
});

test('no shim (dev run) is a clean no-op', () => {
  assert.deepEqual(cliInstall.ensureInstalled(null), { installed: null, reason: 'no-shim' });
});

test('default candidates are /usr/local/bin then ~/.local/bin', () => {
  const dirs = cliInstall.candidates('/Users/you');
  assert.deepEqual(dirs.map((d) => d.dir), ['/usr/local/bin', '/Users/you/.local/bin']);
  assert.equal(dirs[0].create, false);
  assert.equal(dirs[1].create, true);
});
