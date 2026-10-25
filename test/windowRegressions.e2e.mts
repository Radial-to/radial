/// <reference path="../src/renderer/types.d.ts" />
// Regression tests for the window script (renderer.ts), in a real Chromium.
// The page is the built index.html with every window script, as the app loads
// it; only the preload's API is a stand-in: each window.radial method records
// its call and answers from the test's fakes (null when a test gives none), so
// a test drives renderer.ts's own functions and reads what reached the
// preload's boundary or the page.
//
// Opt-in: `npm run test:e2e` (NOT part of `npm test`, which stays browser-free).
// Skips cleanly if Playwright/Chromium isn't available.
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import type { Browser, Page } from 'playwright-core';
import type { RadialApi } from '../src/shared/radialApi.ts';

const require = createRequire(import.meta.url);
type Playwright = typeof import('playwright-core');

// ── The page ─────────────────────────────────────────────────────────────────
/** One call that reached the stand-in preload API. */
interface FakeCall { name: string; args: unknown[] }
/** A stand-in for one window.radial method. */
type FakeMethod = (...args: never[]) => unknown;
/** What the stand-in preload adds to the page's window. */
interface FakeWindow extends Window {
  radial: RadialApi;
  /** Every window.radial call, in order. */
  __calls: FakeCall[];
  /** The test's answers, by method name; a method without one answers null (a Promise of it). */
  __fake: Record<string, FakeMethod>;
  /** Callbacks the window registered with window.radial.on…, by method name. */
  __on: Record<string, ((payload: never) => void)[]>;
  /**
   * A project tab with just what a test's code path reads, plus `fields`: a
   * stand-in, since the window's own tabs come from createTab and a real preview.
   */
  __tab(fields?: Partial<Tab>): Tab;
  /** The stand-in preview each __tab gets (a real one is an Electron <webview>). */
  __preview(): StandInPreview;
  /** nativeChat.js's API (a plain object: tests replace its methods). */
  RadialNativeChat: RadialNativeChatApi;
  /** Answers a stood-in send that waits for its CLI's own question: whether it went in. */
  __deliver?: (delivered: boolean) => void;
}
declare const window: FakeWindow;

// renderer.ts's top-level declarations, which page functions reach by name.
declare let toolPanelState: ToolPanelState | null;
declare function tpState(): ToolPanelState;
declare function tpSave(): void;
declare function mountPublishingSettings(body: HTMLElement, tab: Tab): void;
declare const tabs: Tab[];
declare let activeId: string | null;
declare function buildBranchesBody(): string;
declare let ctxState: ContextFileState | null;
declare function openContextFile(tab: Tab, rel: string, name: string, editing?: boolean): Promise<void>;
declare function closeContextFile(): void;
declare function refreshOpenContextFromDisk(tab: Tab | null, statusLabel?: string): Promise<void>;
declare function saveCtx(): Promise<void>;
declare let homeActive: boolean;
declare const homeTab: HomeTab;
declare let termOpen: boolean;
declare function quickEditToTerminal(tab: AnyTab, termId: string, payload: AgentPrompt): Promise<boolean | undefined>;
declare let sessionTweaks: SessionTweak[];
declare function stageReconcileNote(): Promise<void>;
declare function engineSend(tab: AnyTab | null | undefined, payload?: AgentPrompt): Promise<boolean>;
declare function engineSendQuiet(tab: AnyTab | null | undefined, payload?: AgentPrompt): Promise<boolean>;
// Function declarations, so tests can stand in for the CLI's boot wait and the verified paste.
declare let whenTermReady: (term: TermSession | null | undefined) => Promise<void>;
declare let typeTask: (term: TermSession, task: string, submit: boolean) => Promise<import('../src/shared/agentPaste.ts').TypedTask>;
declare function autoPullNow(tab: Tab | null | undefined): Promise<void>;
declare function sendAllComments(tab: Tab | null | undefined): Promise<void>;
declare function startBuildFix(tab: Tab | null | undefined, auto: boolean): void;
declare function fixBuildErrorWithAgent(tab: Tab | null | undefined, auto: boolean): void;
declare function sendAgentMessage(): Promise<void>;
declare function setAgentInputText(str: string): void;
declare function agentInputText(): string;
declare function termAsking(term: TermSession): Promise<boolean>;
declare function openNewTermMenu(anchor: HTMLElement, tab: AnyTab): Promise<void>;
declare function openHomeMenu(anchor: HTMLElement, items: MenuAction[], last?: boolean): void;
declare let quickEdit: QuickEditState | null;
declare function showQuickEdit(tab: Tab, sel: PreviewSelection, opts?: { pill?: boolean }): void;
declare function hideQuickEdit(clearSelection?: boolean, keepStyles?: boolean): void;
declare function submitQuickEdit(textOverride?: string, targetOverride?: string, imagesExtra?: string[]): Promise<boolean | undefined>;
declare function buildAdjustBody(adj: QuickAdjust | null | undefined): string;
/** The Design panel's stand-in values for a ghosted panel: a complete AdjustCurrent. */
declare const TP_GHOST_CUR: AdjustCurrent;
declare function handleWebviewMessage(tab: Tab, e: PreviewIpcMessageEvent): Promise<void>;
declare function closeTab(id: string | null, opts?: { confirm?: boolean; force?: boolean; anchor?: HTMLElement | null }): Promise<void>;
declare function homeOpenCreate(tab: 'template' | 'github' | 'folder' | 'migrate', tpl?: 'astro' | 'next' | 'html'): void;
/** renderer.ts's handoff of a text edit the direct editor couldn't place (`res` is its failure: the reason and the candidate spots). */
declare function handTextEditToAgent(tab: Tab, edit: import('../src/shared/radialApi.ts').TextEdit, res: { ok: false; reason: string; candidates: { relFile: string; line: number }[] }): void;
/** renderer.ts's link editor: the modal a link's Edit link badge opens, and its Save. */
declare function openLinkModal(tab: Tab, payload: EditLinkRequest): void;
declare function confirmLink(): Promise<void>;

/** The project's preview as these tests need it: what the window sends the page (overlay channel and payload) collects in `sent`. */
interface StandInPreview extends HTMLElement { send(channel: string, payload?: unknown): void; reload(): void; sent: [string, unknown][] }

/**
 * Runs `fn` in the page and returns every exception thrown while it ran,
 * caught ones included (the debugger pauses on each and resumes at once):
 * a swallowed exception leaves no other trace.
 */
async function exceptionsDuring(page: Page, fn: () => Promise<unknown>): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  const thrown: string[] = [];
  cdp.on('Debugger.paused', (e: { reason: string; data?: { description?: string } }) => {
    if (e.reason === 'exception' || e.reason === 'promiseRejection') thrown.push((e.data?.description || '').split('\n')[0]);
    cdp.send('Debugger.resume').catch(() => {});
  });
  await cdp.send('Debugger.enable');
  await cdp.send('Debugger.setPauseOnExceptions', { state: 'all' });
  try { await page.evaluate(fn); } finally { await cdp.send('Debugger.disable').catch(() => {}); await cdp.detach().catch(() => {}); }
  return thrown;
}

/** The toast's text when it is showing, else null. */
function toastText(page: Page): Promise<string | null> {
  return page.evaluate(() => { const t = document.getElementById('toast')!; return t.style.display === 'block' ? t.textContent : null; });
}

/** Sends the window a request from main's askRenderer (cli:request) and returns what it replied (cli:reply). */
function askWindow(page: Page, op: string, payload: object): Promise<unknown> {
  return page.evaluate(async ([op, payload]) => {
    let reply: unknown = null;
    window.__fake.cliReply = (r: unknown) => { reply = r; };
    await (window.__on.onCliRequest[0] as (request: { reqId: string; op: string; payload: object }) => Promise<void>)({ reqId: 'w1', op, payload });
    return reply;
  }, [op, payload] as const);
}

function loadPlaywright(): Playwright | null {
  for (const r of [path.join(process.cwd(), 'node_modules'), path.join(process.cwd(), '..', 'node_modules')]) {
    for (const name of ['playwright', 'playwright-core']) {
      try { return require(path.join(r, name)) as Playwright; } catch {}
    }
  }
  return null;
}

/** Installs the stand-in preload API before the window scripts run (an init script). */
function fakePreload(): void {
  window.__calls = []; window.__fake = {}; window.__on = {};
  // An element (the window styles and classes its previews) that records what's sent to the page.
  window.__preview = () => { const sent: [string, unknown][] = []; return Object.assign(document.createElement('div'), { sent, send(channel: string, payload?: unknown) { sent.push([channel, payload]); }, reload() {} }); };
  window.__tab = (fields = {}) => ({ id: 'tab-site', repoDir: '/site', name: 'site', terminals: [], webview: window.__preview() as unknown as RadialWebview, ...fields }) as Tab;
  window.radial = new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop === 'overlayPreloadUrl') return '';
      return (...args: never[]) => {
        window.__calls.push({ name: prop, args });
        const fake = window.__fake[prop];
        if (fake) return fake(...args);
        if (prop.startsWith('on')) { (window.__on[prop] ||= []).push(args[0]); return () => {}; }
        if (prop === 'getDroppedPath') return null;
        return Promise.resolve(null);
      };
    },
  }) as RadialApi;
}

let browser: Browser | null = null;
/** A fresh window: index.html and its scripts, with the stand-in preload. Errors the page throws after it loaded collect in `errors`. */
async function openWindow(t: import('node:test').TestContext): Promise<{ page: Page; errors: string[] } | null> {
  if (!browser) {
    const pw = loadPlaywright();
    if (!pw) { t.skip('Playwright not available'); return null; }
    try { browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); } catch (e) { t.skip('Chromium launch failed: ' + (e as Error).message); return null; }
  }
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript(fakePreload);
  await page.goto('file://' + path.join(process.cwd(), 'out/renderer/index.html'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { page, errors };
}
test.after(async () => { if (browser) await browser.close(); });
/** Each test's options: a hung page fails the test instead of the run. */
const T = { timeout: 30000 };

// ── Tool panels ──────────────────────────────────────────────────────────────

test('update card: an update macOS refuses offers the download, and Restart only once it installs', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const { page, errors } = w;
  const r = await page.evaluate(() => {
    const card = document.getElementById('updateCard')!;
    const button = document.getElementById('ucRestart') as HTMLButtonElement;
    const read = () => ({ shown: card.style.display, title: card.querySelector('.cc-title')!.textContent, sub: document.getElementById('ucSub')!.textContent, button: button.textContent });
    (window.__on.onUpdateRefused[0] as (p: { version: string; url: string }) => void)({ version: '2.0.0', url: 'https://radial.to/download' });
    const refused = read();
    window.__calls = [];
    button.click();
    const refusedCalls = window.__calls.map((c) => [c.name, c.args]);
    // Squirrel takes it on a later check: the same card turns into Restart.
    (window.__on.onUpdateReady[0] as (p: { version: string }) => void)({ version: '2.0.0' });
    const ready = read();
    window.__calls = [];
    button.click();
    return { refused, refusedCalls, ready, readyCalls: window.__calls.map((c) => c.name) };
  });
  assert.equal(r.refused.shown, 'flex');
  assert.equal(r.refused.title, 'Update available');
  assert.equal(r.refused.button, 'Download');
  assert.match(r.refused.sub || '', /^Radial 2\.0\.0 can’t install itself on this Mac\. Download it/);
  assert.deepEqual(r.refusedCalls, [['openExternal', ['https://radial.to/download']]], 'Download opens the download page, and no restart is tried');
  assert.equal(r.ready.title, 'Update ready');
  assert.equal(r.ready.button, 'Restart now');
  assert.deepEqual(r.readyCalls, ['updateRestart']);
  assert.deepEqual(errors, []);
});

test('tool panels: the arrangement someone saved survives the next launch (the migrations run once)', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const { page } = w;
  const after = await page.evaluate(() => {
    // First run seeds the default workspace (every migration, once) …
    const s = tpState();
    // … then the person closes Layers and drags the Agent panel out to float; the app saves.
    s.layers.open = false; s.terminal.pinned = false;
    tpSave();
    // The next launch reads the saved state fresh.
    toolPanelState = null;
    const next = tpState();
    return { v: next._v, layersOpen: next.layers.open, agentPinned: next.terminal.pinned };
  });
  assert.equal(after.layersOpen, false, 'Layers stays closed after a relaunch');
  assert.equal(after.agentPinned, false, 'the Agent panel stays where it was dragged');
  assert.equal(after.v, 16);
});

test('tool panels: a first run and Restore defaults still seed the shipped workspace', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const seeded = await w.page.evaluate(() => {
    const s = tpState();
    const groups = Object.values(s._groups || {}).map((g) => g.panels.join(','));
    return { v: s._v, agent: s.terminal.pinned, content: s.content.pinned, layers: s.layers.open, design: s.adjust.open, groups };
  });
  assert.deepEqual(seeded, { v: 16, agent: 'home', content: 'right', layers: true, design: false, groups: ['terminal,context', 'content,layers,comments'] });
});

test('tool panels: a state saved by an old build still gets every later migration once', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const migrated = await w.page.evaluate(() => {
    // A v6 save: the agent in its home slot, Design floating, Comments pinned
    // to the retired left dock.
    const old = JSON.parse(JSON.stringify(tpState())) as ToolPanelState;
    old._v = 6; old._groups = {};
    old.comments.open = true; old.comments.pinned = 'left';
    localStorage.setItem('radial.toolPanels', JSON.stringify(old));
    toolPanelState = null;
    const s = tpState();
    const groups = Object.values(s._groups || {}).map((g) => g.panels.join(','));
    return { v: s._v, comments: s.comments.pinned, agent: s.terminal.pinned, groups };
  });
  assert.equal(migrated.v, 16);
  assert.equal(migrated.comments, 'right', 'v8 moved the left dock right, and v13 seeded Comments into the right group');
  assert.equal(migrated.agent, 'home', 'v7 pinned the agent home');
  assert.deepEqual(migrated.groups, ['terminal,context', 'content,layers,comments']);
});

// ── Project settings ─────────────────────────────────────────────────────────

test('project settings: a Vercel project in a team reads "Linked to <project> · <team name>"', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const line = await w.page.evaluate(async () => {
    window.__fake.vercelProjectInfo = async () => ({ linked: true, project: 'marketing-site', team: { slug: 'acme-studio', name: 'Acme Studio' }, dashboardUrl: 'https://vercel.com/acme-studio/marketing-site', urls: { production: null, staging: null } });
    const body = document.createElement('div'); document.body.append(body);
    mountPublishingSettings(body, window.__tab());
    const hosting = body.querySelector('[data-hosting]')!;
    for (let i = 0; i < 50 && hosting.textContent === 'Checking linked project…'; i++) await new Promise((r) => setTimeout(r, 20));
    return hosting.textContent;
  });
  assert.equal(line, 'Linked to marketing-site · Acme Studio.');
});

// ── Branches panel ───────────────────────────────────────────────────────────

/** The Branches panel's Vercel row once its reads answer: [row text, its Open link] or null without a row. */
async function branchesVercelRow(page: Page, link: object): Promise<[string, string | null] | null> {
  return page.evaluate(async (vercelLink) => {
    window.__fake.branchList = async () => ({ ok: true, current: 'main', branches: ['main'], remoteOnly: [] });
    window.__fake.checkPushAuth = async () => ({ ready: true, hasRemote: true, remote: 'https://github.com/acme/site.git' });
    window.__fake.vercelStatus = async () => ({ installed: true, authed: true, user: 'acme', link: vercelLink });
    tabs.push(window.__tab()); activeId = 'tab-site';
    buildBranchesBody(); // starts the reads
    await new Promise((r) => setTimeout(r, 50));
    const host = document.createElement('div'); host.innerHTML = buildBranchesBody();
    const row = [...host.querySelectorAll('.psr')].find((r) => r.querySelector('.psr-name')!.textContent === 'Vercel');
    return row ? [row.querySelector('.psr-sub')!.textContent!, row.querySelector<HTMLElement>('[data-br-vercel]')?.dataset.brVercel ?? null] : null;
  }, link);
}

test('branches panel: a folder with no Vercel link shows no linked Vercel project', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  assert.equal(await branchesVercelRow(w.page, { linked: false }), null);
});

test('branches panel: a linked Vercel project opens its site, as the branch menu does', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const row = await branchesVercelRow(w.page, { linked: true, projectId: 'prj_1', orgId: 'team_1', name: 'marketing-site', liveUrl: 'https://marketing-site.vercel.app', scope: 'acme-studio', dashboardUrl: 'https://vercel.com/acme-studio/marketing-site' });
  assert.deepEqual(row, ['marketing-site', 'https://marketing-site.vercel.app']);
});

// ── Context files ────────────────────────────────────────────────────────────

test('context editor: an agent edit to a file that was just switched away from never lands in the next file', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const result = await w.page.evaluate(async () => {
    // Reads answer when the test says: an agent's edit to a.md is read from
    // disk while b.md is opening, and b.md's read lands first.
    const reads: { rel: string; resolve: (read: { ok: true; content: string; abs: string }) => void }[] = [];
    window.__fake.contextRead = (_dir: string, rel: string) => new Promise((resolve) => reads.push({ rel, resolve }));
    const answer = (rel: string, content: string) => { const i = reads.findIndex((r) => r.rel === rel); reads.splice(i, 1)[0].resolve({ ok: true, content, abs: '/site/.context/' + rel }); };
    const writes: [string, string][] = [];
    window.__fake.contextWrite = async (_dir: string, rel: string, content: string) => { writes.push([rel, content]); return { ok: true }; };
    const tab = window.__tab(); tabs.push(tab); activeId = tab.id;
    const editor = document.getElementById('ctxEditor') as HTMLTextAreaElement;
    const openA = openContextFile(tab, 'a.md', 'a.md'); answer('a.md', 'A as it was'); await openA;
    const openB = openContextFile(tab, 'b.md', 'b.md'); // the person clicks b.md …
    const refresh = refreshOpenContextFromDisk(tab); // … as the agent's edit to a.md is noticed
    answer('b.md', 'B as it is');
    await openB;
    answer('a.md', 'A after the agent');
    await refresh;
    const shown = { rel: ctxState!.rel, editor: editor.value };
    await saveCtx(); // the next keystroke's save
    // Closing a file while its refresh is in flight: nothing is left to update.
    const openC = openContextFile(tab, 'c.md', 'c.md'); answer('c.md', 'C as it was'); await openC;
    const refreshC = refreshOpenContextFromDisk(tab);
    closeContextFile();
    answer('c.md', 'C after the agent');
    const closedRefresh = await refreshC.then(() => 'settled', (e: Error) => e.message);
    return { shown, writes, closedRefresh };
  });
  assert.deepEqual(result.shown, { rel: 'b.md', editor: 'B as it is' }, 'b.md keeps its own text');
  assert.deepEqual(result.writes, [['b.md', 'B as it is']], 'saving b.md writes b.md’s text');
  assert.equal(result.closedRefresh, 'settled');
});

// ── Requests from main (cli:request) ────────────────────────────────────────

test('visibleAgents: Home without its folder yet still reports the chat on screen', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  // Home is showing and the agent dock is open, but Home's folder isn't known
  // (initHomeTab hasn't answered, or homeInfo failed): agentTab() is null.
  await w.page.evaluate(() => { homeActive = true; homeTab.repoDir = null; termOpen = true; window.RadialNativeChat.visibleId = () => 'chat-on-screen'; });
  assert.deepEqual(await askWindow(w.page, 'visibleAgents', {}), { reqId: 'w1', ok: true, chatIds: ['chat-on-screen'], termIds: [] });
});

test('reload: a project the window has no tab for answers not-open, which main passes on as the CLI’s not-open', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  // main's cliApi.reload maps reason 'asleep' and otherwise passes code and error through.
  assert.deepEqual(await askWindow(w.page, 'reload', { repoDir: '/elsewhere' }), { reqId: 'w1', ok: false, code: 'not-open', error: 'The project is not open in the window.' });
});

// ── Quick edits to agents ────────────────────────────────────────────────────

test('quick edit: a chat in Terminal view whose CLI has exited says it is unavailable instead of a raw error', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const sent = await w.page.evaluate(async () => {
    const tab = window.__tab(); tabs.push(tab); activeId = tab.id; homeActive = false;
    const chat = window.RadialNativeChat;
    chat.enabled = () => true; chat.selected = () => true; chat.select = async () => {};
    // main keeps viewMode 'terminal' and clears terminalId when the native CLI exits or the chat is parked.
    window.__fake.nativeChatGet = async () => ({ id: 'chat-1', repoDir: '/site', viewMode: 'terminal', terminalId: null });
    return quickEditToTerminal(tab, 'native:chat-1', { text: 'Make the headline bigger', selections: [], submit: true, label: 'Bigger headline' })
      .then((r) => String(r), (e: Error) => 'threw: ' + e.message);
  });
  assert.equal(sent, 'false');
  assert.equal(await toastText(w.page), 'That chat is unavailable. Choose another chat.');
});

test('reconcile: the tweaks note goes to the agent, not to a shell opened after it', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const pastedInto = await w.page.evaluate(async () => {
    // An agent session, then a plain shell (newTerminal(tab, null)): both live,
    // the shell last. _pasteReady: both are past their boot, so nothing waits.
    const tab = window.__tab({ terminals: [
      { id: 'term-claude', engine: 'claude', label: 'Claude Code', _pasteReady: true },
      { id: 'term-shell', engine: null, label: 'Shell', _pasteReady: true },
    ] });
    tabs.push(tab); activeId = tab.id; homeActive = false;
    sessionTweaks.push({ id: 'tw1', repoDir: '/site', route: '/', tag: 'h1', prop: 'font-size', from: '40px', to: '44px', source: '.hero-title', offScale: true, selRef: { selector: 'h1.hero-title', tagName: 'h1' } as PreviewSelection });
    const pastes: string[] = [];
    typeTask = async (term) => { pastes.push(term.id); return { landed: true, waiting: false, typed: true, delivered: Promise.resolve(true), typing: Promise.resolve(), cancel: () => false }; };
    await stageReconcileNote();
    return pastes;
  });
  assert.deepEqual(pastedInto, ['term-claude']);
});

// ── Sending to agent CLIs ────────────────────────────────────────────────────

/**
 * A sleeping project whose only Claude session is a slept rail row (no PTY, no
 * xterm; it relaunches when the project wakes, as Home's do on a click), and a
 * record of what reaches the CLIs.
 */
async function sleptAgentProject(page: Page): Promise<void> {
  await page.evaluate(() => {
    const tab = window.__tab({ terminals: [{ id: 'slept:s1', sleptId: 's1', engine: 'claude', label: 'Claude Code', _slept: true, detached: true }], activeTerminalId: 'slept:s1', suspended: true });
    tabs.push(tab); activeId = tab.id; homeActive = false;
    window.__fake.engineAvailable = async () => ({ claude: true });
    window.__fake.termStart = async () => ({ id: 'term-new' });
    // The CLI's boot wait and the verified paste, stood in: they'd wait for a real PTY.
    whenTermReady = async () => {};
    typeTask = async (term) => { window.__calls.push({ name: 'typeTask', args: [term.id] }); return { landed: true, waiting: false, typed: true, delivered: Promise.resolve(true), typing: Promise.resolve(), cancel: () => false }; };
  });
}
/** Which session each prompt reached: 'paste:<id>' for a paste into a running one, 'start:<initial text>' for a CLI started with it. */
function deliveries(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__calls.flatMap((c) => c.name === 'typeTask' ? ['paste:' + c.args[0]]
    : c.name === 'termStart' ? ['start:' + ((c.args[4] as { initialText?: string }).initialText || '')] : []));
}

test('engineSend: a slept agent is not taken for a live session', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  await sleptAgentProject(w.page);
  const result = await w.page.evaluate(() => engineSend(tabs[0], { text: 'Tighten the hero copy' }).then(String, (e: Error) => 'threw: ' + e.message));
  assert.equal(result, 'true');
  assert.deepEqual(await deliveries(w.page), ['start:', 'paste:term-new'], 'a new session starts and gets the prompt');
});

test('auto-pull: a prompt sent while the agent sleeps starts a session instead of pasting into the sleeping one', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  await sleptAgentProject(w.page);
  const result = await w.page.evaluate(() => engineSendQuiet(tabs[0], { text: 'Address this comment' }).then((sent) => String(!!sent), (e: Error) => 'threw: ' + e.message));
  assert.equal(result, 'true');
  assert.deepEqual(await deliveries(w.page), ['start:Address this comment']);
});

// ── Review comments ──────────────────────────────────────────────────────────

/** Turns comment auto-pull on for a project with these open comments, runs one pull, and reports the prompt the agent started with and which comments were marked addressed. */
function autoPull(page: Page, comments: Partial<ReviewComment>[]): Promise<{ prompt: string | null; addressed: string[] }> {
  return page.evaluate(async (list) => {
    const tab = window.__tab(); tabs.push(tab); activeId = tab.id; homeActive = false;
    localStorage.setItem('radial.autoPull./site', '1');
    const full = list.map((c) => ({ route: '/', selector: 'h1', anchor: '<h1>', offsetX: null, offsetY: null, file: '', quote: '', text: '', who: '', resolved: false, createdAt: 1, ...c }));
    window.__fake.commentsList = async () => full;
    window.__fake.engineAvailable = async () => ({ claude: true });
    let prompt: string | null = null;
    window.__fake.termStart = async (...args: unknown[]) => { prompt = (args[4] as { initialText?: string }).initialText || null; return { id: 'term-new' }; };
    const addressed: string[] = [];
    window.__fake.commentsUpdate = async (_dir: string, id: string, patch: { addressed?: boolean }) => { if (patch.addressed) addressed.push(id); return {}; };
    await autoPullNow(tab);
    return { prompt, addressed };
  }, comments);
}

test('comments: an image-only comment auto-pulls to the agent, with its image', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const { prompt, addressed } = await autoPull(w.page, [{ id: 'c1', images: ['/site/.radial/comments/hero-mockup.png'] }]);
  assert.ok(prompt && prompt.includes('Comment 1, page /, element <h1> (selector: h1):'), `the prompt names the comment (got ${JSON.stringify(prompt)})`);
  assert.ok(prompt.includes('Attached reference image: /site/.radial/comments/hero-mockup.png'), 'and carries its image');
  assert.deepEqual(addressed, ['c1']);
});

test('comments: a batch marks addressed only what the agent was sent, image-only comments included', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const { prompt, addressed } = await autoPull(w.page, [{ id: 'c1', text: 'Make the headline shorter' }, { id: 'c2', images: ['/site/.radial/comments/footer.png'] }]);
  assert.ok(prompt && prompt.includes('Comment 1, page /, element <h1> (selector: h1):\n"Make the headline shorter"'), `the text comment is there (got ${JSON.stringify(prompt)})`);
  assert.ok(prompt.includes('Comment 2, page /, element <h1> (selector: h1):\n  Attached reference image: /site/.radial/comments/footer.png'), 'and so is the image-only one');
  assert.deepEqual(addressed, ['c1', 'c2']);
});

// ── Sends that wait for a CLI's own question ─────────────────────────────────

/**
 * A project whose Claude session is past its boot, with typeTask stood in: a
 * send waits for the CLI's own question (approving a command, say) until the
 * test answers window.__deliver(true), it went in, or (false), its session went.
 */
async function askingAgentProject(page: Page): Promise<void> {
  await page.evaluate(() => {
    const tab = window.__tab({ terminals: [{ id: 'term-claude', engine: 'claude', label: 'Claude Code', _pasteReady: true }], activeTerminalId: 'term-claude' });
    tabs.push(tab); activeId = tab.id; homeActive = false;
    window.__fake.engineAvailable = async () => ({ claude: true });
    whenTermReady = async () => {};
    typeTask = async (term, task) => {
      window.__calls.push({ name: 'typeTask', args: [term.id, task] });
      return { landed: false, waiting: true, typed: false, delivered: new Promise<boolean>((resolve) => { window.__deliver = resolve; }), typing: Promise.resolve(), cancel: () => false };
    };
  });
}
/** Open comments, and which of them the window marks addressed (in `addressed`, as it does). */
function openComments(page: Page): Promise<void> {
  return page.evaluate(() => {
    window.__fake.commentsList = async () => [{ id: 'c1', route: '/', selector: 'h1', anchor: '<h1>', offsetX: null, offsetY: null, file: '', quote: '', text: 'Make the headline shorter', who: '', resolved: false, createdAt: 1 }];
    (window as unknown as { addressed: string[] }).addressed = [];
    window.__fake.commentsUpdate = async (_dir: string, id: string, patch: { addressed?: boolean }) => { if (patch.addressed) (window as unknown as { addressed: string[] }).addressed.push(id); return {}; };
  });
}

test('auto-pull: comments waiting for the agent CLI\'s own question are marked addressed once they\'re in, never before, and stay open if its session goes', T, async (t) => {
  for (const delivered of [true, false]) {
    const w = await openWindow(t); if (!w) return;
    await askingAgentProject(w.page);
    await openComments(w.page);
    const r = await w.page.evaluate(async (delivered) => {
      localStorage.setItem('radial.autoPull./site', '1');
      const read = () => [...(window as unknown as { addressed: string[] }).addressed];
      const pull = autoPullNow(tabs[0]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const waiting = read();
      await autoPullNow(tabs[0]); // another pull meanwhile sends nothing more
      window.__deliver!(delivered);
      await pull;
      return { waiting, addressed: read(), sends: window.__calls.filter((c) => c.name === 'typeTask').length };
    }, delivered);
    assert.deepEqual(r, { waiting: [], addressed: delivered ? ['c1'] : [], sends: 1 }, `delivered: ${delivered}`);
  }
});

test('Pull comments: comments waiting for the agent CLI\'s own question are marked addressed once they\'re in', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  await askingAgentProject(w.page);
  await openComments(w.page);
  const r = await w.page.evaluate(async () => {
    const read = () => [...(window as unknown as { addressed: string[] }).addressed];
    const pull = sendAllComments(tabs[0]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waiting = read();
    window.__deliver!(true);
    await pull;
    return { waiting, addressed: read() };
  });
  assert.deepEqual(r, { waiting: [], addressed: ['c1'] });
  assert.match(await toastText(w.page) || '', /^Claude Code is asking a question of its own in the terminal\. Answer it, and the prompt is staged\.$/);
});

test('Fix with agent: an attempt waiting for the agent CLI\'s own question counts once it\'s in, and holds the next until then', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  await askingAgentProject(w.page);
  const r = await w.page.evaluate(async () => {
    const tab = tabs[0];
    tab._buildError = 'Module not found: Can\'t resolve \'./Hero\'';
    startBuildFix(tab, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const counted = tab._buildFixAttempts;
    fixBuildErrorWithAgent(tab, true); // the loop's next attempt, while the first still waits
    await new Promise((resolve) => setTimeout(resolve, 50));
    const sends = window.__calls.filter((c) => c.name === 'typeTask').length;
    window.__deliver!(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { counted, sends, attempts: tab._buildFixAttempts, waiting: tab._buildFixWaiting, active: tab._buildFixActive };
  });
  assert.deepEqual(r, { counted: 0, sends: 1, attempts: 1, waiting: false, active: true });
});

test('the composer gives a message back that didn\'t go in (its session gone before the CLI\'s own question was answered), never one it typed', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  await askingAgentProject(w.page);
  const r = await w.page.evaluate(async () => {
    setAgentInputText('Make the hero bigger');
    await sendAgentMessage();
    const waiting = agentInputText(); // it waits to go in: the composer is clear
    window.__deliver!(false); // its session went first
    await new Promise((resolve) => setTimeout(resolve, 20));
    const back = agentInputText();
    // Typed and sent the old direct way, though never seen on its screen: giving it back would invite a second send.
    typeTask = async () => ({ landed: false, waiting: false, typed: true, delivered: Promise.resolve(true), typing: Promise.resolve(), cancel: () => false });
    setAgentInputText('Tighten the footer');
    await sendAgentMessage();
    const unseen = agentInputText();
    // Nothing typed at all: back.
    typeTask = async () => ({ landed: false, waiting: false, typed: false, delivered: Promise.resolve(false), typing: Promise.resolve(), cancel: () => false });
    setAgentInputText('Fix the nav');
    await sendAgentMessage();
    return { waiting, back, unseen, untyped: agentInputText() };
  });
  assert.deepEqual(r, { waiting: '', back: 'Make the hero bigger', unseen: '', untyped: 'Fix the nav' });
  assert.equal(await toastText(w.page), 'Couldn’t confirm the prompt reached the agent. Check the terminal.');
});

test('Home keeps a message waiting for its agent CLI\'s own question until it goes in, says so when it never does, and can call it off until it begins to go in', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const r = await w.page.evaluate(async () => {
    homeTab.repoDir = '/home'; homeActive = true; activeId = null;
    homeTab.terminals = [{ id: 'term-home', engine: 'claude', label: 'Claude Code', _pasteReady: true } as TermSession];
    homeTab.activeTerminalId = 'term-home';
    window.__fake.engineAvailable = async () => ({ claude: true });
    window.__fake.workspaceActivity = async () => ({ projects: [], terminals: [] });
    whenTermReady = async () => {};
    // Each send waits; the test says when it begins to type (typing) and when it went in (delivered). Once it has begun
    // to type, it can't be called off.
    const sends: { deliver: (ok: boolean) => void; begin: () => void; started: boolean }[] = [];
    let cancels = 0;
    typeTask = async () => {
      const s = { deliver: (_ok: boolean) => {}, begin: () => {}, started: false };
      const delivered = new Promise<boolean>((resolve) => { s.deliver = resolve; });
      const typing = new Promise<void>((resolve) => { s.begin = () => { s.started = true; resolve(); }; });
      sends.push(s);
      return { landed: false, waiting: true, typed: false, delivered, typing, cancel: () => { if (s.started) return false; cancels++; s.deliver(false); return true; } };
    };
    const input = document.getElementById('hgChatInput') as HTMLTextAreaElement;
    const send = document.getElementById('hgChatSend') as HTMLButtonElement;
    const cancel = document.getElementById('hgChatCancel') as HTMLButtonElement;
    const status = () => document.getElementById('hgChatStatus')!.textContent;
    const now = () => ({ input: input.value, status: status(), cancel: !cancel.hidden });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    input.value = 'What changed today?';
    document.getElementById('hgChatForm')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const waiting = now();
    sends[0].deliver(true);
    await settle();
    const done = now();
    input.value = 'And yesterday?';
    document.getElementById('hgChatForm')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    sends[1].deliver(false);
    await settle();
    const lost = now();
    // Called off while it waits: the message stays to send again, and the button is back.
    document.getElementById('hgChatForm')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const sendWhileWaiting = send.disabled;
    cancel.click();
    await settle();
    const calledOff = { ...now(), cancels, send: send.disabled };
    // Once it begins to go in (the question answered, its paste on its way to its Enter), "Don't send" goes: called
    // off then, the text would sit in the CLI's input, and a retry would send it twice. It goes on to its end.
    document.getElementById('hgChatForm')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const beforeTyping = !cancel.hidden;
    sends[3].begin();
    await settle();
    const typing = now();
    cancel.click(); // a click that was already on its way
    await settle();
    sends[3].deliver(true);
    await settle();
    return { waiting, done, lost, sendWhileWaiting, calledOff, beforeTyping, typing, sent: { ...now(), cancels } };
  });
  assert.deepEqual(r.waiting, { input: 'What changed today?', status: 'Your workspace agent is asking a question of its own in its terminal. Answer it, and your message goes in.', cancel: true });
  assert.deepEqual(r.done, { input: '', status: 'Sent to your workspace agent.', cancel: false });
  assert.deepEqual(r.lost, { input: 'And yesterday?', status: 'Your message didn’t reach your workspace agent: its session ended. It’s still here to retry.', cancel: false });
  assert.equal(r.sendWhileWaiting, true, 'one message at a time');
  assert.deepEqual(r.calledOff, { input: 'And yesterday?', status: 'Not sent. Your message is still here.', cancel: false, cancels: 1, send: false });
  assert.equal(r.beforeTyping, true, 'it can be called off while it waits');
  assert.deepEqual(r.typing, { input: 'And yesterday?', status: 'Your workspace agent is asking a question of its own in its terminal. Answer it, and your message goes in.', cancel: false }, 'not once it begins to go in');
  assert.deepEqual(r.sent, { input: '', status: 'Sent to your workspace agent.', cancel: false, cancels: 1 }, 'a late click calls nothing off: sent once');
});

test('a delete, an edit the editor couldn\'t place, or a brief waiting for the agent CLI\'s own question says so when it never goes in', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  await askingAgentProject(w.page);
  const r = await w.page.evaluate(async () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    const toast = () => { const el = document.getElementById('toast')!; return el.style.display === 'block' ? el.textContent : null; };
    handTextEditToAgent(tabs[0], { route: '/', originalText: 'Ship faster', newText: 'Ship today', context: { tagName: 'h1' } } as import('../src/shared/radialApi.ts').TextEdit, { ok: false, reason: 'not-found', candidates: [] });
    await settle();
    const asked = toast();
    window.__deliver!(false);
    await settle();
    return { asked, lost: toast() };
  });
  assert.equal(r.asked, 'The agent is asking a question of its own in the terminal. Answer it, and this edit goes in.');
  assert.equal(r.lost, 'This edit didn’t reach the agent: its session ended before its question was answered.');
});

test('a send asks the terminal service whether a CLI asks its own question: an undrawn window can\'t say no for it', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const r = await w.page.evaluate(async () => {
    // Right after a restart: the daemon's screen shows the question, the window's terminal hasn't drawn its replay.
    window.__fake.termAsking = async () => true;
    const term = { id: 'term-claude', engine: 'claude', label: 'Claude Code', _pasteReady: true } as TermSession;
    const daemon = await termAsking(term);
    window.__fake.termAsking = async () => null; // a terminal service too old to say: the window's own screen decides
    const window_ = await termAsking(term);
    return { daemon, window_ };
  });
  assert.deepEqual(r, { daemon: true, window_: false });
});

// ── Closing projects ─────────────────────────────────────────────────────────

test('closing a project: terminals that were never mounted close without an exception', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  await w.page.evaluate(() => {
    // A chat still running in the daemon since the last launch (detached: its
    // xterm mounts on first view) and a native chat's stand-in: neither has an xterm or element.
    const tab = window.__tab({ terminals: [
      { id: 'term-detached', engine: 'claude', label: 'Claude Code', detached: true },
      { id: 'term-chat', engine: 'codex', label: 'Codex', _nativeChatId: 'chat-1', detached: true },
    ] });
    tabs.push(tab); activeId = tab.id; homeActive = false;
  });
  const thrown = await exceptionsDuring(w.page, () => closeTab('tab-site', { force: true }));
  const killed = await w.page.evaluate(() => window.__calls.filter((c) => c.name === 'termKill').map((c) => c.args[0]));
  assert.deepEqual(killed, ['term-detached', 'term-chat'], 'both are stopped');
  assert.deepEqual(thrown.filter((m) => /dispose|remove/.test(m)), [], 'and nothing throws on the xterm or element they never had');
});

// ── New projects ─────────────────────────────────────────────────────────────

test('new project: picking a starter before the form has loaded its templates throws nothing', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  await w.page.evaluate(() => { window.__fake.newProjectInfo = () => new Promise(() => {}); }); // the info hasn't answered yet
  const thrown = await exceptionsDuring(w.page, async () => { homeOpenCreate('template', 'next'); });
  assert.deepEqual(thrown.filter((m) => /templates/.test(m)), []);
});

// ── Menus ────────────────────────────────────────────────────────────────────

test('menus: the New chat menu is named after its row, not "null"', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const name = await w.page.evaluate(async () => {
    window.RadialNativeChat.enabled = () => true;
    window.__fake.engineAvailable = async () => ({ claude: true });
    // The rail's New chat row, as railAgentRowsHtml builds it: no aria-label, its words are its name.
    const row = document.createElement('div'); row.className = 'rail-term rail-term-add'; row.setAttribute('role', 'button'); row.tabIndex = 0;
    row.innerHTML = '<span class="rail-term-plus"></span><span class="rail-term-name">New chat</span>';
    document.body.append(row);
    await openNewTermMenu(row, window.__tab());
    return document.querySelector('.hg-menu')!.getAttribute('aria-label');
  });
  assert.equal(name, 'New chat');
});

test('menus: a placeholder row (no action, disabled) shows disabled and does nothing when clicked', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  // What the native chat's model menu passes while its catalog loads; it
  // reaches openHomeMenu when window.RadialFluidChat is missing.
  const after = await w.page.evaluate(() => {
    const trigger = document.createElement('button'); trigger.setAttribute('aria-label', 'Model'); document.body.append(trigger);
    openHomeMenu(trigger, [{ label: 'Change provider', action: () => {} }, { label: 'Loading models…', disabled: true } as MenuAction]);
    const row = [...document.querySelectorAll<HTMLButtonElement>('.hg-menu button')].find((b) => b.textContent === 'Loading models…')!;
    row.click();
    return { disabled: row.disabled, open: !!document.querySelector('.hg-menu') };
  });
  assert.deepEqual(after, { disabled: true, open: true });
  assert.deepEqual(w.errors, []);
});

// ── The quick edit pill ──────────────────────────────────────────────────────

/** A one-element selection the pill can show under; with `adjust`, its stepper values too (a stand-in: just what these paths read). */
function headline(selector = 'h1.hero', adjust = false): PreviewSelection {
  return { selector, tagName: 'h1', classList: ['hero'], id: null, text: 'Ship your site tonight', rect: { x: 40, y: 40, w: 400, h: 60 },
    ...(adjust ? { adjust: { paddingTop: 8, fontSize: 40, display: 'block' } as AdjustReadout } : {}) } as PreviewSelection;
}

test('quick edit pill: an image pasted just before the pill closes finishes saving without an error', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  await w.page.evaluate(async (sel) => {
    const tab = window.__tab(); tabs.push(tab); activeId = tab.id; homeActive = false;
    let finishSave: (r: { ok: true; abs: string }) => void = () => {};
    window.__fake.savePastedImage = () => new Promise((resolve) => { finishSave = resolve; });
    showQuickEdit(tab, sel);
    const input = document.getElementById('qeInput')!;
    const clip = new DataTransfer(); clip.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'mock.png', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clip, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50)); // the save is under way
    hideQuickEdit(true); // Esc
    finishSave({ ok: true, abs: '/site/.radial/pasted/mock.png' });
    await new Promise((r) => setTimeout(r, 50));
  }, headline());
  assert.deepEqual(w.errors, []);
});

test('quick edit pill: a nudge that finishes writing after a click on another element leaves the new selection alone', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const after = await w.page.evaluate(async ([first, second]) => {
    const tab = window.__tab(); tabs.push(tab); activeId = tab.id; homeActive = false;
    const writes: ((r: { ok: true }) => void)[] = [];
    window.__fake.applyStyleEdit = () => new Promise((resolve) => writes.push(resolve));
    showQuickEdit(tab, first);
    quickEdit!.adj!.deltas['padding-top'] = { from: '8px', to: '16px' }; // a stepper nudge
    const submitting = submitQuickEdit(); // ⏎: the direct write starts
    showQuickEdit(tab, second); // the person clicks another element while it writes
    writes.forEach((finish) => finish({ ok: true }));
    await submitting;
    const sentToPage = (tab.webview as unknown as StandInPreview).sent.map(([channel]) => channel);
    return { pill: document.getElementById('quickEdit')!.style.display, selected: quickEdit && quickEdit.sels.map((s) => s.selector), cleared: sentToPage.includes('radial:clear-selected') };
  }, [headline('h1.hero', true), headline('p.lede', true)] as const);
  assert.deepEqual(after, { pill: 'block', selected: ['p.lede'], cleared: false });
});

test('design panel: nudges made in the Hover state are written when the selection moves on', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const plans = await w.page.evaluate(async ([first, second]) => {
    const tab = window.__tab(); tabs.push(tab); activeId = tab.id; homeActive = false;
    const written: string[] = [];
    window.__fake.applyStyleEdit = async (_dir: string, plans: { kind: string; prop: string }[]) => { written.push(...plans.map((p) => p.kind + ' ' + p.prop)); return { ok: true }; };
    showQuickEdit(tab, first);
    const adj = quickEdit!.adj!;
    adj.sel._styleSources = { '*anchor': { kind: 'rule', selectorText: 'h1.hero', href: 'http://localhost:4321/styles.css' } };
    // A padding nudge in Default, then the panel switches to Hover and the
    // colour changes there; the person clicks elsewhere before either settles.
    adj.deltas['padding-top'] = { from: '8px', to: '16px' };
    quickEdit!._dsMode = 'hover';
    adj.hdeltas = { color: { from: 'rgb(0, 0, 0)', to: 'rgb(200, 0, 0)' } };
    showQuickEdit(tab, second);
    await new Promise((r) => setTimeout(r, 50));
    return written.sort();
  }, [headline('h1.hero', true), headline('p.lede', true)] as const);
  assert.deepEqual(plans, ['css-hover color', 'inline-set padding-top']);
});

test('design panel: the greyed-out panel for a multi-selection asks the page nothing', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const asked = await w.page.evaluate(([first, second]) => {
    const tab = window.__tab(); tabs.push(tab); activeId = tab.id; homeActive = false;
    showQuickEdit(tab, first);
    showQuickEdit(tab, { ...second, additive: true }); // ⇧-click: two elements, so no single one to adjust
    const preview = tab.webview as unknown as StandInPreview;
    preview.sent.length = 0;
    buildAdjustBody(null); // the Design panel's render with no adjustable selection: its greyed-out stand-in
    buildAdjustBody(null); // every render builds a new stand-in
    return preview.sent.map(([channel, payload]) => channel + ' ' + JSON.stringify((payload as { selector?: string }).selector));
  }, [headline('h1.hero', true), headline('p.lede', true)] as const);
  assert.deepEqual(asked, []);
});

test('design panel: an element at scale 0 shows Scale 0 (and opacity 0 shows 0)', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const wells = await w.page.evaluate(() => {
    // An inactive carousel slide as the overlay now reads it: opacity 0, scale 0.
    const adjust = { ...TP_GHOST_CUR, opacity: 0, scale: 0 };
    const sel = { selector: 'div.slide', tagName: 'div', classList: ['slide'], adjust } as unknown as PreviewSelection;
    const host = document.createElement('div');
    host.innerHTML = buildAdjustBody({ sel, cur: { ...adjust }, deltas: {} });
    const well = (k: string) => host.querySelector(`.qa-ctl[data-k="${k}"] .qa-val`)!.textContent;
    return { scale: well('scaleK'), opacity: well('opacity') };
  });
  assert.deepEqual(wells, { scale: '0', opacity: '0' });
});

// ── Messages from the preview ───────────────────────────────────────────────

test('image swap: an image with only a srcset says it can’t be swapped here, before any file is chosen', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const swaps = await w.page.evaluate(async () => {
    const tab = window.__tab(); tabs.push(tab); activeId = tab.id;
    // main's answer once it has copied the chosen file in: the text edit can't find an empty src.
    window.__fake.applyImageEdit = async () => ({ ok: false, reason: 'empty-original' });
    // A double-click on <img srcset="hero-1x.png 1x, hero-2x.png 2x"> with no src.
    const click = { src: null, context: { tagName: 'img', classList: ['hero-art'], id: null, alt: 'Editor screenshot' } };
    await handleWebviewMessage(tab, { channel: 'radial:image-click', args: [click] } as unknown as PreviewIpcMessageEvent);
    return window.__calls.filter((c) => c.name === 'applyImageEdit').length;
  });
  assert.equal(swaps, 0, 'no file dialog, nothing copied into the repo');
  assert.equal(await toastText(w.page), 'This image can’t be swapped here. Ask the agent to change it.');
});

test('text edits: the agent handoff quotes each piece of nearby text on its own', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const prompt = await w.page.evaluate(async () => {
    const tab = window.__tab(); tabs.push(tab); activeId = tab.id;
    window.__fake.engineAvailable = async () => ({ claude: true });
    let started = '';
    window.__fake.termStart = async (...args: unknown[]) => { started = (args[4] as { initialText?: string }).initialText || ''; return { id: 'term-new' }; };
    // The overlay's context for an edited <h2>: the previous and next siblings' text, then the parent's id.
    handTextEditToAgent(tab, { originalText: 'Simple pricing', newText: 'Pricing that scales', context: { tagName: 'h2', classList: ['title'], nearbyText: ['Plans for every team', 'Start free', 'pricing'] } },
      { ok: false, reason: 'ambiguous', candidates: [{ relFile: 'src/pages/index.astro', line: 12 }, { relFile: 'src/pages/pricing.astro', line: 4 }] });
    for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 20));
    return started;
  });
  assert.ok(prompt.includes('The element on the page is <h2> .title (nearby text: "Plans for every team", "Start free", "pricing").'), `got: ${prompt}`);
});

test('links: a link whose href is empty goes to the agent with what to set it to, not “Link edit failed: empty-original”', T, async (t) => {
  const w = await openWindow(t); if (!w) return;
  const result = await w.page.evaluate(async () => {
    const tab = window.__tab({ currentRoute: '/pricing', currentFile: 'src/pages/pricing.astro' }); tabs.push(tab); activeId = tab.id;
    window.__fake.engineAvailable = async () => ({ claude: true });
    // main's answer, were the window to ask it to place an empty href.
    window.__fake.applyTextEdit = async () => ({ ok: false, reason: 'empty-original' });
    let started = '';
    window.__fake.termStart = async (...args: unknown[]) => { started = (args[4] as { initialText?: string }).initialText || ''; return { id: 'term-new' }; };
    // The Edit link badge on <a class="cta" href="">See pricing</a>, then Save with a new address.
    openLinkModal(tab, { href: '', text: 'See pricing', context: { tagName: 'a', attribute: 'href', classList: ['cta'], id: null } });
    (document.getElementById('linkUrlInput') as HTMLInputElement).value = 'https://radial.to/pricing';
    await confirmLink();
    for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 20));
    return { started, asked: window.__calls.filter((c) => c.name === 'applyTextEdit').length };
  });
  assert.equal(result.started, 'Set the href of this link on page /pricing to "https://radial.to/pricing".\n'
    + 'The link is <a> .cta with the text "See pricing". Its href is empty (href=""), so Radial\'s direct editor had no value in the source to replace. The page\'s source is probably src/pages/pricing.astro.\n'
    + 'Make ONLY this change. No other edits, no commentary needed beyond a one-line confirmation.');
  assert.equal(result.asked, 0, 'nothing in the source to find, so the direct editor isn’t asked');
  assert.equal(await toastText(w.page), 'Finishing this edit with the agent…');
});
