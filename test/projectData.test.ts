import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as data from '../src/main/projectData';
import * as context from '../src/main/context';
import * as memory from '../src/main/projectMemory';
import * as comments from '../src/main/comments';
import * as publish from '../src/main/publish';
import * as refs from '../src/main/references';
import type { TestContext } from 'node:test';
import type { CommentImageSave, StoredComment } from '../src/main/comments';
import type { DevInfo } from '../src/main/devServer';
import type { ContextFileResult, LaunchCheckItem, LaunchCheckScan, RadialConfig } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

// Setup calls on a fresh fixture succeed, so the first test reads each result's success side.
type ContextFileCreated = Extract<ContextFileResult, { ok: true }>;
type ImageSaved = Extract<CommentImageSave, { ok: true }>;

function fixture(t: TestContext) {
  const root = tmpDir('radial-storage-');
  const repo = path.join(root, 'site'), userData = path.join(root, 'app');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'index.html'), '<h1>Hello</h1>');
  data.init(userData);
  data.set({ defaultLocal: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo, userData };
}
/** Every file under dir, by its path relative to dir, as base64 of its bytes. */
function files(dir: string) {
  const out: Record<string, string> = {};
  function visit(base: string, rel = '') {
    for (const name of fs.readdirSync(base)) {
      const file = path.join(base, name), key = rel + name;
      if (fs.statSync(file).isDirectory()) visit(file, key + '/');
      else out[key] = fs.readFileSync(file).toString('base64');
    }
  }
  visit(dir);
  return out;
}

test('local metadata operations leave all repository files and the Git index unchanged', async t => {
  const { repo } = fixture(t);
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Shared rules\nKeep the original design.\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(repo, '.vercelignore'), 'private/\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  const before = files(repo);
  data.activate(repo);
  publish.writeConfig(repo, { stagingBranch: 'preview', commitConfig: true });
  refs.add(repo, 'https://example.com/docs');
  const doc = context.create(repo, 'brand') as ContextFileCreated;
  assert.equal(context.write(repo, doc.rel, '# Local brand\nUse green.').ok, true);
  const note = comments.add(repo, { text: 'Change this heading' }) as StoredComment;
  const image = comments.saveImage(repo, 'reference.png', [1, 2, 3]) as ImageSaved;
  assert.equal(path.isAbsolute(image.rel), true);
  comments.update(repo, note.id, { images: [image.rel] });
  memory.addRule(repo, 'Keep the billing note.');
  memory.syncContextIndex(repo, context.list(repo), refs.list(repo));
  memory.ensurePreviewNote(repo); memory.ensureStateFilesNote(repo); memory.ensureCliNote(repo);
  memory.excludeFromDeploy(repo);
  await context.migrate(repo, () => { throw new Error('Must not run git rm'); });
  assert.equal(context.setLocal(repo, doc.rel, false).ok, false);
  (require('../src/main/launchCheck') as typeof import('../src/main/launchCheck')).persist(repo, { results: [] as LaunchCheckItem[] } satisfies Partial<LaunchCheckScan> as LaunchCheckScan); // a stub scan: persist writes what it's given, and only where it lands matters here
  (require('../src/main/moments') as typeof import('../src/main/moments')).saveThumb(repo, 'test', 'data:image/png;base64,AQID');
  const preview = await (require('../src/main/devServer') as typeof import('../src/main/devServer')).start(repo);
  try {
    assert.equal(((JSON.parse as (text: { toString(): string }) => unknown)(fs.readFileSync(data.dataDir(repo, 'dev.json'))) as DevInfo).url, preview.url); // JSON.parse reads the Buffer as its text (it calls toString on its argument); start() wrote dev.json
    assert.equal((require('../src/main/cli') as typeof import('../src/main/cli')).readDevUrl(repo), preview.url);
    const bundle = (require('../src/main/cli') as typeof import('../src/main/cli')).offlineContext(repo);
    assert.match(bundle.rules, /original design/);
    assert.match(bundle.rules, /billing note/);
    assert.equal(bundle.docs[0].content, '# Local brand\nUse green.');
    const prompt = (require('../src/main/engine') as typeof import('../src/main/engine')).contextFor(repo);
    assert.ok(prompt.includes(data.dataDir(repo, 'dev.json')));
    assert.ok(prompt.includes(context.absPath(repo, doc.rel)!)); // the note create() just made: a safe path
  } finally { await preview.stop(); }
  assert.equal(publish.readConfig(repo).stagingBranch, 'preview');
  assert.deepEqual(files(repo), before);
});

test('machine default, per-project overrides, pending changes, and persistence are independent', t => {
  const { root, repo, userData } = fixture(t);
  const other = path.join(root, 'other'); fs.mkdirSync(other);
  assert.equal(data.status(repo).local, true);
  data.set({ defaultLocal: false });
  assert.equal(data.status(repo).pending, true);
  data.set({ repoDir: repo, preference: 'local' });
  assert.equal(data.status(repo).pending, false);
  assert.equal(data.status(other).local, false);
  data.activate(other);
  data.set({ repoDir: other, preference: 'local' });
  data.activate(other);
  assert.equal(data.isLocal(other), false, 'an active workspace keeps its storage paths');
  data.release(other);
  data.activate(other, { defer: true });
  assert.equal(data.isLocal(other), false, 'surviving terminals defer a storage switch');
  data.release(other);
  data.activate(other);
  assert.equal(data.isLocal(other), true);
  data.init(userData);
  assert.equal(data.status().defaultLocal, false);
  assert.equal(data.status(repo).preference, 'local');
  assert.equal(data.status(other).preference, 'local');
});

test('imports existing metadata without deleting originals; switching round trips updated data', t => {
  const { repo } = fixture(t);
  fs.mkdirSync(path.join(repo, '.radial'));
  fs.writeFileSync(path.join(repo, '.radial', 'comments.json'), '[{"id":"old","text":"Keep me"}]');
  fs.writeFileSync(path.join(repo, '.radial.json'), '{"stagingBranch":"preview"}');
  const original = files(repo);
  assert.equal(comments.list(repo)[0].text, 'Keep me');
  assert.deepEqual(files(repo), original);
  publish.writeConfig(repo, { stagingBranch: 'qa' });
  data.set({ repoDir: repo, preference: 'project' });
  data.activate(repo);
  assert.equal(data.isLocal(repo), false);
  assert.equal(publish.readConfig(repo).stagingBranch, 'qa');
  publish.writeConfig(repo, { stagingBranch: 'next' });
  data.release(repo);
  data.set({ repoDir: repo, preference: 'local' });
  data.activate(repo);
  assert.equal(publish.readConfig(repo).stagingBranch, 'next');
});

test('two storage switches in the same millisecond each keep their backup', t => {
  t.mock.method(Date, 'now', () => 1792278057411); // a fast machine: both switches read the same time
  const { repo, userData } = fixture(t);
  fs.writeFileSync(path.join(repo, '.radial.json'), '{"stagingBranch":"preview"}');
  publish.writeConfig(repo, { stagingBranch: 'qa' });
  data.set({ repoDir: repo, preference: 'project' });
  data.activate(repo); // the repo's own config is backed up before the local one replaces it
  publish.writeConfig(repo, { stagingBranch: 'next' });
  data.release(repo);
  data.set({ repoDir: repo, preference: 'local' });
  data.activate(repo); // and the local one before the repo's replaces it
  assert.equal(publish.readConfig(repo).stagingBranch, 'next');
  const [id] = fs.readdirSync(path.join(userData, 'project-data')).filter((n) => n !== 'preferences.json');
  const backups = fs.readdirSync(path.join(userData, 'project-data', id, 'storage-backups'));
  assert.equal(backups.length, 2, backups.join(', '));
  const saved = backups.map((b) => (JSON.parse(fs.readFileSync(path.join(userData, 'project-data', id, 'storage-backups', b, 'config'), 'utf8')) as RadialConfig).stagingBranch).sort();
  assert.deepEqual(saved, ['preview', 'qa'], 'the repo’s config from the first switch, the local one from the second');
});

test('a conflicting destination is preserved and the storage switch fails safely', t => {
  const { repo } = fixture(t);
  fs.writeFileSync(path.join(repo, '.radial.json'), '{"stagingBranch":"old"}');
  publish.writeConfig(repo, { stagingBranch: 'local' });
  fs.writeFileSync(path.join(repo, '.radial.json'), '{"stagingBranch":"teammate"}');
  data.set({ repoDir: repo, preference: 'project' });
  assert.throws(() => data.activate(repo), /different versions/);
  assert.equal(data.isLocal(repo), true);
  assert.equal(publish.readConfig(repo).stagingBranch, 'local');
  assert.equal(((JSON.parse as (text: { toString(): string }) => unknown)(fs.readFileSync(path.join(repo, '.radial.json'))) as Partial<RadialConfig>).stagingBranch, 'teammate'); // JSON.parse reads the Buffer as its text (it calls toString on its argument); the config this test wrote
});

test('project aliases share a preference, while moves preserve the local data folder', t => {
  const { root, repo } = fixture(t);
  const alias = path.join(root, 'alias'); fs.symlinkSync(repo, alias);
  publish.writeConfig(repo, { stagingBranch: 'keep' });
  assert.equal(data.configPath(alias), data.configPath(repo));
  const before = data.status(repo).folder;
  const moved = path.join(root, 'moved'); fs.renameSync(repo, moved); data.rekey(repo, moved);
  assert.equal(data.status(moved).folder, before);
  assert.equal(publish.readConfig(moved).stagingBranch, 'keep');
});

test('migration does not follow a repository symlink into unrelated files', t => {
  const { root, repo } = fixture(t);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret'), 'leave alone');
  fs.symlinkSync(outside, path.join(repo, '.radial'));
  assert.throws(() => data.activate(repo), /symbolic link/);
  assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'leave alone');
});

test('legacy notes are imported locally without changing either repository copy', t => {
  const { repo } = fixture(t);
  fs.mkdirSync(path.join(repo, '.radial', 'context'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.context'));
  fs.writeFileSync(path.join(repo, '.radial', 'context', 'old.md'), 'Old note');
  fs.writeFileSync(path.join(repo, '.radial', 'context', 'brand.md'), 'Old brand');
  fs.writeFileSync(path.join(repo, '.context', 'brand.md'), 'Current brand');
  const before = files(repo);
  data.activate(repo);
  assert.equal(fs.readFileSync(path.join(data.contextDir(repo), 'old.md'), 'utf8'), 'Old note');
  assert.equal(fs.readFileSync(path.join(data.contextDir(repo), 'brand.md'), 'utf8'), 'Current brand');
  assert.deepEqual(files(repo), before);
});

test('switching back cannot write through a destination symlink', t => {
  const { root, repo } = fixture(t);
  comments.add(repo, { text: 'Local note' });
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(repo, '.radial'));
  data.set({ repoDir: repo, preference: 'project' });
  assert.throws(() => data.activate(repo), /symbolic link/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(data.isLocal(repo), true);
});

test('an upgrade retains project-folder storage until local mode is chosen', t => {
  const { root, repo } = fixture(t);
  const profile = path.join(root, 'upgrade-profile');
  fs.writeFileSync(path.join(repo, '.radial.json'), '{"stagingBranch":"existing"}');
  data.init(profile);
  assert.equal(data.status().defaultLocal, false);
  assert.equal(data.configPath(repo), path.join(fs.realpathSync(repo), '.radial.json'));
  assert.equal(publish.readConfig(repo).stagingBranch, 'existing');
  data.set({ defaultLocal: true });
  data.init(profile);
  assert.equal(data.status().defaultLocal, true, 'an explicit machine preference survives relaunch');
  assert.equal(data.status(repo).pending, true, 'existing projects switch on reopen');
});
