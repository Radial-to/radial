// Golden-path smoke test against the PACKAGED app (dist/mac-arm64/Radial.app).
// This is the release gate's proof that the build a user double-clicks actually
// works — asar packing, native modules, signing, and the installed-flavor code
// paths that `electron .` and the unit suite never exercise.
//
// Drives the real binary with playwright-core's _electron (repo-root install),
// fully isolated via RADIAL_USERDATA (which also disables the updater and
// telemetry sending). Renderer functions are classic-script globals, so the
// checks call them directly through page.evaluate.
//
// Usage: npm run test:smoke            (or node scripts/smoke.mts)
//   RADIAL_APP_PATH=<binary> overrides the app under test.
//
// Unlike the unit/e2e suites this NEVER skips: a missing binary or Playwright
// is a hard failure, because a gate that can silently skip is not a gate.
// The checks in win.evaluate run in the window, so they need the DOM's types.
// These references apply to the whole scripts program, not only this file;
// their natural home is the lib list in scripts/tsconfig.json.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ElectronApplication } from 'playwright-core';

// What the checks reach in Radial's window, inside win.evaluate: the preload's
// API and the window scripts' globals, as far as this smoke uses them. The app's
// own declarations are src/renderer/globals.d.ts, types.d.ts and renderer.ts;
// the scripts project can't import app modules (src/ is CommonJS, and these
// scripts check under verbatimModuleSyntax), so the shapes are restated here.
interface SmokeWindow extends Window {
  radial: { nativeChatEnabled(): Promise<boolean>; perfBoot(): Promise<Record<string, number>> };
  RadialNativeChat?: { enabled(): boolean };
}
/** The preview: Electron's <webview>, with the call the checks make. */
interface SmokeWebview extends HTMLElement { executeJavaScript(code: string): Promise<unknown> }
/** An open project (renderer createTab), with the fields the checks read. */
interface SmokeTab {
  id: string;
  /** The dev server; null while the project sleeps. */
  baseUrl: string | null;
  suspended: boolean;
  currentRoute: string;
  /** Visual zoom. */
  vz?: number;
  webview: SmokeWebview;
}
/** A panel's placement in the panels' saved state (renderer tpState). */
interface ToolPanelPlacement { open: boolean; pinned?: boolean | 'left' | 'right' | 'home' }
/** Where a rail menu opens: a click, or a stand-in with its coordinates. */
interface RailMenuPoint { clientX: number; clientY: number; preventDefault?(): void; stopPropagation?(): void }
declare const window: SmokeWindow;
declare function activeTab(): SmokeTab | null;
declare function zoomPreview(mult: number): void;
declare function setDevicePreset(name: 'desktop' | 'responsive' | 'locked' | 'tablet' | 'mobile' | 'custom', tab?: SmokeTab | null): void;
declare function tpState(): { adjust: ToolPanelPlacement };
declare function tpSave(): void;
declare function renderPanelDock(): void;
declare function renderQuickAdjust(): void;
declare function openProjectMenu(e: RailMenuPoint, projectId: string): void;

/** A run of the bundled `radial` CLI: its exit status (or the spawn error's code) and its output. */
interface CliRun { code: number | string; stdout: string; stderr: string }
// The `--json` answers the checks read (src/main/cliServer.ts OpReplies).
/** ls: the open projects. */
interface LsReply { ok: true; projects: { repoDir: string }[] }
/** context: what the app knows about the site; pages is null while it isn't open. */
interface ContextReply { ok: true; pages: unknown[] | null }
/** open: the project is up, focused, or queued. */
interface OpenedReply { ok: true; state: 'opened' | 'focused' | 'queued' }
/** edit text: the edit landed. */
interface EditReply { ok: true }
/** agent list: the agents running. */
interface AgentListReply { ok: true; agents: unknown[] }

const require = createRequire(import.meta.url);
const platformDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The packaged app is named after the product (Radial, or Radial Dev when built from the public repo).
const PRODUCT = (() => {
  try { const p: { productName?: string; build?: { productName?: string } } = JSON.parse(fs.readFileSync(path.join(platformDir, 'package.json'), 'utf8')); return p.build?.productName || p.productName || 'Radial'; } catch { return 'Radial'; }
})();
const APP_BIN = process.env.RADIAL_APP_PATH
  || path.join(platformDir, 'dist', 'mac-arm64', `${PRODUCT}.app`, 'Contents', 'MacOS', PRODUCT);

function fail(msg: string): never { console.error(`\n✗ SMOKE FAILED: ${msg}`); process.exit(1); }
function ok(msg: string): void { console.log(`  ✓ ${msg}`); }

// Poll an async predicate until it returns a truthy value or time runs out.
async function until<T>(label: string, ms: number, fn: () => T | Promise<T>): Promise<NonNullable<Awaited<T>>> {
  const t0 = Date.now();
  let last: Awaited<T> | string | undefined;
  while (Date.now() - t0 < ms) {
    try { last = await fn(); if (last) return last; } catch (e) { last = (e as Error).message; }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`timed out after ${ms}ms waiting for: ${label} (last: ${JSON.stringify(last)})`);
}

if (!fs.existsSync(APP_BIN)) fail(`app binary not found: ${APP_BIN} — run \`npm run dist:signed\` first`);
let _electron: typeof import('playwright-core')._electron;
try { ({ _electron } = require('playwright-core') as typeof import('playwright-core')); }
catch { fail('playwright-core not installed'); }

// Fixture: a bare static site. devServer's static fallback serves any repo
// with an index.html in root, so the golden path needs no npm install.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-smoke-site-'));
fs.writeFileSync(path.join(fixture, 'index.html'),
  '<!doctype html><html><head><title>Smoke</title></head><body>'
  + '<h1>smoke-home</h1><a id="go" href="/about.html">about</a></body></html>');
fs.writeFileSync(path.join(fixture, 'about.html'),
  '<!doctype html><html><head><title>About</title></head><body><h1>smoke-about</h1></body></html>');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-smoke-data-'));
// What the app and its CLI get: the caller's environment without RADIAL_
// variables. A Radial terminal exports RADIAL_CLI_SOCK, its own app's control
// socket, which the CLI prefers over RADIAL_USERDATA: inherited, the CLI checks
// below would drive the Radial that terminal belongs to, not the app under test.
const baseEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('RADIAL_')));

let app: ElectronApplication | null = null;
const pageErrors: string[] = [];
try {
  console.log(`Smoke-testing ${APP_BIN}`);

  // 1. The packaged app boots and shows its window.
  app = await _electron.launch({
    executablePath: APP_BIN,
    env: { ...baseEnv, RADIAL_USERDATA: scratch, RADIAL_OPEN: fixture, RADIAL_DAEMON_EPHEMERAL: '1' }, // the smoke's daemon dies with it
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 20_000 });
  win.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
  const version = await app.evaluate(({ app: a }) => a.getVersion());
  ok(`app booted (v${version}), window up`);
  await until('packaged chat enabled by default', 15000, () => win.evaluate(async () =>
    await window.radial.nativeChatEnabled() && window.RadialNativeChat?.enabled()));
  if (await win.title() !== 'Radial') fail('packaged app uses an experimental window title');
  ok('chat UI enabled in the installed app, production window title');

  // 2. The auto-opened project becomes the active tab.
  await until('project tab created', 20_000,
    () => win.evaluate(() => !!(typeof activeTab === 'function' && activeTab())));
  ok('project opened as tab');

  // 3. The dev server (static fallback) comes up and the tab points at it.
  const baseUrl = await until('dev server URL on tab', 30_000,
    () => win.evaluate(() => (activeTab() && /^https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(activeTab()!.baseUrl || '')) ? activeTab()!.baseUrl : null));
  ok(`dev server up at ${baseUrl}`);

  // 3b. The bundled `radial` CLI reaches THIS app over its control socket
  //     (RADIAL_USERDATA points the client at the scratch profile's socket).
  const cli = path.join(path.dirname(APP_BIN), '..', 'Resources', 'bin', 'radial');
  const radial = (args: string[]) => new Promise<CliRun>((resolve) => execFile('/bin/sh', [cli, ...args], { env: { ...baseEnv, RADIAL_USERDATA: scratch }, encoding: 'utf8', timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
  const ls = await radial(['ls', '--json']);
  if (ls.code !== 0) fail(`radial ls failed (${ls.code}): ${ls.stderr || ls.stdout}`);
  const lsJson: LsReply = JSON.parse(ls.stdout);
  const realFixture = fs.realpathSync(fixture);
  if (!lsJson.projects.some((p) => p.repoDir === realFixture || p.repoDir === fixture)) fail(`radial ls does not list the fixture: ${ls.stdout}`);
  const url = await radial(['url', fixture]);
  if (url.code !== 0 || url.stdout.trim() !== baseUrl) fail(`radial url gave ${JSON.stringify(url.stdout.trim())} (${url.code}), expected ${baseUrl}`);
  const ctx = await radial(['context', fixture, '--json']);
  const ctxJson: ContextReply | null = ctx.code === 0 ? JSON.parse(ctx.stdout) : null;
  if (!ctxJson || !ctxJson.ok || !Array.isArray(ctxJson.pages)) fail(`radial context failed: ${ctx.stderr || ctx.stdout}`);
  const reopen = await radial(['open', fixture, '--json']);
  const reopenJson: OpenedReply | null = reopen.code === 0 ? JSON.parse(reopen.stdout) : null;
  if (!reopenJson || reopenJson.state !== 'focused') fail(`radial open on the open fixture should focus it: ${reopen.stderr || reopen.stdout}`);
  ok('radial CLI: ls, url, context, open (focused) through the packaged app');

  // 4. The preview webview actually rendered the site's DOM.
  await until('preview rendered fixture content', 30_000,
    () => win.evaluate(() => {
      const wv = activeTab() && activeTab()!.webview;
      if (!wv || !wv.offsetWidth) return null;
      return wv.executeJavaScript('document.querySelector("h1") && document.querySelector("h1").textContent')
        .then((t) => t === 'smoke-home').catch(() => null);
    }));
  ok('preview rendered page content');

  // 5. In-page navigation lands in app route state (did-navigate → commit).
  // location.href, not a synthetic anchor click: untrusted clicks don't
  // trigger Chromium's default navigation inside the guest page.
  await win.evaluate(() => activeTab()!.webview.executeJavaScript('location.href = "/about.html"'));
  await until('route committed after link click', 15_000,
    () => win.evaluate(() => activeTab()!.currentRoute === '/about.html'
      ? activeTab()!.webview.executeJavaScript('document.querySelector("h1").textContent').then((t) => t === 'smoke-about').catch(() => null)
      : null));
  ok('in-page navigation committed to route state');

  // 5b. The write lane through the packaged CLI: a deterministic text edit lands
  //     in source (pinned to the page), a bad head tag is a usage error, and the
  //     agent list answers. No agent session is started here (that needs a real
  //     CLI login); test/agentLane.e2e.mts covers it with a stand-in.
  const edit = await radial(['edit', 'text', fixture, '--find', 'smoke-about', '--to', 'smoke-about-edited', '--route', '/about.html', '--json']);
  const editJson: EditReply | null = edit.code === 0 ? JSON.parse(edit.stdout) : null;
  if (!editJson || !editJson.ok || !/smoke-about-edited/.test(fs.readFileSync(path.join(fixture, 'about.html'), 'utf8'))) fail(`radial edit text failed: ${edit.stderr || edit.stdout}`);
  const badMeta = await radial(['meta', 'set', fixture, 'og:nope', 'x']);
  if (badMeta.code !== 2) fail(`radial meta set with a bad tag should exit 2, got ${badMeta.code}: ${badMeta.stderr}`);
  const agents = await radial(['agent', 'list', '--json']);
  if (agents.code !== 0 || !Array.isArray((JSON.parse(agents.stdout) as AgentListReply).agents)) fail(`radial agent list failed: ${agents.stderr || agents.stdout}`);
  ok('radial CLI: edit text landed in source, meta set validates, agent list answers');

  // 6. Zoom pipeline responds (visual zoom in, then reset to actual size).
  await win.evaluate(() => zoomPreview(1.35));
  await until('zoom applied', 5_000, () => win.evaluate(() => (activeTab()!.vz || 1) > 1.2));
  await win.evaluate(() => zoomPreview(0));
  await until('zoom reset', 5_000, () => win.evaluate(() => (activeTab()!.vz || 1) <= 1.001));
  ok('zoom in/reset works');

  // 7. Device preset flips the preview into the mobile artboard.
  await win.evaluate(() => setDevicePreset('mobile', activeTab()));
  await until('mobile device frame applied', 5_000,
    () => win.evaluate(() => activeTab()!.webview.classList.contains('device-frame')));
  ok('mobile preset applies device frame');

  // 7b. Panel surfaces: pin a panel, the dock renders, and the ⋯ menus really
  //     open. A dead handler reference here shipped broken in 0.18.0 — menus
  //     only throw when clicked, so the click has to happen in the gate.
  await win.evaluate(() => {
    const s = tpState();
    s.adjust.open = true; s.adjust.pinned = 'right';
    tpSave(); renderPanelDock(); renderQuickAdjust();
  });
  await until('panel dock rendered', 5_000,
    () => win.evaluate(() => !!document.querySelector('.pd-sec[data-sec-id="adjust"]')));
  await win.evaluate(() => document.querySelector<HTMLElement>('[data-pd-more="adjust"]')!.click());
  await until('dock section menu opens', 5_000,
    () => win.evaluate(() => !!document.querySelector('.pd-sec-menu')));
  await win.evaluate(() => document.querySelector<HTMLElement>('.menu-backdrop')!.click());
  await win.evaluate(() => {
    const s = tpState(); s.adjust.pinned = false; tpSave(); renderPanelDock(); renderQuickAdjust();
  });
  await until('adjust floats', 5_000,
    () => win.evaluate(() => { const el = document.getElementById('adjustPanel'); return !!(el && el.classList.contains('show')); }));
  await win.evaluate(() => document.querySelector<HTMLElement>('#adjustPanel [data-tp-more]')!.click());
  await until('float menu opens', 5_000,
    () => win.evaluate(() => !!document.querySelector('.pd-sec-menu')));
  await win.evaluate(() => document.querySelector<HTMLElement>('.menu-backdrop')!.click());
  await win.evaluate(() => { const s = tpState(); s.adjust.open = false; tpSave(); renderPanelDock(); renderQuickAdjust(); });
  ok('panel dock + float menus open');

  // 7c. The project's rail menu: Reload preview + Restart dev server sit above
  //     Sleep. Click both; a restart comes back on a fresh port with the
  //     preview repointed. (Menus only throw when clicked; see 7b.)
  await win.evaluate(() => openProjectMenu({ clientX: 60, clientY: 60, preventDefault() {}, stopPropagation() {} }, activeTab()!.id));
  await until('project menu opens with reload + restart on top', 5_000,
    () => win.evaluate(() => { const a = [...document.querySelectorAll<HTMLButtonElement>('#railCtxMenu button')].map((b) => b.dataset.act); return a[0] === 'reload' && a[1] === 'restart' && a.includes('sleep'); }));
  await win.evaluate(() => document.querySelector<HTMLButtonElement>('#railCtxMenu button[data-act="reload"]')!.click());
  await until('project menu closed after reload', 5_000, () => win.evaluate(() => !document.getElementById('railCtxMenu')));
  const beforeRestart = await win.evaluate(() => activeTab()!.baseUrl);
  await win.evaluate(() => openProjectMenu({ clientX: 60, clientY: 60, preventDefault() {}, stopPropagation() {} }, activeTab()!.id));
  await until('project menu reopened', 5_000, () => win.evaluate(() => !!document.querySelector('#railCtxMenu button[data-act="restart"]')));
  await win.evaluate(() => document.querySelector<HTMLButtonElement>('#railCtxMenu button[data-act="restart"]')!.click());
  await until('dev server restarted on a fresh port, preview repointed', 30_000,
    () => win.evaluate((u) => { const t = activeTab(); return !!t && !t.suspended && !!t.baseUrl && t.baseUrl !== u; }, beforeRestart));
  ok('project menu: reload preview + restart dev server');

  // 8. Nothing blew up in the renderer along the way.
  if (pageErrors.length) fail(`renderer uncaught errors: ${pageErrors.join(' | ')}`);
  ok('no renderer errors');

  // Perf budget: report the boot marks every run; fail only on egregious
  // regression (the numbers land in perf-log.jsonl).
  try {
    const marks = await win.evaluate(() => window.radial.perfBoot());
    console.log(`  boot marks: ${Object.entries(marks).map(([k, v]) => `${k}=${v}ms`).join(' \u00b7 ') || 'none'}`);
    if (marks['renderer-interactive'] && marks['renderer-interactive'] > 8000) fail(`boot budget blown: renderer-interactive ${marks['renderer-interactive']}ms > 8000ms`);
  } catch (e) { console.log('  boot marks unavailable:', String(e && (e as Error).message || e).slice(0, 80)); }

  await app.close();
  app = null;
  console.log('\n✓ SMOKE PASSED');
} catch (e) {
  fail((e && (e as Error).stack || String(e)) as string);
} finally {
  if (app) { try { await app.close(); } catch {} }
  try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}
