import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the app's window carries, as far as this test reaches into it inside the
// page: the preload's API and the window scripts' globals (the app's own
// declarations are src/renderer/globals.d.ts, types.d.ts and renderer.ts).
interface Tab { id: string; repoDir: string; _terminalsReady?: Promise<void> }
interface NativeChatApi { enabled(): boolean; select(id: string): Promise<void> }
declare const window: Window & typeof globalThis & { radial: RadialApi; RadialNativeChat: NativeChatApi };
declare const tabs: Tab[];
declare function activeTab(): Tab | null;
declare function tabByRepo(repoDir: string | null | undefined): Tab | null;
declare function switchTab(id: string): Promise<void>;
/** A request the Codex fixture logged (test/fixtures/codex-shared.cjs, RADIAL_CHAT_TEST_RESUME_LOG). */
interface CodexRequest { method: string; threadId?: string; pid: number; cwd: string }
/** What the native CLI fixture saves of its session (test/fixtures/native-interactive.cjs), as far as this test reads it. */
interface NativeFixtureState { args: string[]; prompts: string[] }
// Polls check() every 100 ms until it answers something truthy, and fails with the
// label and its last answer after ms. page.waitForFunction can't wait on an async
// check: the promise it returns is truthy, so it stops at the first poll.
const until=async<T,>(label: string,ms: number,check: ()=>Promise<T>): Promise<NonNullable<T>>=>{
  const t0=Date.now();let last: unknown;
  for(;;){
    try{const value=await check();if(value)return value;last=value;}catch(e){last=(e as Error).message;}
    if(Date.now()-t0>=ms)throw new Error(`timed out after ${ms} ms waiting for ${label} (last: ${JSON.stringify(last)})`);
    await new Promise(r=>setTimeout(r,100));
  }
};

test('restart restores open projects and selected Claude/Codex conversations without a new prompt', { timeout: 90000 }, async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radial-project-restore-'));
  const projects=['active-site','sleeping-site'].map(name=>path.join(dir,name));
  for(const p of projects){fs.mkdirSync(p);fs.writeFileSync(path.join(p,'index.html'),'<h1>Restored site</h1>');}
  // A project shows its most recent conversation (nativeChat.list is newest first):
  // the Claude chat (saved[0]) is the one on screen at launch, the Codex chat waits.
  const saved=['claude','codex','claude'].map((engine,i)=>({ id:randomUUID(),engine,threadId:randomUUID(),repoDir:projects[i===2?1:0],home:false,title:engine+' saved',state:'idle',viewMode:'chat',providerPersisted:engine==='claude',messages:[{id:randomUUID(),role:'user',text:'Existing conversation'}],createdAt:i+1,updatedAt:3-i }));
  const archived={...saved[0],id:randomUUID(),threadId:randomUUID(),archived:true};
  fs.writeFileSync(path.join(dir,'native-chats.json'),JSON.stringify([...saved,archived]));
  fs.writeFileSync(path.join(dir,'radial-store.json'),JSON.stringify({projectsDir:dir,recents:projects.map(p=>({path:p,name:path.basename(p),kind:'local'})),session:{open:projects,active:projects[0]}}));
  const log=path.join(dir,'codex-requests.jsonl');
  const env: Record<string, string>={...process.env,RADIAL_USERDATA:dir,CLAUDE_CONFIG_DIR:path.join(dir,'claude'),RADIAL_AUTO_RELOAD:'0',RADIAL_DAEMON_EPHEMERAL:'1',RADIAL_CHAT_EXPERIMENT:'1',RADIAL_CHAT_TEST_CLI:path.resolve('test/fixtures/codex-shared.cjs'),RADIAL_CHAT_TEST_CLAUDE:path.resolve('test/fixtures/native-interactive.cjs'),RADIAL_CHAT_TEST_RESUME_LOG:log};
  delete env.RADIAL_OPEN;
  const launch=()=>launchApp({executablePath:process.env.RADIAL_APP_PATH||path.resolve('node_modules/.bin/electron'),args:process.env.RADIAL_APP_PATH?[]:['.'],env});
  let app=await launch();
  const ready=async()=>{const page=await app.firstWindow();page.setDefaultTimeout(15000);await page.waitForFunction(p=>typeof tabs!=='undefined'&&tabs.length===2&&activeTab()?.repoDir===p,projects[0]);await page.waitForFunction(()=>window.RadialNativeChat?.enabled());await page.evaluate(()=>activeTab()!._terminalsReady);return page;};
  // A chat's CLI is running once main has given the chat a terminal.
  const started=(page: Page,id: string)=>until(`chat ${id}'s CLI to start`,15000,()=>page.evaluate(async id=>!!(await window.radial.nativeChatGet(id)).terminalId,id));
  const requests=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse as (text: string) => CodexRequest):[];
  try {
    let page=await ready();
    await started(page,saved[0].id);
    // A conversation nobody opened waits: no CLI starts for it at launch.
    assert.ok(!requests().some(r=>r.method==='thread/resume'&&r.threadId===saved[1].threadId),'an unopened Codex chat does not reconnect at launch');
    assert.equal((await page.evaluate(id=>window.radial.nativeChatGet(id),saved[2].id)).terminalId,null);
    // Opening it resumes its thread without a new prompt.
    await page.evaluate(id=>window.RadialNativeChat.select(id),saved[1].id);
    await page.waitForFunction(id=>document.getElementById('nativeChatToolbar')!.dataset.chatId===id,saved[1].id);
    for(let i=0;i<60&&!requests().some(r=>r.method==='thread/resume'&&r.threadId===saved[1].threadId);i++)await new Promise(r=>setTimeout(r,250));
    assert.ok(requests().some(r=>r.method==='thread/resume'&&r.threadId===saved[1].threadId),'opening the Codex chat resumes its thread');
    assert.ok(!requests().some(r=>r.method==='turn/start'));
    await page.evaluate(id=>window.RadialNativeChat.select(id),saved[0].id);
    await page.waitForFunction(id=>document.getElementById('nativeChatToolbar')!.dataset.chatId===id,saved[0].id);
    await app.close(); app=await launch();page=await ready();
    await page.waitForFunction(id=>document.getElementById('nativeChatToolbar')!.dataset.chatId===id,saved[0].id);
    await started(page,saved[0].id);
    for(const s of saved.slice(0,2)){
      const resumed=await page.evaluate(id=>window.radial.nativeChatGet(id),s.id);
      assert.equal(resumed.threadId,s.threadId);assert.equal(resumed.messages.filter(m=>m.role==='user').length,1);assert.ok(!resumed.error,resumed.error);
    }
    const resumedCodex=requests().filter(r=>r.method==='thread/resume'&&r.threadId===saved[1].threadId);
    assert.equal(new Set(resumedCodex.map(r=>r.pid)).size,1,'Codex reconnects when opened, not on every app launch');
    assert.ok(!requests().some(r=>r.method==='turn/start'));
    const claude=await page.evaluate(id=>window.radial.nativeChatGet(id),saved[0].id);
    // The CLI writes its state once it boots, a moment after its terminal attaches.
    const stateFile=path.join(dir,'native-fixture',claude.threadId+'.state.json');
    for(let i=0;i<80&&!fs.existsSync(stateFile);i++)await new Promise(r=>setTimeout(r,125));
    const native: NativeFixtureState=JSON.parse(fs.readFileSync(stateFile,'utf8'));
    assert.equal(native.args[native.args.indexOf('--resume')+1],saved[0].threadId);assert.deepEqual(native.prompts,[]);
    assert.ok(!fs.existsSync(path.join(dir,'native-fixture',archived.threadId+'.state.json')));
    await page.evaluate(p=>switchTab(tabByRepo(p)!.id),projects[1]);
    await started(page,saved[2].id);
    assert.equal((await page.evaluate(id=>window.radial.nativeChatGet(id),saved[2].id)).threadId,saved[2].threadId);
    assert.equal(await page.evaluate(()=>tabs.length),2);
  } finally {await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});
