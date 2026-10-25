import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as comments from '../src/main/comments';
import * as projectData from '../src/main/projectData';
import type { CommentImageImport, CommentImageSave, CommentsRead, CommentsRefusal, StoredComment } from '../src/main/comments';
import type { OkOrError } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

// The calls below succeed or refuse as each test sets up, and each asserts it, so
// a result is cast to the branch the test expects.
type SavedImage = Extract<CommentImageSave, { ok: true }>;
type ImportedImage = Extract<CommentImageImport, { ok: true }>;

function tmp() { return tmpDir('radial-cm-'); }
function vercelignore(repoDir: string): string {
  try { return fs.readFileSync(path.join(repoDir, '.vercelignore'), 'utf8'); } catch { return ''; }
}

test('adds and lists a page comment with its anchor', () => {
  const dir = tmp();
  const c = comments.add(dir, { route: '/pricing', selector: '.hero h1', anchor: 'h1.hero', text: 'tighten this' }) as StoredComment;
  assert.ok(c.id);
  assert.equal(c.resolved, false);
  assert.equal(c.file, '');     // page comment → no file anchor
  assert.equal(c.quote, '');
  const list = comments.list(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].route, '/pricing');
  assert.equal(list[0].selector, '.hero h1');
});

test('adds a context-file comment anchored to a file + quote', () => {
  const dir = tmp();
  const c = comments.add(dir, { file: '.context/notes.md', quote: 'tone is too formal', text: 'loosen it up' }) as StoredComment;
  assert.equal(c.file, '.context/notes.md');
  assert.equal(c.quote, 'tone is too formal');
  assert.equal(c.route, '/'); // route defaults but is unused for file comments
  const stored = comments.list(dir)[0];
  assert.equal(stored.file, '.context/notes.md');
  assert.equal(stored.text, 'loosen it up');
});

test('persisting a comment keeps .radial out of the deploy', () => {
  const dir = tmp();
  comments.add(dir, { route: '/', text: 'x' });
  const vi = vercelignore(dir);
  assert.match(vi, /^\.radial\/?$/m);
});

test('update patches fields; remove deletes by id', () => {
  const dir = tmp();
  const c = comments.add(dir, { route: '/', text: 'fix copy' }) as StoredComment;
  const updated = comments.update(dir, c.id, { resolved: true, addressed: true }) as StoredComment;
  assert.equal(updated.resolved, true);
  assert.equal(updated.addressed, true);
  assert.equal(comments.list(dir)[0].resolved, true); // persisted

  comments.remove(dir, c.id);
  assert.equal(comments.list(dir).length, 0);
});

test('update on a missing id returns null and changes nothing', () => {
  const dir = tmp();
  comments.add(dir, { route: '/', text: 'a' });
  assert.equal(comments.update(dir, 'nope', { resolved: true }), null);
  assert.equal(comments.list(dir).length, 1);
});

test('list on a project with no comments file is empty (not an error)', () => {
  assert.deepEqual(comments.list(tmp()), []);
});

test('saveImage writes bytes under .radial/comment-images and returns a repo-relative path', () => {
  const dir = tmp();
  const res = comments.saveImage(dir, 'shot.png', Buffer.from([1, 2, 3, 4])) as SavedImage;
  assert.equal(res.ok, true);
  assert.equal(res.rel, '.radial/comment-images/shot.png');
  assert.ok(fs.existsSync(path.join(dir, res.rel)));
  assert.match(vercelignore(dir), /\.radial/);
});

test('saveImage de-dupes filenames instead of overwriting', () => {
  const dir = tmp();
  const a = comments.saveImage(dir, 'pic.png', Buffer.from('a')) as SavedImage;
  const b = comments.saveImage(dir, 'pic.png', Buffer.from('b')) as SavedImage;
  assert.equal(a.rel, '.radial/comment-images/pic.png');
  assert.equal(b.rel, '.radial/comment-images/pic-2.png'); // second keeps its own file
});

test('saveImage gives a bare name a .png extension', () => {
  const dir = tmp();
  const res = comments.saveImage(dir, 'pasted', Buffer.from('x')) as SavedImage;
  assert.match(res.rel, /\.png$/);
});

test('importImage copies a source file into the repo', () => {
  const dir = tmp();
  const srcDir = tmp();
  const src = path.join(srcDir, 'ref.png');
  fs.writeFileSync(src, Buffer.from('hello'));
  const res = comments.importImage(dir, src) as ImportedImage;
  assert.equal(res.ok, true);
  assert.equal(res.rel, '.radial/comment-images/ref.png');
  assert.equal(fs.readFileSync(path.join(dir, res.rel), 'utf8'), 'hello');
});

test('importImage of a missing file fails gracefully', () => {
  const dir = tmp();
  const res = comments.importImage(dir, path.join(tmp(), 'does-not-exist.png'));
  assert.equal(res.ok, false);
});

// ── Corruption guard ──────────────────────────────────────────────────────
// External agents edit comments.json now (the AGENTS.md contract). A bad
// agent write must make mutations refuse — not read as [] and save a wipe.

test('mutations refuse when comments.json is not valid JSON, leaving the file untouched', () => {
  const dir = tmp();
  const seeded = comments.add(dir, { route: '/', text: 'keep me' }) as StoredComment;
  const f = path.join(dir, '.radial', 'comments.json');
  fs.writeFileSync(f, '[{"id": "broken",');
  const raw = fs.readFileSync(f, 'utf8');

  const added = comments.add(dir, { route: '/', text: 'nope' }) as CommentsRefusal;
  assert.ok(added.error);
  const updated = comments.update(dir, seeded.id, { resolved: true }) as CommentsRefusal;
  assert.ok(updated.error);
  const removed = comments.remove(dir, seeded.id) as Extract<OkOrError, { ok: false }>;
  assert.equal(removed.ok, false);
  assert.ok(removed.error);
  assert.equal(fs.readFileSync(f, 'utf8'), raw); // byte-identical — nothing wiped
});

test('an entry that is not a comment object is skipped by list and makes mutations refuse, leaving the file untouched', () => {
  const dir = tmp();
  const seeded = comments.add(dir, { route: '/', text: 'keep me' }) as StoredComment;
  const f = path.join(dir, '.radial', 'comments.json');
  fs.writeFileSync(f, JSON.stringify([null, seeded, 5, 'fix the hero', [seeded]], null, 2) + '\n');
  const raw = fs.readFileSync(f, 'utf8');

  assert.deepEqual(comments.list(dir).map((c) => c.id), [seeded.id]); // the window and the CLI read this
  const strict = comments.readStrict(dir) as Extract<CommentsRead, { ok: false }>;
  assert.equal(strict.ok, false);
  assert.ok(strict.error);
  const added = comments.add(dir, { route: '/', text: 'nope' }) as CommentsRefusal;
  assert.ok(added.error);
  const updated = comments.update(dir, seeded.id, { resolved: true }) as CommentsRefusal;
  assert.ok(updated.error);
  const removed = comments.remove(dir, seeded.id) as Extract<OkOrError, { ok: false }>;
  assert.equal(removed.ok, false);
  assert.ok(removed.error);
  assert.equal(fs.readFileSync(f, 'utf8'), raw); // byte-identical: nothing dropped or wiped
});

test('a valid-JSON-but-not-array file also refuses mutations', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.radial'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.radial', 'comments.json'), '{"not":"an array"}');
  const added = comments.add(dir, { route: '/', text: 'nope' }) as CommentsRefusal;
  assert.ok(added.error);
});

test('an empty or missing file still accepts writes', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.radial'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.radial', 'comments.json'), '\n');
  const c = comments.add(dir, { route: '/', text: 'first' }) as StoredComment;
  assert.ok(c.id);
  assert.equal(comments.list(dir).length, 1);
});

test('agent-added fields (resolvedBy) survive a Radial-side save round-trip', () => {
  const dir = tmp();
  const c = comments.add(dir, { route: '/', text: 'fix the hero' }) as StoredComment;
  // Simulate an external agent resolving in place, per the AGENTS.md contract.
  const f = path.join(dir, '.radial', 'comments.json');
  const arr = JSON.parse(fs.readFileSync(f, 'utf8')) as StoredComment[];
  arr[0].resolved = true;
  arr[0].resolvedBy = 'claude-code';
  fs.writeFileSync(f, JSON.stringify(arr, null, 2) + '\n');
  // A Radial-side mutation on another comment must not strip the agent's fields.
  comments.add(dir, { route: '/about', text: 'second' });
  const after = comments.list(dir).find((x) => x.id === c.id)!;
  assert.equal(after.resolved, true);
  assert.equal(after.resolvedBy, 'claude-code');
});

test('save is atomic: the file is replaced by rename and no temp file lingers', () => {
  const dir = tmp();
  comments.add(dir, { route: '/', text: 'one' });
  comments.add(dir, { route: '/', text: 'two' });
  const files = fs.readdirSync(path.join(dir, '.radial'));
  assert.deepEqual(files.filter((f) => f.startsWith('comments.json')), ['comments.json']);
  assert.equal(comments.list(dir).length, 2);
});

// Last in the file: it points projectData at a throwaway profile, which no
// earlier test expects (they keep comments in the repo's .radial/).
test('with local storage, an entry that is not a comment object no longer hides every comment', () => {
  const root = tmp();
  const repo = path.join(root, 'site');
  fs.mkdirSync(repo);
  projectData.init(path.join(root, 'app'));
  projectData.set({ defaultLocal: true });
  projectData.activate(repo);
  assert.equal(projectData.isLocal(repo), true);
  const kept = comments.add(repo, { route: '/', text: 'keep me' }) as StoredComment;
  fs.writeFileSync(projectData.dataDir(repo, 'comments.json'), JSON.stringify([null, kept]));
  assert.deepEqual(comments.list(repo).map((c) => c.id), [kept.id]);
});
