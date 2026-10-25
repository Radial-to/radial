import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import * as hosting from '../src/main/hostingProjects';
import type { HostingRequestDeps } from '../src/main/hostingProjects';
import type { VercelFetch } from '../src/main/vercel';
import { tmpDir } from './support/tmp';

/** A Vercel reply. The fakes leave out what request() never reads: the status of a success, the body of a failure. */
type VercelResponse = Awaited<ReturnType<VercelFetch>>;
/**
 * A request a fake fetchImpl saw. `opts` is widened to fetch's own RequestInit
 * (VercelFetch's init declares only headers and signal) so the tests can check that no method is sent.
 */
interface SentRequest<U = string> { url: U; opts: RequestInit }

test('hosting picker scopes and paginates read-only project requests', async () => {
  let request!: SentRequest<URL>;
  const result = await hosting.projects({ scope: 'client studio', search: 'site & docs', until: 123 }, { token: 'test', fetchImpl: async (url, opts) => {
    request = { url: new URL(url), opts };
    return { ok: true, json: async () => ({ projects: [{ id: 'prj_1', name: 'site', accountId: 'team_1', secrets: 'not returned' }], pagination: { next: 456 } }) } as VercelResponse;
  } });
  assert.equal(request.url.pathname, '/v9/projects'); assert.equal(request.url.searchParams.get('slug'), 'client studio');
  assert.equal(request.url.searchParams.get('search'), 'site & docs'); assert.equal(request.url.searchParams.get('until'), '123');
  assert.equal(request.opts.method, undefined);
  assert.deepEqual(result, { ok: true, projects: [{ id: 'prj_1', name: 'site', orgId: 'team_1' }], next: 456 });
});

test('linking verifies access and writes only the local project link and ignore rule', async t => {
  const dir = tmpDir('radial-hosting-link-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'index.html'), 'Keep this site');
  const requests: SentRequest[] = [];
  const deps: HostingRequestDeps = { token: 'test', fetchImpl: async (url, opts) => { requests.push({ url, opts }); return { ok: true, json: async () => ({ id: 'prj_1', accountId: 'team_1', name: 'client-site' }) } as VercelResponse; } };
  const result = await hosting.link(dir, { projectId: 'prj_1', orgId: 'team_1' }, deps);
  assert.equal(result.ok, true);
  // JSON.parse is typed for a string; it reads this Buffer through ToString (UTF-8), so it's widened to take one.
  assert.deepEqual((JSON.parse as (text: string | Buffer) => unknown)(fs.readFileSync(path.join(dir, '.vercel/project.json'))), { projectId: 'prj_1', orgId: 'team_1', projectName: 'client-site' });
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), 'Keep this site');
  assert.ok(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').includes('.vercel'));
  assert.equal(requests.length, 1); assert.equal(requests[0].opts.method, undefined);
  assert.equal(new URL(requests[0].url).searchParams.get('teamId'), 'team_1');
});

test('failed access and mismatched teams preserve the existing hosting link', async t => {
  const dir = tmpDir('radial-hosting-denied-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.vercel')); const file = path.join(dir, '.vercel/project.json'); fs.writeFileSync(file, 'old link');
  for (const response of [{ ok: false, status: 403 } as VercelResponse, { ok: true, json: async () => ({ id: 'prj_1', accountId: 'team_elsewhere' }) } as VercelResponse]) {
    const r = await hosting.link(dir, { projectId: 'prj_1', orgId: 'team_1' }, { token: 'test', fetchImpl: async () => response });
    assert.equal(r.ok, false); assert.equal(fs.readFileSync(file, 'utf8'), 'old link');
  }
});
