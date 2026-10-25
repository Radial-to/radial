import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as devServer from '../src/main/devServer';
import { tmpDir } from './support/tmp';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeStaticRepo() {
  const dir = tmpDir('static-reload-');
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><h1>one</h1>');
  return dir;
}

test('static server pings onChanged when files change, debounced, until stopped', async () => {
  const repo = makeStaticRepo();
  let pings = 0;
  const handle = await devServer.start(repo, { onChanged: () => { pings += 1; } });
  try {
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    // Startup must be quiet: FSEvents replays pre-watcher events (the fixture
    // write) and publishDevInfo writes .radial/dev.json — none of it may ping.
    await sleep(1300);
    assert.equal(pings, 0, 'startup/dotdir events must not trigger a reload');

    // A burst of edits lands as one debounced ping.
    fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html><h1>two</h1>');
    fs.writeFileSync(path.join(repo, 'style.css'), 'h1{color:red}');
    await sleep(900);
    assert.ok(pings >= 1, 'a change should ping');
    const after = pings;

    fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html><h1>three</h1>');
    await sleep(900);
    assert.ok(pings > after, 'a later change pings again');
  } finally {
    await handle.stop();
  }
  const closed = pings;
  fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html><h1>four</h1>');
  await sleep(700);
  assert.equal(pings, closed, 'stop() must close the watcher');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('start without onChanged keeps the old behavior (no watcher, no crash)', async () => {
  const repo = makeStaticRepo();
  const handle = await devServer.start(repo, {});
  assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html><h1>two</h1>');
  await sleep(400);
  await handle.stop();
  fs.rmSync(repo, { recursive: true, force: true });
});
