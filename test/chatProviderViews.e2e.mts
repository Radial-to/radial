import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatEngine } from '../src/shared/chatPermissions.ts';
import type { ChatSession, ChatView, PtyInfo, RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the app's window carries that this check reaches (src/renderer/globals.d.ts, types.d.ts).
/** The Home pseudo-tab (renderer.ts homeTab): its folder is known once main answers. */
interface HomeTab { repoDir: string | null }
/** The native chat panel (nativeChat.ts). */
interface NativeChatPanel { enabled(): boolean; createFor(tab: HomeTab, engine?: ChatEngine): Promise<void> }
interface AppWindow extends Window {
  /** termList(null) lists every project's terminals (terminal.list); RadialApi types only a folder. Drop this override once radialApi.ts widens termList to `repoDir?: string | null`. */
  radial: Omit<RadialApi, 'termList'> & { termList(repoDir: string | null): Promise<PtyInfo[]> };
  RadialNativeChat: NativeChatPanel;
  /** Set by this test: how many times a confirmation showed. */
  viewTestConfirmations: number;
}
declare const window: AppWindow;
declare const homeTab: HomeTab;
/** The state file test/fixtures/native-interactive.cjs keeps per session. */
interface FixtureState { engine: 'claude' | 'cursor'; args: string[]; sessionId: string; cwd: string; pid: number; status: 'idle' | 'busy'; draft: string; prompts: string[]; interrupts: number; outputs: string[]; processed: number }
/** A line of the fixture's commands file: print a reply, end the turn, or stream a long one. */
type FixtureCommand = { type: 'output'; text: string } | { type: 'finish' } | { type: 'stream'; seconds?: number; fps?: number; every?: number; size?: number };

for (const engine of ['claude', 'cursor'] satisfies ChatEngine[]) test(`${engine}: Chat/Terminal switches preserve the live CLI, output and both drafts; only Stop interrupts`, { timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `radial-${engine}-views-`));
  fs.writeFileSync(path.join(dir, 'radial-store.json'), JSON.stringify({ projectsDir: dir, recents: [], session: { open: [], active: null } }));
  const fixture = path.resolve('test/fixtures/native-interactive.cjs');
  const app = await launchApp({
    executablePath: process.env.RADIAL_APP_PATH || path.resolve('node_modules/.bin/electron'),
    args: process.env.RADIAL_APP_PATH ? [] : ['.'],
    env: { ...process.env, RADIAL_USERDATA: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CURSOR_CONFIG_DIR: path.join(dir, 'cursor'), RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLAUDE: fixture, RADIAL_CHAT_TEST_CURSOR: fixture, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' },
  });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    await page.evaluate(engine => window.RadialNativeChat.createFor(homeTab, engine), engine);
    const id = (await page.locator('#nativeChatToolbar').getAttribute('data-chat-id'))!;
    const session = () => page.evaluate(id => window.radial.nativeChatGet(id), id);
    async function waitForSession(predicate: (session: ChatSession) => boolean | undefined) {
      const deadline = Date.now() + 15000;
      let current: ChatSession | undefined;
      while (Date.now() < deadline) { current = await session(); if (predicate(current)) return current; await delay(50); }
      assert.fail('Native session did not reach expected state: ' + JSON.stringify(current));
    }
    await page.locator('#nativeChatInput').fill('Start the native response');
    await page.locator('#nativeChatSend').click();
    await page.locator('.native-chat-message.assistant').filter({ hasText: 'Response in progress 1' }).waitFor();
    const initial = await session();
    assert.ok(initial.terminalId, 'Chat starts the real native PTY before switching views');
    const fixtureState = (): FixtureState => JSON.parse(fs.readFileSync(path.join(dir, 'native-fixture', initial.threadId + '.state.json'), 'utf8'));
    const command = (value: FixtureCommand) => fs.appendFileSync(path.join(dir, 'native-fixture', initial.threadId + '.commands.jsonl'), JSON.stringify(value) + '\n');
    // Observe any confirmation, including a modal that briefly opens and closes.
    await page.evaluate(() => {
      window.viewTestConfirmations = 0;
      const modal = document.querySelector('#confirmModal')!;
      new MutationObserver(() => { if (modal.getBoundingClientRect().height && getComputedStyle(modal).visibility !== 'hidden') window.viewTestConfirmations++; }).observe(modal, { attributes: true });
    });
    async function view(mode: ChatView) {
      await page.locator(`[data-chat-view="${mode}"]`).click();
      await page.waitForFunction(mode => {
        const button = document.querySelector<HTMLButtonElement>(`[data-chat-view="${mode}"]`)!;
        return button.getAttribute('aria-pressed') === 'true' && !button.disabled;
      }, mode);
      assert.equal(await page.locator('#confirmModal').isVisible(), false);
      const current = await session();
      assert.equal(current.threadId, initial.threadId);
      assert.equal(current.terminalId, initial.terminalId);
      return current;
    }
    const running = await session();
    const pid = fixtureState().pid;
    assert.equal(running.state, 'working');
    assert.ok(running.turnId);
    await page.locator('#nativeChatInput').fill('Unsent GUI draft');
    await view('terminal');
    await page.evaluate(terminalId => window.radial.termInput(terminalId, 'Unsent native draft'), initial.terminalId);
    await waitForSession(current => current.terminalHasInput);
    for (let iteration = 1; iteration <= 3; iteration++) {
      command({ type: 'output', text: `Continued output ${iteration}` });
      await waitForSession(current => current.messages.some(message => message.role === 'assistant' && message.text.includes(`Continued output ${iteration}`)));
      const current = await view('chat');
      assert.equal(current.state, 'working');
      assert.equal(current.turnId, running.turnId);
      assert.equal(await page.locator('#nativeChatInput').inputValue(), 'Unsent GUI draft');
      await page.locator('.native-chat-message.assistant').filter({ hasText: `Continued output ${iteration}` }).waitFor();
      assert.equal(fixtureState().pid, pid);
      assert.equal(fixtureState().interrupts, 0, 'changing views must never send a native interrupt');
      assert.equal(fixtureState().draft, 'Unsent native draft');
      await view('terminal');
    }
    command({ type: 'finish' });
    await waitForSession(current => current.state === 'idle');
    // Submit the retained native input: its appearance in Chat proves the actual
    // CLI draft survived, beyond Radial merely retaining a boolean flag.
    await page.evaluate(terminalId => window.radial.termInput(terminalId, '\r'), initial.terminalId);
    await waitForSession(current => current.messages.some(message => message.role === 'user' && message.text === 'Unsent native draft'));
    await view('chat');
    await page.locator('.native-chat-message.assistant').filter({ hasText: 'Response in progress 2' }).waitFor();
    assert.equal(await page.locator('#nativeChatInput').inputValue(), 'Unsent GUI draft');
    assert.equal(fixtureState().prompts.length, 2);
    assert.ok(fixtureState().prompts[0].startsWith('Start the native response'));
    assert.equal(fixtureState().prompts[1], 'Unsent native draft');
    assert.equal(fixtureState().interrupts, 0);
    await page.locator('#nativeChatStop').click();
    await waitForSession(current => current.state === 'idle');
    assert.equal(fixtureState().interrupts, 1, 'only explicit Stop interrupts the native turn');
    assert.equal(fixtureState().pid, pid, 'Stop leaves the interactive CLI alive');
    const stopped = await session();
    assert.equal(stopped.threadId, initial.threadId);
    assert.equal(stopped.terminalId, initial.terminalId);
    const terminals = await page.evaluate(() => window.radial.termList(null));
    assert.equal(terminals.find(terminal => terminal.id === initial.terminalId)?.alive, true);
    assert.equal(await page.evaluate(() => window.viewTestConfirmations), 0);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
