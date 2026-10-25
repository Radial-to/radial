// Offset-precise element scanner for HTML and JSX. Turns source text into a
// tree of nodes with exact character ranges — the foundation for deterministic
// structural edits (move/insert/remove/wrap/unwrap) that don't care how the
// markup is formatted: one element per line, many per line, minified, or
// hand-written with inline tags all resolve the same.
//
// Deliberately lightweight (NOT a spec-complete parser): it understands tags,
// quoted attributes, JSX `{…}` expressions (as opaque, so `{a > b}` and
// `{items.map(i => <X/>)}` never fool the tag scan), comments, self-closing and
// void elements, and recovers from unclosed tags. It does not evaluate JSX —
// an element rendered from inside a `{…}` expression is intentionally invisible
// to it, so mapped content shows up as a source/DOM child-count mismatch (the
// one honestly non-deterministic case) rather than a wrong edit.

/** An element with exact source offsets. */
export interface HtmlNode {
  /** Lowercased source tag name (`div`, `motion.div`, `mycomponent`). */
  tag: string;
  /** The DOM tag it renders as (`motion.div` renders a `div`). */
  renderTag: string;
  openStart: number;
  openEnd: number;
  /** Null until the close tag is found (void, self-closing or unclosed elements). */
  closeStart: number | null;
  closeEnd: number | null;
  /** Just past the element: closeEnd for containers, openEnd for void/self-closing. */
  end: number;
  selfClosing: boolean;
  isVoid: boolean;
  /** The raw open-tag text. */
  open: string;
  children: HtmlNode[];
  parent: HtmlNode | null;
}

/** parseNodes()'s forest, with the source it indexes. */
export interface ParsedHtml {
  roots: HtmlNode[];
  src: string;
}

interface OpenTag {
  tagName: string;
  openEnd: number;
  selfClosing: boolean;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Raw-text / RCDATA elements whose content must NOT be parsed as markup.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
// The DOM tag an element renders as. Framer Motion's `motion.div` / `m.div` and
// react-spring's `animated.div` render the suffix element; the source resolver
// matches DOM paths (which see `div`) against this, not the raw JSX name.
function renderTagOf(tag: string): string { const m = /^(?:motion|m|animated)\.([a-z][a-z0-9]*)$/.exec(tag); return m ? m[1] : tag; }

// Walk a quoted string starting at the quote char; returns the index just past
// the closing quote. Template literals (`) may nest `${…}`; we skip those.
function skipString(src: string, i: number): number {
  const q = src[i]; i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (q === '`' && c === '$' && src[i + 1] === '{') { i = skipBraces(src, i + 1); continue; }
    if (c === q) return i + 1;
    i++;
  }
  return i;
}

// A `//` line or `/* */` block comment starting at `i`; returns the index just
// past it, or -1 if `i` isn't a comment start. `//` and `/*` are unambiguous
// (an empty regex is written `/(?:)/`, never `//`), so this never misfires on
// division or a regex literal — it only ever skips a genuine comment.
function skipComment(src: string, i: number): number {
  if (src[i] !== '/') return -1;
  const n = src[i + 1];
  if (n === '/') { const e = src.indexOf('\n', i + 2); return e < 0 ? src.length : e + 1; }
  if (n === '*') { const e = src.indexOf('*/', i + 2); return e < 0 ? src.length : e + 2; }
  return -1;
}

// A regex literal whose `/` is at `i`; returns the index just past its closing
// `/` + flags, or -1 if this `/` is division. Position decides: right after an
// operator/opener/keyword (`= ( , : [ ! & | ? { ; return typeof …`) a `/` starts
// a regex; after a value (identifier, number, `)`, `]`) it divides. Inside the
// literal a `[…]` class may hold an unescaped `/`, `\\` escapes anything, and a
// newline means it wasn't a regex after all. Without this, `.replace(/"/g, …)`
// or `(['"]?)` in a regex flips string-parity for the REST of the file and
// every tag between string literals is silently eaten.
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'instanceof', 'yield', 'await', 'else', 'do']);
function skipRegex(src: string, i: number): number {
  // `</li>` and `"/>` in JSX close tags, never start a regex: reading them as one
  // ran past the expression's closing `}` and swallowed everything after it. A
  // regex can't follow a string or an attribute's `{…}`, but `/>/g` after `(` is one.
  if (src[i - 1] === '<') return -1;
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (src[i + 1] === '>' && j >= 0 && /["'`}]/.test(src[j])) return -1;
  if (j >= 0 && /[A-Za-z0-9_$)\]]/.test(src[j])) {
    if (!/[A-Za-z_$]/.test(src[j])) return -1;
    let k = j; while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
    if (!REGEX_KEYWORDS.has(src.slice(k + 1, j + 1))) return -1;
  }
  let k = i + 1, inClass = false;
  while (k < src.length) {
    const c = src[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '\n') return -1;
    if (inClass) { if (c === ']') inClass = false; k++; continue; }
    if (c === '[') { inClass = true; k++; continue; }
    if (c === '/') { k++; while (k < src.length && /[a-z]/i.test(src[k])) k++; return k; }
    k++;
  }
  return -1;
}

// Walk a `{…}` region starting at the `{`; returns the index just past the
// matching `}`. Quote-, comment-, regex- and nested-brace-aware so JSX expressions are
// opaque — a `}` or quote inside a string or comment must not close the region.
function skipBraces(src: string, i: number): number {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/') { const j = skipComment(src, i); if (j >= 0) { i = j; continue; } const r = skipRegex(src, i); if (r >= 0) { i = r; continue; } }
    // JSX inside the expression (`{open && <p>It's here</p>}`): its text is text, not code.
    if (c === '<' && jsxStarts(src, i)) { const j = skipJsx(src, i); if (j > i) { i = j; continue; } }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return i;
}

// Whether the `<` at `i` opens JSX: an element or fragment where an expression
// can start (after `( , = ? : & | ! { [ ;`, an arrow, or `return`), never
// `a < b` or `useState<T>`.
const JSX_KEYWORDS = new Set(['return', 'yield', 'await', 'default']);
function jsxStarts(src: string, i: number): boolean {
  if (!/[A-Za-z>]/.test(src[i + 1] || '')) return false;
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  if ('(,=?:&|!{[;'.includes(src[j])) return true;
  if (src[j] === '>' && src[j - 1] === '=') return true;
  if (/[A-Za-z_$]/.test(src[j])) {
    let k = j; while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
    return JSX_KEYWORDS.has(src.slice(k + 1, j + 1));
  }
  return false;
}

// From the `<` of a JSX element (or `<>` fragment) inside an expression, the
// index just past its matching close, or -1 when it isn't an element after
// all. Inside, text is text (quotes included), `{…}` nests, and tags count up
// and down. A void tag written the HTML way (`<br>`, `<img …>`: Astro and
// Svelte allow it) has no close to wait for; a component with a void tag's
// name in capitals (`<Link>`) does.
function skipJsx(src: string, lt: number): number {
  let depth = 0;
  let i = lt;
  while (i < src.length) {
    const c = src[i];
    if (c === '{' && depth > 0) { i = skipBraces(src, i); continue; }
    if (c === '<') {
      if (src[i + 1] === '>') { depth++; i += 2; continue; }
      const close = /^<\/\s*(?:[a-zA-Z][\w.-]*)?\s*>/.exec(src.slice(i, i + 80));
      if (close) { depth--; i += close[0].length; if (depth <= 0) return i; continue; }
      const open = readOpenTag(src, i);
      if (open) {
        if (!open.selfClosing && !VOID.has(open.tagName)) depth++;
        i = open.openEnd;
        if (depth === 0) return i;
        continue;
      }
      if (depth === 0) return -1;
    }
    if (depth === 0) return -1;
    i++;
  }
  return i;
}

// From the `<` of an open tag, find the end of the open tag. Returns
// { tagName, openEnd (index past '>'), selfClosing } or null if not a tag.
function readOpenTag(src: string, lt: number): OpenTag | null {
  let i = lt + 1;
  const m = /^[a-zA-Z][\w.-]*/.exec(src.slice(i, i + 60));
  if (!m) return null;
  const tagName = m[0];
  i += tagName.length;
  // A real open tag's name is immediately followed by whitespace, `/`, or `>`.
  // Anything else means this `<` starts a TS generic or a comparison, not a tag:
  // `Record<string, {…}>` would otherwise read as an element named `string` and
  // flip the scanner into element state, swallowing the real JSX below it.
  if (i < src.length && !/[\s/>]/.test(src[i])) return null;
  while (i < src.length) {
    const c = src[i];
    // A JS comment between attributes is legal JSX (`// note` / `/* note */` on
    // its own line inside the tag) — skip it, or an apostrophe in it starts a
    // string skip and the tag never closes. Only when the `/` starts a token,
    // so `href=//cdn…` and `/>` are untouched.
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*') && /\s/.test(src[i - 1] || ' ')) { i = skipComment(src, i); continue; }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '{') { i = skipBraces(src, i); continue; }
    if (c === '>') {
      const selfClosing = src[i - 1] === '/';
      return { tagName, openEnd: i + 1, selfClosing };
    }
    i++;
  }
  return null; // unterminated open tag
}

/**
 * Parse `src` into a forest of element nodes with exact offsets.
 * Node = { tag, renderTag, openStart, openEnd, closeStart, closeEnd, end, selfClosing,
 *          isVoid, open (raw open-tag text), children, parent }
 * `end` is the offset just past the element (closeEnd for containers, openEnd
 * for void/self-closing). Text and JSX expressions between elements are ignored.
 */
function parseNodes(src: string): ParsedHtml {
  const roots: HtmlNode[] = [];
  const stack: HtmlNode[] = []; // open container nodes
  const push = (node: HtmlNode) => { (stack.length ? stack[stack.length - 1].children : roots).push(node); node.parent = stack.length ? stack[stack.length - 1] : null; };
  let i = 0;
  while (i < src.length) {
    const inEl = stack.length > 0;
    const c = src[i];
    // A `{…}` is a JSX EXPRESSION only inside an element (child position) — skip
    // it so a `{items.map(<X/>)}` stays opaque. At the top level of a .tsx file
    // the braces are the component's function body, which CONTAINS the JSX, so
    // we must NOT swallow them — advance through and let the tags surface.
    if (c === '{') { i = inEl ? skipBraces(src, i) : i + 1; continue; }
    // Top-level JS/TS code: skip `//` and `/* */` comments FIRST, so an
    // apostrophe in a comment ("the section's edge") or a stray `<` in one can't
    // start a string skip or a bogus tag. Only at top level — in JSX text `//`
    // is just text (e.g. a URL) and must be left alone.
    if (!inEl && c === '/') { const j = skipComment(src, i); if (j >= 0) { i = j; continue; } const r = skipRegex(src, i); if (r >= 0) { i = r; continue; } }
    // JS string literals (top-level code) can hold a stray `<`; skip them. In
    // element text position a quote is just text (an apostrophe in copy must not
    // start a string skip that eats the next tag), so we only skip at top level.
    if (!inEl && (c === '"' || c === "'" || c === '`')) { i = skipString(src, i); continue; }
    if (c !== '<') { i++; continue; }
    // Comment?
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<!', i)) { const e = src.indexOf('>', i + 2); i = e < 0 ? src.length : e + 1; continue; } // doctype
    // Close tag?
    if (src[i + 1] === '/') {
      const m = /^<\/\s*([a-zA-Z][\w.-]*)\s*>/.exec(src.slice(i, i + 80));
      if (!m) { i++; continue; }
      const name = m[1].toLowerCase();
      const closeEnd = i + m[0].length;
      // Close the nearest matching open on the stack (auto-closing anything
      // left dangling in between — recovery for imperfect markup).
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].tag === name) {
          const node = stack[s];
          node.closeStart = i; node.closeEnd = closeEnd; node.end = closeEnd;
          stack.length = s; // pop it and anything unclosed above it
          break;
        }
      }
      i = closeEnd;
      continue;
    }
    // Top-level generic/comparison, not a tag: a `<` glued to a preceding
    // identifier / `)` / `]` is `Promise<void>`, `Array<string>`, `useRef<T>`,
    // `foo<T>(…)`, `x<y` — never a JSX open (you never write `foo<div>`). Only
    // when NOT inside an element, since element TEXT may legitimately run text
    // into a child tag ("Price 5<sup>th</sup>"). Without this a phantom
    // <void>/<string> element opens and swallows the real JSX after it.
    if (!inEl) { const p = src[i - 1]; if (p && /[A-Za-z0-9_$)\]]/.test(p)) { i++; continue; } }
    // Open tag?
    const open = readOpenTag(src, i);
    if (!open) { i++; continue; }
    const tag = open.tagName.toLowerCase();
    const node: HtmlNode = {
      tag, renderTag: renderTagOf(tag), openStart: i, openEnd: open.openEnd,
      closeStart: null, closeEnd: null, end: open.openEnd,
      selfClosing: open.selfClosing, isVoid: VOID.has(tag),
      open: src.slice(i, open.openEnd), children: [], parent: null,
    };
    push(node);
    if (!open.selfClosing && !node.isVoid) {
      // Raw-text elements (script, style, textarea, title): their content is
      // NOT markup — CSS braces/comments and JS strings/regex would derail the
      // tag scan (and can swallow the rest of the document). Skip straight to
      // the matching close tag, treating everything between as opaque.
      if (RAW_TEXT.has(tag)) {
        const rest = src.slice(open.openEnd);
        const m = rest.match(new RegExp(`</${tag}(?=[\\s>])`, 'i'));
        if (m) {
          const cs = open.openEnd + m.index!;
          const gt = src.indexOf('>', cs);
          node.closeStart = cs; node.closeEnd = (gt < 0 ? src.length : gt + 1); node.end = node.closeEnd;
          i = node.closeEnd; continue;
        }
        i = open.openEnd; continue; // unclosed raw element — stop descending into it
      }
      stack.push(node);
    }
    i = open.openEnd;
  }
  return { roots, src };
}

// The skippers are sourceContext.ts's too: it walks code and markup the same way.
export { parseNodes, VOID, skipBraces, skipComment, skipRegex, skipString, jsxStarts, skipJsx };
