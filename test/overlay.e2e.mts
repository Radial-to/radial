// E2E for the Text tool's inline-edit interactions, in a real Chromium. The
// overlay preload is plain DOM code behind an ipcRenderer shim, so we load it
// into a page with `require('electron')` stubbed and drive real mouse input:
//   drag over not-yet-editing text → selection survives and editing begins →
//   type replaces the selection → Enter saves → click again re-edits at once.
// These are the exact motions that used to break (beginEdit ran on click,
// after the drag, and collapsed the selection the user just made).
//
// Opt-in: `npm run test:e2e` (NOT part of `npm test`, which stays browser-free).
// Skips cleanly if Playwright/Chromium isn't available.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import type { TextEdit } from '../src/shared/radialApi.ts';
import type { CapturedSelection, SelectElementPayload, SelectEnrichPayload } from '../src/shared/overlayMessages.ts';

const require = createRequire(import.meta.url);

type Playwright = typeof import('playwright-core');

// The page window here: the overlay runs in a plain page behind a stubbed
// ipcRenderer, which records what the overlay sends the host and keeps the
// handlers it registers for messages from the host.
/**
 * What the overlay sends the host (ipcRenderer.sendToHost), by channel: the ones
 * these tests read. Mirrors those entries of renderer.ts's OverlayToHostPayloads;
 * becomes `Pick<OverlayToHostPayloads, …>` once that map moves to
 * src/shared/overlayMessages.ts.
 */
interface HostMessages {
  'radial:edit': TextEdit;
  'radial:select-element': SelectElementPayload;
  'radial:select-enrich': SelectEnrichPayload;
  'radial:inspect-element': CapturedSelection;
  'radial:quick-inspect': boolean;
}
type HostChannel = keyof HostMessages;
/** A message the stub recorded: every sendToHost the overlay makes, on any of its channels. */
interface SentMessage { ch: string; payload: unknown }
/** A recorded message on one of the channels above, which fixes its payload: what a filter on the channel narrows to. */
type Sent<C extends HostChannel> = { ch: C; payload: HostMessages[C] };
/** The `|| {}` stand-in when nothing was sent on a channel. */
interface NothingSent { payload?: undefined }
/** A handler the overlay registered with ipcRenderer.on; the tests call it with a stand-in event. */
type HostHandler = (event: object, payload?: unknown) => void;
/** The Node globals the overlay scrubs off window (non-isolated preload hygiene). */
type NodeGlobal = 'require' | 'module' | 'exports' | 'process' | 'global' | 'Buffer' | '__dirname' | '__filename';
interface OverlayWindow extends Window, Partial<Record<NodeGlobal, unknown>> {
  __sent: SentMessage[];
  __handlers: Record<string, HostHandler>;
}
declare const window: OverlayWindow;

function loadPlaywright() {
  const roots = [
    path.join(process.cwd(), 'node_modules'),
    path.join(process.cwd(), '..', 'node_modules'),
    '/tmp/radial-docs-qa/node_modules',
  ];
  for (const r of roots) {
    for (const name of ['playwright', 'playwright-core']) {
      try { return require(path.join(r, name)) as Playwright; } catch {}
    }
  }
  return null;
}

test('text tool: drag-select starts editing, Enter saves, click re-edits', async (t) => {
  const pw = loadPlaywright();
  if (!pw) { t.skip('Playwright not available — run where cached Chromium is set up'); return; }
  let browser;
  try {
    browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  } catch (e) { t.skip('Chromium launch failed: ' + (e as Error).message); return; }

  try {
    const page = await browser.newPage();
    await page.setContent(
      '<!doctype html><html><body style="margin:40px;font:24px system-ui">'
      + '<h1 id="t">Hello world example</h1><p id="p">Another paragraph.</p></body></html>'
    );

    // Load the overlay with require('electron') stubbed; record every
    // sendToHost and keep the host->overlay handlers callable from the test.
    const overlaySrc = fs.readFileSync(path.join(process.cwd(), 'out/overlay/overlay.js'), 'utf8');
    await page.evaluate((src: string) => {
      window.__sent = [];
      window.__handlers = {};
      const ipcRenderer = {
        sendToHost: (ch: string, payload: unknown) => window.__sent.push({ ch, payload }),
        on: (ch: string, fn: HostHandler) => { window.__handlers[ch] = fn; },
      };
      const require = () => ({ ipcRenderer }); // eslint-disable-line no-unused-vars
      // The overlay scrubs these off window (non-isolated preload hygiene) —
      // give it something to delete.
      for (const g of ['require', 'module', 'exports', 'process', 'global', 'Buffer', '__dirname', '__filename'] as const) window[g] = window[g] || {};
      eval(src); // direct eval: the overlay's `require(...)` resolves to the stub above
    }, overlaySrc);
    await page.evaluate(() => window.__handlers['radial:set-edit-mode']({}, true));

    // 1. Drag across the headline while it is NOT yet being edited. Editing
    //    must begin on mousedown and the drag's selection must survive.
    const box = (await page.locator('#t').boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.55, y, { steps: 8 });
    await page.mouse.up();
    const afterDrag = await page.evaluate(() => ({
      editable: document.getElementById('t')!.getAttribute('contenteditable'),
      selected: window.getSelection()!.toString(),
    }));
    assert.equal(afterDrag.editable, 'true', 'drag should begin editing the element');
    assert.ok(afterDrag.selected.length > 2, `drag selection should survive (got "${afterDrag.selected}")`);

    // 2. Typing replaces the selection; Enter saves and reports the edit.
    await page.keyboard.type('Radial');
    await page.keyboard.press('Enter');
    const afterSave = await page.evaluate(() => ({
      editable: document.getElementById('t')!.getAttribute('contenteditable'),
      text: document.getElementById('t')!.textContent,
      edit: (window.__sent.filter((m): m is Sent<'radial:edit'> => m.ch === 'radial:edit').pop() || {} as NothingSent).payload,
    }));
    assert.equal(afterSave.editable, null, 'Enter should end the edit');
    assert.ok(afterSave.text.includes('Radial'), 'typed text should land in the element');
    assert.ok(afterSave.edit, 'the edit should be sent to the host');
    assert.equal(afterSave.edit.originalText, 'Hello world example');
    assert.equal(afterSave.edit.newText, afterSave.text.trim());

    // 3. Click the same text again immediately — editing must resume without
    //    toggling tools.
    await page.mouse.click(box.x + 10, y);
    const reEdit = await page.evaluate(() => document.getElementById('t')!.getAttribute('contenteditable'));
    assert.equal(reEdit, 'true', 'a click right after saving should re-enter editing');

    // 4. Click out (the paragraph is editable too, so aim at the empty margin
    //    below it) — the edit ends without sending a change.
    const sentBefore = await page.evaluate(() => window.__sent.filter((m) => m.ch === 'radial:edit').length);
    const pBox = (await page.locator('#p').boundingBox())!;
    await page.mouse.click(pBox.x + 4, pBox.y + pBox.height + 60);
    const afterOut = await page.evaluate(() => ({
      editable: document.getElementById('t')!.getAttribute('contenteditable'),
      edits: window.__sent.filter((m) => m.ch === 'radial:edit').length,
    }));
    assert.equal(afterOut.editable, null, 'clicking out should end the edit');
    assert.equal(afterOut.edits, sentBefore, 'an unchanged edit should not be sent');
  } finally {
    await browser.close();
  }
});

// The adjust steppers' overlay half: a Select click reports computed styles +
// the page's type scale; radial:adjust-preview applies inline !important
// styles instantly; adjust-revert restores the element EXACTLY (including a
// pre-existing inline value); adjust-forget keeps applied styles (post-apply,
// so there's no flash back while the agent's real edit lands).
test('adjust preview: select reports styles, preview applies, revert restores exactly', async (t) => {
  const pw = loadPlaywright();
  if (!pw) { t.skip('Playwright not available — run where cached Chromium is set up'); return; }
  let browser;
  try {
    browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  } catch (e) { t.skip('Chromium launch failed: ' + (e as Error).message); return; }

  try {
    const page = await browser.newPage();
    await page.setContent(
      '<!doctype html><html><body style="margin:40px;font:16px system-ui">'
      + '<h1 id="t" style="font-size:32px">Hello world example</h1>'
      + '<p id="p" style="padding-top:4px">Another paragraph.</p></body></html>'
    );
    const overlaySrc = fs.readFileSync(path.join(process.cwd(), 'out/overlay/overlay.js'), 'utf8');
    await page.evaluate((src: string) => {
      window.__sent = [];
      window.__handlers = {};
      const ipcRenderer = {
        sendToHost: (ch: string, payload: unknown) => window.__sent.push({ ch, payload }),
        on: (ch: string, fn: HostHandler) => { window.__handlers[ch] = fn; },
      };
      const require = () => ({ ipcRenderer }); // eslint-disable-line no-unused-vars
      for (const g of ['require', 'module', 'exports', 'process', 'global', 'Buffer', '__dirname', '__filename'] as const) window[g] = window[g] || {};
      eval(src);
    }, overlaySrc);
    await page.evaluate(() => window.__handlers['radial:set-select-mode']({}, true));

    // 1. A Select click captures the element with stepper seed data.
    const box = (await page.locator('#t').boundingBox())!;
    await page.mouse.click(box.x + 10, box.y + box.height / 2);
    await page.waitForTimeout(500); // the select fires after the double-click grace (350ms)
    const sel = await page.evaluate(() => (window.__sent.filter((m): m is Sent<'radial:select-element'> => m.ch === 'radial:select-element').pop() || {} as NothingSent).payload);
    assert.ok(sel, 'the click should select the element');
    assert.equal(sel.tagName, 'h1');
    assert.equal(Math.round(sel.adjust.fontSize), 32, 'computed font-size should seed the stepper');
    // Page-wide provenance (type scale, palette, stylesheet walk) rides the
    // follow-up radial:select-enrich on idle — the fast select payload paints
    // first. Wait for the enrichment for THIS selection, then check the scale.
    await page.waitForFunction((sl) => window.__sent.some((m) => m.ch === 'radial:select-enrich' && (m as Sent<'radial:select-enrich'>).payload.selector === sl), sel.selector, { timeout: 2000 });
    const enrich = await page.evaluate((sl) => window.__sent.filter((m): m is Sent<'radial:select-enrich'> => m.ch === 'radial:select-enrich' && (m as Sent<'radial:select-enrich'>).payload.selector === sl).pop()!.payload, sel.selector);
    assert.ok(Array.isArray(enrich.typeScale) && enrich.typeScale.includes(32), 'the page type scale (enrichment) should include rendered sizes');

    // 2. Preview applies instantly, with !important so utility classes lose.
    await page.evaluate((s) => window.__handlers['radial:adjust-preview']({}, { selector: s, styles: { 'padding-top': '32px', 'font-size': '48px' } }), sel.selector);
    const applied = await page.evaluate(() => {
      const el = document.getElementById('t')!;
      return { pad: getComputedStyle(el).paddingTop, prio: el.style.getPropertyPriority('padding-top'), size: getComputedStyle(el).fontSize };
    });
    assert.equal(applied.pad, '32px');
    assert.equal(applied.prio, 'important');
    assert.equal(applied.size, '48px');

    // 3. Revert restores the element exactly — the padding inline style goes,
    //    the font-size returns to the element's own pre-existing inline 32px.
    await page.evaluate(() => window.__handlers['radial:adjust-revert']({}));
    const reverted = await page.evaluate(() => {
      const el = document.getElementById('t')!;
      return { padInline: el.style.getPropertyValue('padding-top'), size: getComputedStyle(el).fontSize };
    });
    assert.equal(reverted.padInline, '', 'no leftover inline padding after revert');
    assert.equal(reverted.size, '32px', 'pre-existing inline font-size should be restored');

    // 4. A pre-existing inline value on another element also round-trips.
    const pBox = (await page.locator('#p').boundingBox())!;
    await page.mouse.click(pBox.x + 10, pBox.y + pBox.height / 2);
    await page.waitForTimeout(500);
    const pSel = await page.evaluate(() => (window.__sent.filter((m): m is Sent<'radial:select-element'> => m.ch === 'radial:select-element').pop() || {} as NothingSent).payload) as SelectElementPayload; // the click above selected it
    assert.equal(pSel.tagName, 'p');
    await page.evaluate((s) => window.__handlers['radial:adjust-preview']({}, { selector: s, styles: { 'padding-top': '40px' } }), pSel.selector);
    await page.evaluate(() => window.__handlers['radial:adjust-revert']({}));
    const pInline = await page.evaluate(() => document.getElementById('p')!.style.getPropertyValue('padding-top'));
    assert.equal(pInline, '4px', 'the original inline padding should be restored');

    // 5. After apply (forget), styles stay — a later revert must not undo them.
    await page.evaluate((s) => window.__handlers['radial:adjust-preview']({}, { selector: s, styles: { 'padding-top': '40px' } }), pSel.selector);
    await page.evaluate(() => window.__handlers['radial:adjust-forget']({}));
    await page.evaluate(() => window.__handlers['radial:adjust-revert']({}));
    const kept = await page.evaluate(() => getComputedStyle(document.getElementById('p')!).paddingTop);
    assert.equal(kept, '40px', 'applied styles persist until the real edit reloads in');
  } finally {
    await browser.close();
  }
});

// Parent selection: from a buried headline, walk UP to the card/section it
// lives in (pill button → radial:select-parent, or ↑ over the canvas), and ↓
// retraces the exact path back down. Stops at the page shell.
test('parent selection: walks up the ancestor chain and back down', async (t) => {
  const pw = loadPlaywright();
  if (!pw) { t.skip('Playwright not available — run where cached Chromium is set up'); return; }
  let browser;
  try {
    browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  } catch (e) { t.skip('Chromium launch failed: ' + (e as Error).message); return; }

  try {
    const page = await browser.newPage();
    await page.setContent(
      '<!doctype html><html><body style="margin:40px;font:16px system-ui">'
      + '<section id="s" style="padding:24px"><div id="card" style="padding:16px;background:#eee">'
      + '<h2 id="h">Card title</h2><p>Card body text.</p></div></section></body></html>'
    );
    const overlaySrc = fs.readFileSync(path.join(process.cwd(), 'out/overlay/overlay.js'), 'utf8');
    await page.evaluate((src: string) => {
      window.__sent = [];
      window.__handlers = {};
      const ipcRenderer = {
        sendToHost: (ch: string, payload: unknown) => window.__sent.push({ ch, payload }),
        on: (ch: string, fn: HostHandler) => { window.__handlers[ch] = fn; },
      };
      const require = () => ({ ipcRenderer }); // eslint-disable-line no-unused-vars
      for (const g of ['require', 'module', 'exports', 'process', 'global', 'Buffer', '__dirname', '__filename'] as const) window[g] = window[g] || {};
      eval(src);
    }, overlaySrc);
    await page.evaluate(() => window.__handlers['radial:set-select-mode']({}, true));
    const lastSel = () => page.evaluate(() => (window.__sent.filter((m): m is Sent<'radial:select-element'> => m.ch === 'radial:select-element').pop() || {} as NothingSent).payload) as Promise<SelectElementPayload>; // each read follows a selection

    // Click the headline — the thing you can actually hit.
    const box = (await page.locator('#h').boundingBox())!;
    await page.mouse.click(box.x + 10, box.y + box.height / 2);
    await page.waitForTimeout(500);
    assert.equal((await lastSel()).tagName, 'h2');

    // Pill button → parent: the card. Replace semantics: the h2 outline drops.
    await page.evaluate(() => window.__handlers['radial:select-parent']({}, {}));
    let sel = await lastSel();
    assert.equal(sel.tagName, 'div');
    assert.equal(sel.additive, false);
    const classes = await page.evaluate(() => ({
      card: document.getElementById('card')!.classList.contains('radial-selected'),
      h: document.getElementById('h')!.classList.contains('radial-selected'),
    }));
    assert.equal(classes.card, true);
    assert.equal(classes.h, false, 'plain parent-select replaces the child selection');

    // ↑ over the canvas: up again to the section.
    await page.keyboard.press('ArrowUp');
    assert.equal((await lastSel()).tagName, 'section');

    // ↑ again would hit <body> (the page shell) — refused, selection unchanged.
    await page.keyboard.press('ArrowUp');
    assert.equal((await lastSel()).tagName, 'section', 'the walk stops at the page shell');

    // ↓ retraces the exact path back down: section → card.
    await page.keyboard.press('ArrowDown');
    assert.equal((await lastSel()).tagName, 'div');

    // ⇧-parent keeps the current selection too (additive multi-select).
    await page.evaluate(() => window.__handlers['radial:select-parent']({}, { additive: true }));
    sel = await lastSel();
    assert.equal(sel.tagName, 'section');
    assert.equal(sel.additive, true);
    const both = await page.evaluate(() => ({
      card: document.getElementById('card')!.classList.contains('radial-selected'),
      s: document.getElementById('s')!.classList.contains('radial-selected'),
    }));
    assert.equal(both.card, true, 'additive keeps the child selected');
    assert.equal(both.s, true);
  } finally {
    await browser.close();
  }
});

test('select tool: empty containers stay as they are unless the reveal preference is on', async (t) => {
  const pw = loadPlaywright();
  if (!pw) { t.skip('Playwright not available'); return; }
  let browser;
  try { browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); } catch (e) { t.skip('Chromium launch failed: ' + (e as Error).message); return; }
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body style="margin:20px"><h1>Title</h1><div id="e"></div><p>Copy</p></body></html>');
    const overlaySrc = fs.readFileSync(path.join(process.cwd(), 'out/overlay/overlay.js'), 'utf8');
    await page.evaluate((src: string) => {
      window.__sent = []; window.__handlers = {};
      const ipcRenderer = { sendToHost: (ch: string, payload: unknown) => window.__sent.push({ ch, payload }), on: (ch: string, fn: HostHandler) => { window.__handlers[ch] = fn; } };
      const require = () => ({ ipcRenderer }); // eslint-disable-line no-unused-vars
      for (const g of ['require', 'module', 'exports', 'process', 'global', 'Buffer', '__dirname', '__filename'] as const) window[g] = window[g] || {};
      eval(src);
    }, overlaySrc);
    const state = () => page.evaluate(() => ({ reveal: document.documentElement.classList.contains('radial-reveal-empty'), h: document.getElementById('e')!.getBoundingClientRect().height }));
    await page.evaluate(() => window.__handlers['radial:set-select-mode']({}, true));
    assert.deepEqual(await state(), { reveal: false, h: 0 }, 'off by default: the empty div keeps its zero height');
    await page.evaluate(() => window.__handlers['radial:reveal-empty']({}, true));
    const on = await state();
    assert.equal(on.reveal, true); assert.ok(on.h >= 48, `revealed empties get height (${on.h})`);
    await page.evaluate(() => window.__handlers['radial:reveal-empty']({}, false));
    assert.deepEqual(await state(), { reveal: false, h: 0 }, 'turning the preference off puts the page back');
  } finally { await browser.close(); }
});

// Quick inspect: hold ⌥ in Select. Hover measures from the selection, a click
// inspects (it becomes the selection and the host is told), release restores
// Select untouched. Outside Select, ⌥ does nothing.
test('select tool: holding Option borrows the Inspect tool — measure from the selection, click inspects, release restores', async (t) => {
  const pw = loadPlaywright();
  if (!pw) { t.skip('Playwright not available — run where cached Chromium is set up'); return; }
  let browser;
  try {
    browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  } catch (e) { t.skip('Chromium launch failed: ' + (e as Error).message); return; }
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<!doctype html><html><body style="margin:40px;font:20px system-ui">'
      + '<h1 id="a" style="margin:0 0 30px">Headline</h1><p id="b" style="margin:0">Paragraph below.</p><div style="height:400px"></div></body></html>'
    );
    const overlaySrc = fs.readFileSync(path.join(process.cwd(), 'out/overlay/overlay.js'), 'utf8');
    await page.evaluate((src: string) => {
      window.__sent = [];
      window.__handlers = {};
      const ipcRenderer = {
        sendToHost: (ch: string, payload: unknown) => window.__sent.push({ ch, payload }),
        on: (ch: string, fn: HostHandler) => { window.__handlers[ch] = fn; },
      };
      const require = () => ({ ipcRenderer }); // eslint-disable-line no-unused-vars
      for (const g of ['require', 'module', 'exports', 'process', 'global', 'Buffer', '__dirname', '__filename'] as const) window[g] = window[g] || {};
      eval(src);
    }, overlaySrc);
    const sent = <C extends HostChannel>(ch: C) => page.evaluate((ch) => window.__sent.filter((m) => m.ch === ch).map((m) => m.payload), ch) as Promise<HostMessages[C][]>; // the payloads on channel ch
    await page.evaluate(() => window.__handlers['radial:set-select-mode']({}, true));
    const a = (await page.locator('#a').boundingBox())!;
    const b = (await page.locator('#b').boundingBox())!;

    // A plain click in Select selects the headline.
    await page.mouse.click(a.x + 10, a.y + a.height / 2);
    assert.equal(await page.evaluate(() => document.getElementById('a')!.classList.contains('radial-selected')), true, 'the headline is selected');
    assert.equal((await sent('radial:select-element')).length, 1);

    // Hold ⌥ with the cursor over the paragraph: measurements from the selection
    // appear at once, the host hears about the hold, no readout shows.
    await page.mouse.move(b.x + 10, b.y + b.height / 2);
    await page.keyboard.down('Alt');
    const held = await page.evaluate(() => {
      const m = document.getElementById('__radial_measure');
      const p = document.querySelector<HTMLElement>('.radial-inspect-panel');
      return { measure: m ? m.style.display : null, labels: m ? m.querySelectorAll('.rm-label').length : 0, readout: p ? p.style.display : 'none' };
    });
    assert.equal(held.measure, 'block', 'measurement lines are up');
    assert.ok(held.labels >= 1, 'with at least one distance label');
    assert.notEqual(held.readout, 'block', 'no readout while ⌥ is down');
    assert.deepEqual(await sent('radial:quick-inspect'), [true]);

    // ⌥-click the paragraph: it becomes the selection, the host gets an inspect
    // payload (not a second select), and measurements now run from it.
    await page.mouse.click(b.x + 10, b.y + b.height / 2);
    const clicked = await page.evaluate(() => ({
      sel: document.getElementById('b')!.classList.contains('radial-selected'),
      old: document.getElementById('a')!.classList.contains('radial-selected'),
      readout: (document.querySelector<HTMLElement>('.radial-inspect-panel') || { style: {} as Partial<CSSStyleDeclaration> }).style.display,
    }));
    assert.equal(clicked.sel, true, 'the ⌥-clicked element is selected');
    assert.equal(clicked.old, false, 'the old selection is released');
    assert.notEqual(clicked.readout, 'block', 'still no in-page readout while ⌥ is down');
    const inspect = await sent('radial:inspect-element');
    assert.equal(inspect.length, 1); assert.equal(inspect[0].tagName, 'p', JSON.stringify(inspect[0]));
    assert.equal((await sent('radial:select-element')).length, 1, 'an ⌥-click is an inspect, not another select message');
    await page.mouse.move(a.x + 10, a.y + a.height / 2);
    assert.equal(await page.evaluate(() => document.getElementById('__radial_measure')!.style.display), 'block', 'hovering the headline measures from the new selection');

    // Release: Select is back, the lines are gone, the Select hover is under the cursor.
    await page.keyboard.up('Alt');
    const released = await page.evaluate(() => ({
      measure: document.getElementById('__radial_measure')!.style.display,
      hover: document.getElementById('a')!.classList.contains('radial-select-hover'),
      inspectHover: document.querySelectorAll('.radial-inspect-hover').length,
      sel: document.getElementById('b')!.classList.contains('radial-selected'),
    }));
    assert.equal(released.measure, 'none');
    assert.equal(released.hover, true, 'the Select hover is back');
    assert.equal(released.inspectHover, 0);
    assert.equal(released.sel, true, 'the selection survives the release');
    assert.deepEqual(await sent('radial:quick-inspect'), [true, false]);
    // A plain click is a normal select again.
    await page.mouse.click(a.x + 10, a.y + a.height / 2);
    assert.equal((await sent('radial:select-element')).length, 2);

    // Nothing selected: ⌥ still borrows Inspect (hover readout, no lines to draw).
    await page.keyboard.press('Escape');
    await page.mouse.move(b.x + 10, b.y + b.height / 2);
    await page.keyboard.down('Alt');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.radial-selected').length), 0);
    assert.equal(await page.evaluate(() => document.getElementById('b')!.classList.contains('radial-inspect-hover')), true, 'the Inspect hover with nothing to measure from');
    await page.keyboard.up('Alt');

    // The host ends a hold the same way (its own keyup), and outside Select ⌥ does nothing.
    await page.keyboard.down('Alt');
    await page.evaluate(() => window.__handlers['radial:quick-inspect']({}, false));
    assert.equal(await page.evaluate(() => document.querySelectorAll('.radial-inspect-hover').length), 0, 'the host can end the hold');
    await page.keyboard.up('Alt');
    const before = (await sent('radial:quick-inspect')).length;
    await page.evaluate(() => window.__handlers['radial:set-select-mode']({}, false));
    await page.keyboard.down('Alt'); await page.keyboard.up('Alt');
    assert.equal((await sent('radial:quick-inspect')).length, before, 'no hold outside Select');
  } finally {
    await browser.close();
  }
});
