/**
 * Page discovery — produces the Webflow/Framer-style page list for navigation.
 * Best-effort and framework-aware enough to map source files to routes for the
 * frameworks we target: static HTML, Next.js (app + pages routers), Astro, and
 * TanStack Start / TanStack Router (the generated route tree when present, else
 * the src/routes file conventions). Other Vite routers get a wider fallback
 * (src/routes, routes, src/pages, pages; SvelteKit +page files; Remix-style
 * flat names). discoverPages() also says WHY a list came back empty, so the
 * panel and `radial pages --json` can name the gap instead of looking broken.
 */

import fs from 'fs';
import path from 'path';

/** How devServer.detectProject runs a project: a package.json dev script, static HTML, or neither. */
export type ProjectType = 'node' | 'static' | 'unknown';

/** The framework devServer.detectProject names ('node' for a dev script with none it knows). */
export type ProjectFramework = 'next' | 'astro' | 'vite' | 'gatsby' | 'node' | 'static';

/** What page discovery reads from a detected project (devServer.detectProject). */
export interface PageProject {
  type: ProjectType;
  /** Missing when type is 'unknown'. */
  framework?: ProjectFramework;
  /** The folder a static site is served from. */
  staticRoot?: string;
}

/** One entry in the page list. */
export interface PageEntry {
  route: string;
  label: string;
  /** The source file, relative to the repo, when known. */
  file: string | null;
}

/** A router found from the project's dependencies or folders. */
export type PageRouter = 'tanstack' | 'sveltekit' | 'remix' | 'nuxt';

/** Where a page list came from. */
export type PageSource = 'static-html' | 'next' | 'astro' | 'tanstack-gen' | 'tanstack-files' | PageRouter | 'fallback';

/** Why a page list is empty. */
export type EmptyPagesReason = 'not-a-site' | 'no-source-files' | 'unsupported-router';

/** discoverPages()'s answer. */
export interface DiscoveredPages {
  pages: PageEntry[];
  /** The project's framework, else its type. */
  framework: ProjectFramework | ProjectType | null;
  router: PageRouter | null;
  source: PageSource;
  reason: EmptyPagesReason | null;
}

/** A route in a TanStack generated route tree, with its file when the tree names one. */
export interface RouteTreeRoute {
  fullPath: string;
  file: string | null;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function walk(dir: string, filter: (file: string) => boolean, results: string[] = [], base = dir): string[] {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, filter, results, base);
    else if (filter(full)) results.push(full);
  }
  return results;
}

function routeFromStaticFile(rel: string): string {
  let r = '/' + rel.replace(/\\/g, '/');
  r = r.replace(/index\.html?$/i, '');
  r = r.replace(/\.html?$/i, '');
  if (r === '' || r === '/') return '/';
  return r.replace(/\/$/, ''); // no trailing slash, so about/index.html and about.html agree
}

function routeFromNextAppFile(rel: string): string {
  // app/.../page.tsx  ->  /...
  let r = '/' + rel.replace(/\\/g, '/').replace(/^app\//, '');
  r = r.replace(/\/?page\.(t|j)sx?$/, '');
  // Route groups — app/(marketing)/page.tsx serves / — vanish from the URL,
  // including when the group is the last segment (the homepage case).
  r = r.replace(/\/\([^/]*\)(?=\/|$)/g, '');
  return r === '' ? '/' : r;
}

function routeFromNextPagesFile(rel: string): string | null {
  let r = '/' + rel.replace(/\\/g, '/').replace(/^pages\//, '');
  r = r.replace(/index\.(t|j)sx?$/, '');
  r = r.replace(/\.(t|j)sx?$/, '');
  if (r.startsWith('/_')) return null; // _app, _document
  return r === '' || r === '/' ? '/' : r.replace(/\/$/, '');
}

function routeFromAstroFile(rel: string): string {
  let r = '/' + rel.replace(/\\/g, '/').replace(/^src\/pages\//, '');
  r = r.replace(/index\.astro$/, '');
  r = r.replace(/\.astro$/, '');
  return r === '' ? '/' : r;
}

function labelFor(route: string): string {
  if (route === '/') return 'Home';
  const seg = route.replace(/\/$/, '').split('/').filter(Boolean).pop() || 'Home';
  return seg.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── TanStack Start / TanStack Router ──
// Detection: the packages in package.json, or a src/routes folder beside a Vite config.
function readPkg(repoDir: string): PackageJson | null {
  try { return JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')); } catch { return null; }
}
function detectRouter(repoDir: string, project: PageProject): PageRouter | null {
  const pkg = readPkg(repoDir);
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  if (deps['@tanstack/react-start'] || deps['@tanstack/start'] || deps['@tanstack/react-router'] || deps['@tanstack/router-plugin'] || deps['@tanstack/router-vite-plugin']) return 'tanstack';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps['@remix-run/react'] || deps['@remix-run/dev'] || deps['react-router']) {
    if (fs.existsSync(path.join(repoDir, 'app', 'routes'))) return 'remix';
  }
  if (deps.nuxt) return 'nuxt';
  if (project.framework === 'vite' && fs.existsSync(path.join(repoDir, 'src', 'routes'))) return 'tanstack';
  return null;
}
// The generated tree (src/routeTree.gen.ts by default; tsr.config.json can move
// it) is authoritative: every route's full path, flat syntax and pathless
// layouts already resolved, with the file it came from.
function routeTreeFile(repoDir: string): string | null {
  const candidates: string[] = [];
  try { const c: { generatedRouteTree?: string } | null = JSON.parse(fs.readFileSync(path.join(repoDir, 'tsr.config.json'), 'utf8')); if (c && c.generatedRouteTree) candidates.push(path.resolve(repoDir, c.generatedRouteTree)); } catch {}
  candidates.push(path.join(repoDir, 'src', 'routeTree.gen.ts'), path.join(repoDir, 'app', 'routeTree.gen.ts'), path.join(repoDir, 'src', 'routeTree.gen.js'));
  return candidates.find((f) => fs.existsSync(f)) || null;
}
function pagesFromRouteTree(repoDir: string, genFile: string, routesDir: string): RouteTreeRoute[] {
  let text; try { text = fs.readFileSync(genFile, 'utf8'); } catch { return []; }
  const out: RouteTreeRoute[] = [];
  // Newer trees: objects with fullPath + filePath; older ones: FileRoutesByFullPath keys.
  const objRe = /\{[^{}]*?fullPath:\s*'([^']*)'[^{}]*?\}/g;
  let m;
  while ((m = objRe.exec(text))) {
    const fullPath = m[1];
    const fp = /filePath:\s*'([^']*)'/.exec(m[0]);
    const id = /\bid:\s*'([^']*)'/.exec(m[0]);
    if (fp && /(^|\/)(_[^/]*|route)\.[tj]sx?$/.test(fp[1]) && !/index\.[tj]sx?$/.test(fp[1])) { if (id && /\/_[^/]*$/.test(id[1])) continue; } // a pathless layout is not a page
    out.push({ fullPath, file: fp ? path.join(routesDir, fp[1]) : null });
  }
  if (!out.length) {
    const block = /interface FileRoutesByFullPath \{([\s\S]*?)\}/.exec(text) || /interface FileRoutesByTo \{([\s\S]*?)\}/.exec(text);
    if (block) { const keyRe = /'([^']*)':/g; let k; while ((k = keyRe.exec(block[1]))) out.push({ fullPath: k[1], file: null }); }
  }
  return out;
}
// The file conventions, for a tree without a generated file (or as a check):
// index → the folder's route; a leading `-` excludes a file or folder; a leading
// `_` is a pathless layout (no segment); `route.tsx` is the folder's layout;
// dots in a name are path separators (posts.$id.tsx == posts/$id.tsx); `$param`
// and `$` (splat) are dynamic → skipped, like Next's [param]; `(group)` folders
// vanish; `*.lazy.tsx` pairs with its route file.
function routeFromTanstackFile(rel: string): string | null {
  const parts = rel.replace(/\\/g, '/').split('/');
  if (parts.some((seg) => seg.startsWith('-'))) return null;
  const file = parts.pop()!.replace(/\.(lazy\.)?[tj]sx?$/, '');
  if (file === '__root' || file.startsWith('__')) return null;
  const segs = [...parts, ...file.split('.')].filter(Boolean)
    .filter((seg) => !seg.startsWith('_') && !/^\(.*\)$/.test(seg));
  if (segs.length && (segs[segs.length - 1] === 'index' || segs[segs.length - 1] === 'route')) segs.pop();
  if (segs.some((seg) => seg.includes('$') || seg === '*')) return null;
  return '/' + segs.join('/');
}
function routeFromSvelteKitFile(rel: string): string | null {
  // src/routes/blog/+page.svelte → /blog ; (group) folders vanish ; [param] skipped by add()
  const parts = rel.replace(/\\/g, '/').split('/'); const file = parts.pop()!;
  if (!/^\+page(@.*)?\.svelte$/.test(file)) return null;
  const segs = parts.filter((seg) => seg && !/^\(.*\)$/.test(seg));
  return '/' + segs.join('/');
}
function routeFromRemixFile(rel: string): string | null {
  // app/routes/posts.$id.tsx → dynamic ; app/routes/about.tsx → /about ; _index → / ; _layout. prefix vanishes
  const file = rel.replace(/\\/g, '/').split('/').pop()!.replace(/\.[tj]sx?$/, '');
  const segs = file.split('.').filter((seg) => seg && !seg.startsWith('_'));
  if (segs.some((seg) => seg.includes('$') || seg === '*')) return null;
  return '/' + segs.join('/');
}

/**
 * The full answer: { pages, framework, router, source, reason }. `source` says
 * where the list came from (static-html, next, astro, tanstack-gen,
 * tanstack-files, sveltekit, remix, fallback); `reason` is set when pages is
 * empty (no-source-files | unsupported-router | not-a-site).
 */
function discoverPages(repoDir: string, project: PageProject): DiscoveredPages {
  const framework = project.framework || project.type || null;
  const router = project.type !== 'static' ? detectRouter(repoDir, project) : null;
  const pages = listPagesInner(repoDir, project, router);
  let source: PageSource = framework === 'static' || project.type === 'static' ? 'static-html' : framework === 'next' ? 'next' : framework === 'astro' ? 'astro' : router === 'tanstack' ? (routeTreeFile(repoDir) ? 'tanstack-gen' : 'tanstack-files') : router || 'fallback';
  let reason: EmptyPagesReason | null = null;
  if (!pages.length) {
    if (project.type === 'unknown') reason = 'not-a-site';
    else if ((['static', 'next', 'astro'] as readonly DiscoveredPages['framework'][]).includes(framework) || router) reason = 'no-source-files';
    else reason = 'unsupported-router';
  }
  return { pages, framework, router, source, reason };
}

/** Returns [{ route, label, file }] sorted with Home first. */
function listPages(repoDir: string, project: PageProject): PageEntry[] { return listPagesInner(repoDir, project, project.type !== 'static' ? detectRouter(repoDir, project) : null); }
function listPagesInner(repoDir: string, project: PageProject, router: PageRouter | null): PageEntry[] {
  const pages: PageEntry[] = [];
  const add = (route: string | null, file: string | null) => {
    if (!route) return;
    if (route.includes('[') || route.includes(']')) return; // skip dynamic routes for nav
    pages.push({ route, label: labelFor(route), file: file ? path.relative(repoDir, file) : null });
  };

  const framework = project.framework;

  if (framework === 'static' || project.type === 'static') {
    const root = project.staticRoot || repoDir;
    walk(root, (f) => /\.html?$/i.test(f)).forEach((f) =>
      add(routeFromStaticFile(path.relative(root, f)), f)
    );
  } else if (framework === 'next') {
    const appDir = path.join(repoDir, 'app');
    const srcAppDir = path.join(repoDir, 'src', 'app');
    const pagesDir = path.join(repoDir, 'pages');
    const srcPagesDir = path.join(repoDir, 'src', 'pages');
    for (const d of [appDir, srcAppDir]) {
      if (fs.existsSync(d)) walk(d, (f) => /\/page\.(t|j)sx?$/.test(f.replace(/\\/g, '/')))
        .forEach((f) => add(routeFromNextAppFile(path.relative(d.replace(/(src\/)?app$/, '') || repoDir, f).replace(/^src\//, '')), f));
    }
    for (const d of [pagesDir, srcPagesDir]) {
      if (fs.existsSync(d)) walk(d, (f) => /\.(t|j)sx?$/.test(f))
        .forEach((f) => add(routeFromNextPagesFile(path.relative(path.dirname(d) === repoDir ? repoDir : path.join(repoDir, 'src'), f)), f));
    }
  } else if (framework === 'astro') {
    const d = path.join(repoDir, 'src', 'pages');
    if (fs.existsSync(d)) walk(d, (f) => /\.astro$/.test(f))
      .forEach((f) => add(routeFromAstroFile(path.relative(repoDir, f)), f));
  } else if (router === 'tanstack') {
    const routesDir = [path.join(repoDir, 'src', 'routes'), path.join(repoDir, 'app', 'routes')].find((d) => fs.existsSync(d)) || path.join(repoDir, 'src', 'routes');
    const gen = routeTreeFile(repoDir);
    if (gen) pagesFromRouteTree(repoDir, gen, routesDir).forEach((r) => { if (!/[$*]/.test(r.fullPath)) add(r.fullPath.replace(/\/+$/, '') || '/', r.file && fs.existsSync(r.file) ? r.file : null); });
    if (!pages.length && fs.existsSync(routesDir)) walk(routesDir, (f) => /\.[tj]sx?$/.test(f))
      .forEach((f) => add(routeFromTanstackFile(path.relative(routesDir, f)), f));
  } else if (router === 'sveltekit') {
    const d = path.join(repoDir, 'src', 'routes');
    if (fs.existsSync(d)) walk(d, (f) => /\+page(@[^/]*)?\.svelte$/.test(f)).forEach((f) => add(routeFromSvelteKitFile(path.relative(d, f)), f));
  } else if (router === 'remix') {
    const d = path.join(repoDir, 'app', 'routes');
    if (fs.existsSync(d)) walk(d, (f) => /\.[tj]sx?$/.test(f)).forEach((f) => add(routeFromRemixFile(path.relative(d, f)), f));
  } else {
    // Unknown node project: try the common page folders, widest first. A plain
    // src/routes tree (Nuxt-style pages, a hand-rolled router) gets the TanStack
    // conventions, which are a superset of the Next pages ones.
    for (const [d, fn, filter] of [
      [path.join(repoDir, 'src', 'pages'), routeFromAstroFile, /\.(astro|vue|svelte|t|j)sx?$|\.(vue|svelte)$/],
      [path.join(repoDir, 'pages'), routeFromNextPagesFile, /\.(vue|t|j)sx?$|\.vue$/],
      [path.join(repoDir, 'src', 'routes'), (rel) => routeFromTanstackFile(rel.replace(/^src\/routes\//, '')), /\.[tj]sx?$/],
      [path.join(repoDir, 'routes'), (rel) => routeFromTanstackFile(rel.replace(/^routes\//, '')), /\.[tj]sx?$/],
    ] satisfies [string, (rel: string) => string | null, RegExp][]) {
      if (fs.existsSync(d)) walk(d, (f) => filter.test(f)).forEach((f) => add(fn(path.relative(repoDir, f).replace(/\.vue$/, '.tsx').replace(/\.svelte$/, '.tsx')), f));
    }
  }

  // de-dupe by route, Home first, then alphabetical
  const seen = new Map<string, PageEntry>();
  for (const p of pages) if (!seen.has(p.route)) seen.set(p.route, p);
  return [...seen.values()].sort((a, b) =>
    a.route === '/' ? -1 : b.route === '/' ? 1 : a.route.localeCompare(b.route)
  );
}

export { listPages, discoverPages, detectRouter, routeFromTanstackFile, routeFromSvelteKitFile, routeFromRemixFile, pagesFromRouteTree };
