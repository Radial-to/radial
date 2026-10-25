import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { actionForPath, enabled } from '../src/main/devReload';

const root = path.resolve('/tmp/radial');
const inRoot = (...parts: string[]) => path.join(root, ...parts);

test('development reload classifies renderer, preload, main and core changes', () => {
  assert.equal(actionForPath(root, inRoot('src', 'renderer', 'renderer.js')), 'reload');
  assert.equal(actionForPath(root, inRoot('src', 'preload', 'preload.js')), 'reload');
  assert.equal(actionForPath(root, inRoot('src', 'overlay', 'overlay.ts')), 'reload');
  assert.equal(actionForPath(root, inRoot('src', 'main', 'main.js')), 'restart');
  assert.equal(actionForPath(root, inRoot('src', 'core', 'sessions.ts')), 'restart');
  assert.equal(actionForPath(root, inRoot('package.json')), 'restart');
  assert.equal(actionForPath(root, inRoot('test', 'devReload.test.js')), null);
});

test('development reload is off for packaged and smoke-test runs', () => {
  assert.equal(enabled({ isPackaged: false }, {}), true);
  assert.equal(enabled({ isPackaged: true }, {}), false);
  assert.equal(enabled({ isPackaged: false }, { RADIAL_SMOKE: '1' }), false);
  assert.equal(enabled({ isPackaged: false }, { RADIAL_AUTO_RELOAD: '0' }), false);
});
