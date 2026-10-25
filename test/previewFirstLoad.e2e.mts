// A preview's first page load is never thrown away to start the same page
// again. A thread restoring the page a project just opened on asks for it while
// that page is still loading; starting it over aborted the load (an ERR_ABORTED
// error in the console), and on Electron 44 a load aborted that early can crash
// the preview's renderer while a debugger is attached to it, as this suite's is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchApp } from './support/app.ts';

/** renderer.ts's top-level declarations, which page functions reach by name (types.d.ts has the full types). */
declare function openProjectPath(dir: string): Promise<{ ok: boolean }>;
declare function loadRoute(route: string, li?: HTMLElement | null, tab?: Tab | null, onComplete?: () => void): void;
declare function activeTab(): Tab | null;
/** A project tab, the fields read here. */
interface Tab { baseUrl: string | null; webview: HTMLElement & { executeJavaScript(code: string): Promise<unknown> } }
/** What the main process records about the previews (set up in the test). */
type MainGlobals = typeof globalThis & { previewNavigations: string[]; previewsGone: string[] };

test('asking for the page a new preview is still loading lets that load finish', { timeout: 90000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-first-load-'));
  const site = path.join(scratch, 'site');
  fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>First load</title><h1>First load</h1>');
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const app = await launchApp({
    executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'),
    args: process.env.RADIAL_APP_PATH ? [] : ['.'],
    env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' },
  });
  try {
    const win = await app.firstWindow();
    await win.waitForFunction(() => typeof openProjectPath === 'function' && typeof loadRoute === 'function');
    await app.evaluate(({ app: electronApp }) => {
      const main = globalThis as MainGlobals;
      main.previewNavigations = [];
      main.previewsGone = [];
      electronApp.on('web-contents-created', (_event, contents) => {
        if (contents.getType() !== 'webview') return;
        contents.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument) main.previewNavigations.push(details.url); });
        contents.on('render-process-gone', (_e, gone) => { main.previewsGone.push(gone.reason); });
      });
    });
    const finished = await win.evaluate(async (dir) => {
      const opened = await openProjectPath(dir); // the new preview starts loading its first page
      // Once the preview's page exists (before that, a new src only creates it)...
      const wv = activeTab()!.webview as Tab['webview'] & { getWebContentsId(): number };
      const attached = () => { try { wv.getWebContentsId(); return true; } catch { return false; } };
      if (!attached()) await new Promise((resolve) => { wv.addEventListener('did-attach', resolve, { once: true }); setTimeout(resolve, 5000); });
      // ...what a thread restore does before the first page is up: ask for it (twice;
      // the newer request is the one that completes, as with any two navigations).
      loadRoute('/', null, activeTab());
      const done = new Promise<boolean>((resolve) => { loadRoute('/', null, activeTab(), () => resolve(true)); setTimeout(() => resolve(false), 10000); });
      return opened.ok && await done;
    }, site);
    assert.equal(finished, true, 'the navigation that asked for the page completes when the first load commits');
    await win.waitForFunction(() => activeTab()!.webview.executeJavaScript('document.querySelector("h1")?.textContent').then((text) => text === 'First load').catch(() => false), null, { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const seen = await app.evaluate(() => { const main = globalThis as MainGlobals; return { navigations: main.previewNavigations, gone: main.previewsGone }; });
    assert.deepEqual(seen.gone, [], 'the preview did not crash');
    assert.equal(seen.navigations.length, 1, `one document load, not one per request: ${seen.navigations.join(', ')}`);
  } finally {
    await app.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
