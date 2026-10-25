// A process that goes away (src/main/processWatch.ts): the window's own
// renderer, a preview's and Electron's other processes each report with their
// reason, exit code and counts that hold no content; nothing during a quit,
// nothing for a clean exit, and never a minidump.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { watchProcesses } from '../src/main/processWatch';
import type { ReportGone } from '../src/main/processWatch';
import type { App, ProcessMetric, WebContents } from 'electron';

type Listener = (...args: unknown[]) => void;
/** A webContents as the watch sees it, and its own listeners. */
function contents(id: number, type: 'window' | 'webview', pid: number) {
  const on: Record<string, Listener> = {};
  return { id, pid, listeners: on, getType: () => type, isDestroyed: () => false, getOSProcessId: () => pid, on: (event: string, fn: Listener) => { on[event] = fn; } };
}

function setup({ terminals = async () => 3 as number | null, uptime = 5400 } = {}) {
  const appOn: Record<string, Listener> = {};
  const win = contents(1, 'window', 101), preview = contents(2, 'webview', 102), shots = contents(3, 'window', 103);
  let all = [win, preview, shots];
  const metrics = [
    { pid: 101, type: 'Tab', memory: { workingSetSize: 812 * 1024 } },
    { pid: 102, type: 'Tab', memory: { workingSetSize: 300 * 1024 } },
    { pid: 200, type: 'GPU', memory: { workingSetSize: 150 * 1024 } },
    { pid: 201, type: 'Utility', serviceName: 'network.mojom.NetworkService', memory: { workingSetSize: 40 * 1024 } },
  ] as unknown as ProcessMetric[];
  const reports: Parameters<ReportGone>[] = [];
  const app = { on: (event: string, fn: Listener) => { appOn[event] = fn; }, getAppMetrics: () => metrics } as unknown as Pick<App, 'on' | 'getAppMetrics'>;
  const watch = watchProcesses({
    app, webContents: { getAllWebContents: () => all as unknown as WebContents[] }, // read at each call: removePreview takes one out
    report: (...args) => reports.push(args),
    isAppWindow: (c) => c === (win as unknown as WebContents),
    terminals, uptime: () => uptime, sampleMs: 60 * 60 * 1000,
  });
  for (const c of all) appOn['web-contents-created']({}, c);
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const removePreview = () => { all = all.filter((c) => c !== preview); };
  return { appOn, win, preview, shots, reports, watch, settle, removePreview };
}

test('the window\'s own renderer and a preview\'s: reason, exit code, its memory at the last sample, uptime and counts', async () => {
  const t = setup();
  t.watch.sample();
  t.win.listeners['render-process-gone']({}, { reason: 'crashed', exitCode: 11 });
  t.preview.listeners['render-process-gone']({}, { reason: 'oom', exitCode: 5 });
  t.shots.listeners['render-process-gone']({}, { reason: 'killed', exitCode: 9 });
  await t.settle();
  assert.deepEqual(t.reports, [
    ['renderer', { reason: 'crashed', exitCode: 11 }, { memoryMb: 812, uptimeMin: 90, webviews: 1, terminals: 3 }],
    ['preview', { reason: 'oom', exitCode: 5 }, { memoryMb: 300, uptimeMin: 90, webviews: 1, terminals: 3 }],
    ['preview', { reason: 'killed', exitCode: 9 }, { memoryMb: undefined, uptimeMin: 90, webviews: 1, terminals: 3 }],
  ]);
  t.watch.stop();
});

test('another of Electron\'s processes: its type (and a utility\'s service), and its memory at the last sample', async () => {
  const t = setup();
  t.watch.sample();
  t.appOn['child-process-gone']({}, { type: 'GPU', reason: 'crashed', exitCode: 139 });
  t.appOn['child-process-gone']({}, { type: 'Utility', serviceName: 'network.mojom.NetworkService', reason: 'abnormal-exit', exitCode: 15 });
  await t.settle();
  assert.deepEqual(t.reports, [
    ['process', { reason: 'crashed', exitCode: 139, processType: 'GPU' }, { memoryMb: 150, uptimeMin: 90, webviews: 1, terminals: 3 }],
    ['process', { reason: 'abnormal-exit', exitCode: 15, processType: 'Utility:network.mojom.NetworkService' }, { memoryMb: 40, uptimeMin: 90, webviews: 1, terminals: 3 }],
  ]);
  t.watch.stop();
});

test('a sample keeps only the processes still there', async () => {
  const t = setup();
  t.watch.sample();
  t.removePreview(); // the preview's project closed: its webContents is gone
  t.watch.sample();
  t.preview.listeners['render-process-gone']({}, { reason: 'crashed', exitCode: 1 });
  await t.settle();
  assert.deepEqual(t.reports, [['preview', { reason: 'crashed', exitCode: 1 }, { memoryMb: undefined, uptimeMin: 90, webviews: 0, terminals: 3 }]]);
  t.watch.stop();
});

test('nothing for a clean exit or once the app is quitting, and no terminal count when the daemon doesn\'t answer in time', async () => {
  const t = setup({ terminals: () => new Promise<number | null>(() => {}) });
  t.win.listeners['render-process-gone']({}, { reason: 'clean-exit', exitCode: 0 });
  t.appOn['child-process-gone']({}, { type: 'Utility', reason: 'clean-exit', exitCode: 0 });
  t.preview.listeners['render-process-gone']({}, { reason: 'crashed', exitCode: 1 });
  await new Promise((r) => setTimeout(r, 1600));
  assert.deepEqual(t.reports, [['preview', { reason: 'crashed', exitCode: 1 }, { memoryMb: undefined, uptimeMin: 90, webviews: 1 }]]);
  t.appOn['before-quit']();
  t.win.listeners['render-process-gone']({}, { reason: 'killed', exitCode: 9 });
  t.appOn['child-process-gone']({}, { type: 'GPU', reason: 'killed', exitCode: 9 });
  await t.settle();
  assert.equal(t.reports.length, 1, 'a quit takes its processes down: not a crash');
  t.watch.stop();
});

test('no minidumps: the app never starts Electron\'s crash reporter', () => {
  const dir = path.join(__dirname, '..', 'src');
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.ts$/.test(f) && !f.endsWith('.d.ts'));
  for (const f of files) assert.ok(!/\bcrashReporter\.start\(/.test(fs.readFileSync(path.join(dir, f), 'utf8')), `src/${f} starts Electron's crashReporter: a minidump can hold page content`);
});
