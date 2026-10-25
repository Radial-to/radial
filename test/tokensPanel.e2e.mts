// The Tokens panel and the publish notice, in the real app: a static fixture
// with :root tokens (a git repo with an uncommitted edit) opens; the Tokens
// panel is pinned from the add-panel surface, lists the tokens with swatches
// and use counts, and an edit in a row rewrites the exact declaration with a
// toast; the Publish button wears the amber dot and the popover says how many
// changes are unsaved. Opt-in: `npm run test:e2e`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ElectronApplication } from 'playwright-core';
import type { RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';
const require = createRequire(import.meta.url);

// What the app's window carries, as far as this test reaches into it inside the
// page: the preload's API and the window scripts' globals (the app's own
// declarations are src/renderer/globals.d.ts, types.d.ts and renderer.ts).
type ToolPanelId = 'adjust' | 'content' | 'motion' | 'inspect' | 'code' | 'variants' | 'image' | 'a11y' | 'tokens' | 'insert' | 'layers' | 'page' | 'reconcile' | 'ask' | 'draw' | 'comments' | 'pages' | 'context' | 'history' | 'terminal' | 'publish' | 'branches';
interface Tab {
  /** The preview's <webview> element. */
  webview: HTMLElement;
  /** The changes not yet on GitHub: updateSyncBadge counts them (the test runs it before reading this) and sets the dot from them. */
  _unsaved?: number;
}
/** A command palette row. */
interface CommandItem { label: string }
declare const window: Window & typeof globalThis & { radial: RadialApi };
declare function activeTab(): Tab | null;
declare const TOOL_PANELS: { id: ToolPanelId; title: string }[];
declare const TP_CATEGORIES: { label: string; ids: ToolPanelId[] }[];
declare function tpState(): Record<ToolPanelId, { open: boolean }>;
declare function tpPinPanel(id: ToolPanelId, side?: 'left' | 'right'): void;
declare function updateSyncBadge(tab?: Tab | null): Promise<void>;
declare function togglePublishMenu(anchorEl: HTMLElement | null | undefined): Promise<void>;
declare let cmdkAll: CommandItem[];
declare let cmdkFiltered: CommandItem[];
declare function buildCommands(): CommandItem[];
declare function filterCmdK(q: string): void;
/** A token row's value: an <input> on an editable row, a <span> (which has no value) on a read-only one. */
type TokenValueEl = HTMLInputElement | (HTMLSpanElement & { value?: undefined });

function loadElectron() {
  for (const r of [path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '..', 'node_modules')]) {
    try { return (require(path.join(r, 'playwright-core')) as typeof import('playwright-core'))._electron; } catch {}
  }
  return null;
}
const until = async <T,>(label: string, ms: number, fn: () => T | Promise<T>) => { const t0 = Date.now(); let last: Awaited<T> | string | undefined; while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = (e as Error).message; } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`timeout: ${label} (${JSON.stringify(last)})`); };
async function closeApp(app: ElectronApplication) { try { await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]); } catch {} try { app.process().kill('SIGKILL'); } catch {} }

test('Tokens panel lists the stylesheet’s custom properties and edits one in place; Publish shows changed files', async (t) => {
  const _electron = loadElectron();
  if (!_electron) { t.skip('Playwright not available'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-tokens-e2e-'));
  const fixture = path.join(scratch, 'site'); fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'styles.css'), ':root {\n  --brand: #8665f6;\n  --radius: 10px;\n  --font-body: "Inter", sans-serif;\n}\n[data-theme="dark"] { --brand: #a48cff; }\n.btn { color: var(--brand); border-radius: var(--radius); font-family: var(--font-body); }\n');
  fs.writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><title>Tokens</title><link rel="stylesheet" href="styles.css"></head><body><h1>Tokens</h1><a class="btn" href="#">Go</a></body></html>');
  execFileSync('git', ['init', '-q'], { cwd: fixture }); execFileSync('git', ['add', '-A'], { cwd: fixture });
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'init'], { cwd: fixture });
  fs.appendFileSync(path.join(fixture, 'index.html'), '\n<!-- unsaved edit -->'); // one uncommitted change → the notice
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ recents: [], session: { open: [], active: null } }));

  const app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules', '.bin', 'electron'), args: ['.'], cwd: process.cwd(), env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_OPEN: fixture, RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' }, timeout: 30000 });
  const win = await app.firstWindow({ timeout: 20000 });
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  try {
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1600, 900); });
    await until('project open', 40000, () => win.evaluate(() => !!(typeof activeTab === 'function' && activeTab() && activeTab()!.webview && activeTab()!.webview.offsetWidth)));
    // 1. The panel is off by default and listed under the add-panel Page category.
    assert.equal(await win.evaluate(() => !!TOOL_PANELS.find((p) => p.id === 'tokens') && !tpState().tokens.open), true, 'registered, closed by default');
    assert.equal(await win.evaluate(() => TP_CATEGORIES.find((c) => c.label === 'Page')!.ids.includes('tokens')), true);
    // 2. Pin it: rows arrive from the authored stylesheet.
    await win.evaluate(() => tpPinPanel('tokens', 'right'));
    await until('token rows', 20000, () => win.evaluate(() => document.querySelectorAll('#panelDock .tk-row').length >= 3));
    const rows = await win.evaluate(() => [...document.querySelectorAll<HTMLElement>('#panelDock .tk-row')].map((r) => ({ name: r.dataset.tk, value: (r.querySelector<TokenValueEl>('.tk-value') || {}).value || (r.querySelector('.tk-value') || {}).textContent, editable: !!r.querySelector('input.tk-value'), meta: [...r.querySelectorAll('.tk-meta')].map((m) => m.textContent), swatch: (r.querySelector<HTMLElement>('.tk-swatch') || {}).style && r.querySelector<HTMLElement>('.tk-swatch')!.style.background })));
    const brand = rows.find((r) => r.name === '--brand'); const radius = rows.find((r) => r.name === '--radius'); const font = rows.find((r) => r.name === '--font-body');
    assert.ok(brand && radius && font, JSON.stringify(rows));
    assert.equal(brand.editable, false, 'two definitions (default + dark) are read-only in the panel'); assert.ok(brand.meta.some((m) => /2 modes/.test(m)));
    assert.equal(radius.editable, true); assert.ok(radius.meta.some((m) => /1×/.test(m)));
    assert.ok(/rgb\(134, 101, 246\)|#8665f6/i.test(brand.swatch || ''), 'the color row carries its swatch');
    // 3. Edit --radius in the row: Enter commits, the file changes, the toast says where.
    await win.evaluate(() => { const inp = document.querySelector<HTMLInputElement>('#panelDock input[data-tk-input="--radius"]')!; inp.value = '14px'; inp.dispatchEvent(new Event('change', { bubbles: true })); });
    await until('toast', 10000, () => win.evaluate(() => /Saved --radius/.test((document.getElementById('toast') || {}).textContent || '')));
    assert.match(fs.readFileSync(path.join(fixture, 'styles.css'), 'utf8'), /--radius: 14px;/);
    assert.match(fs.readFileSync(path.join(fixture, 'styles.css'), 'utf8'), /--brand: #8665f6;/, 'nothing else moved');
    await until('re-indexed', 10000, () => win.evaluate(() => (document.querySelector<HTMLInputElement>('#panelDock input[data-tk-input="--radius"]') || {}).value === '14px'));
    // 4. Undo through the app's history restores the file.
    await win.evaluate(() => window.radial.historyUndo());
    await until('undone', 10000, () => /--radius: 10px;/.test(fs.readFileSync(path.join(fixture, 'styles.css'), 'utf8')));
    // 5. The publish notice: one uncommitted change → amber dot on Publish and a chip in the popover.
    await win.evaluate(() => updateSyncBadge(activeTab()));
    await until('unsaved dot', 15000, () => win.evaluate(() => { const pb = document.getElementById('publishBtn')!; const d = pb.querySelector('.bs-update-dot'); return !!d && d.classList.contains('warn') && activeTab()!._unsaved! >= 1; }));
    await win.evaluate(() => togglePublishMenu(document.getElementById('publishBtn')));
    await until('changed files', 10000, () => win.locator('#publishMenu .pm-change-count').textContent().then(text => /^[1-9]\d* changed files?$/.test(text!)));
    await win.locator('#publishMenu .pm-change-count').click();
    await until('changed file detail', 10000, () => win.locator('#publishMenu').textContent().then(text => text!.includes('index.html')));
    // 6. Searching "variables" finds the Tokens panel wherever panels are searched.
    const pal = await win.evaluate(() => { cmdkAll = buildCommands(); filterCmdK('variables'); return cmdkFiltered.map((c) => c.label); });
    assert.ok(pal.some((l) => /Tokens panel$/.test(l)), `palette: ${JSON.stringify(pal)}`);
    const palNo = await win.evaluate(() => { filterCmdK('zzzzqq'); return cmdkFiltered.filter((c) => /Tokens panel$/.test(c.label)).length; });
    assert.equal(palNo, 0, 'a nonsense query does not match');
    await win.evaluate(() => document.getElementById('cmdk')!.style.display = 'none');
    await win.evaluate(() => document.querySelector<HTMLButtonElement>('#panelDock .pd-add')!.click());
    await until('add menu', 5000, () => win.evaluate(() => !!document.querySelector('.pd-add-menu .pd-add-search')));
    const visible = await win.evaluate(() => { const inp = document.querySelector<HTMLInputElement>('.pd-add-menu .pd-add-search')!; inp.value = 'variables'; inp.dispatchEvent(new Event('input', { bubbles: true })); return [...document.querySelectorAll<HTMLButtonElement>('.pd-add-menu .pd-add-list button')].filter((b) => b.style.display !== 'none').map((b) => b.textContent.replace(/\u2022/g, '').trim()); });
    assert.deepEqual(visible, ['Tokens'], `add-panel search for "variables" shows only Tokens: ${JSON.stringify(visible)}`);
    assert.deepEqual(errors, []);
  } finally { await closeApp(app); }
});
