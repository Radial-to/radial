/// <reference path="../src/renderer/types.d.ts" />
// The window's own shapes (HomeTab, ChatResponseActions, RadialNativeChatApi) come from types.d.ts above.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenProjectOptions, OpenProjectResult, RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

/**
 * A chat response's actions (types.d.ts ChatResponseActions), with describe answering what render
 * reads: it shows a described image only when it has a src, so these tests' stubs answer {} or a name and src.
 * Use ChatResponseActions itself once its describe allows that.
 */
type ResponseActions = Omit<ChatResponseActions, 'describe'> & { describe(reference: string): Promise<{ name?: string; src?: string }> };
/**
 * The app window (page functions run there): the globals these tests use (src/renderer/globals.d.ts), and the one a test sets.
 * RadialNativeChat is read only through ?., while the page may not have loaded nativeChat.js yet.
 */
declare const window: Window & typeof globalThis & {
  radial: RadialApi;
  RadialNativeChat?: RadialNativeChatApi;
  RadialChatResponses: { render(body: HTMLElement, text: string, actions: ResponseActions): void };
  __previewedImage?: string;
};
// renderer.ts's top-level declarations, which page functions reach by name.
declare const homeTab: HomeTab;
declare function showHomeDock(): void;
declare function openProjectPath(dir: string, opts?: OpenProjectOptions): Promise<OpenProjectResult & { repoDir?: string }>;

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

test('rich responses preserve useful content without allowing active markup', { timeout: 60000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-chat-rich-'));
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  try {
    const page = await app.firstWindow(); page.on('pageerror', error => console.error(error.message)); await page.waitForFunction(() => window.RadialChatResponses && typeof showHomeDock === 'function');
    await page.evaluate(() => {
      const body = document.createElement('div'); body.id = 'response-test'; body.style.cssText = 'position:fixed;inset:0;z-index:10000;overflow:auto;padding:24px;background:var(--bg-2)'; document.body.append(body);
      const text = '| Name | Status |\n| --- | --- |\n| Site | Ready |\n\n- [x] Done\n  - Child\n\n```js\nconst ready = true;\n```\n\n[File](<./hello world.md:12>)\n\n[Bad](javascript:alert(1))\n\n<img src=x onerror="alert(1)">';
      window.RadialChatResponses.render(body, text, { file() {}, describe: async () => ({}), previewImage() {} });
    });
    assert.equal(await page.locator('#response-test table tbody td').first().textContent(), 'Site');
    assert.equal(await page.locator('#response-test input[type=checkbox]:checked:disabled').count(), 1);
    assert.equal(await page.locator('#response-test li ul li').count(), 1);
    assert.equal(await page.locator('#response-test .hljs-keyword').textContent(), 'const');
    assert.equal(await page.locator('#response-test button[aria-label="Copy code"]').count(), 1);
    assert.equal(await page.locator('#response-test .chat-file').count(), 1);
    assert.equal(await page.locator('#response-test [href^="javascript:"], #response-test img, #response-test [onerror]').count(), 0);
    await page.evaluate(() => {
      const body = document.querySelector<HTMLDivElement>('#response-test')!;
      window.RadialChatResponses.render(body, '![Reference](reference.png)', {
        file() {}, describe: async () => ({ name: 'reference.png', src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==' }),
        previewImage: item => { window.__previewedImage = item.name; },
      });
    });
    await page.getByRole('button', { name: 'Preview Reference', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__previewedImage), 'reference.png');
  } finally { await app.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('a first-message draft and attachments survive creating its Terminal view', { timeout: 60000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-chat-first-view-'));
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    await page.evaluate(() => showHomeDock());
    await page.locator('#nativeChatInput').fill('Keep my first draft');
    await page.locator('#nativeChatForm input[type=file]').setInputFiles({ name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('First attachment') });
    await page.locator('.chat-context-chip').waitFor();
    await page.locator('[data-chat-view="terminal"]').click();
    await page.locator('#nativeChatPanel').waitFor({ state: 'hidden' });
    await page.locator('[data-chat-view="chat"]').click();
    await page.locator('#nativeChatPanel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#nativeChatInput').inputValue(), 'Keep my first draft');
    assert.match((await page.locator('.chat-context-chip').textContent())!, /first.txt/);
    assert.equal(await page.locator('.native-chat-message').count(), 0);
  } finally { await app.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('chat composer supports attachments, file context, queueing and choices outside its input', { timeout: 60000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-chat-capabilities-'));
  const repo = path.join(scratch, 'site'); fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'index.html'), '<title>Chat QA</title><h1>Hello</h1>');
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    await page.evaluate(() => localStorage.setItem('radial.chatView.project', 'chat')); // This covers the Chat view; projects open in Terminal by default.
    await page.evaluate(dir => openProjectPath(dir), repo);
    await page.locator('#nativeChatPanel').waitFor({ state: 'visible' });
    await page.locator('#nativeChatForm input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Review this layout') });
    await page.locator('.chat-context-chip').waitFor();
    await page.locator('#nativeChatInput').fill('@index');
    await page.getByRole('option', { name: 'index.html', exact: true }).click();
    assert.equal(await page.locator('.chat-context-chip').count(), 2);
    await page.locator('#nativeChatInput').fill('Rich response demo'); await page.locator('#nativeChatSend').click();
    await page.locator('.native-chat-body table').waitFor(); await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('#nativeChatStop')!.hidden);
    const id = (await page.locator('#nativeChatToolbar').getAttribute('data-chat-id'))!;
    const session = await page.evaluate(id => window.radial.nativeChatGet(id), id);
    assert.equal(session.messages[0].attachments!.length, 2); assert.equal(await page.locator('.chat-context-chip').count(), 0);
    assert.equal(await page.locator('.chat-sent-context button').count(), 2);
    assert.equal(await page.locator('.native-chat-message.assistant .chat-file').count(), 1);
    assert.equal(await page.locator('#nativeChatForm [role=status], #nativeChatForm #nativeChatStatus').count(), 0, 'progress and status never live in the input');
    await page.locator('.native-chat-message.user').hover(); await page.getByRole('button', { name: 'Edit and resend', exact: true }).click();
    assert.equal(await page.locator('#nativeChatInput').inputValue(), 'Rich response demo'); assert.equal(await page.locator('#nativeChatEditNote').isVisible(), true);
    await page.locator('.chat-context-chip').getByRole('button', { name: /^Remove / }).first().click(); await page.locator('.chat-context-chip').getByRole('button', { name: /^Remove / }).first().click();
    await page.locator('#nativeChatInput').fill('Show working indicator'); await page.locator('#nativeChatSend').click();
    await page.locator('#nativeChatWorking').waitFor({ state: 'visible' });
    await page.locator('#nativeChatInput').fill('Rich response demo queued'); await page.getByRole('button', { name: 'Queue message', exact: true }).click();
    await page.locator('#nativeChatQueue').waitFor({ state: 'visible' });
    assert.equal((await page.evaluate(id => window.radial.nativeChatGet(id), id)).queue!.length, 1);
    await page.locator('#nativeChatStop').click();
    await page.getByRole('button', { name: 'Resume queue', exact: true }).waitFor();
    assert.equal((await page.evaluate(id => window.radial.nativeChatGet(id), id)).messages.filter(m => m.role === 'user').length, 2, 'Stop does not dispatch queued work');
    await page.getByRole('button', { name: 'Resume queue', exact: true }).click();
    await until('the queued message sent as the third', 30000, () => page.evaluate(async id => (await window.radial.nativeChatGet(id)).messages.filter(m => m.role === 'user').length === 3, id));
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('#nativeChatStop')!.hidden);
    await page.locator('#nativeChatInput').fill('Ask options'); await page.locator('#nativeChatSend').click();
    await page.getByRole('checkbox', { name: /Green/ }).waitFor();
    await page.locator('#nativeChatApproval').screenshot({ path: path.join(scratch, 'fluid-question-card.png') });
    await page.getByRole('checkbox', { name: /Green/ }).check(); await page.getByRole('checkbox', { name: /Blue/ }).check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('#nativeChatStop')!.hidden);
    await page.locator('#nativeChatInput').fill('/Perm'); await page.getByRole('option', { name: 'Permissions', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Read only', exact: true }).click();
    assert.equal(await page.locator('#nativeChatPermissions').textContent(), 'Read only');
    await page.locator('#nativeChatInput').fill('Keep this unsent draft');
    await page.locator('#nativeChatForm input[type=file]').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this attached') });
    await page.locator('.chat-context-chip').waitFor();
    await page.locator('.native-chat-message.assistant').first().hover();
    await page.locator('.native-chat-message.assistant').first().getByRole('button', { name: 'Retry', exact: true }).click();
    await page.locator('#confirmOk').click();
    await until('the retry sent as the fifth message', 30000, () => page.evaluate(async id => (await window.radial.nativeChatGet(id)).messages.filter(m => m.role === 'user').length === 5, id));
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('#nativeChatStop')!.hidden && document.querySelector<HTMLTextAreaElement>('#nativeChatInput')!.value === 'Keep this unsent draft');
    assert.match((await page.locator('.chat-context-chip').textContent())!, /draft.txt/);
    await page.locator('[data-chat-view="terminal"]').click();
    await page.locator('#nativeChatPanel').waitFor({ state: 'hidden' });
    await page.locator('[data-chat-view="chat"]').click();
    await page.locator('#nativeChatPanel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#nativeChatInput').inputValue(), 'Keep this unsent draft');
    assert.match((await page.locator('.chat-context-chip').textContent())!, /draft.txt/);
    await page.screenshot({ path: path.join(scratch, 'chat-capabilities.png') });
    console.log('Chat capabilities screenshot:', path.join(scratch, 'chat-capabilities.png'));
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
});
