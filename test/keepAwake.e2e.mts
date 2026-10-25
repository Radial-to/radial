// Keep awake E2E — the real app, a stand-in `claude` on PATH, the `radial` CLI.
//
// A session marked Keep awake (rail menu / `radial agent keep`) survives project
// sleep while an unmarked idle one is parked right next to it; releasing it
// makes it parkable again; the rail shows the state and its menu toggles it
// both ways. The idle threshold is shortened through RADIAL_AGENT_IDLE_MS so
// the sleep sweep sees both sessions as idle within seconds instead of 90s.
// (The daemon's caffeinate hold is not exercised here: throwaway daemons never
// touch the Mac's power state by design — check it live with `pmset -g
// assertions`.)
//
// Opt-in: `npm run test:e2e`. Skips cleanly without Playwright.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Electron, ElectronApplication } from 'playwright-core';
import type { OpReplies } from '../src/main/cliServer.ts';
import { launchApp } from './support/app.ts';
const require = createRequire(import.meta.url);

// What the app's window carries that this check reaches (src/renderer/globals.d.ts, types.d.ts, renderer.ts).
/** A tab the agent code works with (types.d.ts AnyTab): a project, or Home. */
interface AnyTab { id: string }
/** Where a rail menu opens: a click, or a point that stands in for one. */
type RailMenuPoint = Pick<MouseEvent, 'clientX' | 'clientY'> & Partial<Pick<MouseEvent, 'preventDefault' | 'stopPropagation'>>;
declare const homeTab: AnyTab;
declare function agentTab(): AnyTab | null;
declare function openTermRowMenu(e: RailMenuPoint, projectId: string, tid: string, sourceRow?: HTMLElement | null): void;
/** One run of the radial CLI: its exit code (an errno string when it could not start), and what it printed. */
interface CliRun { code: number | string; stdout: string; stderr: string }
/** The `--json` answer fields this test reads (cliServer.ts OpReplies): agent start's id, agent wait's reason, agent keep's on, agent list's agents. */
type CliJson = Partial<Pick<OpReplies['agentStart'], 'id'> & Pick<OpReplies['agentWait'], 'reason'> & Pick<OpReplies['agentKeep'], 'on'> & Pick<OpReplies['agentList'], 'agents'>>;

function loadElectron(): Electron | null {
  for (const r of [path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '..', 'node_modules')]) {
    try { return (require(path.join(r, 'playwright-core')) as typeof import('playwright-core'))._electron; } catch {}
  }
  return null;
}
const until = async <T,>(label: string, ms: number, fn: () => T): Promise<NonNullable<Awaited<T>>> => { const t0 = Date.now(); let last: Awaited<T> | string | undefined; while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = (e as Error).message; } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`timeout: ${label} (${JSON.stringify(last)})`); };
async function closeApp(app: ElectronApplication) { try { await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]); } catch {} try { app.process().kill('SIGKILL'); } catch {} }

const FAKE_CLAUDE = `#!/bin/sh
# A stand-in for Claude Code: answers the version probe, prints its task, rings
# the bell, then waits on stdin (idle) like a session parked at its prompt.
if [ "$1" = "--version" ]; then echo "99.0.0 (Claude Code)"; exit 0; fi
for last; do :; done
printf 'FAKE CLAUDE ready\\n'
printf 'TASK: %s\\n' "$last"
sleep 0.3
printf 'turn done\\a\\n'
while IFS= read -r line; do printf 'SUBMITTED: %s\\a\\n' "$line"; done
`;

test('keep awake: a kept session survives project sleep while an unmarked one is parked; release makes it parkable; the rail shows and toggles it', async (t) => {
  const _electron = loadElectron();
  if (!_electron) { t.skip('Playwright not available'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-awake-e2e-'));
  const bin = path.join(scratch, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const fixture = path.join(scratch, 'site'); fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><title>Awake site</title></head><body><h1>Hello</h1></body></html>');
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ recents: [], session: { open: [], active: null } }));

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RADIAL_USERDATA: scratch, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1', RADIAL_AGENT_IDLE_MS: '1500' };
  const app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules', '.bin', 'electron'), args: ['.'], cwd: process.cwd(), env, timeout: 30000 });
  const win = await app.firstWindow({ timeout: 20000 });
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  const cli = path.join(process.cwd(), 'bin', 'radial');
  const radial = (args: string[]) => new Promise<CliRun>((resolve) => execFile('/bin/sh', [cli, ...args], { env, encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
  const json = async (args: string[]) => { const r = await radial([...args, '--json']); let j: CliJson | null = null; try { j = JSON.parse(r.stdout); } catch {} return { ...r, json: j }; };
  const agents = async () => ((await json(['agent', 'list', fixture])).json || {}).agents || [];
  const rowState = (id: string) => win.evaluate((id) => {
    const el = document.querySelector(`.rail-term[data-tid="${id}"]`);
    return el ? { awake: el.classList.contains('awake'), slept: el.classList.contains('slept'), mark: !!el.querySelector('.rail-awake') } : null;
  }, id);
  // Open the row's menu (the ⋯ / right-click path) and press its keep-awake item; returns the item's label.
  const pressMenu = (id: string) => win.evaluate((id) => {
    openTermRowMenu({ clientX: 120, clientY: 120, preventDefault() {}, stopPropagation() {} }, agentTab()!.id, id);
    const b = document.querySelector<HTMLButtonElement>('#railCtxMenu button[data-act="awake"]');
    if (!b) return null;
    const label = b.textContent; b.click(); return label;
  }, id);
  try {
    await until('renderer', 20000, () => win.evaluate(() => typeof homeTab === 'object' && typeof agentTab === 'function'));
    await until('socket', 15000, () => fs.existsSync(path.join(scratch, 'cli.sock')));

    // Two sessions in one project: one to keep, one to leave alone.
    const a = await json(['agent', 'start', fixture, 'Phone session', '--submit', '--label', 'Phone']);
    assert.equal(a.code, 0, a.stderr + a.stdout);
    const kept = a.json!.id!;
    assert.equal((await json(['agent', 'wait', kept, '--timeout', '20'])).json!.reason, 'bell');
    const b = await json(['agent', 'start', fixture, 'Background session', '--submit', '--label', 'Other']);
    assert.equal(b.code, 0, b.stderr + b.stdout);
    const other = b.json!.id!; assert.notEqual(other, kept);
    assert.equal((await json(['agent', 'wait', other, '--timeout', '20'])).json!.reason, 'bell');

    // 1. Keep one awake through the CLI: the list, the human table and the rail all say so.
    assert.equal((await radial(['agent', 'keep'])).code, 2, 'needs the id');
    const keep = await json(['agent', 'keep', kept]);
    assert.equal(keep.code, 0, keep.stderr); assert.equal(keep.json!.on, true);
    assert.equal((await json(['agent', 'keep', 'pty-nope'])).code, 3, 'an unknown session is not found');
    assert.match((await radial(['agent', 'keep', kept])).stdout, /^Kept awake: /);
    let list = await agents();
    assert.equal(list.find((x) => x.id === kept)!.keepAwake, true, JSON.stringify(list));
    assert.equal(list.find((x) => x.id === other)!.keepAwake, false);
    assert.match((await radial(['agent', 'list', fixture])).stdout, /kept awake/);
    await until('the rail marks the kept row', 5000, async () => { const s = await rowState(kept); return s && s.awake && s.mark; });
    assert.deepEqual(await rowState(other), { awake: false, slept: false, mark: false });

    // 2. Project sleep parks the idle unmarked session and leaves the kept one running.
    await new Promise((r) => setTimeout(r, 1800)); // both idle past the (shortened) threshold
    const sl = await json(['sleep', fixture]); assert.equal(sl.code, 0, sl.stderr);
    await until('the other session is parked', 15000, async () => !(await agents()).some((x) => x.id === other && x.alive));
    list = await agents();
    assert.ok(list.some((x) => x.id === kept && x.alive && x.keepAwake), `the kept session is still alive: ${JSON.stringify(list)}`);
    await until('rail: other slept, kept awake', 5000, async () => { const o = await rowState(other); const k = await rowState(kept); return o && o.slept && k && k.awake && !k.slept; });

    // 3. Release it from the row menu (the click path); sleeping the project again parks it now.
    assert.equal(await pressMenu(kept), 'Let it sleep');
    await until('released', 5000, async () => (await agents()).find((x) => x.id === kept)!.keepAwake === false);
    assert.equal((await rowState(kept))!.awake, false);
    assert.match((await radial(['agent', 'keep', kept, '--off'])).stdout, /can be parked again/);
    const wk = await json(['wake', fixture]); assert.equal(wk.code, 0, wk.stderr);
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal((await json(['sleep', fixture])).code, 0);
    await until('the released session is parked too', 15000, async () => !(await agents()).some((x) => x.id === kept && x.alive));

    // 4. The menu turns a live session on as well.
    await json(['wake', fixture]);
    await until('sessions relaunched', 20000, async () => (await agents()).some((x) => x.alive && x.engine === 'claude'));
    const live = (await agents()).find((x) => x.alive && x.engine === 'claude')!;
    await until('the relaunched row is in the rail', 5000, async () => !!(await rowState(live.id)));
    assert.equal(await pressMenu(live.id), 'Keep awake');
    await until('kept from the menu', 5000, async () => (await agents()).find((x) => x.id === live.id)!.keepAwake === true);
    assert.equal((await rowState(live.id))!.awake, true);
    // A slept row offers no keep-awake item (nothing to keep).
    assert.deepEqual(errors, [], 'no renderer errors');
  } finally {
    await closeApp(app);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
});
