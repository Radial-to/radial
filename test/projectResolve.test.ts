// "Which project did they mean?" — paths, GitHub links, names; strict about
// close calls (ambiguous, never a guess). Pure module; helpers injected.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import { resolve, candidates } from '../src/main/projectResolve';
import { normalizeOpenPath } from '../src/main/cliOpen';
import { urlFromText } from '../src/main/github';
import * as fuzzy from '../src/renderer/fuzzy.js';
import { tmpDir } from './support/tmp';
// Each check expects one kind of answer (a path, not-found, ambiguous) and reads only its fields.
import type { ProjectSources, ResolveAmbiguous, ResolvedPath, ResolveNotFound, ResolveOptions } from '../src/main/projectResolve';

function tmpProject(name: string) {
  const d = tmpDir('radial-res-');
  const p = path.join(d, name); fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'index.html'), '<h1>x</h1>');
  return p;
}
const base = (sources: ProjectSources = {}, extra: Partial<ResolveOptions> = {}): ResolveOptions => ({ cwd: process.cwd(), sources, normalizeOpenPath, urlFromText, fuzzy, findLocalCopy: null, ...extra });

test('empty or "." is the working directory; a file resolves to its folder; a missing path-shaped query is not-found, never a guess', () => {
  const p = tmpProject('summit-site');
  const cwdOpts = base({}, { cwd: p });
  assert.deepEqual(resolve('', cwdOpts), { ok: true, kind: 'path', dir: p });
  assert.equal((resolve('.', cwdOpts) as ResolvedPath).dir, p);
  assert.equal((resolve(path.join(p, 'index.html'), base()) as ResolvedPath).dir, p);
  const miss = resolve('/definitely/not/here', base({ recents: [{ path: p, name: 'summit-site' }] })) as ResolveNotFound;
  assert.equal(miss.ok, false); assert.equal(miss.code, 'not-found');
  assert.equal((resolve('./nope-' + Date.now(), base()) as ResolveNotFound).code, 'not-found');
});

test('a GitHub link, git@ form, or bare owner/repo resolves to the local copy when one exists, else to a clone', () => {
  const local = tmpProject('acme__site');
  const opts = base({}, { findLocalCopy: (url) => (url === 'https://github.com/acme/site' ? local : null) });
  assert.deepEqual(resolve('https://github.com/acme/site', opts), { ok: true, kind: 'path', dir: local, repo: 'https://github.com/acme/site' });
  assert.equal((resolve('git@github.com:acme/site.git', opts) as ResolvedPath).dir, local);
  assert.equal((resolve('acme/site', opts) as ResolvedPath).dir, local);
  assert.deepEqual(resolve('acme/other', opts), { ok: true, kind: 'clone', url: 'https://github.com/acme/other' });
  assert.equal((resolve('github.com/orgs/acme', opts) as ResolveNotFound).code, 'not-found', 'reserved first segments are not repos');
});

test('a bare owner/repo that exists as a relative folder is a path, not a repo', () => {
  const root = tmpDir('radial-res-');
  fs.mkdirSync(path.join(root, 'sites', 'acme'), { recursive: true });
  const r = resolve('sites/acme', base({}, { cwd: root })) as ResolvedPath;
  assert.equal(r.kind, 'path'); assert.equal(r.dir, path.join(root, 'sites', 'acme'));
});

test('names: an exact match on project name, folder, page title or owner/repo wins when unique', () => {
  const a = tmpProject('summit-site'), b = tmpProject('acme-store');
  const sources = { open: [{ path: a, name: 'summit', pageTitle: 'Summit — design service', suspended: false }], recents: [{ path: b, name: 'acme-store', lastOpened: 1 }], workspace: [{ path: b, name: 'acme__acme-store', repo: 'acme/acme-store' }] };
  assert.equal((resolve('summit', base(sources)) as ResolvedPath).dir, a);
  assert.equal((resolve('SUMMIT-SITE', base(sources)) as ResolvedPath).dir, a, 'folder name, case-insensitive');
  assert.equal((resolve('Summit — design service', base(sources)) as ResolvedPath).dir, a, 'page title');
  assert.equal((resolve('acme/acme-store', base(sources)) as ResolvedPath).dir, b, 'owner/repo of a workspace clone beats a clone attempt');
  assert.equal((resolve('acme', base(sources)) as ResolvedPath).dir, b, 'fuzzy substring hit with one candidate');
});

test('names: duplicates and close fuzzy scores come back ambiguous with candidates; nothing similar is not-found', () => {
  const a = tmpProject('summit-site'), b = tmpProject('summit-blog');
  const dup = resolve('summit', base({ recents: [{ path: a, name: 'summit', lastOpened: 5 }, { path: b, name: 'summit', lastOpened: 4 }] })) as ResolveAmbiguous;
  assert.equal(dup.code, 'ambiguous'); assert.equal(dup.candidates.length, 2); assert.equal(dup.candidates[0].reason, 'exact');
  const close = resolve('summit', base({ recents: [{ path: a, name: 'summit-site', lastOpened: 5 }, { path: b, name: 'summit-blog', lastOpened: 5 }] })) as ResolveAmbiguous;
  assert.equal(close.code, 'ambiguous', 'two substring hits with the same lead are not guessed');
  assert.deepEqual(close.candidates.map((c) => c.name).sort(), ['summit-blog', 'summit-site']);
  const none = resolve('zzqx', base({ recents: [{ path: a, name: 'summit-site' }] })) as ResolveNotFound;
  assert.equal(none.code, 'not-found'); assert.match(none.error, /radial ls --all/);
});

test('names: recency and being open break a fuzzy tie in favour of what the person is using', () => {
  const a = tmpProject('summit-site'), b = tmpProject('summit-blog');
  const now = Date.now();
  const r = resolve('summit', base({ open: [{ path: a, name: 'summit-site', suspended: false }], recents: [{ path: a, name: 'summit-site', lastOpened: now }, { path: b, name: 'summit-blog', lastOpened: now - 40 * 24 * 3600 * 1000 }] })) as ResolvedPath;
  assert.equal(r.ok, true); assert.equal(r.dir, a); assert.equal(r.match, 'fuzzy');
});

test('candidates dedupe by path and collect every name a project answers to', () => {
  const a = '/tmp/x/summit-site';
  const c = candidates({ open: [{ path: a, name: 'summit', pageTitle: 'Summit' }], recents: [{ path: a, name: 'summit', lastOpened: 3 }], workspace: [{ path: a, name: 'summit-site', repo: 'summit-co/summit-site' }] });
  assert.equal(c.length, 1);
  assert.deepEqual([...c[0].names].sort(), ['Summit', 'summit', 'summit-co/summit-site', 'summit-site']);
  assert.equal(c[0].open, true); assert.equal(c[0].lastOpened, 3);
});
