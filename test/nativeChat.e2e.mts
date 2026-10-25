import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Locator } from 'playwright-core';
import type { Terminal } from '@xterm/xterm';
import type { OpenProjectResult, OpenedProject, RadialApi } from '../src/shared/radialApi.ts';
import type { ChatEngine } from '../src/shared/chatPermissions.ts';
import { launchApp } from './support/app.ts';

// What the app's window has that this test reaches inside win.evaluate: the
// preload's API and window scripts' top-level declarations
// (src/renderer/globals.d.ts and types.d.ts have the full types).
// They are declared as always there; the boot poll still guards them, because
// firstWindow() can resolve before the window's scripts have run.
/** A terminal in a tab's list (renderer TermSession), the fields read here. */
interface PageTerm { id: string; engine: ChatEngine | null; _nativeChatId?: string | null; xterm?: Terminal | null }
/** Home's agent (renderer HomeTab), the fields read here. */
interface PageHomeTab { id: 'home'; repoDir: string | null; terminals: PageTerm[]; term: PageTerm | null }
/** An open project (renderer Tab), the fields read here. */
interface PageProjectTab { id: string; repoDir: string; terminals?: PageTerm[]; _previewLocation?: string }
/** openProjectPath's answer (renderer OpenProjectResultWithDir), its error readable on either branch (OpenedProject has no `error?: undefined` of its own yet). */
type OpenResult = (OpenedProject & { error?: undefined }) | (Extract<OpenProjectResult, { ok: false }> & { repoDir?: string });
declare const window: Window & typeof globalThis & { radial: RadialApi };
declare const homeTab: PageHomeTab;
declare let homeActive: boolean;
declare let _engineAvail: Partial<Record<ChatEngine, boolean>> | null;
declare function showHome(): void;
declare function showHomeDock(): void;
declare function openProjectPath(dir: string): Promise<OpenResult>;
declare function activeTab(): PageProjectTab | null;
declare function agentTab(): PageProjectTab | PageHomeTab | null;
declare function loadRoute(route: string): void;
declare function persistThreadPreview(): void;

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

test('local CLI chat renders streaming text, tools, approvals, and keeps chats per project', { timeout: 60000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-native-ui-'));
  const projectsDir = path.join(scratch, 'projects'); fs.mkdirSync(projectsDir);
  const site = path.join(projectsDir, 'Example website'); fs.mkdirSync(site); fs.writeFileSync(path.join(site, 'index.html'), '<title>Example website</title><h1>Hello</h1>'); fs.writeFileSync(path.join(site, 'about.html'), '<h1>About</h1>');
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir, recents:[], session:{open:[],active:null} }));
  const bin = path.join(process.cwd(), 'test/fixtures/codex-shared.cjs');
  const app = await launchApp({executablePath:process.env.RADIAL_APP_PATH || path.join(process.cwd(),'node_modules/.bin/electron'),args:process.env.RADIAL_APP_PATH ? [] : ['.'],env:{...process.env,RADIAL_USERDATA:scratch,RADIAL_CHAT_EXPERIMENT:process.env.RADIAL_APP_PATH ? '' : '1',RADIAL_CHAT_TEST_CLI:bin,RADIAL_OPEN:' ',RADIAL_AUTO_RELOAD:'0',RADIAL_DAEMON_EPHEMERAL:'1'}});
  try {
    const win=await app.firstWindow();const errors: string[]=[];win.on('pageerror',e=>errors.push(e.message));
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1600,1000));
    await win.waitForFunction(()=>typeof homeTab !== 'undefined' && homeTab.repoDir && document.querySelector('#nativeChatTitle'));
    assert.equal(await win.locator('#rightDock').isVisible(), false, 'Home library has no empty agent column');
    await win.evaluate(() => showHomeDock());
    await win.locator('#nativeChatPanel').waitFor({state:'visible'});
    assert.equal(await win.locator('#nativeChatSessions, #nativeChatNew').count(), 0, 'conversation navigation lives only in the sidebar');
    await win.locator('#nativeChatPermissions').click();
    await win.getByRole('menuitemradio', {name:'Read only',exact:true}).click();
    assert.equal(await win.locator('#nativeChatPermissions').textContent(), 'Read only');
    await win.locator('#nativeChatModel').click();
    await win.getByRole('menuitemradio', { name: 'Codex', exact: true }).click();
    assert.equal(await win.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle), 'none', 'pointer-opened menus do not leave a focus outline');
    await win.getByRole('menuitemradio', {name:'Test Codex'}).click();
    await win.waitForFunction(() => document.querySelector('#nativeChatEffort')!.textContent === 'Medium');
    assert.equal(await win.evaluate(async () => (await window.radial.nativeChatList()).length), 0, 'choosing a model does not create an empty conversation');
    await win.locator('#nativeChatEffort').press('ArrowUp');
    assert.notEqual(await win.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle), 'none', 'keyboard-opened menus retain a visible focus outline');
    await win.screenshot({path:path.join(scratch,'chat-effort-menu.png')});
    await win.getByRole('menuitemradio', {name:'High',exact:true}).click();
    assert.equal(await win.locator('#nativeChatEffort').evaluate(el => el === document.activeElement), true, 'menu restores focus to the composer control');
    await win.evaluate(() => showHome());
    await win.locator('#hgChatInput').fill('Review this workspace');
    await win.locator('#hgChatSend').click();
    await win.locator('#nativeChatApproval [data-decision="accept"]').waitFor();
    assert.equal(await win.locator('#nativeChatWorking').isVisible(), false, 'working indicator pauses for approvals');
    assert.equal(await win.locator('.native-chat-message.assistant strong').textContent(),'Navigation');
    assert.equal(await win.locator('#preview').isVisible(), false, 'workspace conversation replaces the library');
    assert.equal(await win.locator('#nativeChatApproval').evaluate(el => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight; }), true, 'approval is inside the window, not pushed below an empty panel');
    assert.equal(await win.locator('#nativeChatModel').isDisabled(), false);
    assert.equal(await win.locator('#nativeChatEffort').textContent(), 'High');
    const configured = await win.evaluate(async () => window.radial.nativeChatGet(document.querySelector<HTMLElement>('#nativeChatToolbar')!.dataset.chatId!));
    assert.equal(configured.permissionMode, 'read-only');
    assert.equal(await win.locator('#nativeChatPermissions').isDisabled(), false);
    assert.equal(configured.model, 'fixture-codex');
    assert.equal(configured.effort, 'high');
    await win.locator('.native-chat-activity').getByRole('button', { name: /^\d+ steps?/ }).click();
    await win.locator('.native-chat-tool summary').click();
    assert.match((await win.locator('.native-chat-tool pre').textContent())!,/cat index.html/);
    await win.screenshot({path:path.join(scratch,'chat-approval.png')});
    const toolNode = await win.locator('.native-chat-tool').elementHandle();
    await win.evaluate(() => showHome());
    await win.locator('#hgChatInput').fill('Which projects need attention?');
    await win.locator('#hgChatSend').click();
    await win.waitForFunction(() => document.querySelector('#hgChatStatus')!.textContent.includes('waiting for your approval'));
    assert.equal(await win.locator('#hgChatInput').inputValue(), 'Which projects need attention?', 'blocked send keeps the Home draft');
    assert.equal(await win.locator('#nativeChatInput').inputValue(), 'Which projects need attention?', 'retry input does not expose injected workspace context');
    await win.locator('[data-decision="acceptForSession"]').click();
    await win.waitForFunction(()=>document.querySelector<HTMLButtonElement>('#nativeChatStop')!.hidden);
    assert.match((await win.locator('.native-chat-message.assistant').textContent())!,/permission choice/);
    assert.equal(await toolNode.evaluate((el: HTMLDetailsElement) => el.isConnected && el.open), true, 'streaming updates preserve expanded tool nodes');
    const homeId=await win.locator('#nativeChatToolbar').getAttribute('data-chat-id');
    const originalThread = await win.evaluate(async id => (await window.radial.nativeChatGet(id)).threadId, homeId!);
    await win.locator('#nativeChatInput').fill('Keep this unsent draft');
    await win.locator('[data-chat-view="terminal"]').click();
    await win.locator('#nativeChatPanel').waitFor({state:'hidden'});
    await win.waitForFunction(() => homeTab.term?.xterm?.buffer.active.getLine(0)?.translateToString().includes('Shared thread'));
    const terminalId = await win.evaluate(() => homeTab.term!.id);
    assert.equal(await win.locator('[data-chat-view="terminal"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await win.locator('[data-chat-view="chat"]').isVisible(), true, 'toggle remains visible in Terminal');
    await win.screenshot({path:path.join(scratch,'terminal-toggle.png')});
    assert.equal(await win.locator('.rail-recent[data-tid^="native:"]').count(), 1, 'one conversation row across views');
    assert.equal(await win.locator(`.rail-recent[data-tid="${terminalId}"]`).count(), 0, 'the terminal view has no duplicate row');
    await win.evaluate(id => window.radial.termInput(id, 'Continue in terminal\r'), terminalId);
    await until('the line typed in Terminal in the chat', 30000, () => win.evaluate(async id => (await window.radial.nativeChatGet(id)).messages.some(m => m.text === 'Continue in terminal'), homeId!));
    await win.locator('[data-chat-view="chat"]').click();
    await win.locator('#nativeChatPanel').waitFor({state:'visible'});
    assert.equal(await win.locator('#nativeChatInput').inputValue(), 'Keep this unsent draft');
    assert.equal(await win.locator('[data-chat-view="chat"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await win.locator('[data-chat-view="terminal"]').isVisible(), true, 'toggle remains visible in Chat');
    assert.equal(await win.locator('.native-chat-message.user').count(), 2, 'history hydration does not duplicate prompts');
    assert.equal(await win.evaluate(async id => (await window.radial.nativeChatGet(id)).threadId, homeId!), originalThread);
    await win.locator('[data-decision="decline"]').click();
    await win.waitForFunction(() => document.querySelector<HTMLButtonElement>('#nativeChatStop')!.hidden);
    await win.evaluate(id => window.radial.termInput(id, 'Hidden terminal must not send\r'), terminalId);
    await win.waitForTimeout(100);
    assert.equal(await win.locator('.native-chat-message.user').count(), 2, 'inactive terminal input is rejected');
    await win.locator('[data-chat-view="terminal"]').click();
    await win.locator('#nativeChatPanel').waitFor({state:'hidden'});
    assert.equal(await win.evaluate(() => homeTab.term!.id), terminalId, 'switching back reuses the same terminal');
    await win.locator('[data-chat-view="terminal"]').click();
    assert.equal(await win.evaluate(() => homeTab.terminals.filter(term => term._nativeChatId).length), 1, 'clicking the current view does not spawn a terminal');
    await win.locator('[data-chat-view="chat"]').click();
    await win.locator('#nativeChatPanel').waitFor({state:'visible'});
    await win.evaluate(()=>localStorage.setItem('radial.chatView.project','chat')); // This covers the Chat view; projects open in Terminal by default.
    await win.evaluate(dir=>openProjectPath(dir),site);
    await win.waitForFunction(()=>!homeActive && document.querySelector('.native-chat-empty'));
    assert.equal(await win.evaluate(()=>(activeTab()!.terminals || []).length),0,'chat mode does not spawn a hidden terminal agent');
    await win.locator('#nativeChatInput').fill('Improve the home page');
    await win.locator('#nativeChatSend').click();
    await win.locator('#nativeChatApproval [data-decision="accept"]').waitFor();
    await win.locator('[data-decision="accept"]').click();
    await win.waitForFunction(()=>document.querySelector<HTMLButtonElement>('#nativeChatStop')!.hidden);
    await win.screenshot({path:path.join(scratch,'chat-project.png')});
    const projectChat = await win.locator('#nativeChatToolbar').getAttribute('data-chat-id');
    assert.equal(await win.locator('.rail-recent[data-tid^="native:"]').count(), 2);
    const projectRow = win.locator(`.rail-term[data-tid="native:${projectChat}"]`);
    const homeCompose = win.getByRole('button', { name: 'New workspace chat', exact: true });
    assert.equal(await win.locator(`.rail-term-add[data-id="${await win.evaluate(() => homeTab.id)}"]`).count(), 0);
    await homeCompose.click();
    assert.equal(await win.locator('[data-chat-pick="project"]').getAttribute('data-project-id'), await win.evaluate(() => activeTab()!.id), 'compose defaults to the project with the latest submitted task');
    assert.equal(await win.evaluate(() => homeActive), false, 'compose button does not trigger Home navigation');
    await win.keyboard.press('Escape');
    assert.equal(await win.evaluate(() => document.activeElement!.classList.contains('rail-home-new-chat')), true);
    // The rail redraws when a chat's state changes, and a redraw closes the hover
    // card under a still pointer: read the card in one step, and nudge the
    // pointer to bring it back if a redraw closed it.
    const hoverCard = win.locator('#recentHoverCard');
    const readCard = (row: Locator) => (async () => {
      for (let i = 0; i < 5; i++) {
        const box = (await row.boundingBox())!;
        await win.mouse.move(box.x + box.width / 2 - 20 + i, box.y + box.height / 2);
        await win.waitForFunction(() => !!document.getElementById('recentHoverCard'), null, { timeout: 2000 }).catch(() => {});
        const card = await win.evaluate(() => { const c = document.getElementById('recentHoverCard'); return c && { html: c.innerHTML, time: c.querySelector('.recent-hover-time')?.textContent, project: c.querySelector('.recent-hover-project')?.textContent, dt: [...c.querySelectorAll('.recent-hover-settings dt')].map(e => e.textContent), dd: [...c.querySelectorAll('.recent-hover-settings dd')].map(e => e.textContent) }; });
        if (card) return card;
      }
      throw new Error('the hover card never showed');
    })();
    const card = await readCard(projectRow);
    assert.equal(card.time, 'now');
    assert.match(card.project!, /Example website/);
    assert.deepEqual(card.dt, ['Provider', 'Model', 'Effort']);
    assert.deepEqual(card.dd, ['OpenAI', 'fixture-codex', 'Medium']);
    await win.screenshot({path:path.join(scratch,'chat-hover-settings.png')});
    const context = card.html;
    const menuButton = await projectRow.evaluate(row => {
      const menu = row.querySelector('.rail-more')!.getBoundingClientRect();
      return { x: menu.left + menu.width / 2, y: menu.top + menu.height / 2 };
    });
    await win.mouse.move(menuButton.x, menuButton.y);
    assert.equal(await hoverCard.count(), 0, 'the row menu button does not show a hover card');
    assert.equal(await projectRow.locator('button[aria-label="Pin chat"]').count(), 0, 'no pin button on rows');
    assert.equal((await readCard(win.locator(`.rail-recent[data-tid="native:${projectChat}"]`))).html, context, 'native chats share project and Recent hover context');
    await win.locator('#nativeChatInput').fill('Unsent plan for the home page');
    await win.locator(`.rail-term-add[data-id="${await win.evaluate(() => agentTab()!.id)}"]`).click();
    await win.getByRole('menuitem', {name:'Codex',exact:true}).click();
    await win.waitForFunction(id => { const next = document.querySelector<HTMLElement>('#nativeChatToolbar')!.dataset.chatId; return !!next && next !== id; }, projectChat);
    const secondChat = await win.locator('#nativeChatToolbar').getAttribute('data-chat-id');
    assert.equal(await win.locator('#nativeChatInput').inputValue(), '');
    await win.locator('#nativeChatInput').fill('Unsent plan for the about page');
    await win.evaluate(() => loadRoute('/about.html'));
    await win.waitForFunction(() => activeTab()!._previewLocation?.includes('about.html'));
    await win.evaluate(() => persistThreadPreview());
    await win.locator(`.rail-recent[data-tid="native:${projectChat}"]`).click();
    await win.waitForFunction(() => activeTab()!._previewLocation === '/');
    assert.equal(await win.locator('#nativeChatInput').inputValue(), 'Unsent plan for the home page');
    await win.locator(`.rail-recent[data-tid="native:${secondChat}"]`).click();
    await win.waitForFunction(() => activeTab()!._previewLocation?.includes('about.html'));
    const recent = win.locator(`.rail-recent[data-tid="native:${secondChat}"]`);
    await recent.click({button:'right'}); await win.getByRole('menuitem', {name:'Pin chat',exact:true}).click();
    await win.waitForFunction(id => document.querySelector(`.rail-recent[data-tid="native:${id}"]`)!.classList.contains('pinned'), secondChat);
    assert.equal(await recent.locator('.rail-pinned').count(), 1, 'a pinned chat shows its marker');
    await recent.click({button:'right'});
    await win.getByRole('menuitem', {name:'Rename',exact:true}).click();
    await win.locator('.rail-term-rename').fill('About page'); await win.locator('.rail-term-rename').press('Enter');
    await win.waitForFunction(id => document.querySelector(`.rail-recent[data-tid="native:${id}"] .rail-term-name`)!.textContent === 'About page', secondChat);
    await recent.click({button:'right'}); await win.getByRole('menuitem', {name:'Close chat',exact:true}).click();
    await win.locator(`.rail-term[data-tid="native:${secondChat}"]`).waitFor({state:'detached'});
    assert.equal(await recent.isVisible(), true, 'closed chats stay in Recents');
    assert.equal((await win.evaluate(id => window.radial.nativeChatGet(id), secondChat!)).archived, true);
    await recent.click();
    await win.locator(`.rail-term[data-tid="native:${secondChat}"]`).waitFor({state:'visible'});
    assert.equal((await win.evaluate(id => window.radial.nativeChatGet(id), secondChat!)).archived, false);
    assert.equal(await win.locator('#nativeChatInput').inputValue(), 'Unsent plan for the about page');

    await win.evaluate(()=>showHome());
    assert.equal(await win.locator('#rightDock').isVisible(), false);
    await win.locator(`.rail-recent[data-tid="native:${homeId}"]`).click();
    await win.waitForFunction(id=>document.querySelector<HTMLElement>('#nativeChatToolbar')!.dataset.chatId===id,homeId);
    assert.match((await win.locator('.native-chat-message.user').first().textContent())!,/Review this workspace/);
    assert.equal(await win.locator(`.rail-term[data-tid="native:${homeId}"]`).evaluate(el => el.classList.contains('active')), true, 'selected workspace conversation is highlighted');
    await win.reload();
    await win.locator(`.rail-recent[data-tid="native:${homeId}"]`).click();
    await win.locator('#nativeChatPanel').waitFor({state:'visible'});
    await win.waitForFunction(()=>document.querySelector('.native-chat-message.assistant'));
    assert.equal(await win.locator('#nativeChatEffort').textContent(), 'High');
    await win.locator('#nativeChatInput').fill('Continue'); await win.locator('#nativeChatSend').click();
    await win.locator('#nativeChatApproval [data-decision="accept"]').waitFor();
    await win.locator('#nativeChatStop').click();
    await win.waitForFunction(()=>document.querySelector<HTMLButtonElement>('#nativeChatStop')!.hidden);
    await win.locator('#nativeChatInput').fill('Show working indicator');
    await win.locator('#nativeChatSend').click();
    const working = win.locator('#nativeChatWorking');
    await working.waitFor({ state: 'visible' });
    assert.equal(await working.evaluate(el => el.parentElement!.id), 'nativeChatMessages');
    assert.equal(await working.evaluate(el => el === el.parentElement!.lastElementChild), true);
    assert.doesNotMatch((await win.locator('#nativeChatForm').textContent())!, /Working/);
    await win.emulateMedia({ reducedMotion: 'no-preference' });
    assert.equal(await working.locator('span').evaluate(el => getComputedStyle(el).animationName), 'text-shimmer');
    await win.screenshot({ path: path.join(scratch, 'chat-working.png') });
    await win.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await working.locator('span').evaluate(el => getComputedStyle(el).animationName), 'none');
    await win.locator('#nativeChatStop').click();
    await working.waitFor({ state: 'hidden' });
    // Provider choice creates an empty native conversation; Shell stays a real terminal.
    await win.evaluate(() => { _engineAvail = { claude: true, codex: true, cursor: true }; });
    for (const [label, engine] of [['Claude Code', 'claude'], ['Cursor', 'cursor']]) {
      await win.getByRole('button', { name: 'New workspace chat', exact: true }).press('Enter');
      await win.locator('[data-chat-pick="agent"]').click();
      await win.getByRole('menuitemradio', { name: label, exact: true }).click();
      await win.getByRole('menuitem', { name: 'Start chat', exact: true }).click();
      await until(`a ${label} chat on screen`, 30000, () => win.evaluate(async engine => (await window.radial.nativeChatGet(document.querySelector<HTMLElement>('#nativeChatToolbar')!.dataset.chatId!)).engine === engine, engine));
      assert.equal(await win.locator('#nativeChatModel').innerText(), label);
      assert.equal(await win.locator('.native-chat-message').count(), 0);
    }
    await win.getByRole('button', { name: 'New workspace chat', exact: true }).click();
    await win.locator('[data-chat-pick="agent"]').click();
    await win.getByRole('menuitemradio', { name: 'Shell', exact: true }).click();
    await win.getByRole('menuitem', { name: 'Start chat', exact: true }).click();
    await win.waitForFunction(() => homeTab.term && homeTab.term.engine === null);
    assert.equal(await win.locator('#nativeChatToolbar').isVisible(), false, 'a plain shell never claims to be the native conversation');
    assert.deepEqual(errors,[]);
    console.log('Chat screenshots:',scratch);
  } finally {await app.close();}
});
