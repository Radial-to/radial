// What the window's code trusts to be there when it runs is there. TypeScript
// checks the code against declarations; these check the declarations against
// the page.
// - Every element it reads without a null check (RadialDomIds in
//   src/renderer/types.d.ts, what `$(id)` returns) is in index.html. 0.5.7 to
//   0.34 threw a TypeError on every close of the last open project: showEmpty()
//   still set $('changeList').innerHTML after the History rework took
//   #changeList out of the page (app_error at renderer.js 1406, 1443, 1449,
//   1562 and 1573), and the rest of the empty state never drew.
// - Every global another script provides (src/renderer/globals.d.ts) comes
//   from a script index.html loads. A name used but defined nowhere was the
//   0.8.5 to 0.9.2 and 0.18.0 ReferenceErrors (sendCommentsToAgent,
//   openDockSectionMenu); TypeScript now refuses those, but not a declared
//   global whose script the page doesn't load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('every id the window\'s code reads without a null check is in index.html', () => {
  const renderer = path.join(__dirname, '..', 'src', 'renderer');
  const types = fs.readFileSync(path.join(renderer, 'types.d.ts'), 'utf8');
  const start = types.indexOf('interface RadialDomIds {');
  assert.ok(start >= 0, 'types.d.ts declares RadialDomIds');
  const body = types.slice(start, types.indexOf('\n}', start));
  const typed = [...body.matchAll(/^\s+([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1]);
  assert.ok(typed.length > 200, `found ${typed.length} typed ids`);
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const missing = typed.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `RadialDomIds lists ids index.html doesn't have: $() returns null for them, and code that trusts the type throws`);
});

test('every global globals.d.ts says another script provides comes from a script index.html loads', () => {
  const renderer = path.join(__dirname, '..', 'src', 'renderer');
  const globals = fs.readFileSync(path.join(renderer, 'globals.d.ts'), 'utf8');
  const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const loaded = new Set([...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]));
  const named = new Set<string>();
  for (const m of globals.matchAll(/typeof import\('(\.{1,2}\/[\w/]+)'\)/g)) named.add(`${m[1].replace(/^\.\//, '')}.js`); // DUAL modules: ./fuzzy → fuzzy.js (the preload's API is a type only)
  for (const m of globals.matchAll(/\/\/ ([\w/]+\.js)\s*$/gm)) named.add(m[1]); // `declare var X; // shortcuts.js`
  for (const m of globals.matchAll(/\b((?:vendor\/)[\w/.-]+\.js)\b/g)) named.add(m[1]); // the vendored bundles' doc comments
  assert.ok(named.size >= 25, `found ${named.size} scripts named`);
  const missing = [...named].filter((file) => !loaded.has(file));
  assert.deepEqual(missing, [], 'globals.d.ts declares globals from scripts the page never loads: a ReferenceError when the code reaches them');
});
