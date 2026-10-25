// radial serve's usage events (src/headless/usage.ts): sent only by the
// official package (a key), off with CI or DO_NOT_TRACK, `radial telemetry
// on | off | status` per data dir, and a one-time note the first time a
// serve that sends starts. Nothing here sends: the key is a stand-in and no
// client is made (test/telemetry.test.ts covers capture itself).

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as usage from '../src/headless/usage';
import * as cli from '../src/main/cli';
import type { CliIo } from '../src/main/cli';
import { tmpDir } from './support/tmp';

/** An official package's environment: the key, a data dir of its own, nothing that turns events off. */
const official = (dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ RADIAL_POSTHOG_KEY: 'phc_stand_in', RADIAL_DATA_DIR: dataDir, ...extra });
/** A CLI io that keeps what's written. */
function io(env: NodeJS.ProcessEnv): CliIo & { out(): string; err(): string } {
  let out = '', err = '';
  return { stdout: { write: (t: string) => { out += t; } }, stderr: { write: (t: string) => { err += t; } }, env, cwd: '/', isTTY: false, connect: () => Promise.reject(new Error('no socket in this test')), launch: () => {}, out: () => out, err: () => err };
}

test('state: sent only with a key, and never with CI, DO_NOT_TRACK, a throwaway data dir, or switched off', () => {
  const dir = tmpDir('radial-usage-');
  assert.deepEqual(usage.state(dir, { RADIAL_DATA_DIR: dir }), { on: false, why: 'source' }, 'a build from source has no key');
  assert.deepEqual(usage.state(dir, official(dir)), { on: true });
  assert.deepEqual(usage.state(dir, official(dir, { CI: 'true' })), { on: false, why: 'CI' });
  assert.deepEqual(usage.state(dir, official(dir, { DO_NOT_TRACK: '1' })), { on: false, why: 'DO_NOT_TRACK' });
  assert.deepEqual(usage.state(dir, official(dir, { RADIAL_USERDATA: dir })), { on: false, why: 'throwaway' });
  fs.writeFileSync(path.join(dir, 'radial-telemetry.json'), JSON.stringify({ enabled: false }));
  assert.deepEqual(usage.state(dir, official(dir)), { on: false, why: 'off' });
});

test('the one-time note: what is sent, how to turn it off, where the list is; once, and only where events are sent', () => {
  const dir = tmpDir('radial-usage-note-');
  assert.equal(usage.notice(dir, { RADIAL_DATA_DIR: dir }), null, 'nothing to say where nothing is sent');
  assert.equal(usage.notice(dir, official(dir, { DO_NOT_TRACK: '1' })), null);
  assert.equal(fs.existsSync(path.join(dir, 'radial-telemetry.json')), false, 'and nothing written');
  const note = usage.notice(dir, official(dir))!;
  assert.match(note, /^Radial sends anonymous usage events: which commands and features ran, .*Never content: no files, page text, prompts, paths, project names, addresses or tokens\.\n/);
  assert.match(note, /and errors in Radial's own code \(what kind, and where in its code\)/, 'it says errors are sent too');
  assert.ok(note.includes('https://radial.to/docs/usage-data'));
  assert.ok(note.includes(path.join(dir, 'telemetry-log.jsonl')), 'where every event sent is written');
  assert.match(note, /\nTo turn it off: radial telemetry off, or set DO_NOT_TRACK=1\.$/);
  assert.ok(!/—| \/ /.test(note), 'no em dashes or slash separators');
  assert.equal(usage.notice(dir, official(dir)), null, 'once');
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'radial-telemetry.json'), 'utf8')) as { distinctId: string | null; noticeShown: boolean };
  assert.deepEqual([settings.noticeShown, settings.distinctId], [true, null], 'remembered, with no install ID minted by the note');
});

test('radial telemetry status, off and on, per data dir; --json; and a Mac app’s user is pointed at Settings', async () => {
  const dir = tmpDir('radial-usage-cmd-');
  const status = io(official(dir));
  assert.equal(await cli.main(['telemetry'], { ...status, env: { ...status.env, RADIAL_CLI_FLAVOR: 'headless' } }), 0);
  assert.match(status.out(), /^Usage events are on\.\nWhat's sent: anonymous usage events/);
  assert.match(status.out(), /\nTo turn it off: radial telemetry off, or set DO_NOT_TRACK=1\.\n$/);
  const off = io({ ...official(dir), RADIAL_CLI_FLAVOR: 'headless' });
  assert.equal(await cli.main(['telemetry', 'off'], off), 0);
  assert.match(off.out(), /^Usage events are off for this data dir\. Nothing is sent, not even that you turned them off\.\n/);
  assert.match(off.out(), /\nTo turn it on: radial telemetry on\.\n$/);
  assert.equal(usage.notice(dir, official(dir)), null, 'turning it off also means no note later');
  const json = io({ ...official(dir), RADIAL_CLI_FLAVOR: 'headless' });
  assert.equal(await cli.main(['telemetry', 'status', '--json'], json), 0);
  const r = JSON.parse(json.out()) as { ok: boolean; on: boolean; why: string; enabled: boolean; log: string };
  assert.deepEqual([r.ok, r.on, r.why, r.enabled, r.log], [true, false, 'off', false, path.join(dir, 'telemetry-log.jsonl')]);
  const on = io({ ...official(dir, { CI: 'true' }), RADIAL_CLI_FLAVOR: 'headless' });
  assert.equal(await cli.main(['telemetry', 'on'], on), 0);
  assert.match(on.out(), /^Usage events are switched on for this data dir, but nothing is sent here\. Off while CI is set in the environment\.\n/);
  const source = io({ RADIAL_DATA_DIR: dir, RADIAL_CLI_FLAVOR: 'headless' });
  assert.equal(await cli.main(['telemetry'], source), 0);
  assert.match(source.out(), /^Usage events are off\. This copy of Radial was built from source, so it has no key and sends nothing\.\n/);
  const bad = io({ RADIAL_DATA_DIR: dir, RADIAL_CLI_FLAVOR: 'headless' });
  assert.equal(await cli.main(['telemetry', 'maybe'], bad), 2);
  assert.match(bad.err(), /Unknown telemetry command: maybe/);
  const mac = io({ RADIAL_CLI_FLAVOR: 'packaged' });
  assert.equal(await cli.main(['telemetry', 'off'], mac), 0);
  assert.match(mac.out(), /^Radial for Mac keeps its usage switch in Settings\./);
});
