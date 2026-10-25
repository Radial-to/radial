// radial serve's page work end to end (plans/headless-core.md phase 3): the
// core under plain Node, no Electron anywhere, with Playwright's Chrome
// Headless Shell as its page, driven through the real `radial` CLI:
//   radial fields on contentFields.e2e.mts's fixtures lists what the window's
//     Content panel lists (kinds, roles, groups, cut text, alt, paths);
//   the overlay runs in a world the page's own scripts can't reach: a site that
//     patches getBoundingClientRect and getComputedStyle, and plants traps for
//     the overlay's names, changes nothing and catches nothing;
//   edit text --field and edit image --field land in the source;
//   a shot has the size the page has, at 2x and the chosen width (1x for a
//     page too tall for 2x), saved in the data dir;
//   a page that tries to leave for another origin stays where it is;
//   migrate capture takes migrate.e2e.mts's reference screenshots, and compare
//     scores its fixture as the app does: a faithful copy clean, a recolored
//     heading found where it is;
//   the browser stops when idle (RADIAL_PAGE_IDLE_MS), and serve stop leaves
//     no browser behind.
// `npm run test:headless:browser` (it requires the browser: `radial browser
// install`); also part of `npm run test:e2e`, which skips it without one.
// Runs on macOS and Linux.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { test } from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { ErrorReply } from '../src/main/cliProto.ts';
import type { ListedField, OpName, OpReplies } from '../src/main/cliServer.ts';
import type { CompareRow } from '../src/main/migrate/index.ts';
import type { ServeReply } from '../src/headless/serve.ts';
import type { BrowserInfo } from '../src/headless/browser.ts';

const ROOT = path.join(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'bin', 'radial');

/** A `radial …` run: its exit code and output. */
interface CliRun { code: number; stdout: string; stderr: string }
/** A union whose members each read the other members' fields as undefined (src/renderer/types.d.ts LooseUnion), so checks read every kind's fields alike. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type LooseUnion<T, All = T> = T extends unknown ? T & { [K in Exclude<KeysOfUnion<All>, keyof T>]?: undefined } : never;
/** A field as `radial fields --json` lists it. */
type Field = LooseUnion<ListedField>;
/** A compare row that compared (no error). */
type Compared = Extract<CompareRow, { changedPercent: number }>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(label: string, ms: number, fn: () => T | Promise<T>): Promise<NonNullable<T>> {
  const t0 = Date.now(); let last: unknown;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last as NonNullable<T>; } catch (e) { last = (e as Error).message; } await sleep(200); }
  throw new Error(`timeout: ${label} (${JSON.stringify(last)})`);
}
/** Whether a process is there (a zombie isn't). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
}
/** The browser processes a serve started: its children running Chrome Headless Shell. */
function browserChildren(pid: number): number[] {
  const out = String(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }));
  return out.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m && Number(m[2]) === pid && /chrome-headless-shell|headless_shell/.test(m[3])).map((m) => Number(m[1]));
}
/** A URL's HTTP status, or 0 when nothing answers. */
function status(url: string): Promise<number> {
  return new Promise((resolve) => { const req = http.get(url, { agent: false }, (res) => { res.resume(); resolve(res.statusCode || 0); }); req.on('error', () => resolve(0)); req.setTimeout(5000, () => { req.destroy(); resolve(0); }); });
}
/** The size a PNG says it is (IHDR). */
const pngSize = (file: string) => { const b = fs.readFileSync(file); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const git = (cwd: string, args: string[]) => String(execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], { cwd, encoding: 'utf8' })).trim();

// contentFields.e2e.mts's fixtures, as they are there.
const PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const CONTENT = `<!doctype html><html><body style="margin:0;font:16px system-ui">
<header id="top"><nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav></header>
<section id="hero"><h1>Ship your site tonight</h1><p>Radial is a <strong>local</strong> editor.</p><img id="heroimg" src="${PX}" alt="Editor screenshot" width="40" height="30"></section>
<section class="features"><h2>Features that matter</h2><ul><li>Fast <a href="#a">links</a></li><li>Undo anywhere</li></ul><img id="noalt" src="${PX}" width="40" height="30"><p style="display:none">hidden copy</p></section>
<footer><p>${'Long footer text. '.repeat(40)}</p></footer>
</body></html>`;
const SCAFFOLD = '<!doctype html><html><body><main id="main-content"><h1>Ship it</h1><p>Intro</p><a class="btn btn-primary" href="/x">Download</a><a role="button" href="/y">Start</a><a href="/z">Learn more</a></main><section id="pricing"><h2>Plans</h2><blockquote>Nice</blockquote></section><div id="root"><footer><p>Fine</p></footer></div></body></html>';
// A site that would blind the overlay if it shared the page's JavaScript: every element reads as hidden and
// zero-sized, and traps wait under the overlay's names. Its own paragraphs say what its scripts could see.
const HOSTILE = `<!doctype html><html><body><h1>Hostile page</h1><p>Plain copy here.</p><p id="probe">probing</p><p id="trap">no calls</p>
<script>
  const seen = ['ipcRenderer', 'require', '__radialHost', '__radialDispatch', 'injectStyles', 'cssPath'].filter((n) => typeof window[n] !== 'undefined');
  document.getElementById('probe').textContent = 'Overlay names the page sees: ' + (seen.join(', ') || 'none');
  const calls = [];
  const trap = (name) => (...args) => { calls.push(name); document.getElementById('trap').textContent = 'Trap calls: ' + calls.join(', '); };
  window.__radialHost = trap('__radialHost'); window.__radialDispatch = trap('__radialDispatch');
  window.ipcRenderer = { sendToHost: trap('sendToHost'), on: trap('on') };
  Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  window.getComputedStyle = () => ({ display: 'none', visibility: 'hidden', getPropertyValue: () => '' });
</script></body></html>`;
const ABOUT = '<!doctype html><html><head><title>About</title></head><body><h1>About us</h1><img src="/img/logo.png" alt="Logo" width="20" height="20"></body></html>';
const TALL = (h: number) => `<!doctype html><html><body style="margin:0"><div style="height:${h}px;background:#1d4ed8"></div></body></html>`;
const LEAVE = '<!doctype html><html><body><h1>Leaving soon</h1><script>setTimeout(() => { location.href = "https://example.com/"; }, 100);</script></body></html>';
// A 1×1 PNG (the logo, and the image that replaces it).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==', 'base64');

// migrate.e2e.mts's fixture, as it is there.
const MPAGE = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="${title} page"><link rel="stylesheet" href="/styles.css"></head><body><header><a href="/">Home</a> <a href="/about.html">About</a></header><main>${body}</main></body></html>`;
const MFILES: Record<string, string> = {
  'index.html': MPAGE('Home', '<h1 class="hero">Make better websites</h1><p>Plain copy that should match pixel for pixel.</p><img src="/dot.svg" width="120" height="120" alt="Dot">'),
  'about.html': MPAGE('About', '<h1>About us</h1><p>We make websites.</p>'),
  'styles.css': 'body{margin:0;font:16px/1.5 Helvetica,Arial,sans-serif;background:#fafafa;color:#222}header{padding:16px 24px;background:#1d4ed8}header a{color:#fff;margin-right:12px}main{padding:48px 24px;max-width:960px}.hero{font-size:56px;margin:0 0 24px;color:#111}',
  'dot.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="50" fill="#f97316"/></svg>',
};
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml' };

test('radial serve’s page work in a headless browser: fields as the window lists them, an overlay the page can’t reach, field edits, shots, the loopback guard, migration capture and compare, idle and stop', { timeout: 600000 }, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rhb-'));
  const data = path.join(scratch, 'data');
  const env: NodeJS.ProcessEnv = { ...process.env, RADIAL_CLI_FLAVOR: 'headless', RADIAL_USERDATA: data, RADIAL_AUTO_RELOAD: '0', RADIAL_NO_CAFFEINATE: '1', RADIAL_PAGE_IDLE_MS: '6000' };
  for (const k of ['RADIAL_CLI_SOCK', 'RADIAL_DATA_DIR', 'RADIAL_CLI_APP', 'RADIAL_CLI_APP_ARG', 'ELECTRON_RUN_AS_NODE']) delete env[k];
  const radial = (args: string[], timeout = 300000) => new Promise<CliRun>((resolve) => execFile('/bin/sh', [CLI, ...args], { env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
  // K names the socket op whose reply R the run prints with --json (or an ErrorReply when it fails); nothing checks either.
  const json = async <K extends OpName, R = OpReplies[K]>(args: string[]) => { const r = await radial([...args, '--json']); let j: R | null = null; try { j = JSON.parse(r.stdout); } catch {} return { ...r, json: j! }; };

  const shell = await radial(['browser', '--json']);
  const info = (() => { try { return JSON.parse(shell.stdout) as BrowserInfo; } catch { return null; } })();
  if (!info || !info.installed) {
    if (process.env.RADIAL_BROWSER_REQUIRED === '1') assert.fail(`No browser for radial serve: run \`radial browser install\` first.\n${shell.stdout}${shell.stderr}`);
    t.skip('No browser for radial serve (radial browser install).'); fs.rmSync(scratch, { recursive: true, force: true }); return;
  }
  t.diagnostic(`browser: ${info.name} ${info.version} (playwright-core ${info.playwright})`);

  // The site: the fixtures above, served by Radial's own static server, in a git repo.
  const site = path.join(scratch, 'site'); fs.mkdirSync(path.join(site, 'img'), { recursive: true });
  for (const [name, body] of Object.entries({ 'index.html': CONTENT, 'scaffold.html': SCAFFOLD, 'hostile.html': HOSTILE, 'about.html': ABOUT, 'tall.html': TALL(1234), 'toolong.html': TALL(9000), 'leave.html': LEAVE })) fs.writeFileSync(path.join(site, name), body);
  fs.writeFileSync(path.join(site, 'img', 'logo.png'), PNG);
  git(site, ['init', '-q', '-b', 'main']); git(site, ['add', '-A']); git(site, ['commit', '-q', '-m', 'init']);
  // migrate.e2e.mts's fixture: the "live" site on a local server, and the copy Radial runs.
  const live = http.createServer((req, res) => {
    const name = req.url === '/' ? 'index.html' : req.url!.replace(/^\//, '').split('?')[0];
    if (!MFILES[name]) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>Not found</h1>'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(name)] }); res.end(MFILES[name]);
  });
  await new Promise<void>((resolve) => live.listen(0, '127.0.0.1', resolve));
  const liveUrl = `http://127.0.0.1:${(live.address() as AddressInfo).port}`;
  const copy = path.join(scratch, 'copy'); fs.mkdirSync(copy);
  for (const [name, body] of Object.entries(MFILES)) fs.writeFileSync(path.join(copy, name), body);
  git(copy, ['init', '-q', '-b', 'main']); git(copy, ['add', '-A']); git(copy, ['commit', '-q', '-m', 'init']);

  let corePid = 0;
  try {
    const started = await radial(['serve', '--detach', '--json']);
    assert.equal(started.code, 0, started.stderr + started.stdout);
    corePid = (JSON.parse(started.stdout) as Extract<ServeReply, { ok: true }>).pid!;
    const opened = await json<'open'>(['open', site]);
    assert.equal(opened.code, 0, opened.stderr);
    assert.deepEqual(browserChildren(corePid), [], 'no browser until a page op');

    // 1. fields on contentFields.e2e.mts's page: the window's list, field for field.
    const t0 = Date.now();
    const fl = await json<'fields', { route: string; fields: Field[] }>(['fields', site, '/']);
    assert.equal(fl.code, 0, fl.stderr + fl.stdout);
    t.diagnostic(`first fields, with the browser starting: ${Date.now() - t0} ms`);
    assert.equal(fl.json.route, '/');
    const f = fl.json.fields;
    assert.deepEqual(f.map((x) => `${x.kind}:${x.tag}:${x.kind === 'image' ? x.selector.replace(/^.*#/, '#') : x.text!.slice(0, 14)}`), [
      'text:a:Home', 'text:a:Pricing',
      'text:h1:Ship your site', 'text:p:Radial is a lo', 'image:img:#heroimg',
      'text:h2:Features that ', 'text:li:Fast links', 'text:li:Undo anywhere', 'image:img:#noalt',
      'text:p:Long footer te',
    ]);
    assert.deepEqual(f.map((x) => x.id), ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10']);
    assert.equal(f.find((x) => x.text === 'Radial is a local editor.')!.hasMarkup, true);
    assert.deepEqual(f.map((x) => x.role), ['Nav link', 'Nav link', 'Heading', 'Body', 'Image', 'Subheading', 'List item', 'List item', 'Image', 'Body']);
    assert.equal(f[f.length - 1].truncated, true, 'long footer text is truncated');
    assert.deepEqual([...new Set(f.map((x) => x.group))], ['#top', '#hero', 'Features that matter', 'footer']);
    const hero = f.find((x) => x.selector.endsWith('#heroimg'))!, noalt = f.find((x) => x.selector.endsWith('#noalt'))!;
    assert.equal(hero.alt, 'Editor screenshot'); assert.equal(noalt.alt, null);
    assert.deepEqual([hero.naturalW, hero.naturalH], [1, 1]);
    assert.ok(Array.isArray(hero.path) && hero.path[0].tag === 'img' && hero.path.some((l) => l.tag === 'section'));
    assert.ok(!f.some((x) => x.text === 'hidden copy'), 'hidden text is skipped');
    assert.ok(f.every((x) => !('thumb' in x) && !('inFocus' in x)), 'thumbnails and focus flags stay out, as the window leaves them');
    assert.equal(browserChildren(corePid).length, 1, 'one browser');
    const sc = await json<'fields', { route: string; fields: Field[] }>(['fields', site, '/scaffold.html']);
    assert.equal(sc.code, 0, sc.stderr);
    assert.equal(sc.json.route, '/scaffold.html');
    assert.deepEqual(sc.json.fields.map((x) => `${x.group}|${x.role}`), ['Ship it|Heading', 'Ship it|Body', 'Ship it|Button', 'Ship it|Button', 'Ship it|Link', '#pricing|Subheading', '#pricing|Quote', 'footer|Body']);

    // 2. The overlay is out of the page's reach: its patches don't blind it, its traps catch nothing.
    const hostile = await json<'fields', { fields: Field[] }>(['fields', site, '/hostile.html']);
    assert.equal(hostile.code, 0, hostile.stderr);
    assert.deepEqual(hostile.json.fields.map((x) => x.text), ['Hostile page', 'Plain copy here.', 'Overlay names the page sees: none', 'no calls']);
    const again = await json<'fields', { fields: Field[] }>(['fields', site, '/hostile.html']);
    assert.equal(again.json.fields[3].text, 'no calls', 'a second read through the overlay, and still no trap sprung');

    // 3. edit text --field and edit image --field land in the source; the page reloads with them.
    const listed = await json<'fields', { fields: Field[] }>(['fields', site, '/']);
    const h1 = listed.json.fields.find((x) => x.tag === 'h1')!;
    const edit = await json<'editText'>(['edit', 'text', site, '--field', h1.id, '--to', 'Ship it this afternoon']);
    assert.equal(edit.code, 0, edit.stderr + edit.stdout); assert.equal(edit.json.relFile, 'index.html');
    assert.match(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), /<h1>Ship it this afternoon<\/h1>/);
    await until('the page shows the edit', 20000, async () => (await json<'fields', { fields: Field[] }>(['fields', site, '/'])).json.fields.some((x) => x.text === 'Ship it this afternoon'));
    const about = await json<'fields', { fields: Field[] }>(['fields', site, '/about.html']);
    const logo = about.json.fields.find((x) => x.kind === 'image')!;
    assert.match(logo.src!, /\/img\/logo\.png$/);
    const replacement = path.join(scratch, 'new-logo.png'); fs.writeFileSync(replacement, PNG);
    const swap = await json<'editImage', { relFile: string; newSrc: string; copiedTo: string }>(['edit', 'image', site, '--field', logo.id, '--file', replacement]); // a swap that landed (not already-applied)
    assert.equal(swap.code, 0, swap.stderr + swap.stdout); assert.equal(swap.json.relFile, 'about.html');
    assert.deepEqual([swap.json.copiedTo, swap.json.newSrc], [path.join('img', 'logo-radial.png'), '/img/logo-radial.png'], 'beside the image it replaces');
    assert.match(fs.readFileSync(path.join(site, 'about.html'), 'utf8'), /<img src="\/img\/logo-radial\.png" alt="Logo"/);
    assert.equal(await status(new URL('/img/logo-radial.png', opened.json.url!).href), 200, 'and the preview serves it at the new src');

    // 4. Shots: the page's size at 2x and the chosen width, in the data dir; 1x for a page too tall for 2x.
    const shot = await json<'shot'>(['shot', site, '/tall.html']);
    assert.equal(shot.code, 0, shot.stderr + shot.stdout);
    assert.equal(path.dirname(shot.json.path), path.join(data, 'shots'));
    assert.deepEqual([shot.json.scale, shot.json.route, ...pngSize(shot.json.path)], [2, '/tall.html', 2880, 2468]);
    const narrow = await json<'shot'>(['shot', site, '/tall.html', '--width', '390']);
    assert.equal(narrow.code, 0, narrow.stderr);
    assert.deepEqual(pngSize(narrow.json.path), [780, 2468]);
    const toolong = await json<'shot'>(['shot', site, '/toolong.html']);
    assert.deepEqual([toolong.json.scale, ...pngSize(toolong.json.path)], [1, 1440, 9000]);
    assert.equal((await radial(['shot', site, '/', '--width', '100'])).code, 2, 'a width out of range is a usage error');

    // 5. The loopback guard: a page that sends itself elsewhere stays where it is.
    const leave = await json<'fields', { route: string; fields: Field[] }>(['fields', site, '/leave.html']);
    assert.equal(leave.code, 0, leave.stderr);
    await sleep(1500); // its script has tried by now
    const stayed = await json<'fields', { route: string; fields: Field[] }>(['fields', site]);
    assert.deepEqual([stayed.json.route, stayed.json.fields.map((x) => x.text)], ['/leave.html', ['Leaving soon']]);
    assert.match(fs.readFileSync(path.join(data, 'logs', 'core.log'), 'utf8'), /\[page\] Kept site's page from leaving for https:\/\/example\.com\./);

    // 6. Migration: capture takes the reference screenshots, compare scores as the app does.
    assert.equal((await json<'open'>(['open', copy])).code, 0);
    const captured = await json<'migrateCapture'>(['migrate', 'capture', liveUrl, '--project', copy]);
    assert.equal(captured.code, 0, captured.stderr + captured.stdout);
    assert.deepEqual([captured.json.pages, captured.json.screens, captured.json.screensSkipped], [2, 6, undefined], 'two templates at three widths');
    const clean = await json<'migrateCompare', { rows: Compared[]; report: string }>(['migrate', 'compare', copy, '--route', '/']);
    assert.equal(clean.code, 0, clean.stderr + clean.stdout);
    assert.deepEqual(clean.json.rows.map((r) => r.width), [390, 768, 1440]);
    for (const row of clean.json.rows) {
      assert.ok(row.changedPercent < 0.5, `${row.width}: ${row.changedPercent}% changed on an identical copy`);
      assert.equal(row.heights.delta, 0);
      assert.ok(fs.existsSync(row.files.diff) && fs.existsSync(row.files.live) && fs.existsSync(row.files.local));
    }
    t.diagnostic(`identical copy: ${clean.json.rows.map((r) => `${r.width} ${r.changedPercent}% (${r.heights.live}px)`).join(', ')}`);
    fs.writeFileSync(path.join(copy, 'styles.css'), MFILES['styles.css'].replace('.hero{font-size:56px;margin:0 0 24px;color:#111}', '.hero{font-size:56px;margin:0 0 24px;color:#dc2626}'));
    const changed = await json<'migrateCompare', { rows: Compared[]; report: string }>(['migrate', 'compare', copy, '--route', '/', '--widths', '1440']);
    assert.equal(changed.code, 0, changed.stderr + changed.stdout);
    const [row] = changed.json.rows;
    assert.ok(row.changedPercent > 0.05, `a recolored heading shows up (${row.changedPercent}%)`);
    assert.ok(row.bands.length >= 1 && row.bands[0].top > 50 && row.bands[0].bottom < 400, 'the changed band is the heading: ' + JSON.stringify(row.bands));
    assert.ok(fs.readFileSync(changed.json.report, 'utf8').includes('| / | 1440 |'));
    t.diagnostic(`recolored heading at 1440: ${row.changedPercent}% changed, bands ${JSON.stringify(row.bands)}`);

    // 7. Idle: with nothing to do, the pages close and then the browser stops; the next op starts it again.
    await until('the browser stops when idle', 60000, () => browserChildren(corePid).length === 0);
    assert.match(fs.readFileSync(path.join(data, 'logs', 'core.log'), 'utf8'), /\[page\] The browser stopped: nothing used it for a while\./);
    assert.equal((await json<'fields'>(['fields', site, '/scaffold.html'])).code, 0);
    const [browserPid] = browserChildren(corePid);
    assert.ok(browserPid, 'started again');

    // 8. serve stop: the browser goes with it.
    const stopped = await radial(['serve', 'stop', '--json']);
    assert.equal(stopped.code, 0, stopped.stderr + stopped.stdout);
    await until('the browser goes', 15000, () => !alive(browserPid));
    assert.equal(alive(corePid), false);
  } finally {
    if (corePid && alive(corePid)) { await radial(['serve', 'stop'], 60000); try { process.kill(corePid, 'SIGKILL'); } catch {} }
    live.closeAllConnections(); live.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('without a browser, radial serve’s page work still refuses with what to run, and doctor says what’s missing', { timeout: 120000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rhn-'));
  const env: NodeJS.ProcessEnv = { ...process.env, RADIAL_CLI_FLAVOR: 'headless', RADIAL_USERDATA: path.join(scratch, 'data'), RADIAL_AUTO_RELOAD: '0', RADIAL_NO_CAFFEINATE: '1', PLAYWRIGHT_BROWSERS_PATH: path.join(scratch, 'none') };
  for (const k of ['RADIAL_CLI_SOCK', 'RADIAL_DATA_DIR', 'RADIAL_CLI_APP', 'RADIAL_CLI_APP_ARG', 'ELECTRON_RUN_AS_NODE']) delete env[k];
  const radial = (args: string[]) => new Promise<CliRun>((resolve) => execFile('/bin/sh', [CLI, ...args], { env, encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
  const site = path.join(scratch, 'site'); fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><html><body><h1>Hi</h1></body></html>');
  git(site, ['init', '-q', '-b', 'main']); git(site, ['add', '-A']); git(site, ['commit', '-q', '-m', 'init']);
  try {
    assert.equal((await radial(['open', site])).code, 0);
    const fields = await radial(['fields', site, '--json']);
    assert.equal(fields.code, 6);
    const reply = JSON.parse(fields.stdout) as ErrorReply;
    assert.deepEqual([reply.code, reply.fix], ['no-browser', 'radial browser install']);
    const doctor = await radial(['doctor']);
    assert.match(doctor.stdout, /missing {2}browser {4}Not installed\. Screenshots, page fields and migration compares need Chrome Headless Shell [\d.]+\.\n {22}Fix: radial browser install\n/);
  } finally {
    await radial(['serve', 'stop']);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
