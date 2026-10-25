// Regression tests for the preview overlay (overlay.ts), in a real Chromium.
// As in test/overlay.e2e.mts, the overlay's compiled script runs in a plain
// page with require('electron') stubbed: what it sends its host (sendToHost)
// is recorded, and its handlers for messages from the host can be called.
//
// Opt-in: `npm run test:e2e` (NOT part of `npm test`, which stays browser-free).
// Skips cleanly if Playwright/Chromium isn't available.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import type { Browser, Page } from 'playwright-core';
import type { SelectElementPayload } from '../src/shared/overlayMessages.ts';

const require = createRequire(import.meta.url);
type Playwright = typeof import('playwright-core');

/** A message the stub recorded: every sendToHost the overlay makes. */
interface SentMessage { ch: string; payload: unknown }
/** A handler the overlay registered with ipcRenderer.on; tests call it with a stand-in event. */
type HostHandler = (event: object, payload?: unknown) => void;
/** The Node globals the overlay scrubs off window (non-isolated preload hygiene). */
type NodeGlobal = 'require' | 'module' | 'exports' | 'process' | 'global' | 'Buffer' | '__dirname' | '__filename';
interface OverlayWindow extends Window, Partial<Record<NodeGlobal, unknown>> {
  __sent: SentMessage[];
  __handlers: Record<string, HostHandler>;
}
declare const window: OverlayWindow;

function loadPlaywright(): Playwright | null {
  for (const r of [path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '..', 'node_modules')]) {
    for (const name of ['playwright', 'playwright-core']) {
      try { return require(path.join(r, name)) as Playwright; } catch {}
    }
  }
  return null;
}

const OVERLAY = () => fs.readFileSync(path.join(process.cwd(), 'out/overlay/overlay.js'), 'utf8');
/** Runs the overlay in the page, with ipcRenderer stubbed (a page function: it runs in the page). */
function injectOverlay(src: string): void {
  window.__sent = []; window.__handlers = {};
  const ipcRenderer = {
    sendToHost: (ch: string, payload: unknown) => window.__sent.push({ ch, payload }),
    on: (ch: string, fn: HostHandler) => { window.__handlers[ch] = fn; },
  };
  const require = () => ({ ipcRenderer }); // eslint-disable-line no-unused-vars
  for (const g of ['require', 'module', 'exports', 'process', 'global', 'Buffer', '__dirname', '__filename'] as const) window[g] = window[g] || {};
  eval(src); // direct eval: the overlay's `require(...)` resolves to the stub above
}

let browser: Browser | null = null;
async function newPage(t: import('node:test').TestContext): Promise<Page | null> {
  if (!browser) {
    const pw = loadPlaywright();
    if (!pw) { t.skip('Playwright not available'); return null; }
    try { browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); } catch (e) { t.skip('Chromium launch failed: ' + (e as Error).message); return null; }
  }
  return browser.newPage();
}
test.after(async () => { if (browser) await browser.close(); });
/** Each test's options: a hung page fails the test instead of the run. */
const T = { timeout: 30000 };

/** The last payload the overlay sent on a channel. */
function lastSent<P>(page: Page, ch: string): Promise<P | undefined> {
  return page.evaluate((ch) => window.__sent.filter((m) => m.ch === ch).pop()?.payload, ch) as Promise<P | undefined>;
}

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
/** A dev server stand-in on 127.0.0.1: serves `files` by path, 404 otherwise, and records every path asked for. */
async function serveSite(t: import('node:test').TestContext, files: Record<string, { type: string; body: string | Buffer }>): Promise<{ url: string; asked: string[] }> {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url!);
    const file = files[req.url!];
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': file.type }); res.end(file.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

test('selection: an invisible element reads opacity 0 and a collapsed one scale 0, not 100 and 1', T, async (t) => {
  const page = await newPage(t); if (!page) return;
  await page.setContent('<!doctype html><html><body style="margin:40px"><div class="slide" style="opacity:0;scale:0;width:200px;height:80px">Slide two</div><div class="card" style="opacity:0.5;width:200px;height:80px">Card</div></body></html>');
  await page.evaluate(injectOverlay, OVERLAY());
  // A Layers row selects by selector (an inactive carousel slide can't be clicked).
  const read = async (selector: string) => {
    await page.evaluate((selector) => window.__handlers['radial:select-node']({}, { selector }), selector);
    const sel = await lastSent<SelectElementPayload>(page, 'radial:select-element');
    return { opacity: sel!.adjust.opacity, scale: sel!.adjust.scale };
  };
  assert.deepEqual(await read('.slide'), { opacity: 0, scale: 0 });
  assert.deepEqual(await read('.card'), { opacity: 50, scale: 1 }, 'others read as before (scale: none is 1)');
});

test('motion: Replay restarts an SVG element’s animation, as it does an HTML one’s', T, async (t) => {
  const page = await newPage(t); if (!page) return;
  await page.setContent('<!doctype html><html><head><style>@keyframes pulse { from { opacity: 1 } to { opacity: 0.2 } }</style></head><body>'
    + '<div id="badge" style="width:40px;height:40px;background:#c00;animation:pulse 4s linear infinite"></div>'
    + '<svg width="40" height="40"><circle id="dot" cx="20" cy="20" r="10" style="animation:pulse 4s linear infinite"/></svg></body></html>');
  await page.evaluate(injectOverlay, OVERLAY());
  const replay = (selector: string) => page.evaluate(async (selector) => {
    const el = document.querySelector(selector)!;
    await new Promise((r) => setTimeout(r, 300)); // well into the animation
    const before = el.getAnimations()[0], playedMs = before.currentTime as number;
    window.__handlers['radial:replay-animation']({}, { selector });
    const after = el.getAnimations()[0];
    return after !== before && (after.currentTime as number) < playedMs;
  }, selector);
  assert.equal(await replay('#badge'), true, 'an HTML element starts over');
  assert.equal(await replay('#dot'), true, 'an SVG element starts over too');
});

test('favicon: an icon link without an href falls back to /favicon.ico, not /null', T, async (t) => {
  const page = await newPage(t); if (!page) return;
  const site = await serveSite(t, {
    '/': { type: 'text/html', body: '<!doctype html><html><head><title>Site</title><link rel="icon"></head><body><h1>Site</h1></body></html>' },
    '/favicon.ico': { type: 'image/png', body: PNG },
  });
  // The overlay is the preview's preload: it runs before the page, so its DOMContentLoaded work runs too.
  await page.addInitScript(injectOverlay, OVERLAY());
  await page.goto(site.url + '/');
  await page.waitForTimeout(500);
  const favicon = await lastSent<string>(page, 'radial:favicon');
  assert.ok(!site.asked.includes('/null'), `nothing asks for /null (asked: ${site.asked.join(', ')})`);
  assert.equal(favicon, 'data:image/png;base64,' + PNG.toString('base64'), 'the host gets the site’s /favicon.ico');
});

test('image panel: the image readout carries its transfer size, so the panel can show its weight', T, async (t) => {
  const page = await newPage(t); if (!page) return;
  const site = await serveSite(t, {
    '/': { type: 'text/html', body: '<!doctype html><html><body><img id="hero" src="/hero.png" width="40" height="30" alt="Hero"></body></html>' },
    '/hero.png': { type: 'image/png', body: PNG },
  });
  await page.goto(site.url + '/');
  await page.evaluate(injectOverlay, OVERLAY());
  await page.evaluate(() => window.__handlers['radial:read-image']({}, { selector: '#hero' }));
  const result = await lastSent<{ selector: string; image: { bytes?: unknown } }>(page, 'radial:image-result');
  const bytes = result!.image.bytes;
  assert.equal(typeof bytes, 'number', `bytes is sent (got ${JSON.stringify(bytes)})`);
  assert.ok((bytes as number) >= PNG.length, 'at least the file’s own size');
});
