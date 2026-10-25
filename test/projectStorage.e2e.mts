import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import type { ElectronApplication } from 'playwright-core';
import type { ContextFileResult, OpenProjectResult, RadialApi } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the app's window carries that this check reaches (src/renderer/globals.d.ts, renderer.ts).
interface AppWindow extends Window { radial: RadialApi }
declare const window: AppWindow;
declare function openSettings(mode?: 'global' | 'project'): void;
declare function closeSettings(): void;
/** Opens a folder as a project (renderer.ts, answering OpenProjectResultWithDir); the check reads whether it worked and, if not, why: `error` reads on either branch, undefined when it opened. */
declare function openProjectPath(dir: string): Promise<OpenProjectResult & { repoDir?: string; error?: string }>;

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

test('machine and project storage controls persist, and local editing adds no repo metadata', { timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-storage-ui-'));
  const userData = path.join(root, 'app'), repo = path.join(root, 'site');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'index.html'), '<html><head><title>Storage test</title></head><body><h1>Original</h1></body></html>');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Shared rules\nDo not change this file.\n');
  const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']); git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Initial']);
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules/.bin/electron'), args: ['.'], cwd: process.cwd(),
      env: { ...process.env, RADIAL_USERDATA: userData, RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1', RADIAL_DEMO_FRESH: '1' } });
    const win = await app.firstWindow();
    await win.waitForFunction(() => typeof openSettings === 'function');
    await win.evaluate(() => openSettings('global'));
    const machine = win.getByRole('switch', { name: 'Keep Radial data local', exact: true });
    assert.equal(await machine.isChecked(), false);
    await machine.check();
    await until('machine storage saved as local', 30000, () => win.evaluate(async () => (await window.radial.projectDataGet()).defaultLocal));
    await machine.uncheck();
    await until('machine storage saved as not local', 30000, () => win.evaluate(async () => !(await window.radial.projectDataGet()).defaultLocal));
    await machine.check();
    await until('machine storage saved as local', 30000, () => win.evaluate(async () => (await window.radial.projectDataGet()).defaultLocal));
    await win.locator('#machineStorageSettings').screenshot({ path: '/tmp/radial-storage-machine.png' });
    await win.evaluate(() => closeSettings());
    const opened = await win.evaluate(dir => openProjectPath(dir), repo);
    assert.equal(opened.ok, true, opened.error);
    await win.locator('.rail-proj[data-id]').first().hover();
    await win.locator('.rail-proj[data-id]').first().getByRole('button', { name: 'Project menu', exact: true }).click();
    await win.locator('#railCtxMenu').getByRole('button', { name: 'Project settings', exact: true }).click();
    const choice = win.getByLabel('Storage for this project', { exact: true });
    await choice.waitFor();
    assert.equal(await choice.inputValue(), 'default');
    const saved = await win.evaluate(async dir => {
      const doc = await window.radial.contextCreate(dir, 'Private notes') as Extract<ContextFileResult, { ok: true }>;
      await window.radial.contextWrite(dir, doc.rel, 'Keep this private.');
      await window.radial.memoryAddRule(dir, 'Keep the billing note.');
      await window.radial.configSet(dir, { stagingBranch: 'preview' });
      return window.radial.projectDataGet(dir);
    }, repo);
    assert.equal(saved.local, true);
    assert.ok(!saved.folder!.startsWith(repo + path.sep));
    assert.equal(git(['status', '--porcelain']), '');
    assert.equal(fs.existsSync(path.join(repo, '.radial')), false);
    assert.equal(fs.existsSync(path.join(repo, '.radial.json')), false);
    assert.equal(fs.existsSync(path.join(repo, '.context')), false);
    assert.equal(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), '# Shared rules\nDo not change this file.\n');
    await choice.selectOption('local');
    await until("the project's storage saved as local", 30000, () => win.evaluate(async dir => (await window.radial.projectDataGet(dir)).preference === 'local', repo));
    await win.locator('#projectStorageSettings').screenshot({ path: '/tmp/radial-storage-project.png' });
    await win.evaluate(() => openSettings('global'));
    await machine.uncheck();
    await until('machine storage saved as not local', 30000, () => win.evaluate(async () => !(await window.radial.projectDataGet()).defaultLocal));
    assert.equal((await win.evaluate(dir => window.radial.projectDataGet(dir), repo)).local, true);
    await win.evaluate(() => openSettings('project'));
    await choice.selectOption('default');
    await until('the storage change to wait for a reopen', 30000, () => win.evaluate(async dir => (await window.radial.projectDataGet(dir)).pending, repo));
    assert.match(await win.locator('#radialStorageStatus').innerText(), /reopen/);
    await choice.selectOption('local');
    await until('no storage change waiting for a reopen', 30000, () => win.evaluate(async dir => !(await window.radial.projectDataGet(dir)).pending, repo));
    await win.reload();
    await win.waitForFunction(() => typeof openSettings === 'function');
    const retained = await win.evaluate(dir => window.radial.projectDataGet(dir), repo);
    assert.equal(retained.defaultLocal, false);
    assert.equal(retained.preference, 'local');
    assert.equal(git(['status', '--porcelain']), '');
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
