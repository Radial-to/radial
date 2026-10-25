// Opt-in integration check using installed, signed-in CLIs (uses model credits).
// It loads the app's TypeScript source, so it runs through tsx:
// Run: npx tsx scripts/test-native-chat-live.cts codex | claude <trusted-disposable-folder> | cursor
import type { IPty } from 'node-pty';
// What this check uses of src/main/nativeChat.ts and env.ts, declared once in
// test-native-chat-persistent.cts (which names the app's types they restate).
import type { EnvModule, NativeChatModule } from './test-native-chat-persistent.cts';

const root=(require('path') as typeof import('path')).resolve(__dirname,'..');
const {NativeChat}: NativeChatModule=require(root+'/src/main/nativeChat');
const {childEnv}: EnvModule=require(root+'/src/main/env');
const fs: typeof import('fs')=require('fs'),os: typeof import('os')=require('os'),path: typeof import('path')=require('path'),assert: typeof import('assert/strict')=require('assert/strict'),pty: typeof import('node-pty')=require(root+'/node_modules/node-pty');
const engine=process.argv[2];
if (!['codex','claude','cursor'].includes(engine)) { console.error('Usage: npx tsx scripts/test-native-chat-live.cts codex | claude <trusted-disposable-folder> | cursor'); process.exit(2); }
if (engine !== 'codex') { require('./test-native-chat-persistent.cts'); } else {
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'radial-live-audit-'+engine+'-'));
for (const key of ['RADIAL_CHAT_TEST_CLI','RADIAL_CHAT_TEST_CLAUDE','RADIAL_CHAT_TEST_CURSOR']) delete process.env[key];
let proc!: IPty,alive=false,out='',thread: string | null | undefined,trustHandled=false,hookHandled=false;
const sleep=(ms: number)=>new Promise<void>(r=>setTimeout(r,ms));
const wait=async(fn: () => boolean | Promise<boolean>,label: string,ms=60000)=>{const until=Date.now()+ms;while(Date.now()<until){if(await fn())return;await sleep(100);}throw Error('Timeout: '+label);};
const chat=new NativeChat({file:path.join(dir,'chats.json'),context:()=> 'This is an isolated Radial reliability test. Use no tools and change no files.',emit:()=>{},terminal:{
 start:async(cwd,o)=>{assert.ok(o.command.args.includes(thread!));out='';proc=pty.spawn(o.command.bin,o.command.args,{cwd,cols:120,rows:40,env:{...childEnv(),TERM:'xterm-256color'}});alive=true;proc.onExit(()=>{alive=false;});proc.onData(d=>{out+=d;fs.writeFileSync(path.join(dir,'terminal.txt'),out);if(d.includes('\x1b[6n'))proc.write('\x1b[1;1R');});return 'audit-pty';},
 list:async()=>alive?[{id:'audit-pty',alive,pid:proc.pid}]:[],write:(_id,data)=>proc.write(data),kill:()=>{if(alive)proc.kill();}
}});
(async()=>{
 const s=chat.create(dir,false,engine);await chat.send(s.id,'Remember the code RADIAL_MARIGOLD_742. Reply only SAVED. Do not use tools.');
 await wait(()=>['idle','error','approval'].includes(s.state),'initial response');assert.equal(s.state,'idle',s.error||'Unexpected approval');
 thread=s.threadId;assert.ok(thread);console.log(engine,'initial response saved',thread);
 await chat.setView(s.id,'terminal');
 await sleep(4000);
 await wait(()=>{if(!trustHandled&&/Yes,?Itrustthisfolder/i.test(out.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\s/g,''))){trustHandled=true;proc.write('\x1b[B');setTimeout(()=>proc.write('\r'),250);}if(!hookHandled&&out.includes('Hooks need review')){hookHandled=true;proc.write('3\r');}return /SAVED|RADIAL_MARIGOLD_742/.test(out);},'history rendered in real terminal');
 console.log(engine,'real terminal shows same conversation');
 await sleep(500);
 const prompt='Remember another code RADIAL_COBALT_913. Reply with this second code reversed. Do not use tools.';
 chat.recordTerminalInput('audit-pty',prompt);proc.write('\x1b[200~'+prompt+'\x1b[201~');await sleep(200);proc.write('\r');
 await wait(()=>/319_TLABOC_LAIDAR/.test(out.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')),'terminal response',90000);
 await wait(()=>s.state==='idle','terminal completion');
 await sleep(1000);
 await chat.setView(s.id,'chat',120,40,true);assert.equal(s.threadId,thread);assert.ok(s.messages.some(m=>m.role==='user'&&m.text.includes('RADIAL_COBALT_913')));
 console.log(engine,'terminal turn hydrated',s.messages.map(m=>m.role).join(','));
 await chat.send(s.id,'What are the two codes I asked you to remember? Reply only with both codes. Do not use tools.');
 await wait(()=>['idle','error','approval'].includes(s.state),'return response');assert.equal(s.state,'idle',s.error||'Unexpected approval');
 const answer=s.messages.filter(m=>m.role==='assistant').at(-1)?.text;assert.match(answer!,/RADIAL_MARIGOLD_742/);assert.match(answer!,/RADIAL_COBALT_913/);
 for(let i=0;i<3;i++){await chat.setView(s.id,'terminal');await sleep(600);await chat.setView(s.id,'chat',120,40,true);assert.equal(s.threadId,thread);assert.equal(s.messages.filter(m=>m.role==='user').length,3);}
 console.log(engine,'PASS: 4 round trips, native terminal message, recall of both codes; evidence',dir);
})().catch((e: Error)=>{console.error(engine,'FAIL',e.message,'evidence',dir);process.exitCode=1;}).finally(()=>{chat.close();if(alive)proc.kill();});

}
