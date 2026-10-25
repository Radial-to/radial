// TWINS — the thing text search could never do and a design tool must: when two
// elements share a class string, or the same copy appears twice, edit the ONE
// the user pointed at, by DOM position and ancestry; refuse only when a single
// source node truly stands for many rendered copies (a component template).
// Covers the resolver's disambiguation and the structural pin that the text
// tool and the adjust steppers now go through (previously text-search + score,
// which silently edited a twin on another page in the real-site sweep).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as insert from '../src/main/editInsert';
import * as engine from '../src/main/editEngine';
import type { StructuralEditDone, StructuralEditFailure } from '../src/main/editInsert';
import type { StyleEditDone, StyleEditOutcome, TextEditDone } from '../src/main/editEngine';
import type { ElementPathLevel, TextEditFailure } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

/** applyStyleEdits when it wrote nothing. */
type StyleEditFailure = Exclude<StyleEditOutcome, { ok: true }>;

function writeRepo(files: Record<string, string>) {
  const d = tmpDir('pin-');
  for (const [rel, c] of Object.entries(files)) { const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); }
  return d;
}
const rd = (repo: string, rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');
const L = (tag: string, cls: string[], nth: number, cnt: number, own = '', id: string | null = null): ElementPathLevel => ({ tag, id, cls, own, nth, cnt });
const BODY = L('body', [], 0, 1), MAIN = L('main', ['wrap'], 0, 1);

// ── A. Resolver: twins ─────────────────────────────────────────────────────
// Two identical grids of three identical (empty) cards, in a component whose
// root has no signature (a bare <div>), composed from a route file. No in-file
// unique ancestor ⇒ structural descent can't; directLocate must pick the 2nd
// card of the 2nd grid by position (nth among 3) + ancestry (2nd of 2 grids).
function twinGrids() {
  return writeRepo({
    'app/page.tsx': `import { Cards } from "./cards";\nexport default function Home() { return (<main className="wrap"><Cards /></main>); }`,
    'app/cards.tsx': `export function Cards() {\n  return (\n    <div>\n      <section className="grid">\n        <div className="card p-4"></div>\n        <div className="card p-4"></div>\n        <div className="card p-4"></div>\n      </section>\n      <section className="grid">\n        <div className="card p-4"></div>\n        <div className="card p-4"></div>\n        <div className="card p-4"></div>\n      </section>\n    </div>\n  );\n}`,
  });
}
test('twins: 2nd card of the 2nd identical grid — position + ancestry pick it (no in-file anchor)', () => {
  const repo = twinGrids();
  try {
    const sel = { tagName: 'div', path: [L('div', ['card', 'p-4'], 1, 3), L('section', ['grid'], 1, 2), L('div', [], 0, 1), MAIN, BODY] };
    const res = insert.applyInsert(repo, { anchor: sel, position: 'after', markup: '<p class="mark">m</p>', preferFile: 'app/page.tsx' });
    assert.equal(res.ok, true, `should resolve the twin: ${(res as Partial<StructuralEditFailure>).reason}`);
    const out = rd(repo, 'app/cards.tsx');
    const at = out.indexOf('className="mark"');
    assert.equal((out.slice(0, at).match(/className="card p-4"/g) || []).length, 5, 'marker lands after the 5th card overall (2nd of grid 2)');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
test('twins: the DOM says 1st grid, 3rd card — a different twin resolves', () => {
  const repo = twinGrids();
  try {
    const sel = { tagName: 'div', path: [L('div', ['card', 'p-4'], 2, 3), L('section', ['grid'], 0, 2), L('div', [], 0, 1), MAIN, BODY] };
    const res = insert.applyInsert(repo, { anchor: sel, position: 'after', markup: '<p class="mark">m</p>', preferFile: 'app/page.tsx' });
    assert.equal(res.ok, true, (res as Partial<StructuralEditFailure>).reason);
    const out = rd(repo, 'app/cards.tsx');
    assert.equal((out.slice(0, out.indexOf('className="mark"')).match(/className="card p-4"/g) || []).length, 3, 'after the 3rd card overall');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('tailwind overlap: the one element carrying ALL the DOM classes wins over neighbors sharing `flex`', () => {
  // Root div has no unique signature (byTag div is everywhere, bySig `flex` too) ⇒ directLocate by strength.
  const repo = writeRepo({ 'app/page.tsx': `export default function P(){ return (<div className="flex"><div className="flex gap-2"></div><div className="flex items-center gap-2 px-6"></div><div className="flex px-6"></div></div>); }` });
  try {
    const sel = { tagName: 'div', path: [L('div', ['flex', 'items-center', 'gap-2', 'px-6'], 1, 3), L('div', ['flex'], 0, 1), BODY] };
    const res = insert.applyInsert(repo, { anchor: sel, position: 'after', markup: '<p class="mark">m</p>', preferFile: 'app/page.tsx' });
    assert.equal(res.ok, true, `full class-set match should be unique: ${(res as Partial<StructuralEditFailure>).reason}`);
    assert.match(rd(repo, 'app/page.tsx'), /px-6"><\/div>\s*<p className="mark">m<\/p>\s*<div className="flex px-6">/, 'landed after the fully-matching div');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('SAFETY: a component rendered 3× (one source node, DOM cnt 3) is REFUSED, not edited for all', () => {
  const repo = writeRepo({
    'app/page.tsx': `import { Card } from "./card";\nexport default function P(){ return (<main className="wrap"><section className="grid"><Card /><Card /><Card /></section></main>); }`,
    'app/card.tsx': `export function Card(){ return (<div className="card p-4"></div>); }`,
  });
  try {
    const before = rd(repo, 'app/card.tsx');
    const sel = { tagName: 'div', path: [L('div', ['card', 'p-4'], 1, 3), L('section', ['grid'], 0, 1), MAIN, BODY] };
    const res = insert.applyInsert(repo, { anchor: sel, position: 'after', markup: '<p class="mark">m</p>', preferFile: 'app/page.tsx' }) as StructuralEditFailure;
    assert.equal(res.ok, false, 'must not edit the template that stands for all three');
    assert.ok(['count-mismatch', 'no-anchor'].includes(res.reason), res.reason);
    assert.equal(rd(repo, 'app/card.tsx'), before, 'card.tsx untouched');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ── B. Structural pin: adjust steppers (class-swap) ────────────────────────
const twoBoxes = () => writeRepo({
  'index.html': `<html><body>\n<section id="top"><div class="box p-4">A</div></section>\n<section id="bottom"><div class="box p-4">B</div></section>\n</body></html>`,
});
const boxPath = (which: 'top' | 'bottom') => [L('div', ['box', 'p-4'], 0, 1, which === 'top' ? 'A' : 'B'), L('section', [], which === 'top' ? 0 : 1, 2, '', which), BODY];
test('class-swap twins in one file: the pinned (2nd) box changes, the 1st does not', () => {
  const repo = twoBoxes();
  try {
    const res = engine.applyStyleEdits(repo, [{ kind: 'class-swap', prop: 'padding', oldToken: 'p-4', newToken: 'p-6', classList: ['box', 'p-4'] }],
      { tagName: 'div', classList: ['box', 'p-4'], path: boxPath('bottom'), preferFile: 'index.html' });
    assert.equal(res.ok, true, `swap failed: ${(res as Partial<StyleEditFailure>).reason}`);
    const out = rd(repo, 'index.html');
    assert.match(out, /id="top"><div class="box p-4">A/, 'first box untouched');
    assert.match(out, /id="bottom"><div class="box p-6">B/, 'second box swapped');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
test('class-swap twins across pages: path + preferFile edits the current page only', () => {
  const repo = writeRepo({
    'a.html': `<html><body><main class="wrap"><div class="box p-4">x</div></main></body></html>`,
    'b.html': `<html><body><main class="wrap"><div class="box p-4">x</div></main></body></html>`,
  });
  try {
    const a0 = rd(repo, 'a.html');
    const res = engine.applyStyleEdits(repo, [{ kind: 'class-swap', prop: 'padding', oldToken: 'p-4', newToken: 'p-6', classList: ['box', 'p-4'] }],
      { tagName: 'div', classList: ['box', 'p-4'], path: [L('div', ['box', 'p-4'], 0, 1, 'x'), MAIN, BODY], preferFile: 'b.html' });
    assert.equal(res.ok, true, (res as Partial<StyleEditFailure>).reason);
    assert.equal((res as StyleEditDone).files[0].relFile, 'b.html', 'edited the current page');
    assert.equal(rd(repo, 'a.html'), a0, 'other page untouched');
    assert.match(rd(repo, 'b.html'), /class="box p-6"/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
test('class-swap inside cn(): the token in the first fragment is swapped (no single needle could find it)', () => {
  const repo = writeRepo({ 'app/page.tsx': `export default function P(){ return (<main className="wrap"><div className={cn("box p-4", active && "ring-2")}>x</div></main>); }` });
  try {
    // The DOM classList is the MERGED result — not a string that exists in source.
    const res = engine.applyStyleEdits(repo, [{ kind: 'class-swap', prop: 'padding', oldToken: 'p-4', newToken: 'p-6', classList: ['box', 'p-4', 'ring-2'] }],
      { tagName: 'div', classList: ['box', 'p-4', 'ring-2'], path: [L('div', ['box', 'p-4', 'ring-2'], 0, 1, 'x'), MAIN, BODY], preferFile: 'app/page.tsx' });
    assert.equal(res.ok, true, `cn() swap failed: ${(res as Partial<StyleEditFailure>).reason}`);
    assert.match(rd(repo, 'app/page.tsx'), /cn\("box p-6", active && "ring-2"\)/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
test('class-add + inline via the pin land in the same open tag', () => {
  const repo = writeRepo({ 'index.html': `<html><body><main class="wrap"><div class="box" style="padding-top: 8px; color: red">x</div></main></body></html>` });
  try {
    const res = engine.applyStyleEdits(repo, [{ kind: 'class-add', prop: 'margin', newToken: 'mt-4', classList: ['box'] }, { kind: 'inline', prop: 'padding-top', to: '24px', styleAttr: 'padding-top: 8px; color: red' }],
      { tagName: 'div', classList: ['box'], path: [L('div', ['box'], 0, 1, 'x'), MAIN, BODY], preferFile: 'index.html' });
    assert.equal(res.ok, true, (res as Partial<StyleEditFailure>).reason);
    assert.match(rd(repo, 'index.html'), /<div class="box mt-4" style="padding-top: 24px; color: red">x<\/div>/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ── C. Structural pin: text edits ──────────────────────────────────────────
test('text twins in one file: the pinned (2nd) paragraph is edited, the 1st keeps its copy', () => {
  const repo = writeRepo({ 'index.html': `<html><body>\n<section id="top"><p class="lead">Generic AI fails here.</p></section>\n<section id="bottom"><p class="lead">Generic AI fails here.</p></section>\n</body></html>` });
  try {
    const res = engine.applyTextEdit(repo, { originalText: 'Generic AI fails here.', newText: 'Generic AI fails here. This one does not.',
      context: { tagName: 'p', classList: ['lead'], path: [L('p', ['lead'], 0, 1, 'Generic AI fails here.'), L('section', [], 1, 2, '', 'bottom'), BODY], preferFile: 'index.html' } });
    assert.equal(res.ok, true, `text edit failed: ${(res as Partial<TextEditFailure>).reason}`);
    assert.equal((res as TextEditDone).strategy, 'structural');
    const out = rd(repo, 'index.html');
    assert.match(out, /id="top"><p class="lead">Generic AI fails here\.<\/p>/, 'first untouched');
    assert.match(out, /id="bottom"><p class="lead">Generic AI fails here\. This one does not\.<\/p>/, 'second edited');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
test('text twins across pages: path + preferFile edits only the current page', () => {
  const repo = writeRepo({
    'a.html': `<html><body><main class="wrap"><a class="cta" href="/x">Send the room</a></main></body></html>`,
    'b.html': `<html><body><main class="wrap"><a class="cta" href="/x">Send the room</a></main></body></html>`,
  });
  try {
    const a0 = rd(repo, 'a.html');
    const res = engine.applyTextEdit(repo, { originalText: 'Send the room', newText: 'Send the whole room',
      context: { tagName: 'a', classList: ['cta'], path: [L('a', ['cta'], 0, 1, 'Send the room'), MAIN, BODY], preferFile: 'b.html' } });
    assert.equal(res.ok, true, (res as Partial<TextEditFailure>).reason);
    assert.equal((res as TextEditDone).relFile, 'b.html');
    assert.equal(rd(repo, 'a.html'), a0);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
test('no path (legacy caller): text edit still works on a unique occurrence', () => {
  const repo = writeRepo({ 'index.html': `<html><body><h1 class="t">Only once</h1></body></html>` });
  try {
    const res = engine.applyTextEdit(repo, { originalText: 'Only once', newText: 'Only once, edited', context: { tagName: 'h1', classList: ['t'] } });
    assert.equal(res.ok, true, (res as Partial<TextEditFailure>).reason);
    assert.equal((res as TextEditDone).strategy, 'unique');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ── D. the overlay's `twins` signal + page scope ───────────────────────────
test('twins signal: a component root rendered 3× (twins 3) is refused; a unique static section whose DOM count spans layout+page (twins 1) resolves', () => {
  const repo = writeRepo({
    'app/page.tsx': `import { Card } from "./card";\nexport default function P(){ return (<main className="wrap"><section className="grid"><Card /><Card /><Card /></section></main>); }`,
    'app/card.tsx': `export function Card(){ return (<div className="card p-4"></div>); }`,
  });
  try {
    const bad = insert.applyInsert(repo, { anchor: { tagName: 'div', path: [{ ...L('div', ['card', 'p-4'], 1, 3), twins: 3 }, L('section', ['grid'], 0, 1), MAIN, BODY] }, position: 'after', markup: '<p class="m">m</p>', preferFile: 'app/page.tsx' });
    assert.equal(bad.ok, false, 'three identical DOM copies of one source node = a template');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  const repo2 = writeRepo({
    'src/layouts/Base.astro': `---\n---\n<html><body><slot /><section class="footer-cta"><p>cta</p></section></body></html>`,
    'src/pages/index.astro': `---\nimport Base from "../layouts/Base.astro";\n---\n<Base>\n  <section class="hero"><h1>H</h1></section>\n  <section class="features"><h2>F</h2></section>\n  <section class="pricing"><h2>P</h2></section>\n</Base>`,
  });
  try {
    // DOM: 4 sections under body (3 from the page + 1 from the layout); this one is unique by class (twins 1).
    const ok = insert.applyInsert(repo2, { anchor: { tagName: 'section', path: [{ ...L('section', ['features'], 1, 4), twins: 1 }, L('body', [], 0, 1)] }, position: 'after', markup: '<section class="new">n</section>', preferFile: 'src/pages/index.astro' });
    assert.equal(ok.ok, true, `a unique static section must resolve despite the split count: ${(ok as Partial<StructuralEditFailure>).reason}`);
    assert.equal((ok as StructuralEditDone).relFile, 'src/pages/index.astro');
  } finally { fs.rmSync(repo2, { recursive: true, force: true }); }
});
test('page scope: a legacy (no-path) needle present in two pages edits the current page, never the other', () => {
  const repo = writeRepo({ 'a.html': `<html><body><div class="box p-4">x</div></body></html>`, 'b.html': `<html><body><div class="box p-4">x</div></body></html>` });
  try {
    const res = engine.applyStyleEdits(repo, [{ kind: 'class-swap', prop: 'padding', oldToken: 'p-4', newToken: 'p-6', classList: ['box', 'p-4'] }], { tagName: 'div', classList: ['box', 'p-4'], preferFile: 'b.html' });
    assert.equal(res.ok, true, (res as Partial<StyleEditFailure>).reason);
    assert.equal((res as StyleEditDone).files[0].relFile, 'b.html');
    assert.match(rd(repo, 'a.html'), /p-4/, 'other page untouched');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
test('path present but unpinnable (DOM says 3, source has 2 identical twins) → honest ambiguous, never a scored guess', () => {
  const repo = writeRepo({ 'index.html': `<html><body><section class="grid"><div class="box p-4">x</div><div class="box p-4">x</div></section></body></html>` });
  try {
    const before = rd(repo, 'index.html');
    const res = engine.applyStyleEdits(repo, [{ kind: 'class-swap', prop: 'padding', oldToken: 'p-4', newToken: 'p-6', classList: ['box', 'p-4'] }],
      { tagName: 'div', classList: ['box', 'p-4'], path: [{ ...L('div', ['box', 'p-4'], 2, 3), twins: 3 }, L('section', ['grid'], 0, 1), BODY], preferFile: 'index.html' });
    assert.equal(res.ok, false);
    assert.equal((res as StyleEditFailure).reason, 'class-ambiguous');
    assert.equal(rd(repo, 'index.html'), before, 'nothing written');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ── E. attribute edits (alt) pin the element's OPEN TAG ───────────────────
test('alt text twins: the pinned <img> gets the new alt, its twin on another page does not', () => {
  const repo = writeRepo({
    'a.html': `<html><body><main class="wrap"><img class="hero" src="/x.png" alt="Editor screenshot"></main></body></html>`,
    'b.html': `<html><body><main class="wrap"><img class="hero" src="/x.png" alt="Editor screenshot"></main></body></html>`,
  });
  try {
    const a0 = rd(repo, 'a.html');
    const res = engine.applyTextEdit(repo, { originalText: 'Editor screenshot', newText: 'The Radial editor', context: { attribute: 'alt', tagName: 'img', src: '/x.png', path: [L('img', ['hero'], 0, 1), MAIN, BODY], preferFile: 'b.html' } });
    assert.equal(res.ok, true, (res as Partial<TextEditFailure>).reason);
    assert.equal((res as TextEditDone).strategy, 'structural');
    assert.equal((res as TextEditDone).relFile, 'b.html');
    assert.match(rd(repo, 'b.html'), /alt="The Radial editor"/);
    assert.equal(rd(repo, 'a.html'), a0, 'other page untouched');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ── F. a hidden twin whose parents contradict the page (ported from Radial Cloud) ──
// A nav rendered from a list on desktop (invisible to the scanner: it's inside
// `{…}`), with the mobile menu's copy written out. The only source match for a
// desktop link is then the hidden mobile copy, under the wrong parents. Paths
// are what the overlay sends.
const NAV = (links: string[]) => `const links = [${links.map((l) => `'${l}'`).join(', ')}];
export function Header() {
  return (
    <header className="site">
      <nav className="hidden md:flex">
        {links.map((link) => <a className="link" href={'/' + link.toLowerCase()}>{link}</a>)}
      </nav>
      <div className="mobile md:hidden">
        <a className="link" href="/pricing">Pricing</a>
      </div>
    </header>
  );
}
`;
const level = (tag: string, cls: string[], extra: Partial<ElementPathLevel> = {}): ElementPathLevel => ({ tag, id: null, cls, own: '', nth: 0, cnt: 1, twins: 1, src: null, href: null, alt: null, ariaLabel: null, placeholder: null, ...extra });
const desktopLink = (cnt: number) => [level('a', ['link'], { own: 'Pricing', cnt, twins: cnt, href: '/pricing' }), level('nav', ['hidden', 'md:flex']), level('header', ['site']), level('body', [])];
const mobileLink = [level('a', ['link'], { own: 'Pricing', href: '/pricing' }), level('div', ['mobile', 'md:hidden']), level('header', ['site']), level('body', [])];

test('hidden twin: the visible link (from a list) never edits the hidden mobile copy', () => {
  const source = NAV(['Pricing', 'About']);
  const repo = writeRepo({ 'Header.tsx': source });
  const res = engine.applyTextEdit(repo, { originalText: 'Pricing', newText: 'Plans', context: { path: desktopLink(2), tagName: 'a', classList: ['link'] } });
  assert.equal(res.ok, false, 'it should not pick a copy it can’t be sure of');
  assert.equal(rd(repo, 'Header.tsx'), source);
});

test('hidden twin: a list of one never makes the hidden copy the anchor, for text, adjust or insert', () => {
  // The desktop link is the only <a> under its <nav> (cnt 1), so the hidden
  // copy, unique in source, used to be taken as the element itself.
  const source = NAV(['Pricing']);
  const repo = writeRepo({ 'Header.tsx': source });
  const ctx = { path: desktopLink(1), tagName: 'a', classList: ['link'] };
  const text = engine.applyTextEdit(repo, { originalText: 'Pricing', newText: 'Plans', context: ctx });
  assert.equal(text.ok, false, `text: ${JSON.stringify(text)}`);
  const swap = engine.applyStyleEdits(repo, [{ kind: 'class-swap', prop: 'padding', oldToken: 'link', newToken: 'link-lg', classList: ['link'] }], ctx);
  assert.equal(swap.ok, false, 'adjust');
  const ins = insert.applyInsert(repo, { anchor: ctx, position: 'after', markup: '<span class="new">new</span>' });
  assert.equal(ins.ok, false, 'insert');
  assert.equal(rd(repo, 'Header.tsx'), source, 'nothing written');
});

test('hidden twin: the mobile copy itself still edits, and only it', () => {
  const repo = writeRepo({ 'Header.tsx': NAV(['Pricing', 'About']) });
  const res = engine.applyTextEdit(repo, { originalText: 'Pricing', newText: 'Plans', context: { path: mobileLink, tagName: 'a', classList: ['link'] } });
  assert.equal(res.ok, true, (res as Partial<TextEditFailure>).reason);
  const out = rd(repo, 'Header.tsx');
  assert.match(out, /<a className="link" href="\/pricing">Plans<\/a>/);
  assert.match(out, /const links = \['Pricing', 'About'\]/);
});

test('hidden twin check: an element a <Link> wraps still pins (the scanner reads <Link> as a void <link>)', () => {
  // The DOM shows the Link as an <a>; the scanner records the span beside the
  // Link, under the <div>. Cloud's check took that for a contradiction.
  const source = `import Link from 'next/link';
export function Footer() {
  return (
    <footer className="site-footer">
      <div className="cta-row">
        <Link href="/signup" className="btn">
          <span className="btn-label p-2">Start your free trial</span>
        </Link>
      </div>
    </footer>
  );
}
`;
  const repo = writeRepo({ 'Footer.tsx': source });
  const ctx = { tagName: 'span', classList: ['btn-label', 'p-2'], path: [level('span', ['btn-label', 'p-2'], { own: 'Start your free trial' }), level('a', ['btn'], { href: '/signup' }), level('div', ['cta-row']), level('footer', ['site-footer']), level('body', [])] };
  const ins = insert.applyInsert(repo, { anchor: ctx, position: 'after', markup: '<span class="note">No card needed</span>', preferFile: 'Footer.tsx' });
  assert.equal(ins.ok, true, (ins as Partial<StructuralEditFailure>).reason);
  assert.match(rd(repo, 'Footer.tsx'), /Start your free trial<\/span>\s*<span className="note">No card needed<\/span>\s*<\/Link>/);
});

test('hidden twin check: a Vue component’s <template> and kebab-case components are not parents the page can contradict', () => {
  const repo = writeRepo({
    'Hero.vue': '<template>\n  <section class="hero">\n    <h2 class="title">Fresh every day</h2>\n  </section>\n</template>\n',
    'Notes.vue': '<template>\n  <main class="notes">\n    <base-card class="card">\n      <p class="note">Open late tonight</p>\n    </base-card>\n  </main>\n</template>\n',
  });
  const hero = insert.applyInsert(repo, { anchor: { tagName: 'h2', path: [level('h2', ['title'], { own: 'Fresh every day' }), level('section', ['hero']), level('main', []), level('body', [])] }, position: 'after', markup: '<p class="sub">Baked here</p>', preferFile: 'Hero.vue' });
  assert.equal(hero.ok, true, (hero as Partial<StructuralEditFailure>).reason);
  assert.match(rd(repo, 'Hero.vue'), /Fresh every day<\/h2>\s*<p class="sub">Baked here<\/p>/);
  // <base-card> renders a <div class="card"> in the DOM.
  const note = insert.applyInsert(repo, { anchor: { tagName: 'p', path: [level('p', ['note'], { own: 'Open late tonight' }), level('div', ['card']), level('main', ['notes']), level('body', [])] }, position: 'after', markup: '<p class="note">Closed on Monday</p>', preferFile: 'Notes.vue' });
  assert.equal(note.ok, true, (note as Partial<StructuralEditFailure>).reason);
  assert.match(rd(repo, 'Notes.vue'), /Open late tonight<\/p>\s*<p class="note">Closed on Monday<\/p>/);
});

test('hidden twin: of two written-out copies, the clicked one is edited', () => {
  const both = NAV(['Pricing', 'About']).replace("{links.map((link) => <a className=\"link\" href={'/' + link.toLowerCase()}>{link}</a>)}", '<a className="link" href="/pricing">Pricing</a>');
  const repo = writeRepo({ 'Header.tsx': both });
  const res = engine.applyTextEdit(repo, { originalText: 'Pricing', newText: 'Plans', context: { path: desktopLink(1), tagName: 'a', classList: ['link'] } });
  assert.equal(res.ok, true, (res as Partial<TextEditFailure>).reason);
  const out = rd(repo, 'Header.tsx');
  assert.match(out, /<nav className="hidden md:flex">\s*<a className="link" href="\/pricing">Plans<\/a>/);
  assert.match(out, /<div className="mobile md:hidden">\s*<a className="link" href="\/pricing">Pricing<\/a>/);
});
