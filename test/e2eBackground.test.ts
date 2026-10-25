// The desktop e2e suites' background mode (src/main/e2eBackground.ts): only a
// throwaway profile in the system's own temp folder honors the flag; a window in
// it is shown without activating and stays off the screen; its dialogs and
// outside opens never show, it makes no sound, its pages can't reach past the
// window, it keeps its clipboard and its workspace folder to itself, while a
// test's own stubs still win; the harness refuses a launch that wouldn't get it;
// and main.ts and the suites make, show and focus windows and ask dialogs only in
// ways the mode covers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PAGE_CLIPBOARD, PAST_THE_WINDOW, SYSTEM_TEMP_ROOTS, backgroundDialogs, backgroundShell, backgroundWindowOptions, cancelOf, e2eBackground, enterBackgroundMode, isThrowawayProfile, memoryClipboard, showInBackground } from '../src/main/e2eBackground';
import type { BackgroundWindows } from '../src/main/e2eBackground';
import { appEnv, foregroundOnly } from './support/app.ts';
import * as github from '../src/main/github';
import type { App, BrowserWindow, Clipboard, Dialog, Session, Shell } from 'electron';

const realTmp = fs.realpathSync(os.tmpdir());
// This Mac's own temp folder (a Linux box has none the mode trusts, so the mode is never on there).
const systemTemp = SYSTEM_TEMP_ROOTS.some((root) => realTmp.startsWith(root + path.sep));

test('the flag is honored only with a throwaway profile: inside a temp folder the system made, read through links', () => {
  // A stand-in for the system's temp folders (/var/folders), with a user's temp folder in it, and a real profile elsewhere.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-e2e-bg-root-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-e2e-bg-profile-'));
  try {
    const tmp = path.join(root, 'T'); fs.mkdirSync(tmp);
    const places = { tmp, roots: [fs.realpathSync(root)] };
    const flag = { RADIAL_E2E_BACKGROUND: '1' };
    const profile = fs.mkdtempSync(path.join(tmp, 'radial-'));
    assert.equal(e2eBackground({ ...flag, RADIAL_USERDATA: profile }, places), true, 'a profile the suites made in the temp folder');
    assert.equal(e2eBackground({ ...flag, RADIAL_USERDATA: path.join(profile, 'app') }, places), true, 'one not made yet, in a folder that is');
    assert.equal(e2eBackground({ RADIAL_USERDATA: profile }, places), false, 'no flag');
    assert.equal(e2eBackground({ ...flag, RADIAL_E2E_BACKGROUND: '0', RADIAL_USERDATA: profile }, places), false);
    assert.equal(e2eBackground(flag, places), false, 'no profile: the app\'s own (a normal launch)');
    assert.equal(e2eBackground({ ...flag, RADIAL_USERDATA: tmp }, places), false, 'the temp folder itself');
    assert.equal(e2eBackground({ ...flag, RADIAL_USERDATA: path.join(tmp, '..', 'elsewhere') }, places), false, 'a path that climbs out of it');
    assert.equal(e2eBackground({ ...flag, RADIAL_USERDATA: path.join(`${tmp}-not`, 'x') }, places), false, 'a sibling whose name starts the same');
    fs.symlinkSync(elsewhere, path.join(tmp, 'link'));
    assert.equal(e2eBackground({ ...flag, RADIAL_USERDATA: path.join(tmp, 'link') }, places), false, 'a link in the temp folder to a real profile');
    assert.equal(e2eBackground({ ...flag, RADIAL_USERDATA: path.join(tmp, 'link', 'app') }, places), false, 'or to a folder in one');
    assert.equal(e2eBackground({ ...flag, RADIAL_USERDATA: path.join(elsewhere, 'app') }, { tmp: elsewhere, roots: places.roots }), false, 'a TMPDIR outside the system\'s temp folders is not trusted');
    fs.symlinkSync(tmp, path.join(root, 'T-link'));
    assert.equal(e2eBackground({ ...flag, RADIAL_USERDATA: path.join(root, 'T-link', path.basename(profile)) }, places), true, 'a spelling of the temp folder through a link counts as the folder');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('the system\'s own temp folders are the default: a Mac\'s /var/folders, never the real profile', () => {
  const flag = { RADIAL_E2E_BACKGROUND: '1' };
  assert.equal(e2eBackground({ ...flag, RADIAL_USERDATA: path.join(os.homedir(), 'Library', 'Application Support', 'Radial') }), false, 'the real profile');
  assert.equal(e2eBackground({ ...flag, RADIAL_USERDATA: path.join(os.homedir(), 'x') }, { tmp: os.homedir() }), false, 'TMPDIR pointed at the home folder');
  if (!systemTemp) return; // on a system without them nothing counts, and the harness refuses to launch
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-e2e-bg-'));
  try {
    assert.equal(e2eBackground({ ...flag, RADIAL_USERDATA: profile }), true);
    // macOS's temp folder has two spellings, /var/folders/… and /private/var/folders/…: either counts.
    assert.equal(e2eBackground({ ...flag, RADIAL_USERDATA: fs.realpathSync(profile) }), true);
    assert.equal(e2eBackground({ ...flag, RADIAL_USERDATA: profile }, { tmp: realTmp }), true);
    assert.equal(isThrowawayProfile(os.tmpdir()), false, 'the temp folder itself');
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});

test('a window in the background: made hidden and never throttled, then shown without activating, transparent, letting the mouse through', () => {
  const options = backgroundWindowOptions({ width: 1400, webPreferences: { preload: 'p.js', webviewTag: true } });
  assert.deepEqual(options, { width: 1400, show: false, webPreferences: { preload: 'p.js', webviewTag: true, backgroundThrottling: false } });
  const calls: string[] = [];
  const win = { isDestroyed: () => false, setOpacity: (o: number) => calls.push(`opacity ${o}`), setIgnoreMouseEvents: (on: boolean) => calls.push(`ignore mouse ${on}`), showInactive: () => calls.push('showInactive'), show: () => calls.push('show'), focus: () => calls.push('focus') };
  showInBackground(win as unknown as BrowserWindow);
  assert.deepEqual(calls, ['opacity 0', 'ignore mouse true', 'showInactive'], 'never show() or focus()');
});

test('a message box answers with its cancel button, picked as Electron picks it', () => {
  assert.equal(cancelOf({ message: 'Update', buttons: ['Download', 'Later'], cancelId: 1 }), 1, 'its cancelId');
  assert.equal(cancelOf({ message: 'Quit?', buttons: ['Quit', 'Cancel'] }), 1, 'else the first button labelled Cancel');
  assert.equal(cancelOf({ message: 'Save?', buttons: ['Yes', 'No', 'Cancel'] }), 1, 'or No');
  assert.equal(cancelOf({ message: 'Update', buttons: ['Download', 'Later'] }), 0, 'else the first');
  assert.equal(cancelOf({ message: 'Done' }), 0);
  assert.equal(cancelOf(undefined), 0);
});

// What enterBackgroundMode is handed: electron's modules, as plain objects whose methods record what they did.
function electronStandIns() {
  const did: string[] = [];
  const policies: string[] = [];
  const hooks: Record<string, (...args: unknown[]) => void> = {};
  const app = { setActivationPolicy: (p: string) => policies.push(p), whenReady: () => Promise.resolve(), on: (event: string, fn: (...args: unknown[]) => void) => { hooks[event] = fn; } };
  const shell = { openExternal: async (url: string) => { did.push(`open ${url}`); }, openPath: async (p: string) => { did.push(`open ${p}`); return ''; }, showItemInFolder: (p: string) => { did.push(`reveal ${p}`); }, trashItem: async (p: string) => { did.push(`trash ${p}`); }, beep: () => { did.push('beep'); } };
  const dialog = { showOpenDialog: async () => { did.push('open dialog'); return { canceled: false, filePaths: ['/real'] }; }, showMessageBox: async () => { did.push('message box'); return { response: 0, checkboxChecked: false }; }, showErrorBox: () => { did.push('error box'); } };
  const clipboard = { writeText: async (t: string) => { did.push(`copy ${t}`); }, readText: async () => 'the Mac\'s clipboard', clear: () => { did.push('clear'); } };
  // A session's permission handlers, as the mode leaves them.
  const permissions = () => {
    const handlers: { request?: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void; check?: (contents: unknown, permission: string) => boolean } = {};
    return { handlers, setPermissionRequestHandler: (fn: typeof handlers.request) => { handlers.request = fn; }, setPermissionCheckHandler: (fn: typeof handlers.check) => { handlers.check = fn; } };
  };
  const session = { defaultSession: permissions() };
  return { did, policies, hooks, app, shell, dialog, clipboard, session, permissions };
}
const enter = (e: ReturnType<typeof electronStandIns>, log: (line: string) => void, dialog: unknown = e.dialog) =>
  enterBackgroundMode({ app: e.app as unknown as App, shell: e.shell as unknown as Shell, dialog: dialog as Dialog, clipboard: e.clipboard as unknown as Clipboard, session: e.session as unknown as { defaultSession: Session }, log });

test('in the background the app stays out of the Dock, its dialogs answer as cancelled, nothing opens outside it, it makes no sound, its pages can\'t reach past the window, and its clipboard is its own', async () => {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const e = electronStandIns();
  enter(e, log);
  await new Promise((r) => setImmediate(r));
  if (process.platform === 'darwin') assert.deepEqual(e.policies, ['accessory', 'accessory'], 'at once, and again once ready');

  const dialog = e.dialog as unknown as Dialog;
  assert.deepEqual(await dialog.showOpenDialog({ title: 'Open a folder', properties: ['openDirectory'] }), { canceled: true, filePaths: [] });
  assert.deepEqual(await dialog.showSaveDialog({ defaultPath: 'shot.png' }), { canceled: true, filePath: '' });
  assert.deepEqual(await dialog.showMessageBox({ message: 'Update ready', buttons: ['Restart Now', 'Later'], defaultId: 0, cancelId: 1 }), { response: 1, checkboxChecked: false }, 'its cancel button');
  assert.equal(dialog.showMessageBoxSync({ message: 'Quit?', buttons: ['Quit', 'Cancel'] }), 1);
  assert.equal(dialog.showOpenDialogSync({ properties: ['openFile'] }), undefined);
  dialog.showErrorBox('JavaScript error', 'Uncaught Exception');

  const shell = e.shell as unknown as Shell;
  await shell.openExternal('https://radial.to/docs');
  await shell.openPath('/tmp/site/index.html');
  shell.showItemInFolder('/tmp/site');
  await shell.trashItem('/tmp/site/old.html');
  shell.beep();

  const clipboard = e.clipboard as unknown as Clipboard;
  await clipboard.writeText('ABCD-1234');
  assert.equal(await clipboard.readText(), 'ABCD-1234', 'what the app copies stays in the run');
  clipboard.clear();
  assert.equal(await clipboard.readText(), '', 'and never comes from the Mac\'s clipboard');

  assert.deepEqual(e.did, [], 'none of electron\'s own: no dialog, nothing opened, no beep, the Mac\'s clipboard untouched');
  assert.equal(lines.length, 10, lines.join('\n'));
  assert.ok(lines.every((l) => l.startsWith('[e2e background] ')), lines.join('\n'));
  assert.match(lines.join('\n'), /a link was not opened outside the app: https:\/\/radial\.to\/docs\n.*a file was not opened outside the app: \/tmp\/site\/index\.html\n.*a file was not shown in the Finder: \/tmp\/site\n.*a file was not moved to the Trash/);

  // A test that stubs one of electron's methods itself (app.evaluate) gets its stub, over the mode's.
  (e.dialog as Record<string, unknown>).showOpenDialog = async () => ({ canceled: false, filePaths: ['/picked'] });
  assert.deepEqual(await dialog.showOpenDialog({ properties: ['openDirectory'] }), { canceled: false, filePaths: ['/picked'] });

  // Every page a window loads: muted, never throttled, and its own clipboard.
  const contents: Record<string, (...args: unknown[]) => void> = {};
  const page = { muted: false, ran: [] as string[], setAudioMuted(on: boolean) { this.muted = on; }, on: (event: string, fn: (...args: unknown[]) => void) => { contents[event] = fn; }, executeJavaScript(code: string) { this.ran.push(code); return Promise.resolve(); } };
  e.hooks['web-contents-created']({}, page);
  assert.equal(page.muted, true, 'no sound from the window or a preview');
  const prefs: { backgroundThrottling?: boolean } = {};
  contents['will-attach-webview']({}, prefs, {});
  assert.equal(prefs.backgroundThrottling, false, 'a preview a window attaches');
  contents['dom-ready']();
  assert.deepEqual(page.ran, [PAGE_CLIPBOARD], 'each page gets its own clipboard as it loads');

  // No page asks for what reaches past the window, in the window's session or one made later; the rest is granted.
  const later = e.permissions();
  e.hooks['session-created'](later);
  for (const { handlers } of [e.session.defaultSession, later]) {
    for (const permission of ['notifications', 'fullscreen', 'media', 'geolocation', 'display-capture', 'pointerLock', 'keyboardLock']) {
      let granted: boolean | null = null;
      handlers.request!({}, permission, (g) => { granted = g; });
      assert.deepEqual([granted, handlers.check!({}, permission)], [false, false], permission);
    }
    let granted: boolean | null = null;
    handlers.request!({}, 'clipboard-sanitized-write', (g) => { granted = g; });
    assert.deepEqual([granted, handlers.check!({}, 'clipboard-sanitized-write')], [true, true], 'what stays in the window');
  }
  assert.ok(PAST_THE_WINDOW.has('notifications') && !PAST_THE_WINDOW.has('clipboard-read'));

  // A window a test makes itself gets the same treatment (openWindow, test/support/app.ts).
  const windows = (globalThis as typeof globalThis & { radialE2EBackground?: BackgroundWindows }).radialE2EBackground;
  assert.equal(windows?.windowOptions, backgroundWindowOptions);
  assert.equal(windows?.show, showInBackground);
});

test('a module whose methods can\'t be stood in for stops the launch instead of leaving the real ones to show', () => {
  const e = electronStandIns();
  assert.throws(() => enter(e, () => {}, Object.freeze({ ...e.dialog })), /could not stand in for dialog\.showOpenDialog/);
});

test('the stand-ins on their own: dialogs cancel, outside opens are logged, the beep is silent, and the clipboard keeps what was copied last', async () => {
  const lines: string[] = [];
  const dialogs = backgroundDialogs((line) => lines.push(line));
  assert.deepEqual(await dialogs.showSaveDialog({ defaultPath: 'shot.png' } as never), { canceled: true, filePath: '' });
  assert.equal(dialogs.showSaveDialogSync({} as never), '');
  await dialogs.showCertificateTrustDialog();
  const shell = backgroundShell((line) => lines.push(line));
  assert.equal(shell.beep(), undefined);
  assert.equal(lines.length, 3, 'each dialog writes a line, and a beep nothing');
  const clipboard = memoryClipboard();
  await clipboard.write([{ types: ['text/plain', 'text/html'], getType: async (type: string) => new Blob([type === 'text/html' ? '<b>Hi</b>' : 'Hi'], { type }) }] as never);
  assert.equal(await clipboard.readText(), 'Hi');
  assert.equal(await clipboard.has('text/html' as never), true);
  const [item] = await clipboard.read() as { types: string[]; getType(type: string): Promise<Blob> }[];
  assert.deepEqual(item.types, ['text/plain', 'text/html']);
  assert.equal(await (await item.getType('text/html')).text(), '<b>Hi</b>');
  await clipboard.writeText('Bye' as never);
  assert.equal(await clipboard.has('text/html' as never), false, 'a copy replaces the last one whole');
});

test('the workspace a background run clones, creates and keeps Home in is in its profile, never the person\'s ~/Radial', () => {
  assert.equal(github.workspaceRoot().toLowerCase(), path.join(os.homedir(), 'Radial').toLowerCase(), 'by default, ~/Radial');
  const profile = path.join(os.tmpdir(), 'radial-e2e-bg-profile', 'Radial');
  github.useWorkspaceRoot(profile);
  assert.equal(github.workspaceRoot(), profile);
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
  assert.match(main, /\nif \(background\) github\.useWorkspaceRoot\(path\.join\(app\.getPath\('userData'\), 'Radial'\)\);/, 'main.ts moves it there in the background');
  assert.ok(!/path\.join\(app\.getPath\('home'\), 'Radial'\)/.test(main), 'and nothing in main.ts names ~/Radial itself');
});

test('a page\'s clipboard in the background keeps what the page copies in the page', async () => {
  // A page as the script finds it: navigator.clipboard, and the web's ClipboardItem.
  class ClipboardItem {
    readonly types: string[];
    readonly data: Record<string, Blob>;
    constructor(data: Record<string, Blob>) { this.data = data; this.types = Object.keys(data); }
    async getType(type: string) { return this.data[type]; }
  }
  const navigator = { clipboard: {} as Record<string, (...args: unknown[]) => Promise<unknown>> };
  new Function('navigator', 'ClipboardItem', PAGE_CLIPBOARD)(navigator, ClipboardItem);
  assert.equal(await navigator.clipboard.readText(), '');
  await navigator.clipboard.writeText('Preview ready');
  assert.equal(await navigator.clipboard.readText(), 'Preview ready');
  await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['From a write']) })]);
  assert.equal(await navigator.clipboard.readText(), 'From a write');
  assert.equal((await navigator.clipboard.read() as unknown[]).length, 1);
  const writeText = navigator.clipboard.writeText;
  new Function('navigator', 'ClipboardItem', PAGE_CLIPBOARD)(navigator, ClipboardItem);
  assert.equal(navigator.clipboard.writeText, writeText, 'run again in the same page, it changes nothing');
});

test('the suites launch the app in the background unless the run or the launch asks for the foreground, and refuse a launch the app would show', () => {
  const saved = process.env.RADIAL_E2E_FOREGROUND;
  const profile = path.join(os.tmpdir(), 'radial-e2e-bg-launch');
  try {
    delete process.env.RADIAL_E2E_FOREGROUND;
    if (systemTemp) assert.equal(appEnv({ RADIAL_USERDATA: profile, TMPDIR: os.tmpdir() }).RADIAL_E2E_BACKGROUND, '1');
    else assert.throws(() => appEnv({ RADIAL_USERDATA: profile, TMPDIR: os.tmpdir() }), /would put the app on screen/, 'no system temp folder: no background');
    assert.throws(() => appEnv({ RADIAL_USERDATA: path.join(os.homedir(), 'Library', 'Application Support', 'Radial'), TMPDIR: os.tmpdir() }), /would put the app on screen.*RADIAL_E2E_FOREGROUND=1/, 'a profile the app wouldn\'t treat as throwaway');
    assert.throws(() => appEnv({ TMPDIR: os.tmpdir() }), /RADIAL_USERDATA, now not set/, 'no profile at all');
    assert.equal(appEnv({ RADIAL_USERDATA: '/somewhere', RADIAL_E2E_FOREGROUND: '1', RADIAL_E2E_BACKGROUND: '1' }).RADIAL_E2E_BACKGROUND, undefined, 'a launch that asks for the foreground');
    assert.equal(foregroundOnly().skip, 'needs the foreground: run with RADIAL_E2E_FOREGROUND=1', 'a foreground-only test is skipped');
    process.env.RADIAL_E2E_FOREGROUND = '1';
    assert.equal(appEnv({ RADIAL_USERDATA: '/somewhere' }).RADIAL_E2E_BACKGROUND, undefined, 'a run that asks for the foreground');
    assert.equal(foregroundOnly({ timeout: 5 }).skip, false);
  } finally {
    if (saved === undefined) delete process.env.RADIAL_E2E_FOREGROUND; else process.env.RADIAL_E2E_FOREGROUND = saved;
  }
});

// main.ts, and the suites' own code that reaches into the app (app.evaluate), make, show and focus windows and ask
// dialogs only in ways the mode covers: a window made or shown any other way, a focus(), a dialog or an outside open
// without a stand-in would take the screen in a background run.
test('the app and the suites make, show and focus windows, and reach outside, only in ways the background mode covers', () => {
  const read = (dir: string, ext: RegExp) => fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => ext.test(f)).map((f) => ({ file: path.join(path.basename(dir), f), src: fs.readFileSync(path.join(dir, f), 'utf8') }));
  const main = read(path.join(__dirname, '..', 'src', 'main'), /\.ts$/);
  const covered = (methods: Record<string, unknown>) => new Set(Object.keys(methods));
  const standIns = { dialog: covered(backgroundDialogs()), shell: covered(backgroundShell()), clipboard: covered(memoryClipboard()) };
  for (const { file, src } of main) {
    for (const m of src.matchAll(/new BrowserWindow\(([^\n]*)/g)) {
      assert.ok(/^windowOptions\(/.test(m[1]) || /show: false/.test(m[1]), `${file}: a window made hidden or through windowOptions: ${m[0]}`);
    }
    // Every dialog, shell and clipboard method the app calls has a stand-in.
    for (const m of src.matchAll(/\b(dialog|shell|clipboard)\.(\w+)\(/g)) {
      assert.ok(standIns[m[1] as keyof typeof standIns].has(m[2]), `${file}: ${m[0]} has no stand-in in the background mode`);
    }
    assert.ok(!/\bapp\.focus\(|\bdock\.show\(/.test(src), `${file}: nothing brings the app forward`);
    // So is macOS's own `open` (openInEditor's fallback to the default text editor).
    for (const m of src.matchAll(/^.*\bexecFile\('open'.*$/gm)) assert.match(m[0], /!background &&/, `${file}: ${m[0].trim()}`);
    const shows = [...src.matchAll(/(?<!\bapi)\.(?:show|focus|restore)\(\)/g)]; // api.focus(): the CLI's verb, which reaches focusMainWindow
    if (file !== path.join('main', 'main.ts')) { assert.equal(shows.length, 0, `${file}: shows or focuses a window`); continue; }
    const body = /function focusMainWindow\(\): void \{([\s\S]*?)\n\}/.exec(src)![1];
    assert.equal(shows.length, 3, 'main.ts shows a window only in focusMainWindow');
    assert.ok(body.indexOf('if (background) { showInBackground(mainWindow); return; }') < body.indexOf('.show()'), 'which returns first in the background');
  }
  // The suites: a window of their own only through openWindow (test/support/app.ts), and no window shown, focused or
  // brought forward any other way.
  const suites = read(__dirname, /\.(e2e\.mts|ts)$/).filter(({ file }) => !file.endsWith('e2eBackground.test.ts') && !file.includes('fixtures'));
  for (const { file, src } of suites) {
    const made = [...src.matchAll(/new BrowserWindow\(/g)];
    if (file === path.join('test', 'support', 'app.ts')) {
      assert.equal(made.length, 1, 'openWindow makes one');
      assert.match(src, /new BrowserWindow\(e2e \? e2e\.windowOptions\(options\) : options\);\n\s*if \(e2e\) e2e\.show\(win\);/, 'the background\'s way when the app is in it');
    } else assert.equal(made.length, 0, `${file}: makes its own window: use openWindow (test/support/app.ts)`);
    assert.ok(!/(?:BrowserWindow|getAllWindows\(\)|getFocusedWindow\(\))[^\n]*\.(?:show|focus|restore|maximize|moveTop|showInactive)\(/.test(src), `${file}: shows or focuses a window`);
    assert.ok(!/\bbringToFront\(|\bapp\.focus\(|\bdock\.show\(/.test(src), `${file}: brings the app forward`);
  }
});
