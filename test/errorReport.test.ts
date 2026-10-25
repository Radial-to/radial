// app_error (src/main/errorReport.ts): each report names what broke and where
// in Radial's own code, mapped back to src/ with the source maps the app
// ships, and never carries the message, a path outside the app, a URL, page
// text or anything else built from data, whatever the error holds. Every value
// it sends is one of the shapes the usage-data page lists (the allowlist), and
// it never throws, whatever it's given.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import * as errorReport from '../src/main/errorReport';
import type { AppErrorProps, ErrorCapture, ErrorLogEntry } from '../src/main/errorReport';
import { compileWithMap } from '../scripts/transpile.mts';
import { tmpDir } from './support/tmp';

/**
 * An app folder as the build leaves it: out/<rel>.js and its map, compiled
 * from TypeScript the test writes, and a preload with its IPC channels;
 * markers in the source (in strings, which the compiled code keeps) give the
 * generated line and column of a frame, and the TypeScript line it maps back to.
 */
function app(name = 'app'): { root: string; frame(rel: string, marker: string, fn?: string): string; tsLine(rel: string, marker: string): number } {
  const root = path.join(tmpDir('errapp-'), name);
  const sources = new Map<string, string>();
  const put = (rel: string, ts: string) => {
    const { code, map } = compileWithMap(rel, ts);
    const out = path.join(root, 'out', rel.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, code);
    fs.writeFileSync(`${out}.map`, map);
    sources.set(rel, ts);
  };
  put('main/devServer.ts', [
    '// The dev server.',
    'type Opts = { port: number };',
    '',
    'export function startServer(opts: Opts): void {',
    '  const port: number = opts.port;',
    '  throw new TypeError(`no ${port} MARK_START`);',
    '}',
    'export function handler(): void { startServer({ port: Number(\'MARK_HANDLER\') }); }',
  ].join('\n'));
  put('renderer/renderer.ts', [
    'interface Tab { id: string }',
    'let active: Tab | null = null;',
    'function showEmpty(): void {',
    '  const list: HTMLElement | null = null;',
    "  (list as unknown as HTMLElement).innerHTML = 'MARK_EMPTY';",
    '}',
  ].join('\n'));
  // The preload's calls to main: the channels a failed call can name.
  put('preload/preload.ts', [
    "import { contextBridge, ipcRenderer } from 'electron';",
    "contextBridge.exposeInMainWorld('radial', {",
    "  termStart: () => ipcRenderer.invoke('term:start'),",
    "  setActive: (dir: string) => ipcRenderer.invoke('session:setActive', dir),",
    "  openProject: (dir: string) => ipcRenderer.invoke('project:open', dir),",
    "  bell: () => ipcRenderer.send('term:bell'),",
    '});',
  ].join('\n'));
  const generated = (rel: string, marker: string) => {
    const lines = fs.readFileSync(path.join(root, 'out', rel.replace(/\.ts$/, '.js')), 'utf8').split('\n');
    const line = lines.findIndex((l) => l.includes(marker));
    return { line: line + 1, col: lines[line].search(/\S/) + 1 };
  };
  return {
    root,
    frame(rel, marker, fn = 'fn') {
      const at = generated(rel, marker);
      const file = path.join(root, 'out', rel.replace(/\.ts$/, '.js'));
      return `    at ${fn} (${rel.startsWith('renderer/') ? pathToFileURL(file).href : file}:${at.line}:${at.col})`;
    },
    tsLine(rel, marker) { return sources.get(rel)!.split('\n').findIndex((l) => l.includes(marker)) + 1; },
  };
}

/** The events a run sends, and the log it keeps. */
function run(appRoot: string, opts: { idleMs?: number } = {}): { sent: AppErrorProps[]; dir: string; log(): ErrorLogEntry[] } {
  const dir = tmpDir('errrep-');
  const sent: AppErrorProps[] = [];
  errorReport.init(dir, { capture: (_event, props) => sent.push(props), appRoot, ...opts });
  return { sent, dir, log: () => fs.readFileSync(path.join(dir, 'error-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ErrorLogEntry) };
}
const errorWith = (stack: string[], { message = 'boom', name = 'Error', code }: { message?: string; name?: string; code?: string } = {}) => {
  const e = new Error(message) as Error & { code?: string };
  e.name = name;
  e.stack = [`${name}: ${message}`, ...stack].join('\n');
  if (code) e.code = code;
  return e;
};

test('a frame in Radial\'s compiled code maps back to its TypeScript source, line and function', () => {
  const a = app();
  const { sent } = run(a.root);
  errorReport.report('main', errorWith([
    '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    a.frame('main/devServer.ts', 'MARK_START', 'startServer'),
  ], { name: 'TypeError' }));
  assert.deepEqual(sent, [{ surface: 'main', error_name: 'TypeError', where: `src/main/devServer.ts:${a.tsLine('main/devServer.ts', 'MARK_START')} (startServer)` }]);
});

test('a window frame (a file URL, in an app whose folder has a space in its name) maps too', () => {
  const a = app('Radial Beta.app');
  const { sent } = run(a.root);
  errorReport.reportWindow({ surface: 'renderer', via: 'error', name: 'TypeError', message: 'Cannot set properties of null', stack: ['TypeError: Cannot set properties of null', a.frame('renderer/renderer.ts', 'MARK_EMPTY', 'showEmpty')].join('\n') });
  assert.deepEqual(sent, [{ surface: 'renderer', error_name: 'TypeError', where: `src/renderer/renderer.ts:${a.tsLine('renderer/renderer.ts', 'MARK_EMPTY')} (showEmpty)` }]);
});

test('a compiled file with no map says its own line; one thrown inside a library names the library after Radial\'s place', () => {
  const a = app();
  const { sent } = run(a.root);
  fs.writeFileSync(path.join(a.root, 'out', 'main', 'plain.js'), 'function plain() {}\n');
  errorReport.report('main', errorWith([`    at plain (${path.join(a.root, 'out', 'main', 'plain.js')}:12:3)`]));
  errorReport.report('main', errorWith([
    `    at UnixTerminal.write (${path.join(a.root, 'node_modules', 'node-pty', 'lib', 'unixTerminal.js')}:120:9)`,
    `    at Object.<anonymous> (${path.join(a.root, 'node_modules', '@xterm', 'headless', 'lib', 'x.js')}:1:2)`,
    a.frame('main/devServer.ts', 'MARK_START', 'startServer'),
  ], { name: 'RangeError' }));
  errorReport.reportWindow({ surface: 'renderer', name: 'TypeError', message: 'x', stack: ['TypeError: x', `    at e.write (${pathToFileURL(path.join(a.root, 'out', 'renderer', 'vendor', 'xterm.js')).href}:1:34567)`, a.frame('renderer/renderer.ts', 'MARK_EMPTY', 'HTMLDivElement.<anonymous>')].join('\n') });
  errorReport.report('main', errorWith([`    at x (${path.join(a.root, 'node_modules', '@xterm', 'headless', 'lib', 'x.js')}:1:2)`], { name: 'SyntaxError' }));
  assert.deepEqual(sent.map((s) => s.where), [
    'out/main/plain.js:12 (plain)',
    `src/main/devServer.ts:${a.tsLine('main/devServer.ts', 'MARK_START')} (startServer) via node_modules/node-pty`,
    `src/renderer/renderer.ts:${a.tsLine('renderer/renderer.ts', 'MARK_EMPTY')} via src/renderer/vendor/xterm.js:1:34567`,
    'node_modules/@xterm/headless',
  ]);
});

test('with none of Radial\'s code in the stack, Node\'s or Electron\'s own module is the place, and a system error says its code', () => {
  const { sent } = run(app().root);
  errorReport.report('main', errorWith(['    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1611:16)'], { message: 'connect ECONNREFUSED 127.0.0.1:4321', code: 'ECONNREFUSED' }), { via: 'rejection' });
  errorReport.report('main', errorWith(['    at async open (node:internal/fs/promises:639:25)'], { message: "ENOENT: no such file or directory, open '/Users/someone/Clients/acme-site/x'", code: 'ENOENT' }), { via: 'rejection' });
  errorReport.report('main', errorWith(['    at IpcMainImpl.emit (node:electron/js2c/browser_init:2:91000)'], { name: 'TypeError', message: 'Object has been destroyed' }));
  errorReport.report('main', errorWith(['    at Socket.write (node:net:1:1)'], { code: 'ERR_STREAM_DESTROYED' }));
  errorReport.report('main', errorWith(['    at getaddrinfo (node:dns:1:1)'], { code: 'ENOTFOUND' }));
  assert.deepEqual(sent, [
    { surface: 'main', error_name: 'Error', where: 'node:net', error_code: 'ECONNREFUSED' },
    { surface: 'main', error_name: 'Error', where: 'node:internal/fs/promises', error_code: 'ENOENT' },
    { surface: 'main', error_name: 'TypeError', where: 'electron:browser_init' },
    { surface: 'main', error_name: 'Error', where: 'node:net', error_code: 'ERR_STREAM_DESTROYED' },
    { surface: 'main', error_name: 'Error', where: 'node:dns', error_code: 'ENOTFOUND' },
  ]);
});

test('what wasn\'t an Error is named for its type: a rejected string or undefined, a thrown object', () => {
  const { sent } = run(app().root);
  errorReport.report('main', 'a string with /Users/someone/Clients/acme-site in it', { via: 'rejection' });
  errorReport.report('main', undefined, { via: 'rejection' });
  errorReport.report('main', null, { via: 'rejection' });
  errorReport.report('main', 42, { via: 'exception' });
  errorReport.report('main', { reason: 'no stack' }, { via: 'exception' });
  class Refusal { why = 'busy'; }
  errorReport.report('main', new Refusal(), { via: 'rejection' });
  errorReport.report('main', new Map(), { via: 'rejection' });
  assert.deepEqual(sent.map((s) => `${s.error_name} ${s.where}`), ['rejection:string none', 'rejection:undefined none', 'rejection:null none', 'throw:number none', 'throw:object none', 'rejection:object none', 'rejection:Map none']);
});

test('the window\'s reports: a failed call to main names its channel, and the browser\'s own error events say what they were', () => {
  const a = app();
  const { sent } = run(a.root);
  const at = a.frame('renderer/renderer.ts', 'MARK_EMPTY').match(/:(\d+):(\d+)\)$/)!;
  errorReport.reportWindow({ surface: 'renderer', via: 'rejection', name: 'Error', message: "Error invoking remote method 'term:start': TypeError: Cannot read properties of undefined (reading 'pid') at /Users/someone/x", stack: "Error: Error invoking remote method 'term:start': TypeError: …" });
  errorReport.reportWindow({ surface: 'renderer', via: 'rejection', name: 'Error', message: "Error invoking remote method 'session:setActive': No handler registered for 'session:setActive'" });
  errorReport.reportWindow({ surface: 'renderer', via: 'error', kind: 'resize-observer-loop', message: 'ResizeObserver loop completed with undelivered notifications.' });
  errorReport.reportWindow({ surface: 'renderer', via: 'error', kind: 'cross-origin-script', message: 'Script error.' });
  errorReport.reportWindow({ surface: 'renderer', via: 'error', kind: 'error-event', message: 'Uncaught oops', filename: pathToFileURL(path.join(a.root, 'out', 'renderer', 'renderer.js')).href, lineno: Number(at[1]), colno: Number(at[2]) });
  errorReport.reportWindow({ surface: 'renderer', via: 'error', kind: 'error-event', message: 'Uncaught oops', filename: 'http://localhost:4321/src/main.js', lineno: 3, colno: 9 });
  errorReport.reportWindow({ surface: 'renderer', via: 'error', valueType: 'string', message: 'Uncaught boom' });
  errorReport.reportWindow({ surface: 'renderer', via: 'rejection', valueType: 'Event' });
  assert.deepEqual(sent.map((s) => `${s.error_name} ${s.where}`), [
    'TypeError ipc:term:start',
    'Error ipc:session:setActive',
    'resize-observer-loop none',
    'cross-origin-script none',
    `error-event src/renderer/renderer.ts:${a.tsLine('renderer/renderer.ts', 'MARK_EMPTY')}`,
    'error-event none',
    'throw:string none',
    'rejection:Event none',
  ]);
});

test('nothing in an error\'s message, its stack or its name leaves the machine: no path outside the app, no URL, no page text', () => {
  // The app itself in a folder under a home (a checkout): only paths inside it, relative, may go.
  const a = app();
  const { sent, log } = run(a.root);
  const secret = ['/Users/someone/Clients/acme-site', 'https://acme.example/pricing', 'localhost:4321', 'Acme pricing page'];
  errorReport.report('main', errorWith([
    '    at render (http://localhost:4321/src/pages/pricing.astro:12:5)',
    '    at build (/Users/someone/Clients/acme-site/node_modules/astro/dist/core.js:1:2)',
    '    at Object.<anonymous> (/Users/someone/Clients/acme-site/scripts/build.js:9:1)',
  ], { message: `ENOENT ${secret.join(' ')}`, name: 'Error' }), { via: 'rejection' });
  errorReport.report('main', errorWith([a.frame('main/devServer.ts', 'MARK_START', 'startServer')], { message: secret.join(' '), name: '/Users/someone/Clients/acme-site TypeError' }));
  errorReport.reportWindow({ surface: 'preview', via: 'error', name: 'Error https://acme.example/pricing', message: secret.join(' '), stack: `Error: x\n    at f (https://acme.example/pricing.js:1:1)\n    at ${pathToFileURL('/Users/someone/Clients/acme-site/index.html').href}:3:4` });
  errorReport.reportWindow({ surface: 'renderer', via: 'rejection', valueType: 'string', message: secret.join(' ') });
  errorReport.reportWindow({ surface: 'renderer', via: 'error', kind: 'error-event', message: secret.join(' '), filename: 'file:///Users/someone/Clients/acme-site/x.js', lineno: 1, colno: 1 });
  const out = JSON.stringify(sent);
  for (const s of [...secret, '/Users/', 'acme', 'http', 'file:', 'astro', 'pricing']) assert.ok(!out.includes(s), `${s} left the machine: ${out}`);
  assert.deepEqual(sent.map((s) => `${s.error_name} ${s.where}`), ['Error none', `Error src/main/devServer.ts:${a.tsLine('main/devServer.ts', 'MARK_START')} (startServer)`, 'Error none', 'rejection:string none', 'error-event none']);
  assert.ok(log().every((entry) => entry.message.includes('acme-site')), 'the full story stays in the local log');
});

// The privacy review's probes (breakit.ts, exotic.ts, v8names.cjs), each a test: names, kinds and types built from
// data, function names V8 builds from data, codes and process types shaped like content, and values that throw.
test('a name that isn\'t one of the known error classes is sent as Error: a data-named object, a renamed Error, a site\'s own class, an 80-character identifier', () => {
  const a = app();
  const { sent } = run(a.root);
  errorReport.report('main', { name: 'dellamarsh', path: '/Users/jane/Clients/acme' }, { via: 'rejection' });
  errorReport.report('main', { name: 'AcmeClientSite', dir: '/Users/x/acme' }, { via: 'rejection' });
  errorReport.report('main', errorWith([a.frame('main/devServer.ts', 'MARK_START', 'startServer')], { name: 'AcmePricingPage' }));
  errorReport.reportWindow({ surface: 'renderer', via: 'rejection', name: 'PricingTableError', message: 'x', stack: 'PricingTableError: x\n    at render (http://localhost:4321/src/pricing.ts:1:1)' });
  errorReport.report('main', errorWith(['    at node:net:1:1'], { name: 'della_marsh_marshworks_co_acme_site_pricing_page_draft_v2_secret_launch_plan' }));
  errorReport.reportWindow({ surface: 'renderer', via: 'rejection', name: 'Error', message: "Error invoking remote method 'project:open': AcmeSiteError: boom" });
  errorReport.reportWindow({ surface: 'renderer', kind: 'dellamarsh' as never });
  errorReport.reportWindow({ surface: 'renderer', via: 'rejection', valueType: 'AcmeClientSite' });
  errorReport.reportWindow({ surface: 'renderer', via: 'error', name: 'NotAllowedError', message: 'Document is not focused.', stack: 'NotAllowedError: Document is not focused.' });
  assert.deepEqual(sent.map((s) => `${s.error_name} ${s.where}`), [
    'rejection:object none',
    `Error src/main/devServer.ts:${a.tsLine('main/devServer.ts', 'MARK_START')} (startServer)`,
    'Error none',
    'Error node:net',
    'Error ipc:project:open',
    'rejection:object none',
    'NotAllowedError none',
  ], 'the first two objects are one kind (rejection:object, deduped), and the unknown window kind adds nothing new');
  for (const s of ['dellamarsh', 'Acme', 'Pricing', 'della_marsh']) assert.ok(!JSON.stringify(sent).includes(s), s);
});

test('a function name in where is one plain identifier from that file\'s own code: never an alias, a receiver, or a name built from data', () => {
  const a = app();
  const { sent } = run(a.root);
  const frame = (fn: string) => a.frame('main/devServer.ts', 'MARK_HANDLER', fn);
  const line = a.tsLine('main/devServer.ts', 'MARK_HANDLER');
  const names = ['Object.handler [as Acme Pricing]', 'dellamarsh.m', 'acme-site.com', 'della.marsh', 'della@marshworks.co', '/Users/jane/x', 'new della.marsh', 'Acme Site', 'async handler', 'AcmeClient.handler', 'dellamarsh'];
  for (const [i, fn] of names.entries()) errorReport.report('main', errorWith([frame(fn)], { name: ['TypeError', 'RangeError', 'SyntaxError', 'EvalError', 'URIError', 'ReferenceError', 'AggregateError', 'Error', 'AbortError', 'TimeoutError', 'NotFoundError'][i] }));
  assert.deepEqual(sent.map((s) => s.where), [
    `src/main/devServer.ts:${line} (handler)`, // the alias and the receiver go; handler is in the file
    `src/main/devServer.ts:${line}`, // m isn't
    `src/main/devServer.ts:${line}`,
    `src/main/devServer.ts:${line}`, // marsh isn't
    `src/main/devServer.ts:${line}`,
    `src/main/devServer.ts:${line}`,
    `src/main/devServer.ts:${line}`,
    `src/main/devServer.ts:${line}`,
    `src/main/devServer.ts:${line} (handler)`,
    `src/main/devServer.ts:${line} (handler)`,
    `src/main/devServer.ts:${line}`,
  ]);
  for (const s of ['Acme', 'della', 'marshworks', 'Users', '[as']) assert.ok(!JSON.stringify(sent).includes(s), s);
});

test('IPC failures are read only from the window, and only for a channel the preload calls', () => {
  const { sent } = run(app().root);
  errorReport.report('main', Object.assign(new Error("Error invoking remote method 'della.marsh': x"), { stack: 'Error: x' }));
  errorReport.reportWindow({ surface: 'renderer', via: 'rejection', name: 'Error', message: "Error invoking remote method 'della.marsh': TypeError: x" });
  errorReport.reportWindow({ surface: 'renderer', via: 'rejection', name: 'Error', message: "Error invoking remote method 'term:bell': Error: x" }); // the preload sends it, never invokes it
  assert.deepEqual(sent.map((s) => `${s.surface} ${s.error_name} ${s.where}`), ['main Error none', 'renderer TypeError none', 'renderer Error none'], 'the class main threw is still named; the channel only when the preload invokes it');
});

test('a code and a process type are each one of a known list, else other', () => {
  const { sent } = run(app().root);
  errorReport.report('main', errorWith(['    at node:net:1:1'], { code: 'EACMESITE' }));
  errorReport.report('main', errorWith(['    at node:fs:1:1'], { code: 'ERR_ACME_SITE' }));
  errorReport.reportGone('process', { reason: 'crashed', exitCode: 1, processType: 'Utility:Acme Site Preview' }, {});
  errorReport.reportGone('process', { reason: 'oom', exitCode: 1, processType: 'Acme' }, {});
  errorReport.reportGone('process', { reason: 'killed', exitCode: 1, processType: 'Utility:network.mojom.NetworkService' }, {});
  errorReport.reportGone('process', { reason: 'launch-failed', exitCode: 1, processType: 'GPU' }, {});
  errorReport.reportGone('process', { reason: 'integrity-failure', exitCode: 1, processType: 'GPU:network.mojom.NetworkService' }, {}); // only a utility process names its service
  assert.deepEqual(sent.map((s) => s.error_code || s.process_type), ['other', 'other', 'Utility:other', 'other', 'Utility:network.mojom.NetworkService', 'GPU', 'GPU']);
});

test('processes of different types that stop for the same reason are each reported', () => {
  const { sent } = run(app().root);
  errorReport.reportGone('process', { reason: 'crashed', exitCode: 1, processType: 'GPU' }, {});
  errorReport.reportGone('process', { reason: 'crashed', exitCode: 1, processType: 'Utility:network.mojom.NetworkService' }, {});
  errorReport.reportGone('process', { reason: 'crashed', exitCode: 1, processType: 'GPU' }, {});
  assert.deepEqual(sent.map((s) => s.process_type), ['GPU', 'Utility:network.mojom.NetworkService']);
});

test('it never throws, whatever it\'s given: a revoked proxy, a proxy whose get throws, an Error whose stack getter throws, an object whose constructor getter throws', () => {
  const a = app();
  const { sent } = run(a.root);
  const { proxy: revoked, revoke } = Proxy.revocable({}, {}); revoke();
  const values: [string, unknown][] = [
    ['proxy whose get throws', new Proxy({}, { get() { throw new Error('trap'); } })],
    ['revoked proxy', revoked],
    ['error with a throwing stack getter', Object.defineProperty(new Error('x'), 'stack', { get() { throw new Error('stack getter'); } })],
    ['object whose constructor getter throws', Object.defineProperty({}, 'constructor', { get() { throw new Error('ctor'); } })],
  ];
  for (const [label, value] of values) {
    assert.doesNotThrow(() => errorReport.report('main', value, { via: 'rejection' }), label);
    assert.doesNotThrow(() => errorReport.report('main', value, { via: 'exception' }), label);
    assert.doesNotThrow(() => errorReport.reportWindow(value as never), label);
    assert.doesNotThrow(() => errorReport.reportWindow({ surface: 'renderer', name: value, message: value, stack: value, filename: value } as never), label);
  }
  assert.ok(sent.length >= 2 && sent.every((s) => /^(Error|rejection:object|throw:object)$/.test(s.error_name) && s.where === 'none'), JSON.stringify(sent));
});

test('the local log keeps 200 entries a run, and counts the rest', () => {
  const { log, dir } = run(app().root);
  for (let i = 0; i < 230; i++) errorReport.report('main', errorWith([`    at f (node:internal/x${i}:1:1)`]));
  assert.equal(log().length, 200);
  errorReport.writeUnlogged();
  const lines = fs.readFileSync(path.join(dir, 'error-log.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 201);
  assert.equal((JSON.parse(lines[200]) as { unlogged: number }).unlogged, 30);
});

test('a map is read once, each frame mapped once, and both are let go after a short idle', async () => {
  const a = app();
  const { sent } = run(a.root, { idleMs: 30 });
  const err = (name: string) => errorWith([a.frame('main/devServer.ts', 'MARK_START', 'startServer')], { name });
  errorReport.report('main', err('TypeError'));
  errorReport.report('main', err('RangeError'));
  assert.deepEqual(errorReport.cached(), { maps: 1, files: 1, frames: 1 });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(errorReport.cached(), { maps: 0, files: 0, frames: 0 }, 'released after the idle');
  errorReport.report('main', err('SyntaxError'));
  assert.equal(new Set(sent.map((s) => s.where)).size, 1, 'and mapped the same again');
});

test('the window\'s report is taken only from the app\'s own window, never a preview', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
  const relay = /ipcMain\.on\('radial:app-error', \((\w+), (\w+)[^)]*\) => \{([^\n]*)\}\);/.exec(main);
  assert.ok(relay, 'main.ts relays radial:app-error');
  assert.match(relay![3], new RegExp(`${relay![1]}\\.sender !== mainWindow\\.webContents`), 'from the main window only');
  assert.match(relay![3], /try \{ errorReport\.reportWindow\(/, 'and never throws');
  // Each process handler, to its own end: a one-line handler, or the lines up to the first that closes it.
  const lines = main.split('\n');
  for (const handler of ['uncaughtException', 'unhandledRejection']) {
    const start = lines.findIndex((l) => l.startsWith(`process.on('${handler}',`));
    assert.ok(start >= 0, `main.ts handles ${handler}`);
    const end = lines[start].trimEnd().endsWith('});') ? start : lines.findIndex((l, i) => i > start && l === '});');
    assert.match(lines.slice(start, end + 1).join('\n'), /try \{ errorReport\.report\(/, `main.ts reports a ${handler} inside a try`);
  }
});

test('a process that went away: its reason, exit code and counts, once per reason', () => {
  const { sent, log } = run(app().root);
  errorReport.reportGone('renderer', { reason: 'crashed', exitCode: 11 }, { memoryMb: 812, uptimeMin: 95, webviews: 2, terminals: 3 });
  errorReport.reportGone('renderer', { reason: 'crashed', exitCode: 11 }, { memoryMb: 812, uptimeMin: 96, webviews: 2, terminals: 3 });
  errorReport.reportGone('preview', { reason: 'oom', exitCode: 5 }, { uptimeMin: 3, webviews: 1 });
  errorReport.reportGone('process', { reason: 'abnormal-exit', exitCode: 15, processType: 'Utility:network.mojom.NetworkService' }, { memoryMb: 40, uptimeMin: 7, webviews: 0, terminals: 0 });
  errorReport.reportGone('preview', { reason: 'Crashed! See /Users/someone', exitCode: 1.5, processType: '/Users/someone' }, { memoryMb: -3 });
  assert.deepEqual(sent, [
    { surface: 'renderer', error_name: 'render-process-gone/crashed', where: 'none', reason: 'crashed', exit_code: 11, memory_mb: 812, uptime_min: 95, webviews: 2, terminals: 3 },
    { surface: 'preview', error_name: 'render-process-gone/oom', where: 'none', reason: 'oom', exit_code: 5, uptime_min: 3, webviews: 1 },
    { surface: 'process', error_name: 'child-process-gone/abnormal-exit', where: 'none', reason: 'abnormal-exit', exit_code: 15, process_type: 'Utility:network.mojom.NetworkService', memory_mb: 40, uptime_min: 7, webviews: 0, terminals: 0 },
    { surface: 'preview', error_name: 'render-process-gone/unknown', where: 'none', reason: 'unknown', process_type: 'other' },
  ]);
  assert.equal(log().length, 5, 'each one is in the local log');
});

test('a place that fits none of the shapes that may leave is sent as scrubbed', () => {
  const a = app();
  const { sent } = run(a.root);
  fs.mkdirSync(path.join(a.root, 'bin'));
  errorReport.report('main', errorWith([`    at main (${path.join(a.root, 'bin', 'radial')}:5:1)`]));
  assert.deepEqual(sent, [{ surface: 'main', error_name: 'Error', where: 'scrubbed' }]);
});

test('the same error reports once per run but always logs locally', () => {
  const a = app();
  const { sent, log } = run(a.root);
  const err = errorWith([a.frame('renderer/renderer.ts', 'MARK_EMPTY', 'tick')]);
  for (let i = 0; i < 3; i++) errorReport.report('renderer', err);
  assert.equal(sent.length, 1);
  assert.equal(log().length, 3);
});

test('distinct errors are capped per run so a loop cannot flood', () => {
  const { sent } = run(app().root);
  for (let i = 0; i < 40; i++) errorReport.report('main', errorWith([`    at f (node:internal/x${i}:1:1)`]));
  assert.equal(sent.length, 30);
});

test('reporting before init is a safe no-op', () => {
  const p = require.resolve('../src/main/errorReport');
  const cached = require.cache[p];
  delete require.cache[p];
  const fresh = require('../src/main/errorReport') as typeof import('../src/main/errorReport'); // genuinely uninitialized copy
  assert.doesNotThrow(() => fresh.report('main', new Error('early')));
  assert.doesNotThrow(() => fresh.reportWindow({ surface: 'renderer', valueType: 'string' }));
  assert.doesNotThrow(() => fresh.reportGone('renderer', { reason: 'crashed' }));
  require.cache[p] = cached;
});

test('every property it sends is one telemetry passes through', () => {
  const { ALLOWED_PROPS } = require('../src/main/telemetry') as typeof import('../src/main/telemetry');
  const { sent } = run(app().root);
  errorReport.report('main', errorWith(['    at x (node:net:1:1)'], { code: 'EPIPE' }));
  errorReport.reportGone('process', { reason: 'crashed', exitCode: 1, processType: 'GPU' }, { memoryMb: 1, uptimeMin: 1, webviews: 1, terminals: 1 });
  for (const props of sent) for (const key of Object.keys(props)) assert.ok((ALLOWED_PROPS as ReadonlySet<string>).has(key), key);
  const capture: ErrorCapture = (_e, p) => void p;
  assert.equal(typeof capture, 'function');
});
