import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RadialApi } from '../src/shared/radialApi.ts';
import type { ChatEngine } from '../src/shared/chatPermissions.ts';
import { launchApp } from './support/app.ts';

// The window's globals the test calls (renderer.ts and nativeChat.js), as far
// as it uses them. RadialNativeChat is optional because the test probes it
// while the window's scripts are still loading; it's there once that wait ends.
interface HomeTab { id: 'home'; home: true; repoDir: string | null }
declare const homeTab: HomeTab;
declare function showHomeDock(): void;
declare const window: Window & typeof globalThis & {
  radial: RadialApi;
  RadialNativeChat?: { enabled(): boolean; createFor(tab: HomeTab, engine?: ChatEngine): Promise<void>; select(id: string): Promise<void> };
};

function pdf() {
  const content = '0.2 0.5 0.8 rg 20 20 160 160 re f';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let text = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(text);
}
const png = { name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64') };
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
test('Fluid previews render locally and queued messages can be moved, edited and removed', { timeout: 60000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-fluid-files-'));
  fs.writeFileSync(path.join(scratch, 'radial-store.json'), JSON.stringify({ projectsDir: scratch, recents: [], session: { open: [], active: null } }));
  const app = await launchApp({ executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], env: { ...process.env, RADIAL_USERDATA: scratch, RADIAL_CHAT_EXPERIMENT: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1' } });
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') console.log('Renderer:', message.text()); });
    await page.waitForFunction(() => window.RadialNativeChat?.enabled() && typeof homeTab !== 'undefined' && homeTab.repoDir);
    await page.evaluate(() => showHomeDock());
    const form = page.locator('#nativeChatForm'), input = page.locator('#nativeChatInput');
    await form.locator('input[type=file]').setInputFiles([png, { name: 'layout.pdf', mimeType: 'application/pdf', buffer: pdf() }, { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('broken') }]);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.chat-context-chip img')].filter(img => img.naturalWidth > 0).length === 2);
    assert.equal((await page.evaluate(() => window.radial.nativeChatList())).length, 0, 'previews do not start a session');
    await form.getByRole('button', { name: 'Preview first page of layout.pdf', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector<HTMLImageElement>('.chat-image-dialog img')?.naturalWidth ?? 0) > 0);
    await page.locator('.chat-image-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await form.getByRole('button', { name: 'Preview first page of broken.pdf', exact: true }).isDisabled(), true);
    await form.getByRole('button', { name: 'Remove broken.pdf', exact: true }).click();
    await page.screenshot({ path: path.join(scratch, 'fluid-pdf-preview.png') });
    await input.fill('Rich response demo with files'); await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('.native-chat-message.assistant') && document.querySelector<HTMLButtonElement>('#nativeChatStop')!.hidden);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.chat-sent-attachment img')].filter(img => img.naturalWidth > 0).length === 2);
    const id = (await page.locator('#nativeChatToolbar').getAttribute('data-chat-id'))!;
    await input.fill('Show working indicator'); await input.press('Enter');
    await page.locator('#nativeChatWorking').waitFor({ state: 'visible' });
    await form.locator('input[type=file]').setInputFiles(png);
    for (const text of ['First follow-up', 'Second follow-up', 'Third follow-up']) {
      await input.fill(text); await page.getByRole('button', { name: 'Queue message', exact: true }).click();
    }
    await page.waitForFunction(() => document.querySelectorAll('[data-queue-id]').length === 3);
    const last = page.locator('[data-queue-id]').last(); await last.focus(); await last.press('Alt+ArrowUp');
    await until('the moved message second in the saved queue', 30000, () => page.evaluate(async id => (await window.radial.nativeChatGet(id)).queue![1]?.text === 'Third follow-up', id));
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-queue-id') === document.querySelectorAll('[data-queue-id]')[1]?.getAttribute('data-queue-id'));
    // Drag the first row beneath its siblings; the backend only receives the final order.
    const firstBox = (await page.locator('[data-queue-id]').first().boundingBox())!, lastBox = (await page.locator('[data-queue-id]').last().boundingBox())!;
    await page.mouse.move(firstBox.x + 80, firstBox.y + firstBox.height / 2); await page.mouse.down();
    await page.mouse.move(firstBox.x + 80, lastBox.y + lastBox.height + 10, { steps: 20 }); await page.mouse.up();
    await until('the dragged message last in the saved queue', 30000, () => page.evaluate(async id => (await window.radial.nativeChatGet(id)).queue!.at(-1)?.text === 'First follow-up', id));
    await page.locator('#nativeChatStop').click(); await page.getByRole('button', { name: 'Resume queue', exact: true }).waitFor();
    await page.screenshot({ path: path.join(scratch, 'fluid-queue.png') });
    await page.locator('[data-queue-id]').last().press('Enter');
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('#nativeChatInput')!.value === 'First follow-up');
    await form.getByRole('button', { name: 'Remove reference.png', exact: true }).waitFor();
    assert.equal((await page.evaluate(id => window.radial.nativeChatGet(id), id)).queuePaused, true);
    await page.locator('[data-queue-id]').first().press('Delete');
    await until('one message left in the saved queue', 30000, () => page.evaluate(async id => (await window.radial.nativeChatGet(id)).queue!.length === 1, id));
    assert.equal(await input.inputValue(), 'First follow-up', 'remove never replaces an edited draft');
    assert.equal(await form.locator('[role=status]').count(), 0);
    await page.screenshot({ path: path.join(scratch, 'fluid-preview-draft.png') });
    await page.evaluate(() => window.RadialNativeChat!.createFor(homeTab));
    assert.equal(await input.inputValue(), '');
    assert.equal(await form.locator('.chat-context-chip').count(), 0);
    await page.evaluate(id => window.RadialNativeChat!.select(id), id);
    assert.equal(await input.inputValue(), 'First follow-up');
    await form.getByRole('button', { name: 'Remove reference.png', exact: true }).waitFor();
    await form.evaluate(el => { el.style.width = '290px'; });
    assert.equal(await form.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await page.screenshot({ path: path.join(scratch, 'fluid-attachments-compact.png') });
    assert.deepEqual(errors, []);
    console.log('Fluid attachments/queue screenshots:', scratch);
  } finally { await app.close(); }
});
