import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { compiledSource } from './support/compiledSource';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import type { TestContext } from 'node:test';
import { tmpDir } from './support/tmp';

/** env's exports: the compiled module replaces module.exports with them when it runs in the sandbox. */
type EnvModule = typeof import('../src/main/env');

function fixture(t: TestContext) {
  const root = tmpDir('radial-claude-cache-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let shellPath = path.join(root, 'original'), clock = 10000, probes = 0, shells = 0;
  const module = { exports: {} as unknown };
  vm.runInNewContext(compiledSource(require.resolve('../src/main/env')), {
    module, process: { platform: 'darwin', env: { SHELL: '/fixture-shell', PATH: '' } },
    Date: { now: () => clock },
    require: (name: string): unknown => name === 'child_process' ? { execFileSync: (file: string, args: string[], opts: ExecFileSyncOptionsWithStringEncoding) => {
      if (file === '/fixture-shell') { shells++; return `__RADIAL_PATH__${shellPath}__RADIAL_PATH__`; }
      probes++; return execFileSync(file, args, opts);
    } } : name === 'fs' ? { ...fs, accessSync: (file: string, mode: number) => {
      if (!file.startsWith(root + path.sep)) throw Error('Not a fixture executable');
      fs.accessSync(file, mode);
    } } : name === 'os' ? { homedir: () => root } : require(name),
  });
  const install = (dir: string, version = '2.1.267') => {
    fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'claude');
    fs.writeFileSync(file, `#!/bin/sh\nprintf 'Claude Code ${version}\\n'\n`, { mode: 0o755 }); return file;
  };
  return { root, env: module.exports as EnvModule, install, get dir() { return shellPath; },
    relocate: () => { shellPath = path.join(root, 'relocated'); return shellPath; },
    advance: () => { clock += 5001; }, counts: () => ({ probes, shells }) };
}

for (const change of ['removed', 'not executable', 'broken symlink']) {
  test(`Claude is rediscovered after its cached executable is ${change}`, t => {
    const f = fixture(t), original = f.install(f.dir);
    assert.equal(f.env.claudeBin(), original);
    const counts = f.counts();
    assert.equal(f.env.claudeBin(), original);
    assert.deepEqual(f.counts(), counts, 'healthy cache does not rerun the CLI or login shell');
    if (change === 'not executable') fs.chmodSync(original, 0o644);
    else { fs.unlinkSync(original); if (change === 'broken symlink') fs.symlinkSync('missing-version', original); }
    const replacement = f.install(f.relocate());
    assert.equal(f.env.claudeBin(), replacement, 'refreshes the shell PATH and resolves the new executable');
    assert.match(execFileSync(f.env.claudeBin()!, ['--version'], { encoding: 'utf8' }), /2\.1\.267/);
  });
}

test('missing Claude is not cached forever, and version selection still prefers the newer install', t => {
  const f = fixture(t);
  assert.equal(f.env.claudeBin(), null);
  const counts = f.counts(); assert.equal(f.env.claudeBin(), null); assert.deepEqual(f.counts(), counts);
  const file = f.install(f.dir); f.advance(); assert.equal(f.env.claudeBin(), file);
  const newer = f.install(path.join(f.root, 'additional'), '3.0.0');
  f.env.registerExtraBin(path.dirname(newer));
  assert.equal(f.env.claudeBin(), newer);
});
