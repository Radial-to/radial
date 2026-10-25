// The window's uncaught errors and unhandled rejections, as the report main
// names, locates and sends (src/main/errorReport.ts). index.html loads this
// file before every other script and it starts listening right away, so even a
// script that fails as it loads is heard.
// What was thrown or rejected isn't always an Error, and some of the browser's
// own error events carry none at all. Each of those says what it was (a
// rejected string or undefined, a thrown object, a ResizeObserver loop, a
// cross-origin script) instead of arriving as a nameless "Error" with no place
// in the code. Main decides what of it may leave (errorAllowlist.ts).
// Reading what was thrown never throws here: it may be anything (a revoked
// Proxy, a getter that throws), and the window's own error listener must not.
import type { WindowErrorReport, WindowErrorSurface } from '../shared/radialApi';

/** What an error event looks like to the listener: an ErrorEvent, or (dispatched on window itself) a plain Event. */
export interface ErrorEventLike { error?: unknown; message?: unknown; filename?: unknown; lineno?: unknown; colno?: unknown }

/** A read that may throw (a getter, a Proxy's trap): its value, or the fallback. */
function read<T>(get: () => T, fallback: T): T {
  try { return get(); } catch { return fallback; }
}
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** What was thrown or rejected, when it isn't an Error: its type, or the class of an object (an Event's, say). */
export function valueTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object' && typeof value !== 'function') return typeof value; // string, undefined, number, boolean, bigint, symbol
  const name = read(() => (value as { constructor?: { name?: unknown } }).constructor?.name, undefined);
  return typeof name === 'string' && /^[A-Za-z][\w$]{0,39}$/.test(name) && name !== 'Object' ? name : 'object';
}

/** An Error, or close enough to read one off: anything with a stack. */
function errorLike(value: unknown): value is { name?: unknown; message?: unknown; stack?: unknown } {
  return read(() => !!value && typeof value === 'object' && (value instanceof Error || typeof (value as { stack?: unknown }).stack === 'string'), false);
}
/** An Error's name, message and stack, each read on its own. */
function fields(error: { name?: unknown; message?: unknown; stack?: unknown }): Pick<WindowErrorReport, 'name' | 'message' | 'stack'> {
  return { name: text(read(() => error.name, undefined)), message: text(read(() => error.message, undefined)), stack: text(read(() => error.stack, undefined)) };
}

/** The report for one of the window's error events: the error it carries, or why it carries none. */
export function fromErrorEvent(e: ErrorEventLike, surface: WindowErrorSurface = 'renderer'): WindowErrorReport {
  try {
    const error = read(() => e.error, undefined);
    const message = text(read(() => e.message, undefined));
    if (errorLike(error)) return { surface, via: 'error', ...fields(error) };
    if (error !== undefined && error !== null) return { surface, via: 'error', valueType: valueTypeOf(error), message };
    // No error object: one the browser sends itself, or a thrown undefined or null.
    if (message !== undefined && /^ResizeObserver loop /.test(message)) return { surface, via: 'error', kind: 'resize-observer-loop', message };
    if (message === 'Script error.') return { surface, via: 'error', kind: 'cross-origin-script', message };
    const thrown = message === undefined ? null : /^Uncaught (undefined|null)$/.exec(message); // `throw undefined` and `throw null` leave the event's error empty
    if (thrown) return { surface, via: 'error', valueType: thrown[1], message };
    return { surface, via: 'error', kind: 'error-event', message, filename: text(read(() => e.filename, undefined)), lineno: count(read(() => e.lineno, undefined)), colno: count(read(() => e.colno, undefined)) };
  } catch {
    return { surface, via: 'error', valueType: 'object' };
  }
}

/** The report for a rejected promise nobody handled. */
export function fromRejection(reason: unknown, surface: WindowErrorSurface = 'renderer'): WindowErrorReport {
  try {
    if (errorLike(reason)) return { surface, via: 'rejection', ...fields(reason) };
    return { surface, via: 'rejection', valueType: valueTypeOf(reason), message: text(reason) };
  } catch {
    return { surface, via: 'rejection', valueType: 'object' };
  }
}

/** A window with the preload's API, as far as this file uses it. */
type ReportingWindow = Pick<Window, 'addEventListener'> & { radial?: { reportError?(report: WindowErrorReport): void } };

/** Listens for a window's uncaught errors and unhandled rejections, and reports each through the preload's reportError. */
export function install(win: ReportingWindow): void {
  // The report is built inside the try too: nothing the page throws can make this listener throw.
  const send = (build: () => WindowErrorReport) => { try { win.radial?.reportError?.(build()); } catch {} };
  win.addEventListener('error', (e) => send(() => fromErrorEvent(e as ErrorEventLike)));
  win.addEventListener('unhandledrejection', (e) => send(() => fromRejection(read(() => (e as PromiseRejectionEvent).reason, undefined))));
}

// In the window (not in Node, where the tests load it), it listens from here on.
if (typeof window !== 'undefined' && typeof document !== 'undefined') install(window as unknown as ReportingWindow);
