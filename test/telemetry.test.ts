// Unit tests for anonymous usage stats. Run from platform/:
//   node --test test/telemetry.test.js
//
// The PostHog client is injected via init's makeClient so every test observes
// exact payloads offline. The contract under test is the public promise:
// allowlisted event names only, allowlisted primitive props only, a random
// install UUID, a local audit log of everything sent, and an off switch that
// stops sending entirely.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import type { TelemetryClient, TelemetryEvent, TelemetryInitOptions, TelemetryProps } from '../src/main/telemetry';
import { tmpDir } from './support/tmp';

/** What telemetry.capture hands the client: always with properties (the base ones plus the allowlisted ones). */
type SentEvent = Omit<Parameters<TelemetryClient['capture']>[0], 'properties'> & { properties: Record<string, string | number | boolean | null> };
/** radial-telemetry.json once init has run, which always mints the install ID (telemetry.ts's TelemetryStore, not exported, is null before that). */
type StoreFile = { enabled: boolean; distinctId: string };
/** A telemetry-log.jsonl line as capture() writes it: { ts, event, ...base, ...allowlisted props }. */
type LogLine = { ts: string; event: TelemetryEvent; app_version: string | null; os_version: string | null } & TelemetryProps;

process.env.RADIAL_POSTHOG_KEY = 'phc_test'; // module gates client creation on a key
const telemetry = require('../src/main/telemetry') as typeof import('../src/main/telemetry');

let dir: string | null = null;
let sent: SentEvent[] | null = null;
const makeClient = (): TelemetryClient => ({ capture: (p) => sent!.push(p as SentEvent), shutdown: async () => {} });

beforeEach(() => {
  dir = tmpDir('radial-tm-');
  sent = [];
});

const initOpts = (extra: TelemetryInitOptions = {}): TelemetryInitOptions => ({ appVersion: '9.9.9', osVersion: '15.0', sendAllowed: true, makeClient, ...extra });

test('init mints a stable random install ID', () => {
  telemetry.init(dir!, initOpts());
  const first: StoreFile = JSON.parse(fs.readFileSync(path.join(dir!, 'radial-telemetry.json'), 'utf8'));
  assert.match(first.distinctId, /^[0-9a-f-]{36}$/);
  telemetry.init(dir!, initOpts());
  const second: StoreFile = JSON.parse(fs.readFileSync(path.join(dir!, 'radial-telemetry.json'), 'utf8'));
  assert.equal(second.distinctId, first.distinctId);
});

test('capture sends allowlisted events with base props and anonymous processing', () => {
  telemetry.init(dir!, initOpts());
  telemetry.capture('agent_session_started', { provider: 'claude' });
  assert.equal(sent!.length, 1);
  assert.equal(sent![0].event, 'agent_session_started');
  assert.equal(sent![0].properties.app_version, '9.9.9');
  assert.equal(sent![0].properties.provider, 'claude');
  assert.equal(sent![0].properties.$process_person_profile, false);
  assert.equal(sent![0].disableGeoip, true);
});

test('unknown events and non-allowlisted props are dropped', () => {
  telemetry.init(dir!, initOpts());
  // @ts-expect-error -- not an event on purpose: capture's EVENTS check drops it.
  telemetry.capture('made_up_event', {});
  assert.equal(sent!.length, 0);
  // @ts-expect-error -- repoDir and nested on purpose: capture's ALLOWED_PROPS filter drops them.
  telemetry.capture('project_opened', { repoDir: '/Users/you/clients/law-firm', provider: 'claude', nested: { a: 1 } });
  assert.equal(sent!.length, 1);
  assert.equal(sent![0].properties.repoDir, undefined);
  assert.equal(sent![0].properties.nested, undefined);
  assert.equal(sent![0].properties.provider, 'claude');
});

test('every sent event lands in the local audit log', () => {
  telemetry.init(dir!, initOpts());
  telemetry.capture('project_created', { template: 'starter' });
  const lines = fs.readFileSync(path.join(dir!, 'telemetry-log.jsonl'), 'utf8').trim().split('\n');
  const logged: LogLine = JSON.parse(lines.at(-1)!);
  assert.equal(logged.event, 'project_created');
  assert.equal(logged.template, 'starter');
  assert.ok(logged.ts);
});

test('the off switch stops sending and logging, and persists', () => {
  telemetry.init(dir!, initOpts());
  telemetry.setEnabled(false);
  telemetry.capture('app_opened');
  assert.equal(sent!.length, 0);
  assert.ok(!fs.existsSync(path.join(dir!, 'telemetry-log.jsonl')));
  // Off survives a restart, and no "it was turned off" event ever fires.
  telemetry.init(dir!, initOpts());
  assert.equal(telemetry.isEnabled(), false);
  assert.equal(sent!.length, 0);
  telemetry.setEnabled(true);
  telemetry.capture('app_opened');
  assert.equal(sent!.length, 1);
});

test('every event carries the app\'s, macOS\'s and (in the Mac app) Electron\'s versions the same way; radial serve has no Electron', () => {
  telemetry.init(dir!, initOpts({ osVersion: '27.0.0', electronVersion: '44.9.0' }));
  telemetry.capture('app_opened');
  telemetry.capture('app_error', { surface: 'renderer', error_name: 'TypeError', where: 'src/renderer/renderer.ts:1670 (showEmpty)' });
  for (const e of sent!) assert.deepEqual([e.properties.app_version, e.properties.os_version, e.properties.electron_version], ['9.9.9', '27.0.0', '44.9.0'], e.event);
  telemetry.init(dir!, initOpts({ osVersion: 'Linux 6.8.0', electronVersion: null }));
  telemetry.capture('serve_started', { listen: false, remote: false });
  assert.equal('electron_version' in sent!.at(-1)!.properties, false);
});

test('app_error carries what it was, where, a system error\'s code, and for a process that went away its reason, exit code and counts', () => {
  telemetry.init(dir!, initOpts());
  telemetry.capture('app_error', { surface: 'main', error_name: 'Error', where: 'node:net', error_code: 'ECONNREFUSED' });
  telemetry.capture('app_error', { surface: 'renderer', error_name: 'render-process-gone/crashed', where: 'none', reason: 'crashed', exit_code: 11, process_type: 'GPU', memory_mb: 812, uptime_min: 95, webviews: 2, terminals: 3 });
  assert.equal(sent![0].properties.error_code, 'ECONNREFUSED');
  for (const key of ['reason', 'exit_code', 'process_type', 'memory_mb', 'uptime_min', 'webviews', 'terminals'] as const) assert.notEqual(sent![1].properties[key], undefined, key);
});

test('sendAllowed=false (dev / e2e) never creates a client', () => {
  telemetry.init(dir!, initOpts({ sendAllowed: false }));
  telemetry.capture('app_opened');
  assert.equal(sent!.length, 0);
});

test('dev-server memory restarts and stops are in the vocabulary, with no properties', () => {
  telemetry.init(dir!, initOpts());
  telemetry.capture('dev_server_memory_restarted');
  telemetry.capture('dev_server_memory_stopped');
  assert.deepEqual(sent!.map((e) => e.event), ['dev_server_memory_restarted', 'dev_server_memory_stopped']);
  assert.deepEqual(Object.keys(sent![0].properties).sort(), ['$process_person_profile', 'app_version', 'os_version']);
});

test('adjust events are in the vocabulary and carry only the tweak count', () => {
  telemetry.init(dir!, initOpts());
  // @ts-expect-error -- selector and value on purpose: capture's ALLOWED_PROPS filter drops them.
  telemetry.capture('adjust_applied', { tweaks: 3, selector: 'div.hero', value: '24px' });
  telemetry.capture('adjust_undo');
  assert.equal(sent!.length, 2);
  assert.equal(sent![0].event, 'adjust_applied');
  assert.equal(sent![0].properties.tweaks, 3);
  assert.equal(sent![0].properties.selector, undefined, 'selectors are content and never pass');
  assert.equal(sent![0].properties.value, undefined, 'style values are content and never pass');
  assert.equal(sent![1].event, 'adjust_undo');
});

test('radial serve’s start is counted with booleans only: whether it listens, and beyond this machine', () => {
  telemetry.init(dir!, initOpts());
  // @ts-expect-error -- address and token on purpose: capture's ALLOWED_PROPS filter drops them.
  telemetry.capture('serve_started', { listen: true, remote: false, address: '0.0.0.0:4000', token: 'rcore_x' });
  assert.deepEqual(sent!.map((e) => [e.event, e.properties.listen, e.properties.remote, e.properties.address, e.properties.token]), [['serve_started', true, false, undefined, undefined]]);
});

test('CI and DO_NOT_TRACK turn radial serve’s events off; a throwaway data dir does too, unless forced', () => {
  assert.equal(telemetry.envOptOut({}), null);
  assert.equal(telemetry.envOptOut({ CI: 'true' }), 'CI');
  assert.equal(telemetry.envOptOut({ CI: '1' }), 'CI');
  assert.equal(telemetry.envOptOut({ CI: 'false' }), null, 'CI=false means no');
  assert.equal(telemetry.envOptOut({ DO_NOT_TRACK: '1', CI: 'true' }), 'DO_NOT_TRACK');
  assert.equal(telemetry.envOptOut({ DO_NOT_TRACK: '0' }), null);
  assert.equal(telemetry.sendAllowedFor('headless', {}), true);
  assert.equal(telemetry.sendAllowedFor('headless', { CI: 'true' }), false);
  assert.equal(telemetry.sendAllowedFor('headless', { DO_NOT_TRACK: '1', RADIAL_TELEMETRY_FORCE: '1' }), false, 'forcing never beats DO_NOT_TRACK');
  assert.equal(telemetry.sendAllowedFor('headless', { RADIAL_USERDATA: '/tmp/x' }), false);
  assert.equal(telemetry.sendAllowedFor('headless', { RADIAL_USERDATA: '/tmp/x', RADIAL_TELEMETRY_FORCE: '1' }), true);
  // The Mac app is as it was: installed ones send, dev and throwaway ones don't, CI isn't its business.
  assert.equal(telemetry.sendAllowedFor('packaged', { CI: 'true' }), true);
  assert.equal(telemetry.sendAllowedFor('dev', {}), false);
  assert.equal(telemetry.sendAllowedFor('packaged', { RADIAL_USERDATA: '/tmp/x' }), false);
  assert.equal(telemetry.keyFor({ RADIAL_POSTHOG_KEY: 'phc_from_env' }), 'phc_from_env');
});

test('settings read and written by another command never mint an install ID, and a running process stops at its next event', () => {
  const other = tmpDir('radial-tm-settings-');
  assert.deepEqual(telemetry.readSettings(other), { enabled: true, distinctId: null }, 'on unless switched off');
  assert.equal(fs.existsSync(path.join(other, 'radial-telemetry.json')), false, 'reading writes nothing');
  telemetry.writeSettings(other, { enabled: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(other, 'radial-telemetry.json'), 'utf8')), { enabled: false, distinctId: null });
  // A running serve (init) sends; `radial telemetry off` from another process stops its next event, and on starts it again.
  telemetry.init(dir!, initOpts());
  telemetry.capture('cli_command', { command: 'ls' });
  const file = path.join(dir!, 'radial-telemetry.json');
  const before: StoreFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...before, enabled: false }));
  const later = new Date(Date.now() + 5000); fs.utimesSync(file, later, later); // another process's write, seen by its mtime
  telemetry.capture('cli_command', { command: 'open' });
  assert.deepEqual(sent!.map((e) => e.properties.command), ['ls'], 'off took effect without a restart');
  telemetry.writeSettings(dir!, { enabled: true });
  telemetry.capture('cli_command', { command: 'url' });
  assert.deepEqual(sent!.map((e) => e.properties.command), ['ls', 'url']);
  assert.equal(sent![1].distinctId, before.distinctId, 'the same install ID throughout');
});
