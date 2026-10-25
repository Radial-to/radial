// `radial setup` (src/headless/setup.ts): radial serve in the background,
// Radial's MCP server added to the agent CLIs on PATH, with --listen a token
// and what other machines need, then doctor; and running it again changes
// nothing. serve, the installers, PATH and doctor are stand-ins
// (setup.deps); the token store is the real one, in a scratch data dir. The
// npm package's smoke (scripts/cli-package-smoke.mts) runs the real thing.

import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import path from 'path';

import * as setup from '../src/headless/setup';
import * as apiTokens from '../src/headless/apiTokens';
import * as cli from '../src/main/cli';
import type { SetupDeps, SetupReply } from '../src/headless/setup';
import type { ServeReply, ListenConfig } from '../src/headless/serve';
import type { Check } from '../src/headless/doctor';
import type { CliIo } from '../src/main/cli';
import type { InstallResult } from '../src/main/mcp';
import { tmpDir } from './support/tmp';

const real: SetupDeps = { ...setup.deps };
afterEach(() => { Object.assign(setup.deps, real); });

/** A CLI io that keeps what's written. */
function io(env: NodeJS.ProcessEnv): CliIo & { out(): string; err(): string } {
  let out = '', err = '';
  return { stdout: { write: (t: string) => { out += t; } }, stderr: { write: (t: string) => { err += t; } }, env: { RADIAL_CLI_FLAVOR: 'headless', ...env }, cwd: '/', isTTY: false, connect: () => Promise.reject(new Error('no socket in this test')), launch: () => {}, out: () => out, err: () => err };
}

/** A machine for setup: which CLIs are on PATH, the MCP entries each already has, and a serve that starts (with the listener asked for) or is running. */
function machine(dataDir: string, { onPath = ['claude', 'codex'], running = null as null | { listen?: string } } = {}) {
  const calls: string[] = [];
  const have = new Set<string>();
  let serve: Extract<ServeReply, { ok: true }> | null = running ? { ok: true, state: 'running', dataDir, socket: path.join(dataDir, 'cli.sock'), log: path.join(dataDir, 'logs', 'core.log'), pid: 4242, version: '1.0.0', ...(running.listen ? { listen: running.listen } : {}) } : null;
  const checks: Check[] = [{ name: 'node', ok: true, required: true, detail: '24.12.0' }, { name: 'git', ok: true, required: true, detail: '2.39.5' }];
  Object.assign(setup.deps, {
    which: (name: string) => (onPath.includes(name) ? `/usr/bin/${name}` : null),
    install(kind: 'claude-code' | 'codex', command: string): InstallResult {
      calls.push(`install ${kind} ${command}`);
      const already = have.has(kind); have.add(kind);
      return { path: kind === 'codex' ? '/home/someone/.codex/config.toml' : '/home/someone/.claude.json', action: already ? 'already' : 'written' };
    },
    async status(): Promise<ServeReply> { return serve ? { ...serve, state: 'running' } : { ok: false, code: 'not-running', error: `Radial isn't running on ${dataDir}.`, dataDir }; },
    async detach(_dir: string, { listen }: { listen: ListenConfig | null }): Promise<ServeReply> {
      calls.push(`detach${listen ? ` ${listen.address.host}:${listen.address.port}${listen.allowRemote ? ' remote' : ''}` : ''}`);
      serve = { ok: true, state: 'started', dataDir, socket: path.join(dataDir, 'cli.sock'), log: path.join(dataDir, 'logs', 'core.log'), pid: 4242, version: '1.0.0', ...(listen ? { listen: `http://${listen.address.host}:${listen.address.port}` } : {}) };
      return serve;
    },
    doctor: async () => checks,
    addresses: () => ['192.168.1.20'],
  } satisfies Partial<SetupDeps>);
  return { calls, checks };
}

test('setup starts serve, adds Radial to Claude Code and Codex, ends with doctor, and the second run changes nothing', async () => {
  const dataDir = tmpDir('radial-setup-');
  const m = machine(dataDir);
  const env = { RADIAL_DATA_DIR: dataDir, RADIAL_CLI_SHIM: '/opt/radial/lib/node_modules/radial-cli/bin/radial' };
  const first = io(env);
  assert.equal(await cli.main(['setup'], first), 0, first.err());
  assert.deepEqual(m.calls, ['detach', 'install claude-code /opt/radial/lib/node_modules/radial-cli/bin/radial', 'install codex /opt/radial/lib/node_modules/radial-cli/bin/radial']);
  assert.match(first.out(), /^Radial without a window, on this machine:\n {2}Started radial serve in the background \(pid 4242\)\. Its log: .*core\.log\n {2}Claude Code: added Radial's MCP server \(\/home\/someone\/\.claude\.json\)\.\n {2}Codex: added Radial's MCP server \(\/home\/someone\/\.codex\/config\.toml\)\.\n\nWhat radial serve needs on this machine:\n/);
  assert.match(first.out(), /\nEverything radial serve needs is here\.\n$/);
  m.calls.length = 0;
  const second = io(env);
  assert.equal(await cli.main(['setup'], second), 0);
  assert.deepEqual(m.calls, ['install claude-code /opt/radial/lib/node_modules/radial-cli/bin/radial', 'install codex /opt/radial/lib/node_modules/radial-cli/bin/radial'], 'no second serve');
  assert.match(second.out(), /radial serve was already running \(pid 4242\)\.\n {2}Claude Code: already has a radial MCP server .*\n {2}Codex: already has a radial MCP server/);
});

test('setup --listen makes one token named setup and prints RADIAL_URL, RADIAL_TOKEN and the claude mcp add line; again, it makes none', async () => {
  const dataDir = tmpDir('radial-setup-listen-');
  const m = machine(dataDir, { onPath: ['claude'] });
  const env = { RADIAL_DATA_DIR: dataDir };
  const first = io(env);
  assert.equal(await cli.main(['setup', '--listen', '0.0.0.0:4000', '--allow-remote', '--json'], first), 0, first.err());
  const r = JSON.parse(first.out()) as SetupReply;
  assert.deepEqual(m.calls, ['detach 0.0.0.0:4000 remote', 'install claude-code radial']);
  assert.deepEqual([r.ok, r.agents.claudeCode.state, r.agents.codex.state], [true, 'added', 'missing']);
  assert.equal(r.remote!.url, 'http://192.168.1.20:4000', 'a wildcard bind is reached by this machine’s address');
  assert.match(r.remote!.token!, /^rcore_[A-Za-z0-9_-]{43}$/);
  assert.equal(r.remote!.claudeMcpAdd, `claude mcp add --transport http radial http://192.168.1.20:4000/mcp --header "Authorization: Bearer ${r.remote!.token}"`);
  assert.deepEqual(apiTokens.list(dataDir).map((t) => t.name), ['setup']);
  const again = io(env);
  assert.equal(await cli.main(['setup', '--listen', '0.0.0.0:4000', '--allow-remote'], again), 0);
  assert.deepEqual(apiTokens.list(dataDir).map((t) => t.name), ['setup'], 'no second token');
  assert.match(again.out(), /\nFor agents on other machines \(radial serve listens on http:\/\/0\.0\.0\.0:4000\):\n {2}RADIAL_URL=http:\/\/192\.168\.1\.20:4000\n {2}RADIAL_TOKEN: the token named setup was made by an earlier radial setup, and tokens show only when they're made\./);
  assert.match(again.out(), /\n {2}Claude Code there: claude mcp add --transport http radial http:\/\/192\.168\.1\.20:4000\/mcp --header "Authorization: Bearer <token>"\n/);
  assert.match(again.out(), /Codex isn't installed here, so it wasn't set up\./);
  assert.match(again.out(), /Claude Code: already has a radial MCP server/);
});

test('setup --listen with a serve already running without it says how to add the listener, and never restarts it', async () => {
  const dataDir = tmpDir('radial-setup-running-');
  const m = machine(dataDir, { onPath: [], running: {} });
  const out = io({ RADIAL_DATA_DIR: dataDir });
  assert.equal(await cli.main(['setup', '--listen', '127.0.0.1:4000'], out), 6);
  assert.deepEqual(m.calls, [], 'nothing started, nothing stopped');
  assert.match(out.out(), /radial serve was already running \(pid 4242\)\.\n {2}It runs without --listen, so other machines can't reach it\. To add the listener: radial serve stop, then radial setup with --listen again/);
  assert.match(out.out(), /Claude Code isn't installed here, so it wasn't set up \(npm install -g @anthropic-ai\/claude-code, then radial setup again\)\./);
  assert.deepEqual(apiTokens.list(dataDir), [], 'no token for a listener that isn’t there');
  // Bad flags are a usage error before anything happens; something required missing fails it.
  const bad = io({ RADIAL_DATA_DIR: dataDir });
  assert.equal(await cli.main(['setup', '--listen', '0.0.0.0:4000'], bad), 2);
  assert.match(bad.err(), /--allow-remote/);
  m.checks.push({ name: 'git', ok: false, required: true, detail: 'Not found.' });
  assert.equal(await cli.main(['setup'], io({ RADIAL_DATA_DIR: dataDir })), 1);
  // Radial for Mac sets itself up.
  const mac = io({ RADIAL_CLI_FLAVOR: 'packaged' });
  assert.equal(await cli.main(['setup'], mac), 0);
  assert.match(mac.out(), /^Radial for Mac sets itself up\. `radial setup` is for radial serve .* radial mcp --install claude-code\.\n$/);
});

test('remoteUrl: the listener’s own address, or this machine’s for a wildcard bind', () => {
  assert.equal(setup.remoteUrl('http://127.0.0.1:4000', ['10.0.0.5']), 'http://127.0.0.1:4000');
  assert.equal(setup.remoteUrl('http://0.0.0.0:4100', ['10.0.0.5']), 'http://10.0.0.5:4100');
  assert.equal(setup.remoteUrl('http://[::]:4000', []), 'http://<this machine>:4000');
});
