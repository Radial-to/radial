import { test } from 'node:test';
import assert from 'node:assert';

import * as fuzzy from '../src/renderer/fuzzy';

test('substring beats subsequence; word-start beats mid-word', () => {
  const items = ['summit-site', 'sun-umami-trek', 'the-summit-of-truth'];
  const out = fuzzy.filter('summit', items);
  assert.equal(out[0], 'summit-site'); // word-start substring, shortest
  assert.ok(out.includes('the-summit-of-truth'));
});

test('tokens match in any order across label and path', () => {
  const items = [
    { label: 'Open project: summit-site', keywords: '/Users/you/Radial/summit-co__summit-site' },
    { label: 'Open project: landing', keywords: '/Users/you/Radial/northwind__landing' },
  ];
  const key = (c: (typeof items)[number]) => `${c.label} ${c.keywords}`;
  assert.equal(fuzzy.filter('site summit', items, key)[0].label, 'Open project: summit-site');
  assert.equal(fuzzy.filter('northwind landing', items, key)[0].label, 'Open project: landing');
  // owner-only queries hit via keywords (the path), not the label
  assert.equal(fuzzy.filter('summit-co', items, key).length, 1);
});

test('subsequence matching finds abbreviations but every token must land', () => {
  assert.ok(fuzzy.score('msite', 'summit-site') > 0);
  assert.equal(fuzzy.score('zebra', 'summit-site'), -1);
  assert.equal(fuzzy.filter('nomatch', ['a', 'b']).length, 0);
});

test('empty query returns everything in original order', () => {
  assert.deepEqual(fuzzy.filter('', ['b', 'a']), ['b', 'a']);
  assert.deepEqual(fuzzy.filter('  ', ['b', 'a']), ['b', 'a']);
});

test('earlier and shorter candidates win ties', () => {
  const out = fuzzy.filter('pricing', ['site-pricing-archive-page', 'pricing']);
  assert.equal(out[0], 'pricing');
});

test('recency bonus lifts the recently-worked project among near-identical names', () => {
  const now = Date.now();
  const items = [
    { label: 'harbor-marketing-site', when: now - 30 * 24 * 3.6e6 }, // a month ago
    { label: 'harbor-site-v2', when: now - 40 * 24 * 3.6e6 },
    { label: 'harbor', when: now - 20 * 60 * 1000 }, // 20 minutes ago
    { label: 'harbor-legacy', when: 0 },
  ];
  const out = fuzzy.filter('harbor', items, (c) => c.label, (c) => fuzzy.recencyBonus(c.when));
  assert.equal(out[0].label, 'harbor'); // exact + fresh
  // the stale-but-matching ones still appear, just below
  assert.equal(out.length, 4);
});

test('recencyBonus decays with age and tolerates missing timestamps', () => {
  const now = Date.now();
  assert.ok(fuzzy.recencyBonus(now - 60_000) > fuzzy.recencyBonus(now - 2 * 24 * 3.6e6));
  assert.equal(fuzzy.recencyBonus(0), 0);
  assert.equal(fuzzy.recencyBonus(undefined), 0);
});
