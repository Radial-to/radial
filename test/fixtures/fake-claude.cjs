#!/usr/bin/env node
'use strict';
// A stand-in for Claude Code in the terminals Radial starts, for the core's
// agent lane with no window (src/core/agentLane.ts; test/coreHeadless.test.ts,
// test/headless.e2e.mts). Like agentLane.e2e.mts's stand-ins, in one script:
// - it answers the version probe (99.0.0, so it wins over a real install);
// - in a folder it trusts it prints its task (its first prompt), rings the bell
//   (what Claude Code does when a turn completes), then echoes each submitted
//   line with a bell, like a new turn;
// - in a folder with an UNTRUSTED file it first asks Claude Code 2.1's trust
//   question, in its words and layout: Enter picks the focused "No, exit" and
//   quits; arrow down, then Enter, trusts the folder. Then its input prompt,
//   which takes typed or pasted text and submits it on Enter; a first prompt
//   runs once the folder is trusted;
// - it keeps its conversation where Claude Code does ($CLAUDE_CONFIG_DIR/
//   projects/<munged folder>/<session id>.jsonl, written once it has a prompt),
//   so a session put to sleep can be resumed (--resume);
// - it logs each event to $RADIAL_FAKE_CLI_LOG as a JSON line: start (with its
//   task, session ids, whether it had Home's brief, and whether its prompt
//   carried the notes an open writes into AGENTS.md), resumed, submit,
//   typed-into-question, declined, trusted, run and draft.
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('99.0.0 (Claude Code)'); process.exit(0); }
const VALUED = new Set(['--session-id', '--resume', '--append-system-prompt', '--settings', '--model', '--permission-mode']);
const opts = {};
let task = null;
for (let i = 0; i < args.length; i++) {
  if (VALUED.has(args[i])) { opts[args[i]] = args[i + 1]; i++; }
  else if (!args[i].startsWith('--')) task = args[i];
}
const cwd = fs.realpathSync(process.cwd());
const log = (event, extra = {}) => { if (process.env.RADIAL_FAKE_CLI_LOG) fs.appendFileSync(process.env.RADIAL_FAKE_CLI_LOG, JSON.stringify({ pid: process.pid, cwd, event, ...extra }) + '\n'); };
const session = opts['--resume'] || opts['--session-id'] || null;
// Only under a test's own config folder: never in the person's ~/.claude.
const transcript = session && process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), session + '.jsonl') : null;
const record = (text) => { if (!transcript) return; fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.appendFileSync(transcript, JSON.stringify({ type: 'user', text }) + '\n'); };
log('start', { task, sessionId: opts['--session-id'] || null, resume: opts['--resume'] || null, home: /RADIAL HOME/.test(opts['--append-system-prompt'] || ''), agentsNotes: /## Radial state files/.test(opts['--append-system-prompt'] || '') });
if (opts['--resume']) log('resumed', { session: opts['--resume'], found: !!transcript && fs.existsSync(transcript) });

if (!fs.existsSync(path.join(cwd, 'UNTRUSTED'))) {
  // A folder it trusts: line by line, as a plain terminal reads them.
  process.stdout.write('FAKE CLAUDE ready\n');
  if (task) { record(task); process.stdout.write(`TASK: ${task}\n`); }
  setTimeout(() => {
    process.stdout.write('turn done\x07\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const text = line.replace(/\x1b\[20[01]~/g, ''); // a paste's markers, as the terminal passed them on
      record(text); log('submit', { text });
      process.stdout.write(`SUBMITTED: ${text}\x07\n`);
    });
  }, 400);
} else {
  // A folder it doesn't trust yet: Claude Code's question first, key by key. Its rules span the terminal, as Claude
  // Code's do, and it draws again when the terminal is resized.
  const rule = () => '─'.repeat(process.stdout.columns || 80);
  let trusted = false, focus = 0, draft = '';
  const draw = (lines) => process.stdout.write('\x1b[2J\x1b[H' + lines.map((l) => (l === RULE ? rule() : l)).join('\r\n'));
  const RULE = '\0rule';
  const question = () => draw([RULE, ' Accessing workspace:', '', ' ' + process.cwd(), '', ' Quick safety check: Is this a project you created or one you trust?', '', " Claude Code'll be able to read, edit, and execute files here.", '', (focus === 0 ? ' ❯ ' : '   ') + 'No, exit', (focus === 1 ? ' ❯ ' : '   ') + 'Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel']);
  const prompt = () => draw([' Claude Code v99.0.0', ...(task ? ['', 'TASK: ' + task] : []), RULE, '❯ ' + draft, RULE, '  ? for shortcuts']);
  process.stdout.on('resize', () => (trusted ? prompt() : question()));
  process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    for (const key of data.match(/\x1b\[200~[\s\S]*?\x1b\[201~|\x1b[[O][A-D]|[\s\S]/g) || []) {
      if (!trusted) {
        if (/^\x1b[[O]A$/.test(key)) { focus = 0; question(); }
        else if (/^\x1b[[O]B$/.test(key)) { focus = 1; question(); }
        else if (key === '\r') {
          if (focus === 0) { log('declined'); process.exit(1); }
          trusted = true; log('trusted'); if (task) { record(task); log('run', { text: task }); } prompt();
        } else log('typed-into-question', { text: key });
        continue;
      }
      if (key === '\r') { record(draft); log('submit', { text: draft }); draft = ''; }
      else if (key.startsWith('\x1b[200~')) draft += key.slice(6, -6);
      else if (!key.startsWith('\x1b')) draft += key;
      log('draft', { text: draft }); prompt();
    }
  });
  question();
}
