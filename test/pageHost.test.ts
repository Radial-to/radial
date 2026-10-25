// radial serve's page host (src/headless/page.ts) against a stand-in for
// Playwright: what it asks of the browser, and its guards. The browser starts
// on the first page op and stops when idle; one page per project; the overlay
// in an isolated world that the page's scripts can't reach; the loopback
// guard; popups and downloads refused; main.ts's shot sequence; shots.ts's
// shooter. test/headlessBrowser.e2e.mts runs the real browser.

import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

import { BINDING, DEFAULT_WIDTH, DISPATCH, LAUNCH_ARGS, WORLD, createPageHost, isLoopbackUrl, overlayScript } from '../src/headless/page';
import type { PageHostOptions } from '../src/headless/page';
import type { PreviewNow } from '../src/core/sessions';
import { encodePng } from '../src/headless/png';
import { tmpDir } from './support/tmp';

type Params = Record<string, unknown>;
/** The fields the stand-in overlay answers with, as the Content panel reads them. */
const FIELDS = [
  { kind: 'text', selector: 'h1', tag: 'h1', role: 'Heading', text: 'Welcome home', truncated: false, hasMarkup: false, group: 'Page', inFocus: false, path: [{ tag: 'h1' }] },
  { kind: 'image', selector: 'img', tag: 'img', role: 'Image', src: '/hero.png', thumb: 'data:image/png;base64,AAAA', alt: null, naturalW: 4, naturalH: 3, group: 'Page', inFocus: false, path: [{ tag: 'img' }] },
];

/** A CDP session as the page host drives it: it answers what it's asked and remembers each call. */
class FakeCdp extends EventEmitter {
  calls: [string, Params | undefined][] = [];
  world = 0;
  content = 1234;
  readonly browser: FakeBrowser;
  constructor(browser: FakeBrowser) { super(); this.browser = browser; }
  async send(method: string, params?: Params): Promise<unknown> {
    this.calls.push([method, params]);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
    if (method === 'Page.getLayoutMetrics') {
      const width = (this.calls.filter(([m]) => m === 'Emulation.setDeviceMetricsOverride').pop()?.[1]?.width as number) || 800;
      return { cssLayoutViewport: { clientWidth: width, clientHeight: 900 }, layoutViewport: { clientWidth: width, clientHeight: 900 }, cssContentSize: { height: this.content }, contentSize: { height: this.content } };
    }
    if (method === 'Page.captureScreenshot') return { data: encodePng({ width: 2, height: 2, data: Buffer.alloc(16, 255) }).toString('base64') };
    if (method === 'Runtime.evaluate') {
      const expression = String(params!.expression);
      if (expression.startsWith(`globalThis.${DISPATCH}("radial:read-fields"`)) {
        // A site's script calling a binding it doesn't have can't, but if a call came from another context it must not count.
        this.emit('Runtime.bindingCalled', { name: BINDING, payload: JSON.stringify({ channel: 'radial:fields-result', args: [{ focus: null, fields: [{ kind: 'text', text: 'spoofed' }] }] }), executionContextId: 1 });
        this.emit('Runtime.bindingCalled', { name: BINDING, payload: JSON.stringify({ channel: 'radial:fields-result', args: [{ focus: null, fields: this.browser.fields }] }), executionContextId: this.world });
      }
      return { result: { type: 'undefined', value: undefined } };
    }
    return {};
  }
  /** A new document in the main frame: the old worlds go, the overlay's comes with the new one. */
  load(): void {
    this.emit('Runtime.executionContextsCleared', {});
    this.world = ++this.browser.contexts;
    this.emit('Runtime.executionContextCreated', { context: { id: this.world, name: WORLD, origin: '', uniqueId: String(this.world), auxData: { frameId: 'main-frame', isDefault: false } } });
  }
}
class FakePage extends EventEmitter {
  address = 'about:blank';
  closed = false;
  readonly cdp: FakeCdp;
  readonly browser: FakeBrowser;
  constructor(browser: FakeBrowser) { super(); this.browser = browser; this.cdp = new FakeCdp(browser); }
  url(): string { return this.address; }
  async goto(url: string): Promise<null> {
    this.browser.loads.push(url);
    if (this.browser.gate) await this.browser.gate; // a slow page: the test lets it load
    if (this.browser.blockLoads) throw new Error('page.goto: net::ERR_CONNECTION_REFUSED at ' + url);
    this.address = url; this.cdp.load(); return null;
  }
  async reload(): Promise<null> { this.browser.reloads++; this.cdp.load(); return null; }
  async close(): Promise<void> { this.closed = true; this.emit('close'); }
  async evaluate(): Promise<number> { return 1000; }
}
class FakeContext extends EventEmitter {
  pages: FakePage[] = [];
  closed = false;
  readonly browser: FakeBrowser;
  readonly options: Params;
  constructor(browser: FakeBrowser, options: Params) { super(); this.browser = browser; this.options = options; }
  async newPage(): Promise<FakePage> { const p = new FakePage(this.browser); this.pages.push(p); this.emit('page', p); return p; }
  async newCDPSession(page: FakePage): Promise<FakeCdp> { return page.cdp; }
  async close(): Promise<void> { this.closed = true; for (const p of this.pages) if (!p.closed) await p.close(); }
}
class FakeBrowser extends EventEmitter {
  launches: Params[] = [];
  contextsMade: FakeContext[] = [];
  loads: string[] = [];
  reloads = 0;
  contexts = 10; // execution context ids
  closed = false;
  blockLoads = false;
  launchError: string | null = null;
  /** What a launch with Chrome's sandbox throws, as on a machine that can't give it one. */
  sandboxError: string | null = null;
  /** While set, pages wait for it before they load. */
  gate: Promise<void> | null = null;
  fields: unknown[] = FIELDS;
  version(): string { return '151.0.7922.34'; }
  async newContext(options: Params): Promise<FakeContext> { const c = new FakeContext(this, options); this.contextsMade.push(c); return c; }
  async close(): Promise<void> { this.closed = true; this.emit('disconnected'); }
}

/** A page host on a stand-in browser, a clock the test moves, and previews the test sets. */
function setup(extra: Partial<PageHostOptions> = {}) {
  const b = new FakeBrowser();
  let clock = 1_000_000;
  const previews = new Map<string, PreviewNow>([['/site', { ok: true, url: 'http://127.0.0.1:4321/', name: 'fixture' }], ['/other', { ok: true, url: 'http://localhost:5555/', name: 'other' }], ['/third', { ok: true, url: 'http://127.0.0.1:6666/', name: 'third' }]]);
  const lines: string[] = [];
  const told: [string, unknown][] = [];
  const dataDir = tmpDir('radial-page-');
  const host = createPageHost({
    dataDir,
    preview: (dir) => previews.get(dir) || { ok: false, code: 'not-open', error: `${dir} is not open.` },
    log: (l) => lines.push(l),
    notify: (channel, payload) => told.push([channel, payload]),
    idleMs: 60_000,
    now: () => clock,
    installed: () => true,
    overlay: () => '/* overlay.js */',
    playwright: () => ({ chromium: { launch: async (options: Params) => {
      b.launches.push(options);
      if (b.launchError) throw new Error(b.launchError);
      if (options.chromiumSandbox && b.sandboxError) throw new Error(b.sandboxError);
      b.closed = false; return b;
    } } }) as unknown as ReturnType<NonNullable<PageHostOptions['playwright']>>,
    ...extra,
  });
  return { b, host, previews, lines, told, dataDir, tick: (ms: number) => { clock += ms; }, cdpOf: (i = 0) => (b.contextsMade[i].pages[0]).cdp };
}

test('loopback is localhost, 127.0.0.1 and ::1 over http(s), any port; nothing else', () => {
  for (const u of ['http://localhost:4321/', 'https://localhost/x', 'http://127.0.0.1:1/', 'http://[::1]:3000/a?b']) assert.equal(isLoopbackUrl(u), true, u);
  for (const u of ['https://example.com/', 'http://localhost.example.com/', 'http://127.0.0.2/', 'http://0.0.0.0:3000/', 'ftp://localhost/', 'file:///etc/hosts', 'javascript:alert(1)', 'data:text/html,hi', 'not a url']) assert.equal(isLoopbackUrl(u), false, u);
});

test('the overlay script: overlay.js as it is, in the top frame only, with an ipcRenderer that sends through the world’s binding', () => {
  const overlay = "'use strict';\nconst { ipcRenderer } = require('electron');\nipcRenderer.on('ping', (_e, n) => ipcRenderer.sendToHost('pong', { n: n * 2 }));";
  const script = overlayScript(overlay);
  assert.ok(script.includes(overlay), 'unchanged');
  const sent: string[] = [];
  const top: Record<string, unknown> = { [BINDING]: (payload: string) => sent.push(payload) };
  top.window = top; top.top = top;
  vm.runInNewContext(script, top);
  assert.equal(typeof top[DISPATCH], 'function');
  (top[DISPATCH] as (channel: string, args: unknown[]) => void)('ping', [21]);
  assert.deepEqual(sent.map((s) => JSON.parse(s)), [{ channel: 'pong', args: [{ n: 42 }] }]);
  const frame: Record<string, unknown> = { [BINDING]: () => assert.fail('an iframe runs no overlay') };
  frame.window = frame; frame.top = top;
  vm.runInNewContext(script, frame);
  assert.equal(frame[DISPATCH], undefined, 'nothing in a subframe');
});

test('the browser starts on the first page op, with popups blocked; each project gets a context of its own, downloads refused, and keeps it', async () => {
  const { b, host } = setup();
  assert.deepEqual(b.launches, [], 'nothing starts with serve');
  assert.equal(host.available(), true);
  const first = await host.fields('/site', '/');
  assert.ok(first.ok, JSON.stringify(first));
  assert.deepEqual(b.launches, [{ headless: true, chromiumSandbox: true, args: LAUNCH_ARGS, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, timeout: 60000 }], 'with Chrome’s sandbox, which Playwright leaves off unless asked');
  assert.ok(LAUNCH_ARGS.includes('--block-new-web-contents'), 'window.open answers null');
  assert.deepEqual(b.contextsMade.map((c) => c.options), [{ viewport: null, acceptDownloads: false }]);
  await host.fields('/site', null);
  await host.shot('/site', null, null);
  assert.equal(b.contextsMade.length, 1, 'the same page for the same project');
  await host.fields('/other', '/');
  assert.equal(b.contextsMade.length, 2, 'another project, another context');
  assert.equal(b.launches.length, 1, 'one browser');
  assert.deepEqual(host.state(), { projects: ['/site', '/other'], browser: true, sandbox: true, running: 0, waiting: 0 });
  // A popup that got past Chrome's block closes at once.
  const popup = new FakePage(b);
  b.contextsMade[0].emit('page', popup);
  assert.equal(popup.closed, true);
  assert.equal(b.contextsMade[0].pages[0].closed, false, 'the project’s own page stays');
});

test('the overlay runs in an isolated world with a binding only that world has; a call from any other context is ignored', async () => {
  const { host, cdpOf } = setup();
  const r = await host.fields('/site', '/');
  const cdp = cdpOf();
  const call = (m: string) => cdp.calls.find(([name]) => name === m)?.[1];
  assert.deepEqual(call('Runtime.addBinding'), { name: BINDING, executionContextName: WORLD });
  const script = call('Page.addScriptToEvaluateOnNewDocument')!;
  assert.equal(script.worldName, WORLD);
  assert.ok(String(script.source).includes('/* overlay.js */') && String(script.source).includes('if (window !== window.top) return;'));
  const dispatch = cdp.calls.filter(([m, p]) => m === 'Runtime.evaluate' && String(p!.expression).startsWith(`globalThis.${DISPATCH}`));
  assert.deepEqual(dispatch.map(([, p]) => [p!.expression, p!.contextId]), [[`globalThis.${DISPATCH}("radial:read-fields", [{"focus":null}])`, cdp.world]], 'messages go into the overlay’s world');
  assert.ok(r.ok);
  assert.deepEqual(r.ok ? r.fields.map((f) => f.kind === 'text' ? f.text : f.kind) : null, ['Welcome home', 'image'], 'the spoofed reply from another context didn’t count');
  assert.ok(r.ok && r.fields.every((f) => !('thumb' in f) && !('inFocus' in f)), 'thumbnails and focus flags stay out, as the window leaves them');
  assert.equal(r.ok && r.route, '/');
});

test('the loopback guard: a main-frame document anywhere else is cancelled; other loopback ports and iframes load', async () => {
  const { host, cdpOf, lines } = setup();
  await host.fields('/site', '/');
  const cdp = cdpOf();
  assert.deepEqual(cdp.calls.find(([m]) => m === 'Fetch.enable')![1], { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
  const paused = (requestId: string, url: string, frameId: string) => cdp.emit('Fetch.requestPaused', { requestId, frameId, resourceType: 'Document', request: { url } });
  paused('r1', 'https://example.com/login', 'main-frame');
  paused('r2', 'http://localhost:9999/other-dev-server', 'main-frame');
  paused('r3', 'https://www.youtube.com/embed/x', 'an-iframe');
  paused('r4', 'javascript:void(0)', 'main-frame');
  await new Promise((r) => setImmediate(r));
  const answers = cdp.calls.filter(([m]) => m.startsWith('Fetch.') && m !== 'Fetch.enable').map(([m, p]) => [m, p!.requestId, p!.errorReason]);
  assert.deepEqual(answers, [['Fetch.failRequest', 'r1', 'Aborted'], ['Fetch.continueRequest', 'r2', undefined], ['Fetch.continueRequest', 'r3', undefined], ['Fetch.failRequest', 'r4', 'Aborted']]);
  assert.ok(lines.includes('[page] Kept site\'s page from leaving for https://example.com.'), lines.join('\n'));
});

test('a shot is main.ts’s sequence at the chosen width and 2x, saved in the data dir; a page too tall for 2x is shot at 1x', async () => {
  const { host, cdpOf, dataDir } = setup();
  const r = await host.shot('/site', '/pricing', 390);
  assert.ok(r.ok, JSON.stringify(r));
  const cdp = cdpOf();
  const seq = cdp.calls.filter(([m]) => /^(Emulation|Page\.getLayoutMetrics|Page\.captureScreenshot)/.test(m)).map(([m, p]) => [m, p]);
  assert.deepEqual(seq, [
    ['Emulation.setDeviceMetricsOverride', { width: DEFAULT_WIDTH, height: 900, deviceScaleFactor: 1, mobile: false }], // a new page's default
    ['Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false }], // the chosen width
    ['Page.getLayoutMetrics', undefined],
    ['Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 2, mobile: false }],
    ['Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }],
    ['Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false }], // back to its own
  ]);
  assert.equal(r.ok && r.scale, 2); assert.equal(r.ok && r.route, '/pricing');
  assert.equal(r.ok && path.dirname(r.path), path.join(dataDir, 'shots'));
  assert.match(r.ok ? path.basename(r.path) : '', /^fixture-pricing-full@2x-\d{4}-\d{2}-\d{8}\.png$/);
  assert.ok(r.ok && fs.existsSync(r.path));
  cdp.content = 9000;
  const tall = await host.shot('/site', null, null);
  assert.equal(tall.ok && tall.scale, 1, '9000 css px at 2x would pass the 16000 px texture limit');
  assert.notEqual(tall.ok && tall.path, r.ok && r.path);
});

test('a page loads its route once; a route off the preview is refused; a dev server restarted on a new port gets a fresh page; a page that can’t load says why', async () => {
  const { b, host, previews } = setup();
  await host.fields('/site', '/about');
  await host.fields('/site', '/about');
  await host.fields('/site', null);
  assert.deepEqual(b.loads, ['http://127.0.0.1:4321/about'], 'already there: no reload');
  previews.set('/site', { ok: true, url: 'http://127.0.0.1:4400/', name: 'fixture' });
  await host.fields('/site', null);
  assert.equal(b.contextsMade.length, 2); assert.equal(b.contextsMade[0].closed, true, 'the old page went');
  assert.deepEqual(b.loads.slice(1), ['http://127.0.0.1:4400/']);
  assert.deepEqual(await host.shot('/site', 'https://example.com/pricing', null), { ok: false, code: 'error', error: 'https://example.com/pricing isn\'t a page of the preview: give its route, like /pricing.' });
  assert.equal(b.loads.length, 2, 'nothing loaded for it');
  b.blockLoads = true;
  previews.set('/site', { ok: true, url: 'http://127.0.0.1:4500/', name: 'fixture' });
  const r = await host.fields('/site', '/');
  assert.deepEqual(r, { ok: false, code: 'error', error: 'Couldn\'t load the preview: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4500/' });
});

test('a project that isn’t open or sleeps answers the core’s reason, and loses its page', async () => {
  const { b, host, previews } = setup();
  await host.fields('/site', '/');
  previews.set('/site', { ok: false, code: 'no-dev-server', error: '/site is asleep; wake it first (radial wake).' });
  assert.deepEqual(await host.shot('/site', null, null), { ok: false, code: 'no-dev-server', error: '/site is asleep; wake it first (radial wake).' });
  assert.equal(b.contextsMade[0].closed, true);
  assert.deepEqual(await host.fields('/gone', null), { ok: false, code: 'not-open', error: '/gone is not open.' });
});

test('reloads: one waiting reload serves several; nothing open, nothing to reload; a static site’s change reloads its page; a sleeping project’s page goes', async () => {
  const { b, host } = setup();
  assert.deepEqual(await host.reload('/site'), { ok: true }, 'no page yet: the next op loads it fresh');
  assert.equal(b.launches.length, 0, 'and no browser started for it');
  await host.fields('/site', '/');
  const [a, c] = await Promise.all([host.reload('/site'), host.reload('/site')]);
  assert.deepEqual([a, c], [{ ok: true }, { ok: true }]);
  assert.equal(b.reloads, 1, 'one reload for both');
  host.onEvent('dev:static-changed', { repoDir: '/site' });
  await host.fields('/site', null); // takes its turn after the reload
  assert.equal(b.reloads, 2);
  host.onEvent('dev:static-changed', { repoDir: '/elsewhere' });
  host.onEvent('session:suspended', { repoDir: '/site' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(host.state().projects, []);
});

test('idle: a page unused for idleMs closes at the sweep, and then the browser; a project that closed loses its page at once', async () => {
  const { b, host, previews, tick, lines } = setup();
  await host.fields('/site', '/');
  await host.fields('/other', '/');
  tick(30_000);
  await host.fields('/other', null);
  previews.delete('/other');
  await host.sweep();
  assert.deepEqual(host.state().projects, ['/site'], 'the closed project’s page went; the other isn’t idle yet');
  assert.equal(host.state().browser, true);
  tick(30_001);
  await host.sweep();
  assert.deepEqual([host.state().projects, host.state().browser], [[], true], '/site’s page went; the browser was used 30 s ago, for /other');
  tick(30_000);
  await host.sweep();
  assert.deepEqual([host.state().projects, host.state().browser], [[], false]);
  assert.equal(b.closed, true, 'the browser stopped');
  assert.ok(lines.some((l) => /The browser stopped: nothing used it for a while/.test(l)), lines.join('\n'));
  await host.fields('/site', '/');
  assert.equal(b.launches.length, 2, 'the next op starts it again');
});

test('a browser that won’t start answers no-browser with what to run, and the next op tries again', async () => {
  const { b, host } = setup();
  b.launchError = 'browserType.launch: \n╔══╗\n║ Host system is missing dependencies to run browsers. ║';
  assert.deepEqual(await host.fields('/site', '/'), { ok: false, code: 'no-browser', error: 'The browser is installed, but this machine is missing system libraries it needs.', fix: 'radial doctor' });
  b.launchError = 'browserType.launch: Executable doesn\'t exist at /root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-linux/headless_shell';
  assert.deepEqual(await host.shot('/site', null, null), { ok: false, code: 'no-browser', error: 'The browser isn\'t installed.', fix: 'radial browser install' });
  b.launchError = null;
  assert.equal((await host.fields('/site', '/')).ok, true);
  assert.equal(b.launches.length, 3);
});

test('Chrome’s sandbox where it can run; where a sandboxed launch fails for want of one, without it from then on, said once, and noted for doctor', async () => {
  const { b, host, lines, told, dataDir, tick } = setup();
  b.sandboxError = 'browserType.launch: Target page, context or browser has been closed\n[pid=12][err] [12:12:FATAL:zygote_host_impl_linux.cc(132)] Running as root without --no-sandbox is not supported. See https://crbug.com/638180.';
  assert.equal((await host.fields('/site', '/')).ok, true);
  assert.deepEqual(b.launches.map((l) => l.chromiumSandbox), [true, false], 'tried with it, then without');
  assert.equal(host.state().sandbox, false);
  assert.equal(lines.filter((l) => /can't use its sandbox here \(it runs as root/.test(l)).length, 1, lines.join('\n'));
  assert.match(lines.join('\n'), /Run radial serve as a user other than root/);
  const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'browser.json'), 'utf8')) as { sandbox: boolean; reason: string; pid: number };
  assert.deepEqual([record.sandbox, record.pid], [false, process.pid]); assert.match(record.reason, /root/);
  assert.deepEqual(told.filter(([c]) => c === 'page:browser').map(([, p]) => p), [{ state: 'started', version: '151.0.7922.34', sandbox: false }], 'watchers hear it started, without its sandbox');
  // Idle, the browser stops; the next start goes straight to no sandbox, and says nothing again.
  tick(61_000); await host.sweep(); tick(61_000); await host.sweep();
  assert.equal(host.state().browser, false);
  assert.deepEqual(told.at(-1), ['page:browser', { state: 'stopped' }]);
  await host.fields('/site', '/');
  assert.deepEqual(b.launches.map((l) => l.chromiumSandbox), [true, false, false]);
  assert.equal(lines.filter((l) => /can't use its sandbox here/.test(l)).length, 1);
});

test('a launch that fails for another reason doesn’t lose the sandbox: the next start tries with it again', async () => {
  const { b, host } = setup();
  b.launchError = 'browserType.launch: Executable doesn\'t exist at /x';
  assert.equal((await host.fields('/site', '/')).ok, false);
  b.launchError = null;
  assert.equal((await host.fields('/site', '/')).ok, true);
  assert.deepEqual(b.launches.map((l) => l.chromiumSandbox), [true, true]);
  assert.equal(host.state().sandbox, true);
});

test('page ops across projects run two at a time; the rest wait their turn instead of being refused', async () => {
  const { b, host } = setup();
  let open!: () => void;
  b.gate = new Promise<void>((resolve) => { open = resolve; });
  const ops = [host.fields('/site', '/'), host.shot('/other', null, null), host.fields('/third', '/')];
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([host.state().running, host.state().waiting], [2, 1], 'two run, one waits');
  open(); b.gate = null;
  const results = await Promise.all(ops);
  assert.deepEqual(results.map((r) => r.ok), [true, true, true], 'all three answered');
  assert.deepEqual([host.state().running, host.state().waiting], [0, 0]);
  const one = setup({ maxOps: 1 });
  let let1!: () => void;
  one.b.gate = new Promise<void>((resolve) => { let1 = resolve; });
  const two = [one.host.fields('/site', '/'), one.host.fields('/other', '/')];
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([one.host.state().running, one.host.state().waiting], [1, 1], 'maxOps sets the number');
  let1(); one.b.gate = null;
  assert.deepEqual((await Promise.all(two)).map((r) => r.ok), [true, true]);
});

test('the migration shooter: a fresh context per call, no loopback guard, shots.ts’s metrics at each width, then it closes', async () => {
  const { b, host } = setup();
  const results = await host.shoot('https://www.example.com/', [390, 1440]);
  assert.deepEqual(results.map((r) => ('png' in r ? [r.width, r.height, r.fullHeight, r.clipped] : r.error)), [[390, 1234, 1234, false], [1440, 1234, 1234, false]]);
  const [context] = b.contextsMade;
  assert.deepEqual(context.options, { viewport: null, acceptDownloads: false });
  assert.equal(context.closed, true, 'closed after the call');
  const cdp = context.pages[0].cdp;
  assert.equal(cdp.calls.some(([m]) => m.startsWith('Fetch.')), false, 'the live site is anywhere: no guard');
  const emulation = cdp.calls.filter(([m]) => m.startsWith('Emulation.') || m === 'Page.captureScreenshot').map(([m, p]) => [m, p]);
  assert.deepEqual(emulation.slice(0, 4), [
    ['Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false }],
    ['Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true }],
    ['Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 390, height: 1234, scale: 1 } }],
    ['Emulation.clearDeviceMetricsOverride', undefined],
  ]);
  assert.deepEqual(b.loads, ['https://www.example.com/', 'https://www.example.com/']);
  b.launchError = 'browserType.launch: Executable doesn\'t exist at /x';
  await host.close();
  assert.deepEqual((await host.shoot('https://www.example.com/', [768])), [{ width: 768, error: 'The browser isn\'t installed.' }]);
});
