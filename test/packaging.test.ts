import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';

// electron-builder's `files` patterns, applied in order: a later pattern wins,
// so a file ships when the last pattern that matches it isn't a negation.
const patterns: string[] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).build.files;
function ships(file: string): boolean {
  let included = false;
  for (const p of patterns) {
    const negated = p.startsWith('!');
    if (minimatch(file, negated ? p.slice(1) : p, { dot: true })) included = !negated;
  }
  return included;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}

test('the files the main process reads at runtime ship in the packaged app', () => {
  // Markdown is left out of the package by default, so a template or playbook
  // that reads its .md files needs its folder added back after that rule.
  const root = path.join(__dirname, '..');
  for (const dir of ['src/main/templates', 'src/main/migrate/playbook']) {
    for (const file of walk(path.join(root, dir))) {
      const rel = path.relative(root, file).split(path.sep).join('/').replace(/^src\//, 'out/');
      assert.ok(ships(rel), `${rel} isn't packaged`);
    }
  }
});

test('the app\'s own source maps ship, so an error report can say where in src/ it happened; a dependency\'s maps and the UI library page stay out', () => {
  assert.equal(ships('out/main/main.js'), true);
  assert.equal(ships('out/main/main.js.map'), true);
  assert.equal(ships('out/renderer/renderer.js.map'), true);
  assert.equal(ships('out/core/sessions.js.map'), true);
  assert.equal(ships('node_modules/posthog-node/lib/index.cjs.map'), false);
  assert.equal(ships('out/renderer/ui/index.html'), false);
  assert.equal(ships('out/renderer/ui/library.js.map'), false);
});

test('the build writes a map beside each compiled file, with no source inside, and the file names it', () => {
  const out = path.join(__dirname, '..', 'out');
  if (!fs.existsSync(path.join(out, 'main', 'main.js'))) return; // not built: npm test builds first
  for (const rel of ['main/main.js', 'main/errorReport.js', 'renderer/renderer.js', 'renderer/windowErrors.js']) {
    const map = JSON.parse(fs.readFileSync(path.join(out, `${rel}.map`), 'utf8')) as { sources: string[]; sourcesContent?: unknown };
    assert.deepEqual(map.sources, [`src/${rel.replace(/\.js$/, '.ts')}`], rel);
    assert.equal(map.sourcesContent, undefined, `${rel}.map carries no source`);
    assert.match(fs.readFileSync(path.join(out, rel), 'utf8'), new RegExp(`//# sourceMappingURL=${path.basename(rel)}\\.map\\n$`));
  }
});
