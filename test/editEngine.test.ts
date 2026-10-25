import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as engine from '../src/main/editEngine';
import type { AddHeadTagOutcome, HeadTagDone, SetHeadTagOutcome, TextEditDone } from '../src/main/editEngine';
import type { TextEditFailure } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

function makeRepo(files: Record<string, string>) {
  const dir = tmpDir('radial-test-');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

test('rewrites a unique string in a plain HTML file', () => {
  const repo = makeRepo({
    'index.html': '<h1>Welcome to Acme</h1>\n<p>We build things.</p>\n',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: 'Welcome to Acme',
    newText: 'Welcome to Acme Corp',
    context: { tagName: 'h1' },
  }) as TextEditDone;
  assert.equal(res.ok, true);
  assert.equal(res.strategy, 'unique');
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.match(out, /Welcome to Acme Corp/);
});

test('rewrites text inside JSX', () => {
  const repo = makeRepo({
    'src/Hero.tsx': 'export default function Hero() {\n  return <h1 className="hero-title">Build faster</h1>;\n}\n',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: 'Build faster',
    newText: 'Ship faster',
    context: { tagName: 'h1', classList: ['hero-title'] },
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'src/Hero.tsx'), 'utf8');
  assert.match(out, /Ship faster/);
  assert.doesNotMatch(out, /Build faster/);
});

test('rewrites text inside an .astro file', () => {
  const repo = makeRepo({
    'src/pages/index.astro': '---\nconst x = 1;\n---\n<main>\n  <h2>Our Services</h2>\n</main>\n',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: 'Our Services',
    newText: 'What We Offer',
    context: { tagName: 'h2' },
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'src/pages/index.astro'), 'utf8');
  assert.match(out, /What We Offer/);
});

test('disambiguates duplicate strings using class context', () => {
  const repo = makeRepo({
    'index.html':
      '<a class="nav-link">Learn more</a>\n' +
      '<a class="footer-link">Learn more</a>\n',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: 'Learn more',
    newText: 'Read the docs',
    context: { tagName: 'a', classList: ['footer-link'] },
  }) as TextEditDone;
  assert.equal(res.ok, true);
  assert.equal(res.strategy, 'context-score');
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.match(out, /footer-link">Read the docs/);
  assert.match(out, /nav-link">Learn more/); // the other one untouched
});

test('falls back to occurrence index when no context distinguishes', () => {
  const repo = makeRepo({
    'a.html': '<p>Hello</p>',
    'b.html': '<p>Hello</p>',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: 'Hello',
    newText: 'Hi',
    context: { occurrenceIndex: 1 },
  }) as TextEditDone;
  assert.equal(res.ok, true);
  assert.equal(res.strategy, 'occurrence-index');
});

test('reports ambiguity when nothing can disambiguate', () => {
  const repo = makeRepo({
    'a.html': '<p>Hello</p>',
    'b.html': '<p>Hello</p>',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: 'Hello',
    newText: 'Hi',
    context: {},
  }) as Extract<TextEditFailure, { reason: 'not-found' | 'ambiguous' }>;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'ambiguous');
  assert.equal(res.candidates.length, 2);
});

test('matches text split across lines (whitespace-flexible)', () => {
  const repo = makeRepo({
    'index.html': '<p>\n  We help teams\n  move faster\n</p>\n',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: 'We help teams move faster',
    newText: 'We help teams win',
    context: { tagName: 'p' },
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.match(out, /We help teams win/);
});

test('ignores matches inside HTML comments so DOM index aligns', () => {
  // Mirrors a real site: a comment label plus two real elements with the same text.
  const repo = makeRepo({
    'index.astro':
      '<!-- Column 2: What\'s included -->\n' +
      '<p class="col-label">What\'s included</p>\n' +
      '<p class="col-label" style="margin-top:24px">What\'s included</p>\n',
  });
  const occ = engine.findOccurrences(repo, "What's included");
  assert.equal(occ.length, 2); // comment match dropped

  // DOM occurrence index 0 -> the first real <p>, not the comment.
  const res = engine.applyTextEdit(repo, {
    originalText: "What's included",
    newText: 'What you get',
    context: { tagName: 'p', classList: ['col-label'], occurrenceIndex: 0 },
  }) as TextEditDone;
  assert.equal(res.ok, true);
  assert.equal(res.line, 2); // line 1 is the comment
});

test('adds a missing tag before </head>', () => {
  const repo = makeRepo({ 'index.html': '<html>\n  <head>\n    <title>X</title>\n  </head>\n  <body></body>\n</html>\n' });
  const res = engine.addHeadTag(repo, 'index.html', '<meta name="description" content="Hello there" />') as HeadTagDone;
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.match(out, /<meta name="description" content="Hello there" \/>\s*<\/head>/);
  assert.equal(res.prevContent !== res.newContent, true);
});

test('reports no-head when the file has no <head>', () => {
  const repo = makeRepo({ 'page.astro': '---\nconst x=1;\n---\n<main>hi</main>\n' });
  const res = engine.addHeadTag(repo, 'page.astro', '<meta name="description" content="x" />') as Extract<AddHeadTagOutcome, { ok: false }>;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-head');
});

test('refuses interpolated text', () => {
  const repo = makeRepo({
    'src/Hero.tsx': 'return <h1>Welcome to {brand}</h1>;',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: 'Welcome to {brand}',
    newText: 'Welcome to Acme',
    context: {},
  }) as TextEditFailure;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'interpolated-text');
});

test('returns before/after content enabling undo restore', () => {
  const repo = makeRepo({ 'index.html': '<h1>Old</h1>' });
  const res = engine.applyTextEdit(repo, { originalText: 'Old', newText: 'New', context: {} }) as TextEditDone;
  assert.equal(res.ok, true);
  assert.equal(res.prevContent, '<h1>Old</h1>');
  assert.equal(res.newContent, '<h1>New</h1>');
  // Simulate undo: write prevContent back.
  fs.writeFileSync(path.join(repo, 'index.html'), res.prevContent!);
  assert.equal(fs.readFileSync(path.join(repo, 'index.html'), 'utf8'), '<h1>Old</h1>');
});

test('edits the right link href using attribute + preferFile + link text', () => {
  const repo = makeRepo({
    'src/components/Header.astro': '<a href="/" class="brand">Home</a>',
    'src/pages/index.astro': '<main>\n  <a href="/" class="cta">Get started</a>\n</main>',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: '/',
    newText: '/signup',
    context: {
      tagName: 'a',
      attribute: 'href',
      classList: ['cta'],
      nearbyText: ['Get started'],
      preferFile: 'src/pages/index.astro',
    },
  }) as TextEditDone;
  assert.equal(res.ok, true);
  assert.equal(res.relFile, 'src/pages/index.astro');
  const idx = fs.readFileSync(path.join(repo, 'src/pages/index.astro'), 'utf8');
  assert.match(idx, /href="\/signup"/);
  const hdr = fs.readFileSync(path.join(repo, 'src/components/Header.astro'), 'utf8');
  assert.match(hdr, /href="\/"/); // header link untouched
});

test('ignores node_modules and build output', () => {
  const repo = makeRepo({
    'index.html': '<h1>Real Title</h1>',
    'node_modules/pkg/index.html': '<h1>Real Title</h1>',
    'dist/index.html': '<h1>Real Title</h1>',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: 'Real Title',
    newText: 'New Title',
    context: {},
  }) as TextEditDone;
  assert.equal(res.ok, true);
  assert.equal(res.strategy, 'unique'); // only the source file counts
});

// --- setHeadTagValue: locator-driven meta rewrite (og:image upload fallback) ---

test('setHeadTagValue rewrites og:image content when the DOM value differs from source', () => {
  const repo = makeRepo({
    'index.html': '<html><head>\n  <meta property="og:image" content="/old-social.png" />\n</head><body></body></html>',
  });
  // The renderer saw the RESOLVED URL, so a value search would find nothing —
  // the locator path must still land on the tag.
  const res = engine.setHeadTagValue(repo, { preferFile: 'index.html', locator: 'og:image', attr: 'content', value: 'https://acme.com/new-social.png' });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.ok(out.includes('content="https://acme.com/new-social.png"'));
  assert.ok(!out.includes('/old-social.png'));
});

test('setHeadTagValue does not confuse og:image with og:image:alt', () => {
  const repo = makeRepo({
    'index.html': '<head>\n<meta property="og:image:alt" content="A rocket" />\n<meta property="og:image" content="/a.png" />\n</head>',
  });
  const res = engine.setHeadTagValue(repo, { preferFile: 'index.html', locator: 'og:image:alt', attr: 'content', value: 'A moon' });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.ok(out.includes('content="A moon"'));
  assert.ok(out.includes('content="/a.png"'), 'og:image untouched');
});

test('setHeadTagValue prefers the current page file when several pages define the tag', () => {
  const repo = makeRepo({
    'index.html': '<head><meta property="og:image" content="/home.png" /></head>',
    'about.html': '<head><meta property="og:image" content="/about.png" /></head>',
  });
  const res = engine.setHeadTagValue(repo, { preferFile: 'about.html', locator: 'og:image', attr: 'content', value: '/about-v2.png' }) as HeadTagDone;
  assert.equal(res.ok, true);
  assert.equal(res.relFile, 'about.html');
  assert.ok(fs.readFileSync(path.join(repo, 'index.html'), 'utf8').includes('/home.png'), 'other page untouched');
});

test('setHeadTagValue rewrites <title> inner text and single-quoted attrs', () => {
  const repo = makeRepo({
    'index.html': "<head><title>Old Name</title><link rel='canonical' href='https://a.com/x' /></head>",
  });
  const t = engine.setHeadTagValue(repo, { preferFile: 'index.html', locator: '<title', attr: null, value: 'New & Better' });
  assert.equal(t.ok, true);
  const c = engine.setHeadTagValue(repo, { preferFile: 'index.html', locator: 'canonical', attr: 'href', value: 'https://a.com/y' });
  assert.equal(c.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.ok(out.includes('<title>New &amp; Better</title>'));
  assert.ok(out.includes("href='https://a.com/y'") || out.includes('https://a.com/y'));
});

test('setHeadTagValue skips JSX expression values and commented-out tags', () => {
  const repo = makeRepo({
    'page.tsx': 'export const Head = () => <><meta property="og:image" content={ogUrl} /></>;',
    'index.html': '<head><!-- <meta property="og:image" content="/ghost.png" /> --></head>',
  });
  const res = engine.setHeadTagValue(repo, { preferFile: 'page.tsx', locator: 'og:image', attr: 'content', value: '/x.png' }) as Extract<SetHeadTagOutcome, { ok: false }>;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-found');
});

test('setHeadTagValue editing og:image ignores an earlier og:image:alt tag', () => {
  const repo = makeRepo({
    'index.html': '<head>\n<meta property="og:image:alt" content="A rocket" />\n<meta property="og:image" content="/a.png" />\n</head>',
  });
  const res = engine.setHeadTagValue(repo, { preferFile: 'index.html', locator: 'og:image', attr: 'content', value: 'https://acme.com/b.png' });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
  assert.ok(out.includes('content="A rocket"'), 'alt untouched');
  assert.ok(out.includes('content="https://acme.com/b.png"'));
});

test('setHeadTagValue follows an Astro identifier expression to its frontmatter literal', () => {
  const repo = makeRepo({
    'src/layouts/Base.astro': `---
const { title } = Astro.props;
const ogImage = new URL('/og-image.png', Astro.site).href;
---
<html><head>
  <meta property="og:image" content={ogImage} />
  <meta name="twitter:image" content={ogImage} />
</head></html>`,
  });
  // Upload flow hands over an ABSOLUTE url; the const absolutizes itself, so
  // only the path should land in the literal.
  const res = engine.setHeadTagValue(repo, { preferFile: 'src/pages/index.astro', locator: 'og:image', attr: 'content', value: 'https://example.com/share-card.png' });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'src/layouts/Base.astro'), 'utf8');
  assert.ok(out.includes("new URL('/share-card.png', Astro.site).href"), out);
  assert.ok(!out.includes('/og-image.png'));
});

test('setHeadTagValue keeps an absolute value when the identifier literal was already absolute', () => {
  const repo = makeRepo({
    'src/Layout.astro': `---
const ogImage = 'https://old.com/a.png';
---
<meta property="og:image" content={ogImage} />`,
  });
  const res = engine.setHeadTagValue(repo, { preferFile: 'src/Layout.astro', locator: 'og:image', attr: 'content', value: 'https://new.com/b.png' });
  assert.equal(res.ok, true);
  assert.ok(fs.readFileSync(path.join(repo, 'src/Layout.astro'), 'utf8').includes("'https://new.com/b.png'"));
});

test('setHeadTagValue leaves multi-definition or prop-fed identifiers alone', () => {
  const repo = makeRepo({
    'a.astro': `---
const { ogImage } = Astro.props;
---
<meta property="og:image" content={ogImage} />`,
  });
  const res = engine.setHeadTagValue(repo, { preferFile: 'a.astro', locator: 'og:image', attr: 'content', value: '/x.png' }) as Extract<SetHeadTagOutcome, { ok: false }>;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-found');
});

// --- canonical-form matching (entities, escapes, smart punctuation) ---------
// The DOM hands us RENDERED text; source spells it differently. Each of these
// used to fail with not-found.

test('finds text whose source uses HTML entities (&rsquo; &amp; &nbsp;)', () => {
  const repo = makeRepo({
    'index.html': '<h1>Let&rsquo;s build &amp; ship&nbsp;today</h1>\n',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: 'Let’s build & ship today', // as textContent renders it
    newText: 'Let’s go',
    context: { tagName: 'h1' },
  });
  assert.equal(res.ok, true);
  assert.match(fs.readFileSync(path.join(repo, 'index.html'), 'utf8'), /Let’s go/);
});

test('finds text behind escaped quotes in JS strings', () => {
  const repo = makeRepo({
    'data.js': "export const hero = 'Don\\'t miss the launch';\n",
  });
  const res = engine.applyTextEdit(repo, {
    originalText: "Don't miss the launch",
    newText: "Don't miss it",
    context: {},
  });
  assert.equal(res.ok, true);
  // The typed apostrophe is escaped for the string it lands in (sourceContext.ts):
  // written raw, it ended the string early and broke the file.
  assert.equal(fs.readFileSync(path.join(repo, 'data.js'), 'utf8'), "export const hero = 'Don\\'t miss it';\n");
});

test('folds smart punctuation both directions (’ vs \x27, … vs ..., — vs -)', () => {
  const repo = makeRepo({
    'a.astro': "<p>Wait for it... it's here - finally</p>\n",
  });
  // Typography pipeline rendered: … ’ – — the DOM text uses the fancy forms.
  const res = engine.applyTextEdit(repo, {
    originalText: 'Wait for it… it’s here – finally',
    newText: 'It has arrived',
    context: { tagName: 'p' },
  });
  assert.equal(res.ok, true);
  assert.match(fs.readFileSync(path.join(repo, 'a.astro'), 'utf8'), /It has arrived/);
});

test('numeric entities decode too (&#8217; and &#x2019;)', () => {
  const repo = makeRepo({
    'x.html': '<p>It&#8217;s time. It&#x2019;s here.</p>\n',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: 'It’s time. It’s here.',
    newText: 'Now boarding.',
    context: { tagName: 'p' },
  });
  assert.equal(res.ok, true);
});

test('canonical matching still respects comments and replaces the exact span', () => {
  const repo = makeRepo({
    'y.html': '<!-- Let&rsquo;s build -->\n<h2>Let&rsquo;s build</h2>\n',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: 'Let’s build',
    newText: 'Ship it',
    context: { tagName: 'h2' },
  });
  assert.equal(res.ok, true);
  const out = fs.readFileSync(path.join(repo, 'y.html'), 'utf8');
  assert.match(out, /<!-- Let&rsquo;s build -->/); // comment untouched
  assert.match(out, /<h2>Ship it<\/h2>/);
});

test('a file that mentions &valueOf; or &toString; reads them as plain text, not entities', () => {
  // Every file without an exact match goes through the canonical form, so one
  // such note anywhere in the repo used to make every edit and locate throw.
  const repo = makeRepo({
    'index.html': '<h1>Hello there world</h1>\n',
    'notes.md': 'Notes &valueOf; and &toString; here\n',
  });
  const located = engine.locateElement(repo, { text: 'Hello there world', tagName: 'h1' });
  assert.equal(located.ok, true);
  const res = engine.applyTextEdit(repo, {
    originalText: 'Hello there world',
    newText: 'Hi there',
    context: { tagName: 'h1' },
  });
  assert.equal(res.ok, true);
  assert.match(fs.readFileSync(path.join(repo, 'index.html'), 'utf8'), /<h1>Hi there<\/h1>/);
  assert.equal(fs.readFileSync(path.join(repo, 'notes.md'), 'utf8'), 'Notes &valueOf; and &toString; here\n');
});

test('a stale-preview edit whose replacement already exists reports already-applied', () => {
  // The screen showed "plain code" copy, but an agent had already rewritten
  // the file. The old text is gone; the NEW text is present — nothing to do.
  const repo = makeRepo({
    'integrations.html': '<p>Your site is code that you own fully, your agents are coders.</p>\n',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: 'Your site is plain code and your agents are real coding agents.',
    newText: 'Your site is code that you own fully, your agents are coders.',
    context: { tagName: 'p' },
  }) as Extract<TextEditFailure, { reason: 'already-applied' }>;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'already-applied');
  assert.equal(res.relFile, 'integrations.html');
});

test('short replacements never claim already-applied (too easy to false-positive)', () => {
  const repo = makeRepo({
    'index.html': '<button>Save</button>\n<h1>Something else entirely</h1>\n',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: 'Text that is not in any file',
    newText: 'Save',
    context: {},
  }) as TextEditFailure;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-found');
});

test('a genuinely missing edit still reports not-found', () => {
  const repo = makeRepo({
    'index.html': '<h1>Hello</h1>\n',
  });
  const res = engine.applyTextEdit(repo, {
    originalText: 'This text never existed anywhere',
    newText: 'And this replacement is also nowhere to be found',
    context: {},
  }) as TextEditFailure;
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-found');
});
