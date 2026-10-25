// Where a spot in a source file sits, so text someone typed on the page can be
// written there without breaking the file: inside a quoted JS string (escape
// its quote), a template literal, an attribute value (HTML entities), page text
// (JSX, MDX, Astro and Svelte braces and angle brackets as entities, Vue's
// {{ }}), or a plain-text file (Markdown). Where text can't go (code, a comment,
// an unquoted attribute with spaces), escapeTyped says so and the edit is
// refused instead.
//
// Ported from Radial Cloud's copy of the edit engine, which made it first.
// Three differences: MDX has its own dialect (Cloud reads a whole .mdx file as
// JavaScript, so prose with an apostrophe looked like a string and most prose
// like code); a <title> is raw text only in plain HTML (in JSX, Astro and
// Svelte its braces are code); and text right inside a JSX fragment is page
// text (Cloud's version re-read the fragment until the stack ran out).

import path from 'path';
import { parseNodes, skipBraces, skipComment, skipRegex, skipString, jsxStarts, skipJsx } from './htmlScan';
import type { HtmlNode } from './htmlScan';

/** How a file's markup and code are written. */
export type Dialect = 'jsx' | 'mdx' | 'astro' | 'svelte' | 'vue' | 'html' | 'json' | 'text';

/** What sits at a spot in a source file, for writing typed text there. */
export type SourceContext =
  /** Inside a quoted JS string: its own quote gets escaped. */
  | { kind: 'string'; quote: '"' | "'" }
  /** Inside a template literal's text. */
  | { kind: 'template' }
  /** An attribute's value, quoted or (`quote: null`) not. */
  | { kind: 'attr'; quote: '"' | "'" | '`' | null; name: string }
  /** Page text between tags. */
  | { kind: 'markup' }
  /** A <title> or <textarea>'s text, where tags aren't read. */
  | { kind: 'raw' }
  /** A file that is all text (Markdown). */
  | { kind: 'text' }
  /** Code, a comment, a tag's name: somewhere typed text can't go as text. */
  | { kind: 'code' };

const JSX_EXTS = new Set(['.jsx', '.tsx', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

/** How a file's markup and code are written, by its extension. */
function dialectOf(file: string): Dialect {
  const ext = path.extname(file).toLowerCase();
  if (JSX_EXTS.has(ext)) return 'jsx';
  if (ext === '.mdx') return 'mdx';
  if (ext === '.astro') return 'astro';
  if (ext === '.svelte') return 'svelte';
  if (ext === '.vue') return 'vue';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.json') return 'json';
  return 'text';
}

// The deepest element whose range holds `pos`.
function deepest(nodes: HtmlNode[], pos: number): HtmlNode | null {
  for (const node of nodes) {
    if (node.openStart <= pos && pos < node.end) return deepest(node.children, pos) || node;
  }
  return null;
}

/** What sits at offset `pos` of `src`, a file written in `dialect`. */
function contextAt(src: string, pos: number, dialect: Dialect): SourceContext {
  if (dialect === 'json') return jsContext(src, 0, src.length, pos, false);
  if (dialect === 'text') return { kind: 'text' };
  if (dialect === 'mdx') return mdxContext(src, pos);
  if (dialect === 'astro' && src.startsWith('---')) {
    const end = src.indexOf('\n---', 3);
    if (end > 0 && pos < end) return jsContext(src, 3, end, pos, false);
  }
  return withinMarkup(src, 0, src.length, pos, dialect, parseNodes(src).roots);
}

// MDX is Markdown prose with JSX elements, `{…}` expressions and import and
// export statements in it. The YAML frontmatter and fenced code blocks hold
// text as written; an import or export runs to the next blank line and is
// code; everything else reads as the text of one element, the way MDX reads
// it: an apostrophe in prose is text, `{` starts an expression, `<` a tag.
const MDX_ROOT = '<mdx-root>';
function mdxContext(src: string, pos: number): SourceContext {
  let rest = ''; // the file with frontmatter, code blocks and statements blanked out (offsets kept)
  let at = 0;
  let front = /^---\r?\n/.test(src);
  let fence = ''; // the open code block's fence (``` or ~~~), if any
  let statement = -1; // where the import or export being read began
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    let kind: 'prose' | 'text' | 'code' = 'prose';
    const opensFence = /^(`{3,}|~{3,})/.exec(trimmed);
    if (front) { kind = 'text'; if (at > 0 && trimmed === '---') front = false; }
    else if (fence) { kind = 'text'; if (trimmed.startsWith(fence) && !trimmed.replace(/^[`~]+/, '').trim()) fence = ''; }
    else if (statement >= 0 && trimmed) kind = 'code';
    else if (/^(import|export)\s/.test(line)) { kind = 'code'; statement = at; }
    else if (opensFence) { kind = 'text'; fence = opensFence[1]; statement = -1; }
    else statement = -1;
    if (pos >= at && pos <= at + line.length) {
      if (kind === 'text') return { kind: 'text' };
      if (kind === 'code') return jsContext(src, statement, src.length, pos, true);
    }
    rest += (kind === 'prose' ? line : ' '.repeat(line.length)) + '\n';
    at += line.length + 1;
  }
  const doc = `${MDX_ROOT}${rest}</${MDX_ROOT.slice(1)}`;
  return withinMarkup(doc, 0, doc.length, pos + MDX_ROOT.length, 'mdx', parseNodes(doc).roots);
}

// In a stretch of markup: a whole template, or (`nested`) a JSX element or
// fragment inside an expression, parsed on its own.
function withinMarkup(src: string, from: number, to: number, pos: number, dialect: Dialect, roots: HtmlNode[], nested = false): SourceContext {
  const el = deepest(roots, pos);
  if (!el) {
    // Text right inside a fragment (`<>Don't stop</>`) belongs to no element.
    // Reading the fragment as code again (Cloud's version) re-entered it here
    // until the stack ran out.
    if (nested) return jsxText(src, from, to, pos, roots);
    if (dialect === 'jsx') return jsContext(src, from, to, pos, true);
    return dialect === 'html' || dialect === 'astro' || dialect === 'svelte' || dialect === 'vue' || dialect === 'mdx' ? { kind: 'markup' } : { kind: 'code' };
  }
  if (pos < el.openEnd) return attrContext(src, el, pos, dialect);
  if (el.tag === 'script') return jsContext(src, el.openEnd, el.closeStart ?? el.end, pos, false);
  if (el.tag === 'style') return { kind: 'code' };
  // Tags aren't read in a <title> or <textarea>: in plain HTML its text is
  // raw. In JSX, MDX, Astro and Svelte its braces are still code, so it's
  // page text like any other (Cloud's raw text let a typed `{` into an SVG's
  // <title> in JSX break the file).
  if ((el.tag === 'title' || el.tag === 'textarea') && dialect === 'html') return { kind: 'raw' };
  if (dialect === 'html' || dialect === 'vue') return { kind: 'markup' };
  return jsxText(src, el.openEnd, el.closeStart ?? el.end, pos, el.children);
}

// Page text from `start` to `end`, around `children`: markup, unless `pos` is
// inside one of its own `{…}` expressions.
function jsxText(src: string, start: number, end: number, pos: number, children: HtmlNode[]): SourceContext {
  let i = start;
  while (i < end && i <= pos) {
    const child = children.find((node) => node.openStart === i);
    if (child) { i = child.end; continue; }
    if (src[i] === '{') {
      const close = skipBraces(src, i);
      if (i < pos && pos < close) return jsContext(src, i + 1, close - 1, pos, true);
      i = close;
      continue;
    }
    i++;
  }
  return { kind: 'markup' };
}

// In an open tag: a quoted value, a `{…}` value (code), or the tag itself.
function attrContext(src: string, el: HtmlNode, pos: number, dialect: Dialect): SourceContext {
  let i = el.openStart + 1;
  while (i < el.openEnd && /[^\s/>]/.test(src[i])) i++;
  while (i < el.openEnd) {
    const name = /^[^\s=/>"'{]+/.exec(src.slice(i, i + 100));
    if (!name) {
      if (src[i] === '{') {
        const close = skipBraces(src, i);
        if (i < pos && pos < close) return jsContext(src, i + 1, close - 1, pos, true);
        i = close;
        continue;
      }
      i++;
      continue;
    }
    i += name[0].length;
    let j = i;
    while (/\s/.test(src[j] || '')) j++;
    if (src[j] !== '=') continue;
    j++;
    while (/\s/.test(src[j] || '')) j++;
    const quote = src[j];
    if (quote === '"' || quote === "'" || quote === '`') {
      const close = skipString(src, j);
      if (j < pos && pos < close) {
        // Vue's bound attributes (:title, v-bind, @click) hold code, not text.
        if (dialect === 'vue' && /^(:|v-|@)/.test(name[0])) return { kind: 'code' };
        return { kind: 'attr', quote, name: name[0] };
      }
      i = close;
    } else if (quote === '{') {
      const close = skipBraces(src, j);
      if (j < pos && pos < close) return jsContext(src, j + 1, close - 1, pos, true);
      i = close;
    } else {
      const value = /^[^\s>]+/.exec(src.slice(j, j + 400));
      const close = j + (value ? value[0].length : 0);
      if (j <= pos && pos < close) return { kind: 'attr', quote: null, name: name[0] };
      i = close;
    }
  }
  return { kind: 'code' };
}

// In code from `from` to `to`: strings, template literals (and their `${}`),
// comments, regexes and, when `jsx`, JSX elements.
function jsContext(src: string, from: number, to: number, pos: number, jsx: boolean): SourceContext {
  let i = from;
  while (i < to && i <= pos) {
    const c = src[i];
    if (c === '/') {
      const comment = skipComment(src, i);
      if (comment >= 0) { if (pos < comment) return { kind: 'code' }; i = comment; continue; }
      const regex = skipRegex(src, i);
      if (regex >= 0) { if (pos < regex) return { kind: 'code' }; i = regex; continue; }
    }
    if (c === '"' || c === "'") {
      const close = skipString(src, i);
      if (i < pos && pos < close) return { kind: 'string', quote: c };
      i = close;
      continue;
    }
    if (c === '`') {
      let k = i + 1;
      while (k < src.length) {
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === '`') break;
        if (src[k] === '$' && src[k + 1] === '{') {
          const close = skipBraces(src, k + 1);
          if (k + 1 < pos && pos < close) return jsContext(src, k + 2, close - 1, pos, jsx);
          k = close;
          continue;
        }
        k++;
      }
      if (i < pos && pos < k + 1) return { kind: 'template' };
      i = k + 1;
      continue;
    }
    if (jsx && c === '<' && jsxStarts(src, i)) {
      const close = skipJsx(src, i);
      if (close > i) {
        if (i <= pos && pos < close) {
          // The element is parsed on its own; its offsets move back to the file's.
          const at = i;
          const shift = (nodes: HtmlNode[]): HtmlNode[] => nodes.map((node) => ({
            ...node,
            openStart: node.openStart + at, openEnd: node.openEnd + at,
            closeStart: node.closeStart == null ? null : node.closeStart + at,
            closeEnd: node.closeEnd == null ? null : node.closeEnd + at,
            end: node.end + at, children: shift(node.children),
          }));
          return withinMarkup(src, i, close, pos, 'jsx', shift(parseNodes(src.slice(i, close)).roots), true);
        }
        i = close;
        continue;
      }
    }
    i++;
  }
  return { kind: 'code' };
}

// `&copy;` typed as words stays words: an ampersand that would start an entity is written as one.
const literalAmpersands = (text: string): string => text.replace(/&(?=#?[a-zA-Z0-9]+;)/g, '&amp;');

/** What someone typed, made safe for where it lands, or null when it can't go there as text. */
function escapeTyped(context: SourceContext, typed: string, dialect: Dialect): string | null {
  switch (context.kind) {
    case 'string':
      return typed.replace(/\\/g, '\\\\').replace(new RegExp(context.quote, 'g'), `\\${context.quote}`).replace(/\r?\n/g, '\\n');
    case 'template':
      return typed.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    case 'attr': {
      if (context.quote === null) return /[\s"'`=<>]/.test(typed) ? null : typed;
      // React decodes entities in a prop's string; MDX, Astro, Vue and Svelte
      // components may get them as written, so the attribute's own quote isn't
      // typed into one of those.
      if (dialect !== 'jsx' && dialect !== 'html' && typed.includes(context.quote)) return null;
      let out = literalAmpersands(typed);
      if (context.quote === '"') out = out.replace(/"/g, '&quot;');
      else if (context.quote === "'") out = out.replace(/'/g, '&#39;');
      else return null;
      // Svelte reads `{…}` inside a quoted value as code.
      if (dialect === 'svelte') out = out.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
      return out;
    }
    case 'markup': {
      let out = literalAmpersands(typed).replace(/</g, '&lt;');
      if (dialect === 'jsx' || dialect === 'mdx') out = out.replace(/>/g, '&gt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
      else if (dialect === 'astro' || dialect === 'svelte') out = out.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
      else if (dialect === 'vue') out = out.replace(/\{\{/g, '&#123;&#123;').replace(/\}\}/g, '&#125;&#125;');
      return out;
    }
    case 'raw':
      return typed.replace(/</g, '&lt;');
    case 'text':
      return typed;
    case 'code':
      return null;
  }
}

export { dialectOf, contextAt, escapeTyped };
