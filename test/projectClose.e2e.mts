import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Terminal } from '@xterm/xterm';
import type { ChatEngine } from '../src/shared/chatPermissions.ts';
import type { OpenProjectResult } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the app's window carries, as far as this test reaches into it inside the
// page: the window scripts' globals (the app's own declarations are
// src/renderer/globals.d.ts, types.d.ts and renderer.ts).
interface TermSession { id: string; _nativeChatId?: string | null; _exited?: boolean; _working?: boolean; xterm?: Terminal | null }
interface AgentHost { terminals?: TermSession[]; term?: TermSession | null }
interface Tab extends AgentHost { id: string; repoDir: string }
interface HomeTab extends AgentHost { id: 'home'; home: true; repoDir: string | null; terminals: TermSession[]; term: TermSession | null }
type AnyTab = Tab | HomeTab;
interface NativeChatApi {
  enabled(): boolean;
  createFor(tab: AnyTab, engine?: ChatEngine): Promise<void>;
  /** The tab's open chats as rail rows. */
  terms(tab: AnyTab | null | undefined): TermSession[];
}
declare const window: Window & typeof globalThis & { RadialNativeChat: NativeChatApi };
declare const homeTab: HomeTab;
declare function agentTab(): AnyTab | null;
declare function tabByRepo(repoDir: string | null | undefined): Tab | null;
declare function openProjectPath(dir: string): Promise<OpenProjectResult & { repoDir?: string }>;
declare function addTerminal(tab: AnyTab | null | undefined, engine: ChatEngine | null): Promise<TermSession | null>;

test('Close project from the sidebar is one step unless work would stop, and then asks inline', { timeout: 90000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-project-close-'));
  const projects = ['Idle site', 'Busy site', 'Shell site'].map(name => {
    const dir = path.join(scratch, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'index.html'), `<title>${name}</title><h1>Hello</h1>`); return dir;
  });
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const interactive = path.resolve('test/fixtures/native-interactive.cjs');
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'), CURSOR_CONFIG_DIR: path.join(scratch, 'cursor'), RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_CHAT_TEST_CLAUDE: interactive, RADIAL_CHAT_TEST_CURSOR: interactive, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(20000);
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    const isOpen = (dir: string) => page.evaluate(dir => !!tabByRepo(dir), dir);
    async function closeFromSidebar(dir: string) {
      const row = page.locator('.rail-proj:not([data-home])').filter({ hasText: path.basename(dir) });
      await row.hover(); await row.locator('.rail-more').click();
      await page.locator('#railCtxMenu [data-act="close"]').click();
    }

    // Idle: the project's Terminal chat is waiting for input. One click closes it.
    await page.evaluate(dir => openProjectPath(dir), projects[0]);
    await page.waitForFunction(() => document.querySelector('[data-chat-view="terminal"]')?.getAttribute('aria-pressed') === 'true' && agentTab()?.term?.xterm);
    await closeFromSidebar(projects[0]);
    await page.waitForFunction(dir => !tabByRepo(dir), projects[0]);
    assert.equal(await page.locator('#confirmModal').isVisible(), false, 'no dialog for an idle project');
    assert.equal(await page.locator('#projectCloseConfirm').count(), 0);

    // A chat mid-turn: the question appears in the menu's style, next to the project.
    await page.evaluate(() => localStorage.setItem('radial.chatView.project', 'chat'));
    await page.evaluate(dir => openProjectPath(dir), projects[1]);
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('#nativeChatInput')?.placeholder === 'Ask about Busy site…');
    await page.evaluate(() => window.RadialNativeChat.createFor(agentTab()!, 'codex'));
    await page.locator('#nativeChatInput').fill('Show working indicator');
    await page.locator('#nativeChatInput').press('Enter');
    await page.waitForFunction(() => window.RadialNativeChat.terms(agentTab()).some(t => t._working));
    await closeFromSidebar(projects[1]);
    const pop = page.locator('#projectCloseConfirm');
    await pop.waitFor();
    assert.match((await pop.textContent())!, /Close Busy site\?.*is still working and will stop\..*Stop and close.*Cancel/);
    assert.equal(await page.locator('#confirmModal').isVisible(), false, 'no full-window dialog from the sidebar');
    await page.screenshot({ path: path.join(scratch, 'close-working.png') });
    await pop.locator('[data-act="cancel"]').click();
    assert.equal(await pop.count(), 0); assert.ok(await isOpen(projects[1]), 'Cancel keeps the project open');
    await closeFromSidebar(projects[1]); await pop.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await pop.count(), 0); assert.ok(await isOpen(projects[1]), 'Escape keeps the project open');
    await closeFromSidebar(projects[1]); await pop.locator('[data-act="close"]').click();
    await page.waitForFunction(dir => !tabByRepo(dir), projects[1]);

    // A shell terminal cannot be brought back, so closing asks too.
    await page.evaluate(dir => openProjectPath(dir), projects[2]);
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('#nativeChatInput')?.placeholder === 'Ask about Shell site…');
    await page.evaluate(() => addTerminal(agentTab(), null));
    await page.waitForFunction(() => (agentTab()!.terminals || []).some(t => !t._nativeChatId && !t._exited));
    await closeFromSidebar(projects[2]); await pop.waitFor();
    assert.match((await pop.textContent())!, /A terminal will close, stopping anything running there\./);
    await pop.locator('[data-act="close"]').click();
    await page.waitForFunction(dir => !tabByRepo(dir), projects[2]);
    assert.deepEqual(errors, []);
    console.log('Project close screenshots:', scratch);
  } finally { await app.close(); }
});
