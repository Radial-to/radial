/**
 * Design tokens = the project's CSS custom properties, read from the AUTHORED
 * stylesheets (never the served or built ones), so a value can be written back
 * to the exact declaration it came from. This is the index behind the Tokens
 * panel and `radial tokens` (plans/radial-agent-native.md, ceiling side).
 *
 * What counts: every `--name: value` declaration inside a rule block of a .css
 * file (plus <style> blocks in .html/.astro/.vue/.svelte files), including
 * Tailwind v4 `@theme { … }` blocks. Each definition remembers its scope (the
 * selector, e.g. `:root`, `[data-theme="dark"]`, `.dark`) and its at-rule
 * context (`@media (prefers-color-scheme: dark)`), which is what "modes" are in
 * CSS. Skipped: generated and vendored folders, minified files, anything over
 * 2MB. Pure Node, Electron-free.
 */

import fs from 'fs';
import path from 'path';
import type { FileEdit } from './editHistory';

/** A `--name: value` declaration found by scanCss, with offsets of its value in the scanned text. */
export interface CssDeclaration {
  name: string;
  value: string;
  /** The innermost rule's selector, `@theme` inside a Tailwind @theme block, else the innermost at-rule. */
  selector: string;
  /** The enclosing at-rules other than @theme, joined by spaces ('' when none). */
  at: string;
  theme: boolean;
  start: number;
  end: number;
}

/** One definition of a token in the project: its declaration, with the file (relative to the repo) and line. */
export interface TokenDefinition extends Omit<CssDeclaration, 'name'> {
  file: string;
  line: number;
}

export type TokenType = 'color' | 'font' | 'length' | 'number' | 'duration' | 'easing' | 'shadow' | 'alias' | 'other';

/** A token: its base definition's fields, every definition, and how often it is used. */
export interface Token extends Omit<TokenDefinition, 'start' | 'end'> {
  name: string;
  type: TokenType;
  /** The token it points at when its value is `var(--other)`. */
  alias: string | null;
  defs: TokenDefinition[];
  /** One label per definition when there are several, else empty. */
  modes: string[];
  /** `var(--name` references in source files. */
  uses: number;
  /** Files with a reference. */
  files: number;
}

/** A token as the agent context bundle lists it (main.ts and cli.ts build these from indexTokens). */
export type TokenSummary = Pick<Token, 'name' | 'value' | 'type' | 'modes'>;

/** indexTokens()'s answer; tokens holds at most MAX_TOKENS, count is the full number. */
export interface TokenIndex {
  ok: true;
  tokens: Token[];
  count: number;
  /** Files with definitions, relative to the repo. */
  files: string[];
}

/** Which declaration setToken rewrites; without file, selector, at or mode a token must have one definition. */
export interface SetTokenRequest {
  name?: string | null;
  value?: string | null;
  file?: string | null;
  selector?: string | null;
  at?: string | null;
  mode?: string | null;
}

/** A definition offered when setToken can't tell which one was meant. */
export interface TokenChoice {
  relFile: string;
  line: number;
  mode: string;
  selector: string;
  at: string;
  value: string;
}

/** A rewritten declaration: a FileEdit (what recordEdit takes) that always carries both contents and the line. */
export interface SetTokenDone extends FileEdit {
  line: number;
  name: string;
  from: string;
  to: string;
  mode: string;
  prevContent: string;
  newContent: string;
}

export interface SetTokenFailed {
  ok: false;
  reason: 'invalid' | 'not-found' | 'error' | 'write-failed';
  message: string;
}

export interface SetTokenAmbiguous {
  ok: false;
  reason: 'ambiguous';
  message: string;
  candidates: TokenChoice[];
}

export interface SetTokenUnchanged {
  ok: false;
  reason: 'no-change';
}

export type SetTokenResult = SetTokenDone | SetTokenFailed | SetTokenAmbiguous | SetTokenUnchanged;

const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit', '.astro', 'dist', 'build', 'out', '.cache', '.vercel', '.turbo', 'coverage', '.vscode', '.idea', '.output', 'storybook-static']);
const CSS_EXT = new Set(['.css']);
const STYLE_HOST_EXT = new Set(['.html', '.htm', '.astro', '.vue', '.svelte']);
const REF_EXT = new Set(['.css', '.html', '.htm', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.astro', '.vue', '.svelte', '.mdx', '.md', '.json']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOKENS = 600;

function listFiles(repoDir: string, exts: Set<string>): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue; walk(path.join(dir, e.name), depth + 1); }
      else if (e.isFile() && exts.has(path.extname(e.name).toLowerCase())) out.push(path.join(dir, e.name));
    }
  };
  walk(repoDir, 0);
  return out.sort();
}

function looksMinified(text: string): boolean {
  if (text.length < 4000) return false;
  const lines = text.split('\n');
  return lines.length < 5 || text.length / lines.length > 1200;
}

// ── the scanner ──
// Walks a stylesheet's text with a brace stack so each declaration knows its
// selector and at-rule ancestry. Comments and strings are skipped. Good enough
// for authored CSS; it does not try to be a full parser.
function scanCss(text: string, { offset = 0 }: { offset?: number } = {}): CssDeclaration[] {
  const defs: CssDeclaration[] = [];
  const stack: { kind: 'rule' | 'at'; head: string }[] = []; // { kind: 'rule'|'at', head }
  let i = 0, headStart = 0;
  const n = text.length;
  const skipComment = () => { const e = text.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; };
  const skipString = (q: string) => { i++; while (i < n && text[i] !== q) { if (text[i] === '\\') i++; i++; } i++; };
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') { skipComment(); headStart = i; continue; }
    if (c === '"' || c === "'") { skipString(c); continue; }
    if (c === '{') {
      const head = text.slice(headStart, i).trim().replace(/\s+/g, ' ');
      stack.push({ kind: head.startsWith('@') ? 'at' : 'rule', head });
      i++; headStart = i; continue;
    }
    if (c === '}') { stack.pop(); i++; headStart = i; continue; }
    if (c === ';') { headStart = i + 1; i++; continue; }
    // A custom property declaration starts at `--` in statement position.
    if (c === '-' && text[i + 1] === '-' && stack.length) {
      const before = text.slice(headStart, i).trim();
      if (before === '') {
        const m = /^(--[A-Za-z0-9_-]+)\s*:/.exec(text.slice(i, i + 200));
        if (m) {
          const valStart = i + m[0].length;
          // The value runs to the next ; or } at depth 0 (parens and strings can hide either).
          let j = valStart, depth = 0;
          while (j < n) {
            const ch = text[j];
            if (ch === '"' || ch === "'") { const q = ch; j++; while (j < n && text[j] !== q) { if (text[j] === '\\') j++; j++; } j++; continue; }
            if (ch === '(') depth++;
            else if (ch === ')') depth = Math.max(0, depth - 1);
            else if ((ch === ';' || ch === '}') && depth === 0) break;
            j++;
          }
          const rawValue = text.slice(valStart, j);
          const trimmed = rawValue.trim();
          const lead = rawValue.length - rawValue.replace(/^\s+/, '').length;
          const scope = stack.filter((s) => s.kind === 'rule').map((s) => s.head);
          const ats = stack.filter((s) => s.kind === 'at').map((s) => s.head);
          const theme = ats.some((a) => /^@theme\b/.test(a));
          defs.push({
            name: m[1], value: trimmed,
            selector: scope.length ? scope[scope.length - 1] : (theme ? '@theme' : (ats[ats.length - 1] || '')),
            at: ats.filter((a) => !/^@theme\b/.test(a)).join(' '),
            theme,
            start: offset + valStart + lead, end: offset + valStart + lead + trimmed.length,
          });
          i = j; headStart = j; continue;
        }
      }
    }
    i++;
  }
  return defs;
}

// <style> blocks inside html-like files carry their own offset into the file.
function scanStyleHost(text: string): CssDeclaration[] {
  const defs: CssDeclaration[] = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(text))) defs.push(...scanCss(m[1], { offset: m.index + m[0].indexOf(m[1]) }));
  return defs;
}

// ── types ──
const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color|color-mix|hwb)\(|transparent$|currentcolor$|(white|black|red|blue|green|gray|grey|silver|orange|purple|pink|teal|navy|maroon|olive|lime|aqua|fuchsia|yellow|cyan|magenta|indigo|violet|brown|beige|ivory|coral|salmon|gold|khaki|crimson|tan|wheat|linen|snow|azure|plum|orchid|tomato|turquoise|chartreuse|lavender|mint)$)/i;
function inferType(value: string | null | undefined): TokenType {
  const v = String(value || '').trim();
  if (!v) return 'other';
  if (/^var\(--[A-Za-z0-9_-]+\)$/.test(v)) return 'alias';
  if (COLOR_RE.test(v)) return 'color';
  if (/^-?\d*\.?\d+(px|rem|em|%|vw|vh|vmin|vmax|ch|ex|pt|cqw|cqh|svh|dvh|lvh)$/.test(v)) return 'length';
  if (/^-?\d*\.?\d+$/.test(v)) return 'number';
  if (/^\d*\.?\d+(ms|s)$/.test(v)) return 'duration';
  if (/^(cubic-bezier|steps|linear|ease)\b/.test(v)) return 'easing';
  if (/^(\d*\.?\d+(px|rem|em)\s*){2,4}$/.test(v) && !/[^\d.\spxrem]/.test(v)) return 'length';
  if (/(px|rem|em)\b.*(rgba?|hsla?|oklch|#[0-9a-f]{3,8})/i.test(v) || /^inset\b/.test(v)) return 'shadow';
  if (/^(["']?[A-Za-z][\w -]*["']?)(\s*,\s*[^,]+)+$/.test(v) && /,/.test(v) && !/\(/.test(v.replace(/var\([^)]*\)/g, ''))) return 'font';
  if (/^["'][^"']+["']$/.test(v)) return 'font';
  if (/^(sans-serif|serif|monospace|system-ui|ui-sans-serif|ui-serif|ui-monospace)$/.test(v)) return 'font';
  return 'other';
}
const TYPE_ORDER: TokenType[] = ['color', 'font', 'length', 'number', 'duration', 'easing', 'shadow', 'alias', 'other'];

// ── the index ──
/** Every token in the project, colors first, and the files that define them; indexTokens lists the first MAX_TOKENS. */
function collectTokens(repoDir: string): { tokens: Token[]; files: string[] } {
  const files = listFiles(repoDir, new Set([...CSS_EXT, ...STYLE_HOST_EXT]));
  const byName = new Map<string, { name: string; defs: TokenDefinition[] }>();
  const defsAll: TokenDefinition[] = [];
  for (const file of files) {
    let text; try { if (fs.statSync(file).size > MAX_FILE_BYTES) continue; text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (/\.min\.css$/i.test(file) || (CSS_EXT.has(path.extname(file).toLowerCase()) && looksMinified(text))) continue;
    const defs = CSS_EXT.has(path.extname(file).toLowerCase()) ? scanCss(text) : scanStyleHost(text);
    const rel = path.relative(repoDir, file);
    for (const d of defs) {
      const line = text.slice(0, d.start).split('\n').length;
      const def: TokenDefinition = { file: rel, line, selector: d.selector, at: d.at, theme: d.theme, value: d.value, start: d.start, end: d.end };
      defsAll.push(def);
      const t = byName.get(d.name) || { name: d.name, defs: [] };
      t.defs.push(def);
      byName.set(d.name, t);
    }
  }
  // References: every `var(--name` in source files, minus the definitions themselves.
  const refCounts = new Map<string, number>();
  const refFiles = new Map<string, Set<string>>();
  for (const file of listFiles(repoDir, REF_EXT)) {
    let text; try { if (fs.statSync(file).size > MAX_FILE_BYTES) continue; text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (/\.min\.(css|js)$/i.test(file)) continue;
    const re = /var\(\s*(--[A-Za-z0-9_-]+)/g;
    let m;
    const rel = path.relative(repoDir, file);
    while ((m = re.exec(text))) {
      refCounts.set(m[1], (refCounts.get(m[1]) || 0) + 1);
      if (!refFiles.has(m[1])) refFiles.set(m[1], new Set());
      refFiles.get(m[1])!.add(rel);
    }
  }
  const tokens = [...byName.values()].map((t): Token => {
    const base = t.defs.find((d) => !d.at && /^(:root|html|@theme)\b/.test(d.selector)) || t.defs[0];
    const type = t.defs.some((d) => inferType(d.value) === 'alias') && t.defs.every((d) => inferType(d.value) === 'alias') ? 'alias' : inferType(base.value);
    const alias = /^var\((--[A-Za-z0-9_-]+)\)$/.exec(base.value);
    const modes = t.defs.length > 1 ? t.defs.map((d) => modeLabel(d)) : [];
    return {
      name: t.name, value: base.value, type, alias: alias ? alias[1] : null,
      file: base.file, line: base.line, selector: base.selector, at: base.at, theme: base.theme,
      defs: t.defs, modes, uses: refCounts.get(t.name) || 0, files: refFiles.has(t.name) ? refFiles.get(t.name)!.size : 0,
    };
  });
  tokens.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.file.localeCompare(b.file) || a.line - b.line);
  return { tokens, files: [...new Set(defsAll.map((d) => d.file))] };
}

function indexTokens(repoDir: string): TokenIndex {
  const { tokens, files } = collectTokens(repoDir);
  return { ok: true, tokens: tokens.slice(0, MAX_TOKENS), count: tokens.length, files };
}

function modeLabel(def: Pick<TokenDefinition, 'selector' | 'at'>): string {
  if (def.at) { const m = /prefers-color-scheme\s*:\s*(dark|light)/i.exec(def.at); if (m) return m[1].toLowerCase(); const w = /(max|min)-width\s*:\s*([\d.]+\w+)/.exec(def.at); if (w) return `${w[1] === 'max' ? '≤' : '≥'}${w[2]}`; return def.at.replace(/^@media\s*/, ''); }
  if (/^(:root|html|@theme)$/.test(def.selector)) return 'default';
  const d = /\[data-theme\s*=\s*["']?([^"'\]]+)["']?\]/.exec(def.selector) || /\.(dark|light|theme-[\w-]+)\b/.exec(def.selector);
  return d ? d[1] : def.selector;
}

// ── writing ──
// Rewrite ONE declaration's value in place: the definition chosen by file +
// selector + at-rule (or the base one), re-located by scanning the file fresh so
// a stale index can never write to the wrong bytes. Returns the shape recordEdit
// expects (file, relFile, prevContent, newContent, line).
function setToken(repoDir: string, { name, value, file, selector, at, mode }: SetTokenRequest = {}): SetTokenResult {
  if (!name || !/^--[A-Za-z0-9_-]+$/.test(name)) return { ok: false, reason: 'invalid', message: 'A token name looks like --brand.' };
  if (value == null || !String(value).trim()) return { ok: false, reason: 'invalid', message: 'A value is required.' };
  const val = String(value).trim().replace(/;$/, '');
  if (/[;{}]/.test(val)) return { ok: false, reason: 'invalid', message: 'A value cannot contain ; { or }.' };
  // Every token, not just the ones the index lists: a big theme defines more than MAX_TOKENS.
  const t = collectTokens(repoDir).tokens.find((x) => x.name === name);
  if (!t) return { ok: false, reason: 'not-found', message: `${name} is not defined in this project's stylesheets.` };
  let candidates = t.defs;
  if (file) candidates = candidates.filter((d) => d.file === file);
  if (selector) candidates = candidates.filter((d) => d.selector === selector);
  if (at != null) candidates = candidates.filter((d) => (d.at || '') === (at || ''));
  if (mode) candidates = candidates.filter((d) => modeLabel(d) === mode);
  if (!file && !selector && at == null && !mode && candidates.length > 1) {
    return { ok: false, reason: 'ambiguous', message: `${name} is defined ${candidates.length} times (${candidates.map(modeLabel).join(', ')}). Say which: --mode <name>.`, candidates: candidates.map((d) => ({ relFile: d.file, line: d.line, mode: modeLabel(d), selector: d.selector, at: d.at, value: d.value })) };
  }
  if (!candidates.length) return { ok: false, reason: 'not-found', message: `No definition of ${name} matches that scope.` };
  const def = candidates[0];
  const abs = path.join(repoDir, def.file);
  let content; try { content = fs.readFileSync(abs, 'utf8'); } catch (e) { return { ok: false, reason: 'error', message: (e as Error).message }; }
  // Re-locate by re-scanning this file: the index may be seconds old.
  const fresh = (CSS_EXT.has(path.extname(abs).toLowerCase()) ? scanCss(content) : scanStyleHost(content))
    .filter((d) => d.name === name && d.selector === def.selector && (d.at || '') === (def.at || ''));
  const here = fresh.find((d) => content.slice(d.start, d.end) === def.value) || fresh[0];
  if (!here) return { ok: false, reason: 'not-found', message: `${def.file} changed; ${name} is no longer where the index saw it.` };
  if (content.slice(here.start, here.end) === val) return { ok: false, reason: 'no-change' };
  const next = content.slice(0, here.start) + val + content.slice(here.end);
  try { fs.writeFileSync(abs, next, 'utf8'); } catch (e) { return { ok: false, reason: 'write-failed', message: (e as Error).message }; }
  return { ok: true, file: abs, relFile: def.file, line: here && content.slice(0, here.start).split('\n').length, name, from: def.value, to: val, mode: modeLabel(def), prevContent: content, newContent: next };
}

export { indexTokens, setToken, scanCss, scanStyleHost, inferType, modeLabel, TYPE_ORDER };
