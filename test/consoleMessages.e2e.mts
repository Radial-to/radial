// The window's warnings and errors reach the main process's log (main.ts's
// console-message listener, which reads Electron's event object: the positional
// arguments are deprecated since Electron 35), and the app boots without any
// Electron deprecation warning on stderr. The app is started directly, not
// through Playwright's launcher, so the test reads its output from the first
// line; Playwright attaches over the DevTools port only to log in the window.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { appEnv } from './support/app.ts';

/** The Home agent: renderer.ts declares it once its scripts have run. */
declare const homeTab: object | undefined;

async function until<T>(label: string, fn: () => T | Promise<T>, ms = 30000): Promise<NonNullable<T>> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('window warnings and errors reach the main log, and booting prints no Electron deprecation warning', { timeout: 90000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-console-'));
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const packaged = process.env.RADIAL_APP_PATH;
  const bin = packaged || path.join(process.cwd(), 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  // The DevTools switch goes before the app path, where main.ts expects launcher flags.
  const app = spawn(bin, ['--remote-debugging-port=0', ...(packaged ? [] : ['.'])], {
    env: appEnv({ ...process.env, RADIAL_USERDATA: scratch, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' }), // in the background, as every suite's app (support/app.ts)
  });
  let stdout = '', stderr = '';
  app.stdout.on('data', (chunk) => { stdout += chunk; });
  app.stderr.on('data', (chunk) => { stderr += chunk; });
  let browser: Browser | null = null;
  try {
    const endpoint = await until('the DevTools endpoint', () => /DevTools listening on (ws:\/\/\S+)/.exec(stderr)?.[1]);
    browser = await chromium.connectOverCDP(endpoint);
    const page = await until('the app window', () => browser!.contexts().flatMap((context) => context.pages()).find((p) => p.url().endsWith('/renderer/index.html')));
    await page.waitForFunction(() => typeof homeTab !== 'undefined', null, { timeout: 30000 });
    await page.evaluate(() => {
      console.log('radial-console-probe info');
      console.warn('radial-console-probe warning');
      console.error('radial-console-probe error');
    });
    await until('the warning and the error in the main log', () => stdout.includes('[renderer] radial-console-probe warning (') && stdout.includes('[renderer] radial-console-probe error ('));
    assert.match(stdout, /\[renderer\] radial-console-probe warning \([^)]*:\d+\)/, 'the line names where it was logged');
    assert.ok(!stdout.includes('radial-console-probe info'), 'info-level messages stay out of the log');
    const deprecations = stderr.split('\n').filter((line) => line.includes('(electron)'));
    assert.deepEqual(deprecations, [], 'Electron printed deprecation warnings');
  } finally {
    try { await browser?.close(); } catch {}
    app.kill();
    await new Promise((resolve) => { if (app.exitCode !== null || app.signalCode !== null) resolve(null); else app.once('exit', resolve); });
    // The app's helper processes can still be writing to its folder for a moment after it exits.
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
