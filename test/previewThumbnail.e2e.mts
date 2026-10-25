// The "Open now" card's picture of a project is shrunk in the main process
// (a full-size capture shipped to the window stalled every terminal for
// 150-300 ms), and a project is pictured at most every 2 minutes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchApp } from './support/app.ts';

// The window's globals the test calls (renderer.ts), as far as it uses them.
interface ProjectTab { repoDir: string; _thumb?: string; _thumbAt?: number }
declare const tabs: ProjectTab[];
declare function activeTab(): ProjectTab | null;
declare function captureTabThumb(tab: ProjectTab | null | undefined): Promise<void>;

test('project pictures are small, made in the main process, and not retaken on every switch', { timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-thumb-'));
  const site = path.join(dir, 'site'); fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'index.html'), '<body style="margin:0;background:#2a6"><h1 style="font:64px sans-serif;color:#fff">Thumbnail</h1></body>');
  fs.writeFileSync(path.join(dir, 'radial-store.json'), JSON.stringify({ projectsDir: dir, recents: [{ path: site, name: 'site', kind: 'local' }], session: { open: [site], active: site } }));
  const env: Record<string, string> = { ...process.env, RADIAL_USERDATA: dir, RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' };
  delete env.RADIAL_OPEN;
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.resolve('node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(30000);
    await page.waitForFunction(p => typeof tabs !== 'undefined' && activeTab()?.repoDir === p, site);
    await page.waitForFunction(() => !!activeTab()!._thumb, null, { timeout: 30000 }); // taken after the page loads
    const first = await page.evaluate(() => ({ thumb: activeTab()!._thumb!, at: activeTab()!._thumbAt }));
    assert.match(first.thumb, /^data:image\/png;base64,/);
    const width = await page.evaluate(src => new Promise<number>(resolve => { const img = new Image(); img.onload = () => resolve(img.naturalWidth); img.src = src; }), first.thumb);
    assert.equal(width, 360, 'shrunk before it reaches the window');
    await page.evaluate(() => captureTabThumb(activeTab()));
    assert.equal(await page.evaluate(() => activeTab()!._thumbAt), first.at, 'not retaken within 2 minutes');
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
