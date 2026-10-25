/// <reference path="../src/renderer/types.d.ts" />
// The window's own shapes (AnyTab, TermSession, RadialNativeChatApi) come from types.d.ts above.
//
// Opening a project with chats on starts its first chat (refresh → switchView in
// nativeChat.ts). Anything picked while that chat is still starting stays on
// screen, and the first chat, never shown and never used, is not left beside it.
// The test holds the first chat at fixed points so each race happens every run:
// at its first step (choosing the engine, through the window's
// engineAvailability), and while its terminal waits for the project's terminal
// list (tab._terminalsReady).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { OpenProjectOptions, OpenProjectResult, RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

/** What the test parks on the window: the held first chat, the held terminal list, and a createFor still running. */
interface Held { started: boolean; release: () => void }
declare const window: Window & typeof globalThis & { radial: RadialApi; RadialNativeChat: RadialNativeChatApi; __hold?: Held; __list?: () => void; __created?: Promise<unknown> };
// renderer.ts's top-level declarations, which page functions reach by name.
declare const homeTab: HomeTab;
declare function agentTab(): AnyTab | null;
declare function openProjectPath(dir: string, opts?: OpenProjectOptions): Promise<OpenProjectResult & { repoDir?: string }>;
declare function addTerminal(tab: AnyTab | null | undefined, engine: ChatEngine | null): Promise<TermSession | null>;
declare let engineAvailability: () => Promise<Partial<Record<ChatEngine, boolean>>>;

// The next first chat waits at its first step (choosing its engine) until released.
const holdFirstChat = (page: Page) => page.evaluate(() => {
  const real = engineAvailability;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  window.__hold = { started: false, release };
  engineAvailability = async () => { engineAvailability = real; window.__hold!.started = true; await gate; return real(); };
});
// Polls from here: a page predicate that returns a promise counts as truthy at once.
const until = async <T,>(label: string, fn: () => Promise<T>): Promise<NonNullable<T>> => {
  for (const t0 = Date.now(); ; await new Promise(resolve => setTimeout(resolve, 100))) {
    const value = await fn(); if (value) return value;
    if (Date.now() - t0 > 20000) throw new Error('timed out: ' + label);
  }
};
const projectChats = (page: Page, repoDir: string) => page.evaluate(dir => window.radial.nativeChatList(dir, true), repoDir);
// The project's selected chat once it is another than `before`: select() saves a pick
// before anything else (localStorage radial.selectedChats).
const selection = (page: Page, repoDir: string, before?: string) => page.waitForFunction(({ dir, before }) => { const id = (JSON.parse(localStorage.getItem('radial.selectedChats') || '[]') as [string, string][]).find(([key]) => key === dir)?.[1]; return id !== before && id; }, { dir: repoDir, before }).then(handle => handle.jsonValue() as Promise<string>);
// render() marks the chat toolbar busy while a view switch (the first chat's start) runs.
const settled = (page: Page) => page.waitForFunction(() => document.getElementById('nativeChatToolbar')!.getAttribute('aria-busy') === 'false');

test('a project\'s first chat stands down for a chat or terminal picked while it starts', { timeout: 90000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-first-chat-'));
  const sites = ['First site', 'Second site', 'Third site'].map(name => {
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
    const open = async (dir: string) => { await page.evaluate(dir => openProjectPath(dir), dir); await page.waitForFunction(() => window.__hold?.started); return page.evaluate(() => agentTab()!.repoDir!); };

    // 1. A chat created (the sidebar's New chat) before the first chat is made: no first chat at all.
    await holdFirstChat(page);
    let repoDir = await open(sites[0]);
    await page.evaluate(() => { window.__created = window.RadialNativeChat.createFor(agentTab()!, 'codex'); });
    const picked = await selection(page, repoDir);
    await page.evaluate(() => window.__hold!.release());
    await page.evaluate(() => window.__created);
    assert.equal(await page.locator('#nativeChatToolbar').getAttribute('data-chat-id'), picked, 'the picked chat is on screen');
    assert.equal(await page.locator('#nativeChatTitle').textContent(), 'Codex');
    await settled(page);
    assert.deepEqual((await projectChats(page, repoDir)).map(s => s.id), [picked], 'no first chat beside the picked one');

    // 2. A terminal shown (Shell / other CLI) while the first chat waits: the terminal stays, no chat starts.
    await holdFirstChat(page);
    repoDir = await open(sites[1]);
    const shell = await page.evaluate(async () => (await addTerminal(agentTab(), null))!.id);
    await page.evaluate(() => window.__hold!.release());
    await settled(page);
    await page.waitForTimeout(300); // anything the first chat would still show lands by now
    const pane = await page.evaluate(id => { const tab = agentTab()!; return { active: tab.activeTerminalId === id, shown: !!tab.terminals!.find(t => t.id === id)!.el!.classList.contains('active'), chat: window.RadialNativeChat.visibleId(), chatPanel: !document.getElementById('nativeChatPanel')!.hidden }; }, shell);
    assert.deepEqual(pane, { active: true, shown: true, chat: null, chatPanel: false }, 'the shell stays on screen');
    assert.deepEqual(await projectChats(page, repoDir), [], 'no first chat beside the shell');

    // 3. A chat created after the first chat's CLI started, while its terminal waits for the
    //    project's terminal list: the created chat shows, and the first chat is deleted with its CLI.
    await holdFirstChat(page);
    repoDir = await open(sites[2]);
    await page.evaluate(() => {
      const tab = agentTab()!, listed = tab._terminalsReady;
      tab._terminalsReady = new Promise<void>(resolve => { window.__list = resolve; }).then(() => listed);
      window.__hold!.release();
    });
    const { id: first, terminalId: firstPty } = await until('the first chat\'s CLI', async () => (await projectChats(page, repoDir)).find(s => s.terminalId));
    await page.evaluate(() => { window.__created = window.RadialNativeChat.createFor(agentTab()!, 'codex'); });
    const created = await selection(page, repoDir, first); // the first chat saved itself as the selection when it loaded
    await page.evaluate(() => window.__list!());
    await page.evaluate(() => window.__created);
    await settled(page);
    assert.equal(await page.locator('#nativeChatToolbar').getAttribute('data-chat-id'), created, 'the created chat is on screen');
    assert.deepEqual((await projectChats(page, repoDir)).map(s => s.id), [created], 'the first chat is gone, not left beside it');
    await until('the first chat\'s CLI stops', async () => !(await page.evaluate(dir => window.radial.termList(dir), repoDir)).some(t => t.id === firstPty && t.alive !== false));
    assert.equal(await page.locator(`[data-tid="native:${first}"]`).count(), 0, 'and from the sidebar');
    assert.deepEqual(errors, []);
  } finally { await app.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
});
