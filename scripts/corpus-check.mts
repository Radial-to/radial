#!/usr/bin/env node
// Corpus reliability gate for the structural editor — runs the deterministic
// engine against EVERY real site in a folder (CORPUS_DIR: Next, Astro, Vite,
// static HTML; Tailwind-heavy, Framer Motion, cn()/clsx, mapped lists) and
// reports the things a design tool must never do:
//   A. PARSE — a component file with real JSX that scans to ZERO nodes (a
//      swallow: comment apostrophes, generics, regex-with-quotes…), phantom
//      tags, or an element slice that doesn't round-trip.
//   B. OPS   — insert / wrap / remove / reorder on sampled real elements: an
//      unprincipled bail, invalid output, a broken UNDO contract (prevContent),
//      or a stale snapshot on rapid same-size moves.
//   C. EDITS — the T tool (applyTextEdit) and adjust class-swap (applyStyleEdits)
//      with the structural path the overlay sends: an edit that lands in the
//      WRONG file or WRONG element (a twin) is a hard failure.
// It is not part of `npm test` (it needs the local corpus); run it before a
// release that touches htmlScan / editInsert / editEngine:
//   CORPUS_DIR=/path/to/sites npm run test:corpus   (skips cleanly without it)
//   CORPUS_DIR=/path/to/sites npm run test:corpus -- --all   (include monorepos)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// The engine's own types (src/main/htmlScan.ts, editInsert.ts and editEngine.ts,
// src/shared/radialApi.ts) can't be imported here: the scripts project reads
// src/ as CommonJS, where their ES exports are errors (TS1295). These restate
// the parts this gate passes in and reads back, and the test project, which
// can import src/, checks them against the real modules
// (test/support/corpusCheckTypes.ts).
// TODO: import the engine's types once the scripts project reads src/ as ES modules.
/** An element with exact source offsets (htmlScan HtmlNode). */
interface HtmlNode {
  tag: string;
  renderTag: string;
  openStart: number;
  openEnd: number;
  closeStart: number | null;
  closeEnd: number | null;
  end: number;
  selfClosing: boolean;
  isVoid: boolean;
  open: string;
  children: HtmlNode[];
  parent: HtmlNode | null;
}
/** parseNodes()'s forest (htmlScan ParsedHtml). */
export interface ParsedHtml { roots: HtmlNode[]; src: string }
/**
 * One level of an element's structural path (radialApi ElementPathLevel), as
 * pathFrom derives it from source. `id` is null when the element has none, as
 * the overlay sends it.
 */
interface PathLevel { tag: string; id: string | null; cls: string[]; own: string; nth: number; cnt: number; twins: number }
/** An element as the resolvers take it (radialApi ElementContext), the fields this gate sets. */
interface ElementContext { tagName: string; path: PathLevel[]; classList?: string[]; id?: string | null; preferFile?: string }
type InsertPosition = 'before' | 'after' | 'inside';
/** A file the engine wrote, with both contents for undo (editEngine WrittenFileEdit). */
interface WrittenFileEdit { ok: true; file: string; relFile: string; line?: number; prevContent: string; newContent: string }
/** editInsert's StructuralEditOutcome. */
type StructuralEditOutcome =
  | (WrittenFileEdit & { line: number; wrapperClass?: string })
  | { ok: false; reason: 'bad-args' | 'unclosed' | 'count-mismatch' | 'no-anchor' | 'void-parent' | 'cross-file' | 'nested' | 'no-children' };
type StructuralEditDone = Extract<StructuralEditOutcome, { ok: true }>;
/** editEngine's TextEditOutcome: a success carries both contents unless it was a dry run. */
type TextEditOutcome =
  | { ok: true; file: string; relFile: string; line: number; prevContent?: string; newContent?: string }
  | { ok: false; reason: string };
/** editEngine's StyleEditOutcome. */
type StyleEditOutcome = { ok: true; summary: string; files: WrittenFileEdit[] } | { ok: false; reason: string; message?: string };
/** A Tailwind class swap (adjustDirect StylePlan, kind 'class-swap'). */
interface ClassSwapPlan { kind: 'class-swap'; prop: string; oldToken: string; newToken: string; classList: string[] }
// The two modules' functions are typed as properties, not methods, so the test
// project's check compares their parameters strictly: a field the engine starts
// to require and this gate doesn't send is an error there.
/** What this gate calls in editInsert.ts. */
export interface EditInsert {
  applyInsert: (repoDir: string, spec: { anchor: ElementContext; position: InsertPosition; markup: string; preferFile?: string | null }) => StructuralEditOutcome;
  applyMove: (repoDir: string, spec: { subject: ElementContext; target: ElementContext; position: InsertPosition; preferFile?: string | null }) => StructuralEditOutcome;
  applyRemove: (repoDir: string, spec: { subject: ElementContext; preferFile?: string | null }) => StructuralEditOutcome;
  applyWrap: (repoDir: string, spec: { subject: ElementContext; preferFile?: string | null }) => StructuralEditOutcome;
}
/** What this gate calls in editEngine.ts. */
export interface EditEngine {
  listSourceFiles: (repoDir: string) => string[];
  applyTextEdit: (repoDir: string, edit: { originalText: string; newText: string; context?: ElementContext }) => TextEditOutcome;
  applyStyleEdits: (repoDir: string, plans: ClassSwapPlan[], domContext?: ElementContext) => StyleEditOutcome;
}
/** One site's counts (a row of the report); the TOTAL row sums them. */
interface Tally {
  files: number; nodes: number; swallow: number; phantom: number; rt: number;
  ops: number; ok: number; princ: number; unpr: number; bad: number;
  txt: number; txtOk: number; txtBad: number; sty: number; styOk: number; styBad: number;
}
interface SiteRow extends Tally { site: string }

const require = createRequire(import.meta.url);
const insert = require('../src/main/editInsert') as EditInsert;
const engine = require('../src/main/editEngine') as EditEngine;
const { parseNodes } = require('../src/main/htmlScan') as { parseNodes(src: string): ParsedHtml };

const ROOT = process.env.CORPUS_DIR || '';
const ALL = process.argv.includes('--all');
if (!ROOT || !fs.existsSync(ROOT)) { console.log('corpus-check: set CORPUS_DIR to a folder of real sites — skipped'); process.exit(0); }

const SKIP_DIRS = new Set(['node_modules', 'apps', 'packages']);
// App monorepos (an apps/ or packages/ folder) are big: skipped unless --all, and sampled lighter.
const isMonorepo = (name: string): boolean => ['apps', 'packages'].some((d) => fs.existsSync(path.join(ROOT, name, d)));
const COPY_SKIP = new Set(['node_modules', '.next', '.git', '.radial', 'public', 'dist', '.vercel', '.astro', '.turbo']);
const PRINCIPLED = new Set(['count-mismatch', 'no-anchor', 'unclosed', 'nested', 'void-parent', 'cross-file', 'no-children']);
const HTML = new Set(('html head body title base link meta style script noscript template slot main section nav article aside header footer h1 h2 h3 h4 h5 h6 hgroup address p hr pre blockquote ol ul menu li dl dt dd figure figcaption div a em strong small s cite q dfn abbr ruby rt rp data time code var samp kbd sub sup i b u mark bdi bdo span br wbr ins del picture source img iframe embed object param video audio track map area table caption colgroup col tbody thead tfoot tr td th form label input button select datalist optgroup option textarea output progress meter fieldset legend details summary dialog canvas svg math path circle rect g defs use line polyline polygon ellipse text tspan mask pattern filter image marker symbol stop desc metadata switch view fragment component transition portal').split(/\s+/));
const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'li', 'button', 'blockquote', 'figcaption', 'td', 'th', 'label', 'small', 'strong', 'em', 'dt', 'dd', 'summary']);
const SP_RE = /^(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|gap|gap-x|gap-y|space-y|space-x)-(\d+)$/;
const ENT: Partial<Record<string, string>> = { rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', amp: '&', mdash: '—', ndash: '–', hellip: '…', nbsp: ' ', quot: '"', lt: '<', gt: '>', copy: '©', reg: '®', trade: '™' };

const flat = (t: ParsedHtml): HtmlNode[] => { const o: HtmlNode[] = []; const w = (ns: HtmlNode[]) => ns.forEach((n) => { o.push(n); w(n.children); }); w(t.roots); return o; };
const rt = (x: HtmlNode): string => x.renderTag || x.tag;
const own = (n: HtmlNode, s: string): string => { let t = '', c = n.openEnd; for (const ch of n.children) { t += s.slice(c, ch.openStart); c = ch.end; } t += s.slice(c, n.closeStart == null ? n.end : n.closeStart); return t.replace(/\s+/g, ' ').trim(); };
const cls = (o: string): string[] => { const m = o.match(/(?:class|className)\s*=\s*(["'`])([^"'`]*)\1/); return m ? m[2].split(/\s+/).filter((c) => c && !c.includes('{') && !c.includes('$')) : []; };
const idOf = (o: string): string | null => { const m = o.match(/\bid\s*=\s*["'`]([^"'`]+)["'`]/); return m ? m[1] : null; };
const bounded = (n: HtmlNode): boolean => n.selfClosing || n.isVoid || n.closeStart != null;
const decode = (s: string): string => s.replace(/&#39;/g, "'").replace(/&#x27;/gi, "'").replace(/&([a-z]+);/gi, (m: string, k: string) => ENT[k] ?? m).replace(/\s+/g, ' ').trim();
const reparses = (s: string): boolean => { try { return parseNodes(s).roots.length > 0; } catch { return false; } };
const changeAt = (a: string, b: string): number => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
// The overlay's structural path, derived from source (twins = same-tag siblings with this class set).
function pathFrom(n: HtmlNode, s: string): PathLevel[] {
  const out: PathLevel[] = []; let x: HtmlNode | null = n;
  while (x) {
    const sibs: HtmlNode[] = x.parent ? x.parent.children : [x]; let nth = 0, cnt = 0, twins = 0; const myc = cls(x.open).join(' ');
    for (const c of sibs) if (rt(c) === rt(x)) { if (c === x) nth = cnt; cnt++; if (cls(c.open).join(' ') === myc) twins++; }
    out.push({ tag: rt(x), id: idOf(x.open), cls: cls(x.open), own: own(x, s).slice(0, 60), nth, cnt, twins }); x = x.parent;
  }
  return out;
}
const good = (n: HtmlNode, s: string) => n.parent && bounded(n) && n.end - n.openStart < 6000 && (idOf(n.open) || cls(n.open).length || own(n, s).length >= 6) && /^[a-z][a-z0-9.]*$/.test(n.tag);
const spread = <T,>(arr: T[], k: number): T[] => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / k)) === 0).slice(0, k);
function tmpFile(rel: string, src: string): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-')); const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, src); return d; }
function copySite(dir: string): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-')); fs.cpSync(dir, d, { recursive: true, filter: (s) => !COPY_SKIP.has(path.basename(s)) }); return d; }

const sites = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name) && !d.name.startsWith('.') && (ALL || !isMonorepo(d.name))).map((d) => d.name).sort();
const fails: string[] = []; const rows: SiteRow[] = [];
let T: Tally = { files: 0, nodes: 0, swallow: 0, phantom: 0, rt: 0, ops: 0, ok: 0, princ: 0, unpr: 0, bad: 0, txt: 0, txtOk: 0, txtBad: 0, sty: 0, styOk: 0, styBad: 0 };

for (const s of sites) {
  const dir = path.join(ROOT, s);
  const files = engine.listSourceFiles(dir).filter((f) => /\.(html?|jsx|tsx|astro|vue|svelte)$/.test(f));
  if (!files.length) continue;
  const r: SiteRow = { site: s, files: files.length, nodes: 0, swallow: 0, phantom: 0, rt: 0, ops: 0, ok: 0, princ: 0, unpr: 0, bad: 0, txt: 0, txtOk: 0, txtBad: 0, sty: 0, styOk: 0, styBad: 0 };

  // ── A. parse health ──
  for (const f of files) {
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; } if (src.length > 2e6) continue;
    const rel = path.relative(dir, f);
    let tree; try { tree = parseNodes(src); } catch (e) { r.swallow++; fails.push(`${s}/${rel}: parse THREW ${(e as Error).message}`); continue; }
    const ns = flat(tree); r.nodes += ns.length;
    const hasJsx = /<(div|span|section|svg|main|p|h[1-6]|a|ul|li|button|img|header|footer|nav|article|path|g|form|input|label|table)[\s>\/]/.test(src);
    if (!ns.length && hasJsx && /\.(jsx|tsx|astro|vue|svelte|html?)$/.test(f)) { r.swallow++; fails.push(`${s}/${rel}: real markup scanned to ZERO nodes (swallow)`); }
    for (const n of ns) { const orig = src.slice(n.openStart + 1, n.openStart + 1 + n.tag.length); if (orig !== orig.toLowerCase()) continue; const t = rt(n); if (HTML.has(t) || t.includes('-') || /\./.test(t)) continue; if (/\.(jsx|tsx|astro|vue|svelte|html?)$/.test(f)) { r.phantom++; fails.push(`${s}/${rel}: phantom <${n.tag}>`); } }
    for (const c of ns.filter((n) => n.closeStart != null && n.end - n.openStart < 3000).slice(0, 10)) { let re; try { re = parseNodes(src.slice(c.openStart, c.end)).roots[0]; } catch {} if (!re || re.tag !== c.tag) { r.rt++; fails.push(`${s}/${rel}: <${c.tag}> slice doesn't round-trip`); } }
  }

  // ── B. ops + undo + rapid move (single-file temp repos) ──
  for (const f of spread(files, isMonorepo(s) ? 6 : 14)) {
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; } if (src.length > 1.5e6) continue;
    const rel = path.relative(dir, f); const nodes = flat(parseNodes(src)).filter((n) => good(n, src));
    const tally = (res: StructuralEditOutcome, tag: string, kind: string, check: (res: StructuralEditDone) => string | null): StructuralEditDone | null => { r.ops++; if (!res.ok) { if (PRINCIPLED.has(res.reason)) r.princ++; else { r.unpr++; fails.push(`${s}/${rel}: ${kind} <${tag}> UNPRINCIPLED ${res.reason}`); } return null; } r.ok++; const why = check(res); if (why) { r.bad++; fails.push(`${s}/${rel}: ${kind} <${tag}> ${why}`); } return res; };
    for (const n of spread(nodes, 3)) {
      const sel = { tagName: rt(n), path: pathFrom(n, src) }; const jsx = /\.(jsx?|tsx?|mjs|cjs)$/.test(rel);
      let repo = tmpFile(rel, src); try { tally(insert.applyInsert(repo, { anchor: sel, position: 'after', markup: '<div class="rdl-x">x</div>', preferFile: rel }), rt(n), 'insert', (res) => { const out = fs.readFileSync(path.join(repo, rel), 'utf8'); if (!(jsx ? /className="rdl-x"/ : /\bclass="rdl-x"/).test(out)) return 'marker/attr wrong'; if (!reparses(out)) return 'invalid output'; if (res.prevContent !== src) return 'UNDO prevContent != original'; return null; }); } finally { fs.rmSync(repo, { recursive: true, force: true }); }
      repo = tmpFile(rel, src); try { tally(insert.applyWrap(repo, { subject: sel, preferFile: rel }), rt(n), 'wrap', (res) => { const out = fs.readFileSync(path.join(repo, rel), 'utf8'); if (!res.wrapperClass || !out.includes(res.wrapperClass)) return 'wrapper missing'; if (!reparses(out)) return 'invalid output'; if (res.prevContent !== src) return 'UNDO mismatch'; return null; }); } finally { fs.rmSync(repo, { recursive: true, force: true }); }
      repo = tmpFile(rel, src); try { tally(insert.applyRemove(repo, { subject: sel, preferFile: rel }), rt(n), 'remove', (res) => { const out = fs.readFileSync(path.join(repo, rel), 'utf8'); if (!reparses(out)) return 'invalid output'; if (out.length >= src.length) return 'nothing removed'; if (res.prevContent !== src) return 'UNDO mismatch'; return null; }); } finally { fs.rmSync(repo, { recursive: true, force: true }); }
      const sibs = n.parent!.children.filter((c) => rt(c) === rt(n) && bounded(c));
      if (sibs.length >= 2 && sibs.length <= 30 && n !== sibs[sibs.length - 1]) {
        const last = sibs[sibs.length - 1]; repo = tmpFile(rel, src);
        try {
          const mv = tally(insert.applyMove(repo, { subject: sel, target: { tagName: rt(last), path: pathFrom(last, src) }, position: 'after', preferFile: rel }), rt(n), 'move', (res) => { const out = fs.readFileSync(path.join(repo, rel), 'utf8'); const re = new RegExp('<' + n.tag.replace('.', '\\.') + '(?=[\\s>/])', 'g'); if ((out.match(re) || []).length !== (src.match(re) || []).length) return 'count changed'; if (!reparses(out)) return 'invalid output'; if (res.prevContent !== src) return 'UNDO mismatch'; return null; });
          if (mv) { // rapid second move (same byte size) must see the first write, not a stale snapshot
            const after = fs.readFileSync(path.join(repo, rel), 'utf8'); const t2 = flat(parseNodes(after));
            const grp = t2.find((x) => x.parent && rt(x) === rt(n) && x.parent.children.filter((c) => rt(c) === rt(n)).length >= 2);
            if (grp) { const kin = grp.parent!.children.filter((c) => rt(c) === rt(n)); const back = insert.applyMove(repo, { subject: { tagName: rt(n), path: pathFrom(kin[kin.length - 1], after) }, target: { tagName: rt(n), path: pathFrom(kin[0], after) }, position: 'before', preferFile: rel }); r.ops++; if (back.ok) { r.ok++; if (back.prevContent !== after) { r.bad++; fails.push(`${s}/${rel}: rapid-move STALE CACHE`); } } else if (PRINCIPLED.has(back.reason)) r.princ++; else { r.unpr++; fails.push(`${s}/${rel}: rapid-move UNPRINCIPLED ${back.reason}`); } }
          }
        } finally { fs.rmSync(repo, { recursive: true, force: true }); }
      }
    }
  }

  // ── C. text edits + class-swap with structural paths (whole-site copy; twins across pages are real) ──
  if (!isMonorepo(s)) {
    const repo = copySite(dir);
    try {
      for (const f of spread(files, 10)) {
        const rel = path.relative(dir, f); const tf = path.join(repo, rel); if (!fs.existsSync(tf)) continue;
        const base = fs.readFileSync(tf, 'utf8'); const all = flat(parseNodes(base));
        const tIdx = all.map((n, i): [HtmlNode, number] => [n, i]).filter(([n]) => TEXT_TAGS.has(rt(n)) && n.closeStart != null && !n.children.length && (() => { const o = own(n, base); return o.length >= 8 && o.length <= 120 && !/[{}<>]/.test(o); })()).map(([, i]) => i);
        for (const i of spread(tIdx, 4)) {
          const cur = fs.readFileSync(tf, 'utf8'); const n = flat(parseNodes(cur))[i]; if (!n) continue;
          const original = decode(own(n, cur)); const newText = original + ' (edited)';
          const res = engine.applyTextEdit(repo, { originalText: original, newText, context: { tagName: rt(n), classList: cls(n.open), id: idOf(n.open), preferFile: rel, path: pathFrom(n, cur) } });
          r.txt++; if (!res.ok) continue; r.txtOk++;
          const why: string[] = []; if (res.relFile !== rel) why.push('WRONG FILE ' + res.relFile); else { const at = changeAt(cur, res.newContent!); if (!(at >= n.openStart && at < n.end)) why.push('WRONG ELEMENT'); } if (res.prevContent !== cur) why.push('UNDO mismatch');
          if (why.length) { r.txtBad++; fails.push(`${s}/${rel}: text <${rt(n)}> ${why.join('; ')} "${original.slice(0, 30)}"`); }
        }
        const sIdx = all.map((n, i): [HtmlNode, number] => [n, i]).filter(([n]) => cls(n.open).some((c) => SP_RE.test(c))).map(([, i]) => i);
        for (const i of spread(sIdx, 4)) {
          const cur = fs.readFileSync(tf, 'utf8'); const n = flat(parseNodes(cur))[i]; if (!n) continue;
          const classList = cls(n.open); const oldToken = classList.find((c) => SP_RE.test(c))!; const m = SP_RE.exec(oldToken)!; const newToken = `${m[1]}-${Number(m[2]) + 2}`;
          const res = engine.applyStyleEdits(repo, [{ kind: 'class-swap', prop: 'padding', oldToken, newToken, classList }], { tagName: rt(n), classList, id: idOf(n.open), preferFile: rel, path: pathFrom(n, cur) });
          r.sty++; if (!res.ok) continue; r.styOk++;
          const fr = (res.files || [])[0]; const why: string[] = [];
          if (!fr) why.push('no file result'); else { if (fr.relFile !== rel) why.push('WRONG FILE ' + fr.relFile); else { const at = changeAt(cur, fr.newContent); if (!(at >= n.openStart && at < n.openEnd)) why.push('WRONG ELEMENT'); } if (fr.prevContent !== cur) why.push('UNDO mismatch'); }
          if (why.length) { r.styBad++; fails.push(`${s}/${rel}: class-swap <${rt(n)}> ${why.join('; ')} ${oldToken}→${newToken}`); }
        }
      }
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  }
  rows.push(r); for (const k of Object.keys(T) as (keyof Tally)[]) T[k] += r[k] || 0;
}

const pad = (v: number, w: number): string => String(v).padStart(w);
console.log(['site'.padEnd(40), 'files', 'nodes', 'SWLW', 'PHNT', 'RT', '  ops', 'ok', 'prin', 'UNPR', 'BAD', '  txt', 'ok', 'BAD', ' sty', 'ok', 'BAD'].join(' '));
for (const r of rows) console.log(r.site.padEnd(40), pad(r.files, 5), pad(r.nodes, 5), pad(r.swallow, 4), pad(r.phantom, 4), pad(r.rt, 2), ' ', pad(r.ops, 4), pad(r.ok, 4), pad(r.princ, 4), pad(r.unpr, 4), pad(r.bad, 3), ' ', pad(r.txt, 4), pad(r.txtOk, 3), pad(r.txtBad, 3), ' ', pad(r.sty, 3), pad(r.styOk, 3), pad(r.styBad, 3), (r.swallow || r.phantom || r.rt || r.unpr || r.bad || r.txtBad || r.styBad) ? ' <--' : '');
console.log('TOTAL'.padEnd(40), pad(T.files, 5), pad(T.nodes, 5), pad(T.swallow, 4), pad(T.phantom, 4), pad(T.rt, 2), ' ', pad(T.ops, 4), pad(T.ok, 4), pad(T.princ, 4), pad(T.unpr, 4), pad(T.bad, 3), ' ', pad(T.txt, 4), pad(T.txtOk, 3), pad(T.txtBad, 3), ' ', pad(T.sty, 3), pad(T.styOk, 3), pad(T.styBad, 3));
const hard = T.swallow + T.rt + T.unpr + T.bad + T.txtBad + T.styBad;
console.log(`\n${hard ? 'FAIL' : 'PASS'}: ${hard} hard failure(s) across ${rows.length} sites` + (T.phantom ? ` (${T.phantom} phantom tag(s) — review, non-fatal)` : ''));
for (const f of fails.slice(0, 40)) console.log(' -', f);
process.exit(hard ? 1 : 0);
