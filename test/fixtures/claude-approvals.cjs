#!/usr/bin/env node
// Native stdio protocol fixture: two successive tools, then a completed turn.
const args = process.argv.slice(2), out = m => process.stdout.write(JSON.stringify(m) + '\n');
const full = args[args.indexOf('--permission-mode') + 1] === 'bypassPermissions';
let seq = 0, pending;
function complete() { out({ type: 'result', is_error: false, result: 'Done' }); }
function approval() { pending = String(++seq); out({ type: 'control_request', request_id: pending, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' } } }); }
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { models: [] } } });
  if (m.type === 'user') { seq = 0; if (full) complete(); else approval(); }
  if (m.type === 'control_response' && m.response.request_id === pending) { if (m.response.response?.behavior !== 'allow') process.exit(2); if (seq < 2) approval(); else complete(); }
});
