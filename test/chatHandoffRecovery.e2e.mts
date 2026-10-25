import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ChatEngine} from '../src/shared/chatPermissions.ts';
import type {RadialApi} from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the app's window carries that this check reaches (src/renderer/globals.d.ts, types.d.ts).
/** The Home pseudo-tab (renderer.ts homeTab): its folder is known once main answers. */
interface HomeTab {repoDir:string|null}
/** The native chat panel (nativeChat.ts). */
interface NativeChatPanel {enabled():boolean;createFor(tab:HomeTab,engine?:ChatEngine):Promise<void>}
interface AppWindow extends Window {radial:RadialApi;RadialNativeChat:NativeChatPanel}
declare const window:AppWindow;
declare const homeTab:HomeTab;

test('an unavailable CLI leaves the draft intact and lets an empty chat choose another provider', {timeout:60000}, async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radial-chat-recovery-'));
  fs.writeFileSync(path.join(dir,'radial-store.json'),JSON.stringify({projectsDir:dir,recents:[],session:{open:[],active:null}}));
  const app=await launchApp({executablePath:process.env.RADIAL_APP_PATH||path.resolve('node_modules/.bin/electron'),args:process.env.RADIAL_APP_PATH?[]:['.'],env:{...process.env,RADIAL_USERDATA:dir,RADIAL_OPEN:' ',RADIAL_AUTO_RELOAD:'0',RADIAL_DAEMON_EPHEMERAL:'1',RADIAL_CHAT_EXPERIMENT:'1',RADIAL_CHAT_TEST_CLI:path.resolve('test/fixtures/codex-shared.cjs'),RADIAL_CHAT_TEST_CLAUDE:path.join(dir,'missing-claude')}});
  try {
    const page=await app.firstWindow();page.setDefaultTimeout(10000);
    await page.waitForFunction(()=>window.RadialNativeChat?.enabled()&&typeof homeTab!=='undefined'&&homeTab.repoDir);
    await page.evaluate(()=>window.RadialNativeChat.createFor(homeTab,'claude'));
    const id=(await page.locator('#nativeChatToolbar').getAttribute('data-chat-id'))!;
    await page.locator('#nativeChatInput').fill('Keep my unsent message');
    await page.locator('[data-chat-view=terminal]').click();
    await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('[data-chat-view=terminal]')!.disabled && document.getElementById('nativeChatStatus')!.textContent!.includes('ENOENT'));
    assert.equal(await page.locator('[data-chat-view=chat]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#nativeChatInput').inputValue(),'Keep my unsent message');
    assert.ok(!(await page.locator('#nativeChatStatus').textContent())!.includes('Error invoking remote method'));
    await page.locator('#nativeChatModel').click();
    await page.getByRole('menuitemradio',{name:'Codex',exact:true}).click();
    await page.getByRole('menuitemradio',{name:'Test Codex',exact:true}).click();
    const session=await page.evaluate(id=>window.radial.nativeChatGet(id),id);
    assert.equal(session.engine,'codex');assert.equal(session.state,'idle');assert.equal(session.messages.length,0);
    assert.equal(await page.locator('#nativeChatInput').inputValue(),'Keep my unsent message');
    assert.equal(await page.locator('#nativeChatToolbar').getAttribute('data-chat-id'),id);
    await page.locator('#nativeChatSend').click();
    await page.locator('#nativeChatApproval [data-decision=accept]').waitFor();
    await page.locator('#nativeChatApproval [data-decision=accept]').click();
    await page.waitForFunction(()=>document.getElementById('nativeChatStop')!.hidden);
    assert.equal((await page.evaluate(id=>window.radial.nativeChatGet(id),id)).messages.filter(m=>m.role==='user').length,1);
  } finally {await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});
