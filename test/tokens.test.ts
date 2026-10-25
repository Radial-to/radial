// tokens.js: the design-token index (authored CSS only) and the in-place writer.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as tokens from '../src/main/tokens';
import type { SetTokenAmbiguous, SetTokenDone, SetTokenResult } from '../src/main/tokens';
import { tmpDir } from './support/tmp';

// Each setToken below succeeds or refuses as the test sets up, and the test asserts
// which, so its result is cast to that branch.
type SetTokenRefusal = Exclude<SetTokenResult, SetTokenDone>;

function site(files: Record<string, string>): string {
  const dir = tmpDir('rtok-');
  for (const [rel, content] of Object.entries(files)) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
  return dir;
}
const CSS = `/* brand */
:root {
  --purple: #8665f6;
  --purple-hover: var(--purple);
  --radius: 10px;
  --font-display: "Mango Grotesque", var(--font-display-fallback), sans-serif;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.2);
  --ease: cubic-bezier(.2, 0, 0, 1);
  --dur: 200ms;
  --unused: 3;
}
[data-theme="dark"] { --purple: #a48cff; }
@media (prefers-color-scheme: dark) { :root { --panel: #1d1d1d; } }
.btn { color: var(--purple); border-radius: var(--radius); font-family: var(--font-display); }
`;

test('indexTokens reads authored CSS: names, values, types, aliases, modes, usage; skips built and minified files', () => {
  const dir = site({
    'styles.css': CSS,
    'src/theme.css': '@theme {\n  --color-brand: oklch(0.7 0.2 300);\n  --spacing-lg: 2rem;\n}\n',
    'index.html': '<style>:root { --hero-pad: 4rem; }</style><div style="padding: var(--hero-pad)"></div><p class="x" style="color: var(--purple)"></p>',
    'dist/bundle.css': ':root { --built: red; }',
    'node_modules/x/x.css': ':root { --vendored: red; }',
    'vendor.min.css': ':root{--minified:red}' + ' a{color:red}'.repeat(400),
  });
  const idx = tokens.indexTokens(dir);
  assert.equal(idx.ok, true);
  const by = Object.fromEntries(idx.tokens.map((t) => [t.name, t]));
  assert.ok(!by['--built'] && !by['--vendored'] && !by['--minified'], 'generated, vendored and minified files are not sources');
  assert.equal(by['--purple'].type, 'color'); assert.equal(by['--purple'].value, '#8665f6'); assert.equal(by['--purple'].file, 'styles.css'); assert.equal(by['--purple'].line, 3);
  assert.deepEqual(by['--purple'].modes, ['default', 'dark'], 'a second definition under [data-theme=dark] is a mode');
  assert.equal(by['--purple'].uses, 3, 'var(--purple) in .btn, in --purple-hover, and inline in index.html');
  assert.equal(by['--purple'].files, 2);
  assert.equal(by['--purple-hover'].type, 'alias'); assert.equal(by['--purple-hover'].alias, '--purple');
  assert.equal(by['--radius'].type, 'length'); assert.equal(by['--font-display'].type, 'font'); assert.equal(by['--shadow-sm'].type, 'shadow');
  assert.equal(by['--ease'].type, 'easing'); assert.equal(by['--dur'].type, 'duration'); assert.equal(by['--unused'].uses, 0);
  assert.equal(by['--panel'].modes.length, 0, 'one definition is no mode'); assert.equal(tokens.modeLabel(by['--panel'].defs[0]), 'dark', 'but its scope reads as the dark mode');
  assert.equal(by['--color-brand'].theme, true); assert.equal(by['--color-brand'].selector, '@theme'); assert.equal(by['--color-brand'].type, 'color');
  assert.equal(by['--spacing-lg'].type, 'length');
  assert.equal(by['--hero-pad'].file, 'index.html'); assert.equal(by['--hero-pad'].uses, 1);
  assert.ok(idx.tokens[0].type === 'color', 'colors sort first');
});

test('setToken rewrites exactly one declaration, refuses ambiguity without a mode, honours the mode, and relocates after the file changed', () => {
  const dir = site({ 'styles.css': CSS });
  // Unambiguous: one definition.
  const r1 = tokens.setToken(dir, { name: '--radius', value: '12px' }) as SetTokenDone;
  assert.equal(r1.ok, true); assert.equal(r1.relFile, 'styles.css'); assert.equal(r1.from, '10px'); assert.equal(r1.to, '12px');
  assert.ok(typeof r1.prevContent === 'string' && typeof r1.newContent === 'string', 'recordEdit shape');
  assert.match(fs.readFileSync(path.join(dir, 'styles.css'), 'utf8'), /--radius: 12px;/);
  // Two definitions: needs a mode.
  const amb = tokens.setToken(dir, { name: '--purple', value: '#000' }) as SetTokenAmbiguous;
  assert.equal(amb.ok, false); assert.equal(amb.reason, 'ambiguous'); assert.deepEqual(amb.candidates.map((c) => c.mode), ['default', 'dark']);
  const dark = tokens.setToken(dir, { name: '--purple', value: '#ffffff', mode: 'dark' }) as SetTokenDone;
  assert.equal(dark.ok, true); assert.equal(dark.mode, 'dark');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  assert.match(css, /--purple: #8665f6;/, 'the default definition is untouched'); assert.match(css, /\[data-theme="dark"\] \{ --purple: #ffffff; \}/);
  // Value with a function and commas.
  const f = tokens.setToken(dir, { name: '--font-display', value: 'Inter, sans-serif', mode: 'default' });
  assert.equal(f.ok, true); assert.match(fs.readFileSync(path.join(dir, 'styles.css'), 'utf8'), /--font-display: Inter, sans-serif;/);
  // Guards.
  assert.equal((tokens.setToken(dir, { name: 'purple', value: 'x' }) as SetTokenRefusal).reason, 'invalid');
  assert.equal((tokens.setToken(dir, { name: '--nope', value: 'x' }) as SetTokenRefusal).reason, 'not-found');
  assert.equal((tokens.setToken(dir, { name: '--radius', value: '12px' }) as SetTokenRefusal).reason, 'no-change');
  assert.equal((tokens.setToken(dir, { name: '--radius', value: '1px; color: red' }) as SetTokenRefusal).reason, 'invalid');
});

test('setToken finds a token past the first 600 the index lists', () => {
  // A big theme (Tailwind v4 sites easily pass 600 variables): 600 colors sort ahead of one length.
  const colors = Array.from({ length: 600 }, (_, i) => `  --color-${i}: #${String(i).padStart(6, '0')};`).join('\n');
  const dir = site({ 'styles.css': `:root {\n${colors}\n  --radius: 10px;\n}\n` });
  const idx = tokens.indexTokens(dir);
  assert.equal(idx.count, 601); assert.equal(idx.tokens.length, 600);
  assert.ok(!idx.tokens.some((t) => t.name === '--radius'), 'the index lists the first 600, all colors');
  const r = tokens.setToken(dir, { name: '--radius', value: '12px' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(fs.readFileSync(path.join(dir, 'styles.css'), 'utf8'), /--radius: 12px;/);
});

test('scanCss handles comments, strings, nested at-rules and values with braces in strings', () => {
  const defs = tokens.scanCss(`/* --not-a-token: x; */ :root { --a: "a; b"; --b: url("x}y"); }\n@supports (display: grid) { @media (min-width: 900px) { :root { --c: 1px; } } }`);
  assert.deepEqual(defs.map((d) => [d.name, d.value, d.selector, d.at]), [['--a', '"a; b"', ':root', ''], ['--b', 'url("x}y")', ':root', ''], ['--c', '1px', ':root', '@supports (display: grid) @media (min-width: 900px)']]);
});
