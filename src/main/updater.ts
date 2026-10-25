/**
 * In-app auto-update (electron-updater / Squirrel.Mac, fed from the public
 * Radial-to/radial-releases GitHub releases). Figma-style flow: check quietly on
 * launch (and every few hours), download in the background, then surface a
 * small "Restart to update" affordance — the user picks the restart moment,
 * because live agent terminals may be mid-task. (They survive the restart via
 * the PTY daemon, but an SDK chat turn would be cut short.)
 *
 * On macOS an update is ready only once Squirrel.Mac (Electron's own
 * autoUpdater) has it. electron-updater announces update-downloaded as soon as
 * it has the zip, and only then hands it to Squirrel, which checks the new
 * app's signature against this one's. Squirrel refuses an update signed by
 * another team or under another app ID, and quitAndInstall would then wait
 * forever: Restart would do nothing. So a refusal is reported instead
 * (onRefused, check's 'refused'), and the person downloads that version.
 *
 * Only official builds update themselves: scripts/official-build.mts bakes the
 * feed (app-update.yml) and the official config into the app. A build from
 * source, and dev (`electron .`), never checks: there's nothing it could
 * install, since official updates are signed by Radial.
 *
 * In an official build, the old website flow (updateCheck.js →
 * radial.to/download) stays as the fallback when the updater itself errors.
 */

import type { EventEmitter } from 'events';
import type { AppUpdater, UpdateDownloadedEvent } from 'electron-updater';

/** The downloaded update electron-updater reported ({} when the event carried no info). */
export type DownloadedUpdate = Partial<UpdateDownloadedEvent>;
/** A downloaded update macOS won't install in place (Squirrel.Mac refused it): the website has it. */
export interface RefusedUpdate { version: string | undefined; error: string }

/** init()'s options. */
export interface UpdaterInitOptions {
  isPackaged: boolean;
  isOfficial: boolean;
  /** Called once an update has downloaded and is ready to install. */
  onDownloaded?: (info: DownloadedUpdate) => void;
  /** Called when macOS refuses a downloaded update: it can't install itself, and needs a download instead. */
  onRefused?: (info: RefusedUpdate) => void;
}

/** check()'s options. */
export interface UpdaterCheckOptions {
  isPackaged: boolean;
  isOfficial: boolean;
  currentVersion: string;
}

/** check()'s verdict (see check()). */
export type UpdaterCheckResult =
  | { state: 'downloaded'; version: string | undefined }
  | { state: 'refused'; version: string | undefined; error: string }
  | { state: 'available'; version: string }
  | { state: 'none'; version: string }
  | { state: 'source-build' }
  | { state: 'error'; error: string };

/** What the updater drives: electron-updater's autoUpdater, and on macOS Squirrel.Mac, which installs what it downloads. Tests stand in for both. */
export interface UpdaterDeps {
  autoUpdater(): AppUpdater;
  /** Electron's own autoUpdater on macOS; null elsewhere, where electron-updater installs the update itself. */
  squirrel(): Pick<EventEmitter, 'on'> | null;
}

const RECHECK_MS = 4 * 60 * 60 * 1000; // long-running app still hears about updates

const electronDeps: UpdaterDeps = {
  autoUpdater: () => (require('electron-updater') as typeof import('electron-updater')).autoUpdater,
  squirrel: () => (process.platform === 'darwin' ? (require('electron') as typeof import('electron')).autoUpdater : null),
};

/** An updater on these deps: the app's own is below; tests make theirs. */
export function createUpdater(deps: UpdaterDeps = electronDeps) {
  let auto: AppUpdater | null = null;               // lazy electron-updater autoUpdater
  let fetched: DownloadedUpdate | null = null;      // electron-updater has the zip (on macOS, Squirrel is checking it)
  let downloaded: DownloadedUpdate | null = null;   // ready to install
  let refused: RefusedUpdate | null = null;         // Squirrel won't install the fetched one
  let notifyDownloaded: ((info: DownloadedUpdate) => void) | null = null;
  let notifyRefused: ((info: RefusedUpdate) => void) | null = null;
  let timer: NodeJS.Timeout | null = null;

  function load(): AppUpdater {
    if (auto) return auto;
    auto = deps.autoUpdater();
    auto.autoDownload = true;
    auto.autoInstallOnAppQuit = true; // quitting normally also applies it (and on macOS, hands each download to Squirrel at once)
    const squirrel = deps.squirrel();
    const ready = (info: DownloadedUpdate) => {
      downloaded = info;
      refused = null;
      if (notifyDownloaded) notifyDownloaded(info);
    };
    auto.on('update-downloaded', (info) => {
      fetched = info || {};
      if (!squirrel) ready(fetched);
    });
    if (squirrel) {
      squirrel.on('update-downloaded', () => { if (fetched) ready(fetched); });
      squirrel.on('error', (e: unknown) => {
        if (!fetched || downloaded) return; // nothing handed over yet, or already staged: not a refusal
        refused = { version: fetched.version, error: (e instanceof Error && e.message) || String(e) };
        if (notifyRefused) notifyRefused(refused);
      });
    }
    auto.on('error', () => {}); // background checks fail silently (offline etc.)
    return auto;
  }

  /** Start background checking. No-op outside a packaged official build. */
  function init({ isPackaged, isOfficial, onDownloaded, onRefused }: UpdaterInitOptions): void {
    if (!isPackaged || !isOfficial) return;
    notifyDownloaded = onDownloaded || null;
    notifyRefused = onRefused || null;
    const tick = () => { try { load().checkForUpdates().catch(() => {}); } catch {} };
    setTimeout(tick, 10_000).unref(); // off the launch critical path
    timer = setInterval(tick, RECHECK_MS);
    timer.unref();
  }

  /** The downloaded-and-ready update, or null. */
  function ready(): DownloadedUpdate | null { return downloaded; }
  /** The update macOS refused to install in place, or null. */
  function refusal(): RefusedUpdate | null { return refused; }

  /**
   * Manual "Check for Updates…": resolves to one of
   *   { state: 'downloaded', version }       — ready now; caller offers Restart
   *   { state: 'refused', version, error }   — macOS won't install it in place; caller offers the download
   *   { state: 'available', version }        — found; download started in background
   *   { state: 'none', version }             — up to date (version = current)
   *   { state: 'source-build' }              — built from source: never updates itself
   *   { state: 'error', error }              — updater unusable; caller falls back
   */
  async function check({ isPackaged, isOfficial, currentVersion }: UpdaterCheckOptions): Promise<UpdaterCheckResult> {
    if (downloaded) return { state: 'downloaded', version: downloaded.version };
    if (refused) return { state: 'refused', version: refused.version, error: refused.error };
    if (!isPackaged) return { state: 'error', error: 'dev build' };
    if (!isOfficial) return { state: 'source-build' };
    try {
      const r = await load().checkForUpdates();
      const latest = r && r.updateInfo && r.updateInfo.version;
      // Squirrel can accept or refuse during the await; TypeScript still holds the nulls from the checks above.
      const now = downloaded as DownloadedUpdate | null, no = refused as RefusedUpdate | null;
      if (now) return { state: 'downloaded', version: now.version };
      if (no) return { state: 'refused', version: no.version, error: no.error };
      if (latest && latest !== currentVersion && (r.isUpdateAvailable === undefined || r.isUpdateAvailable)) {
        return { state: 'available', version: latest };
      }
      return { state: 'none', version: currentVersion };
    } catch (e) {
      return { state: 'error', error: ((e as Error) && (e as Error).message) || String(e) };
    }
  }

  /** Apply the downloaded update now (quits, installs, relaunches). */
  function restart(): boolean {
    if (!auto || !downloaded) return false;
    auto.quitAndInstall();
    return true;
  }

  return { init, check, ready, refusal, restart };
}

const updater = createUpdater();
export const { init, check, ready, refusal, restart } = updater;
