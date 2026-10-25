// The reap decision decides whether we KILL OS processes, so it gets a test.
// groupHasDevMember is the pure core: given a `ps` snapshot and a pgid, is a
// living member of that group one of our dev servers?
import { test } from 'node:test';
import assert from 'node:assert';
import * as devServer from '../src/main/devServer';

const LISTING = [
  '100 5000 next-server (v15.5.15)',
  '101 5000 node /proj/node_modules/.bin/astro dev',
  '200  200 vim notes.txt',
  '300  300 /Applications/Spotify.app/Contents/MacOS/Spotify',
].join('\n');

test('reaps when a living member of the group is a dev server', () => {
  assert.equal(devServer.groupHasDevMember(5000, LISTING), true);
});

test('does not reap a group with no living members (orphan leader already gone)', () => {
  assert.equal(devServer.groupHasDevMember(9999, LISTING), false);
});

test('reuse-safe: pgid matches but the command is not a dev server', () => {
  assert.equal(devServer.groupHasDevMember(200, LISTING), false); // vim
});

test('null / empty inputs never reap', () => {
  assert.equal(devServer.groupHasDevMember(0, LISTING), false);
  assert.equal(devServer.groupHasDevMember(5000, ''), false);
  assert.equal(devServer.groupHasDevMember(5000, null), false);
});

test('reapGroups([]) and reapGroup(null) are no-ops (no throw)', () => {
  assert.doesNotThrow(() => devServer.reapGroups([]));
  assert.doesNotThrow(() => devServer.reapGroup(null));
});
