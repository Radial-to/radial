#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--input-format')) {
  let prompt;
  const out = m => process.stdout.write(JSON.stringify(m) + '\n');
  require('readline').createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    if (m.type === 'user') { prompt = m; out({type:'assistant',message:{id:'in-progress',content:[{type:'text',text:'Response in progress'}]}}); }
    if (m.request?.subtype === 'interrupt' && prompt) setTimeout(() => {
      const fs = require('fs'), path = require('path');
      const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', fs.realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'));
      fs.mkdirSync(dir,{recursive:true});
      fs.writeFileSync(path.join(dir,prompt.session_id+'.jsonl'), JSON.stringify({type:'user',sessionId:prompt.session_id,uuid:prompt.uuid,message:prompt.message})+'\n');
      out({type:'result',is_error:false,result:'Interrupted'});
    }, 300);
    if (m.type === 'control_request') process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { models: [] } } }) + '\n');
  });
} else {
  const flag = args.includes('--resume') ? '--resume' : '--session-id';
  process.stdout.write('Claude thread ' + args[args.indexOf(flag) + 1] + '\r\n');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', data => { if (data.includes(4)) process.exit(0); process.stdout.write(data); });
}
