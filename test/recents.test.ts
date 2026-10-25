import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as recents from '../src/main/recents';
import { tmpDir } from './support/tmp';

function tmp() { return tmpDir('radial-rec-'); }

test('records and lists recent projects, newest first', () => {
  recents.init(tmp());
  const a = tmp(); const b = tmp();
  recents.addRecent(a, 'Alpha');
  recents.addRecent(b, 'Beta');
  const list = recents.listRecents();
  assert.equal(list[0].path, b); // newest first
  assert.equal(list[1].path, a);
});

test('re-adding moves a project to the top without duplicating', () => {
  recents.init(tmp());
  const a = tmp(); const b = tmp();
  recents.addRecent(a, 'Alpha');
  recents.addRecent(b, 'Beta');
  recents.addRecent(a, 'Alpha');
  const list = recents.listRecents();
  assert.equal(list.length, 2);
  assert.equal(list[0].path, a);
});

test('caches a favicon and carries it across a re-open', () => {
  recents.init(tmp());
  const a = tmp();
  recents.addRecent(a, 'Alpha');
  recents.setFavicon(a, 'data:image/png;base64,ABC');
  assert.equal(recents.listRecents()[0].favicon, 'data:image/png;base64,ABC');
  // Re-opening the same project must NOT wipe the cached favicon.
  recents.addRecent(a, 'Alpha');
  assert.equal(recents.listRecents()[0].favicon, 'data:image/png;base64,ABC');
});

test('setFavicon on an unknown project is a no-op (no throw)', () => {
  recents.init(tmp());
  recents.setFavicon(tmp(), 'data:image/png;base64,XYZ'); // never added
  assert.equal(recents.listRecents().length, 0);
});

test('drops recents whose folder no longer exists', () => {
  recents.init(tmp());
  const a = tmp();
  recents.addRecent(a, 'Alpha');
  fs.rmSync(a, { recursive: true, force: true });
  assert.equal(recents.listRecents().length, 0);
});

test('scans a projects folder for website projects', () => {
  recents.init(tmp());
  const root = tmp();
  fs.mkdirSync(path.join(root, 'site-a'));
  fs.writeFileSync(path.join(root, 'site-a', 'package.json'), '{}');
  fs.mkdirSync(path.join(root, 'site-b'));
  fs.writeFileSync(path.join(root, 'site-b', 'index.html'), '<h1>x</h1>');
  fs.mkdirSync(path.join(root, 'not-a-site')); // no markers
  recents.setProjectsDir(root);
  const found = recents.scanProjectsDir().map((p) => p.name).sort();
  assert.deepEqual(found, ['site-a', 'site-b']);
});

test('the folder of the last migration files pick is remembered across launches', () => {
  const userData = tmp();
  recents.init(userData);
  assert.equal(recents.getFilesDir(), null);
  recents.setFilesDir('/Users/someone/Brand assets');
  recents.init(userData); // the next launch reads the store again
  assert.equal(recents.getFilesDir(), '/Users/someone/Brand assets');
});

// The app marks itself running at boot (markRunning) and cleanly closed at
// quit (markCleanExit); the window, restoring the last session after boot, asks
// whether the run before this one ended without that close (crashedLastRun).
function relaunch(dir: string): boolean {
  recents.init(dir);
  recents.markRunning(); // boot marks this run before the window asks
  return recents.crashedLastRun();
}

test('after a clean quit, the next launch does not report a crash', () => {
  const dir = tmp();
  relaunch(dir);
  recents.markCleanExit();
  assert.equal(relaunch(dir), false);
});

test('a run that never reached its clean quit is reported as a crash by the next launch', () => {
  const dir = tmp();
  relaunch(dir); // runs, then dies without markCleanExit
  assert.equal(relaunch(dir), true);
});

test('a first launch is not a crash', () => {
  assert.equal(relaunch(tmp()), false);
});
