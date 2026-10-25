// The native chat panel (src/renderer/nativeChat.ts) while it starts, in a
// real Chromium page: configure() turns chat on before it has read the saved
// chats and made the composer, and a send in that gap answers false (the
// caller keeps the message to retry) instead of throwing.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

/** The part of the preload's API configure() and send() reach, faked; nativeChatList holds until the test lets it go. */
interface FakeRadial {
  nativeChatEnabled(): Promise<boolean>;
  nativeChatList(repoDir?: string, all?: boolean): Promise<never[]>;
  nativeChatCreate(...args: unknown[]): Promise<never>;
  nativeChatSend(...args: unknown[]): Promise<never>;
}
/** The hooks configure() is given (src/renderer/types.d.ts NativeChatHooks), only the ones this gap reaches. */
interface StartupHooks { context(): { repoDir: string; home: boolean; name: string }; renderRail(): void }
interface PageGlobals {
  radial: FakeRadial;
  /** nativeChat.js's API (types.d.ts RadialNativeChatApi), the calls made here. */
  RadialNativeChat: { configure(hooks: StartupHooks): Promise<void>; enabled(): boolean; send(text?: string, displayText?: string): Promise<boolean> };
  /** What reached main: chats created or messages sent. */
  calls: string[];
}
declare const window: Window & typeof globalThis & PageGlobals;

test('a send while the chat is still starting answers false instead of throwing', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(6000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('http://radial.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto('http://radial.test/');
    await page.evaluate(() => {
      window.calls = [];
      window.radial = {
        nativeChatEnabled: async () => true,
        // The saved chats are still being read for as long as this test runs.
        nativeChatList: () => new Promise<never[]>(() => {}),
        nativeChatCreate: async () => { window.calls.push('create'); throw new Error('unexpected'); },
        nativeChatSend: async () => { window.calls.push('send'); throw new Error('unexpected'); },
      };
    });
    await page.addScriptTag({ content: fs.readFileSync('out/renderer/nativeChat.js', 'utf8') });
    await page.evaluate(() => { window.RadialNativeChat.configure({ context: () => ({ repoDir: '/site', home: true, name: 'Workspace' }), renderRail: () => {} }); });
    // Chat reports itself on (Home's send and engineSend route to it) before the composer exists.
    await page.waitForFunction(() => window.RadialNativeChat.enabled());
    assert.equal(await page.evaluate(() => window.RadialNativeChat.send('Review this workspace')), false);
    assert.deepEqual(await page.evaluate(() => window.calls), [], 'nothing reached main');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
