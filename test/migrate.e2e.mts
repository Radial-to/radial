// Site migration end to end through bin/radial (plans/site-migration.md): capture a
// "live" site served locally, then compare it with a local copy running in Radial's
// own preview. Identical pages compare clean; a changed heading shows up as a band.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MigrateFramework, RadialApi } from '../src/shared/radialApi.ts';
import type { OpReplies } from '../src/main/cliServer.ts';
import type { CompareRow } from '../src/main/migrate/index.ts';
import { launchApp } from './support/app.ts';

// What the app's window has that this test reaches inside page.evaluate:
// window scripts' top-level declarations (src/renderer/types.d.ts and
// renderer.ts have the full types).
// They are declared as always there; the boot poll still guards them, because
// firstWindow() can resolve before the window's scripts have run.
declare const homeTab: { repoDir: string | null };
declare function agentTab(): { id: string } | null;
declare function homeOpenCreate(tab: 'template' | 'github' | 'folder' | 'migrate'): void;
declare const mg: { framework: MigrateFramework | null };
declare const window: Window & { radial: RadialApi };
/** The main process's global that the stubbed shell.openExternal records into. */
type MainGlobals = typeof globalThis & { openedExternally: string[] };
/**
 * One `bin/radial … --json` run: the exit code (or the spawn error's), the
 * object it printed and its output. cli.ts prints the op's whole reply
 * (OpReplies), or `{ ok: false, code, error }` when the exit code isn't 0.
 */
interface CliRun<T> { code: number | string; json: T | null; stderr: string; stdout: string }
/**
 * migrate compare's reply when every row compared (no row with an error).
 * compareSite also writes `{ route, width, error }` rows and still exits 0;
 * this test assumes none, and one would fail the changedPercent asserts.
 */
type Comparison = Omit<OpReplies['migrateCompare'], 'rows'> & { rows: Extract<CompareRow, { changedPercent: number }>[] };

const PAGE = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="${title} page"><link rel="stylesheet" href="/styles.css"></head><body><header><a href="/">Home</a> <a href="/about.html">About</a></header><main>${body}</main></body></html>`;
const FILES: Record<string, string> = {
  'index.html': PAGE('Home', '<h1 class="hero">Make better websites</h1><p>Plain copy that should match pixel for pixel.</p><img src="/dot.svg" width="120" height="120" alt="Dot">'),
  'about.html': PAGE('About', '<h1>About us</h1><p>We make websites.</p>'),
  'styles.css': 'body{margin:0;font:16px/1.5 Helvetica,Arial,sans-serif;background:#fafafa;color:#222}header{padding:16px 24px;background:#1d4ed8}header a{color:#fff;margin-right:12px}main{padding:48px 24px;max-width:960px}.hero{font-size:56px;margin:0 0 24px;color:#111}',
  'dot.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="50" fill="#f97316"/></svg>',
};
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml' };

test('migrate capture and compare: a faithful copy compares clean and a real difference is located', { timeout: 240000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-migrate-e2e-'));
  const live = http.createServer((req, res): ServerResponse | void => {
    const name = req.url === '/' ? 'index.html' : req.url!.replace(/^\//, '').split('?')[0];
    if (!FILES[name]) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>Not found</h1>'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(name)] }); res.end(FILES[name]);
  });
  await new Promise<void>(resolve => live.listen(0, '127.0.0.1', resolve));
  const liveUrl = `http://127.0.0.1:${(live.address() as AddressInfo).port}`;
  const site = path.join(scratch, 'copy'); fs.mkdirSync(site);
  for (const [name, body] of Object.entries(FILES)) fs.writeFileSync(path.join(site, name), body);
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const interactive = path.resolve('test/fixtures/native-interactive.cjs');
  // No inherited RADIAL_ variables: a Radial terminal's RADIAL_CLI_SOCK would point the CLI below at that terminal's own Radial.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('RADIAL_'))), RADIAL_USERDATA: scratch, CLAUDE_CONFIG_DIR: path.join(scratch, 'claude'), CURSOR_CONFIG_DIR: path.join(scratch, 'cursor'), RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_CHAT_TEST_CLAUDE: interactive, RADIAL_CHAT_TEST_CURSOR: interactive, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' };
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env });
  const cli = path.join(process.cwd(), 'bin', 'radial');
  const radial = (args: string[]) => new Promise<CliRun<unknown>>(resolve => execFile('/bin/sh', [cli, ...args, '--json'], { env, encoding: 'utf8', timeout: 200000 }, (error, stdout, stderr) => {
    let json: unknown = null; try { json = JSON.parse(stdout); } catch {}
    resolve({ code: error ? (error.code || 1) : 0, json, stderr: String(stderr), stdout: String(stdout) });
  }));
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => typeof homeTab === 'object' && typeof agentTab === 'function');
    await app.evaluate(({ shell }) => { (globalThis as MainGlobals).openedExternally = []; shell.openExternal = async url => { (globalThis as MainGlobals).openedExternally.push(url); }; });
    for (let i = 0; i < 150 && !fs.existsSync(path.join(scratch, 'cli.sock')); i++) await new Promise(r => setTimeout(r, 100));

    // The playbook is Markdown, which the bundle otherwise leaves out: run against the
    // packaged app (the release gate), this proves it ships whole and installs at launch.
    const playbook = path.join(scratch, 'skills', 'site-migration'), source = path.resolve('src/main/migrate/playbook');
    for (let i = 0; i < 50 && !fs.existsSync(path.join(playbook, 'SKILL.md')); i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(fs.readFileSync(path.join(playbook, 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8'));
    assert.deepEqual(fs.readdirSync(path.join(playbook, 'references')).sort(), fs.readdirSync(path.join(source, 'references')).sort());

    // Home's wizard: leaving the address field starts the check, and the framework
    // press that caused it must still land.
    await page.evaluate(() => homeOpenCreate('migrate'));
    await page.locator('#mgUrl').fill(liveUrl.replace('http://', ''));
    await page.locator('[data-mg-fw="astro"]').click();
    assert.equal(await page.evaluate(() => mg.framework), 'astro', 'the first press picks the framework');
    assert.equal(await page.locator('#mgStart').isDisabled(), false);
    await page.waitForFunction(() => /^Found 127\.0\.0\.1/.test(document.getElementById('mgFound')!.textContent), null, { timeout: 20000 });
    assert.match((await page.locator('.mg-model-tip').textContent())!, /latest frontier models at high to max effort/);
    // Preparing refuses a framework the migration doesn't scaffold, a name every object inherits included.
    const refused = await page.evaluate(url => window.radial.migratePrepare({ url, framework: 'constructor' as string as MigrateFramework }), liveUrl); // not a MigrateFramework on purpose
    assert.deepEqual(refused, { ok: false, code: 'bad-request', error: 'Choose Astro or Next.js.' });

    const opened = await radial(['open', site]);
    assert.equal(opened.code, 0, opened.stderr + opened.stdout);

    const captured = await radial(['migrate', 'capture', liveUrl, '--project', site]) as CliRun<OpReplies['migrateCapture']>;
    assert.equal(captured.code, 0, captured.stderr + captured.stdout);
    assert.deepEqual([captured.json!.pages, captured.json!.platform], [2, 'Unknown']);
    assert.ok(captured.json!.assets >= 2, 'stylesheet and image downloaded');
    assert.equal(captured.json!.screens, 6, 'two templates at three widths');
    const readme = fs.readFileSync(captured.json!.readme, 'utf8');
    assert.match(readme, /Live-site capture: http:\/\/127\.0\.0\.1:\d+\/ \(Unknown\)/);
    assert.ok(!captured.json!.capture.startsWith(site + path.sep + 'src'), 'evidence stays out of the site source');
    assert.match(readme, /Reference screenshots: 6 under screens\//);
    assert.match(fs.readFileSync(path.join(site, '.context', 'migration.md'), 'utf8'), /^# Migration: 127\.0\.0\.1 → this project's framework/, 'the intent record every agent reads');

    const clean = await radial(['migrate', 'compare', site, '--route', '/']) as CliRun<Comparison>;
    assert.equal(clean.code, 0, clean.stderr + clean.stdout);
    assert.deepEqual(clean.json!.rows.map(r => r.width), [390, 768, 1440]);
    for (const row of clean.json!.rows) {
      assert.ok(row.changedPercent < 0.5, `${row.width}: ${row.changedPercent}% changed on an identical copy`);
      assert.equal(row.heights.delta, 0);
      assert.ok(fs.existsSync(row.files.diff) && fs.existsSync(row.files.live) && fs.existsSync(row.files.local));
    }

    fs.writeFileSync(path.join(site, 'styles.css'), FILES['styles.css'].replace('.hero{font-size:56px;margin:0 0 24px;color:#111}', '.hero{font-size:56px;margin:0 0 24px;color:#dc2626}'));
    const changed = await radial(['migrate', 'compare', site, '--route', '/', '--widths', '1440']) as CliRun<Comparison>;
    assert.equal(changed.code, 0, changed.stderr + changed.stdout);
    const [row] = changed.json!.rows;
    assert.ok(row.changedPercent > 0.05, `a recolored heading shows up (${row.changedPercent}%)`);
    assert.ok(row.bands.length >= 1 && row.bands[0].top > 50 && row.bands[0].bottom < 400, 'the changed band is the heading: ' + JSON.stringify(row.bands));
    assert.ok(fs.readFileSync(changed.json!.report, 'utf8').includes('| / | 1440 |'));

    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'screenshot windows are closed');
    assert.deepEqual(await app.evaluate(() => (globalThis as MainGlobals).openedExternally), [], 'nothing opened in the browser');
    assert.deepEqual(errors, []);
  } finally { await app.close(); live.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
});
