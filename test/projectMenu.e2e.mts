// Project rail menu E2E — the real app, a static fixture, the `radial` CLI.
//
// Right-click a project in the rail: Reload preview and Restart dev server sit
// above Sleep for an awake project; a sleeping one offers Wake instead. The
// restart comes back on a fresh port with the preview repointed. The same two
// actions answer as `radial reload` / `radial restart`; reload refuses a
// sleeping project, restart of a sleeping project is a fresh start.
//
// Opt-in: `npm run test:e2e`. Skips cleanly without Playwright.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ElectronApplication } from 'playwright-core';
import type { OpName, OpReplies } from '../src/main/cliServer.ts';
import { launchApp } from './support/app.ts';
const require = createRequire(import.meta.url);

// What the app's window carries, as far as this test reaches into it inside the
// page: the window scripts' globals (the app's own declarations are
// src/renderer/globals.d.ts, types.d.ts and renderer.ts) and the counter the
// test puts on window.
/** The preview: Electron's <webview>, with the methods this test calls. */
interface Webview extends HTMLElement { isLoading(): boolean; getURL(): string }
interface Tab { id: string; baseUrl: string | null; suspended: boolean; webview: Webview }
declare const window: Window & typeof globalThis & { __reloads: number };
declare function activeTab(): Tab | null;
declare function openProjectMenu(e: { clientX: number; clientY: number; preventDefault?(): void; stopPropagation?(): void }, projectId: string): void;
declare function closeRailMenu(): void;
/** A run of the `radial` CLI: its exit status (or the spawn error's code) and its output. */
interface CliRun { code: number | string; stdout: string; stderr: string }

function loadElectron() {
  for (const r of [path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '..', 'node_modules')]) {
    try { return (require(path.join(r, 'playwright-core')) as typeof import('playwright-core'))._electron; } catch {}
  }
  return null;
}
const until = async <T,>(label: string, ms: number, fn: () => T | Promise<T>) => { const t0 = Date.now(); let last: Awaited<T> | string | undefined; while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = (e as Error).message; } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`timeout: ${label} (${JSON.stringify(last)})`); };
async function closeApp(app: ElectronApplication) { try { await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]); } catch {} try { app.process().kill('SIGKILL'); } catch {} }

test('project menu: reload + restart from the rail and the CLI; a sleeping project offers Wake only', async (t) => {
  const _electron = loadElectron();
  if (!_electron) { t.skip('Playwright not available'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-projmenu-e2e-'));
  const fixture = path.join(scratch, 'site'); fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><title>Menu site</title></head><body><h1>Hello</h1></body></html>');
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ recents: [], session: { open: [], active: null } }));

  const env = { ...process.env, RADIAL_USERDATA: scratch, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' };
  const app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules', '.bin', 'electron'), args: ['.'], cwd: process.cwd(), env, timeout: 30000 });
  const win = await app.firstWindow({ timeout: 20000 });
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  const cli = path.join(process.cwd(), 'bin', 'radial');
  const radial = (args: string[]) => new Promise<CliRun>((resolve) => execFile('/bin/sh', [cli, ...args], { env, encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
  // K names the socket op (cliServer OpReplies) whose reply `--json` prints. The
  // test reads it only after the exit code says the op worked (an ErrorReply exits
  // non-zero), and j stays null when stdout wasn't JSON.
  const json = async <K extends OpName>(args: string[]) => { const r = await radial([...args, '--json']); let j: OpReplies[K] | null = null; try { j = JSON.parse(r.stdout); } catch {} return { ...r, json: j }; };
  const items = () => win.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('#railCtxMenu button')].map((b) => [b.dataset.act, b.textContent]));
  const openMenu = () => win.evaluate(() => openProjectMenu({ clientX: 60, clientY: 60, preventDefault() {}, stopPropagation() {} }, activeTab()!.id));
  const press = (act: string) => win.evaluate((act) => { const b = document.querySelector<HTMLButtonElement>(`#railCtxMenu button[data-act="${act}"]`); if (!b) return false; b.click(); return true; }, act);
  try {
    await until('renderer', 20000, () => win.evaluate(() => typeof activeTab === 'function' && typeof openProjectMenu === 'function'));
    await until('socket', 15000, () => fs.existsSync(path.join(scratch, 'cli.sock')));

    const open = await json<'open'>(['open', fixture]);
    assert.equal(open.code, 0, open.stderr + open.stdout);
    const url1 = open.json!.url!; assert.match(url1, /^http:\/\/(127\.0\.0\.1|localhost):\d+/);
    // The webview must have reached dom-ready: reload() is a silent no-op before that (same for ⌘R).
    await until('tab awake with a loaded preview', 30000, () => win.evaluate(() => { const t = activeTab(); if (!t || t.suspended || !t.baseUrl || !t.webview) return false; try { return !t.webview.isLoading() && /^http/.test(t.webview.getURL()); } catch { return false; } }));

    // 1. Awake: reload + restart on top, then sleep / reveal / close.
    await openMenu();
    assert.deepEqual(await items(), [['reload', 'Reload preview'], ['restart', 'Restart dev server'], ['sleep', 'Sleep'], ['reveal', 'Reveal in Finder'], ['settings', 'Project settings'], ['close', 'Close project']]);
    await win.evaluate(() => { window.__reloads = 0; activeTab()!.webview.addEventListener('did-start-loading', () => { window.__reloads++; }); });
    assert.equal(await press('reload'), true);
    await until('the preview reloaded', 5000, () => win.evaluate(() => window.__reloads > 0));
    await until('menu closed', 5000, () => win.evaluate(() => !document.getElementById('railCtxMenu')));

    // 2. Restart: a fresh port, the preview repointed, the project still awake.
    await openMenu();
    assert.equal(await press('restart'), true);
    await until('restarted on a new port', 30000, () => win.evaluate((u) => { const t = activeTab(); return !!t && !t.suspended && !!t.baseUrl && t.baseUrl !== u; }, url1));
    const url2 = await win.evaluate(() => activeTab()!.baseUrl);

    // 3. The CLI: restart answers with the new url and the tab follows; reload answers ok.
    const rs = await json<'restart'>(['restart', fixture]);
    assert.equal(rs.code, 0, rs.stderr + rs.stdout); assert.match(rs.json!.url!, /^http/); assert.notEqual(rs.json!.url, url2);
    await until('tab on the CLI-restarted port', 20000, () => win.evaluate((u) => activeTab()!.baseUrl === u, rs.json!.url!));
    assert.equal((await json<'reload'>(['reload', fixture])).code, 0);
    assert.match((await radial(['restart', fixture])).stdout, /^Restarted: site → http/);
    assert.match((await radial(['reload', fixture])).stdout, /^Reloaded: site/);

    // 4. Asleep: the menu offers Wake only; reload refuses (exit 6); restart is a fresh start.
    assert.equal((await json<'sleep'>(['sleep', fixture])).code, 0);
    await until('asleep', 10000, () => win.evaluate(() => activeTab()!.suspended === true));
    await openMenu();
    assert.deepEqual((await items()).map((x) => x[0]), ['sleep', 'reveal', 'settings', 'close']);
    assert.equal(await win.evaluate(() => document.querySelector('#railCtxMenu button[data-act="sleep"]')!.textContent), 'Wake');
    await win.evaluate(() => closeRailMenu());
    const rl = await radial(['reload', fixture]);
    assert.equal(rl.code, 6, rl.stderr + rl.stdout); assert.match(rl.stderr, /asleep/);
    const rs2 = await json<'restart'>(['restart', fixture]);
    assert.equal(rs2.code, 0, rs2.stderr + rs2.stdout); assert.match(rs2.json!.url!, /^http/);
    await until('awake again after the CLI restart', 30000, () => win.evaluate(() => activeTab()!.suspended === false && !!activeTab()!.baseUrl));
    assert.deepEqual(errors, [], 'no renderer errors');
  } finally {
    await closeApp(app);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
});
