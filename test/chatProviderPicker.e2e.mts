import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenProjectResult, OpenedProject, RadialApi } from '../src/shared/radialApi.ts';
import type { ChatEngine } from '../src/shared/chatPermissions.ts';
import { launchApp } from './support/app.ts';

// What the app's window has that this test reaches inside page.evaluate: the
// preload's API, the native chat (nativeChat.ts) and window scripts' top-level
// declarations (src/renderer/globals.d.ts and types.d.ts have the full types).
// They are declared as always there; the boot poll still guards them, because
// firstWindow() can resolve before the window's scripts have run.
/** A terminal in a tab's list (renderer TermSession), the fields read here. */
interface PageTerm { engine: ChatEngine | null; _exited?: boolean }
/** A project, or Home's agent (renderer AnyTab), the fields read here. */
interface PageAnyTab { id: string; repoDir: string | null; terminals?: PageTerm[] }
/** An open project (renderer Tab), the fields read here. */
interface PageProjectTab extends PageAnyTab { repoDir: string }
/** The native chat's window API (renderer RadialNativeChatApi), the methods called here. */
interface NativeChatApi { enabled(): boolean; active(): boolean; refresh(): Promise<void> | undefined; createFor(tab: PageAnyTab, engine?: ChatEngine): Promise<void> }
/** openProjectPath's answer (renderer OpenProjectResultWithDir), its error readable on either branch (OpenedProject has no `error?: undefined` of its own yet). */
type OpenResult = (OpenedProject & { error?: undefined }) | (Extract<OpenProjectResult, { ok: false }> & { repoDir?: string });
declare const window: Window & typeof globalThis & { radial: RadialApi; RadialNativeChat: NativeChatApi };
declare function openProjectPath(dir: string): Promise<OpenResult>;
declare function activeTab(): PageProjectTab | null;
declare function agentTab(): PageAnyTab | null;

test('new project and empty chat pickers change native providers/models and retain drafts and files', {timeout:90000}, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'radial-provider-picker-'));
  const first=path.join(root,'first'), second=path.join(root,'second');
  for(const dir of [first,second]) {fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'index.html'),'<h1>Provider picker QA</h1>');}
  const app=await launchApp({executablePath:process.env.RADIAL_APP_PATH || path.resolve('node_modules/.bin/electron'),args:process.env.RADIAL_APP_PATH ? [] : ['.'],env:{...process.env,RADIAL_USERDATA:path.join(root,'profile'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),CURSOR_CONFIG_DIR:path.join(root,'cursor'),RADIAL_NATIVE_FIXTURE_AUTOFINISH:'1',RADIAL_OPEN:' ',RADIAL_AUTO_RELOAD:'0',RADIAL_DAEMON_EPHEMERAL:'1',RADIAL_CHAT_EXPERIMENT:'1',RADIAL_CHAT_TEST_CLI:path.resolve('test/fixtures/codex-shared.cjs'),RADIAL_CHAT_TEST_CLAUDE:path.resolve('test/fixtures/provider-picker.cjs'),RADIAL_CHAT_TEST_CURSOR:path.resolve('test/fixtures/provider-picker.cjs')}});
  try {
    const page=await app.firstWindow();page.setDefaultTimeout(10000);
    const errors: string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.waitForFunction(()=>typeof openProjectPath==='function'&&window.RadialNativeChat?.enabled());
    await page.evaluate(()=>localStorage.setItem('radial.chatView.project','chat')); // This covers the Chat view; projects open in Terminal by default.
    await page.evaluate(dir=>openProjectPath(dir),first);
    await page.locator('#nativeChatInput').fill('Keep my draft');
    await page.locator('#nativeChatForm input[type=file]').setInputFiles({name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('Provider context')});
    await page.getByRole('button',{name:'Remove notes.txt',exact:true}).waitFor();
    await page.locator('#nativeChatPermissions').click();await page.getByRole('menuitemradio',{name:'Full access · no approvals',exact:true}).click();
    await page.locator('#nativeChatModel').click();
    for(const label of ['Codex','Claude Code','Cursor']) {const row=page.getByRole('menuitemradio',{name:label,exact:true});await row.waitFor();assert.ok(await row.locator('.fluid-central-icon svg').count() > 0);}
    await page.getByRole('menuitem',{name:'Shell / other CLI',exact:true}).waitFor();
    await page.screenshot({path:path.join(root,'provider-menu.png')});
    await page.getByRole('menuitemradio',{name:'Claude Code',exact:true}).click();
    await page.getByRole('menuitemradio',{name:'Test Claude',exact:true}).click();
    assert.equal(await page.locator('#nativeChatPermissions').textContent(),'Use Claude Code settings');
    assert.equal(await page.locator('#nativeChatInput').inputValue(),'Keep my draft');
    assert.equal(await page.evaluate(async dir=>(await window.radial.nativeChatList(dir)).length,first),0,'provider/model selection does not create unused chats');
    await page.locator('#nativeChatModel').click();await page.getByRole('menuitemradio',{name:'Cursor',exact:true}).click();
    await page.getByRole('menuitemradio',{name:'Test Cursor',exact:true}).click();
    await page.evaluate(dir=>openProjectPath(dir),second);
    await page.waitForFunction(()=>document.getElementById('nativeChatModel')!.textContent==='Codex');
    await page.evaluate(dir=>openProjectPath(dir),first);
    await page.waitForFunction(()=>document.getElementById('nativeChatModel')!.textContent==='Test Cursor');
    assert.equal(await page.locator('#nativeChatInput').inputValue(),'Keep my draft');
    assert.equal(await page.getByRole('button',{name:'Remove notes.txt',exact:true}).count(),1);
    await page.locator('#nativeChatSend').click();
    await page.waitForFunction(()=>document.querySelector('.native-chat-message.assistant')&&document.getElementById('nativeChatStop')!.hidden);
    const id=await page.locator('#nativeChatToolbar').getAttribute('data-chat-id');
    let s=await page.evaluate(id=>window.radial.nativeChatGet(id),id!);
    assert.equal(s.engine,'cursor');assert.equal(s.model,'fixture-cursor');assert.equal(s.messages.find(m=>m.role==='user')!.attachments!.length,1);
    await page.locator('#nativeChatModel').click();await page.getByRole('menuitem',{name:'Change model in Terminal',exact:true}).waitFor();
    assert.equal(await page.getByRole('menuitemradio',{name:'Claude Code',exact:true}).count(),0,'started conversations retain their native provider');
    await page.keyboard.press('Escape');
    await page.evaluate(()=>window.RadialNativeChat.createFor(agentTab()!,'codex'));
    const emptyId=await page.locator('#nativeChatToolbar').getAttribute('data-chat-id');
    await page.locator('#nativeChatInput').fill('Another unsent draft');
    await page.locator('#nativeChatModel').press('ArrowDown');await page.getByRole('menuitemradio',{name:'Claude Code',exact:true}).click();
    await page.getByRole('menuitemradio',{name:'Test Claude',exact:true}).click();
    s=await page.evaluate(id=>window.radial.nativeChatGet(id),emptyId!);
    assert.equal(s.engine,'claude');assert.equal(s.title,'Claude Code');assert.equal(s.model,'fixture-claude');
    assert.equal(await page.locator('#nativeChatInput').inputValue(),'Another unsent draft');
    assert.equal(await page.locator('#nativeChatToolbar').getAttribute('data-chat-id'),emptyId);
    await page.locator('#nativeChatSend').click();await page.waitForFunction(()=>document.querySelector('.native-chat-message.assistant')&&document.getElementById('nativeChatStop')!.hidden);
    s=await page.evaluate(id=>window.radial.nativeChatGet(id),emptyId!);assert.equal(s.engine,'claude');assert.equal(s.messages.filter(m=>m.role==='user').length,1);
    await page.evaluate(dir=>openProjectPath(dir),second);
    await page.locator('#nativeChatInput').fill('Shell option keeps my draft');
    await page.locator('#nativeChatModel').click();
    await page.getByRole('menuitem',{name:'Shell / other CLI',exact:true}).click();
    await page.waitForFunction(()=>!window.RadialNativeChat.active() && activeTab()!.terminals?.some(t=>!t.engine && !t._exited));
    assert.equal(await page.evaluate(async dir=>(await window.radial.nativeChatList(dir)).length,second),0);
    await page.evaluate(()=>window.RadialNativeChat.refresh());
    assert.equal(await page.locator('#nativeChatInput').inputValue(),'Shell option keeps my draft');
    assert.deepEqual(errors,[]);console.log('Provider picker screenshot:',path.join(root,'provider-menu.png'));
  } finally {await app.close();}
});
