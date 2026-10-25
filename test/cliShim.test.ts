// The `radial` shim the app writes into userData/shims so the CLI is on PATH
// inside every Radial terminal, always pointing at the RUNNING app's bundle.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { radialShimSource } from '../src/main/cliShim';
import { tmpDir } from './support/tmp';

test('shim execs the bundled CLI with the caller’s arguments and names the control socket', () => {
  const src = radialShimSource({ bin: '/Applications/Radial.app/Contents/Resources/bin/radial', sock: '/Users/x/Library/Application Support/Radial/cli.sock' });
  assert.ok(src.startsWith('#!/bin/sh\n'));
  assert.ok(src.includes('exec "/Applications/Radial.app/Contents/Resources/bin/radial" "$@"'));
  assert.ok(src.includes('export RADIAL_CLI_SOCK="${RADIAL_CLI_SOCK:-/Users/x/Library/Application Support/Radial/cli.sock}"'));
  assert.ok(src.endsWith('\n'));
});

test('shim without a socket just execs, and escapes shell-special characters in paths', () => {
  const src = radialShimSource({ bin: '/tmp/we"ird $dir/bin/radial' });
  assert.ok(!src.includes('RADIAL_CLI_SOCK'));
  assert.ok(src.includes('exec "/tmp/we\\"ird \\$dir/bin/radial" "$@"'));
  // @ts-expect-error -- no bin on purpose: radialShimSource's guard throws without one.
  assert.throws(() => radialShimSource({}), /bin is required/);
});

test('radial serve’s shim says its terminals are headless, whatever they inherited; the Mac app’s says nothing', () => {
  const dir = tmpDir('radial-shim-flavor-');
  const fake = path.join(dir, 'fake-radial');
  fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$RADIAL_CLI_FLAVOR"\n', { mode: 0o755 });
  const headless = path.join(dir, 'radial');
  fs.writeFileSync(headless, radialShimSource({ bin: fake, sock: path.join(dir, 'cli.sock'), flavor: 'headless' }), { mode: 0o755 });
  // bin/radial on a Mac checkout would take the dev branch for dev and launch the app when nothing answers.
  assert.equal(execFileSync('/bin/sh', [headless], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', RADIAL_CLI_FLAVOR: 'dev' } }).trim(), 'headless');
  assert.ok(!radialShimSource({ bin: fake, sock: path.join(dir, 'cli.sock') }).includes('RADIAL_CLI_FLAVOR'), 'bin/radial finds the Mac app’s flavor itself');
});

test('shim really runs: it passes arguments through and exports the socket for the callee', () => {
  const dir = tmpDir('radial-shim-');
  const fake = path.join(dir, 'fake radial'); // a space, on purpose
  fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s|%s|%s\\n" "$1" "$2" "$RADIAL_CLI_SOCK"\n', { mode: 0o755 });
  const shim = path.join(dir, 'radial');
  fs.writeFileSync(shim, radialShimSource({ bin: fake, sock: path.join(dir, 'cli.sock') }), { mode: 0o755 });
  const out = execFileSync('/bin/sh', [shim, 'open', 'my site'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim();
  assert.equal(out, `open|my site|${path.join(dir, 'cli.sock')}`);
  // A caller that already knows a socket keeps it.
  const out2 = execFileSync('/bin/sh', [shim, 'ls', ''], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', RADIAL_CLI_SOCK: '/elsewhere.sock' } }).trim();
  assert.equal(out2, 'ls||/elsewhere.sock');
});
