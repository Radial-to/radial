// node-pty on this machine (src/headless/nodePty.ts): which binary loads, and
// radial-cli's postinstall, which compiles node-pty when its binary doesn't
// load (no prebuilt one here, or a glibc one on musl) and never fails the
// install. The machine is a stand-in (nodePty.deps): nothing compiles here.
// The real thing runs in test/cliPackage.test.ts and in Docker (plans/headless-core.md, phase 5).

import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as nodePty from '../src/headless/nodePty';
import type { PtyDeps } from '../src/headless/nodePty';
import { tmpDir } from './support/tmp';

const real: PtyDeps = { ...nodePty.deps };
afterEach(() => { Object.assign(nodePty.deps, real); });

/** A machine: its platform and C library, what's on disk, whether node-pty loads (an error, or null), and what a compile does. */
function machine({ platform = 'linux' as NodeJS.Platform, arch = 'x64', libc = 'glibc' as 'glibc' | 'musl' | null, files = [] as string[], load = [null] as (string | null)[], compiles = true, apt = true, root = false } = {}) {
  const ran: string[] = [];
  const disk = new Set(files.map((f) => path.join('/pkg/node_modules/node-pty', f)));
  Object.assign(nodePty.deps, {
    root: () => '/pkg/node_modules/node-pty', platform, arch, libc: () => libc,
    exists: (file: string) => disk.has(file),
    tryLoad: () => { ran.push('load'); return load.length > 1 ? load.shift()! : load[0]; },
    compile: (_root: string, onOutput: (text: string) => void) => {
      ran.push('compile'); onOutput('gyp info ok\n');
      if (!compiles) return { ok: false, error: 'gyp ERR! find Python: Python is not set from command line' };
      disk.add('/pkg/node_modules/node-pty/build/Release/pty.node');
      return { ok: true };
    },
    fixHelpers: () => { ran.push('chmod'); },
    hasApt: () => apt, isRoot: () => root,
  } satisfies Partial<PtyDeps>);
  return ran;
}

test('status: the prebuilt binary, or one compiled here (node-pty tries build/Release first), named with the platform and C library', () => {
  machine({ files: ['prebuilds/linux-x64/pty.node'] });
  assert.deepEqual(nodePty.status(), { ok: true, from: 'prebuilt', target: 'linux-x64 (glibc)', root: '/pkg/node_modules/node-pty' });
  machine({ files: ['build/Release/pty.node', 'prebuilds/linux-x64/pty.node'] });
  assert.equal(nodePty.status().from, 'compiled');
  machine({ platform: 'darwin', arch: 'arm64', libc: null, files: ['prebuilds/darwin-arm64/pty.node'] });
  assert.equal(nodePty.status().target, 'darwin-arm64');
  // Not loading: why, and what to run (the build tools, then npm rebuild).
  machine({ libc: 'musl', load: ['Error loading shared library ld-linux-x86-64.so.2: No such file or directory'] });
  const s = nodePty.status();
  assert.deepEqual([s.ok, s.from, s.target], [false, null, 'linux-x64 (musl)']);
  assert.match(s.fix!, /^sudo apt-get install -y python3 make g\+\+, then npm rebuild node-pty \(in .+\)$/, 'a checkout rebuilds its own node-pty');
  machine({ load: ['nope'], root: true, apt: false });
  assert.match(nodePty.fix(), /^install python3, make and a C\+\+ compiler \(g\+\+\) with this machine's package manager, then /);
  Object.assign(nodePty.deps, { root: () => null });
  assert.equal(nodePty.status().error, 'node-pty is not installed next to Radial');
});

test('ensure (the package’s postinstall): a binary that loads is left alone; one that doesn’t is compiled here', () => {
  const lines: string[] = [];
  let ran = machine({ files: ['prebuilds/linux-x64/pty.node'] });
  assert.equal(nodePty.ensure((l) => lines.push(l), () => {}).ok, true);
  assert.deepEqual(ran, ['load'], 'nothing compiled');
  assert.match(lines.pop()!, /prebuilt binary for linux-x64 \(glibc\)/);
  // The glibc binary on musl (node-pty's own install took it, as the folder is there): compiled here, and build/Release wins from then on.
  let output = '';
  ran = machine({ libc: 'musl', files: ['prebuilds/linux-x64/pty.node'], load: ['Error relocating pty.node: symbol not found', null] });
  const s = nodePty.ensure((l) => lines.push(l), (t) => { output += t; });
  assert.deepEqual([s.ok, s.from, ran], [true, 'compiled', ['load', 'compile', 'load']]);
  assert.match(lines.join('\n'), /doesn't load on linux-x64 \(musl\) \(Error relocating pty\.node: symbol not found\)\. Compiling it for this machine/);
  assert.match(lines.pop()!, /compiled node-pty for this machine/);
  assert.equal(output, 'gyp info ok\n', 'node-gyp’s output goes through');
});

test('ensure never fails the install: without the build tools it says what to run, and radial serve still runs', () => {
  const lines: string[] = [];
  const ran = machine({ arch: 'riscv64', load: ['Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-riscv64'], compiles: false });
  const s = nodePty.ensure((l) => lines.push(l), () => {});
  assert.deepEqual([s.ok, ran], [false, ['load', 'compile']]);
  assert.match(lines.pop()!, /^radial: node-pty couldn't be compiled here \(gyp ERR! find Python: Python is not set from command line\), so agent sessions can't start until it is; everything else in Radial works\. To fix it: sudo apt-get install -y python3 make g\+\+, then npm rebuild /);
  // macOS: the spawn-helpers get their execute bit back before anything loads.
  const mac = machine({ platform: 'darwin', arch: 'arm64', libc: null, files: ['prebuilds/darwin-arm64/pty.node'] });
  nodePty.ensure(() => {}, () => {});
  assert.deepEqual(mac, ['chmod', 'load']);
});

test('the fix names npm rebuild for this install: the package’s, allowed to run its postinstall (npm 12), with its prefix when it isn’t npm’s own', () => {
  const prefix = tmpDir('radial-pty-prefix-');
  const root = path.join(prefix, 'lib', 'node_modules', 'radial-cli');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'radial-cli', version: '1.0.0' }));
  assert.equal(nodePty.rebuildCommand(root), `npm rebuild -g radial-cli --allow-scripts=radial-cli --prefix ${prefix}`);
  const checkout = tmpDir('radial-pty-checkout-');
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'radial-platform' }));
  assert.equal(nodePty.rebuildCommand(checkout), `npm rebuild node-pty (in ${checkout})`);
});

test('what went wrong, in a line: a missing build tool first, then an error’s own message, never the source line Node prints above it', () => {
  const uncaught = [
    '/pkg/node_modules/node-pty/lib/utils.js:31',
    '    throw new Error("Failed to load native module: " + name + ".node, checked: " + dirs.join(\', \') + ": " + lastError);',
    '    ^',
    '',
    'Error: Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-riscv64: Error: Cannot find module',
    '    at Object.loadNativeModule (/pkg/node_modules/node-pty/lib/utils.js:31:11)',
  ].join('\n');
  assert.equal(nodePty.firstError(uncaught), 'Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-riscv64: Error: Cannot find module');
  assert.equal(nodePty.firstError('gyp info it worked if it ends with ok\ngyp ERR! configure error\ngyp ERR! stack Error: Could not find any Python installation to use\ngyp ERR! find Python Python is not set from command line or npm configuration'), 'gyp ERR! find Python Python is not set from command line or npm configuration');
  assert.equal(nodePty.firstError(''), 'it did not load');
});

test('the real node-pty here loads and runs a shell', () => {
  const s = nodePty.status();
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.ok(s.from === 'compiled' || s.from === 'prebuilt');
});
