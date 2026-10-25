#!/usr/bin/env node
if (process.stdin.isTTY || ['create-chat', 'agents'].includes(process.argv[2])) { require('./native-interactive.cjs'); } else {
const { randomUUID } = require('node:crypto');
const claude = process.argv.includes('--input-format');
const out = m => process.stdout.write(JSON.stringify(m) + '\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (claude) {
    if (m.type === 'control_request') out({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[{value:'fixture-claude',displayName:'Test Claude'}]}}});
    if (m.type === 'user') {out({type:'assistant',message:{id:randomUUID(),content:[{type:'text',text:'Claude received the draft.'}]}});out({type:'result',is_error:false});}
    return;
  }
  const result = (value = {}) => out({jsonrpc:'2.0',id:m.id,result:value});
  if (m.method === 'initialize') result({protocolVersion:1,agentCapabilities:{promptCapabilities:{image:true}}});
  else if (m.method === 'cursor/list_available_models') result({models:[{value:'fixture-cursor',name:'Test Cursor'}]});
  else if (['session/new','session/load'].includes(m.method)) result({sessionId:m.params.sessionId || randomUUID()});
  else if (m.method === 'session/prompt') {out({jsonrpc:'2.0',method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Cursor received the draft.'}}}});result({stopReason:'end_turn'});}
  else result();
});

}
