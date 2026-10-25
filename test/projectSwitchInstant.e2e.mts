/// <reference path="../src/renderer/types.d.ts" />
// Switching to a project shows its sessions at once, while its preview waits on
// its dev server. From the report that asked for it: "the agent / terminal view doesnt switch until the new
// project has fully rendered and it makes it feel slow."
//
// The real app twice, with one user data folder, as a restored session runs:
// run 1 opens a slow site (its dev server, a stand-in, waits four seconds before
// it listens) and a fast one; each boots its default agent (a stand-in CLI that
// prints which project it runs in), and the app quits with the fast site in
// front, its agents still running in the PTY daemon. Run 2 restores the fast site
// awake and the slow one asleep, its agent live in the daemon but not shown yet.
// Then:
// - a switch to the slow site shows its terminal, with its session's content,
//   within a frame or two, while its preview still shows that it's loading; the
//   preview fills in once the server answers, scrolled where the session left
//   it (run 1 scrolled it down), as soon as the page is there;
// - with the slow site asleep again, a quick switch to it and back ends on the
//   fast site: its session, its pages, what's open over it and its preview,
//   nothing of the slow site's wake. The slow site's session's view comes back
//   when the slow site is next shown.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright-core';
import type { OpenProjectOptions, OpenProjectResult, RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// The window's API, and renderer.ts's top-level declarations, which page functions reach by name.
declare const window: Window & typeof globalThis & { radial: RadialApi };
declare const tabs: Tab[];
declare let activeId: string | null;
declare function tabByRepo(repoDir: string | null | undefined): Tab | null;
declare function switchTab(id: string): Promise<void>;
declare function openProjectPath(dir: string, opts?: OpenProjectOptions): Promise<OpenProjectResult & { repoDir?: string }>;
declare function openSitemapView(): void;
declare function sitemapOpen(): boolean;
declare function $<K extends string>(id: K): ElementById<K>;

// A stand-in for Claude Code: answers the version probe, then draws a screen that says which project it runs in,
// and stays up.
const FAKE_CLAUDE = `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('99.0.0 (Claude Code)'); process.exit(0); }
process.stdout.write('\\x1b[2J\\x1b[H' + 'Agent in ' + require('path').basename(process.cwd()) + ': ready\\r\\n');
process.stdin.resume();
`;
// A dev server that takes its time: it listens on the port Radial gives it four seconds after it starts. Its page is
// tall enough to scroll.
const SLOW_SERVER = `const http = require('http');
console.log('Warming up…');
setTimeout(() => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Slow site</title><h1>Slow site</h1><div style="height: 4000px"></div>'); });
  server.listen(Number(process.env.PORT) || 0, '127.0.0.1', () => console.log('Local: http://127.0.0.1:' + server.address().port + '/'));
}, 4000);
`;

const until = async <T,>(label: string, ms: number, fn: () => T | Promise<T>): Promise<NonNullable<T>> => {
  const t0 = Date.now(); let last: unknown;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last as NonNullable<T>; } catch (e) { last = (e as Error).message; } await new Promise((r) => setTimeout(r, 200)); }
  throw new Error(`timeout: ${label} (${JSON.stringify(last)})`);
};

test('a switch shows the project\'s sessions at once and its preview after; a quick switch away and back ends where it started', { timeout: 240000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-switch-now-'));
  const bin = path.join(scratch, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const fast = path.join(scratch, 'fast-site'), slow = path.join(scratch, 'slow-site');
  fs.mkdirSync(fast); fs.mkdirSync(path.join(slow, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(fast, 'index.html'), '<!doctype html><title>Fast site</title><h1>Fast site</h1><a href="/about.html">About</a>');
  fs.writeFileSync(path.join(fast, 'about.html'), '<!doctype html><title>About</title><h1>About</h1>');
  fs.writeFileSync(path.join(slow, 'package.json'), JSON.stringify({ name: 'slow-site', private: true, scripts: { dev: 'node dev-server.cjs' } }));
  fs.writeFileSync(path.join(slow, 'dev-server.cjs'), SLOW_SERVER);
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  // Run 1 opens nothing at launch (RADIAL_OPEN with no path); run 2 restores the session run 1 left.
  const launch = (run: 1 | 2) => launchApp({
    executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'),
    args: process.env.RADIAL_APP_PATH ? [] : ['.'],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RADIAL_USERDATA: scratch, CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'), RADIAL_AUTO_RELOAD: '0', ...(run === 1 ? { RADIAL_OPEN: ' ', RADIAL_DAEMON_EPHEMERAL: '0' } : { RADIAL_DAEMON_EPHEMERAL: '1' }) },
  });
  // A project's agent pane shows its session: its terminal is the one on screen, with the stand-in's words in it.
  const shows = (page: Page, dir: string) => page.evaluate(({ dir, marker }) => {
    const tab = tabByRepo(dir), term = tab?.term;
    if (!tab || activeId !== tab.id || !term?.xterm || !term.el?.classList.contains('active') || !$('termOpening').hidden) return false;
    const buffer = term.xterm.buffer.active;
    for (let i = 0; i < buffer.length; i++) if (buffer.getLine(i)?.translateToString(true).includes(marker)) return true;
    return false;
  }, { dir, marker: `Agent in ${path.basename(dir)}: ready` });
  // Where a project's preview is scrolled to, down the page.
  const scrolled = (page: Page, dir: string) => page.evaluate((dir) => tabByRepo(dir)!.webview.executeJavaScript('scrollY') as Promise<number>, dir);
  let app: ElectronApplication | null = null;
  try {
    // ── Run 1: the slow site, then the fast one in front, each with its agent; the agents outlive the app. ──
    app = await launch(1);
    let page = await app.firstWindow();
    await page.waitForFunction(() => typeof tabs !== 'undefined' && typeof openProjectPath === 'function', null, { timeout: 30000 });
    for (const dir of [slow, fast]) {
      await page.evaluate((dir) => openProjectPath(dir), dir);
      await until(`${path.basename(dir)} open with its agent`, 60000, () => shows(page, dir));
      if (dir !== slow) continue;
      // The slow site's session keeps its view of the preview: scrolled down the page.
      await until('the slow site\'s preview up', 30000, () => page.evaluate((dir) => !!tabByRepo(dir)!._previewReady && !tabByRepo(dir)!._documentLoading, dir));
      await page.evaluate((dir) => tabByRepo(dir)!.webview.executeJavaScript('scrollTo(0, 800)'), dir);
      await until('its session saved that view', 10000, () => page.evaluate((dir) => tabByRepo(dir)!.term?.preview?.scroll?.y === 800, dir));
    }
    await app.close(); app = null;

    // ── Run 2: the fast site restored awake in front, the slow one asleep with its agent live in the daemon. ──
    app = await launch(2);
    page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await until('the fast site restored in front, with its agent', 60000, () => shows(page, fast));
    const before = await until('the slow site restored asleep, its agent listed', 30000, () => page.evaluate((dir) => {
      const tab = tabByRepo(dir);
      return tab && tab.suspended && (tab.terminals || []).length === 1 && tab.terminals![0].detached && !tab.terminals![0].xterm ? { id: tab.id } : null;
    }, slow));

    // The switch: the slow site's session shows within a frame or two, its preview still loading.
    const now = await page.evaluate(async ({ id, marker }) => {
      const tab = tabs.find((t) => t.id === id)!;
      const t0 = performance.now();
      void switchTab(id);
      return new Promise<{ ms: number; asleep: boolean; loading: boolean }>((resolve) => {
        const look = () => {
          const term = tab.term, buffer = term?.xterm?.buffer.active;
          let content = false;
          for (let i = 0; buffer && i < buffer.length && !content; i++) content = !!buffer.getLine(i)?.translateToString(true).includes(marker);
          const shown = !!term?.el?.classList.contains('active') && term.el.offsetWidth > 0 && $('termOpening').hidden && content;
          if (shown || performance.now() - t0 > 15000) resolve({ ms: shown ? Math.round(performance.now() - t0) : -1, asleep: !!tab.suspended, loading: !!tab._documentLoading });
          else requestAnimationFrame(look);
        };
        look();
      });
    }, { id: before.id, marker: 'Agent in slow-site: ready' });
    console.log(`switch to a sleeping project: its session showed in ${now.ms} ms`);
    assert.ok(now.ms >= 0 && now.ms <= 250, `the session shows at once, not after the dev server (${now.ms} ms)`);
    assert.deepEqual([now.asleep, now.loading], [true, true], 'its preview is still waking, and says it is loading');
    const filled = await until('the preview fills in once the server answers', 30000, () => page.evaluate((dir) => {
      const tab = tabByRepo(dir)!;
      let url = ''; try { url = tab.webview.getURL(); } catch {}
      return !tab.suspended && !!tab.baseUrl && url.startsWith(tab.baseUrl) && tab._previewReady && !tab._documentLoading ? url : null;
    }, slow));
    assert.match(filled, /^http:\/\/127\.0\.0\.1:\d+\//);
    assert.equal(await shows(page, slow), true, 'its session is still the one shown');
    // Its session's view comes back with the page, not ten seconds later (a navigation replaced by the switch's own
    // used to drop the restore's callback, which then waited out its timeout).
    const t1 = Date.now();
    await until('its session\'s view back with the page', 4000, async () => Math.abs(await scrolled(page, slow) - 800) <= 2);
    console.log(`its session's view came back ${Date.now() - t1} ms after the page`);

    // A quick switch to the sleeping slow site and back: it ends on the fast site, whatever the wake does after.
    await page.evaluate((dir) => window.radial.sleepProject(dir), slow);
    await until('the slow site asleep again', 20000, () => page.evaluate((dir) => tabByRepo(dir)!.suspended, slow));
    await page.evaluate((dir) => switchTab(tabByRepo(dir)!.id), fast);
    await until('the fast site in front', 10000, () => shows(page, fast));
    const fastUrl = await page.evaluate((dir) => tabByRepo(dir)!.webview.getURL(), fast);
    await page.evaluate(async ([a, b]) => {
      // The slow site's session's view isn't back yet, as after a restart: this switch is the one that brings it.
      delete tabByRepo(b)!._threadPreview;
      void switchTab(tabByRepo(b)!.id);
      await new Promise((r) => setTimeout(r, 50));
      void switchTab(tabByRepo(a)!.id);
      openSitemapView(); // something open over the fast site while the slow one wakes
    }, [fast, slow]);
    await until('the slow site woke behind', 30000, () => page.evaluate((dir) => !tabByRepo(dir)!.suspended, slow));
    await new Promise((r) => setTimeout(r, 500)); // anything the wake would still do to the view
    const after = await page.evaluate(([a, b]) => ({
      front: activeId === tabByRepo(a)!.id,
      pages: [...document.querySelectorAll('#pageList li')].map((li) => li.textContent!.trim()).join(' | '),
      slowTermShown: !!tabByRepo(b)!.term?.el?.classList.contains('active'),
      sitemap: sitemapOpen(),
      url: tabByRepo(a)!.webview.getURL(),
    }), [fast, slow]);
    assert.equal(after.front, true, 'the fast site is in front');
    assert.equal(await shows(page, fast), true, 'its session is the one shown');
    assert.equal(after.slowTermShown, false, 'never the slow site\'s');
    assert.match(after.pages, /about/i, `its pages, not the slow site's (${after.pages})`);
    assert.equal(after.sitemap, true, 'what is open over it stays open');
    assert.equal(after.url, fastUrl, 'and its preview stays where it was');
    // Shown again, the slow site gets its session's view back.
    await page.evaluate((dir) => switchTab(tabByRepo(dir)!.id), slow);
    await until('the slow site\'s session view back once it is shown', 8000, async () => Math.abs(await scrolled(page, slow) - 800) <= 2);
    assert.deepEqual(errors, []);
  } finally {
    if (app) await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 10000))]);
    try { execFileSync('pkill', ['-f', path.join(scratch, 'term-daemon')]); } catch {}
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
