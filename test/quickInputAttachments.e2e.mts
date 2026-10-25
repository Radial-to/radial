import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElectronApplication } from 'playwright-core';
import type { WebviewTag } from 'electron';
import type { OpenProjectResult, OpenedProject } from '../src/shared/radialApi.ts';
import { launchApp } from './support/app.ts';

// What the app's window has that this test reaches inside win.evaluate:
// window scripts' top-level declarations (src/renderer/types.d.ts and
// renderer.ts have the full types), and the global the test's stub fills.
// They are declared as always there; the boot poll still guards them, because
// firstWindow() can resolve before the window's scripts have run.
/** An open project (renderer Tab), the fields used here. */
interface PageProjectTab { webview: WebviewTag }
/**
 * A canvas selection (renderer PreviewSelection), the fields used here. Narrow
 * on purpose: the pinned case hands showQuickEdit a deliberately partial
 * selection (selector, tag and rect only), which it tolerates.
 */
interface PageSelection { selector: string; tagName: string; rect: { x: number; y: number; w: number; h: number } }
/** A prompt for the agent (renderer AgentPrompt), the fields read here. */
interface PagePrompt { text?: string; selections?: PageSelection[]; images?: string[] }
/** openProjectPath's answer (renderer OpenProjectResultWithDir), its error readable on either branch (OpenedProject has no `error?: undefined` of its own yet). */
type OpenResult = (OpenedProject & { error?: undefined }) | (Extract<OpenProjectResult, { ok: false }> & { repoDir?: string });
declare const window: Window & typeof globalThis & { __quickInputSent?: PagePrompt | null };
declare let quickEdit: { tab: PageProjectTab; sels: PageSelection[] } | null;
declare let quickEditSending: boolean;
declare let quickEditToTerminal: (tab: PageProjectTab, termId: string, payload: PagePrompt) => Promise<boolean | undefined>;
declare function openProjectPath(dir: string): Promise<OpenResult>;
declare function activeTab(): PageProjectTab | null;
declare function setCanvasMode(mode: 'none' | 'select' | 'comment' | 'inspect' | 'draw' | 'text' | 'edit'): void;
declare function askBackToFloating(): void;
declare function askPinToDock(): void;
declare function showQuickEdit(tab: PageProjectTab, sel: PageSelection): void;

test('Select quick input: dropped images attach, survive redraws, and reach the agent in both homes', { timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-quick-input-'));
  const repo = path.join(root, 'site');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'index.html'), '<html><body><h1 id="hero">Marketing site</h1></body></html>');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
  const image = path.join(root, 'visual reference.png');
  const notes = path.join(root, 'brand notes.txt');
  fs.writeFileSync(image, png);
  fs.writeFileSync(notes, 'Brand notes');
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp({
      executablePath: process.env.RADIAL_APP_PATH || path.join(process.cwd(), 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], cwd: process.cwd(),
      // A project's Terminal-first chat runs a fixture CLI, never a real agent.
      env: { ...process.env, RADIAL_USERDATA: path.join(root, 'app'), RADIAL_OPEN: ' ', RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1', RADIAL_DEMO_FRESH: '1', RADIAL_CHAT_TEST_CLI: path.resolve('test/fixtures/codex-shared.cjs'), RADIAL_CHAT_TEST_CLAUDE: path.resolve('test/fixtures/native-interactive.cjs'), RADIAL_CHAT_TEST_CURSOR: path.resolve('test/fixtures/native-interactive.cjs'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CURSOR_CONFIG_DIR: path.join(root, 'cursor') },
    });
    const win = await app.firstWindow();
    const errors: string[] = [];
    win.on('pageerror', e => errors.push(e.message));
    await win.waitForFunction(() => typeof openProjectPath === 'function');
    const opened = await win.evaluate(dir => openProjectPath(dir), repo);
    assert.equal(opened.ok, true, opened.error);
    await win.waitForFunction(() => {
      const tab = activeTab();
      return tab?.webview && !tab.webview.isLoading() && /^http/.test(tab.webview.getURL());
    });
    await win.evaluate(() => {
      setCanvasMode('select');
      askBackToFloating();
      activeTab()!.webview.send('radial:select-node', { selector: '#hero' });
    });
    await win.locator('#qeInput').waitFor();
    await win.locator('#qeInput').focus();
    await win.locator('#quickEdit').screenshot({ path: path.join(os.tmpdir(), 'radial-quick-input-focus.png') });
    const cdp = await win.context().newCDPSession(win);
    const dropFiles = async (selector: string, files: string[]) => {
      const box = await win.locator(selector).boundingBox();
      assert.ok(box, 'drop target is visible');
      const params = { x: box.x + box.width / 2, y: box.y + box.height / 2,
        data: { items: [], files, dragOperationsMask: 1 } };
      await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...params });
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...params });
      assert.equal(await win.locator(selector).evaluate(el => el.closest('.quick-edit')!.classList.contains('drop-into')), true);
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...params });
    };

    for (const pinned of [false, true]) {
      if (pinned) await win.evaluate(() => {
        showQuickEdit(activeTab()!, { selector: '#hero', tagName: 'h1', rect: { x: 8, y: 8, w: 250, h: 40 } });
        askPinToDock();
      });
      const input = pinned ? '[data-tpa-input]' : '#qeInput';
      const thumbs = pinned ? '[data-tpa-attach] .cm-attach-thumb' : '#qeAttach .cm-attach-thumb';
      const selection = await win.evaluate(() => quickEdit!.sels[0].selector);
      await win.locator(input).fill('Use these references');
      await dropFiles(input, [image, notes]);
      await win.waitForFunction(selector => document.querySelectorAll(selector).length === 1, thumbs);
      assert.match(await win.locator(input).inputValue(), /Use these references/);
      assert.ok((await win.locator(input).inputValue()).includes("'" + notes + "'"), 'non-image paths still insert with shell quoting');
      assert.equal(await win.locator(input).evaluate(el => document.activeElement === el), true);
      assert.equal(await win.locator(input).evaluate(el => el.closest('.quick-edit')!.classList.contains('drop-into')), false);
      await win.waitForFunction(selector => { const img = document.querySelector<HTMLImageElement>(selector); return img?.complete && img.naturalWidth > 0; }, thumbs + ' img');

      // Files without useful MIME metadata still become images, not text paths.
      await win.evaluate(({ input, bytes }) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File([new Uint8Array(bytes)], 'reference.PNG', { type: '' }));
        dataTransfer.items.add(new File([new Uint8Array(bytes)], 'second.png', { type: 'application/octet-stream' }));
        document.querySelector(input)!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      }, { input, bytes: [...png] });
      await win.waitForFunction(selector => document.querySelectorAll(selector).length === 3, thumbs);

      // Rebuilding the same selection must not install duplicate handlers.
      await win.evaluate(() => showQuickEdit(quickEdit!.tab, quickEdit!.sels[0]));
      await win.evaluate(({ input, bytes }) => {
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' }));
        document.querySelector(input)!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
      }, { input, bytes: [...png] });
      await win.waitForFunction(selector => document.querySelectorAll(selector).length === 4, thumbs);
      await win.locator(thumbs + ' button').last().click();
      await win.waitForFunction(selector => document.querySelectorAll(selector).length === 3, thumbs);

      // Capture at the terminal boundary: no real agent is launched by this test.
      await win.evaluate(() => {
        window.__quickInputSent = null;
        quickEditToTerminal = async (_tab, _term, payload): Promise<undefined> => { window.__quickInputSent = payload; };
      });
      await win.locator(input).press('Enter');
      await win.waitForFunction(() => !quickEditSending);
      const sent = (await win.evaluate(() => window.__quickInputSent))!;
      assert.equal(sent.images!.length, 3);
      assert.equal(sent.images![0], image, 'native file drops retain their real path');
      assert.equal(sent.selections![0].selector, selection);
      assert.match(sent.text!, /Use these references/);
      for (const file of sent.images!) assert.deepEqual(fs.readFileSync(file), png, 'the agent can read the attached image');
    }
    assert.deepEqual(errors, []);
  } finally {
    if (app) await app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
