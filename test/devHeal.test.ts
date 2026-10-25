import { test } from 'node:test';
import assert from 'node:assert';

import * as devHeal from './../src/main/devHeal';
import type { HealAction, HealInput, HealSession } from './../src/main/devHeal';

const T0 = 1_000_000_000_000;
const handle = (): HealInput['deadHandle'] => ({ url: 'http://127.0.0.1:50000/' });

test('an unexpected exit of the current server restarts it', () => {
  const h = handle();
  const r = devHeal.decide({ session: { handle: h }, deadHandle: h, now: T0 });
  assert.equal(r.action, 'restart');
  assert.deepEqual(r.heals, [T0]);
});

test('a handle whose stop() was called is a deliberate stop — ignored', () => {
  const h = handle();
  h.stopped = true;
  const r = devHeal.decide({ session: { handle: h }, deadHandle: h, now: T0 });
  assert.equal(r.action, 'ignore');
});

test('a closed project, a replaced server, and a suspended session are all ignored', () => {
  const h = handle();
  assert.equal(devHeal.decide({ session: undefined, deadHandle: h, now: T0 }).action, 'ignore');
  assert.equal(devHeal.decide({ session: { handle: handle() }, deadHandle: h, now: T0 }).action, 'ignore');
  assert.equal(devHeal.decide({ session: { handle: h, suspended: true }, deadHandle: h, now: T0 }).action, 'ignore');
});

test('crash-looping gives up after MAX_RESTARTS inside the window', () => {
  const session: HealSession = { heals: [] };
  let verdicts: HealAction[] = [];
  for (let i = 0; i <= devHeal.MAX_RESTARTS; i++) {
    const h = handle();
    session.handle = h; // each restart installs a fresh handle
    const r = devHeal.decide({ session, deadHandle: h, now: T0 + i * 1000 });
    session.heals = r.heals;
    verdicts.push(r.action);
  }
  assert.deepEqual(verdicts, ['restart', 'restart', 'restart', 'give-up']);
});

test('old crashes age out of the window — a later crash restarts again', () => {
  const h = handle();
  const session = { handle: h, heals: [T0, T0 + 1000, T0 + 2000] };
  const r = devHeal.decide({ session, deadHandle: h, now: T0 + devHeal.WINDOW_MS + 3000 });
  assert.equal(r.action, 'restart');
  assert.deepEqual(r.heals, [T0 + devHeal.WINDOW_MS + 3000]);
});
