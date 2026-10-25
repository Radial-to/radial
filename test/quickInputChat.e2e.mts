import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebviewTag } from 'electron';
import type { ChatMessage, OpenProjectResult, RadialApi } from '../src/shared/radialApi.ts';
import type { ChatEngine } from '../src/shared/chatPermissions.ts';
import { launchApp } from './support/app.ts';

// The window's globals the test calls (renderer.ts and nativeChat.js), as far
// as it uses them.
/** A project tab: its terminals are absent until they're listed or one starts. */
interface ProjectTab { repoDir: string; webview: WebviewTag; terminals?: { _exited?: boolean }[] }
/** The tab the agent works in: a project tab, or Home (whose folder may not be known yet). */
interface AgentTab { repoDir: string | null }
declare function openProjectPath(dir: string): Promise<OpenProjectResult & { repoDir?: string }>;
declare function activeTab(): ProjectTab | null;
declare function agentTab(): AgentTab | null;
declare function setCanvasMode(mode: 'select'): void;
declare function askPinToDock(): void;
declare function askBackToFloating(): void;
declare let quickEdit: { sels: { selector: string }[]; images?: { abs: string }[] } | null;
declare let quickEditSending: boolean;
declare const window: Window & typeof globalThis & {
  radial: RadialApi;
  RadialNativeChat: { createFor(tab: AgentTab, engine?: ChatEngine): Promise<void> };
};

// Polls check() every 100 ms until it answers something truthy, and fails with the
// label and its last answer after ms. page.waitForFunction can't wait on an async
// check: the promise it returns is truthy, so it stops at the first poll.
const until = async <T,>(label: string, ms: number, check: () => Promise<T>): Promise<NonNullable<T>> => {
  const t0 = Date.now(); let last: unknown;
  for (;;) {
    try { const value = await check(); if (value) return value; last = value; } catch (e) { last = (e as Error).message; }
    if (Date.now() - t0 >= ms) throw new Error(`timed out after ${ms} ms waiting for ${label} (last: ${JSON.stringify(last)})`);
    await new Promise(r => setTimeout(r, 100));
  }
};

test('quick input sends element context to the chosen native conversation and preserves blocked drafts', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-quick-chat-'));
  const repo = path.join(root, 'site'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'index.html'), '<html><body><h1 id="hero">Marketing site</h1></body></html>');
  const image = path.join(repo, 'reference.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'));
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.resolve('node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: path.join(root, 'profile'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1', RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs') } });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(() => typeof openProjectPath === 'function');
    await page.evaluate(() => localStorage.setItem('radial.chatView.project', 'chat')); // This covers the Chat view; projects open in Terminal by default.
    await page.evaluate(dir => openProjectPath(dir), repo);
    await page.waitForFunction(() => activeTab()?.webview && !activeTab()!.webview.isLoading() && /^http/.test(activeTab()!.webview.getURL()));
    await page.evaluate(async () => { await window.RadialNativeChat.createFor(agentTab()!, 'codex'); await window.RadialNativeChat.createFor(agentTab()!, 'codex'); });
    const id = (await page.locator('#nativeChatToolbar').getAttribute('data-chat-id'))!;
    await page.locator('#nativeChatInput').fill('Keep this separate unsent draft');
    const choose = async (pinned: boolean) => {
      await page.evaluate(pinned => { setCanvasMode('select'); if (pinned) askPinToDock(); else askBackToFloating(); activeTab()!.webview.send('radial:select-node', { selector: '#hero' }); }, pinned);
      const input = page.locator(pinned ? '[data-tpa-input]' : '#qeInput'); await input.waitFor();
      return input;
    };
    for (const pinned of [false, true]) {
      const input = await choose(pinned);
      await input.fill(pinned ? 'Make this blue' : 'Make this heading shorter');
      const target = page.locator(pinned ? '[data-tpa-model]' : '#qeModel');
      assert.equal(await target.inputValue(), 'term:native:' + id, 'defaults to the selected native chat');
      await page.evaluate(image => { quickEdit!.images = [{ abs: image }]; }, image);
      await input.press('Enter');
      await page.waitForFunction(() => !quickEditSending);
      await page.waitForFunction(() => !quickEdit);
      const session = await page.evaluate(id => window.radial.nativeChatGet(id), id);
      const message = session.messages.filter(m => m.role === 'user').at(-1) as ChatMessage & { sourceText: string };
      assert.match(message.sourceText, /#hero/); assert.match(message.sourceText, /Marketing site/); assert.ok(message.sourceText.includes(image));
      assert.equal(await page.locator('#nativeChatInput').inputValue(), 'Keep this separate unsent draft');
      assert.equal(await page.evaluate(async dir => (await window.radial.nativeChatList(dir)).length, repo), 2, 'no extra conversation created');
      assert.equal(await page.evaluate(() => (activeTab()!.terminals || []).filter(t => !t._exited).length), 0, 'no unrelated terminal launched');
      const retry = await choose(pinned); await retry.fill('Keep this blocked request');
      await retry.press('Enter'); await page.waitForFunction(() => !quickEditSending);
      assert.equal(await retry.inputValue(), 'Keep this blocked request');
      assert.match(await page.evaluate(() => quickEdit!.sels[0].selector), /#hero$/);
      await page.locator('#nativeChatApproval [data-decision="accept"]').click();
      await until('the chat to finish its turn', 10000, () => page.evaluate(async id => !['working', 'approval'].includes((await window.radial.nativeChatGet(id)).state), id));
    }
    const staged = await choose(false); await staged.fill('Stage this visual change');
    await staged.press('Meta+Enter');
    await page.waitForFunction(() => !quickEdit);
    const draft = await page.locator('#nativeChatInput').inputValue();
    assert.match(draft, /Keep this separate unsent draft/); assert.match(draft, /Stage this visual change/); assert.match(draft, /#hero/);
    assert.equal((await page.evaluate(id => window.radial.nativeChatGet(id), id)).messages.filter(m => m.role === 'user').length, 2, 'stage does not submit');
    assert.deepEqual(errors, []);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
