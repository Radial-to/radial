// Cross-framework reliability for the structural editor. The real-project tests
// prove one Next/TSX site end to end; this
// file generalizes the two things that vary by framework and silently broke the
// direct-edit path until fixed:
//   (1) PARSE HAZARDS — TS/JSX/SFC syntax that a naive tag scanner mistakes for
//       markup and lets swallow the real JSX (comment apostrophes, `Record<K,V>`
//       comma-generics, and single-arg generics `Promise<void>`/`useRef<T>`/
//       `Array<string>` that appear in EVERY TS/React/Vue/Svelte/Astro file).
//   (2) FRAMEWORK PAGE→LAYOUT→COMPONENT SPLIT — the app hands editInsert the
//       ROUTE file as preferFile, but the element lives in a component (and
//       <body> in a layout); resolution must fall back across files.
// These are synthetic-but-representative fixtures (fast, no dev server, no
// network) so they run in the normal `npm test` gate on any machine.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as insert from '../src/main/editInsert';
import { parseNodes } from '../src/main/htmlScan';
import type { HtmlNode, ParsedHtml } from '../src/main/htmlScan';
import type { StructuralEditReadout as Outcome } from './support/structuralEdit';
import { tmpDir } from './support/tmp';

const flat = (t: ParsedHtml) => { const o: HtmlNode[] = []; const w = (ns: HtmlNode[]) => ns.forEach((n) => { o.push(n); w(n.children); }); w(t.roots); return o; };
const tagsOf = (src: string) => flat(parseNodes(src)).map((n) => n.tag);
const reparses = (src: string) => { try { return parseNodes(src).roots.length > 0; } catch { return false; } };
function writeRepo(files: Record<string, string>): string {
  const d = tmpDir('fw-');
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content);
  }
  return d;
}

// ── 1. PARSE HAZARD MATRIX ─────────────────────────────────────────────────
// find: real elements that MUST survive the scan. banned: phantom tags a bad
// scan produces (a generic/comment/comparison read as an element).
const HAZARDS = [
  { n: 'react useRef<HTMLDivElement>', find: ['div', 'h1'], banned: ['htmldivelement'],
    src: `export default function C(){\n  const r = useRef<HTMLDivElement>(null);\n  return (<div className="box"><h1>Hi</h1></div>);\n}` },
  { n: 'react fn : Promise<void>', find: ['article', 'p'], banned: ['void', 'promise'],
    src: `async function go(): Promise<void> {}\nexport default function C(){ return (<article><p>x</p></article>); }` },
  { n: 'react useCallback ()=>Promise<Foo>', find: ['main', 'h2'], banned: ['void', 'foo', 'promise'],
    src: `const f = useCallback(async (): Promise<Foo> => { await x(); }, []);\nexport default function C(){ return (<main><h2>H</h2></main>); }` },
  { n: 'react useState<Item[]>', find: ['section', 'p'], banned: ['item'],
    src: `export default function C(){\n  const [x] = useState<Item[]>([]);\n  return (<section id="s"><p>t</p></section>);\n}` },
  { n: 'ts Record<K, V> comma generic', find: ['div', 'span'], banned: ['string'],
    src: `const m: Record<string, number> = {};\nexport default function C(){ return (<div><span>a</span></div>); }` },
  { n: 'comment apostrophe + content-[\'\']', find: ['section', 'h1'], banned: [],
    src: `export function C(){\n  return (\n    // the section's edge; the hero's cap\n    <section className="after:content-['']"><h1>Hi</h1></section>\n  );\n}` },
  { n: 'jsx text runs into child 5<sup>', find: ['p', 'sup'], banned: [],
    src: `export default function C(){ return (<p>Price 5<sup>th</sup> best</p>); }` },
  { n: 'jsx ternary <A/> : <B/>', find: ['div', 'h1', 'section', 'h2'], banned: [],
    src: `export default function C(){ return cond ? (<div><h1>A</h1></div>) : (<section><h2>B</h2></section>); }` },
  { n: 'astro frontmatter + Array<string> + map', find: ['section', 'h1', 'slot'], banned: ['string'],
    src: `---\nimport Card from "../components/Card.astro";\nconst arr = new Array<string>();\n// items note: it's fine\n---\n<section class="grid">\n  <h1>{title}</h1>\n  {arr.map((i) => <Card label={i} />)}\n  <slot />\n</section>` },
  { n: 'vue script-setup ref<number>/ref<Item[]>', find: ['div', 'h1'], banned: ['number', 'item'],
    src: `<script setup lang="ts">\nconst n = ref<number>(0);\nconst list = ref<Item[]>([]);\n</script>\n<template><div class="wrap"><h1>{{ t }}</h1></div></template>` },
  { n: 'svelte each + Array<string>', find: ['section', 'div'], banned: ['string'],
    src: `<script lang="ts">\n  let items: Array<string> = [];\n</script>\n<section class="list">{#each items as i}<div class="row">{i}</div>{/each}</section>` },
  // ── Corpus-sweep finds (30 real sites): regex literals, division, in-tag comments, dotted JSX ──
  { n: 'regex escapeHtml /"/g + /\'/g before JSX (feed.xml route)', find: ['main', 'p'], banned: [],
    src: 'const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\'/g, "&#39;");\nexport default function C(){ return (<main><p>z</p></main>); }' },
  { n: 'regex class ([\'"]?) before JSX (hero-illustration)', find: ['div', 'span'], banned: [],
    src: 'const url = g.match(/url\\((["\']?)([^"\')]+)\\1\\)/)?.[2];\nexport default function C(){ return (<div><span>w</span></div>); }' },
  { n: 'regex with a literal backtick before JSX (MarkdownMessage)', find: ['article', 'p'], banned: [],
    src: 'const s = t.replace(/^(`{3})\\n/g, "$1");\nexport default function C(){ return (<article><p>v</p></article>); }' },
  { n: 'return /re/.test(x) is a regex, not division', find: ['section', 'h2'], banned: [],
    src: 'function f(x){ return /^a["]b$/.test(x); }\nexport default function C(){ return (<section><h2>y</h2></section>); }' },
  { n: 'division a / b, (a+b) / 2, arr[0] / 2, 10 / 5 stay division', find: ['div', 'p'], banned: [],
    src: 'const r = a / b; const q = (a + b) / 2; const z = arr[0] / 2; const w = 10 / 5;\nexport default function C(){ return (<div><p>x</p></div>); }' },
  { n: 'jsx braces: {count / total} division + {s.replace(/"/g, "")} regex', find: ['div', 'p', 'b'], banned: [],
    src: 'export default function C(){ return (<div><p>{count / total}%</p><p>{s.replace(/"/g, "")}</p><b>k</b></div>); }' },
  { n: 'comment between JSX attributes with an apostrophe (photo-avatar)', find: ['image'], banned: [],
    src: 'export function A(){ return (<Image\n  alt=""\n  className="x"\n  // Explicit box so the reset can\'t\n  // stretch it\n  style={{ a: 1 }}\n  width={1}\n/>); }' },
  { n: 'href=//cdn unquoted is an attribute, not a comment', find: ['a', 'p'], banned: [],
    src: '<a href=//cdn.x/y.js>x</a><p>after</p>' },
  { n: 'dotted JSX: motion.div / m.span / animated.li parse', find: ['motion.div', 'm.span', 'ul', 'animated.li'], banned: [],
    src: 'export default function C(){ return (<motion.div className="a"><m.span>t</m.span><ul><animated.li>i</animated.li></ul></motion.div>); }' },
];

for (const h of HAZARDS) {
  test(`parse: ${h.n} — real elements survive, no phantom`, () => {
    const tags = tagsOf(h.src);
    for (const t of h.find) assert.ok(tags.includes(t), `<${t}> must parse (got [${tags}])`);
    for (const b of h.banned) assert.ok(!tags.includes(b), `phantom <${b}> must NOT appear (got [${tags}])`);
    // Everything the scanner emits must round-trip (no corrupted offsets).
    for (const n of flat(parseNodes(h.src)).filter((x) => x.closeStart != null && x.end - x.openStart < 2000)) {
      const re = parseNodes(h.src.slice(n.openStart, n.end)).roots[0];
      assert.equal(re && re.tag, n.tag, `<${n.tag}> slice should re-parse to itself`);
    }
  });
}

// ── 2. FRAMEWORK SPLIT: route file ≠ the element's file ─────────────────────
// An Astro site: the route composes a component; <body> lives in a layout. The
// app passes preferFile = the ROUTE page; resolution must reach the component.
function astroRepo() {
  return writeRepo({
    'src/pages/index.astro': `---\nimport Base from "../layouts/Base.astro";\nimport Feature from "../components/Feature.astro";\n---\n<Base title="Home">\n  <Feature />\n</Base>`,
    'src/layouts/Base.astro': `---\nconst { title } = Astro.props;\n---\n<html>\n  <body class="page">\n    <slot />\n  </body>\n</html>`,
    'src/components/Feature.astro': `---\nconst items = ["a", "b", "c"];\n---\n<section id="feat" class="features">\n  <h2 class="ft-title">Our features</h2>\n  <ul class="ft-list">\n    {items.map((i) => <li class="ft-item">{i}</li>)}\n  </ul>\n</section>`,
  });
}
// The captured DOM path for the heading (element→body), as the overlay builds
// it: cnts reflect the rendered DOM. Ancestors run up through <body> (a
// DIFFERENT file), which structural descent can't cross — directLocate must.
const H2_PATH = [
  { tag: 'h2', id: null, cls: ['ft-title'], own: 'Our features', nth: 0, cnt: 1 },
  { tag: 'section', id: 'feat', cls: ['features'], own: '', nth: 0, cnt: 1 },
  { tag: 'body', id: null, cls: ['page'], own: '', nth: 0, cnt: 1 },
  { tag: 'html', id: null, cls: [], own: '', nth: 0, cnt: 1 },
];

test('astro split: insert after <h2> with preferFile=ROUTE resolves into the component', () => {
  const repo = astroRepo();
  try {
    const res: Outcome = insert.applyInsert(repo, { anchor: { tagName: 'h2', path: H2_PATH }, position: 'after', markup: '<p class="sub">sub</p>', preferFile: 'src/pages/index.astro' });
    assert.equal(res.ok, true, `insert failed: ${res.reason}`);
    assert.equal(res.relFile, 'src/components/Feature.astro', 'resolved across route→layout→component to the real file');
    const out = fs.readFileSync(path.join(repo, res.relFile!), 'utf8');
    assert.match(out, /class="sub"/, '.astro keeps class= (no className rewrite)');
    assert.doesNotMatch(out, /className=/, 'no JSX className leaked into .astro');
    assert.ok(reparses(out), 'valid .astro after insert');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('astro split: SAFETY — a mapped <li> ({items.map}) is REFUSED, source untouched', () => {
  const repo = astroRepo();
  try {
    // A rendered list item: DOM says one-of-3 (cnt:3); source has one <li> whose
    // own text is `{i}` (a template), so the literal DOM text isn't there.
    const liPath = [
      { tag: 'li', id: null, cls: ['ft-item'], own: 'b', nth: 1, cnt: 3 },
      { tag: 'ul', id: null, cls: ['ft-list'], own: '', nth: 0, cnt: 1 },
      { tag: 'section', id: 'feat', cls: ['features'], own: '', nth: 0, cnt: 1 },
      { tag: 'body', id: null, cls: ['page'], own: '', nth: 0, cnt: 1 },
    ];
    const before = fs.readFileSync(path.join(repo, 'src/components/Feature.astro'), 'utf8');
    const res: Outcome = insert.applyInsert(repo, { anchor: { tagName: 'li', path: liPath }, position: 'after', markup: '<li class="x">x</li>', preferFile: 'src/pages/index.astro' });
    assert.equal(res.ok, false, 'a mapped list item must not resolve');
    assert.ok(['count-mismatch', 'no-anchor', 'unclosed'].includes(res.reason!), `principled refusal, got ${res.reason}`);
    assert.equal(fs.readFileSync(path.join(repo, 'src/components/Feature.astro'), 'utf8'), before, 'source untouched');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('astro split: reorder two literal <li> under one list — count preserved (static list)', () => {
  // A hand-written list (not a .map) reorders deterministically via structural
  // descent from the unique <ul>.
  const repo = writeRepo({
    'src/pages/index.astro': `---\nimport Base from "../layouts/Base.astro";\n---\n<Base>\n  <nav class="menu">\n    <a class="lnk" href="/one">One</a>\n    <a class="lnk" href="/two">Two</a>\n    <a class="lnk" href="/three">Three</a>\n  </nav>\n</Base>`,
    'src/layouts/Base.astro': `---\n---\n<html><body><slot /></body></html>`,
  });
  try {
    const mk = (nth: number, own: string, href: string) => ({ tagName: 'a', path: [
      { tag: 'a', id: null, cls: ['lnk'], own, href, nth, cnt: 3 },
      { tag: 'nav', id: null, cls: ['menu'], own: '', nth: 0, cnt: 1 },
      { tag: 'body', id: null, cls: [], own: '', nth: 0, cnt: 1 },
    ] });
    const res: Outcome = insert.applyMove(repo, { subject: mk(0, 'One', '/one'), target: mk(2, 'Three', '/three'), position: 'after', preferFile: 'src/pages/index.astro' });
    assert.equal(res.ok, true, `move failed: ${res.reason}`);
    const out = fs.readFileSync(path.join(repo, res.relFile!), 'utf8');
    assert.equal((out.match(/<a(?=[\s>])/g) || []).length, 3, 'all three links preserved');
    assert.ok(out.indexOf('/one') > out.indexOf('/two'), 'One moved after Two/Three');
    assert.ok(reparses(out), 'valid .astro after reorder');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ── 3. Vue SFC split (element in a component, <body>-equivalent app shell) ────
test('vue: insert into a component template with preferFile=route resolves + keeps class=', () => {
  const repo = writeRepo({
    'src/App.vue': `<script setup lang="ts">\nimport Panel from "./components/Panel.vue";\n</script>\n<template>\n  <main class="app"><Panel /></main>\n</template>`,
    'src/components/Panel.vue': `<script setup lang="ts">\nconst rows = ref<number[]>([1, 2]);\n</script>\n<template>\n  <section class="panel">\n    <h3 class="p-title">Panel heading</h3>\n  </section>\n</template>`,
  });
  try {
    const res: Outcome = insert.applyInsert(repo, { anchor: { tagName: 'h3', path: [
      { tag: 'h3', id: null, cls: ['p-title'], own: 'Panel heading', nth: 0, cnt: 1 },
      { tag: 'section', id: null, cls: ['panel'], own: '', nth: 0, cnt: 1 },
      { tag: 'main', id: null, cls: ['app'], own: '', nth: 0, cnt: 1 },
      { tag: 'body', id: null, cls: [], own: '', nth: 0, cnt: 1 },
    ] }, position: 'after', markup: '<p class="d">d</p>', preferFile: 'src/App.vue' });
    assert.equal(res.ok, true, `vue insert failed: ${res.reason}`);
    assert.equal(res.relFile, 'src/components/Panel.vue', 'resolved into the component');
    const out = fs.readFileSync(path.join(repo, res.relFile!), 'utf8');
    assert.match(out, /class="d"/, 'vue keeps class=');
    assert.ok(reparses(out), 'valid .vue after insert');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ── 4. Framer Motion / react-spring: the DOM sees <section>/<h1>/<p>, the source
//    says <motion.section>/<m.h1>/<motion.p>. renderTag bridges them. ────────
function motionRepo() {
  return writeRepo({
    'app/page.tsx': `import { motion, m } from "framer-motion";\nexport default function Home() {\n  return (\n    <main className="wrap">\n      <motion.section className="hero" initial={{ opacity: 0 }}>\n        <m.h1 className="title">Motion heading</m.h1>\n        <motion.p className="lead">Lead copy here</motion.p>\n      </motion.section>\n    </main>\n  );\n}`,
  });
}
const M_H1 = { tagName: 'h1', path: [
  { tag: 'h1', id: null, cls: ['title'], own: 'Motion heading', nth: 0, cnt: 1 },
  { tag: 'section', id: null, cls: ['hero'], own: '', nth: 0, cnt: 1 },
  { tag: 'main', id: null, cls: ['wrap'], own: '', nth: 0, cnt: 1 },
  { tag: 'body', id: null, cls: [], own: '', nth: 0, cnt: 1 },
] };
const M_P = { tagName: 'p', path: [
  { tag: 'p', id: null, cls: ['lead'], own: 'Lead copy here', nth: 0, cnt: 1 },
  { tag: 'section', id: null, cls: ['hero'], own: '', nth: 0, cnt: 1 },
  { tag: 'main', id: null, cls: ['wrap'], own: '', nth: 0, cnt: 1 },
  { tag: 'body', id: null, cls: [], own: '', nth: 0, cnt: 1 },
] };

test('motion: insert after a DOM <h1> lands after the source <m.h1> (renderTag)', () => {
  const repo = motionRepo();
  try {
    const res: Outcome = insert.applyInsert(repo, { anchor: M_H1, position: 'after', markup: '<p class="sub">sub</p>', preferFile: 'app/page.tsx' });
    assert.equal(res.ok, true, `motion insert failed: ${res.reason}`);
    const out = fs.readFileSync(path.join(repo, res.relFile!), 'utf8');
    assert.match(out, /<\/m\.h1>\n\s*<p className="sub">sub<\/p>/, 'landed right after the m.h1 with className');
    assert.ok(reparses(out));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('motion: move a DOM <p> before a DOM <h1> reorders motion.p / m.h1 in source', () => {
  const repo = motionRepo();
  try {
    const mv: Outcome = insert.applyMove(repo, { subject: M_P, target: M_H1, position: 'before', preferFile: 'app/page.tsx' });
    assert.equal(mv.ok, true, `motion move failed: ${mv.reason}`);
    const out = fs.readFileSync(path.join(repo, mv.relFile!), 'utf8');
    assert.ok(out.indexOf('<motion.p') < out.indexOf('<m.h1'), 'motion.p now precedes m.h1');
    assert.equal((out.match(/<motion\.p(?=[\s>])/g) || []).length, 1, 'exactly one motion.p');
    assert.ok(reparses(out));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
