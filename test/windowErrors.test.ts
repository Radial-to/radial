// The window's uncaught errors and unhandled rejections (src/renderer/windowErrors.ts):
// each report says what was thrown or rejected, or why a browser error event
// carries no error at all, instead of a nameless "Error". In 0.38.1 a rejected
// string or undefined, a thrown object, a ResizeObserver loop and a script
// from another origin all arrived as "Error" (or "UnhandledRejection") with no
// place in the code. Reading what was thrown never throws in the window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fromErrorEvent, fromRejection, install, valueTypeOf } from '../src/renderer/windowErrors';
import type { WindowErrorReport } from '../src/shared/radialApi';

test('an error event that carries an Error sends its name, message and stack', () => {
  const error = new TypeError("Cannot set properties of null (setting 'innerHTML')");
  assert.deepEqual(fromErrorEvent({ error, message: `Uncaught ${error.message}` }), { surface: 'renderer', via: 'error', name: 'TypeError', message: error.message, stack: error.stack });
});

test('one with no error object says why: a ResizeObserver loop, a script from another origin, or neither', () => {
  assert.deepEqual(fromErrorEvent({ error: null, message: 'ResizeObserver loop completed with undelivered notifications.' }), { surface: 'renderer', via: 'error', kind: 'resize-observer-loop', message: 'ResizeObserver loop completed with undelivered notifications.' });
  assert.equal(fromErrorEvent({ error: null, message: 'ResizeObserver loop limit exceeded' }).kind, 'resize-observer-loop', 'the older wording');
  assert.equal(fromErrorEvent({ error: null, message: 'Script error.', filename: '', lineno: 0 }).kind, 'cross-origin-script');
  // An element's failed load never reaches the window's own listener (it doesn't bubble), so a plain Event there is one more error-event.
  assert.deepEqual(fromErrorEvent({}), { surface: 'renderer', via: 'error', kind: 'error-event', message: undefined, filename: undefined, lineno: undefined, colno: undefined });
  assert.deepEqual(fromErrorEvent({ error: undefined, message: 'Uncaught oops', filename: 'file:///app/out/renderer/renderer.js', lineno: 12, colno: 3 }), { surface: 'renderer', via: 'error', kind: 'error-event', message: 'Uncaught oops', filename: 'file:///app/out/renderer/renderer.js', lineno: 12, colno: 3 });
});

test('a thrown value that isn\'t an Error says its type', () => {
  assert.deepEqual(fromErrorEvent({ error: 'boom', message: 'Uncaught boom' }), { surface: 'renderer', via: 'error', valueType: 'string', message: 'Uncaught boom' });
  assert.equal(fromErrorEvent({ error: { code: 1 }, message: 'Uncaught [object Object]' }).valueType, 'object');
  assert.equal(fromErrorEvent({ error: undefined, message: 'Uncaught undefined' }).valueType, 'undefined', 'throw undefined leaves the event\'s error empty');
  assert.equal(fromErrorEvent({ error: null, message: 'Uncaught null' }).valueType, 'null');
});

test('a rejection says what it rejected with', () => {
  const error = new Error("Error invoking remote method 'term:start': Error: no daemon");
  assert.deepEqual(fromRejection(error), { surface: 'renderer', via: 'rejection', name: 'Error', message: error.message, stack: error.stack });
  assert.deepEqual(fromRejection('timed out'), { surface: 'renderer', via: 'rejection', valueType: 'string', message: 'timed out' });
  assert.deepEqual(fromRejection(undefined), { surface: 'renderer', via: 'rejection', valueType: 'undefined', message: undefined });
  class CloseEvent { code = 1006; }
  assert.equal(fromRejection(new CloseEvent()).valueType, 'CloseEvent', 'an Event names its class');
  assert.equal(fromRejection({ stack: 'Error: x\n    at y (file:///a.js:1:1)', message: 'x' }).name, undefined, 'something with a stack counts as an Error, nameless or not');
});

test('valueTypeOf: primitives by type, objects by class, a plain object as object', () => {
  assert.deepEqual([valueTypeOf(null), valueTypeOf(undefined), valueTypeOf(1), valueTypeOf(true), valueTypeOf(1n), valueTypeOf(Symbol('x')), valueTypeOf({}), valueTypeOf(Object.create(null)), valueTypeOf(new Map())], ['null', 'undefined', 'number', 'boolean', 'bigint', 'symbol', 'object', 'object', 'Map']);
});

test('reading what was thrown never throws: a revoked proxy, a proxy whose get throws, an Error whose stack getter throws, an object whose constructor getter throws', () => {
  const { proxy: revoked, revoke } = Proxy.revocable({}, {}); revoke();
  const values: unknown[] = [
    new Proxy({}, { get() { throw new Error('trap'); } }),
    revoked,
    Object.defineProperty(new Error('x'), 'stack', { get() { throw new Error('stack getter'); } }),
    Object.defineProperty({}, 'constructor', { get() { throw new Error('ctor'); } }),
  ];
  for (const value of values) {
    const a = fromRejection(value), b = fromErrorEvent({ error: value, message: 'Uncaught x' });
    for (const r of [a, b]) assert.equal(typeof r.surface, 'string');
    assert.doesNotThrow(() => fromErrorEvent(new Proxy({}, { get() { throw new Error('event trap'); } }) as never));
  }
  const listeners: Record<string, (e: unknown) => void> = {};
  const sent: WindowErrorReport[] = [];
  install({ addEventListener: ((type: string, fn: (e: unknown) => void) => { listeners[type] = fn; }) as Window['addEventListener'], radial: { reportError: (r) => sent.push(r) } });
  assert.doesNotThrow(() => listeners.error(new Proxy({}, { get() { throw new Error('event trap'); } })));
  assert.doesNotThrow(() => listeners.unhandledrejection({ get reason() { throw new Error('reason getter'); } }));
  assert.equal(sent.length, 2, 'each still reports, as what could be read');
});

test('installed on a window, it reports both kinds through the preload', () => {
  const listeners: Record<string, (e: unknown) => void> = {};
  const sent: WindowErrorReport[] = [];
  install({ addEventListener: ((type: string, fn: (e: unknown) => void) => { listeners[type] = fn; }) as Window['addEventListener'], radial: { reportError: (r) => sent.push(r) } });
  listeners.error({ error: null, message: 'Script error.' });
  listeners.unhandledrejection({ reason: undefined });
  assert.deepEqual(sent.map((r) => r.kind || r.valueType), ['cross-origin-script', 'undefined']);
  const broken = { addEventListener: ((type: string, fn: (e: unknown) => void) => { listeners[type] = fn; }) as Window['addEventListener'], radial: { reportError: () => { throw new Error('gone'); } } };
  install(broken);
  assert.doesNotThrow(() => listeners.error({ error: new Error('x') }), 'a report that can\'t go never throws in the window');
});

test('the window loads it before every other script, so a script that fails as it loads is heard', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(scripts[0], 'windowErrors.js');
});
