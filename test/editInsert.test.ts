import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as insert from '../src/main/editInsert';
import type { StructuralEditDone, StructuralEditFailure } from '../src/main/editInsert';
import type { ElementPathLevel } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

/**
 * A path level as these fixtures write it: everything but the id, which the
 * overlay always sends (null for none). Each fixture is checked as FixtureLevel[]
 * and then cast to ElementPathLevel[], since the resolvers read a missing id as none.
 */
type FixtureLevel = Omit<ElementPathLevel, 'id'>;

function makeRepo(files: Record<string, string>): string {
  const dir = tmpDir('radial-test-');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

const PAGE = [
  '<!doctype html>',
  '<body>',
  '  <section class="hero-block">',
  '    <h1>Big headline</h1>',
  '    <p>Sub copy.</p>',
  '  </section>',
  '  <section class="features-grid">',
  '    <div class="card-first">One</div>',
  '    <div class="card-second">Two</div>',
  '  </section>',
  '  <img class="brand-mark" src="/logo.png" alt="" />',
  '</body>',
].join('\n');

test('insert after: new markup lands after the anchor close tag, same indent', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyInsert(repo, {
    anchor: { tagName: 'section', classList: ['hero-block'] },
    position: 'after',
    markup: '<section>\n  <h2>New section</h2>\n</section>',
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8').split('\n');
  assert.equal(out[6], '  <section>');
  assert.equal(out[7], '    <h2>New section</h2>');
  assert.equal(out[9], '  <section class="features-grid">'); // untouched neighbor follows
});

test('insert inside: appended as last child with one extra indent step', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyInsert(repo, {
    anchor: { tagName: 'section', classList: ['features-grid'] },
    position: 'inside',
    markup: '<div class="card-third">Three</div>',
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8').split('\n');
  assert.equal(out[9], '    <div class="card-third">Three</div>');
  assert.equal(out[10], '  </section>');
});

test('insert before: lands above the anchor open tag', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyInsert(repo, {
    anchor: { tagName: 'section', classList: ['hero-block'] },
    position: 'before',
    markup: '<nav>Menu</nav>',
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8').split('\n');
  assert.equal(out[2], '  <nav>Menu</nav>');
  assert.equal(out[3], '  <section class="hero-block">');
});

test('insert inside a void element bails', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyInsert(repo, {
    anchor: { tagName: 'img', classList: ['brand-mark'] },
    position: 'inside',
    markup: '<span>x</span>',
  });
  assert.equal(res.ok, false);
  assert.equal((res as StructuralEditFailure).reason, 'void-parent');
});

test('nested same-tag: outer div anchored by class gets the OUTER range', () => {
  const repo = makeRepo({
    'index.html': [
      '<body>',
      '  <div class="outer-shell">',
      '    <div class="inner-bit">',
      '      <p>Deep text</p>',
      '    </div>',
      '  </div>',
      '</body>',
    ].join('\n'),
  });
  const res = insert.applyInsert(repo, {
    anchor: { tagName: 'div', classList: ['outer-shell'] },
    position: 'after',
    markup: '<div class="sibling-box">S</div>',
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8').split('\n');
  assert.equal(out[6], '  <div class="sibling-box">S</div>'); // after </div> of OUTER, not inner
});

test('JSX file: our class= templates become className=', () => {
  const repo = makeRepo({
    'src/Page.tsx': [
      'export default function Page() {',
      '  return (',
      '    <main className="page-main">',
      '      <h1>Hello</h1>',
      '    </main>',
      '  );',
      '}',
    ].join('\n'),
  });
  const res = insert.applyInsert(repo, {
    anchor: { tagName: 'main', classList: ['page-main'] },
    position: 'inside',
    markup: '<section class="fresh-part">\n  <h2>New section</h2>\n</section>',
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'src/Page.tsx'), 'utf8');
  assert.match(out, /className="fresh-part"/);
  assert.doesNotMatch(out, /class="fresh-part"/);
});

test('move after: first section slides below the second', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyMove(repo, {
    subject: { tagName: 'section', classList: ['hero-block'] },
    target: { tagName: 'section', classList: ['features-grid'] },
    position: 'after',
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8').split('\n');
  assert.equal(out[2], '  <section class="features-grid">');
  assert.equal(out[6], '  <section class="hero-block">');
  assert.equal(out[7], '    <h1>Big headline</h1>');
});

test('move before: second section climbs above the first', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyMove(repo, {
    subject: { tagName: 'section', classList: ['features-grid'] },
    target: { tagName: 'section', classList: ['hero-block'] },
    position: 'before',
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8').split('\n');
  assert.equal(out[2], '  <section class="features-grid">');
  assert.equal(out[6], '  <section class="hero-block">');
});

test('move inside a one-line container opens it up and nests the child', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyMove(repo, {
    subject: { tagName: 'img', classList: ['brand-mark'] },
    target: { tagName: 'div', classList: ['card-first'] }, // <div class="card-first">One</div>
    position: 'inside',
  });
  assert.equal(res.ok, true); // the offset engine handles one-liners now
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  // The img now lives inside card-first, which is broken onto multiple lines.
  assert.match(out, /<div class="card-first">[\s\S]*brand-mark[\s\S]*<\/div>/);
});

test('move inside a multi-line container: image lands as last child, indented', () => {
  const repo = makeRepo({
    'index.html': [
      '<body>',
      '  <div class="media-box">',
      '    <h3>Media</h3>',
      '  </div>',
      '  <img class="brand-mark" src="/logo.png" alt="" />',
      '</body>',
    ].join('\n'),
  });
  const res = insert.applyMove(repo, {
    subject: { tagName: 'img', classList: ['brand-mark'] },
    target: { tagName: 'div', classList: ['media-box'] },
    position: 'inside',
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8').split('\n');
  assert.equal(out[3], '    <img class="brand-mark" src="/logo.png" alt="" />');
  assert.equal(out[4], '  </div>');
});

test('move across parents: a card leaves its section for the top level', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyMove(repo, {
    subject: { tagName: 'div', classList: ['card-second'] },
    target: { tagName: 'img', classList: ['brand-mark'] },
    position: 'after',
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8').split('\n');
  const imgIdx = out.findIndex((l) => l.includes('brand-mark'));
  assert.equal(out[imgIdx + 1], '  <div class="card-second">Two</div>'); // re-indented to its new depth
});

test('move out of own parent: a card lands after its section', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyMove(repo, {
    subject: { tagName: 'div', classList: ['card-first'] },
    target: { tagName: 'section', classList: ['features-grid'] },
    position: 'after',
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8').split('\n');
  const closeIdx = out.findIndex((l, i) => l.trim() === '</section>' && i > out.findIndex((x) => x.includes('features-grid')));
  assert.equal(out[closeIdx + 1], '  <div class="card-first">One</div>');
});

test('move a container onto its own child bails', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyMove(repo, {
    subject: { tagName: 'section', classList: ['features-grid'] },
    target: { tagName: 'div', classList: ['card-first'] },
    position: 'after',
  });
  assert.equal(res.ok, false);
  assert.equal((res as StructuralEditFailure).reason, 'nested');
});

test('sibling-index: a classless img resolves through its parent + slot', () => {
  const repo = makeRepo({
    'index.html': [
      '<body>',
      '  <section class="media-row">',
      '    <img src="/a.png" />',
      '    <img src="/b.png" />',
      '    <img src="/c.png" />',
      '  </section>',
      '</body>',
    ].join('\n'),
  });
  const res = insert.applyRemove(repo, {
    subject: { tagName: 'img', classList: [], text: '',
      parent: { tagName: 'section', classList: ['media-row'] },
      nthOfTag: 1, tagSiblings: 3 },
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.match(out, /a\.png/); assert.doesNotMatch(out, /b\.png/); assert.match(out, /c\.png/);
});

test('sibling-index bails on a count mismatch (mapped content)', () => {
  const repo = makeRepo({
    'index.html': '<body>\n  <section class="media-row">\n    <img src="/only.png" />\n  </section>\n</body>',
  });
  const res = insert.applyRemove(repo, {
    subject: { tagName: 'img', classList: [], text: '',
      parent: { tagName: 'section', classList: ['media-row'] },
      nthOfTag: 2, tagSiblings: 5 }, // DOM says five rendered — source has one line
  });
  assert.equal(res.ok, false);
  assert.equal((res as StructuralEditFailure).reason, 'count-mismatch');
});

test('attribute needle: an img with only a src locates by filename', () => {
  const repo = makeRepo({
    'index.html': '<body>\n  <p class="intro-copy">Hello.</p>\n  <img src="/assets/team-photo.png" />\n</body>',
  });
  const res = insert.applyRemove(repo, {
    subject: { tagName: 'img', classList: [], text: '', src: '/assets/team-photo.png' },
  });
  assert.equal(res.ok, true);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, 'index.html'), 'utf8'), /team-photo/);
});

test('unbalanced markup bails instead of guessing', () => {
  const repo = makeRepo({
    'index.html': '<body>\n  <section class="broken-part">\n    <p>Text\n</body>',
  });
  const res = insert.applyInsert(repo, {
    anchor: { tagName: 'section', classList: ['broken-part'] },
    position: 'after',
    markup: '<div>x</div>',
  });
  assert.equal(res.ok, false); // the reason varies by which resolver gave up last — the contract is the bail
});

test('quoted > inside an attribute does not end the open tag early', () => {
  const repo = makeRepo({
    'index.html': '<body>\n  <div class="tricky-attr" title="a > b">Hi</div>\n  <p>After</p>\n</body>',
  });
  const res = insert.applyInsert(repo, {
    anchor: { tagName: 'div', classList: ['tricky-attr'] },
    position: 'after',
    markup: '<span>new</span>',
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8').split('\n');
  assert.equal(out[2], '  <span>new</span>');
});

test('remove: the whole element range disappears, neighbors untouched', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyRemove(repo, {
    subject: { tagName: 'section', classList: ['hero-block'] },
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.doesNotMatch(out, /hero-block/);
  assert.doesNotMatch(out, /Big headline/);
  assert.match(out, /features-grid/);
  assert.match(out, /brand-mark/);
});

test('remove: a void element goes as a single line', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyRemove(repo, {
    subject: { tagName: 'img', classList: ['brand-mark'] },
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.doesNotMatch(out, /brand-mark/);
  assert.match(out, /features-grid/);
});

test('remove bails on markup it cannot bound', () => {
  const repo = makeRepo({
    'index.html': '<body>\n  <section class="broken-part">\n    <p>Text\n</body>',
  });
  const res = insert.applyRemove(repo, {
    subject: { tagName: 'section', classList: ['broken-part'] },
  });
  assert.equal(res.ok, false); // reason string varies by resolver; the bail is the contract
});

test('wrap: subject gains a uniquely-classed div wrapper, indented one step in', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyWrap(repo, {
    subject: { tagName: 'section', classList: ['hero-block'] },
  }) as StructuralEditDone;
  assert.equal(res.ok, true);
  assert.match(res.wrapperClass!, /^block-[a-z0-9]+$/);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8').split('\n');
  assert.match(out[2], new RegExp(`^  <div class="${res.wrapperClass}">$`));
  assert.equal(out[3], '    <section class="hero-block">');
  assert.equal(out[6], '    </section>');
  assert.equal(out[7], '  </div>');
});

test('wrap in JSX uses className', () => {
  const repo = makeRepo({
    'src/Page.tsx': 'export default function P() {\n  return (\n    <main className="page-main">\n      <h1>Hello</h1>\n    </main>\n  );\n}',
  });
  const res = insert.applyWrap(repo, { subject: { tagName: 'h1', text: 'Hello' } });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'src/Page.tsx'), 'utf8');
  assert.match(out, /<div className="block-/);
});

test('unwrap: the wrapper tags vanish, children step out one indent', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyUnwrap(repo, {
    subject: { tagName: 'section', classList: ['features-grid'] },
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.doesNotMatch(out, /features-grid/);
  const lines = out.split('\n');
  assert.equal(lines[6], '  <div class="card-first">One</div>');
  assert.equal(lines[7], '  <div class="card-second">Two</div>');
});

test('unwrap a one-line or crowded element bails', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyUnwrap(repo, {
    subject: { tagName: 'div', classList: ['card-first'] },
  });
  assert.equal(res.ok, false);
  assert.equal((res as StructuralEditFailure).reason, 'no-children');
});

test('wrap round-trips through unwrap back to the original layout', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const w = insert.applyWrap(repo, { subject: { tagName: 'section', classList: ['hero-block'] } });
  assert.equal(w.ok, true);
  const u = insert.applyUnwrap(repo, { subject: { tagName: 'div', classList: [(w as StructuralEditDone).wrapperClass!] } });
  assert.equal(u.ok, true);
  assert.equal(fs.readFileSync(path.join(repo, 'index.html'), 'utf8'), PAGE);
});

// ── structural resolver: repeated / utility-class markup (the real world) ──
const TW = [
  '<body>',
  '  <section class="py-20 bg-white">',
  '    <div class="container mx-auto px-4">',
  '      <div class="grid grid-cols-3 gap-8">',
  '        <div class="rounded-lg border p-6 shadow-sm">',
  '          <h3 class="text-xl font-semibold">Feature One</h3>',
  '          <p class="text-gray-600">Body one.</p>',
  '        </div>',
  '        <div class="rounded-lg border p-6 shadow-sm">',
  '          <h3 class="text-xl font-semibold">Feature Two</h3>',
  '          <p class="text-gray-600">Body two.</p>',
  '        </div>',
  '        <div class="rounded-lg border p-6 shadow-sm">',
  '          <h3 class="text-xl font-semibold">Feature Three</h3>',
  '          <p class="text-gray-600">Body three.</p>',
  '        </div>',
  '      </div>',
  '    </div>',
  '  </section>',
  '</body>',
].join('\n');
// The ancestor path buildStructuralPath produces for the Nth feature card.
const cardPath = (nth: number) => [
  { tag: 'div', cls: ['rounded-lg', 'border', 'p-6', 'shadow-sm'], own: '', nth, cnt: 3 },
  { tag: 'div', cls: ['grid', 'grid-cols-3', 'gap-8'], own: '', nth: 0, cnt: 1 },
  { tag: 'div', cls: ['container', 'mx-auto', 'px-4'], own: '', nth: 0, cnt: 1 },
  { tag: 'section', cls: ['py-20', 'bg-white'], own: '', nth: 0, cnt: 1 },
  { tag: 'body', cls: [], own: '', nth: 0, cnt: 1 },
] satisfies FixtureLevel[] as ElementPathLevel[];

test('reorder identical cards: the 2nd card (not the 1st) moves after the 3rd', () => {
  const repo = makeRepo({ 'index.html': TW });
  const res = insert.applyMove(repo, {
    subject: { tagName: 'div', path: cardPath(1) },
    target: { tagName: 'div', path: cardPath(2) },
    position: 'after',
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  // Order becomes One, Three, Two — the 2nd card really moved, not the 1st.
  assert.ok(out.indexOf('Feature One') < out.indexOf('Feature Three'));
  assert.ok(out.indexOf('Feature Three') < out.indexOf('Feature Two'));
});

test('delete the middle identical card removes exactly that one', () => {
  const repo = makeRepo({ 'index.html': TW });
  const res = insert.applyRemove(repo, { subject: { tagName: 'div', path: cardPath(1) } });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.match(out, /Feature One/); assert.doesNotMatch(out, /Feature Two/); assert.match(out, /Feature Three/);
});

test('leaf inside a non-unique card resolves via the grid anchor + descent', () => {
  const repo = makeRepo({ 'index.html': TW });
  // The <p> in card 2 — its own classes repeat, its parent card repeats; only
  // the grid is unique. Anchor = grid, descend card(nth1) → p(nth0).
  const pPath = [
    { tag: 'p', cls: ['text-gray-600'], own: 'Body two.', nth: 0, cnt: 1 },
    ...cardPath(1),
  ] satisfies FixtureLevel[] as ElementPathLevel[];
  const res = insert.applyRemove(repo, { subject: { tagName: 'p', path: pPath } });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.doesNotMatch(out, /Body two\./);
  assert.match(out, /Body one\./); assert.match(out, /Body three\./);
});

test('anchors on <body> when nothing above the element is uniquely classed', () => {
  const repo = makeRepo({
    'index.html': [
      '<body>',
      '  <div class="flex">',
      '    <div class="flex">A</div>',
      '    <div class="flex">B</div>',
      '  </div>',
      '</body>',
    ].join('\n'),
  });
  // Everything is class "flex"; only <body> is unique. Descend body → outer → inner[1].
  const res = insert.applyRemove(repo, {
    subject: { tagName: 'div', path: [
      { tag: 'div', cls: ['flex'], own: 'B', nth: 1, cnt: 2 },
      { tag: 'div', cls: ['flex'], own: '', nth: 0, cnt: 1 },
      { tag: 'body', cls: [], own: '', nth: 0, cnt: 1 },
    ] satisfies FixtureLevel[] as ElementPathLevel[] },
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.match(out, />A</); assert.doesNotMatch(out, />B</);
});

test('mapped content (source count ≠ DOM count) bails at the descent guard', () => {
  const repo = makeRepo({
    'index.html': [
      '<body>',
      '  <ul class="feed">',
      '    <li class="item">{item.title}</li>',
      '  </ul>',
      '</body>',
    ].join('\n'),
  });
  // DOM rendered 4 <li> from one mapped source line.
  const res = insert.applyRemove(repo, {
    subject: { tagName: 'li', path: [
      { tag: 'li', cls: ['item'], own: 'Third title', nth: 2, cnt: 4 },
      { tag: 'ul', cls: ['feed'], own: '', nth: 0, cnt: 1 },
      { tag: 'body', cls: [], own: '', nth: 0, cnt: 1 },
    ] satisfies FixtureLevel[] as ElementPathLevel[] },
  });
  assert.equal(res.ok, false);
  assert.equal((res as StructuralEditFailure).reason, 'count-mismatch');
});

test('JSX component file: reorder identical cards by structure', () => {
  const repo = makeRepo({
    'src/Features.tsx': [
      'export default function Features() {',
      '  return (',
      '    <section className="features">',
      '      <div className="grid grid-cols-2">',
      '        <article className="card">First</article>',
      '        <article className="card">Second</article>',
      '      </div>',
      '    </section>',
      '  );',
      '}',
    ].join('\n'),
  });
  const artPath = (nth: number) => [
    { tag: 'article', cls: ['card'], own: nth === 0 ? 'First' : 'Second', nth, cnt: 2 },
    { tag: 'div', cls: ['grid', 'grid-cols-2'], own: '', nth: 0, cnt: 1 },
    { tag: 'section', cls: ['features'], own: '', nth: 0, cnt: 1 },
  ] satisfies FixtureLevel[] as ElementPathLevel[];
  const res = insert.applyMove(repo, {
    subject: { tagName: 'article', path: artPath(0) },
    target: { tagName: 'article', path: artPath(1) },
    position: 'after',
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'src/Features.tsx'), 'utf8');
  assert.ok(out.indexOf('Second') < out.indexOf('First'));
});

test('multi-page: preferFile scopes uniqueness to the current page', () => {
  // Two pages, each with its own <body> and sibling sections. Without scoping,
  // <body> repeats → nothing is globally unique → no-anchor on every drag.
  const page = (t: string) => [
    '<!doctype html><html><head><title>' + t + '</title></head>',
    '<body>',
    '  <section class="hero"><h1>' + t + '</h1></section>',
    '  <section class="pricing"><h2>Pricing</h2></section>',
    '  <section class="cta"><h2>CTA</h2></section>',
    '</body></html>',
  ].join('\n');
  const repo = makeRepo({ 'index.html': page('Home'), 'about.html': page('About') });
  const sec = (cls: string, nth: number) => ({ tagName: 'section', path: [
    { tag: 'section', cls: [cls], own: '', nth, cnt: 3 },
    { tag: 'body', cls: [], own: '', nth: 0, cnt: 1 },
  ] satisfies FixtureLevel[] as ElementPathLevel[] });
  // Without preferFile — bails, because <body> is not globally unique.
  assert.equal(insert.applyMove(repo, { subject: sec('hero', 0), target: sec('cta', 2), position: 'after' }).ok, false);
  // With it — resolves against the home page and leaves About alone.
  const ok = insert.applyMove(repo, { subject: sec('hero', 0), target: sec('cta', 2), position: 'after', preferFile: 'index.html' });
  assert.equal(ok.ok, true);
  assert.match(fs.readFileSync(path.join(repo, 'about.html'), 'utf8'), /About/);
  const home = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.ok(home.indexOf('class="pricing"') < home.indexOf('class="cta"'));
  assert.ok(home.indexOf('class="cta"') < home.indexOf('class="hero"'));
});

test('result carries prev/new content so recordEdit can make it undoable', () => {
  const repo = makeRepo({ 'index.html': PAGE });
  const res = insert.applyInsert(repo, {
    anchor: { tagName: 'section', classList: ['hero-block'] },
    position: 'after',
    markup: '<hr />',
  }) as StructuralEditDone;
  assert.equal(res.ok, true);
  assert.equal(typeof res.prevContent, 'string');
  assert.equal(typeof res.newContent, 'string');
  assert.notEqual(res.prevContent, res.newContent);
  assert.equal(res.prevContent, PAGE);
});
