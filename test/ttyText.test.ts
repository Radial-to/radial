// ttyText: the agent-output renderer. A TUI's redraws collapse to what the
// screen showed; the strip fallback never garbles plain output.

import { test } from 'node:test';
import assert from 'node:assert';
import * as tty from '../src/main/ttyText';

test('the emulator is available and renders colors, CR/LF and redraws to the screen text', async () => {
  assert.equal(tty.hasEmulator(), true, '@xterm/headless is installed');
  assert.equal(await tty.render('\x1b[31mhello\x1b[0m\r\nworld\r\n', { cols: 40, rows: 10 }), 'hello\nworld');
  // An Ink-style redraw: move up one line, clear it, write the final state.
  assert.equal(await tty.render('Thinking…\r\n\x1b[1A\x1b[2KDone ✓\r\n', { cols: 40, rows: 10 }), 'Done ✓');
  // A line the pty wrapped comes back as one line.
  const long = 'x'.repeat(70);
  assert.equal(await tty.render(long + '\r\n', { cols: 40, rows: 10 }), long);
  // Scrollback beyond the rows is kept in order.
  const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n') + '\r\n';
  const out = await tty.render(many, { cols: 40, rows: 5 });
  assert.ok(out.startsWith('line 0\n') && out.endsWith('line 29'), out);
  assert.equal(await tty.render('', { cols: 40, rows: 5 }), '');
  // A TUI's spacer rows collapse to one blank line.
  assert.equal(await tty.render('top\r\n\r\n\r\n\r\n\r\nprompt ❯\r\n', { cols: 40, rows: 10 }), 'top\n\nprompt ❯');
});

test('strip removes CSI/OSC sequences, keeps the last rewrite of a CR line, trims blank edges', () => {
  assert.equal(tty.strip('\x1b]0;title\x07\x1b[32m$ \x1b[0mls\r\nfoo\r\n\r\n'), '$ ls\nfoo');
  assert.equal(tty.strip('spinner 1\rspinner 2\rfinal'), 'final');
  assert.equal(tty.strip('\x1b[?25l\x1b[2K\x1b[Gprompt ❯ '), 'prompt ❯');
});

test('lastLines keeps the tail', () => {
  assert.equal(tty.lastLines('a\nb\nc', 2), 'b\nc');
  assert.equal(tty.lastLines('a\nb\nc', 0), 'a\nb\nc');
});

test('screen reads a pty as the window reads its xterm: the rows on screen now, the rows above them, and the last 60 rows run together', async () => {
  // Scrolled: thirty lines on a five-row screen show the last five.
  const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n');
  const v = await tty.screen(many, { cols: 40, rows: 5 });
  assert.equal(v.screen, 'line 25\nline 26\nline 27\nline 28\nline 29');
  assert.deepEqual(v.above, Array.from({ length: 25 }, (_, i) => `line ${i}`), 'and the rows above it, oldest first');
  const full = await tty.screen(many + '\x1b[?1049h\x1b[H Trust this folder?', { cols: 40, rows: 5 });
  assert.deepEqual([full.screen.split('\n')[0], full.above], [' Trust this folder?', []], 'a full-screen CLI has none above its screen');
  assert.equal(v.recent, Array.from({ length: 30 }, (_, i) => `line ${i}`).join(''), 'every row there is, fewer than 60');
  // A question the TUI drew over its boot screen is what the screen shows, blank rows included.
  const asked = await tty.screen('Loading…\x1b[2J\x1b[H Do you trust the files in this folder?\r\n ❯ 1. Yes, proceed\r\n', { cols: 40, rows: 6 });
  assert.equal(asked.screen, ' Do you trust the files in this folder?\n ❯ 1. Yes, proceed\n\n\n\n');
  // A paste the pty wrapped reads whole once whitespace goes.
  const wrapped = await tty.screen('❯ Make the pricing table two columns, and tighten the hero copy', { cols: 24, rows: 6 });
  assert.ok(wrapped.recent.replace(/\s+/g, '').includes('Makethepricingtabletwocolumns,andtightenthehero'), wrapped.recent);
  assert.deepEqual(await tty.screen('', { cols: 40, rows: 4 }), { screen: '\n\n\n', above: [], recent: '' });
});
