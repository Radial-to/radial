// Direct-write planning for the adjust steppers: decide whether a batch of
// exact style deltas (padding-bottom: 32px → 48px, …) can be expressed in the
// element's source WITHOUT an agent, and produce the concrete edit plans.
//
// The agent path exists because styling idiom varies (Tailwind, inline CSS,
// stylesheets, CSS-in-JS) — but the common cases are deterministic, and for
// those "+48px bottom padding" should be an instant local write, not a model
// call. This module is deliberately conservative: anything ambiguous (py/p
// shorthands covering the changed side, md:/hover: variants, arbitrary
// values, multiple matching CSS rules, non-px units) returns not-plannable
// and the caller falls back to the agent, which stays the generalist.
//
// Pure and DOM-free (same UMD shape as navigation.js) so node can unit-test
// it; the overlay supplies provenance captured at select time.

/** One Design-panel change: the CSS value the element had and the value to write. */
export interface StyleDelta { from: string; to: string }
/** The pending changes by CSS property ('padding-bottom' → { from: '32px', to: '48px' }). */
export type StyleDeltas = Record<string, StyleDelta>;
/** A stylesheet rule that sets one adjustable property on the element (overlay.js readStyleSource). */
export interface StyleRule { prop: string; value: string; selectorText: string; href: string | null }
/** The same, inside an @media block, with whether the block applies at the preview's width. */
export interface MediaStyleRule extends StyleRule {
  media: string;
  active: boolean;
  maxW?: number | null;
  minW?: number | null;
}
/** Where an element's adjustable properties come from, captured when it is selected. */
export interface StyleSource {
  /** The full stylesheet walk ran (not just the fast first payload). */
  _full?: boolean;
  styleAttr?: string;
  rules?: StyleRule[];
  /** The element or a near ancestor carries Tailwind utilities. */
  tw?: boolean;
  mediaRules?: MediaStyleRule[];
  breakpoints?: number[];
  viewportW?: number;
  rootPx?: number;
}
/** The rule an element's own selector lands in, for a new declaration. */
export interface StyleAnchor { selectorText: string; href: string | null }
/** The parts of a canvas selection the planner reads. */
export interface PlanSelection {
  classList?: string[];
  styleSource?: StyleSource;
  adjust?: { fontSize?: number };
  anchor?: StyleAnchor | null;
}
/** A concrete source edit for one property; the main process's editEngine.applyStyleEdits writes it. */
export type StylePlan =
  | { kind: 'inline'; prop: string; to: string; styleAttr: string }
  | { kind: 'class-swap'; prop: string; oldToken: string; newToken: string; classList: string[] }
  | { kind: 'class-add'; prop: string; newToken: string; classList: string[] }
  | { kind: 'css'; prop: string; to: string; from: string; selectorText: string; href: string }
  | { kind: 'css-set'; prop: string; value: string; selectorText: string; href: string }
  | { kind: 'css-set-media'; prop: string; value: string; selectorText: string; href: string; media: string }
  | { kind: 'inline-set'; prop: string; value: string };
export type StylePlanResult = { ok: true; plans: StylePlan[] } | { ok: false; reason: 'nothing-to-do' };
/** The Tailwind prefixes one spacing property owns, and the shorthands that also set it. */
export interface SpacingFamily { exact: string; conflict: string[] }
/** The family's own bare token on an element, or that a shorthand/variant makes a swap unsafe. */
export type FamilyState = { conflicting: true; own?: undefined } | { own: string | null; conflicting: boolean };
/** The element's current token for a property, or that it can't be swapped as one token. */
export type CurrentToken = { conflict: true; token?: undefined } | { token: string | null; conflict?: undefined };
/** The px sizes a rem / em value is relative to. */
export interface UnitContext { rootPx?: number | null; fontPx?: number | null }
/** The rule that wins for a property, flagged by whether it sits in an @media block. */
export type WinningRule = (MediaStyleRule & { isMedia: true }) | (StyleRule & { isMedia: false });

// ── Tailwind value maps (default theme; off-scale values bail to agent) ──
const TW_SPACING: Partial<Record<number, string>> = {
  0: '0', 1: 'px', 2: '0.5', 4: '1', 6: '1.5', 8: '2', 10: '2.5', 12: '3',
  14: '3.5', 16: '4', 20: '5', 24: '6', 28: '7', 32: '8', 36: '9', 40: '10',
  44: '11', 48: '12', 56: '14', 64: '16', 80: '20', 96: '24', 112: '28',
  128: '32', 144: '36', 160: '40', 176: '44', 192: '48', 208: '52',
  224: '56', 240: '60', 256: '64', 288: '72', 320: '80', 384: '96',
};
const TW_TEXT: Partial<Record<number, string>> = { 12: 'xs', 14: 'sm', 16: 'base', 18: 'lg', 20: 'xl', 24: '2xl', 30: '3xl', 36: '4xl', 48: '5xl', 60: '6xl', 72: '7xl', 96: '8xl', 128: '9xl' };
const TW_WEIGHT: Partial<Record<number, string>> = { 100: 'thin', 200: 'extralight', 300: 'light', 400: 'normal', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black' };
const TW_RADIUS: Partial<Record<number, string>> = { 0: 'rounded-none', 2: 'rounded-sm', 4: 'rounded', 6: 'rounded-md', 8: 'rounded-lg', 12: 'rounded-xl', 16: 'rounded-2xl', 24: 'rounded-3xl', 9999: 'rounded-full' };
const TEXT_SIZE_NAMES = new Set(Object.values(TW_TEXT));
const WEIGHT_NAMES = new Set(Object.values(TW_WEIGHT));

// Per-property token families: which bare utility we can swap (`exact`),
// and which sibling utilities make the swap ambiguous (`conflict` — a py-8
// also sets the bottom we're changing; splitting it is the agent's call).
const SPACING_FAMILIES: Partial<Record<string, SpacingFamily>> = {
  'padding-top': { exact: 'pt', conflict: ['py', 'p'] },
  'padding-right': { exact: 'pr', conflict: ['px', 'p'] },
  'padding-bottom': { exact: 'pb', conflict: ['py', 'p'] },
  'padding-left': { exact: 'pl', conflict: ['px', 'p'] },
  'margin-top': { exact: 'mt', conflict: ['my', 'm'] },
  'margin-right': { exact: 'mr', conflict: ['mx', 'm'] },
  'margin-bottom': { exact: 'mb', conflict: ['my', 'm'] },
  'margin-left': { exact: 'ml', conflict: ['mx', 'm'] },
  'gap': { exact: 'gap', conflict: ['gap-x', 'gap-y'] },
};
const ALIGN_TOKENS: Partial<Record<string, Partial<Record<string, string>>>> = {
  'text-align': { left: 'text-left', center: 'text-center', right: 'text-right' },
  'justify-content': { 'flex-start': 'justify-start', center: 'justify-center', 'flex-end': 'justify-end' },
  'align-items': { 'flex-start': 'items-start', center: 'items-center', 'flex-end': 'items-end' },
};

const px = (v: string): number | null => { const m = String(v).match(/^(-?[\d.]+)px$/); return m ? parseFloat(m[1]) : null; };
const normv = (v: string): string => String(v).toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ').trim();
const famEq = (a: string, b: string): boolean => normv(a).split(',')[0].trim() === normv(b).split(',')[0].trim();
const bare = (tok: string): boolean => !tok.includes(':') && !tok.includes('['); // no variants, no arbitrary values

/** The bare token on the element that a family owns (pb-8 for 'pb'), or
 *  null; conflicting = a shorthand/variant that makes swapping unsafe. */
function familyState(classList: string[] | null | undefined, fam: SpacingFamily): FamilyState {
  const list = Array.isArray(classList) ? classList : [];
  // Any variant/arbitrary token touching this family → hands off entirely.
  const touches = (t: string) => {
    const base = t.replace(/^.*:/, '');
    return base === fam.exact || base.startsWith(fam.exact + '-') ||
      fam.conflict.some((c) => base === c || base.startsWith(c + '-'));
  };
  if (list.some((t) => !bare(t) && touches(t))) return { conflicting: true };
  const own = list.find((t) => bare(t) && (t === fam.exact || t.startsWith(fam.exact + '-')) &&
    !fam.conflict.some((c) => t === c || t.startsWith(c + '-')));
  const conflicting = list.some((t) => bare(t) && fam.conflict.some((c) => t === c || t.startsWith(c + '-')));
  return { own: own || null, conflicting };
}

function twTokenFor(prop: string, toValue: string): string | null {
  if (SPACING_FAMILIES[prop]) {
    const n = px(toValue);
    if (n === null || !(n in TW_SPACING)) return null;
    const fam = SPACING_FAMILIES[prop].exact;
    return TW_SPACING[n] === '0' ? `${fam}-0` : `${fam}-${TW_SPACING[n]}`;
  }
  if (prop === 'font-size') {
    const n = px(toValue);
    return n !== null && TW_TEXT[n] ? `text-${TW_TEXT[n]}` : null;
  }
  if (prop === 'font-weight') {
    const w = TW_WEIGHT[parseInt(toValue, 10)];
    return w ? `font-${w}` : null;
  }
  if (prop === 'border-radius') {
    const n = px(toValue);
    return n !== null && TW_RADIUS[n] !== undefined ? TW_RADIUS[n] : null;
  }
  if (ALIGN_TOKENS[prop]) return ALIGN_TOKENS[prop][String(toValue)] || null;
  return null;
}

/** The element's current bare token for prop, for swap-style plans. */
function currentToken(prop: string, classList: string[] | null | undefined): CurrentToken {
  const list = Array.isArray(classList) ? classList : [];
  if (SPACING_FAMILIES[prop]) {
    const st = familyState(list, SPACING_FAMILIES[prop]);
    if (st.conflicting) return { conflict: true };
    return { token: st.own };
  }
  if (prop === 'font-size') {
    const t = list.find((c) => bare(c) && /^text-/.test(c) && TEXT_SIZE_NAMES.has(c.slice(5)));
    return { token: t || null };
  }
  if (prop === 'font-weight') {
    const t = list.find((c) => bare(c) && /^font-/.test(c) && WEIGHT_NAMES.has(c.slice(5)));
    return { token: t || null };
  }
  if (prop === 'border-radius') {
    // Per-corner tokens (rounded-t-lg) make the shorthand swap unsafe.
    const corner = list.some((c) => bare(c) && /^rounded-(t|b|l|r|tl|tr|bl|br)(-|$)/.test(c));
    if (corner) return { conflict: true };
    const t = list.find((c) => bare(c) && (c === 'rounded' || (/^rounded-/.test(c) && ['none', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', 'full'].includes(c.split('-')[1]))));
    return { token: t || null };
  }
  if (ALIGN_TOKENS[prop]) {
    const vals = Object.values(ALIGN_TOKENS[prop]);
    return { token: list.find((c) => vals.includes(c)) || null };
  }
  return { token: null };
}

const declRe = (prop: string): RegExp => new RegExp(`(^|;)\\s*${prop.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*:`, 'i');

// ── The ladder never ends at the agent ─────────────────────────────────────
// A Design-panel value IS the change: it writes on commit and ⌘Z
// undoes it. So every prop resolves to a deterministic write, in this order:
//   1. the element's own style="" declaration
//   2. Tailwind: swap the winning token (a desktop min-width variant, the
//      element's own token — scale or arbitrary), or ADD the longhand when a
//      shorthand (py-8) covers the side (longhands win in Tailwind's order);
//      off-scale values become arbitrary tokens (pt-[13px])
//   3. the authored CSS rule that WINS for this element (active media rule
//      first, then specificity, then source order), written in the author's
//      unit (1rem stays rem) — media rules write into their @media block
//   4. the element's own anchor rule (new declaration) when provenance is complete
//   5. an inline declaration on the pinned element — always expressible
// Only bundler-hashed stylesheets are skipped (not source); they fall to 5.
const BP_ORDER = ['sm', 'md', 'lg', 'xl', '2xl'];
const hashy = (href: string | null | undefined): boolean => !!href && /-[a-f0-9]{6,}\.css/i.test(href);
function arbitraryTokenFor(prop: string, toValue: string): string | null {
  const v = String(toValue).trim();
  if (SPACING_FAMILIES[prop]) return /^-?[\d.]+px$/.test(v) ? SPACING_FAMILIES[prop].exact + '-[' + v + ']' : null;
  if (prop === 'font-size') return /^[\d.]+px$/.test(v) ? 'text-[' + v + ']' : null;
  if (prop === 'font-weight') return /^\d{3}$/.test(v) ? 'font-[' + v + ']' : null;
  if (prop === 'border-radius') return /^[\d.]+px$/.test(v) ? 'rounded-[' + v + ']' : null;
  return null;
}
// The element's OWN token for a family — scale or arbitrary (pt-4, pt-[13px]).
function ownToken(list: string[], fam: string): string | null { return list.find((t) => !t.includes(':') && (t === fam || t.startsWith(fam + '-'))) || null; }
// The widest min-width breakpoint variant on the family: at desktop it is
// the value the user is looking at, so it is the token to swap.
function desktopVariant(list: string[], fam: string): { token: string; variant: string } | null {
  let best: { token: string; variant: string } | null = null, bi = -1;
  for (const t of list) {
    const m = /^([a-z0-9]+):(.+)$/.exec(t); if (!m) continue;
    const i = BP_ORDER.indexOf(m[1]); if (i < 0) continue;
    if (!(m[2] === fam || m[2].startsWith(fam + '-'))) continue;
    if (i > bi) { bi = i; best = { token: t, variant: m[1] }; }
  }
  return best;
}
// A px target in the unit the author used: 24px against "1rem" → 1.5rem.
function unitize(toValue: string, authored: string, ctx: UnitContext): string {
  const n = px(toValue); if (n === null) return String(toValue);
  const m = /^-?[\d.]+(rem|em)$/.exec(String(authored).trim()); if (!m) return String(toValue);
  const base = m[1] === 'rem' ? (ctx.rootPx || 16) : (ctx.fontPx || ctx.rootPx || 16);
  if (!(base > 0)) return String(toValue);
  const r = Math.round((n / base) * 1000) / 1000;
  return (String(r).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') || '0') + m[1];
}
// Enough specificity to edit the rule that WINS, not the first one listed.
function specificity(sel: string | null | undefined): number {
  const s = String(sel || '').replace(/::[a-z-]+/gi, '');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const cls = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!not\()[a-z-]+/gi) || []).length;
  const tags = (s.match(/(^|[\s>+~,(])[a-z][\w-]*/gi) || []).length;
  return ids * 10000 + cls * 100 + tags;
}
function winningRule(src: StyleSource, prop: string): WinningRule | null {
  const pick = <R extends StyleRule>(list: R[]): R | null => { let w: R | null = null; for (const r of list) if (!w || specificity(r.selectorText) >= specificity(w.selectorText)) w = r; return w; };
  const m = pick((src.mediaRules || []).filter((r) => r.prop === prop && r.active));
  if (m) return Object.assign({}, m, { isMedia: true as const });
  const b = pick((src.rules || []).filter((r) => r.prop === prop));
  return b ? Object.assign({}, b, { isMedia: false as const }) : null;
}

/**
 * Build direct-edit plans for a delta batch. Always ok for a pinnable element;
 * only 'nothing-to-do' (every delta already expressed) comes back false.
 * @param {Object} deltas       { 'padding-bottom': { from:'32px', to:'48px' }, … }
 * @param {Object} sel          the selection payload: classList + styleSource (+ adjust.fontSize)
 * @returns {{ ok:true, plans:[] } | { ok:false, reason:string }}
 */
function plan(deltas: StyleDeltas | null | undefined, sel: PlanSelection | null | undefined): StylePlanResult {
  const src: StyleSource = (sel && sel.styleSource) || {};
  const classList = (sel && sel.classList) || [];
  const ctx = { rootPx: src.rootPx, fontPx: sel && sel.adjust && sel.adjust.fontSize };
  const authored = (prop: string) => (src.rules || []).some((r) => r.prop === prop) || (src.mediaRules || []).some((r) => r.prop === prop && r.active);
  const plans: StylePlan[] = [];
  for (const [prop, d] of Object.entries(deltas || {})) {
    // 1) own style="" declaration
    if (src.styleAttr && declRe(prop).test(src.styleAttr)) { plans.push({ kind: 'inline', prop, to: d.to, styleAttr: src.styleAttr }); continue; }
    // 2) Tailwind idiom
    const newToken = twTokenFor(prop, d.to) || arbitraryTokenFor(prop, d.to);
    const fam = SPACING_FAMILIES[prop];
    if (fam && newToken) {
      const dv = desktopVariant(classList, fam.exact);
      if (dv) { const nt = dv.variant + ':' + newToken; if (nt !== dv.token) plans.push({ kind: 'class-swap', prop, oldToken: dv.token, newToken: nt, classList }); continue; }
      const own = ownToken(classList, fam.exact);
      if (own) { if (own !== newToken) plans.push({ kind: 'class-swap', prop, oldToken: own, newToken, classList }); continue; }
      const shorthand = classList.some((t) => !t.includes(':') && fam.conflict.some((c) => t === c || t.startsWith(c + '-')));
      if ((shorthand || src.tw) && !authored(prop)) { plans.push({ kind: 'class-add', prop, newToken, classList }); continue; }
    } else if (!fam && newToken) {
      const cur = currentToken(prop, classList);
      if (!cur.conflict && cur.token) { if (cur.token !== newToken) plans.push({ kind: 'class-swap', prop, oldToken: cur.token, newToken, classList }); continue; }
      if (!cur.conflict && src.tw && classList.length && !authored(prop)) { plans.push({ kind: 'class-add', prop, newToken, classList }); continue; }
      // a per-corner radius etc. (cur.conflict) falls through to CSS / inline
    }
    // 3) the authored rule that wins, in the author's unit
    const w = winningRule(src, prop);
    if (w && w.href && !hashy(w.href)) {
      if (!w.isMedia && px(w.value) !== null && px(w.value) === px(d.from)) { plans.push({ kind: 'css', prop, to: d.to, from: w.value, selectorText: w.selectorText, href: w.href }); continue; }
      const value = unitize(d.to, w.value, ctx);
      plans.push(w.isMedia
        ? { kind: 'css-set-media', prop, value, selectorText: w.selectorText, href: w.href, media: w.media }
        : { kind: 'css-set', prop, value, selectorText: w.selectorText, href: w.href });
      continue;
    }
    // 4) nothing authored: the element's own rule, on complete provenance
    if (!w && src._full && !src.tw && sel && sel.anchor && sel.anchor.selectorText && sel.anchor.href && !hashy(sel.anchor.href)) {
      plans.push({ kind: 'css-set', prop, value: d.to, selectorText: sel.anchor.selectorText, href: sel.anchor.href }); continue;
    }
    // 5) terminal: an inline declaration on the pinned element
    plans.push({ kind: 'inline-set', prop, value: d.to });
  }
  if (!plans.length) return { ok: false, reason: 'nothing-to-do' };
  return { ok: true, plans };
}

export { plan, twTokenFor, familyState, currentToken, TW_SPACING, unitize, specificity, winningRule };
