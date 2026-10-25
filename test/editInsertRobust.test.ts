// Robustness: the same structural edits must succeed across EVERY formatting
// shape real source takes — Prettier-formatted, inline, minified, JSX, Astro,
// deeply nested, ragged indentation. A bail here would mean the agent has to
// take over a direct-manipulation action, which must never happen for markup a
// person can point at.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as insert from '../src/main/editInsert';
import type { StructuralEditFailure } from '../src/main/editInsert';
import type { ElementPathLevel } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

/**
 * A path level as these fixtures write it: everything but the id, which the
 * overlay always sends (null for none). Each fixture is checked as FixtureLevel[]
 * and then cast to ElementPathLevel[], since the resolvers read a missing id as none.
 */
type FixtureLevel = Omit<ElementPathLevel, 'id'>;

function makeRepo(files: Record<string, string>): string {
  const dir = tmpDir('radial-rob-');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}
// A section's DOM ancestor path (element → body). Sections are same-tag
// siblings, so they anchor via <body> + descent — the real-world case.
const secPath = (cls: string, nth: number, cnt: number) => ({ tagName: 'section', path: [
  { tag: 'section', cls: [cls], own: '', nth, cnt },
  { tag: 'body', cls: [], own: '', nth: 0, cnt: 1 },
] satisfies FixtureLevel[] as ElementPathLevel[] });

test('MINIFIED: reorder sections with zero whitespace', () => {
  const repo = makeRepo({ 'index.html': '<body><section class="a">A</section><section class="b">B</section><section class="c">C</section></body>' });
  const res = insert.applyMove(repo, { subject: secPath('a', 0, 3), target: secPath('c', 2, 3), position: 'after', preferFile: 'index.html' });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.ok(out.indexOf('class="b"') < out.indexOf('class="c"'));
  assert.ok(out.indexOf('class="c"') < out.indexOf('class="a"'));
});

test('INLINE: many elements per line, delete the middle one', () => {
  const repo = makeRepo({ 'index.html': '<body>\n  <nav><a class="home" href="/">Home</a> <a class="about" href="/about">About</a> <a class="contact" href="/c">Contact</a></nav>\n</body>' });
  const res = insert.applyRemove(repo, { subject: { tagName: 'a', path: [
    { tag: 'a', cls: ['about'], own: 'About', nth: 1, cnt: 3 },
    { tag: 'nav', cls: [], own: '', nth: 0, cnt: 1 },
    { tag: 'body', cls: [], own: '', nth: 0, cnt: 1 },
  ] satisfies FixtureLevel[] as ElementPathLevel[] }, preferFile: 'index.html' });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.match(out, /Home/); assert.doesNotMatch(out, /About/); assert.match(out, /Contact/);
});

test('RAGGED indentation: insert after a section keeps working', () => {
  const repo = makeRepo({ 'index.html': '<body>\n      <section class="hero">\n        <h1>Hi</h1>\n      </section>\n</body>' });
  const res = insert.applyInsert(repo, { anchor: { tagName: 'section', path: [
    { tag: 'section', cls: ['hero'], own: '', nth: 0, cnt: 1 }, { tag: 'body', cls: [], own: '', nth: 0, cnt: 1 },
  ] satisfies FixtureLevel[] as ElementPathLevel[] }, position: 'after', markup: '<section class="new">\n  <p>New</p>\n</section>', preferFile: 'index.html' });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.match(out, /class="new"/);
  assert.ok(out.indexOf('class="hero"') < out.indexOf('class="new"'));
});

test('ASTRO: frontmatter + JSX-ish markup, reorder cards', () => {
  const repo = makeRepo({ 'src/pages/index.astro': [
    '---',
    'const items = ["a", "b"];',
    'import Layout from "../Layout.astro";',
    '---',
    '<Layout>',
    '  <div class="grid">',
    '    <article class="card">First</article>',
    '    <article class="card">Second</article>',
    '  </div>',
    '</Layout>',
  ].join('\n') });
  const cardPath = (nth: number) => ({ tagName: 'article', path: [
    { tag: 'article', cls: ['card'], own: nth === 0 ? 'First' : 'Second', nth, cnt: 2 },
    { tag: 'div', cls: ['grid'], own: '', nth: 0, cnt: 1 },
  ] satisfies FixtureLevel[] as ElementPathLevel[] });
  const res = insert.applyMove(repo, { subject: cardPath(0), target: cardPath(1), position: 'after', preferFile: 'src/pages/index.astro' });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'src/pages/index.astro'), 'utf8');
  assert.ok(out.indexOf('Second') < out.indexOf('First'));
  assert.match(out, /const items/); // frontmatter untouched
});

test('TSX: component with hooks + JSX return, delete a repeated item', () => {
  const repo = makeRepo({ 'src/Feed.tsx': [
    'import { useState } from "react";',
    'export function Feed() {',
    '  const [n, setN] = useState(0);',
    '  return (',
    '    <ul className="feed">',
    '      <li className="row">Alpha</li>',
    '      <li className="row">Bravo</li>',
    '      <li className="row">Charlie</li>',
    '    </ul>',
    '  );',
    '}',
  ].join('\n') });
  const res = insert.applyRemove(repo, { subject: { tagName: 'li', path: [
    { tag: 'li', cls: ['row'], own: 'Bravo', nth: 1, cnt: 3 },
    { tag: 'ul', cls: ['feed'], own: '', nth: 0, cnt: 1 },
  ] satisfies FixtureLevel[] as ElementPathLevel[] }, preferFile: 'src/Feed.tsx' });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'src/Feed.tsx'), 'utf8');
  assert.match(out, /Alpha/); assert.doesNotMatch(out, /Bravo/); assert.match(out, /Charlie/);
  assert.match(out, /useState/); // logic untouched
});

test('TSX with {expr} children: literal siblings still reorder around it', () => {
  const repo = makeRepo({ 'src/X.tsx': [
    'export function X({ user }) {',
    '  return (',
    '    <div className="wrap">',
    '      <header className="hd">Head</header>',
    '      {user && <span>hi</span>}',
    '      <footer className="ft">Foot</footer>',
    '    </div>',
    '  );',
    '}',
  ].join('\n') });
  // header and footer are the only literal children; the {expr} is opaque.
  const res = insert.applyMove(repo, {
    subject: { tagName: 'footer', path: [
      { tag: 'footer', cls: ['ft'], own: 'Foot', nth: 0, cnt: 1 },
      { tag: 'div', cls: ['wrap'], own: '', nth: 0, cnt: 1 },
    ] satisfies FixtureLevel[] as ElementPathLevel[] },
    target: { tagName: 'header', path: [
      { tag: 'header', cls: ['hd'], own: 'Head', nth: 0, cnt: 1 },
      { tag: 'div', cls: ['wrap'], own: '', nth: 0, cnt: 1 },
    ] satisfies FixtureLevel[] as ElementPathLevel[] },
    position: 'before', preferFile: 'src/X.tsx',
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'src/X.tsx'), 'utf8');
  assert.ok(out.indexOf('Foot') < out.indexOf('Head'));
  assert.match(out, /\{user && <span>hi<\/span>\}/); // the expression is preserved verbatim
});

test('DEEP nesting: reorder a leaf 6 levels down via ancestor + descent', () => {
  const repo = makeRepo({ 'index.html': [
    '<body>',
    '  <main class="page">',
    '    <div class="a"><div class="b"><div class="c">',
    '      <ul class="list">',
    '        <li>one</li>',
    '        <li>two</li>',
    '        <li>three</li>',
    '      </ul>',
    '    </div></div></div>',
    '  </main>',
    '</body>',
  ].join('\n') });
  const liPath = (nth: number) => ({ tagName: 'li', path: [
    { tag: 'li', cls: [], own: ['one', 'two', 'three'][nth], nth, cnt: 3 },
    { tag: 'ul', cls: ['list'], own: '', nth: 0, cnt: 1 },
  ] satisfies FixtureLevel[] as ElementPathLevel[] });
  const res = insert.applyMove(repo, { subject: liPath(0), target: liPath(2), position: 'after', preferFile: 'index.html' });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.ok(out.indexOf('two') < out.indexOf('three'));
  assert.ok(out.indexOf('three') < out.indexOf('one'));
});

test('FRAMEWORK split: <body> in a layout file, sections in the page — resolves via direct locate', () => {
  // Astro/Next shape: the DOM path runs up to a <body> that lives in the
  // layout, not the page. Structural descent can't cross that boundary, so the
  // element is found directly in the page file by its own class.
  const repo = makeRepo({
    'src/layouts/Layout.astro': '<html>\n  <body>\n    <slot />\n  </body>\n</html>',
    'src/pages/index.astro': ['---', 'import Layout from "../layouts/Layout.astro";', '---',
      '<Layout>', '  <section class="hero"><h1>Hero</h1></section>',
      '  <section class="features"><h2>Features</h2></section>',
      '  <section class="pricing"><h2>Pricing</h2></section>', '</Layout>'].join('\n'),
  });
  const sec = (cls: string, nth: number) => ({ tagName: 'section', path: [
    { tag: 'section', cls: [cls], own: '', nth, cnt: 3 },
    { tag: 'body', cls: [], own: '', nth: 0, cnt: 1 }, // body is in the OTHER file
  ] satisfies FixtureLevel[] as ElementPathLevel[] });
  const mv = insert.applyMove(repo, { subject: sec('hero', 0), target: sec('pricing', 2), position: 'after', preferFile: 'src/pages/index.astro' });
  assert.equal(mv.ok, true);
  const page = fs.readFileSync(path.join(repo, 'src/pages/index.astro'), 'utf8');
  assert.ok(page.indexOf('class="features"') < page.indexOf('class="hero"')); // hero moved down
  assert.match(fs.readFileSync(path.join(repo, 'src/layouts/Layout.astro'), 'utf8'), /<slot \/>/); // layout untouched
  const ad = insert.applyInsert(repo, { anchor: sec('features', 1), position: 'after', markup: '<section class="new">n</section>', preferFile: 'src/pages/index.astro' });
  assert.equal(ad.ok, true);
});

test('idempotent stress: 12 reorders in a row never bail', () => {
  const repo = makeRepo({ 'index.html': '<body>\n  <section class="s0">0</section>\n  <section class="s1">1</section>\n  <section class="s2">2</section>\n  <section class="s3">3</section>\n</body>' });
  for (let k = 0; k < 12; k++) {
    // read current order → move first to after last
    const src = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
    const order = [...src.matchAll(/class="s(\d)"/g)].map((m) => m[1]);
    const first = order[0], last = order[order.length - 1];
    const res = insert.applyMove(repo, {
      subject: secPath('s' + first, 0, 4), target: secPath('s' + last, 3, 4), position: 'after', preferFile: 'index.html',
    });
    assert.equal(res.ok, true, `move ${k} bailed: ${(res as { reason?: StructuralEditFailure['reason'] }).reason}`);
  }
  // Still four sections, still valid.
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.equal((out.match(/<section/g) || []).length, 4);
});
