// Full-page screenshots of any URL at fixed CSS widths (plans/site-migration.md),
// for the live site and the local preview alike so they compare like for like.
// A hidden, sandboxed window with its own in-memory session: no cookies shared
// with the app or previews, no popups, downloads or permissions. The capture
// keeps a 900px-tall viewport and renders beyond it (captureBeyondViewport), so
// 100vh sections keep their real height instead of stretching to the page.

import { BrowserWindow, session } from 'electron';
import type { Session } from 'electron';
import type { ShotResult } from './index'; // the Shooter's contract (index.ts says why it lives there)
import { SETTLE, VIEWPORT_HEIGHT } from './settle'; // shared with radial serve's shooter (src/headless/page.ts)

export interface ShotOptions { settleMs?: number; loadTimeoutMs?: number; maxHeight?: number }
// The parts of the DevTools Protocol answers read here.
interface LayoutMetrics { cssContentSize?: { height: number }; contentSize: { height: number } }
interface Screenshot { data: string }

const PARTITION = 'radial-migrate-shots';
let prepared = false;
function prepareSession(): Session {
  const ses = session.fromPartition(PARTITION);
  if (prepared) return ses;
  prepared = true;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.on('will-download', (event) => event.preventDefault());
  return ses;
}

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms))]);

// shoot(url, [390, 768, 1440]) → [{ width, png, height, fullHeight, clipped } | { width, error }]
async function shoot(url: string, widths: number[], { settleMs = 1200, loadTimeoutMs = 45000, maxHeight = 16000 }: ShotOptions = {}): Promise<ShotResult[]> {
  prepareSession();
  const win = new BrowserWindow({ show: false, width: 1440, height: VIEWPORT_HEIGHT, paintWhenInitiallyHidden: true,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false } });
  const wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const results: ShotResult[] = [];
  try {
    for (const width of widths) {
      try {
        // The window's own size is the viewport the page lays out (and runs its
        // scripts) against. The debugger attaches only after a page has loaded:
        // DevTools commands sent to a window with no renderer yet hang.
        win.setContentSize(width, VIEWPORT_HEIGHT);
        await withTimeout(wc.loadURL(url), loadTimeoutMs, 'Loading ' + url);
        await withTimeout(wc.executeJavaScript(SETTLE(settleMs), true), 30000, 'Settling ' + url);
        const dbg = wc.debugger;
        if (!dbg.isAttached()) dbg.attach('1.3');
        await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: width < 600 });
        const metrics: LayoutMetrics = await dbg.sendCommand('Page.getLayoutMetrics');
        const fullHeight = Math.ceil((metrics.cssContentSize || metrics.contentSize).height);
        const height = Math.max(1, Math.min(fullHeight, maxHeight));
        const shot: Screenshot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
        await dbg.sendCommand('Emulation.clearDeviceMetricsOverride');
        results.push({ width, png: Buffer.from(shot.data, 'base64'), height, fullHeight, clipped: fullHeight > maxHeight });
      } catch (error) { results.push({ width, error: (error as Error).message }); }
    }
  } finally {
    try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch {}
    win.destroy();
  }
  return results;
}

export { shoot, PARTITION };
