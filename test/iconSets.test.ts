// The app ships one of two icon sets with the same names: Central (licensed,
// official builds) or Lucide (open, builds from the public source). These keep
// them in step. In the public source icons.gen.js is itself the open set, and
// icons.open.gen.js may be absent; the checks adapt.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');
const genPath = path.join(root, 'src', 'renderer', 'icons.gen.js');
const openPath = fs.existsSync(path.join(root, 'src', 'renderer', 'icons.open.gen.js'))
  ? path.join(root, 'src', 'renderer', 'icons.open.gen.js')
  : genPath;
const map: Record<string, string> = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'icons-open-map.json'), 'utf8'));

function load(file: string) {
  const win: { RADIAL_ICONS?: Record<string, string> } = {};
  new Function('window', fs.readFileSync(file, 'utf8'))(win);
  return win.RADIAL_ICONS!;
}
const head = (file: string) => fs.readFileSync(file, 'utf8').slice(0, 400);
const genIsCentral = !head(genPath).includes('Lucide');
const gen = load(genPath);
const open = load(openPath);

test('the open set ships exactly the names the app ships', () => {
  assert.deepStrictEqual(Object.keys(open).sort(), Object.keys(gen).sort());
});

test('every shipped name has a Lucide match in icons-open-map.json', () => {
  const missing = Object.keys(gen).filter((n) => !map[n]);
  assert.deepStrictEqual(missing, [], `add these to scripts/icons-open-map.json: ${missing.join(', ')}`);
});

test('open icons are house-style SVGs the renderer can size', () => {
  for (const [name, svg] of Object.entries(open)) {
    // icon() adds class/width/height by replacing the leading '<svg '.
    assert.ok(svg.startsWith('<svg '), `${name} must start with "<svg "`);
    assert.match(svg, /<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">/, name);
    assert.match(svg, /<(path|circle|rect|line|polyline|polygon|ellipse)\b/, `${name} has no shapes`);
  }
});

test('the open set carries Lucide\'s license notices', () => {
  const src = fs.readFileSync(openPath, 'utf8');
  assert.match(src, /ISC License/);
  assert.match(src, /Lucide Icons and Contributors/);
  assert.match(src, /Cole Bemis/);   // Feather-derived icons, MIT
});

test('the open map points at real Lucide icons', (t) => {
  let dir;
  try { dir = path.join(path.dirname(require.resolve('lucide-static/package.json')), 'icons'); }
  catch { return t.skip('lucide-static not installed'); }
  const unknown = Object.entries(map).filter(([, l]) => !fs.existsSync(path.join(dir, `${l}.svg`))).map(([n, l]) => `${n} -> ${l}`);
  assert.deepStrictEqual(unknown, []);
});

test('no Central drawing appears in the open set', { skip: !genIsCentral || openPath === genPath }, () => {
  const openSrc = fs.readFileSync(openPath, 'utf8');
  const centralPaths = new Set<string>();
  for (const svg of Object.values(gen)) for (const m of svg.matchAll(/\sd="([^"]{12,})"/g)) centralPaths.add(m[1]);
  const leaked = [...centralPaths].filter((d) => openSrc.includes(d));
  assert.deepStrictEqual(leaked, []);
});
