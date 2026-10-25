// Signing in to GitHub from the app (tools:ghAuth): Radial drives
// `gh auth login --web` in a terminal of its own, copies the one-time code and
// shows it in the window. Stand-ins play gh (found first on the login shell's
// PATH, which Radial asks the user's shell for) and the clipboard (the real one
// is the user's). Electron 44's clipboard.writeText returns a promise, so a
// copy that fails rejects instead of throwing: it must not reach main's
// unhandledRejection reporter as an app error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

declare const window: Window & typeof globalThis & { radial: RadialApi };
/** The main process's global that the clipboard stand-in records into. */
type MainGlobals = typeof globalThis & { copied: string[] };

test('GitHub sign-in shows the one-time code, and a copy that fails is no app error', { timeout: 90000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-gh-signin-'));
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  // gh's device flow, as `gh auth login --web` prints it; Enter finishes it.
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    'if [ "$1" = auth ] && [ "$2" = login ]; then',
    "  printf '! First copy your one-time code: ABCD-1234\\n'",
    "  printf 'Press Enter to open https://github.com/login/device in your browser... '",
    '  read answer',
    "  printf '\\nLogged in as radial-test\\n'",
    'fi',
    'exit 0',
  ].join('\n') + '\n', { mode: 0o755 });
  // The login shell Radial asks for its PATH (src/main/env.ts): the stand-in's folder first.
  fs.writeFileSync(path.join(scratch, 'shell'), `#!/bin/sh\nprintf '%s' "__RADIAL_PATH__${bin}:/usr/bin:/bin__RADIAL_PATH__"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const app = await launchApp({
    executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'),
    args: process.env.RADIAL_APP_PATH ? [] : ['.'],
    env: { ...process.env, SHELL: path.join(scratch, 'shell'), RADIAL_USERDATA: scratch, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' },
  });
  try {
    const win = await app.firstWindow();
    await win.waitForFunction(() => typeof window.radial?.toolsGhAuth === 'function');
    await app.evaluate(({ clipboard }) => {
      (globalThis as MainGlobals).copied = [];
      clipboard.writeText = async (text: string) => { (globalThis as MainGlobals).copied.push(text); throw new Error('clipboard busy'); };
    });
    const shown = win.evaluate(() => new Promise((resolve) => window.radial.onGhCode(resolve)));
    assert.deepEqual(await win.evaluate(() => window.radial.toolsGhAuth()), { ok: true });
    assert.deepEqual(await shown, { code: 'ABCD-1234', url: 'https://github.com/login/device' }, 'the window shows the code');
    assert.deepEqual(await app.evaluate(() => (globalThis as MainGlobals).copied), ['ABCD-1234'], 'the code went to the clipboard');
    await new Promise((resolve) => setTimeout(resolve, 500)); // an unhandled rejection is reported a turn later
    const log = path.join(scratch, 'error-log.jsonl');
    const reported = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    assert.ok(!reported.includes('clipboard busy'), `the failed copy became an app error: ${reported}`);
  } finally {
    await app.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
