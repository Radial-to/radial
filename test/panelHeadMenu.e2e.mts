// A panel's header is rebuilt whenever what it shows changes: its tabs, the
// active tab, collapsed or not, its group or where it sits (buildFloatHead in
// renderer.ts). A right-click on the header opens the panel's menu. Each rebuild
// used to add one more right-click listener to the same header, so a right-click
// ran the menu once per rebuild: an even count opened and closed it (no menu,
// and a stray backdrop that swallowed the next click), an odd count left extra
// backdrops under it. Switching the Agent window's tabs, as a person does,
// rebuilds its header; after each switch one right-click opens one menu.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenProjectResult, OpenedProject } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the app's window has that this test reaches inside page.evaluate (renderer.ts).
/** openProjectPath's answer (renderer OpenProjectResultWithDir), its error readable on either branch. */
type OpenResult = (OpenedProject & { error?: undefined }) | (Extract<OpenProjectResult, { ok: false }> & { repoDir?: string });
declare const window: Window & typeof globalThis & { RadialNativeChat?: { enabled(): boolean } };
declare const homeTab: { repoDir: string | null };
declare function openProjectPath(dir: string): Promise<OpenResult>;

test('a panel header opens one menu per right-click, however often it was rebuilt', { timeout: 60000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-panel-head-menu-'));
  const site = path.join(scratch, 'Site'); fs.mkdirSync(site); fs.writeFileSync(path.join(site, 'index.html'), '<title>Site</title><h1>Hello</h1>');
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const interactive = path.resolve('test/fixtures/native-interactive.cjs');
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_CHAT_TEST_CLAUDE: interactive, RADIAL_CHAT_TEST_CURSOR: interactive, CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'), CURSOR_CONFIG_DIR: path.join(scratch, 'cursor'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  try {
    const page = await app.firstWindow(); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    const opened = await page.evaluate(dir => openProjectPath(dir), site);
    assert.equal(opened.ok, true, opened.error);
    // The Agent window in the left sidebar: Agent and Context tabs, then the + and empty space.
    const head = page.locator('#rp-terminal > .tool-panel.homed > .tp-head');
    await head.locator('[data-tpg-tab="context"]').waitFor({ state: 'visible' });
    const menus = page.locator('.pd-sec-menu'), backdrops = page.locator('.menu-backdrop');
    for (const tab of ['context', 'terminal', 'context', 'terminal']) {
      const spacer = await head.locator('.pd-sp').elementHandle();
      await head.locator(`[data-tpg-tab="${tab}"]`).click();
      assert.equal(await head.locator(`[data-tpg-tab="${tab}"]`).getAttribute('aria-pressed'), 'true');
      assert.equal(await spacer!.evaluate(el => el.isConnected), false, 'switching the tab rebuilt the header');
      // Right-click the header's empty space, right of the tabs and the +.
      const box = (await head.boundingBox())!;
      await head.click({ button: 'right', position: { x: box.width - 12, y: box.height / 2 } });
      assert.equal(await menus.count(), 1, `one menu after switching to ${tab}`);
      assert.equal(await backdrops.count(), 1, `one backdrop under it after switching to ${tab}`);
      assert.equal(await menus.isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await menus.count() + await backdrops.count(), 0, 'Escape closes the menu and its backdrop');
    }
    assert.deepEqual(errors, []);
  } finally { await app.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
});
