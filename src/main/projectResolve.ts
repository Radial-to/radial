/**
 * "Which project did they mean?" — the one resolver behind `radial open`, the
 * MCP tools, and the Home search box (plans/radial-agent-native.md).
 *
 * Order: an empty query or `.` is the working directory; a path-shaped query
 * is a path (a file resolves to its folder; a missing one is not-found, never a
 * fuzzy guess); a GitHub link or bare owner/repo is a repo (an existing local
 * copy wins over a clone); anything else is a name matched against the
 * projects Radial knows — exact first, then fuzzy — and a close call is
 * returned as `ambiguous` with candidates rather than guessed.
 *
 * Pure: every source and helper is injected, so this runs in main, in the CLI
 * client with the app closed (recents from disk), and under node --test.
 */

import path from 'path';
import type * as Fuzzy from '../renderer/fuzzy';

/** A project Radial knows from one of the sources; only `path` is required. */
export interface ProjectSourceEntry {
  path: string;
  name?: string | null;
  pageTitle?: string | null;
  suspended?: boolean;
  lastOpened?: number | null;
  /** owner/repo, for a workspace clone. */
  repo?: string | null;
}

/** The projects to match names against: open tabs, recents, the projects folder, workspace clones. */
export interface ProjectSources {
  open?: ProjectSourceEntry[];
  recents?: ProjectSourceEntry[];
  available?: ProjectSourceEntry[];
  workspace?: ProjectSourceEntry[];
}

/** The matcher from src/renderer/fuzzy.ts; recencyBonus is optional. */
export interface ResolveFuzzy {
  score: typeof Fuzzy.score;
  recencyBonus?: typeof Fuzzy.recencyBonus;
}

/** resolve()'s injected sources and helpers. */
export interface ResolveOptions {
  /** Defaults to process.cwd(). */
  cwd?: string;
  sources?: ProjectSources | null;
  /** An absolute existing folder for a path (a file gives its folder), or null (cliOpen.normalizeOpenPath). */
  normalizeOpenPath: (p: string, cwd: string) => string | null;
  /** A GitHub URL from a link or owner/repo (github.urlFromText). */
  urlFromText?: ((text: string, allowBare: boolean) => string | null) | null;
  /** An existing clone of that repo, if any. */
  findLocalCopy?: ((url: string) => string | null) | null;
  fuzzy?: ResolveFuzzy | null;
}

/** One project, deduped by path, with every name it answers to. */
export interface ProjectCandidate {
  path: string;
  names: Set<string>;
  open: boolean;
  suspended: boolean;
  lastOpened: number;
  repo: string | null;
  name: string;
}

/** A project offered when a name could mean several. */
export interface ResolveChoice {
  path: string;
  name: string;
  open: boolean;
  suspended: boolean;
  lastOpened: number | null;
  reason: 'exact' | 'fuzzy';
}

/** A local folder; `repo` is set when a GitHub target matched a local copy. */
export interface ResolvedPath {
  ok: true;
  kind: 'path';
  dir: string;
  repo?: string;
  match?: 'repo' | 'exact' | 'fuzzy';
}

/** A GitHub repo with no local copy yet. */
export interface ResolvedClone {
  ok: true;
  kind: 'clone';
  url: string;
}

// The two failures go out on the wire unchanged (cliServer), so they keep the
// protocol's error reply shape: {ok:false, code, error}, plus candidates.
export interface ResolveNotFound {
  ok: false;
  code: 'not-found';
  error: string;
}

export interface ResolveAmbiguous {
  ok: false;
  code: 'ambiguous';
  error: string;
  candidates: ResolveChoice[];
}

export type ResolveResult = ResolvedPath | ResolvedClone | ResolveNotFound | ResolveAmbiguous;

interface ScoredCandidate {
  c: ProjectCandidate;
  raw: number;
  score: number;
}

const PATH_SHAPED = /^(\/|~|\.\/|\.\.\/|\.$|\.\.$)/;
const FUZZY_LEAD = 25;   // top must beat the runner-up by this much to be picked
const FUZZY_REAL = 100;  // and score like a real substring hit, not a subsequence
const MAX_CANDIDATES = 8;

/**
 * Resolve a query to a local folder, a repo to clone, or a not-found or
 * ambiguous answer. ResolveOptions documents each injected source and helper.
 */
function resolve(query: string | null | undefined, o: ResolveOptions): ResolveResult {
  const q = String(query || '').trim();
  const cwd = o.cwd || process.cwd();
  if (!q || q === '.') return pathResult(o.normalizeOpenPath('.', cwd), cwd);
  // A path: absolute, home-relative, explicitly relative, or a slash-y thing that exists.
  if (PATH_SHAPED.test(q)) return pathResult(o.normalizeOpenPath(expandHome(q), cwd), q);
  if (q.includes('/')) {
    const dir = o.normalizeOpenPath(q, cwd);
    if (dir) return { ok: true, kind: 'path', dir };
  }
  // A GitHub repo: link, git@ form, or bare owner/repo.
  const url = o.urlFromText ? o.urlFromText(q, true) : null;
  if (url) {
    // A clone Radial already knows (workspace `owner__repo` dirs carry their repo) wins before any lookup or clone.
    const ident = url.replace(/^https:\/\/github\.com\//i, '').toLowerCase();
    const known = candidates(o.sources).find((c) => c.repo && String(c.repo).toLowerCase() === ident);
    if (known) return { ok: true, kind: 'path', dir: known.path, repo: url, match: 'repo' };
    const local = o.findLocalCopy ? o.findLocalCopy(url) : null;
    if (local) return { ok: true, kind: 'path', dir: local, repo: url };
    return { ok: true, kind: 'clone', url };
  }
  if (q.includes('/')) return notFound(q, o);
  return byName(q, o);
}

function pathResult(dir: string | null, shown: string): ResolvedPath | ResolveNotFound {
  if (dir) return { ok: true, kind: 'path', dir };
  return { ok: false, code: 'not-found', error: `No folder at ${shown}.` };
}

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return path.join((require('os') as typeof import('os')).homedir(), p.slice(1));
  return p;
}

/** Every project Radial knows, deduped by path, each with the names it answers to. */
function candidates(sources: ProjectSources | null | undefined): ProjectCandidate[] {
  const s: ProjectSources = sources || {};
  const byPath = new Map<string, ProjectCandidate>();
  const add = (rec: ProjectSourceEntry, extra: { open?: boolean }) => {
    if (!rec || !rec.path) return;
    const p = rec.path;
    const c = byPath.get(p) || { path: p, names: new Set<string>(), open: false, suspended: false, lastOpened: 0, repo: null, name: rec.name || path.basename(p) };
    if (rec.name) c.names.add(rec.name);
    c.names.add(path.basename(p));
    if (rec.pageTitle) c.names.add(rec.pageTitle);
    if (rec.repo) { c.repo = rec.repo; c.names.add(rec.repo); }
    if (extra.open) { c.open = true; c.suspended = !!rec.suspended; }
    if (rec.lastOpened) c.lastOpened = Math.max(c.lastOpened, rec.lastOpened);
    byPath.set(p, c);
  };
  (s.open || []).forEach((r) => add(r, { open: true }));
  (s.recents || []).forEach((r) => add(r, {}));
  (s.available || []).forEach((r) => add(r, {}));
  (s.workspace || []).forEach((r) => add(r, {}));
  return [...byPath.values()];
}

function byName(q: string, o: ResolveOptions): ResolvedPath | ResolveNotFound | ResolveAmbiguous {
  const all = candidates(o.sources);
  const ql = q.toLowerCase();
  const exact = all.filter((c) => [...c.names].some((n) => String(n).toLowerCase() === ql));
  if (exact.length === 1) return { ok: true, kind: 'path', dir: exact[0].path, match: 'exact' };
  if (exact.length > 1) return ambiguous(q, exact.map((c) => ({ c, score: 0 })), 'exact');
  if (!o.fuzzy) return notFound(q, o);
  const scored = (all.map((c): ScoredCandidate | null => {
    const text = [...c.names].join(' ') + ' ' + c.path;
    const raw = o.fuzzy!.score(q, text);
    if (raw < 0) return null;
    return { c, raw, score: raw + (o.fuzzy!.recencyBonus ? o.fuzzy!.recencyBonus(c.lastOpened) : 0) + (c.open ? 20 : 0) };
  }).filter(Boolean) as ScoredCandidate[]).sort((a, b) => b.score - a.score);
  if (!scored.length) return notFound(q, o);
  if (scored.length === 1 && scored[0].raw >= FUZZY_REAL) return { ok: true, kind: 'path', dir: scored[0].c.path, match: 'fuzzy' };
  if (scored.length > 1 && scored[0].raw >= FUZZY_REAL && scored[0].score - scored[1].score >= FUZZY_LEAD) return { ok: true, kind: 'path', dir: scored[0].c.path, match: 'fuzzy' };
  return ambiguous(q, scored.slice(0, MAX_CANDIDATES), 'fuzzy');
}

function ambiguous(q: string, list: { c: ProjectCandidate }[], how: ResolveChoice['reason']): ResolveAmbiguous {
  return {
    ok: false, code: 'ambiguous',
    error: `"${q}" could be ${list.length} projects — pass a path, or pick one.`,
    candidates: list.map(({ c }) => ({ path: c.path, name: c.name, open: c.open, suspended: c.suspended, lastOpened: c.lastOpened || null, reason: how })),
  };
}

function notFound(q: string, o: ResolveOptions): ResolveNotFound {
  const n = candidates(o.sources).length;
  return { ok: false, code: 'not-found', error: `No project called "${q}"${n ? ` among the ${n} Radial knows` : ''}. Pass a path, a GitHub link or owner/repo; \`radial ls --all\` lists projects.` };
}

export { resolve, candidates, PATH_SHAPED };
