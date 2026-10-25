import { test } from 'node:test';
import assert from 'node:assert';
import * as nav from '../src/renderer/navigation';

test('route matching ignores trailing slashes but preserves origin boundaries', () => {
  assert.equal(nav.routeFromUrl('http://127.0.0.1:3000/work/', 'http://127.0.0.1:3000/'), '/work');
  assert.equal(nav.routeFromUrl('http://127.0.0.1:3001/work', 'http://127.0.0.1:3000/'), null);
});

test('a pending navigation rejects a late event for an older route', () => {
  const pending = { id: 'nav-b', target: '/pricing' };
  assert.equal(nav.acceptsCommit(pending, '/about', null), false);
  assert.equal(nav.acceptsCommit(pending, '/pricing/', 'nav-b'), true);
  assert.equal(nav.acceptsCommit(pending, '/pricing', 'nav-a'), false);
});
