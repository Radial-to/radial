// The radial-cli npm package (scripts/pack-cli.mts, plans/headless-core.md
// phase 5): what the headless core loads, traced through out/; the size test
// on the tarball; and a real `npm pack` into a scratch folder, read back. The
// package installed and run (serve, open, edit, an agent) is
// scripts/cli-package-smoke.mts, on a Mac and in Docker.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { BUDGET, PACKAGES, checkTarball, checkTrace, pack, trace } from '../scripts/pack-cli.mts';
import { newer, newestGlibc } from '../scripts/pty-prebuild.mts';
import type { TarEntry } from '../scripts/pack-cli.mts';
import { tmpDir } from './support/tmp';

const OUT = path.join(__dirname, '..', 'out'); // npm test builds it first

test('the trace from the package’s entry points: the core, its headless host, the CLI and the daemon, and only the window’s shared modules', () => {
  const t = trace(OUT);
  assert.deepEqual(checkTrace(t), []);
  for (const f of ['main/cli.js', 'headless/serve.js', 'headless/listen.js', 'headless/previewProxy.js', 'headless/apiTokens.js', 'headless/setup.js', 'headless/usage.js', 'main/mcp.js', 'main/term-daemon.js', 'core/index.js', 'headless/npmBin.js', 'headless/nodePty.js']) assert.ok(t.files.includes(f), `${f} is in it`);
  assert.deepEqual(t.files.filter((f) => f.startsWith('renderer/')), ['renderer/fuzzy.js', 'renderer/navigation.js', 'renderer/taskTitle.js']);
  for (const f of ['main/main.js', 'main/updater.js', 'main/migrate/shots.js', 'main/skills.js', 'main/nativeChat.js']) assert.ok(!t.files.includes(f), `${f} is the Mac app's`);
  assert.deepEqual([...t.packages.keys()].sort(), Object.keys(PACKAGES).sort(), 'every package the core loads is a dependency, and nothing more');
  // What the checks refuse: Electron, the app's own main process, a package nobody listed.
  const bad = { files: ['main/cli.js', 'main/main.js', 'renderer/renderer.js'], packages: new Map([['electron', new Set(['main/main.js'])], ['left-pad', new Set(['main/cli.js'])]]), missing: ['./gone (from main/cli.js)'] };
  const problems = checkTrace(bad);
  assert.equal(problems.length, 5, problems.join('\n'));
  assert.ok(problems.some((p) => /left-pad .* isn't one of the package's dependencies/.test(p)));
});

test('the size test: a budget, the page overlay, and no Electron, renderer bundles, source maps or stray analytics key', () => {
  const good: TarEntry[] = [{ path: 'package/bin/radial', size: 300 }, { path: 'package/out/overlay/overlay.js', size: 137000 }, { path: 'package/out/main/cli.js', size: 43000 }, { path: 'package/out/renderer/fuzzy.js', size: 3000 }];
  assert.deepEqual(checkTarball(good, 400 * 1024), []);
  assert.match(checkTarball(good, BUDGET.packed + 1).join('\n'), /over its 4\.0 MB budget/);
  assert.match(checkTarball([...good, { path: 'out/main/big.js', size: BUDGET.unpacked }], 1000).join('\n'), /unpacks to .* over its 12\.0 MB budget/);
  assert.match(checkTarball(good.filter((e) => !e.path.endsWith('overlay.js')), 1000).join('\n'), /overlay\.js \(the page overlay\) is missing/);
  const wrong = checkTarball([...good,
    { path: 'package/node_modules/electron/index.js', size: 10 }, { path: 'package/out/main/cli.js.map', size: 10 },
    { path: 'package/out/renderer/renderer.js', size: 10 }, { path: 'package/out/renderer/vendor/xterm.js', size: 10 },
    { path: 'package/out/main/main.js', size: 10 }, { path: 'package/out/main/official-build.json', size: 10 }], 1000);
  for (const re of [/electron\/index\.js is Electron/, /cli\.js\.map is a source map/, /renderer\/renderer\.js is the window's/, /vendor\/xterm\.js/, /out\/main\/main\.js is the Mac app's/, /analytics key\) is in a package made without --official/]) assert.match(wrong.join('\n'), re);
  assert.match(checkTarball(good, 1000, { official: true }).join('\n'), /official-build\.json is missing from an --official package/);
});

test('node-pty’s Linux binaries: the newest glibc symbol they need, from objdump, held to 2.28 (where Node’s own Linux builds run)', () => {
  const dump = ['0000000000000000      DF *UND*  0000000000000000  GLIBC_2.17  forkpty', '0000000000000000      DF *UND*  0000000000000000  GLIBC_2.28  fcntl', '0000000000000000      DF *UND*  0000000000000000 (GLIBC_2.4)  __stack_chk_fail'].join('\n');
  assert.equal(newestGlibc(dump), '2.28');
  assert.equal(newestGlibc('0000 DF *UND* GLIBC_2.34 forkpty\n0000 DF *UND* GLIBC_2.2.5 memcpy'), '2.34', 'a build on glibc 2.34 or newer: forkpty moved into libc');
  assert.equal(newestGlibc('no versions here'), null);
  assert.deepEqual([newer('2.34', '2.28'), newer('2.28', '2.28'), newer('2.9', '2.28'), newer('2.2.5', '2.28')], [true, false, false, false]);
});

test('npm pack: a radial-cli tarball under budget, its own package.json, node-pty bundled with its macOS binaries, and the analytics key only with --official', async () => {
  const dir = tmpDir('radial-pack-');
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  let tarball: string;
  try { tarball = await pack(['--out', dir, '--no-build']); } finally { console.log = log; }
  assert.match(path.basename(tarball), /^radial-cli-\d+\.\d+\.\d+\.tgz$/);
  const list = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n').map((p) => p.replace(/^package\//, ''));
  for (const f of ['bin/radial', 'package.json', 'README.md', 'LICENSE', 'NOTICE', 'out/main/cli.js', 'out/headless/serve.js', 'out/overlay/overlay.js', 'out/main/templates/plain-html/index.html', 'out/main/migrate/playbook/SKILL.md', 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node', 'node_modules/node-pty/binding.gyp', 'node_modules/node-pty/src/unix/pty.cc', 'node_modules/node-addon-api/napi.h']) assert.ok(list.includes(f), `${f} is packed`);
  for (const f of list) assert.ok(!/node_modules\/(electron|@xterm\/headless|posthog-node|playwright-core)\//.test(f), `${f}: only node-pty is bundled`);
  assert.ok(!list.some((f) => f.includes('prebuilds/win32')), 'no Windows binaries');
  const pkg = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' })) as { name: string; bin: Record<string, string>; engines: { node: string }; dependencies: Record<string, string>; optionalDependencies: Record<string, string>; bundleDependencies: string[]; scripts: Record<string, string>; files: string[] };
  assert.deepEqual([pkg.name, pkg.bin, pkg.engines], ['radial-cli', { radial: 'bin/radial' }, { node: '>=22.18' }]);
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@xterm/headless', 'node-pty', 'posthog-node']);
  assert.deepEqual(Object.keys(pkg.optionalDependencies), ['playwright-core']);
  assert.deepEqual(pkg.bundleDependencies, ['node-pty']);
  assert.equal(pkg.scripts.postinstall, 'node out/headless/nodePty.js install');
  assert.ok(pkg.files.includes('out/headless/') && pkg.files.includes('out/main/cli.js') && !pkg.files.includes('out/main/'), 'out/main ships file by file');
  const bin = execFileSync('tar', ['-xzOf', tarball, 'package/bin/radial'], { encoding: 'utf8' });
  assert.match(bin, /^#!\/usr\/bin\/env node\n/); assert.match(bin, /require\('\.\.\/out\/headless\/npmBin\.js'\)/);
  assert.ok(!/MacOS|\.app\b/.test(bin), 'the package’s radial never looks for a Mac app');
  const readme = execFileSync('tar', ['-xzOf', tarball, 'package/README.md'], { encoding: 'utf8' });
  assert.match(readme, /^# radial-cli\n\nRadial also runs without its window/); assert.ok(!/—| \/ /.test(readme), 'no em dashes or slash separators');
  assert.ok(logs.some((l) => /Not official: no analytics key, sends nothing\./.test(l)));
  // --official: the key goes in, from the environment.
  const was = process.env.RADIAL_POSTHOG_KEY;
  process.env.RADIAL_POSTHOG_KEY = 'phc_stand_in';
  console.log = () => {};
  try {
    const official = await pack(['--out', tmpDir('radial-pack-official-'), '--no-build', '--official']);
    const config = JSON.parse(execFileSync('tar', ['-xzOf', official, 'package/out/main/official-build.json'], { encoding: 'utf8' })) as { posthogKey: string; posthogHost: string };
    assert.deepEqual(config, { posthogKey: 'phc_stand_in', posthogHost: 'https://us.i.posthog.com' });
  } finally { console.log = log; if (was === undefined) delete process.env.RADIAL_POSTHOG_KEY; else process.env.RADIAL_POSTHOG_KEY = was; }
  assert.equal(fs.existsSync(path.join(OUT, 'main', 'official-build.json')), false, 'the key never lands in out/');
});
