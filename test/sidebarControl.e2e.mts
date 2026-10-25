import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenProjectResult, OpenedProject, RadialApi } from '../src/shared/radialApi.ts';
import type { ChatEngine } from '../src/shared/chatPermissions.ts';
import { launchApp } from './support/app.ts';

// What the app's window has that this test reaches inside page.evaluate: the
// preload's API, the native chat (nativeChat.ts) and window scripts' top-level
// declarations (src/renderer/globals.d.ts and types.d.ts have the full types).
// They are declared as always there; the boot poll still guards them, because
// firstWindow() can resolve before the window's scripts have run.
/** A project, or Home's agent (renderer AnyTab), the fields read here. */
interface PageAnyTab { id: string; repoDir: string | null }
/** The native chat's window API (renderer RadialNativeChatApi), the methods called here. */
interface NativeChatApi { enabled(): boolean; createFor(tab: PageAnyTab, engine?: ChatEngine): Promise<void> }
/** openProjectPath's answer (renderer OpenProjectResultWithDir), its error readable on either branch (OpenedProject has no `error?: undefined` of its own yet). */
type OpenResult = (OpenedProject & { error?: undefined }) | (Extract<OpenProjectResult, { ok: false }> & { repoDir?: string });
declare const window: Window & typeof globalThis & { radial: RadialApi; RadialNativeChat: NativeChatApi };
declare const homeTab: PageAnyTab;
declare function agentTab(): PageAnyTab | null;
declare function openProjectPath(dir: string): Promise<OpenResult>;
/** Renders every tool panel again (renderer.ts), as a page update does. */
declare function renderQuickAdjust(): void;
/** Electron's draggable-region property, which Chromium reports on computed styles. */
type AppRegionStyle = CSSStyleDeclaration & { webkitAppRegion: string };

test('sidebar toggle stays in the header across Home, projects and fullscreen', { timeout: 60000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-sidebar-control-'));
  const site = path.join(scratch, 'Site'); fs.mkdirSync(site); fs.writeFileSync(path.join(site, 'index.html'), '<title>Site</title><h1>Hello</h1>');
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_CHAT_TEST_CLAUDE: path.resolve('test/fixtures/native-interactive.cjs'), RADIAL_CHAT_TEST_CURSOR: path.resolve('test/fixtures/native-interactive.cjs'), CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'), CURSOR_CONFIG_DIR: path.join(scratch, 'cursor'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  try {
    const page = await app.firstWindow(); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    const chat = await page.evaluate(() => window.radial.nativeChatCreate(homeTab.repoDir!, true, 'codex'));
    const recent = page.locator(`.rail-recent[data-tid="native:${chat.id}"]`);
    await recent.waitFor({ state: 'visible' });
    for (const fullscreen of [false, true]) {
      await page.evaluate(on => document.body.classList.toggle('is-fullscreen', on), fullscreen);
      await recent.hover();
      const more = (await recent.locator('.rail-more').boundingBox())!;
      const before = (await page.locator('#railCollapse').boundingBox())!;
      assert.ok(Math.abs((more.x + more.width / 2) - (before.x + before.width / 2)) < 1, 'sidebar toggle aligns with the hovered chat menu');
      for (const selector of ['.rail-home-new-chat', '.rail-new-project', '.rail-new-chat']) {
        const action = (await page.locator(selector).boundingBox())!;
        assert.ok(Math.abs((action.x + action.width / 2) - (before.x + before.width / 2)) < 1, `${selector} aligns with the sidebar toggle`);
      }
      await page.screenshot({ path: path.join(scratch, `sidebar-${fullscreen ? 'fullscreen' : 'windowed'}.png`) });
      await page.locator('#railCollapse').click();
      assert.equal(await page.locator('#projectsRail').isVisible(), false);
      const reopened = (await page.locator('#railReopen').boundingBox())!;
      assert.deepEqual({ y: reopened.y, width: reopened.width, height: reopened.height }, { y: before.y, width: before.width, height: before.height });
      assert.equal(await page.locator('#railReopen').getAttribute('aria-expanded'), 'false');
      assert.ok((await page.locator('#homeGrid').boundingBox())!.y >= before.y + before.height, 'toggle is above the Home card');
      await page.screenshot({ path: path.join(scratch, `home-${fullscreen ? 'fullscreen' : 'windowed'}.png`) });
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#projectsRail').isVisible(), true, 'focus transfers so keyboard can toggle back');
    }
    await page.evaluate(() => document.body.classList.remove('is-fullscreen'));
    await page.evaluate(dir => openProjectPath(dir), site);
    await page.evaluate(() => window.RadialNativeChat.createFor(agentTab()!, 'codex'));
    assert.equal(await page.locator('#nativeChatTitle').textContent(), 'Codex');
    for (const fullscreen of [false, true]) {
      await page.evaluate(on => document.body.classList.toggle('is-fullscreen', on), fullscreen);
      const before = (await page.locator('#railCollapse').boundingBox())!;
      await page.locator('#railCollapse').click();
      const reopen = (await page.locator('#railReopen').boundingBox())!;
      assert.equal(reopen.y, before.y);
      assert.equal(await page.locator('[data-rail-reopen]').count(), 0, 'no duplicate panel toggle');
      assert.equal(await page.locator('.right-dock .side-tabs').isVisible(), false, 'no empty row above Agent/Context');
      const head = page.locator('#rp-terminal > .tool-panel.homed > .tp-head');
      const agent = head.locator('[data-tpg-tab="terminal"]');
      const context = head.locator('[data-tpg-tab="context"]');
      await agent.waitFor({ state: 'visible' }); // header moves on the next layout frame
      const agentBox = (await agent.boundingBox())!;
      assert.ok(Math.abs(agentBox.y + agentBox.height / 2 - (reopen.y + reopen.height / 2)) < 1, 'Agent aligns vertically with the sidebar toggle');
      assert.ok(agentBox.x >= reopen.x + reopen.width + 8, 'tabs clear the sidebar toggle and traffic lights');
      assert.equal(await head.evaluate(el => (getComputedStyle(el) as AppRegionStyle).webkitAppRegion), 'no-drag', 'header controls remain clickable');
      await context.click();
      assert.equal(await context.getAttribute('aria-pressed'), 'true');
      await agent.click();
      await head.locator('[data-tp-add]').click();
      // A panel render for the page (its tree after a load, a selection) leaves the header as it is.
      await page.evaluate(() => renderQuickAdjust());
      assert.equal(await head.locator('[data-tp-add]').getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('Escape');
      await page.screenshot({ path: path.join(scratch, `project-collapsed-${fullscreen ? 'fullscreen' : 'windowed'}.png`) });
      await page.locator('#railReopen').click();
      assert.equal(await page.locator('#projectsRail').isVisible(), true);
      assert.ok((await agent.boundingBox())!.x > reopen.x, 'expanded header returns to its dock');
    }
    assert.deepEqual(errors, []);
    console.log('Sidebar screenshots:', scratch);
  } finally { await app.close(); }
});
