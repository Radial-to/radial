/**
 * radial serve's page (src/core/host.ts's Page), done in Playwright's Chrome
 * Headless Shell (plans/headless-core.md, phase 3): screenshots, the Content
 * panel's fields and reloads of a project's preview, and the migration's
 * screenshots and PNG codec.
 *
 * - The browser starts on the first page op, and stops once nothing has used
 *   it for idleMs (a few minutes). Each open project gets one page, in a
 *   browser context of its own, closed after the same idle time, or at the
 *   next sweep once the project sleeps or closes. A project's ops take turns.
 * - A project's page goes nowhere but loopback: a navigation of its main frame
 *   to another origin is cancelled and the page stays where it was, as the
 *   preview's guard in main.ts does. Popups never open (window.open answers
 *   null) and downloads are refused.
 * - The overlay (out/overlay/overlay.js, the preview's preload in the Mac app)
 *   runs as it is, behind a small stand-in for Electron's ipcRenderer, in an
 *   isolated world of its own: the page's scripts share its DOM but none of
 *   its JavaScript, so they can't reach it or fool it (a site that patches
 *   getBoundingClientRect doesn't change the fields it reads). Messages go in
 *   with Runtime.evaluate in that world, and come back through a binding that
 *   only that world has.
 * - A shot is main.ts's shot:fullPage CDP sequence at a chosen width (1440
 *   unless asked) and 2x, saved in <data dir>/shots.
 * - The migration's shooter is shots.ts's, through the same browser: a fresh
 *   context per call (and no loopback guard: it shoots the live site), the
 *   same settle script, a 900 px viewport and captureBeyondViewport. Its PNGs
 *   decode, and its diffs encode, with png.ts.
 * - At most two page ops run at once across projects (RADIAL_PAGE_OPS changes
 *   it); the rest wait their turn rather than being refused, so many clients
 *   on radial serve --listen can't run the machine out of memory.
 * - Chrome runs with its sandbox where it can: on macOS, and on Linux as a
 *   user other than root with user namespaces. Playwright turns it off unless
 *   asked. When a sandboxed launch fails for want of one (root, a container
 *   without user namespaces), the browser runs without it from then on, the
 *   log says so once, and browser.json in the data dir records which, for
 *   `radial doctor`.
 */
import fs from 'fs';
import path from 'path';
import type { Browser, BrowserContext, CDPSession, Page as PwPage } from 'playwright-core';
import type { Page } from '../core/host';
import type { PreviewNow } from '../core/sessions';
import type { CliFailure, CliResult, ContentField } from '../shared/radialApi';
import type { ContentFieldReadout, OverlayToHostPayloads } from '../shared/overlayMessages';
import type { ShotResult } from '../main/migrate';
import { SETTLE, VIEWPORT_HEIGHT } from '../main/migrate/settle';
import { normRoute } from '../renderer/navigation';
import { decodePng, encodePng } from './png';
import * as browser from './browser';

/** The isolated world the overlay runs in, and the names it has there (the page's own world has neither). */
export const WORLD = 'radial-overlay';
export const BINDING = '__radialHost';
export const DISPATCH = '__radialDispatch';
/** The page width when an op doesn't choose one: a desktop layout. */
export const DEFAULT_WIDTH = 1440;
/** How long a project's page, and then the browser, stay up unused. */
export const IDLE_MS = 5 * 60 * 1000;
/** Chrome's own switches: no new windows from a page (window.open answers null), no sound. */
export const LAUNCH_ARGS = ['--block-new-web-contents', '--mute-audio'];
/** How many page ops (shots, fields, reloads, the migration's shooter) run at once across projects. */
export const MAX_OPS = 2;

/**
 * Whether a navigation may land on a URL: http(s) on loopback only, the
 * preview's guard (main.ts): localhost, 127.0.0.1 and ::1, any port. Other
 * local dev servers are the same trust as the preview; anything else, or
 * another scheme, is not.
 */
export function isLoopbackUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false; // foo://localhost is not loopback
    const h = url.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch { return false; }
}

/**
 * The overlay as the page runs it: overlay.js unchanged, in a function of its
 * own (it declares its own ipcRenderer), behind a stand-in for Electron's that
 * sends through the world's binding and keeps the handlers it registers for
 * DISPATCH. The preview's preload runs in the main frame only, and so does this.
 */
export function overlayScript(overlay: string): string {
  return `(function () {
  'use strict';
  if (window !== window.top) return;
  const handlers = Object.create(null);
  const host = {
    sendToHost(channel, ...args) { try { globalThis.${BINDING}(JSON.stringify({ channel, args })); } catch {} },
    on(channel, listener) { (handlers[channel] || (handlers[channel] = [])).push(listener); return host; },
  };
  globalThis.${DISPATCH} = (channel, args) => { for (const fn of handlers[channel] || []) { try { fn({}, ...args); } catch {} } };
  const require = () => ({ ipcRenderer: host });
  (function () {
${overlay}
  })();
})();`;
}

/** What the page host needs from radial serve: its data dir, the core's previews, and where to log. */
export interface PageHostOptions {
  dataDir: string;
  /** A project's preview as the core runs it now (sessions.ts previewNow). */
  preview(repoDir: string): PreviewNow;
  log?: (line: string) => void;
  idleMs?: number;
  /** The browser's own events, for whoever watches (radial serve's /events): page:browser (it started or stopped) and page:blocked (a page kept on loopback). */
  notify?: (channel: string, payload: unknown) => void;
  /** How many page ops run at once (MAX_OPS, or RADIAL_PAGE_OPS). */
  maxOps?: number;
  /** Stand-ins for tests: Playwright, whether the browser is installed, the overlay's source, and the clock. */
  playwright?: () => Pick<typeof import('playwright-core'), 'chromium'> | null;
  installed?: () => boolean;
  overlay?: () => string;
  now?: () => number;
}

/** The page host: the core's Page, and what radial serve does with it besides. */
export interface PageHost extends Page {
  available(): boolean;
  /** A project's page goes now (its project slept or closed). */
  forget(repoDir: string): Promise<void>;
  /** The core told whoever watches what happened: a static site's files changed, a project slept. */
  onEvent(channel: string, payload: unknown): void;
  /** Closes idle pages, then an idle browser; it runs on a timer, and tests call it with their own clock. */
  sweep(): Promise<void>;
  /** Closes every page and the browser (radial serve stopping). */
  close(): Promise<void>;
  /** For tests: the open projects' pages, whether the browser runs (and with its sandbox), and the page ops running and waiting. */
  state(): { projects: string[]; browser: boolean; sandbox: boolean | null; running: number; waiting: number };
}

/** One project's page: its context, its CDP session, and the overlay world in its main frame. */
interface ProjectPage {
  repoDir: string;
  context: BrowserContext;
  page: PwPage;
  cdp: CDPSession;
  mainFrame: string;
  /** The overlay world's execution context in the main frame; null between documents. */
  world: number | null;
  /** The preview's origin the page was opened for: a restart on a new port gets a fresh page. */
  origin: string;
  /** The CSS width its layout is at. */
  width: number;
  /** Nothing loaded yet (about:blank). */
  fresh: boolean;
  /** The last address the loopback guard kept the page from: a load that fails on it says so. */
  blocked: string | null;
  lastUsed: number;
  /** Overlay replies awaited, by channel. */
  waiters: Map<string, ((payload: unknown) => void)[]>;
  closed: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(timer));
}
/** A failure as the core's page answers it. */
const fail = (code: CliFailure['code'], error: string, extra: Partial<CliFailure> = {}): CliFailure => ({ ok: false, code, error, ...extra });
/** A field as the CLI lists it: the Content panel's, without its thumbnail and focus flag (renderer.ts onCliRequest does the same). */
function listed(field: ContentFieldReadout): ContentField {
  const out: Partial<Record<string, unknown>> = { ...field };
  delete out.thumb; delete out.inFocus;
  return out as ContentField; // the readout less the two keys the window drops is a ContentField
}

/** Why the browser didn't start, in words, with what to run. */
function launchFailure(e: unknown): CliFailure {
  const message = String((e as Error)?.message || e);
  if (/missing dependencies|error while loading shared libraries/i.test(message)) return fail('no-browser', 'The browser is installed, but this machine is missing system libraries it needs.', { fix: 'radial doctor' });
  if (/Executable doesn't exist/i.test(message)) return fail('no-browser', 'The browser isn\'t installed.', { fix: 'radial browser install' });
  const line = message.split('\n').map((l) => l.replace(/^browserType\.launch:\s*/, '').trim()).find((l) => l && !/^[╔║╚═]/.test(l)) || 'unknown error';
  return fail('no-browser', `The browser didn't start: ${line}`, { fix: 'radial doctor' });
}

/** radial serve's page host. Nothing starts until the first page op. */
export function createPageHost(opts: PageHostOptions): PageHost {
  const log = opts.log || (() => {});
  const idleMs = opts.idleMs ?? IDLE_MS;
  const now = opts.now || Date.now;
  const playwright = opts.playwright || (() => { try { return require('playwright-core') as typeof import('playwright-core'); } catch { return null; } });
  let overlaySource: string | null = null;
  const overlay = opts.overlay || (() => (overlaySource ??= fs.readFileSync(path.join(__dirname, '..', 'overlay', 'overlay.js'), 'utf8')));
  let executable: string | null | undefined; // where Playwright puts the browser: looked up once, checked each time
  const installed = opts.installed || (() => {
    if (executable === undefined) executable = browser.browserInfo().executable;
    return !!executable && fs.existsSync(executable);
  });

  const notify = opts.notify || (() => {});
  let launching: Promise<Browser> | null = null;
  let lastUsed = now();
  let busy = 0; // page ops and shooters running or waiting: the browser stays while any does
  const projects = new Map<string, ProjectPage>();
  const turns = new Map<string, Promise<unknown>>(); // a project's ops, one at a time
  const reloads = new Map<string, Promise<CliResult<'reload'>>>(); // a reload queued and not started yet
  // Chrome's sandbox: tried first, until a launch shows this machine can't give it one.
  let sandbox: boolean | null = null;

  function touch(): void { lastUsed = now(); }

  // Page ops across projects take slots: at most maxOps run, the rest wait in order.
  const maxOps = opts.maxOps ?? (Number(process.env.RADIAL_PAGE_OPS) > 0 ? Math.floor(Number(process.env.RADIAL_PAGE_OPS)) : MAX_OPS);
  let running = 0;
  const waiting: (() => void)[] = [];
  async function slot(): Promise<() => void> {
    if (running < maxOps) running++;
    else await new Promise<void>((resolve) => waiting.push(resolve)); // the op that finishes hands its slot over
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) next(); else running--;
    };
  }

  /** Notes which way the browser runs, once: in the log, in browser.json for radial doctor, and for watchers. */
  function settleSandbox(on: boolean, reason: string | null): void {
    if (sandbox !== null) return;
    sandbox = on;
    if (!on) log(`[page] Chrome can't use its sandbox here (${reason}), so the browser runs without it. ${/root/.test(reason || '') ? 'Run radial serve as a user other than root to give it one.' : 'radial doctor says more.'}`);
    try { fs.writeFileSync(browser.sandboxFile(opts.dataDir), JSON.stringify({ sandbox: on, reason, pid: process.pid, at: Date.now() } satisfies browser.SandboxRecord, null, 2) + '\n'); } catch {}
  }

  function launch(): Promise<Browser> {
    if (launching) return launching;
    const pw = playwright();
    if (!pw) return Promise.reject(new Error(browser.noPlaywright()));
    const start = (sandboxed: boolean) => pw.chromium.launch({ headless: true, chromiumSandbox: sandboxed, args: LAUNCH_ARGS, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, timeout: 60000 });
    const p: Promise<Browser> = (async () => {
      if (sandbox !== false) {
        try { const b = await start(true); settleSandbox(true, null); return b; }
        catch (e) {
          const why = browser.sandboxFailure(String((e as Error)?.message || e));
          if (!why) throw e; // another failure (no libraries, no browser): the sandbox isn't the reason
          settleSandbox(false, why);
        }
      }
      return start(false);
    })().then((b) => {
      log(`[page] The browser started (${browser.SHELL_NAME} ${b.version()}${sandbox ? ', with its sandbox' : ', without its sandbox'}).`);
      notify('page:browser', { state: 'started', version: b.version(), sandbox: !!sandbox });
      b.on('disconnected', () => { if (launching === p) { launching = null; for (const pp of projects.values()) pp.closed = true; projects.clear(); } });
      return b;
    });
    launching = p;
    p.catch(() => { if (launching === p) launching = null; }); // the next op tries again
    return p;
  }

  /** One project's ops take turns; each answers a CliResult and never rejects. */
  function inTurn<T>(repoDir: string, op: () => Promise<T>): Promise<T> {
    const turn = (turns.get(repoDir) || Promise.resolve()).then(op);
    const settled = turn.then(() => {}, () => {});
    turns.set(repoDir, settled);
    settled.then(() => { if (turns.get(repoDir) === settled) turns.delete(repoDir); });
    return turn;
  }

  async function closeProject(repoDir: string, why: string): Promise<void> {
    const pp = projects.get(repoDir);
    if (!pp) return;
    projects.delete(repoDir);
    pp.closed = true;
    for (const list of pp.waiters.values()) for (const w of list) w(null);
    try { await pp.context.close(); } catch {}
    log(`[page] Closed ${path.basename(repoDir)}'s page (${why}).`);
  }

  /** The project's page for this preview: the open one, or a new one with the overlay, the guards and the default width. */
  async function pageFor(repoDir: string, url: string): Promise<ProjectPage> {
    const origin = new URL(url).origin;
    const open = projects.get(repoDir);
    if (open && !open.closed && open.origin === origin) return open;
    if (open) await closeProject(repoDir, 'its preview moved to a new address');
    const b = await launch();
    const context = await b.newContext({ viewport: null, acceptDownloads: false });
    try { return await setUp(repoDir, origin, context); }
    catch (e) { try { await context.close(); } catch {} throw e; }
  }
  async function setUp(repoDir: string, origin: string, context: BrowserContext): Promise<ProjectPage> {
    let page: PwPage | null = null;
    context.on('page', (p) => { if (page && p !== page) p.close().catch(() => {}); }); // a popup that got through closes at once
    page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const pp: ProjectPage = { repoDir, context, page, cdp, mainFrame: '', world: null, origin, width: 0, fresh: true, blocked: null, lastUsed: now(), waiters: new Map(), closed: false };
    const frame = await cdp.send('Page.getFrameTree');
    pp.mainFrame = frame.frameTree.frame.id;
    cdp.on('Runtime.executionContextCreated', ({ context: c }) => {
      if (c.name === WORLD && (c.auxData as { frameId?: string } | undefined)?.frameId === pp.mainFrame) pp.world = c.id;
    });
    cdp.on('Runtime.executionContextDestroyed', (e) => { if (e.executionContextId === pp.world) pp.world = null; });
    cdp.on('Runtime.executionContextsCleared', () => { pp.world = null; });
    cdp.on('Runtime.bindingCalled', (e) => {
      if (e.name !== BINDING || e.executionContextId !== pp.world) return; // only the overlay's world has the binding; anything else is ignored
      let message: { channel?: string; args?: unknown[] } | null = null;
      try { message = JSON.parse(e.payload) as { channel?: string; args?: unknown[] }; } catch { return; }
      const waiting = message && message.channel ? pp.waiters.get(message.channel) : null;
      if (!waiting || !waiting.length) return;
      pp.waiters.delete(message!.channel!);
      for (const w of waiting) w(message!.args ? message!.args[0] : undefined);
    });
    // The loopback guard: the main frame's documents only (iframes may embed other sites, as in the preview).
    cdp.on('Fetch.requestPaused', (e) => {
      const block = e.frameId === pp.mainFrame && !isLoopbackUrl(e.request.url);
      if (block) {
        pp.blocked = (() => { try { return new URL(e.request.url).origin; } catch { return e.request.url.slice(0, 80); } })();
        log(`[page] Kept ${path.basename(repoDir)}'s page from leaving for ${pp.blocked}.`);
        notify('page:blocked', { repoDir, to: pp.blocked });
      }
      (block ? cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'Aborted' }) : cdp.send('Fetch.continueRequest', { requestId: e.requestId })).catch(() => {});
    });
    page.on('crash', () => { void closeProject(repoDir, 'it crashed'); });
    page.on('close', () => { pp.closed = true; if (projects.get(repoDir) === pp) projects.delete(repoDir); });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: BINDING, executionContextName: WORLD });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: overlayScript(overlay()), worldName: WORLD });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    await emulate(pp, DEFAULT_WIDTH);
    projects.set(repoDir, pp);
    return pp;
  }

  /** Lays the page out at a CSS width, 900 px tall, at 1x: the window size the shooters use (shots.ts). */
  async function emulate(pp: ProjectPage, width: number, force = false): Promise<void> {
    if (pp.width === width && !force) return;
    await pp.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false });
    pp.width = width;
  }

  /** Where the page is, as a route of its preview (the window's normRoute). */
  function routeOf(pp: ProjectPage): string {
    try { const u = new URL(pp.page.url()); return u.origin === pp.origin ? normRoute(u.pathname) : '/'; } catch { return '/'; }
  }

  /** Loads a route when one is asked for and the page isn't there, or the page's first (or its preview's again, after an error page); otherwise it stays where it is. */
  async function goTo(pp: ProjectPage, route: string | null): Promise<void> {
    if (route && new URL(route, pp.origin).origin !== pp.origin) throw new Error(`${route} isn't a page of the preview: give its route, like /pricing.`);
    const onPreview = (() => { try { return new URL(pp.page.url()).origin === pp.origin; } catch { return false; } })();
    if (!pp.fresh && onPreview && (!route || normRoute(route) === routeOf(pp))) return;
    const target = new URL(route || (onPreview ? routeOf(pp) : '/'), pp.origin).href;
    pp.blocked = null;
    try { await pp.page.goto(target, { waitUntil: 'load', timeout: 45000 }); }
    catch (e) {
      if (pp.blocked) throw new Error(`${new URL(target).pathname} sent the page to ${pp.blocked}, and Radial's browser only goes to this machine's own addresses (loopback).`);
      throw e;
    }
    pp.fresh = false;
  }

  /** The overlay world, once the page's document has it. */
  async function world(pp: ProjectPage, timeoutMs = 10000): Promise<number> {
    const t0 = Date.now(); // the real clock: opts.now is the idle sweep's
    while (pp.world == null) {
      if (pp.closed) throw new Error('The page closed.');
      if (Date.now() - t0 > timeoutMs) throw new Error('The page did not load the overlay.');
      await sleep(25);
    }
    return pp.world;
  }

  /** Runs an expression in the overlay's world and answers its value (a promise is awaited). */
  async function evaluate(pp: ProjectPage, expression: string): Promise<unknown> {
    const r = await pp.cdp.send('Runtime.evaluate', { expression, contextId: await world(pp), awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  }

  /** Sends the overlay a host message and waits for its reply on another channel (renderer.ts's webview.send, then the ipc-message). */
  async function ask<C extends keyof OverlayToHostPayloads>(pp: ProjectPage, channel: string, args: unknown[], reply: C, timeoutMs: number): Promise<OverlayToHostPayloads[C] | null> {
    let resolve!: (payload: unknown) => void;
    const answer = new Promise<unknown>((r) => { resolve = r; });
    pp.waiters.set(reply, [...(pp.waiters.get(reply) || []), resolve]);
    try { await evaluate(pp, `globalThis.${DISPATCH}(${JSON.stringify(channel)}, ${JSON.stringify(args)})`); }
    catch (e) { pp.waiters.set(reply, (pp.waiters.get(reply) || []).filter((w) => w !== resolve)); throw e; }
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), timeoutMs); });
    try { return await Promise.race([answer, late]) as OverlayToHostPayloads[C] | null; } finally { clearTimeout(timer); }
  }

  /** A project op: its preview checked, its page ready, its turn taken; a failure becomes the CliResult the window would answer. */
  function projectOp<T extends { ok: boolean }>(repoDir: string, op: (pp: ProjectPage) => Promise<T>): Promise<T | CliFailure> {
    return inTurn(repoDir, async () => {
      busy++; touch();
      const release = await slot(); // in the project's turn: its own ops stay in order while others' run
      try {
        const where = opts.preview(repoDir);
        if (!where.ok) { await closeProject(repoDir, 'its project is not running'); return fail(where.code, where.error); }
        let pp: ProjectPage;
        try { pp = await pageFor(repoDir, where.url); } catch (e) { return launchFailure(e); }
        pp.lastUsed = now();
        try { return await op(pp); }
        catch (e) {
          const message = String((e as Error)?.message || e).split('\n')[0];
          if (pp.closed || /Target (page, context or browser )?(has been )?closed|Session closed/i.test(message)) { await closeProject(repoDir, 'it closed during an op'); return fail('error', 'The page closed while Radial was working on it. Try again.'); }
          return fail(/took longer|Timeout/i.test(message) ? 'timeout' : 'error', message.replace(/^page\.goto: /, `Couldn't load the preview: `));
        } finally { pp.lastUsed = now(); }
      } finally { release(); busy--; touch(); }
    });
  }

  async function shot(repoDir: string, route: string | null, width?: number | null): Promise<CliResult<'shot'>> {
    return projectOp(repoDir, async (pp) => {
      await emulate(pp, width || DEFAULT_WIDTH);
      await goTo(pp, route);
      await withTimeout(evaluate(pp, SETTLE(300)), 30000, 'Settling the page');
      // main.ts's shot:fullPage: keep the CSS viewport (media queries unchanged), bump the
      // scale to 2x, unless the page is too tall for that, and capture beyond the viewport.
      const metrics = await pp.cdp.send('Page.getLayoutMetrics');
      const layout = metrics.cssLayoutViewport || metrics.layoutViewport;
      const content = metrics.cssContentSize || metrics.contentSize;
      const scale: 1 | 2 = Math.ceil(content.height) * 2 <= 16000 ? 2 : 1;
      await pp.cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.ceil(layout.clientWidth), height: Math.ceil(layout.clientHeight), deviceScaleFactor: scale, mobile: false });
      let data: string;
      try { ({ data } = await pp.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })); }
      finally { await emulate(pp, pp.width, true); } // back to its own layout, as main.ts's clear does for the window's
      const here = routeOf(pp);
      const where = opts.preview(repoDir);
      const slug = here === '/' ? 'home' : here.replace(/^\//, '').replace(/\//g, '-');
      const dir = path.join(opts.dataDir, 'shots');
      fs.mkdirSync(dir, { recursive: true });
      const safe = `${where.ok ? where.name : path.basename(repoDir)}-${slug}-full@${scale}x-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`.replace(/[^a-zA-Z0-9._@-]/g, '-');
      let file = path.join(dir, safe + '.png');
      for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${safe}-${i}.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      return { ok: true as const, path: file, scale, route: here };
    });
  }

  async function fields(repoDir: string, route: string | null): Promise<CliResult<'fields'>> {
    return projectOp(repoDir, async (pp) => {
      await emulate(pp, DEFAULT_WIDTH);
      await goTo(pp, route);
      // Fonts and images settle first, as the window's own read waits for them (renderer.ts cliNavigateTo).
      await withTimeout(evaluate(pp, `(async () => { try { await document.fonts.ready; } catch {} await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); setTimeout(r, 5000); }))); await new Promise((r) => setTimeout(r, 300)); })()`), 30000, 'Settling the page');
      const res = await ask(pp, 'radial:read-fields', [{ focus: null }], 'radial:fields-result', 10000);
      if (!res) return fail('timeout', 'The page did not answer with its fields.');
      return { ok: true as const, route: routeOf(pp), fields: res.fields.map(listed) };
    });
  }

  function reload(repoDir: string): Promise<CliResult<'reload'>> {
    const queued = reloads.get(repoDir);
    if (queued) return queued; // one is waiting its turn already: it reloads for both
    const p = inTurn(repoDir, async (): Promise<CliResult<'reload'>> => {
      reloads.delete(repoDir);
      const pp = projects.get(repoDir);
      if (!pp || pp.closed || pp.fresh) return { ok: true }; // nothing loaded: the next op loads it fresh
      const where = opts.preview(repoDir);
      if (!where.ok) { await closeProject(repoDir, 'its project is not running'); return where.code === 'no-dev-server' ? { ok: false, reason: 'asleep' } : { ok: false, reason: 'not-open' }; }
      busy++;
      const release = await slot();
      try { await pp.page.reload({ waitUntil: 'load', timeout: 45000 }); pp.lastUsed = now(); return { ok: true }; }
      catch (e) { return fail('error', `The page didn't reload: ${String((e as Error).message || e).split('\n')[0]}`); }
      finally { release(); busy--; touch(); }
    });
    reloads.set(repoDir, p);
    return p;
  }

  async function shoot(url: string, widths: number[], { settleMs = 1200, loadTimeoutMs = 45000, maxHeight = 16000 }: { settleMs?: number; loadTimeoutMs?: number; maxHeight?: number } = {}): Promise<ShotResult[]> {
    busy++;
    touch();
    let context: BrowserContext | null = null;
    const release = await slot();
    try {
      let b: Browser;
      try { b = await launch(); } catch (e) { const why = launchFailure(e).error; return widths.map((width) => ({ width, error: why })); }
      context = await b.newContext({ viewport: null, acceptDownloads: false });
      let page: PwPage | null = null;
      context.on('page', (p) => { if (page && p !== page) p.close().catch(() => {}); });
      page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      const results: ShotResult[] = [];
      for (const width of widths) {
        try {
          // shots.ts: the window's size is the viewport the page lays out (and runs its scripts)
          // against; after loading and settling, the capture's own metrics and captureBeyondViewport.
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false });
          await withTimeout(page.goto(url, { waitUntil: 'load', timeout: loadTimeoutMs }), loadTimeoutMs + 1000, 'Loading ' + url);
          await withTimeout(page.evaluate(SETTLE(settleMs)), 30000, 'Settling ' + url);
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: width < 600 });
          const metrics = await cdp.send('Page.getLayoutMetrics');
          const fullHeight = Math.ceil((metrics.cssContentSize || metrics.contentSize).height);
          const height = Math.max(1, Math.min(fullHeight, maxHeight));
          const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
          await cdp.send('Emulation.clearDeviceMetricsOverride');
          results.push({ width, png: Buffer.from(shot.data, 'base64'), height, fullHeight, clipped: fullHeight > maxHeight });
        } catch (error) { results.push({ width, error: String((error as Error).message || error).split('\n')[0] }); }
      }
      return results;
    } finally {
      if (context) { try { await context.close(); } catch {} }
      release();
      busy--;
      touch();
    }
  }

  async function forget(repoDir: string): Promise<void> { await inTurn(repoDir, () => closeProject(repoDir, 'its project is not running')); }

  async function sweep(): Promise<void> {
    for (const [repoDir, pp] of [...projects]) {
      // In the project's turn, so an op never finds its page closing under it; checked again there, after any op before it.
      await inTurn(repoDir, async () => {
        if (projects.get(repoDir) !== pp) return;
        if (!opts.preview(repoDir).ok) await closeProject(repoDir, 'its project is not running');
        else if (now() - pp.lastUsed >= idleMs) await closeProject(repoDir, `unused for ${Math.round(idleMs / 60000) || 'under 1'} min`);
      });
    }
    if (launching && !projects.size && !busy && now() - lastUsed >= idleMs) {
      const p = launching;
      launching = null;
      try { await (await p).close(); log('[page] The browser stopped: nothing used it for a while. The next page op starts it again.'); notify('page:browser', { state: 'stopped' }); } catch {}
    }
  }
  let sweeping: Promise<void> | null = null; // a sweep waits for each project's turn: a slow op mustn't stack sweeps behind it
  const timer = setInterval(() => { if (!sweeping) sweeping = sweep().catch(() => {}).finally(() => { sweeping = null; }); }, Math.max(1000, Math.min(30000, Math.floor(idleMs / 2))));
  timer.unref();

  return {
    available: () => installed(),
    shot,
    fields,
    reload,
    shoot: (url, widths) => shoot(url, widths),
    decode: decodePng,
    encode: encodePng,
    forget,
    onEvent(channel, payload) {
      const repoDir = payload && typeof payload === 'object' ? (payload as { repoDir?: unknown }).repoDir : null;
      if (typeof repoDir !== 'string' || !projects.has(repoDir)) return;
      if (channel === 'dev:static-changed') void reload(repoDir); // the built-in static server has no HMR: refresh like the window does
      else if (channel === 'session:suspended') void forget(repoDir);
    },
    sweep,
    async close() {
      clearInterval(timer);
      for (const repoDir of [...projects.keys()]) await closeProject(repoDir, 'radial serve is stopping');
      const p = launching;
      launching = null;
      if (p) { try { await (await p).close(); } catch {} }
    },
    state: () => ({ projects: [...projects.keys()], browser: !!launching, sandbox, running, waiting: waiting.length }),
  };
}
