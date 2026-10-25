// The desktop e2e suites' background mode (RADIAL_E2E_BACKGROUND=1, which the
// suites' launch helper sets, test/support/app.ts): a test run that takes
// nothing from the person at the Mac, so the suites can run while someone works
// there. Only with a throwaway profile, RADIAL_USERDATA inside the system's own
// per-user temp folder, both read through links: a normal launch never runs this
// way, whatever its environment says. In it:
// - the app stays out of the Dock and the app switcher, and never comes forward
//   (activation policy 'accessory'; nothing calls app.focus or dock.show);
// - a window is made hidden, then shown without activating (showInactive), fully
//   transparent and letting the mouse through: it renders and lays out as any
//   shown window does, and nothing of it is on screen or under the pointer
//   (showInactive alone orders a window in front of other apps' windows). A
//   window a test makes itself gets the same, through radialE2EBackground on the
//   main process's globalThis (openWindow in test/support/app.ts);
// - nothing throttles a window or a preview nobody looks at (backgroundThrottling
//   off), so the suites' timings are a shown window's;
// - a native dialog is answered as cancelled, and a link, file or folder Radial
//   would open outside the app is only written to the log: neither may take the
//   screen either;
// - it makes no sound: no system beep (a CLI's bell rings one), and every page
//   is muted;
// - no page may ask for what would reach past the window: a notification banner,
//   fullscreen (a Space of its own), the camera, the microphone, the location or
//   the screen (the system's own prompts), or the pointer and the keyboard;
// - the clipboard is the run's own: what the main process or a page copies stays
//   in memory, and the Mac's clipboard is never read or changed;
// - so is the workspace, where it clones, creates projects and keeps Home
//   (~/Radial otherwise): a folder in its profile (main.ts, github.ts).
// The dialogs, the outside opens, the beep and the main process's clipboard are
// stand-ins put in for electron's own methods, so a test that stubs one itself
// (app.evaluate) still gets its stub.
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { App, BrowserWindow, BrowserWindowConstructorOptions, Clipboard, Dialog, MessageBoxOptions, Session, Shell, WebContents } from 'electron';

// A path as the file system resolves it, links and all. One that doesn't exist
// yet (a profile the app makes at launch) reads as its nearest existing parent's
// real path, plus the rest.
function realPath(p: string): string {
  const resolved = path.resolve(p);
  try { return fs.realpathSync(resolved); }
  catch {
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(realPath(parent), path.basename(resolved));
  }
}

/** Where the system keeps each user's temp folder: macOS's /var/folders/…, which is really /private/var/folders/…. */
export const SYSTEM_TEMP_ROOTS = ['/var/folders', '/private/var/folders'];

/** The temp folder a profile must be in, and the system's own temp folders that one must be in (the tests pass their own). */
export interface TempPlaces { tmp?: string; roots?: string[] }

/**
 * Whether a profile folder is a throwaway one: inside the temp folder, not the
 * folder itself. Both are read through links, so a link in the temp folder to a
 * real profile doesn't count. A temp folder (TMPDIR) outside the system's own
 * isn't trusted at all: it could be a real profile's parent.
 */
export function isThrowawayProfile(dir: string | undefined, { tmp = os.tmpdir(), roots = SYSTEM_TEMP_ROOTS }: TempPlaces = {}): boolean {
  if (!dir) return false;
  const temp = realPath(tmp), profile = realPath(dir);
  if (!roots.some((root) => temp.startsWith(root + path.sep))) return false;
  return profile.startsWith(temp + path.sep);
}

/** Whether this launch runs in the background: the flag, with a throwaway profile. */
export function e2eBackground(env: NodeJS.ProcessEnv = process.env, places: TempPlaces = {}): boolean {
  return env.RADIAL_E2E_BACKGROUND === '1' && isThrowawayProfile(env.RADIAL_USERDATA, places);
}

/** A window's options in the background: made hidden, never throttled. */
export function backgroundWindowOptions(options: BrowserWindowConstructorOptions): BrowserWindowConstructorOptions {
  return { ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } };
}

/** Shows a window in the background: transparent, letting the mouse through, and without activating the app. */
export function showInBackground(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.showInactive();
}

/** What the background mode puts on the main process's globalThis, for a window a test makes itself (openWindow). */
export interface BackgroundWindows {
  windowOptions: typeof backgroundWindowOptions;
  show: typeof showInBackground;
}

/** The button a message box answers with in the background: its cancel button, as Electron picks it (cancelId, else the first button labelled Cancel or No, else the first). */
export function cancelOf(options: MessageBoxOptions | undefined): number {
  if (options && typeof options.cancelId === 'number') return options.cancelId;
  const i = ((options && options.buttons) || []).findIndex((button) => ['cancel', 'no'].includes(String(button).toLowerCase()));
  return i === -1 ? 0 : i;
}

type Log = (line: string) => void;
const say = (log: Log, what: string, detail?: string) => log(`[e2e background] ${what}${detail ? `: ${detail}` : ''}`);
type Methods = Record<string, (...args: never[]) => unknown>;

/** Stand-ins for electron's dialog methods: each answers as cancelled, with a line in the log. */
export function backgroundDialogs(log: Log = (line) => console.log(line)): Methods {
  // A dialog's parent window comes first when one is given: the options are the last argument either way.
  const optionsOf = <T,>(args: unknown[]): T | undefined => args[args.length - 1] as T | undefined;
  const titleOf = (args: unknown[]) => optionsOf<{ title?: string }>(args)?.title;
  return {
    showOpenDialog: async (...args: unknown[]) => { say(log, 'an open dialog was answered as cancelled', titleOf(args)); return { canceled: true, filePaths: [] }; },
    showOpenDialogSync: (...args: unknown[]) => { say(log, 'an open dialog was answered as cancelled', titleOf(args)); return undefined; },
    showSaveDialog: async (...args: unknown[]) => { say(log, 'a save dialog was answered as cancelled', titleOf(args)); return { canceled: true, filePath: '' }; },
    showSaveDialogSync: (...args: unknown[]) => { say(log, 'a save dialog was answered as cancelled', titleOf(args)); return ''; },
    showMessageBox: async (...args: unknown[]) => { const o = optionsOf<MessageBoxOptions>(args); say(log, 'a message box was answered with its cancel button', o?.message); return { response: cancelOf(o), checkboxChecked: false }; },
    showMessageBoxSync: (...args: unknown[]) => { const o = optionsOf<MessageBoxOptions>(args); say(log, 'a message box was answered with its cancel button', o?.message); return cancelOf(o); },
    showErrorBox: (title: string, content: string) => { say(log, `an error box was not shown (${title})`, content); },
    showCertificateTrustDialog: async () => { say(log, 'a certificate dialog was not shown'); },
  };
}

/** Stand-ins for electron's shell methods that reach outside the app: each only writes a line in the log. The beep makes no sound. */
export function backgroundShell(log: Log = (line) => console.log(line)): Methods {
  return {
    openExternal: async (url: unknown) => { say(log, 'a link was not opened outside the app', String(url)); },
    openPath: async (file: unknown) => { say(log, 'a file was not opened outside the app', String(file)); return ''; },
    showItemInFolder: (file: unknown) => { say(log, 'a file was not shown in the Finder', String(file)); },
    trashItem: async (file: unknown) => { say(log, 'a file was not moved to the Trash', String(file)); },
    beep: () => {},
  };
}

/** One clipboard entry as Electron 44's clipboard and the web's take them: its types, and each one's data. */
interface ClipboardEntry { types: readonly string[]; getType(type: string): Promise<unknown> }

/** A clipboard in memory, with the methods Electron 44's has: what the run copies stays in the run. */
export function memoryClipboard(): Methods {
  let copied = new Map<string, unknown>(); // what was copied last, by type
  const textOf = async (value: unknown): Promise<string> => typeof value === 'string' ? value : value instanceof Blob ? value.text() : '';
  return {
    writeText: async (text: unknown) => { copied = new Map([['text/plain', String(text)]]); },
    readText: async () => textOf(copied.get('text/plain')),
    write: async (items: ClipboardEntry[]) => {
      const next = new Map<string, unknown>();
      for (const item of items || []) for (const type of item.types) next.set(type, await item.getType(type));
      copied = next;
    },
    read: async (): Promise<ClipboardEntry[]> => {
      const now = copied;
      if (!now.size) return [];
      return [{ types: [...now.keys()], getType: async (type: string) => { if (!now.has(type)) throw new Error(`Nothing of type ${type} was copied.`); return now.get(type); } }];
    },
    has: async (type: string) => copied.has(type),
    clear: () => { copied = new Map(); },
  };
}

// What a page copies stays in that page: navigator.clipboard (the web's
// clipboard, which the window and the previews copy with) keeps it in memory.
// Run in each page as it loads (dom-ready), before anything done in it can copy.
// A copy made with the keyboard (⌘C) isn't covered; no suite makes one.
export const PAGE_CLIPBOARD = `(() => {
  const clipboard = navigator.clipboard;
  if (!clipboard || clipboard.radialE2EBackground) return;
  let items = [];
  const define = (name, value) => Object.defineProperty(clipboard, name, { value, configurable: true, writable: true });
  define('radialE2EBackground', true);
  define('writeText', async (text) => { items = [new ClipboardItem({ 'text/plain': new Blob([String(text)], { type: 'text/plain' }) })]; });
  define('readText', async () => {
    const item = items.find((entry) => entry.types.includes('text/plain'));
    return item ? (await item.getType('text/plain')).text() : '';
  });
  define('write', async (next) => { items = [...next]; });
  define('read', async () => items.slice());
})();`;

// What a page may not have in the background: each would reach past the window (a
// notification banner, fullscreen's own Space, the system's prompts for the camera,
// the microphone, the location or the screen, the pointer or the keyboard). Every
// other permission is granted, as it is without a handler.
export const PAST_THE_WINDOW = new Set(['notifications', 'fullscreen', 'media', 'geolocation', 'display-capture', 'pointerLock', 'keyboardLock', 'window-management', 'idle-detection', 'midi', 'midiSysex']);
function keepPagesInside(session: Session): void {
  session.setPermissionRequestHandler((_contents, permission, callback) => callback(!PAST_THE_WINDOW.has(permission)));
  session.setPermissionCheckHandler((_contents, permission) => !PAST_THE_WINDOW.has(permission));
}

// Puts stand-ins in for an electron module's methods, and makes sure each took: a
// module whose methods couldn't be replaced would leave the real ones to take the
// screen, so this throws instead (main.ts then quits the launch).
function standIn(target: object, what: string, methods: Methods): void {
  const slots = target as Record<string, unknown>;
  for (const [name, fn] of Object.entries(methods)) {
    try { slots[name] = fn; } catch {}
    if (slots[name] !== fn) throw new Error(`The e2e background mode could not stand in for ${what}.${name}.`);
  }
}

/**
 * Puts the app in the background mode (see the top of this file): its
 * activation policy, its stand-ins for electron's dialogs, outside opens, beep
 * and clipboard, and what it does to every page its windows load (muted, never
 * throttled, its own clipboard, nothing past the window). Call it once, at
 * startup, before the first window. Throws when a stand-in won't take.
 */
export function enterBackgroundMode({ app, shell, dialog, clipboard, session, log = (line) => console.log(line) }: { app: App; shell: Shell; dialog: Dialog; clipboard: Clipboard; session: { readonly defaultSession: Session }; log?: Log }): void {
  const policy = () => { try { if (process.platform === 'darwin') app.setActivationPolicy('accessory'); } catch {} };
  policy();
  app.whenReady().then(() => { policy(); keepPagesInside(session.defaultSession); }).catch(() => {});
  app.on('session-created', keepPagesInside); // one a page or a feature makes of its own
  standIn(dialog, 'dialog', backgroundDialogs(log));
  standIn(shell, 'shell', backgroundShell(log));
  standIn(clipboard, 'clipboard', memoryClipboard());
  (globalThis as typeof globalThis & { radialE2EBackground?: BackgroundWindows }).radialE2EBackground = { windowOptions: backgroundWindowOptions, show: showInBackground };
  // Every page a window loads, the window's own and the previews (<webview>) it attaches.
  app.on('web-contents-created', (_e, contents: WebContents) => {
    try { contents.setAudioMuted(true); } catch {}
    contents.on('will-attach-webview', (_event, webPreferences) => { webPreferences.backgroundThrottling = false; });
    contents.on('dom-ready', () => { contents.executeJavaScript(PAGE_CLIPBOARD).catch(() => {}); });
  });
}
