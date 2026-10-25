// Main's paste into an agent CLI's terminal (src/main/enginePaste.ts): never
// into a question of the CLI's own, the chat's input gate asked again right
// before each write, and a look that fails leaving the window to decide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enginePaster } from '../src/main/enginePaste';
import type { EnginePasteHost } from '../src/main/enginePaste';

/** A host whose answers a test sets as it goes, and what reached the pty. */
function host(over: Partial<EnginePasteHost> = {}) {
  const state = { accepts: true, asking: false as boolean | null, writes: [] as string[], records: [] as string[], looks: [] as string[] };
  const h: EnginePasteHost = {
    accepts: () => state.accepts,
    asking: async (_id, typed) => { state.looks.push(typed); return state.asking; },
    record: (_id, text) => { state.records.push(text); },
    write: (_id, data) => { state.writes.push(data); },
    pasteSequence: (text) => `\x1b[200~${text}\x1b[201~`,
    ...over,
  };
  return { h, state };
}

test('main\'s paste goes in, then its Enter a beat later, each after a look that leaves the pasted text out', async () => {
  const { h, state } = host();
  await enginePaster(h, 5)('pty1', 'Make the Sign in button blue', true);
  assert.deepEqual(state.writes, ['\x1b[200~Make the Sign in button blue\x1b[201~', '\r']);
  assert.deepEqual(state.looks, ['Make the Sign in button blue', 'Make the Sign in button blue'], 'its own words are no question');
  assert.deepEqual(state.records, ['Make the Sign in button blue']);
  const staged = host();
  await enginePaster(staged.h, 5)('pty1', 'Stage it', false);
  assert.deepEqual(staged.state.writes, ['\x1b[200~Stage it\x1b[201~'], 'no Enter when not asked');
});

test('main\'s paste types nothing into a question of the CLI\'s own, and no Enter into one that comes up after the paste', async () => {
  const asking = host();
  asking.state.asking = true;
  await enginePaster(asking.h, 5)('pty1', 'Fix the hero', true);
  assert.deepEqual(asking.state.writes, []);
  const later = host();
  const paste = enginePaster(later.h, 30)('pty1', 'Fix the hero', true);
  await new Promise((r) => setTimeout(r, 10));
  later.state.asking = true; // a permission prompt comes up between the paste and its Enter
  await paste;
  assert.deepEqual(later.state.writes, ['\x1b[200~Fix the hero\x1b[201~']);
});

test('main\'s paste asks the chat\'s input gate again right before each write', async () => {
  // The gate closes while the look for a question takes its moment: nothing goes in.
  const { h, state } = host();
  h.asking = async () => { state.accepts = false; return false; };
  await enginePaster(h, 5)('pty1', 'Fix the hero', true);
  assert.deepEqual(state.writes, []);
  // It closes between the paste and its Enter: no Enter.
  const second = host();
  let looks = 0;
  second.h.asking = async () => { if (++looks === 2) second.state.accepts = false; return false; };
  await enginePaster(second.h, 5)('pty1', 'Fix the hero', true);
  assert.deepEqual(second.state.writes, ['\x1b[200~Fix the hero\x1b[201~']);
  const closed = host();
  closed.state.accepts = false;
  await enginePaster(closed.h, 5)('pty1', 'Fix the hero', true);
  assert.deepEqual(closed.state.writes, []);
});

test('a look that fails can\'t say: the window\'s own check decided, and no rejection escapes', async () => {
  const { h, state } = host({ asking: async () => { throw new Error('the terminal service went away'); } });
  await enginePaster(h, 5)('pty1', 'Fix the hero', true);
  assert.deepEqual(state.writes, ['\x1b[200~Fix the hero\x1b[201~', '\r']);
  const unknown = host();
  unknown.state.asking = null; // an older terminal service, which can't give its screen
  await enginePaster(unknown.h, 5)('pty1', 'Fix the hero', false);
  assert.deepEqual(unknown.state.writes, ['\x1b[200~Fix the hero\x1b[201~']);
});
