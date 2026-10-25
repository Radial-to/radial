/// <reference path="../src/renderer/types.d.ts" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OpenProjectOptions, OpenProjectResult, PtyInfo, RadialApi, SleptAgent } from '../src/shared/radialApi.ts';
import type { ChatEngine } from '../src/shared/chatPermissions.ts';
import { launchApp } from './support/app.ts';

// What the page functions reach in Radial's window: the preload's API and
// renderer.ts's project and terminal helpers, typed with the window's own
// shapes (src/renderer/types.d.ts Tab, AnyTab, TermSession).
/**
 * termList(null) lists every project's terminals (main terminal.list), which
 * RadialApi's signature leaves out. Drop this override once radialApi.ts widens
 * termList to `repoDir?: string | null`.
 */
type PageRadialApi = Omit<RadialApi, 'termList'> & { termList(repoDir: string | null): Promise<PtyInfo[]> };
interface RadialWindow extends Window { radial: PageRadialApi }
declare const window: RadialWindow;
declare function openProjectPath(dir: string, opts?: OpenProjectOptions): Promise<OpenProjectResult & { repoDir?: string }>;
declare function activeTab(): Tab | null;
declare function addTerminal(tab: AnyTab | null | undefined, engine: ChatEngine | null): Promise<TermSession | null>;
declare function findTermById(id: string): TermSession | null;
declare function captureTypedTask(term: TermSession, data: string): void;
declare function startRenameTerm(projectId: string, termId: string, nameEl: Element): void;

// Polls check() every 100 ms until it answers something truthy, and fails with the
// label and its last answer after ms. page.waitForFunction can't wait on an async
// check: the promise it returns is truthy, so it stops at the first poll.
const until = async <T,>(label: string, ms: number, check: () => Promise<T>): Promise<NonNullable<T>> => {
  const t0 = Date.now(); let last: unknown;
  for (;;) {
    try { const value = await check(); if (value) return value; last = value; } catch (e) { last = (e as Error).message; }
    if (Date.now() - t0 >= ms) throw new Error(`timed out after ${ms} ms waiting for ${label} (last: ${JSON.stringify(last)})`);
    await new Promise(r => setTimeout(r, 100));
  }
};

test('submitted tasks get concise titles across reattachment while manual names stay fixed', { timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-task-title-'));
  const site = path.join(root, 'site'); fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>Title fixture</h1>');
  let app;
  try {
    app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules/.bin/electron'), args: ['.'], cwd: process.cwd(), env: { ...process.env, RADIAL_USERDATA: path.join(root, 'app'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof openProjectPath === 'function');
    const id = await page.evaluate(async dir => {
      await openProjectPath(dir);
      const term = await addTerminal(activeTab(), null);
      window.radial.termSetMeta(term!.id, { label: 'Claude Code' });
      return term!.id;
    }, site);
    const reopen = async () => {
      await page.reload();
      await page.waitForFunction(() => typeof openProjectPath === 'function');
      await page.evaluate(dir => openProjectPath(dir), site);
      await page.waitForFunction(id => !!findTermById(id), id);
    };
    const label = () => page.evaluate(id => findTermById(id)!.label, id);
    const submit = (prompt: string) => page.evaluate(({ id, prompt }) => {
      const term = findTermById(id)!; captureTypedTask(term, prompt); captureTypedTask(term, '\r');
    }, { id, prompt });
    await until("the terminal's label saved", 30000, () => page.evaluate(async id => (await window.radial.termList(null)).find(t => t.id === id)?.meta.label === 'Claude Code', id));
    await reopen();
    assert.equal(await page.evaluate(id => findTermById(id)!._renamed, id), false);
    await page.evaluate(id => captureTypedTask(findTermById(id)!, '\x1b[200~Can you please fix the login button?\x1b[201~'), id);
    assert.equal(await label(), 'Claude Code', 'pasting does not rename before submission');
    await submit('');
    assert.equal(await label(), 'Fix the login button');
    await until('the task title saved as automatic', 30000, () => page.evaluate(async id => (await window.radial.termList(null)).find(t => t.id === id)?.meta.labelSource === 'auto', id));
    await reopen();
    await submit('Please improve sidebar spacing');
    assert.equal(await label(), 'Improve sidebar spacing', 'automatic naming still works after reload');
    await submit('yes');
    assert.equal(await label(), 'Improve sidebar spacing');
    const row = page.locator(`.rail-recent[data-tid="${id}"]`);
    await page.evaluate(id => {
      const row = document.querySelector<HTMLElement>(`.rail-recent[data-tid="${id}"]`)!;
      startRenameTerm(row.dataset.id!, id, row.querySelector('.rail-term-name')!);
    }, id);
    await row.locator('input').fill('My custom chat');
    await row.locator('input').press('Enter');
    await until('the rename saved as manual', 30000, () => page.evaluate(async id => (await window.radial.termList(null)).find(t => t.id === id)?.meta.labelSource === 'manual', id));
    await reopen();
    await submit('Fix the checkout form');
    assert.equal(await label(), 'My custom chat');
    const restored = await page.evaluate(async dir => {
      window.radial.stateSave(dir, { sleptAgents: [{ id: 'title-auto', engine: null, label: 'Improve navigation', labelSource: 'auto' }, { id: 'title-manual', engine: null, label: 'Old task', labelSource: 'auto' }] as SleptAgent[] }); // fixtures without sleptAt, which nothing reads
      await window.radial.stateGet(dir);
      const renamed = await window.radial.termRenameSlept(dir, 'title-manual', 'Keep this name');
      const auto = await window.radial.termStart(dir, 80, 24, undefined, { restoreOf: 'title-auto' });
      const manual = await window.radial.termStart(dir, 80, 24, undefined, { restoreOf: 'title-manual' });
      const sessions = await window.radial.termList(dir);
      return { renamed: renamed.ok, auto: sessions.find(t => t.id === auto.id)!.meta, manual: sessions.find(t => t.id === manual.id)!.meta };
    }, site);
    assert.equal(restored.renamed, true);
    assert.equal(restored.auto.labelSource, 'auto');
    assert.equal(restored.manual.label, 'Keep this name');
    assert.equal(restored.manual.labelSource, 'manual');

  } finally { await app?.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
});
