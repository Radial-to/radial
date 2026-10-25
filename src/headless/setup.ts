/**
 * `radial setup`: Radial without a window, ready for the agents on this
 * machine in one command (plans/headless-core.md, section 4):
 * 1. radial serve in the background (`radial serve --detach`), with --listen
 *    and its flags when given;
 * 2. Radial's MCP server registered with the agent CLIs found on PATH:
 *    Claude Code (`claude mcp add --scope user radial -- radial mcp`) and
 *    Codex (its config.toml), through `radial mcp --install`'s own code;
 * 3. with --listen, a token for other machines (made once, named setup) and
 *    what they need: RADIAL_URL and RADIAL_TOKEN for the CLI, and the
 *    `claude mcp add --transport http` line for Claude Code;
 * 4. radial doctor's checks.
 * Running it again changes nothing that's already set up, and it says what
 * it changed and what it found as it was. It never restarts a running serve:
 * one without the listener asked for says how to restart it.
 */
import os from 'os';
import * as dataDirs from '../main/dataDirs';
import * as mcp from '../main/mcp';
import * as apiTokens from './apiTokens';
import * as doctor from './doctor';
import * as serve from './serve';
import * as usage from './usage';
import { isWildcard } from './previewProxy';
import type { CliIo, Flags } from '../main/cli';
import type { InstallResult } from '../main/mcp';
import type { ListenConfig, ServeReply } from './serve';
import type { Check } from './doctor';

/** What setup reaches: PATH, the MCP installer, serve, tokens, doctor and the network; or a test's stand-ins. */
export interface SetupDeps {
  which(name: string): string | null;
  install(kind: 'claude-code' | 'codex', command: string): InstallResult;
  status(dataDir: string, env: NodeJS.ProcessEnv): Promise<ServeReply>;
  detach(dataDir: string, opts: { env: NodeJS.ProcessEnv; listen: ListenConfig | null }): Promise<ServeReply>;
  doctor(dataDir: string): Promise<Check[]>;
  /** This machine's own addresses on its networks (not loopback), for the address other machines use. */
  addresses(): string[];
}
export const deps: SetupDeps = {
  which: (name) => doctor.deps.which(name),
  install: (kind, command) => mcp.installConfig(kind, command),
  status: (dataDir, env) => serve.status(dataDir, env),
  detach: (dataDir, { env, listen }) => serve.detach(dataDir, { env, listen }),
  doctor: (dataDir) => doctor.checks(dataDir),
  addresses() {
    const out: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (!a.internal && a.family === 'IPv4') out.push(a.address);
    return out;
  },
};

/** What setup did for one agent CLI: added the server, found it there, isn't installed, or couldn't. */
export type AgentSetup =
  | { state: 'added' | 'already'; where: string }
  | { state: 'missing' }
  | { state: 'failed'; error: string };
/** What other machines need: the address, the token (only when setup made it now), and the line for Claude Code. */
export interface RemoteSetup { url: string; tokenName: string; token: string | null; made: boolean; claudeMcpAdd: string }
/** `radial setup --json`: each step, and doctor's checks. */
export interface SetupReply {
  ok: boolean;
  dataDir: string;
  serve: ServeReply & { already?: boolean };
  agents: { claudeCode: AgentSetup; codex: AgentSetup };
  remote?: RemoteSetup;
  /** --listen was asked for, but a serve without it was running already: what to run. */
  listenRefused?: string;
  doctor: { ok: boolean; checks: Check[] };
}

/** The address other machines use for a listener: its own, or for a wildcard bind (0.0.0.0) this machine's first network address. */
export function remoteUrl(listen: string, addresses: string[]): string {
  const u = new URL(listen);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!isWildcard(host)) return u.origin;
  return `http://${addresses[0] || '<this machine>'}:${u.port}`;
}

/** The name of the token setup makes: once, so running it again makes no more. */
export const TOKEN_NAME = 'setup';

/** An agent CLI's MCP entry: added, already there, or why not. */
function agentSetup(kind: 'claude-code' | 'codex', bin: string, command: string): AgentSetup {
  if (!deps.which(bin)) return { state: 'missing' };
  try { const r = deps.install(kind, command); return { state: r.action === 'already' ? 'already' : 'added', where: r.path }; }
  catch (e) { return { state: 'failed', error: (e as Error).message }; }
}

/**
 * `radial setup [--listen <address> [--allow-remote] [--allow-host <name>]…
 * [--allow-origin <origin>]…] [--data-dir <dir>] [--json]` as the CLI runs it.
 * 0 when serve runs and doctor finds what it needs; 1 when serve didn't start
 * or something required is missing; 2 for bad flags; 6 when --listen was
 * asked of a serve already running without it.
 */
export async function command(_positional: string[], flags: Flags, io: Pick<CliIo, 'stdout' | 'stderr' | 'env'>): Promise<number> {
  const env = io.env;
  const dataDir = dataDirs.headlessDataDir(env);
  const json = !!flags.json;
  const listen = serve.listenConfig(flags);
  if (listen && 'error' in listen) {
    if (json) io.stdout.write(JSON.stringify({ ok: false, code: 'bad-request', error: listen.error }) + '\n'); else io.stderr.write(`radial: ${listen.error}\n`);
    return 2;
  }
  const lines: string[] = [];
  const say = (line: string) => lines.push(`  ${line}`);

  // 1. radial serve, in the background.
  let running = await deps.status(dataDir, env);
  let serveReply: SetupReply['serve'];
  let listenRefused: string | undefined;
  if (running.ok) {
    serveReply = { ...running, already: true };
    say(`radial serve was already running (pid ${running.pid}).`);
    if (listen && !running.listen) {
      listenRefused = `It runs without --listen, so other machines can't reach it. To add the listener: radial serve stop, then radial setup with --listen again (agents keep running; dev servers restart when their projects open).`;
      say(listenRefused);
    }
  } else {
    const note = usage.notice(dataDir, env); // the one-time note about usage events, before the serve that would send them starts
    if (note) io.stderr.write(note + '\n');
    running = await deps.detach(dataDir, { env, listen });
    serveReply = running;
    say(running.ok ? `Started radial serve in the background (pid ${running.pid}). Its log: ${running.log}` : `radial serve didn't start: ${running.error}`);
  }

  // 2. The agent CLIs on this machine get Radial's MCP server (stdio, this machine's radial).
  const command = env.RADIAL_CLI_SHIM || 'radial';
  const claudeCode = agentSetup('claude-code', 'claude', command);
  const codex = agentSetup('codex', 'codex', command);
  const describe = (name: string, r: AgentSetup, install: string) => {
    if (r.state === 'missing') say(`${name} isn't installed here, so it wasn't set up${install ? ` (${install}, then radial setup again)` : ''}.`);
    else if (r.state === 'failed') say(`${name}: couldn't add Radial's MCP server: ${r.error}`);
    else say(r.state === 'added' ? `${name}: added Radial's MCP server (${r.where}).` : `${name}: already has a radial MCP server (${r.where}).`);
  };
  describe('Claude Code', claudeCode, 'npm install -g @anthropic-ai/claude-code');
  describe('Codex', codex, '');

  // 3. --listen: a token for other machines, once, and what they need.
  let remote: RemoteSetup | undefined;
  if (listen && running.ok && running.listen) {
    const url = remoteUrl(running.listen, deps.addresses());
    const made = apiTokens.create(dataDir, TOKEN_NAME);
    const token = made.ok ? made.token : null;
    const bearer = token || '<token>';
    remote = { url, tokenName: TOKEN_NAME, token, made: made.ok, claudeMcpAdd: `claude mcp add --transport http radial ${url}/mcp --header "Authorization: Bearer ${bearer}"` };
    lines.push('', `For agents on other machines (radial serve listens on ${running.listen}):`);
    say(`RADIAL_URL=${url}`);
    if (token) say(`RADIAL_TOKEN=${token}  (shown only now: keep it somewhere safe)`);
    else say(`RADIAL_TOKEN: the token named ${TOKEN_NAME} was made by an earlier radial setup, and tokens show only when they're made. radial token create <name> makes another; radial token revoke ${TOKEN_NAME} ends the old one.`);
    say(`Claude Code there: ${remote.claudeMcpAdd}`);
    if (url.includes('<this machine>')) say('Use this machine\'s address in place of <this machine>.');
  }

  // 4. doctor.
  const checks = await deps.doctor(dataDir);
  const doctorOk = checks.every((c) => c.ok || !c.required);
  const ok = running.ok && doctorOk && !listenRefused;
  if (json) {
    const reply: SetupReply = { ok, dataDir, serve: serveReply, agents: { claudeCode, codex }, ...(remote ? { remote } : {}), ...(listenRefused ? { listenRefused } : {}), doctor: { ok: doctorOk, checks } };
    io.stdout.write(JSON.stringify(reply) + '\n');
  } else {
    io.stdout.write(['Radial without a window, on this machine:', ...lines, ''].join('\n') + '\n');
    await doctor.command([], {}, { stdout: io.stdout, env }, checks);
  }
  return !running.ok || !doctorOk ? 1 : listenRefused ? 6 : 0;
}
