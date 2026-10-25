import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ElectronApplication } from 'playwright-core';
import type { ChatEngine } from '../src/shared/chatPermissions.ts';
import type { OpenProjectResult, RadialApi, TermOpenUrl } from '../src/shared/radialApi.ts';
import type { PreviewMode, ThreadPreview, ViewportMode } from '../src/renderer/threadPreview.ts';
import { launchApp } from './support/app.ts';

// What the app's window carries that this check reaches (src/renderer/globals.d.ts, types.d.ts, renderer.ts).
/** An agent or shell session (TermSession): the daemon's pty id. */
interface TermSession { id: string }
/** A project tab (types.d.ts Tab), as far as this check reads it. */
interface Tab {
  id: string;
  repoDir: string;
  /** The dev server; null while the project sleeps. */
  baseUrl: string | null;
  currentRoute: string;
  previewMode: PreviewMode;
  viewportMode: ViewportMode;
  /** Visual zoom. */
  vz?: number;
  terminals?: TermSession[];
  /** The preview: Electron's <webview> (RadialWebview). */
  webview: HTMLElement & { executeJavaScript(code: string): Promise<unknown> };
  /** An in-flight preview navigation (PreviewNavigation). */
  _nav?: { full: string; startedAt: number } | null;
  _previewScroll?: { x: number; y: number };
  _restoringScroll?: number | null;
  _threadPreview?: ThreadPreview<TermSession>;
}
interface AppWindow extends Window { radial: RadialApi }
declare const window: AppWindow;
declare function activeTab(): Tab | null;
declare function openProjectPath(dir: string): Promise<OpenProjectResult & { repoDir?: string }>;
declare function addTerminal(tab: Tab | null, engine: ChatEngine | null): Promise<TermSession | null>;
declare function selectProjectTerminal(projectId: string, termId: string): Promise<void>;
declare function setDevicePreset(name: ViewportMode | 'desktop', tab?: Tab | null): void;
declare function zoomPreview(mult: number): void;
declare function softReloadPreview(tab: Tab): Promise<void>;
declare function routeAgentUrl(target?: Partial<TermOpenUrl>): void;

test('terminal threads restore their page, scroll, and viewport in the existing canvas', { timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-thread-preview-'));
  const repo = path.join(root, 'site'); fs.mkdirSync(repo);
  for (const [file, title] of [['index.html', 'Home'], ['pricing.html', 'Pricing'], ['about.html', 'About']]) {
    fs.writeFileSync(path.join(repo, file), `<!doctype html><html><head><title>${title}</title><style>h1{margin:50px}</style><script>setTimeout(() => document.body.style.height = '4000px', 250)</script></head><body><h1>${title}</h1><a href="/pricing.html">Pricing</a></body></html>`);
  }
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Initial site'], { cwd: repo });
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules/.bin/electron'), args: ['.'], cwd: process.cwd(),
      env: { ...process.env, RADIAL_USERDATA: path.join(root, 'app'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1', RADIAL_DEMO_FRESH: '1' } });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(() => typeof openProjectPath === 'function');
    await page.evaluate(dir => openProjectPath(dir), repo);
    await page.waitForFunction(() => activeTab() && !activeTab()!._nav);
    async function waitForGuest(condition: string) {
      for (let i = 0; i < 100; i++) {
        if (await page.evaluate(condition => activeTab()!.webview.executeJavaScript(condition), condition)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Guest did not become ready: ${condition}`);
    }
    const a = await page.evaluate(async () => { const t = await addTerminal(activeTab(), null); return t!.id; });
    await waitForGuest('document.body.style.height === "4000px"');
    await page.evaluate(() => activeTab()!.webview.executeJavaScript('scrollTo(0,640)'));
    await page.waitForFunction(() => activeTab()!._previewScroll?.y === 640);
    const b = await page.evaluate(async () => { const t = await addTerminal(activeTab(), null); return t!.id; });
    assert.equal(await page.evaluate(() => activeTab()!.webview.executeJavaScript('scrollY')), 640, 'new thread inherits the current page');
    await page.locator('#navUrl').fill('/pricing.html');
    await page.locator('#navUrl').press('Enter');
    await page.waitForFunction(() => activeTab()!.currentRoute === '/pricing.html' && !activeTab()!._nav);
    await waitForGuest('document.title === "Pricing" && document.readyState === "complete" && document.body.style.height === "4000px"');
    await page.evaluate(async () => { setDevicePreset('mobile'); zoomPreview(1.35); await activeTab()!.webview.executeJavaScript('scrollTo(0, 1200)'); });
    await page.waitForFunction(() => activeTab()!._previewScroll?.y === 1200);
    await page.locator(`.rail-term[data-tid="${a}"]`).click();
    await page.waitForFunction(() => activeTab()!.currentRoute === '/' && !activeTab()!._threadPreview?.restoring);
    assert.equal(await page.evaluate(() => activeTab()!.webview.executeJavaScript('scrollY')), 640);
    assert.equal(await page.evaluate(() => activeTab()!.viewportMode), 'locked');
    assert.equal(await page.evaluate(() => activeTab()!.vz), 1);
    await page.locator(`.rail-term[data-tid="${b}"]`).click();
    await page.waitForFunction(() => activeTab()!.currentRoute === '/pricing.html' && !activeTab()!._threadPreview?.restoring);
    assert.equal(await page.evaluate(() => activeTab()!.webview.executeJavaScript('scrollY')), 1200);
    assert.equal(await page.evaluate(() => activeTab()!.viewportMode), 'mobile');
    assert.equal(await page.evaluate(() => activeTab()!.vz), 1.35);
    await page.evaluate(() => softReloadPreview(activeTab()!));
    await page.waitForFunction(() => !activeTab()!._restoringScroll);
    assert.equal(await page.evaluate(() => activeTab()!.webview.executeJavaScript('scrollY')), 1200, 'live reload waits for delayed page layout before restoring scroll');
    assert.equal(app.windows().filter(w => w.url().includes('/renderer/index.html')).length, 1, 'switching threads keeps one workspace window');
    assert.equal(await page.locator('webview').count(), 1, 'threads reuse the project canvas');
    assert.equal(await page.locator('#navNewWindow').count(), 0, 'no separate preview-window control');
    await page.evaluate(async ids => {
      const tab = activeTab()!;
      await Promise.all([selectProjectTerminal(tab.id, ids[0]), selectProjectTerminal(tab.id, ids[1]), selectProjectTerminal(tab.id, ids[0])]);
    }, [a, b]);
    await page.waitForFunction(() => !activeTab()!._threadPreview?.restoring);
    assert.equal(await page.evaluate(() => activeTab()!.currentRoute), '/');
    assert.equal(await page.evaluate(() => activeTab()!.webview.executeJavaScript('scrollY')), 640);
    const meta = await page.evaluate(dir => window.radial.termList(dir), repo);
    assert.equal(meta.find(t => t.id === b)!.meta.preview!.route, '/pricing.html');
    assert.equal(meta.find(t => t.id === b)!.meta.preview!.scroll!.y, 1200);
    await page.reload();
    await page.waitForFunction(() => typeof openProjectPath === 'function');
    await page.evaluate(dir => openProjectPath(dir), repo);
    await page.waitForFunction(id => activeTab()?.terminals?.some(t => t.id === id), a);
    await page.evaluate(id => selectProjectTerminal(activeTab()!.id, id), b);
    await page.waitForFunction(() => !activeTab()!._threadPreview?.restoring);
    assert.equal(await page.evaluate(() => activeTab()!.currentRoute), '/pricing.html');
    assert.equal(await page.evaluate(() => activeTab()!.webview.executeJavaScript('scrollY')), 1200, 'reattached terminal retains the preview context');
    await page.evaluate(id => selectProjectTerminal(activeTab()!.id, id), a);
    await page.evaluate(id => routeAgentUrl({ termId: id, repoDir: activeTab()!.repoDir, url: new URL('/about.html', activeTab()!.baseUrl!).href }), b);
    assert.equal(await page.evaluate(() => activeTab()!.currentRoute), '/', 'background agent does not navigate the active thread');
    await page.evaluate(id => selectProjectTerminal(activeTab()!.id, id), b);
    assert.equal(await page.evaluate(() => activeTab()!.currentRoute), '/about.html');
    assert.equal(await page.evaluate(() => activeTab()!.webview.executeJavaScript('scrollY')), 0);
    const serverUrl = await page.evaluate(() => activeTab()!.baseUrl);
    const menu = () => page.locator('.rail-proj:not([data-home]) .rail-more').first();
    await menu().locator('..').hover();
    await menu().click();
    await page.getByLabel('One shared preview', { exact: false }).click();
    await page.waitForFunction(() => activeTab()!.previewMode === 'shared');
    await page.locator(`.rail-term[data-tid="${a}"]`).click();
    assert.equal(await page.evaluate(() => activeTab()!.currentRoute), '/about.html', 'shared preview stays put when switching agents');
    await page.locator('#navUrl').fill('/pricing.html');
    await page.locator('#navUrl').press('Enter');
    await page.waitForFunction(() => activeTab()!.currentRoute === '/pricing.html' && !activeTab()!._nav);
    await page.locator(`.rail-term[data-tid="${b}"]`).click();
    assert.equal(await page.evaluate(() => activeTab()!.currentRoute), '/pricing.html');
    const saved = await page.evaluate(dir => window.radial.stateGet(dir), repo);
    assert.equal(saved.previewMode, 'shared');
    assert.equal(saved.sharedPreview!.route, '/pricing.html');
    assert.equal((await page.evaluate(dir => window.radial.stateGet(dir + '/different-project'), repo)).previewMode, undefined, 'mode is scoped to this project');
    await page.reload();
    await page.waitForFunction(() => typeof openProjectPath === 'function');
    await page.evaluate(dir => openProjectPath(dir), repo);
    await page.waitForFunction(() => activeTab()?.previewMode === 'shared' && activeTab()!.currentRoute === '/pricing.html' && !activeTab()!._threadPreview?.restoring);
    await menu().locator('..').hover();
    await menu().click();
    assert.equal(await page.getByLabel('One shared preview', { exact: false }).isChecked(), true);
    await page.getByLabel('Preview per agent', { exact: false }).click();
    await page.waitForFunction(() => activeTab()!.previewMode === 'agent' && !activeTab()!._threadPreview?.restoring);
    assert.equal(await page.evaluate(() => activeTab()!.currentRoute), '/about.html', 'per-agent view survives shared mode and reload');
    await page.locator(`.rail-term[data-tid="${a}"]`).click();
    await page.waitForFunction(() => activeTab()!.currentRoute === '/' && !activeTab()!._threadPreview?.restoring);
    assert.equal(await page.evaluate(() => activeTab()!.webview.executeJavaScript('scrollY')), 640);
    assert.equal(await page.evaluate(() => activeTab()!.baseUrl), serverUrl, 'mode switches reuse the running server');
    assert.equal(await page.locator('webview').count(), 1);
    assert.equal(app.windows().filter(w => w.url().includes('/renderer/index.html')).length, 1);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(os.tmpdir(), 'radial-thread-preview.png') });
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
