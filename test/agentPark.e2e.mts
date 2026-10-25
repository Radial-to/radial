// Idle chats are parked while the app runs, and a project opens without starting
// a CLI for every past conversation (docs/memory-leak-report-2026-10-11.md).
// Three saved Claude chats in one project, a stand-in CLI, and a short park
// cutoff: only the chat on screen starts at launch; chats opened and then left
// alone are parked (CLI stopped, conversation kept, no error); opening a parked
// chat resumes the same thread without sending anything.
/// <reference path="../src/renderer/types.d.ts" />
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the page functions reach in Radial's window: the preload's API, the
// native chat (nativeChat.ts) and renderer.ts's tabs, typed with the window's
// own shapes (src/renderer/globals.d.ts, types.d.ts).
interface RadialWindow extends Window {
  radial: RadialApi;
  RadialNativeChat: RadialNativeChatApi;
}
declare const window: RadialWindow;
declare const tabs: Tab[];
declare function activeTab(): Tab | null;
/** The stand-in CLI's record of a session (test/fixtures/native-interactive.cjs). */
interface FixtureState { args: string[]; prompts: string[] }
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

test('idle chats are parked and resume on open; a project starts only the chat on screen', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-agent-park-'));
  const site = path.join(dir, 'site'); fs.mkdirSync(site); fs.writeFileSync(path.join(site, 'index.html'), '<h1>Parked agents</h1>');
  const saved = ['First', 'Second', 'Third'].map((title, i) => ({ id: randomUUID(), engine: 'claude', threadId: randomUUID(), repoDir: site, home: false, title, state: 'idle', viewMode: 'terminal', providerPersisted: true, messages: [{ id: randomUUID(), role: 'user', text: title + ' conversation' }], createdAt: i + 1, updatedAt: i + 1 }));
  fs.writeFileSync(path.join(dir, 'native-chats.json'), JSON.stringify(saved));
  fs.writeFileSync(path.join(dir, 'radial-store.json'), JSON.stringify({ projectsDir: dir, recents: [{ path: site, name: 'site', kind: 'local' }], session: { open: [site], active: site } }));
  const fixture = path.resolve('test/fixtures/native-interactive.cjs');
  const env: Record<string, string> = { ...process.env, RADIAL_USERDATA: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1', RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_CHAT_TEST_CLAUDE: fixture, RADIAL_AGENT_PARK_MS: '4000' };
  delete env.RADIAL_OPEN;
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.resolve('node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(p => typeof tabs !== 'undefined' && activeTab()?.repoDir === p && window.RadialNativeChat?.enabled(), site);
    const get = (id: string) => page.evaluate(id => window.radial.nativeChatGet(id), id);
    const running = () => page.evaluate(async p => (await window.radial.termList(p)).filter(t => t.alive !== false && t.meta?.nativeChatId).map(t => t.meta.nativeChatId).sort(), site);
    // A chat's CLI is running once main has given the chat a terminal.
    const started = (id: string) => until(`chat ${id}'s CLI to start`, 20000, () => page.evaluate(async id => !!(await window.radial.nativeChatGet(id)).terminalId, id));
    const open = async (id: string) => { await page.evaluate(id => window.RadialNativeChat.select(id), id); await started(id); };

    // Launch: the chat on screen starts; the other two wait to be opened.
    const shown = await page.waitForFunction(() => window.RadialNativeChat.visibleId()).then(h => h.jsonValue() as Promise<string>); // resolves on a truthy id
    await started(shown);
    assert.deepEqual(await running(), [shown], 'only the chat on screen has a CLI after launch');

    // Open the other two, then go back: they are left idle off screen and get parked.
    const others = saved.map(s => s.id).filter(id => id !== shown);
    for (const id of others) await open(id);
    await open(shown);
    assert.equal((await running()).length, 3, 'all three are running before the cutoff');
    const t0 = Date.now();
    while ((await running()).length > 1 && Date.now() - t0 < 30000) await new Promise(r => setTimeout(r, 250));
    assert.deepEqual(await running(), [shown], 'the two off screen were parked; the chat on screen keeps running');
    for (const id of others) {
      const s = await get(id);
      assert.equal(s.state, 'idle'); assert.equal(s.error || '', '', 'a parked chat is not an error'); assert.ok(s.parkedAt! > 0);
      assert.equal(s.threadId, saved.find(x => x.id === id)!.threadId, 'the conversation is kept');
    }

    // Opening a parked chat resumes the same thread and sends nothing.
    await open(others[0]);
    const resumed = await get(others[0]);
    const state: FixtureState = JSON.parse(fs.readFileSync(path.join(dir, 'native-fixture', resumed.threadId + '.state.json'), 'utf8'));
    assert.equal(state.args[state.args.indexOf('--resume') + 1], resumed.threadId);
    assert.deepEqual(state.prompts, []);
    assert.deepEqual(errors, []);
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
