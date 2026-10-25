// The Content panel's page-wide field reader (overlay, real Chromium): text
// blocks + images in document order, grouped by landmark, `focus` marks the
// selection's fields, images carry a structural path for alt edits.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import type { ContentField } from '../src/shared/radialApi.ts';
const require = createRequire(import.meta.url);

/** A union whose members each read the other members' fields as undefined (src/renderer/types.d.ts LooseUnion): the checks read fields of every kind alike. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type LooseUnion<T, All = T> = T extends unknown ? T & { [K in Exclude<KeysOfUnion<All>, keyof T>]?: undefined } : never;
/** One Content field as the overlay sends it (overlay.ts OverlayContentField; not cliServer.ts's PageField): an image adds its thumbnail, and every field says whether it sits in the focus. To become LooseUnion<ContentFieldReadout> from src/shared/overlayMessages.ts once that exports it. */
type FieldReadout = LooseUnion<(Extract<ContentField, { kind: 'image' }> & { thumb: string | null; inFocus: boolean }) | (Exclude<ContentField, { kind: 'image' }> & { inFocus: boolean })>;
/** radial:fields-result: the focus it was read for, and the page's fields. To become OverlayToHostPayloads['radial:fields-result'] from src/shared/overlayMessages.ts. */
interface FieldsResult { focus: string | null; fields: FieldReadout[] }
/** The overlay's handler for one host message (ipcRenderer.on); the checks call it with a stand-in event. */
type OverlayHandler = (event: object, message: unknown) => void;
/** What INJECT puts on the page's window: what the overlay sent to its host, its handlers by channel, and the CommonJS names its compiled script reads. */
interface PageWindow extends Window {
  __sent: { ch: string; payload: unknown }[];
  __handlers: Record<string, OverlayHandler>;
  /** The scripted demo's interval: a number in the page, typed as this project's setInterval (Node's) returns it. */
  __tick: ReturnType<typeof setInterval>;
  require: unknown; module: unknown; exports: unknown; process: unknown; global: unknown; Buffer: unknown; __dirname: unknown; __filename: unknown;
}
declare const window: PageWindow;
function loadPlaywright(): typeof import('playwright-core') | null { for (const r of [path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '..', 'node_modules')]) for (const n of ['playwright', 'playwright-core']) { try { return require(path.join(r, n)) as typeof import('playwright-core'); } catch {} } return null; }
const INJECT = (src: string) => { window.__sent = []; window.__handlers = {}; const ipcRenderer = { sendToHost: (ch: string, payload?: unknown) => window.__sent.push({ ch, payload }), on: (ch: string, fn: OverlayHandler) => { window.__handlers[ch] = fn; } }; const require = () => ({ ipcRenderer }); for (const g of ['require', 'module', 'exports', 'process', 'global', 'Buffer', '__dirname', '__filename'] as const) window[g] = window[g] || {}; eval(src); }; // eslint-disable-line
const PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const PAGE = `<!doctype html><html><body style="margin:0;font:16px system-ui">
<header id="top"><nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav></header>
<section id="hero"><h1>Ship your site tonight</h1><p>Radial is a <strong>local</strong> editor.</p><img id="heroimg" src="${PX}" alt="Editor screenshot" width="40" height="30"></section>
<section class="features"><h2>Features that matter</h2><ul><li>Fast <a href="#a">links</a></li><li>Undo anywhere</li></ul><img id="noalt" src="${PX}" width="40" height="30"><p style="display:none">hidden copy</p></section>
<footer><p>${'Long footer text. '.repeat(40)}</p></footer>
</body></html>`;

test('read-fields: text blocks + images, document order, landmark groups, focus flags, image paths', async (t) => {
  const pw = loadPlaywright(); if (!pw) { t.skip('Playwright not available'); return; }
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    await page.evaluate(INJECT, fs.readFileSync(path.join(process.cwd(), 'out/overlay/overlay.js'), 'utf8'));
    await page.evaluate(() => window.__handlers['radial:read-fields']({}, { focus: '#hero' }));
    const res = await page.evaluate(() => window.__sent.find((m) => m.ch === 'radial:fields-result')!.payload as FieldsResult);
    assert.equal(res.focus, '#hero');
    const f = res.fields;
    const kinds = f.map((x) => `${x.kind}:${x.tag}:${x.kind === 'image' ? x.selector.replace(/^.*#/, '#') : x.text!.slice(0, 14)}`);
    // Document order, one field per text block (the <li> owns "Fast links"; its <a> is not a second field; the <p> with <strong> is one field).
    assert.deepEqual(kinds, [
      'text:a:Home', 'text:a:Pricing',
      'text:h1:Ship your site', 'text:p:Radial is a lo', 'image:img:#heroimg',
      'text:h2:Features that ', 'text:li:Fast links', 'text:li:Undo anywhere', 'image:img:#noalt',
      'text:p:Long footer te',
    ]);
    assert.equal(f.find((x) => x.text === 'Radial is a local editor.')!.hasMarkup, true);
    // The kind in words: tag plus where it sits (nav links, list items…).
    assert.deepEqual(f.map((x) => x.role), ['Nav link', 'Nav link', 'Heading', 'Body', 'Image', 'Subheading', 'List item', 'List item', 'Image', 'Body']);
    assert.equal(f[f.length - 1].truncated, true, 'long footer text is truncated');
    // Groups by landmark: id when present, else first heading, else tag.
    assert.deepEqual([...new Set(f.map((x) => x.group))], ['#top', '#hero', 'Features that matter', 'footer']);
    // Focus: everything inside #hero (and nothing outside).
    assert.deepEqual(f.filter((x) => x.inFocus).map((x) => x.tag), ['h1', 'p', 'img']);
    // Images carry alt (null when missing), size, and a structural path for the alt pin.
    const hero = f.find((x) => x.selector.endsWith('#heroimg'))!, noalt = f.find((x) => x.selector.endsWith('#noalt'))!;
    assert.equal(hero.alt, 'Editor screenshot'); assert.equal(noalt.alt, null);
    assert.ok(Array.isArray(hero.path) && hero.path[0].tag === 'img' && hero.path.some((l) => l.tag === 'section'));
    // In-page thumbnails: a data URL the host can always show (dev servers 403 cross-site image loads).
    assert.ok(typeof hero.thumb === 'string' && hero.thumb.startsWith('data:image/png'), 'loaded images carry a data-URL thumb');
    // Hidden text is skipped.
    assert.ok(!f.some((x) => x.text === 'hidden copy'));
    // No focus → no flags.
    await page.evaluate(() => window.__handlers['radial:read-fields']({}, {}));
    const res2 = await page.evaluate(() => window.__sent.filter((m) => m.ch === 'radial:fields-result').pop()!.payload as FieldsResult);
    assert.equal(res2.fields.filter((x) => x.inFocus).length, 0);
  } finally { await browser.close(); }
});


test('read-fields: scaffolding ids yield to the section heading; buttons and quotes get their kind', async (t) => {
  const pw = loadPlaywright(); if (!pw) { t.skip('Playwright not available'); return; }
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><main id="main-content"><h1>Ship it</h1><p>Intro</p><a class="btn btn-primary" href="/x">Download</a><a role="button" href="/y">Start</a><a href="/z">Learn more</a></main><section id="pricing"><h2>Plans</h2><blockquote>Nice</blockquote></section><div id="root"><footer><p>Fine</p></footer></div></body></html>');
    await page.evaluate(INJECT, fs.readFileSync(path.join(process.cwd(), 'out/overlay/overlay.js'), 'utf8'));
    await page.evaluate(() => window.__handlers['radial:read-fields']({}, {}));
    const f = await page.evaluate(() => (window.__sent.find((m) => m.ch === 'radial:fields-result')!.payload as FieldsResult).fields);
    // #main-content is scaffolding, so its h1 names the group; #pricing is a real name and keeps it.
    assert.deepEqual(f.map((x) => `${x.group}|${x.role}`), ['Ship it|Heading', 'Ship it|Body', 'Ship it|Button', 'Ship it|Button', 'Ship it|Link', '#pricing|Subheading', '#pricing|Quote', 'footer|Body']);
  } finally { await browser.close(); }
});

test('read-fields: a subtree that changes on its own becomes one Animated row and stops dirtying the tree; Radial\u2019s own live edits never count', async (t) => {
  const pw = loadPlaywright(); if (!pw) { t.skip('Playwright not available'); return; }
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><main><div class="wrap"><h1>Stable title</h1><p>Stable copy</p><div id="demo"><p>Tick 0</p><a href="#">Link 0</a></div></div><section id="after"><h2>After</h2></section></main></body></html>');
    await page.evaluate(INJECT, fs.readFileSync(path.join(process.cwd(), 'out/overlay/overlay.js'), 'utf8'));
    await page.evaluate(() => { window.__handlers['radial:read-tree']({}, { full: true }); window.__sent.length = 0; });
    // A scripted demo: the subtree re-renders every half second.
    await page.evaluate(() => { let i = 0; window.__tick = setInterval(() => { i++; document.getElementById('demo')!.innerHTML = `<p>Tick ${i}</p><a href="#">Link ${i}</a>`; }, 500); });
    await page.waitForTimeout(2600); // 5 beats: the root is known by the 3rd
    const dirtyA = await page.evaluate(() => window.__sent.filter((m) => m.ch === 'radial:tree-dirty').length);
    await page.waitForTimeout(1600);
    const dirtyB = await page.evaluate(() => window.__sent.filter((m) => m.ch === 'radial:tree-dirty').length);
    assert.ok(dirtyA >= 1 && dirtyA <= 4, `dirtied a few times before the root was known (${dirtyA})`);
    assert.equal(dirtyB, dirtyA, 'no more tree-dirty once the churn is a known animated root');
    await page.evaluate(() => { window.__sent.length = 0; window.__handlers['radial:read-fields']({}, {}); });
    const f = await page.evaluate(() => (window.__sent.find((m) => m.ch === 'radial:fields-result')!.payload as FieldsResult).fields);
    // The wrapper around the demo is NOT swallowed: the headline next to the demo stays a field.
    assert.deepEqual(f.map((x) => `${x.kind}:${x.role}:${x.kind === 'animated' ? x.name + '/' + x.count : x.text}`), ['text:Heading:Stable title', 'text:Body:Stable copy', 'animated:Animated:#demo/2', 'text:Subheading:After']);
    // Live typing through Radial lands as childList mutations too: four beats on the h1 must not make it animated.
    await page.evaluate(() => clearInterval(window.__tick));
    for (let i = 1; i <= 4; i++) { await page.evaluate((i) => window.__handlers['radial:set-text']({}, { selector: 'h1', text: 'Stable title ' + 'x'.repeat(i), live: true }), i); await page.waitForTimeout(500); }
    await page.evaluate(() => { window.__sent.length = 0; window.__handlers['radial:read-fields']({}, {}); });
    const f2 = await page.evaluate(() => (window.__sent.find((m) => m.ch === 'radial:fields-result')!.payload as FieldsResult).fields);
    assert.equal(f2[0].kind, 'text'); assert.equal(f2[0].text, 'Stable title xxxx');
  } finally { await browser.close(); }
});
