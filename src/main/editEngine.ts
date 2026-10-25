/**
 * Radial content-locating edit engine.
 *
 * The framework-agnostic core: given a piece of text the user changed on the
 * rendered page (plus DOM context to disambiguate), find where that text lives
 * in the repo's source and rewrite it in place. Works the same across .html,
 * .jsx/.tsx, .astro, .vue, .svelte, .md/.mdx, and in-repo JSON/data files
 * because marketing copy almost always lives literally in the repo.
 *
 * No framework parsing here. Per-framework precision adapters can plug in later
 * behind the same applyTextEdit() contract.
 */

import fs from 'fs';
import path from 'path';
import type {
  ElementContext, MatchStrategy, TextEdit, TextEditFailure, TextEditResult, StyleEditPlan, StyleEditResult,
  HeadTagResult, HeadTagValue, SourceLocation, StyleRef,
} from '../shared/radialApi';
import { contextAt, dialectOf, escapeTyped } from './sourceContext';
import type { FileEdit } from './editHistory';
import type { HtmlNode } from './htmlScan';

/** One place a string sits in a source file (findOccurrences), with the source around it for scoring. */
export interface Occurrence {
  /** Absolute path. */
  file: string;
  /** Relative to the repo. */
  relFile: string;
  /** The matched source span, [start, end). */
  start: number;
  end: number;
  line: number;
  /** Found verbatim (not through the entity/punctuation/whitespace folding). */
  exact: boolean;
  /** The source text of the span. */
  matched: string;
  /** Up to 80 characters either side of the span. */
  context: string;
  /** The context before the span: the opening tag a class or id is matched against. */
  before: string;
}

export interface FindOccurrencesOptions {
  /** Fall back to the folded (entities, punctuation, whitespace) match when a file has no exact one. Default true. */
  flexible?: boolean;
}

/** selectOccurrence's pick: one occurrence, or none with why (nothing found, or twins it can't tell apart). */
export type OccurrenceChoice =
  | { chosen: Occurrence; candidates: Occurrence[]; strategy: 'unique' | 'context-score' | 'occurrence-index' }
  | { chosen: null; candidates: Occurrence[]; strategy: 'none' | 'ambiguous' };

export interface TextEditOptions {
  /** Locate and report, but write nothing (the result then carries no contents). */
  dryRun?: boolean;
}

/**
 * A FileEdit that was written, so it always carries both contents (what
 * recordEdit stores for undo, and what main strips before replying to the
 * window). Belongs beside FileEdit in editHistory.ts; it lives here until that
 * file is next typed, and tokens.ts's SetTokenDone can use it too.
 */
export type WrittenFileEdit = FileEdit & { prevContent: string; newContent: string };

/** A text edit made: the window's TextEditResult success plus the two contents for undo (both missing on a dry run). */
export type TextEditDone = Extract<TextEditResult, { ok: true }> & FileEdit;
export type TextEditOutcome = TextEditDone | TextEditFailure;

/** Why applyStyleEdits wrote nothing (the window sees these as StyleEditResult's reason string). */
export type StyleEditFailureReason =
  | 'no-plans' | 'inline-set-needs-pin' | 'pinned-token-missing' | 'nothing-staged'
  | 'no-class-string' | 'class-ambiguous' | 'class-not-found' | `token-missing:${string}`
  | 'no-style-attr' | 'inline-ambiguous' | 'inline-not-found' | `inline-decl-missing:${string}`
  | 'css-no-href' | 'stylesheet-not-found' | 'css-set-rule-not-found'
  | 'hover-no-href' | 'hover-stylesheet-not-found' | 'hover-base-rule-not-found'
  | 'css-set-no-href' | 'css-set-stylesheet-not-found'
  | 'css-set-media-no-href' | 'css-set-media-stylesheet-not-found';

/** A style batch written: the window's StyleEditResult success, each file with both contents (undo, and the rollback of a failed batch). */
export type StyleEditDone = Omit<Extract<StyleEditResult, { ok: true }>, 'files'> & { files: WrittenFileEdit[] };
/** applyStyleEdits: every plan written (all or nothing), or why none was. */
export type StyleEditOutcome =
  | StyleEditDone
  | { ok: false; reason: StyleEditFailureReason }
  | { ok: false; reason: 'write-failed'; message: string };

/** A head tag written: the window's HeadTagResult success plus the two contents for undo. */
export type HeadTagDone = Extract<HeadTagResult, { ok: true }> & WrittenFileEdit;
/** addHeadTag: the HeadTagResult cases it can produce (main-side: the success still holds both contents). */
export type AddHeadTagOutcome =
  | HeadTagDone
  | { ok: false; reason: 'invalid' | 'no-head' }
  | { ok: false; reason: 'read-failed' | 'write-failed'; message: string };
/** setHeadTagValue: the HeadTagResult cases it can produce (main-side: the success still holds both contents). */
export type SetHeadTagOutcome =
  | HeadTagDone
  | { ok: false; reason: 'invalid' | 'not-found' }
  | { ok: false; reason: 'write-failed'; message: string }
  | { ok: false; reason: 'ambiguous'; candidates: { relFile: string; line: number }[] };

/** locateElement: the window's SourceLocation, less the 'error' case main.ts adds when it throws. */
export type LocateOutcome = Exclude<SourceLocation, { reason: 'error' }>;

// The clicked element's own source node (editInsert.resolveTarget), for edits inside its range.
interface PinnedNode {
  file: string;
  relFile: string;
  node: HtmlNode;
}

// Where locateStaged found a needle, or why it couldn't pick one.
type StagedLocation =
  | { ok: true; chosen: Occurrence }
  | { ok: false; reason: 'ambiguous' | 'not-found'; strategy: 'none' | 'ambiguous' };

// A CSS declaration to set inside a selector's block.
interface CssSetSpec {
  selectorText: string;
  prop: string;
  value: string;
}

// A head tag value setHeadTagValue can rewrite: an attribute's quoted value, a
// tag's inner text, or the string literal behind a `{ident}` expression.
type HeadTagMatch =
  | { file: string; start: number; end: number; content: string; kind: 'attr' | 'text' }
  | { file: string; start: number; end: number; content: string; kind: 'js'; quote: string };

const SOURCE_EXTENSIONS = new Set([
  '.html', '.htm',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.astro', '.vue', '.svelte',
  '.md', '.mdx',
  '.json',
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.astro',
  'dist', 'build', 'out', '.cache', '.vercel', '.turbo', 'coverage',
  '.vscode', '.idea',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip anything huge — copy lives in small files

/** Recursively collect candidate source files under repoDir. */
function listSourceFiles(repoDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          results.push(full);
        }
      }
    }
  };
  walk(repoDir);
  return results;
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rendered DOM text differs from source in more ways than whitespace: the DOM
 * gives decoded entities (`&rsquo;` → `'`), unescaped quotes (`Don\'t` →
 * `Don't`), and typographically transformed punctuation (smart quotes, em
 * dashes, `...` → `…`). Any of these made the old whitespace-flexible regex
 * miss ("can't find x"). Instead: normalize BOTH sides into a canonical form —
 * entities decoded, escapes unescaped, punctuation folded, whitespace
 * collapsed — and track each normalized char's original span so a match maps
 * back to exact source offsets for replacement.
 */
const ENTITIES: Partial<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', copy: '©',
  reg: '®', trade: '™', middot: '·', bull: '•',
  deg: '°', times: '×',
};

function decodeEntityAt(content: string, i: number): { ch: string; len: number } | null {
  if (content[i] !== '&') return null;
  const m = /^&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+[0-9]*));/.exec(content.slice(i, i + 12));
  if (!m) return null;
  let ch: string | null = null;
  try {
    // Own keys only: `&valueOf;` or `&toString;` in a file is text, not an
    // entity (an inherited key would yield Object.prototype's function). The
    // table's own values are all strings (the `!`).
    if (m[1]) ch = String.fromCodePoint(parseInt(m[1], 10));
    else if (m[2]) ch = String.fromCodePoint(parseInt(m[2], 16));
    else if (m[3] && Object.hasOwn(ENTITIES, m[3])) ch = ENTITIES[m[3]]!;
  } catch { ch = null; }
  return ch == null ? null : { ch, len: m[0].length };
}

// Typographic folding — applied to BOTH sides so either direction matches
// (source `...` vs DOM `…`, source `'` vs smart-quoted DOM `’`, etc.).
function foldChar(ch: string): string {
  switch (ch) {
    case '’': case '‘': case 'ʼ': return "'";
    case '“': case '”': return '"';
    case '–': case '—': return '-';
    case '…': return '...';
    case ' ': return ' ';
    default: return ch;
  }
}

/** The needle (DOM text) in canonical form. */
function foldNeedle(text: string): string {
  let out = '';
  for (const ch of String(text || '')) out += foldChar(ch);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Source content in canonical form, plus per-char original spans:
 * match [a, b) in `text` ⇒ source span [starts[a], ends[b - 1]).
 */
function normalizeSource(content: string): { text: string; starts: number[]; ends: number[] } {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  let lastWasSpace = true; // leading whitespace collapses away
  const push = (s: string, a: number, b: number) => { for (const c of s) { text += c; starts.push(a); ends.push(b); } };
  while (i < content.length) {
    let ch, adv;
    const ent = decodeEntityAt(content, i);
    if (ent) { ch = ent.ch; adv = ent.len; }
    else if (content[i] === '\\' && (content[i + 1] === "'" || content[i + 1] === '"')) { ch = content[i + 1]; adv = 2; }
    else { ch = content[i]; adv = 1; }
    const folded = foldChar(ch);
    if (folded === ' ' || /^\s$/.test(folded)) {
      if (!lastWasSpace) push(' ', i, i + adv);
      lastWasSpace = true;
    } else {
      push(folded, i, i + adv);
      lastWasSpace = false;
    }
    i += adv;
  }
  return { text, starts, ends };
}

/**
 * Is the match at `index` inside a comment? Non-rendered text (HTML comments,
 * JSX/JS block comments) shows up in source search but never in the DOM, so it
 * misaligns occurrence indexing and must be skipped.
 */
function isInsideComment(content: string, index: number): boolean {
  // HTML comment: <!-- ... -->
  const htmlOpen = content.lastIndexOf('<!--', index);
  if (htmlOpen !== -1) {
    const htmlClose = content.indexOf('-->', htmlOpen);
    if (htmlClose === -1 || htmlClose >= index) return true;
  }
  // JSX expression comment {/* ... */} and JS block comment /* ... */
  const blockOpen = content.lastIndexOf('/*', index);
  if (blockOpen !== -1) {
    const blockClose = content.indexOf('*/', blockOpen);
    if (blockClose === -1 || blockClose >= index) return true;
  }
  return false;
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Find every occurrence of `text` across the repo's source files.
 * Tries exact match first, then a whitespace-flexible match as a fallback.
 *
 * @returns every match, with its source span and the source around it
 */
function findOccurrences(repoDir: string, text: string, { flexible = true }: FindOccurrencesOptions = {}): Occurrence[] {
  const needle = (text || '').trim();
  if (!needle) return [];

  const files = listSourceFiles(repoDir);
  const occurrences: Occurrence[] = [];

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;

    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    // Pass 1: exact substring matches.
    let from = 0;
    let idx;
    let foundExact = false;
    while ((idx = content.indexOf(needle, from)) !== -1) {
      from = idx + needle.length;
      if (isInsideComment(content, idx)) continue;
      foundExact = true;
      occurrences.push(makeOccurrence(repoDir, file, content, idx, idx + needle.length, true));
    }

    // Pass 2: canonical-form matches (entities decoded, escapes unescaped,
    // punctuation folded, whitespace collapsed) — only if the exact form
    // wasn't found in this file (avoids double-counting the same spot).
    if (!foundExact && flexible) {
      const folded = foldNeedle(needle);
      if (folded) {
        const norm = normalizeSource(content);
        let nfrom = 0;
        let nidx;
        while ((nidx = norm.text.indexOf(folded, nfrom)) !== -1) {
          nfrom = nidx + folded.length;
          const start = norm.starts[nidx];
          const end = norm.ends[nidx + folded.length - 1];
          if (start == null || end == null) continue;
          if (!isInsideComment(content, start)) {
            occurrences.push(makeOccurrence(repoDir, file, content, start, end, false));
          }
        }
      }
    }
  }

  return occurrences;
}

function makeOccurrence(repoDir: string, file: string, content: string, start: number, end: number, exact: boolean): Occurrence {
  const ctxRadius = 80;
  const ctxStart = Math.max(0, start - ctxRadius);
  const ctxEnd = Math.min(content.length, end + ctxRadius);
  return {
    file,
    relFile: path.relative(repoDir, file),
    start,
    end,
    line: lineNumberAt(content, start),
    exact,
    matched: content.slice(start, end),
    context: content.slice(ctxStart, ctxEnd),
    // The opening tag (and its attributes) precedes the inner text, so we match
    // class/id against the source immediately *before* the occurrence — this
    // keeps a neighbor's attributes from leaking into the score.
    before: content.slice(ctxStart, start),
  };
}

/**
 * Score how well a source occurrence matches the DOM context captured at click
 * time. Higher is better. Used to disambiguate when the same string appears in
 * multiple places. Framework-agnostic: we just look for context tokens (class
 * names, attribute values, nearby copy) near the occurrence in source.
 */
function scoreOccurrence(occ: Occurrence, domContext: ElementContext = {}): number {
  let score = 0;
  if (occ.exact) score += 2; // prefer exact over whitespace-flexible

  const hay = occ.context.toLowerCase();
  const pre = (occ.before || occ.context).toLowerCase();

  // Class names from the clicked element are strong locators in source. Match
  // against the preceding source (the opening tag) so a neighbor's class doesn't
  // leak into this occurrence's score.
  for (const cls of domContext.classList || []) {
    if (cls && pre.includes(String(cls).toLowerCase())) score += 5;
  }

  // id is an even stronger locator.
  if (domContext.id && pre.includes(String(domContext.id).toLowerCase())) score += 8;

  // The element's tag appearing just before the text (e.g. <h1>) is a mild signal.
  if (domContext.tagName) {
    const tag = String(domContext.tagName).toLowerCase();
    if (pre.includes('<' + tag)) score += 2;
  }

  // Nearby rendered text (preceding/following sibling copy) appearing in source.
  for (const frag of domContext.nearbyText || []) {
    const f = String(frag).trim().toLowerCase();
    if (f.length >= 4 && hay.includes(f)) score += 3;
  }

  // Bias toward the source file backing the page the user is currently viewing.
  if (domContext.preferFile && occ.relFile === domContext.preferFile) score += 6;

  // For link edits: strongly prefer occurrences that sit in an href/src/to/url
  // attribute, not an incidental string match elsewhere.
  if (domContext.attribute) {
    if (new RegExp(`${domContext.attribute}\\s*=\\s*['"\`{]?\\s*$`).test(pre)) score += 6;
  }

  return score;
}

/**
 * Pick the best occurrence to edit.
 * @returns the chosen occurrence (null when none or ambiguous), the candidates, and the strategy that decided
 */
function selectOccurrence(occurrences: Occurrence[], domContext: ElementContext = {}): OccurrenceChoice {
  if (occurrences.length === 0) return { chosen: null, candidates: [], strategy: 'none' };
  // The page being edited is a HARD scope, not a +6 hint: when the current page
  // holds the needle, a match on another page is never the pointed-at element
  // (the soft bias lost to incidental class hits and edited another route).
  if (domContext.preferFile && occurrences.length > 1) {
    const inPage = occurrences.filter((o) => o.relFile === domContext.preferFile);
    if (inPage.length) occurrences = inPage;
  }
  if (occurrences.length === 1) {
    return { chosen: occurrences[0], candidates: occurrences, strategy: 'unique' };
  }
  // A caller that captured the element's DOM path but couldn't pin it has
  // twins the resolver can't tell apart — a context score would only guess.
  if (Array.isArray(domContext.path) && domContext.path.length) {
    return { chosen: null, candidates: occurrences, strategy: 'ambiguous' };
  }

  const scored = occurrences
    .map((occ) => ({ occ, score: scoreOccurrence(occ, domContext) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const runnerUp = scored[1];

  // Clear winner by context.
  if (top.score > 0 && top.score > runnerUp.score) {
    return { chosen: top.occ, candidates: occurrences, strategy: 'context-score' };
  }

  // Fall back to the rendered occurrence index if the DOM gave us one.
  const oi = domContext.occurrenceIndex;
  if (Number.isInteger(oi) && oi! >= 0 && oi! < occurrences.length) {
    return { chosen: occurrences[oi!], candidates: occurrences, strategy: 'occurrence-index' };
  }

  // Ambiguous — caller should ask the user to disambiguate.
  return { chosen: null, candidates: occurrences, strategy: 'ambiguous' };
}

// ── Structural pin ──────────────────────────────────────────────────────────
// Every canvas selection carries the element's DOM ancestor `path`. When it's
// there, resolve THAT element to its exact source node (editInsert's resolver)
// and edit inside its range. Text search + scoring stays as the fallback for
// callers without a path — it cannot tell identical twins apart (the same class
// string on two elements, the same copy on two pages) and once picked the wrong
// one silently. The resolver can, and refuses when it truly can't.
function pinNode(repoDir: string, ctx: ElementContext): PinnedNode | null {
  if (!ctx || !Array.isArray(ctx.path) || !ctx.path.length) return null;
  try {
    const editInsert = require('./editInsert') as typeof import('./editInsert'); // lazy: editInsert requires this module
    const r = editInsert.resolveTarget(repoDir, ctx, ctx.preferFile);
    if (!r || r.fail || !r.node) return null;
    return { file: path.join(repoDir, r.entry.relFile), relFile: r.entry.relFile, node: r.node };
  } catch { return null; }
}
// The value spans of every class / className attribute in an open tag — a
// quoted string, or a `{…}` expression (cn("a b", cond && "c"), a template).
function classAttrSpans(open: string): [number, number][] {
  const spans: [number, number][] = [];
  const re = /\bclass(?:Name)?\s*=\s*/g;
  let m;
  while ((m = re.exec(open))) {
    const at = m.index + m[0].length;
    const q = open[at];
    if (q === '"' || q === "'" || q === '`') { const e = open.indexOf(q, at + 1); if (e > at) spans.push([at, e + 1]); }
    else if (q === '{') { let d = 0, k = at; for (; k < open.length; k++) { if (open[k] === '{') d++; else if (open[k] === '}' && --d === 0) { k++; break; } } spans.push([at, k]); }
  }
  return spans;
}
// Swap one class token inside the pinned open tag (within its class attribute
// values only — including cn()/clsx fragments and template literals). Returns
// the new open tag, or null if the token isn't literally there (dynamic class).
function swapClassToken(open: string, oldToken: string, newToken: string): string | null {
  const re = new RegExp(`(["'\`\\s])${escapeRegExp(oldToken)}(?=["'\`\\s])`);
  for (const [a, b] of classAttrSpans(open)) {
    const val = open.slice(a, b);
    if (re.test(val)) return open.slice(0, a) + val.replace(re, `$1${newToken}`) + open.slice(b);
  }
  return null;
}
// Append a class token to the first string literal of the first class attribute.
function addClassToken(open: string, newToken: string): string | null {
  const spans = classAttrSpans(open);
  if (!spans.length) return null;
  const [a, b] = spans[0];
  const val = open.slice(a, b);
  const m = /(["'`])([^"'`]*)\1/.exec(val); // first string literal (the whole value, or cn()'s first arg)
  if (!m) return null;
  const inner = m[2].trim() ? `${m[2]} ${newToken}` : newToken;
  return open.slice(0, a) + val.slice(0, m.index) + m[1] + inner + m[1] + val.slice(m.index + m[0].length) + open.slice(b);
}
// Rewrite a declaration's value inside the pinned open tag's style="…".
function swapInlineDecl(open: string, prop: string, to: string): string | null {
  const m = /\bstyle\s*=\s*(["'])([^"']*)\1/.exec(open);
  if (!m) return null;
  const re = new RegExp(`(${escapeRegExp(prop)}\\s*:\\s*)[^;'"}]+`, 'i');
  if (!re.test(m[2])) return null;
  const val = m[2].replace(re, `$1${to}`);
  return open.slice(0, m.index) + `style=${m[1]}${val}${m[1]}` + open.slice(m.index + m[0].length);
}

// Set (insert or replace) a declaration in the pinned open tag's style
// attribute, creating the attribute when absent. HTML-ish files carry
// style="…"; JSX carries a style={{ camelCase: 'value' }} object. This is the
// Design panel's terminal write: when no authored rule can take a value, the
// element itself can — always.
function setInlineDecl(open: string, prop: string, value: string, jsx: boolean): string | null {
  const camel = prop.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
  const str = /\bstyle\s*=\s*(["'])([^"']*)\1/.exec(open);
  if (str) {
    const re = new RegExp(`(^|;)\\s*${escapeRegExp(prop)}\\s*:\\s*[^;]*`, 'i');
    let v = str[2];
    if (re.test(v)) v = v.replace(re, (m: string, lead: string) => `${lead ? lead + ' ' : ''}${prop}: ${value}`);
    else v = v.trim() ? `${v.replace(/;?\s*$/, '')}; ${prop}: ${value}` : `${prop}: ${value}`;
    return open.slice(0, str.index) + `style=${str[1]}${v}${str[1]}` + open.slice(str.index + str[0].length);
  }
  const obj = /\bstyle\s*=\s*\{\{/.exec(open);
  if (obj) {
    let i = obj.index + obj[0].length, depth = 2; const start = i;
    while (i < open.length && depth > 0) { if (open[i] === '{') depth++; else if (open[i] === '}') depth--; i++; }
    if (depth !== 0) return null;
    const inner = open.slice(start, i - 2);
    const re = new RegExp(`(^|[,{\\s])(${escapeRegExp(camel)}|['"]${escapeRegExp(prop)}['"])\\s*:\\s*[^,}]+`);
    const body = re.test(inner) ? inner.replace(re, `$1${camel}: '${value}'`) : (inner.trim() ? `${inner.replace(/,?\s*$/, '')}, ${camel}: '${value}' ` : ` ${camel}: '${value}' `);
    return open.slice(0, start) + body + open.slice(i - 2);
  }
  const close = /\s*\/?>$/.exec(open); if (!close) return null;
  const attr = jsx ? ` style={{ ${camel}: '${value}' }}` : ` style="${prop}: ${value}"`;
  return open.slice(0, close.index) + attr + open.slice(close.index);
}

/**
 * Apply a text edit by rewriting the located occurrence in its source file.
 *
 * @param edit - the original text, its replacement, and the clicked element's context
 * @param opts - dryRun: locate and report without writing
 * @returns the edit made (with both contents unless a dry run), or why not
 */
function applyTextEdit(repoDir: string, edit: TextEdit, opts: TextEditOptions = {}): TextEditOutcome {
  const { originalText, newText, context = {} } = edit;
  const original = (originalText || '').trim();
  if (!original) return { ok: false, reason: 'empty-original' };
  if (typeof newText !== 'string') return { ok: false, reason: 'invalid-new-text' };
  if (original === newText.trim()) return { ok: false, reason: 'no-change' };

  // Guard against interpolated/split text we can't safely rewrite.
  if (/[{}]/.test(original) && /\$\{|\{\{|\{[a-zA-Z_]/.test(original)) {
    return { ok: false, reason: 'interpolated-text', message: 'This text appears to be dynamic/interpolated and is not directly editable yet.' };
  }

  const occurrences = findOccurrences(repoDir, original);
  // Structural pin first: the occurrence INSIDE the clicked element's own source
  // range. Twins elsewhere (same copy on another page, or twice in this file)
  // are never candidates, so a score tie can't pick the wrong one.
  let chosen: Occurrence | null = null, candidates: Occurrence[] = occurrences, strategy: MatchStrategy = 'none';
  const pin = pinNode(repoDir, context);
  if (pin) {
    // An attribute value (alt, href) lives in the open tag; text lives between the tags.
    const from = context.attribute ? pin.node.openStart : pin.node.openEnd;
    const to = context.attribute ? pin.node.openEnd : (pin.node.closeStart == null ? pin.node.end : pin.node.closeStart);
    const inside = occurrences.filter((o) => o.relFile === pin.relFile && o.start >= from && o.end <= to);
    if (inside.length) { chosen = inside[0]; strategy = 'structural'; }
  }
  if (!chosen) ({ chosen, candidates, strategy } = selectOccurrence(occurrences, context));

  if (!chosen) {
    // A stale preview is the common cause of not-found: the DOM still shows
    // text that was already rewritten on disk (by an agent turn or an earlier
    // edit). If the REPLACEMENT text is already in source, the edit is
    // effectively done — report that instead of escalating to the agent, so
    // the caller can just resync the preview. Length guard: short strings
    // ("Save") occur everywhere and would false-positive.
    if (strategy === 'none') {
      const want = newText.trim();
      if (want.length >= 12) {
        const applied = findOccurrences(repoDir, want);
        if (applied.length) {
          return { ok: false, reason: 'already-applied', relFile: applied[0].relFile, line: applied[0].line };
        }
      }
    }
    return {
      ok: false,
      reason: strategy === 'none' ? 'not-found' : 'ambiguous',
      strategy,
      candidates: candidates.map((c) => ({ relFile: c.relFile, line: c.line, context: c.context })),
    };
  }

  let content;
  try {
    content = fs.readFileSync(chosen.file, 'utf8');
  } catch (e) {
    return { ok: false, reason: 'read-failed', message: (e as Error).message };
  }

  // What was typed is page text: written raw, a quote ended the JS string it
  // landed in and a brace opened an expression. Escape it for where it lands
  // (sourceContext.ts), or refuse where text can't go as typed. If reading the
  // spot fails, refuse too: a refusal goes to the agent, a throw loses the edit.
  const dialect = dialectOf(chosen.file);
  let written: string | null = null;
  try { written = escapeTyped(contextAt(content, chosen.start, dialect), newText, dialect); } catch {}
  if (written === null) return { ok: false, reason: 'needs-agent', message: "This text sits in the site's code, so it can't be written there as typed. Ask the agent to make this change." };
  const before = content.slice(0, chosen.start);
  const after = content.slice(chosen.end);
  const updated = before + written + after;

  if (!opts.dryRun) {
    try {
      fs.writeFileSync(chosen.file, updated, 'utf8');
    } catch (e) {
      return { ok: false, reason: 'write-failed', message: (e as Error).message };
    }
  }

  return {
    ok: true,
    file: chosen.file,
    relFile: chosen.relFile,
    line: chosen.line,
    strategy,
    replaced: chosen.matched,
    occurrencesFound: occurrences.length,
    // Full before/after content for the undo/redo history (only when written).
    prevContent: opts.dryRun ? undefined : content,
    newContent: opts.dryRun ? undefined : updated,
  };
}

// ── Direct style edits (the adjust steppers' no-agent fast path) ───────────
// renderer/adjustDirect.js decides WHETHER a delta batch is deterministic and
// hands us concrete plans; this locates and rewrites them. Same locate-and-
// rewrite philosophy as text: class attributes, style attributes, and plain
// CSS rules are literal strings in the repo. All-or-nothing: every plan must
// stage cleanly before anything is written, so a half-applied batch (padding
// landed, gap didn't) can't exist — failures fall back to the agent whole.

function occurrencesIn(repoDir: string, file: string, content: string, needle: string): Occurrence[] {
  const out: Occurrence[] = [];
  let i = content.indexOf(needle);
  while (i !== -1) { out.push(makeOccurrence(repoDir, file, content, i, i + needle.length, true)); i = content.indexOf(needle, i + 1); }
  if (!out.length && /\s/.test(needle)) {
    // Whitespace-flexible (JSX class strings wrap across lines).
    const re = new RegExp(needle.trim().split(/\s+/).map(escapeRegExp).join('\\s+'), 'g');
    let m;
    while ((m = re.exec(content))) out.push(makeOccurrence(repoDir, file, content, m.index, m.index + m[0].length, false));
  }
  return out;
}

// Find `needle` across the repo, honoring already-staged (unwritten) content.
function locateStaged(repoDir: string, needle: string, domContext: ElementContext, staged: Map<string, string>): StagedLocation {
  const all: Occurrence[] = [];
  for (const file of listSourceFiles(repoDir)) {
    let content = staged.get(file);
    if (content === undefined) {
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
        content = fs.readFileSync(file, 'utf8');
      } catch { continue; }
    }
    if (content.includes("\u0000")) continue;
    all.push(...occurrencesIn(repoDir, file, content, needle));
  }
  const { chosen, strategy } = selectOccurrence(all, domContext);
  if (!chosen) return { ok: false, reason: all.length ? 'ambiguous' : 'not-found', strategy };
  return { ok: true, chosen };
}

/**
 * Apply adjust plans (class-swap | class-add | inline | css) to source.
 * @returns every file written with both contents and a summary, or why nothing
 *          was written (write-failed also carries the error message)
 */
function applyStyleEdits(repoDir: string, plans: StyleEditPlan[], domContext: ElementContext = {}): StyleEditOutcome {
  if (!Array.isArray(plans) || !plans.length) return { ok: false, reason: 'no-plans' };
  const staged = new Map<string, string>();   // file → pending content
  const originals = new Map<string, string>(); // file → content as it was on disk
  const readCur = (file: string): string => {
    if (staged.has(file)) return staged.get(file)!;
    const c = fs.readFileSync(file, 'utf8');
    if (!originals.has(file)) originals.set(file, c);
    return c;
  };
  const stage = (occ: Pick<Occurrence, 'file' | 'start' | 'end'>, span: string) => {
    const content = readCur(occ.file);
    if (!originals.has(occ.file)) originals.set(occ.file, content);
    staged.set(occ.file, content.slice(0, occ.start) + span + content.slice(occ.end));
  };

  const classPlans = plans.filter((p) => p.kind === 'class-swap' || p.kind === 'class-add');
  const inlinePlans = plans.filter((p) => p.kind === 'inline');
  const inlineSetPlans = plans.filter((p) => p.kind === 'inline-set');
  // Structural pin first: edit the class / style attributes INSIDE the clicked
  // element's own open tag. This is what makes "+8px padding" hit the element
  // you pointed at and not its twin on another page — and it reaches tokens in
  // cn()/clsx fragments and template literals that no single needle could find.
  let pinned = false;
  const pin = (classPlans.length || inlinePlans.length || inlineSetPlans.length) ? pinNode(repoDir, domContext) : null;
  if (inlineSetPlans.length && !pin) return { ok: false, reason: 'inline-set-needs-pin' }; // the terminal write needs the element, not a needle
  if (pin) {
    const content = readCur(pin.file);
    let open = content.slice(pin.node.openStart, pin.node.openEnd), okAll = true;
    for (const p of classPlans) {
      const next = p.kind === 'class-swap' ? swapClassToken(open, p.oldToken, p.newToken) : addClassToken(open, p.newToken);
      if (next == null) { okAll = false; break; }
      open = next;
    }
    for (const p of (okAll ? inlinePlans : [])) {
      const next = swapInlineDecl(open, p.prop, p.to);
      if (next == null) { okAll = false; break; }
      open = next;
    }
    const jsxFile = /\.(jsx?|tsx?|mjs|cjs)$/.test(pin.relFile);
    for (const p of (okAll ? inlineSetPlans : [])) {
      const next = setInlineDecl(open, p.prop, p.value, jsxFile);
      if (next == null) { okAll = false; break; }
      open = next;
    }
    if (!okAll) return { ok: false, reason: 'pinned-token-missing' }; // the class/declaration is computed at runtime — the agent's job, never a twin's
    stage({ file: pin.file, start: pin.node.openStart, end: pin.node.openEnd }, open); pinned = true;
  }

  // Class tokens: all swaps/adds happen inside the ONE located class string.
  if (classPlans.length && !pinned) {
    const needle = (classPlans[0].classList || []).join(' ').trim();
    if (!needle) return { ok: false, reason: 'no-class-string' };
    const loc = locateStaged(repoDir, needle, domContext, staged);
    if (!loc.ok) return { ok: false, reason: `class-${loc.reason}` };
    if (!originals.has(loc.chosen.file)) originals.set(loc.chosen.file, readCur(loc.chosen.file));
    let span = loc.chosen.matched;
    for (const p of classPlans) {
      if (p.kind === 'class-swap') {
        const re = new RegExp(`(^|\\s)${escapeRegExp(p.oldToken)}(?=\\s|$)`);
        if (!re.test(span)) return { ok: false, reason: `token-missing:${p.oldToken}` };
        span = span.replace(re, `$1${p.newToken}`);
      } else {
        span = `${span} ${p.newToken}`;
      }
    }
    stage(loc.chosen, span);
  }

  // Inline style attribute: swap each declaration inside the located value.
  if (inlinePlans.length && !pinned) {
    const needle = String(inlinePlans[0].styleAttr || '').trim();
    if (!needle) return { ok: false, reason: 'no-style-attr' };
    const loc = locateStaged(repoDir, needle, domContext, staged);
    if (!loc.ok) return { ok: false, reason: `inline-${loc.reason}` };
    let span = loc.chosen.matched;
    for (const p of inlinePlans) {
      const re = new RegExp(`(${escapeRegExp(p.prop)}\\s*:\\s*)[^;'"}]+`, 'i');
      if (!re.test(span)) return { ok: false, reason: `inline-decl-missing:${p.prop}` };
      span = span.replace(re, `$1${p.to}`);
    }
    stage(loc.chosen, span);
  }

  // Plain CSS rules: rewrite the declaration inside the matching selector block.
  // Shared set-declaration staging: rewrite the prop's value inside the
  // selector's block, or append the declaration at the block's end. Returns a
  // failure reason string, or null on success.
  const stageCssSet = (file: string, p: CssSetSpec): 'css-set-rule-not-found' | null => {
    let content = readCur(file);
    let blk: { braceAt: number; blockEnd: number } | null = null;
    for (let i = content.indexOf(p.selectorText); i !== -1; i = content.indexOf(p.selectorText, i + 1)) {
      const braceAt = content.indexOf('{', i + p.selectorText.length);
      if (braceAt === -1) break;
      if (/\S/.test(content.slice(i + p.selectorText.length, braceAt))) continue; // not this rule
      const blockEnd = content.indexOf('}', braceAt);
      if (blockEnd === -1) break;
      blk = { braceAt, blockEnd };
      break;
    }
    if (!blk) return 'css-set-rule-not-found';
    const block = content.slice(blk.braceAt, blk.blockEnd);
    const re = new RegExp(`(${escapeRegExp(p.prop)}\\s*:\\s*)[^;}]+`, 'i');
    let next;
    if (re.test(block)) {
      next = block.replace(re, `$1${p.value}`);
    } else {
      const trimmed = block.replace(/\s+$/, '');
      next = trimmed + (/[{;]$/.test(trimmed) ? '' : ';') + `\n  ${p.prop}: ${p.value};\n`;
    }
    if (!originals.has(file)) originals.set(file, readCur(file));
    content = content.slice(0, blk.braceAt) + next + content.slice(blk.blockEnd);
    staged.set(file, content);
    return null;
  };

  for (const p of plans.filter((x) => x.kind === 'css')) {
    const rel = String(p.href || '').replace(/^\//, '').split('?')[0];
    if (!rel) return { ok: false, reason: 'css-no-href' };
    const file = [rel, `public/${rel}`, `src/${rel}`, `static/${rel}`]
      .map((r) => path.join(repoDir, r))
      .find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    if (!file) return { ok: false, reason: 'stylesheet-not-found' };
    let content = readCur(file);
    let done = false;
    for (let i = content.indexOf(p.selectorText); i !== -1 && !done; i = content.indexOf(p.selectorText, i + 1)) {
      const braceAt = content.indexOf('{', i + p.selectorText.length);
      if (braceAt === -1) break;
      if (/\S/.test(content.slice(i + p.selectorText.length, braceAt))) continue; // not this rule
      const blockEnd = content.indexOf('}', braceAt);
      if (blockEnd === -1) break;
      const block = content.slice(braceAt, blockEnd);
      const re = new RegExp(`(${escapeRegExp(p.prop)}\\s*:\\s*)${escapeRegExp(p.from)}(?=\\s*(!important)?\\s*;?)`, 'i');
      if (!re.test(block)) continue;
      content = content.slice(0, braceAt) + block.replace(re, `$1${p.to}`) + content.slice(blockEnd);
      if (!originals.has(file)) originals.set(file, readCur(file));
      staged.set(file, content);
      done = true;
    }
    if (!done) {
      // The exact `prop: from` text isn't in the file — the value the browser
      // reported came from a shorthand (border-radius supplying
      // border-top-left-radius) or differently-formatted authoring. The rule
      // itself is still the right home: set the longhand at the end of its
      // block, where it wins the within-block cascade.
      const r2 = stageCssSet(file, { selectorText: p.selectorText, prop: p.prop, value: p.to });
      if (r2) return { ok: false, reason: r2 };
      done = true;
    }
  }

  // :hover rules (Design panel states): rewrite the declaration in an
  // existing `${base}:hover` block, add the declaration to it, or create the
  // block right after the base rule. Deterministic; the caller falls back to
  // an agent ask when the base rule can't be located.
  for (const p of plans.filter((x) => x.kind === 'css-hover')) {
    const rel = String(p.href || '').replace(/^\//, '').split('?')[0];
    if (!rel) return { ok: false, reason: 'hover-no-href' };
    const file = [rel, `public/${rel}`, `src/${rel}`, `static/${rel}`]
      .map((r) => path.join(repoDir, r))
      .find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    if (!file) return { ok: false, reason: 'hover-stylesheet-not-found' };
    let content = readCur(file);
    const hoverSel = `${p.baseSelector}:hover`;
    const findBlock = (selText: string) => {
      for (let i = content.indexOf(selText); i !== -1; i = content.indexOf(selText, i + 1)) {
        const braceAt = content.indexOf('{', i + selText.length);
        if (braceAt === -1) return null;
        if (/\S/.test(content.slice(i + selText.length, braceAt))) continue; // not this rule
        const blockEnd = content.indexOf('}', braceAt);
        if (blockEnd === -1) return null;
        return { start: i, braceAt, blockEnd };
      }
      return null;
    };
    const hov = findBlock(hoverSel);
    if (hov) {
      const block = content.slice(hov.braceAt, hov.blockEnd);
      const re = new RegExp(`(${escapeRegExp(p.prop)}\\s*:\\s*)[^;}]+`, 'i');
      const next = re.test(block)
        ? block.replace(re, `$1${p.value}`)
        : block.replace('{', `{\n  ${p.prop}: ${p.value};`);
      if (!originals.has(file)) originals.set(file, readCur(file));
      content = content.slice(0, hov.braceAt) + next + content.slice(hov.blockEnd);
      staged.set(file, content);
    } else {
      const base = findBlock(p.baseSelector);
      if (!base) return { ok: false, reason: 'hover-base-rule-not-found' };
      if (!originals.has(file)) originals.set(file, readCur(file));
      const insertion = `\n${hoverSel} {\n  ${p.prop}: ${p.value};\n}`;
      content = content.slice(0, base.blockEnd + 1) + insertion + content.slice(base.blockEnd + 1);
      staged.set(file, content);
    }
  }

  // Base-rule declaration set (Design panel direct writes): rewrite the
  // declaration wherever the matched rule supplies it, or append it at the
  // end of the block so it wins the within-block cascade — which is exactly
  // right when a longhand edit (border-top-left-radius) rides an authored
  // shorthand (border-radius).
  for (const p of plans.filter((x) => x.kind === 'css-set')) {
    const rel = String(p.href || '').replace(/^\//, '').split('?')[0];
    if (!rel) return { ok: false, reason: 'css-set-no-href' };
    const file = [rel, `public/${rel}`, `src/${rel}`, `static/${rel}`]
      .map((r) => path.join(repoDir, r))
      .find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    if (!file) return { ok: false, reason: 'css-set-stylesheet-not-found' };
    const r2 = stageCssSet(file, p);
    if (r2) return { ok: false, reason: r2 };
  }

  // Breakpoint-scoped declaration set: write inside the matching @media
  // block — rewrite the decl, add it to the selector's block there, create
  // the selector block inside the media rule, or append a whole new media
  // rule at the END of the file (cascade order makes end-of-file overrides
  // win, which is exactly what a smaller-breakpoint edit needs).
  for (const p of plans.filter((x) => x.kind === 'css-set-media')) {
    const rel = String(p.href || '').replace(/^\//, '').split('?')[0];
    if (!rel) return { ok: false, reason: 'css-set-media-no-href' };
    const file = [rel, `public/${rel}`, `src/${rel}`, `static/${rel}`]
      .map((r) => path.join(repoDir, r))
      .find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    if (!file) return { ok: false, reason: 'css-set-media-stylesheet-not-found' };
    let content = readCur(file);
    const collapse = (s2: string) => s2.replace(/\s+/g, ' ').trim().toLowerCase();
    const want = collapse(String(p.media));
    // Locate a media block whose condition matches (whitespace-insensitive).
    let block = null;
    const re = /@media([^{]*)\{/g;
    let mm;
    while ((mm = re.exec(content))) {
      if (collapse(mm[1]) !== want) continue;
      let depth = 1, i = re.lastIndex;
      while (i < content.length && depth > 0) { if (content[i] === '{') depth++; else if (content[i] === '}') depth--; i++; }
      block = { bodyStart: re.lastIndex, end: i - 1 }; // end = the closing brace of the @media
      break;
    }
    if (!originals.has(file)) originals.set(file, readCur(file));
    if (!block) {
      content = content.replace(/\s*$/, '') + `\n\n@media ${p.media} {\n  ${p.selectorText} {\n    ${p.prop}: ${p.value};\n  }\n}\n`;
      staged.set(file, content);
      continue;
    }
    const inner = content.slice(block.bodyStart, block.end);
    // The selector's block inside the media rule.
    let sb = null;
    for (let i = inner.indexOf(p.selectorText); i !== -1; i = inner.indexOf(p.selectorText, i + 1)) {
      const braceAt = inner.indexOf('{', i + p.selectorText.length);
      if (braceAt === -1) break;
      if (/\S/.test(inner.slice(i + p.selectorText.length, braceAt))) continue;
      const blockEnd = inner.indexOf('}', braceAt);
      if (blockEnd === -1) break;
      sb = { braceAt, blockEnd };
      break;
    }
    let nextInner;
    if (sb) {
      const body = inner.slice(sb.braceAt, sb.blockEnd);
      const dre = new RegExp(`(${escapeRegExp(p.prop)}\\s*:\\s*)[^;}]+`, 'i');
      let nb;
      if (dre.test(body)) {
        nb = body.replace(dre, `$1${p.value}`);
      } else {
        const trimmed = body.replace(/\s+$/, '');
        nb = trimmed + (/[{;]$/.test(trimmed) ? '' : ';') + `\n    ${p.prop}: ${p.value};\n  `;
      }
      nextInner = inner.slice(0, sb.braceAt) + nb + inner.slice(sb.blockEnd);
    } else {
      nextInner = inner.replace(/\s*$/, '') + `\n  ${p.selectorText} {\n    ${p.prop}: ${p.value};\n  }\n`;
    }
    content = content.slice(0, block.bodyStart) + nextInner + content.slice(block.end);
    staged.set(file, content);
  }

  if (!staged.size) return { ok: false, reason: 'nothing-staged' };
  const files: WrittenFileEdit[] = [];
  for (const [file, next] of staged) {
    try { fs.writeFileSync(file, next, 'utf8'); }
    catch (e) {
      // Roll back anything already written — all-or-nothing.
      for (const f of files) { try { fs.writeFileSync(f.file, f.prevContent, 'utf8'); } catch {} }
      return { ok: false, reason: 'write-failed', message: (e as Error).message };
    }
    files.push({ ok: true, file, relFile: path.relative(repoDir, file), prevContent: originals.get(file)!, newContent: next });
  }
  return { ok: true, files, summary: plans.map((p) => p.prop).join(', ') };
}

/**
 * Insert a new tag just before </head> in a page's source file. Used to ADD a
 * missing meta tag (title/description/OG/etc.) — editing an existing one goes
 * through applyTextEdit instead. Returns no-head if the file has no literal
 * <head> (e.g. the head lives in a framework layout we shouldn't touch per-page).
 */
function addHeadTag(repoDir: string, relFile: string, snippet: string): AddHeadTagOutcome {
  if (!relFile || !snippet) return { ok: false, reason: 'invalid' };
  const file = path.join(repoDir, relFile);
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, reason: 'read-failed', message: (e as Error).message }; }
  const m = content.match(/<\/head>/i);
  if (!m) return { ok: false, reason: 'no-head' };
  const idx = m.index!;
  const lineStart = content.lastIndexOf('\n', idx) + 1;
  const indent = (content.slice(lineStart, idx).match(/^\s*/) || [''])[0];
  const insertion = indent + '  ' + snippet + '\n' + indent;
  const updated = content.slice(0, idx) + insertion + content.slice(idx);
  try { fs.writeFileSync(file, updated, 'utf8'); } catch (e) { return { ok: false, reason: 'write-failed', message: (e as Error).message }; }
  return { ok: true, file, relFile, line: lineNumberAt(content, idx), prevContent: content, newContent: updated };
}

/**
 * Rewrite a head tag's value by LOCATOR (og:image, canonical, <title, …) instead
 * of by its current value. The fallback for meta edits where the rendered DOM
 * value differs from source — frameworks resolve relative URLs (metadataBase /
 * Astro.site), so searching for the DOM string finds nothing even though the
 * tag sits right there in source.
 *
 * attr set   → replace that attribute's quoted value inside the located tag.
 *              When the value is a bare-identifier expression instead
 *              (Astro/JSX: content={ogImage}), follow ONE hop to the
 *              identifier's `const` in the same file and rewrite the string
 *              literal inside its initializer — the common Astro layout shape
 *              `const ogImage = new URL('/og.png', Astro.site).href`.
 * attr null  → replace the tag's inner text (the <title> case).
 * Anything else (template literals, props, computed values) is skipped.
 */

// Resolve `{ident}` one hop: the identifier's single const/let/var initializer
// in the same file, and the first quoted string literal inside it.
function findIdentifierLiteral(content: string, ident: string): { start: number; end: number; quote: string } | null {
  const re = new RegExp(`\\b(?:const|let|var)\\s+${ident}\\s*=`, 'g');
  const defs: number[] = [];
  let m;
  while ((m = re.exec(content)) !== null) { if (!isInsideComment(content, m.index)) defs.push(m.index + m[0].length); }
  if (defs.length !== 1) return null; // none, or too many to pick safely
  const from = defs[0];
  const semi = content.indexOf(';', from);
  const nl = content.indexOf('\n', from);
  const end = Math.min(semi === -1 ? Infinity : semi, nl === -1 ? Infinity : nl, from + 400);
  const seg = content.slice(from, end);
  const lit = seg.match(/(['"])((?:\\.|(?!\1).)*)\1/);
  if (!lit) return null;
  const start = from + lit.index! + 1;
  return { start, end: start + lit[2].length, quote: lit[1] };
}

function setHeadTagValue(repoDir: string, { preferFile, locator, attr, value }: HeadTagValue): SetHeadTagOutcome {
  if (!locator || typeof value !== 'string') return { ok: false, reason: 'invalid' };
  const escAttr = (s: string) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const escText = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escJs = (s: string, q: string) => String(s).replace(/\\/g, '\\\\').replaceAll(q, '\\' + q);

  const matches: HeadTagMatch[] = [];
  for (const file of listSourceFiles(repoDir)) {
    let content;
    try { if (fs.statSync(file).size > MAX_FILE_BYTES) continue; content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let from = 0, idx;
    const seenTags = new Set<number>(); // a locator can occur twice inside one tag (rel + href)
    while ((idx = content.indexOf(locator, from)) !== -1) {
      from = idx + locator.length;
      // Token boundaries: 'og:image' must not match inside 'og:image:alt', and
      // 'icon' must not match inside 'favicon.ico' / 'apple-touch-icon'.
      const prev = content[idx - 1] || '';
      const next = content[idx + locator.length] || '';
      if (/[A-Za-z0-9_-]/.test(prev) || /[A-Za-z0-9_:-]/.test(next)) continue;
      if (isInsideComment(content, idx)) continue;
      const tagStart = content.lastIndexOf('<', idx);
      const tagEnd = content.indexOf('>', idx);
      if (tagStart === -1 || tagEnd === -1 || seenTags.has(tagStart)) continue;
      const tag = content.slice(tagStart, tagEnd + 1);
      if (!/^<(meta|link|title)\b/i.test(tag)) continue;
      seenTags.add(tagStart);
      if (attr) {
        const m = tag.match(new RegExp(attr + `\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
        if (m) {
          const quoted = m[1];
          const valStart = tagStart + m.index! + m[0].length - quoted.length + 1;
          const valEnd = valStart + quoted.length - 2;
          matches.push({ file, start: valStart, end: valEnd, content, kind: 'attr' });
          continue;
        }
        // Expression value: content={ogImage} → rewrite the identifier's literal.
        const ex = tag.match(new RegExp(attr + `\\s*=\\s*\\{\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\}`, 'i'));
        if (!ex) continue; // computed/template value — can't rewrite safely
        const lit = findIdentifierLiteral(content, ex[1]);
        if (!lit) continue;
        matches.push({ file, start: lit.start, end: lit.end, content, kind: 'js', quote: lit.quote });
      } else {
        const close = content.indexOf('</', tagEnd);
        if (close === -1) continue;
        matches.push({ file, start: tagEnd + 1, end: close, content, kind: 'text' });
      }
    }
  }

  if (!matches.length) return { ok: false, reason: 'not-found' };
  let chosen = matches;
  if (matches.length > 1 && preferFile) {
    const preferred = matches.filter((m) => path.relative(repoDir, m.file) === preferFile);
    if (preferred.length) chosen = preferred;
  }
  if (chosen.length > 1) {
    return { ok: false, reason: 'ambiguous', candidates: chosen.map((m) => ({ relFile: path.relative(repoDir, m.file), line: lineNumberAt(m.content, m.start) })) };
  }

  const m = chosen[0];
  let insert = value;
  if (m.kind === 'js') {
    // The identifier's own code absolutizes (new URL(path, Astro.site)); if it
    // held a site-relative path and we're handing it an absolute URL on the
    // same pattern, keep just the path so the site's URL-building stays intact.
    const oldLit = m.content.slice(m.start, m.end);
    if (/^\//.test(oldLit) && /^https?:\/\//i.test(value)) {
      try { const u = new URL(value); insert = u.pathname + u.search; } catch {}
    }
  }
  const replacement = m.kind === 'js' ? escJs(insert, m.quote) : m.kind === 'attr' ? escAttr(insert) : escText(insert);
  const updated = m.content.slice(0, m.start) + replacement + m.content.slice(m.end);
  try { fs.writeFileSync(m.file, updated, 'utf8'); } catch (e) { return { ok: false, reason: 'write-failed', message: (e as Error).message }; }
  return {
    ok: true,
    file: m.file,
    relFile: path.relative(repoDir, m.file),
    line: lineNumberAt(m.content, m.start),
    replaced: m.content.slice(m.start, m.end),
    prevContent: m.content,
    newContent: updated,
  };
}

/**
 * Read-only source locator for the Code panel. Given a clicked element's
 * selection payload, find where it's authored in source (and where it's styled),
 * reusing the very same finder/scorer as text edits — so it lands on the exact
 * spot an edit would. Never writes; returns a short snippet, not whole files.
 *
 * @param sel  captureSelection payload (text, classList, id, tagName, heading, styleSource, ...)
 * @returns where the element is authored (or only styled) with a snippet, or why it wasn't found
 */
function locateElement(repoDir: string, sel: ElementContext = {}): LocateOutcome {
  if (!repoDir) return { ok: false, reason: 'no-project' };

  const domContext: ElementContext = {
    classList: sel.classList || [],
    id: sel.id || null,
    tagName: sel.tagName || null,
    nearbyText: [sel.heading].filter(Boolean) as string[],
    occurrenceIndex: Number.isInteger(sel.occurrenceIndex) ? sel.occurrenceIndex : undefined,
  };

  // Locators in order of strength: the element's own rendered text (what a text
  // edit targets), then a distinctive class, then its id. First that resolves wins.
  const tries: string[] = [];
  const text = (sel.text || '').trim();
  if (text) tries.push(text.length > 120 ? text.slice(0, 120).trim() : text);
  for (const c of (sel.classList || [])) {
    if (c && String(c).length >= 4) { tries.push(String(c)); break; }
  }
  if (sel.id) tries.push(String(sel.id));
  // Attribute needles (src filename, href, alt…) — supplied by callers whose
  // elements carry no text/class/id. Weakest locators, so they come last.
  for (const n of (sel.extraNeedles || [])) { const v = String(n || '').trim(); if (v.length >= 4) tries.push(v); }

  let chosen: Occurrence | null = null;
  let strategy: MatchStrategy | 'first' = 'none';
  for (const needle of tries) {
    const occ = findOccurrences(repoDir, needle);
    if (!occ.length) continue;
    const pick = selectOccurrence(occ, domContext);
    if (pick.chosen) { chosen = pick.chosen; strategy = pick.strategy; break; }
    if (pick.candidates.length) { chosen = pick.candidates[0]; strategy = 'first'; break; }
  }

  const styleRefs = locateStyleRefs(repoDir, sel);

  if (!chosen) {
    // No authored-markup match. The CSS source is still a useful "dig in" target.
    if (styleRefs.length) {
      const s = styleRefs[0];
      return { ok: true, relFile: s.relFile, line: s.line, col: 1, snippet: s.snippet, startLine: s.startLine, strategy: 'style-only', styleRefs };
    }
    return { ok: false, reason: 'not-found', styleRefs };
  }

  const snip = readSnippet(chosen.file, chosen.line);
  return { ok: true, relFile: chosen.relFile, line: chosen.line, col: 1, snippet: snip.lines, startLine: snip.startLine, strategy, styleRefs };
}

// A few lines of a file around `line` (1-based) for the panel's read-only view.
function readSnippet(file: string, line: number, radius = 10): { startLine: number; lines: string[] } {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return { startLine: line, lines: [] }; }
  const all = content.split('\n');
  const start = Math.max(1, line - radius);
  const end = Math.min(all.length, line + radius);
  return { startLine: start, lines: all.slice(start - 1, end) };
}

// Resolve the CSS source rules captured at click time to on-disk files + lines.
function locateStyleRefs(repoDir: string, sel: ElementContext): StyleRef[] {
  const rules = (sel.styleSource && sel.styleSource.rules) || [];
  const out: StyleRef[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    if (!r || !r.href || !r.selectorText) continue;
    const key = r.href + '|' + r.selectorText;
    if (seen.has(key)) continue;
    seen.add(key);
    const file = resolveHrefToFile(repoDir, r.href);
    if (!file) continue;
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const line = selectorLine(content, r.selectorText);
    if (line == null) continue;
    const snip = readSnippet(file, line, 6);
    out.push({ relFile: path.relative(repoDir, file), selectorText: r.selectorText, line, startLine: snip.startLine, snippet: snip.lines });
    if (out.length >= 3) break;
  }
  return out;
}

// A stylesheet href (URL pathname, e.g. "/src/styles.css") → an on-disk file.
function resolveHrefToFile(repoDir: string, href: string): string | null {
  const rel = String(href).replace(/^\/+/, '').split('?')[0].split('#')[0];
  if (!rel || !/\.(css|scss|sass|less)$/i.test(rel)) return null;
  const direct = path.join(repoDir, rel);
  if (safeExists(direct)) return direct;
  // Framework-relocated hrefs: match by suffix / basename across source files.
  const base = rel.split('/').pop();
  try {
    for (const f of listSourceFiles(repoDir)) {
      if (f.endsWith(path.sep + rel) || path.basename(f) === base) return f;
    }
  } catch {}
  return null;
}

// The line where a CSS rule for `selectorText` begins (first "<selector> ... {").
function selectorLine(content: string, selectorText: string): number | null {
  const st = String(selectorText).trim();
  const cands = [st];
  const simple = st.split(/[\s>+~,]+/).filter(Boolean).pop();
  if (simple && simple !== st) cands.push(simple);
  for (const c of cands) {
    let from = 0;
    let idx;
    while ((idx = content.indexOf(c, from)) !== -1) {
      from = idx + c.length;
      const after = content.slice(idx + c.length, idx + c.length + 160);
      if (/^[^{};]*\{/.test(after)) return lineNumberAt(content, idx);
    }
  }
  return null;
}

function safeExists(p: string): boolean { try { return fs.existsSync(p); } catch { return false; } }

export { listSourceFiles, findOccurrences, locateElement, addHeadTag, setHeadTagValue, selectOccurrence, scoreOccurrence, applyTextEdit, applyStyleEdits, SOURCE_EXTENSIONS, IGNORED_DIRS };
