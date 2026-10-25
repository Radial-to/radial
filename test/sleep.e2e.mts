/// <reference path="../src/renderer/types.d.ts" />
// Sleep-on-restart E2E — the real app, twice, same userData.
//
// Run 1 opens two static projects (A active last... actually B) and collapses
// A's rail drawer. Run 2 must restore B awake (it was active), A ASLEEP with no
// dev server, and A's drawer still collapsed; switching to A must wake it.
// This is the restored-session contract: ten open projects cost nothing at
// boot until one is used.
//
// Runs under `npm run test:e2e`; skips without playwright/electron like the
// other e2e suites. No network, no agents — two throwaway static fixtures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import type { OpenProjectOptions, OpenProjectResult } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

const require = createRequire(import.meta.url);

// renderer.ts's top-level declarations, which page functions reach by name (Tab is types.d.ts's).
declare const tabs: Tab[];
declare let activeId: string | null;
declare function openProjectPath(dir: string, opts?: OpenProjectOptions): Promise<OpenProjectResult & { repoDir?: string }>;
declare function saveRailCollapse(repoDir: string, collapsed: boolean): void;
declare function switchTab(id: string): Promise<void>;

function loadPlaywright() {
  const roots = [
    path.join(process.cwd(), 'node_modules'),
    path.join(process.cwd(), '..', 'node_modules'),
    path.join(process.cwd(), '..', 'platform', 'node_modules'),
  ];
  for (const r of roots) {
    for (const name of ['playwright', 'playwright-core']) {
      try { return require(path.join(r, name)) as typeof import('playwright-core'); } catch {}
    }
  }
  return null;
}

function makeSite(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `radial-sleep-e2e-${name}-`));
  fs.writeFileSync(path.join(dir, 'index.html'),
    `<!doctype html><html><head><title>${name}</title></head><body><h1>${name}</h1></body></html>`);
  return dir;
}

async function until<T>(label: string, ms: number, fn: () => T | Promise<T>) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { last = await fn(); if (last) return last; } catch (e) { last = (e as Error).message; }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail(`timed out waiting for: ${label} (last: ${JSON.stringify(last)})`);
}

test('restart restores the active project awake and the rest asleep (wake on click, collapse sticks)', async (t) => {
  const pw = loadPlaywright();
  if (!pw || !pw._electron) { t.skip('playwright(-core) not available'); return; }
  let electronPath;
  try { electronPath = require(path.join(process.cwd(), 'node_modules', 'electron')) as string; } catch {}
  if (!electronPath) { t.skip('electron not installed'); return; }

  const siteA = makeSite('site-a');
  const siteB = makeSite('site-b');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-sleep-e2e-data-'));
  const launch = (extra: Record<string, string> = {}) => launchApp({
    executablePath: electronPath,
    args: ['.'],
    cwd: process.cwd(),
    env: { ...process.env, RADIAL_USERDATA: userData, RADIAL_AUTO_RELOAD: '0', ...extra },
  });

  // ── Run 1: open A then B (B ends active), collapse A's drawer, quit. ──
  let app = await launch();
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate((dir) => openProjectPath(dir), siteA);
    await until('site-a open', 30000, () => page.evaluate(() => tabs.length === 1 && !!tabs[0].baseUrl));
    // The preview must report its <title> before we quit — that's what a cold
    // restore later restores as the tab's identity.
    await until('site-a title learned', 30000, () => page.evaluate(() => tabs[0].pageTitle === 'site-a'));
    await page.evaluate((dir) => openProjectPath(dir), siteB);
    await until('site-b open + active', 30000, () => page.evaluate(() =>
      tabs.length === 2 && !!tabs[1].baseUrl && activeId === tabs[1].id));
    await page.evaluate(() => {
      const a = tabs[0];
      a._railCollapsed = true;
      saveRailCollapse(a.repoDir, true);
    });
  } finally { await app.close(); }

  // ── Run 2: same userData → session restore. ──
  app = await launch({ RADIAL_DAEMON_EPHEMERAL: '1' }); // the last instance takes the daemon (and its agents) down with it
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const state = await until('both tabs restored', 30000, () => page.evaluate(() => {
      if (typeof tabs === 'undefined' || tabs.length !== 2) return null;
      const byName = (n: string) => tabs.find((t) => t.name && t.name.includes(n));
      const a = byName('site-a'), b = byName('site-b');
      if (!a || !b) return null;
      if (!b.baseUrl) return null; // active project still starting
      return {
        aSuspended: a.suspended, aUrl: a.baseUrl, aCollapsed: !!a._railCollapsed, aId: a.id,
        aTitle: a.pageTitle,
        bSuspended: b.suspended, bUrl: b.baseUrl, activeIsB: activeId === b.id,
      };
    }));
    assert.equal(state.bSuspended, false, 'the last-active project wakes');
    assert.ok(/^https?:/.test(state.bUrl), 'active project has a live dev server');
    assert.equal(state.activeIsB, true, 'restore focuses the last-active project');
    assert.equal(state.aSuspended, true, 'the background project restores ASLEEP');
    assert.equal(state.aUrl, null, 'no dev server was started for the sleeping project');
    assert.equal(state.aCollapsed, true, 'the rail drawer collapse survives the restart');
    assert.equal(state.aTitle, 'site-a', 'a sleeping tab still knows its real site title');

    // Sleeping projects retain their state without a decorative moon icon.
    const moons = await page.locator('#railProjects .rail-moon').count();
    assert.equal(moons, 0, 'sleep status does not add a decorative sidebar icon');

    // Click the sleeping project → it wakes: dev server starts, preview points at it.
    await page.evaluate((id) => switchTab(id), state.aId);
    await until('site-a woke on click', 30000, () => page.evaluate(() => {
      const a = tabs.find((t) => t.name && t.name.includes('site-a'));
      return a && !a.suspended && /^https?:/.test(a.baseUrl || '');
    }));
  } finally { await app.close(); }
});
