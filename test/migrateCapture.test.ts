import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import type { InlineScript, Inventory } from '../src/main/migrate/capture';
import type { ShotResult } from '../src/main/migrate';
import { tmpDir } from './support/tmp';
const fs = require('fs') as typeof import('fs'), os = require('os') as typeof import('os'), path = require('path') as typeof import('path'), http = require('http') as typeof import('http');
const { capture, resolveSite, extract, routeOf } = require('../src/main/migrate/capture') as typeof import('../src/main/migrate/capture');

/** The running fixture site: its server, its 127.0.0.1 origin, and the port it listens on. */
interface FixtureSite { server: Server; origin: string; port: number }

// A Webflow-shaped site on 127.0.0.1 whose "CDN" is the same server reached as localhost.
function fixtureSite(): Promise<FixtureSite> {
  let port: number;
  const cdn = () => `http://localhost:${port}/cdn`;
  const page = (wfPage: string, title: string, body: string) => `<!DOCTYPE html><html data-wf-page="${wfPage}" data-wf-site="site-1" lang="en"><head><title>${title}</title>
<meta name="description" content="${title} description"><meta property="og:image" content="${cdn()}/og.png"><link rel="canonical" href="/${title === 'Home' ? '' : title.toLowerCase()}">
<link href="${cdn()}/site.css" rel="stylesheet" type="text/css"><link rel="icon" href="/favicon.ico">
<script src="https://www.googletagmanager.com/gtm.js?id=GTM-TEST"></script></head><body>
<nav><a href="/">Home</a><a href="/about">About</a><a href="/blog/a">A</a><a href="/old">Old</a><a href="/missing">Missing</a><a href="/files/deck.pdf">Deck</a><a href="https://example.org/">Out</a></nav>
${body}<script src="${cdn()}/webflow.js" type="text/javascript"></script><script>window.answer = 42;</script></body></html>`;
  const routes: Partial<Record<string, () => string>> = {
    '/': () => page('home-1', 'Home', `<h1>Welcome home</h1><img src="${cdn()}/hero.jpg" srcset="${cdn()}/hero-500.jpg 500w, ${cdn()}/hero-800.jpg 800w" alt="Hero"><div class="w-dyn-list"></div>
      <form action="/subscribe" method="post" data-name="Newsletter"><input type="email" name="email"><input type="hidden" name="t" value="1"><input type="submit" value="Go"></form>`),
    '/about': () => page('about-1', 'About', `<h1>About us</h1><div style="background-image:url('${cdn()}/bg.png')"></div>`),
    '/blog/a': () => page('post-tpl', 'Post A', '<h1>Post A</h1><a href="/blog/b">Next</a><a href="/blog?abc_page=2">More</a>'),
    '/blog/b': () => page('post-tpl', 'Post B', '<h1>Post B</h1>'),
  };
  const files: Partial<Record<string, [type: string, body: string]>> = {
    '/cdn/site.css': ['text/css', "@font-face{font-family:x;src:url('fonts/brand.woff2') format('woff2')} body{background:url(/cdn/paper.png)}"],
    '/cdn/fonts/brand.woff2': ['font/woff2', 'WOFF2'], '/cdn/paper.png': ['image/png', 'PNG'], '/cdn/og.png': ['image/png', 'OG'],
    '/cdn/hero.jpg': ['image/jpeg', 'HERO'], '/cdn/hero-500.jpg': ['image/jpeg', 'H500'], '/cdn/hero-800.jpg': ['image/jpeg', 'H800'], '/cdn/bg.png': ['image/png', 'BG'],
    '/cdn/webflow.js': ['text/javascript', 'console.log(1)'], '/favicon.ico': ['image/x-icon', 'ICO'], '/files/deck.pdf': ['application/pdf', '%PDF'],
  };
  const server = http.createServer((req, res): ServerResponse | void => {
    const url = new URL(req.url!, 'http://x'), pathName = url.pathname;
    if (pathName === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`User-agent: *\nSitemap: http://127.0.0.1:${port}/sitemap.xml`); }
    if (pathName === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(`<urlset><url><loc>http://127.0.0.1:${port}/</loc></url><url><loc>http://127.0.0.1:${port}/about</loc></url><url><loc>http://127.0.0.1:${port}/blog/b</loc></url><url><loc>http://127.0.0.1:${port}/gone</loc></url></urlset>`); }
    if (pathName === '/old') { res.writeHead(301, { location: '/about' }); return res.end(); }
    if (routes[pathName] && req.headers.host!.startsWith('127.0.0.1')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(routes[pathName]()); }
    if (pathName === '/blog' ) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page('blog-1', 'Blog', '<h1>Blog page ' + (url.searchParams.get('abc_page') || 1) + '</h1>')); }
    if (files[pathName]) { res.writeHead(200, { 'content-type': files[pathName][0] }); return res.end(files[pathName][1]); }
    res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>Not found</h1>');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => { port = (server.address() as AddressInfo).port; resolve({ server, origin: `http://127.0.0.1:${port}`, port }); }));
}

test('capture records every route, the raw pages, the assets they load and a template inventory', async t => {
  const { server, origin, port } = await fixtureSite(); t.after(() => server.close());
  const out = tmpDir('radial-capture-'); t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const seen: string[] = [];
  const inventory = await capture(origin, out, { onProgress: line => seen.push(line) });
  assert.equal(inventory.platform.id, 'webflow');
  assert.equal(inventory.source.origin, origin);
  const route = (p: string) => inventory.routes.find(r => r.path === p);
  for (const p of ['/', '/about', '/blog/a', '/blog/b', '/blog?abc_page=2']) assert.equal(route(p)?.status, 200, p);
  assert.deepEqual([route('/old')!.status, route('/old')!.location], [301, '/about']);
  assert.equal(route('/missing')!.status, 404);
  assert.equal(route('/gone')!.status, 404, 'sitemap URLs are fetched too');
  assert.equal(fs.readFileSync(path.join(out, 'pages/index.html'), 'utf8').includes('Welcome home'), true);
  assert.equal(route('/about')!.title, 'About');
  assert.equal(route('/')!.forms![0].name, 'Newsletter');
  assert.deepEqual(route('/')!.forms![0].fields, [{ name: 'email', type: 'email' }]);
  const files = new Map(inventory.assets.map(a => [new URL(a.url).pathname, a]));
  for (const p of ['/cdn/site.css', '/cdn/fonts/brand.woff2', '/cdn/paper.png', '/cdn/hero.jpg', '/cdn/hero-500.jpg', '/cdn/hero-800.jpg', '/cdn/bg.png', '/cdn/og.png', '/cdn/webflow.js', '/favicon.ico', '/files/deck.pdf']) assert.ok(files.has(p), p);
  assert.equal(files.get('/cdn/fonts/brand.woff2')!.kind, 'font');
  assert.equal(files.get('/cdn/site.css')!.file, path.join('assets', 'localhost', 'cdn', 'site.css'));
  assert.equal(fs.readFileSync(path.join(out, files.get('/cdn/hero.jpg')!.file), 'utf8'), 'HERO');
  assert.ok(!inventory.assets.some(a => a.url.includes('googletagmanager')), 'trackers are not downloaded');
  assert.deepEqual(inventory.integrations.map(i => i.host), ['www.googletagmanager.com']);
  const blog = inventory.templates.find(tpl => tpl.key === 'webflow:post-tpl');
  assert.deepEqual([blog!.count, inventory.collections.find(c => c.template === 'webflow:post-tpl')!.items], [2, 2]);
  assert.ok(inventory.notInSitemap.includes('/blog/a'));
  assert.ok((JSON.parse(fs.readFileSync(path.join(out, 'inventory.json'), 'utf8')) as Inventory).routes.length >= 8);
  assert.ok(seen.some(line => /Captured \d+ pages/.test(line)));
  assert.equal((route('/')!.scripts!.find(s => s.inline) as InlineScript).sample, 'window.answer = 42;');
  assert.ok(port > 0);
});

test('site addresses resolve through redirects and reject what is not a site', async t => {
  const { server, origin } = await fixtureSite(); t.after(() => server.close());
  const site = await resolveSite(origin + '/old');
  assert.equal(site.url, origin + '/about');
  assert.equal(site.platform.name, 'Webflow');
  assert.equal((await resolveSite(origin.replace('http://', ''))).url, origin + '/', 'a bare address without HTTPS falls back to HTTP');
  await assert.rejects(resolveSite('not a url'), /not a web address/);
  await assert.rejects(resolveSite(origin + '/missing'), /answered 404/);
});

test('extraction keeps pagination queries, drops tracking ones, and finds lazy and background media', () => {
  assert.equal(routeOf(new URL('https://a.com/blog?6f1_page=3&utm_source=x')), '/blog?6f1_page=3');
  assert.equal(routeOf(new URL('https://a.com/blog?utm_source=x')), '/blog');
  const facts = extract(`<html><body><img data-src="/lazy.jpg" data-srcset="/l-1.jpg 1x, /l-2.jpg 2x"><div class="w-background-video" data-poster-url="/poster.jpg" data-video-urls="/v.mp4,/v.webm"></div>
    <!-- <img src="/commented.jpg"> --><a href="mailto:hi@a.com">Mail</a><a href="#top">Top</a>
    <div data-animation-type="lottie" data-src="/anim.json"></div><button brand-menu="copy" data-src="/logo%20mark.png?v=2"></button><div data-src="/not-a-file"></div></body></html>`, 'https://a.com/');
  const assets = [...facts.assets.keys()].map(u => new URL(u).pathname).sort();
  assert.deepEqual(assets, ['/anim.json', '/l-1.jpg', '/l-2.jpg', '/lazy.jpg', '/logo%20mark.png', '/poster.jpg', '/v.mp4', '/v.webm']);
  assert.deepEqual(facts.links, []);
});

test('a scoped capture takes only the pages asked for (and where they redirect), and says what it left out', async t => {
  const { server, origin } = await fixtureSite(); t.after(() => server.close());
  const out = tmpDir('radial-capture-'); t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const inventory = await capture(origin, out, { only: ['/old'] });
  assert.deepEqual(inventory.routes.map(r => [r.path, r.status]), [['/about', 200], ['/old', 301]], 'the redirect is followed, links are not');
  assert.deepEqual(inventory.scope, ['/old']);
  assert.deepEqual(inventory.notCaptured.sort(), ['/', '/blog/b', '/gone'], 'the sitemap still maps the rest');
  assert.deepEqual(inventory.sitemapOnly, []);
  const files = inventory.assets.map(a => new URL(a.url).pathname);
  assert.ok(files.includes('/cdn/bg.png') && !files.includes('/cdn/hero.jpg'), 'only the scoped page\'s assets');
  await assert.rejects(capture(origin, out, { only: ['https://example.org/'] }), /must be on/);
  const { kickoffPrompt } = require('../src/main/migrate') as typeof import('../src/main/migrate');
  assert.match(kickoffPrompt({ url: origin, platform: 'Webflow', framework: 'astro', captureReadme: '/c/README.md', playbook: '/p/SKILL.md', provided: 0, scope: ['/'] }), /Scope: only \/ for now; build just this page/);
});

test('a screenshot width that failed without a message is recorded as failed, by captureSite and compareSite alike', async t => {
  const { server, origin } = await fixtureSite(); t.after(() => server.close());
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-migrate-')); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const { captureSite, compareSite } = require('../src/main/migrate') as typeof import('../src/main/migrate');
  // shoot() records the thrown error's message: '' for new Error(''), and undefined for a thrown string (outside ShotError's type).
  const shoot = async (_url: string, widths: number[]): Promise<ShotResult[]> => widths.map((width) => (width === 390 ? { width, error: '' } : { width, error: undefined as unknown as string }));
  const { inventory } = await captureSite(repo, origin, { shoot, widths: [390, 768], only: ['/'] });
  assert.deepEqual(inventory.screens, [{ route: '/', width: 390, error: 'no screenshot' }, { route: '/', width: 768, error: 'no screenshot' }]);
  const never = (): never => { throw new Error('a failed width reached the image code'); };
  const { report } = await compareSite(repo, 'http://127.0.0.1:1', { shoot, decode: never, encode: never, routes: ['/'], widths: [390, 768] });
  assert.deepEqual(report.rows, [{ route: '/', width: 390, error: 'no screenshot' }, { route: '/', width: 768, error: 'no screenshot' }]);
});
