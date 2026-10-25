import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { UiAudit } from '../src/renderer/ui/catalog.js';

test('UI library uses live styles, resolves sources, and stays out of release builds', async () => {
  const { catalog, surfaces } = await import('../src/renderer/ui/catalog.js');
  assert.equal(new Set(catalog.map((p) => p.id)).size, catalog.length);
  assert.ok(catalog.length >= 12);
  for (const entry of catalog) {
    assert.ok(entry.usage && entry.description);
    for (const source of entry.sources) assert.ok(fs.existsSync(path.join(__dirname, '..', source)), source);
    for (const example of entry.examples) {
      assert.doesNotMatch(example.html, /onclick=|window\.radial|<script/i);
      assert.ok(example.title);
    }
  }
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/index.html'), 'utf8');
  assert.match(html, /\/src\/renderer\/styles\.css/);
  assert.match(html, /\/src\/renderer\/workspace\.css/);
  assert.doesNotMatch(html, /renderer\.js|preload|welcome/);
  const config = require('../package.json') as typeof import('../package.json');
  assert.ok(config.build.files.includes('!out/renderer/ui/**/*'));
});

test('new library and workspace use semantic colors; shared tokens exist', () => {
  const base = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
  for (const token of ['shadow-panel', 'shadow-dialog', 'btn-hover', 'canvas-surface', 'canvas-text', 'canvas-muted', 'canvas-border', 'success', 'warning']) {
    assert.match(base, new RegExp(`--${token}:`));
  }
  for (const file of ['workspace.css', 'ui/library.css']) {
    const css = fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8');
    assert.doesNotMatch(css, /(?:color|background(?:-color)?):\s*#[0-9a-f]{3,8}\b/i, file);
    assert.doesNotMatch(css, /transition:\s*all\b/);
  }
});

test('UI source census follows the live panel registry and records review locations', async () => {
  const { auditUI } = await import('../scripts/ui-audit.mts');
  const report: UiAudit = await auditUI();
  assert.ok(report.tokenCount > 50);
  assert.ok(report.selectorCount > 1000);
  assert.ok(report.panels.some((p) => p.id === 'publish'));
  assert.ok(report.panels.some((p) => p.id === 'adjust' && p.experimental));
  assert.ok(report.rawDeclarations.every((d) => d.file && d.line > 0 && d.selector && d.property));
});

test('library server is read-only and limits exposed files', async () => {
  const { createLibraryServer } = await import('../scripts/ui-library.mts');
  const server = createLibraryServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await fetch(origin)).status, 200);
    assert.equal((await fetch(`${origin}/src/renderer/ui/catalog.js`)).status, 200);
    const census: UiAudit = await (await fetch(`${origin}/ui-audit.json`)).json();
    assert.ok(census.panels.length >= 20);
    assert.equal((await fetch(`${origin}/package.json`)).status, 403);
    assert.equal((await fetch(`${origin}/.env`)).status, 403);
    assert.equal((await fetch(`${origin}/src/main/main.js`)).status, 403);
    assert.equal((await fetch(origin, { method: 'POST', body: 'test' })).status, 403);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
