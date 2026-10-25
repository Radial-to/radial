#!/usr/bin/env node
'use strict';
// A deterministic native CLI stand-in: real PTY input, native transcript files,
// Claude hook commands/status, and Cursor turn_ended records. Tests release
// output through a command journal instead of racing a timed response.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execSync } = require('node:child_process');
const args = process.argv.slice(2);
const root = path.join(process.env.RADIAL_USERDATA, 'native-fixture');
fs.mkdirSync(root, { recursive: true });
if (args[0] === 'create-chat') { console.log(randomUUID()); process.exit(0); }
if (args[0] === 'agents') {
  console.log(JSON.stringify(fs.readdirSync(root).filter(name => name.endsWith('.state.json')).map(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))).filter(state => state.engine === 'claude' && fs.realpathSync(state.cwd) === fs.realpathSync(args[args.indexOf('--cwd') + 1]))));
  process.exit(0);
}
const engine = args.includes('--settings') ? 'claude' : 'cursor';
const flag = args.includes('--session-id') ? '--session-id' : '--resume';
const sessionId = args[args.indexOf(flag) + 1];
if (!sessionId || !process.stdin.isTTY) throw new Error('Interactive fixture requires a native conversation and a real PTY');
const project = fs.realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-');
const transcript = engine === 'claude'
  ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', project, sessionId + '.jsonl')
  : path.join(process.env.CURSOR_CONFIG_DIR, 'projects', project, 'agent-transcripts', sessionId, sessionId + '.jsonl');
fs.mkdirSync(path.dirname(transcript), { recursive: true });
const stateFile = path.join(root, sessionId + '.state.json');
const commandFile = path.join(root, sessionId + '.commands.jsonl');
const state = { engine, args, sessionId, cwd: process.cwd(), pid: process.pid, status: 'idle', draft: '', prompts: [], interrupts: 0, outputs: [], processed: 0 };
const save = () => { fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state)); fs.renameSync(stateFile + '.tmp', stateFile); };
const record = value => fs.appendFileSync(transcript, JSON.stringify(value) + '\n');
const hooks = engine === 'claude' ? JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8')).hooks : null;
function hook(name, extra = {}) {
  for (const group of hooks?.[name] || []) for (const entry of group.hooks || []) execSync(entry.command, { input: JSON.stringify({ hook_event_name: name, session_id: sessionId, transcript_path: transcript, model: args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined, ...extra }), stdio: ['pipe', 'ignore', 'inherit'] });
}
function prompt() { process.stdout.write(engine === 'claude' ? '\r\n❯ ' + state.draft : '\r\n→ Add a follow-up ' + state.draft); }
function output(text) {
  const content = [{ type: 'text', text }];
  if (engine === 'claude') record({ type: 'assistant', sessionId, message: { id: randomUUID(), content } });
  else record({ role: 'assistant', message: { content } });
  state.outputs.push(text); save(); process.stdout.write('\r\n' + text + '\r\n');
}
function finish(interrupted = false) {
  if (state.status !== 'busy') return;
  if (engine === 'claude') hook('Stop', { last_assistant_message: state.outputs.at(-1) });
  else record({ type: 'turn_ended', status: interrupted ? 'aborted' : 'completed' });
  state.status = 'idle'; save(); prompt();
}
function submit() {
  if (state.status === 'busy' || !state.draft) return;
  const text = state.draft; state.draft = ''; state.prompts.push(text); state.status = 'busy'; save();
  const id = randomUUID();
  if (engine === 'claude') {
    record({ type: 'user', sessionId, uuid: id, message: { content: text } });
    hook('UserPromptSubmit', { prompt_id: id, prompt: text });
  } else {
    // Cursor replaces its final marker in place when the next turn starts.
    if (fs.existsSync(transcript)) {
      const lines = fs.readFileSync(transcript, 'utf8').trimEnd().split('\n');
      if (JSON.parse(lines.at(-1)).type === 'turn_ended') { lines.pop(); fs.writeFileSync(transcript, lines.join('\n') + '\n'); }
    }
    record({ role: 'user', generation_id: id, message: { content: [{ type: 'text', text: '<user_query>\n' + text + '\n</user_query>' }] } });
  }
  process.stdout.write('\r\n'); output('Response in progress ' + state.prompts.length);
  if (process.env.RADIAL_NATIVE_FIXTURE_AUTOFINISH === '1') {
    output((engine === 'claude' ? 'Claude' : 'Cursor') + ' received the draft.');
    setTimeout(() => finish(), 100);
  }
}
// Performance runs: a Claude-style turn. A spinner block redrawn in place
// (cursor up, erase, rewrite) at `fps`, and every `every` ms a few KB of reply
// printed above it plus a transcript entry, the way an Ink TUI streams a turn.
function stream({ seconds = 10, fps = 15, every = 2000, size = 3000 } = {}) {
  const spin = ['·', '✢', '✳', '✶', '✻', '✽'], started = Date.now();
  const words = 'the quick agent edits a file and checks the preview before it answers with a short summary of what changed'.split(' ');
  const reply = n => Array.from({ length: Math.ceil(size / 80) }, (_, i) => Array.from({ length: 13 }, (_, j) => words[(n * 7 + i * 13 + j) % words.length]).join(' ')).join('\r\n');
  let frame = 0, last = started;
  const block = () => '\r\x1b[2K' + spin[frame % spin.length] + ' Working… (' + Math.round((Date.now() - started) / 1000) + 's · ↓ ' + frame * 37 + ' tokens · esc to interrupt)\r\n\r\x1b[2K  ⎿  step ' + frame + '\r\n\r\x1b[2K';
  process.stdout.write('\r\n' + block());
  const timer = setInterval(() => {
    frame++;
    let out = '\x1b[2A';
    if (Date.now() - last >= every) {
      last = Date.now(); const text = reply(frame);
      record(engine === 'claude' ? { type: 'assistant', sessionId, message: { id: randomUUID(), content: [{ type: 'text', text: text.replace(/\r\n/g, '\n') }] } } : { role: 'assistant', message: { content: [{ type: 'text', text }] } });
      out += '\r\x1b[J' + text + '\r\n\r\n';
    }
    process.stdout.write(out + block());
    if (Date.now() - started >= seconds * 1000) { clearInterval(timer); process.stdout.write('\r\n'); finish(); }
  }, Math.round(1000 / fps));
}
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
let pending = '', paste = false;
process.stdin.on('data', data => {
  pending += data;
  // What a chunk types is echoed and saved once, the way a real CLI takes in a
  // paste: a save per character (a write and a rename each) made a Cursor
  // chat's first message, with its 3 to 6 KB of context, take seconds under
  // load (test/nativeFixture.test.ts).
  let typed = '', changed = false;
  const flush = () => { if (typed) { process.stdout.write(typed); typed = ''; } if (changed) { changed = false; save(); } };
  while (pending) {
    const markers = ['\x1b[200~', '\x1b[201~'];
    const marker = markers.find(value => pending.startsWith(value));
    if (marker) { paste = marker === markers[0]; pending = pending.slice(marker.length); continue; }
    if (markers.some(value => value.startsWith(pending)) && pending.length > 1) break;
    const char = pending[0]; pending = pending.slice(1);
    if (char === '\x03' || char === '\x1b') { flush(); state.interrupts++; save(); finish(true); }
    else if (!paste && (char === '\r' || char === '\n')) { flush(); submit(); }
    else if (char === '\x7f') { state.draft = state.draft.slice(0, -1); changed = true; }
    else { state.draft += char; typed += char; changed = true; }
  }
  flush();
});
// Performance runs: a resumed CLI repaints its conversation first, like Claude Code.
const history = Number(process.env.RADIAL_NATIVE_FIXTURE_RESUME_BYTES) || 0;
if (history && flag === '--resume') { const line = 'Earlier in this conversation the agent changed a file and summarized it. '; for (let n = 0; n < history; n += 8 * line.length) process.stdout.write((line.repeat(8) + '\r\n')); }
save(); hook('SessionStart'); prompt();
setInterval(() => {
  if (!fs.existsSync(commandFile)) return;
  const lines = fs.readFileSync(commandFile, 'utf8').split('\n').filter(Boolean);
  while (state.processed < lines.length) {
    const command = JSON.parse(lines[state.processed++]);
    if (command.type === 'output') output(command.text);
    if (command.type === 'finish') finish();
    if (command.type === 'stream') { if (state.status !== 'busy') { state.status = 'busy'; if (engine === 'claude') hook('UserPromptSubmit', { prompt_id: randomUUID(), prompt: 'stream' }); } stream(command); }
    save();
  }
}, 25);
