// Capture a live website as migration evidence (plans/site-migration.md): every
// route Radial can find, the raw HTML as served, the assets those pages load, and
// an inventory an agent rebuilds the site from. Plain HTTP, no browser (shots.js
// adds the visual reference). A capture is evidence: written once, never edited.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import zlib from 'zlib';
import type { IncomingHttpHeaders } from 'http';

/** A hosted platform recognized from a page's markup; 'unknown' when none matches. */
export type PlatformId = 'webflow' | 'framer' | 'squarespace' | 'wix' | 'wordpress' | 'shopify' | 'unknown';
export interface SitePlatform { id: PlatformId; name: string }
/** What a URL a page loads is for: how it is fetched and filed. */
export type AssetKind = 'css' | 'js' | 'font' | 'icon' | 'media' | 'document' | 'file';
export interface ExternalScript { src: string; type: string; thirdParty: boolean; inline?: undefined }
/** An inline script, recorded by size, hash and its first 160 characters. */
export interface InlineScript { inline: true; type: string; bytes: number; sha: string; sample: string; src?: undefined; thirdParty?: undefined }
export type PageScript = ExternalScript | InlineScript;
/** A form and its visible fields (hidden and submit inputs left out). */
export interface PageForm { action: string; method: string; name: string; fields: { name: string; type: string }[] }
/** What extract() reads from one HTML document. */
export interface PageFacts {
  title: string; description: string; meta: Partial<Record<string, string>>; canonical: string; robots: string; lang: string; wfPage: string; wfSite: string;
  headings: { tag: string; text: string }[]; links: string[]; external: string[]; scripts: PageScript[]; forms: PageForm[]; embeds: string[];
  collectionLists: number;
  assets: Map<string, AssetKind>; // url -> kind
}
export interface GetOptions { accept?: string; timeoutMs?: number; maxBytes?: number; follow?: boolean }
/** httpGet's answer: `body` is null when the response is larger than maxBytes (tooLarge). */
export interface HttpResult { status: number; url: string; headers: IncomingHttpHeaders; body: Buffer | null; tooLarge?: true }
export type HttpGet = (url: string, options?: GetOptions) => Promise<HttpResult>;
/** A typed address resolved to the site's real origin (resolveSite), with its home page. */
export interface ResolvedSite { input: string; url: string; origin: string; host: string; status: number; html: string; platform: SitePlatform }
/** How the crawl reached a route. */
export type RouteVia = 'start' | 'sitemap' | 'link' | 'redirect';
/** One crawled URL: how it answered and, for a saved page, what extract() found (its assets as a count). */
export interface CapturedRoute extends Partial<Omit<PageFacts, 'meta' | 'assets'>> {
  path: string; url: string; via: RouteVia;
  status?: number; location?: string; contentType?: string; error?: string; file?: string;
  ogImage?: string; assets?: number; template?: string;
}
/** Routes that share a page template (templatesOf). */
export interface TemplateGroup { key: string; count: number; sample: string; paths: string[] }
/** A downloaded file, or an alias of the larger CDN variant that was downloaded instead. */
export interface CapturedAsset { url: string; file: string; kind: AssetKind; type: string; bytes: number; sha256: string; aliasOf?: string }
export interface SkippedAsset { url: string; kind: AssetKind; reason: string }
export interface CaptureOptions { get?: HttpGet; maxPages?: number; onProgress?: (line: string) => void; site?: ResolvedSite | null; only?: string[] | null }
/**
 * The base record capture() writes to inventory.json: what it saved, and what it
 * resolves. captureSite (migrate/index.ts) then rewrites the file with two more
 * top-level fields, `provided` and `screens`, which its readers rely on; type the
 * full on-disk record there as an extension of this one.
 */
export interface Inventory {
  schema: number;
  source: Pick<ResolvedSite, 'input' | 'url' | 'origin' | 'host'>;
  capturedAt: string;
  scope: string[] | null; // the routes asked for (`only`); null for the whole site
  platform: SitePlatform & { webflowSite: string };
  counts: { routes: number; pages: number; redirects: number; errors: number; assets: number; aliases: number; assetBytes: number; skipped: number };
  templates: Omit<TemplateGroup, 'paths'>[];
  collections: { template: string; items: number; sample: string }[];
  sitemapOnly: string[]; notCaptured: string[]; notInSitemap: string[];
  integrations: { host: string; example: string }[];
  forms: (PageForm & { page: string })[];
  routes: CapturedRoute[]; assets: CapturedAsset[]; skipped: SkippedAsset[];
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 RadialMigrate/1';
const MEDIA_FILE = /\.(?:avif|webp|png|jpe?g|gif|svg|ico|bmp|mp4|webm|mov|m4v|ogv|mp3|wav|ogg|m4a|json|lottie)$/i;
const many = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const LIMITS = { pages: 300, html: 8 * 1024 * 1024, file: 80 * 1024 * 1024, total: 1536 * 1024 * 1024 };

// Hosted-platform fingerprints, checked in order.
const PLATFORMS: { id: PlatformId; name: string; test: (html: string) => boolean }[] = [
  { id: 'webflow', name: 'Webflow', test: html => /data-wf-(?:site|page)=|website-files\.com|uploads-ssl\.webflow\.com|<meta[^>]+content="Webflow"/i.test(html) },
  { id: 'framer', name: 'Framer', test: html => /framerusercontent\.com|<meta[^>]+content="Framer|data-framer-/i.test(html) },
  { id: 'squarespace', name: 'Squarespace', test: html => /static1\.squarespace\.com|squarespace-cdn\.com|Static\.SQUARESPACE_CONTEXT/i.test(html) },
  { id: 'wix', name: 'Wix', test: html => /static\.wixstatic\.com|parastorage\.com|<meta[^>]+content="Wix/i.test(html) },
  { id: 'wordpress', name: 'WordPress', test: html => /\/wp-content\/|\/wp-includes\/|<meta[^>]+content="WordPress/i.test(html) },
  { id: 'shopify', name: 'Shopify', test: html => /cdn\.shopify\.com|Shopify\.theme/i.test(html) },
];
// Trackers and widgets stay integrations to keep (recorded, not downloaded).
const THIRD_PARTY = /(?:^|\.)(?:googletagmanager\.com|google-analytics\.com|googleadservices\.com|doubleclick\.net|facebook\.net|facebook\.com|hotjar\.com|segment\.(?:com|io)|intercom(?:cdn)?\.(?:com|io)|hs-scripts\.com|hs-analytics\.net|hubspot\.com|clarity\.ms|plausible\.io|usefathom\.com|posthog\.com|licdn\.com|linkedin\.com|twitter\.com|x\.com|tiktok\.com|cookiebot\.com|cookielaw\.org|onetrust\.com|termly\.io|usercentrics\.eu|youtube\.com|vimeo\.com|calendly\.com|typeform\.com|recaptcha\.net|google\.com)$/i;
const DOCUMENT = /\.(?:pdf|docx?|pptx?|xlsx?|zip|csv|mp4|webm|mov|mp3|wav|ogg)$/i;
const NOT_PAGE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|json|xml|txt|woff2?|ttf|otf|eot|map)$/i;

const decode = (s: string) => String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const tags = (html: string, name: string): string[] => html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) || [];
function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? '') : null;
}
const plain = (html: string) => decode(html.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const sameSite = (a: string, b: string) => a.replace(/^www\./, '') === b.replace(/^www\./, '');
const sha = (buf: string | Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

function resolve(raw: string | null | undefined, base: string | URL): URL | null {
  if (!raw || /^\s*(?:data|blob|javascript|mailto|tel|about|sms):/i.test(raw) || raw.trim().startsWith('#')) return null;
  try { const u = new URL(raw.trim(), base); u.hash = ''; return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; }
}
const srcsetUrls = (value: string | null) => String(value || '').split(/,\s+(?=\S)/).map(part => part.trim().split(/\s+/)[0]).filter(Boolean);
// url() and @import references, minus fragments (SVG #ids) and template placeholders from CSS-in-JS.
const cssUrls = (css: string) => [...css.matchAll(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi)].map(m => m[2]).concat([...css.matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/gi)].map(m => m[1]))
  .filter(v => !/^\s*(?:#|%23)/.test(v) && !/\$\{|\{\{/.test(v));
// Image CDNs that serve one image at many sizes: the capture keeps the largest
// size the site used, once, and records the rest as aliases of that file.
function variantOf(u: URL): { key: string; size: number } | null {
  if (/(?:^|\.)framerusercontent\.com$/.test(u.hostname) && u.pathname.startsWith('/images/')) return { key: u.origin + u.pathname, size: Number(u.searchParams.get('scale-down-to')) || Infinity };
  if (/(?:^|\.)squarespace-cdn\.com$/.test(u.hostname)) { const f = u.searchParams.get('format') || ''; return { key: u.origin + u.pathname, size: f === 'original' || !f ? Infinity : parseInt(f, 10) || Infinity }; }
  return null;
}

// A crawlable route key: same-site path, pagination queries kept, others dropped.
function routeOf(u: URL): string {
  const keep = [...u.searchParams].filter(([k, v]) => /(?:^|_)page$/i.test(k) && /^\d+$/.test(v));
  return u.pathname + (keep.length ? '?' + keep.map(([k, v]) => `${k}=${v}`).join('&') : '');
}

// Everything a rebuild needs from one HTML document.
function extract(html: string, pageUrl: string): PageFacts {
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  // Tags are read from the markup only: HTML inside script strings is code, not the page.
  const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');
  const base = resolve(attr(tags(html, 'base')[0] || '', 'href'), pageUrl) || new URL(pageUrl);
  const meta: Partial<Record<string, string>> = {};
  for (const t of tags(html, 'meta')) { const k = (attr(t, 'name') || attr(t, 'property') || '').toLowerCase(); if (k && !(k in meta)) meta[k] = attr(t, 'content') || ''; }
  const linkTags = tags(html, 'link');
  const rel = (t: string, r: string) => (attr(t, 'rel') || '').toLowerCase().split(/\s+/).includes(r);
  const assets = new Map<string, AssetKind>(); // url -> kind
  const add = (raw: string | null | undefined, kind: AssetKind, from = base) => { const u = resolve(raw, from); if (u) assets.set(u.href, assets.get(u.href) || kind); };
  for (const t of linkTags) {
    if (rel(t, 'stylesheet')) add(attr(t, 'href'), 'css');
    else if (['icon', 'apple-touch-icon', 'mask-icon', 'manifest'].some(r => rel(t, r))) add(attr(t, 'href'), 'icon');
    else if (rel(t, 'preload')) add(attr(t, 'href'), ({ image: 'media', script: 'js', style: 'css', font: 'font' } as Partial<Record<string, AssetKind>>)[(attr(t, 'as') || '').toLowerCase()] || 'file');
  }
  const scripts: PageScript[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const open = '<script' + m[1] + '>', src = attr(open, 'src'), type = attr(open, 'type') || '';
    if (src) { const u = resolve(src, base); if (!u) continue; const third = THIRD_PARTY.test(u.hostname); scripts.push({ src: u.href, type, thirdParty: third }); if (!third) add(u.href, 'js'); }
    else if (m[2].trim() && !/json|template/i.test(type)) scripts.push({ inline: true, type, bytes: Buffer.byteLength(m[2]), sha: sha(m[2]).slice(0, 16), sample: m[2].trim().slice(0, 160) });
  }
  for (const t of [...tags(markup, 'img'), ...tags(markup, 'source'), ...tags(markup, 'video'), ...tags(markup, 'audio'), ...tags(markup, 'image'), ...tags(markup, 'input')]) {
    for (const a of ['src', 'data-src', 'poster', 'href', 'xlink:href', 'data-poster-url']) { const v = attr(t, a); if (v && !(a === 'href' && !/^<image/i.test(t))) add(v, 'media'); }
    for (const a of ['srcset', 'data-srcset']) srcsetUrls(attr(t, a)).forEach(v => add(v, 'media'));
  }
  // Lottie players, lazy loaders and copy-logo buttons keep their file in data-src on any element.
  for (const t of markup.match(/<[a-z][^>]*\sdata-src=[^>]*>/gi) || []) { const v = attr(t, 'data-src'); if (v && MEDIA_FILE.test(v.split(/[?#]/)[0])) add(v, 'media'); }
  // Webflow background videos: the URLs and poster live on a div.
  for (const t of markup.match(/<[a-z][^>]*\sdata-(?:video-urls|poster-url)=[^>]*>/gi) || []) {
    (attr(t, 'data-video-urls') || '').split(',').filter(Boolean).forEach(v => add(v.trim(), 'media'));
    if (attr(t, 'data-poster-url')) add(attr(t, 'data-poster-url'), 'media');
  }
  for (const m of markup.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) cssUrls(decode(m[2])).forEach(v => add(v, 'media'));
  for (const m of markup.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) cssUrls(m[1]).forEach(v => add(v, 'media'));
  for (const k of ['og:image', 'twitter:image', 'og:image:secure_url']) if (meta[k]) add(meta[k], 'media');
  const links = new Set<string>(), external = new Set<string>();
  for (const t of tags(markup, 'a')) {
    const u = resolve(attr(t, 'href'), base); if (!u) continue;
    if (!sameSite(u.hostname, base.hostname)) { external.add(u.href); continue; }
    if (DOCUMENT.test(u.pathname)) add(u.href, 'document'); else if (!NOT_PAGE.test(u.pathname)) links.add(routeOf(u));
  }
  for (const t of tags(markup, 'a')) { const u = resolve(attr(t, 'href'), base); if (u && !sameSite(u.hostname, base.hostname) && DOCUMENT.test(u.pathname) && !THIRD_PARTY.test(u.hostname)) add(u.href, 'document'); }
  const forms: PageForm[] = [];
  for (const m of markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const open = '<form' + m[1] + '>';
    forms.push({ action: attr(open, 'action') || '', method: (attr(open, 'method') || 'get').toLowerCase(), name: attr(open, 'name') || attr(open, 'data-name') || attr(open, 'id') || '',
      fields: [...tags(m[2], 'input'), ...tags(m[2], 'textarea'), ...tags(m[2], 'select')].map(f => ({ name: attr(f, 'name') || '', type: attr(f, 'type') || f.match(/^<(\w+)/)![1].toLowerCase() })).filter(f => f.type !== 'hidden' && f.type !== 'submit') });
  }
  const headings = [...html.matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(m => ({ tag: m[1].toLowerCase(), text: plain(m[2]) })).filter(h => h.text).slice(0, 40);
  const htmlTag = tags(html, 'html')[0] || '';
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return {
    title: titleMatch ? plain(titleMatch[1]) : '', description: meta.description || '', meta,
    canonical: (() => { const t = linkTags.find(l => rel(l, 'canonical')); const u = t && resolve(attr(t, 'href'), base); return u ? u.href : ''; })(),
    robots: meta.robots || '', lang: attr(htmlTag, 'lang') || '', wfPage: attr(htmlTag, 'data-wf-page') || '', wfSite: attr(htmlTag, 'data-wf-site') || '',
    headings, links: [...links], external: [...external], scripts, forms,
    embeds: tags(markup, 'iframe').map(t => resolve(attr(t, 'src') || attr(t, 'data-src'), base)).filter(Boolean).map(u => u!.href),
    collectionLists: (html.match(/\bw-dyn-list\b/g) || []).length,
    assets,
  };
}

function detectPlatform(html: string): SitePlatform {
  const hit = PLATFORMS.find(p => p.test(html));
  return hit ? { id: hit.id, name: hit.name } : { id: 'unknown', name: 'Unknown' };
}

// A small GET with what real sites need: large response headers (builders send
// big CSP and cookie headers that Node's fetch rejects), gzip/deflate/brotli,
// redirects either followed or reported, a size cap and a timeout. Resolves
// { status, url, headers, body: Buffer | null, tooLarge }.
function httpGet(url: string, { accept = '*/*', timeoutMs = 30000, maxBytes = LIMITS.html, follow = false }: GetOptions = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const go = (current: string, hops: number): void => {
      let u; try { u = new URL(current); } catch { return reject(new Error('Bad address: ' + current)); }
      const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
      if (!lib) return reject(new Error('Unsupported address: ' + current));
      const req = lib.request(u, { method: 'GET', maxHeaderSize: 512 * 1024, timeout: timeoutMs,
        headers: { 'user-agent': UA, accept, 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en-US,en;q=0.9' } }, (res) => {
        const status = res.statusCode!, headers = res.headers;
        if (follow && status >= 300 && status < 400 && headers.location && hops < 10) { res.resume(); return go(new URL(headers.location, current).href, hops + 1); }
        if (Number(headers['content-length'] || 0) > maxBytes) { res.destroy(); return resolve({ status, url: current, headers, body: null, tooLarge: true }); }
        const enc = String(headers['content-encoding'] || '').toLowerCase();
        const stream = enc.includes('gzip') ? res.pipe(zlib.createGunzip()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
        const chunks: Buffer[] = []; let size = 0, done = false;
        stream.on('data', (chunk) => {
          if (done) return;
          size += chunk.length;
          if (size > maxBytes) { done = true; res.destroy(); return resolve({ status, url: current, headers, body: null, tooLarge: true }); }
          chunks.push(chunk);
        });
        stream.on('end', () => { if (!done) { done = true; resolve({ status, url: current, headers, body: Buffer.concat(chunks) }); } });
        stream.on('error', (error) => { if (!done) { done = true; reject(error); } });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      req.end();
    };
    go(url, 0);
  });
}
const header = (res: HttpResult, name: string): string => { const v = res.headers[name]; return Array.isArray(v) ? v[0] : v || ''; };

// Normalize what a person typed ("acme.com", "https://www.acme.com/about") to the
// site's real origin by following its redirects.
async function resolveSite(input: string, { get = httpGet }: Pick<CaptureOptions, 'get'> = {}): Promise<ResolvedSite> {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('Enter the address of the site to bring in.');
  const bare = !/^https?:\/\//i.test(raw);
  if (bare) raw = 'https://' + raw;
  let start;
  try { start = new URL(raw); } catch { throw new Error(`“${input}” is not a web address.`); }
  if (!/^https?:$/.test(start.protocol) || !start.hostname.includes('.') && start.hostname !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(start.hostname)) throw new Error(`“${input}” is not a web address.`);
  let res;
  try { res = await get(start.href, { follow: true, accept: 'text/html', timeoutMs: 20000 }); }
  catch (error) {
    // A typed bare address that has no HTTPS (old sites, local servers) gets one try over HTTP.
    if (!bare) throw new Error(`Could not reach ${start.hostname}: ${(error as NodeJS.ErrnoException).code || (error as Error).message}`);
    try { start.protocol = 'http:'; res = await get(start.href, { follow: true, accept: 'text/html', timeoutMs: 20000 }); }
    catch { throw new Error(`Could not reach ${start.hostname}: ${(error as NodeJS.ErrnoException).code || (error as Error).message}`); }
  }
  const final = new URL(res.url || start.href);
  const html = res.body ? res.body.toString('utf8') : '';
  if (res.status < 200 || res.status >= 300) throw new Error(`${final.hostname} answered ${res.status}. Check the address, or whether the site is password protected.`);
  return { input: String(input), url: final.href, origin: final.origin, host: final.hostname, status: res.status, html, platform: detectPlatform(html) };
}

async function sitemapRoutes(origin: string, get: HttpGet, robotsText: string): Promise<{ urls: string[]; files: { url: string; xml: string }[] }> {
  const queue = [...new Set([...(robotsText.match(/^\s*sitemap:\s*(\S+)/gim) || []).map(l => l.replace(/^\s*sitemap:\s*/i, '').trim()), origin + '/sitemap.xml'])];
  const seen = new Set<string>(), urls = new Set<string>(), files: { url: string; xml: string }[] = [];
  while (queue.length && seen.size < 20) {
    const next = queue.shift()!; if (seen.has(next)) continue; seen.add(next);
    try {
      const res = await get(next, { follow: true, accept: 'application/xml,text/xml', timeoutMs: 20000 });
      if (res.status !== 200 || !res.body) continue;
      const xml = res.body.toString('utf8');
      files.push({ url: next, xml });
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => decode(m[1]));
      if (/<sitemapindex/i.test(xml)) locs.forEach(l => queue.push(l)); else locs.forEach(l => urls.add(l));
    } catch {}
  }
  return { urls: [...urls], files };
}

async function mapPool<T>(items: T[], n: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

function pageFile(route: string): string {
  const [p, q] = route.split('?');
  let rel = p.replace(/^\/+/, '');
  rel = !rel ? 'index' : rel.endsWith('/') ? rel + 'index' : rel;
  rel = rel.replace(/\.html?$/i, '').split('/').map(s => s.replace(/[^\w.-]+/g, '_').slice(0, 120) || '_').join('/');
  return path.join('pages', rel + (q ? '__' + sha(q).slice(0, 8) : '') + '.html');
}
function assetFile(u: URL, contentType = ''): string {
  let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) rel += 'index';
  rel = rel.split('/').map(s => s.replace(/[^\w.@-]+/g, '_').slice(0, 120) || '_').join('/');
  if (!path.extname(rel)) { const ext = { 'text/css': '.css', 'application/javascript': '.js', 'text/javascript': '.js', 'image/svg+xml': '.svg', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/avif': '.avif', 'image/gif': '.gif', 'font/woff2': '.woff2', 'font/woff': '.woff' }[contentType.split(';')[0].trim()]; if (ext) rel += ext; }
  if (u.search) { const ext = path.extname(rel); rel = rel.slice(0, rel.length - ext.length) + '__' + sha(u.search).slice(0, 8) + ext; }
  return path.join('assets', u.hostname, rel);
}

// Template grouping: Webflow names its page templates; elsewhere, siblings under
// one parent path (/blog/a, /blog/b) are one collection template.
function templatesOf(routes: Pick<CapturedRoute, 'path' | 'wfPage' | 'template'>[]): TemplateGroup[] {
  const byParent = new Map<string, number>();
  for (const r of routes) { const parts = r.path.split('?')[0].split('/').filter(Boolean); if (parts.length >= 2) { const parent = '/' + parts.slice(0, -1).join('/'); byParent.set(parent, (byParent.get(parent) || 0) + 1); } }
  const templates = new Map<string, string[]>();
  for (const r of routes) {
    const parts = r.path.split('?')[0].split('/').filter(Boolean), parent = '/' + parts.slice(0, -1).join('/');
    r.template = r.wfPage ? 'webflow:' + r.wfPage : parts.length >= 2 && byParent.get(parent)! >= 2 ? parent + '/*' : r.path.split('?')[0] || '/';
    if (!templates.has(r.template)) templates.set(r.template, []);
    templates.get(r.template)!.push(r.path);
  }
  return [...templates].map(([key, paths]) => ({ key, count: paths.length, sample: paths.find(p => !p.includes('?')) || paths[0], paths }));
}

// Crawl and save. onProgress(text) receives short human progress lines.
// `only` limits the capture to those pages (and wherever they redirect) when the
// person wants to start with part of a site; the sitemap still maps the rest.
async function capture(input: string, outDir: string, { get = httpGet, maxPages = LIMITS.pages, onProgress = () => {}, site = null, only = null }: CaptureOptions = {}): Promise<Inventory> {
  site = site || await resolveSite(input, { get });
  const origin = site.origin, host = site.host;
  fs.mkdirSync(outDir, { recursive: true });
  const write = (rel: string, data: string | Buffer) => { const file = path.join(outDir, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return rel; };
  onProgress(`Reading ${host} (${site.platform.name})…`);
  let robots = '';
  try { const res = await get(origin + '/robots.txt', { follow: true, accept: 'text/plain', timeoutMs: 15000, maxBytes: 512 * 1024 }); if (res.status === 200 && res.body && !/html/i.test(header(res, 'content-type'))) robots = res.body.toString('utf8'); } catch {}
  if (robots) write('robots.txt', robots);
  const sitemap = await sitemapRoutes(origin, get, robots);
  sitemap.files.forEach((f, i) => write(i ? `sitemaps/sitemap-${i}.xml` : 'sitemap.xml', f.xml));
  const queue: { route: string; via: RouteVia }[] = [], queued = new Set<string>(), sitemapPaths = new Set<string>();
  const scope = only && only.length ? [...new Set(only.map(p => { const u = resolve(p, origin); return u && sameSite(u.hostname, host) ? routeOf(u) : null; }))] : null;
  if (scope && scope.includes(null)) throw new Error(`Pages to capture must be on ${host}: ${only!.join(', ')}`);
  const enqueue = (raw: string | null, via: RouteVia) => {
    const u = resolve(raw, origin); if (!u || !sameSite(u.hostname, host) || NOT_PAGE.test(u.pathname) || DOCUMENT.test(u.pathname)) return;
    const route = routeOf(u); if (via === 'sitemap') sitemapPaths.add(route);
    if (scope && (via === 'sitemap' || via === 'link')) return;
    if (queued.has(route) || queued.size >= maxPages) return;
    queued.add(route); queue.push({ route, via });
  };
  if (scope) scope.forEach(route => enqueue(route, 'start'));
  else enqueue(new URL(site.url).pathname || '/', 'start');
  sitemap.urls.forEach(u => enqueue(u, 'sitemap'));
  onProgress(scope ? `Capturing ${scope.join(', ')} only${sitemap.urls.length ? ` (the sitemap lists ${sitemap.urls.length} pages)` : ''}.` : sitemap.urls.length ? `Sitemap lists ${sitemap.urls.length} pages.` : 'No sitemap; following links.');

  const routes: CapturedRoute[] = [], assetKinds = new Map<string, AssetKind>(), platformVotes = new Map([[site.platform.id, 1]]);
  for (let at = 0; at < queue.length; at += 0) {
    const batch = queue.slice(at, at + 6); at += batch.length;
    await mapPool(batch, 6, async ({ route, via }) => {
      const url = origin + route, entry: CapturedRoute = { path: route, url, via };
      try {
        const res = await get(url, { accept: 'text/html' });
        entry.status = res.status;
        if (res.status >= 300 && res.status < 400) { entry.location = header(res, 'location'); const target = resolve(entry.location, url); if (target) enqueue(target.href, 'redirect'); routes.push(entry); return; }
        entry.contentType = header(res, 'content-type');
        if (!/html/i.test(entry.contentType)) { routes.push(entry); return; }
        const buf = res.body;
        if (!buf) { entry.error = 'page larger than 8 MB'; routes.push(entry); return; }
        entry.file = write(pageFile(route), buf);
        const facts = extract(buf.toString('utf8'), url), p = detectPlatform(buf.toString('utf8'));
        platformVotes.set(p.id, (platformVotes.get(p.id) || 0) + 1);
        for (const [a, kind] of facts.assets) assetKinds.set(a, assetKinds.get(a) || kind);
        facts.links.forEach(l => enqueue(l, 'link'));
        const { assets, meta, ...rest } = facts;
        Object.assign(entry, rest, { ogImage: meta['og:image'] || '', assets: assets.size });
      } catch (error) { entry.error = (error as NodeJS.ErrnoException).code || (error as Error).message; }
      routes.push(entry);
    });
    onProgress(`Pages: ${routes.length} of ${queue.length} found.`);
  }
  routes.sort((a, b) => a.path.localeCompare(b.path));

  // Assets: stylesheets first (their url() references join the list), then the rest.
  const manifest: CapturedAsset[] = [], skipped: SkippedAsset[] = [], done = new Set<string>();
  let total = 0;
  const fetchAsset = async (href: string, kind: AssetKind) => {
    if (done.has(href)) return; done.add(href);
    const u = new URL(href);
    if (THIRD_PARTY.test(u.hostname)) return;
    try {
      const res = await get(href, { follow: true, timeoutMs: 60000, maxBytes: LIMITS.file });
      if (res.status < 200 || res.status >= 300) { skipped.push({ url: href, kind, reason: `HTTP ${res.status}` }); return; }
      const type = header(res, 'content-type');
      const buf = res.body;
      if (!buf) { skipped.push({ url: href, kind, reason: 'larger than 80 MB' }); return; }
      if (total + buf.length > LIMITS.total) { skipped.push({ url: href, kind, reason: 'capture size limit (1.5 GB) reached' }); return; }
      total += buf.length;
      const file = write(assetFile(u, type), buf);
      manifest.push({ url: href, file, kind, type: type.split(';')[0], bytes: buf.length, sha256: sha(buf) });
      if (kind === 'css' || /text\/css/i.test(type)) for (const ref of cssUrls(buf.toString('utf8'))) { const r = resolve(ref, href); if (r && !done.has(r.href)) assetKinds.set(r.href, assetKinds.get(r.href) || (/\.(?:woff2?|ttf|otf|eot)$/i.test(r.pathname) ? 'font' : r.pathname.endsWith('.css') ? 'css' : 'media')); }
    } catch (error) { skipped.push({ url: href, kind, reason: (error as NodeJS.ErrnoException).code || (error as Error).message }); }
  };
  for (let round = 0; round < 3; round++) {
    const css = [...assetKinds].filter(([u, k]) => k === 'css' && !done.has(u));
    if (!css.length) break;
    await mapPool(css, 6, ([u, k]) => fetchAsset(u, k));
  }
  const groups = new Map<string, { url: string; size: number }[]>(); // variant key -> [{ url, size }]
  for (const [u] of assetKinds) { const v = variantOf(new URL(u)); if (v) { if (!groups.has(v.key)) groups.set(v.key, []); groups.get(v.key)!.push({ url: u, size: v.size }); } }
  const aliasOf = new Map<string, string>(); // variant url -> the url actually downloaded
  for (const list of groups.values()) { const best = list.reduce((a, b) => (b.size > a.size ? b : a)); for (const v of list) if (v.url !== best.url) aliasOf.set(v.url, best.url); }
  const rest = [...assetKinds].filter(([u]) => !done.has(u) && !aliasOf.has(u));
  onProgress(`Downloading ${rest.length + manifest.length} assets…`);
  let count = 0;
  await mapPool(rest, 8, async ([u, k]) => { await fetchAsset(u, k); if (++count % 50 === 0) onProgress(`Assets: ${count} of ${rest.length} (${Math.round(total / 1048576)} MB).`); });
  for (const [variant, best] of aliasOf) { const got = manifest.find(m => m.url === best); if (got) manifest.push({ ...got, url: variant, aliasOf: best }); }
  manifest.sort((a, b) => a.url.localeCompare(b.url));

  const platform = [...platformVotes].sort((a, b) => b[1] - a[1])[0][0];
  const platformName = (PLATFORMS.find(p => p.id === platform) || { name: 'Unknown' }).name;
  const pages = routes.filter(r => r.file);
  const templates = templatesOf(pages);
  const integrations = [...new Map(pages.flatMap(r => (r.scripts || []).filter(s => s.thirdParty).map(s => [new URL(s.src!).hostname, { host: new URL(s.src!).hostname, example: s.src! }]))).values()];
  const inventory: Inventory = {
    schema: 1, source: { input: site.input, url: site.url, origin, host }, capturedAt: new Date().toISOString(), scope: scope as string[] | null,
    platform: { id: platform, name: platformName, webflowSite: pages.find(r => r.wfSite)?.wfSite || '' },
    counts: { routes: routes.length, pages: pages.length, redirects: routes.filter(r => r.location).length, errors: routes.filter(r => r.error || (r.status! >= 400)).length, assets: manifest.filter(m => !m.aliasOf).length, aliases: aliasOf.size, assetBytes: total, skipped: skipped.length },
    templates: templates.map(({ paths, ...t }) => t),
    collections: templates.filter(t => t.count >= 2 && (t.key.endsWith('/*') || t.key.startsWith('webflow:'))).map(t => ({ template: t.key, items: t.count, sample: t.sample })),
    sitemapOnly: scope ? [] : [...sitemapPaths].filter(p => !routes.some(r => r.path === p)),
    notCaptured: scope ? [...sitemapPaths].filter(p => !routes.some(r => r.path === p)) : [],
    notInSitemap: sitemapPaths.size ? pages.map(r => r.path).filter(p => !sitemapPaths.has(p)) : [],
    integrations, forms: pages.flatMap(r => (r.forms || []).map(f => ({ ...f, page: r.path }))),
    routes, assets: manifest, skipped,
  };
  write('inventory.json', JSON.stringify(inventory, null, 2));
  onProgress(`Captured ${many(pages.length, 'page')} and ${many(manifest.length, 'asset')} (${Math.round(total / 1048576)} MB).`);
  return inventory;
}

export { many, capture, resolveSite, httpGet, extract, detectPlatform, templatesOf, routeOf, pageFile, assetFile, UA, LIMITS };
