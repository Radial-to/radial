// Site migration (plans/site-migration.md): one engine behind `radial migrate`,
// MCP and the Home wizard. Capture the live site, compare it with the local
// preview, and describe the job to the agent that rebuilds it.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as projectData from '../projectData';
import { capture, many } from './capture';
import { diffBitmaps } from './diff';
import type { CaptureOptions, Inventory } from './capture';
import type { Bitmap, BitmapDiff, DiffBand } from './diff';
import type { MigrateFramework } from '../../shared/radialApi';

/** What the intent record names as the destination (frameworkOf): a framework a migration scaffolds, or 'existing' for anything else. */
export type MigrationTarget = MigrateFramework | 'existing';
/** One width's screenshot: `height` is what was captured, `fullHeight` the page's, `clipped` when the page ran past maxHeight. */
export interface Shot { width: number; png: Buffer; height: number; fullHeight: number; clipped: boolean; error?: undefined }
export interface ShotError { width: number; error: string }
export type ShotResult = Shot | ShotError;
/**
 * Takes full-page screenshots of a URL at each width (shots.shoot, or a test's
 * stand-in). The shot types live here, with the engine that reads them, and not
 * in shots.ts, which loads Electron: the Electron-free core (src/core) reaches
 * this module, and so its type-check would reach Electron's.
 */
export type Shooter = (url: string, widths: number[]) => Promise<ShotResult[]>;
/** A reference screenshot of the live site under screens/, or why that width failed. */
export type ReferenceScreen =
  | { route: string; width: number; file: string; height: number; clipped: boolean; error?: undefined }
  | { route: string; width: number; error: string; file?: undefined };
/** inventory.json as captureSite leaves it: capture()'s record plus the provided files and reference screenshots. */
export interface CaptureInventory extends Inventory {
  provided: string[]; // paths relative to the capture folder (provided/…)
  screens: ReferenceScreen[];
}
/** latest.json in the project's migrate folder: where the newest capture is. */
interface LatestCapture { dir: string; capturedAt: string; source: string }
export interface CaptureSiteOptions extends Pick<CaptureOptions, 'get' | 'site' | 'only' | 'onProgress'> {
  shoot?: Shooter; // no reference screenshots without it
  files?: string[]; // files the person has from the site, copied into provided/
  widths?: number[];
}
export interface SiteCapture { dir: string; inventory: CaptureInventory }
export interface CompareSiteOptions {
  shoot: Shooter;
  decode: (png: Buffer) => Bitmap;
  encode: (image: BitmapDiff['image']) => Buffer;
  routes?: string[]; // the reference routes when empty
  widths?: number[];
  onProgress?: (line: string) => void;
}
/** One route at one width: how much changed, or why it could not be compared. */
export type CompareRow =
  | { route: string; width: number; error: string; changedPercent?: undefined; heights?: undefined; bands?: undefined; files?: undefined }
  | { route: string; width: number; error?: undefined; changedPercent: number; heights: BitmapDiff['heights']; bands: DiffBand[]; files: { live: string; local: string; diff: string } };
/** report.json in the comparison folder. */
export interface CompareReport { comparedAt: string; live: string; local: string; widths: number[]; rows: CompareRow[] }
export interface SiteComparison { dir: string; report: CompareReport }
/** What intentRecord writes into .context/migration.md. */
export interface IntentRecordInput {
  url: string;
  platform: string;
  framework: MigrationTarget;
  captureRef: string;
  inventory: Pick<Inventory, 'scope' | 'counts'>;
  files?: string[];
}
/** What kickoffPrompt tells the agent that rebuilds the site. */
export interface KickoffInput {
  url: string;
  platform: string;
  framework: MigrateFramework;
  captureReadme: string;
  playbook: string;
  provided: number; // how many files the person provided
  scope: string[] | null;
}

const WIDTHS = [390, 768, 1440];
/** Display names of the frameworks a migration scaffolds; 'existing' looks up undefined. */
const FRAMEWORKS: Readonly<Record<MigrateFramework, string> & Partial<Record<MigrationTarget, string>>> = { astro: 'Astro', next: 'Next.js' };
const MAX_TEMPLATES = 10;

const routeSlug = (route: string): string => (route.split('?')[0].replace(/^\/+|\/+$/g, '').replace(/[^\w.-]+/g, '-') || 'home')
  + (route.includes('?') ? '-' + crypto.createHash('sha1').update(route).digest('hex').slice(0, 6) : '');
const mb = (bytes: number): number => Math.max(1, Math.round(bytes / 1048576));

// The playbook ships inside the app bundle, which other processes cannot read
// (app.asar), so it is copied to a plain folder the CLIs read by path.
function installPlaybook(userData: string, version = ''): string {
  const src = path.join(__dirname, 'playbook'), dest = path.join(userData, 'skills', 'site-migration');
  const marker = path.join(dest, '.version');
  try { if (fs.readFileSync(marker, 'utf8') === version && version) return dest; } catch {}
  const copy = (from: string, to: string): void => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) copy(path.join(from, entry.name), path.join(to, entry.name));
      else fs.writeFileSync(path.join(to, entry.name), fs.readFileSync(path.join(from, entry.name)));
    }
  };
  copy(src, dest);
  fs.writeFileSync(marker, version);
  return dest;
}

const migrateDir = (repoDir: string): string => projectData.dataDir(repoDir, 'migrate');
function latestCapture(repoDir: string): string | null {
  try { const { dir } = JSON.parse(fs.readFileSync(path.join(migrateDir(repoDir), 'latest.json'), 'utf8')) as LatestCapture; if (fs.existsSync(path.join(dir, 'inventory.json'))) return dir; } catch {}
  return null;
}
function readInventory(dir: string): CaptureInventory { return JSON.parse(fs.readFileSync(path.join(dir, 'inventory.json'), 'utf8')) as CaptureInventory; }

// One reference route per template, home first, biggest collections next.
function referenceRoutes(inventory: Pick<Inventory, 'templates'>, limit = MAX_TEMPLATES): string[] {
  // The booleans subtract as 1 and 0 on purpose, so the home route sorts first.
  const t = [...inventory.templates].sort((a, b) => ((b.sample === '/') as unknown as number) - ((a.sample === '/') as unknown as number) || b.count - a.count);
  return t.slice(0, limit).map(x => x.sample).filter(Boolean);
}

// Capture into the project's Radial data folder (outside its source), then take
// the visual reference. Earlier captures stay: evidence is never overwritten.
async function captureSite(repoDir: string, url: string, { shoot, onProgress = () => {}, files = [], get, widths = WIDTHS, site, only }: CaptureSiteOptions = {}): Promise<SiteCapture> {
  const root = migrateDir(repoDir);
  let dir = path.join(root, 'capture');
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(root, 'capture-' + n);
  const inventory = await capture(url, dir, { onProgress, site, only, ...(get ? { get } : {}) });
  // Whatever the person has from the site (exports, logos, fonts, docs) rides along.
  const provided: string[] = [];
  for (const file of files) {
    let dest = path.join(dir, 'provided', path.basename(file));
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, 'provided', `${n}-${path.basename(file)}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(file, dest, { recursive: true });
    provided.push(path.relative(dir, dest));
  }
  const screens: ReferenceScreen[] = [];
  if (shoot) {
    const routes = referenceRoutes(inventory);
    for (const [i, route] of routes.entries()) {
      onProgress(`Reference screenshots: ${route} (${i + 1} of ${routes.length})…`);
      for (const shot of await shoot(inventory.source.origin + route, widths)) {
        // A failed width has no png. Its error is the thrown message, which can be empty (or missing, for a thrown non-Error).
        if (!('png' in shot)) { screens.push({ route, width: shot.width, error: shot.error || 'no screenshot' }); continue; }
        const file = path.join('screens', `${routeSlug(route)}@${shot.width}.png`);
        fs.mkdirSync(path.join(dir, 'screens'), { recursive: true });
        fs.writeFileSync(path.join(dir, file), shot.png);
        screens.push({ route, width: shot.width, file, height: shot.fullHeight, clipped: shot.clipped });
      }
    }
  }
  const full = { ...inventory, provided, screens };
  fs.writeFileSync(path.join(dir, 'inventory.json'), JSON.stringify(full, null, 2));
  fs.writeFileSync(path.join(dir, 'README.md'), captureReadme(full, { shot: !!shoot }));
  fs.writeFileSync(path.join(root, 'latest.json'), JSON.stringify({ dir, capturedAt: full.capturedAt, source: full.source.url }, null, 2));
  return { dir, inventory: full };
}

// shot: whether a browser took the reference screenshots; `radial serve` has none yet.
function captureReadme(inv: CaptureInventory, { shot = true }: { shot?: boolean } = {}): string {
  const lines = [
    `# Live-site capture: ${inv.source.url} (${inv.platform.name})`, '',
    `Captured ${inv.capturedAt} by Radial. This folder is evidence of the live site: read it, copy from it, never edit it. Build the new site in the project.`, '',
    ...(inv.scope ? [`Scope: only ${inv.scope.join(', ')}, as the person asked. The other ${many(inv.notCaptured.length, 'page')} in the sitemap (inventory.json → notCaptured) ${inv.notCaptured.length === 1 ? 'was' : 'were'} not captured; keep links to them on their original paths.`, ''] : []),
    `- Pages: ${inv.counts.pages} saved as served under pages/ (inventory.json → routes has status, title, description, canonical, headings, links, scripts and forms for every URL, including ${inv.counts.redirects} redirects and ${inv.counts.errors} errors).`,
    `- Templates: ${inv.templates.length}. ${inv.collections.length ? 'Likely CMS collections: ' + inv.collections.map(c => `${c.template} (${c.items} items, e.g. ${c.sample})`).join('; ') + '.' : 'No repeated templates found.'}`,
    `- Assets: ${inv.counts.assets} files (${mb(inv.counts.assetBytes)} MB) under assets/<host>/; inventory.json → assets maps each original URL to its file, kind and sha256.${inv.counts.skipped ? ` ${inv.counts.skipped} were not downloaded (inventory.json → skipped says why).` : ''}`,
    `- Integrations to keep (recorded, not downloaded): ${inv.integrations.length ? inv.integrations.map(i => i.host).join(', ') : 'none found'}.`,
    `- Forms: ${inv.forms.length ? inv.forms.map(f => `${f.name || 'form'} on ${f.page} (${f.method.toUpperCase()} ${f.action || 'same page'})`).join('; ') + '. The platform\'s form handling does not come with the site; plan a replacement with the person.' : 'none found.'}`,
    `- Sitemap: ${inv.sitemapOnly.length ? inv.sitemapOnly.length + ' sitemap URLs did not answer as pages; ' : ''}${inv.notInSitemap.length ? inv.notInSitemap.length + ' linked pages are missing from the sitemap.' : 'pages and sitemap agree.'}`,
    `- Files the person provided: ${inv.provided.length ? inv.provided.join(', ') + '. CMS exports become the collections\' source of truth; logos, fonts and brand files are originals to prefer over captured copies; documents are context.' : 'none. Collections can be rebuilt from the captured pages; ask whether CMS exports are available for drafts, hidden fields and references.'}`,
    shot
      ? `- Reference screenshots: ${inv.screens.filter(s => s.file).length} under screens/ (<route>@<width>.png at ${WIDTHS.join(', ')}). \`radial migrate compare\` shoots the live site and the local preview the same way.`
      : '- Reference screenshots: none. This capture ran without a browser (radial serve), and so `radial migrate compare` can\'t run either. `radial browser install` adds one; capture again after it for the screenshots. Until then, compare the rebuild with the saved pages, or open both sites in a browser you have.',
    '', 'What a capture does not hold: anything behind a login, the platform\'s server features (forms, search, memberships, commerce), redirect rules that only exist in the platform\'s settings, and traffic history.',
  ];
  return lines.join('\n') + '\n';
}

// Live site vs local preview, same widths, same renderer; diffs say where to look.
// Callers must pass shoot/decode/encode (this overload); the implementation keeps
// its original `= {}` default, which no typed caller can reach.
async function compareSite(repoDir: string, previewUrl: string, options: CompareSiteOptions): Promise<SiteComparison>;
async function compareSite(repoDir: string, previewUrl: string, { shoot, decode, encode, routes, widths = WIDTHS, onProgress = () => {} }: CompareSiteOptions = {} as CompareSiteOptions): Promise<SiteComparison> {
  const dir = latestCapture(repoDir);
  if (!dir) throw new Error('No capture yet. Run `radial migrate capture <url>` in this project first.');
  const inventory = readInventory(dir);
  routes = routes && routes.length ? routes : referenceRoutes(inventory, 8);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(migrateDir(repoDir), 'compare', stamp);
  fs.mkdirSync(out, { recursive: true });
  const rows: CompareRow[] = [];
  const base = previewUrl.replace(/\/+$/, '');
  for (const [i, route] of routes.entries()) {
    onProgress(`Comparing ${route} (${i + 1} of ${routes.length})…`);
    const [live, local] = await Promise.all([shoot(inventory.source.origin + route, widths), shoot(base + route, widths)]);
    for (const width of widths) {
      const a = live.find(s => s.width === width), b = local.find(s => s.width === width), name = `${routeSlug(route)}@${width}`;
      // A failed width has no png (its error message can be empty, as in captureSite).
      if (!a || !b || !('png' in a) || !('png' in b)) { rows.push({ route, width, error: (a && a.error) || (b && b.error) || 'no screenshot' }); continue; }
      const result = diffBitmaps(decode(a.png), decode(b.png));
      fs.writeFileSync(path.join(out, name + '.live.png'), a.png);
      fs.writeFileSync(path.join(out, name + '.local.png'), b.png);
      fs.writeFileSync(path.join(out, name + '.diff.png'), encode(result.image));
      rows.push({ route, width, changedPercent: Math.round(result.ratio * 10000) / 100, heights: result.heights, bands: result.bands,
        files: { live: path.join(out, name + '.live.png'), local: path.join(out, name + '.local.png'), diff: path.join(out, name + '.diff.png') } });
    }
  }
  const report = { comparedAt: new Date().toISOString(), live: inventory.source.origin, local: base, widths, rows };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(out, 'report.md'), [
    `# Comparison ${report.comparedAt}`, '', `Live ${report.live} vs local ${report.local}. Changed pixels are magenta in each .diff.png; inspect them, a small missing button matters more than a large animation difference.`, '',
    '| Route | Width | Changed | Height live → local | Where |', '| --- | --- | --- | --- | --- |',
    ...rows.map(r => r.error ? `| ${r.route} | ${r.width} | error: ${r.error} | | |`
      : `| ${r.route} | ${r.width} | ${r.changedPercent}% | ${r.heights!.live} → ${r.heights!.local}${r.heights!.delta ? ` (${r.heights!.delta > 0 ? '+' : ''}${r.heights!.delta})` : ''} | ${r.bands!.slice(0, 4).map(bd => `${bd.top}–${bd.bottom}px`).join(', ') || '—'} |`),
  ].join('\n') + '\n');
  return { dir: out, report };
}

// How agents should see the capture's location: repo-relative when it sits in
// the project (.radial/…), absolute when the project keeps Radial data elsewhere.
// Both sides are resolved first (macOS /var is /private/var).
function captureRef(repoDir: string, abs: string): string {
  const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };
  const rel = path.relative(real(repoDir), real(abs));
  return rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel.split(path.sep).join('/');
}

// What an existing project is built with, for its intent record.
function frameworkOf(repoDir: string): MigrationTarget {
  try { const pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')); const deps = { ...pkg.dependencies, ...pkg.devDependencies }; return deps.astro ? 'astro' : deps.next ? 'next' : 'existing'; }
  catch { return 'existing'; }
}
const frameworkLabel = (framework: MigrationTarget): string => FRAMEWORKS[framework] || "this project's framework";

// The committed intent record every agent reads (.context/migration.md).
function intentRecord({ url, platform, framework, captureRef, inventory, files = [] }: IntentRecordInput): string {
  const scope = inventory.scope;
  return [
    `# Migration: ${new URL(url).hostname} → ${frameworkLabel(framework)}`, '',
    `Started ${new Date().toISOString().slice(0, 10)} in Radial.`, '',
    `- Source: ${url} (${platform}). Capture: ${captureRef} (${many(inventory.counts.pages, 'page')}, ${many(inventory.counts.assets, 'asset')}).`,
    `- Destination: ${frameworkLabel(framework)}, this repository.`,
    ...(scope ? [`- Scope: ${scope.join(', ')} only, for now (the person's choice). The rest of the site comes later with \`radial migrate capture\`.`] : []),
    '- Fidelity: one to one with the live site. Record every intentional difference below.',
    '- Content editing: undecided. Ask who edits after the move: in-repo content files edited in Radial, or a hosted CMS.',
    `- Files provided: ${files.length ? files.map(f => path.basename(f)).join(', ') + ' (in the capture\'s provided/ folder)' : 'none yet'}.`,
    '- Hosting and DNS: not started. Launch and DNS cutover are separate, explicit steps; keep the old site running until after cutover.',
    '', '## Status', '',
    '- [ ] Implementation tested: build passes; every captured route, its content and metadata match',
    '- [ ] Visual parity checked: `radial migrate compare` for each template at 390, 768 and 1440',
    '- [ ] Staging verified: shareable URL checked while logged out',
    '- [ ] Production verified: domain, HTTPS, redirects and analytics after cutover',
    '', '## Decisions and intentional differences', '', '(none yet)', '',
  ].join('\n');
}

function kickoffPrompt({ url, platform, framework, captureReadme, playbook, provided, scope }: KickoffInput): string {
  return `Migrate ${url} (${platform}) into this ${FRAMEWORKS[framework]} project, one to one: same design, content, URLs and behavior. `
    + (scope ? `Scope: only ${scope.join(', ')} for now; build just ${scope.length > 1 ? 'these pages' : 'this page'} and leave links to other pages on their original paths. ` : '')
    + `First read Radial's migration playbook: ${playbook}. The live-site capture (raw HTML for every route, downloaded assets, inventory.json, reference screenshots) is described in ${captureReadme}; decisions and status live in .context/migration.md. `
    + (provided ? 'The person also provided files from the site (CMS exports, brand assets or documents) in the capture\'s provided/ folder; use them. ' : 'No CMS exports were provided: rebuild collections from the captured pages and ask whether exports are available. ')
    + 'Before modeling content, ask me who will edit it after the move. Check your work with `radial migrate compare`, and keep .context/migration.md current.';
}

export { WIDTHS, FRAMEWORKS, frameworkOf, captureRef, installPlaybook, captureSite, compareSite, latestCapture, readInventory, referenceRoutes, intentRecord, kickoffPrompt, routeSlug, migrateDir };
