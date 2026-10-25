// Only official builds update themselves. A build from source has no feed and
// no official config, so the updater never loads electron-updater there.

import { test } from 'node:test';
import assert from 'node:assert';
import * as updater from '../src/main/updater';

test('builds from source and dev runs never check for updates', async () => {
  // init is a no-op: no timers, nothing loaded (it would throw on a missing yml).
  updater.init({ isPackaged: true, isOfficial: false, onDownloaded: () => assert.fail('no download') });
  updater.init({ isPackaged: false, isOfficial: true, onDownloaded: () => assert.fail('no download') });
  assert.deepEqual(await updater.check({ isPackaged: true, isOfficial: false, currentVersion: '1.0.0' }), { state: 'source-build' });
  assert.equal((await updater.check({ isPackaged: false, isOfficial: false, currentVersion: '1.0.0' })).state, 'error');
  assert.equal(updater.ready(), null);
  assert.equal(updater.restart(), false);
});

// On macOS electron-updater says update-downloaded before Squirrel.Mac has
// checked the new app's signature; Restart only works once Squirrel has it.
import { EventEmitter } from 'node:events';
import type { AppUpdater } from 'electron-updater';

/** A stand-in electron-updater autoUpdater: checks find `latest`; the test emits its events. */
function fakeAuto(latest: string) {
  const auto = Object.assign(new EventEmitter(), {
    autoDownload: false, autoInstallOnAppQuit: false, installs: 0,
    checkForUpdates: async () => ({ updateInfo: { version: latest }, isUpdateAvailable: true }),
    quitAndInstall() { auto.installs++; },
  });
  return auto;
}
const official = { isPackaged: true, isOfficial: true, currentVersion: '1.0.0' };

test('on macOS an update is ready only once Squirrel.Mac has it', async () => {
  const auto = fakeAuto('1.0.1'), squirrel = new EventEmitter();
  const u = updater.createUpdater({ autoUpdater: () => auto as unknown as AppUpdater, squirrel: () => squirrel });
  const ready: (string | undefined)[] = [];
  u.init({ ...official, onDownloaded: (info) => ready.push(info.version), onRefused: () => assert.fail('not refused') });
  assert.deepEqual(await u.check(official), { state: 'available', version: '1.0.1' });
  assert.equal(auto.autoDownload, true);
  assert.equal(auto.autoInstallOnAppQuit, true, 'hands each download to Squirrel at once');
  auto.emit('update-downloaded', { version: '1.0.1' }); // electron-updater has the zip; Squirrel is checking it
  assert.equal(u.ready(), null);
  assert.equal(u.restart(), false, 'a Restart now would wait forever');
  assert.equal((await u.check(official)).state, 'available');
  squirrel.emit('update-downloaded');
  assert.deepEqual(ready, ['1.0.1']);
  assert.deepEqual(await u.check(official), { state: 'downloaded', version: '1.0.1' });
  assert.equal(u.restart(), true);
  assert.equal(auto.installs, 1);
});

test('an update macOS refuses is offered as a download, never a Restart that does nothing', async () => {
  const auto = fakeAuto('2.0.0'), squirrel = new EventEmitter();
  const u = updater.createUpdater({ autoUpdater: () => auto as unknown as AppUpdater, squirrel: () => squirrel });
  const refused: updater.RefusedUpdate[] = [];
  const ready: (string | undefined)[] = [];
  u.init({ ...official, onDownloaded: (info) => ready.push(info.version), onRefused: (r) => refused.push(r) });
  await u.check(official);
  squirrel.emit('error', new Error('The request timed out.')); // before anything was handed over: not a refusal
  assert.equal(u.refusal(), null);
  auto.emit('update-downloaded', { version: '2.0.0' });
  squirrel.emit('error', new Error('Code signature at URL file:///… did not pass validation: code failed to satisfy specified code requirement(s)'));
  assert.deepEqual(refused.map((r) => r.version), ['2.0.0']);
  assert.match(refused[0].error, /code requirement/);
  assert.deepEqual(await u.check(official), { state: 'refused', version: '2.0.0', error: refused[0].error });
  assert.equal(u.ready(), null);
  assert.equal(u.restart(), false);
  assert.equal(auto.installs, 0);
  // The next background check hands the cached zip over again; if Squirrel takes it this time, it's ready.
  auto.emit('update-downloaded', { version: '2.0.0' });
  squirrel.emit('update-downloaded');
  assert.deepEqual(ready, ['2.0.0']);
  assert.equal(u.refusal(), null);
  assert.deepEqual(await u.check(official), { state: 'downloaded', version: '2.0.0' });
});

test('without Squirrel (not macOS) a download is ready at once', async () => {
  const auto = fakeAuto('1.0.1');
  const u = updater.createUpdater({ autoUpdater: () => auto as unknown as AppUpdater, squirrel: () => null });
  const ready: (string | undefined)[] = [];
  u.init({ ...official, onDownloaded: (info) => ready.push(info.version) });
  await u.check(official);
  auto.emit('update-downloaded', { version: '1.0.1' });
  assert.deepEqual(ready, ['1.0.1']);
  assert.deepEqual(await u.check(official), { state: 'downloaded', version: '1.0.1' });
});
