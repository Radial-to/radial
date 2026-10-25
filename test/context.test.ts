import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import * as context from '../src/main/context';
import type { ContextFileResult } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

// The creates, renames and imports below succeed; a failure has no name, so its asserts fail.
type ContextFileDone = Extract<ContextFileResult, { ok: true }>;

// A real git repo: .radial/ ignores now live in .git/info/exclude, which only
// exists (and only takes effect) inside an actual repo.
function repo() {
  const dir = tmpDir('radial-ctx-');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
const read = (p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const exclude = (dir: string) => read(path.join(dir, '.git', 'info', 'exclude'));

test('creating a context file commits .context/ and hides local data with no Radial record', () => {
  const dir = repo();
  context.create(dir, 'positioning.md');
  const gi = read(path.join(dir, '.gitignore'));
  // The committed thing is .context/ — it is NOT gitignored...
  assert.ok(!/^\.context\/?$/m.test(gi), '.context/ stays committed');
  // ...and the tracked .gitignore names nothing about Radial.
  assert.ok(!/radial/i.test(gi), '.gitignore carries no Radial record');
  // Radial's local-only working data is excluded via the never-committed .git/info/exclude.
  const ex = exclude(dir);
  assert.match(ex, /^\.radial\/$/m);
  assert.match(ex, /^\.radial\.json$/m);
  // The deploy excludes .context/ + .radial/ via a real .vercelignore — but unbranded.
  const vi = read(path.join(dir, '.vercelignore'));
  assert.match(vi, /^\.context\/$/m);
  assert.match(vi, /^\.radial\/$/m);
  assert.ok(!/# Radial/i.test(vi), '.vercelignore comment is neutral');
});

test('migrate moves a legacy .radial/context/ project to .context/ and fixes ignores', async () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, '.radial', 'context'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.radial', 'context', 'notes.md'), '# notes\n');
  // An old project with a blanket ignore + a per-file local override.
  fs.writeFileSync(path.join(dir, '.gitignore'),
    'node_modules\n# Radial context files\n.radial/context/\n.radial/context/secret.md\n');

  await context.migrate(dir); // no gitRm → just the on-disk + ignore migration

  // Files moved to the neutrally-named, committed folder.
  assert.ok(fs.existsSync(path.join(dir, '.context', 'notes.md')), 'context file moved');
  assert.ok(!fs.existsSync(path.join(dir, '.radial', 'context')), 'old context dir removed');

  const gi = read(path.join(dir, '.gitignore'));
  assert.ok(!gi.includes('.radial/context/secret.md'), 'old per-file override rewritten');
  assert.match(gi, /^\.context\/secret\.md$/m, 'per-file override points at .context/');
  assert.ok(!/^\.radial\/context\/$/m.test(gi), 'stale blanket context ignore dropped');
  assert.ok(!/radial/i.test(gi.replace(/^\.context\/secret\.md$/m, '')), 'no Radial working-data record left in .gitignore');
  assert.match(exclude(dir), /^\.radial\/$/m, 'local data now in .git/info/exclude');
  assert.ok(gi.includes('node_modules'), 'unrelated lines preserved');
});

test('migrate de-brands a previously-connected repo (branded .gitignore + .vercelignore)', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, '.gitignore'),
    'node_modules\n# Radial — local working files (not committed)\n.radial/\n.radial.json\n' +
    '# Radial — build artifacts (not committed)\n.next/\ndist/\n');
  fs.writeFileSync(path.join(dir, '.vercelignore'),
    '# Radial — kept in the repo, not deployed\n.context/\n.radial/\n' +
    '# Radial: hidden pages (draft — not deployed)\nabout.html\n# Radial: end hidden pages\n');

  await context.migrate(dir);

  const gi = read(path.join(dir, '.gitignore'));
  const vi = read(path.join(dir, '.vercelignore'));
  assert.ok(!/radial/i.test(gi), 'no Radial string left in .gitignore');
  assert.ok(!/# Radial/i.test(vi), 'no Radial branding left in .vercelignore');
  // Generic build-artifact lines are kept (just de-branded).
  assert.ok(gi.includes('.next/') && gi.includes('dist/') && gi.includes('node_modules'), 'artifact lines preserved');
  // The deploy still excludes the neutral .context/ + .radial/, and the draft page.
  assert.match(vi, /^\.context\/$/m);
  assert.ok(vi.includes('about.html'), 'hidden page kept');
  // Radial's own working data relocated to the never-committed exclude file.
  assert.match(exclude(dir), /^\.radial\/$/m, 'local data relocated to .git/info/exclude');
});

test('setLocal toggles a per-file gitignore line and isLocal reflects it', () => {
  const dir = repo();
  context.create(dir, 'secrets.md');
  assert.equal(context.isLocal(dir, 'secrets.md'), false); // shared by default

  context.setLocal(dir, 'secrets.md', true);
  assert.equal(context.isLocal(dir, 'secrets.md'), true);
  assert.match(read(path.join(dir, '.gitignore')), /^\.context\/secrets\.md$/m);

  context.setLocal(dir, 'secrets.md', false);
  assert.equal(context.isLocal(dir, 'secrets.md'), false);
  assert.ok(!read(path.join(dir, '.gitignore')).includes('secrets.md'));
});

test('list() flags which files are local-only, default shared', () => {
  const dir = repo();
  context.create(dir, 'a.md');
  context.create(dir, 'b.md');
  context.setLocal(dir, 'b.md', true);
  const byName = Object.fromEntries(context.list(dir).map((f) => [f.name, f.local]));
  assert.equal(byName['a.md'], false);
  assert.equal(byName['b.md'], true);
});

test('renaming a local-only file carries the local flag to the new name', () => {
  const dir = repo();
  context.create(dir, 'draft.md');
  context.setLocal(dir, 'draft.md', true);
  context.rename(dir, 'draft.md', 'final.md');
  assert.equal(context.isLocal(dir, 'final.md'), true);
  assert.equal(context.isLocal(dir, 'draft.md'), false); // stale line dropped
});

test('deleting a local-only file drops its gitignore line', () => {
  const dir = repo();
  context.create(dir, 'temp.md');
  context.setLocal(dir, 'temp.md', true);
  context.remove(dir, 'temp.md');
  assert.ok(!read(path.join(dir, '.gitignore')).includes('temp.md'));
});

test('context accepts any file type: real extensions survive, bare names become notes', () => {
  const dir = repo();
  // A bare name is a markdown note (seeded with a title)...
  const note = context.create(dir, 'brand voice') as ContextFileDone;
  assert.equal(note.name, 'brand voice.md');
  assert.match(read(path.join(dir, '.context', note.name)), /^# brand voice/);
  // ...but a real extension is kept, not mangled into .md.
  const pal = context.create(dir, 'palette.json') as ContextFileDone;
  assert.equal(pal.name, 'palette.json');
  assert.equal(read(path.join(dir, '.context', 'palette.json')), '', 'non-markdown starts empty, no # header');
  // Renaming a binary keeps its extension (was: logo.png → logo.png.md).
  fs.writeFileSync(path.join(dir, '.context', 'shot.png'), Buffer.from([1, 2, 3]));
  const r = context.rename(dir, 'shot.png', 'homepage.png') as ContextFileDone;
  assert.equal(r.name, 'homepage.png');
});

test('importBytes writes a pasted screenshot into .context/ with a safe unique name', () => {
  const dir = repo();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const a = context.importBytes(dir, 'screenshot.png', bytes) as ContextFileDone;
  assert.equal(a.name, 'screenshot.png');
  assert.deepEqual(fs.readFileSync(path.join(dir, '.context', a.name)), bytes);
  // Same name again → deduped, not overwritten.
  const b = context.importBytes(dir, 'screenshot.png', bytes) as ContextFileDone;
  assert.equal(b.name, 'screenshot-2.png');
  // No extension → defaults to .png; hostile characters are stripped.
  const c = context.importBytes(dir, '../we|ird', bytes) as ContextFileDone;
  assert.ok(c.name.endsWith('.png'));
  assert.ok(!c.name.includes('/') && !c.name.includes('|'));
  assert.ok(fs.existsSync(path.join(dir, '.context', c.name)));
});
