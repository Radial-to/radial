import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as vercel from '../src/main/vercel';
import { tmpDir } from './support/tmp';

function tmp() { return tmpDir('radial-vc-'); }
const read = (p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

test('readLink parses .vercel/project.json when present', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.vercel'));
  fs.writeFileSync(path.join(dir, '.vercel', 'project.json'),
    JSON.stringify({ projectId: 'prj_123', orgId: 'team_abc', projectName: 'my-site' }));
  const link = vercel.readLink(dir);
  assert.equal(link.linked, true);
  assert.equal(link.projectId, 'prj_123');
  assert.equal(link.orgId, 'team_abc');
  assert.equal(link.name, 'my-site');
});

test('readLink reports unlinked when there is no .vercel link', () => {
  assert.deepEqual(vercel.readLink(tmp()), { linked: false });
});

test('ensureIgnore adds .vercel to .gitignore exactly once', () => {
  const dir = tmp();
  vercel.ensureIgnore(dir);
  let gi = read(path.join(dir, '.gitignore'));
  assert.match(gi, /^\.vercel$/m);
  // Idempotent — a second call doesn't duplicate the line.
  vercel.ensureIgnore(dir);
  gi = read(path.join(dir, '.gitignore'));
  assert.equal((gi.match(/^\.vercel$/gm) || []).length, 1);
});

test('ensureIgnore preserves existing .gitignore content', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.radial/\n');
  vercel.ensureIgnore(dir);
  const gi = read(path.join(dir, '.gitignore'));
  assert.match(gi, /node_modules/);
  assert.match(gi, /^\.radial\/$/m);
  assert.match(gi, /^\.vercel$/m);
});

test('parseDeployUrls picks the deployment URL over the dashboard/inspector link', () => {
  // Typical `vercel deploy`: deployment URL on stdout, inspector on stderr.
  const a = vercel.parseDeployUrls('https://my-site-abc123.vercel.app\n',
    'Vercel CLI\nInspect: https://vercel.com/acme-co/my-site/dep_9 [2s]\n');
  assert.equal(a.url, 'https://my-site-abc123.vercel.app');
  assert.equal(a.inspectorUrl, 'https://vercel.com/acme-co/my-site/dep_9');

  // Trailing punctuation is stripped.
  const b = vercel.parseDeployUrls('Preview: https://x.vercel.app.', '');
  assert.equal(b.url, 'https://x.vercel.app');

  // A dashboard URL on stdout is not mistaken for the deployment when a real one exists.
  const c = vercel.parseDeployUrls('https://vercel.com/acme-co/my-site\nhttps://my-site.vercel.app\n', '');
  assert.equal(c.url, 'https://my-site.vercel.app');

  // No URLs → null, not a throw.
  assert.deepEqual(vercel.parseDeployUrls('', ''), { url: null, inspectorUrl: null });
});
