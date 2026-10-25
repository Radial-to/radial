#!/usr/bin/env node
// Deterministic CLI fixture: both the JSON client and the PTY join this server.
const fs = require('fs'), http = require('http'), net = require('net'), { randomUUID } = require('crypto');
const readline = require('readline'), WebSocket = require('ws');
const args = process.argv.slice(2), at = flag => args[args.indexOf(flag) + 1];
const models = [{ model:'fixture-codex',displayName:'Test Codex',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}] }];
if (args.includes('--remote')) {
  const ws = new WebSocket('ws://localhost', { createConnection: () => net.createConnection(at('--remote').slice(7)) });
  let seq = 10, thread, approval, line = '';
  const send = (method, params) => ws.send(JSON.stringify({ id: ++seq, method, params }));
  ws.on('open', () => send('initialize', {}));
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id === 11) { ws.send(JSON.stringify({ method:'initialized', params:{} })); send(args[0] === 'resume' ? 'thread/resume' : 'thread/start', { threadId:args[1] }); }
    if (m.id === 12) { thread = m.result.thread.id; process.stdout.write('Shared thread ' + thread + '\r\n'); }
    if (m.method === 'item/agentMessage/delta') process.stdout.write(m.params.delta + '\r\n');
    if (m.method?.includes('requestApproval')) { approval = m.id; process.stdout.write('Allow or deny?\r\n'); }
    if (m.method === 'serverRequest/resolved') approval = null;
  });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', data => {
    for (const c of data.toString()) {
      if (c === '\r' || c === '\n') {
        if (line === '/exit') { ws.close(); process.exit(0); }
        else if (line === 'deny' && approval) ws.send(JSON.stringify({ id:approval,result:{decision:'decline'} }));
        else if (line.trim() && thread) send('turn/start', { threadId:thread,input:[{type:'text',text:line}] });
        line = '';
      } else line += c;
    }
  });
  ws.on('close', () => process.exit(0));
} else {
  let thread = randomUUID(), turn = 0, history = [], pending = null;
  const clients = new Set();
  const broadcast = message => { for (const send of clients) send(message); };
  function handle(m, send) {
    if (process.env.RADIAL_CHAT_TEST_RESUME_LOG) fs.appendFileSync(process.env.RADIAL_CHAT_TEST_RESUME_LOG, JSON.stringify({ method: m.method, threadId: m.params?.threadId, pid: process.pid, cwd: process.cwd() }) + '\n');
    if (m.method === 'thread/resume' && m.params?.threadId) thread = m.params.threadId;
    if (m.method === 'initialize') { clients.add(send); send({id:m.id,result:{userAgent:'fixture'}}); }
    if (m.method === 'model/list') send({id:m.id,result:{data:models,nextCursor:null}});
    if (m.method === 'config/read') send({id:m.id,result:{config:process.env.RADIAL_CHAT_TEST_CODEX_CONFIG ? JSON.parse(process.env.RADIAL_CHAT_TEST_CODEX_CONFIG) : {},origins:{}}});
    if (m.method === 'thread/start' || m.method === 'thread/resume') {
      send({id:m.id,result:{thread:{id:thread},model:'fixture-codex',reasoningEffort:'medium'}});
      if (m.method === 'thread/start') broadcast({method:'thread/started',params:{thread:{id:thread}}});
    }
    if (m.method === 'thread/items/list') send({id:m.id,result:{data:history.map(item=>({item,turnId:'turn-'+turn})),nextCursor:null}});
    if (m.method === 'turn/start') {
      turn++; send({id:m.id,result:{turn:{id:'turn-'+turn}}});
      broadcast({method:'turn/started',params:{threadId:thread,turn:{id:'turn-'+turn}}});
      const user={id:'user-'+turn,type:'userMessage',content:m.params.input};history.push(user);
      broadcast({method:'item/completed',params:{threadId:thread,item:user}});
      const tool={id:'tool-'+turn,type:'commandExecution',command:'cat index.html',aggregatedOutput:'<h1>Hello</h1>',status:'completed'};history.push(tool);
      broadcast({method:'item/completed',params:{threadId:thread,item:tool}});
      const rich = m.params.input.some(item => item.text?.startsWith('Rich response demo'));
      const answer={id:'answer-'+turn,type:'agentMessage',text:rich ? '# Preview ready\n\n| File | Status |\n| --- | --- |\n| index.html | Updated |\n\n- [x] Check navigation\n  - Verify mobile\n\n```js\nconst ready = true;\n```\n\n[Open source](index.html)' : 'The website is ready. **Navigation** is clear.'};history.push(answer);
      broadcast({method:'item/agentMessage/delta',params:{threadId:thread,itemId:answer.id,delta:answer.text}});
      if (rich || (process.env.RADIAL_CHAT_TEST_HONOR_PERMISSIONS === '1' && m.params.approvalPolicy === 'never')) { broadcast({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-'+turn,status:'completed'}}}); return; }
      if (m.params.input.some(item => item.text === 'Show working indicator')) return;
      if (m.params.input.some(item => item.text === 'Ask options')) { pending = 900+turn; broadcast({id:pending,method:'item/tool/requestUserInput',params:{threadId:thread,questions:[{id:'color',question:'Which colors?',multiSelect:true,options:[{label:'Green',description:'Natural accents'},{label:'Blue',description:'Cool accents'}]}]}}); return; }
      pending = 900+turn;
      broadcast({id:pending,method:'item/commandExecution/requestApproval',params:{threadId:thread,command:'npm test',reason:'Run project checks', ...(m.params.input.some(item => item.text === 'Remember Radial commands') ? { command: 'radial open /sites/example', proposedExecpolicyAmendment: ['radial', 'open'] } : {})}});
    }
    if (m.id === pending && m.result) {
      const id=pending;pending=null;
      broadcast({method:'serverRequest/resolved',params:{threadId:thread,requestId:id}});
      history.at(-1).text += ' Your permission choice was received.';
      broadcast({method:'item/agentMessage/delta',params:{threadId:thread,itemId:'answer-'+turn,delta:' Your permission choice was received.'}});
      broadcast({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-'+turn,status:'completed'}}});
    }
    if (m.method === 'turn/interrupt') { send({id:m.id,result:{}});pending=null;broadcast({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-'+turn,status:'interrupted'}}}); }
  }
  if (args.includes('--listen')) {
    const server=http.createServer(), wss=new WebSocket.Server({server});
    wss.on('connection',ws=>{const send=m=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(m));};ws.on('message',raw=>handle(JSON.parse(raw),send));ws.on('close',()=>clients.delete(send));});
    server.listen(at('--listen').slice(7));
  } else {
    const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
    readline.createInterface({input:process.stdin}).on('line',line=>handle(JSON.parse(line),send));
  }
}
