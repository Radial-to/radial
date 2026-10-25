import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as restartRequests from '../src/main/restartRequests';
import { tmpDir } from './support/tmp';

function tmp() { return tmpDir('radial-rr-'); }
const waitFor = async (fn: () => boolean, ms = 8000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('touching .radial/restart-dev-server fires onRequest and removes the file', async () => {
  const dir = tmp();
  let fired = 0;
  const dispose = restartRequests.watch(dir, () => fired++, 50);
  try {
    fs.writeFileSync(restartRequests.requestPath(dir), '');
    await waitFor(() => fired === 1);
    assert.equal(fs.existsSync(restartRequests.requestPath(dir)), false);
  } finally { dispose(); }
});

test('a request left while the project was closed fires as soon as the watch starts', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.radial'), { recursive: true });
  fs.writeFileSync(restartRequests.requestPath(dir), '');
  let fired = 0;
  const dispose = restartRequests.watch(dir, () => fired++, 50);
  try {
    await waitFor(() => fired === 1);
    assert.equal(fs.existsSync(restartRequests.requestPath(dir)), false);
  } finally { dispose(); }
});

test('other files in .radial (dev.json etc.) do not trigger a restart', async () => {
  const dir = tmp();
  let fired = 0;
  const dispose = restartRequests.watch(dir, () => fired++, 50);
  try {
    fs.writeFileSync(path.join(dir, '.radial', 'dev.json'), '{}');
    fs.writeFileSync(path.join(dir, '.radial', 'comments.json'), '[]');
    await new Promise((r) => setTimeout(r, 200)); // give watch events time to (not) arrive
    assert.equal(fired, 0);
  } finally { dispose(); }
});

test('consume() is single-shot — a second consume without a new request is false', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.radial'), { recursive: true });
  fs.writeFileSync(restartRequests.requestPath(dir), '');
  assert.equal(restartRequests.consume(dir), true);
  assert.equal(restartRequests.consume(dir), false);
});

test('the disposer stops the watch — later requests do not fire', async () => {
  const dir = tmp();
  let fired = 0;
  const dispose = restartRequests.watch(dir, () => fired++, 50);
  dispose();
  fs.writeFileSync(restartRequests.requestPath(dir), '');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fired, 0);
});

// ── Parameterized basename (agent requests, e.g. run-launch-check) ────────

test('a second basename watches its own request file, independent of restart', async () => {
  const dir = tmp();
  let fired = 0;
  const dispose = restartRequests.watch(dir, () => fired++, 50, 'run-launch-check');
  try {
    fs.writeFileSync(restartRequests.requestPath(dir, 'run-launch-check'), '');
    await waitFor(() => fired === 1);
    assert.equal(fs.existsSync(restartRequests.requestPath(dir, 'run-launch-check')), false);
    // The default restart request is NOT this watcher's to consume.
    fs.writeFileSync(restartRequests.requestPath(dir), '');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fired, 1);
    assert.equal(fs.existsSync(restartRequests.requestPath(dir)), true);
  } finally { dispose(); }
});
