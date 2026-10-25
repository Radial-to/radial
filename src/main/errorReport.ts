// Crash/error visibility with a handful of real users: when something breaks
// in the field, an `app_error` telemetry event says THAT it broke, what it was
// and where in Radial's own code. The full story stays on the user's machine.
//
// The privacy split mirrors the telemetry contract (events, never content):
//   → PostHog: surface (main|renderer|preview|process), error_name, where,
//     a system error's code, and for a process that went away its reason,
//     exit code and a few counts. Never the message (messages embed user file
//     paths, "ENOENT …/Clients/acme-site/…"), a path outside the app, a URL,
//     page text, or a name built from data. Every value goes through the
//     allowlist (errorAllowlist.ts, the usage-data page's list) on its way out:
//     a known error class, a known code or process type, `where` in one of a
//     few shapes built from Radial's own files (relative to the app, mapped to
//     src/ with the source maps the app ships, with a function name only when
//     it's an identifier in that file's code), a library, a Node or Electron
//     module, or one of the preload's IPC channels; else "Error", "other" or
//     "scrubbed".
//   → error-log.jsonl in userData: message + full stack, for when a tester
//     says "it broke" and sends the file. 200 entries a run (the rest are
//     counted), with the telemetry audit log's bounded rotation.
//
// Not every report starts as an Error. A rejected string, a thrown object, or
// one of the browser's own error events (a ResizeObserver loop, a script from
// another origin) has no name and no stack; each is named for what it was
// (rejection:string, throw:object, resize-observer-loop, …) and its where is
// "none". A call to main that failed in the window (Electron's "Error invoking
// remote method 'x'") arrives with no stack either; its where is the channel.
//
// It never throws: what it's given may be anything (a revoked Proxy, a getter
// that throws), and an exception from an uncaughtException listener would
// take the app down.
//
// Dedupe: one report per (surface, name, where, code, reason, process type) per run, capped
// overall — an error in a render loop must not turn into an event flood.

import fs from 'fs';
import path from 'path';
import util from 'util';
import { fileURLToPath } from 'url';
import { SourceMap } from 'module';
import type { SourceMapPayload } from 'module';
import type { WindowErrorReport } from '../shared/radialApi';
import type { TelemetryProp } from './telemetry';
import { WINDOW_KINDS, safeCode, safeCount, safeName, safeProcessType, safeReason, safeWhere } from './errorAllowlist';

const LOG_NAME = 'error-log.jsonl';
const LOG_MAX_BYTES = 512 * 1024;
const LOG_PER_RUN = 200;
const MAX_REPORTS_PER_RUN = 30;

/** Where an error happened: the main process, the app window, a site preview, or another of Electron's processes (the GPU process, a utility process). */
export type ErrorSurface = 'main' | 'renderer' | 'preview' | 'process';
/** How an error reached the reporter: thrown and never caught, or a rejected promise nobody handled. */
export type ErrorVia = 'exception' | 'rejection';

/**
 * The app_error event's properties. None of them can carry the message, a
 * path outside the app, a URL or page text: each is a known name, an
 * app-relative place, a known code or type, or a number (errorAllowlist.ts).
 */
export type AppErrorProps = {
  surface: ErrorSurface;
  error_name: string;
  where: string;
  /** A system error's code (ENOENT, ECONNREFUSED, ERR_STREAM_DESTROYED), or "other". */
  error_code?: string;
  /** A process that went away: why (crashed, oom, killed, …), its exit code, and for another of Electron's processes its type. */
  reason?: string;
  exit_code?: number;
  process_type?: string;
  /** How much memory that process used at the last sample, how long the app had been up, and how many previews and terminals were open. */
  memory_mb?: number;
  uptime_min?: number;
  webviews?: number;
  terminals?: number;
};

// Every property is one telemetry.ts passes through (ALLOWED_PROPS): one it didn't know would be dropped on the way out.
const _allowed: Record<Exclude<keyof AppErrorProps, TelemetryProp>, never> = {};
void _allowed;

/** telemetry.capture, or a test's stand-in. */
export type ErrorCapture = (event: 'app_error', props: AppErrorProps) => void;

export interface ErrorReportOptions {
  capture?: ErrorCapture | null;
  /** The folder the app runs from (holding out/ and its source maps): the installed app's app.asar, or a checkout. Tests pass their own. */
  appRoot?: string;
  /** How long the source maps and what they mapped stay in memory after the last report (ms). */
  idleMs?: number;
}

/** One line of error-log.jsonl in userData: the full story stays on the machine. */
export interface ErrorLogEntry {
  ts: string;
  surface: ErrorSurface;
  name: string;
  /** Where in Radial's own code, like "src/renderer/renderer.ts:1234 (showEmpty)"; "none" when there's no stack. */
  where: string;
  code?: string;
  message: string;
  stack: string;
}
/** The log's last line for a run that reported more than it keeps: how many it didn't write. */
export interface ErrorLogSummary { ts: string; unlogged: number }

let logPath: string | null = null;
let capture: ErrorCapture | null = null; // telemetry.capture, injected so tests can observe
let appRoot = path.resolve(__dirname, '..', '..'); // out/main → the app's folder
let idleMs = 30000;
const seen = new Set<string>();
let sent = 0;
let logged = 0;
let unlogged = 0;
let exitHooked = false;

/** A read that may throw (a getter, a Proxy's trap, a revoked Proxy): its value, or the fallback. */
function read<T>(get: () => T, fallback: T): T {
  try { return get(); } catch { return fallback; }
}
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

// ── What it was read from: source maps, the files' identifiers, the preload's channels ──
// Read once each, kept while reports come, and let go after a short idle: renderer.js.map alone is 600 KB to
// parse and holds megabytes once parsed, on main's thread.

const maps = new Map<string, SourceMap | null>(); // out/<file>.js → its map
const identifiers = new Map<string, ReadonlySet<string>>(); // a file in the app → the identifiers in its code
const frames = new Map<string, string>(); // a frame (file, line, column, function) → its place
let channels: ReadonlySet<string> | null = null; // the preload's ipcRenderer.invoke channels
let idleTimer: NodeJS.Timeout | null = null;

function release(): void {
  maps.clear();
  identifiers.clear();
  frames.clear();
  channels = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}
function touched(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(release, idleMs);
  idleTimer.unref?.();
}
/** What's in memory now (for the tests). */
export function cached(): { maps: number; files: number; frames: number } {
  return { maps: maps.size, files: identifiers.size, frames: frames.size };
}

function mapFor(rel: string): SourceMap | null {
  if (!maps.has(rel)) maps.set(rel, read(() => new SourceMap(JSON.parse(fs.readFileSync(path.join(appRoot, `${rel}.map`), 'utf8')) as SourceMapPayload), null));
  return maps.get(rel)!;
}
/** The identifiers in a file of the app: every word its code is written in, so a function name from one of them is code, never data. */
function identifiersOf(rel: string): ReadonlySet<string> {
  if (!identifiers.has(rel)) identifiers.set(rel, read(() => new Set(fs.readFileSync(path.join(appRoot, rel), 'utf8').match(/[A-Za-z_$][\w$]*/g) || []), new Set<string>()));
  return identifiers.get(rel)!;
}
/** The channels the preload calls main on (ipcRenderer.invoke('…')): the only ones a failed call may name. */
function preloadChannels(): ReadonlySet<string> {
  if (!channels) {
    let source = '';
    for (const rel of ['out/preload/preload.js', 'src/preload/preload.ts']) {
      source = read(() => fs.readFileSync(path.join(appRoot, rel), 'utf8'), '');
      if (source) break;
    }
    channels = new Set([...source.matchAll(/\bipcRenderer\.invoke\(\s*["']([\w:.-]{1,64})["']/g)].map((m) => m[1]));
  }
  touched();
  return channels;
}

// ── Where: the first frame in Radial's own code ─────────────────────────────

/** One line of a V8 stack: its function (when it has one) and its place. */
export interface StackFrame { fn: string | null; file: string; line: number; col: number }

/** The frames of a V8 stack, top first; lines that aren't frames (the message, "at <anonymous>") are skipped. */
export function parseFrames(stack: unknown): StackFrame[] {
  const out: StackFrame[] = [];
  for (const raw of text(stack).split('\n')) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(raw);
    if (!m || /^eval at /.test(m[2])) continue;
    out.push({ fn: m[1] || null, file: m[2], line: Number(m[3]), col: Number(m[4]) });
  }
  return out;
}

/** A frame's file as a path in the app's folder ("out/main/main.js", "node_modules/node-pty/lib/index.js"), or null for anything outside it. */
function inApp(file: string): string | null {
  let abs = file;
  if (/^file:\/\//.test(abs)) { try { abs = fileURLToPath(abs); } catch { return null; } }
  if (!path.isAbsolute(abs)) return null; // node:internal/…, a URL, <anonymous>
  const rel = path.relative(appRoot, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** A library the error went through: a package (node_modules/<name>) or a bundle vendored into the window (src/renderer/vendor/<file>). */
function libraryOf(rel: string): string | null {
  const pkg = /(?:^|\/)node_modules\/((?:@[\w.-]+\/)?[\w.-]+)/.exec(rel);
  if (pkg) return `node_modules/${pkg[1]}`;
  const vendor = /^(?:out|src)\/renderer\/vendor\/(.+)$/.exec(rel);
  return vendor ? `src/renderer/vendor/${vendor[1]}` : null;
}

// How V8 names a frame's function: a receiver, a name, an alias. All but the name can come from data (a
// Symbol.toStringTag, a key a function was stored under, "[as Acme Pricing]"), and so can a computed name.
const FRAME_FUNCTION = /^(?:new |async )?(?:(?:[\w$]+|<anonymous>)\.)*([\w$]+|<anonymous>)(?: \[as [^\]]*\])?$/;

/** A frame's function, as one plain identifier that's in its file's code; null otherwise (no alias, no receiver, nothing built from data). */
function functionOf(rel: string, frame: StackFrame): string | null {
  const m = FRAME_FUNCTION.exec(frame.fn || '');
  if (!m || !/^[A-Za-z_$][\w$]{0,59}$/.test(m[1])) return null;
  return identifiersOf(rel).has(m[1]) ? m[1] : null;
}

/** A frame of Radial's own code, mapped back to its source: "src/renderer/renderer.ts:1234 (showEmpty)". */
function ownPlace(rel: string, frame: StackFrame): string {
  const key = `${rel}:${frame.line}:${frame.col}:${frame.fn || ''}`;
  if (!frames.has(key)) {
    let place = `${rel}:${frame.line}`;
    if (rel.startsWith('out/')) {
      const origin = read(() => mapFor(rel)?.findOrigin(frame.line, frame.col), undefined);
      if (origin && 'fileName' in origin && /^src\//.test(origin.fileName)) place = `${origin.fileName}:${origin.lineNumber}`;
    }
    const fn = functionOf(rel, frame);
    if (frames.size > 1000) frames.clear();
    frames.set(key, fn ? `${place} (${fn})` : place);
  }
  touched();
  return frames.get(key)!;
}

/**
 * Where in Radial an error happened, from its stack: the first frame in its own
 * code (src/…, mapped), with the library it went through when it was thrown
 * inside one; else that library; else the Node or Electron module it came
 * from; null when the stack names none of these (no stack, or only other
 * code: a site's page, an eval).
 */
export function locate(stack: unknown): string | null {
  let library: string | null = null;
  let internal: string | null = null;
  for (const frame of parseFrames(stack)) {
    const rel = inApp(frame.file);
    if (rel) {
      const lib = libraryOf(rel);
      if (!lib) return ownPlace(rel, frame) + (library ? ` via ${library}` : '');
      if (!library) library = lib.startsWith('src/') ? `${lib}:${frame.line}:${frame.col}` : lib;
      continue;
    }
    if (!internal) {
      const mod = /^(?:node:)?electron\/js2c\/([\w-]+)$/.exec(frame.file);
      if (mod) internal = `electron:${mod[1]}`;
      else if (/^node:[\w/._-]{1,80}$/.test(frame.file)) internal = frame.file;
    }
  }
  return library || internal;
}

// ── What it was ─────────────────────────────────────────────────────────────

/** What was thrown or rejected, when it isn't an Error: its type, or an object's class (the allowlist keeps only known ones). */
function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object' && typeof value !== 'function') return typeof value;
  const name = read(() => (value as { constructor?: { name?: unknown } }).constructor?.name, undefined);
  return typeof name === 'string' && name !== 'Object' ? name : 'object';
}

/** What report() reads off an Error; a value that isn't one has none of these. */
export interface ErrorLike { name?: unknown; message?: unknown; stack?: unknown; code?: unknown }
/** An Error, as the window tests it (windowErrors.ts), and one from another realm (a vm context) too. */
const isError = (value: unknown): value is ErrorLike => read(() => util.types.isNativeError(value) || value instanceof Error, false);

// Electron's message for a call to main that failed in the window: "Error invoking remote method '<channel>': <the error main threw>".
const IPC_FAILURE = /^Error invoking remote method '([\w:.-]{1,64})': (?:([A-Za-z][\w$]*)\b)?/;

/** One report, as it goes to the log and (checked) to the event. */
interface Described { name: string; where: string | null; code?: unknown; message: string; stack: string }

/** An Error's name, place and code, each read so that a getter that throws can't. */
function describeError(e: ErrorLike): Described {
  const stack = text(read(() => e.stack, ''));
  return { name: text(read(() => e.name, '')) || 'Error', where: locate(stack), code: read(() => e.code, undefined), message: text(read(() => e.message, '')), stack };
}

/** Anything thrown or rejected in main: an Error, or a value named for its type ("rejection:string", "throw:object"). */
function describe(err: unknown, via: ErrorVia): Described {
  if (isError(err)) return describeError(err);
  return { name: `${via === 'rejection' ? 'rejection' : 'throw'}:${valueType(err)}`, where: null, message: typeof err === 'string' ? err : '', stack: '' };
}

/** A report from the window (windowErrors.ts), every field read as untrusted. */
function describeWindow(p: unknown): Described {
  const field = (key: keyof WindowErrorReport): unknown => read(() => (p as Record<string, unknown>)[key], undefined);
  const message = text(field('message'));
  const kind = field('kind');
  if (kind === 'error-event') {
    // An error event with no error object, but a place in a script: Radial's own, when it's in the app.
    const filename = text(field('filename')), lineno = field('lineno'), colno = field('colno');
    const rel = filename ? inApp(filename) : null;
    const where = rel && !libraryOf(rel) && typeof lineno === 'number' ? ownPlace(rel, { fn: null, file: filename, line: lineno, col: typeof colno === 'number' ? colno : 1 }) : null;
    return { name: 'error-event', where, message, stack: '' };
  }
  if (typeof kind === 'string' && WINDOW_KINDS.has(kind)) return { name: kind, where: null, message, stack: '' };
  const type = field('valueType');
  if (typeof type === 'string' && type) return { name: `${field('via') === 'rejection' ? 'rejection' : 'throw'}:${type}`, where: null, message, stack: '' };
  // An Error from the window. A failed call to main has no stack: its place is the channel, when it's one the preload calls.
  const ipc = IPC_FAILURE.exec(message);
  if (ipc) return { name: ipc[2] || 'Error', where: preloadChannels().has(ipc[1]) ? `ipc:${ipc[1]}` : null, message, stack: text(field('stack')) };
  return describeError({ name: field('name'), message, stack: field('stack') });
}

// ── The report ──────────────────────────────────────────────────────────────

/** Writes the count of entries this run didn't log, if any (at exit, and for the tests). */
function writeUnlogged(): void {
  if (!logPath || !unlogged) return;
  try { fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), unlogged } satisfies ErrorLogSummary) + '\n'); } catch {}
  unlogged = 0;
}

function init(userDataDir: string, opts: ErrorReportOptions = {}): void {
  logPath = path.join(userDataDir, LOG_NAME);
  capture = opts.capture || null;
  if (opts.appRoot) appRoot = path.resolve(opts.appRoot);
  if (opts.idleMs) idleMs = opts.idleMs;
  release();
  seen.clear();
  sent = 0;
  logged = 0;
  unlogged = 0;
  if (!exitHooked) { exitHooked = true; process.on('exit', writeUnlogged); }
  try {
    const st = fs.statSync(logPath);
    if (st.size > LOG_MAX_BYTES) {
      const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(logPath, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
    }
  } catch {}
}

/** Logs a described error locally (message and stack included, 200 a run) and sends its checked event, once per run per kind and place. */
function emit(surface: ErrorSurface, d: Described, extra: Omit<AppErrorProps, 'surface' | 'error_name' | 'where'> = {}): void {
  if (!logPath) return; // not initialized (early crash before whenReady) — dialog still shows
  const name = safeName(d.name);
  const where = safeWhere(d.where);
  const code = safeCode(d.code);
  if (logged < LOG_PER_RUN) {
    logged += 1;
    try {
      fs.appendFileSync(logPath, JSON.stringify({
        ts: new Date().toISOString(),
        surface,
        name,
        where,
        ...(code ? { code } : {}),
        message: d.message.slice(0, 2000),
        stack: d.stack.slice(0, 8000),
      } satisfies ErrorLogEntry) + '\n');
    } catch {}
  } else unlogged += 1;
  const key = `${surface}|${name}|${where}|${code || ''}|${extra.reason || ''}|${extra.process_type || ''}`;
  if (seen.has(key) || sent >= MAX_REPORTS_PER_RUN) return;
  seen.add(key);
  sent += 1;
  if (capture) capture('app_error', { surface, error_name: name, where, ...(code ? { error_code: code } : {}), ...extra });
}

/**
 * Something thrown and never caught, or a rejected promise nobody handled, in
 * the main process (or radial serve's): an Error, or any other value. Never throws.
 */
function report(surface: ErrorSurface, err: unknown, { via = 'exception' }: { via?: ErrorVia } = {}): void {
  try { emit(surface, describe(err, via)); } catch {}
}

/** One of the window's uncaught errors or unhandled rejections (radial:app-error, from windowErrors.ts). Never throws. */
function reportWindow(p: unknown): void {
  try {
    if (!p || typeof p !== 'object') return;
    emit(read(() => (p as WindowErrorReport).surface, 'renderer') === 'preview' ? 'preview' : 'renderer', describeWindow(p));
  } catch {}
}

/** A process that went away (processWatch.ts): Electron's details, and what it knew at the time. */
export interface GoneDetails { reason?: unknown; exitCode?: unknown; processType?: unknown }
export interface GoneCounts { memoryMb?: number; uptimeMin?: number; webviews?: number; terminals?: number }

/**
 * A renderer that went away (the window's own, or a preview's) or another of
 * Electron's processes: its reason and exit code, and a few counts that hold
 * no content. Nothing of the process's memory: no minidump (processWatch.ts).
 * Never throws.
 */
function reportGone(surface: Exclude<ErrorSurface, 'main'>, details: GoneDetails, counts: GoneCounts = {}): void {
  try {
    const reason = safeReason(details.reason);
    const props: Omit<AppErrorProps, 'surface' | 'error_name' | 'where'> = { reason };
    const exitCode = typeof details.exitCode === 'number' && Number.isInteger(details.exitCode) ? details.exitCode : undefined;
    if (exitCode !== undefined) props.exit_code = exitCode;
    const type = safeProcessType(details.processType);
    if (type) props.process_type = type;
    for (const [key, value] of [['memory_mb', counts.memoryMb], ['uptime_min', counts.uptimeMin], ['webviews', counts.webviews], ['terminals', counts.terminals]] as const) {
      const n = safeCount(value);
      if (n !== undefined) props[key] = n;
    }
    const name = `${surface === 'process' ? 'child' : 'render'}-process-gone/${reason}`;
    emit(surface, { name, where: null, message: read(() => JSON.stringify({ ...details, ...counts }), ''), stack: '' }, props);
  } catch {}
}

export { init, report, reportWindow, reportGone, writeUnlogged };
