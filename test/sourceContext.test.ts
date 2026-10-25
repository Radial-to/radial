// Text typed on the page is written safely wherever it lands in the source: the
// quote of a JS string is escaped, page text and attributes get entities, and
// where text can't go the edit is refused instead of breaking the file. Edits
// run through the same path as the Text tool, the Content panel and
// `radial edit text` (editEngine.applyTextEdit), on files in a temp folder, and
// every JS/TS result must still parse. Ported from Radial Cloud's engine tests,
// plus the three places this port reads differently from Cloud's version: a
// JSX fragment's text, a <title> in JSX, and MDX.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import * as engine from '../src/main/editEngine';
import { contextAt, dialectOf } from '../src/main/sourceContext';
import type { TextEditFailure } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

/** Writes one file in a fresh folder, edits `from` to `to` in it, and returns the result and the file after. */
function edit(name: string, source: string, from: string, to: string) {
  const site = tmpDir('radial-escape-');
  fs.writeFileSync(path.join(site, name), source);
  const result = engine.applyTextEdit(site, { originalText: from, newText: to, context: {} });
  return { result, after: fs.readFileSync(path.join(site, name), 'utf8') };
}

/** TypeScript's syntax errors for a JS/TS/JSX file. */
function parseErrors(name: string, source: string): string[] {
  const out = ts.transpileModule(source, { fileName: name, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext } });
  return (out.diagnostics || []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

const why = (result: unknown) => JSON.stringify(result);

test('JSX text: braces and angle brackets become entities instead of breaking the file', () => {
  const source = 'export function Hero() {\n\treturn <h1 className="title">Save on everything</h1>;\n}\n';
  const { result, after } = edit('Hero.tsx', source, 'Save on everything', 'Save {50%} on <everything> & more');
  assert.equal(result.ok, true, why(result));
  assert.match(after, /Save &#123;50%&#125; on &lt;everything&gt; & more/);
  assert.deepEqual(parseErrors('Hero.tsx', after), []);
});

test('a prop string in React: a double quote becomes &quot;, an apostrophe stays', () => {
  const source = 'export default function Page() {\n\treturn <Hero title="Welcome to the shop" />;\n}\n';
  const { result, after } = edit('page.tsx', source, 'Welcome to the shop', 'The "best" shop, it\'s true');
  assert.equal(result.ok, true, why(result));
  assert.match(after, /title="The &quot;best&quot; shop, it's true"/);
  assert.deepEqual(parseErrors('page.tsx', after), []);
});

test('a JS string: the quote it uses is escaped, the other isn’t', () => {
  const source = "const copy = {\n\theading: 'Fresh bread every morning',\n\tnote: \"Open daily\",\n};\nexport default function Page() { return <h2>{copy.heading}</h2>; }\n";
  const single = edit('copy.tsx', source, 'Fresh bread every morning', "Mara's \"famous\" bread");
  assert.equal(single.result.ok, true, why(single.result));
  assert.match(single.after, /heading: 'Mara\\'s "famous" bread'/);
  assert.deepEqual(parseErrors('copy.tsx', single.after), []);
  const double = edit('copy.tsx', source, 'Open daily', 'Open "daily", it\'s true');
  assert.match(double.after, /note: "Open \\"daily\\", it's true"/);
  assert.deepEqual(parseErrors('copy.tsx', double.after), []);
});

test('text inside a longer string (HTML kept in a string) is escaped too', () => {
  const source = "export const banner = '<p class=\"note\">Free shipping today</p>';\n";
  const { result, after } = edit('banner.ts', source, 'Free shipping today', "It's free today");
  assert.equal(result.ok, true, why(result));
  assert.match(after, /'<p class="note">It\\'s free today<\/p>'/);
  assert.deepEqual(parseErrors('banner.ts', after), []);
});

test('a template literal: backticks and ${ are escaped', () => {
  const source = 'export const intro = `Hand-made goods`;\n';
  const { after } = edit('intro.ts', source, 'Hand-made goods', 'Use `code` and ${things}');
  assert.match(after, /`Use \\`code\\` and \\\$\{things\}`/);
  assert.deepEqual(parseErrors('intro.ts', after), []);
});

test('JSX text inside an expression ({open && <p>…</p>}) is page text, not a string', () => {
  const source = "export function Note({ open }) {\n\treturn <div>{open && <p>We're open late</p>}</div>;\n}\n";
  const { result, after } = edit('Note.jsx', source, "We're open late", 'Open until {10}');
  assert.equal(result.ok, true, why(result));
  assert.match(after, /<p>Open until &#123;10&#125;<\/p>/);
  assert.deepEqual(parseErrors('Note.jsx', after), []);
});

test('Astro: frontmatter strings, and braces in the template', () => {
  const source = "---\nconst tagline = 'Made in Tulsa';\n---\n<h1>{tagline}</h1>\n<p class=\"lede\">We build websites</p>\n";
  const front = edit('index.astro', source, 'Made in Tulsa', "Made in Oklahoma's capital");
  assert.match(front.after, /const tagline = 'Made in Oklahoma\\'s capital';/);
  const text = edit('index.astro', source, 'We build websites', 'We build {fast} sites');
  assert.match(text.after, /<p class="lede">We build &#123;fast&#125; sites<\/p>/);
});

test('Astro, Vue and Svelte props: their own quote is refused, not guessed', () => {
  const source = '---\nimport Hero from "../Hero.astro";\n---\n<Hero title="Welcome in" />\n';
  const { result, after } = edit('index.astro', source, 'Welcome in', 'Say "hi"');
  if (result.ok || result.reason !== 'needs-agent') throw new Error(`expected needs-agent: ${why(result)}`);
  assert.match(result.message, /Ask the agent/);
  assert.equal(after, source);
  const apostrophe = edit('index.astro', source, 'Welcome in', "Y'all come in");
  assert.match(apostrophe.after, /title="Y'all come in"/);
});

test('Vue: {{ in template text; Svelte: braces in text and in quoted attributes', () => {
  const vue = edit('Page.vue', '<template>\n\t<p>Prices from 10</p>\n</template>\n', 'Prices from 10', 'Use {{ name }} here');
  assert.match(vue.after, /<p>Use &#123;&#123; name &#125;&#125; here<\/p>/);
  const svelte = edit('Page.svelte', '<p title="Short note">Hello there</p>\n', 'Hello there', 'Hi {you}');
  assert.match(svelte.after, /<p title="Short note">Hi &#123;you&#125;<\/p>/);
  const attr = edit('Page.svelte', '<p title="Short note">Hello there</p>\n', 'Short note', 'A {short} one');
  assert.match(attr.after, /<p title="A &#123;short&#125; one">/);
});

test('HTML: < in text and quotes in attributes become entities', () => {
  const html = edit('index.html', '<!doctype html>\n<body>\n<h1>Plain page</h1>\n</body>\n', 'Plain page', 'Pages < sites & "more"');
  assert.match(html.after, /<h1>Pages &lt; sites & "more"<\/h1>/);
  const alt = edit('index.html', '<img src="/a.png" alt="A plain photo">\n', 'A plain photo', 'The "best" photo');
  assert.match(alt.after, /alt="The &quot;best&quot; photo"/);
});

test('JSON content: quotes and backslashes are escaped and it still parses', () => {
  const { after } = edit('site.json', '{\n\t"title": "Our story"\n}\n', 'Our story', 'Our "story" \\ more');
  assert.doesNotThrow(() => JSON.parse(after));
  assert.equal(JSON.parse(after).title, 'Our "story" \\ more');
});

test('&copy; typed as words stays words', () => {
  const { after } = edit('Foot.tsx', 'export const Foot = () => <small>All rights</small>;\n', 'All rights', 'Write &copy; for ©');
  assert.match(after, /Write &amp;copy; for ©/);
  assert.deepEqual(parseErrors('Foot.tsx', after), []);
});

test('an unquoted attribute takes a word, but not text with spaces', () => {
  const source = '<img src=/a.png alt=Logo>\n';
  assert.match(edit('index.html', source, 'Logo', 'Mark').after, /alt=Mark>/);
  const { result, after } = edit('index.html', source, 'Logo', 'Our logo');
  assert.equal((result as TextEditFailure).reason, 'needs-agent');
  assert.equal(after, source);
});

// ── Where this port reads differently from Cloud's version ────────────────
test('text right inside a JSX fragment is page text', () => {
  // Cloud's version read the fragment as code, re-entered it, and ran out of stack.
  const source = "export const Hours = ({ open }) => (\n\t<div>{open ? <>Don't stop by late</> : <p>Closed</p>}</div>\n);\nexport const Note = () => <>Hello there, friend</>;\n";
  const late = edit('Hours.jsx', source, "Don't stop by late", 'Stop by {before} <ten>');
  assert.equal(late.result.ok, true, why(late.result));
  assert.match(late.after, /<>Stop by &#123;before&#125; &lt;ten&gt;<\/>/);
  assert.deepEqual(parseErrors('Hours.jsx', late.after), []);
  const hello = edit('Hours.jsx', source, 'Hello there, friend', "It's {you}");
  assert.match(hello.after, /<>It's &#123;you&#125;<\/>/);
  assert.deepEqual(parseErrors('Hours.jsx', hello.after), []);
});

test('an SVG <title> in JSX is page text: braces and > become entities; in HTML it stays raw', () => {
  // Cloud reads every <title> as raw HTML text, so `{` and `>` went in as typed.
  const source = 'export const Mark = () => (\n\t<svg viewBox="0 0 10 10"><title>Brand mark</title><path d="M0 0h10v10H0z" /></svg>\n);\n';
  const { result, after } = edit('Mark.tsx', source, 'Brand mark', 'Mark {v2} > logo');
  assert.equal(result.ok, true, why(result));
  assert.match(after, /<title>Mark &#123;v2&#125; &gt; logo<\/title>/);
  assert.deepEqual(parseErrors('Mark.tsx', after), []);
  const html = edit('index.html', '<!doctype html>\n<title>Old name</title>\n<h1>Hi</h1>\n', 'Old name', 'A < B {C}');
  assert.match(html.after, /<title>A &lt; B \{C\}<\/title>/);
});

test('MDX: prose is page text, an export is code, a code block and the frontmatter are as written', () => {
  // Cloud reads a whole .mdx file as JavaScript: an apostrophe in the prose
  // opened a "string", so braces went in raw (MDX reads them as an expression).
  const source = [
    '---',
    'summary: Notes from the week',
    '---',
    "export const meta = { title: 'Shop notes' };",
    '',
    "It's been a busy week at the shop, and we're glad.",
    '',
    '```js',
    'print("ready to ship")',
    '```',
    '',
  ].join('\n');
  const prose = edit('post.mdx', source, 'a busy week at the shop', 'a {big} week <really>');
  assert.equal(prose.result.ok, true, why(prose.result));
  assert.match(prose.after, /It's been a &#123;big&#125; week &lt;really&gt;, and we're glad\./);
  assert.match(edit('post.mdx', source, 'Shop notes', "Mara's notes").after, /title: 'Mara\\'s notes'/);
  assert.match(edit('post.mdx', source, 'ready to ship', '{shipped}').after, /print\("\{shipped\}"\)/);
  assert.match(edit('post.mdx', source, 'Notes from the week', 'Notes {and} news').after, /summary: Notes \{and\} news/);
  assert.equal(dialectOf('post.mdx'), 'mdx');
  assert.deepEqual(contextAt(source, source.indexOf('a busy week'), 'mdx'), { kind: 'markup' });
});

test('Markdown is plain text: what was typed is written as typed', () => {
  const { result, after } = edit('README.md', '# Shop\n\nWe sell bread.\n', 'We sell bread.', "We sell {fresh} bread & it's <good>.");
  assert.equal(result.ok, true, why(result));
  assert.match(after, /We sell \{fresh\} bread & it's <good>\./);
});
