// A link in the preview opened with ⌘-click or a middle click goes to the
// default browser, through the same http(s)-only check as every link that
// leaves the preview, instead of a bare preview window. A plain click still
// follows the link in the preview.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { launchApp } from './support/app.ts';

/** renderer.ts's top-level declarations, which page functions reach by name (types.d.ts has the full types). */
declare function openProjectPath(dir: string): Promise<{ ok: boolean }>;
declare function activeTab(): Tab | null;
declare function setCanvasMode(mode: 'none' | 'select', tab?: Tab | null): void;
/** A project tab, the fields read here: its preview, an Electron <webview>. */
interface Tab { baseUrl: string | null; webview: HTMLElement & { executeJavaScript(code: string): Promise<unknown>; getURL(): string; isLoading(): boolean } }
/** The main process's global object, with the URLs this test records there instead of opening them. */
type MainGlobal = typeof globalThis & { openedExternally: string[] };

test('⌘-click and middle-click on a link in the preview open it in the default browser; a plain click follows it in the preview', { timeout: 90000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-preview-links-'));
  const site = path.join(scratch, 'site');
  fs.mkdirSync(site);
  // One link that fills the page, so a click in the middle of the preview lands on it at any preview scale.
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>Links</title><a id="next" href="/next.html" style="position:fixed;inset:0;display:block;background:#eef">Next page</a>');
  fs.writeFileSync(path.join(site, 'next.html'), '<!doctype html><title>Next</title><h1>Next page</h1>');
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const app = await launchApp({
    executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'),
    args: process.env.RADIAL_APP_PATH ? [] : ['.'],
    env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' },
  });
  try {
    const win = await app.firstWindow();
    const errors: string[] = [];
    win.on('pageerror', (error) => errors.push(error.message));
    await win.waitForFunction(() => typeof openProjectPath === 'function' && typeof setCanvasMode === 'function');
    assert.equal((await win.evaluate((dir) => openProjectPath(dir), site)).ok, true);
    await win.waitForFunction(() => { const t = activeTab(); try { return !!t && !!t.baseUrl && !t.webview.isLoading() && /^http/.test(t.webview.getURL()); } catch { return false; } }, null, { timeout: 30000 });
    await win.waitForFunction(() => activeTab()!.webview.executeJavaScript('!!document.getElementById("next")').catch(() => false), null, { timeout: 15000 });
    const start = await win.evaluate(() => activeTab()!.webview.getURL());
    const next = new URL('/next.html', start).href;
    // Browsing (no canvas tool), so a click reaches the page's own link. The
    // preview opens in Select, which the page's overlay marks on <html>: wait
    // for it to take Select up and then put it down, so no click lands mid-switch.
    const selecting = () => activeTab()!.webview.executeJavaScript('document.documentElement.classList.contains("radial-select-on")');
    await win.waitForFunction(selecting, null, { timeout: 15000 });
    await win.evaluate(() => setCanvasMode('none'));
    await win.waitForFunction(async () => !(await activeTab()!.webview.executeJavaScript('document.documentElement.classList.contains("radial-select-on")')), null, { timeout: 15000 });
    // Record what would reach the default browser instead of launching it.
    await app.evaluate(({ shell }) => { (globalThis as MainGlobal).openedExternally = []; shell.openExternal = async (url) => { (globalThis as MainGlobal).openedExternally.push(url); }; });
    const opened = async (count: number) => {
      const deadline = Date.now() + 5000;
      let urls: string[] = [];
      while (Date.now() < deadline) { urls = await app.evaluate(() => (globalThis as MainGlobal).openedExternally); if (urls.length >= count) break; await delay(50); }
      return urls;
    };
    const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    const box = await win.evaluate(() => { const r = activeTab()!.webview.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });

    await win.keyboard.down('Meta');
    await win.mouse.click(box.x, box.y);
    await win.keyboard.up('Meta');
    assert.deepEqual(await opened(1), [next], '⌘-click opens the link in the default browser');
    await win.mouse.click(box.x, box.y, { button: 'middle' });
    assert.deepEqual(await opened(2), [next, next], 'a middle click does too');
    await delay(300);
    assert.equal(await windows(), 1, 'no preview window opens');
    assert.equal(await win.evaluate(() => activeTab()!.webview.getURL()), start, 'the preview stays on its page');

    await win.mouse.click(box.x, box.y);
    await win.waitForFunction((url) => activeTab()!.webview.getURL() === url, next, { timeout: 10000 });
    assert.equal((await opened(2)).length, 2, 'a plain click opens nothing outside the preview');
    assert.equal(await windows(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
