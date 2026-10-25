import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the app's window has that these tests reach inside page.evaluate: the
// preload's API, the native chat (nativeChat.ts) and window scripts' top-level
// declarations (src/renderer/globals.d.ts and types.d.ts have the full types).
// They are declared as always there; the boot poll still guards them, because
// firstWindow() can resolve before the window's scripts have run.
declare const window: Window & typeof globalThis & { radial: RadialApi; RadialNativeChat: { enabled(): boolean } };
declare const homeTab: { repoDir: string | null };
declare function showHomeDock(): void;

test('Chat exposes the native Codex saved rule with its exact scope', { timeout: 45000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-approval-ui-'));
  fs.writeFileSync(path.join(dir, 'radial-store.json'), JSON.stringify({ projectsDir: dir, recents: [], session: { open: [], active: null } }));
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.resolve('node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: dir, RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    await page.evaluate(() => showHomeDock());
    await page.locator('#nativeChatInput').fill('Remember Radial commands');
    await page.locator('#nativeChatInput').press('Enter');
    const rule = page.getByRole('button', { name: 'Always allow this command', exact: true });
    await rule.waitFor();
    assert.equal(await page.locator('#nativeChatApproval code').textContent(), '"radial" "open"');
    await rule.click();
    await page.locator('#nativeChatApproval').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#nativeChatPermissions').textContent(), 'Use Codex settings', 'saving a rule does not change the chat permissions');
    await page.locator('#nativeChatInput').fill('An unrelated command');
    await page.locator('#nativeChatInput').press('Enter');
    await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
    assert.equal(await rule.count(), 0, 'no permanent rule offered without a CLI proposal');
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('a machine whose Codex never asks runs Radial Codex chats without approvals until the chat chooses otherwise', { timeout: 45000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-codex-yolo-'));
  fs.writeFileSync(path.join(dir, 'radial-store.json'), JSON.stringify({ projectsDir: dir, recents: [], session: { open: [], active: null } }));
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.resolve('node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: dir, RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_CHAT_TEST_HONOR_PERMISSIONS: '1', RADIAL_CHAT_TEST_CODEX_CONFIG: JSON.stringify({ approval_policy: 'never', sandbox_mode: 'danger-full-access' }), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    await page.evaluate(() => showHomeDock());
    assert.equal(await page.locator('#nativeChatPermissions').textContent(), 'Use Codex settings');
    await page.locator('#nativeChatInput').fill('Deploy the site');
    await page.locator('#nativeChatInput').press('Enter');
    await page.locator('.native-chat-message.assistant').waitFor();
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('#nativeChatStop')!.hidden);
    assert.equal(await page.locator('#nativeChatApproval').isVisible(), false, 'no approval prompt on a never-ask machine');
    const id = await page.locator('#nativeChatToolbar').getAttribute('data-chat-id');
    assert.equal((await page.evaluate(id => window.radial.nativeChatGet(id), id!)).state, 'idle');
    await page.locator('#nativeChatPermissions').click();
    await page.getByRole('menuitemradio', { name: 'Workspace access', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#nativeChatPermissions')!.textContent === 'Workspace access');
    await page.locator('#nativeChatInput').fill('Run the checks');
    await page.locator('#nativeChatInput').press('Enter');
    await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
