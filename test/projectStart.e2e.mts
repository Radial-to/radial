// Opening a project and waking it (resuming its dev server) can overlap for the
// same folder. Each must still do its own work and answer its own result: a
// wake that arrives during an open starts the dev server once the open is done,
// and an open that arrives during a wake opens the project once the wake is done.
/// <reference path="../src/renderer/types.d.ts" />
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenProjectResult, RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the page functions reach in Radial's window: the preload's API and
// renderer.ts's tabs (src/renderer/types.d.ts Tab).
interface RadialWindow extends Window { radial: RadialApi }
declare const window: RadialWindow;
declare const tabs: Tab[];
declare function tabByRepo(repoDir: string | null | undefined): Tab | null;
declare function openProjectPath(dir: string): Promise<{ ok: boolean; error?: string }>;

const launch = (env: Record<string, string>) => launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.resolve('node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env });

test('a restart request left while Radial was closed wakes the project it restores asleep', { timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-start-cold-'));
  const [front, back] = ['front', 'back'].map(name => { const site = path.join(dir, name); fs.mkdirSync(site); fs.writeFileSync(path.join(site, 'index.html'), `<title>${name}</title><h1>${name}</h1>`); return site; });
  // An agent still working in the closed app asked for a dev server for `back` (restartRequests.ts).
  const request = path.join(back, '.radial', 'restart-dev-server');
  fs.mkdirSync(path.dirname(request)); fs.writeFileSync(request, '');
  fs.writeFileSync(path.join(dir, 'radial-store.json'), JSON.stringify({ projectsDir: dir, recents: [{ path: front, name: 'front', kind: 'local' }, { path: back, name: 'back', kind: 'local' }], session: { open: [front, back], active: front } }));
  const env: Record<string, string> = { ...process.env, RADIAL_USERDATA: dir, RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' };
  delete env.RADIAL_OPEN; // restore the session
  const app = await launch(env);
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(30000);
    await page.waitForFunction(([a, b]) => typeof tabs !== 'undefined' && !!tabByRepo(a) && !!tabByRepo(b), [front, back]); // `back` opens asleep: it isn't the active one
    await page.waitForFunction(b => tabByRepo(b)!.suspended === false, back, { timeout: 30000 }).catch(async (e: Error) => {
      throw new Error(`${e.message}: back still asleep (request ${fs.existsSync(request) ? 'still there' : 'consumed'}, dev.json ${fs.existsSync(path.join(back, '.radial', 'dev.json')) ? 'written' : 'missing'})`);
    });
    assert.equal(fs.existsSync(request), false, 'the request was taken');
    const dev = JSON.parse(fs.readFileSync(path.join(back, '.radial', 'dev.json'), 'utf8')) as { url: string };
    assert.equal((await fetch(dev.url)).status, 200, 'its dev server answers');
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

/**
 * Radial with one project open and then put to sleep. Its dev server takes 3
 * seconds to listen: long enough to close (and reopen) the project while it wakes.
 */
async function asleepSlowProject(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const site = path.join(dir, 'slow'); fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'package.json'), JSON.stringify({ name: 'slow', private: true, scripts: { dev: 'node server.js' } }));
  fs.writeFileSync(path.join(site, 'server.js'), `const http = require('http'); const port = process.env.PORT || 4321;
setTimeout(() => http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<h1>Slow</h1>'); }).listen(port, () => console.log('ready http://localhost:' + port)), 3000);`);
  fs.writeFileSync(path.join(dir, 'radial-store.json'), JSON.stringify({ projectsDir: dir, recents: [], session: { open: [], active: null } }));
  const app = await launch({ ...process.env, RADIAL_USERDATA: dir, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' });
  const done = async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(30000);
    await page.waitForFunction(() => typeof openProjectPath === 'function');
    const opened = await page.evaluate(s => openProjectPath(s), site);
    assert.equal(opened.ok, true, opened.error);
    assert.deepEqual(await page.evaluate(s => window.radial.sleepProject(s), site), { ok: true });
    return { page, site, done };
  } catch (e) { await done(); throw e; }
}

test('reopening a project closed while it was waking opens it, not the wake\'s URL', { timeout: 90000 }, async () => {
  const { page, site, done } = await asleepSlowProject('radial-start-reopen-');
  try {
    // In one go, as the main process takes them in order: wake it, close it while its server starts, open it again.
    const reopened = await page.evaluate(async s => {
      const waking = window.radial.setActive(s);
      const closing = window.radial.closeProject(s);
      const answer = await window.radial.openProject(s) as OpenProjectResult | string | null; // what arrives, whatever the contract says
      await waking; await closing;
      return answer;
    }, site);
    assert.equal(typeof reopened, 'object', `the open answered ${JSON.stringify(reopened)}`);
    const result = reopened as OpenProjectResult; // an object, checked above
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal((await fetch(result.url!)).status, 200, 'the reopened project\'s dev server answers');
  } finally { await done(); }
});

test('a project closed while it wakes doesn\'t keep the dev server that comes up', { timeout: 90000 }, async () => {
  const { page, site, done } = await asleepSlowProject('radial-start-close-');
  try {
    // Wake it and close it while its server starts; the wake answers once the server is up.
    const woke = await page.evaluate(async s => { const waking = window.radial.setActive(s); await window.radial.closeProject(s); return waking; }, site);
    const devJson = path.join(site, '.radial', 'dev.json');
    assert.equal(fs.existsSync(devJson), false, `the closed project's server still runs: ${fs.existsSync(devJson) ? fs.readFileSync(devJson, 'utf8') : ''}`);
    if (woke.ok && woke.url) await assert.rejects(fetch(woke.url), 'nothing answers at the URL the wake reported');
  } finally { await done(); }
});
