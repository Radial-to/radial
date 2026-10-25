// Radial's Claude Code hook (src/main/chat/observe.cjs) refuses the Bash
// commands devGuard forbids. The hook runs as a process of its own, from the
// files a chat copies out of the compiled app, so these tests start a chat's
// transport from out/ (npm test builds it first) and run the PreToolUse
// command it registers the way Claude Code runs one: through the shell, with
// the hook's JSON input on stdin and its answer read from stdout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { TestContext } from 'node:test';
import type { InteractiveOptions } from '../src/main/chat/interactive';
import type { FakeList, FakeTerminal, NativeStart } from './support/nativeChat';
import { tmpDir } from './support/tmp';
import { forbiddenBashReason } from '../src/main/devGuard';
const { InteractiveTransport } = require('../out/main/chat/interactive') as typeof import('../src/main/chat/interactive');

const threadId = '12345678-1234-1234-1234-123456789abc';

/** A hook's input as Claude Code sends it (its hooks reference): the session, the event, and for a tool event the tool and its input. */
interface HookInput { session_id: string; transcript_path: string; cwd: string; permission_mode: string; hook_event_name: string; tool_name?: string; tool_input?: unknown; tool_use_id?: string; tool_response?: unknown; user_email?: string }

/** A Claude chat's transport started from the compiled app, its PreToolUse command, and how to run it. */
async function claudeChat(t: TestContext, { home = false } = {}) {
  const dir = tmpDir('radial-hook-');
  const project = path.join(dir, 'site'); fs.mkdirSync(project);
  const bin = path.join(dir, 'claude'); fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o700 });
  const starts: NativeStart[] = [];
  const terminal: FakeTerminal<'write' | 'kill' | 'attach'> & FakeList<'id'> = { list: async () => [], start: async (_dir, options) => { starts.push(options); return 'pty'; }, write() {}, kill() {}, attach() {} };
  const env = { RADIAL_USERDATA: dir, RADIAL_CHAT_TEST_CLAUDE: bin, CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config') };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const transport = new InteractiveTransport({ engine: 'claude', cwd: project, runtimeRoot: dir, session: { id: 'chat', threadId, title: 'Guard', home }, terminal, onEvent() {} } as unknown as InteractiveOptions); // the stand-ins for the session and the terminal
  await transport.initialize(); transport.close();
  const args = starts[0].command.args;
  const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  const command = settings.hooks.PreToolUse[0].hooks[0].command;
  const input = (event: Partial<HookInput>): HookInput => ({ session_id: threadId, transcript_path: path.join(dir, threadId + '.jsonl'), cwd: project, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_use_id: 'toolu_01', ...event });
  /** Runs the hook on one event: its answer on stdout, parsed. */
  const run = (event: Partial<HookInput>): unknown => JSON.parse(execFileSync('/bin/sh', ['-c', command], { cwd: project, input: JSON.stringify(input(event)), encoding: 'utf8' }));
  const bash = (command: string) => run({ tool_name: 'Bash', tool_input: { command, description: 'Run it' } });
  return { dir, project, command, journal: transport.journal, input, run, bash };
}
const denied = (command: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: forbiddenBashReason(command, { devServerPids: new Set() }) } });

test('the hook refuses a Bash call devGuard forbids, with devGuard’s reason, which points the agent at radial restart', async t => {
  const chat = await claudeChat(t);
  for (const command of ['npm run dev', 'pnpm dev -- --port 3005', 'rm -rf .next', 'pkill -f next-server', 'lsof -ti:3000 | xargs kill']) {
    assert.deepEqual(chat.bash(command), denied(command), command);
    assert.match(forbiddenBashReason(command)!, /`radial restart --yes`/);
  }
});

test('the hook lets an allowed Bash call, a tool other than Bash, and events after the call through', async t => {
  const chat = await claudeChat(t);
  for (const command of ['git status', 'npm run build', 'tsc --noEmit', 'kill 99999', 'npm install -D vite', 'cat vite.config.ts', 'npx vite build']) assert.deepEqual(chat.bash(command), {}, command);
  assert.deepEqual(chat.run({ tool_name: 'Write', tool_input: { file_path: path.join(chat.project, 'notes.md'), content: 'Run npm run dev, then rm -rf .next' } }), {});
  assert.deepEqual(chat.run({ tool_name: 'Read', tool_input: { file_path: path.join(chat.project, 'package.json') } }), {});
  assert.deepEqual(chat.run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm run dev' }, tool_response: { stdout: '', stderr: '' } }), {});
});

test('the hook still journals every event for the chat, refused calls included', async t => {
  const chat = await claudeChat(t);
  chat.bash('git status');
  chat.bash('npm run dev');
  chat.run({ hook_event_name: 'UserPromptSubmit', user_email: 'someone@example.com' });
  const journal = fs.readFileSync(chat.journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as HookInput);
  assert.deepEqual(journal.map(event => [event.hook_event_name, (event.tool_input as { command?: string } | undefined)?.command]), [['PreToolUse', 'git status'], ['PreToolUse', 'npm run dev'], ['UserPromptSubmit', undefined]]);
  assert.equal('user_email' in journal[2], false, 'the email stays out of the journal');
});

test('the hook refuses a kill aimed at the preview’s dev server: the pid in dev.json and the rest of its process group', async t => {
  const chat = await claudeChat(t);
  // A dev server: a process group whose leader started a worker, as next dev does.
  const server = spawn(process.execPath, ['-e', "const w = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write(w.pid + '\\n'); setInterval(() => {}, 1000);"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { process.kill(-server.pid!, 'SIGKILL'); } catch {} });
  const worker = Number(await new Promise<string>(resolve => server.stdout!.once('data', data => resolve(String(data).trim()))));
  assert.ok(worker > 0);
  assert.deepEqual(chat.bash(`kill ${server.pid}`), {}, 'no dev.json yet: Radial runs no server here');
  fs.mkdirSync(path.join(chat.project, '.radial'));
  fs.writeFileSync(path.join(chat.project, '.radial', 'dev.json'), JSON.stringify({ url: 'http://localhost:4321', framework: 'astro', pid: server.pid, cwd: chat.project }));
  const pids = new Set([server.pid!, worker]);
  for (const command of [`kill ${server.pid}`, `kill -9 ${worker}`]) {
    assert.deepEqual(chat.bash(command), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: forbiddenBashReason(command, { devServerPids: pids }) } }, command);
  }
  assert.deepEqual(chat.bash('kill 99999'), {}, 'a pid outside the server stays allowed');
});

test('the hook refuses under Electron’s own Node, as the app runs it', async t => {
  const electron = require('electron') as unknown as string; // the npm package's main, in Node: the path of Electron's binary
  // Electron's binary loads its desktop libraries even to run as Node: a slim Linux image (the CI's) has none, and the app never runs there.
  try { execFileSync(electron, ['-e', '0'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', timeout: 30000 }); }
  catch { t.skip('Electron can’t start on this machine'); return; }
  const chat = await claudeChat(t);
  const command = chat.command.replace("'" + process.execPath + "'", "'" + electron + "'");
  assert.notEqual(command, chat.command);
  const answer = JSON.parse(execFileSync('/bin/sh', ['-c', command], { cwd: chat.project, input: JSON.stringify(chat.input({ tool_name: 'Bash', tool_input: { command: 'next dev' } })), encoding: 'utf8' }));
  assert.deepEqual(answer, denied('next dev'));
});

test('Home’s chat gets the same guard without a dev server to look up', async t => {
  const chat = await claudeChat(t, { home: true });
  assert.ok(!chat.command.includes('dev.json'), chat.command);
  assert.deepEqual(chat.bash('npm run dev'), denied('npm run dev'));
  assert.deepEqual(chat.bash('kill 99999'), {});
});
