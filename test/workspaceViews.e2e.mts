/// <reference path="../src/renderer/types.d.ts" />
// The window's own shapes (Tab, HomeTab, ToolPanelId, ElementById) come from types.d.ts above.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectTemplate, RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

/** The app window (page functions run there): the preload's API (src/renderer/globals.d.ts). */
declare const window: Window & typeof globalThis & { radial: RadialApi };
/** The main process's global where the file picker stand-in records the options it was opened with. */
type DialogGlobals = typeof globalThis & { dialogOptions?: Electron.OpenDialogOptions };
// renderer.ts's top-level declarations, which page functions reach by name.
declare const tabs: Tab[];
declare let homeActive: boolean;
/** Home shows the new-project form. */
declare let homeCreateMode: boolean;
/** Home's library filter ('all', 'pinned', 'open', 'activity', 'github'). */
declare let hgFilter: string;
/** The Home agent. */
declare const homeTab: HomeTab;
/** The new-project form's state: the starter picked. */
declare const np: { templateId: ProjectTemplate['id'] };
declare function $<K extends string>(id: K): ElementById<K>;
declare function activeTab(): Tab | null;
declare function renderProjectsRail(): void;
declare function closeNewSiteMenu(): void;
declare function closePublishMenu(): void;
declare function openToolPanel(id: ToolPanelId): void;
declare function closeToolPanel(id: ToolPanelId): void;
declare function openSettings(mode?: 'global' | 'project'): void;

test('Home library and settings: navigation, filters, themes, and layout', { timeout: 120000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-workspace-'));
  const projectsDir = path.join(scratch, 'projects');
  fs.mkdirSync(projectsDir);
  const recents = ['Studio website', 'Field notes', 'Radial documentation', 'Summer collection', 'Portfolio', 'A project with a deliberately long name to check truncation'].map((name, i) => {
    const dir = path.join(projectsDir, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), `<title>${name}</title><h1>${name}</h1>`);
    return { name, path: dir, lastOpened: Date.now() - (i + 1) * 3600000 };
  });
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ recents, projectsDir, session: { open: [], active: null } }));
  const app = await launchApp({
    executablePath: path.join(process.cwd(), 'node_modules/.bin/electron'), args: ['.'],
    env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' },
  });
  const errors: string[] = [];
  try {
    const win = await app.firstWindow();
    win.on('pageerror', (e) => errors.push(e.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await win.waitForFunction(() => typeof homeActive !== 'undefined' && homeActive && document.querySelectorAll('.hg-open').length === 6);
    await win.locator('#appSplash').waitFor({ state: 'hidden' });
    const shot = async (name: string) => {
      await win.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
      await win.screenshot({ path: path.join(scratch, `${name}.png`) });
    };
    await win.evaluate(() => { localStorage.setItem('radial.railSection.projects', '1'); renderProjectsRail(); });
    assert.equal(await win.locator('.rail-projects-empty').isVisible(), true, 'empty state stays visible even if Projects was collapsed');
    assert.equal(await win.locator('[data-section="projects"]').isDisabled(), true);
    assert.equal(await win.locator('.rail-projects-empty').textContent(), 'No projects open');
    await win.evaluate(() => localStorage.removeItem('radial.railSection.projects'));
    const projectAction = win.getByRole('button', { name: 'Open or create project', exact: true });
    await projectAction.focus();
    await win.evaluate(() => renderProjectsRail());
    assert.equal(await projectAction.evaluate(el => el === document.activeElement), true);
    await win.keyboard.press('ArrowDown');
    assert.equal(await win.getByRole('menuitem', { name: 'Open local project', exact: true }).evaluate(el => el === document.activeElement), true);
    await win.evaluate(() => renderProjectsRail());
    assert.equal(await projectAction.getAttribute('aria-expanded'), 'true', 'open project menu survives sidebar updates');
    await win.keyboard.press('Escape');
    assert.equal(await projectAction.evaluate(el => el === document.activeElement), true);
    await win.keyboard.press('ArrowUp');
    await win.keyboard.press('Enter');
    await win.waitForFunction(() => homeActive && homeCreateMode);
    assert.equal(await win.locator('#fr-template').isVisible(), true);
    await win.locator('#frBack').click();
    await win.locator('[data-starter="html"]').waitFor();
    assert.equal(await win.locator('.hg-starter').count(), 3);
    await win.locator('[data-starter="html"]').click();
    await win.waitForFunction(() => homeCreateMode && np.templateId === 'html');
    await win.locator('#frBack').click();
    await win.locator('.hg-chat-suggestions button').first().click();
    assert.equal(await win.locator('#hgChatInput').inputValue(), 'What’s running right now?');
    assert.equal(await win.evaluate(() => homeTab.terminals.length), 0, 'suggestions stage a question without starting an agent');
    await win.locator('#hgChatInput').fill('');
    assert.equal(await win.locator('#hgChatInput').evaluate(el => getComputedStyle(el).resize), 'none');
    assert.ok(await win.locator('#hgChatInput').evaluate(el => el.getBoundingClientRect().height) >= 108);
    await win.evaluate(() => document.body.classList.add('is-fullscreen'));
    assert.equal(await win.evaluate(() => $('railCollapse').getBoundingClientRect().bottom <= document.querySelector('.rail-proj[data-home]')!.getBoundingClientRect().top), true, 'sidebar toggle does not overlap Home');
    await win.locator('#railCollapse').click();
    assert.equal(await win.locator('#projectsRail').isVisible(), false, 'Home can collapse the projects sidebar');
    await win.locator('#railReopen').click();
    assert.equal(await win.locator('#projectsRail').isVisible(), true);
    await win.evaluate(() => document.body.classList.remove('is-fullscreen'));

    await win.locator('#hgActivitySummary').click();
    assert.equal(await win.locator('[data-hg-filter="activity"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await win.locator('#hgActivitySummary').isVisible(), false, 'Activity does not link to itself');
    assert.equal(await win.locator('[data-hg-filter="activity"]').evaluate(el => el === document.activeElement), true, 'focus moves to the destination tab');
    await win.waitForFunction(() => document.querySelector('#hgActivity')!.textContent.includes('Nothing running right now'));
    await win.locator('[data-hg-filter="all"]').click();
    assert.equal(await win.locator('#hgActivitySummary').isVisible(), true, 'activity shortcut returns in other views');
    await shot('01-home-list');
    assert.equal(await win.locator('.hg-intro').count(), 0, 'Home has no decorative tagline');
    assert.doesNotMatch((await win.locator('#termEmpty').textContent())!, /type below/i);
    await win.locator('#hgSort').focus();
    await win.keyboard.press('ArrowDown');
    assert.equal(await win.getByRole('menuitemradio', { name: 'Last opened' }).getAttribute('aria-checked'), 'true');
    await shot('home-sort-menu');
    await win.keyboard.press('Escape');
    assert.equal(await win.evaluate(() => document.activeElement!.id), 'hgSort');
    assert.equal(await win.locator('#hgSort').getAttribute('aria-expanded'), 'false');
    await win.locator('#hgSearch').fill('field');
    assert.equal(await win.locator('.hg-open').count(), 1);
    await win.locator('.hg-more').focus();
    await win.keyboard.press('ArrowDown');
    await shot('home-project-menu');
    await win.keyboard.press('Enter');
    assert.equal(await win.evaluate(() => document.activeElement!.classList.contains('hg-more')), true, 'pin restores focus after reordering');
    await win.locator('.hg-more').click();
    assert.equal(await win.getByRole('menuitem', { name: 'Unpin project' }).count(), 1);
    await win.keyboard.press('Escape');
    await win.locator('#hgSearch').fill('');
    await win.locator('[data-hg-filter="pinned"]').click();
    assert.equal(await win.locator('.hg-open').count(), 1);
    await win.locator('[data-hg-filter="open"]').click();
    assert.equal(await win.locator('.hg-no-results h2:visible').textContent(), 'Nothing open yet');
    await win.locator('#hgReset').click();
    await win.locator('.hg-more').first().focus();
    await win.keyboard.press('ArrowUp');
    assert.equal(await win.evaluate(() => document.activeElement!.textContent), 'Remove from Home');
    await win.keyboard.press('Enter');
    assert.equal(await win.evaluate(() => document.activeElement!.id), 'confirmCancel');
    await win.keyboard.press('Shift+Tab');
    assert.equal(await win.evaluate(() => document.activeElement!.id), 'confirmOk');
    await win.keyboard.press('Tab');
    assert.equal(await win.evaluate(() => document.activeElement!.id), 'confirmCancel');
    await win.keyboard.press('Enter');
    assert.equal(await win.locator('#confirmModal').isVisible(), false, 'Enter on Cancel cancels');
    assert.equal(await win.locator('.hg-open').count(), 6, 'cancel keeps every recent');
    await win.locator('#hgSort').click();
    await win.keyboard.press('End');
    await win.keyboard.press('Enter');
    assert.equal(await win.locator('#hgSort').getAttribute('aria-label'), 'Sort projects: Name A–Z');
    assert.equal(await win.locator('.hg-name').first().textContent(), 'Field notes', 'pinned sorts first');
    await win.locator('[data-hg-view="grid"]').click();
    assert.equal(await win.evaluate(() => localStorage.getItem('radial.homeView')), 'grid');
    await shot('02-home-grid');
    await win.locator('#hgSearch').fill('no such project');
    assert.equal(await win.locator('.hg-no-results h2:visible').textContent(), 'No matching projects');
    await win.locator('#hgReset').click();
    await win.locator('#settingsBtn').click();
    await win.locator('[data-settings-page="general"]').waitFor({ state: 'visible' });
    await shot('03-settings-general');
    const settingsIcons = await win.locator('#settingsNav button svg').evaluateAll((icons) => icons.map((el) => el.innerHTML));
    assert.equal(new Set(settingsIcons).size, 4, 'every settings page has a distinct available icon');
    const controlsCentered = await win.locator('#settingsView .settings-actions button').evaluateAll((buttons) => buttons.every((button) => {
      const b = button.getBoundingClientRect(), i = button.querySelector('svg')!.getBoundingClientRect();
      return Math.abs(b.x + b.width / 2 - i.x - i.width / 2) < 1 && Math.abs(b.y + b.height / 2 - i.y - i.height / 2) < 1;
    }));
    assert.equal(controlsCentered, true, 'settings action icons are centered');
    assert.equal(await win.evaluate(() => getComputedStyle(document.querySelector('.hg-card')!).backgroundColor === getComputedStyle(document.querySelector('.set-card')!).backgroundColor), true, 'Home uses the settings card surface');
    for (const section of ['connections', 'privacy', 'about']) {
      await win.locator(`[data-settings-nav="${section}"]`).click();
      assert.equal(await win.locator('[data-settings-page]:visible').count(), 1);
      await shot(`settings-${section}`);
    }
    await win.locator('[data-settings-nav="general"]').click();
    await win.getByRole('radio', { name: 'Light', exact: true }).check();
    await win.waitForFunction(() => document.documentElement.classList.contains('light'));
    await shot('04-settings-light');
    await win.locator('#settingsBack').click();
    assert.equal(await win.locator('#settingsView').isVisible(), false);
    await shot('05-home-light');
    await win.locator('#hgNew').click();
    assert.ok(await win.locator('.new-site-menu').isVisible());
    await win.evaluate(() => closeNewSiteMenu());
    await win.locator('#settingsBtn').click();
    await win.getByRole('radio', { name: 'Dark', exact: true }).check();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760));
    await shot('06-settings-compact');
    const overflow = () => win.evaluate(() => [...document.querySelectorAll('#settingsView, .settings-content, #settingsBody')].some((el) => el.scrollWidth > el.clientWidth + 2));
    assert.equal(await overflow(), false, 'compact settings has no horizontal overflow');
    await win.evaluate(() => { document.documentElement.dir = 'rtl'; });
    assert.equal(await overflow(), false, 'RTL settings has no horizontal overflow');
    await win.evaluate(() => { document.documentElement.dir = 'ltr'; });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
    assert.equal(await overflow(), false, 'settings at 200% has no horizontal overflow');
    await shot('07-settings-zoom');
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.webContents.setZoomFactor(1); w.setSize(1600, 1000); });
    await win.locator('#settingsClose').click();
    // The picker stand-in records where the app asked it to open (its options are the last argument).
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async (...args: unknown[]) => { (globalThis as DialogGlobals).dialogOptions = args.at(-1) as Electron.OpenDialogOptions; return { canceled: false, filePaths: [dir] }; }; }, recents[0].path);
    await projectAction.click();
    await win.getByRole('menuitem', { name: 'Open local project', exact: true }).click();
    await win.waitForFunction(() => !homeActive && activeTab()?.baseUrl, { timeout: 30000 });
    assert.equal(await app.evaluate(() => (globalThis as DialogGlobals).dialogOptions?.defaultPath), projectsDir, 'Open local project starts in the projects folder, not ~/Downloads');
    assert.equal(await win.locator('.rail-projects-empty').count(), 0, 'opening a project replaces the empty state');
    await projectAction.click();
    assert.deepEqual(await win.getByRole('menuitem').allTextContents(), ['Open local project', 'Open from GitHub', 'New project']);
    await win.getByRole('menuitem', { name: 'Open from GitHub', exact: true }).click();
    await win.waitForFunction(() => homeActive && !homeCreateMode && hgFilter === 'github');
    assert.equal(await win.locator('#hgGithub').isVisible(), true, 'sidebar opens GitHub repositories from a project');
    assert.equal(await win.locator('#hgSearch').getAttribute('placeholder'), 'Search repositories…');
    await win.locator('.rail-proj[data-id]').first().click();
    await win.waitForFunction(() => !homeActive);
    await projectAction.click();
    await win.getByRole('menuitem', { name: 'New project', exact: true }).click();
    await win.waitForFunction(() => homeActive && homeCreateMode);
    assert.equal(await win.locator('#fr-template').isVisible(), true, 'sidebar creation opens the starter form from a project');
    assert.equal(await win.evaluate(() => tabs.length), 1, 'creating from the sidebar keeps the open project');
    await win.locator('#frBack').click();
    await win.locator('[data-hg-filter="activity"]').click();
    await win.waitForFunction(() => document.querySelector('.hg-runtime-info')?.textContent.includes('Studio website'));
    const activity = await win.evaluate(() => window.radial.workspaceActivity());
    assert.equal(activity.projects.filter(p => p.server).length, 1);
    assert.ok(activity.projects[0].server!.startedAt! > 0);
    await shot('home-live-activity');
    await win.locator('.hg-runtime').first().click();
    await win.waitForFunction(() => !homeActive);
    await win.locator('#publishBtn').click();
    await win.locator('#publishMenu').waitFor({ state: 'visible' });
    await shot('08-publish-app');
    const publishMenu = win.locator('#publishMenu');
    assert.equal(await publishMenu.getByRole('checkbox', { name: 'Staging', exact: true }).isVisible(), true);
    assert.equal(await publishMenu.getByRole('checkbox', { name: 'Production', exact: true }).isVisible(), true);
    await publishMenu.getByRole('button', { name: 'Publish settings', exact: true }).click();
    await publishMenu.getByRole('textbox', { name: 'Staging branch', exact: true }).waitFor();
    assert.equal(await win.locator('dialog[open]').count(), 0, 'publishing settings stay in the card');
    await publishMenu.getByRole('button', { name: 'Cancel', exact: true }).click();
    await win.evaluate(() => closePublishMenu());
    for (const id of ['content', 'code', 'layers', 'page', 'publish'] as const) {
      await win.evaluate((id) => openToolPanel(id), id);
      await shot(`panel-${id}`);
      await win.evaluate((id) => closeToolPanel(id), id);
    }
    await win.evaluate(() => openSettings('project'));
    await shot('09-project-settings');
    assert.deepEqual(errors, []);
    console.log(`Workspace screenshots: ${scratch}`);
  } finally {
    await Promise.race([app.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 8000))]);
    try { if (app.process().exitCode === null) app.process().kill('SIGKILL'); } catch {}
  }
});
