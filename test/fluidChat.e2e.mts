/// <reference path="../src/renderer/types.d.ts" />
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the page functions reach in Radial's window: the preload's API, the
// native chat (nativeChat.ts), the Fluid chat bundle (vendor/fluid/chat.js),
// the answers this test records, and renderer.ts's Home tab, typed with the
// window's own shapes (src/renderer/globals.d.ts, types.d.ts).
interface RadialWindow extends Window {
  radial: RadialApi;
  RadialNativeChat: RadialNativeChatApi;
  /** Missing when the bundle didn't load (globals.d.ts); the questions test runs once the page has it. */
  RadialFluidChat?: RadialFluidChatApi;
  answersSeen: Record<string, string[]>[];
}
declare const window: RadialWindow;
declare const homeTab: HomeTab;
declare function showHomeDock(): void;

test('Fluid chat keeps keyboard menus, draft ownership, compact layout and theme isolation', { timeout: 60000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-fluid-chat-'));
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    await page.evaluate(() => showHomeDock());
    const form = page.locator('#nativeChatForm');
    assert.equal(await form.evaluate(el => el.classList.contains('fluid-chat')), true);
    // Checking actual paint catches incorrectly scoped light tokens in dark mode.
    assert.equal(await form.locator(':scope > div > div').evaluate(el => getComputedStyle(el).backgroundColor), await form.evaluate(el => getComputedStyle(el).getPropertyValue('--bg-3').trim()));
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--surface-2')), '', 'Fluid tokens do not leak into the editor');
    await page.locator('#nativeChatInput').fill('A draft to preserve');
    await page.locator('#nativeChatPermissions').focus();
    await page.keyboard.press('ArrowUp');
    await page.getByRole('menuitemradio', { name: 'Read only', exact: true }).waitFor();
    await page.keyboard.press('r');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#nativeChatPermissions')!.textContent === 'Read only');
    assert.equal(await page.locator('#nativeChatPermissions').evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('#nativeChatInput').inputValue(), 'A draft to preserve');
    await page.locator('#nativeChatModel').click();
    await page.getByRole('menuitemradio', { name: 'Codex', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Test Codex', exact: true }).click();
    await page.locator('#nativeChatEffort').press('ArrowDown');
    await page.getByRole('menuitemradio', { name: 'High', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#nativeChatEffort').evaluate(el => el === document.activeElement), true);
    // Existing DOM delegates and React must not submit the same Enter twice.
    await page.locator('#nativeChatInput').fill('Rich response demo from Fluid');
    await page.locator('#nativeChatInput').press('Enter');
    await page.waitForFunction(() => document.querySelector('.native-chat-message.assistant') && document.querySelector<HTMLElement>('#nativeChatStop')!.hidden);
    const id = await page.locator('#nativeChatToolbar').getAttribute('data-chat-id');
    assert.equal(await page.evaluate(async id => (await window.radial.nativeChatGet(id!)).messages.filter(m => m.role === 'user').length, id), 1);
    const copy = page.locator('.native-chat-message.assistant').getByRole('button', { name: 'Copy', exact: true });
    await page.keyboard.press('Tab');
    await copy.focus();
    await page.getByRole('tooltip', { name: 'Copy', exact: true }).waitFor();
    await copy.press('Enter');
    await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Preview ready/);
    await form.evaluate(el => { el.style.width = '290px'; });
    await page.locator('#nativeChatInput').fill('First line');
    await page.locator('#nativeChatInput').press('Shift+Enter');
    await page.locator('#nativeChatInput').pressSequentially('Second line');
    assert.equal(await page.locator('#nativeChatInput').inputValue(), 'First line\nSecond line');
    assert.equal(await form.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'compact composer controls fit a narrow sidebar');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => document.documentElement.classList.add('light'));
    await page.waitForFunction(() => !document.querySelector('#nativeChatForm')!.classList.contains('dark'));
    await page.locator('#nativeChatPermissions').click();
    await page.getByRole('menu').waitFor();
    assert.equal(await page.locator('.fluid-menu-host').evaluate(el => el.classList.contains('dark')), false);
    await page.screenshot({ path: path.join(scratch, 'fluid-chat-light-compact.png') });
    await page.keyboard.press('Escape');
    assert.equal(await form.locator('[role=status]').count(), 0);
    assert.deepEqual(errors, []);
    console.log('Fluid screenshot:', path.join(scratch, 'fluid-chat-light-compact.png'));
  } finally { await app.close(); }
});

test('Fluid agent questions keep required answers, keyboard scope and retryable submissions', { timeout: 60000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-fluid-questions-'));
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    await page.evaluate(() => showHomeDock());
    await page.evaluate(() => {
      const host = document.createElement('div'); host.id = 'fluidQuestionTest'; host.className = 'native-chat-approval'; host.style.cssText = 'position:fixed;top:90px;right:24px;width:320px;z-index:1000'; document.body.append(host);
      window.answersSeen = [];
      window.RadialFluidChat!.questions(host, [
        { id: 'colors', question: 'Which colors?', multiSelect: true, optionsOnly: true, options: [{ label: 'Green', description: 'Natural accents' }, { label: 'Blue', description: 'Cool accents' }] },
        { id: 'purpose', question: 'What is this for?', options: [{ label: 'A portfolio' }, { label: 'A shop' }] },
        { id: 'name', question: 'What should we call it?' },
      ], async answers => { window.answersSeen.push(answers); await new Promise(resolve => setTimeout(resolve, 100)); return false; });
    });
    const pane = page.locator('#fluidQuestionTest');
    assert.equal(await pane.getByRole('button', { name: 'Skip', exact: true }).count(), 0);
    assert.equal(await pane.getByRole('button', { name: /^Continue/ }).isDisabled(), true);
    // Digits outside the question card must never choose an answer.
    await page.locator('#nativeChatInput').fill('Draft 1'); await page.locator('#nativeChatInput').press('2');
    assert.equal(await pane.getByRole('checkbox', { name: /Green/ }).getAttribute('aria-checked'), 'false');
    await pane.getByRole('checkbox', { name: /Green/ }).focus(); await page.keyboard.press('1');
    await pane.getByRole('checkbox', { name: /Blue/ }).check();
    await pane.getByRole('button', { name: /^Continue/ }).click();
    await pane.getByRole('radio', { name: /A portfolio/ }).waitFor();
    await pane.getByRole('textbox').fill('An old alternative');
    await pane.getByRole('radio', { name: /A portfolio/ }).click();
    const answer = pane.getByRole('textbox', { name: 'What should we call it?' });
    await answer.fill('Studio');
    // IME confirmation does not submit the answer.
    await answer.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    assert.equal(await page.evaluate(() => window.answersSeen.length), 0);
    await pane.getByRole('button', { name: /^Continue/ }).click();
    await pane.getByRole('alert').waitFor();
    assert.deepEqual(await page.evaluate(() => window.answersSeen[0]), { colors: ['Green', 'Blue'], purpose: ['A portfolio'], name: ['Studio'] });
    assert.equal(await answer.inputValue(), 'Studio', 'failed submit preserves answers');
    await pane.getByRole('button', { name: /^Continue/ }).click();
    await page.waitForFunction(() => window.answersSeen.length === 2);
    await page.screenshot({ path: path.join(scratch, 'fluid-questions.png') });
    await pane.evaluate((el: HTMLElement) => { window.RadialFluidChat!.clear(el); el.hidden = true; });
    await page.keyboard.press('1');
    assert.equal(await page.evaluate(() => window.answersSeen.length), 2);
    assert.deepEqual(errors, []);
    console.log('Fluid questions screenshot:', path.join(scratch, 'fluid-questions.png'));
  } finally { await app.close(); }
});
