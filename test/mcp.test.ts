// `radial mcp`: the stdio MCP server against a real control server with a
// fake api. Speaks the protocol subset the way Claude Desktop / Cursor / Codex
// do: initialize → initialized → tools/list → tools/call, resources/list/read.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';

import * as mcp from '../src/main/mcp';
import * as cli from '../src/main/cli';
import * as cliServer from '../src/main/cliServer';
import * as spec from '../src/main/cliSpec';
import type { CliIo } from '../src/main/cli';
import type { ToolArgs } from '../src/main/mcp';
import type { McpTool } from '../src/main/cliSpec';
import type { CliApi, OpReplies } from '../src/main/cliServer';
import type { Sketch, FakeMethods } from './cli.test'; // the fake api's types; a type import is erased, so cli.test.ts's tests don't run here
import { encodePng } from '../src/headless/png';
import { tmpDir } from './support/tmp';
import { fakeSessions, trustAsk } from './fixtures/fakeSessions';

/** What a fake api method was given after the project or session it works on. */
type ArgsOf<K extends keyof CliApi> = Parameters<CliApi[K]>[1];
/** A call the fake app saw: the method, then what it was given after the project or session (agentKeep records the session id too). */
type Call = ['publish', ArgsOf<'publish'>] | ['agentStart', ArgsOf<'agentStart'>] | ['agentWait', ArgsOf<'agentWait'>] | ['agentKeep', string, ArgsOf<'agentKeep'>];

// The protocol as these tests speak it: what mcp.ts serve answers, copied here
// because mcp.ts doesn't export it yet. The names differ from mcp.ts's private
// RpcParams, RpcError and ClientConfig, which are other shapes.
/** What a request's params carry, by method; the other methods take none. */
interface ClientParams {
  initialize: { protocolVersion: string; capabilities: Record<string, unknown>; clientInfo: { name: string; version: string } };
  'tools/call': { name: string; arguments: ToolArgs };
  'resources/read': { uri: string };
}
/** A document's media type, as mcp.ts mimeFor names it from the file's extension. */
type McpMimeType = 'text/markdown' | 'application/json' | 'text/html' | 'text/plain';
/** A tool call's answer: the reply rendered for a model, and whether the app refused. */
interface McpToolResult { content: { type: 'text'; text: string }[]; isError: boolean }
/** What each method answers when it works. */
interface McpResults {
  initialize: { protocolVersion: typeof mcp.PROTOCOL_VERSION; capabilities: { tools: { listChanged: boolean }; resources: { subscribe: boolean; listChanged: boolean } }; serverInfo: { name: string; version: string } };
  ping: Record<string, never>;
  'tools/list': { tools: Pick<McpTool, 'name' | 'description' | 'inputSchema'>[] };
  'tools/call': McpToolResult;
  'resources/list': { resources: { uri: string; name: string; mimeType: McpMimeType }[] };
  /** uri: the request's own, echoed back unchecked. */
  'resources/read': { contents: { uri: unknown; mimeType: McpMimeType; text: string }[] };
}
/** A JSON-RPC error: -32601 for an unknown method, -32602 for an unknown tool or resource, -32603 for a method that threw. */
interface RpcErrorBody { code: number; message: string; data?: unknown }
/** The reply to a request for method M: its result when it worked, else the error (a method McpResults doesn't list has an untyped result). */
type RpcReply<M extends string> = { jsonrpc: '2.0'; id: number } & ({ result: M extends keyof McpResults ? McpResults[M] : unknown; error?: undefined } | { result?: undefined; error: RpcErrorBody });
/** A reply off the wire, whichever request it answers. */
type RpcMessage = RpcReply<string>;
/** An MCP client's JSON config as these tests read it back: the radial server installConfig or configSnippet wrote, beside the client's other servers and settings (a theme here). */
interface WrittenClientConfig { mcpServers: { radial: { command: string; args: string[] }; [server: string]: { command: string; args?: string[] } }; theme?: string }

function tmp() { return tmpDir('rmcp-'); }
function fakeApi(over: FakeMethods = {}): CliApi {
  return {
    info: () => ({ version: '9.9.9', flavor: 'test', pid: 1, windowReady: true }),
    isOpen: (d) => d === '/open/site', focus: () => ({}), telemetry: () => {}, requestOpen: () => {},
    resolve: async (t) => (t === 'amb' ? { ok: false, code: 'ambiguous', error: 'two', candidates: [{ path: '/a', name: 'a' }, { path: '/b', name: 'b' }] } : { ok: true, kind: 'path', dir: t || '/cwd' }),
    clone: async () => ({ ok: false, code: 'error', error: 'no' }),
    projects: async ({ all }) => ({ projects: [{ repoDir: '/open/site', name: 'site', url: 'http://localhost:7/', state: 'running', active: true, terminals: 0 }], ...(all ? { recents: [] } : {}) }),
    previewUrl: (d) => (d === '/open/site' ? 'http://localhost:7/' : null),
    status: async () => ({ name: 'site', open: true }),
    context: async () => ({ name: 'site', rules: '## Project rules\n- be nice', docs: [{ file: 'design.md', content: '# Design' }], references: [], pages: [{ route: '/' }], url: 'http://localhost:7/', openComments: 2 }),
    pages: async () => [{ route: '/', label: 'Home' }], comments: async () => [], shot: async () => ({ ok: true, path: '/tmp/s.png' }),
    create: async () => ({ ok: true, dir: '/new/x' }), sleep: async () => ({ state: 'asleep' }), wake: async () => ({ state: 'running' }), close: async () => ({ state: 'closed' }), liveTerminals: async () => 0,
    ...over,
  } satisfies FakeMethods as CliApi; // a fake: the methods these tests drive, answering only the fields they read; another method's op fails its test
}
// A client speaking newline JSON-RPC over two PassThrough streams.
function session(env: NodeJS.ProcessEnv) {
  const input = new PassThrough(); const output = new PassThrough();
  const io: CliIo = { stdin: input, stdout: output, stderr: { write: () => {} }, env, cwd: '/cwd', isTTY: false, launchTimeoutMs: 500, connect: (sock) => new Promise((res, rej) => { const s = (require('net') as typeof import('net')).createConnection(sock); s.once('connect', () => res(s)); s.once('error', rej); }), launch: () => {} };
  const done = mcp.serve({ input, output, api: mcp.socketApi(cli, io) });
  const replies = new Map<number, RpcMessage>(); const waiters = new Map<number, (m: RpcMessage) => void>();
  let buf = '';
  output.on('data', (chunk: Buffer) => { buf += chunk; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue; const m = JSON.parse(line) as RpcMessage; replies.set(m.id, m); const w = waiters.get(m.id); if (w) w(m); } }); // the server's own replies
  let seq = 0;
  // call reads its reply as the method's: the server answers each request with that method's result.
  return {
    call: <M extends string>(method: M, params?: M extends keyof ClientParams ? ClientParams[M] : undefined) => new Promise<RpcMessage>((res) => { const id = ++seq; waiters.set(id, res); input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }) as Promise<RpcReply<M>>,
    notify: (method: string, params?: Record<string, unknown>) => input.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    end: () => { input.end(); return done; },
  };
}

test('initialize, ping, tools/list from the verb table, and an unknown method', async () => {
  const s = session({ RADIAL_CLI_SOCK: path.join(tmp(), 'none.sock') });
  const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result!.protocolVersion, mcp.PROTOCOL_VERSION);
  assert.equal(init.result!.serverInfo.name, 'radial');
  assert.ok(init.result!.capabilities.tools && init.result!.capabilities.resources);
  s.notify('notifications/initialized');
  assert.deepEqual((await s.call('ping')).result, {});
  const tools = (await s.call('tools/list')).result!.tools;
  assert.deepEqual(tools.map((t) => t.name), spec.mcpTools().map((t) => t.name));
  assert.ok(tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));
  const bad = await s.call('nope');
  assert.equal(bad.error!.code, -32601);
  const badTool = await s.call('tools/call', { name: 'not_a_tool', arguments: {} });
  assert.equal(badTool.error!.code, -32602);
  await s.end();
});

test('a method named after an Object.prototype member is not found', async () => {
  const s = session({ RADIAL_CLI_SOCK: path.join(tmp(), 'none.sock') });
  for (const method of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const r = await s.call(method);
    assert.equal(r.result, undefined, method);
    assert.equal(r.error!.code, -32601, method);
    assert.equal(r.error!.message, `Method not found: ${method}`);
  }
  await s.end();
});

test('tools/call reaches the app: list_projects returns JSON, get_context returns markdown, refusals are isError', async () => {
  const sock = path.join(tmp(), 'cli.sock');
  const srv = cliServer.start({ socketPath: sock, api: fakeApi() });
  await new Promise((r) => setTimeout(r, 40));
  const s = session({ RADIAL_CLI_SOCK: sock });
  try {
    const ls = (await s.call('tools/call', { name: 'list_projects', arguments: {} })).result!;
    assert.equal(ls.isError, false);
    assert.equal((JSON.parse(ls.content[0].text) as Sketch<OpReplies['ls']>).projects![0].name, 'site');
    const ctx = (await s.call('tools/call', { name: 'get_context', arguments: { project: '/open/site' } })).result!;
    assert.match(ctx.content[0].text, /^# site/); assert.match(ctx.content[0].text, /be nice/); assert.match(ctx.content[0].text, /## \.context\/design\.md/); assert.match(ctx.content[0].text, /2 open comments/);
    const url = (await s.call('tools/call', { name: 'preview_url', arguments: { project: '/closed/site' } })).result!;
    assert.equal(url.isError, true); assert.match(url.content[0].text, /no-dev-server/);
    const amb = (await s.call('tools/call', { name: 'open_project', arguments: { target: 'amb' } })).result!;
    assert.equal(amb.isError, true); assert.match(amb.content[0].text, /1\. a — \/a/);
    const pages = (await s.call('tools/call', { name: 'list_pages', arguments: { project: '/open/site' } })).result!;
    assert.deepEqual((JSON.parse(pages.content[0].text) as Sketch<OpReplies['pages']>).pages, [{ route: '/', label: 'Home' }]);
  } finally { await s.end(); srv.stop(); }
});

test('resources: every open or recent project exposes AGENTS.md and its .context docs; reads stay inside .context', async () => {
  const proj = path.join(tmp(), 'site');
  fs.mkdirSync(path.join(proj, '.context'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'AGENTS.md'), '# Rules\n');
  fs.writeFileSync(path.join(proj, '.context', 'design-system.md'), '# Tokens\n');
  fs.writeFileSync(path.join(proj, '.context', 'logo.png'), 'png');
  const sock = path.join(tmp(), 'cli.sock');
  const srv = cliServer.start({ socketPath: sock, api: fakeApi({
    projects: async () => ({ projects: [{ repoDir: proj, name: 'site', url: null, state: 'asleep', active: false, terminals: 0 }], recents: [] }),
    context: async dir => cli.offlineContext(dir),
  }) });
  await new Promise((r) => setTimeout(r, 40));
  const s = session({ RADIAL_CLI_SOCK: sock });
  try {
    const list = (await s.call('resources/list')).result!.resources;
    const uris = list.map((r) => r.uri);
    const key = encodeURIComponent(proj);
    assert.ok(uris.includes(`radial://project/${key}/AGENTS.md`));
    assert.ok(uris.includes(`radial://project/${key}/context/design-system.md`));
    assert.equal(list.find((r) => r.uri.endsWith('logo.png'))!.mimeType, 'text/plain');
    const read = (await s.call('resources/read', { uri: `radial://project/${key}/context/design-system.md` })).result!;
    assert.equal(read.contents[0].text, '# Tokens\n'); assert.equal(read.contents[0].mimeType, 'text/markdown');
    const rules = (await s.call('resources/read', { uri: `radial://project/${key}/AGENTS.md` })).result!;
    assert.equal(rules.contents[0].text, '# Rules\n');
    const escape = await s.call('resources/read', { uri: `radial://project/${key}/context/..%2F..%2Fetc%2Fpasswd` });
    assert.ok(escape.error, 'no path escape');
    assert.ok((await s.call('resources/read', { uri: 'radial://nope' })).error);
  } finally { await s.end(); srv.stop(); }
});

test('with the app closed, get_context and preview_url answer from disk and open_project would launch it', async () => {
  const userData = tmp();
  const proj = path.join(tmp(), 'summit-site');
  fs.mkdirSync(path.join(proj, '.radial'), { recursive: true }); fs.mkdirSync(path.join(proj, '.context'));
  fs.writeFileSync(path.join(proj, '.radial', 'dev.json'), JSON.stringify({ url: 'http://localhost:4321/' }));
  fs.writeFileSync(path.join(proj, '.context', 'positioning.md'), '# Positioning\nBold.');
  fs.writeFileSync(path.join(userData, 'radial-store.json'), JSON.stringify({ recents: [{ path: proj, name: 'summit-site', lastOpened: 1 }] }));
  const s = session({ RADIAL_USERDATA: userData });
  try {
    const ctx = (await s.call('tools/call', { name: 'get_context', arguments: { project: 'summit' } })).result!;
    assert.equal(ctx.isError, false); assert.match(ctx.content[0].text, /Positioning/); assert.match(ctx.content[0].text, /preview: http:\/\/localhost:4321\//);
    const url = (await s.call('tools/call', { name: 'preview_url', arguments: { project: 'summit-site' } })).result!;
    assert.equal((JSON.parse(url.content[0].text) as OpReplies['url']).url, 'http://localhost:4321/');
    const open = (await s.call('tools/call', { name: 'open_project', arguments: { target: proj } })).result!;
    assert.equal(open.isError, true); assert.match(open.content[0].text, /unreachable/); // launch() is a no-op here; the real one starts the app
  } finally { await s.end(); }
});

test('config snippets point MCP clients at the shim', () => {
  const c = mcp.configSnippet('claude', '/Applications/Radial.app/Contents/Resources/bin/radial');
  assert.match(c, /claude_desktop_config\.json/); assert.equal((JSON.parse(c.split('\n').slice(1).join('\n')) as WrittenClientConfig).mcpServers.radial.args[0], 'mcp');
  assert.match(mcp.configSnippet('cursor', '/x/radial'), /mcp\.json/);
  assert.match(mcp.configSnippet('codex', '/x/radial'), /\[mcp_servers\.radial\]\ncommand = "\/x\/radial"\nargs = \["mcp"\]/);
});

test('the write and agent tools reach the server: publish refuses without yes, run_agent submits by default, agent_wait and agent_output render text', async () => {
  const calls: Call[] = [];
  const sock = path.join(tmp(), 'cli.sock');
  const srv = cliServer.start({ socketPath: sock, api: fakeApi({
    publish: async (d, a) => { calls.push(['publish', a]); return { ok: true, mode: 'merge' }; },
    agentStart: async (d, o) => { calls.push(['agentStart', o]); return { ok: true, id: 'pty1', label: 'Fix', engine: 'claude', submitted: o.submit, landed: true }; },
    agentWait: async (id, o) => { calls.push(['agentWait', o]); return { ok: true, id: 'pty1', reason: 'bell', alive: true, text: 'Done ✓' }; },
    agentOutput: async () => ({ ok: true, id: 'pty1', alive: true, text: 'screen text' }),
    editText: async () => ({ ok: true, relFile: 'index.html', line: 2 }),
    agentKill: async () => ({ ok: true, id: 'pty1' }),
    agentKeep: async (id, o) => { calls.push(['agentKeep', id, o]); return { ok: true, id, on: o.on }; },
  }) });
  await new Promise((r) => setTimeout(r, 40));
  const s = session({ RADIAL_CLI_SOCK: sock });
  try {
    const tools = (await s.call('tools/list')).result!.tools.map((t) => t.name);
    for (const t of ['edit_text', 'publish', 'run_agent', 'agent_wait', 'agent_output', 'list_agents', 'kill_agent', 'keep_agent_awake', 'reload_preview', 'restart_dev_server']) assert.ok(tools.includes(t), t);
    const keep = (await s.call('tools/call', { name: 'keep_agent_awake', arguments: { id: 'pty1' } })).result!;
    assert.equal(keep.isError, false); assert.match(keep.content[0].text, /^Kept awake: pty1/);
    assert.deepEqual(calls.find((c) => c[0] === 'agentKeep')!.slice(1), ['pty1', { on: true }]);
    const rel = (await s.call('tools/call', { name: 'keep_agent_awake', arguments: { id: 'pty1', off: true } })).result!;
    assert.match(rel.content[0].text, /can be parked again/);
    const pub = (await s.call('tools/call', { name: 'publish', arguments: { project: '/open/site', to: 'production' } })).result!;
    assert.equal(pub.isError, true); assert.match(pub.content[0].text, /needs-yes/);
    assert.match(pub.content[0].text, /\nTo go ahead: ask the person, then call publish again with confirm: true\.$/, 'the refusal says how, in the tool’s terms');
    const ok = (await s.call('tools/call', { name: 'publish', arguments: { project: '/open/site', to: 'production', confirm: true } })).result!;
    assert.equal(ok.isError, false); assert.equal((JSON.parse(ok.content[0].text) as Pick<OpReplies['publish'], 'target'>).target, 'production'); // the fake's merge stand-in, with the target the server adds
    const older = (await s.call('tools/call', { name: 'publish', arguments: { project: '/open/site', to: 'production', yes: true } })).result!;
    assert.equal(older.isError, false, 'yes: true, as clients before confirm send it, still confirms');
    const run = (await s.call('tools/call', { name: 'run_agent', arguments: { project: '/open/site', task: 'Fix the hero' } })).result!;
    assert.equal(run.isError, false); assert.equal((JSON.parse(run.content[0].text) as Sketch<OpReplies['agentStart']>).id, 'pty1');
    assert.equal(calls.find((c) => c[0] === 'agentStart')![1].submit, true, 'an MCP caller is an explicit principal: it submits');
    const staged = (await s.call('tools/call', { name: 'run_agent', arguments: { project: '/open/site', task: 'Fix', submit: false } })).result!;
    assert.equal((JSON.parse(staged.content[0].text) as Sketch<OpReplies['agentStart']>).submitted, false);
    const wait = (await s.call('tools/call', { name: 'agent_wait', arguments: { id: 'pty1', timeout: 5 } })).result!;
    assert.match(wait.content[0].text, /^reason: bell/); assert.match(wait.content[0].text, /Done ✓/);
    assert.equal(calls.find((c) => c[0] === 'agentWait')![1].waitMs, 5000);
    const out = (await s.call('tools/call', { name: 'agent_output', arguments: { id: 'pty1' } })).result!;
    assert.equal(out.content[0].text, 'screen text');
    const edit = (await s.call('tools/call', { name: 'edit_text', arguments: { project: '/open/site', find: 'a', to: 'b' } })).result!;
    assert.equal((JSON.parse(edit.content[0].text) as Sketch<OpReplies['editText']>).relFile, 'index.html');
    const kill = (await s.call('tools/call', { name: 'kill_agent', arguments: { id: 'pty1' } })).result!;
    assert.equal(kill.isError, true); assert.match(kill.content[0].text, /needs-yes/); assert.match(kill.content[0].text, /call kill_agent again with confirm: true/);
    const killed = (await s.call('tools/call', { name: 'kill_agent', arguments: { id: 'pty1', confirm: true } })).result!;
    assert.equal(killed.isError, false);
  } finally { await s.end(); srv.stop(); }
});

test('agent_question reads a session\'s own question; agent_answer says what it would answer until confirm is true with the question\'s id, then answers', async () => {
  const h = fakeSessions();
  const pty1 = h.add('pty1', { ask: trustAsk() });
  h.add('pty2');
  const answered: [string, ArgsOf<'agentAnswer'>][] = [];
  const sock = path.join(tmp(), 'cli.sock');
  const srv = cliServer.start({ socketPath: sock, api: fakeApi({
    agentQuestion: (id) => h.questions.question(id),
    agentAnswer: (id, o) => { answered.push([id, o]); return h.questions.answer(id, o); },
  }) });
  await new Promise((r) => setTimeout(r, 40));
  const s = session({ RADIAL_CLI_SOCK: sock });
  try {
    const asked = (await s.call('tools/call', { name: 'agent_question', arguments: { id: 'pty1' } })).result!;
    assert.equal(asked.isError, false);
    const id = /expect: "(q[0-9a-f]{12})"/.exec(asked.content[0].text)![1];
    assert.ok(asked.content[0].text.endsWith(`\n1. No, exit (focused)\n2. Yes, I trust this folder\n\nAnswer with agent_answer { id: "pty1", answer: <its number or label>, expect: "${id}", confirm: true } once the person agrees.`), asked.content[0].text);
    assert.match(asked.content[0].text, /^pty1 is asking \(takes: option\):\nAccessing workspace:\n\/work\/site\n/);
    const idle = (await s.call('tools/call', { name: 'agent_question', arguments: { id: 'pty2' } })).result!;
    assert.equal(idle.isError, false);
    assert.match(idle.content[0].text, /^pty2 isn't asking a question of its own\. Its screen:\n\n─+\n❯\n─+\n {2}\? for shortcuts$/);
    // Without confirm, or without the question's id, nothing goes in: what it would do, and how to go ahead.
    const unconfirmed = (await s.call('tools/call', { name: 'agent_answer', arguments: { id: 'pty1', answer: '2', expect: id } })).result!;
    assert.equal(unconfirmed.isError, true);
    assert.match(unconfirmed.content[0].text, new RegExp(`^needs-yes: pty1's CLI asks:[\\s\\S]*Answering it with "Yes, I trust this folder" goes into its CLI[\\s\\S]*\\nTo go ahead: ask the person, then call agent_answer again with confirm: true and expect: "${id}"\\.$`));
    const unnamed = (await s.call('tools/call', { name: 'agent_answer', arguments: { id: 'pty1', answer: '2', confirm: true } })).result!;
    assert.equal(unnamed.isError, true);
    assert.match(unnamed.content[0].text, new RegExp(`^needs-yes: [\\s\\S]*An answer names the question it is for: pass --expect ${id}[\\s\\S]*with confirm: true and expect: "${id}"\\.$`));
    assert.deepEqual(pty1.writes, [], 'nothing typed');
    const done = (await s.call('tools/call', { name: 'agent_answer', arguments: { id: 'pty1', answer: '2', expect: id, confirm: true } })).result!;
    assert.equal(done.isError, false, done.content[0].text);
    assert.match(done.content[0].text, /^Chose "Yes, I trust this folder" \(2\) in pty1\. The question is gone: its CLI went on\.\n\nafter: gone\n\n─+\n❯\n─+\n {2}\? for shortcuts$/);
    assert.deepEqual(answered.map(([sid, o]) => [sid, o.answer, o.expect, o.yes]), [['pty1', '2', id, false], ['pty1', '2', null, true], ['pty1', '2', id, true]]);
    const prompt = (await s.call('tools/call', { name: 'agent_answer', arguments: { id: 'pty2', answer: '1', expect: id, confirm: true } })).result!;
    assert.deepEqual([prompt.isError, /^not-asking: pty2 isn't asking a question of its own/.test(prompt.content[0].text)], [true, true]);
  } finally { await s.end(); srv.stop(); }
});

test('a tool argument that is not the type its schema says is refused before it reaches the app', async () => {
  const added: ArgsOf<'commentAdd'>[] = [];
  const published: ArgsOf<'publish'>[] = [];
  const sock = path.join(tmp(), 'cli.sock');
  const srv = cliServer.start({ socketPath: sock, api: fakeApi({
    commentAdd: async (d, a) => { added.push(a); return { ok: true, comment: { id: 'c1', text: a.text } }; },
    publish: async (d, a) => { published.push(a); return { ok: true, mode: 'merge' }; },
    agentOutput: async () => ({ ok: true, id: 'pty1', alive: true, text: 'screen text' }),
  }) });
  await new Promise((r) => setTimeout(r, 40));
  const s = session({ RADIAL_CLI_SOCK: sock });
  const call = async (name: string, args: unknown) => (await s.call('tools/call', { name, arguments: args as ToolArgs })).result!; // args: what a client may send, whatever the schema says
  try {
    for (const text of [{ a: 1 }, 42, true, ['fix it']]) { // comments.json would keep any of these as the comment's text
      const r = await call('add_comment', { project: '/open/site', text });
      assert.equal(r.isError, true, JSON.stringify(text));
      assert.equal(r.content[0].text, 'bad-request: text must be a string.');
    }
    const confirm = await call('publish', { project: '/open/site', to: 'production', confirm: 'false' }); // read as a yes
    assert.equal(confirm.content[0].text, 'bad-request: confirm must be a boolean.');
    const legacy = await call('publish', { project: '/open/site', to: 'production', yes: 'true' }); // the old argument counts only as true itself
    assert.match(legacy.content[0].text, /^needs-yes: /);
    assert.equal((await call('agent_output', { id: 'pty1', lines: '5' })).content[0].text, 'bad-request: lines must be an integer.');
    assert.equal((await call('migrate_compare', { project: '/open/site', widths: [390, '768'] })).content[0].text, 'bad-request: widths must be an array of numbers.');
    assert.equal((await call('add_comment', 'fix the hero')).content[0].text, 'bad-request: arguments must be an object.');
    assert.deepEqual([added, published], [[], []], 'nothing reached the app');
    // Well-typed arguments go through; null reads as unset, as in the CLI's own requests.
    const ok = await call('add_comment', { project: '/open/site', text: 'fix the hero', route: null });
    assert.equal(ok.isError, false);
    assert.deepEqual(added, [{ text: 'fix the hero', route: '/', selector: '' }]);
  } finally { await s.end(); srv.stop(); }
});

test('--install writes the radial server into each client config, keeps other servers, and is idempotent', () => {
  const home = tmp();
  const shim = '/Applications/Radial.app/Contents/Resources/bin/radial';
  // Claude Desktop: merges into an existing config with other servers.
  const claudeFile = mcp.configPath('claude', { home, platform: 'darwin' });
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
  assert.equal(mcp.installConfig('claude', shim, { home, platform: 'darwin' }).action, 'updated');
  const claude: WrittenClientConfig = JSON.parse(fs.readFileSync(claudeFile, 'utf8')); // the file installConfig just wrote
  assert.deepEqual(claude.mcpServers.radial, { command: shim, args: ['mcp'] }); assert.equal(claude.mcpServers.other.command, 'x'); assert.equal(claude.theme, 'dark');
  assert.ok(fs.existsSync(claudeFile + '.bak-radial'), 'the previous file is kept');
  assert.equal(mcp.installConfig('claude', shim, { home, platform: 'darwin' }).action, 'already');
  // Cursor: created from nothing.
  const r = mcp.installConfig('cursor', shim, { home }); assert.equal(r.action, 'written'); assert.equal(r.path, path.join(home, '.cursor', 'mcp.json'));
  assert.equal((JSON.parse(fs.readFileSync(r.path, 'utf8')) as WrittenClientConfig).mcpServers.radial.args[0], 'mcp');
  // Codex: a TOML table appended, left alone when present.
  const codexFile = mcp.configPath('codex', { home });
  fs.mkdirSync(path.dirname(codexFile), { recursive: true }); fs.writeFileSync(codexFile, 'model = "o3"\n');
  assert.equal(mcp.installConfig('codex', shim, { home }).action, 'updated');
  const toml = fs.readFileSync(codexFile, 'utf8');
  assert.match(toml, /^model = "o3"/); assert.match(toml, /\[mcp_servers\.radial\]\ncommand = "\/Applications/);
  assert.equal(mcp.installConfig('codex', shim, { home }).action, 'already');
  // Broken JSON is an error, never clobbered.
  fs.writeFileSync(claudeFile, '{ not json');
  assert.throws(() => mcp.installConfig('claude', shim, { home, platform: 'darwin' }), /not valid JSON/);
  assert.throws(() => mcp.installConfig('vim', shim, { home }), /Unknown client/);
});

test('--install claude-code runs claude mcp add in the user scope, leaves an existing radial entry alone, and says when Claude Code is missing', () => {
  const ran: string[][] = [];
  const answers: mcp.RunResult[] = [
    { status: 0, stdout: 'Added stdio MCP server radial with command: /opt/radial/bin/radial mcp to user config\nFile modified: /home/someone/.claude.json\n', stderr: '' },
    { status: 1, stdout: '', stderr: '\x1b[31mMCP server radial already exists in user config\x1b[39m\n' },
    { status: null, stdout: '', stderr: '', error: 'spawnSync claude ENOENT' },
    { status: 1, stdout: '', stderr: 'error: unknown option --scope\n' },
  ];
  const run = (command: string, args: string[]) => { ran.push([command, ...args]); return answers.shift()!; };
  const first = mcp.installConfig('claude-code', '/opt/radial/bin/radial', { run });
  assert.deepEqual(first, { path: '/home/someone/.claude.json', action: 'written' });
  assert.deepEqual(ran[0], ['claude', 'mcp', 'add', '--scope', 'user', 'radial', '--', '/opt/radial/bin/radial', 'mcp']);
  assert.equal(mcp.installConfig('claude-code', '/opt/radial/bin/radial', { run }).action, 'already');
  assert.throws(() => mcp.installConfig('claude-code', null, { run }), /Claude Code isn't installed here \(no claude on PATH\)/);
  assert.deepEqual(ran[2].slice(-2), ['radial', 'mcp'], 'without a shim, the command is radial on PATH');
  assert.throws(() => mcp.installConfig('claude-code', null, { run }), /claude mcp add didn't work: error: unknown option --scope/);
  // --config prints the command to run, with the path quoted for the shell when it needs it.
  assert.equal(mcp.configSnippet('claude-code', '/opt/radial/bin/radial'), '# Claude Code keeps its own config: run this once (every project on this account)\nclaude mcp add --scope user radial -- /opt/radial/bin/radial mcp\n');
  assert.match(mcp.configSnippet('claude-code', '/Users/me/My Tools/radial'), /-- '\/Users\/me\/My Tools\/radial' mcp\n$/);
  assert.deepEqual([...mcp.CLIENTS], ['claude', 'claude-code', 'cursor', 'codex']);
});

test('keep_agent_awake says so when only an open Radial keeps the Mac awake (an older terminal service)', () => {
  const outdated = mcp.renderResult('agent keep', { ok: true, id: 'pty1', on: true, daemonOutdated: true });
  assert.match(outdated, /^Kept awake: pty1 is never parked/);
  assert.match(outdated, /the Mac stays awake only while Radial is open/);
  const current = mcp.renderResult('agent keep', { ok: true, id: 'pty1', on: true, daemonOutdated: false });
  assert.equal(current, process.platform === 'darwin' ? 'Kept awake: pty1 is never parked, and this Mac stays awake while it runs.' : 'Kept awake: pty1 is never parked.', 'only a Mac has a Mac to keep awake');
});

test('list_fields renders ids and values as lines a model can act on', () => {
  const text = mcp.renderResult('fields', { ok: true, route: '/', fields: [{ id: 'f1', kind: 'text', role: 'Heading', tag: 'h1', text: 'Welcome' }, { id: 'f2', kind: 'image', role: 'Image', tag: 'img', src: '/a.png', naturalW: 10, naturalH: 5 }] });
  assert.match(text, /^Route \/: 2 fields/); assert.match(text, /f1  \[Heading\] h1: "Welcome"/); assert.match(text, /f2  \[Image\] img: \/a\.png \(10×5\)/);
});

test('list_tokens renders lines with type, modes and uses; set_token reaches the server', async () => {
  const text = mcp.renderResult('tokens', { ok: true, count: 2, files: ['styles.css'], tokens: [{ name: '--brand', value: '#8665f6', type: 'color', modes: [], uses: 3, file: 'styles.css', line: 3 }, { name: '--panel', value: '#1d1d1d', type: 'color', modes: ['default', 'dark'], uses: 0, file: 'styles.css', line: 9 }] });
  assert.match(text, /^2 tokens in 1 files/); assert.match(text, /--brand: #8665f6  \[color; 3 uses; styles\.css:3\]/); assert.match(text, /--panel: #1d1d1d  \[color; modes: default, dark; unused; styles\.css:9\]/);
  const sock = path.join(tmp(), 'cli.sock');
  const calls: ArgsOf<'tokenSet'>[] = [];
  const srv = cliServer.start({ socketPath: sock, api: fakeApi({ tokenSet: async (d, a) => { calls.push(a); return { ok: true, relFile: 'styles.css', line: 3, name: a.name, to: a.value, mode: a.mode || 'default' }; } }) });
  await new Promise((r) => setTimeout(r, 40));
  const s = session({ RADIAL_CLI_SOCK: sock });
  try {
    const r = (await s.call('tools/call', { name: 'set_token', arguments: { project: '/open/site', name: '--brand', value: '#000', mode: 'dark' } })).result!;
    assert.equal(r.isError, false); assert.equal((JSON.parse(r.content[0].text) as Sketch<OpReplies['tokenSet']>).mode, 'dark'); assert.deepEqual(calls[0], { name: '--brand', value: '#000', mode: 'dark' });
  } finally { await s.end(); srv.stop(); }
});

test('a screenshot’s result carries the image too, at 1x; tools/list carries hints; initialize agrees on the client’s version and says what the server is', async () => {
  const dir = tmp();
  const png = path.join(dir, 'site-home-full@2x.png');
  fs.writeFileSync(png, encodePng({ width: 8, height: 6, data: Buffer.alloc(8 * 6 * 4, 200) }));
  const sock = path.join(dir, 'cli.sock');
  const srv = cliServer.start({ socketPath: sock, api: fakeApi({ shot: async () => ({ ok: true, path: png, scale: 2, route: '/' }) }) });
  await new Promise((r) => setTimeout(r, 40));
  const s = session({ RADIAL_CLI_SOCK: sock });
  try {
    const init = (await s.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'http-era', version: '1' } })).result! as McpResults['initialize'] & { protocolVersion: string; instructions: string };
    assert.equal(init.protocolVersion, '2025-03-26', 'a version it knows, echoed');
    assert.match(init.instructions, /confirm: true, and only after the person said yes/);
    assert.equal(((await s.call('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'old', version: '1' } })).result! as { protocolVersion: string }).protocolVersion, mcp.PROTOCOL_VERSION, 'one it doesn’t: its own');
    const tools = (await s.call('tools/list')).result!.tools as (McpTool & { annotations: { readOnlyHint: boolean; destructiveHint: boolean } })[];
    assert.deepEqual(tools.find((t) => t.name === 'kill_agent')!.annotations, { readOnlyHint: false, destructiveHint: true });
    assert.deepEqual(tools.find((t) => t.name === 'screenshot')!.annotations, { readOnlyHint: true, destructiveHint: false });
    const shot = (await s.call('tools/call', { name: 'screenshot', arguments: { project: '/open/site' } })).result! as unknown as { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError: boolean };
    assert.equal(shot.isError, false);
    assert.deepEqual(shot.content.map((c) => c.type), ['text', 'text', 'image']);
    assert.equal((JSON.parse((shot.content[0] as { text: string }).text) as { path: string }).path, png);
    assert.match((shot.content[1] as { text: string }).text, new RegExp(`^The image is the shot scaled to 4×3; the full PNG \\(8×6\\) is at ${png.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.$`));
    const image = shot.content[2] as { data: string; mimeType: string };
    assert.equal(image.mimeType, 'image/png');
    const decoded = Buffer.from(image.data, 'base64');
    assert.deepEqual([decoded.readUInt32BE(16), decoded.readUInt32BE(20)], [4, 3], 'a 2x shot comes back at 1x');
  } finally { await s.end(); srv.stop(); }
});

test('a refusal that says how to fix it and what to run instead carries both commands to the model', () => {
  const text = mcp.renderResult('shot', { ok: false, code: 'no-browser', error: 'This Radial has no browser for its projects\' pages yet (radial serve), so it can\'t take screenshots.', repoDir: '/site', fix: 'radial browser install', instead: 'radial url /site' });
  assert.equal(text, 'no-browser: This Radial has no browser for its projects\' pages yet (radial serve), so it can\'t take screenshots.\nFix: radial browser install\nInstead: radial url /site');
});
