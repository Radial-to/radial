// Unit tests for the pre-launch check engine. Run from platform/:
//   node --test test/launchCheck.test.js
//
// The checks are pure (facts in, findings out), so we build pages from HTML
// strings via extractPageFacts and assert on statuses. No live server needed.

import { test } from 'node:test';
import assert from 'node:assert';

import { extractPageFacts, runChecks, CHECKS } from '../src/main/launchCheck';
import type { LaunchCheckPage } from '../src/main/launchCheck';
import type { LaunchCheckItem, LaunchCheckReport } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

function page(route: string, html: string): LaunchCheckPage {
  return { route, label: route, facts: extractPageFacts(html) };
}
// Every id asked for is a check in the registry, so runChecks always has its result.
function byId(results: LaunchCheckItem[], id: string): LaunchCheckItem {
  return results.find((r) => r.id === id)!;
}

test('extractPageFacts pulls the tags each check needs', () => {
  const f = extractPageFacts(`
    <html><head>
      <title>  Home   Page </title>
      <meta name="description" content="A short summary.">
      <meta name="robots" content="INDEX, follow">
      <meta property="og:title" content="Home">
      <meta property="og:image" content="/og.png">
      <link rel="icon" href="/fav.ico">
    </head><body>
      <h1>Hi</h1><h2>Sub</h2>
      <img src="/a.png" alt="A logo">
      <img src="/b.png">
      <img src="/c.png" alt="" role="presentation">
      <a href="/about">About</a>
      <a href="https://example.com">External</a>
      <a href="mailto:x@y.com">Mail</a>
    </body></html>`);
  assert.equal(f.title, 'Home Page', 'title is collapsed + trimmed');
  assert.equal(f.description, 'A short summary.');
  assert.equal(f.robots, 'index, follow');
  assert.equal(f.hasOgTitle, true);
  assert.equal(f.hasOgImage, true);
  assert.equal(f.favicon, true);
  assert.deepEqual(f.headings, [1, 2]);
  assert.equal(f.images.length, 3);
  assert.equal(f.images[0].hasAlt, true);
  assert.equal(f.images[1].hasAlt, false, 'no alt attribute');
  assert.equal(f.images[1].decorative, false);
  assert.equal(f.images[2].decorative, true, 'empty alt + role=presentation is decorative');
  assert.deepEqual(f.links, ['/about'], 'only same-doc internal links, no external/mailto');
});

test('titles: passes when unique and short, fails on missing or duplicate', () => {
  const good = runChecks([
    page('/', '<title>Home</title>'),
    page('/about', '<title>About Us</title>'),
  ]);
  assert.equal(byId(good, 'titles').status, 'pass');

  const dup = runChecks([
    page('/', '<title>Same</title>'),
    page('/two', '<title>Same</title>'),
  ]);
  assert.equal(byId(dup, 'titles').status, 'fail', 'duplicate titles fail');

  const missing = runChecks([page('/', '<h1>no title tag</h1>')]);
  assert.equal(byId(missing, 'titles').status, 'fail');

  const long = runChecks([page('/', `<title>${'x'.repeat(80)}</title>`)]);
  assert.equal(byId(long, 'titles').status, 'warn', 'over-long title warns, not fails');
});

test('descriptions: warns on missing or over-long, never hard-fails', () => {
  const ok = runChecks([page('/', '<title>H</title><meta name="description" content="Fine.">')]);
  assert.equal(byId(ok, 'descriptions').status, 'pass');

  const none = runChecks([page('/', '<title>H</title>')]);
  assert.equal(byId(none, 'descriptions').status, 'warn');

  const long = runChecks([page('/', `<meta name="description" content="${'x'.repeat(200)}">`)]);
  assert.equal(byId(long, 'descriptions').status, 'warn');
});

test('alt: fails on a content image with no alt, exempts decorative, na when no images', () => {
  const missing = runChecks([page('/', '<img src="/x.png">')]);
  assert.equal(byId(missing, 'alt').status, 'fail');

  const decorative = runChecks([page('/', '<img src="/x.png" alt="" aria-hidden="true">')]);
  assert.equal(byId(decorative, 'alt').status, 'pass', 'decorative image is exempt');

  const none = runChecks([page('/', '<h1>text only</h1>')]);
  assert.equal(byId(none, 'alt').status, 'na');
});

test('headings: fails with no h1, warns on multiple h1 or a skipped level', () => {
  assert.equal(byId(runChecks([page('/', '<h2>no h1</h2>')]), 'headings').status, 'fail');
  assert.equal(byId(runChecks([page('/', '<h1>a</h1><h1>b</h1>')]), 'headings').status, 'warn');
  assert.equal(byId(runChecks([page('/', '<h1>a</h1><h3>skip</h3>')]), 'headings').status, 'warn');
  assert.equal(byId(runChecks([page('/', '<h1>a</h1><h2>b</h2><h3>c</h3>')]), 'headings').status, 'pass');
});

test('favicon + social: warn when absent', () => {
  const bare = runChecks([page('/', '<title>H</title>')]);
  assert.equal(byId(bare, 'favicon').status, 'warn');
  assert.equal(byId(bare, 'social').status, 'warn');

  const set = runChecks([page('/', '<link rel="icon" href="/f.ico"><meta property="og:title" content="H"><meta property="og:image" content="/o.png">')]);
  assert.equal(byId(set, 'favicon').status, 'pass');
  assert.equal(byId(set, 'social').status, 'pass');
});

test('links: reads broken links from context, passes when none', () => {
  const pages = [page('/', '<a href="/dead">x</a>')];
  assert.equal(byId(runChecks(pages, {}), 'links').status, 'pass', 'no broken links reported = pass');
  const broken = runChecks(pages, { brokenLinks: [{ route: '/', href: '/dead', status: 404 }] });
  assert.equal(byId(broken, 'links').status, 'fail');
});

test('every check declares id, label, category, hint', () => {
  for (const c of CHECKS) {
    assert.ok(c.id && c.label && c.category && c.hint, `${c.id} is fully described`);
  }
});

// ── Agent-facing report file ──────────────────────────────────────────────

const fs = require('fs') as typeof import('fs');
const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const { persist, filePath } = require('../src/main/launchCheck') as typeof import('../src/main/launchCheck');

test('persist writes the report to .radial/launch-check.json, creating the dir', () => {
  const dir = tmpDir('radial-lc-');
  const report: LaunchCheckReport = { ok: true, scannedAt: 123, pageCount: 2, counts: { pass: 1, warn: 1, fail: 0, na: 0 }, unreachable: [], results: [] };
  persist(dir, report);
  const back: unknown = JSON.parse(fs.readFileSync(filePath(dir), 'utf8'));
  assert.deepEqual(back, report);
});

test('persist keeps ok:false reports too — the agent that asked needs the why', () => {
  const dir = tmpDir('radial-lc-');
  persist(dir, { ok: false, error: 'dev server not running', scannedAt: 456 });
  const back = JSON.parse(fs.readFileSync(filePath(dir), 'utf8')) as Extract<LaunchCheckReport, { ok: false }>;
  assert.equal(back.ok, false);
  assert.match(back.error, /dev server/);
});
