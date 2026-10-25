import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ChatEngine } from '../src/shared/chatPermissions.ts';
import type { ChatSession, ChatSummary, OpenProjectResult, RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the app's window carries, as far as this test reaches into it inside the
// page: the preload's API and the window scripts' globals (the app's own
// declarations are src/renderer/globals.d.ts, types.d.ts and renderer.ts).
interface Tab { id: string; repoDir: string; baseUrl: string | null }
interface HomeTab { id: 'home'; home: true; repoDir: string | null }
type AnyTab = Tab | HomeTab;
interface NativeChatApi {
  enabled(): boolean;
  createFor(tab: AnyTab, engine?: ChatEngine): Promise<void>;
  /** Every chat with its rail stand-in, for Recent. */
  history(): { session: ChatSummary | ChatSession }[];
}
declare const window: Window & typeof globalThis & { radial: RadialApi; RadialNativeChat: NativeChatApi };
declare const homeTab: HomeTab;
declare function agentTab(): AnyTab | null;
declare function tabByRepo(repoDir: string | null | undefined): Tab | null;
declare function openProjectPath(dir: string): Promise<OpenProjectResult & { repoDir?: string }>;
declare function closeTab(id: string | null, opts?: { confirm?: boolean; force?: boolean; anchor?: HTMLElement | null }): Promise<void>;

test('Recents preserves closed chats and projects across restarts and restores the same conversation', { timeout: 120000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-chat-recents-'));
  const projects = ['First site', 'Second site'].map(name => {
    const dir = path.join(scratch, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'index.html'), `<title>${name}</title><h1>Hello</h1>`); return dir;
  });
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const launch = () => launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  let app = await launch(); const errors: string[] = [];
  const ready = async () => { const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message)); await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir); return page; };
  const row = (page: Page, id: string) => page.locator(`.rail-recent[data-tid="native:${id}"]`);
  const selected = async (page: Page, id: string) => page.waitForFunction(id => document.querySelector<HTMLElement>('#nativeChatToolbar')?.dataset.chatId === id && !document.querySelector<HTMLButtonElement>('[data-chat-view="chat"]')?.disabled, id);
  try {
    let page = await ready();
    await page.evaluate(() => localStorage.setItem('radial.chatView.project', 'chat')); // This covers the Chat view; projects open in Terminal by default.
    await page.evaluate(dir => openProjectPath(dir), projects[0]);
    await page.evaluate(() => window.RadialNativeChat.createFor(agentTab()!, 'codex'));
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#nativeChatToolbar')?.dataset.chatId);
    const first = (await page.locator('#nativeChatToolbar').getAttribute('data-chat-id'))!;
    await page.locator('#nativeChatInput').fill('Rich response demo for the first project');
    await page.locator('#nativeChatInput').press('Enter');
    for (let attempt = 0; attempt < 100; attempt++) {
      const chat = await page.evaluate(id => window.radial.nativeChatGet(id), first);
      if (chat.state === 'idle' && chat.threadId && chat.messages.some(m => m.role === 'assistant')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const before = await page.evaluate(id => window.radial.nativeChatGet(id), first);
    assert.ok(before.threadId); assert.equal(before.state, 'idle');
    await page.evaluate(dir => openProjectPath(dir), projects[1]);
    await page.waitForFunction(id => document.querySelector<HTMLElement>('#nativeChatToolbar')?.dataset.chatId !== id, first);
    await page.evaluate(dir => closeTab(tabByRepo(dir)!.id, { force: true }), projects[0]);
    await row(page, first).waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(dir => !!tabByRepo(dir), projects[0]), false);
    await row(page, first).click(); await page.locator('#confirmCancel').click();
    assert.equal(await page.evaluate(dir => !!tabByRepo(dir), projects[0]), false);
    await row(page, first).click(); await page.locator('#confirmOk').click(); await selected(page, first);
    assert.equal((await page.evaluate(id => window.radial.nativeChatGet(id), first)).threadId, before.threadId);
    assert.ok(await page.evaluate(dir => !!tabByRepo(dir)?.baseUrl, projects[0]), 'reopened project starts its preview');
    await row(page, first).hover();
    await row(page, first).locator('.rail-more').click();
    await page.getByText('Close chat', { exact: true }).click();
    await page.waitForFunction(id => window.RadialNativeChat.history().find(entry => entry.session.id === id)?.session.archived, first);
    await row(page, first).waitFor({ state: 'visible' });
    await page.waitForFunction(id => !document.querySelector(`.rail-term[data-tid="native:${id}"]`), first);
    await row(page, first).click(); await selected(page, first);
    const restored = await page.evaluate(id => window.radial.nativeChatGet(id), first);
    assert.equal(restored.archived, false); assert.equal(restored.threadId, before.threadId);
    assert.deepEqual(restored.messages, before.messages);
    await page.evaluate(dir => closeTab(tabByRepo(dir)!.id, { force: true }), projects[0]);
    await app.close(); app = await launch(); page = await ready();
    await row(page, first).waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(dir => !!tabByRepo(dir), projects[0]), false);
    await row(page, first).click(); await page.locator('#confirmOk').click(); await selected(page, first);
    const reopened = await page.evaluate(id => window.radial.nativeChatGet(id), first);
    assert.equal(reopened.threadId, before.threadId); assert.deepEqual(reopened.messages, before.messages);
    assert.deepEqual(errors, []);
  } finally { await app.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
});
