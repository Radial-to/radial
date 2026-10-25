// E2E for rail project reordering: reorderTabs() moves a project row, the
// session persists the new order, and a relaunch restores the rail in exactly
// that order (the restore path must NOT bubble the active project to the top —
// that would scramble a manual arrangement on every restart).
//
// Drives reorderTabs directly rather than synthesizing HTML5 drag events
// (which playwright can't do reliably); the DnD wiring itself mirrors the
// long-proven pages-list pattern.
//
// Opt-in: `npm run test:e2e` (NOT part of `npm test`, which stays browser-free).
// Skips cleanly if Playwright or electron isn't available.
/// <reference path="../src/renderer/types.d.ts" />
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import type { Page } from 'playwright-core';
import type { OpenSession, RecentsStore } from '../src/main/recents.ts';
import { launchApp } from './support/app.ts';

const require = createRequire(import.meta.url);

type Playwright = typeof import('playwright-core');

// What the page functions reach in Radial's window: renderer.ts's tabs and
// sidebar helpers, typed with the window's own shapes (src/renderer/types.d.ts
// Tab, TermSession), and the activations this test counts.
/** A project tab (renderer Tab): the fields the rail reads and the sidebar fixture sets. */
type ProjectTab = Pick<Tab, 'id' | 'name' | 'repoDir' | '_railCollapsed' | 'terminals'>;
interface RadialWindow extends Window { renameActivations: number }
declare const window: RadialWindow;
/** renderer.ts's tabs (Tab[]), as far as this test reads them and its fixture fills them in. */
declare const tabs: ProjectTab[];
declare function reorderTabs(fromId: string | undefined, toId: string | undefined, after: boolean): void;
declare function renderProjectsRail(): void;
declare function startRenameTerm(projectId: string, termId: string, nameEl: Element): void;
declare function updateTermStatusDom(term: TermSession): void;
/** A sidebar row's activation (renderer.ts, async there); the test swaps in a counter. */
declare let selectProjectTerminal: (projectId: string, termId: string) => void;

function loadPlaywright() {
  const roots = [
    path.join(process.cwd(), 'node_modules'),
    path.join(process.cwd(), '..', 'node_modules'),
    path.join(process.cwd(), '..', 'platform', 'node_modules'),
  ];
  for (const r of roots) {
    for (const name of ['playwright', 'playwright-core']) {
      try { return require(path.join(r, name)) as Playwright; } catch {}
    }
  }
  return null;
}

function makeSite(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const f of ['index.html', 'styles.css']) {
    fs.copyFileSync(path.join(process.cwd(), 'samples', 'static-site', f), path.join(dir, f));
  }
  return fs.realpathSync(dir);
}

// Row order by repoDir (display names swap to the page <title> once a preview
// reports in — folder names are not stable across a relaunch).
const railOrder = (win: Page) => win.evaluate(() =>
  [...document.querySelectorAll<HTMLElement>('.rail-proj[data-id]')].map((el) => tabs.find((t) => t.id === el.dataset.id)!.repoDir));

async function launch(pw: Playwright, electronPath: string, userData: string, env: Record<string, string> = {}) {
  const app = await launchApp({
    executablePath: electronPath,
    args: ['.'],
    cwd: process.cwd(),
    env: { ...process.env, RADIAL_USERDATA: userData, RADIAL_AUTO_RELOAD: '0', ...env },
  });
  const win = await app.firstWindow();
  return { app, win };
}

test('rail reorder persists and survives a relaunch in order', async (t) => {
  const pw = loadPlaywright();
  if (!pw || !pw._electron) { t.skip('playwright(-core) not available'); return; }
  let electronPath;
  try { electronPath = require(path.join(process.cwd(), 'node_modules', 'electron')) as string; } catch {}
  if (!electronPath) { t.skip('electron not installed'); return; }

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-rail-e2e-'));
  const p1 = makeSite('rail-alpha-');
  const p2 = makeSite('rail-beta-');

  // Boot with both projects open (RADIAL_OPEN skips session restore).
  let { app, win } = await launch(pw, electronPath, userData, { RADIAL_OPEN: `${p1},${p2}` });
  try {
    await win.waitForFunction(() => document.querySelectorAll('.rail-proj[data-id]').length === 2, null, { timeout: 90000 });
    const before = await railOrder(win);
    assert.deepEqual(before, [p1, p2]);

    // Drag row 2 above row 1 (the drop handler's exact call).
    await win.evaluate(() => {
      const ids = [...document.querySelectorAll<HTMLElement>('.rail-proj[data-id]')].map((el) => el.dataset.id);
      reorderTabs(ids[1], ids[0], false);
    });
    assert.deepEqual(await railOrder(win), [p2, p1]);

    // The reorder saved the session in the new order (IPC write is async — poll).
    const storeFile = path.join(userData, 'radial-store.json');
    let saved: OpenSession | undefined | null = null;
    for (let i = 0; i < 50; i++) {
      try { saved = (JSON.parse(fs.readFileSync(storeFile, 'utf8')) as RecentsStore).session; } catch {}
      if (saved && saved.open && saved.open[0] === p2) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.deepEqual(saved && saved.open, [p2, p1], 'session order should match the rail');
  } finally {
    await app.close().catch(() => {});
  }

  // Relaunch on the saved session: the rail must come back [p2, p1] even
  // though the ACTIVE project (p1) is last — order beats active-first.
  ({ app, win } = await launch(pw, electronPath, userData, { RADIAL_DAEMON_EPHEMERAL: '1' })); // the last instance takes the daemon down with it
  try {
    await win.waitForFunction(() => document.querySelectorAll('.rail-proj[data-id]').length === 2, null, { timeout: 90000 });
    assert.deepEqual(await railOrder(win), [p2, p1]);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(p1, { recursive: true, force: true });
    fs.rmSync(p2, { recursive: true, force: true });
  }
});

test('agent rename keeps spaces, selection and focus through sidebar updates', { timeout: 90000 }, async (t) => {
  const pw = loadPlaywright();
  if (!pw?._electron) { t.skip('playwright(-core) not available'); return; }
  const electronPath = require(path.join(process.cwd(), 'node_modules', 'electron')) as string;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-rename-e2e-'));
  const site = makeSite('rail-rename-');
  let app;
  try {
    const launched = await launch(pw, electronPath, userData, { RADIAL_OPEN: ' ', RADIAL_DAEMON_EPHEMERAL: '1' });
    app = launched.app;
    const win = launched.win;
    await win.waitForFunction(() => typeof startRenameTerm === 'function', null, { timeout: 20000 });
    // Exercise the real sidebar with fixture rows, without starting a native CLI.
    await win.evaluate((repoDir) => {
      tabs.push({ id: 'rename-project', name: 'Rename fixture', repoDir, _railCollapsed: false,
        terminals: [{ id: 'rename-fixture', label: 'Original name', engine: 'claude' }] });
      renderProjectsRail();
      window.renameActivations = 0;
      selectProjectTerminal = () => { window.renameActivations++; };
    }, site);
    const row = win.locator('.rail-term[data-tid="rename-fixture"]');
    const input = win.getByRole('textbox', { name: 'Agent name' });
    const beginRename = () => win.evaluate(() => {
      const row = document.querySelector<HTMLElement>('.rail-term[data-tid="rename-fixture"]')!;
      startRenameTerm(row.dataset.id!, row.dataset.tid!, row.querySelector('.rail-term-name')!);
    });
    await beginRename();
    await input.fill('Fix');
    await input.press('Space');
    await input.press('ArrowUp');
    await input.press('ArrowDown');
    await input.press('End');
    await input.pressSequentially('client site');
    assert.equal(await input.inputValue(), 'Fix client site');
    assert.equal(await win.evaluate(() => window.renameActivations), 0);
    assert.equal(await input.evaluate((el) => document.activeElement === el), true);

    const preserved = await win.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('.rail-term-rename')!;
      input.setSelectionRange(4, 10, 'backward');
      const term = tabs[0].terminals![0];
      term._working = true;
      updateTermStatusDom(term);
      tabs[0].terminals!.push({ id: 'background-fixture', label: 'Background agent', engine: 'claude' });
      renderProjectsRail();
      return {
        sameInput: document.querySelector('.rail-term-rename') === input,
        focused: document.activeElement === input,
        selection: [input.selectionStart, input.selectionEnd, input.selectionDirection],
        working: input.closest('.rail-term')!.classList.contains('working'),
      };
    });
    assert.deepEqual(preserved, { sameInput: true, focused: true, selection: [4, 10, 'backward'], working: true });
    await input.press('Enter');
    assert.equal(await input.count(), 0);
    assert.equal(await row.locator('.rail-term-name').textContent(), 'Fix client site');
    assert.equal(await row.evaluate((el) => document.activeElement === el), true);
    assert.equal(await win.locator('.rail-term[data-tid="background-fixture"]').count(), 1, 'deferred changes appear after editing');

    await beginRename();
    await input.fill('Discard this name');
    await input.press('Escape');
    assert.equal(await row.locator('.rail-term-name').textContent(), 'Fix client site');
    assert.equal(await row.evaluate((el) => document.activeElement === el), true);

    await beginRename();
    await input.fill('Saved on blur');
    await input.press('Tab');
    assert.equal(await input.count(), 0);
    assert.equal(await row.locator('.rail-term-name').textContent(), 'Saved on blur');

    await row.focus();
    await row.press('Space');
    assert.equal(await win.evaluate(() => window.renameActivations), 1, 'Space still activates a focused sidebar row');

    await beginRename();
    await win.evaluate(() => { tabs[0].terminals = []; renderProjectsRail(); });
    assert.equal(await input.count(), 0, 'removing an agent cancels its active rename');
    assert.equal(await row.count(), 0);
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(site, { recursive: true, force: true });
  }
});
