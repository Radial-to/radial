// The app under test, for the desktop e2e suites: launched in the background
// (src/main/e2eBackground.ts), so its windows never come forward or show on
// screen, it makes no sound and it leaves the Mac's clipboard alone, and the
// suites can run while someone works at the Mac. The app honors that only with a
// throwaway profile (RADIAL_USERDATA in the system's temp folder), which every
// suite gives it; a launch that wouldn't get the background stops here instead
// of taking the screen. RADIAL_E2E_FOREGROUND=1, in the run's environment or a
// launch's own, runs it as a normal window instead: to watch a run, or for a test
// that needs the OS's own focus (foregroundOnly). A window a test makes itself
// goes through openWindow, which makes it the way the app makes its own.
// scripts/smoke.mts, scripts/update-rehearsal.mts and scripts/perf/chatPerf.mts
// drive the real app in the foreground on purpose, and don't come through here.
import { _electron } from 'playwright-core';
import type { ElectronApplication, Page } from 'playwright-core';
import type { BrowserWindowConstructorOptions } from 'electron';
import { e2eBackground } from '../../src/main/e2eBackground.ts';
import type { BackgroundWindows } from '../../src/main/e2eBackground.ts';

type LaunchOptions = NonNullable<Parameters<typeof _electron.launch>[0]>;

/** Whether this run shows the app as a normal window (RADIAL_E2E_FOREGROUND=1). */
export const foreground = (env: Record<string, string | undefined> = process.env): boolean => env.RADIAL_E2E_FOREGROUND === '1';

// The temp folder the app will see: its os.tmpdir(), from the launch's environment.
const tmpdirOf = (env: Record<string, string | undefined>): string => env.TMPDIR || env.TMP || env.TEMP || '/tmp';

/**
 * A launch's environment (by default the run's), for the background unless the
 * run or the launch asks for the foreground. Throws when the app wouldn't honor
 * the background with it (its profile isn't a throwaway one in the system's temp
 * folder), rather than let the launch take the screen.
 */
export function appEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out = { ...env } as Record<string, string>;
  if (foreground() || foreground(env)) { delete out.RADIAL_E2E_BACKGROUND; return out; }
  out.RADIAL_E2E_BACKGROUND = '1';
  if (!e2eBackground(out, { tmp: tmpdirOf(out) })) {
    throw new Error(`This launch would put the app on screen: the background needs its profile (RADIAL_USERDATA, now ${out.RADIAL_USERDATA || 'not set'}) inside the system's temp folder (/var/folders on a Mac), and TMPDIR there too. Set RADIAL_E2E_FOREGROUND=1 to run it in the foreground.`);
  }
  return out;
}

/** A launch's options, with appEnv's environment. */
export function inBackground(options: LaunchOptions = {}): LaunchOptions {
  return { ...options, env: appEnv(options.env || process.env) };
}

/** Launches the app under test (playwright-core's _electron.launch), in the background unless asked otherwise. */
export function launchApp(options: LaunchOptions = {}): Promise<ElectronApplication> {
  return _electron.launch(inBackground(options));
}

/**
 * Opens a window of the test's own in the app under test (a page the test
 * serves), made as the app makes its windows in this run: in the background,
 * hidden, then shown without activating, transparent and letting the mouse
 * through; in the foreground, a normal window. Resolves with its page.
 */
export async function openWindow(app: ElectronApplication, url: string, options: BrowserWindowConstructorOptions = {}): Promise<Page> {
  const next = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, { url, options }) => {
    const e2e = (globalThis as typeof globalThis & { radialE2EBackground?: BackgroundWindows }).radialE2EBackground;
    const win = new BrowserWindow(e2e ? e2e.windowOptions(options) : options);
    if (e2e) e2e.show(win);
    void win.loadURL(url);
  }, { url, options });
  return next;
}

/**
 * For a test that needs the OS's own focus (the app frontmost, a key window): it
 * runs only when the run allows the foreground, and is skipped otherwise. Pass
 * as the test's options: test(name, foregroundOnly(), fn).
 */
export const foregroundOnly = (options: { timeout?: number } = {}) => ({ ...options, skip: foreground() ? false : 'needs the foreground: run with RADIAL_E2E_FOREGROUND=1' });
