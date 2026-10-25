// Window drag areas stay where they are drawn. Chromium 152 (Electron 44) made
// app-region inherited: a child of a drag area is a drag area too unless it says
// otherwise, and Electron hit-tests drag areas by their boxes, unclipped and
// regardless of what is on top. So a child drawn outside its drag container (a
// menu, a popover, rail sections scrolled under the rail's header and footer)
// would drag the window there and stop clicks reaching what is under it, like
// the rail's collapse button. This audit finds every element that inherits drag
// from its parent and reaches outside the outermost drag area it sits in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { launchApp } from './support/app.ts';

// renderer.ts's top-level declarations, which page functions reach by name.
declare function openProjectPath(dir: string): Promise<{ ok: boolean }>;
declare function activeTab(): { _previewReady?: boolean } | null;
declare function showHome(): void;

/** An element the audit flags: its box, and the outermost drag area it inherits drag from. */
interface Stray { el: string; box: number[]; area: string; areaBox: number[] }

/** Elements whose computed app-region is drag, whose parent's is drag too, and whose box leaves the outermost drag ancestor's box. */
function strays(page: Page): Promise<{ inherited: number; strays: Stray[] }> {
  return page.evaluate(() => {
    const region = (el: Element) => getComputedStyle(el).getPropertyValue('-webkit-app-region');
    const name = (el: Element) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
    const box = (r: DOMRect) => [r.left, r.top, r.right, r.bottom].map(Math.round);
    let inherited = 0;
    const found: Stray[] = [];
    for (const el of document.querySelectorAll('body *')) {
      if (region(el) !== 'drag' || !el.parentElement || region(el.parentElement) !== 'drag') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      inherited++;
      let area: Element = el.parentElement;
      while (area.parentElement && region(area.parentElement) === 'drag') area = area.parentElement;
      const a = area.getBoundingClientRect();
      if (r.left < a.left - 0.5 || r.top < a.top - 0.5 || r.right > a.right + 0.5 || r.bottom > a.bottom + 0.5) found.push({ el: name(el), box: box(r), area: name(area), areaBox: box(a) });
    }
    return { inherited, strays: found };
  });
}

test('drag areas never reach past the rail, toolbar, canvas header and dock tabs they belong to', { timeout: 120000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-drag-'));
  // Enough projects that the rail's list scrolls.
  const sites = Array.from({ length: 12 }, (_, i) => {
    const dir = path.join(scratch, `site-${i + 1}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><title>Site ${i + 1}</title><h1>Site ${i + 1}</h1>`);
    return dir;
  });
  const recents = sites.map((dir, i) => ({ path: dir, name: `Site ${i + 1}`, kind: 'local', lastOpened: Date.now() - i * 60000 }));
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents, session: { open: [], active: null } }));
  const app = await launchApp({
    executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'),
    args: process.env.RADIAL_APP_PATH ? [] : ['.'],
    env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' },
  });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1300, 760));
    await win.waitForFunction(() => typeof openProjectPath === 'function');
    await win.locator('#appSplash').waitFor({ state: 'hidden' });
    const seen: Record<string, Awaited<ReturnType<typeof strays>>> = {};
    seen.home = await strays(win);
    for (const dir of sites.slice(0, 8)) await win.evaluate((d) => openProjectPath(d), dir);
    await win.waitForFunction(() => !!activeTab()?._previewReady, null, { timeout: 30000 });
    assert.ok(await win.evaluate(() => { const list = document.getElementById('railProjects')!; return list.scrollHeight > list.clientHeight; }), 'the rail list overflows, so its sections can scroll under the header and footer');
    seen.projects = await strays(win);
    await win.evaluate(() => { const list = document.getElementById('railProjects')!; list.scrollTop = list.scrollHeight; });
    seen.railScrolled = await strays(win);
    await win.locator('#railCollapse').click();
    await win.waitForFunction(() => document.body.classList.contains('rail-collapsed'));
    seen.railCollapsed = await strays(win);
    await win.locator('#railReopen').click();
    await win.evaluate(() => showHome());
    seen.homeWithProjects = await strays(win);
    assert.ok(Object.values(seen).some((state) => state.inherited > 0), 'the audit saw elements that inherit drag');
    for (const [state, { strays: found }] of Object.entries(seen)) assert.deepEqual(found, [], `${state}: elements that would drag the window outside their drag area`);
  } finally {
    await app.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
