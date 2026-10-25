// Tests for the project-references module: URL validation, kind detection
// (GitHub repo vs plain web), the pointer store (add/list/remove + dedupe),
// migration off the old linked-repos clone pipeline, and the agent prompt
// section. Pure pointer bookkeeping — no network, no cloning.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as references from '../src/main/references';
import type { Reference, ReferenceUrlError } from '../src/main/references';
import type { RadialConfig } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

function tmpRepo() {
  return tmpDir('radial-refs-test-');
}

const REPO_URL = 'https://github.com/acme/widgets';
const DOCS_URL = 'https://docs.example.com/api/getting-started';

// --- add / kind detection

test('add stores a GitHub repo reference with owner/repo and label', () => {
  const dir = tmpRepo();
  const r = references.add(dir, REPO_URL);
  assert.equal(r.kind, 'github');
  assert.equal(r.owner, 'acme');
  assert.equal(r.repo, 'widgets');
  assert.equal(r.label, 'acme/widgets');
  assert.ok(r.addedAt);
});

test('add stores a plain web reference with a readable label', () => {
  const dir = tmpRepo();
  const r = references.add(dir, DOCS_URL);
  assert.equal(r.kind, 'web');
  assert.equal(r.owner, undefined);
  assert.equal(r.label, 'docs.example.com/api/getting-started');
});

test('a github.com deep link (blob/tree) still counts as that repo', () => {
  const dir = tmpRepo();
  const r = references.add(dir, 'https://github.com/acme/widgets/blob/main/README.md');
  assert.equal(r.kind, 'github');
  assert.equal(r.repo, 'widgets');
});

test('a non-github host with a repo-shaped path is NOT a github ref', () => {
  const dir = tmpRepo();
  const r = references.add(dir, 'https://gitlab.com/acme/widgets');
  assert.equal(r.kind, 'web');
});

test('add rejects junk and non-http links', () => {
  const dir = tmpRepo();
  for (const bad of ['not a url', 'ftp://example.com/x', 'file:///etc/passwd', '']) {
    assert.throws(() => references.add(dir, bad), (e) => (e as ReferenceUrlError).code === 'InvalidReferenceUrl');
  }
});

test('add rejects duplicates (trailing slash / fragment / case noise)', () => {
  const dir = tmpRepo();
  references.add(dir, REPO_URL);
  for (const dup of [REPO_URL, REPO_URL + '/', REPO_URL + '#readme', 'https://GitHub.com/acme/widgets']) {
    assert.throws(() => references.add(dir, dup), (e) => /already attached/.test((e as ReferenceUrlError).message));
  }
  assert.equal(references.list(dir).length, 1);
});

// --- list / remove

test('list returns attached refs; remove drops by url', () => {
  const dir = tmpRepo();
  references.add(dir, REPO_URL);
  references.add(dir, DOCS_URL);
  assert.equal(references.list(dir).length, 2);
  assert.equal(references.remove(dir, REPO_URL + '/'), true, 'remove matches the normalized url');
  assert.equal(references.remove(dir, REPO_URL), false, 'already gone');
  const left = references.list(dir);
  assert.equal(left.length, 1);
  assert.equal(left[0].url, DOCS_URL);
});

test('store coexists with other .radial.json keys', () => {
  const dir = tmpRepo();
  fs.writeFileSync(path.join(dir, '.radial.json'), JSON.stringify({ designRefs: { pages: {} }, hiddenPages: ['/x'] }, null, 2));
  references.add(dir, DOCS_URL);
  const cfg: Pick<RadialConfig, 'hiddenPages'> & { references: Reference[] } = JSON.parse(fs.readFileSync(path.join(dir, '.radial.json'), 'utf8')); // what this test wrote, and the references add() wrote beside it
  assert.deepEqual(cfg.hiddenPages, ['/x'], 'unrelated config survives');
  assert.equal(cfg.references.length, 1);
});

test('a .radial.json that holds something other than an object reads as empty, and add() replaces it', () => {
  // A hand-edited string, number or true made add() throw in the app (strict mode); an array kept the file and lost the reference.
  for (const content of ['"hand edited"', '5', 'true', '[1, 2]', 'null']) {
    const dir = tmpRepo();
    fs.writeFileSync(path.join(dir, '.radial.json'), content);
    assert.deepEqual(references.list(dir), [], content);
    const ref = references.add(dir, DOCS_URL);
    assert.deepEqual(references.list(dir), [ref], content);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.radial.json'), 'utf8')), { references: [ref] }, content);
  }
});

// --- migration off the linked-repos clone pipeline

test('migrates .radial/linked.json pointers to references and removes the clones', () => {
  const dir = tmpRepo();
  const radial = path.join(dir, '.radial');
  fs.mkdirSync(path.join(radial, 'linked', 'acme__widgets'), { recursive: true });
  fs.writeFileSync(path.join(radial, 'linked', 'acme__widgets', 'README.md'), 'x');
  fs.writeFileSync(path.join(radial, 'linked.json'), JSON.stringify([
    { name: 'acme__widgets', owner: 'acme', repo: 'widgets', url: 'https://github.com/acme/widgets.git', addedAt: 1 },
    { garbage: true },
  ]));
  const refs = references.list(dir);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, 'github');
  assert.equal(refs[0].label, 'acme/widgets');
  assert.ok(!fs.existsSync(path.join(radial, 'linked.json')), 'pointer file removed');
  assert.ok(!fs.existsSync(path.join(radial, 'linked')), 'clones removed');
});

test('migration dedupes against an already-attached reference', () => {
  const dir = tmpRepo();
  references.add(dir, 'https://github.com/acme/widgets.git');
  fs.mkdirSync(path.join(dir, '.radial'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.radial', 'linked.json'), JSON.stringify([
    { name: 'acme__widgets', owner: 'acme', repo: 'widgets', url: 'https://github.com/acme/widgets.git' },
  ]));
  assert.equal(references.list(dir).length, 1);
});

// --- prompt section

test('promptSection is empty with no refs and lists each ref with pull guidance', () => {
  const dir = tmpRepo();
  assert.equal(references.promptSection(dir), '');
  references.add(dir, REPO_URL);
  references.add(dir, DOCS_URL);
  const s = references.promptSection(dir);
  assert.ok(s.includes('PROJECT REFERENCES'));
  assert.ok(s.includes('acme/widgets → https://github.com/acme/widgets (GitHub repo)'));
  assert.ok(s.includes(`docs.example.com/api/getting-started → ${DOCS_URL}`));
  assert.ok(/clone --depth 1/.test(s), 'tells the agent how to pull a repo itself');
  assert.ok(/UNTRUSTED/.test(s), 'reference content is flagged untrusted');
  assert.ok(/OUTSIDE this project/.test(s), 'forbids cloning into the project');
});
