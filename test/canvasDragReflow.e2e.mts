// The live-reflow canvas drag (behind radial.canvasReorder), in a real Chromium:
// slots are axis-aware and measured where siblings RENDER, drops into a
// container land at the pointer's slot (not "last child"), gaps resolve to the
// slot between neighbors, phrasing containers are climbed, positioned elements
// refuse with a reason, Escape restores, and the committed payloads describe the
// PRE-move tree (what the source scanner sees).
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import type { TestContext } from 'node:test';
import type { Page } from 'playwright-core';
import type { CapturedSelection } from '../src/shared/overlayMessages.ts';
import type { InsertPosition } from '../src/shared/radialApi.ts';
const require = createRequire(import.meta.url);
type Playwright = typeof import('playwright-core');
/** A listener the overlay registers on its ipcRenderer (Electron passes the event, then the sender's arguments). */
type IpcListener = (event: unknown, ...args: unknown[]) => void;
/** One message the overlay sent its host, as INJECT's stand-in records it. */
interface SentMessage { ch: string; payload: unknown }
/** What the overlay sends on the channels this test reads (renderer.ts OverlayToHostPayloads). */
interface SentPayloads {
  'radial:canvas-move': { subject: CapturedSelection; target: CapturedSelection; position: InsertPosition };
  'radial:canvas-drag-blocked': { selector: string; reason?: 'positioned' | 'grid-placed' | 'css-order' };
}
// The page's window in this harness (the functions passed to page.evaluate run
// there): INJECT's ipcRenderer stand-in keeps what the overlay sends and the
// listeners it registers, and Node's globals are stubbed on it by name.
declare const window: Window & typeof globalThis & { __sent: SentMessage[]; __handlers: Record<string, IpcListener> };
function loadPlaywright() { for (const r of [path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '..', 'node_modules')]) for (const n of ['playwright', 'playwright-core']) { try { return require(path.join(r, n)) as Playwright; } catch {} } return null; }
const INJECT = (src: string) => {
  window.__sent = []; window.__handlers = {};
  const ipcRenderer = { sendToHost: (ch: string, payload: unknown) => window.__sent.push({ ch, payload }), on: (ch: string, fn: IpcListener) => { window.__handlers[ch] = fn; } };
  const require = () => ({ ipcRenderer }); // eslint-disable-line no-unused-vars
  for (const g of ['require', 'module', 'exports', 'process', 'global', 'Buffer', '__dirname', '__filename']) (window as unknown as Record<string, unknown>)[g] = (window as unknown as Record<string, unknown>)[g] || {};
  eval(src); // eslint-disable-line no-eval
};
const BOX = (id: string, extra = '') => `<div id="${id}" style="width:100px;height:60px;background:#ddd;${extra}">${id.toUpperCase()}</div>`;
async function setup(pw: Playwright, html: string) {
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent(`<!doctype html><html><body style="margin:40px;font:16px system-ui">${html}</body></html>`);
  await page.evaluate(INJECT, fs.readFileSync(path.join(process.cwd(), 'out/overlay/overlay.js'), 'utf8'));
  await page.evaluate(() => { window.__handlers['radial:set-select-mode']({}, true); window.__handlers['radial:set-canvas-reorder']({}, true); });
  return { browser, page };
}
const order = (page: Page, sel: string) => page.evaluate((s) => [...document.querySelector(s)!.children].map((d) => d.id).join(''), sel);
const sent = <C extends keyof SentPayloads>(page: Page, ch: C) => page.evaluate((c) => window.__sent.filter((m) => m.ch === c).map((m) => m.payload as SentPayloads[C]), ch);
const center = async (page: Page, id: string) => { const b = (await page.locator('#' + id).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2, b }; };
async function lift(page: Page, id: string) { const c = await center(page, id); await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x + 9, c.y + 9, { steps: 2 }); return c; }
async function moveTo(page: Page, x: number, y: number) { await page.mouse.move(x, y, { steps: 8 }); await page.waitForTimeout(220); await page.mouse.move(x + 1, y, { steps: 1 }); await page.waitForTimeout(220); }
function run(name: string, html: string, body: (page: Page, t: TestContext) => Promise<void>) {
  test(name, async (t) => {
    const pw = loadPlaywright(); if (!pw) { t.skip('Playwright not available'); return; }
    const { browser, page } = await setup(pw, html);
    try { await body(page, t); } finally { await browser.close(); }
  });
}

run('flex row: the slot is along X against rendered centers (bar is vertical), commit payload is pre-move',
  `<div id="row" style="display:flex;gap:24px;width:600px">${BOX('a')}${BOX('b')}${BOX('c')}</div>`, async (page) => {
    await lift(page, 'a');
    const b = await center(page, 'b'), c = await center(page, 'c');
    await moveTo(page, (b.x + c.x) / 2 + 10, b.y);        // between B and C
    assert.equal(await order(page, '#row'), 'bac', 'live reflow placed A between B and C');
    await moveTo(page, c.x + 60, c.y);                     // past C
    assert.equal(await order(page, '#row'), 'bca', 'A now after C');
    await page.mouse.up();
    const mv = await sent(page, 'radial:canvas-move');
    assert.equal(mv.length, 1);
    assert.equal(mv[0].position, 'after'); assert.match(mv[0].target.selector, /#c$/);
    assert.equal(mv[0].subject.path[0].nth, 0, 'subject describes the PRE-move tree (A was first)');
    assert.equal(await order(page, '#row'), 'bca', 'final DOM kept after the commit round-trip');
  });

run('block column: slot along Y; a heading dropped at the TOP of a div lands FIRST, not last',
  `<section id="s"><div id="card1" style="padding:20px;background:#f3f3f3"><h3 id="h">Title</h3><p id="p">Body copy that is long enough to click.</p></div><div id="card2" style="padding:20px;margin-top:24px;background:#e9e9e9"><p id="p2">Second card first paragraph</p><p id="p3">Second card second paragraph</p></div></section>`, async (page) => {
    await lift(page, 'h');
    const c2 = (await page.locator('#card2').boundingBox())!, p2 = await center(page, 'p2');
    await moveTo(page, c2.x + c2.width / 2, p2.y - 14);    // inside card2, above its first paragraph (past the 12px edge band)
    assert.equal(await order(page, '#card2'), 'hp2p3', 'heading is the FIRST child of card2');
    assert.equal(await order(page, '#card1'), 'p');
    await page.mouse.up();
    const mv = await sent(page, 'radial:canvas-move');
    assert.equal(mv[0].position, 'before'); assert.match(mv[0].target.selector, /#p2$/);
  });

run('phrasing containers are climbed: a heading over a <p> lands beside it, never inside it',
  `<section id="s"><div id="card" style="padding:20px"><h3 id="h">Title</h3><p id="p" style="height:80px">Body</p><p id="q" style="height:80px">More</p></div></section>`, async (page) => {
    await lift(page, 'h');
    const q = await center(page, 'q');
    await moveTo(page, q.x, q.y + 20);                     // deep inside <p id=q> — a block can't live there
    assert.equal(await order(page, '#card'), 'pqh', 'heading placed after q in the card, not inside the paragraph');
    assert.equal(await page.evaluate(() => document.querySelector('#q h3')), null);
    await page.mouse.up();
  });

run('gap between siblings resolves to the slot between them, not "inside parent, last"',
  `<div id="col" style="display:flex;flex-direction:column;gap:40px;width:200px">${BOX('a')}${BOX('b')}${BOX('c')}</div>`, async (page) => {
    await lift(page, 'c');
    const a = await center(page, 'a'), b = await center(page, 'b');
    await moveTo(page, a.x, (a.b.y + a.b.height + b.b.y) / 2); // in the 40px gap between A and B
    assert.equal(await order(page, '#col'), 'acb');
    await page.mouse.up();
  });

run('row-reverse: the visual slot maps to the right DOM insertion (measured, flipped)',
  `<div id="rev" style="display:flex;flex-direction:row-reverse;gap:24px;width:600px">${BOX('a')}${BOX('b')}${BOX('c')}</div>`, async (page) => {
    // Renders C B A left→right. Drag A (rightmost) to between C and B visually.
    await lift(page, 'a');
    const b = await center(page, 'b'), c = await center(page, 'c');
    await moveTo(page, (c.x + b.x) / 2, b.y);
    const xs = await page.evaluate(() => Object.fromEntries(['a', 'b', 'c'].map((i) => [i, document.getElementById(i)!.getBoundingClientRect().left])));
    assert.ok(xs.c < xs.a && xs.a < xs.b, `A renders between C and B (got c=${xs.c} a=${xs.a} b=${xs.b})`);
    assert.equal(await order(page, '#rev'), 'bac', 'DOM insertion was flipped to express the visual slot');
    await page.mouse.up();
    const mv = await sent(page, 'radial:canvas-move');
    assert.equal(mv.length, 1, 'committed');
  });

run('wrap + grid: 2D slots pick the row band under the pointer, then X',
  `<div id="wrap" style="display:flex;flex-wrap:wrap;gap:10px;width:230px">${BOX('a')}${BOX('b')}${BOX('c')}${BOX('d')}</div>
   <div id="grid" style="display:grid;grid-template-columns:repeat(2,100px);gap:10px;margin-top:40px">${BOX('e')}${BOX('f')}${BOX('g')}${BOX('h')}</div>`, async (page) => {
    await lift(page, 'd');                                   // row 2 → between A and B in row 1
    const a = await center(page, 'a'), b = await center(page, 'b');
    await moveTo(page, (a.x + b.x) / 2, a.y);
    assert.equal(await order(page, '#wrap'), 'adbc');
    await page.mouse.up(); await page.waitForTimeout(50);
    await lift(page, 'g');                                   // grid: before E
    const e = await center(page, 'e');
    await moveTo(page, e.x - 30, e.y);
    assert.equal(await order(page, '#grid'), 'gefh');
    await page.mouse.up();
  });

run('empty container: drop inside as the only child; commit says inside + the container',
  `<div id="col" style="width:200px">${BOX('a')}${BOX('b')}<div id="empty" style="min-height:90px;border:1px dashed #999"></div></div>`, async (page) => {
    await lift(page, 'a');
    const em = (await page.locator('#empty').boundingBox())!;
    await moveTo(page, em.x + em.width / 2, em.y + em.height / 2);
    assert.equal(await order(page, '#empty'), 'a');
    await page.mouse.up();
    const mv = await sent(page, 'radial:canvas-move');
    assert.equal(mv[0].position, 'inside'); assert.match(mv[0].target.selector, /#empty$/);
  });

run('positioned element refuses with a reason; Escape restores a live-moved element',
  `<div id="col" style="position:relative;width:300px;height:200px">${BOX('a')}${BOX('b')}<div id="abs" style="position:absolute;right:0;top:0;width:60px;height:60px;background:#c00">ABS</div></div>`, async (page) => {
    await lift(page, 'abs');
    const a = await center(page, 'a'); await moveTo(page, a.x, a.y - 20); await page.mouse.up();
    const blocked = await sent(page, 'radial:canvas-drag-blocked');
    assert.equal(blocked.length, 1); assert.equal(blocked[0].reason, 'positioned');
    assert.equal(await order(page, '#col'), 'ababs'.replace('ab', 'ab'), 'nothing moved');
    assert.equal((await sent(page, 'radial:canvas-move')).length, 0);
    // Escape mid-drag
    await lift(page, 'b');
    await moveTo(page, a.x, a.y - 20);
    assert.equal(await order(page, '#col'), 'baabs', 'live reflow moved B before A');
    await page.keyboard.press('Escape');
    assert.equal(await order(page, '#col'), 'ababs', 'Escape restored the original order');
    await page.mouse.up();
    assert.equal((await sent(page, 'radial:canvas-move')).length, 0, 'no commit after Escape');
  });

run('stability: jitter around a placement does not oscillate the slot',
  `<div id="row" style="display:flex;gap:24px;width:600px">${BOX('a')}${BOX('b')}${BOX('c')}</div>`, async (page) => {
    await lift(page, 'a');
    const b = await center(page, 'b'), c = await center(page, 'c');
    const x = (b.x + c.x) / 2 + 10;
    await moveTo(page, x, b.y);
    const before = await order(page, '#row');
    for (let i = 0; i < 12; i++) { await page.mouse.move(x + (i % 2 ? 2 : -2), b.y + (i % 3 ? 1 : -1)); await page.waitForTimeout(25); }
    assert.equal(await order(page, '#row'), before, 'order stable under jitter');
    await page.mouse.up();
  });
