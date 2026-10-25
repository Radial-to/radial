/**
 * Fuzzy matching for the command palette, project search, and page filter.
 *
 * Every whitespace-separated query token must match the candidate somewhere;
 * tokens can arrive in any order ("site summit" finds "summit-site"). A token
 * matches by substring (best — with a word-start bonus and an earlier-is-better
 * nudge) or by in-order subsequence (weakest, penalized per gap), so "mmsite"
 * still finds "moment-marketing-site" while ranked below real substrings.
 *
 * Shared like navigation.ts: the window gets window.RadialFuzzy, the main
 * process and tests import it (see DUAL in scripts/transpile.mts).
 */
const BOUNDARY = /[\s\-_/.:,()]/;

function tokenScore(token: string, text: string): number {
  const idx = text.indexOf(token);
  if (idx !== -1) {
    const atWordStart = idx === 0 || BOUNDARY.test(text[idx - 1]);
    return 100 + (atWordStart ? 40 : 0) - Math.min(idx, 30);
  }
  // In-order subsequence, penalized by gap size, bonused at word starts.
  let ti = 0, score = 60, last = -1;
  for (let i = 0; i < text.length && ti < token.length; i++) {
    if (text[i] === token[ti]) {
      if (last !== -1) score -= Math.min(i - last - 1, 8);
      if (i === 0 || BOUNDARY.test(text[i - 1])) score += 6;
      last = i; ti++;
    }
  }
  return ti === token.length ? Math.max(score, 1) : -1;
}

/** Match score for query against text, or -1 when any token misses. */
export function score(query: string | null | undefined, text: unknown): number {
  const t = String(text || '').toLowerCase();
  const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  let total = 0;
  for (const tok of tokens) {
    const s = tokenScore(tok, t);
    if (s < 0) return -1;
    total += s;
  }
  return total - Math.min(t.length, 60) / 10; // shorter candidates edge ahead on ties
}

/**
 * Items matching query, best first; empty query returns items unchanged.
 * `bonusFn(item)` adds rank outside the text match — e.g. recency, so among
 * four near-identical client sites the one worked on recently tops the list.
 * Without `keyFn` each item is matched as text itself.
 */
export function filter<T>(
  query: string | null | undefined,
  items: readonly T[],
  keyFn?: (item: T) => string,
  bonusFn?: (item: T) => number | null | undefined,
): T[] {
  if (!String(query || '').trim()) return items.slice();
  const scored: { item: T; s: number; i: number }[] = [];
  items.forEach((item, i) => {
    const s = score(query, keyFn ? keyFn(item) : item);
    if (s >= 0) scored.push({ item, s: s + (bonusFn ? bonusFn(item) || 0 : 0), i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map((x) => x.item);
}

/** Rank bonus for a last-used timestamp: just-used ≫ this week ≫ long ago. */
export function recencyBonus(ts: number | null | undefined): number {
  if (!ts) return 0;
  const h = (Date.now() - ts) / 3.6e6;
  if (h < 1) return 34;
  if (h < 6) return 28;
  if (h < 24) return 22;
  if (h < 24 * 7) return 14;
  if (h < 24 * 30) return 6;
  return 0;
}
