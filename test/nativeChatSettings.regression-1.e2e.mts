/// <reference path="../src/renderer/types.d.ts" />
// Regression: ISSUE-002 — composer choices were dead during an approval.
// Found by /qa on 2026-10-04.
// Report: .gstack/qa-reports/qa-report-radial-2026-10-04.md
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';
/**
 * The app window (page functions run there): the globals this test uses (src/renderer/globals.d.ts).
 * RadialNativeChat (types.d.ts RadialNativeChatApi) is read only through ?., while the page may not have loaded nativeChat.js yet.
 */
declare const window: Window & typeof globalThis & { radial: RadialApi; RadialNativeChat?: RadialNativeChatApi };
/** renderer.ts's Home agent (types.d.ts HomeTab), which page functions reach by name. */
declare const homeTab: HomeTab;
test('settings remain usable during approvals and apply only to the next message', {timeout:60000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'radial-chat-settings-'));
  fs.writeFileSync(path.join(dir,'radial-store.json'),JSON.stringify({projectsDir:dir,recents:[],session:{open:[],active:null}}));
  const app = await launchApp({executablePath:process.env.RADIAL_APP_PATH || path.join(process.cwd(),'node_modules/.bin/electron'),args:process.env.RADIAL_APP_PATH ? [] : ['.'],env:{...process.env,RADIAL_USERDATA:dir,RADIAL_CHAT_EXPERIMENT:'1',RADIAL_CHAT_TEST_CLI:path.join(process.cwd(),'test/fixtures/codex-shared.cjs'),RADIAL_OPEN:' ',RADIAL_AUTO_RELOAD:'0',RADIAL_DAEMON_EPHEMERAL:'1'}});
  try {
    const win=await app.firstWindow(); const errors:string[]=[]; win.on('pageerror',e=>errors.push(e.message));
    await win.waitForFunction(()=>typeof homeTab!=='undefined'&&homeTab.repoDir&&window.RadialNativeChat?.enabled());
    await win.locator('#hgChatInput').fill('Review this workspace');await win.locator('#hgChatSend').click();
    await win.locator('#nativeChatApproval [data-decision=accept]').waitFor();
    await win.locator('#nativeChatPermissions').click();
    await win.getByRole('menuitemradio',{name:'Read only',exact:true}).click();
    await win.locator('#nativeChatModel').click();await win.getByRole('menuitemradio',{name:'Test Codex',exact:true}).click();
    await win.locator('#nativeChatEffort').click();await win.getByRole('menuitemradio',{name:'High',exact:true}).click();
    await win.waitForFunction(()=>document.getElementById('nativeChatStatus')!.textContent.includes('Changes apply to next message'));
    let s=await win.evaluate(()=>window.radial.nativeChatGet(document.getElementById('nativeChatToolbar')!.dataset.chatId!));
    assert.equal(s.state,'approval');assert.notEqual(s.permissionMode,'read-only');assert.equal(s.pendingSettings!.permissionMode,'read-only');assert.equal(s.pendingSettings!.effort,'high');
    await win.screenshot({path:path.join(dir,'queued-settings.png')});
    await win.locator('#nativeChatApproval [data-decision=accept]').click();await win.waitForFunction(()=>document.getElementById('nativeChatStop')!.hidden);
    await win.locator('#nativeChatInput').fill('Continue the review');await win.locator('#nativeChatSend').click();
    await win.locator('#nativeChatApproval [data-decision=accept]').waitFor();
    s=await win.evaluate(()=>window.radial.nativeChatGet(document.getElementById('nativeChatToolbar')!.dataset.chatId!));
    assert.equal(s.permissionMode,'read-only');assert.equal(s.effort,'high');assert.equal(s.pendingSettings,null);assert.equal(s.messages.filter(m=>m.role==='user').length,2);
    await win.locator('[data-chat-view=terminal]').click();await win.waitForFunction(()=>!document.body.classList.contains('native-chat'));
    await win.locator('[data-chat-view=chat]').click();await win.locator('#nativeChatApproval [data-decision=accept]').waitFor();
    assert.equal((await win.evaluate(()=>window.radial.nativeChatGet(document.getElementById('nativeChatToolbar')!.dataset.chatId!))).threadId,s.threadId);
    assert.deepEqual(errors,[]);console.log('Settings QA screenshot:',path.join(dir,'queued-settings.png'));
  } finally {await app.close();}
});
