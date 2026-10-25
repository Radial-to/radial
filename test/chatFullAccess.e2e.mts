import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatEngine } from '../src/shared/chatPermissions.ts';
import type { RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the app's window carries that these checks reach (src/renderer/globals.d.ts, types.d.ts).
/** The Home pseudo-tab (renderer.ts homeTab): its folder is known once main answers. */
interface HomeTab { repoDir: string | null }
/** The native chat panel (nativeChat.ts). */
interface NativeChatPanel { enabled(): boolean; createFor(tab: HomeTab, engine?: ChatEngine): Promise<void> }
interface AppWindow extends Window { radial: RadialApi; RadialNativeChat: NativeChatPanel }
declare const window: AppWindow;
declare const homeTab: HomeTab;
/** The state file test/fixtures/native-interactive.cjs keeps per session. */
interface FixtureState { engine: 'claude' | 'cursor'; args: string[]; sessionId: string; cwd: string; pid: number; status: 'idle' | 'busy'; draft: string; prompts: string[]; interrupts: number; outputs: string[]; processed: number }
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
for (const engine of ['claude', 'cursor'] satisfies ChatEngine[]) test(`${engine}: Full access is passed to the native CLI at launch; live controls preserve its process`, { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-native-permissions-'));
  const fixture = path.resolve('test/fixtures/native-interactive.cjs');
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.resolve('node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CURSOR_CONFIG_DIR: path.join(dir, 'cursor'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1', RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLAUDE: fixture, RADIAL_CHAT_TEST_CURSOR: fixture, RADIAL_NATIVE_FIXTURE_AUTOFINISH: '1' } });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    await page.evaluate(engine => window.RadialNativeChat.createFor(homeTab, engine), engine);
    await page.locator('#nativeChatPermissions').click();
    await page.getByRole('menuitemradio', { name: 'Full access · no approvals', exact: true }).click();
    await page.locator('#nativeChatInput').fill('Inspect the project'); await page.locator('#nativeChatSend').click();
    await page.locator('.native-chat-message.assistant').filter({ hasText: 'received the draft' }).waitFor();
    await page.locator('#nativeChatStop').waitFor({ state: 'hidden' });
    const id = (await page.locator('#nativeChatToolbar').getAttribute('data-chat-id'))!;
    const before = await page.evaluate(id => window.radial.nativeChatGet(id), id);
    const file = path.join(dir, 'native-fixture', before.threadId + '.state.json');
    const native: FixtureState = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (engine === 'claude') assert.equal(native.args[native.args.indexOf('--permission-mode') + 1], 'bypassPermissions');
    else assert.ok(native.args.includes('--force'));
    assert.equal(before.permissionMode, 'full');
    await page.locator('#nativeChatPermissions').click();
    await page.getByRole('menuitem', { name: 'Manage permissions in Terminal', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-chat-view=terminal]')!.getAttribute('aria-pressed') === 'true');
    const after = await page.evaluate(id => window.radial.nativeChatGet(id), id);
    assert.equal(after.threadId, before.threadId); assert.equal(after.terminalId, before.terminalId);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, native.pid);
    assert.equal(await page.locator('#confirmModal').isVisible(), false);
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
for (const engine of ['codex'] satisfies ChatEngine[]) test(`${engine}: Full access finishes the current response and reaches the next native turn`, { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-full-access-ui-'));
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.resolve('node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: dir, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1', RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_CHAT_TEST_CLAUDE: path.resolve('test/fixtures/claude-approvals.cjs'), RADIAL_CHAT_TEST_HONOR_PERMISSIONS: '1' } });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    await page.evaluate(engine => window.RadialNativeChat.createFor(homeTab, engine), engine);
    const id = (await page.locator('#nativeChatToolbar').getAttribute('data-chat-id'))!;
    await page.locator('#nativeChatInput').fill('Inspect the project'); await page.locator('#nativeChatSend').click();
    await page.locator('#nativeChatApproval [data-decision="accept"]').waitFor();
    const before = await page.evaluate(id => window.radial.nativeChatGet(id), id);
    await page.locator('#nativeChatPermissions').click();
    await page.getByRole('menuitemradio', { name: 'Full access · no approvals', exact: true }).click();
    await until('the chat to finish its response', 10000, () => page.evaluate(async id => (await window.radial.nativeChatGet(id)).state === 'idle', id));
    assert.equal(await page.locator('#nativeChatApproval').isVisible(), false);
    await page.locator('#nativeChatInput').fill('Continue the inspection'); await page.locator('#nativeChatSend').click();
    await until('the second message answered', 10000, () => page.evaluate(async id => { const s = await window.radial.nativeChatGet(id); return s.state === 'idle' && s.messages.filter(m => m.role === 'user').length === 2; }, id));
    const after = await page.evaluate(id => window.radial.nativeChatGet(id), id);
    assert.equal(after.permissionMode, 'full'); assert.equal(after.pendingSettings, null); assert.equal(after.threadId, before.threadId);
    assert.equal(await page.locator('#nativeChatApproval').isVisible(), false); assert.deepEqual(errors, []);
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('Claude default is opt-in, inherited on launch, and never changes a running CLI', { timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-claude-default-ui-'));
  const config = path.join(dir, 'claude', 'settings.json'); fs.mkdirSync(path.dirname(config));
  const original = { model: 'opus', permissions: { allow: ['Read'], deny: ['Bash(rm *)'] } };
  fs.writeFileSync(config, JSON.stringify(original));
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.resolve('node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: dir, CLAUDE_CONFIG_DIR: path.dirname(config), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1', RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLAUDE: path.resolve('test/fixtures/native-interactive.cjs') } });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    await page.evaluate(() => window.RadialNativeChat.createFor(homeTab, 'claude'));
    assert.equal(await page.locator('#nativeChatPermissions').textContent(), 'Use Claude Code settings');
    const chooseDefault = async (name: string) => {
      await page.locator('#nativeChatPermissions').click();
      await page.getByRole('menuitem', { name: 'Claude Code default…', exact: true }).click();
      await page.getByRole('menuitemradio', { name, exact: true }).click();
      await page.locator('#confirmModal').waitFor({ state: 'visible' });
      assert.match((await page.locator('#confirmModal').textContent())!, /inside and outside Radial/);
    };
    await chooseDefault('Full access'); await page.locator('#confirmCancel').click();
    assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), original);
    await chooseDefault('Full access'); await page.locator('#confirmOk').click();
    await until("Claude Code's default saved as Full access", 15000, () => page.evaluate(async () => (await window.radial.nativeChatClaudeDefault()).mode === 'full'));
    assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')).permissions, { ...original.permissions, defaultMode: 'bypassPermissions' });
    await page.locator('#nativeChatInput').fill('Keep working'); await page.locator('#nativeChatSend').click();
    await page.locator('.native-chat-message.assistant').filter({ hasText: 'Response in progress' }).waitFor();
    const id = (await page.locator('#nativeChatToolbar').getAttribute('data-chat-id'))!;
    const before = await page.evaluate(id => window.radial.nativeChatGet(id), id);
    const stateFile = path.join(dir, 'native-fixture', before.threadId + '.state.json');
    const native: FixtureState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(!native.args.includes('--permission-mode'), 'inherit native settings without an overriding launch flag');
    await chooseDefault('Ask permission'); await page.locator('#confirmOk').click();
    await until("Claude Code's default saved as Ask permission", 15000, () => page.evaluate(async () => (await window.radial.nativeChatClaudeDefault()).mode === 'default'));
    const after = await page.evaluate(id => window.radial.nativeChatGet(id), id);
    assert.equal(after.terminalId, before.terminalId); assert.equal(after.threadId, before.threadId); assert.equal(after.state, 'working');
    const running: FixtureState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(running.pid, native.pid); assert.equal(running.interrupts, 0);
    assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).model, 'opus');
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
