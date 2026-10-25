import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, isManual } from '../src/renderer/taskTitle';

test('task titles remove conversational openings and keep the actual request', () => {
  assert.equal(summarize('Can you please fix the login button? It is broken on mobile.'), 'Fix the login button');
  assert.equal(summarize('Please add dark mode to the settings page'), 'Add dark mode to the settings');
  assert.equal(summarize('Fix sidebar spacing'), 'Fix sidebar spacing');
});
test('selection context and image paths do not become task titles', () => {
  assert.equal(summarize('The user selected 1 element:\n<div>Hero</div>\n\nFind this in the source and act on the request below.\n\nMake the heading smaller\n\nReference image (read for visual context): /tmp/image.png'), 'Make the heading smaller');
});
test('brief acknowledgements and CLI commands preserve the existing title', () => {
  for (const prompt of ['yes', 'continue', 'go ahead', 'thanks!', '/model', '', '  ']) assert.equal(summarize(prompt), '');
});
test('titles stay bounded without cutting ordinary words or adding ellipses', () => {
  const title = summarize('Review the complete navigation and responsive layout across all marketing pages');
  assert.equal(title, 'Review the complete navigation');
  assert.ok(Array.from(summarize('長'.repeat(60))).length <= 32);
  assert.equal(title.includes('…'), false);
});
test('manual-title provenance survives reattachment and legacy model names remain automatic', () => {
  for (const label of ['Claude Code', 'Claude Code 2', 'Codex', 'Cursor 3', 'Shell']) assert.equal(isManual({ label }), false);
  assert.equal(isManual({ label: 'My custom name' }), true);
  assert.equal(isManual({ label: 'Fix login', labelSource: 'auto' }), false);
  assert.equal(isManual({ label: 'Codex', labelSource: 'manual' }), true);
});
