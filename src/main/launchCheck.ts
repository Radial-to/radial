import * as projectData from './projectData';

// Pre-launch checklist: deterministic, per-project readiness checks.
//
// The engine fetches each page's rendered HTML from the running dev server,
// extracts a small set of facts, and runs a registry of checks over them.
// Every result here is a hard, measured pass/fail. No agent, no judgment.
// The agent-judged dimensions (visual consistency, copy, responsive polish)
// come in a later pass and stay visually distinct from these verified checks.

import fs from 'fs';
import path from 'path';
import type { LaunchCheckIssue, LaunchCheckItem, LaunchCheckReport, LaunchCheckScan, LaunchCheckStatus } from '../shared/radialApi';
import type { PageEntry } from './project';

/** What a page's rendered HTML says, as the checks read it. */
export interface PageFacts {
  /** Whitespace collapsed; '' when the page has no title. */
  title: string;
  /** null when there's no meta description tag. */
  description: string | null;
  /** Lowercased; null when there's no meta robots tag. */
  robots: string | null;
  hasOgTitle: boolean;
  hasOgImage: boolean;
  favicon: boolean;
  images: { src: string; hasAlt: boolean; decorative: boolean }[];
  /** Heading levels (1-6) in document order. */
  headings: number[];
  /** Relative hrefs: absolute http(s), mailto:, tel:, #, javascript:, data: and sms: links are left out. */
  links: string[];
}
/** A fetched page the checks run over. */
export interface LaunchCheckPage { route: string; label: string; facts: PageFacts }
/** An internal link that didn't resolve; status 0 or missing means unreachable. */
export interface BrokenLink { route: string; href: string; status?: number }
export interface LaunchCheckContext { brokenLinks?: BrokenLink[] }
/** One check in the registry. `run` is called as a method: it reads its own id, label, category and hint. */
export interface LaunchCheckDef {
  id: string;
  label: string;
  category: string;
  hint: string;
  run(this: LaunchCheckDef, pages: LaunchCheckPage[], ctx: LaunchCheckContext): LaunchCheckItem;
}
/** A page as scan fetched it. */
type FetchedPage = (LaunchCheckPage & { ok: true }) | { route: string; label: string; ok: false; error: string };

// ── HTML fact extraction ──────────────────────────────────────────────────
// Targeted, dependency-free extraction of the handful of tags each check
// needs. This is not a full HTML parser: marketing-site output is well-formed
// and we only read specific tags, so scoped regex is enough and keeps the
// build lean (no new bundled dependency).

function attr(tag: string, name: string): string | null {
  const m = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
  if (!m) return null;
  return m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] != null ? m[3] : '';
}

function tags(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp('<' + name + '\\b[^>]*>', 'gi'))].map((m) => m[0]);
}

function extractPageFacts(html: string): PageFacts {
  html = String(html || '');

  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleM ? titleM[1].replace(/\s+/g, ' ').trim() : '';

  const metas = tags(html, 'meta');
  const metaByName = (name: string) =>
    metas.find((t) => (attr(t, 'name') || '').toLowerCase() === name);
  const metaByProp = (prop: string) =>
    metas.find((t) => (attr(t, 'property') || '').toLowerCase() === prop);

  const descTag = metaByName('description');
  const description = descTag ? (attr(descTag, 'content') || '').trim() : null;
  const robotsTag = metaByName('robots');
  const robots = robotsTag ? (attr(robotsTag, 'content') || '').trim().toLowerCase() : null;

  const favicon = tags(html, 'link').some((t) => /\bicon\b/i.test(attr(t, 'rel') || ''));

  const images = tags(html, 'img').map((t) => {
    const alt = attr(t, 'alt');
    const decorative = alt === '' || /role\s*=\s*["']?presentation/i.test(t) || /\baria-hidden\s*=\s*["']?true/i.test(t);
    return { src: attr(t, 'src') || '', hasAlt: alt != null && alt.trim() !== '', decorative };
  });

  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>/gi)].map((m) => Number(m[1]));

  const links = tags(html, 'a')
    .map((t) => attr(t, 'href'))
    .filter((h) => h && !/^(https?:|mailto:|tel:|#|javascript:|data:|sms:)/i.test(h)) as string[];

  return {
    title,
    description,
    robots,
    hasOgTitle: !!metaByProp('og:title'),
    hasOgImage: !!metaByProp('og:image'),
    favicon,
    images,
    headings,
    links,
  };
}

// ── Check registry ────────────────────────────────────────────────────────
// Each check runs over the fetched pages ([{route, label, facts}]) plus a
// context ({brokenLinks}). It returns a result whose status is the worst
// severity among its issues: fail > warn > pass. `na` means nothing to check.

function mkResult(def: LaunchCheckDef, summary: string, issues: LaunchCheckIssue[], opts?: { emptyStatus?: LaunchCheckStatus }): LaunchCheckItem {
  let status: LaunchCheckStatus = (opts && opts.emptyStatus) || 'pass';
  if (issues.length) {
    status = 'warn';
    for (const i of issues) if (i.sev === 'fail') { status = 'fail'; break; }
  }
  return { id: def.id, label: def.label, category: def.category, hint: def.hint, status, summary, issues };
}

const CHECKS: LaunchCheckDef[] = [
  {
    id: 'titles', label: 'Page titles', category: 'SEO & sharing',
    hint: 'Every page needs a unique title within about 60 characters. Titles show in browser tabs and search results.',
    run(pages) {
      const issues: LaunchCheckIssue[] = [];
      const seen = new Map<string, string[]>();
      for (const p of pages) {
        const t = p.facts.title;
        if (!t) { issues.push({ route: p.route, sev: 'fail', msg: 'No title set' }); continue; }
        if (t.length > 60) issues.push({ route: p.route, sev: 'warn', msg: `Title is ${t.length} chars (aim for 60 or fewer)` });
        const key = t.toLowerCase();
        seen.set(key, (seen.get(key) || []).concat(p.route));
      }
      for (const [t, routes] of seen) {
        if (routes.length > 1) issues.push({ route: '', sev: 'fail', msg: `${routes.length} pages share the title "${t.slice(0, 50)}"` });
      }
      return mkResult(this, issues.length ? `${issues.length} to fix across ${pages.length} pages` : `All ${pages.length} pages have a unique, right-length title`, issues);
    },
  },
  {
    id: 'descriptions', label: 'Meta descriptions', category: 'SEO & sharing',
    hint: 'Each page should have a meta description under about 160 characters. It is the summary shown under the title in search results.',
    run(pages) {
      const issues: LaunchCheckIssue[] = [];
      for (const p of pages) {
        const d = p.facts.description;
        if (d == null || d === '') issues.push({ route: p.route, sev: 'warn', msg: 'No meta description' });
        else if (d.length > 160) issues.push({ route: p.route, sev: 'warn', msg: `Description is ${d.length} chars (aim for 160 or fewer)` });
      }
      return mkResult(this, issues.length ? `${issues.length} pages need a description` : `All ${pages.length} pages have a description`, issues);
    },
  },
  {
    id: 'social', label: 'Social preview tags', category: 'SEO & sharing',
    hint: 'Open Graph tags (og:title, og:image) control how a link looks when shared on social or in chat.',
    run(pages) {
      const issues: LaunchCheckIssue[] = [];
      for (const p of pages) {
        const miss: string[] = [];
        if (!p.facts.hasOgTitle) miss.push('og:title');
        if (!p.facts.hasOgImage) miss.push('og:image');
        if (miss.length) issues.push({ route: p.route, sev: 'warn', msg: `Missing ${miss.join(' + ')}` });
      }
      return mkResult(this, issues.length ? `${issues.length} pages missing social tags` : 'Every page has social preview tags', issues);
    },
  },
  {
    id: 'favicon', label: 'Favicon', category: 'SEO & sharing',
    hint: 'A favicon is the small icon in the browser tab. One site-wide icon link is enough.',
    run(pages) {
      const has = pages.some((p) => p.facts.favicon);
      const issues: LaunchCheckIssue[] = has ? [] : [{ route: '', sev: 'warn', msg: 'No <link rel="icon"> found on any page' }];
      return mkResult(this, has ? 'Favicon is set' : 'No favicon found', issues);
    },
  },
  {
    id: 'headings', label: 'Heading structure', category: 'Accessibility',
    hint: 'Each page should have exactly one h1 and no skipped heading levels (h1 then h3 with no h2). Screen readers and search engines use this outline.',
    run(pages) {
      const issues: LaunchCheckIssue[] = [];
      for (const p of pages) {
        const hs = p.facts.headings;
        const h1s = hs.filter((h) => h === 1).length;
        if (h1s === 0) issues.push({ route: p.route, sev: 'fail', msg: 'No h1' });
        else if (h1s > 1) issues.push({ route: p.route, sev: 'warn', msg: `${h1s} h1 headings (use one)` });
        let prev = 0;
        for (const level of hs) {
          if (prev && level > prev + 1) { issues.push({ route: p.route, sev: 'warn', msg: `Jumps from h${prev} to h${level}` }); break; }
          prev = level;
        }
      }
      return mkResult(this, issues.length ? `${issues.length} pages have heading issues` : `Clean heading outline on all ${pages.length} pages`, issues);
    },
  },
  {
    id: 'alt', label: 'Image alt text', category: 'Accessibility',
    hint: 'Every content image needs alt text so screen readers can describe it. Decorative images (empty alt or aria-hidden) are exempt.',
    run(pages) {
      const issues: LaunchCheckIssue[] = [];
      let total = 0;
      for (const p of pages) {
        for (const img of p.facts.images) {
          total++;
          if (!img.hasAlt && !img.decorative) issues.push({ route: p.route, sev: 'fail', msg: `Image missing alt: ${(img.src || '').slice(0, 60) || '(no src)'}` });
        }
      }
      if (total === 0) return mkResult(this, 'No images to check', [], { emptyStatus: 'na' });
      return mkResult(this, issues.length ? `${issues.length} of ${total} images missing alt` : `All ${total} images have alt text`, issues);
    },
  },
  {
    id: 'links', label: 'Internal links', category: 'Links',
    hint: 'Every internal link should resolve. Broken links (404s) are a common last-minute regression.',
    run(pages, ctx) {
      const broken = (ctx && ctx.brokenLinks) || [];
      const issues: LaunchCheckIssue[] = broken.map((b) => ({ route: b.route, sev: 'fail', msg: `${b.href} -> ${b.status || 'unreachable'}` }));
      return mkResult(this, issues.length ? `${issues.length} broken links` : 'All internal links resolve', issues);
    },
  },
];

function runChecks(pages: LaunchCheckPage[], ctx?: LaunchCheckContext): LaunchCheckItem[] {
  return CHECKS.map((c) => c.run(pages, ctx || {}));
}

// ── Scan (I/O) ────────────────────────────────────────────────────────────
// Fetches each page from the running preview, extracts facts, crawls internal
// links, then runs the pure checks. Separated from runChecks so the checks
// stay unit-testable without a live server.

function joinUrl(base: string, route: string): string {
  try { return new URL(route || '/', base).href; } catch { return base; }
}

async function get(url: string, ms?: number): Promise<{ status: number; body: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 8000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const workers = new Array<number>(Math.min(concurrency, items.length || 1)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function crawlLinks(previewUrl: string, fetched: FetchedPage[], cap: number): Promise<BrokenLink[]> {
  const origin = (() => { try { return new URL(previewUrl).origin; } catch { return null; } })();
  const jobs: { route: string; href: string; abs: string }[] = [];
  const seen = new Set<string>();
  for (const p of fetched) {
    if (!p.ok) continue;
    for (const href of p.facts.links) {
      let abs: string;
      try { abs = new URL(href, joinUrl(previewUrl, p.route)).href; } catch { continue; }
      try { if (origin && new URL(abs).origin !== origin) continue; } catch { continue; }
      const key = p.route + ' ' + abs;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({ route: p.route, href, abs });
    }
  }
  const limited = jobs.slice(0, cap || 200);
  const statuses = new Map<string, number>();
  await mapPool([...new Set(limited.map((j) => j.abs))], 8, async (abs) => {
    try { const r = await get(abs, 6000); statuses.set(abs, r.status); }
    catch { statuses.set(abs, 0); }
  });
  const broken: BrokenLink[] = [];
  for (const j of limited) {
    const s = statuses.get(j.abs);
    if (s == null || s === 0 || s >= 400) broken.push({ route: j.route, href: j.href, status: s });
  }
  return broken;
}

async function scan(previewUrl: string, pages: Pick<PageEntry, 'route' | 'label'>[]): Promise<Omit<LaunchCheckScan, 'ok'>> {
  const list = (pages || []).filter((p) => p && p.route);
  const fetched = await mapPool(list, 6, async (p): Promise<FetchedPage> => {
    try {
      const r = await get(joinUrl(previewUrl, p.route));
      if (r.status >= 400) return { route: p.route, label: p.label, ok: false, error: 'HTTP ' + r.status };
      return { route: p.route, label: p.label, ok: true, facts: extractPageFacts(r.body) };
    } catch (e) {
      return { route: p.route, label: p.label, ok: false, error: String((e && (e as Error).message) || e) };
    }
  });

  const okPages = fetched.filter((f) => f.ok).map((f) => ({ route: f.route, label: f.label, facts: f.facts }));
  const brokenLinks = await crawlLinks(previewUrl, fetched, 200);
  const results = runChecks(okPages, { brokenLinks });

  const counts = { pass: 0, warn: 0, fail: 0, na: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

  return {
    scannedAt: Date.now(),
    pageCount: fetched.length,
    unreachable: fetched.filter((f) => !f.ok).map((f) => ({ route: f.route, error: f.error })),
    counts,
    results,
  };
}

// ── Agent-facing report file ──────────────────────────────────────────────
// Every scan mirrors into .radial/launch-check.json so any agent — the
// embedded CLI or one in an outside terminal — can read what needs fixing
// (contract in AGENTS.md, projectMemory.STATE_FILES_NOTE). ok:false reports
// persist too: an agent that requested a scan needs to see why it failed.

function filePath(repoDir: string): string { return projectData.dataDir(repoDir, 'launch-check.json'); }

function persist(repoDir: string, report: LaunchCheckReport): void {
  fs.mkdirSync(projectData.dataDir(repoDir), { recursive: true });
  fs.writeFileSync(filePath(repoDir), JSON.stringify(report, null, 2) + '\n', 'utf8');
}

export { extractPageFacts, runChecks, CHECKS, scan, filePath, persist };
