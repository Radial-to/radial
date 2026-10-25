import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { Terminal } from '@xterm/xterm';
import type { ChatView, OpenProjectResult, OpenedProject, RadialApi } from '../src/shared/radialApi.ts';
import type { ChatEngine } from '../src/shared/chatPermissions.ts';
import { launchApp } from './support/app.ts';

// What the app's window has that this test reaches inside page.evaluate: the
// preload's API, the native chat (nativeChat.ts) and window scripts' top-level
// declarations (src/renderer/globals.d.ts and types.d.ts have the full types).
// They are declared as always there; the boot poll still guards them, because
// firstWindow() can resolve before the window's scripts have run.
/** A terminal in a tab's list (renderer TermSession), the fields read here. */
interface PageTerm { xterm?: Terminal | null }
/** A project, or Home's agent (renderer AnyTab), the fields read here. */
interface PageAnyTab { repoDir: string | null; term?: PageTerm | null }
/** The native chat's window API (renderer RadialNativeChatApi), the methods called here. */
interface NativeChatApi { enabled(): boolean; createFor(tab: PageAnyTab, engine?: ChatEngine): Promise<void>; select(id: string): Promise<void> }
/** openProjectPath's answer (renderer OpenProjectResultWithDir), its error readable on either branch (OpenedProject has no `error?: undefined` of its own yet). */
type OpenResult = (OpenedProject & { error?: undefined }) | (Extract<OpenProjectResult, { ok: false }> & { repoDir?: string });
declare const window: Window & typeof globalThis & { radial: RadialApi; RadialNativeChat: NativeChatApi };
declare const homeTab: PageAnyTab;
declare function agentTab(): PageAnyTab | null;
declare function showHome(): void;
declare function initHomeTab(): Promise<void>;
declare function showHomeDock(): void;
declare function openProjectPath(dir: string): Promise<OpenResult>;

test('Projects open chats in Terminal, Home opens Chat, and each remembers its own choice across restarts', { timeout: 120000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-chat-view-'));
  const projects = ['First site', 'Second site'].map(name => {
    const dir = path.join(scratch, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'index.html'), `<title>${name}</title><h1>Hello</h1>`); return dir;
  });
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  // A Terminal-first chat starts the machine's default agent; every provider runs a fixture.
  const interactive = path.resolve('test/fixtures/native-interactive.cjs');
  const launch = () => launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'), CURSOR_CONFIG_DIR: path.join(scratch, 'cursor'), RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_CHAT_TEST_CLAUDE: interactive, RADIAL_CHAT_TEST_CURSOR: interactive, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  let app = await launch();
  const errors: string[] = [];
  async function pageReady() {
    const page = await app.firstWindow(); page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    return page;
  }
  async function view(page: Page, mode: ChatView) {
    await page.waitForFunction(mode => {
      const button = document.querySelector<HTMLButtonElement>(`[data-chat-view="${mode}"]`);
      return button?.getAttribute('aria-pressed') === 'true' && !button.disabled && !document.querySelector<HTMLButtonElement>('[data-chat-view="chat"]')!.disabled;
    }, mode, { timeout: 20000 });
    if (mode === 'terminal') await page.waitForFunction(() => agentTab()?.term?.xterm, null, { timeout: 20000 });
  }
  // The chat panel follows the active context on its own refresh; wait for it.
  const placeholder = (page: Page, text: string) => page.waitForFunction(text => document.querySelector<HTMLTextAreaElement>('#nativeChatInput')?.placeholder === text, text);
  async function home(page: Page) { await page.evaluate(async () => { showHome(); await initHomeTab(); showHomeDock(); }); await placeholder(page, 'Ask your workspace…'); }
  async function open(page: Page, dir: string) { await page.evaluate(dir => openProjectPath(dir), dir); await placeholder(page, `Ask about ${path.basename(dir)}…`); }
  const chatId = (page: Page) => page.locator('#nativeChatToolbar').getAttribute('data-chat-id');
  const stored = (page: Page) => page.evaluate(() => [localStorage.getItem('radial.chatView.project'), localStorage.getItem('radial.chatView.home')]);
  try {
    let page = await pageReady();
    await home(page); await view(page, 'chat');
    assert.equal(await chatId(page), '', 'Home opens as Chat and starts nothing until you send');
    await open(page, projects[0]); await view(page, 'terminal');
    const first = await chatId(page);
    assert.ok(first, 'a project opens its conversation in Terminal');
    assert.deepEqual(await stored(page), [null, null], 'defaults are not saved as choices');
    await open(page, projects[1]); await view(page, 'terminal');
    const second = await chatId(page);
    assert.notEqual(first, second);
    await page.evaluate(() => window.RadialNativeChat.createFor(agentTab()!)); await view(page, 'terminal');
    const third = await chatId(page);
    assert.notEqual(second, third, 'new chats inherit the project view');
    await page.locator('[data-chat-view="chat"]').click(); await view(page, 'chat');
    assert.deepEqual(await stored(page), ['chat', null]);
    await page.locator('#nativeChatInput').fill('Keep this second-site draft');
    await page.evaluate(id => window.RadialNativeChat.select(id), first); await view(page, 'chat');
    assert.equal((await page.evaluate(id => window.radial.nativeChatGet(id), first)).viewMode, 'chat', 'an existing Terminal session hands back to Chat');
    await home(page); await view(page, 'chat');
    await page.locator('[data-chat-view="terminal"]').click(); await view(page, 'terminal');
    assert.deepEqual(await stored(page), ['chat', 'terminal'], 'Home keeps its own choice');
    await page.evaluate(id => window.RadialNativeChat.select(id), third!); await view(page, 'chat');
    assert.equal(await page.locator('#nativeChatInput').inputValue(), 'Keep this second-site draft');
    await app.close(); app = await launch(); page = await pageReady();
    await open(page, projects[1]); await view(page, 'chat');
    await home(page); await view(page, 'terminal');
    await open(page, projects[0]); await view(page, 'chat');
    await page.locator('[data-chat-view="terminal"]').click(); await view(page, 'terminal');
    await app.close(); app = await launch(); page = await pageReady();
    await open(page, projects[1]); await view(page, 'terminal');
    assert.deepEqual(await stored(page), ['terminal', 'terminal']);
    assert.deepEqual(errors, []);
  } finally { await app.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
});
