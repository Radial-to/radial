import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElectronApplication } from 'playwright-core';
import type { OpenProjectResult, OpenedProject } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the app's window has that this test reaches inside win.evaluate:
// window scripts' top-level declarations (src/renderer/globals.d.ts,
// types.d.ts and renderer.ts have the full types).
// They are declared as always there; the boot poll still guards them, because
// firstWindow() can resolve before the window's scripts have run.
/** A canvas tool (renderer CanvasToolMode). */
type CanvasMode = 'none' | 'select' | 'comment' | 'inspect' | 'draw' | 'text';
/** openProjectPath's answer (renderer OpenProjectResultWithDir), its error readable on either branch (OpenedProject has no `error?: undefined` of its own yet). */
type OpenResult = (OpenedProject & { error?: undefined }) | (Extract<OpenProjectResult, { ok: false }> & { repoDir?: string });
/** The canvas key map (shortcuts.js); this test swaps in its own copy and edits that. */
declare const window: Window & typeof globalThis & { RadialToolKeys: Partial<Record<string, CanvasMode>> };
declare function openProjectPath(dir: string): Promise<OpenResult>;
declare function setCanvasMode(mode: CanvasMode | 'edit'): void;
declare function openSettings(mode?: 'global' | 'project'): void;
declare function closeSettings(): void;
declare function openCmdK(): Promise<void>;

test('shortcut hints follow live bindings, ignore keyboard actions, and respect limits and settings', { timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-shortcut-ui-'));
  const repo = path.join(root, 'site');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'index.html'), '<html><body><h1>Hello</h1></body></html>');
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules/.bin/electron'), args: ['.'], cwd: process.cwd(),
      env: { ...process.env, RADIAL_USERDATA: path.join(root, 'app'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1', RADIAL_DEMO_FRESH: '1' } });
    const win = await app.firstWindow();
    await win.waitForFunction(() => typeof openProjectPath === 'function');
    const result = await win.evaluate(dir => openProjectPath(dir), repo);
    assert.equal(result.ok, true, result.error);
    await win.waitForFunction(() => !document.querySelector('.toast.show'));
    await win.evaluate(() => setCanvasMode('none'));
    const tool = win.locator('.bn-tool[data-mode="select"]').first();
    await tool.click();
    await win.waitForSelector('.shortcut-hint');
    assert.equal(await win.locator('.shortcut-hint kbd').innerText(), 'S');
    await win.locator('.shortcut-hint').screenshot({ path: '/tmp/radial-shortcut-hint.png' });
    await tool.focus();
    await win.keyboard.press('v');
    await win.waitForTimeout(5500);
    assert.equal(await win.locator('.shortcut-hint').count(), 1, 'trying a key keeps the reminder visible beyond five seconds');
    await win.getByRole('button', { name: 'Dismiss shortcut hint' }).click();
    await win.locator('.bn-tool[data-mode="none"]').first().click();
    assert.equal(await win.locator('.shortcut-hint').count(), 0, 'global cooldown');
    await win.evaluate(() => { const now = Date.now; Date.now = () => now() + 31000; });
    await tool.focus();
    await win.keyboard.press('s');
    assert.equal(await win.locator('.shortcut-hint').count(), 0, 'a shortcut does not promote itself');
    await win.evaluate(() => document.querySelector<HTMLElement>('.bn-tool[data-mode="none"]')!.click());
    assert.equal(await win.locator('.shortcut-hint').count(), 0, 'programmatic clicks are not manual actions');
    await tool.click();
    await win.waitForSelector('.shortcut-hint');
    await win.getByRole('button', { name: 'Turn off hints' }).click();
    assert.equal(await win.locator('.shortcut-hint').count(), 0);
    await win.evaluate(() => openSettings('global'));
    const enabled = win.getByRole('switch', { name: 'Show shortcut hints' });
    assert.equal(await enabled.isChecked(), false);
    await enabled.check();
    await win.evaluate(() => closeSettings());
    await win.evaluate(() => { const now = Date.now; Date.now = () => now() + 31000; });
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()!.getMenuItemById('shortcut-reload-preview')!;
      const win = BrowserWindow.getAllWindows()[0];
      item.click({ triggeredByAccelerator: false }, win, win.webContents);
    });
    await win.waitForSelector('.shortcut-hint');
    assert.match(await win.locator('.shortcut-hint kbd').innerText(), /⌘R|Ctrl\+R/);
    await win.getByRole('button', { name: 'Dismiss shortcut hint' }).click();
    await win.evaluate(() => { const now = Date.now; Date.now = () => now() + 31000; });
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()!.getMenuItemById('shortcut-reload-preview')!;
      const win = BrowserWindow.getAllWindows()[0];
      item.click({ triggeredByAccelerator: true }, win, win.webContents);
    });
    assert.equal(await win.locator('.shortcut-hint').count(), 0, 'native accelerator does not promote itself');
    await win.evaluate(() => setCanvasMode('none'));
    await tool.click();
    await win.waitForSelector('.shortcut-hint');
    await win.getByRole('button', { name: 'Dismiss shortcut hint' }).click();
    await win.evaluate(() => { const now = Date.now; Date.now = () => now() + 31000; setCanvasMode('none'); });
    await tool.click();
    assert.equal(await win.locator('.shortcut-hint').count(), 0, 'three reminders per binding');
    // Change the real canvas key map; both dispatch and hints use this map.
    await win.evaluate(() => {
      window.RadialToolKeys = { ...window.RadialToolKeys, q: 'select' };
      delete window.RadialToolKeys.s;
      setCanvasMode('none');
    });
    await tool.click();
    await win.waitForSelector('.shortcut-hint');
    assert.equal(await win.locator('.shortcut-hint kbd').innerText(), 'Q');
    await win.getByRole('button', { name: 'Dismiss shortcut hint' }).click();
    await win.evaluate(() => setCanvasMode('none'));
    await tool.focus();
    await win.keyboard.press('q');
    assert.ok(await tool.evaluate(el => el.classList.contains('active')), 'the promoted binding runs the action');
    await win.evaluate(() => { const now = Date.now; Date.now = () => now() + 31000; openCmdK(); });
    await win.locator('#cmdkInput').fill('Actual size');
    await win.locator('.cmdk-item').filter({ hasText: 'Actual size' }).click();
    await win.waitForSelector('.shortcut-hint');
    assert.match(await win.locator('.shortcut-hint kbd').innerText(), /⌘0|Ctrl\+0/);
    await win.getByRole('button', { name: 'Dismiss shortcut hint' }).click();
    await win.evaluate(() => openSettings('global'));
    await enabled.uncheck();
    await win.reload();
    await win.waitForFunction(() => typeof openSettings === 'function');
    await win.evaluate(() => openSettings('global'));
    assert.equal(await enabled.isChecked(), false, 'off switch persists across reloads');
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
