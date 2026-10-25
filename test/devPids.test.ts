import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as devPids from '../src/main/devPids';
import * as devServer from '../src/main/devServer';
import { tmpDir } from './support/tmp';

function tmp() { return tmpDir('radial-dp-'); }

test('devPids records, reads, and clears a dev server pid', () => {
  devPids.init(tmp());
  devPids.set('/repo/a', 1234);
  assert.equal(devPids.get('/repo/a')!.pid, 1234);
  assert.ok(devPids.allPids().has(1234));
  devPids.clear('/repo/a');
  assert.equal(devPids.get('/repo/a'), null);
  assert.equal(devPids.allPids().has(1234), false);
});

test('devPids ignores empty input and survives a corrupt file', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'radial-devservers.json'), '{ broken');
  devPids.init(dir); // must not throw
  devPids.set('/repo/x', 0); // falsy pid → no-op
  assert.equal(devPids.get('/repo/x'), null);
});

test('devPids persists across a restart', () => {
  const dir = tmp();
  devPids.init(dir);
  devPids.set('/repo/persist', 4321);
  devPids.init(dir); // simulate relaunch
  assert.equal(devPids.get('/repo/persist')!.pid, 4321);
});

test('devProcessCommand returns a command for a live pid and null for a dead one', () => {
  if (process.platform === 'win32') return; // ps-based; skip on Windows
  const mine = devServer.devProcessCommand(process.pid);
  assert.ok(mine && /node/i.test(mine)); // this test runner is node
  assert.equal(devServer.devProcessCommand(2147483646), null); // implausible pid → not running
});
