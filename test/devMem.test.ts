import { test } from 'node:test';
import assert from 'node:assert';
import { sumTreeRss } from '../src/main/devServer';

// ps -axo pid=,ppid=,rss= style rows. Tree: 100 → 101 → 102; 200 alone;
// 300 is unrelated noise.
const PS = `
  100     1  1024
  101   100  2048
  102   101  4096
  200     1  8192
  300     1   512
`;

test('sumTreeRss walks whole descendant trees per root (KB → MB)', () => {
  const out = sumTreeRss(PS, [100, 200]);
  assert.equal(out.get(100), 7);  // (1024+2048+4096)/1024
  assert.equal(out.get(200), 8);
});

test('sumTreeRss: a dead root reads as 0, cycles cannot loop it', () => {
  const cyc = '  10  20  1024\n  20  10  1024\n';
  const out = sumTreeRss(cyc, [10, 999]);
  assert.equal(out.get(10), 2);   // both, once each, despite the parent cycle
  assert.equal(out.get(999), 0);
});

test('sumTreeRss shrugs at garbage input', () => {
  assert.equal(sumTreeRss('not ps output at all', [1]).get(1), 0);
  assert.equal(sumTreeRss('', []).size, 0);
});
