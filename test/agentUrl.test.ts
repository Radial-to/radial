import { test } from 'node:test';
import assert from 'node:assert';
import { classifyUrl } from '../src/renderer/agentUrl';

const BASE = 'http://127.0.0.1:5173/';

test('same dev origin → webview', () => {
  assert.strictEqual(classifyUrl('http://127.0.0.1:5173/about', BASE), 'webview');
});

test('localhost vs 127.0.0.1 on the same port → webview (loopback equivalence)', () => {
  assert.strictEqual(classifyUrl('http://localhost:5173/', BASE), 'webview');
});

test('different loopback port → external (a different server)', () => {
  assert.strictEqual(classifyUrl('http://localhost:3000/', BASE), 'external');
});

test('foreign https → external', () => {
  assert.strictEqual(classifyUrl('https://anthropic.com/login', BASE), 'external');
});

test('non-http(s) (file://) → blocked, never webview', () => {
  assert.strictEqual(classifyUrl('file:///etc/passwd', BASE), 'blocked');
});

test('malformed url → blocked (never throws, never webview)', () => {
  assert.strictEqual(classifyUrl('not a url', BASE), 'blocked');
  assert.strictEqual(classifyUrl('', BASE), 'blocked');
});

test('no baseUrl → external for http(s), blocked for junk', () => {
  assert.strictEqual(classifyUrl('http://localhost:5173/', null), 'external');
  assert.strictEqual(classifyUrl('javascript:alert(1)', null), 'blocked');
});
