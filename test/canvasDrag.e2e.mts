// Canvas drag-to-reorder safety switch (overlay in a real Chromium, electron
// stubbed — same harness as overlay.e2e.mts). Default OFF: a drag on a selected
// element moves nothing, emits ONE radial:canvas-drag-blocked (the host opens
// Layers), and no canvas-move. Switched ON (the flag the live-reflow drag is
// built behind), the gesture arms and moves as before. Switching OFF mid-drag
// restores the lifted element.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import type { Page } from 'playwright-core';
import type { InsertPosition } from '../src/shared/radialApi.ts';
import type { CapturedSelection } from '../src/shared/overlayMessages.ts';
const require = createRequire(import.meta.url);
function loadPlaywright() { for (const r of [path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '..', 'node_modules')]) for (const n of ['playwright', 'playwright-core']) { try { return require(path.join(r, n)) as typeof import('playwright-core'); } catch {} } return null; }
const PAGE = '<!doctype html><html><body style="margin:40px;font:16px system-ui"><section id="s"><div id="a" style="height:60px;background:#eee">A</div><div id="b" style="height:60px;background:#ddd">B</div><div id="c" style="height:60px;background:#ccc">C</div></section></body></html>';
/** One sendToHost call, as the stubbed ipcRenderer records it. */
interface SentMessage { ch: string; payload: unknown }
/** An overlay's ipcRenderer.on listener; the tests call it with an empty event. */
type HostListener = (event: object, value: unknown) => void;
/** The page's window (page functions run there), with what INJECT puts on it: the overlay's messages to the host, and its listeners by channel. */
declare const window: Window & typeof globalThis & { __sent: SentMessage[]; __handlers: Record<string, HostListener> };
/** What the overlay sends on the channels these tests read (renderer.ts OverlayToHostPayloads). */
interface HostPayloads {
  'radial:canvas-move': { subject: CapturedSelection; target: CapturedSelection; position: InsertPosition };
  'radial:canvas-drag-blocked': { selector: string; reason?: 'positioned' | 'grid-placed' | 'css-order' };
}
const INJECT = (src: string) => {
  window.__sent = []; window.__handlers = {};
  const ipcRenderer = { sendToHost: (ch: string, payload: unknown) => window.__sent.push({ ch, payload }), on: (ch: string, fn: HostListener) => { window.__handlers[ch] = fn; } };
  const require = () => ({ ipcRenderer }); // eslint-disable-line no-unused-vars
  for (const g of ['require', 'module', 'exports', 'process', 'global', 'Buffer', '__dirname', '__filename']) (window as unknown as Record<string, unknown>)[g] = (window as unknown as Record<string, unknown>)[g] || {};
  eval(src); // eslint-disable-line no-eval
};
async function setup(pw: typeof import('playwright-core')) {
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(PAGE);
  await page.evaluate(INJECT, fs.readFileSync(path.join(process.cwd(), 'out/overlay/overlay.js'), 'utf8'));
  await page.evaluate(() => window.__handlers['radial:set-select-mode']({}, true));
  return { browser, page };
}
const order = (page: Page) => page.evaluate(() => [...document.querySelectorAll('#s > div')].map((d) => d.id).join(''));
const sent = <C extends keyof HostPayloads>(page: Page, ch: C) => page.evaluate((c) => window.__sent.filter((m) => m.ch === c).map((m) => m.payload), ch) as Promise<HostPayloads[C][]>;
async function drag(page: Page, fromId: string, toId: string, where: InsertPosition) {
  const f = (await page.locator('#' + fromId).boundingBox())!, t = (await page.locator('#' + toId).boundingBox())!;
  await page.mouse.move(f.x + 10, f.y + f.height / 2); await page.mouse.down();
  await page.mouse.move(f.x + 10, f.y + f.height / 2 + 12, { steps: 3 }); // past the 7px arm threshold
  const ty = where === 'after' ? t.y + t.height - 4 : where === 'before' ? t.y + 4 : t.y + t.height / 2;
  await page.mouse.move(t.x + 10, ty, { steps: 6 });
  await page.waitForTimeout(30);
}

test('OFF (default): a canvas drag moves nothing and emits one Layers hint', async (t) => {
  const pw = loadPlaywright(); if (!pw) { t.skip('Playwright not available'); return; }
  const { browser, page } = await setup(pw);
  try {
    await drag(page, 'b', 'c', 'after'); await page.mouse.up();
    assert.equal(await order(page), 'abc', 'DOM order unchanged');
    assert.equal((await sent(page, 'radial:canvas-move')).length, 0, 'no canvas-move');
    const hints = await sent(page, 'radial:canvas-drag-blocked');
    assert.equal(hints.length, 1, 'exactly one hint');
    assert.match(hints[0].selector, /#b$/, 'hint names the element the user tried to move');
    await drag(page, 'a', 'c', 'after'); await page.mouse.up();
    assert.equal((await sent(page, 'radial:canvas-drag-blocked')).length, 1, 'hint is once per page');
    assert.equal(await order(page), 'abc');
  } finally { await browser.close(); }
});

test('ON (flag): the gesture arms and moves; canvas-move carries pre-move payloads', async (t) => {
  const pw = loadPlaywright(); if (!pw) { t.skip('Playwright not available'); return; }
  const { browser, page } = await setup(pw);
  try {
    await page.evaluate(() => window.__handlers['radial:set-canvas-reorder']({}, true));
    await drag(page, 'b', 'c', 'after'); await page.mouse.up();
    assert.equal(await order(page), 'acb', 'B landed after C');
    const mv = await sent(page, 'radial:canvas-move');
    assert.equal(mv.length, 1);
    assert.equal(mv[0].position, 'after');
    assert.match(mv[0].subject.selector, /#b$/); assert.match(mv[0].target.selector, /#c$/);
    assert.equal(mv[0].subject.path[0].nth, 1, 'subject path describes the PRE-move tree (b was 2nd)');
    assert.equal((await sent(page, 'radial:canvas-drag-blocked')).length, 0, 'no hint when the gesture is on');
  } finally { await browser.close(); }
});

test('switching OFF mid-drag restores the lifted element and drops nothing', async (t) => {
  const pw = loadPlaywright(); if (!pw) { t.skip('Playwright not available'); return; }
  const { browser, page } = await setup(pw);
  try {
    await page.evaluate(() => window.__handlers['radial:set-canvas-reorder']({}, true));
    await drag(page, 'b', 'c', 'after');
    assert.equal(await page.evaluate(() => document.getElementById('b')!.style.opacity), '0.35', 'lifted');
    await page.evaluate(() => window.__handlers['radial:set-canvas-reorder']({}, false));
    assert.equal(await page.evaluate(() => document.getElementById('b')!.style.opacity), '', 'restored');
    await page.mouse.up();
    assert.equal(await order(page), 'abc');
    assert.equal((await sent(page, 'radial:canvas-move')).length, 0);
  } finally { await browser.close(); }
});
