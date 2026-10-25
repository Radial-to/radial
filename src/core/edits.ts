/**
 * Edits written into a project's source: the window's text, structural, style,
 * meta and token edits and the CLI's `radial edit` and `meta set`, each landing
 * in the undo history; the head tags `meta set` knows; the page file a route
 * edits; an image swap; and the nudge that refreshes the preview after a write
 * from outside the window. Moved from main.ts (plans/headless-core.md, phase 1).
 */
import fs from 'fs';
import path from 'path';
import * as editEngine from '../main/editEngine';
import * as editInsert from '../main/editInsert';
import * as tokens from '../main/tokens';
import * as project from '../main/project';
import * as projectData from '../main/projectData';
import type { MetaTag } from '../main/cliSpec';
import type { HeadTagValue } from '../shared/radialApi';
import type * as RadialIpc from '../shared/radialApi';
import type { AnswerTo, ArgTo, LooseUnion } from './types';
import { recordEdit } from './history';
import { sessions } from './sessions';
import { browserPage } from './host';

// The head tags `radial meta set` edits, by the same locators the SEO panel uses.
export const META_FIELDS: Record<MetaTag, Pick<HeadTagValue, 'locator' | 'attr'>> = {
  title: { locator: '<title' },
  description: { locator: 'name="description"', attr: 'content' },
  'og:title': { locator: 'og:title', attr: 'content' }, 'og:description': { locator: 'og:description', attr: 'content' }, 'og:image': { locator: 'og:image', attr: 'content' }, 'og:image:alt': { locator: 'og:image:alt', attr: 'content' }, 'og:type': { locator: 'og:type', attr: 'content' },
  'twitter:card': { locator: 'twitter:card', attr: 'content' }, 'twitter:title': { locator: 'twitter:title', attr: 'content' }, 'twitter:image': { locator: 'twitter:image', attr: 'content' }, 'twitter:image:alt': { locator: 'twitter:image:alt', attr: 'content' },
  canonical: { locator: 'canonical', attr: 'href' }, robots: { locator: 'robots', attr: 'content' }, favicon: { locator: 'icon', attr: 'href' }, 'theme-color': { locator: 'theme-color', attr: 'content' },
};
// A route → the page's source file (what the Content panel passes as preferFile), for open projects.
export function pageFileFor(dir: string, route: string | null): string | null {
  const s = sessions.get(dir);
  if (!route || !s) return null;
  // '/about', '/about/', '/about.html' and '/about/index.html' are the same page (listPages
  // names static routes without the extension; the preview's URL keeps it).
  const norm = (r: string) => { let x = String(r || '/').split(/[?#]/)[0].toLowerCase(); if (!x.startsWith('/')) x = '/' + x; x = x.replace(/\/index\.html?$/, '/').replace(/\.html?$/, '').replace(/\/+$/, ''); return x || '/'; };
  try {
    const pages = project.listPages(dir, s.project);
    const hit = pages.find((pg) => norm(pg.route) === norm(route)) || pages.find((pg) => pg.file && pg.file.toLowerCase() === String(route).replace(/^\/+/, '').toLowerCase());
    return hit ? hit.file : null;
  } catch { return null; }
}
// After a write from outside the window: refresh the preview (best effort; the dev server's own reload covers framework sites). No window, no preview to refresh.
export function nudgePreview(dir: string): void { browserPage()?.reload(dir); }

// Copy a replacement image into the repo (mirroring the old asset's location)
// and rewrite the src that pointed at the old file. Shared by the panel's file
// picker and `radial edit image`.
export function swapImageFile(repoDir: string, oldSrc: string, chosen: string): RadialIpc.ImageSwapResult {
  const cleanSrc = (oldSrc || '').split('?')[0].split('#')[0];
  const ext = path.extname(chosen);
  const baseName = path.basename(cleanSrc, path.extname(cleanSrc)) || 'image';
  // The rewrite below changes only the src's file name, so the new file goes where the
  // old one is; only an image that isn't in the site (a CDN's) goes to an asset folder.
  const assetDirGuess = besideOldAsset(repoDir, cleanSrc) || pickAssetDir(repoDir, cleanSrc);
  fs.mkdirSync(assetDirGuess.absDir, { recursive: true });
  const destName = `${baseName}-${projectData.isLocal(repoDir) ? 'edited-' + Date.now() : 'radial'}${ext}`;
  const destAbs = path.join(assetDirGuess.absDir, destName);
  fs.copyFileSync(chosen, destAbs);

  const newSrc = path.posix.join(assetDirGuess.refPrefix, destName);

  // Rewrite the src reference in source via the same content-locating engine.
  const original = path.basename(cleanSrc); // match the filename token, robust across quoting
  const result: LooseUnion<import('../main/editEngine').TextEditOutcome> = editEngine.applyTextEdit(repoDir, {
    originalText: original,
    newText: destName,
    context: { tagName: 'img', attribute: 'src' },
  });
  recordEdit(repoDir, result);

  return { ok: result.ok, reason: result.ok ? undefined : result.reason, relFile: result.relFile, line: result.line, candidates: result.candidates, newSrc, copiedTo: path.relative(repoDir, destAbs) };
}

/** The folders a site's dev server serves its files from, the site's own first: where an image's URL path is found, and where a new one goes. */
const ASSET_ROOTS = ['public', 'static', 'assets', 'src/assets', 'images'];

/**
 * The folder of the file an image's src names, when it's in the site: the src
 * is the page's URL for it (an <img>'s currentSrc), root-relative, or relative
 * (read from the site's root). Its path is looked up in the site, then in the
 * folders dev servers serve; refPrefix is the src's own folder, so the new src
 * reads like the old one.
 */
function besideOldAsset(repoDir: string, src: string): { absDir: string; refPrefix: string } | null {
  let urlPath: string;
  try { urlPath = decodeURIComponent(new URL(src, 'http://localhost/').pathname); } catch { return null; }
  const rel = urlPath.replace(/^\/+/, '');
  if (!rel) return null;
  const root = path.resolve(repoDir);
  for (const dir of ['', ...ASSET_ROOTS]) {
    const abs = path.resolve(root, dir, rel);
    if (!abs.startsWith(root + path.sep)) continue; // a src that climbs out of the site
    try { if (!fs.statSync(abs).isFile()) continue; } catch { continue; }
    const refPrefix = /^[a-z][a-z\d+.-]*:/i.test(src) ? path.posix.dirname(urlPath) : path.posix.dirname(src); // a full URL reads as its path
    return { absDir: path.dirname(abs), refPrefix };
  }
  return null;
}

function pickAssetDir(repoDir: string, oldSrc: string): { absDir: string; refPrefix: string } {
  // Prefer the directory the old asset lived in; else common asset dirs.
  for (const root of ASSET_ROOTS) {
    if (fs.existsSync(path.join(repoDir, root))) {
      return { absDir: path.join(repoDir, root), refPrefix: oldSrc.startsWith('/') ? path.posix.dirname(oldSrc) : root };
    }
  }
  return { absDir: repoDir, refPrefix: '.' };
}

// ── The window's edits ──
// edit:applyText
export async function applyTextEdit(repoDir: ArgTo<'applyTextEdit', 0>, edit: ArgTo<'applyTextEdit', 1>): Promise<AnswerTo<'applyTextEdit'>> {
  const result: LooseUnion<import('../main/editEngine').TextEditOutcome> = editEngine.applyTextEdit(repoDir, edit);
  recordEdit(repoDir, result);
  // Don't ship the full file contents back to the renderer.
  const { prevContent, newContent, ...slim } = result;
  return slim;
}
// Structural fast path (the Add panel + layer moves): editInsert's scanner
// proves the edit, writes it, and lands in the same undo history; a bail
// ({ ok:false, reason }) is the renderer's cue to hand the SAME instruction
// to the agent. Never both.
// edit:insertElement
export async function insertElement(repoDir: ArgTo<'insertElement', 0>, spec: ArgTo<'insertElement', 1>): Promise<AnswerTo<'insertElement'>> {
  const result: LooseUnion<import('../main/editInsert').StructuralEditOutcome> = editInsert.applyInsert(repoDir, spec || {});
  recordEdit(repoDir, result);
  const { prevContent, newContent, ...slim } = result;
  return slim;
}
// edit:moveElement
export async function moveElement(repoDir: ArgTo<'moveElement', 0>, spec: ArgTo<'moveElement', 1>): Promise<AnswerTo<'moveElement'>> {
  const result: LooseUnion<import('../main/editInsert').StructuralEditOutcome> = editInsert.applyMove(repoDir, spec || {});
  recordEdit(repoDir, result);
  const { prevContent, newContent, ...slim } = result;
  return slim;
}
// edit:removeElement
export async function removeElement(repoDir: ArgTo<'removeElement', 0>, spec: ArgTo<'removeElement', 1>): Promise<AnswerTo<'removeElement'>> {
  const result: LooseUnion<import('../main/editInsert').StructuralEditOutcome> = editInsert.applyRemove(repoDir, spec || {});
  recordEdit(repoDir, result);
  const { prevContent, newContent, ...slim } = result;
  return slim;
}
// edit:wrapElement
export async function wrapElement(repoDir: ArgTo<'wrapElement', 0>, spec: ArgTo<'wrapElement', 1>): Promise<AnswerTo<'wrapElement'>> {
  const result: LooseUnion<import('../main/editInsert').StructuralEditOutcome> = editInsert.applyWrap(repoDir, spec || {});
  recordEdit(repoDir, result);
  const { prevContent, newContent, ...slim } = result;
  return slim;
}
// edit:unwrapElement
export async function unwrapElement(repoDir: ArgTo<'unwrapElement', 0>, spec: ArgTo<'unwrapElement', 1>): Promise<AnswerTo<'unwrapElement'>> {
  const result: LooseUnion<import('../main/editInsert').StructuralEditOutcome> = editInsert.applyUnwrap(repoDir, spec || {});
  recordEdit(repoDir, result);
  const { prevContent, newContent, ...slim } = result;
  return slim;
}
// The adjust steppers' direct-write fast path: deterministic style deltas
// (a Tailwind token swap, an inline style value, a plain CSS declaration)
// skip the agent entirely — located and rewritten like a text edit, with the
// same undo/auto-commit/history treatment. Ambiguous batches never get here;
// the renderer's planner (adjustDirect.js) already routed those to the agent.
// edit:applyStyle
export async function applyStyleEdit(repoDir: ArgTo<'applyStyleEdit', 0>, plans: ArgTo<'applyStyleEdit', 1>, context: ArgTo<'applyStyleEdit', 2>): Promise<AnswerTo<'applyStyleEdit'>> {
  const result = editEngine.applyStyleEdits(repoDir, plans || [], context || {});
  if (!result.ok) return result;
  for (const f of result.files) recordEdit(repoDir, f);
  return { ok: true, summary: result.summary, files: result.files.map(({ prevContent, newContent, ...slim }: import('../main/editEngine').WrittenFileEdit) => slim) };
}
// meta:addTag
export async function metaAddTag(repoDir: ArgTo<'metaAddTag', 0>, relFile: ArgTo<'metaAddTag', 1>, snippet: ArgTo<'metaAddTag', 2>): Promise<AnswerTo<'metaAddTag'>> {
  const result: LooseUnion<import('../main/editEngine').AddHeadTagOutcome> = editEngine.addHeadTag(repoDir, relFile, snippet);
  recordEdit(repoDir, result);
  const { prevContent, newContent, ...slim } = result;
  return slim;
}
// Locator-driven meta rewrite — the fallback when the rendered value doesn't
// appear literally in source (framework-resolved URLs, e.g. og:image).
// meta:setTagValue
export async function metaSetTagValue(repoDir: ArgTo<'metaSetTagValue', 0>, args: ArgTo<'metaSetTagValue', 1>): Promise<AnswerTo<'metaSetTagValue'>> {
  const result: LooseUnion<import('../main/editEngine').SetHeadTagOutcome> = editEngine.setHeadTagValue(repoDir, args || {});
  recordEdit(repoDir, result);
  const { prevContent, newContent, ...slim } = result;
  return slim;
}
// tokens:set
export async function tokensSet(repoDir: ArgTo<'tokensSet', 0>, { name, value, mode, file, selector }: Partial<NonNullable<ArgTo<'tokensSet', 1>>>): Promise<AnswerTo<'tokensSet'>> {
  const result: LooseUnion<import('../main/tokens').SetTokenResult> = tokens.setToken(repoDir, { name, value, mode: mode || null, file: file || null, selector: selector || null });
  recordEdit(repoDir, result);
  const { prevContent, newContent, ...slim } = result;
  if (slim.ok) nudgePreview(repoDir);
  return slim;
}
