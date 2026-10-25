import { test } from 'node:test';
import assert from 'node:assert';
import { decodeOsc52 } from '../src/renderer/osc52';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

test('decodes a normal "c;<base64>" payload', () => {
  assert.strictEqual(decodeOsc52('c;' + b64('hello world')), 'hello world');
});

test('round-trips non-ASCII (emoji + accents) without corruption', () => {
  const s = 'café — 🚀 déjà';
  assert.strictEqual(decodeOsc52('c;' + b64(s)), s);
});

test('handles primary/clipboard selection prefixes (p;, c;, empty;)', () => {
  assert.strictEqual(decodeOsc52('p;' + b64('x')), 'x');
  assert.strictEqual(decodeOsc52(';' + b64('y')), 'y');
});

test('ignores read/query payload ("?") — write-only, no exfiltration', () => {
  assert.strictEqual(decodeOsc52('c;?'), null);
});

test('ignores oversize payloads (>1MiB base64)', () => {
  const huge = 'c;' + 'A'.repeat((1 << 20) + 1);
  assert.strictEqual(decodeOsc52(huge), null);
});

test('returns null (never throws) on malformed/missing payload', () => {
  assert.strictEqual(decodeOsc52('c;@@not base64@@'), null);
  assert.strictEqual(decodeOsc52('c'), null);
  assert.strictEqual(decodeOsc52(''), null);
});
