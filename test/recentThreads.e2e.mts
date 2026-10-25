/// <reference path="../src/renderer/types.d.ts" />
// The window's own shapes (Tab, AnyTab, AgentHost, TermSession, AgentPrompt) come from types.d.ts above.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ChatEngine } from '../src/shared/chatPermissions.ts';
import type { OpenProjectOptions, OpenProjectResult, PtyInfo, RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

/**
 * The app window (page functions run there): the preload's API (src/renderer/globals.d.ts).
 * termList also takes null, for every project's terminals (terminal.ts list), which RadialApi's termList leaves out.
 * Drop this override once radialApi.ts widens termList to `repoDir?: string | null`.
 */
declare const window: Window & typeof globalThis & { radial: Omit<RadialApi, 'termList'> & { termList(repoDir: string | null): Promise<PtyInfo[]> } };
// renderer.ts's top-level declarations, which page functions reach by name.
declare const tabs: Tab[];
declare function activeTab(): Tab | null;
declare function activeTerm(tab: Pick<AgentHost, 'terminals' | 'activeTerminalId'>): TermSession | null;
declare function findTermById(id: string): TermSession | null;
declare function openProjectPath(dir: string, opts?: OpenProjectOptions): Promise<OpenProjectResult & { repoDir?: string }>;
declare function addTerminal(tab: AnyTab | null | undefined, engine: ChatEngine | null): Promise<TermSession | null>;
declare function loadRoute(route: string, li?: HTMLElement | null, tab?: Tab | null, onComplete?: () => void): void;
declare function renderProjectsRail(): void;
declare function markTermActivity(tab: AnyTab | null | undefined, term: TermSession): void;
declare function showTerminal(tab: AnyTab, term: TermSession | null | undefined): Promise<TermSession | null>;
/** Hands the agent a prompt: submit runs it now, otherwise it waits in the terminal. */
declare function quickEditToTerminal(tab: AnyTab, termId: string, payload: AgentPrompt): Promise<boolean | undefined>;
declare function reattachProjectTerminals(tab: AnyTab): Promise<void>;

test('Recents switches project, agent, and preview without duplicating sessions', { timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-recent-threads-'));
  const dirs = ['First site', 'Second site'].map(name => {
    const dir = path.join(root, name); fs.mkdirSync(dir);
    for (const file of ['index.html', 'about.html']) fs.writeFileSync(path.join(dir, file), `<!doctype html><html><title>${name}</title><body><h1>${name} ${file}</h1></body></html>`);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Initial'], { cwd: dir });
    return dir;
  });
  let app;
  try {
    app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules/.bin/electron'), args: ['.'], cwd: process.cwd(),
      env: { ...process.env, RADIAL_USERDATA: path.join(root, 'app'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1', RADIAL_DEMO_FRESH: '1' } });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(() => typeof openProjectPath === 'function');
    async function openThread(dir: string, label: string, route: string) {
      const result = await page.evaluate(async ({ dir, label, route }) => {
        await openProjectPath(dir);
        const tab = activeTab()!, term = (await addTerminal(tab, null))!;
        term.label = label; term._renamed = true; window.radial.termSetMeta(term.id, { label });
        await new Promise<void>(resolve => loadRoute(route, null, tab, resolve));
        renderProjectsRail();
        return { id: term.id, projectId: tab.id, baseUrl: tab.baseUrl };
      }, { dir, label, route });
      await page.keyboard.type('echo task');
      await page.keyboard.press('Enter');
      return result;
    }
    const first = await openThread(dirs[0], 'First task', '/about.html');
    const second = await openThread(dirs[1], 'Second task', '/');
    const countBefore = (await page.evaluate(() => window.radial.termList(null))).length;
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), second.id);
    assert.equal(await page.locator(`.rail-recent[data-tid="${first.id}"]`).innerText(), 'First task');
    await page.locator('[data-section="projects"]').click();
    assert.equal(await page.locator('#railSection-projects').isVisible(), false);
    await page.locator(`.rail-recent[data-tid="${second.id}"]`).focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.tid), first.id, 'keyboard navigation skips collapsed project rows');
    await page.locator(`.rail-recent[data-tid="${first.id}"]`).click();
    await page.waitForFunction(({ id, dir }) => activeTab()?.repoDir === dir && activeTab()!.activeTerminalId === id && activeTab()!.currentRoute === '/about.html' && !activeTab()!._threadPreview?.restoring, { id: first.id, dir: dirs[0] });
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), second.id, 'navigation preserves order');
    // Recents uses the same actions even while the Projects drawer is collapsed.
    const firstRecent = page.locator(`.rail-recent[data-tid="${first.id}"]`);
    await firstRecent.hover();
    await firstRecent.locator('.rail-more').click();
    assert.deepEqual(await page.locator('#railCtxMenu button').allTextContents(), ['Rename', 'Pin chat', 'Keep awake', 'Close agent']);
    await page.locator('#railCtxMenu [data-act="rename"]').click();
    const rename = firstRecent.locator('.rail-term-rename');
    await rename.fill('Renamed recent task');
    await page.evaluate(() => renderProjectsRail());
    assert.equal(await rename.inputValue(), 'Renamed recent task', 'sidebar updates preserve recent-row renaming');
    await rename.press('Enter');
    assert.equal(await firstRecent.locator('.rail-term-name').innerText(), 'Renamed recent task');
    assert.equal(await page.evaluate(id => document.querySelector(`.rail-recent[data-tid="${id}"]`) === document.activeElement, first.id), true);
    await firstRecent.click({ button: 'right' });
    assert.deepEqual(await page.locator('#railCtxMenu button').allTextContents(), ['Rename', 'Pin chat', 'Keep awake', 'Close agent']);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(id => document.querySelector(`.rail-recent[data-tid="${id}"] .rail-more`) === document.activeElement, first.id), true);
    await firstRecent.hover();
    await firstRecent.locator('.rail-more').click();
    await page.locator('#railCtxMenu [data-act="awake"]').click();
    await page.waitForFunction(id => findTermById(id)?.keepAwake === true, first.id);
    await firstRecent.click({ button: 'right' });
    assert.equal(await page.locator('#railCtxMenu [data-act="awake"]').innerText(), 'Let it sleep');
    await page.locator('#railCtxMenu [data-act="awake"]').click();
    await page.waitForFunction(id => findTermById(id)?.keepAwake === false, first.id);
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), second.id, 'menu actions do not reorder Recents');
    await firstRecent.click();

    await page.keyboard.type('echo next task');
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), second.id, 'typing alone preserves order');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), first.id, 'submission moves a renamed thread to the top');
    // Output and an automatic agent reveal do not reorder already-visited threads.
    await page.evaluate(id => {
      const tab = tabs.find(t => t.terminals?.some(term => term.id === id))!;
      const term = tab.terminals!.find(t => t.id === id)!;
      markTermActivity(tab, term);
      return showTerminal(tab, term);
    }, second.id);
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), first.id);
    await page.evaluate(dir => window.radial.sleepProject(dir), dirs[1]);
    await page.locator(`.rail-recent[data-tid="${second.id}"]`).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(id => activeTab()?.activeTerminalId === id && !activeTab()!.suspended && !activeTab()!._threadPreview?.restoring, second.id);
    assert.equal(await page.evaluate(() => activeTab()!.repoDir), dirs[1]);
    assert.equal((await page.evaluate(() => window.radial.termList(null))).length, countBefore);
    assert.equal(await page.locator('webview').count(), 2, 'one preview per project');
    assert.equal(app.windows().filter(w => w.url().includes('/renderer/index.html')).length, 1);
    await page.reload();
    await page.waitForFunction(() => typeof openProjectPath === 'function');
    for (const dir of dirs) await page.evaluate(dir => openProjectPath(dir), dir);
    await page.waitForFunction(id => !!document.querySelector(`.rail-recent[data-tid="${id}"]`), second.id);
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), first.id, 'task order survives reattachment');
    assert.equal(await page.locator('#railSection-projects').isVisible(), false);
    await page.locator(`.rail-recent[data-tid="${first.id}"]`).click();
    await page.waitForFunction(id => activeTab()?.activeTerminalId === id && !activeTab()!._threadPreview?.restoring, first.id);
    // Staging visual-context text is not a submission; manual Enter is.
    await page.locator(`.rail-recent[data-tid="${second.id}"]`).click();
    await page.evaluate(async () => {
      const tab = activeTab()!;
      await quickEditToTerminal(tab, tab.activeTerminalId!, { text: 'echo staged task', submit: false });
    });
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), first.id);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), second.id);
    await page.locator(`.rail-recent[data-tid="${first.id}"]`).click();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), second.id, 'empty Enter does not promote');
    await page.keyboard.type('echo newest task'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), first.id);
    // Pinned rows stay above new tasks, persist on reattach, and can be unpinned.
    // Pin lives in the row's ⋯ menu; rows show no pin button, only a marker once pinned.
    const pinFromMenu = async (row: string, label: string) => {
      await page.locator(row).hover();
      await page.locator(`${row} .rail-more`).click();
      assert.equal(await page.locator('#railCtxMenu [data-act="pin"]').textContent(), label);
      await page.locator('#railCtxMenu [data-act="pin"]').click();
    };
    assert.equal(await page.locator('.rail-thread button[aria-label="Pin chat"]').count(), 0, 'no pin button on rows');
    await pinFromMenu(`.rail-recent[data-tid="${second.id}"]`, 'Pin chat');
    assert.equal(await page.locator(`.rail-recent[data-tid="${second.id}"] .rail-pinned`).count(), 1, 'a pinned row shows its marker');
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), second.id);
    assert.equal(await page.locator(`.rail-recent[data-tid="${second.id}"]`).getAttribute('title'), null);
    await page.locator(`.rail-recent[data-tid="${first.id}"]`).click();
    await page.keyboard.type('echo after pin'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), second.id);
    await page.reload();
    await page.waitForFunction(() => typeof openProjectPath === 'function');
    for (const dir of dirs) await page.evaluate(dir => openProjectPath(dir), dir);
    await page.waitForFunction(id => !!document.querySelector(`.rail-recent[data-tid="${id}"].pinned`), second.id);
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), second.id);
    await pinFromMenu(`.rail-recent[data-tid="${second.id}"]`, 'Unpin chat');
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), first.id);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#railSection-recents')!).rowGap === '1px');
    // Pinning from a project row updates the same chat in Recents.
    await page.locator('[data-section="projects"]').click();
    await page.locator(`.rail-term[data-tid="${second.id}"] .rail-more`).focus();
    await page.evaluate(() => renderProjectsRail());
    assert.equal(await page.evaluate(id => document.querySelector(`.rail-term[data-tid="${id}"] .rail-more`) === document.activeElement, second.id), true, 'background sidebar redraw preserves keyboard focus');
    await pinFromMenu(`.rail-term[data-tid="${second.id}"]`, 'Pin chat');
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), second.id);
    assert.match((await page.locator(`.rail-term[data-tid="${second.id}"]`).getAttribute('class'))!, /\bpinned\b/);
    await pinFromMenu(`.rail-recent[data-tid="${second.id}"]`, 'Unpin chat');
    assert.doesNotMatch((await page.locator(`.rail-term[data-tid="${second.id}"]`).getAttribute('class'))!, /\bpinned\b/);
    await page.locator('[data-section="projects"]').click();

    // The header creates exactly one session in the chosen project and remembers its agent.
    await page.locator(`.rail-recent[data-tid="${first.id}"]`).click();
    await page.evaluate(dir => window.radial.sleepProject(dir), dirs[1]);
    const beforeCreate = (await page.evaluate(() => window.radial.termList(null))).length;
    await page.locator('.rail-new-chat').click();
    assert.equal(await page.locator('[data-chat-pick="project"]').getAttribute('data-project-id'), await page.evaluate(() => activeTab()!.id));
    const secondProjectId = await page.evaluate(dir => tabs.find(t => t.repoDir === dir)!.id, dirs[1]);
    await page.locator('[data-chat-pick="project"]').click();
    await page.locator(`[data-chat-choice="${secondProjectId}"]`).click();
    await page.locator('[data-chat-pick="agent"]').click();
    await page.locator('[data-chat-choice=""]').click();
    await page.screenshot({ path: path.join(os.tmpdir(), 'radial-recent-chat-picker.png') });
    await page.locator('.recent-chat-start').click();
    // The chat shows at once; its sleeping project wakes behind it. The rest reads the rail once that settles.
    await page.waitForFunction(({ dir, previous }) => activeTab()?.repoDir === dir && activeTerm(activeTab()!)?.id !== previous && !document.getElementById('termNewMenu') && !activeTab()!.suspended, { dir: dirs[1], previous: second.id });
    assert.equal((await page.evaluate(() => window.radial.termList(null))).length, beforeCreate + 1);
    assert.equal(await page.evaluate(() => activeTerm(activeTab()!)!.engine), null);
    assert.equal(await page.locator('.rail-recent').first().getAttribute('data-tid'), first.id, 'new empty chats do not bump tasks');
    await page.locator('.rail-new-chat').click();
    assert.equal(await page.locator('[data-chat-pick="project"]').getAttribute('data-project-id'), first.projectId, 'an empty chat in another project does not replace the most recently worked project');
    await page.locator('[data-chat-pick="project"]').click();
    await page.locator(`[data-chat-choice="${secondProjectId}"]`).click();
    assert.equal(await page.locator('[data-chat-pick="agent"]').getAttribute('data-engine'), '');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#termNewMenu').count(), 0);
    assert.equal(await page.evaluate(() => document.querySelector('.rail-new-chat') === document.activeElement), true);
    assert.equal((await page.evaluate(() => window.radial.termList(null))).length, beforeCreate + 1);
    await page.locator(`.rail-recent[data-tid="${first.id}"]`).click();
    // Titles scan only after a deliberate hover, using their full untruncated text. The delay is timed on the
    // page's own clock, from the pointer entering the row to the scan starting: a look 200 ms after hover()
    // raced the delay from here, and lost whenever a loaded machine held this side up for 300 ms more.
    await page.mouse.move(0, 0); // off the row the click left it on, so the hover enters it afresh
    await page.evaluate(id => {
      activeTerm(activeTab()!)!.label = 'Review the complete navigation and responsive layout across all marketing pages';
      renderProjectsRail();
      const row = `.rail-recent[data-tid="${CSS.escape(id)}"]`, times: { enter?: number; scan?: number } = {};
      (window as unknown as { titleScan: typeof times }).titleScan = times;
      document.addEventListener('mouseenter', e => { if ((e.target as Element).matches?.(row)) times.enter ??= performance.now(); }, true);
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
        if (this.matches(`${row} .rail-title-text`)) times.scan ??= performance.now();
        return animate.apply(this, args);
      };
    }, first.id);
    const recentTitle = page.locator(`.rail-recent[data-tid="${first.id}"] .rail-title-text`);
    await page.locator(`.rail-recent[data-tid="${first.id}"]`).hover();
    await page.waitForFunction(id => document.querySelector(`.rail-recent[data-tid="${id}"] .rail-title-text`)?.getAnimations().length === 1, first.id);
    const scan = await page.evaluate(() => (window as unknown as { titleScan: { enter?: number; scan?: number } }).titleScan);
    assert.ok(scan.enter !== undefined && scan.scan !== undefined && scan.scan - scan.enter >= 450, `hover delay avoids movement while passing through (${JSON.stringify(scan)})`);
    await page.waitForFunction(id => { const el = document.querySelector(`.rail-recent[data-tid="${id}"] .rail-title-text`); return !!el && getComputedStyle(el).transform !== 'none'; }, first.id); // and it moves the title
    const hoverCard = page.locator('#recentHoverCard');
    assert.equal(await hoverCard.getAttribute('role'), 'tooltip');
    assert.equal(await hoverCard.locator('.recent-hover-title').innerText(), await recentTitle.innerText());
    assert.match(await hoverCard.locator('.recent-hover-project').innerText(), /First site/);
    await hoverCard.hover(); await page.waitForTimeout(180);
    assert.equal(await hoverCard.isVisible(), true, 'card stays readable when the pointer enters it');
    await page.keyboard.press('Escape');
    assert.equal(await hoverCard.count(), 0);
    await firstRecent.focus();
    await page.waitForFunction(() => !!document.getElementById('recentHoverCard'));
    assert.equal(await firstRecent.getAttribute('aria-describedby'), 'recentHoverCard');
    await firstRecent.locator('.rail-more').focus();
    assert.equal(await hoverCard.count(), 0, 'action focus dismisses the card');
    await firstRecent.focus();
    await page.waitForFunction(() => !!document.getElementById('recentHoverCard'));
    // A redraw that replaces the rows (the rail keeps its rows when nothing on them changed, and whether something
    // did by now depends on what the window drew last).
    await page.evaluate(() => { (document.getElementById('railProjects') as HTMLElement & { _html?: string })._html = ''; renderProjectsRail(); });
    assert.equal(await hoverCard.count(), 0, 'rerender removes the stale card');

    // Project chats and Recents expose the same instant context and last-task age.
    await page.evaluate(id => { findTermById(id)!.recentTaskAt = Date.now() - 7 * 3600000; }, first.id);
    await page.locator('[data-section="projects"]').click();
    const projectChat = page.locator(`.rail-term[data-tid="${first.id}"]`);
    await projectChat.hover();
    assert.equal(await hoverCard.locator('.recent-hover-time').innerText(), '7h');
    assert.equal(await hoverCard.locator('.recent-hover-time').getAttribute('aria-label'), 'Last task 7h ago');
    assert.match(await hoverCard.locator('.recent-hover-project').innerText(), /First site/);
    assert.equal(await projectChat.getAttribute('aria-describedby'), 'recentHoverCard');
    const projectCard = await hoverCard.innerHTML();
    await firstRecent.hover();
    assert.equal(await hoverCard.innerHTML(), projectCard);
    await projectChat.focus();
    assert.equal(await projectChat.getAttribute('aria-describedby'), 'recentHoverCard');
    await projectChat.locator('.rail-more').focus();
    assert.equal(await hoverCard.count(), 0);
    await page.evaluate(id => { findTermById(id)!.recentTaskAt = 0; }, first.id);
    await projectChat.focus();
    assert.equal(await hoverCard.locator('.recent-hover-time').count(), 0, 'unknown activity has no invented timestamp');
    await page.locator('[data-section="projects"]').click();

    await page.locator('[data-home]').hover();
    assert.equal(await recentTitle.evaluate(el => el.getAnimations().length), 0);
    assert.equal(await recentTitle.evaluate(el => getComputedStyle(el).transform), 'none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator(`.rail-recent[data-tid="${first.id}"]`).hover();
    await page.waitForTimeout(650);
    assert.equal(await recentTitle.evaluate(el => el.getAnimations().length), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator(`.rail-recent[data-tid="${second.id}"]`).hover();
    await page.waitForTimeout(650);
    assert.equal(await page.locator(`.rail-recent[data-tid="${second.id}"] .rail-title-text`).evaluate(el => el.getAnimations().length), 0, 'short titles stay still');
    // Open and closed chevrons share a glyph and stay hidden until hover.
    const heading = page.locator('[data-section="recents"]');
    await page.locator('[data-home]').hover();
    await page.waitForTimeout(180);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-section="recents"] .rail-chevron')!).opacity === '0');
    await heading.hover(); await page.waitForTimeout(180);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-section="recents"] .rail-chevron')!).opacity === '1');
    const glyph = await heading.locator('svg').innerHTML();
    const transform = await heading.locator('.rail-chevron').evaluate(el => getComputedStyle(el).transform);
    await heading.click();
    assert.equal(await heading.locator('svg').innerHTML(), glyph);
    assert.notEqual(await heading.locator('.rail-chevron').evaluate(el => getComputedStyle(el).transform), transform);
    await page.locator('[data-home]').hover(); await page.waitForTimeout(180);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-section="recents"] .rail-chevron')!).opacity === '0');
    await heading.click();
    await page.locator(`.rail-recent[data-tid="${second.id}"]`).click();
    await firstRecent.hover();
    await firstRecent.locator('.rail-more').click();
    await page.locator('#railCtxMenu [data-act="close"]').click();
    await page.locator('#agentCloseConfirm [data-act="cancel"]').click();
    assert.equal(await firstRecent.count(), 1, 'cancel preserves the session');
    await firstRecent.click({ button: 'right' });
    await page.locator('#railCtxMenu [data-act="close"]').click();
    await page.locator('#agentCloseConfirm [data-act="close"]').click();
    assert.equal(await page.evaluate(() => activeTerm(activeTab()!)!.id), second.id, 'closing another project’s agent preserves the active chat');
    await page.waitForFunction(id => !document.querySelector(`.rail-recent[data-tid="${id}"]`), first.id);
    // Pinning a parked session updates its resume record without waking it.
    await page.evaluate(dir => window.radial.sleepProject(dir), dirs[1]);
    const sleptRecord = { id: 'parked-shell', engine: null, label: 'Parked task', recentTaskAt: 1, sleptAt: Date.now() };
    await page.evaluate(({ dir, record }) => {
      window.radial.stateSave(dir, { sleptAgents: [record] });
    }, { dir: dirs[1], record: sleptRecord });
    await page.evaluate(async ({ dir, record }) => {
      const tab = tabs.find(t => t.repoDir === dir)!;
      tab._sleptAgents = [record]; await reattachProjectTerminals(tab); renderProjectsRail();
    }, { dir: dirs[1], record: sleptRecord });
    await page.locator('.rail-recent[data-tid="slept:parked-shell"]').hover();
    await page.locator('.rail-recent[data-tid="slept:parked-shell"] .rail-more').click();
    await page.locator('#railCtxMenu [data-act="pin"]').click();
    const storedPin = await page.evaluate(async dir => (await window.radial.stateGet(dir)).sleptAgents![0].recentPinnedAt, dirs[1]);
    assert.ok(storedPin! > 0);
    assert.equal(await page.evaluate(dir => tabs.find(t => t.repoDir === dir)!.suspended, dirs[1]), true);
    await page.locator('.rail-recent[data-tid="slept:parked-shell"]').click();
    await page.waitForFunction(() => activeTerm(activeTab()!)?.label === 'Parked task' && !activeTerm(activeTab()!)!._slept);
    const resumed = await page.evaluate(async () => {
      const term = activeTerm(activeTab()!)!;
      const persisted = (await window.radial.termList(activeTab()!.repoDir)).find(t => t.id === term.id)!;
      return { pinned: term.recentPinnedAt, saved: persisted.meta.recentPinnedAt, at: persisted.meta.recentTaskAt };
    });
    assert.deepEqual(resumed, { pinned: storedPin, saved: storedPin, at: 1 });
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(os.tmpdir(), 'radial-recent-threads.png') });
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
