// Vercel Toolbar comments in the real app: a linked static fixture opens with a
// FAKE `vercel` on PATH that answers `comments list --json`; the thread lands in
// .radial/comments.json on the first automatic pull, the Comments pane shows it
// with its author and a "via Vercel" chip plus the status line, `radial comments
// pull` is idempotent, and an old CLI turns the status line into the upgrade
// hint until a retry succeeds. Opt-in: `npm run test:e2e`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ElectronApplication } from 'playwright-core';
import type { CommentsPullReply } from '../src/main/cliServer.ts';
import type { RadialApi, ReviewComment } from '../src/shared/radialApi.ts';
import type { VercelThread } from '../src/main/vercelComments.ts';
import type { ViewportMode } from '../src/renderer/threadPreview.ts';
import { launchApp } from './support/app.ts';
const require = createRequire(import.meta.url);

// What the app's window carries, as far as this test reaches into it inside the
// page: the preload's API and the window scripts' globals (the app's own
// declarations are src/renderer/globals.d.ts, types.d.ts and renderer.ts).
/** The preview: Electron's <webview>, with the method this test calls. */
interface Webview extends HTMLElement { executeJavaScript(code: string): Promise<unknown> }
interface Tab { repoDir: string; webview: Webview; viewportMode: ViewportMode; comments?: ReviewComment[] }
declare const window: Window & typeof globalThis & { radial: RadialApi };
declare function activeTab(): Tab | null;
declare function openComments(): void;
declare function sendCommentPins(tab: Tab | null | undefined, list?: ReviewComment[]): void;
declare function commentsPrompt(items: ReviewComment[]): string | null;
declare function pullVercelCommentsNow(tab: Tab): Promise<void>;
/** A run of the `radial` CLI: its exit status (or the spawn error's code) and its output. */
interface CliRun { code: number | string; stdout: string; stderr: string }
/** Where the comment pin sits in the preview, as the script run there reports it; null until the pin is there. */
interface PinCheck { onElement: boolean; stale: boolean }

function loadElectron() {
  for (const r of [path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '..', 'node_modules')]) {
    try { return (require(path.join(r, 'playwright-core')) as typeof import('playwright-core'))._electron; } catch {}
  }
  return null;
}
const until = async <T,>(label: string, ms: number, fn: () => T | Promise<T>) => {
  const t0 = Date.now(); let last: Awaited<T> | string | undefined;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = (e as Error).message; } await new Promise((r) => setTimeout(r, 200)); }
  throw new Error(`timeout waiting for ${label}: ${last}`);
};
async function closeApp(app: ElectronApplication) { try { await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]); } catch {} try { app.process().kill('SIGKILL'); } catch {} }

const THREAD = {
  id: 'e2eThread1', resolved: false, resolvedBy: null, branch: 'staging', webUrl: 'https://vercel.com/acme-co/site/c/e2eThread1', messageCount: 2,
  // The deployed DOM had one more wrapper than the fixture: the stored selector misses locally, the relaxed one hits.
  context: { href: 'https://site-e2e.vercel.app/?utm=x', path: '/', pageTitle: 'Vercel comments', selection: 'Book a demo', selector: 'section#pricing > div.flex:nth-of-type(2) > a.btn:nth-of-type(2)',
    device: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', screenWidth: 390, screenHeight: 844, devicePixelRatio: 3 },
    frameworkContext: 'React Component Tree (root to selected element):\n\nSelected: <a.btn>\n\n  <[minified] url="/" ...>\n    <section className="pricing" id="pricing">\n      <div className="flex">\n        <a className="btn">' },
  messages: [
    { id: 'm1', author: { name: 'Dana', type: 'user' }, timestamp: 1786733118830, text: 'This CTA should say Talk to sales.' },
    { id: 'm2', author: { name: 'Sam', type: 'user' }, timestamp: 1786733200000, text: 'Agreed.' },
  ],
} satisfies VercelThread;
// Reads $MODE_FILE: "ok" answers like CLI 59; "old" answers like CLI 50 (no `comments`).
const FAKE_VERCEL = (modeFile: string, listFile: string, log: string) => `#!/bin/sh
echo "$*" >> "${log}"
mode=$(cat "${modeFile}" 2>/dev/null || echo ok)
if [ "$1" = "whoami" ]; then echo "e2e-user"; exit 0; fi
if [ "$1" = "--version" ]; then echo "59.11.7"; exit 0; fi
if [ "$1" = "comments" ] && [ "$mode" = "old" ]; then echo 'Error: "comments" is not a valid target directory or subcommand. Did you mean "certs"?' >&2; exit 1; fi
if [ "$1" = "comments" ] && [ "$2" = "list" ]; then echo "Vercel CLI 59.11.7" >&2; echo "Retrieving project…" >&2; cat "${listFile}"; exit 0; fi
if [ "$1" = "comments" ] && [ "$2" = "resolve" ]; then printf '{"thread":{"id":"%s","resolved":true}}\\n' "$3"; exit 0; fi
echo '{"error":{"code":"unknown","message":"unknown command"}}'; exit 1
`;

test('Vercel Toolbar comments land in the pane with author + chip, pull is idempotent, an old CLI shows the upgrade hint', async (t) => {
  const _electron = loadElectron();
  if (!_electron) { t.skip('Playwright not available'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-vc-e2e-'));
  const bin = path.join(scratch, 'bin'); fs.mkdirSync(bin);
  const modeFile = path.join(scratch, 'mode'), listFile = path.join(scratch, 'list.json'), log = path.join(scratch, 'vercel.log');
  fs.writeFileSync(modeFile, 'ok');
  fs.writeFileSync(listFile, JSON.stringify({ scope: { teamSlug: 'acme-co' }, filters: {}, pagination: { nextCursor: null }, threads: [THREAD] }, null, 2));
  fs.writeFileSync(path.join(bin, 'vercel'), FAKE_VERCEL(modeFile, listFile, log), { mode: 0o755 });
  const fixture = path.join(scratch, 'site'); fs.mkdirSync(path.join(fixture, '.vercel'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><title>Vercel comments</title></head><body><section id="pricing"><div class="flex"><a class="btn" href="#">Learn more</a><a class="btn" href="#">Book a demo</a></div></section></body></html>');
  fs.writeFileSync(path.join(fixture, '.vercel', 'project.json'), JSON.stringify({ projectId: 'prj_e2e', orgId: 'team_e2e', projectName: 'e2e-site' }));
  fs.writeFileSync(path.join(fixture, '.gitignore'), '.vercel\n');
  execFileSync('git', ['init', '-q'], { cwd: fixture }); execFileSync('git', ['add', '-A'], { cwd: fixture });
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'init'], { cwd: fixture });
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ recents: [], session: { open: [], active: null } }));

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RADIAL_USERDATA: scratch, RADIAL_OPEN: fixture, RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' };
  const app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules', '.bin', 'electron'), args: ['.'], cwd: process.cwd(), env, timeout: 30000 });
  const win = await app.firstWindow({ timeout: 20000 });
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  const cli = path.join(process.cwd(), 'bin', 'radial');
  const radial = (args: string[]) => new Promise<CliRun>((resolve) => execFile('/bin/sh', [cli, ...args], { env, encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' })));
  try {
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1600, 900); });
    await until('project open', 40000, () => win.evaluate(() => !!(typeof activeTab === 'function' && activeTab() && activeTab()!.webview && activeTab()!.webview.offsetWidth)));

    // 1. The first automatic pull (a few seconds after open) writes the thread.
    const synced = await until('synced comment', 30000, () => win.evaluate(async () => (await window.radial.commentsList(activeTab()!.repoDir)).find((c) => c.id === 'vercel-e2eThread1')));
    assert.equal(synced.route, '/'); assert.equal(synced.selector, 'section#pricing > div.flex:nth-of-type(2) > a.btn:nth-of-type(2)');
    assert.deepEqual(synced.alt, ['section#pricing > div.flex > a.btn:nth-of-type(2)', 'section#pricing > div.flex > a.btn', 'a.btn']);
    assert.equal(synced.anchor, '<a> “Book a demo”'); assert.equal(synced.who, 'Dana'); assert.equal(synced.source, 'vercel');
    assert.equal(synced.vercel!.viewport, 'mobile'); assert.equal(synced.vercel!.device, 'iPhone · Safari'); assert.deepEqual(synced.vercel!.tree, ['<section className="pricing" id="pricing">', '<div className="flex">', '<a className="btn">']);
    assert.equal(synced.text, 'This CTA should say Talk to sales.\n↳ Sam: Agreed.');
    assert.match(fs.readFileSync(log, 'utf8'), /comments list --json --status all --all-branches --limit 100/);

    // 2. The pane: author, the chip, the status line.
    await win.evaluate(() => openComments());
    await until('row', 15000, () => win.evaluate(() => !!document.querySelector('#commentsList .cm-row[data-id="vercel-e2eThread1"] .cm-src')));
    const row = await win.evaluate(() => { const r = document.querySelector('#commentsList .cm-row[data-id="vercel-e2eThread1"]')!; return { who: r.querySelector('.cm-who')!.textContent, src: r.querySelector('.cm-src')!.textContent, url: r.querySelector<HTMLAnchorElement>('.cm-src')!.dataset.url, text: r.querySelector('.cm-text')!.textContent }; });
    assert.deepEqual(row, { who: 'Dana', src: 'via Vercel', url: THREAD.webUrl, text: 'This CTA should say Talk to sales.\n↳ Sam: Agreed.' });
    await until('status line', 15000, () => win.evaluate(() => { const s = document.getElementById('commentsVercel'); return s && s.style.display !== 'none' && /Vercel comments · pulled/.test(s.textContent) && !!s.querySelector('.cm-vercel-pull'); }));
    assert.equal(await win.evaluate(() => document.querySelector('#commentsList .cm-row[data-id="vercel-e2eThread1"] .cm-where')!.textContent), 'staging · phone', 'the row says where it was left');

    // 2b. Pinned where it is on the live site: the stored selector misses this DOM, the relaxed
    //     fallback finds the element, and the pin renders on it in the preview.
    await win.evaluate(() => sendCommentPins(activeTab(), activeTab()!.comments));
    const pin = await until('pin in the preview', 15000, () => win.evaluate(() => activeTab()!.webview.executeJavaScript(`(() => { const p = document.querySelector('.radial-comment-pin'); if (!p) return null; const a = document.querySelectorAll('section#pricing a.btn')[1].getBoundingClientRect(); const r = p.getBoundingClientRect(); return { onElement: Math.abs(r.left - a.right) < 40 && Math.abs(r.top - a.top) < 40, stale: !!document.querySelector('section#pricing > div.flex:nth-of-type(2)') }; })()`) as Promise<PinCheck | null>));
    assert.equal(pin.stale, false, 'the fixture really lacks the deployed wrapper'); assert.equal(pin.onElement, true, 'the pin sits on the element the fallback found');
    // Open matches the reviewer's device: a phone comment switches the canvas to the mobile preset and flashes the element.
    await win.evaluate(() => document.querySelector<HTMLButtonElement>('#commentsList .cm-row[data-id="vercel-e2eThread1"] .cm-goto')!.click());
    await until('mobile preset', 10000, () => win.evaluate(() => activeTab()!.viewportMode === 'mobile'));
    await until('flash on the element', 10000, () => win.evaluate(() => activeTab()!.webview.executeJavaScript(`!!document.querySelector('section#pricing a.btn:nth-of-type(2).radial-review-flash')`)));
    // The agent prompt carries the tree and the layout.
    const prompt = await win.evaluate(() => commentsPrompt([activeTab()!.comments!.find((c) => c.id === 'vercel-e2eThread1')!])!);
    assert.match(prompt, /React component tree at the element \(from Vercel\):\n\s+<section className="pricing" id="pricing">/);
    assert.match(prompt, /viewing on iPhone · Safari at 390×844 \(the mobile layout\)/);
    assert.match(prompt, /Also matches: section#pricing > div\.flex > a\.btn:nth-of-type\(2\)/);

    // 3. The CLI: a manual pull, idempotent → nothing new, no error.
    const pull = await radial(['comments', 'pull', fixture]);
    assert.equal(pull.code, 0, pull.stderr + pull.stdout);
    assert.match(pull.stdout, /Up to date: 1 Vercel thread, nothing new\./);
    const pj = await radial(['comments', 'pull', fixture, '--json']);
    const j: CommentsPullReply = JSON.parse(pj.stdout); assert.equal(j.ok, true); assert.equal(j.total, 1); assert.equal(j.added, 0); assert.equal(j.changed, false);
    assert.equal((await win.evaluate(async () => (await window.radial.commentsList(activeTab()!.repoDir)).length)), 1, 'one comment, never duplicated');

    // 4. An old CLI: the status line becomes the upgrade hint; a retry after the upgrade recovers.
    fs.writeFileSync(modeFile, 'old');
    await win.evaluate(() => pullVercelCommentsNow(activeTab()!));
    await until('upgrade hint', 15000, () => win.evaluate(() => { const s = document.getElementById('commentsVercel')!; return s.classList.contains('warn') && /Vercel CLI 59\.1 or newer/.test(s.textContent) && /Retry/.test(s.textContent); }));
    const oldCli = await radial(['comments', 'pull', fixture]);
    assert.notEqual(oldCli.code, 0); assert.match(oldCli.stderr + oldCli.stdout, /59\.1 or newer/);
    fs.writeFileSync(modeFile, 'ok');
    await win.evaluate(() => document.querySelector<HTMLButtonElement>('#commentsVercel .cm-vercel-pull')!.click());
    await until('recovered', 15000, () => win.evaluate(() => { const s = document.getElementById('commentsVercel')!; return !s.classList.contains('warn') && /pulled/.test(s.textContent); }));

    assert.deepEqual(errors, []);
  } finally {
    await closeApp(app);
  }
});
