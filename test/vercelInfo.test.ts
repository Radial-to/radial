import { test } from 'node:test';
import assert from 'node:assert';

import { pickSiteUrl, projectInfo } from '../src/main/vercel';
import type { VercelFetch, VercelProjectInfoResult } from '../src/main/vercel';

/** projectInfo's answer when it could read the project. */
type InfoFound = Extract<VercelProjectInfoResult, { ok: true }>;
/** A faked API route: a URL pattern, the JSON it answers, and its status (200 when left out). */
type FakeRoute = [re: RegExp, body: unknown, status?: number];

// The scenario that motivated all of this: project named `acme`, bare
// acme.vercel.app already taken, so Vercel assigned acme-five —
// deriving <name>.vercel.app shows a domain the project never had.
test('pickSiteUrl returns the REAL default domain, not a derived guess', () => {
  assert.equal(pickSiteUrl([{ name: 'acme-five.vercel.app', verified: true }]),
    'https://acme-five.vercel.app');
});

test('pickSiteUrl prefers a verified custom domain over the vercel.app default', () => {
  const url = pickSiteUrl([
    { name: 'acme-five.vercel.app', verified: true },
    { name: 'acme.dev', verified: true },
  ]);
  assert.equal(url, 'https://acme.dev');
});

test('pickSiteUrl never picks branch-scoped, redirecting, or unverified-custom domains', () => {
  const url = pickSiteUrl([
    { name: 'preview.acme.dev', verified: true, gitBranch: 'staging' },
    { name: 'www.acme.dev', verified: true, redirect: 'acme.dev' },
    { name: 'acme.dev', verified: false },              // DNS not set up yet
    { name: 'acme-five.vercel.app', verified: true },  // the one that actually serves
  ]);
  assert.equal(url, 'https://acme-five.vercel.app');
});

test('pickSiteUrl ties go to the shortest name, and empty input is null', () => {
  assert.equal(pickSiteUrl([
    { name: 'shop.acme.dev', verified: true },
    { name: 'acme.dev', verified: true },
  ]), 'https://acme.dev');
  assert.equal(pickSiteUrl([]), null);
  assert.equal(pickSiteUrl(null), null);
  assert.equal(pickSiteUrl([{ name: 'x.vercel.app', gitBranch: 'dev' }]), null);
});

// projectInfo against a faked API — response mapping, team lookup, failures.
function fakeFetch(routes: FakeRoute[]): VercelFetch {
  return async (url) => {
    for (const [re, body, status] of routes) {
      if (re.test(url)) return { ok: (status || 200) < 400, status: status || 200, json: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('projectInfo maps domains + team + git connection and picks the canonical url', async () => {
  const f = fakeFetch([
    [/\/v9\/projects\/prj_1\/domains\?teamId=team_abc/, {
      domains: [
        { name: 'acme-five.vercel.app', verified: true },
        { name: 'preview.acme.dev', verified: true, gitBranch: 'staging' },
      ],
    }],
    [/\/v9\/projects\/prj_1\?teamId=team_abc/, { id: 'prj_1', link: { type: 'github', org: 'acme-co', repo: 'site' } }],
    [/\/v2\/teams\/team_abc/, { id: 'team_abc', slug: 'acme-co', name: 'Acme' }],
  ]);
  const r = await projectInfo({ projectId: 'prj_1', orgId: 'team_abc', token: 't', fetchImpl: f }) as InfoFound;
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://acme-five.vercel.app');
  assert.deepEqual(r.team, { slug: 'acme-co', name: 'Acme' });
  assert.equal(r.gitRepo, 'acme-co/site');
  assert.equal(r.domains.length, 2);
  assert.equal(r.domains[1].gitBranch, 'staging');
});

test('projectInfo reports gitRepo null when the project has no git link (CLI-only deploys)', async () => {
  const f = fakeFetch([
    [/\/domains/, { domains: [{ name: 'x.vercel.app', verified: true }] }],
    [/\/v9\/projects\/prj_1\b/, { id: 'prj_1' }], // no link field
  ]);
  const r = await projectInfo({ projectId: 'prj_1', token: 't', fetchImpl: f }) as InfoFound;
  assert.equal(r.ok, true);
  assert.equal(r.gitRepo, null);
});

test('projectInfo on a personal scope skips the team lookup', async () => {
  let teamCalls = 0;
  const f: VercelFetch = async (url) => {
    if (/\/v2\/teams\//.test(url)) { teamCalls++; return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => ({ domains: [{ name: 'me.vercel.app', verified: true }] }) };
  };
  const r = await projectInfo({ projectId: 'prj_1', orgId: 'user_123', token: 't', fetchImpl: f }) as InfoFound;
  assert.equal(r.ok, true);
  assert.equal(r.team, null);
  assert.equal(teamCalls, 0);
});

test('projectInfo reports missing token / project and HTTP failures as reasons', async () => {
  assert.deepEqual(await projectInfo({ projectId: 'prj_1', token: null }), { ok: false, reason: 'no-token' });
  assert.deepEqual(await projectInfo({ token: 't' }), { ok: false, reason: 'not-linked' });
  const r = await projectInfo({ projectId: 'prj_1', token: 't', fetchImpl: fakeFetch([[/domains/, {}, 403]]) });
  assert.deepEqual(r, { ok: false, reason: 'http-403' });
});

test('projectInfo survives a network error', async () => {
  const r = await projectInfo({ projectId: 'prj_1', token: 't', fetchImpl: async () => { throw new Error('boom'); } });
  assert.deepEqual(r, { ok: false, reason: 'network' });
});
