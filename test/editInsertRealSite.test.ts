// Real-world coverage: run every structural op against a real static marketing
// site (RADIAL_TEST_SITE: plain hand-authored HTML, hundreds of elements per
// page, inline scripts; built against radial.to's own source). Static HTML is 1:1 with the DOM, so we can derive
// accurate DOM-path payloads straight from the parsed source and exercise the
// resolver on real markup instead of tidy fixtures. Each op runs on a throwaway
// copy — the real files are never touched. Skips cleanly when RADIAL_TEST_SITE
// isn't set (other machines / CI).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as insert from '../src/main/editInsert';
import { parseNodes } from '../src/main/htmlScan';
import type { HtmlNode, ParsedHtml } from '../src/main/htmlScan';
import type { ElementPathLevel } from '../src/shared/radialApi';
import type { StructuralEditReadout as Outcome } from './support/structuralEdit';
import { tmpDir } from './support/tmp';

const SITE = process.env.RADIAL_TEST_SITE || '';
const PAGES = ['index.html', 'pricing.html', 'integrations.html', 'download.html', 'trust.html'];
const haveSite = (() => { try { return !!SITE && fs.existsSync(SITE); } catch { return false; } })();

function ownTextOf(node: HtmlNode, src: string): string {
  let t = '', cur = node.openEnd;
  for (const ch of node.children) { t += src.slice(cur, ch.openStart); cur = ch.end; }
  t += src.slice(cur, node.closeStart == null ? node.end : node.closeStart);
  return t.replace(/\s+/g, ' ').trim();
}
// The DOM-path payload the app would capture for this node (element → body).
// `id: null`, as the overlay sends for an element without one.
function pathFromNode(node: HtmlNode, src: string): ElementPathLevel[] {
  const out: ElementPathLevel[] = [];
  let n: HtmlNode | null = node;
  while (n && n.tag !== 'html') {
    const sibs: HtmlNode[] = n.parent ? n.parent.children : [n];
    let nth = 0, cnt = 0;
    for (const c of sibs) { if (c.tag === n.tag) { if (c === n) nth = cnt; cnt++; } }
    const clsM = n.open.match(/class\s*=\s*"([^"]*)"/);
    out.push({ tag: n.tag, id: null, cls: clsM ? clsM[1].split(/\s+/).filter(Boolean) : [], own: ownTextOf(n, src).slice(0, 60), nth, cnt });
    if (n.tag === 'body') break;
    n = n.parent;
  }
  return out;
}
function flatten(tree: ParsedHtml): HtmlNode[] { const o: HtmlNode[] = []; const w = (ns: HtmlNode[]) => ns.forEach((n) => { o.push(n); w(n.children); }); w(tree.roots); return o; }
function freshRepo(rel: string, src: string): string {
  const d = tmpDir('realsite-');
  const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, src);
  return d;
}

for (const page of (haveSite ? PAGES : [])) {
  const abs = path.join(SITE, page);
  if (!fs.existsSync(abs)) continue;
  const orig = fs.readFileSync(abs, 'utf8');
  const nodes = flatten(parseNodes(orig));

  // Reorderable elements: a node with ≥2 same-tag siblings under one parent —
  // the exact case that used to bail. Sample a spread across the page.
  const reorderable = nodes.filter((n) => {
    if (!n.parent || (!n.closeStart && !n.selfClosing && !n.isVoid)) return false;
    const sibs = n.parent.children.filter((c) => c.tag === n.tag);
    return sibs.length >= 2 && sibs.length <= 40; // skip pathological huge repeats
  });
  const sample = reorderable.filter((_, i) => i % Math.max(1, Math.floor(reorderable.length / 12)) === 0).slice(0, 12);

  test(`${page}: parses to valid element tree (${nodes.length} nodes)`, () => {
    assert.ok(nodes.length > 20, 'should find real elements');
    // Every container we bound must round-trip: its slice re-parses to itself.
    const containers = nodes.filter((n) => n.closeStart != null && n.end - n.openStart < 4000).slice(0, 30);
    for (const c of containers) {
      const slice = orig.slice(c.openStart, c.end);
      const re = parseNodes(slice).roots[0];
      assert.equal(re && re.tag, c.tag, `slice of <${c.tag}> should re-parse to the same tag`);
    }
  });

  test(`${page}: reorder ${sample.length} real repeated elements — none bail`, () => {
    let moved = 0;
    for (const n of sample) {
      const parent = n.parent!; // sample holds only nodes with a parent (reorderable)
      const sibs = parent.children.filter((c) => c.tag === n.tag);
      const last = sibs[sibs.length - 1];
      if (n === last) continue;
      const repo = freshRepo(page, orig);
      const res: Outcome = insert.applyMove(repo, {
        subject: { tagName: n.tag, path: pathFromNode(n, orig) },
        target: { tagName: last.tag, path: pathFromNode(last, orig) },
        position: 'after', preferFile: page,
      });
      assert.equal(res.ok, true, `move <${n.tag}> (nth among ${sibs.length}) failed: ${res.reason}`);
      // The result must still be valid markup with the same element count.
      const out = fs.readFileSync(path.join(repo, page), 'utf8');
      assert.equal((out.match(new RegExp(`<${n.tag}(?=[\\s>/])`, 'g')) || []).length,
        (orig.match(new RegExp(`<${n.tag}(?=[\\s>/])`, 'g')) || []).length, 'element count preserved');
      moved++;
    }
    assert.ok(moved > 0, 'exercised at least one real reorder');
  });

  test(`${page}: insert + remove on real elements — none bail`, () => {
    for (const n of sample.slice(0, 6)) {
      // insert after
      let repo = freshRepo(page, orig);
      const ins: Outcome = insert.applyInsert(repo, { anchor: { tagName: n.tag, path: pathFromNode(n, orig) }, position: 'after', markup: '<div class="rdl-test-x">x</div>', preferFile: page });
      assert.equal(ins.ok, true, `insert after <${n.tag}> failed: ${ins.reason}`);
      assert.match(fs.readFileSync(path.join(repo, page), 'utf8'), /rdl-test-x/);
      // remove
      repo = freshRepo(page, orig);
      const rm: Outcome = insert.applyRemove(repo, { subject: { tagName: n.tag, path: pathFromNode(n, orig) }, preferFile: page });
      assert.equal(rm.ok, true, `remove <${n.tag}> failed: ${rm.reason}`);
      const out = fs.readFileSync(path.join(repo, page), 'utf8');
      // Removing a container removes its whole subtree, so the same-tag count
      // drops by however many same-tag elements lived inside it (itself + nested
      // <n.tag> descendants), not by exactly one.
      const re = new RegExp(`<${n.tag}(?=[\\s>/])`, 'g');
      const subtree = (orig.slice(n.openStart, n.end).match(re) || []).length;
      assert.equal((out.match(re) || []).length, (orig.match(re) || []).length - subtree,
        `removed <${n.tag}> and its ${subtree - 1} same-tag descendant(s)`);
      // And the result must still be valid markup that re-parses.
      assert.ok(parseNodes(out).roots.length > 0, 'remove leaves a parseable document');
    }
  });
}

if (!haveSite) test('marketing site not present — real-site tests skipped', () => { assert.ok(true); });
