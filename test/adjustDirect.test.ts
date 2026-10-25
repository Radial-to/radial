import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import { plan, twTokenFor } from '../src/renderer/adjustDirect';
import * as editEngine from '../src/main/editEngine';
import type { PlanSelection, StylePlan, StylePlanResult, StyleSource } from '../src/renderer/adjustDirect';
import type { StyleEditDone, StyleEditOutcome } from '../src/main/editEngine';
import type { ElementContext, ElementPathLevel } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

/** plan() when it found plans: each test asserts ok before reading them. */
type Planned = Extract<StylePlanResult, { ok: true }>;
/** applyStyleEdits when it wrote nothing. */
type StyleEditFailure = Exclude<StyleEditOutcome, { ok: true }>;

const sel = (classList: string[], styleSource: StyleSource = {}): PlanSelection => ({
  classList,
  styleSource: { styleAttr: '', rules: [], tw: true, ...styleSource },
});

// ── planning ────────────────────────────────────────────────────────────────

test('the motivating case: +48px bottom padding is a pb token swap', () => {
  const r = plan(
    { 'padding-bottom': { from: '32px', to: '48px' } },
    sel(['flex', 'pb-8', 'pt-4'])
  ) as Planned;
  assert.equal(r.ok, true);
  assert.deepEqual(r.plans, [{ kind: 'class-swap', prop: 'padding-bottom', oldToken: 'pb-8', newToken: 'pb-12', classList: ['flex', 'pb-8', 'pt-4'] }]);
});

test('twTokenFor maps the standard scales', () => {
  assert.equal(twTokenFor('padding-bottom', '48px'), 'pb-12');
  assert.equal(twTokenFor('margin-top', '0px'), 'mt-0');
  assert.equal(twTokenFor('gap', '24px'), 'gap-6');
  assert.equal(twTokenFor('font-size', '30px'), 'text-3xl');
  assert.equal(twTokenFor('font-weight', '600'), 'font-semibold');
  assert.equal(twTokenFor('border-radius', '8px'), 'rounded-lg');
  assert.equal(twTokenFor('border-radius', '4px'), 'rounded');
  assert.equal(twTokenFor('justify-content', 'center'), 'justify-center');
  assert.equal(twTokenFor('padding-bottom', '47px'), null); // off scale
});

test('missing utility gets ADDED when the page speaks Tailwind and nothing else supplies it', () => {
  const r = plan({ 'padding-bottom': { from: '0px', to: '48px' } }, sel(['flex', 'items-center'])) as Planned;
  assert.equal(r.ok, true);
  assert.deepEqual(r.plans[0], { kind: 'class-add', prop: 'padding-bottom', newToken: 'pb-12', classList: ['flex', 'items-center'] });
});

test('shorthands, variants and arbitrary values all still write deterministically (never the agent)', () => {
  // py-8 covers the bottom: ADD the longhand — Tailwind orders longhands after shorthands, so pb-12 wins.
  assert.deepEqual((plan({ 'padding-bottom': { from: '32px', to: '48px' } }, sel(['py-8'])) as Planned).plans[0], { kind: 'class-add', prop: 'padding-bottom', newToken: 'pb-12', classList: ['py-8'] });
  // At desktop the md: variant is the value on screen — swap THAT token.
  assert.deepEqual((plan({ 'padding-bottom': { from: '64px', to: '48px' } }, sel(['pb-8', 'md:pb-16'])) as Planned).plans[0], { kind: 'class-swap', prop: 'padding-bottom', oldToken: 'md:pb-16', newToken: 'md:pb-12', classList: ['pb-8', 'md:pb-16'] });
  // An arbitrary own token swaps like any other; an off-scale target becomes an arbitrary token.
  assert.deepEqual((plan({ 'padding-bottom': { from: '33px', to: '48px' } }, sel(['pb-[33px]'])) as Planned).plans[0], { kind: 'class-swap', prop: 'padding-bottom', oldToken: 'pb-[33px]', newToken: 'pb-12', classList: ['pb-[33px]'] });
  assert.deepEqual((plan({ 'padding-bottom': { from: '32px', to: '13px' } }, sel(['pb-8'])) as Planned).plans[0], { kind: 'class-swap', prop: 'padding-bottom', oldToken: 'pb-8', newToken: 'pb-[13px]', classList: ['pb-8'] });
  // Per-corner radius can't be expressed as one token — the element takes it inline (terminal write).
  assert.deepEqual((plan({ 'border-radius': { from: '8px', to: '12px' } }, sel(['rounded-t-lg'])) as Planned).plans[0], { kind: 'inline-set', prop: 'border-radius', value: '12px' });
});

test('inline style beats everything and off-scale values are fine there', () => {
  const s = sel(['pb-8'], { styleAttr: 'padding-bottom: 33px; color: red' });
  const r = plan({ 'padding-bottom': { from: '33px', to: '47px' } }, s) as Planned;
  assert.equal(r.ok, true);
  assert.equal(r.plans[0].kind, 'inline');
  assert.equal((r.plans[0] as Extract<StylePlan, { kind: 'inline' }>).to, '47px');
});

test('one plain CSS rule in px from a source stylesheet is plannable; hashed bundles are not', () => {
  const rules = [{ prop: 'padding-bottom', value: '32px', selectorText: '.hero', href: '/styles.css' }];
  const r = plan({ 'padding-bottom': { from: '32px', to: '48px' } }, sel([], { tw: false, rules })) as Planned;
  assert.equal(r.ok, true);
  assert.deepEqual(r.plans[0], { kind: 'css', prop: 'padding-bottom', to: '48px', from: '32px', selectorText: '.hero', href: '/styles.css' });

  // A bundler-hashed stylesheet isn't source — the element takes the value inline instead.
  const hashed = [{ prop: 'padding-bottom', value: '32px', selectorText: '.hero', href: '/assets/index-a1b2c3d4.css' }];
  assert.deepEqual((plan({ 'padding-bottom': { from: '32px', to: '48px' } }, sel([], { tw: false, rules: hashed })) as Planned).plans[0], { kind: 'inline-set', prop: 'padding-bottom', value: '48px' });

  // The reported case: the authored rule is in rem — write the new value in the author's unit.
  const remRule = [{ prop: 'padding-bottom', value: '2rem', selectorText: '.hero', href: '/styles.css' }];
  assert.deepEqual((plan({ 'padding-bottom': { from: '32px', to: '48px' } }, sel([], { tw: false, rules: remRule, rootPx: 16 })) as Planned).plans[0], { kind: 'css-set', prop: 'padding-bottom', value: '3rem', selectorText: '.hero', href: '/styles.css' });
  // em is relative to the element's own font size.
  const emRule = [{ prop: 'padding-top', value: '0.5em', selectorText: '.lead', href: '/styles.css' }];
  const r2 = plan({ 'padding-top': { from: '10px', to: '15px' } }, { classList: [], adjust: { fontSize: 20 }, styleSource: { styleAttr: '', rules: emRule, tw: false, rootPx: 16 } }) as Planned;
  assert.deepEqual(r2.plans[0], { kind: 'css-set', prop: 'padding-top', value: '0.75em', selectorText: '.lead', href: '/styles.css' });
});

test('nothing plannable in the old sense now ends at the element itself (inline-set), never the agent', () => {
  const r = plan({ 'padding-bottom': { from: '32px', to: '48px' } }, sel([], { tw: false, rules: [] })) as Planned;
  assert.equal(r.ok, true);
  assert.deepEqual(r.plans[0], { kind: 'inline-set', prop: 'padding-bottom', value: '48px' });
  // Only "already expressed" is a non-plan.
  assert.equal(plan({}, sel([])).ok, false);
});

test('a mixed batch plans together (swap + add + align)', () => {
  const r = plan({
    'padding-bottom': { from: '32px', to: '48px' },
    'gap': { from: '0px', to: '24px' },
    'justify-content': { from: 'flex-start', to: 'center' },
  }, sel(['flex', 'pb-8', 'justify-start'])) as Planned;
  assert.equal(r.ok, true);
  assert.equal(r.plans.length, 3);
  assert.deepEqual(r.plans.map((p) => p.kind).sort(), ['class-add', 'class-swap', 'class-swap']);
});

// ── locating + writing (editEngine.applyStyleEdits) ────────────────────────

function repo(files: Record<string, string>) {
  const dir = tmpDir('radial-adj-');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');

test('class-swap rewrites the token inside the located class attribute', () => {
  const dir = repo({ 'index.html': '<section class="hero flex pb-8 pt-4"><h1>Hi</h1></section>' });
  const r = editEngine.applyStyleEdits(dir, [
    { kind: 'class-swap', prop: 'padding-bottom', oldToken: 'pb-8', newToken: 'pb-12', classList: ['hero', 'flex', 'pb-8', 'pt-4'] },
  ], { tagName: 'section' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(read(dir, 'index.html'), /class="hero flex pb-12 pt-4"/);
});

test('batched swaps + adds land in one pass, JSX multiline class strings included', () => {
  const dir = repo({
    'src/Hero.jsx': '<div className="hero flex\n  pb-8 pt-4">\n  <p>x</p>\n</div>',
  });
  const r = editEngine.applyStyleEdits(dir, [
    { kind: 'class-swap', prop: 'padding-bottom', oldToken: 'pb-8', newToken: 'pb-12', classList: ['hero', 'flex', 'pb-8', 'pt-4'] },
    { kind: 'class-add', prop: 'gap', newToken: 'gap-6', classList: ['hero', 'flex', 'pb-8', 'pt-4'] },
  ], {});
  assert.equal(r.ok, true, JSON.stringify(r));
  const out = read(dir, 'src/Hero.jsx');
  assert.match(out, /pb-12/);
  assert.match(out, /gap-6/);
  assert.doesNotMatch(out, /pb-8/);
});

test('identical elements are ambiguous and refuse to write (agent decides scope)', () => {
  const dir = repo({
    'index.html': '<div class="card pb-8">a</div><div class="card pb-8">b</div>',
  });
  const r = editEngine.applyStyleEdits(dir, [
    { kind: 'class-swap', prop: 'padding-bottom', oldToken: 'pb-8', newToken: 'pb-12', classList: ['card', 'pb-8'] },
  ], {});
  assert.equal(r.ok, false);
  assert.match((r as StyleEditFailure).reason, /ambiguous/);
});

test('inline style declaration swap', () => {
  const dir = repo({ 'index.html': '<div id="x" style="padding-bottom: 33px; color: red">y</div>' });
  const r = editEngine.applyStyleEdits(dir, [
    { kind: 'inline', prop: 'padding-bottom', to: '47px', styleAttr: 'padding-bottom: 33px; color: red' },
  ], { id: 'x' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(read(dir, 'index.html'), /style="padding-bottom: 47px; color: red"/);
});

test('css rule declaration rewrites in the repo stylesheet', () => {
  const dir = repo({
    'styles.css': '.other { padding-bottom: 32px }\n.hero { color: red; padding-bottom: 32px; }\n',
  });
  const r = editEngine.applyStyleEdits(dir, [
    { kind: 'css', prop: 'padding-bottom', to: '48px', from: '32px', selectorText: '.hero', href: '/styles.css' },
  ], {});
  assert.equal(r.ok, true, JSON.stringify(r));
  const out = read(dir, 'styles.css');
  assert.match(out, /\.hero \{ color: red; padding-bottom: 48px; \}/);
  assert.match(out, /\.other \{ padding-bottom: 32px \}/); // untouched
});

test('all-or-nothing: one failing plan writes nothing', () => {
  const dir = repo({ 'index.html': '<div class="hero pb-8">x</div>' });
  const before = read(dir, 'index.html');
  const r = editEngine.applyStyleEdits(dir, [
    { kind: 'class-swap', prop: 'padding-bottom', oldToken: 'pb-8', newToken: 'pb-12', classList: ['hero', 'pb-8'] },
    { kind: 'css', prop: 'gap', to: '24px', from: '0px', selectorText: '.hero', href: '/missing.css' },
  ], {});
  assert.equal(r.ok, false);
  assert.equal(read(dir, 'index.html'), before);
});

test('applyStyleEdits result carries what recordEdit needs for undo', () => {
  const dir = repo({ 'index.html': '<div class="hero pb-8">x</div>' });
  const r = editEngine.applyStyleEdits(dir, [
    { kind: 'class-swap', prop: 'padding-bottom', oldToken: 'pb-8', newToken: 'pb-12', classList: ['hero', 'pb-8'] },
  ], {});
  assert.equal(r.ok, true);
  const f = (r as StyleEditDone).files[0];
  assert.equal(f.relFile, 'index.html');
  assert.match(f.prevContent, /pb-8/);
  assert.match(f.newContent, /pb-12/);
});

// ── the ladder's remaining rungs ─────────────────────────────────────────────
test('many rules: the rule that WINS is edited — active media rule first, then specificity, then source order', () => {
  const rules = [
    { prop: 'padding-top', value: '8px', selectorText: '.hero-aside', href: '/styles.css' },
    { prop: 'padding-top', value: '12px', selectorText: '.content .hero-aside', href: '/styles.css' }, // more specific → wins
    { prop: 'padding-top', value: '4px', selectorText: '.aside', href: '/styles.css' },
  ];
  let r = plan({ 'padding-top': { from: '12px', to: '16px' } }, sel([], { tw: false, rules })) as Planned;
  assert.deepEqual(r.plans[0], { kind: 'css', prop: 'padding-top', to: '16px', from: '12px', selectorText: '.content .hero-aside', href: '/styles.css' });
  // An ACTIVE media rule overrides base at this viewport → write into that @media block.
  const mediaRules = [{ prop: 'padding-top', value: '6px', selectorText: '.hero-aside', href: '/styles.css', media: '(max-width: 640px)', active: true, maxW: 640, minW: null }];
  r = plan({ 'padding-top': { from: '6px', to: '16px' } }, sel([], { tw: false, rules, mediaRules })) as Planned;
  assert.deepEqual(r.plans[0], { kind: 'css-set-media', prop: 'padding-top', value: '16px', selectorText: '.hero-aside', href: '/styles.css', media: '(max-width: 640px)' });
  // An inactive media rule is ignored.
  r = plan({ 'padding-top': { from: '12px', to: '16px' } }, sel([], { tw: false, rules, mediaRules: [{ ...mediaRules[0], active: false }] })) as Planned;
  assert.equal((r.plans[0] as Extract<StylePlan, { selectorText: string }>).selectorText, '.content .hero-aside');
});

test('nothing authored and no anchor: the element itself takes the value (inline-set) — a px delta is never unplannable', () => {
  const r = plan({ 'padding-top': { from: '8px', to: '16px' } }, sel([], { tw: false, rules: [], _full: true })) as Planned;
  assert.deepEqual(r.plans, [{ kind: 'inline-set', prop: 'padding-top', value: '16px' }]);
  // With a resolved anchor rule the declaration lands in the element's own rule instead.
  const r2 = plan({ 'padding-top': { from: '8px', to: '16px' } }, { classList: [], anchor: { selectorText: '.hero-aside', href: '/styles.css' }, styleSource: { styleAttr: '', rules: [], tw: false, _full: true } }) as Planned;
  assert.deepEqual(r2.plans[0], { kind: 'css-set', prop: 'padding-top', value: '16px', selectorText: '.hero-aside', href: '/styles.css' });
});

test('unitize + specificity helpers', () => {
  const { unitize, specificity } = require('../src/renderer/adjustDirect') as typeof import('../src/renderer/adjustDirect');
  assert.equal(unitize('24px', '1rem', { rootPx: 16 }), '1.5rem');
  assert.equal(unitize('16px', '1rem', { rootPx: 16 }), '1rem');
  assert.equal(unitize('10px', '1rem', { rootPx: 16 }), '0.625rem');
  assert.equal(unitize('16px', '50%', {}), '16px');
  assert.ok(specificity('#a .b') > specificity('.a .b') && specificity('.a .b') > specificity('.a') && specificity('.a') > specificity('div'));
});

// ── engine: the inline-set terminal write, through the structural pin ────────
const fs2 = require('fs') as typeof import('fs'), os2 = require('os') as typeof import('os'), path2 = require('path') as typeof import('path');
function repo2(files: Record<string, string>) { const d = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'iset-')); for (const [rel, c] of Object.entries(files)) { const f = path2.join(d, rel); fs2.mkdirSync(path2.dirname(f), { recursive: true }); fs2.writeFileSync(f, c); } return d; }
const lvl = (tag: string, cls: string[], own = '', id: string | null = null, nth = 0, cnt = 1): ElementPathLevel => ({ tag, id, cls, own, nth, cnt });
const leaf = (cls: string[], own: string, nth: number) => lvl('div', cls, own, null, nth, 3); // one of three sibling divs
test('inline-set: creates, appends to, and replaces within style="…" on the pinned element (HTML)', () => {
  const repo = repo2({ 'index.html': '<html><body><main class="wrap"><div class="hero-aside">x</div><div class="box-b" style="color: red">y</div><div class="box-c" style="padding-top: 8px; color: red">z</div></main></body></html>' });
  try {
    const ctx = (cls: string[], own: string, nth: number): ElementContext => ({ tagName: 'div', classList: cls, path: [leaf(cls, own, nth), lvl('main', ['wrap']), lvl('body', [])], preferFile: 'index.html' });
    let r = editEngine.applyStyleEdits(repo, [{ kind: 'inline-set', prop: 'padding-top', value: '16px' }], ctx(['hero-aside'], 'x', 0));
    assert.equal(r.ok, true, (r as Partial<StyleEditFailure>).reason);
    assert.match(fs2.readFileSync(path2.join(repo, 'index.html'), 'utf8'), /<div class="hero-aside" style="padding-top: 16px">x<\/div>/);
    r = editEngine.applyStyleEdits(repo, [{ kind: 'inline-set', prop: 'padding-top', value: '16px' }], ctx(['box-b'], 'y', 1));
    assert.equal(r.ok, true, (r as Partial<StyleEditFailure>).reason);
    assert.match(fs2.readFileSync(path2.join(repo, 'index.html'), 'utf8'), /<div class="box-b" style="color: red; padding-top: 16px">y<\/div>/);
    r = editEngine.applyStyleEdits(repo, [{ kind: 'inline-set', prop: 'padding-top', value: '16px' }], ctx(['box-c'], 'z', 2));
    assert.equal(r.ok, true, (r as Partial<StyleEditFailure>).reason);
    assert.match(fs2.readFileSync(path2.join(repo, 'index.html'), 'utf8'), /<div class="box-c" style="padding-top: 16px; color: red">z<\/div>/);
  } finally { fs2.rmSync(repo, { recursive: true, force: true }); }
});
test('inline-set: JSX style={{ … }} object — create, insert, replace', () => {
  const repo = repo2({ 'app/page.tsx': 'export default function P(){ return (<main className="wrap"><div className="card-a">x</div><div className="card-b" style={{ color: "red" }}>y</div><div className="card-c" style={{ paddingTop: 8, color: "red" }}>z</div></main>); }' });
  try {
    const ctx = (cls: string[], own: string, nth: number): ElementContext => ({ tagName: 'div', classList: cls, path: [leaf(cls, own, nth), lvl('main', ['wrap']), lvl('body', [])], preferFile: 'app/page.tsx' });
    let r = editEngine.applyStyleEdits(repo, [{ kind: 'inline-set', prop: 'padding-top', value: '16px' }], ctx(['card-a'], 'x', 0));
    assert.equal(r.ok, true, (r as Partial<StyleEditFailure>).reason);
    let out = fs2.readFileSync(path2.join(repo, 'app/page.tsx'), 'utf8');
    assert.match(out, /<div className="card-a" style=\{\{ paddingTop: '16px' \}\}>x/);
    r = editEngine.applyStyleEdits(repo, [{ kind: 'inline-set', prop: 'padding-top', value: '16px' }], ctx(['card-b'], 'y', 1));
    assert.equal(r.ok, true, (r as Partial<StyleEditFailure>).reason);
    out = fs2.readFileSync(path2.join(repo, 'app/page.tsx'), 'utf8');
    assert.match(out, /<div className="card-b" style=\{\{ color: "red", paddingTop: '16px' \}\}>y/);
    r = editEngine.applyStyleEdits(repo, [{ kind: 'inline-set', prop: 'padding-top', value: '16px' }], ctx(['card-c'], 'z', 2));
    assert.equal(r.ok, true, (r as Partial<StyleEditFailure>).reason);
    out = fs2.readFileSync(path2.join(repo, 'app/page.tsx'), 'utf8');
    assert.match(out, /<div className="card-c" style=\{\{ paddingTop: '16px', color: "red" \}\}>z/);
  } finally { fs2.rmSync(repo, { recursive: true, force: true }); }
});
test('inline-set without a pin is refused (never a needle guess)', () => {
  const repo = repo2({ 'index.html': '<html><body><div class="a">x</div></body></html>' });
  try { assert.equal((editEngine.applyStyleEdits(repo, [{ kind: 'inline-set', prop: 'padding-top', value: '16px' }], { tagName: 'div', classList: ['a'] }) as StyleEditFailure).reason, 'inline-set-needs-pin'); }
  finally { fs2.rmSync(repo, { recursive: true, force: true }); }
});
