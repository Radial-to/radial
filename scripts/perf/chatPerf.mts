#!/usr/bin/env node
// Chat and terminal performance, measured on a store shaped like a real one.
//
//   node scripts/perf/chatPerf.mts [--mode chat|terminal] [--store real|small] [--out results.json]
//
// --mode chat      the native chat layer (Chat/Terminal views over the CLI), the default
// --mode terminal  terminal-only agents (the chat layer off), for comparison
// --store real     ~60 MB of chats sized like a long-running install (tool output
//                  sizes follow a real store's spread: p50 0.7 KB, p90 14 KB, p99 200 KB)
// --store small    the same layout with tiny conversations
//
// Every agent is the test CLI (test/fixtures/native-interactive.cjs), so no
// real model runs. It echoes typing, writes transcripts, fires Claude hooks, and
// can stream a Claude-style turn (spinner redraws plus reply blocks).
// Set RADIAL_APP_PATH to measure a packaged build instead of `electron .`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';
import type { IDisposable, Terminal } from '@xterm/xterm';
import type { IpcMain, IpcMainInvokeEvent, ProcessMetric } from 'electron';
import type { Profiler, Session as InspectorSession } from 'node:inspector';
import type { ELDHistogram } from 'node:perf_hooks';
import type { FixtureCommand, FixtureState } from '../../test/fixtures/native-interactive.cjs';

// ---- types ---------------------------------------------------------------------
// Each type restated from the app names the one it stands for.
// TODO: import the app's own types once the scripts project can load them.
/** A message in a generated chat (the app's ChatMessage, src/shared/radialApi.ts). */
interface PerfMessage { id: string; role: 'user' | 'assistant' | 'tool'; text: string; name?: string; detail?: string; status?: string }
/** A content block of a Claude transcript line (the app's ClaudeContentBlock, src/main/chat/providers.ts). */
type TranscriptBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: { file_path: string } }
  | { type: 'tool_result'; tool_use_id: string; content: string };
/** A line of a Claude transcript (<config>/projects/<project>/<session>.jsonl), as generated here (the app's ClaudeRecord, src/main/chat/providers.ts). */
interface TranscriptRecord { type: 'user' | 'assistant'; sessionId: string; uuid?: string; message: { id?: string; content: string | TranscriptBlock[] } }
/** A chat in native-chats.json (the store src/main/nativeChat.ts loads), as generated here (the app's ChatSession, src/shared/radialApi.ts). */
interface SavedChat {
  id: string;
  engine: 'claude';
  threadId: string;
  repoDir: string;
  home: boolean;
  title: string;
  state: 'idle';
  viewMode: 'terminal';
  providerPersisted: boolean;
  archived?: boolean;
  messages: PerfMessage[];
  createdAt: number;
  updatedAt: number;
}
// The test CLI's session files (native-fixture/<session>.state.json and
// .commands.jsonl) are typed beside it, in test/fixtures/native-interactive.d.cts.

// What the probes keep in the main process (global.__perf): event-loop delay,
// CPU since begin(), and IPC traffic by channel (sent to the window, invoked by it).
type IpcSent = { n: number; kb: number };
type IpcInvoked = { n: number; ms: number; max: number; kb: number };
interface MainPerf { h: ELDHistogram; ipc: Record<string, IpcSent>; inv: Record<string, IpcInvoked>; cpu: NodeJS.CpuUsage }
/** ipcMain with Electron's private table of handle() handlers, which the probe wraps when it's there. */
type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type IpcMainHandlers = IpcMain & { _invokeHandlers?: Map<string, InvokeHandler> };
// The main process's global, as app.evaluate's functions use it.
declare const global: typeof globalThis & { __perf: MainPerf; __prof: InspectorSession };

// What the page functions reach in the window: the probes set here, and the
// app's globals (renderer.ts, nativeChat.ts and the preload's API; the app
// declares them in src/renderer/types.d.ts and globals.d.ts, which the scripts
// project can't load), typed as far as they're used here.
/** A terminal in a tab's list (renderer TermSession): its xterm and element once mounted. */
interface PerfTerm { xterm?: Terminal | null; el?: HTMLDivElement | null }
/** An open project (renderer Tab). */
interface PerfTab { id: string; repoDir: string; term?: PerfTerm | null; terminals?: PerfTerm[] }
/** Home's tab (renderer HomeTab): its folder is null until main tells it. */
interface PerfHomeTab extends Omit<PerfTab, 'repoDir'> { repoDir: string | null }
/** Long tasks and frame gaps since start() (in ms). */
interface FrameStats { longTasks: number; longTaskMs: number; worstTaskMs: number; framesOver50ms: number; worstFrameMs: number }
/** The window's probe (window.__perf). */
interface WindowPerf {
  long: number[];
  gaps: number[];
  on: boolean;
  start(): void;
  stop(): FrameStats;
  /** Switches to the project's tab, or opens the project. */
  go(dir: string): void;
  /** The project's agent terminal is on screen with content in it. */
  ready(dir: string | null): boolean;
  /** What ready() sees, as JSON, for a timeout's message. */
  why(dir: string | null): string;
  /** The ms until fn() is truthy; rejects after `timeout` ms. */
  until(fn: () => boolean, timeout?: number, dir?: string | null): Promise<number>;
}
/** The typing probe (window.__echo): keys typed and still waiting for their echo, and the latencies measured. */
interface EchoProbe { typed: string; pending: number[]; lat: number[]; key: (e: KeyboardEvent) => void; sub: IDisposable }
/** The native chat panel (renderer RadialNativeChatApi). */
interface NativeChatPanel { enabled(): boolean; active(): boolean; visibleId(): string | null; select(id: string): Promise<void> }
declare const window: Window & typeof globalThis & {
  __perf: WindowPerf;
  __echo: EchoProbe;
  RadialNativeChat: NativeChatPanel;
  /**
   * The preload's API (RadialApi, src/shared/radialApi.ts). visibleSession passes
   * nativeChatGet the null visibleId() returns with no chat on screen; main
   * rejects it, like an unknown id, with "Chat not found.".
   */
  radial: { nativeChatGet(id: string | null): Promise<{ threadId: string | null }> };
};
declare const tabs: PerfTab[];
declare function activeTab(): PerfTab | null;
declare function agentTab(): PerfTab | PerfHomeTab | null;
declare function tabByRepo(repoDir: string | null | undefined): PerfTab | null;
declare function switchTab(id: string): Promise<void>;
declare function openProjectPath(dir: string): Promise<{ ok: boolean }>;
declare function setRightTab(name: 'agent' | 'terminal' | 'comments' | 'history', opts?: { focus?: boolean }): void;

// What the run measures.
/** Echo latency of typed keys (ms), with the keys that never echoed. */
interface Latency { p50: number | null; p95: number | null; max: number | null; n: number; missed: number; samples: number[] }
/** Time to switch (ms). */
interface SwitchTimes { p50: number | null; p95: number | null; max: number | null; n: number }
/** What a scenario adds to its measurements, or why it failed. */
interface ScenarioExtra { latency?: Latency; switch?: SwitchTimes; error?: string; profile?: { main: string[]; window: string[] } }
type ScenarioResult = Awaited<ReturnType<typeof end>> & ScenarioExtra;
/** The counters begin() reads, for end() to subtract. */
interface Mark { m: Record<string, number>; cpu: number; procs: { type: ProcessMetric['type']; cpu: number }[]; at: number }
/** The run's results (written as JSON with --out). */
interface PerfResults {
  mode: string;
  store: string;
  storeMB: number;
  scenarios: Record<string, ScenarioResult>;
  launchToAgentMs?: number;
  firstOpenMs?: { projects: number[]; chats: (number | null)[] };
  memoryMB?: Record<string, number>;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = <T extends string | null>(name: string, fallback: T): string | T => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const MODE = arg('mode', 'chat'), STORE = arg('store', 'real'), OUT = arg('out', null), PROFILE = arg('profile', null), IPC = !process.argv.includes('--no-ipc');
const PROJECTS = 3, CHATS = 4; // 3: the free plan's open-project limit
const MB = 1024 * 1024;
// Open chats per project (MB), biggest first, plus one large archived chat.
const SIZES = STORE === 'small' ? Array(PROJECTS * CHATS).fill(0.02) : [9, 3, 1, 0.3, 9, 2, 0.5, 0.2, 6, 5, 1, 0.5];
const ARCHIVED = STORE === 'small' ? 0.05 : 25;

// ---- data ------------------------------------------------------------------
let seed = 7; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.floor(rand() * 16); return (c === 'x' ? r : (r & 3) | 8).toString(16); });
// Tool output size: piecewise log-linear through a real store's quantiles.
const Q = [[0, 40], [0.5, 726], [0.9, 13804], [0.99, 200791], [1, 992803]];
function toolSize() {
  const u = rand(); for (let i = 1; i < Q.length; i++) if (u <= Q[i][0]) { const [u0, a] = Q[i - 1], [u1, b] = Q[i]; return Math.round(Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * (u - u0) / (u1 - u0))); }
  return Q.at(-1)![1];
}
const WORDS = 'the agent reads a component then edits the layout and checks the preview before running the build again with a short note'.split(' ');
const text = (n: number): string => { let s = ''; while (s.length < n) s += WORDS[Math.floor(rand() * WORDS.length)] + (rand() < 0.08 ? '\n' : ' '); return s.slice(0, n); };
function conversation(bytes: number, threadId: string): { messages: PerfMessage[]; records: TranscriptRecord[] } {
  const messages: PerfMessage[] = [], records: TranscriptRecord[] = []; let size = 0, turn = 0;
  while (size < bytes) {
    turn++;
    const u: PerfMessage = { id: uuid(), role: 'user', text: text(120 + Math.floor(rand() * 300)) };
    messages.push(u); records.push({ type: 'user', sessionId: threadId, uuid: u.id, message: { content: u.text } }); size += u.text.length;
    for (let k = 0, tools = 1 + Math.floor(rand() * 5); k < tools; k++) {
      const id = 'toolu_' + uuid().replace(/-/g, '').slice(0, 24), input = { file_path: '/src/components/Section' + k + '.tsx' }, out = text(toolSize());
      messages.push({ id, role: 'tool', name: ['Read', 'Edit', 'Bash', 'Grep'][k % 4], text: JSON.stringify(input), detail: JSON.stringify(out), status: 'completed' });
      records.push({ type: 'assistant', sessionId: threadId, message: { id: 'msg_' + uuid(), content: [{ type: 'tool_use', id, name: 'Read', input }] } });
      records.push({ type: 'user', sessionId: threadId, message: { content: [{ type: 'tool_result', tool_use_id: id, content: out }] } });
      size += out.length + 80;
    }
    const a: PerfMessage = { id: 'msg_' + uuid(), role: 'assistant', text: text(300 + Math.floor(rand() * 900)) };
    messages.push(a); records.push({ type: 'assistant', sessionId: threadId, message: { id: a.id, content: [{ type: 'text', text: a.text }] } }); size += a.text.length;
  }
  return { messages, records };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
const projects = Array.from({ length: PROJECTS }, (_, i) => { const p = path.join(dir, 'site' + (i + 1)); fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'index.html'), `<title>Site ${i + 1}</title><h1>Site ${i + 1}</h1>`); return fs.realpathSync(p); });
const chats: SavedChat[] = [];
const t0 = Date.now();
for (let i = 0; i < PROJECTS * CHATS; i++) {
  const repoDir = projects[Math.floor(i / CHATS)], threadId = uuid(), { messages, records } = conversation(SIZES[i] * MB, threadId);
  chats.push({ id: uuid(), engine: 'claude', threadId, repoDir, home: false, title: 'Chat ' + (i + 1), state: 'idle', viewMode: 'terminal', providerPersisted: true, messages, createdAt: i + 1, updatedAt: 1000 - i });
  const tdir = path.join(dir, 'claude', 'projects', repoDir.replace(/[^a-zA-Z0-9]/g, '-')); fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, threadId + '.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
}
{ const threadId = uuid(); chats.push({ id: uuid(), engine: 'claude', threadId, repoDir: projects[0], home: false, title: 'Archived', state: 'idle', viewMode: 'terminal', providerPersisted: true, archived: true, messages: conversation(ARCHIVED * MB, threadId).messages, createdAt: 0, updatedAt: 0 }); }
fs.writeFileSync(path.join(dir, 'native-chats.json'), JSON.stringify(chats));
fs.writeFileSync(path.join(dir, 'radial-store.json'), JSON.stringify({ projectsDir: dir, recents: projects.map(p => ({ path: p, name: path.basename(p), kind: 'local' })), session: { open: projects, active: projects[0] } }));
const storeMB = fs.statSync(path.join(dir, 'native-chats.json')).size / MB;
console.log(`store ${storeMB.toFixed(1)} MB, ${chats.length} chats, ${chats.reduce((n, c) => n + c.messages.length, 0)} messages (generated in ${Date.now() - t0} ms)`);

// Terminal-only mode starts the machine's `claude`: put the test CLI first.
const shim = path.join(dir, 'bin'); fs.mkdirSync(shim);
fs.writeFileSync(path.join(shim, 'claude'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "99.0.0 (Claude Code)"; exit 0; fi\nexec node ${JSON.stringify(path.join(root, 'test/fixtures/native-interactive.cjs'))} "$@"\n`, { mode: 0o755 });

// ---- launch + instrumentation ------------------------------------------------
const env: Record<string, string> = { ...process.env, PATH: shim + ':' + process.env.PATH, RADIAL_USERDATA: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CURSOR_CONFIG_DIR: path.join(dir, 'cursor'), RADIAL_AUTO_RELOAD: '0', RADIAL_DAEMON_EPHEMERAL: '1', RADIAL_CHAT_EXPERIMENT: MODE === 'chat' ? '1' : '0', RADIAL_CHAT_TEST_CLI: path.join(root, 'test/fixtures/codex-shared.cjs'), RADIAL_CHAT_TEST_CLAUDE: path.join(root, 'test/fixtures/native-interactive.cjs'), RADIAL_NATIVE_FIXTURE_RESUME_BYTES: '200000' };
delete env.RADIAL_OPEN;
const launchAt = Date.now();
const app = await _electron.launch({ executablePath: process.env.RADIAL_APP_PATH || path.join(root, 'node_modules/.bin/electron'), args: process.env.RADIAL_APP_PATH ? [] : ['.'], cwd: root, env });
const results: PerfResults = { mode: MODE, store: STORE, storeMB: +storeMB.toFixed(1), scenarios: {} };
const page = await app.firstWindow(); page.setDefaultTimeout(60000);
const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');

await app.evaluate(({ BrowserWindow, ipcMain }, IPC) => {
  const { monitorEventLoopDelay, performance } = process.getBuiltinModule('perf_hooks');
  const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
  const p: MainPerf = global.__perf = { h, ipc: {}, inv: {}, cpu: process.cpuUsage() };
  if (!IPC) return; // --no-ipc: measure without the IPC wrappers
  const wc = BrowserWindow.getAllWindows()[0].webContents, send = wc.send.bind(wc);
  wc.send = (ch: string, ...a: unknown[]) => { const r = p.ipc[ch] ||= { n: 0, kb: 0 }; r.n++; try { r.kb += JSON.stringify(a).length / 1024; } catch {} return send(ch, ...a); };
  for (const [ch, fn] of (ipcMain as IpcMainHandlers)._invokeHandlers || []) (ipcMain as IpcMainHandlers)._invokeHandlers!.set(ch, async (...a) => {
    const t = performance.now(); let out: unknown;
    try { return (out = await fn(...a)); } finally { const r = p.inv[ch] ||= { n: 0, ms: 0, max: 0, kb: 0 }; const d = performance.now() - t; r.n++; r.ms += d; r.max = Math.max(r.max, d); try { r.kb += (JSON.stringify(out) || '').length / 1024; } catch {} }
  });
}, IPC);
await page.evaluate(() => {
  const st = window.__perf = { long: [] as number[], gaps: [] as number[], on: false } as WindowPerf;
  new PerformanceObserver(list => { for (const e of list.getEntries()) if (st.on) st.long.push(e.duration); }).observe({ type: 'longtask' });
  st.start = () => { st.long = []; st.gaps = []; st.on = true; let last = performance.now(); const tick = () => { if (!st.on) return; const now = performance.now(); st.gaps.push(now - last); last = now; requestAnimationFrame(tick); }; requestAnimationFrame(tick); };
  st.stop = () => { st.on = false; const g = st.gaps; return { longTasks: st.long.length, longTaskMs: Math.round(st.long.reduce((a, b) => a + b, 0)), worstTaskMs: Math.round(Math.max(0, ...st.long)), framesOver50ms: g.filter(x => x > 50).length, worstFrameMs: Math.round(Math.max(0, ...g)) }; };
  st.go = dir => { const tab = tabByRepo(dir); if (tab) switchTab(tab.id); else openProjectPath(dir); };
  // Ready = this project's agent terminal is on screen with content in it.
  st.ready = dir => {
    const tab = tabByRepo(dir), t = tab?.term;
    return !!(t && agentTab() === tab && t.el?.classList.contains('active') && t.el.offsetParent
      // @ts-expect-error: until its xterm is mounted, length is undefined, and `undefined > 2` is false: not ready.
      && t.xterm?.buffer.active.length > 2
      && document.getElementById('termOpening')!.hidden);
  };
  st.why = dir => { const tab = tabByRepo(dir), t = tab?.term; return JSON.stringify({ tab: !!tab, term: !!t, agentTab: agentTab() === tab, active: !!t?.el?.classList.contains('active'), shown: !!t?.el?.offsetParent, lines: t?.xterm?.buffer.active.length, opening: document.getElementById('termOpening')!.hidden ? '' : document.getElementById('termOpening')!.textContent, visibleChat: window.RadialNativeChat?.visibleId?.(), mode: window.RadialNativeChat?.active?.() ? 'chat' : 'terminal', terms: (tab?.terminals || []).length }); };
  st.until = (fn, timeout = 30000, dir) => new Promise((resolve, reject) => { const t0 = performance.now(); const tick = () => { let ok = false; try { ok = fn(); } catch {} if (ok) return resolve(performance.now() - t0); if (performance.now() - t0 > timeout) return reject(new Error('timed out ' + (dir ? st.why(dir) : ''))); requestAnimationFrame(tick); }; tick(); });
});

const cpuOf = () => { const out = execSync('ps -axo pid=,time=,command=', { encoding: 'utf8' }); let s = 0; for (const l of out.split('\n')) if (l.includes(dir) && !l.includes('ps -axo')) { const m = l.trim().split(/\s+/)[1]?.match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/); if (m) s += (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3]; } return s; };
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
let mark: Mark | null = null;
async function begin() {
  await app.evaluate(() => { const p = global.__perf; p.h.reset(); p.cpu = process.cpuUsage(); p.ipc = {}; p.inv = {}; });
  await page.evaluate(() => window.__perf.start());
  mark = { m: await metrics(), cpu: cpuOf(), procs: await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({ type: p.type, cpu: p.cpu.cumulativeCPUUsage || 0 }))), at: Date.now() };
}
async function end() {
  const main = await app.evaluate(() => { const p = global.__perf, h = p.h, c = process.cpuUsage(p.cpu); const top = (o: Record<string, Record<string, number>>) => Object.fromEntries(Object.entries(o).sort((a, b) => (b[1].kb || 0) - (a[1].kb || 0)).slice(0, 6).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([x, y]) => [x, Math.round(y * 10) / 10]))])); return { eventLoop: { p50: +(h.percentile(50) / 1e6).toFixed(1), p99: +(h.percentile(99) / 1e6).toFixed(1), max: +(h.max / 1e6).toFixed(1) }, mainCpuMs: Math.round((c.user + c.system) / 1000), ipcOut: top(p.ipc), ipcIn: top(p.inv) }; });
  const r = await page.evaluate(() => window.__perf.stop()), m = await metrics(), procs = await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({ type: p.type, cpu: p.cpu.cumulativeCPUUsage || 0 })));
  const sec = (Date.now() - mark!.at) / 1000;
  const typeCpu = (type: ProcessMetric['type']) => Math.round(1000 * (procs.filter(p => p.type === type).reduce((a, p) => a + p.cpu, 0) - mark!.procs.filter(p => p.type === type).reduce((a, p) => a + p.cpu, 0)));
  return { seconds: +sec.toFixed(1), ...main, renderer: { ...r, scriptMs: Math.round(1000 * (m.ScriptDuration - mark!.m.ScriptDuration)), layoutMs: Math.round(1000 * (m.LayoutDuration - mark!.m.LayoutDuration)), styleMs: Math.round(1000 * (m.RecalcStyleDuration - mark!.m.RecalcStyleDuration)), taskMs: Math.round(1000 * (m.TaskDuration - mark!.m.TaskDuration)), heapMB: Math.round(m.JSHeapUsedSize / MB), cpuMs: typeCpu('Tab') }, agentsCpuMs: Math.round(1000 * (cpuOf() - mark!.cpu)) };
}
// Self time per function from a V8 CPU profile, biggest first.
function topSelf(profile: Profiler.Profile, n = 12): string[] {
  const byNode = new Map(profile.nodes.map(node => [node.id, node])), self = new Map<string, number>();
  const dt = (profile.endTime - profile.startTime) / Math.max(1, profile.samples!.length) / 1000;
  for (const id of profile.samples!) { const f = byNode.get(id)!.callFrame; const key = (f.functionName || '(anonymous)') + ' ' + (f.url || '').replace(/^.*\/(src|node_modules)\//, '$1/') + (f.lineNumber >= 0 ? ':' + (f.lineNumber + 1) : ''); self.set(key, (self.get(key) || 0) + dt); }
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => `${Math.round(ms)} ms  ${k}`);
}
async function scenario(name: string, fn: () => Promise<ScenarioExtra | void>): Promise<void> {
  process.stdout.write(`- ${name}… `);
  const profiling = PROFILE && name.includes(PROFILE);
  if (profiling) {
    await app.evaluate(() => { const { Session } = process.getBuiltinModule('inspector'); const s = global.__prof = new Session(); s.connect(); s.post('Profiler.enable'); s.post('Profiler.setSamplingInterval', { interval: 200 }); s.post('Profiler.start'); });
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start');
  }
  await begin(); let extra: ScenarioExtra = {};
  try { extra = (await fn()) || {}; } catch (e) { extra = { error: (e as Error).message.split('\n')[0] }; }
  if (profiling) {
    const mainProfile: Profiler.Profile = JSON.parse(await app.evaluate(() => new Promise<string>(resolve => global.__prof.post('Profiler.stop', (err, r) => { global.__prof.disconnect(); resolve(JSON.stringify(r.profile)); }))));
    const { profile: windowProfile } = await cdp.send('Profiler.stop');
    if (OUT) { fs.writeFileSync(OUT.replace(/\.json$/, '') + '.main.cpuprofile', JSON.stringify(mainProfile)); fs.writeFileSync(OUT.replace(/\.json$/, '') + '.window.cpuprofile', JSON.stringify(windowProfile)); }
    extra.profile = { main: topSelf(mainProfile), window: topSelf(windowProfile) };
  }
  const r = { ...(await end()), ...extra };
  results.scenarios[name] = r;
  console.log(r.error ? 'ERROR ' + r.error : summary(r));
  if (r.profile) for (const side of ['main', 'window'] as const) console.log(`    ${side} self time:\n      ` + r.profile[side].join('\n      '));
}
const pct = (xs: number[], p: number): number | null => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : null; };
const summary = (r: ScenarioResult): string => [r.latency && `echo p50 ${r.latency.p50} / p95 ${r.latency.p95} / max ${r.latency.max} ms`, r.switch && `switch p50 ${r.switch.p50} / p95 ${r.switch.p95} / max ${r.switch.max} ms`, `main stall p99 ${r.eventLoop.p99} max ${r.eventLoop.max} ms`, `main CPU ${r.mainCpuMs} ms`, `renderer long tasks ${r.renderer.longTasks} (${r.renderer.longTaskMs} ms, worst ${r.renderer.worstTaskMs})`].filter(Boolean).join(' · ');

const fixtureState = () => fs.readdirSync(path.join(dir, 'native-fixture')).filter(f => f.endsWith('.state.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'native-fixture', f), 'utf8')) as FixtureState; } catch { return null; } }).filter(Boolean) as FixtureState[];
// The CLI behind the agent on screen in `repoDir` (chat: by thread; terminal: the one CLI there).
async function visibleSession(repoDir: string): Promise<string | null | undefined> {
  if (MODE === 'chat') { const id = await page.evaluate(() => window.RadialNativeChat.visibleId()); return (await page.evaluate(id => window.radial.nativeChatGet(id), id)).threadId; }
  return fixtureState().find(s => s.cwd === repoDir)?.sessionId;
}
// Without a session no CLI reads the command, and the scenario would time an idle app.
const command = (sessionId: string | null | undefined, cmd: FixtureCommand) => {
  if (!sessionId) throw new Error(`no agent session on screen to send "${cmd.type}" to`);
  fs.appendFileSync(path.join(dir, 'native-fixture', sessionId + '.commands.jsonl'), JSON.stringify(cmd) + '\n');
};
async function typeAndMeasure(chars: string): Promise<{ latency: Latency }> {
  await page.evaluate(() => {
    const x = agentTab()!.term!.xterm!, st = window.__echo = { typed: '', pending: [] as number[], lat: [] as number[] } as EchoProbe;
    st.key = e => { if (e.key.length === 1) { st.typed += e.key; st.pending.push(performance.now()); } };
    x.textarea!.addEventListener('keydown', st.key, true);
    st.sub = x.onWriteParsed(() => {
      if (!st.pending.length) return;
      const b = x.buffer.active, line = (b.getLine(b.baseY + b.cursorY)?.translateToString(true) || '').trimEnd();
      if (line.endsWith(st.typed.trimEnd().slice(-4))) { const now = performance.now(); while (st.pending.length) st.lat.push(now - st.pending.shift()!); } // the line comes back trimmed
    });
    x.focus();
  });
  await page.keyboard.type(chars, { delay: 90 });
  await new Promise(r => setTimeout(r, 500));
  const lat = await page.evaluate(() => { const st = window.__echo, x = agentTab()!.term!.xterm!; x.textarea!.removeEventListener('keydown', st.key, true); st.sub.dispose(); return { lat: st.lat, missed: st.pending.length }; });
  await page.keyboard.press('Control+U'); // clear the draft line in the CLI (the stand-in ignores it; harmless)
  return { latency: { p50: pct(lat.lat, 0.5), p95: pct(lat.lat, 0.95), max: pct(lat.lat, 1), n: lat.lat.length, missed: lat.missed, samples: lat.lat.map(Math.round) } };
}

// ---- scenarios -----------------------------------------------------------------
try {
  await page.waitForFunction(p => typeof tabs !== 'undefined' && activeTab()?.repoDir === p, projects[0]);
  if (MODE === 'chat') await page.waitForFunction(() => window.RadialNativeChat?.enabled());
  else await page.evaluate(() => setRightTab('terminal', { focus: true }));
  await page.evaluate(dir => window.__perf.until(() => window.__perf.ready(dir), 60000, dir), projects[0]);
  results.launchToAgentMs = Date.now() - launchAt;
  console.log(`launch → first agent on screen: ${results.launchToAgentMs} ms`);
  // Warm up: open every project once so each has its agent running. These are
  // cold starts (the CLI launches and resumes its conversation): timed too.
  const cold: number[] = [];
  for (const p of [...projects.slice(1), projects[0]]) cold.push(Math.round(await page.evaluate(dir => { const t0 = performance.now(); window.__perf.go(dir); return window.__perf.until(() => window.__perf.ready(dir), 120000, dir).then(() => performance.now() - t0); }, p)));
  console.log('first open of each project (ms):', cold.join(', '));
  if (MODE === 'chat') {
    const opens: (number | null)[] = [];
    for (const c of chats.filter(c => c.repoDir === projects[0] && !c.archived).reverse()) {
      try { opens.push(Math.round(await page.evaluate(([id, dir]) => { const t0 = performance.now(); window.RadialNativeChat.select(id); return window.__perf.until(() => window.RadialNativeChat.visibleId() === id && window.__perf.ready(dir), 60000, dir).then(() => performance.now() - t0); }, [c.id, projects[0]]))); }
      catch (e) { opens.push(null); console.log('  ' + (e as Error).message.split('\n')[0].slice(0, 300)); }
      console.log(`  first open of a ${(SIZES[chats.indexOf(c)] || 0)} MB chat: ${opens.at(-1) ?? 'did not open within 60 s'}${opens.at(-1) == null ? '' : ' ms'}`);
    }
    results.firstOpenMs = { projects: cold, chats: opens };
  }
  await new Promise(r => setTimeout(r, 3000));

  await scenario('idle 10s', () => new Promise(r => setTimeout(r, 10000)));
  await scenario('typing in the agent terminal', () => typeAndMeasure('hello radial agent how are'));
  await scenario('project switching (9 switches)', async () => {
    const times: number[] = [];
    for (let round = 0; round < 3; round++) for (const p of [...projects.slice(1), projects[0]]) times.push(await page.evaluate(dir => { const t0 = performance.now(); window.__perf.go(dir); return window.__perf.until(() => window.__perf.ready(dir), 30000, dir).then(() => performance.now() - t0); }, p));
    return { switch: { p50: pct(times, 0.5), p95: pct(times, 0.95), max: pct(times, 1), n: times.length } };
  });
  if (MODE === 'chat') await scenario('chat switching in one project (12 switches)', async () => {
    const ids = chats.filter(c => c.repoDir === projects[0] && !c.archived).map(c => c.id), times: number[] = [];
    for (let round = 0; round < 3; round++) for (const id of ids) times.push(await page.evaluate(id => { const t0 = performance.now(); window.RadialNativeChat.select(id); return window.__perf.until(() => window.RadialNativeChat.visibleId() === id && window.__perf.ready(agentTab()!.repoDir)).then(() => performance.now() - t0); }, id));
    return { switch: { p50: pct(times, 0.5), p95: pct(times, 0.95), max: pct(times, 1), n: times.length } };
  });
  await scenario('agent streaming on screen (10s)', async () => {
    const sid = await visibleSession(projects[0]); command(sid, { type: 'stream', seconds: 10, fps: 15 });
    await new Promise(r => setTimeout(r, 11000));
  });
  await scenario('typing while 2 other projects stream', async () => {
    for (const p of projects.slice(1)) { await page.evaluate(dir => { window.__perf.go(dir); return window.__perf.until(() => window.__perf.ready(dir), 30000, dir); }, p); command(await visibleSession(p), { type: 'stream', seconds: 14, fps: 15 }); }
    await page.evaluate(dir => { window.__perf.go(dir); return window.__perf.until(() => window.__perf.ready(dir), 30000, dir); }, projects[0]);
    await new Promise(r => setTimeout(r, 1000));
    return typeAndMeasure('typing during background work');
  });
  if (MODE === 'chat') {
    await new Promise(r => setTimeout(r, 4000));
    await scenario('open the biggest chat in Chat view', async () => {
      const big = chats.find(c => c.repoDir === projects[0] && !c.archived)!.id;
      await page.evaluate(id => window.RadialNativeChat.select(id), big);
      await page.waitForFunction(id => window.RadialNativeChat.visibleId() === id, big);
      const ms = await page.evaluate(() => { const t0 = performance.now(); document.querySelector<HTMLButtonElement>('[data-chat-view="chat"]')!.click(); return window.__perf.until(() => window.RadialNativeChat.active() && document.querySelectorAll('#nativeChatMessages > *').length > 0 && !document.querySelector<HTMLButtonElement>('[data-chat-view="chat"]')!.disabled).then(() => performance.now() - t0); });
      return { switch: { p50: Math.round(ms), p95: Math.round(ms), max: Math.round(ms), n: 1 } };
    });
    await scenario('agent streaming in Chat view (10s)', async () => {
      const sid = await visibleSession(projects[0]); command(sid, { type: 'stream', seconds: 10, fps: 15 });
      await new Promise(r => setTimeout(r, 11000));
    });
    await scenario('typing in the Chat composer', async () => {
      await page.locator('#nativeChatInput').click();
      await page.keyboard.type('a short message for the agent', { delay: 90 });
      await page.locator('#nativeChatInput').fill('');
    });
  }
  results.memoryMB = await app.evaluate(({ app }) => Object.fromEntries(Object.entries(app.getAppMetrics().reduce<Record<string, number>>((a, p) => { a[p.type] = (a[p.type] || 0) + p.memory.workingSetSize / 1024; return a; }, {})).map(([k, v]) => [k, Math.round(v)])));
  console.log('memory (MB):', JSON.stringify(results.memoryMB));
} finally {
  await app.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
