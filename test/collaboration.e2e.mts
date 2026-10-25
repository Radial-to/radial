import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { CollaborationPlan, CollaborationPlanOptions, CollaborationPlanResult, RadialConfig, ReviewAction, ReviewOptions } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// The window's globals the test calls (renderer.ts and the publish scripts),
// as far as it uses them.
declare function activeTab(): { repoDir: string } | null;
declare function openCollaboration(page?: 'changes' | 'pulls'): Promise<void>;
declare function closePublishMenu(): void;
declare function openToolPanel(id: 'publish'): void;
declare function openPublishSurface(): void;
declare function publishPinToDock(): void;
declare function applyTheme(theme: string): void;
declare function openSettings(mode?: 'global' | 'project'): void;
declare function renderSettings(): Promise<void>;
declare const RadialPublish: { open(host: HTMLElement, page: 'review'): void; draft(dir: string): { message: string }; refresh(): void };
declare const window: Window & typeof globalThis & { RadialCollaboration?: { isBusy(): boolean } };

// The main process: what the preload sends with collaboration:review and
// collaboration:plan, the review calls the fake handler records on globalThis,
// and Electron's private map of ipcMain.handle handlers, so one can be wrapped.
// The two payloads are the preload's (preload.ts collaborationReview and
// collaborationPlan, read by main.ts's handlers). They belong exported from
// src/shared/radialApi.ts, outside this unit: the main.ts wave should export
// them there and this file should import them in place of these copies.
/** collaboration:review's payload: each action with its own options. */
type CollaborationReviewRequest = { [A in ReviewAction]: { repoDir: string; action: A; opts?: ReviewOptions[A] } }[ReviewAction];
/** collaboration:plan's payload. */
interface CollaborationPlanRequest { repoDir: string; opts?: CollaborationPlanOptions }
type ReviewCall = Pick<CollaborationReviewRequest, 'action' | 'opts'>;
type MainGlobals = typeof globalThis & { collaborationReviewCalls: ReviewCall[] };
type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type IpcMainHandlers = IpcMain & { _invokeHandlers: Map<string, InvokeHandler> };
type PlanHandler = (event: IpcMainInvokeEvent, args: CollaborationPlanRequest) => Promise<CollaborationPlanResult>;

test('publish panel: inline diffs, local Git integration, settings, and PR review', { timeout: 120000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-collab-ui-'));
  const fixture = path.join(scratch, 'site'); fs.mkdirSync(fixture);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(fixture, '.gitignore'), '.radial/\n.radial.json\n.vercelignore\n');
  fs.writeFileSync(path.join(fixture, 'index.html'), '<title>Team fixture</title><h1>Original headline</h1>');
  git('add', '.'); git('commit', '-qm', 'Initial');
  fs.writeFileSync(path.join(fixture, 'index.html'), '<title>Team fixture</title><h1>Updated headline</h1>');
  const app = await launchApp({ executablePath: path.join(process.cwd(), 'node_modules/.bin/electron'), args: ['.'],
    env: { ...process.env, RADIAL_USERDATA: path.join(scratch, 'user'), RADIAL_OPEN: fixture, RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  const errors: string[] = [];
  try {
    const win = await app.firstWindow(); win.setDefaultTimeout(15000); win.on('pageerror', error => errors.push(error.message));
    await win.waitForFunction(() => typeof activeTab === 'function' && activeTab()?.repoDir && window.RadialCollaboration);
    await win.locator('#appSplash').waitFor({ state: 'hidden' });
    await win.evaluate(() => openCollaboration());
    const dialog = win.locator('#publishMenu .collab-embedded');
    await dialog.locator('.collab-file-row').filter({ hasText: 'index.html' }).getByRole('button', { name: 'Working diff' }).click();
    await win.waitForFunction(() => document.querySelector('diffs-container')?.shadowRoot?.textContent.includes('<title>Team fixture</title><h1>Updated headline'));
    await dialog.getByRole('button', { name: 'Split', exact: true }).click();
    assert.equal(await dialog.getByRole('button', { name: 'Split', exact: true }).getAttribute('aria-pressed'), 'true');
    await win.waitForFunction(() => document.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-diff-type="split"]'));
    await win.screenshot({ path: '/tmp/radial-collaboration-changes.png' });
    await dialog.getByRole('button', { name: 'Create branch', exact: true }).click();
    await dialog.getByLabel('Branch name', { exact: true }).fill('homepage-copy');
    await win.keyboard.press('Enter');
    await dialog.getByRole('heading', { name: 'Local changes' }).waitFor();
    assert.equal(git('branch', '--show-current'), 'homepage-copy');
    assert.ok(fs.readFileSync(path.join(fixture, 'index.html'), 'utf8').includes('Updated headline'));
    await dialog.getByRole('button', { name: 'Commit…', exact: true }).click();
    await dialog.getByLabel('Commit message (optional)').fill('Update homepage copy');
    await dialog.getByRole('button', { name: 'Commit locally', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Git operation complete' }).waitFor();
    assert.equal(git('log', '-1', '--format=%s'), 'Update homepage copy');
    assert.equal(git('remote'), '');
    await dialog.getByRole('button', { name: 'Back to publish', exact: true }).first().click();
    await win.evaluate(() => closePublishMenu());
    // One draft survives the compact surface, pinning, file review, and integration.
    const remote = path.join(scratch, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote]);
    git('remote', 'add', 'origin', remote); git('push', '-q', 'origin', 'HEAD:main');
    const peer = path.join(scratch, 'peer');
    execFileSync('git', ['clone', '-q', remote, peer]);
    const other = (...args: string[]) => execFileSync('git', args, { cwd: peer, stdio: 'pipe' });
    other('config', 'user.name', 'Teammate'); other('config', 'user.email', 'peer@example.invalid');
    fs.writeFileSync(path.join(peer, 'about.html'), '<h1>Team contribution</h1>');
    other('add', '.'); other('commit', '-qm', 'Teammate page'); other('push', '-q');
    fs.writeFileSync(path.join(fixture, 'local.txt'), 'Local contribution'); git('add', 'local.txt');
    await win.evaluate(() => openToolPanel('publish'));
    await win.evaluate(() => openPublishSurface());
    const menu = win.locator('#publishMenu');
    await menu.locator('summary.pm-disclosure').focus();
    await win.keyboard.press('Space');
    assert.equal(await menu.locator('details.pm-github-details').getAttribute('open'), '');
    await menu.locator('summary.pm-disclosure').click();
    await menu.getByRole('checkbox', { name: 'Production', exact: true }).check();
    assert.equal(await menu.getByLabel('Commit message (optional)').count(), 0);
    await win.evaluate(() => RadialPublish.open(document.querySelector<HTMLElement>('#publishMenu')!, 'review'));
    await dialog.getByLabel('Commit message (optional)').fill('Publish the campaign');
    await dialog.getByRole('button', { name: 'Back to publish', exact: true }).first().click();
    await win.evaluate(() => publishPinToDock());
    const panel = win.locator('#publishPanelSurface');
    await panel.waitFor();
    assert.equal(await panel.getByRole('checkbox', { name: 'Production', exact: true }).isChecked(), true);
    await win.evaluate(() => openPublishSurface());
    await menu.waitFor();
    await menu.getByRole('checkbox', { name: 'Staging', exact: true }).check();
    assert.equal(await panel.getByRole('checkbox', { name: 'Staging', exact: true }).isChecked(), true);
    await menu.getByRole('checkbox', { name: 'Production', exact: true }).check();
    assert.equal(await panel.getByRole('checkbox', { name: 'Production', exact: true }).isChecked(), true);
    await win.evaluate(() => RadialPublish.open(document.querySelector<HTMLElement>('#publishMenu')!, 'review'));
    assert.equal(await dialog.getByLabel('Commit message (optional)').inputValue(), 'Publish the campaign');
    await dialog.getByLabel('Commit scope', { exact: true }).selectOption('staged');
    await dialog.locator('summary').filter({ hasText: 'local.txt' }).click();
    await dialog.locator('diffs-container').getByText('Local contribution', { exact: true }).waitFor();
    await win.screenshot({ path: '/tmp/radial-publish-review.png' });
    await dialog.getByRole('button', { name: 'Integrate 1 incoming commits first' }).click();
    await dialog.getByRole('button', { name: 'Update with fast-forward' }).click();
    await dialog.getByRole('heading', { name: 'Review push', exact: true }).waitFor();
    await dialog.getByLabel('Commit message (optional)').waitFor();
    assert.equal(await dialog.getByLabel('Destination', { exact: true }).inputValue(), 'production');
    assert.equal(await dialog.getByLabel('Commit message (optional)').inputValue(), 'Publish the campaign');
    assert.equal(await dialog.getByLabel('Commit scope', { exact: true }).inputValue(), 'staged');
    assert.ok(fs.existsSync(path.join(fixture, 'about.html')));
    await dialog.getByRole('button', { name: 'Commit and push to main', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Git operation complete', exact: true }).waitFor();
    assert.equal(git('log', '-1', '--format=%s'), 'Publish the campaign');
    assert.equal(execFileSync('git', ['--git-dir', remote, 'show', 'main:local.txt']).toString(), 'Local contribution');
    await dialog.getByRole('button', { name: 'Back to publish', exact: true }).first().click();
    assert.equal(await win.evaluate(() => RadialPublish.draft(activeTab()!.repoDir).message), '');
    await win.screenshot({ path: '/tmp/radial-publish-panel.png' });
    // The routine action uses the same real Git safety checks without entering review.
    fs.writeFileSync(path.join(fixture, 'quick-edit.txt'), 'A direct edit'); git('add', 'quick-edit.txt');
    await win.evaluate(() => RadialPublish.refresh());
    await menu.getByRole('button', { name: 'Commit and push to main', exact: true }).click();
    await win.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#pmPublish')!.disabled);
    assert.equal(execFileSync('git', ['--git-dir', remote, 'show', 'main:quick-edit.txt']).toString(), 'A direct edit');
    assert.equal(await dialog.count(), 0);
    // Resizing only changes layout. It must never click the publish action.
    const savedHead = git('rev-parse', 'HEAD');
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.webContents.setZoomFactor(window.getContentSize()[1] / 330);
    });
    await win.waitForTimeout(250);
    await menu.locator('summary.pm-disclosure').click();
    await win.waitForTimeout(250);
    assert.equal(await menu.isVisible(), true);
    assert.equal(await win.locator('dialog[open]').count(), 0);
    assert.equal(git('rev-parse', 'HEAD'), savedHead);
    assert.equal(await menu.evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    await app.evaluate(({ ipcMain }) => {
      (globalThis as MainGlobals).collaborationReviewCalls = [];
      const pr = { number: 4, title: 'Campaign launch', author: 'designer', head: 'campaign', base: 'main', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), state: 'open', mergeable: true, mergeState: 'clean', url: 'https://github.com/team/site/pull/4' };
      ipcMain.removeHandler('collaboration:review');
      ipcMain.handle('collaboration:review', (_e, { action, opts }: CollaborationReviewRequest) => {
        (globalThis as MainGlobals).collaborationReviewCalls.push({ action, opts });
        if (action === 'list') return { ok: true, prs: [pr] };
        if (action === 'detail') return { ok: true, pr, files: [{ file: 'index.html', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-Old headline\n+Campaign headline\n' }], reviews: [], checks: [{ name: 'Build', state: 'success' }], statuses: [], previews: [{ environment: 'Preview', state: 'success', url: 'https://preview.example.invalid' }], checksKnown: true, reviewsKnown: true, capabilities: { mergeMethods: ['squash'] } };
        if (action === 'review') return { ok: false, reason: 'changed', error: 'New commits arrived. Refresh and review them first.' };
        throw new Error('Unexpected test mutation');
      });
      const originalPlan = (ipcMain as IpcMainHandlers)._invokeHandlers.get('collaboration:plan') as PlanHandler;
      ipcMain.removeHandler('collaboration:plan');
      ipcMain.handle('collaboration:plan', async (_e, args: CollaborationPlanRequest) => { const plan = await originalPlan(_e, args); return { ...plan, deployment: { ...(plan as Partial<CollaborationPlan>).deployment, production: true, label: 'Configured for a Vercel production deployment.' } }; });
    });
    await win.waitForTimeout(300);
    await win.evaluate(async () => { applyTheme('light'); await openCollaboration('pulls'); });
    await dialog.getByRole('button', { name: '#4 Campaign launch' }).click();
    await dialog.getByRole('button', { name: 'Merge and deploy to production' }).waitFor();
    await dialog.getByText('modified index.html · +1 −1', { exact: true }).click();
    await dialog.locator('diffs-container').getByText('Campaign headline', { exact: true }).waitFor();
    assert.equal(await dialog.locator('diffs-container').getByText('a/file', { exact: true }).count(), 0);
    await win.screenshot({ path: '/tmp/radial-collaboration-review-light.png' });
    await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
    await dialog.getByText('New commits arrived. Refresh and review them first.', { exact: true }).waitFor();
    const reviewCalls = await app.evaluate(() => (globalThis as MainGlobals).collaborationReviewCalls);
    assert.deepEqual(reviewCalls.find(call => call.action === 'review')!.opts, { number: 4, sha: 'a'.repeat(40), event: 'APPROVE', body: '' });
    await dialog.getByRole('button', { name: 'Back to publish', exact: true }).first().click();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('setup:check');
      ipcMain.handle('setup:check', async () => ({ tools: {}, agent: {}, push: { isRepo: true, hasRemote: true } }));
    });
    await win.evaluate(() => openSettings('project'));
    const repoInput = win.getByRole('textbox', { name: 'GitHub repository', exact: true });
    await repoInput.fill('example/client-site');
    // A background status refresh must preserve the user's unsaved field.
    await win.evaluate(() => renderSettings());
    assert.equal(await repoInput.inputValue(), 'example/client-site');
    const headBefore = git('rev-parse', 'HEAD');
    await win.getByRole('button', { name: 'Save repository', exact: true }).click();
    await win.getByText('Repository saved. Use Incoming changes to fetch and review its updates.', { exact: true }).waitFor();
    assert.equal(git('remote', 'get-url', 'origin'), 'https://github.com/example/client-site.git');
    assert.equal(git('rev-parse', 'HEAD'), headBefore);
    assert.ok(fs.readFileSync(path.join(fixture, 'index.html'), 'utf8').includes('Updated headline'));
    const stageInput = win.getByRole('textbox', { name: 'Staging branch', exact: true });
    await stageInput.fill('client-preview');
    await win.evaluate(() => renderSettings());
    assert.equal(await stageInput.inputValue(), 'client-preview');
    await win.getByRole('button', { name: 'Save publishing settings', exact: true }).click();
    await win.getByText('Publishing settings saved.', { exact: true }).waitFor();
    // JSON.parse reads the Buffer as its text (it calls toString on its argument).
    assert.equal(((JSON.parse as (text: { toString(): string }) => unknown)(fs.readFileSync(path.join(fixture, '.radial.json'))) as Partial<RadialConfig>).stagingBranch, 'client-preview');
    await win.screenshot({ path: '/tmp/radial-project-repository-settings.png' });
    assert.deepEqual(errors, []);
  } catch (error) { await app.windows()[0]?.screenshot({ path: '/tmp/radial-publish-ui-failure.png' }).catch(() => {}); throw error; } finally { await app.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
});
