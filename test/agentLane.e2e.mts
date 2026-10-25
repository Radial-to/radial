// The write and agent lanes (plans/radial-agent-native.md) against the real
// app: a scratch profile, a static fixture, and a FAKE `claude` on PATH that
// prints its task, rings BEL (what Claude Code does when a turn completes) and
// echoes anything submitted on stdin. Through bin/radial:
//   agent start --submit → the task rides as the CLI's argument; agent wait
//   resolves on the bell with the rendered screen; a staged start leaves the
//   prompt unsent; agent list / output / kill; edit text, meta set, comments,
//   moments write through the same engines the panels use.
//
// Opt-in: `npm run test:e2e`. Skips cleanly without Playwright.
/// <reference path="../src/renderer/types.d.ts" />
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ElectronApplication } from 'playwright-core';
import type { ErrorReply } from '../src/main/cliProto.ts';
import type { ListedField, OpName, OpReplies, PageField } from '../src/main/cliServer.ts';
import type { RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';
const require = createRequire(import.meta.url);

// What the page functions reach in Radial's window: the preload's API, the chat
// panel, and renderer.ts's tabs, typed with the window's own shapes
// (src/renderer/types.d.ts RadialNativeChatApi, HomeTab, AnyTab, Tab).
declare const window: Window & typeof globalThis & { radial: RadialApi; RadialNativeChat: RadialNativeChatApi };
declare const homeTab: HomeTab;
declare let homeActive: boolean;
declare function agentTab(): AnyTab | null;
declare function activeTab(): Tab | null;
declare function findTermById(id: string): TermSession | null;
declare function agentTabs(): AnyTab[];
declare function quickEditToTerminal(tab: AnyTab, termId: string, payload: AgentPrompt): Promise<boolean | undefined>;

/** A `radial …` run: the exit code (or the spawn error's code) and the output. */
interface CliRun { code: number | string; stdout: string; stderr: string }

function loadElectron() {
  for (const r of [path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '..', 'node_modules')]) {
    try { return (require(path.join(r, 'playwright-core')) as typeof import('playwright-core'))._electron; } catch {}
  }
  return null;
}
const until = async <T,>(label: string, ms: number, fn: () => T | Promise<T>) => { const t0 = Date.now(); let last; while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = (e as Error).message; } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`timeout: ${label} (${JSON.stringify(last)})`); };
async function closeApp(app: ElectronApplication) { try { await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]); } catch {} try { app.process().kill('SIGKILL'); } catch {} }

const FAKE_CLAUDE = `#!/bin/sh
# A stand-in for Claude Code: answers the version probe, prints its task, rings
# the bell, then echoes every submitted line (with a bell) like a new turn.
if [ "$1" = "--version" ]; then echo "99.0.0 (Claude Code)"; exit 0; fi
for last; do :; done
printf 'FAKE CLAUDE ready\\n'
printf 'TASK: %s\\n' "$last"
sleep 0.4
printf 'turn done\\a\\n'
while IFS= read -r line; do printf 'SUBMITTED: %s\\a\\n' "$line"; done
`;
// A stand-in for Claude Code in a folder it doesn't trust yet. Its first screen
// is Claude Code 2.1's own question, in its words and layout: Enter picks the
// focused "No, exit" and quits; arrow down, then Enter, trusts the folder. Then
// its input box, which takes typed or pasted text and submits it on Enter, with
// each prompt submitted kept above it as Claude Code draws an earlier prompt ("❯
// " and the prompt at the line's start, its row filled out to the edge). "Run
// the shell command: X" asks to run X, as Claude Code's permission prompt does,
// in the input box's place: arrows move its focus, Enter answers it, Esc says
// no. A task given as its first prompt runs once the folder is trusted. It logs
// each event, and anything typed into a question, to $RADIAL_FAKE_CLI_LOG.
const FAKE_ASKING_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('99.0.0 (Claude Code)'); process.exit(0); }
const log = (event, text) => fs.appendFileSync(process.env.RADIAL_FAKE_CLI_LOG, JSON.stringify({ pid: process.pid, cwd: process.cwd(), event, text }) + '\\n');
const valued = new Set(['--session-id', '--resume', '--append-system-prompt', '--settings', '--model', '--permission-mode']);
let task = null;
for (let i = 0; i < args.length; i++) { if (valued.has(args[i])) i++; else if (!args[i].startsWith('--')) task = args[i]; }
log('start', task);
// Its rules span the terminal, as Claude Code's do, and it draws again when the terminal is resized.
const RULE = 'RULE';
const width = () => process.stdout.columns || 80;
let trusted = false, focus = 0, draft = '', asking = null;
const transcript = [];
const OPTIONS = ['Yes', "Yes, and don't ask again", 'No']; // short enough for the dock's narrow terminal
const draw = (lines) => process.stdout.write('\\x1b[2J\\x1b[H' + lines.map((l) => (l === RULE ? '\\u2500'.repeat(width()) : l)).join('\\r\\n'));
const head = () => [' Claude Code v99.0.0', ...(task ? ['', 'TASK: ' + task] : []), '', ...transcript];
const question = () => draw([RULE, ' Accessing workspace:', '', ' ' + process.cwd(), '', ' Quick safety check: Is this a project you created or one you trust?', '', " Claude Code'll be able to read, edit, and execute files here.", '', (focus === 0 ? ' \\u276f ' : '   ') + 'No, exit', (focus === 1 ? ' \\u276f ' : '   ') + 'Yes, I trust this folder', '', ' Enter to confirm \\u00b7 Esc to cancel']);
const prompt = () => draw([...head(), RULE, '\\u276f\\u00a0' + draft, RULE, draft ? '  \\u23f8 manual mode on' : '  \\u23f8 manual mode on \\u00b7 ? for shortcuts']);
const permission = () => draw([...head(), '\\u23fa Bash(' + asking + ')', '  \\u23bf \\u00a0Waiting\\u2026', '', RULE, ' Bash command', '', '   ' + asking, '   Run a command', '', ' Do you want to proceed?', ...OPTIONS.map((o, i) => (focus === i ? ' \\u276f ' : '   ') + (i + 1) + '. ' + o), '', ' Esc to cancel \\u00b7 Tab to amend']);
const redraw = () => (!trusted ? question() : asking ? permission() : prompt());
process.stdout.on('resize', redraw);
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  for (const key of data.match(/\\x1b\\[200~[\\s\\S]*?\\x1b\\[201~|\\x1b[[O][A-D]|[\\s\\S]/g) || []) {
    if (!trusted) {
      if (/^\\x1b[[O]A$/.test(key)) { focus = 0; question(); }
      else if (/^\\x1b[[O]B$/.test(key)) { focus = 1; question(); }
      else if (key === '\\r') {
        if (focus === 0) { log('declined'); process.exit(1); }
        trusted = true; log('trusted'); if (task) log('run', task); prompt();
      } else log('typed-into-question', key);
      continue;
    }
    if (asking) {
      if (/^\\x1b[[O]A$/.test(key)) focus = Math.max(0, focus - 1);
      else if (/^\\x1b[[O]B$/.test(key)) focus = Math.min(OPTIONS.length - 1, focus + 1);
      else if (key === '\\r' || key === '\\x1b') {
        const yes = key === '\\r' && focus < 2;
        log(yes ? 'approved' : 'rejected', asking);
        transcript.push('\\u23fa Bash(' + asking + ')', yes ? '  \\u23bf \\u00a0(No content)' : '  \\u23bf \\u00a0Interrupted \\u00b7 What should Claude do instead?', '');
        asking = null;
      } else log('typed-into-question', key);
      redraw();
      continue;
    }
    if (key === '\\r') {
      log('submit', draft);
      transcript.push(('\\u276f ' + draft).padEnd(width()), '');
      const run = /^Run the shell command: (.+)$/.exec(draft);
      draft = '';
      if (run) { asking = run[1]; focus = 0; }
      else transcript.push('\\u23fa Done.', '');
    } else if (key.startsWith('\\x1b[200~')) draft += key.slice(6, -6);
    else if (!key.startsWith('\\x1b')) draft += key;
    log('draft', draft); redraw();
  }
});
question();
`;
const FAKE_CODEX = `#!/bin/sh
# A stand-in for Codex in a plain terminal: prints its task, then echoes every submitted line.
for last; do :; done
printf 'FAKE CODEX ready\\n'
printf 'TASK: %s\\n' "$last"
while IFS= read -r line; do printf 'SUBMITTED: %s\\n' "$line"; done
`;
// A stand-in for Codex 0.163 at its prompt, drawn as Codex draws it: its header, its input ("› " and a draft, or its
// placeholder), the footer under it (its model, then its folder), and "? for shortcuts" only while the input is
// empty. A paste goes into the draft, Enter submits it. It logs each event to $RADIAL_FAKE_CLI_LOG.
const FAKE_CODEX_TUI = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.163.0'); process.exit(0); }
const log = (event, text) => fs.appendFileSync(process.env.RADIAL_FAKE_CLI_LOG, JSON.stringify({ pid: process.pid, cwd: process.cwd(), event, text }) + '\\n');
const task = args.length ? args[args.length - 1] : null;
log('start', task);
let draft = '';
const draw = () => process.stdout.write('\\x1b[2J\\x1b[H' + ['  >_ OpenAI Codex (v0.163.0)', '     ' + process.cwd(), '', draft ? '› ' + draft : '› Ask Codex to do anything', '', '  GPT-6.1-Sol default · ' + process.cwd(), ...(draft ? [] : ['  ? for shortcuts'])].join('\\r\\n'));
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  for (const key of data.match(/\\x1b\\[200~[\\s\\S]*?\\x1b\\[201~|\\x1b[[O][A-D]|[\\s\\S]/g) || []) {
    if (key === '\\r') { log('submit', draft); draft = ''; }
    else if (key.startsWith('\\x1b[200~')) draft += key.slice(6, -6);
    else if (!key.startsWith('\\x1b')) draft += key;
    draw();
  }
});
process.stdout.on('resize', draw);
draw();
`;

test('agent lane end to end: submit → bell, staged → unsent, output/list/kill; write lane: text, meta, comments, moments', async (t) => {
  const _electron = loadElectron();
  if (!_electron) { t.skip('Playwright not available'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-agent-e2e-'));
  const bin = path.join(scratch, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const fixture = path.join(scratch, 'site'); fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><title>Fixture site</title><meta name="description" content="Old description"></head><body><h1>Welcome home</h1><p>Some body copy.</p></body></html>');
  fs.writeFileSync(path.join(fixture, 'about.html'), '<!doctype html><html><head><title>About</title></head><body><h1>Welcome home</h1></body></html>');
  execFileSync('git', ['init', '-q'], { cwd: fixture }); execFileSync('git', ['add', '-A'], { cwd: fixture });
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'init'], { cwd: fixture });
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ recents: [], session: { open: [], active: null } }));

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RADIAL_USERDATA: scratch, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' };
  const app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules', '.bin', 'electron'), args: ['.'], cwd: process.cwd(), env, timeout: 30000 });
  const win = await app.firstWindow({ timeout: 20000 });
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  const cli = path.join(process.cwd(), 'bin', 'radial');
  const radial = (args: string[]) => new Promise<CliRun>((resolve) => execFile('/bin/sh', [cli, ...args], { env, encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
  // K is the caller's claim about which socket op (cliServer OpReplies) the args
  // run, and R the reply it reads; nothing checks either against args. stdout is
  // an ErrorReply when the exit code isn't 0 (cli.ts prints the failure under
  // --json), so a call that expects a failure names ErrorReply as R; and json is
  // null when stdout isn't JSON. The success reads trust the shape the same way
  // the JS did.
  const json = async <K extends OpName, R extends OpReplies[K] | ErrorReply = OpReplies[K]>(args: string[]) => { const r = await radial([...args, '--json']); let j: R | null = null; try { j = JSON.parse(r.stdout); } catch {} return { ...r, json: j! }; };
  try {
    await until('renderer', 20000, () => win.evaluate(() => typeof homeTab === 'object' && typeof agentTab === 'function'));
    await until('socket', 15000, () => fs.existsSync(path.join(scratch, 'cli.sock')));

    // 1. agent start --submit on a project that isn't open yet: opened first, then a visible
    //    session boots with the task as its argument; wait resolves on the bell.
    const start = await json<'agentStart'>(['agent', 'start', fixture, 'Fix the hero', '--submit', '--label', 'Hero fix']);
    assert.equal(start.code, 0, start.stderr + start.stdout);
    assert.equal(start.json.submitted, true); assert.equal(start.json.engine, 'claude'); assert.equal(start.json.label, 'Hero fix');
    assert.equal(start.json.reused, true, 'the task went to the default session the open booted, not a second one');
    const id = start.json.id; assert.match(id, /^pty/);
    assert.equal(await win.evaluate(() => document.querySelectorAll('.rail-proj[data-id]').length), 1, 'the project opened');
    assert.equal(await win.evaluate((id) => !!activeTab() && (activeTab()!.terminals || []).some((x) => x.id === id && x.engine === 'claude'), id), true, 'the session is a terminal of the project tab');
    const wait = await json<'agentWait'>(['agent', 'wait', id, '--timeout', '20']);
    assert.equal(wait.code, 0, wait.stderr);
    assert.equal(wait.json.reason, 'bell', JSON.stringify(wait.json));
    assert.match(wait.json.text, /SUBMITTED: Fix the hero/, 'the bell that counted is the one after the task was submitted');
    assert.ok(wait.json.lastBellAt! >= wait.json.lastInputAt!, `answered at or after the input (a stand-in answers within the same ms): ${JSON.stringify({ ...wait.json, text: undefined })}`);
    // A second wait since that bell: the session is idle now (nothing new happened).
    const idle = await json<'agentWait'>(['agent', 'wait', id, '--since', String(wait.json.lastBellAt! + 1), '--timeout', '30']);
    assert.equal(idle.json.reason, 'idle', JSON.stringify(idle.json));
    // Human output renders the screen too.
    const out = await radial(['agent', 'output', id, '--lines', '3']);
    assert.equal(out.code, 0); assert.match(out.stdout, /turn done/);

    // 2. A staged start: a fresh session, the prompt pasted but NOT submitted.
    const staged = await json<'agentStart'>(['agent', 'start', fixture, 'Rewrite the footer']);
    assert.equal(staged.code, 0, staged.stderr); assert.equal(staged.json.submitted, false); assert.notEqual(staged.json.id, id); assert.equal(staged.json.reused, false, 'a used session is never reused');
    await new Promise((r) => setTimeout(r, 1500));
    const so = await json<'agentOutput'>(['agent', 'output', staged.json.id]);
    assert.match(so.json.text, /Rewrite the footer/, 'the prompt is in the terminal'); assert.ok(!/SUBMITTED/.test(so.json.text), 'and was not submitted');
    const list = await json<'agentList'>(['agent', 'list', fixture]);
    assert.equal(list.json.agents.filter((a) => a.alive && a.engine === 'claude').length, 2, JSON.stringify(list.json));
    assert.ok(list.json.agents.some((a) => a.id === id && a.label === 'Hero fix' && a.lastBellAt! > 0));

    // 3. kill needs --yes; then the session is gone from the list and the sidebar.
    assert.equal((await radial(['agent', 'kill', staged.json.id])).code, 6);
    assert.equal((await radial(['agent', 'kill', staged.json.id, '--yes'])).code, 0);
    await until('killed', 10000, async () => { const l = await json<'agentList'>(['agent', 'list', fixture]); return !l.json.agents.some((a) => a.id === staged.json.id && a.alive); });
    assert.equal((await json<'agentOutput', ErrorReply>(['agent', 'output', staged.json.id])).code, 3, 'a dead session is not found');

    // 4. Write lane: text (pinned by route), a head tag, comments, moments.
    const edit = await json<'editText'>(['edit', 'text', fixture, '--find', 'Welcome home', '--to', 'Welcome back', '--route', '/about.html']);
    assert.equal(edit.code, 0, edit.stderr); assert.equal(edit.json.relFile, 'about.html');
    assert.match(fs.readFileSync(path.join(fixture, 'about.html'), 'utf8'), /Welcome back/);
    assert.match(fs.readFileSync(path.join(fixture, 'index.html'), 'utf8'), /Welcome home/, 'the twin on the other page is untouched');
    const twin = await radial(['edit', 'text', fixture, '--find', 'Some body copy.', '--to', 'Some body copy!']);
    assert.equal(twin.code, 0, twin.stderr);
    const meta = await json<'metaSet'>(['meta', 'set', fixture, 'description', 'New description', '--route', '/']);
    assert.equal(meta.code, 0, meta.stderr); assert.match(fs.readFileSync(path.join(fixture, 'index.html'), 'utf8'), /content="New description"/);
    const title = await json<'metaSet'>(['meta', 'set', fixture, 'title', 'Fixture site, renamed', '--file', 'index.html']);
    assert.equal(title.code, 0, title.stderr); assert.match(fs.readFileSync(path.join(fixture, 'index.html'), 'utf8'), /<title>Fixture site, renamed<\/title>/);
    const bad = await json<'metaSet', ErrorReply>(['meta', 'set', fixture, 'og:nope', 'x']); assert.equal(bad.code, 2);
    const add = await json<'commentAdd'>(['comments', 'add', fixture, '--text', 'Tighten this headline', '--route', '/', '--selector', 'h1']);
    assert.equal(add.code, 0, add.stderr); assert.equal(add.json.comment.selector, 'h1');
    const open = await json<'comments'>(['comments', fixture, '--open']); assert.equal(open.json.comments.length, 1);
    assert.equal((await json<'commentResolve'>(['comments', 'resolve', fixture, add.json.comment.id])).json.comment.resolved, true);
    assert.equal((await json<'comments'>(['comments', fixture, '--open'])).json.comments.length, 0);
    const rec = await json<'momentRecord', Extract<OpReplies['momentRecord'], { moment: unknown }>>(['moments', 'record', fixture, '--label', 'After the CLI edits']);
    assert.equal(rec.code, 0, rec.stderr); assert.ok(rec.json.moment && rec.json.moment.label === 'After the CLI edits', JSON.stringify(rec.json));
    const ms = await json<'moments'>(['moments', fixture]); assert.ok(ms.json.moments.some((m) => m.id === rec.json.moment.id));
    assert.equal((await radial(['moments', 'restore', fixture, rec.json.moment.id])).code, 6, 'restore needs --yes');
    // Production publish refuses without --yes, before touching git.
    assert.equal((await radial(['publish', fixture, '--to', 'production'])).code, 6);

    // 5. fields → a field-pinned edit → undo; the page inventory comes from the live preview.
    const fl = await json<'fields'>(['fields', fixture, '/']);
    assert.equal(fl.code, 0, fl.stderr); assert.equal(fl.json.route, '/');
    const h1 = fl.json.fields.find((f): f is Extract<ListedField, { kind: 'text' }> => f.kind === 'text' && f.tag === 'h1');
    assert.ok(h1 && h1.id && h1.text === 'Welcome home' && Array.isArray(h1.path), JSON.stringify(fl.json.fields.slice(0, 4)));
    assert.ok(fl.json.fields.every((f: PageField) => f.thumb === undefined), 'thumbnails stay in the app');
    const fe = await json<'editText'>(['edit', 'text', fixture, '--field', h1.id, '--to', 'Welcome, friend']);
    assert.equal(fe.code, 0, fe.stderr); assert.equal(fe.json.relFile, 'index.html');
    assert.match(fs.readFileSync(path.join(fixture, 'index.html'), 'utf8'), /Welcome, friend/);
    assert.match(fs.readFileSync(path.join(fixture, 'about.html'), 'utf8'), /Welcome back/, 'the field pinned the home page, not the twin');
    const un = await json<'undo'>(['undo', fixture]); assert.equal(un.code, 0, un.stderr); assert.equal(un.json.relFile, 'index.html');
    assert.match(fs.readFileSync(path.join(fixture, 'index.html'), 'utf8'), /Welcome home/, 'undo put the text back');
    assert.equal((await json<'redo'>(['redo', fixture])).json.relFile, 'index.html');
    assert.match(fs.readFileSync(path.join(fixture, 'index.html'), 'utf8'), /Welcome, friend/);

    // 6. Context contributions land in the repo and are read back by `context`.
    const ca = await json<'contextAdd'>(['context', 'add', fixture, 'positioning', '--text', '# Positioning\n\nBold and warm.']);
    assert.equal(ca.code, 0, ca.stderr); assert.equal(ca.json.rel, 'positioning.md');
    assert.equal(fs.readFileSync(path.join(fixture, '.context', 'positioning.md'), 'utf8'), '# Positioning\n\nBold and warm.');
    assert.equal((await radial(['context', 'add', fixture, 'positioning', '--text', 'again'])).code, 2, 'no silent overwrite');
    assert.equal((await json<'contextAdd', Extract<OpReplies['contextAdd'], { replaced: boolean }>>(['context', 'add', fixture, 'positioning', '--text', 'again', '--replace'])).json.replaced, true);
    const ra = await json<'refAdd'>(['refs', 'add', fixture, 'https://github.com/acme/brand']); assert.equal(ra.code, 0, ra.stderr);
    const ru = await json<'ruleAdd'>(['rules', 'add', fixture, 'Never use em dashes in copy']); assert.equal(ru.code, 0, ru.stderr);
    assert.match(fs.readFileSync(path.join(fixture, 'AGENTS.md'), 'utf8'), /- Never use em dashes in copy/);
    const ctx = await json<'context'>(['context', fixture]);
    assert.ok(ctx.json.docs.some((d) => d.file === 'positioning.md' && d.content === 'again'), JSON.stringify(ctx.json.docs));
    assert.ok(ctx.json.references.some((r) => /acme\/brand/.test(r.url)));
    assert.equal((await json<'refRemove'>(['refs', 'remove', fixture, 'https://github.com/acme/brand'])).code, 0);

    // 7. agent send: a follow-up into the running (submitted) session, answered with a bell.
    const sent = await json<'agentSend'>(['agent', 'send', id, 'Also fix the footer']);
    assert.equal(sent.code, 0, sent.stderr); assert.equal(sent.json.submitted, true);
    const w2 = await json<'agentWait'>(['agent', 'wait', id, '--timeout', '20']);
    assert.equal(w2.json.reason, 'bell', JSON.stringify({ ...w2.json, text: undefined })); assert.match(w2.json.text, /SUBMITTED: .*Also fix the footer/);
    const lst = await json<'agentList'>(['agent', 'list', fixture]);
    assert.equal(lst.json.agents.find((a) => a.id === id)!.state, 'waiting', JSON.stringify(lst.json.agents));
    const lsj = await json<'ls'>(['ls']);
    const row = lsj.json.projects.find((p) => p.repoDir === fixture || p.repoDir === fs.realpathSync(fixture));
    assert.ok(row && row.waiting >= 1 && row.openComments === 0 && row.changes! >= 1, JSON.stringify(lsj.json.projects));

    // 8. home: Home comes up with a shell as its agent; asking again reuses it.
    const hm = await json<'home'>(['home', '--engine', 'shell']);
    assert.equal(hm.code, 0, hm.stderr); assert.equal(hm.json.started, true); assert.equal(hm.json.engine, 'shell');
    assert.equal(await win.evaluate(() => homeActive && homeTab.terminals.length === 1), true);
    assert.equal((await json<'home'>(['home', '--engine', 'shell'])).json.started, false);

    assert.deepEqual(errors, []);
  } finally {
    // json is null when stdout wasn't JSON; a failure's ErrorReply has no agents, and the for-of throws into the catch.
    try { for (const a of (((await json<'agentList'>(['agent', 'list'])).json as OpReplies['agentList'] | null) || { agents: [] }).agents) await radial(['agent', 'kill', a.id, '--yes']); } catch {}
    await closeApp(app);
    try { execFileSync('pkill', ['-f', path.join(scratch, 'term-daemon')]); } catch {}
  }
});

// With chats on (the packaged default) a project's default agent is its first
// chat, which the chat panel starts when the open shows the project. The agent
// lane hands the task to that chat when the engine matches and nobody has used
// it. Otherwise the task gets a chat of its own, made as New chat makes one,
// titled from the task, with the task as its first message (submitted, or
// staged in its CLI's input), and the open's first chat goes if unused.
test('agent start with chats on: the task goes into the first chat the open starts; another engine, or a used first chat, gets a chat of its own', async (t) => {
  const _electron = loadElectron();
  if (!_electron) { t.skip('Playwright not available'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-agent-chats-'));
  const bin = path.join(scratch, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 }); // installed, so Claude Code is the default engine
  fs.writeFileSync(path.join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
  const sites = ['Hero site', 'Footer site', 'Draft site'].map((name) => {
    const dir = path.join(scratch, name); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><head><title>${name}</title></head><body><h1>${name}</h1></body></html>`);
    return dir;
  });
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ recents: [], session: { open: [], active: null } }));
  // Chats run the native stand-ins (test/fixtures); a plain terminal runs the stand-ins on PATH.
  const interactive = path.resolve('test/fixtures/native-interactive.cjs');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RADIAL_USERDATA: scratch, CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'), CURSOR_CONFIG_DIR: path.join(scratch, 'cursor'), RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_CHAT_TEST_CLAUDE: interactive, RADIAL_CHAT_TEST_CURSOR: interactive, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' };
  const app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules', '.bin', 'electron'), args: ['.'], cwd: process.cwd(), env, timeout: 30000 });
  const win = await app.firstWindow({ timeout: 20000 });
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  const cli = path.join(process.cwd(), 'bin', 'radial');
  const radial = (args: string[]) => new Promise<CliRun>((resolve) => execFile('/bin/sh', [cli, ...args], { env, encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
  const json = async <K extends OpName>(args: string[]) => { const r = await radial([...args, '--json']); let j: OpReplies[K] | null = null; try { j = JSON.parse(r.stdout); } catch {} return { ...r, json: j! }; };
  // The project as the window has it (its folder resolved), once the chat panel has settled
  // there (its input is disabled while it loads, its toolbar busy while a chat starts):
  // anything the open starts has landed by then.
  const settled = async (name: string) => {
    await win.waitForFunction((name) => { const input = document.querySelector<HTMLTextAreaElement>('#nativeChatInput')!; return input.placeholder === `Ask about ${name}…` && !input.disabled && document.getElementById('nativeChatToolbar')!.getAttribute('aria-busy') === 'false'; }, name, { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 500));
    return win.evaluate(() => activeTab()!.repoDir);
  };
  const chats = (repoDir: string) => win.evaluate((dir) => window.radial.nativeChatList(dir, true), repoDir);
  const alive = async (dir: string) => (await json<'agentList'>(['agent', 'list', dir])).json.agents.filter((a) => a.alive).map((a) => a.id);
  try {
    await until('renderer', 20000, () => win.evaluate(() => typeof homeTab === 'object' && typeof agentTab === 'function' && !!window.RadialNativeChat?.enabled()));
    await until('socket', 15000, () => fs.existsSync(path.join(scratch, 'cli.sock')));

    // 1. The same engine: one session, the open's first chat, with the task as its first message.
    const start = await json<'agentStart'>(['agent', 'start', sites[0], 'Fix the hero', '--submit', '--label', 'Hero fix']);
    assert.equal(start.code, 0, start.stderr + start.stdout);
    assert.equal(start.json.engine, 'claude'); assert.equal(start.json.submitted, true); assert.equal(start.json.label, 'Hero fix');
    assert.equal(start.json.reused, true, 'the task went to the first chat the open started');
    let repoDir = await settled('Hero site');
    const heroChats = await chats(repoDir), [chat] = heroChats;
    assert.equal(heroChats.length, 1, 'no second chat');
    assert.equal(chat.terminalId, start.json.id, 'the session is the chat\'s own CLI'); assert.equal(chat.title, 'Hero fix');
    assert.deepEqual(await alive(sites[0]), [start.json.id], 'one CLI in the project');
    assert.equal(await win.evaluate(() => window.RadialNativeChat.visibleId()), chat.id, 'the chat is on screen');
    await until('the task is the first message', 20000, async () => { const s = await win.evaluate((id) => window.radial.nativeChatGet(id), chat.id); return s.messages[0]?.role === 'user' && s.messages[0].text === 'Fix the hero'; });

    // 2. Another engine: a chat of its own, on screen, with the task as its first message; the open's untouched first chat is gone.
    const other = await json<'agentStart'>(['agent', 'start', sites[1], 'Rewrite the footer', '--submit', '--engine', 'codex']);
    assert.equal(other.code, 0, other.stderr + other.stdout);
    assert.equal(other.json.engine, 'codex'); assert.equal(other.json.reused, false); assert.equal(other.json.submitted, true);
    repoDir = await settled('Footer site');
    const footerChats = await chats(repoDir), [codexChat] = footerChats;
    assert.deepEqual(footerChats.map((s) => s.engine), ['codex'], 'the task\'s chat, and no first chat left beside it');
    assert.equal(codexChat.terminalId, other.json.id, 'the reply names the chat\'s CLI'); assert.equal(codexChat.title, 'Rewrite the footer', 'titled from the task');
    assert.equal(await win.evaluate(() => window.RadialNativeChat.visibleId()), codexChat.id, 'the chat is on screen');
    assert.equal(await win.evaluate((id) => window.RadialNativeChat.history().some(({ session }) => session.id === id), codexChat.id), true, 'it shows in Recents');
    await until('the task is its first message', 20000, async () => { const s = await win.evaluate((id) => window.radial.nativeChatGet(id), codexChat.id); return s.messages[0]?.role === 'user' && s.messages[0].text === 'Rewrite the footer'; });
    assert.deepEqual(await alive(sites[1]), [other.json.id], 'one CLI in the project');

    // 3. A used first chat (it took the first task): the next task gets a chat of its own beside it, submitted to its CLI.
    const next = await json<'agentStart'>(['agent', 'start', sites[0], 'Tighten the hero copy', '--submit']);
    assert.equal(next.code, 0, next.stderr + next.stdout);
    assert.equal(next.json.engine, 'claude'); assert.equal(next.json.reused, false); assert.equal(next.json.submitted, true);
    repoDir = await settled('Hero site');
    const own = (await chats(repoDir)).find((s) => s.id !== chat.id)!;
    assert.equal((await chats(repoDir)).length, 2, 'the used first chat stays');
    assert.equal(own.terminalId, next.json.id); assert.equal(own.title, 'Tighten the hero copy');
    assert.equal(await win.evaluate(() => window.RadialNativeChat.visibleId()), own.id, 'the new chat is on screen');
    await until('the task is its first message', 20000, async () => { const s = await win.evaluate((id) => window.radial.nativeChatGet(id), own.id); return s.messages[0]?.role === 'user' && s.messages[0].text === 'Tighten the hero copy'; });
    const fixtureState = (threadId: string | null | undefined) => { try { return JSON.parse(fs.readFileSync(path.join(scratch, 'native-fixture', threadId + '.state.json'), 'utf8')) as { draft: string; prompts: string[] }; } catch { return null; } };
    await until('the task submitted in its CLI', 20000, async () => fixtureState((await win.evaluate((id) => window.radial.nativeChatGet(id), own.id)).threadId)?.prompts.includes('Tighten the hero copy'));
    assert.deepEqual((await alive(sites[0])).sort(), [start.json.id, next.json.id].sort(), 'its CLI beside the first chat\'s');

    // 4. Staged, into a chat of its own: the task waits in its CLI's input, unsent.
    const later = await json<'agentStart'>(['agent', 'start', sites[0], 'Draft the hero alt text']);
    assert.equal(later.code, 0, later.stderr + later.stdout);
    assert.equal(later.json.reused, false); assert.equal(later.json.submitted, false); assert.equal(later.json.landed, true);
    repoDir = await settled('Hero site');
    const drafted = (await chats(repoDir)).find((s) => s.terminalId === later.json.id)!;
    assert.equal(drafted.title, 'Draft the hero alt text');
    const draftedState = await until('the draft in its CLI', 10000, async () => { const s = fixtureState(drafted.threadId); return s?.draft === 'Draft the hero alt text' ? s : null; });
    assert.deepEqual(draftedState.prompts, [], 'and was not submitted');

    // 5. A staged start into the first chat: the task waits in its CLI's input, unsent.
    const staged = await json<'agentStart'>(['agent', 'start', sites[2], 'Rewrite the footer']);
    assert.equal(staged.code, 0, staged.stderr + staged.stdout);
    assert.equal(staged.json.reused, true); assert.equal(staged.json.submitted, false); assert.equal(staged.json.landed, true);
    repoDir = await settled('Draft site');
    const [draft] = await chats(repoDir);
    assert.equal(draft.terminalId, staged.json.id);
    const state = path.join(scratch, 'native-fixture', draft.threadId + '.state.json');
    const cliState = await until('the draft in the CLI', 10000, async () => { try { const s = JSON.parse(fs.readFileSync(state, 'utf8')) as { draft: string; prompts: string[] }; return s.draft === 'Rewrite the footer' ? s : null; } catch { return null; } }) as { draft: string; prompts: string[] };
    assert.deepEqual(cliState.prompts, [], 'and was not submitted');
    assert.deepEqual(errors, []);
  } finally {
    await closeApp(app);
    try { execFileSync('pkill', ['-f', path.join(scratch, 'term-daemon')]); } catch {}
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// With chats off, a project's default agent is a plain terminal the open boots.
// In a folder its CLI hasn't seen, that CLI first asks a question of its own (here
// trusting the folder, as Claude Code does; or signing in). The agent lane never
// types into that question: the typing would be lost, and its Enter would answer
// it (here "No, exit", which quits the CLI). A submitted task becomes a new CLI's
// first prompt instead, and the CLI runs it once the person answers; a staged task
// goes into the CLI's input once the question is answered, unsent. `radial agent
// question` reads the question and its id, and `agent answer` with the yes and
// that id answers it: the keys go to the session through the app, as the
// person's typing does, and the window stays as it is. `agent send` to a session
// whose CLI asks waits for it too, and so does the canvas's quick edit; so does a
// send while it asks to run a command, under the prompt that led to it.
test('agent start and send, and the quick edit, with chats off never type into a CLI asking its own question; the text runs or waits in its input once answered, by the person or by agent answer', async (t) => {
  const _electron = loadElectron();
  if (!_electron) { t.skip('Playwright not available'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-agent-asks-'));
  const bin = path.join(scratch, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_ASKING_CLAUDE, { mode: 0o755 });
  const sites = ['Hero site', 'Footer site', 'Pricing site', 'Headline site'].map((name) => {
    const dir = path.join(scratch, name); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><head><title>${name}</title></head><body><h1>${name}</h1></body></html>`);
    return dir;
  });
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ recents: [], session: { open: [], active: null } }));
  const cliLog = path.join(scratch, 'fake-cli.jsonl');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RADIAL_USERDATA: scratch, RADIAL_FAKE_CLI_LOG: cliLog, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' };
  const app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules', '.bin', 'electron'), args: ['.'], cwd: process.cwd(), env, timeout: 30000 });
  const win = await app.firstWindow({ timeout: 20000 });
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  const cli = path.join(process.cwd(), 'bin', 'radial');
  const radial = (args: string[]) => new Promise<CliRun>((resolve) => execFile('/bin/sh', [cli, ...args], { env, encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
  const json = async <K extends OpName>(args: string[]) => { const r = await radial([...args, '--json']); let j: OpReplies[K] | null = null; try { j = JSON.parse(r.stdout); } catch {} return { ...r, json: j! }; };
  /** What the stand-in CLIs logged: each one that started, in its folder, and what reached it. */
  interface CliEvent { pid: number; cwd: string; event: 'start' | 'typed-into-question' | 'declined' | 'trusted' | 'run' | 'draft' | 'submit' | 'approved' | 'rejected'; text?: string | null }
  const events = (): CliEvent[] => { try { return fs.readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as CliEvent); } catch { return []; } };
  const inSite = (site: string) => events().filter((e) => fs.realpathSync(e.cwd) === fs.realpathSync(site));
  const alive = async (dir: string) => (await json<'agentList'>(['agent', 'list', dir])).json.agents.filter((a) => a.alive).map((a) => a.id);
  // The person answers in the app: arrow down to "Yes, I trust this folder", then Enter, typed into the session's terminal.
  const trustFolder = async (id: string) => {
    await win.evaluate((id) => findTermById(id)!.xterm!.focus(), id);
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('Enter');
  };
  try {
    await until('renderer', 20000, () => win.evaluate(() => typeof homeTab === 'object' && typeof agentTab === 'function'));
    await until('socket', 15000, () => fs.existsSync(path.join(scratch, 'cli.sock')));

    // 1. Submitted: the open's CLI is asking, so the task is a new CLI's first prompt, and the asking one goes.
    const start = await json<'agentStart'>(['agent', 'start', sites[0], 'Fix the hero', '--submit']);
    assert.equal(start.code, 0, start.stderr + start.stdout);
    assert.equal(start.json.submitted, true); assert.equal(start.json.waiting, true, 'the reply says the CLI is asking a question of its own');
    assert.equal(start.json.reused, false, 'the open\'s CLI, asking, was not typed into');
    // The reply comes as the task's CLI is spawned, a moment before it logs its start.
    const started = await until('the task\'s CLI to start', 10000, async () => { const s = inSite(sites[0]).filter((e) => e.event === 'start'); return s.length >= 2 ? s : null; });
    assert.deepEqual(started.map((e) => e.text), [null, 'Fix the hero'], 'the open\'s CLI, then one with the task as its first prompt');
    assert.deepEqual(inSite(sites[0]).filter((e) => e.event !== 'start'), [], 'nothing typed into either question, nothing answered');
    await until('one CLI in the project', 10000, async () => (await alive(sites[0])).join() === start.json.id);
    await trustFolder(start.json.id);
    const ran = await until('the task to run once the folder is trusted', 10000, async () => { const r = inSite(sites[0]).filter((e) => e.event === 'run'); return r.length ? r : null; });
    assert.deepEqual(ran.map((e) => [e.pid, e.text]), [[started[1].pid, 'Fix the hero']]);

    // 2. Staged: nothing typed while the CLI asks. agent question reads the question; agent answer, refused without
    //    the question's id or the yes, answers it with both. Then the task waits in its input, unsent.
    const staged = await json<'agentStart'>(['agent', 'start', sites[1], 'Rewrite the footer']);
    assert.equal(staged.code, 0, staged.stderr + staged.stdout);
    assert.equal(staged.json.submitted, false); assert.equal(staged.json.landed, false); assert.equal(staged.json.waiting, true);
    assert.equal(staged.json.reused, true, 'the open\'s CLI keeps the task for after its question');
    await new Promise((r) => setTimeout(r, 1500)); // anything typed now would reach the question
    assert.deepEqual(inSite(sites[1]).map((e) => e.event), ['start'], 'nothing typed into the question');
    const question = await json<'agentQuestion'>(['agent', 'question', staged.json.id]);
    assert.equal(question.code, 0, question.stderr + question.stdout);
    assert.deepEqual([question.json.asking, question.json.question!.options.map((o) => o.label), question.json.question!.focused], [true, ['No, exit', 'Yes, I trust this folder'], 1]);
    const unnamed = await radial(['agent', 'answer', staged.json.id, 'Yes, I trust this folder', '--yes']);
    assert.equal(unnamed.code, 6, unnamed.stderr + unnamed.stdout);
    assert.ok(unnamed.stderr.endsWith(`An answer names the question it is for: pass --expect ${question.json.question!.id}, with --yes once the person agrees to answer it with "Yes, I trust this folder".\n`), unnamed.stderr);
    const unconfirmed = await radial(['agent', 'answer', staged.json.id, 'Yes, I trust this folder', '--expect', question.json.question!.id]);
    assert.equal(unconfirmed.code, 6, unconfirmed.stderr + unconfirmed.stdout);
    assert.ok(unconfirmed.stderr.endsWith(`Pass --yes to confirm, with --expect ${question.json.question!.id} so the answer goes only to this question.\n`), unconfirmed.stderr);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(inSite(sites[1]).map((e) => e.event), ['start'], 'nothing typed without --yes');
    const answered = await json<'agentAnswer'>(['agent', 'answer', staged.json.id, 'Yes, I trust this folder', '--expect', question.json.question!.id, '--yes']);
    assert.equal(answered.code, 0, answered.stderr + answered.stdout);
    assert.deepEqual([answered.json.id, answered.json.chose, answered.json.after], [staged.json.id, { number: 2, label: 'Yes, I trust this folder' }, 'gone']);
    await until('the task in the CLI\'s input', 15000, async () => inSite(sites[1]).some((e) => e.event === 'draft' && e.text === 'Rewrite the footer'));
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(inSite(sites[1]).filter((e) => e.event !== 'draft').map((e) => e.event), ['start', 'trusted'], 'not submitted, nothing typed into the question');
    //    Its CLI at its prompt now: an answer is refused, and nothing goes into the draft.
    const notAsking = await radial(['agent', 'answer', staged.json.id, '1', '--yes']);
    assert.equal(notAsking.code, 6, notAsking.stderr + notAsking.stdout); assert.match(notAsking.stderr, /isn't asking a question of its own\. Its screen shows:/);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(inSite(sites[1]).filter((e) => e.event === 'draft').at(-1)!.text, 'Rewrite the footer', 'the draft as the task left it');
    assert.deepEqual(await alive(sites[1]), [staged.json.id]);

    // 3. agent send into a session whose CLI asks: nothing typed now, and the reply says the text waits. It goes in,
    //    and runs, once the question is answered (here by the person).
    const opened = await radial(['open', sites[2]]);
    assert.equal(opened.code, 0, opened.stderr + opened.stdout);
    const [asking] = await until('the open\'s CLI', 15000, async () => { const ids = await alive(sites[2]); return ids.length === 1 && inSite(sites[2]).some((e) => e.event === 'start') ? ids : null; });
    await until('its question', 10000, async () => (await json<'agentQuestion'>(['agent', 'question', asking])).json.asking);
    const sent = await json<'agentSend'>(['agent', 'send', asking, 'Make the pricing two columns']);
    assert.equal(sent.code, 0, sent.stderr + sent.stdout);
    assert.deepEqual([sent.json.submitted, sent.json.landed, sent.json.waiting], [true, false, true], 'the reply says the text waits for the question');
    await new Promise((r) => setTimeout(r, 1500)); // anything typed now would reach the question
    assert.deepEqual(inSite(sites[2]).map((e) => e.event), ['start'], 'nothing typed into the question');
    await trustFolder(asking);
    await until('the text, run once the folder is trusted', 15000, async () => inSite(sites[2]).some((e) => e.event === 'submit' && e.text === 'Make the pricing two columns'));
    assert.deepEqual(inSite(sites[2]).filter((e) => e.event !== 'draft').map((e) => e.event), ['start', 'trusted', 'submit']);

    // 4. The canvas's quick edit into a session whose CLI asks: nothing typed now, and the change goes in, and runs,
    //    once the question is answered.
    const opening = await radial(['open', sites[3]]);
    assert.equal(opening.code, 0, opening.stderr + opening.stdout);
    const [editing] = await until('the open\'s CLI', 15000, async () => { const ids = await alive(sites[3]); return ids.length === 1 && inSite(sites[3]).some((e) => e.event === 'start') ? ids : null; });
    await until('its question', 10000, async () => (await json<'agentQuestion'>(['agent', 'question', editing])).json.asking);
    const quick = await win.evaluate((id) => {
      const tab = agentTabs().find((t) => (t.terminals || []).some((s) => s.id === id))!;
      return quickEditToTerminal(tab, id, { text: 'Make the headline bigger', selections: [], submit: true, label: 'Bigger headline' });
    }, editing);
    assert.equal(quick, true);
    await new Promise((r) => setTimeout(r, 1500)); // anything typed now would reach the question
    assert.deepEqual(inSite(sites[3]).map((e) => e.event), ['start'], 'nothing typed into the question');
    await trustFolder(editing);
    await until('the change, run once the folder is trusted', 15000, async () => inSite(sites[3]).some((e) => e.event === 'submit' && e.text === 'Make the headline bigger'));
    assert.deepEqual(inSite(sites[3]).filter((e) => e.event !== 'draft').map((e) => e.event), ['start', 'trusted', 'submit']);

    // 5. A permission prompt under the prompt that led to it, as Claude Code draws one: an earlier prompt keeps its ❯
    //    at the line's start, where it once read as the CLI's input. agent question reads the prompt; a send waits,
    //    typing nothing into it and never pressing Enter there (a "1. Yes" in its words included), and goes in once
    //    the person answers it.
    const run = await json<'agentSend'>(['agent', 'send', asking, 'Run the shell command: touch notes.txt']);
    assert.equal(run.code, 0, run.stderr + run.stdout);
    assert.deepEqual([run.json.submitted, run.json.landed, run.json.waiting], [true, true, undefined], 'typed, seen, and sent');
    const permission = await until('its permission prompt, drawn whole', 10000, async () => { const q = await json<'agentQuestion'>(['agent', 'question', asking]); return q.json.asking && q.json.question!.options.length === 3 ? q.json.question! : null; });
    assert.deepEqual([permission.options.map((o) => o.label), permission.focused], [['Yes', 'Yes, and don\'t ask again', 'No'], 1]);
    assert.match(permission.text, /^Bash command\n\s+touch notes\.txt\n\s+Run a command\nDo you want to proceed\?$/, 'its words, not the earlier prompt above it');
    const held = await json<'agentSend'>(['agent', 'send', asking, '1. Yes, use the blue one 2. Keep the footer']);
    assert.equal(held.code, 0, held.stderr + held.stdout);
    assert.deepEqual([held.json.submitted, held.json.landed, held.json.waiting], [true, false, true], 'the reply says the text waits for the question');
    await new Promise((r) => setTimeout(r, 1500)); // anything typed now would reach the question
    assert.deepEqual(inSite(sites[2]).filter((e) => ['typed-into-question', 'approved', 'rejected'].includes(e.event)), [], 'nothing typed into it, nothing answered');
    await win.evaluate((id) => findTermById(id)!.xterm!.focus(), asking);
    await win.keyboard.press('Escape'); // the person says no
    await until('the text, sent once the question is answered', 15000, async () => inSite(sites[2]).some((e) => e.event === 'submit' && e.text === '1. Yes, use the blue one 2. Keep the footer'));
    assert.deepEqual(inSite(sites[2]).filter((e) => e.event !== 'draft').map((e) => [e.event, e.text]), [['start', null], ['trusted', undefined], ['submit', 'Make the pricing two columns'], ['submit', 'Run the shell command: touch notes.txt'], ['rejected', 'touch notes.txt'], ['submit', '1. Yes, use the blue one 2. Keep the footer']]);
    assert.deepEqual(errors, []);
  } finally {
    await closeApp(app);
    try { execFileSync('pkill', ['-f', path.join(scratch, 'term-daemon')]); } catch {}
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// Codex drops "? for shortcuts" once its input has text, so a message whose words a question has ("Sign in", "Log
// in") once read as Codex asking a question of its own: it sat unsent in the input. Its footer marks its input, and
// what Radial typed is left out of the look.
test('a send or a quick edit with a question\'s words goes into Codex and is submitted', async (t) => {
  const _electron = loadElectron();
  if (!_electron) { t.skip('Playwright not available'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-agent-codex-'));
  const bin = path.join(scratch, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 }); // the open's default agent: never the real one
  fs.writeFileSync(path.join(bin, 'codex'), FAKE_CODEX_TUI, { mode: 0o755 });
  const site = path.join(scratch, 'Login site'); fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><html><head><title>Login site</title></head><body><nav><a href="/login">Log in</a></nav><h1>Sign in</h1></body></html>');
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ recents: [], session: { open: [], active: null } }));
  const cliLog = path.join(scratch, 'fake-cli.jsonl');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RADIAL_USERDATA: scratch, RADIAL_FAKE_CLI_LOG: cliLog, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' };
  const app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules', '.bin', 'electron'), args: ['.'], cwd: process.cwd(), env, timeout: 30000 });
  const win = await app.firstWindow({ timeout: 20000 });
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  const cli = path.join(process.cwd(), 'bin', 'radial');
  const radial = (args: string[]) => new Promise<CliRun>((resolve) => execFile('/bin/sh', [cli, ...args], { env, encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
  const json = async <K extends OpName>(args: string[]) => { const r = await radial([...args, '--json']); let j: OpReplies[K] | null = null; try { j = JSON.parse(r.stdout); } catch {} return { ...r, json: j! }; };
  interface CliEvent { pid: number; cwd: string; event: 'start' | 'submit'; text?: string | null }
  const events = (): CliEvent[] => { try { return fs.readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as CliEvent); } catch { return []; } };
  const submitted = () => events().filter((e) => e.event === 'submit').map((e) => e.text);
  try {
    await until('renderer', 20000, () => win.evaluate(() => typeof homeTab === 'object' && typeof agentTab === 'function'));
    await until('socket', 15000, () => fs.existsSync(path.join(scratch, 'cli.sock')));
    const start = await json<'agentStart'>(['agent', 'start', site, 'Look at the site', '--engine', 'codex', '--submit']);
    assert.equal(start.code, 0, start.stderr + start.stdout);
    assert.equal(start.json.engine, 'codex');
    await until('Codex at its prompt', 15000, () => events().some((e) => e.event === 'start' && e.text && /Look at the site/.test(e.text)));
    // agent send: typed, seen landing, and submitted; never held as a question of Codex's own.
    const sent = await json<'agentSend'>(['agent', 'send', start.json.id, 'Make the Sign in button blue']);
    assert.equal(sent.code, 0, sent.stderr + sent.stdout);
    assert.deepEqual([sent.json.submitted, sent.json.landed, sent.json.waiting], [true, true, undefined], JSON.stringify(sent.json));
    await until('the send, submitted', 15000, () => submitted().includes('Make the Sign in button blue'));
    assert.equal((await json<'agentQuestion'>(['agent', 'question', start.json.id])).json.asking, false, 'and Codex isn\'t asking anything');
    // The canvas's quick edit, on a nav link that says "Log in".
    const quick = await win.evaluate((id) => {
      const tab = agentTabs().find((t) => (t.terminals || []).some((s) => s.id === id))!;
      return quickEditToTerminal(tab, id, { text: 'Make the Log in link bold', selections: [], submit: true, label: 'Bold Log in' });
    }, start.json.id);
    assert.equal(quick, true);
    await until('the quick edit, submitted', 15000, () => submitted().includes('Make the Log in link bold'));
    assert.deepEqual(submitted(), ['Make the Sign in button blue', 'Make the Log in link bold'], 'each once');
    assert.deepEqual(errors, []);
  } finally {
    await closeApp(app);
    try { execFileSync('pkill', ['-f', path.join(scratch, 'term-daemon')]); } catch {}
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
