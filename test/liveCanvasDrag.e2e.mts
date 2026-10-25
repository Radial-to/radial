// LIVE: the live-reflow canvas drag on a REAL page (a static marketing site),
// through the same commit bridge the app uses. Lift the first CTA in the hero's
// flex row and drop it after the last one: the DOM reorders live as the pointer
// crosses the neighbor's rendered center, and the committed payloads (captured
// against the PRE-move tree) resolve in source via applyMove on a temp copy.
//   /usr/bin/python3 -m http.server 8791 --directory "$RADIAL_TEST_SITE"
//   RADIAL_TEST_SITE_URL=http://127.0.0.1:8791 node --test test/liveCanvasDrag.e2e.mts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import type { StructuralEditOutcome } from '../src/main/editInsert.ts';
import type { CapturedSelection } from '../src/shared/overlayMessages.ts';
import type { InsertPosition } from '../src/shared/radialApi.ts';

// The page's window once INJECT has run: what the overlay sent the host and
// the listeners it registered, in place of Electron's ipcRenderer. INJECT also
// stubs Node's globals on window by name.
// Note for the merge with ts/w4-w-consolidate: src/shared/overlayMessages.ts
// exports CanvasMove and OverlayToHostPayloads there. Import them then, delete
// the local CanvasMove, and type __sent per channel from OverlayToHostPayloads
// ({ [C in keyof OverlayToHostPayloads]: { ch: C; payload: OverlayToHostPayloads[C] } }[keyof OverlayToHostPayloads][])
// in place of HostMessage.
interface HostMessage { ch: string; payload: unknown }
type OverlayListener = (event: object, ...args: unknown[]) => void;
/** The Node globals INJECT stubs on window. */
type NodeGlobal = 'require' | 'module' | 'exports' | 'process' | 'global' | 'Buffer' | '__dirname' | '__filename';
interface OverlayWindow extends Window, Partial<Record<NodeGlobal, unknown>> {
  __sent: HostMessage[];
  __handlers: Record<string, OverlayListener>;
}
declare const window: OverlayWindow;
/** radial:canvas-move's payload: the element, the neighbour it moved to, and where (the window's handleWebviewMessage). */
interface CanvasMove { subject: CapturedSelection; target: CapturedSelection; position: InsertPosition }
// LooseUnion as src/renderer/types.d.ts defines it (ambient there, so a test
// can't import it); both belong in a src/shared module.
/** Every key of every member of a union. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
/** A union whose members each read the other members' fields as undefined. */
type LooseUnion<T, All = T> = T extends unknown ? T & { [K in Exclude<KeysOfUnion<All>, keyof T>]?: undefined } : never;
/** applyMove's outcome read without narrowing: a field the other outcome lacks reads as undefined. */
type MoveOutcome = LooseUnion<StructuralEditOutcome>;
const require = createRequire(import.meta.url);
const editInsert = require('../out/main/editInsert.js') as typeof import('../src/main/editInsert.ts');
const SITE = process.env.RADIAL_TEST_SITE || '';
const URL0 = process.env.RADIAL_TEST_SITE_URL || 'http://127.0.0.1:8791';
const SHOTS = path.join(os.tmpdir(), 'canvas-drag-e2e');
function loadPlaywright() { for (const r of [path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '..', 'node_modules')]) for (const n of ['playwright', 'playwright-core']) { try { return require(path.join(r, n)) as typeof import('playwright-core'); } catch {} } return null; }
async function reachable(url: string) { try { const c = new AbortController(); const t = setTimeout(() => c.abort(), 2500); const r = await fetch(url, { signal: c.signal }); clearTimeout(t); return r.ok; } catch { return false; } }
const SKIP = new Set(['node_modules', '.git', '.radial', 'dist']);
function freshCopy() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-drag-')); fs.cpSync(SITE, d, { recursive: true, filter: (s) => !SKIP.has(path.basename(s)) }); return d; }
const INJECT = (src: string) => {
  window.__sent = []; window.__handlers = {};
  const ipcRenderer = { sendToHost: (ch: string, payload: unknown) => window.__sent.push({ ch, payload }), on: (ch: string, fn: OverlayListener) => { window.__handlers[ch] = fn; } };
  const require = () => ({ ipcRenderer }); // eslint-disable-line no-unused-vars
  for (const g of ['require', 'module', 'exports', 'process', 'global', 'Buffer', '__dirname', '__filename'] as const) window[g] = window[g] || {};
  eval(src); // eslint-disable-line no-eval
};

test('live: reorder a real CTA inside the hero flex row by dragging on the canvas; commit resolves in source', async (t) => {
  if (!SITE || !fs.existsSync(SITE)) { t.skip('set RADIAL_TEST_SITE to the site folder'); return; }
  const pw = loadPlaywright(); if (!pw) { t.skip('Playwright not available'); return; }
  if (!(await reachable(URL0 + '/index.html'))) { t.skip(`site not served at ${URL0}`); return; }
  let browser; try { browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); } catch (e) { t.skip('Chromium: ' + (e as Error).message); return; }
  fs.mkdirSync(SHOTS, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(URL0 + '/index.html', { waitUntil: 'load' });
    // A real flex row with ≥2 sizeable children: the hero's .cta-row if present, else the first such row.
    const row = await page.evaluate(() => {
      const ok = (el: Element) => { const cs = getComputedStyle(el); const kids = [...el.children].filter((k) => k.getBoundingClientRect().width > 40); return cs.display.includes('flex') && !cs.flexDirection.includes('column') && kids.length >= 2 && kids.every((k) => k.tagName === kids[0].tagName); };
      const pick = document.querySelector('.cta-row') && ok(document.querySelector('.cta-row')!) ? document.querySelector('.cta-row') : [...document.querySelectorAll('body *')].find(ok);
      if (!pick) return null;
      pick.setAttribute('data-e2e-row', '1');
      return { n: pick.children.length, tag: pick.children[0].tagName.toLowerCase(), cls: pick.className };
    });
    assert.ok(row, 'found a real flex row with same-tag children');
    t.diagnostic(`row: .${row.cls} with ${row.n} <${row.tag}>`);
    await page.locator('[data-e2e-row]').scrollIntoViewIfNeeded();
    await page.evaluate(INJECT, fs.readFileSync(path.join(process.cwd(), 'out/overlay/overlay.js'), 'utf8'));
    await page.evaluate(() => { window.__handlers['radial:set-select-mode']({}, true); window.__handlers['radial:set-canvas-reorder']({}, true); });
    const ids = await page.evaluate(() => [...document.querySelector('[data-e2e-row]')!.children].map((k, i) => { k.setAttribute('data-e2e-i', String(i)); return i; }));
    const orderNow = () => page.evaluate(() => [...document.querySelector('[data-e2e-row]')!.children].map((k) => k.getAttribute('data-e2e-i')).join(''));
    const before = await orderNow();
    const first = (await page.locator('[data-e2e-i="0"]').boundingBox())!, last = (await page.locator(`[data-e2e-i="${ids.length - 1}"]`).boundingBox())!;
    // Lift the first CTA, cross the last one's center, hold to let the reflow settle.
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2); await page.mouse.down();
    await page.mouse.move(first.x + first.width / 2 + 9, first.y + first.height / 2 + 4, { steps: 2 });
    await page.mouse.move(last.x + last.width + 30, last.y + last.height / 2, { steps: 10 }); await page.waitForTimeout(240);
    await page.mouse.move(last.x + last.width + 31, last.y + last.height / 2); await page.waitForTimeout(240);
    const during = await orderNow();
    assert.notEqual(during, before, 'the row reflowed live while dragging');
    assert.equal(during, before.slice(1) + before[0], 'first CTA now renders last');
    await page.screenshot({ path: path.join(SHOTS, '1-mid-drag-reflow.png'), clip: { x: Math.max(0, first.x - 40), y: Math.max(0, first.y - 60), width: 900, height: 220 } });
    await page.mouse.up();
    const mv = await page.evaluate(() => (window.__sent.filter((m) => m.ch === 'radial:canvas-move').pop() || {}).payload as CanvasMove | undefined);
    assert.ok(mv, 'a canvas-move was committed');
    assert.equal(mv.subject.path[0].nth, 0, 'subject captured against the PRE-move tree (it was first)');
    assert.equal(mv.position, 'after');
    // Now the source: the same payloads through applyMove, on a temp copy of the site.
    const repo = freshCopy();
    try {
      const res: MoveOutcome = editInsert.applyMove(repo, { subject: mv.subject, target: mv.target, position: mv.position, preferFile: 'index.html' });
      assert.equal(res.ok, true, `applyMove: ${res.reason}`);
      assert.equal(res.relFile, 'index.html');
      const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8'), src = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
      const cnt = (s: string) => (s.match(new RegExp(`<${row.tag}(?=[\\s>])`, 'g')) || []).length;
      assert.equal(cnt(out), cnt(src), 'element count preserved');
      // The subject's own text now appears AFTER the target's in the source row.
      const sT = (mv.subject.text || '').trim().slice(0, 24), tT = (mv.target.text || '').trim().slice(0, 24);
      if (sT && tT) assert.ok(out.indexOf(sT) > out.indexOf(tT), `"${sT}" now follows "${tT}" in source`);
      t.diagnostic(`source: <${row.tag}> "${sT}" moved after "${tT}" in index.html; undo record ${res.prevContent === src ? 'byte-exact' : 'MISMATCH'}`);
      assert.equal(res.prevContent, src);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
    t.diagnostic(`screenshot: ${SHOTS}/1-mid-drag-reflow.png`);
  } finally { await browser.close(); }
});
