/// <reference path="../src/renderer/types.d.ts" />
// The window's own shapes (AnyTab, Tab, TermSession, RadialNativeChatApi) come from types.d.ts above.
//
// A chat owns a view of the preview (threadPreview.ts), and so does its terminal
// once the window first shows it: a record of its own, which takes the chat's
// view over (restore in renderer.ts threadPreviewFor). That restore navigated
// the preview to the route it was already on. The page didn't reload, but
// loadRoute closes what is open over the preview: Settings and the quick-edit
// pill closed whenever a chat's terminal came up for the first time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { OpenProjectOptions, OpenProjectResult, RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

declare const window: Window & typeof globalThis & { radial: RadialApi; RadialNativeChat: RadialNativeChatApi };
// renderer.ts's top-level declarations, which page functions reach by name.
declare const homeTab: HomeTab;
declare let quickEdit: object | null;
declare function agentTab(): AnyTab | null;
declare function activeTab(): Tab | null;
declare function openProjectPath(dir: string, opts?: OpenProjectOptions): Promise<OpenProjectResult & { repoDir?: string }>;
declare function setCanvasMode(mode: 'select'): void;
declare function askBackToFloating(): void;
declare function openSettings(mode?: 'global' | 'project'): void;

// Polls check() every 100 ms until it answers something truthy, and fails with the
// label and its last answer after ms.
const until = async <T,>(label: string, ms: number, check: () => Promise<T>): Promise<NonNullable<T>> => {
  const t0 = Date.now(); let last: unknown;
  for (;;) {
    try { const value = await check(); if (value) return value; last = value; } catch (e) { last = (e as Error).message; }
    if (Date.now() - t0 >= ms) throw new Error(`timed out after ${ms} ms waiting for ${label} (last: ${JSON.stringify(last)})`);
    await new Promise(r => setTimeout(r, 100));
  }
};
// The chat's terminal is on screen and has taken the chat's view over: the terminal
// record the window made for it is the project's active one, selected for the
// preview (previewSelectedAt), and no restore or navigation is still running.
const terminalShown = (page: Page, id: string) => until(`chat ${id}'s terminal on screen`, 20000, () => page.evaluate(async id => {
  const session = await window.radial.nativeChatGet(id), tab = activeTab()!;
  const term = (tab.terminals || []).find(t => t._nativeChatId === id && t.id === session.terminalId);
  return !!term && tab.activeTerminalId === term.id && !!term.previewSelectedAt && window.RadialNativeChat.visibleId() === id
    && !tab._threadPreview?.restoring && !tab._nav;
}, id));

test('a chat\'s terminal shown for the first time leaves Settings and the quick-edit pill open', { timeout: 90000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-chat-terminal-preview-'));
  const site = path.join(scratch, 'Site'); fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><html><head><title>Site</title></head><body><h1 id="hero">Marketing site</h1></body></html>');
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const interactive = path.resolve('test/fixtures/native-interactive.cjs');
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'), CURSOR_CONFIG_DIR: path.join(scratch, 'cursor'), RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_CHAT_TEST_CLAUDE: interactive, RADIAL_CHAT_TEST_CURSOR: interactive, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(20000);
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    // Chat view first, so each chat's terminal comes up later, on its own.
    await page.evaluate(() => localStorage.setItem('radial.chatView.project', 'chat'));
    await page.evaluate(dir => openProjectPath(dir), site);
    await page.waitForFunction(() => { const tab = activeTab(); return !!tab?._previewReady && /^http/.test(tab.webview.getURL()) && !tab._nav; });
    const repoDir = await page.evaluate(() => agentTab()!.repoDir!);

    // 1. The quick-edit pill on the heading, then the chat switched to its terminal
    //    (a click() alone: a pointer press outside the preview closes the pill by design).
    await page.evaluate(() => window.RadialNativeChat.createFor(agentTab()!, 'claude'));
    const chat = (await page.locator('#nativeChatToolbar').getAttribute('data-chat-id'))!;
    await page.evaluate(() => { setCanvasMode('select'); askBackToFloating(); activeTab()!.webview.send('radial:select-node', { selector: '#hero' }); });
    await page.locator('#qeInput').waitFor();
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-chat-view="terminal"]')!.click());
    await terminalShown(page, chat);
    await page.waitForTimeout(300); // anything the switch would still close has closed by now
    assert.equal(await page.evaluate(() => !!quickEdit), true, 'the selection is kept');
    assert.equal(await page.locator('#qeInput').isVisible(), true, 'the quick-edit pill stays open');

    // 2. Another chat on screen in Chat view, Settings open over the preview, then that
    //    chat's terminal comes up for the first time. Settings makes the agent column
    //    inert to the pointer; a click() still runs the switch, as the window's own
    //    paths (a launch restoring a chat left in Terminal, the agent lane) do.
    await page.keyboard.press('Escape'); // the pill goes; Settings is the next check
    await page.evaluate(() => localStorage.setItem('radial.chatView.project', 'chat')); // switching chat 1 remembered Terminal
    await page.evaluate(() => window.RadialNativeChat.createFor(agentTab()!, 'claude'));
    const other = (await page.locator('#nativeChatToolbar').getAttribute('data-chat-id'))!;
    assert.notEqual(other, chat);
    assert.equal(await page.locator('#nativeChatPanel').isVisible(), true, 'the second chat starts in Chat view');
    await page.evaluate(() => openSettings('global'));
    await page.locator('#settingsView').waitFor({ state: 'visible' });
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-chat-view="terminal"]')!.click());
    await terminalShown(page, other);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#settingsView').isVisible(), true, 'Settings stays open');
    assert.equal(await page.evaluate(() => document.body.classList.contains('settings-open')), true);
    assert.equal(await page.evaluate(() => activeTab()!.currentRoute), '/', 'the preview stayed on its page');
    assert.equal((await page.evaluate(dir => window.radial.nativeChatList(dir), repoDir)).length, 2);
    assert.deepEqual(errors, []);
  } finally { await app.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
});
