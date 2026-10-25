import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { ChatResourceAction, OpenProjectResult } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the app's window carries that this check reaches (src/renderer/globals.d.ts, types.d.ts).
/** An agent or shell session (TermSession): its xterm once mounted. */
interface TermSession { xterm?: Terminal | null }
/** The Home pseudo-tab or a project tab (types.d.ts AnyTab), as far as the terminal code goes. */
interface AnyTab { repoDir: string | null; term?: TermSession | null }
/** What a rendered reply asks of its host (ChatResponseActions); render reads only describe's src. */
interface ResponseActions {
  file: (reference: string, action: ChatResourceAction) => unknown;
  describe: (reference: string) => Promise<{ src?: string }>;
  previewImage: (item: { name: string; src: string }) => void;
}
interface AppWindow extends Window {
  /** The native chat panel (nativeChat.ts); read only in a readiness poll, which can run before nativeChat.js sets it. */
  RadialNativeChat?: { enabled(): boolean };
  RadialChatResponses: { render(body: HTMLElement, text: string, actions: ResponseActions): void };
}
declare const window: AppWindow;
declare const homeTab: AnyTab;
declare function agentTab(): AnyTab | null;
declare function openProjectPath(dir: string): Promise<OpenProjectResult & { repoDir?: string }>;
declare function mountXterm(): { el: HTMLDivElement; xterm: Terminal; fit: FitAddon };
/** The main process's global object, with the URLs this test records there instead of opening them. */
type MainGlobal = typeof globalThis & { openedExternally: string[] };

test('links in chat replies and terminals open in the default browser, never a Radial window', { timeout: 90000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-chat-links-'));
  const site = path.join(scratch, 'Links site'); fs.mkdirSync(site); fs.writeFileSync(path.join(site, 'index.html'), '<title>Links site</title><h1>Hello</h1>');
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const interactive = path.resolve('test/fixtures/native-interactive.cjs');
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'), CURSOR_CONFIG_DIR: path.join(scratch, 'cursor'), RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_CHAT_TEST_CLAUDE: interactive, RADIAL_CHAT_TEST_CURSOR: interactive, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  try {
    const page = await app.firstWindow(), errors: string[] = [], dialogs: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    // Record what would reach the default browser instead of launching it.
    await app.evaluate(({ shell }) => { (globalThis as MainGlobal).openedExternally = []; shell.openExternal = async url => { (globalThis as MainGlobal).openedExternally.push(url); }; });
    async function opened(count: number) {
      const deadline = Date.now() + 5000;
      let urls: string[] = [];
      while (Date.now() < deadline) { urls = await app.evaluate(() => (globalThis as MainGlobal).openedExternally); if (urls.length >= count) break; await delay(50); }
      return urls;
    }
    const appUrl = page.url();

    // Chat replies: a plain click and a ⌘-click.
    await page.evaluate(() => {
      const body = document.createElement('div'); body.id = 'links-test'; body.style.cssText = 'position:fixed;inset:0;z-index:10000;padding:24px;background:var(--bg-2)'; document.body.append(body);
      window.RadialChatResponses.render(body, 'Deployed to [your site](https://radial-demo.vercel.app/) and [the docs](https://radial.to/docs).', { file() {}, describe: async () => ({}), previewImage() {} });
    });
    await page.locator('#links-test p a', { hasText: 'your site' }).click();
    await page.locator('#links-test p a', { hasText: 'the docs' }).click({ modifiers: ['Meta'] });
    assert.deepEqual(await opened(2), ['https://radial-demo.vercel.app/', 'https://radial.to/docs']);
    await page.evaluate(() => document.querySelector('#links-test')!.remove());

    // Terminal output: an OSC 8 hyperlink, a plain URL ending a sentence, and a URL wrapped across rows.
    await page.evaluate(dir => openProjectPath(dir), site);
    await page.waitForFunction(() => document.querySelector('[data-chat-view="terminal"]')?.getAttribute('aria-pressed') === 'true' && agentTab()?.term?.xterm);
    const size = await page.evaluate(() => new Promise<{ cols: number; rows: number }>(resolve => {
      const { el, xterm, fit } = mountXterm();
      el.id = 'links-term'; el.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:240px;z-index:10001;display:block;background:#100c0a'; document.body.append(el); // above the app's stacking contexts
      fit.fit();
      xterm.write('\x1b]8;;https://radial-demo.vercel.app/osc\x07Open the deployment\x1b]8;;\x07\r\nInspect: https://vercel.com/radial/demo/abc123.\r\nLong: https://example.com/' + 'a'.repeat(xterm.cols) + '\r\n', () => resolve({ cols: xterm.cols, rows: xterm.rows }));
    }));
    const box = (await page.locator('#links-term .xterm-screen').boundingBox())!;
    async function clickCell(col: number, row: number) {
      const x = box.x + (col + 0.5) * box.width / size.cols, y = box.y + (row + 0.5) * box.height / size.rows;
      await page.mouse.move(x - 2, y); await delay(80); await page.mouse.move(x, y); await delay(150);
      await page.mouse.click(x, y);
    }
    await clickCell(4, 0);
    await clickCell(16, 1);
    await clickCell(4, 3);
    assert.deepEqual((await opened(5)).slice(2), ['https://radial-demo.vercel.app/osc', 'https://vercel.com/radial/demo/abc123', 'https://example.com/' + 'a'.repeat(size.cols)]);

    // A link without a target would navigate the app window itself. Last, since
    // Playwright keeps waiting on the navigation the app cancels.
    await page.evaluate(() => { const plain = document.createElement('a'); plain.id = 'plain-link'; plain.href = 'https://example.com/plain'; plain.textContent = 'Plain link'; plain.style.cssText = 'position:fixed;left:700px;top:20px;z-index:10002'; document.body.append(plain); });
    await page.locator('#plain-link').click({ noWaitAfter: true });
    assert.equal((await opened(6))[5], 'https://example.com/plain');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL()), appUrl, 'a link never navigates the app window away');

    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'no Radial window opens for a link');
    assert.deepEqual(dialogs, [], 'no confirm prompt before opening a terminal link');
    assert.deepEqual(errors, []);
  } finally { await app.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
});
