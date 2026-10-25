import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as vercel from '../src/main/vercel';
import { tmpDir } from './support/tmp';

function tmp() { return tmpDir('radial-va-'); }

test('projectSlug produces Vercel-project / subdomain safe names', () => {
  const s = vercel.projectSlug;
  assert.equal(s('My Site!'), 'my-site');
  assert.equal(s('Acme.co Launch'), 'acme-co-launch'); // dots are not subdomain-safe
  assert.equal(s('--weird--'), 'weird');
  assert.equal(s(''), 'site');
  assert.equal(s(null), 'site');
  assert.ok(s('x'.repeat(120)).length <= 63);
});

test('readAltLink: null when missing, parsed when present, repo .vercel untouched', () => {
  const repo = tmp();
  assert.equal(vercel.readAltLink(repo, 'client-preview'), null);
  const p = path.join(repo, '.radial', 'vercel-client-preview.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ projectId: 'prj_1', orgId: 'team_1', name: 'acme-staging' }));
  const link = vercel.readAltLink(repo, 'client-preview')!;
  assert.equal(link.projectId, 'prj_1');
  assert.equal(link.name, 'acme-staging');
  // Alt links live under .radial/, never the repo's own .vercel/.
  assert.ok(!fs.existsSync(path.join(repo, '.vercel')));
});
