import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElectronApplication } from 'playwright-core';
import { launchApp } from './support/app.ts';

// The window script's global this test calls inside the page (renderer.ts).
declare function openSettings(mode?: 'global' | 'project'): void;

test('appearance previews apply immediately, support keyboard selection, and persist', { timeout: 60000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-appearance-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp({
      executablePath: path.join(process.cwd(), 'node_modules', '.bin', 'electron'), args: ['.'],
      cwd: process.cwd(),
      env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForFunction(() => typeof openSettings === 'function');
    await win.evaluate(() => openSettings('global'));
    const dark = win.getByRole('radio', { name: 'Dark', exact: true });
    const light = win.getByRole('radio', { name: 'Light', exact: true });
    const sidebar = win.getByRole('switch', { name: 'Transparent sidebar' });
    assert.equal(await dark.isChecked(), true);
    assert.equal(await sidebar.isChecked(), false);
    const colors = () => win.locator('.theme-preview').evaluateAll(els => els.map(el => getComputedStyle(el).backgroundColor));
    const previewColors = await colors();
    assert.notEqual(previewColors[0], previewColors[1]);
    await win.locator('.set-appearance').screenshot({ path: '/tmp/radial-appearance-dark.png' });

    await dark.focus();
    await win.keyboard.press('ArrowRight');
    assert.equal(await light.isChecked(), true);
    assert.equal(await light.evaluate(el => el === document.activeElement), true);
    assert.equal(await win.evaluate(() => document.documentElement.classList.contains('light')), true);
    assert.deepEqual(await colors(), previewColors, 'preview palettes stay stable when the app theme changes');
    await sidebar.check();
    assert.equal(await win.evaluate(() => localStorage.getItem('radial.transparentSidebar')), '1');
    assert.match(await win.locator('#projectsRail').evaluate(el => getComputedStyle(el).backgroundColor), /0\.72/);
    await win.locator('.set-appearance').screenshot({ path: '/tmp/radial-appearance-light.png' });

    await win.reload();
    await win.waitForFunction(() => typeof openSettings === 'function');
    assert.equal(await win.evaluate(() => document.documentElement.classList.contains('light') && document.documentElement.classList.contains('sidebar-transparent')), true);
    await win.evaluate(() => openSettings('global'));
    assert.equal(await light.isChecked(), true);
    assert.equal(await sidebar.isChecked(), true);
    await sidebar.focus();
    await win.keyboard.press('Space');
    assert.equal(await sidebar.isChecked(), false);
    assert.equal(await win.evaluate(() => localStorage.getItem('radial.transparentSidebar')), '0');
    await dark.check();
    assert.equal(await win.evaluate(() => localStorage.getItem('radial.theme')), 'dark');

    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1000, 760); w.webContents.setZoomFactor(2); });
    assert.equal(await win.locator('.set-appearance').evaluate(el => el.scrollWidth > el.clientWidth), false, 'appearance fits at 200% zoom');
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
