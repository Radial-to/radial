import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as project from '../src/main/project';
import type { PageProject, ProjectFramework } from '../src/main/project';
import { tmpDir } from './support/tmp';

function tmp() { return tmpDir('radial-pg-'); }
function write(dir: string, rel: string, body = 'x'): void {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}
const routes = (dir: string, fw: ProjectFramework) => project.listPages(dir, { type: 'node', framework: fw }).map((p) => p.route);

test('Next app router: maps page.tsx files, skips dynamic, strips route groups', () => {
  const dir = tmp();
  write(dir, 'app/page.tsx');
  write(dir, 'app/about/page.tsx');
  write(dir, 'app/(marketing)/pricing/page.tsx'); // route group → /pricing
  write(dir, 'app/(refresh)/page.tsx'); // group as the FINAL segment → / (the homepage case)
  write(dir, 'app/blog/[slug]/page.tsx');          // dynamic → skipped from nav
  assert.deepEqual(routes(dir, 'next'), ['/', '/about', '/pricing']);
});

test('Next app router under src/ works too', () => {
  const dir = tmp();
  write(dir, 'src/app/page.tsx');
  write(dir, 'src/app/features/page.tsx');
  assert.deepEqual(routes(dir, 'next'), ['/', '/features']);
});

test('Next pages router: index → /, files → /name, _app/_document skipped', () => {
  const dir = tmp();
  write(dir, 'pages/index.tsx');
  write(dir, 'pages/about.tsx');
  write(dir, 'pages/_app.tsx');        // framework file, not a route
  write(dir, 'pages/_document.tsx');
  write(dir, 'pages/blog/[slug].tsx'); // dynamic → skipped
  assert.deepEqual(routes(dir, 'next'), ['/', '/about']);
});

test('Astro: src/pages/*.astro map to routes, dynamic skipped', () => {
  const dir = tmp();
  write(dir, 'src/pages/index.astro');
  write(dir, 'src/pages/about.astro');
  write(dir, 'src/pages/work/[id].astro'); // dynamic → skipped
  assert.deepEqual(routes(dir, 'astro'), ['/', '/about']);
});

test('static: a nested index.html maps to a slash-free route, like flat files', () => {
  const dir = tmp();
  write(dir, 'index.html');
  write(dir, 'about.html');       // flat → /about
  write(dir, 'blog/index.html');  // nested index → /blog (not /blog/)
  const r = project.listPages(dir, { type: 'static', framework: 'static', staticRoot: dir }).map((p) => p.route);
  assert.deepEqual(r, ['/', '/about', '/blog']);
});

test('Home (/) always sorts first; the rest are alphabetical', () => {
  const dir = tmp();
  write(dir, 'pages/zeta.tsx');
  write(dir, 'pages/alpha.tsx');
  write(dir, 'pages/index.tsx');
  assert.deepEqual(routes(dir, 'next'), ['/', '/alpha', '/zeta']);
});

test('labels are humanized from the last route segment', () => {
  const dir = tmp();
  write(dir, 'pages/index.tsx');
  write(dir, 'pages/case-studies.tsx');
  const pages = project.listPages(dir, { type: 'node', framework: 'next' });
  const byRoute = Object.fromEntries(pages.map((p) => [p.route, p.label]));
  assert.equal(byRoute['/'], 'Home');
  assert.equal(byRoute['/case-studies'], 'Case Studies');
});

test('page discovery ignores node_modules and dotfolders', () => {
  const dir = tmp();
  write(dir, 'pages/index.tsx');
  write(dir, 'node_modules/some-dep/pages/leak.tsx'); // dependency pages must not leak in
  write(dir, '.next/server/pages/cached.tsx');         // build output must not leak in
  assert.deepEqual(routes(dir, 'next'), ['/']);
});

test('page entries carry a repo-relative source file path', () => {
  const dir = tmp();
  write(dir, 'pages/about.tsx');
  const about = project.listPages(dir, { type: 'node', framework: 'next' }).find((p) => p.route === '/about')!;
  assert.equal(about.file, path.join('pages', 'about.tsx'));
});

// ── TanStack Start / TanStack Router, and the wider fallback (from a user report) ──
const GEN = `/* prettier-ignore-start */
import { Route as rootRoute } from './routes/__root'
export interface FileRoutesByPath {
  '/': { id: '/'; path: '/'; fullPath: '/'; preLoaderRoute: typeof IndexImport; parentRoute: typeof rootRoute; filePath: 'index.tsx' }
  '/about': { id: '/about'; path: '/about'; fullPath: '/about'; preLoaderRoute: typeof AboutImport; parentRoute: typeof rootRoute; filePath: 'about.tsx' }
  '/_layout': { id: '/_layout'; path: ''; fullPath: '/'; preLoaderRoute: typeof LayoutImport; parentRoute: typeof rootRoute; filePath: '_layout.tsx' }
  '/_layout/pricing': { id: '/_layout/pricing'; path: '/pricing'; fullPath: '/pricing'; preLoaderRoute: typeof LayoutPricingImport; parentRoute: typeof LayoutImport; filePath: '_layout/pricing.tsx' }
  '/blog/': { id: '/blog/'; path: '/'; fullPath: '/blog/'; preLoaderRoute: typeof BlogIndexImport; parentRoute: typeof BlogImport; filePath: 'blog/index.tsx' }
  '/blog/$slug': { id: '/blog/$slug'; path: '/$slug'; fullPath: '/blog/$slug'; preLoaderRoute: typeof BlogSlugImport; parentRoute: typeof BlogImport; filePath: 'blog/$slug.tsx' }
  '/posts/$id': { id: '/posts/$id'; path: '/posts/$id'; fullPath: '/posts/$id'; preLoaderRoute: typeof PostsIdImport; parentRoute: typeof rootRoute; filePath: 'posts.$id.tsx' }
}
`;
test('TanStack Start: the generated route tree is authoritative (dynamic and pathless layouts skipped, files mapped)', () => {
  const dir = tmp();
  write(dir, 'package.json', JSON.stringify({ dependencies: { '@tanstack/react-start': '1', vite: '5' }, scripts: { dev: 'vite dev' } }));
  write(dir, 'src/routeTree.gen.ts', GEN);
  for (const f of ['index.tsx', 'about.tsx', '_layout.tsx', '_layout/pricing.tsx', 'blog/index.tsx', 'blog/$slug.tsx', 'posts.$id.tsx', '__root.tsx']) write(dir, 'src/routes/' + f);
  const proj: PageProject = { type: 'node', framework: 'vite' };
  const d = project.discoverPages(dir, proj);
  assert.equal(d.router, 'tanstack'); assert.equal(d.source, 'tanstack-gen'); assert.equal(d.reason, null);
  assert.deepEqual(d.pages.map((p) => p.route), ['/', '/about', '/blog', '/pricing']);
  assert.equal(d.pages.find((p) => p.route === '/pricing')!.file, path.join('src', 'routes', '_layout', 'pricing.tsx'));
  assert.deepEqual(routes(dir, 'vite'), ['/', '/about', '/blog', '/pricing'], 'listPages agrees');
});

test('TanStack file conventions without a generated tree: index, -excluded, _pathless, route.tsx, flat dots, $params, (groups), .lazy', () => {
  const dir = tmp();
  write(dir, 'package.json', JSON.stringify({ dependencies: { '@tanstack/react-router': '1', vite: '5' } }));
  for (const f of ['__root.tsx', 'index.tsx', 'about.tsx', 'about.lazy.tsx', '-components/nav.tsx', '-helper.tsx', '_auth/dashboard.tsx', '_auth.tsx', 'blog/route.tsx', 'blog/index.tsx', 'blog/$slug.tsx', 'posts.$id.tsx', 'docs.getting-started.tsx', '(marketing)/pricing.tsx', 'files/$.tsx']) write(dir, 'src/routes/' + f);
  const d = project.discoverPages(dir, { type: 'node', framework: 'vite' });
  assert.equal(d.source, 'tanstack-files');
  assert.deepEqual(d.pages.map((p) => p.route), ['/', '/about', '/blog', '/dashboard', '/docs/getting-started', '/pricing']);
  assert.equal(project.routeFromTanstackFile('posts.$id.tsx'), null);
  assert.equal(project.routeFromTanstackFile('-hidden/thing.tsx'), null);
  assert.equal(project.routeFromTanstackFile('_layout/settings/index.tsx'), '/settings');
});

test('a plain Vite project with src/routes but no TanStack package is treated as TanStack-style routes', () => {
  const dir = tmp();
  write(dir, 'package.json', JSON.stringify({ dependencies: { vite: '5' } }));
  write(dir, 'vite.config.ts', 'export default {}');
  write(dir, 'src/routes/index.tsx'); write(dir, 'src/routes/contact.tsx');
  assert.equal(project.detectRouter(dir, { type: 'node', framework: 'vite' }), 'tanstack');
  assert.deepEqual(routes(dir, 'vite'), ['/', '/contact']);
});

test('SvelteKit +page files and Remix flat routes map; the unknown fallback also reads src/routes and routes', () => {
  const sk = tmp();
  write(sk, 'package.json', JSON.stringify({ devDependencies: { '@sveltejs/kit': '2', vite: '5' } }));
  for (const f of ['+page.svelte', '+layout.svelte', 'about/+page.svelte', 'blog/[slug]/+page.svelte', '(app)/account/+page.svelte', 'api/+server.ts']) write(sk, 'src/routes/' + f);
  const d1 = project.discoverPages(sk, { type: 'node', framework: 'vite' });
  assert.equal(d1.router, 'sveltekit'); assert.deepEqual(d1.pages.map((p) => p.route), ['/', '/about', '/account']);
  const rx = tmp();
  write(rx, 'package.json', JSON.stringify({ dependencies: { '@remix-run/react': '2', vite: '5' } }));
  for (const f of ['_index.tsx', 'about.tsx', 'posts.$id.tsx', '_layout.settings.tsx', 'blog._index.tsx']) write(rx, 'app/routes/' + f);
  const d2 = project.discoverPages(rx, { type: 'node', framework: 'vite' });
  assert.equal(d2.router, 'remix'); assert.deepEqual(d2.pages.map((p) => p.route), ['/', '/about', '/blog', '/settings']);
  const fb = tmp();
  write(fb, 'package.json', JSON.stringify({ dependencies: { express: '4' } }));
  write(fb, 'routes/index.tsx'); write(fb, 'routes/help.tsx');
  assert.deepEqual(routes(fb, 'node'), ['/', '/help']);
});

test('an empty list says why: unsupported router, no source files, or not a site', () => {
  const v = tmp(); write(v, 'package.json', JSON.stringify({ dependencies: { vite: '5', 'some-router': '1' } })); write(v, 'src/main.tsx');
  const d1 = project.discoverPages(v, { type: 'node', framework: 'vite' });
  assert.deepEqual([d1.pages.length, d1.framework, d1.reason], [0, 'vite', 'unsupported-router']);
  const t = tmp(); write(t, 'package.json', JSON.stringify({ dependencies: { '@tanstack/react-start': '1' } }));
  const d2 = project.discoverPages(t, { type: 'node', framework: 'vite' });
  assert.deepEqual([d2.router, d2.reason], ['tanstack', 'no-source-files']);
  assert.equal(project.discoverPages(tmp(), { type: 'unknown' }).reason, 'not-a-site');
  const n = tmp(); assert.equal(project.discoverPages(n, { type: 'node', framework: 'next' }).reason, 'no-source-files');
});
