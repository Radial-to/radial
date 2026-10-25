import { test } from 'node:test';
import assert from 'node:assert';
import { relayOpen } from '../src/main/openRelay';
import type { OpenMessage, RelayClient } from '../src/main/openRelay';

// Build a fake client + a recording sendTo so we can assert the ack contract.
// `clients` is unused: no test passes it and the body never reads it.
function harness(clients?: Iterable<RelayClient>) {
  const sent: { c: RelayClient; msg: OpenMessage }[] = [];
  const sendTo = (c: RelayClient, msg: OpenMessage) => sent.push({ c, msg });
  return { sent, sendTo };
}

test('delivers to an app subscriber and reports delivered>0 (ack ok)', () => {
  const shim = { isApp: false };
  const app = { isApp: true };
  const { sent, sendTo } = harness();
  const n = relayOpen([app, shim], shim, { termId: 't1', repoDir: '/r', url: 'http://localhost:3000/' }, sendTo);
  assert.strictEqual(n, 1);
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].msg, { op: 'open', termId: 't1', repoDir: '/r', url: 'http://localhost:3000/' });
  assert.strictEqual(sent[0].c, app);
});

test('no app subscriber → delivered 0 (ack nack → shim exits 1, no false success)', () => {
  const shim = { isApp: false };
  const { sent, sendTo } = harness();
  const n = relayOpen([shim], shim, { termId: 't1', repoDir: null, url: 'http://x/' }, sendTo);
  assert.strictEqual(n, 0);
  assert.strictEqual(sent.length, 0);
});

test('never delivers back to the sender even if the sender is an app', () => {
  const sender = { isApp: true };
  const { sent, sendTo } = harness();
  const n = relayOpen([sender], sender, { termId: 't', repoDir: null, url: 'http://x/' }, sendTo);
  assert.strictEqual(n, 0);
});

test('delivers to every app subscriber (multi-window), skips non-app clients', () => {
  const shim = { isApp: false };
  const app1 = { isApp: true };
  const app2 = { isApp: true };
  const other = { isApp: false };
  const { sent, sendTo } = harness();
  const n = relayOpen([app1, other, app2, shim], shim, { termId: 't', repoDir: '/r', url: 'http://x/' }, sendTo);
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(sent.map((s) => s.c), [app1, app2]);
});
