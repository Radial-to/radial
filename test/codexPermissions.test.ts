import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CodexApprovalPolicy, CodexConfigRead, CodexPolicy, NativeChatTransport, NativeChatTransportOptions } from '../src/main/nativeChat';
import type { ChatEngine, CodexSandboxPolicy, PermissionMode } from '../src/shared/chatPermissions';
import type { ChatSession } from '../src/shared/radialApi';
import type { FakeTransport, SavedChat, SentRequest } from './support/nativeChat';
import { tmpDir } from './support/tmp';
const fs = require('fs') as typeof import('fs'), os = require('os') as typeof import('os'), path = require('path') as typeof import('path');
const { NativeChat } = require('../src/main/nativeChat') as typeof import('../src/main/nativeChat');
const permissions = require('../src/shared/chatPermissions') as typeof import('../src/shared/chatPermissions');
/** The user's Codex config as config/read reports it. */
type CodexConfig = NonNullable<CodexConfigRead['config']>;
/** The double, a stand-in for a Codex chat's CLI that can share its terminal view (endpoint, bin): request answers config/read with the config and records the rest, and it keeps the options it was made with. */
type CodexDouble = FakeTransport<'initialize' | 'close' | 'endpoint' | 'bin'> & { options: NativeChatTransportOptions };
/** A workspace-write sandbox, the one a config's sandbox_workspace_write shapes. */
type WorkspaceWrite = Extract<CodexSandboxPolicy, { type: 'workspaceWrite' }>;

// A Codex app-server double: config/read answers with `config`; other requests are recorded.
function codexChat(dir: string, config: CodexConfig, file = path.join(dir, 'chats.json')) {
  const calls: SentRequest[] = [], transports: CodexDouble[] = [];
  const chat = new NativeChat({ file, context: () => '', emit: () => {}, transport: options => {
    const t: CodexDouble = { options, endpoint: 'unix:///test', bin: 'codex', initialize: async () => {}, close() {}, request: async (method, params) => {
      if (method === 'config/read') return { config };
      calls.push({ method, params });
      return method.startsWith('thread/') ? { thread: { id: 'thread-1' } } : { turn: { id: 'turn-' + calls.length } };
    } };
    transports.push(t); return t as NativeChatTransport; // the double, which answers what NativeChat asks of a Codex chat
  } });
  return { chat, calls, transports };
}
const yolo: CodexConfig = { approval_policy: 'never', sandbox_mode: 'danger-full-access' };
const done = (chat: InstanceType<typeof NativeChat>, s: ChatSession) => chat.event(s, { method: 'turn/completed', params: { turn: {} } });

test('Codex chats use the machine’s Codex settings until the chat picks its own', async t => {
  const dir = tmpDir('radial-codex-settings-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { chat, calls } = codexChat(dir, yolo); t.after(() => chat.close());
  assert.equal(permissions.defaultMode('codex'), 'cli');
  assert.deepEqual(permissions.args('codex'), [], 'no permission flags override Codex');
  const s = chat.create(dir);
  await chat.send(s.id, 'Ship it');
  const start = calls.find(c => c.method === 'thread/start')!, turn = calls.find(c => c.method === 'turn/start')!; // send started both
  assert.equal(start.params.sandbox, 'danger-full-access'); assert.equal(start.params.approvalPolicy, 'never');
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'dangerFullAccess' }); assert.equal(turn.params.approvalPolicy, 'never');
  chat.event(s, { method: 'thread/settings/updated', params: { threadSettings: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } } });
  assert.ok(permissions.inherits('codex', s.permissionMode), 'Codex reporting the inherited policy back is not a new choice');
  done(chat, s);
  await chat.update(s.id, { permissionMode: 'workspace' });
  await chat.send(s.id, 'Careful now');
  assert.equal(calls.at(-1)!.params.sandboxPolicy!.type, 'workspaceWrite'); assert.equal(calls.at(-1)!.params.approvalPolicy, 'on-request'); // the turn just sent, with its policy
  done(chat, s);
  await chat.update(s.id, { permissionMode: 'cli' });
  await chat.send(s.id, 'Back to my settings');
  assert.equal(calls.at(-1)!.params.sandboxPolicy!.type, 'dangerFullAccess', 'switching back applies on the next turn of the same thread');
  assert.equal(calls.filter(c => c.method.startsWith('thread/')).length, 1);
  chat.event(s, { method: 'thread/settings/updated', params: { threadSettings: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } } } });
  assert.equal(s.permissionMode, 'read-only', 'a different policy chosen in the terminal still updates the chat');
  assert.throws(() => permissions.validate('codex', 'default'), /not supported/);
});

test('without Codex permission settings Radial keeps workspace access; profiles and partial settings count', async t => {
  const cases: [CodexConfig, CodexPolicy['sandbox'], CodexApprovalPolicy][] = [
    [{}, 'workspace-write', 'on-request'],
    [{ profile: 'yolo', profiles: { yolo } }, 'danger-full-access', 'never'],
    [{ sandbox_mode: 'read-only' }, 'read-only', 'on-request'],
    [{ approval_policy: 'untrusted', sandbox_workspace_write: { network_access: true, writable_roots: ['/tmp/shared'] } }, 'workspace-write', 'untrusted'],
  ];
  for (const [config, sandbox, approvalPolicy] of cases) {
    const dir = tmpDir('radial-codex-defaults-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { chat, calls } = codexChat(dir, config); t.after(() => chat.close());
    const s = chat.create(dir);
    await chat.send(s.id, 'Hello');
    const start = calls.find(c => c.method === 'thread/start')!, turn = calls.find(c => c.method === 'turn/start')!; // send started both
    assert.equal(start.params.sandbox, sandbox, JSON.stringify(config)); assert.equal(start.params.approvalPolicy, approvalPolicy, JSON.stringify(config));
    assert.equal(turn.params.approvalPolicy, approvalPolicy);
    if (config.sandbox_workspace_write) assert.deepEqual([(turn.params.sandboxPolicy as WorkspaceWrite).networkAccess, (turn.params.sandboxPolicy as WorkspaceWrite).writableRoots], [true, ['/tmp/shared']]); // this config's sandbox is workspace-write
  }
});

test('a Codex config that sets nothing, reported as nulls, still gets workspace access and keeps Codex settings', async t => {
  // codex-cli 0.160.1 answers config/read with null for every permission field the config leaves unset.
  const unset: CodexConfig = { approval_policy: null, sandbox_mode: null, sandbox_workspace_write: null, profile: null };
  const dir = tmpDir('radial-codex-nulls-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { chat, calls } = codexChat(dir, unset); t.after(() => chat.close());
  const s = chat.create(dir);
  await chat.send(s.id, 'Hello');
  const start = calls.find(c => c.method === 'thread/start')!, turn = calls.find(c => c.method === 'turn/start')!; // send started both
  assert.equal(start.params.sandbox, 'workspace-write'); assert.equal(start.params.approvalPolicy, 'on-request', 'an unset approval policy gets Radial’s, as with {}');
  assert.equal(turn.params.sandboxPolicy!.type, 'workspaceWrite'); assert.equal(turn.params.approvalPolicy, 'on-request');
  chat.event(s, { method: 'thread/settings/updated', params: { threadSettings: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } } } });
  assert.ok(permissions.inherits('codex', s.permissionMode), 'Codex reporting the policy Radial filled in is not a new choice');
});

test('saved Codex chats without a real choice move to Codex settings; explicit choices and other providers stay', t => {
  const dir = tmpDir('radial-codex-migrate-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'chats.json');
  const saved = (id: string, engine: ChatEngine, permissionMode?: PermissionMode): SavedChat => ({ id, engine, ...(permissionMode ? { permissionMode } : {}), repoDir: dir, home: false, title: id, messages: [], state: 'idle' });
  fs.writeFileSync(file, JSON.stringify([saved('echoed', 'codex', 'default'), saved('unset', 'codex'), saved('full', 'codex', 'full'), saved('read-only', 'codex', 'read-only'), saved('claude', 'claude', 'default')]));
  const { chat } = codexChat(dir, yolo, file); t.after(() => chat.close());
  assert.deepEqual(['echoed', 'unset', 'full', 'read-only', 'claude'].map(id => chat.get(id).permissionMode), ['cli', 'cli', 'full', 'read-only', 'default']);
});

test('a Terminal-made Codex thread gets the machine’s settings, not the terminal’s own guess', async t => {
  const dir = tmpDir('radial-codex-terminal-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { chat, transports } = codexChat(dir, yolo); t.after(() => chat.close());
  const s = chat.create(dir);
  await chat.connect(s, true);
  const params = transports[0].options.terminalParams!('thread/start', { cwd: dir, sandbox: 'read-only', approvalPolicy: 'on-request' })!; // connect gives the transport its terminalParams, which answers the params it's given, rewritten
  assert.deepEqual([params.sandbox, params.approvalPolicy, params.cwd], ['danger-full-access', 'never', dir]);
});
