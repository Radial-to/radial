/// <reference path="../src/renderer/types.d.ts" />
// Inspect tool E2E — the real app, a static fixture.
//
// The Inspect tool is back in the header pill; activating it (or inspecting an
// element with a click, ⌥-click from Select included) opens the Inspect panel
// pinned at the top of the right sidebar by default, and a panel the user moved
// (floating here) stays where they put it until it's closed. Holding ⌥ in
// Select borrows the tool: the pill lights Inspect, measurements draw in the
// preview, a click sends the element to the panel; release restores Select.
//
// Opt-in: `npm run test:e2e`. Skips cleanly without Playwright.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ElectronApplication } from 'playwright-core';
import { launchApp } from './support/app.ts';
const require = createRequire(import.meta.url);

/**
 * A project tab (types.d.ts Tab), its preview with Electron's WebviewTag isLoading, which
 * types.d.ts RadialWebview leaves out. Use Tab itself once RadialWebview has isLoading.
 */
type InspectTab = Tab & { webview: { isLoading(): boolean } };
// renderer.ts's top-level declarations, which page functions reach by name
// (ToolPanelState, ToolPanelId, CanvasToolMode and QuickEditState are types.d.ts's).
declare function activeTab(): InspectTab | null;
declare function tpState(): ToolPanelState;
declare function setCanvasMode(mode: CanvasToolMode | 'edit', tab?: Tab | null): void;
declare function tpPlacePanel(id: ToolPanelId, where: 'float' | 'home' | 'left' | 'right'): void;
declare function closeToolPanel(id: ToolPanelId): void;
declare function setQuickInspect(on: boolean, fromOverlay?: boolean): void;
declare let quickEdit: QuickEditState | null;
declare let selectMode: boolean;
declare let inspectMode: boolean;
declare let quickInspectOn: boolean;
/**
 * What the radial CLI printed, and its exit code: 0 on success; when it failed, the child's exit
 * status or Node's error code string such as 'ENOENT' (1 when there is none, e.g. killed by a signal).
 */
interface CliRun { code: string | number; stdout: string; stderr: string }

function loadElectron() {
  for (const r of [path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '..', 'node_modules')]) {
    try { return (require(path.join(r, 'playwright-core')) as typeof import('playwright-core'))._electron; } catch {}
  }
  return null;
}
const until = async <T,>(label: string, ms: number, fn: () => T | Promise<T>) => { const t0 = Date.now(); let last; while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = (e as Error).message; } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`timeout: ${label} (${JSON.stringify(last)})`); };
async function closeApp(app: ElectronApplication) { try { await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]); } catch {} try { app.process().kill('SIGKILL'); } catch {} }

test('inspect tool: back in the pill, panel pinned top-right by default (moves stick), ⌥ in Select measures and ⌥-click inspects', async (t) => {
  const _electron = loadElectron();
  if (!_electron) { t.skip('Playwright not available'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-inspect-e2e-'));
  const fixture = path.join(scratch, 'site'); fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><title>Inspect site</title></head><body style="margin:40px;font:20px system-ui"><h1 id="a" style="margin:0 0 30px">Headline</h1><p id="b" style="margin:0">Paragraph below.</p><div style="height:600px"></div></body></html>');
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ recents: [], session: { open: [], active: null } }));

  const env = { ...process.env, RADIAL_USERDATA: scratch, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' };
  const app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules', '.bin', 'electron'), args: ['.'], cwd: process.cwd(), env, timeout: 30000 });
  const win = await app.firstWindow({ timeout: 20000 });
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  const cli = path.join(process.cwd(), 'bin', 'radial');
  const radial = (args: string[]) => new Promise<CliRun>((resolve) => execFile('/bin/sh', [cli, ...args], { env, encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
  const guest = (js: string) => win.evaluate((js) => activeTab()!.webview.executeJavaScript(js), js);
  const inspectSt = () => win.evaluate(() => { const s = tpState().inspect; return { open: !!s.open, pinned: s.pinned, top: !!s.top }; });
  const inFixedStrip = () => win.evaluate(() => !!document.querySelector('#panelDock .pd-fixed [data-sec-id="inspect"]'));
  // Synthetic pointer events inside the guest (untrusted, but the overlay's listeners fire).
  const guestPoint = (id: string, type: string, extra = '') => guest(`(() => { const el = document.getElementById('${id}'); const r = el.getBoundingClientRect(); const x = r.left + 10, y = r.top + r.height / 2; const ev = new MouseEvent('${type}', { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window ${extra} }); el.dispatchEvent(ev); return [x, y]; })()`);
  try {
    await until('renderer', 20000, () => win.evaluate(() => typeof activeTab === 'function' && typeof setCanvasMode === 'function'));
    await until('socket', 15000, () => fs.existsSync(path.join(scratch, 'cli.sock')));
    const open = await radial(['open', fixture, '--json']);
    assert.equal(open.code, 0, open.stderr + open.stdout);
    await until('loaded preview', 30000, () => win.evaluate(() => { const t = activeTab(); if (!t || t.suspended || !t.baseUrl || !t.webview) return false; try { return !t.webview.isLoading() && /^http/.test(t.webview.getURL()); } catch { return false; } }));
    await until('overlay ready in the guest', 15000, () => guest(`!!document.getElementById('__radial_select_hl') || typeof window.__radialZoomed !== 'undefined' || document.querySelectorAll('style').length > 0`));

    // 1. The Inspect tool is visible in the header pill again.
    const toolVisible = await win.evaluate(() => { const b = document.querySelector('#bnToolsDock .bn-tool[data-mode="inspect"]'); return !!b && getComputedStyle(b).display !== 'none' && b.getClientRects().length > 0; });
    assert.equal(toolVisible, true, 'the Inspect tool sits in the header pill');

    // 2. Activating the tool opens its panel pinned at the top of the right sidebar.
    assert.equal((await inspectSt()).open, false, 'closed to begin with');
    await win.evaluate(() => setCanvasMode('inspect'));
    await until('panel pinned top-right', 5000, async () => { const s = await inspectSt(); return s.open && s.pinned === 'right' && s.top; });
    assert.equal(await inFixedStrip(), true, 'the Inspect section renders in the fixed strip');
    // Moved by the user (floating): using the tool again leaves it there.
    await win.evaluate(() => { setCanvasMode('select'); tpPlacePanel('inspect', 'float'); });
    await until('floating', 5000, async () => { const s = await inspectSt(); return s.open && s.pinned === false; });
    await win.evaluate(() => setCanvasMode('inspect'));
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await inspectSt(), { open: true, pinned: false, top: false }, 'a moved panel stays where the user put it');
    // Closed: the next use returns to the default home.
    await win.evaluate(() => { setCanvasMode('select'); closeToolPanel('inspect'); });
    await until('closed', 5000, async () => !(await inspectSt()).open);
    await win.evaluate(() => setCanvasMode('inspect'));
    await until('back to top-right', 5000, async () => { const s = await inspectSt(); return s.open && s.pinned === 'right' && s.top; });
    await win.evaluate(() => { setCanvasMode('select'); closeToolPanel('inspect'); });

    // 3. Select the headline in the preview, then hold ⌥ from the app chrome:
    //    the pill lights Inspect, the preview measures from the selection.
    await guestPoint('a', 'click');
    await until('selection reached the host', 10000, () => win.evaluate(() => !!(quickEdit && quickEdit.sels && quickEdit.sels[0] && /h1/i.test(quickEdit.sels[0].tagName || ''))));
    await guestPoint('b', 'mousemove'); // the overlay remembers the pointer for the hold
    await win.evaluate(() => setQuickInspect(true));
    await until('pill shows Inspect during the hold', 5000, () => win.evaluate(() => document.querySelector('#bnToolsDock .bn-tool[data-mode="inspect"]')!.classList.contains('active')));
    await until('measurements in the preview', 5000, () => guest(`(() => { const m = document.getElementById('__radial_measure'); return !!m && m.style.display === 'block' && m.querySelectorAll('.rm-label').length >= 1; })()`));
    // ⌥-click the paragraph: it becomes the selection and the Inspect panel opens top-right.
    await guestPoint('b', 'click');
    await until('the panel shows the clicked element', 10000, async () => { const s = await inspectSt(); const sel = await win.evaluate(() => quickEdit && quickEdit.sels && quickEdit.sels[0] && quickEdit.sels[0].tagName); return s.open && s.pinned === 'right' && s.top && /^p$/i.test(sel || ''); });
    assert.equal(await inFixedStrip(), true);
    assert.equal(await win.evaluate(() => selectMode && !inspectMode), true, 'the real tool is still Select');
    // Release: measurements gone, the pill back on Select, the selection kept.
    await win.evaluate(() => setQuickInspect(false));
    await until('measurements cleared', 5000, () => guest(`document.getElementById('__radial_measure').style.display === 'none'`));
    assert.equal(await win.evaluate(() => document.querySelector('#bnToolsDock .bn-tool[data-mode="select"]')!.classList.contains('active')), true);
    assert.equal(await guest(`document.getElementById('b').classList.contains('radial-selected')`), true, 'the ⌥-clicked element stays selected');

    // 4. The overlay's own ⌥ (keystrokes landing in the preview) reaches the pill too.
    await guest(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true }))`);
    await until('overlay-started hold lights the pill', 5000, () => win.evaluate(() => quickInspectOn === true));
    await guest(`document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true }))`);
    await until('overlay-ended hold', 5000, () => win.evaluate(() => quickInspectOn === false));
    assert.deepEqual(errors, [], 'no renderer errors');
  } finally {
    await closeApp(app);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
});
