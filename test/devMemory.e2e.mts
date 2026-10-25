// A dev server over the memory limit is restarted, and stopped with a note only
// when it blows past double the limit again right after two restarts (src/main/
// devMemory.js; docs/memory-leak-report-2026-10-11.md). The server holds ~250 MB of random
// bytes (random so macOS can't compress it below the limit) against a 120 MB
// limit checked every 3s. Also: nothing kills the server Radial just started,
// and each restart and the stop is counted in the anonymous usage stats (sending
// forced on, to a local sink; telemetry-log.jsonl holds exactly what was sent).
/// <reference path="../src/renderer/types.d.ts" />
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the page functions reach in Radial's window: the preload's API, the
// events this test records, and renderer.ts's tabs (src/renderer/types.d.ts Tab).
interface RadialWindow extends Window {
  radial: RadialApi;
  __devmem: string[];
}
declare const window: RadialWindow;
declare function tabByRepo(repoDir: string | null | undefined): Tab | null;

test('a runaway dev server is restarted twice, then stopped with a note', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-devmem-'));
  const site = path.join(dir, 'hungry'); fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'package.json'), JSON.stringify({ name: 'hungry', private: true, scripts: { dev: 'node server.js' } }));
  fs.writeFileSync(path.join(site, 'server.js'), `const http = require('http'), { randomFillSync } = require('crypto');
const hog = []; for (let i = 0; i < 25; i++) hog.push(randomFillSync(Buffer.alloc(10 * 1024 * 1024)));
const port = process.env.PORT || 4321;
http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<h1>Hungry ' + hog.length + '</h1>'); }).listen(port, () => console.log('ready http://localhost:' + port));
setInterval(() => { for (const b of hog) for (let i = 0; i < b.length; i += 4096) b[i]++; }, 500); // stays resident, like a build tool's live heap`);
  fs.writeFileSync(path.join(dir, 'radial-store.json'), JSON.stringify({ projectsDir: dir, recents: [{ path: site, name: 'hungry', kind: 'local' }], session: { open: [site], active: site } }));
  const sink = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }); });
  await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve));
  const env: Record<string, string> = { ...process.env, RADIAL_USERDATA: dir, RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1', RADIAL_DEV_MEM_LIMIT_MB: '120', RADIAL_DEV_MEM_CHECK_MS: '3000',
    RADIAL_TELEMETRY_FORCE: '1', RADIAL_POSTHOG_KEY: 'phc_e2e', RADIAL_POSTHOG_HOST: `http://127.0.0.1:${(sink.address() as AddressInfo).port}` };
  delete env.RADIAL_OPEN;
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.resolve('node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    await page.evaluate(() => {
      window.__devmem = [];
      window.radial.onDevMemoryRestarted(p => window.__devmem.push('restarted ' + p.gb));
      window.radial.onDevMemoryStopped(p => window.__devmem.push('stopped ' + p.gb));
      window.radial.onLog(line => { if (/exited unexpectedly/.test(line)) window.__devmem.push('crashed'); });
    });
    await page.waitForFunction(() => window.__devmem.some(e => e.startsWith('stopped')), null, { timeout: 60000 }).catch(async (e: Error) => { throw new Error(e.message + ' events: ' + JSON.stringify(await page.evaluate(() => window.__devmem))); });
    await new Promise(r => setTimeout(r, 7000)); // two more checks: a stopped server stays stopped
    const events = await page.evaluate(() => window.__devmem);
    assert.deepEqual(events.map(e => e.split(' ')[0]), ['restarted', 'restarted', 'stopped'], events.join(', ')); // 250 MB is over double the 120 MB limit
    assert.match(await page.locator('#devMemPill').textContent() as string, /stopped to protect your Mac/);
    assert.equal(await page.evaluate(p => tabByRepo(p)?.suspended, site), true);
    const sent = fs.readFileSync(path.join(dir, 'telemetry-log.jsonl'), 'utf8').trim().split('\n').map(line => (JSON.parse(line) as { event: string }).event);
    assert.deepEqual(sent.filter(e => e.startsWith('dev_server_memory_')), ['dev_server_memory_restarted', 'dev_server_memory_restarted', 'dev_server_memory_stopped'], sent.join(', '));
  } finally { await app.close(); sink.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
