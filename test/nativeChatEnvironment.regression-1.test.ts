// Regression: ISSUE-003 — native chat could query a different installed app.
// Found by /qa on 2026-10-04.
// Report: .gstack/qa-reports/qa-report-radial-2026-10-04.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NativeChatTransport, NativeChatTransportOptions } from '../src/main/nativeChat';
import type { FakeTransport } from './support/nativeChat';
import { tmpDir } from './support/tmp';
const fs=require('fs') as typeof import('fs'),os=require('os') as typeof import('os'),path=require('path') as typeof import('path');
const {NativeChat}=require('../src/main/nativeChat') as typeof import('../src/main/nativeChat');
test('every provider receives the owning profile CLI socket for discovery and conversations',async()=>{
  const dir=tmpDir('radial-chat-env-'),options: NativeChatTransportOptions[]=[];
  const chat=new NativeChat({file:path.join(dir,'native-chats.json'),context:()=>'',emit:()=>{},transport:o=>{options.push(o);return{initialize:async()=>{},close(){},request:async method=>method==='model/list'?{data:[]}:{thread:{id:'fixture'}}} satisfies FakeTransport as NativeChatTransport;}});
  try{for(const engine of ['codex','claude','cursor'] as const){await chat.models(dir,engine);await chat.connect(chat.create(dir,false,engine));}assert.equal(options.length,6);for(const option of options)assert.equal(option.env.RADIAL_CLI_SOCK,path.join(dir,'cli.sock'));}
  finally{chat.close();fs.rmSync(dir,{recursive:true,force:true});}
});
