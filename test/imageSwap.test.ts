// An image swap (src/core/edits.ts swapImageFile, behind the window's image
// panels and `radial edit image`): the new file goes where the old one lives,
// so the src, whose file name is all the swap rewrites, still finds it. The
// page names its images by URL (an <img>'s currentSrc), and the file behind
// that URL is in the repo, or in the folder its dev server serves (public/,
// static/…).

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import { createCore } from '../src/core';
import type { CoreHost } from '../src/core';
import { swapImageFile } from '../src/core/edits';
import * as projectState from '../src/main/projectState';
import * as recents from '../src/main/recents';
import { tmpDir } from './support/tmp';

const dataDir = tmpDir('radial-swap-');
const host: CoreHost = {
  platform: { version: '9.9.9', flavor: 'dev', dataDir, home: dataDir, osVersion: 'test', cliBin: path.join(dataDir, 'radial'), keepAwake() {} },
  page: null,
  viewer: null,
  events: { send() {}, listening: () => false },
};
recents.init(dataDir);
projectState.init(dataDir);
createCore(host, { idleSleepMs: null, parkAgents: false, browserShims: false });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==', 'base64');
/** A site in a new folder: its files by path. */
function site(files: Record<string, string | Buffer>): string {
  const dir = path.join(tmpDir('radial-swap-site-'), 'site');
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); }
  return dir;
}
const chosen = path.join(dataDir, 'new.png');
fs.writeFileSync(chosen, PNG);

test('a static site’s image: the new file goes beside the old one, named by its URL or by its path', () => {
  for (const src of ['http://127.0.0.1:4321/img/logo.png', '/img/logo.png']) {
    const dir = site({ 'index.html': '<!doctype html><html><body><img src="/img/logo.png" alt="Logo"></body></html>', 'img/logo.png': PNG });
    const r = swapImageFile(dir, src, chosen);
    assert.equal(r.ok, true, `${src}: ${JSON.stringify(r)}`);
    assert.equal(r.copiedTo, path.join('img', 'logo-radial.png'), `${src}: beside the old file`);
    assert.equal(r.newSrc, '/img/logo-radial.png');
    assert.ok(fs.existsSync(path.join(dir, 'img', 'logo-radial.png')));
    assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /<img src="\/img\/logo-radial\.png" alt="Logo">/, 'and the src that served the old one serves the new one');
  }
});

test('a framework’s image in public/: the new file goes in the same folder there', () => {
  const dir = site({ 'package.json': '{"name":"app"}', 'src/pages/index.astro': '<img src="/images/hero/hero.png" alt="Hero" />', 'public/images/hero/hero.png': PNG, 'public/favicon.svg': '<svg/>' });
  const r = swapImageFile(dir, 'http://localhost:4321/images/hero/hero.png?v=2', chosen);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.copiedTo, path.join('public', 'images', 'hero', 'hero-radial.png'));
  assert.equal(r.newSrc, '/images/hero/hero-radial.png');
  assert.match(fs.readFileSync(path.join(dir, 'src', 'pages', 'index.astro'), 'utf8'), /<img src="\/images\/hero\/hero-radial\.png" alt="Hero" \/>/);
});

test('a relative src keeps its folder too', () => {
  const dir = site({ 'index.html': '<img src="img/logo.png">', 'img/logo.png': PNG });
  const r = swapImageFile(dir, 'img/logo.png', chosen);
  assert.deepEqual([r.ok, r.copiedTo, r.newSrc], [true, path.join('img', 'logo-radial.png'), 'img/logo-radial.png']);
});

test('an image that isn’t on disk (a CDN’s, say) goes to the site’s asset folder, as before', () => {
  const dir = site({ 'index.html': '<img src="https://cdn.example.com/a/photo.png">', 'public/robots.txt': '' });
  const r = swapImageFile(dir, 'https://cdn.example.com/a/photo.png', chosen);
  assert.equal(r.copiedTo, path.join('public', 'photo-radial.png'));
  assert.ok(fs.existsSync(path.join(dir, 'public', 'photo-radial.png')));
});

test('a URL that climbs out of the site finds nothing there', () => {
  const outside = path.join(path.dirname(dataDir), 'outside.png');
  const dir = site({ 'index.html': '<img src="/../../outside.png">' });
  const r = swapImageFile(dir, '/../../../../../../' + path.basename(outside), chosen);
  assert.ok(!r.copiedTo || !r.copiedTo.startsWith('..'), `stays inside the site: ${r.copiedTo}`);
});
