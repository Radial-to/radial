#!/usr/bin/env node
// The radial-cli package, installed, end to end (plans/headless-core.md,
// phase 5). Run it with the `radial` an `npm install -g` put on PATH, on a Mac
// or in a Linux container, as root or not:
//
//   node scripts/cli-package-smoke.mts --radial <radial command> --fake-claude test/fixtures/fake-claude.cjs
//
// Everything happens in a scratch folder: a throwaway data dir
// (RADIAL_USERDATA, so stopping serve takes its terminal service and agents
// with it), a home of its own (radial setup writes the agents' MCP configs
// there, never into yours), and a stand-in for Claude Code first on PATH (the
// fixture, plus `claude mcp add` answered the way Claude Code does). No
// browser: PLAYWRIGHT_BROWSERS_PATH points at an empty folder.
//   --version, then doctor: node-pty loads here;
//   setup: serve starts, Claude Code gets the MCP server; again: nothing changes;
//   ls, open a static git site and fetch its preview, edit text --find and see it;
//   agent start --submit with the stand-in, then wait: the bell, the task on screen;
//   telemetry status: a package without the key sends nothing;
//   serve stop: no serve, no terminal service left.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';

function args(argv: string[]): { radial: string; fakeClaude: string; keep: boolean } {
  const a = { radial: 'radial', fakeClaude: '', keep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--radial') a.radial = argv[++i];
    else if (argv[i] === '--fake-claude') a.fakeClaude = path.resolve(argv[++i]);
    else if (argv[i] === '--keep') a.keep = true;
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  if (!a.fakeClaude || !fs.existsSync(a.fakeClaude)) throw new Error('--fake-claude <test/fixtures/fake-claude.cjs> is needed');
  return a;
}
const opts = args(process.argv.slice(2));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rcs-')); // short: the sockets live under it
const data = path.join(scratch, 'data'), home = path.join(scratch, 'home'), bin = path.join(scratch, 'bin');
for (const d of [home, bin]) fs.mkdirSync(d, { recursive: true });
// Claude Code's stand-in: `claude mcp …` answers as Claude Code 2.1 does (added, then already there); anything else is the fixture.
fs.copyFileSync(opts.fakeClaude, path.join(bin, 'fake-claude.cjs'));
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
if [ "$1" = "mcp" ]; then
  echo "$*" >> "${scratch}/mcp-calls.log"
  if [ -f "${scratch}/mcp-added" ]; then echo "MCP server radial already exists in user config" >&2; exit 1; fi
  touch "${scratch}/mcp-added"; echo "Added stdio MCP server radial with command: $7 $8 to user config"; echo "File modified: $HOME/.claude.json"; exit 0
fi
exec node "${bin}/fake-claude.cjs" "$@"
`, { mode: 0o755 });

const env: NodeJS.ProcessEnv = {
  ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RADIAL_USERDATA: data,
  CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'), RADIAL_FAKE_CLI_LOG: path.join(scratch, 'fake-cli.jsonl'),
  PLAYWRIGHT_BROWSERS_PATH: path.join(scratch, 'no-browsers'), RADIAL_NO_CAFFEINATE: '1', RADIAL_AUTO_RELOAD: '0',
};
for (const k of ['RADIAL_CLI_SOCK', 'RADIAL_DATA_DIR', 'RADIAL_CLI_APP', 'RADIAL_CLI_APP_ARG', 'RADIAL_CLI_FLAVOR', 'ELECTRON_RUN_AS_NODE', 'RADIAL_URL', 'RADIAL_TOKEN', 'RADIAL_POSTHOG_KEY', 'CI', 'DO_NOT_TRACK']) delete env[k];

interface Run { code: number; stdout: string; stderr: string }
const radial = (argv: string[], timeout = 180000) => new Promise<Run>((resolve) => execFile(opts.radial, argv, { env, encoding: 'utf8', timeout, cwd: scratch }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
const json = async <T,>(argv: string[]): Promise<Run & { json: T }> => { const r = await radial([...argv, '--json']); let j: T | null = null; try { j = JSON.parse(r.stdout) as T; } catch {} return { ...r, json: j as T }; };
function check(ok: unknown, what: string, detail: unknown = ''): void {
  if (!ok) throw new Error(`${what}${detail ? `\n${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}` : ''}`);
  console.log(`ok  ${what}`);
}
function get(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { agent: false }, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c: string) => { body += c; }); res.on('end', () => resolve(body)); });
    req.on('error', () => resolve(null)); req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, ms: number, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v as T; await sleep(250); }
  throw new Error(`timed out: ${what}`);
}

let corePid = 0;
try {
  const version = await radial(['--version']);
  check(version.code === 0 && /^\d+\.\d+\.\d+/.test(version.stdout), `radial --version: ${version.stdout.trim()}`, version.stderr);
  const doctor = await json<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }>(['doctor']);
  const pty = doctor.json && doctor.json.checks.find((c) => c.name === 'node-pty');
  check(doctor.code === 0 && doctor.json.ok, 'radial doctor: everything required is here', doctor.stdout + doctor.stderr);
  check(pty && pty.ok, `node-pty: ${pty && pty.detail}`, pty);

  // setup: serve in the background, Claude Code's MCP entry; again, nothing changes.
  const setup = await json<{ ok: boolean; serve: { ok: boolean; pid?: number; state?: string }; agents: { claudeCode: { state: string }; codex: { state: string } } }>(['setup']);
  check(setup.json && setup.json.serve.ok && setup.json.serve.state === 'started', 'radial setup started radial serve', setup.stdout + setup.stderr);
  corePid = setup.json.serve.pid || 0;
  check(setup.json.agents.claudeCode.state === 'added', 'radial setup added Radial to Claude Code', setup.json.agents);
  const calls = fs.readFileSync(path.join(scratch, 'mcp-calls.log'), 'utf8').trim();
  check(/^mcp add --scope user radial -- \S+ mcp$/.test(calls), `as claude ${calls}`);
  const again = await json<{ serve: { already?: boolean }; agents: { claudeCode: { state: string } } }>(['setup']);
  check(again.json && again.json.serve.already === true && again.json.agents.claudeCode.state === 'already', 'radial setup again: serve already running, Claude Code already set up', again.json);

  // ls, open, the preview, edit text.
  const ls = await json<{ ok: boolean; projects: unknown[] }>(['ls']);
  check(ls.code === 0 && ls.json.ok, 'radial ls', ls.stderr);
  const site = path.join(scratch, 'site');
  fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><html><head><title>Fixture</title></head><body><h1>Welcome home</h1><p>Some body copy.</p></body></html>\n');
  const git = (a: string[]) => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', ...a], { cwd: site, stdio: 'ignore' });
  git(['init', '-q', '-b', 'main']); git(['add', '-A']); git(['commit', '-q', '-m', 'init']);
  const opened = await json<{ ok: boolean; url: string }>(['open', site]);
  check(opened.code === 0 && opened.json.url, `radial open: ${opened.json && opened.json.url}`, opened.stdout + opened.stderr);
  check(/Welcome home/.test((await get(opened.json.url)) || ''), 'the preview serves the site');
  const edited = await json<{ ok: boolean; relFile: string }>(['edit', 'text', site, '--find', 'Welcome home', '--to', 'Welcome back']);
  check(edited.code === 0 && edited.json.relFile === 'index.html', 'radial edit text --find', edited.stdout + edited.stderr);
  check(/Welcome back/.test(fs.readFileSync(path.join(site, 'index.html'), 'utf8')), 'the file says the new text');
  await until('the preview shows the edit', 15000, async () => /Welcome back/.test((await get(opened.json.url)) || ''));
  check(true, 'the preview shows the edit');

  // An agent session with Claude Code's stand-in.
  const start = await json<{ ok: boolean; id: string; engine: string; submitted: boolean; landed: boolean }>(['agent', 'start', site, 'Fix the hero', '--submit']);
  check(start.code === 0 && start.json.engine === 'claude' && start.json.submitted, `radial agent start --submit: ${start.json && start.json.id}`, start.stdout + start.stderr);
  const wait = await json<{ ok: boolean; reason: string; text: string }>(['agent', 'wait', start.json.id, '--timeout', '30']);
  check(wait.code === 0 && wait.json.reason === 'bell' && /TASK: Fix the hero/.test(wait.json.text), 'radial agent wait: the bell, with the task on screen', wait.json || wait.stderr);
  const killed = await radial(['agent', 'kill', start.json.id, '--yes']);
  check(killed.code === 0, 'radial agent kill --yes', killed.stderr);

  // Usage events: a package without the official key sends nothing, and says so.
  const usage = await json<{ on: boolean; why: string }>(['telemetry', 'status']);
  check(usage.code === 0 && usage.json.on === false && ['source', 'throwaway'].includes(usage.json.why), `radial telemetry status: off (${usage.json && usage.json.why})`, usage.json);
  check(!fs.existsSync(path.join(data, 'radial-telemetry.json')) || !JSON.parse(fs.readFileSync(path.join(data, 'radial-telemetry.json'), 'utf8')).distinctId, 'no install ID where nothing is sent');

  // serve stop: no serve, no terminal service.
  const stopped = await json<{ ok: boolean; state: string }>(['serve', 'stop']);
  check(stopped.code === 0 && stopped.json.state === 'stopped', 'radial serve stop', stopped.stdout + stopped.stderr);
  await until('the terminal service goes', 15000, () => !fs.existsSync(path.join(data, 'term-daemon.sock')));
  check(true, 'no serve and no terminal service left');
  corePid = 0;
  console.log('\nThe radial-cli package works here.');
} catch (e) {
  console.error(`\nFAILED: ${(e as Error).message}`);
  try { console.error('\n--- core.log (last lines) ---\n' + fs.readFileSync(path.join(data, 'logs', 'core.log'), 'utf8').split('\n').slice(-40).join('\n')); } catch {}
  process.exitCode = 1;
} finally {
  if (corePid) { await radial(['serve', 'stop'], 60000); try { process.kill(corePid, 'SIGKILL'); } catch {} }
  if (!opts.keep) fs.rmSync(scratch, { recursive: true, force: true }); else console.log(`Scratch folder kept: ${scratch}`);
}
