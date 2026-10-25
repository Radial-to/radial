import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLibraryServer } from '../scripts/ui-library.mts';
import { catalog } from '../src/renderer/ui/catalog.ts';
import type { AddressInfo } from 'node:net';
import { launchApp, openWindow } from './support/app.ts';

/** The library page's window: a plain page; the test probes it for the preload's API (window.radial), which it must not have. */
interface LibraryWindow extends Window { radial?: unknown }
declare const window: LibraryWindow;

test('UI library: all pages, live styles, safe interactions, both themes, and narrow layout', { timeout: 120000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-ui-library-'));
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ recents: [], projectsDir: scratch, session: { open: [], active: null } }));
  const server = createLibraryServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules/.bin/electron'), args: ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_OPEN: ' ', RADIAL_DAEMON_EPHEMERAL: '1', RADIAL_AUTO_RELOAD: '0' } });
  const errors: string[] = [];
  try {
    await app.firstWindow();
    // The library in a window of its own, made the way the app makes its windows in this run (in the background, off screen).
    const page = await openWindow(app, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, { width: 1500, height: 1050, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.locator('#uiMain h1').waitFor();
    assert.equal(await page.evaluate(() => typeof window.radial), 'undefined');
    const shot = (name: string) => page.screenshot({ path: path.join(scratch, `${name}.png`), fullPage: true });
    await shot('01-overview');
    for (const entry of catalog) {
      await page.locator(`#uiNav a[href="#${entry.id}"]`).click();
      // The page renders on hashchange, which Chromium 152 (Electron 44) can fire after the click returns.
      await page.waitForFunction((name) => document.querySelector('#uiMain h1')?.textContent === name, entry.name, { timeout: 5000 }).catch(() => {});
      assert.equal(await page.locator('#uiMain h1').textContent(), entry.name);
      assert.equal(await page.locator('.ui-example').count(), entry.examples.length);
      assert.equal(await page.locator('#uiNav [aria-current="page"]').count(), 1);
      for (const source of entry.sources) assert.equal((await page.request.get(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${source}`)).status(), 200);
    }
    await page.locator('#uiSearch').fill('button');
    assert.ok(await page.locator('#uiNav a').count() < catalog.length);
    await page.locator('#uiSearch').fill('');
    await page.locator('#uiNav a[href="#inventory"]').click();
    await page.waitForFunction(() => document.querySelector('#uiCensus')!.textContent.includes('registered panels'));
    assert.ok(await page.locator('#uiPanels h3').count() >= 20);
    await page.locator('#uiNav a[href="#settings"]').click();
    await page.locator('[data-demo-segment] button').last().click();
    assert.equal(await page.locator('[data-demo-segment] button').last().getAttribute('aria-pressed'), 'true');
    await shot('02-settings-pattern');
    await page.locator('#uiNav a[href="#publish"]').click();
    await page.locator('.pm-target input').first().uncheck();
    assert.equal(await page.locator('[data-demo-publish]').isDisabled(), true);
    await page.locator('.pm-target input').last().check();
    await page.locator('[data-demo-publish]').click();
    assert.match(await page.locator('[data-demo-publish-status]').textContent() as string, /No changes were published/);
    await shot('03-publish-pattern');
    await page.locator('#uiNav a[href="#feedback"]').click();
    await page.locator('[data-demo-dialog]').click();
    assert.equal(await page.locator('dialog').isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement!.textContent), 'Cancel');
    await page.keyboard.press('Escape');
    await page.locator('dialog').waitFor({ state: 'detached' });
    assert.equal(await page.locator('dialog').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement!.hasAttribute('data-demo-dialog')), true);
    await page.locator('#uiNav a[href="#foundations"]').click();
    await shot('04-foundations-dark');
    await page.locator('[data-ui-theme="light"]').click();
    await shot('05-foundations-light');
    const contrast = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const styles = getComputedStyle(document.documentElement);
      const pixel = (fg: string | null, bg: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = bg; ctx.fillRect(0, 0, 1, 1); if (fg) { ctx.fillStyle = fg; ctx.fillRect(0, 0, 1, 1); } return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      const luminance = (rgb: number[]) => rgb.map((v) => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      const result = [];
      for (const dark of [false, true]) {
        document.documentElement.classList.toggle('light', !dark);
        for (const bgToken of ['--bg-2', '--bg-3']) for (const fgToken of ['--text', '--muted']) {
          const bg = styles.getPropertyValue(bgToken), fg = styles.getPropertyValue(fgToken);
          const a = luminance(pixel(fg, bg)), b = luminance(pixel(null, bg));
          result.push({ theme: dark ? 'dark' : 'light', pair: `${fgToken} on ${bgToken}`, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) });
        }
      }
      return result;
    });
    for (const pair of contrast) assert.ok(pair.ratio >= 4.5, JSON.stringify(pair));
    console.log('Measured text contrast:', JSON.stringify(contrast));
    await page.locator('#uiNav a[href="#buttons"]').click();
    await shot('06-buttons');
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('http://127.0.0.1')); win!.setSize(560, 900); });
    await shot('07-compact');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.deepEqual(errors, []);
    console.log(`UI library screenshots: ${scratch}`);
  } finally {
    await Promise.race([app.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 8000))]);
    try { app.process().kill('SIGKILL'); } catch {}
    await new Promise((resolve) => server.close(resolve));
  }
});
