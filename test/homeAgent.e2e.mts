// The Home terminal (plans/radial-agent-native.md), in the real app: an
// isolated dev instance with no project open. The agent column shows on Home,
// nothing starts by itself, a Home terminal runs in the projects folder with
// `radial` on PATH, it survives opening a project and returning, and it
// reattaches after a relaunch (the PTY daemon keeps it).
//
// Opt-in: `npm run test:e2e`. Skips cleanly without Playwright.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Electron, ElectronApplication } from 'playwright-core';
import type { Terminal } from '@xterm/xterm';
import type { ChatEngine } from '../src/shared/chatPermissions.ts';
import type { OpenProjectResult, RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';
const require = createRequire(import.meta.url);

// What the app's window carries that this check reaches (src/renderer/globals.d.ts, types.d.ts).
/** An agent or shell session (TermSession): the daemon's pty id, and its xterm and element once mounted. */
interface TermSession { id: string; _ready?: boolean; xterm?: Terminal | null; el?: HTMLDivElement | null }
/** A tab the agent code works with (types.d.ts AnyTab): a project, or Home. */
interface AnyTab { id: string; repoDir: string | null }
/** The Home pseudo-tab (renderer.ts homeTab): its folder is known once main answers. */
interface HomeTab extends AnyTab { id: 'home'; terminals: TermSession[]; term: TermSession | null }
interface AppWindow extends Window { radial: RadialApi }
declare const window: AppWindow;
declare const homeTab: HomeTab;
declare let homeActive: boolean;
declare let rightTab: 'terminal' | 'comments' | 'history' | null;
declare let termOpen: boolean;
declare function agentTab(): AnyTab | null;
declare function addTerminal(tab: AnyTab | null, engine: ChatEngine | null): Promise<TermSession | null>;
declare function openProjectPath(dir: string): Promise<OpenProjectResult & { repoDir?: string }>;
declare function selectProjectTerminal(projectId: string, termId: string): Promise<void>;
declare function tabByRepo(repoDir: string): (AnyTab & { terminals?: TermSession[] }) | null;

function loadElectron(): Electron | null {
  for (const r of [path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '..', 'node_modules')]) {
    try { return (require(path.join(r, 'playwright-core')) as typeof import('playwright-core'))._electron; } catch {}
  }
  return null;
}
const until = async <T,>(label: string, ms: number, fn: () => T): Promise<NonNullable<Awaited<T>>> => { const t0 = Date.now(); let last: Awaited<T> | string | undefined; while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = (e as Error).message; } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`timeout: ${label} (${JSON.stringify(last)})`); };

async function launch(_electron: Electron, scratch: string, extraEnv: Record<string, string> = {}) {
  const app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules', '.bin', 'electron'), args: ['.'], cwd: process.cwd(), env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', ...extraEnv }, timeout: 30000 });
  const win = await app.firstWindow({ timeout: 20000 });
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1600, 900); });
  await until('renderer', 20000, () => win.evaluate(() => typeof homeTab === 'object' && typeof agentTab === 'function'));
  return { app, win, errors };
}
// app.close() can hang when a renderer wait threw mid-boot; never let that pin the suite.
async function closeApp(app: ElectronApplication) { try { await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]); } catch {} try { app.process().kill('SIGKILL'); } catch {} }

test('Home terminal: on-demand Home conversation, on-demand agent with radial on PATH, survives project switches and a relaunch', async (t) => {
  const _electron = loadElectron();
  if (!_electron) { t.skip('Playwright not available'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-home-e2e-'));
  const projectsDir = path.join(scratch, 'projects'); fs.mkdirSync(projectsDir);
  const fixture = path.join(scratch, 'site'); fs.mkdirSync(fixture); fs.writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><title>Site</title><h1>Site</h1>');
  // Point the Home cwd at a scratch projects folder (else ~/Radial): the store is what recents.getProjectsDir reads.
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ recents: [], projectsDir, session: { open: [], active: null } }));

  // A scratch profile takes its daemon, and the Home terminal with it, down at quit
  // unless it opts out (terminal.ts ephemeral()). This first run keeps its daemon,
  // like an installed app, so the relaunch has a terminal to reattach; the relaunch
  // takes the daemon down, and so does the cleanup if the test stops before that.
  t.after(() => { try { execFileSync('pkill', ['-f', path.join(scratch, 'term-daemon')]); } catch {} });
  let { app, win, errors } = await launch(_electron, scratch, { RADIAL_DAEMON_EPHEMERAL: '0' });
  try {
    // 1. Home shows the library without an empty agent column or a running agent.
    await until('home library', 15000, () => win.evaluate(() => homeActive && homeTab.repoDir && getComputedStyle(document.getElementById('rightDock')!).display === 'none'));
    const state = await win.evaluate(() => ({ cwd: homeTab.repoDir, terminals: homeTab.terminals.length, empty: !document.getElementById('termEmpty')!.hidden, homeAgent: document.body.classList.contains('home-agent'), rightTab, termOpen, paneActive: document.getElementById('rp-terminal')!.classList.contains('active') }));
    assert.equal(state.cwd, projectsDir, 'Home runs in the projects folder');
    assert.equal(state.terminals, 0, 'nothing starts by itself');
    assert.equal(state.homeAgent, false, `Home starts in the library: ${JSON.stringify(state)}`);
    // 2. A Home terminal (plain shell) appears under the Home row, and `radial` is on its PATH.
    await win.evaluate(() => addTerminal(homeTab, null));
    await until('home row', 10000, () => win.evaluate(() => document.querySelectorAll('.rail-term[data-id="home"]:not(.rail-term-add)').length === 1));
    await until('shell ready', 10000, () => win.evaluate(() => homeTab.term && homeTab.term._ready));
    await win.evaluate(() => window.radial.termInput(homeTab.term!.id, 'command -v radial; printf "SOCK=%s\\n" "$RADIAL_CLI_SOCK"; pwd\n'));
    const buffer = await until('radial on PATH', 15000, () => win.evaluate(() => { const b = homeTab.term!.xterm!.buffer.active; let out = ''; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (!l) continue; out += (l.isWrapped ? '' : '\n') + l.translateToString(true); } return /shims\/radial/.test(out) && /SOCK=[^\n]*cli\.sock/.test(out) ? out : null; })); // wrapped rows are joined: a narrow pane splits long paths
    assert.match(buffer, /\/shims\/radial/); assert.match(buffer, /cli\.sock/);
    assert.ok(buffer.includes(projectsDir) || buffer.includes(fs.realpathSync(projectsDir)), 'the shell sits in the projects folder');
    assert.equal(await win.evaluate(() => document.getElementById('termEmpty')!.hidden), true);
    // 3. Opening a project leaves Home; the Home agent row stays; coming back shows it again.
    await win.evaluate((dir) => openProjectPath(dir), fixture);
    await until('project open', 40000, () => win.evaluate(() => !homeActive && document.querySelectorAll('.rail-proj[data-id]').length === 1));
    assert.equal(await win.evaluate(() => document.querySelectorAll('.rail-term[data-id="home"]:not(.rail-term-add)').length), 1, 'Home agent row survives');
    assert.equal(await win.evaluate(() => document.body.classList.contains('home-agent')), false);
    await win.evaluate(() => selectProjectTerminal('home', homeTab.term!.id));
    await until('back home', 10000, () => win.evaluate(() => homeActive && document.body.classList.contains('home-agent') && homeTab.term!.el!.classList.contains('active')));
    assert.deepEqual(errors, []);
  } finally { await closeApp(app); }

  // 4. Relaunch with the same profile: the daemon kept the Home terminal, and it reattaches under Home.
  ({ app, win, errors } = await launch(_electron, scratch, { RADIAL_DAEMON_EPHEMERAL: '1' })); // reattach first, then this instance takes the daemon down
  try {
    await until('home dock again', 15000, () => win.evaluate(() => homeActive && homeTab.repoDir));
    await until('reattached', 15000, () => win.evaluate(() => homeTab.terminals.length === 1 && document.querySelectorAll('.rail-term[data-id="home"]:not(.rail-term-add)').length === 1));
    assert.deepEqual(errors, []);
  } finally {
    try { await win.evaluate(() => window.radial.termKill(homeTab.terminals[0].id)); } catch {}
    await closeApp(app);
  }
});

// Opening a project starts its first agent (chats are off in this build), which
// first waits for main to say which agent CLIs are installed. When the person
// has gone back to the Home terminal by the time that agent's terminal exists,
// it stays on its project's tab: the pane keeps showing Home's terminal.
test('a project agent still starting when the person goes back Home leaves the Home terminal on screen', async (t) => {
  const _electron = loadElectron();
  if (!_electron) { t.skip('Playwright not available'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-home-race-e2e-'));
  const projectsDir = path.join(scratch, 'projects'); fs.mkdirSync(projectsDir);
  const fixture = path.join(scratch, 'site'); fs.mkdirSync(fixture); fs.writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><title>Site</title><h1>Site</h1>');
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ recents: [], projectsDir, session: { open: [], active: null } }));
  const { app, win, errors } = await launch(_electron, scratch);
  try {
    await until('home library', 15000, () => win.evaluate(() => homeActive && homeTab.repoDir));
    await win.evaluate(() => addTerminal(homeTab, null));
    await until('shell ready', 10000, () => win.evaluate(() => homeTab.term && homeTab.term._ready));
    // Hold main's answer about the installed CLIs, so the project's agent starts
    // after the person is back Home, every time.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const answer = handlers.get('engine:available')!;
      handlers.set('engine:available', async (...args: unknown[]) => { await new Promise((r) => setTimeout(r, 1500)); return answer(...args); });
    });
    await win.evaluate((dir) => openProjectPath(dir), fixture);
    await until('project open', 20000, () => win.evaluate(() => !homeActive));
    await win.evaluate(() => selectProjectTerminal('home', homeTab.term!.id));
    await until('the project agent started', 20000, () => win.evaluate((dir) => (tabByRepo(dir)?.terminals || []).some((term) => !String(term.id).startsWith('new') && !!term.el), fixture));
    await new Promise((r) => setTimeout(r, 500)); // whatever the start does next has run
    const state = await win.evaluate(() => ({ homeActive, homeAgent: document.body.classList.contains('home-agent'), homeTermShown: !!homeTab.term!.el!.classList.contains('active') }));
    assert.deepEqual(state, { homeActive: true, homeAgent: true, homeTermShown: true });
    assert.deepEqual(errors, []);
  } finally {
    await closeApp(app);
  }
});
