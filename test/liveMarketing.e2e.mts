// LIVE E2E #3 — a reported case, on a real static marketing site: the
// Design panel changes .hero-aside's top padding and the change must WRITE
// deterministically (no agent). The element's only authored rule is
// `padding-top: 1rem` in styles.css — a rem value the old planner refused.
// Flow mirrors the app: overlay selects the element → enrichment delivers
// styleSource (+ rootPx) → adjustDirect.plan → engine writes through the
// structural pin into a temp copy of the site.
//   /usr/bin/python3 -m http.server 8791 --directory "$RADIAL_TEST_SITE"
//   RADIAL_TEST_SITE_URL=http://127.0.0.1:8791 node --test test/liveMarketing.e2e.mts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import type { Page } from 'playwright-core';
import type { StylePlan, StylePlanResult } from '../src/renderer/adjustDirect.ts';
import type { StyleEditDone } from '../src/main/editEngine.ts';
import type { SelectElementPayload, SelectEnrichPayload } from '../src/shared/overlayMessages.ts';
const require = createRequire(import.meta.url);
const engine = require('../out/main/editEngine.js') as typeof import('../src/main/editEngine.ts');
const { plan } = require('../out/renderer/adjustDirect.js') as typeof import('../src/renderer/adjustDirect.ts');

const SITE = process.env.RADIAL_TEST_SITE || '';
const URL0 = process.env.RADIAL_TEST_SITE_URL || 'http://127.0.0.1:8791';
function loadPlaywright() { for (const r of [path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '..', 'node_modules')]) for (const n of ['playwright', 'playwright-core']) { try { return require(path.join(r, n)) as typeof import('playwright-core'); } catch {} } return null; }
async function reachable(url: string) { try { const c = new AbortController(); const t = setTimeout(() => c.abort(), 2500); const r = await fetch(url, { signal: c.signal }); clearTimeout(t); return r.ok; } catch { return false; } }
const SKIP = new Set(['node_modules', '.git', '.radial', 'dist']);
function freshCopy() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-src-')); fs.cpSync(SITE, d, { recursive: true, filter: (s) => !SKIP.has(path.basename(s)) }); return d; }
/** One sendToHost call, as the stubbed ipcRenderer records it. */
interface SentMessage { ch: string; payload: unknown }
/** An overlay's ipcRenderer.on listener; the test calls it with an empty event. */
type HostListener = (event: object, value: unknown) => void;
/** The page's window (page functions run there), with what INJECT puts on it: the overlay's messages to the host, and its listeners by channel. */
declare const window: Window & typeof globalThis & { __sent: SentMessage[]; __handlers: Record<string, HostListener> };
/** What the overlay sends on the channels this test reads (renderer.ts OverlayToHostPayloads). */
interface HostPayloads {
  'radial:select-element': SelectElementPayload;
  'radial:select-enrich': SelectEnrichPayload;
}
/** A plan that worked: the test asserts planned.ok before it reads the plans. */
type PlanDone = Extract<StylePlanResult, { ok: true }>;
const INJECT = (src: string) => {
  window.__sent = []; window.__handlers = {};
  const ipcRenderer = { sendToHost: (ch: string, payload: unknown) => window.__sent.push({ ch, payload }), on: (ch: string, fn: HostListener) => { window.__handlers[ch] = fn; } };
  const require = () => ({ ipcRenderer }); // eslint-disable-line no-unused-vars
  for (const g of ['require', 'module', 'exports', 'process', 'global', 'Buffer', '__dirname', '__filename']) (window as unknown as Record<string, unknown>)[g] = (window as unknown as Record<string, unknown>)[g] || {};
  eval(src); // eslint-disable-line no-eval
};

test('live marketing site: Design-panel padding-top +8 on .hero-aside writes deterministically (the reported case)', async (t) => {
  if (!SITE || !fs.existsSync(SITE)) { t.skip('set RADIAL_TEST_SITE to the site folder'); return; }
  const pw = loadPlaywright(); if (!pw) { t.skip('Playwright not available'); return; }
  if (!(await reachable(URL0 + '/index.html'))) { t.skip(`marketing site not served at ${URL0}`); return; }
  let browser; try { browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); } catch (e) { t.skip('Chromium: ' + (e as Error).message); return; }
  const overlaySrc = fs.readFileSync(path.join(process.cwd(), 'out/overlay/overlay.js'), 'utf8');
  const last = <C extends keyof HostPayloads>(page: Page, ch: C, pred?: string) => page.evaluate(([c, p]) => { const ms = window.__sent.filter((m) => m.ch === c); const f = ms.filter((m) => !p || (m.payload as HostPayloads[C]).selector === p); return (f.pop() || {} as Partial<SentMessage>).payload; }, [ch, pred || null]) as Promise<HostPayloads[C] | undefined>;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    await page.goto(URL0 + '/index.html', { waitUntil: 'load' });
    await page.locator('.hero-aside').first().waitFor({ timeout: 15000 });
    await page.evaluate(INJECT, overlaySrc);
    await page.evaluate(() => window.__handlers['radial:set-select-mode']({}, true));

    // Select the CTA, then walk up to the .hero-aside container (what the user clicked).
    const cta = page.locator('.hero-aside .cta').first();
    await cta.scrollIntoViewIfNeeded();
    const box = (await cta.boundingBox())!;
    await page.mouse.click(box.x + 8, box.y + box.height / 2); await page.waitForTimeout(500);
    let sel = await last(page, 'radial:select-element');
    for (let i = 0; i < 4 && !(sel && sel.classList && sel.classList.includes('hero-aside')); i++) {
      await page.evaluate(() => window.__handlers['radial:select-parent']({}, {})); await page.waitForTimeout(80);
      sel = await last(page, 'radial:select-element');
    }
    assert.ok(sel && sel.classList.includes('hero-aside'), `selected .hero-aside (got <${sel && sel.tagName}.${sel && sel.classList.join('.')}>)`);
    assert.equal(typeof sel.adjust.paddingTop, 'number', 'fast payload seeds the stepper');

    // Enrichment (styleSource + rootPx) rides radial:select-enrich on idle.
    await page.waitForFunction((s) => window.__sent.some((m) => m.ch === 'radial:select-enrich' && (m.payload as SelectEnrichPayload).selector === s), sel.selector, { timeout: 3000 });
    const enrich = await last(page, 'radial:select-enrich', sel.selector);
    assert.ok(enrich && enrich.styleSource, 'enrichment carries styleSource');
    assert.ok(enrich.styleSource.rootPx > 0, 'styleSource carries rootPx for unit-preserving writes');
    const full = { ...sel, styleSource: enrich.styleSource };
    const authored = (enrich.styleSource.rules || []).filter((r) => r.prop === 'padding-top');
    t.diagnostic(`computed padding-top=${sel.adjust.paddingTop}px; authored rules: ${JSON.stringify(authored.map((r) => `${r.selectorText}{${r.value}}`))}; active media: ${(enrich.styleSource.mediaRules || []).filter((r) => r.prop === 'padding-top' && r.active).length}`);

    // The Design panel's delta: top padding +8px.
    const from = `${sel.adjust.paddingTop}px`, to = `${sel.adjust.paddingTop + 8}px`;
    const planned = plan({ 'padding-top': { from, to } }, full);
    assert.equal(planned.ok, true, `the planner must ALWAYS plan a px value (was: ${(planned as { reason?: string }).reason})`);
    const p: StylePlan & { value?: string } = (planned as PlanDone).plans[0];
    assert.ok(['css', 'css-set', 'css-set-media', 'inline-set'].includes(p.kind), `deterministic rung, got ${p.kind}`);
    t.diagnostic(`plan: ${JSON.stringify(p)}`);

    // Write it exactly as the app does — through the structural pin, scoped to the page.
    const repo = freshCopy();
    try {
      const ctx = { classList: sel.classList, id: sel.id, tagName: sel.tagName, path: sel.path, preferFile: 'index.html' };
      const res = engine.applyStyleEdits(repo, (planned as PlanDone).plans, ctx);
      assert.equal(res.ok, true, `write failed: ${(res as { reason?: string }).reason}`);
      const f0 = (res as StyleEditDone).files[0];
      if (p.kind === 'inline-set') {
        assert.equal(f0.relFile, 'index.html');
        assert.match(f0.newContent, new RegExp(`<div class="hero-aside" style="padding-top: ${to}"`), 'inline declaration on the element');
      } else {
        assert.equal(f0.relFile, 'styles.css');
        // The value written into the WINNING .hero-aside rule, in the author's unit (rem stays rem).
        const blk = /\.hero-aside\s*\{[^}]*\}/g; let hit = null;
        for (const m of f0.newContent.match(blk) || []) if (m.includes(p.value || to)) hit = m;
        assert.ok(hit, `.hero-aside block should now carry padding-top ${p.value || to}`);
        if (/rem$/.test(authored[0] && authored[0].value || '')) assert.match(String(p.value), /rem$/, 'rem authored → rem written');
        t.diagnostic(`styles.css block now: ${hit.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      assert.equal(f0.prevContent, fs.readFileSync(path.join(SITE, f0.relFile), 'utf8'), 'undo record is byte-exact');
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  } finally { await browser.close(); }
});
