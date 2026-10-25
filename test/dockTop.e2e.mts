// Pin to the top, on both sides: any docked section can ride the
// right dock's fixed strip like the agent does, and the left sidebar has the
// same strip above the agent window. Moving a panel into a hidden sidebar
// shows the sidebar. The dock column never scrolls sideways; a deep Layers
// tree scrolls sideways on its own instead of clipping. Opt-in: `npm run test:e2e`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ElectronApplication } from 'playwright-core';
import type { WebviewTag } from 'electron';
import { launchApp } from './support/app.ts';
const require = createRequire(import.meta.url);

// What the app's window has that this test reaches inside win.evaluate: window
// scripts' top-level declarations (src/renderer/types.d.ts has the full types).
// They are declared as always there; the boot poll still guards them, because
// firstWindow() can resolve before the window's scripts have run.
/** The tool panels this test moves (renderer ToolPanelId). */
type PanelId = 'layers' | 'tokens' | 'terminal';
/** A sidebar (renderer ToolPanelDockSide). */
type DockSide = 'left' | 'right';
/**
 * Where a panel is (renderer ToolPanelPlacement), the fields read here.
 * pinned 'left' is the left sidebar's top strip (tpPinTop, always with
 * top: true); only the old left scroller dock (tpState v8) was retired.
 */
interface PanelPlacement { pinned?: boolean | 'left' | 'right' | 'home'; top?: boolean }
declare function activeTab(): { webview: WebviewTag } | null;
declare function tpState(): { [Id in PanelId]: PanelPlacement } & { _pdFixedH?: number };
declare function tpRemoveFromGroup(id: PanelId): void;
declare function tpPinTop(id: PanelId, side?: DockSide): void;
declare function tpPinPanel(id: PanelId, side?: DockSide): void;
declare function tpSetTop(id: PanelId, on: boolean): void;
declare function tpGoHome(id: PanelId): void;
declare function setSidebarHidden(side: DockSide, hide: boolean): void;

function loadElectron() {
  for (const r of [path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '..', 'node_modules')]) {
    try { return (require(path.join(r, 'playwright-core')) as typeof import('playwright-core'))._electron; } catch {}
  }
  return null;
}
const until = async (label: string, ms: number, fn: () => Promise<unknown>) => {
  const t0 = Date.now(); let last: unknown;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = (e as Error).message; } await new Promise((r) => setTimeout(r, 200)); }
  throw new Error(`timeout waiting for ${label}: ${last}`);
};
async function closeApp(app: ElectronApplication) { try { await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]); } catch {} try { app.process().kill('SIGKILL'); } catch {} }

test('pin to the top on both sides, hidden sidebars reveal on a move, Layers scrolls sideways instead of clipping', async (t) => {
  const _electron = loadElectron();
  if (!_electron) { t.skip('Playwright not available'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-docktop-e2e-'));
  const fixture = path.join(scratch, 'site'); fs.mkdirSync(fixture);
  let inner = '<a class="inline-flex items-center justify-center rounded-md" href="#">Book a demo with our very long call to action label</a>';
  for (let i = 0; i < 12; i++) inner = `<div class="level-${i} flex flex-col gap-4 max-w-[1200px] some-other-very-long-class-name-${i}">${inner}</div>`;
  fs.writeFileSync(path.join(fixture, 'styles.css'), ':root { --brand: #8665f6; --radius: 10px; }');
  fs.writeFileSync(path.join(fixture, 'index.html'), `<!doctype html><html><head><title>Dock</title><link rel="stylesheet" href="styles.css"></head><body><main class="page"><section id="hero"><h1>Dock</h1>${inner}</section>${'<p>filler</p>'.repeat(30)}</main></body></html>`);
  execFileSync('git', ['init', '-q'], { cwd: fixture }); execFileSync('git', ['add', '-A'], { cwd: fixture });
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'init'], { cwd: fixture });
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ recents: [], session: { open: [], active: null } }));

  const app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules', '.bin', 'electron'), args: ['.'], cwd: process.cwd(), env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_OPEN: fixture, RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' }, timeout: 30000 });
  const win = await app.firstWindow({ timeout: 20000 });
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  try {
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1500, 900); });
    await until('project open', 40000, () => win.evaluate(() => !!(typeof activeTab === 'function' && activeTab() && activeTab()!.webview && activeTab()!.webview.offsetWidth)));

    // 1. Layers pinned to the top of the right dock: it rides the sized strip with the grip; the default group stays in the scroller.
    await win.evaluate(() => { tpRemoveFromGroup('layers'); tpPinTop('layers', 'right'); });
    await until('layers rows', 20000, () => win.evaluate(() => document.querySelectorAll('#panelDock .pd-fixed-sized .ly-row').length >= 10));
    const r1 = await win.evaluate(() => ({
      topSecs: [...document.querySelectorAll<HTMLElement>('#panelDock .pd-fixed-sized > .pd-sec')].map((x) => x.dataset.secId),
      scrollSecs: [...document.querySelectorAll<HTMLElement>('#pdSections > .pd-sec')].map((x) => x.dataset.secId),
      sized: document.querySelector('#panelDock .pd-fixed-sized')!.classList.contains('sized'),
      h: Math.round(document.querySelector('#panelDock .pd-fixed-sized')!.getBoundingClientRect().height),
      grip: !!document.querySelector('#panelDock .pd-fixed-resize'),
      layersScrollsSideways: (() => { const b = document.querySelector('[data-tp-body="dock-layers"]')!; return b.scrollWidth > b.clientWidth + 40 && getComputedStyle(b).overflowX === 'auto'; })(),
      dockSideways: (() => { const el = document.getElementById('pdSections')!; return el.scrollWidth - el.clientWidth; })(),
      deepRowUncut: (() => { const b = document.querySelector('[data-tp-body="dock-layers"]')!; const rows = [...b.querySelectorAll<HTMLElement>('.ly-row')]; const deep = rows.reduce((a, r) => (parseInt(r.style.paddingLeft, 10) > parseInt(a.style.paddingLeft, 10) ? r : a), rows[0]); return deep.scrollWidth <= deep.clientWidth + 1 && deep.getBoundingClientRect().width > b.clientWidth; })(),
    }));
    assert.deepEqual(r1.topSecs, ['layers']); assert.deepEqual(r1.scrollSecs, ['content']);
    assert.equal(r1.sized, true); assert.ok(r1.h >= 300 && r1.h <= 400, `sized strip ${r1.h}`); assert.equal(r1.grip, true);
    assert.equal(r1.layersScrollsSideways, true, 'the Layers body is the sideways scroller');
    assert.equal(r1.dockSideways, 0, 'the dock column itself never scrolls sideways');
    assert.equal(r1.deepRowUncut, true, 'the deepest row sizes to its content instead of clipping');

    // 2. The strip's grip sizes the box; the value persists.
    await win.evaluate(() => { const g = document.querySelector('#panelDock .pd-fixed-resize')!; const r = g.getBoundingClientRect(); g.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 20, clientY: r.top + 3 })); document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 20, clientY: r.top + 83 })); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
    const h2 = await win.evaluate(() => ({ box: Math.round(document.querySelector('#panelDock .pd-fixed-sized')!.getBoundingClientRect().height), saved: tpState()._pdFixedH }));
    assert.ok(h2.box >= r1.h + 70 && h2.box <= r1.h + 90, `grew by the drag: ${r1.h} → ${h2.box}`); assert.equal(h2.saved, h2.box);

    // 3. A move into a hidden sidebar shows it (both sides).
    await win.evaluate(() => setSidebarHidden('right', true));
    assert.equal(await win.evaluate(() => document.body.classList.contains('sb-right-hidden')), true);
    await win.evaluate(() => { tpRemoveFromGroup('tokens'); tpPinPanel('tokens', 'right'); });
    assert.equal(await win.evaluate(() => document.body.classList.contains('sb-right-hidden')), false, 'pinning right shows the right sidebar');
    await win.evaluate(() => setSidebarHidden('left', true));
    await win.evaluate(() => tpPinTop('tokens', 'left'));
    await until('left top rows', 15000, () => win.evaluate(() => document.querySelectorAll('#pdFixedL .tk-row').length >= 2));
    const r3 = await win.evaluate(() => ({
      leftShown: !document.body.classList.contains('sb-left-hidden'),
      leftSecs: [...document.querySelectorAll<HTMLElement>('#pdFixedL .pd-fixed-sized > .pd-sec')].map((x) => x.dataset.secId),
      leftGrip: !!document.querySelector('#pdFixedL .pd-fixed-resize'),
      agentBelow: (() => { const a = document.getElementById('rp-terminal')!.getBoundingClientRect(); const f = document.getElementById('pdFixedL')!.getBoundingClientRect(); return f.height > 100 && a.top >= f.bottom - 1; })(),
      rightSecs: [...document.querySelectorAll<HTMLElement>('#pdSections > .pd-sec')].map((x) => x.dataset.secId),
      st: tpState().tokens,
    }));
    assert.equal(r3.leftShown, true, 'pinning to the top of the left sidebar shows it');
    assert.deepEqual(r3.leftSecs, ['tokens']); assert.equal(r3.leftGrip, true); assert.equal(r3.agentBelow, true, 'the agent window sits under the strip');
    assert.deepEqual(r3.rightSecs, ['content'], 'it left the right dock');
    assert.equal(r3.st.pinned, 'left'); assert.equal(r3.st.top, true);

    // 4. The agent itself pinned right lands in the strip above Layers; unpins put things back.
    await win.evaluate(() => { tpRemoveFromGroup('terminal'); tpPinPanel('terminal', 'right'); });
    await until('terminal in the strip', 15000, () => win.evaluate(() => [...document.querySelectorAll<HTMLElement>('#panelDock .pd-fixed-sized > .pd-sec')].map((x) => x.dataset.secId).join(',') === 'terminal,layers'));
    const term = await win.evaluate(() => { const b = document.querySelector('[data-tp-body="dock-terminal"]')!; return { h: Math.round(b.getBoundingClientRect().height), core: !!b.querySelector('#agentPaneCore') }; });
    assert.ok(term.h > 60, `the agent body has room in the shared strip: ${term.h}`); assert.equal(term.core, true);
    await win.evaluate(() => { tpSetTop('layers', false); tpGoHome('tokens'); tpGoHome('terminal'); });
    const r4 = await win.evaluate(() => ({
      topSecs: [...document.querySelectorAll<HTMLElement>('#panelDock .pd-fixed-sized > .pd-sec')].map((x) => x.dataset.secId),
      scrollSecs: [...document.querySelectorAll<HTMLElement>('#pdSections > .pd-sec')].map((x) => x.dataset.secId),
      leftSecs: [...document.querySelectorAll<HTMLElement>('#pdFixedL .pd-sec')].map((x) => x.dataset.secId),
      homeTabs: [...document.querySelectorAll<HTMLElement>('#rp-terminal .tpg-tab')].map((x) => x.dataset.tpgTab),
      leftSlotHidden: getComputedStyle(document.getElementById('pdFixedL')!).display === 'none',
    }));
    assert.deepEqual(r4.topSecs, []); assert.deepEqual(r4.scrollSecs, ['content', 'layers']);
    assert.deepEqual(r4.leftSecs, []); assert.equal(r4.leftSlotHidden, true);
    assert.ok(r4.homeTabs.includes('tokens') && r4.homeTabs[0] === 'terminal', `unpinned from the left top = a tab in the agent window: ${r4.homeTabs}`);

    // 5. The section menu offers the pin verbs in the right words.
    await win.evaluate(() => document.querySelector<HTMLElement>('#pdSections .pd-sec[data-sec-id="layers"] .pd-more')!.click());
    const items = await win.evaluate(() => [...document.querySelectorAll('.pd-sec-menu button')].map((b) => b.textContent));
    assert.ok(items.includes('Pin to the top'), items.join(' | '));
    await win.evaluate(() => document.querySelector<HTMLElement>('.menu-backdrop')!.click());

    assert.deepEqual(errors, []);
  } finally {
    await closeApp(app);
  }
});
