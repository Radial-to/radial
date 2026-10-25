// `radial agent wait` and Home's activity list read the daemon's lastBellAt. Claude
// Code ends its animated title (OSC 0) and its links (OSC 8) with BEL; those are
// not bells (found while migrating a real site).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bellScanner } from '../src/main/termBell';

test('a bare BEL rings; the BEL that ends a title or a link does not', () => {
  const ring = bellScanner();
  assert.equal(ring('\x1b]0;◐ Acme.com Webflow to Astro migration\x07'), false);
  assert.equal(ring('Running 1 shell command…\x1b]8;id=a;https://code.claude.com/docs\x07docs\x1b]8;;\x07'), false);
  assert.equal(ring('plain output with no escapes'), false);
  assert.equal(ring('turn done\x07'), true);
  assert.equal(ring('\x1b]0;✳ Claude Code\x07\x07'), true, 'a bell right after a title still rings');
  assert.equal(ring('\x1b[31mred\x1b[0m\x07'), true, 'colour codes are not strings');
});

test('strings split across chunks, ended by ST, or never ended', () => {
  const ring = bellScanner();
  assert.equal(ring('\x1b]0;half a ti'), false);
  assert.equal(ring('tle\x07'), false, 'the title ends in the next chunk');
  assert.equal(ring('\x1b'), false);
  assert.equal(ring(']8;;https://a.com\x07'), false, 'even the ESC can arrive alone');
  assert.equal(ring('\x1b]0;title\x1b\\\x07'), true, 'ESC \\ ends the string; the BEL after it is real');
  assert.equal(ring('\x1bP+q544e\x1b\\'), false, 'device control strings too');
  const stuck = bellScanner();
  assert.equal(stuck('\x1b]0;' + 'x'.repeat(9000)), false);
  assert.equal(stuck('\x07'), true, 'an unterminated string stops hiding bells');
});
