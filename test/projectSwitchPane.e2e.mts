/// <reference path="../src/renderer/types.d.ts" />
// The window's own shapes (Tab, AnyTab, HomeTab, ElementById, RadialNativeChatApi) come from types.d.ts above.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenProjectOptions, OpenProjectResult } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

/**
 * The app window (page functions run there): the global this test uses (src/renderer/globals.d.ts),
 * read only through ?. while the page may not have loaded nativeChat.js yet.
 */
declare const window: Window & typeof globalThis & { RadialNativeChat?: RadialNativeChatApi };
// renderer.ts's top-level declarations, which page functions reach by name.
declare const homeTab: HomeTab;
declare function tabByRepo(repoDir: string | null | undefined): Tab | null;
declare function agentTab(): AnyTab | null;
declare function switchTab(id: string): Promise<void>;
declare function openProjectPath(dir: string, opts?: OpenProjectOptions): Promise<OpenProjectResult & { repoDir?: string }>;
declare function $<K extends string>(id: K): ElementById<K>;

test('switching projects swaps the agent pane at once instead of leaving the previous terminal up', { timeout: 90000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-switch-pane-'));
  const projects = ['First site', 'Second site', 'Third site'].map(name => {
    const dir = path.join(scratch, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'index.html'), `<title>${name}</title><h1>${name}</h1>`); return dir;
  });
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const interactive = path.resolve('test/fixtures/native-interactive.cjs');
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'), CURSOR_CONFIG_DIR: path.join(scratch, 'cursor'), RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_CHAT_TEST_CLAUDE: interactive, RADIAL_CHAT_TEST_CURSOR: interactive, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(20000);
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    const attached = (dir: string) => page.waitForFunction(dir => { const tab = tabByRepo(dir); return tab && agentTab() === tab && tab.term?.el?.classList.contains('active') && tab.term.xterm && $('termOpening').hidden; }, dir);
    for (const dir of projects.slice(0, 2)) { await page.evaluate(dir => openProjectPath(dir), dir); await attached(dir); }
    // Second → First: First's terminal is already mounted, so it shows synchronously.
    const back = await page.evaluate(dirs => {
      const [first, second] = dirs.map(d => tabByRepo(d));
      switchTab(first!.id); // not awaited: inspect what the pane shows before the dev server answers
      return { firstActive: first!.term!.el!.classList.contains('active'), secondActive: second!.term!.el!.classList.contains('active'), opening: !$('termOpening').hidden };
    }, projects.slice(0, 2));
    assert.deepEqual(back, { firstActive: true, secondActive: false, opening: false });
    await attached(projects[0]);
    // A project whose session is not attached yet shows the placeholder, never the old terminal.
    await page.evaluate(dir => openProjectPath(dir), projects[2]);
    const opening = await page.evaluate(dirs => {
      const first = tabByRepo(dirs[0]), third = tabByRepo(dirs[1]);
      return { firstActive: first!.term!.el!.classList.contains('active'), activeCount: document.querySelectorAll('.term-instance.active').length, thirdMounted: !!third?.term?.xterm, text: $('termOpening').hidden ? '' : $('termOpening').textContent };
    }, [projects[0], projects[2]]);
    assert.equal(opening.firstActive, false, 'the previous project terminal is hidden while the new one opens');
    if (!opening.thirdMounted) assert.equal(opening.text, 'Opening Third site…');
    await attached(projects[2]);
    assert.equal(await page.locator('.term-instance.active').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await app.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
});
