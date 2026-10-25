// test/fixtures/native-interactive.cjs, the native CLI most desktop e2e suites
// type into (Claude Code's and Cursor Agent's stand-in), in a real PTY. It must
// take in what Radial pastes the way a real CLI does: at once. A Cursor chat's
// first message carries the project's context too (3 to 6 KB), and a stand-in
// that saved its state once per character took 8 s to take one in during a full
// parallel e2e run, most of the 10 s the suites wait for its answer
// (chatFullAccess, chatProviderPicker).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { tmpDir } from './support/tmp';

const FIXTURE = path.join(__dirname, 'fixtures', 'native-interactive.cjs');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('the native CLI stand-in takes in a long paste with a few saves of its state, not one per character', async () => {
  const dir = tmpDir('radial-native-fixture-');
  // Counts its saves from outside it: each one ends in a rename onto its .state.json.
  const count = path.join(dir, 'saves');
  const hook = path.join(dir, 'count-saves.cjs');
  fs.writeFileSync(hook, `const fs = require('fs'); const rename = fs.renameSync; let n = 0;
fs.renameSync = (from, to) => { rename(from, to); if (String(to).endsWith('.state.json')) fs.writeFileSync(${JSON.stringify(count)}, String(++n)); };
`);
  const id = randomUUID();
  const cli = pty.spawn(process.execPath, ['--require', hook, FIXTURE, '--resume', id], { // no --settings: Cursor Agent
    cwd: dir, cols: 80, rows: 24,
    env: { ...process.env, RADIAL_USERDATA: dir, CURSOR_CONFIG_DIR: path.join(dir, 'cursor'), RADIAL_NATIVE_FIXTURE_AUTOFINISH: '1' },
  });
  let screen = '';
  cli.onData((data) => { screen += data; });
  const until = async (what: string, ok: () => boolean) => { for (let i = 0; i < 800 && !ok(); i++) await delay(25); assert.ok(ok(), `timed out waiting for ${what}`); };
  try {
    await until('its prompt', () => screen.includes('→ Add a follow-up'));
    const before = Number(fs.readFileSync(count, 'utf8'));
    const text = 'Inspect the project\n\n' + 'Context Radial adds to the first message. '.repeat(146); // about 6 KB, a project's
    cli.write('\x1b[200~' + text + '\x1b[201~'); // as the chat delivers it (chat/interactive.ts deliver)
    await delay(100);
    cli.write('\r');
    await until('its answer', () => screen.includes('Cursor received the draft.'));
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'native-fixture', `${id}.state.json`), 'utf8')) as { prompts: string[] };
    assert.deepEqual(state.prompts, [text], 'the whole paste, as one message');
    const saves = Number(fs.readFileSync(count, 'utf8')) - before;
    assert.ok(saves <= 20, `${saves} saves for a paste of ${text.length} characters`);
  } finally { cli.kill(); }
});
