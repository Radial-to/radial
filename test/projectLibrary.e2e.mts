import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import type { Terminal } from '@xterm/xterm';
import type { IpcMainInvokeEvent } from 'electron';
import type { ChatEngine } from '../src/shared/chatPermissions.ts';
import type { GitHubOwners, GitHubRepo, LibraryStatus, OpenedFromGitHub, OpenProjectResult } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the app's window carries, as far as this test reaches into it inside the
// page: the window scripts' globals (the app's own declarations are
// src/renderer/globals.d.ts, types.d.ts and renderer.ts).
type ToolPanelId = 'adjust' | 'content' | 'motion' | 'inspect' | 'code' | 'variants' | 'image' | 'a11y' | 'tokens' | 'insert' | 'layers' | 'page' | 'reconcile' | 'ask' | 'draw' | 'comments' | 'pages' | 'context' | 'history' | 'terminal' | 'publish' | 'branches';
interface TermSession { id: string; xterm?: Terminal | null }
interface Tab { id: string; repoDir: string; baseUrl: string | null; terminals?: TermSession[]; activeTerminalId?: string | null }
declare let homeActive: boolean;
declare function activeTab(): Tab | null;
declare function activeTerm(tab: Pick<Tab, 'terminals' | 'activeTerminalId'>): TermSession | null;
declare function openProjectPath(dir: string): Promise<OpenProjectResult & { repoDir?: string }>;
declare function addTerminal(tab: Tab | null | undefined, engine: ChatEngine | null): Promise<TermSession | null>;
declare function tpGoHome(id: ToolPanelId): void;
declare function openToolPanel(id: ToolPanelId): void;
declare function focusAgentChat(): void;
declare function startRenameTerm(projectId: string, termId: string, nameEl: Element): void;
declare function updateTermStatusDom(term: TermSession): void;
declare function renderPanelDock(): void;
declare function renderProjectsRail(): void;
declare const RadialProjectLibrary: {
  /** The note for how a project opened from GitHub; it reads only the action. */
  openMessage(result: Pick<OpenedFromGitHub, 'action'>): string;
};
// What the main-process stubs answer in place of the Home library's IPC. They
// carry only some fields of the replies the window is typed against (radialApi:
// LibraryStatus for libraryStatus and libraryCopies, GitHubRepo rows for
// libraryRepos). The window reads a status as possibly missing any field
// (LooseUnion), and of a repo row it reads only these three here (isPrivate
// only when there is no description).
/** A checkout that tracks its upstream, with the fields the stubs fill in. */
type StubStatus = Pick<Extract<LibraryStatus, { ok: true; exists: true }>, 'dir' | 'ok' | 'isRepo' | 'branch' | 'slug' | 'remote' | 'changes' | 'ahead' | 'behind' | 'exists' | 'checkedAt'>;
/** A repository row, with the fields the stub fills in. */
type StubRepo = Pick<GitHubRepo, 'nameWithOwner' | 'url' | 'description'>;

test('GitHub Home selects local copies; terminal opens focused without stealing rename focus', { timeout: 120000 }, async () => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'radial-library-ui-')));
  const site = path.join(scratch, 'client-site'); fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'index.html'), '<title>Client site</title><h1>Local work</h1>');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: site, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'campaign'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('add', '.'); git('commit', '-qm', 'Initial'); git('remote', 'add', 'origin', 'https://github.com/client/site');
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ recents: [{ path: site, name: 'Client site', lastOpened: Date.now() }], session: { open: [], active: null } }));
  const app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules/.bin/electron'), args: ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  const child = app.process();
  const errors: string[] = [];
  try {
    const win = await app.firstWindow(); win.setDefaultTimeout(10000); win.on('pageerror', e => errors.push(e.message));
    await app.evaluate(({ ipcMain, BrowserWindow }, site) => {
      BrowserWindow.getAllWindows()[0].setSize(1400, 950);
      const state: StubStatus = { dir: site, ok: true, isRepo: true, branch: 'campaign', slug: 'client/site', remote: 'https://github.com/client/site', changes: [], ahead: 0, behind: 0, exists: true, checkedAt: Date.now() };
      for (const [channel, handler] of Object.entries({
        'library:repos': async (): Promise<{ ok: true; repos: StubRepo[] }> => ({ ok: true, repos: [{ nameWithOwner: 'client/site', url: 'https://github.com/client/site', description: 'Client marketing site' }] }),
        'library:copies': async (): Promise<StubStatus[]> => [state, { ...state, dir: site + '-other', branch: 'main' }],
        'library:status': async (_e: IpcMainInvokeEvent, { dir }: { dir: string; fetch: boolean }): Promise<StubStatus> => ({ ...state, dir, branch: dir === site ? 'campaign' : 'main' }),
        'github:owners': async (): Promise<GitHubOwners> => ({ ok: true, user: 'designer', orgs: ['client'] }),
      })) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); }
    }, site);
    await win.waitForFunction(() => typeof homeActive !== 'undefined' && homeActive);
    await win.locator('#appSplash').waitFor({ state: 'hidden' });
    await win.waitForFunction(() => document.querySelector('.hg-repository')?.textContent.includes('client/site'));
    assert.match((await win.locator('.hg-repository').textContent())!, /campaign/);
    await win.locator('[data-hg-filter="github"]').click();
    await win.getByText('Client marketing site', { exact: true }).waitFor();
    await win.screenshot({ path: path.join(scratch, 'github-home.png') });
    await win.locator('#hgGithub').getByRole('button', { name: 'Open local copy' }).click();
    await win.waitForFunction(() => document.querySelectorAll('.hg-copy').length === 2);
    assert.match((await win.locator('.hg-copy').first().textContent())!, /campaign/);
    assert.match((await win.locator('.hg-copy').nth(1).textContent())!, /main/);
    assert.equal(await win.getByRole('button', { name: 'Update and open', exact: true }).count(), 0);
    await win.screenshot({ path: path.join(scratch, 'local-copies.png') });
    await win.getByRole('button', { name: 'Close', exact: true }).click();
    await win.evaluate(dir => openProjectPath(dir), site);
    await win.waitForFunction(() => !homeActive && activeTab()?.baseUrl);
    await win.evaluate(async () => { await addTerminal(activeTab(), null); tpGoHome('content'); });
    await win.locator('[data-tpg-tab="terminal"]:visible').first().click();
    await win.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
    await win.keyboard.type('terminal focus check');
    await win.waitForFunction(() => {
      const b = activeTerm(activeTab()!)!.xterm!.buffer.active;
      return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString()).join('\n').includes('terminal focus check');
    });
    await win.keyboard.press('Control+u');
    await win.locator('[data-tpg-tab="content"]:visible').first().click();
    await win.evaluate(() => openToolPanel('terminal'));
    await win.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
    await win.locator('[data-tpg-tab="content"]:visible').first().click();
    await win.evaluate(() => focusAgentChat());
    await win.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
    await win.locator('[data-tpg-tab="content"]:visible').first().click();
    await win.locator('.rail-term[data-tid]').last().click();
    await win.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
    assert.doesNotMatch(await win.evaluate(() => RadialProjectLibrary.openMessage({ action: 'kept-local' })), /Pulled latest|Updated local branch/);
    assert.match(await win.evaluate(() => RadialProjectLibrary.openMessage({ action: 'kept-detached' })), /detached HEAD kept/);
    await win.evaluate(() => {
      const tab = activeTab()!, term = activeTerm(tab)!;
      const row = document.querySelector(`.rail-term[data-tid="${term.id}"]`)!;
      startRenameTerm(tab.id, term.id, row.querySelector('.rail-term-name')!);
    });
    const rename = win.getByRole('textbox', { name: 'Agent name' }); await rename.fill('Client site agent');
    await win.evaluate(() => { updateTermStatusDom(activeTerm(activeTab()!)!); renderPanelDock(); renderProjectsRail(); });
    assert.equal(await rename.evaluate(el => document.activeElement === el), true);
    await rename.press('Escape');
    assert.deepEqual(errors, []);
    console.log(`Project library screenshots: ${scratch}`);
  } finally {
    await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 8000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
