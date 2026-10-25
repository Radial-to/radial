import { test } from 'node:test';
import assert from 'node:assert';
import { parseNodes } from '../src/main/htmlScan';
import type { HtmlNode } from '../src/main/htmlScan';

// Flatten to [tag, sliceOfElement] for easy assertions.
function flat(src: string) {
  const out: { tag: string; text: string; kids: number }[] = [];
  const walk = (nodes: HtmlNode[]) => nodes.forEach((n) => { out.push({ tag: n.tag, text: src.slice(n.openStart, n.end), kids: n.children.length }); walk(n.children); });
  walk(parseNodes(src).roots);
  return out;
}
function roots(src: string) { return parseNodes(src).roots; }

test('formatted: each element on its own line', () => {
  const src = '<section>\n  <h1>Hi</h1>\n  <p>Yo</p>\n</section>';
  const r = roots(src);
  assert.equal(r.length, 1);
  assert.equal(r[0].tag, 'section');
  assert.equal(r[0].children.map((c) => c.tag).join(','), 'h1,p');
  assert.equal(src.slice(r[0].openStart, r[0].end), src);
});

test('inline: many elements on one line', () => {
  const src = '<div><span>a</span><span>b</span><span>c</span></div>';
  const r = roots(src);
  assert.equal(r[0].children.length, 3);
  assert.equal(src.slice(r[0].children[1].openStart, r[0].children[1].end), '<span>b</span>');
});

test('minified: no whitespace at all', () => {
  const src = '<ul><li>1</li><li>2</li><li>3</li></ul>';
  const r = roots(src);
  assert.equal(r[0].children.length, 3);
  assert.equal(src.slice(r[0].children[2].openStart, r[0].children[2].end), '<li>3</li>');
});

test('void + self-closing elements have no close range', () => {
  const src = '<div><img src="/a.png"><br/><input type="text" /></div>';
  const kids = roots(src)[0].children;
  assert.deepEqual(kids.map((k) => k.tag), ['img', 'br', 'input']);
  kids.forEach((k) => { assert.equal(k.closeStart, null); assert.equal(k.end, k.openEnd); });
});

test('quoted > inside an attribute does not end the tag', () => {
  const src = '<div title="a > b" data-x=\'c > d\'><p>ok</p></div>';
  const r = roots(src);
  assert.equal(r[0].tag, 'div');
  assert.equal(r[0].children.length, 1);
  assert.equal(r[0].children[0].tag, 'p');
});

test('JSX className and {expression} attributes', () => {
  const src = 'return (\n  <main className="wrap" style={{ color: "red" }}>\n    <h1>{title}</h1>\n  </main>\n);';
  const r = parseNodes(src).roots;
  const main = r.find((n) => n.tag === 'main');
  assert.ok(main);
  assert.equal(main.children.map((c) => c.tag).join(','), 'h1');
});

test('JSX {items.map(i => <Card/>)} is opaque — the mapped tag is NOT a child', () => {
  const src = '<section>\n  {items.map((i) => <Card key={i} />)}\n</section>';
  const r = roots(src);
  assert.equal(r[0].tag, 'section');
  assert.equal(r[0].children.length, 0); // the Card lives inside a {…} expression → invisible (mapped)
});

test('a > b inside a JSX expression child does not read as a tag', () => {
  const src = '<div>\n  {count > 3 && <b>many</b>}\n  <p>after</p>\n</div>';
  const kids = roots(src)[0].children;
  assert.deepEqual(kids.map((k) => k.tag), ['p']); // the <b> is inside {…}
});

test('HTML comments are skipped', () => {
  const src = '<div>\n  <!-- <fake> not a tag -->\n  <p>real</p>\n</div>';
  const kids = roots(src)[0].children;
  assert.deepEqual(kids.map((k) => k.tag), ['p']);
});

test('nested same-tag divs keep correct ranges', () => {
  const src = '<div class="outer">\n  <div class="inner">\n    <p>deep</p>\n  </div>\n</div>';
  const outer = roots(src)[0];
  assert.match(outer.open, /outer/);
  assert.equal(outer.children.length, 1);
  assert.match(outer.children[0].open, /inner/);
  assert.equal(src.slice(outer.openStart, outer.end), src);
});

test('offsets round-trip: element slice re-parses to the same tag', () => {
  const src = '<body>\n  <section class="a"><h2>A</h2></section>\n  <section class="b"><h2>B</h2></section>\n</body>';
  const secs = roots(src)[0].children;
  assert.equal(secs.length, 2);
  const bSlice = src.slice(secs[1].openStart, secs[1].end);
  assert.equal(bSlice, '<section class="b"><h2>B</h2></section>');
  assert.equal(parseNodes(bSlice).roots[0].tag, 'section');
});

test('unclosed tag recovers at parent close', () => {
  const src = '<div><p>oops<span>x</span></div>';
  const div = roots(src)[0];
  assert.equal(div.tag, 'div');
  // p never closed; recovery closes it when div closes. Both are descendants.
  const tags = flat(src).map((f) => f.tag);
  assert.ok(tags.includes('p') && tags.includes('span'));
});

test('multiple top-level roots', () => {
  const src = '<header>H</header>\n<main>M</main>\n<footer>F</footer>';
  assert.deepEqual(roots(src).map((r) => r.tag), ['header', 'main', 'footer']);
});

// ── JSX inside a {…} expression (fixed in Radial Cloud's copy first) ─────────
// The element tags of a scan, depth first.
function tags(src: string): string[] {
  const out: string[] = [];
  const walk = (nodes: HtmlNode[]) => { for (const n of nodes) { out.push(n.tag); walk(n.children); } };
  walk(parseNodes(src).roots);
  return out;
}

test('a closing tag or a self-closing tag inside {…} no longer swallows what follows', () => {
  // The `/` of `</li>` and of `"/>` read as the start of a regex, which ran past
  // the expression's closing `}` and took the rest of the file with it.
  assert.deepEqual(tags('<div>{items.map(i => <li>{i}</li>)}</div><p>after</p>'), ['div', 'p']);
  assert.deepEqual(tags('<ul>{rows.map(r => <Row key={r.id} name="x"/>)}</ul><footer>end</footer>'), ['ul', 'footer']);
});

test('an apostrophe in JSX text inside {…} is text, not the start of a string', () => {
  assert.deepEqual(tags("<div>{open && <p>It's here</p>}</div><span>after</span>"), ['div', 'span']);
  assert.deepEqual(tags("<div>{a < b ? <i>x</i> : <>Don't</>}</div><b>after</b>"), ['div', 'b']);
  // Comparisons and generics are still not tags.
  assert.deepEqual(tags('function f() { const x = useState<string>(""); return <section>{a < b && c}</section> }'), ['section']);
});

test('a dialog that renders its lists from data keeps every element after them', () => {
  // The shape of a real careers dialog (an Astro component) that scanned to 11
  // elements instead of 50: a map whose items render <li>s inside fragments and
  // a ternary, then the whole form below it.
  const src = [
    '<div class="dialog">',
    '  <div class="info">',
    '    {roles.map(role => {',
    '      const brief = briefs[role];',
    '      return (',
    '        <div class="brief" data-brief={role} hidden>',
    '          {brief ? (',
    '            <>',
    '              <div class="intro">{brief.intro.map(text => <p>{text}</p>)}</div>',
    '              {brief.sections.map(section => (',
    '                <section>',
    '                  <h3>{section.title}</h3>',
    '                  <ul>{section.items.map(item => <li>{item}</li>)}</ul>',
    '                </section>',
    '              ))}',
    '            </>',
    '          ) : (',
    "            <p>Tell us what you've built.</p>",
    '          )}',
    '        </div>',
    '      );',
    '    })}',
    '  </div>',
    '  <form class="apply">',
    '    <label for="name">Name</label>',
    '    <input id="name" name="name" />',
    '    <button type="submit">Send</button>',
    '  </form>',
    '</div>',
  ].join('\n');
  assert.deepEqual(tags(src), ['div', 'div', 'form', 'label', 'input', 'button']);
});

test('a void tag written the HTML way inside {…} (Astro, Svelte) closes itself', () => {
  assert.deepEqual(tags('<div>{show && <img src="a.png">}</div><p>after</p>'), ['div', 'p']);
  assert.deepEqual(tags("<div>{note && <p>Line one<br>it's two</p>}</div><p>after</p>"), ['div', 'p']);
  // A component named like a void tag holds its children (and their apostrophes).
  assert.deepEqual(tags('<nav>{open && <Link href="/">Don\'t go</Link>}</nav><p>after</p>'), ['nav', 'p']);
});

test('a regex that starts with > inside {…} is still a regex', () => {
  assert.deepEqual(tags('<div>{text.replace(/>/g, "&gt;")}</div><p>after</p>'), ['div', 'p']);
  assert.deepEqual(tags("<div>{text.replace(/>'/g, '')}</div><p>after</p>"), ['div', 'p']);
});
