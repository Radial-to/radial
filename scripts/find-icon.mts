#!/usr/bin/env node
/**
 * Search the icon catalog by keyword/alias so we can pick the right name without
 * paging 2000+ icons by hand. Searches Central Icons when the licensed package is
 * installed (official builds), otherwise Lucide (the open set builds from the
 * public source use). Force one with --set central|open.
 *
 *   node scripts/find-icon.mts globe            # list matches (name: aliases)
 *   node scripts/find-icon.mts shopping cart    # all terms must match
 *   node scripts/find-icon.mts bell --preview   # also render matches to an HTML grid
 *   node scripts/find-icon.mts --svg IconGlobe  # print one icon's raw SVG (a Lucide name in the open set)
 *
 * Central: reference the name via icon('IconName') in the renderer (or add it to
 * SEED in build-icons.mts if it's used dynamically), add its Lucide match to
 * scripts/icons-open-map.json, then run `npm run icons` and `npm run icons:open`.
 * Lucide: add "IconName": "lucide-name" to scripts/icons-open-map.json.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

let args = process.argv.slice(2);
let forced: string | null = null;
const setAt = args.indexOf('--set');
if (setAt !== -1) { forced = args[setAt + 1]; args.splice(setAt, 2); }
if (forced && !['central', 'open'].includes(forced)) { console.error('--set must be central or open'); process.exit(1); }

function centralInstalled(): boolean {
  try { require.resolve('@central-icons-react/all'); return true; } catch { return false; }
}
const set = forced || (centralInstalled() ? 'central' : 'open');

const STYLE = { join: 'round', fill: 'outlined', stroke: '2', radius: '3', color: 'currentColor', size: 24 } as const;
let aliases: Record<string, string>;   // { name: "alias1, alias2" }
let svgFor: (name: string) => Promise<string>;    // async (name) => svg markup

if (set === 'central') {
  const pkgDir = join(root, 'node_modules', '@central-icons-react', 'all');
  try {
    aliases = (JSON.parse(readFileSync(join(pkgDir, 'icons-index.json'), 'utf8')) as { iconAliases?: Record<string, string> }).iconAliases || {};
  } catch {
    console.error('Central Icons not installed. Run: npm run icons:reinstall (needs CENTRAL_LICENSE_KEY), or search the open set with --set open.');
    process.exit(1);
  }
  svgFor = async (name) => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { CentralIcon } = await import('@central-icons-react/all');
    return renderToStaticMarkup(createElement(CentralIcon, { name, ...STYLE }));
  };
} else {
  let pkgDir: string;
  try { pkgDir = dirname(require.resolve('lucide-static/package.json')); }
  catch { console.error('lucide-static is not installed. Run: npm install'); process.exit(1); }
  const tags: Record<string, string[]> = JSON.parse(readFileSync(join(pkgDir, 'tags.json'), 'utf8'));   // { "globe": ["world", …] }
  aliases = Object.fromEntries(Object.entries(tags).map(([n, t]) => [n, t.join(', ')]));
  svgFor = async (name) => {
    const file = join(pkgDir, 'icons', `${name}.svg`);
    return existsSync(file) ? readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim() : '';
  };
}

// --svg name: print one icon's raw markup.
if (args[0] === '--svg') {
  const name = args[1];
  if (!name) { console.error('Usage: --svg <name>'); process.exit(1); }
  if (!aliases[name]) console.warn(`(warning: ${name} not in the ${set} catalog, output may be empty)`);
  console.log(await svgFor(name));
  process.exit(0);
}

const preview = args.includes('--preview');
const terms = args.filter((a) => a !== '--preview').map((s) => s.toLowerCase());
if (!terms.length) { console.error('Usage: node scripts/find-icon.mts <keyword…> [--preview] [--set central|open]'); process.exit(1); }

// Every term must appear in the name or its aliases. Rank exact-name hits first.
const matches = Object.entries(aliases)
  .map(([name, alias]) => ({ name, alias, hay: (name + ' ' + alias).toLowerCase() }))
  .filter((e) => terms.every((t) => e.hay.includes(t)))
  .sort((a, b) => {
    const aw = terms.some((t) => a.name.toLowerCase().includes(t)) ? 0 : 1;
    const bw = terms.some((t) => b.name.toLowerCase().includes(t)) ? 0 : 1;
    return aw - bw || a.name.localeCompare(b.name);
  });

const setName = set === 'central' ? 'Central Icons' : 'Lucide';
if (!matches.length) { console.log(`No ${setName} icons match: ${terms.join(' ')}`); process.exit(0); }

console.log(`${matches.length} ${setName} match(es) for "${terms.join(' ')}":\n`);
for (const m of matches) console.log(`  ${m.name}: ${m.alias}`);
if (set === 'open') console.log('\nUse one as the value in scripts/icons-open-map.json: "IconYourName": "lucide-name".');

if (preview) {
  const cells: string[] = [];
  for (const m of matches.slice(0, 60)) {
    cells.push(`<figure><div class="ic">${await svgFor(m.name)}</div><figcaption>${m.name}</figcaption></figure>`);
  }
  const html = `<!doctype html><meta charset="utf8"><title>icons: ${terms.join(' ')}</title>
<style>body{background:#0d0d0f;color:#e6e6e6;font:13px ui-sans-serif,system-ui;margin:24px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:14px}
figure{margin:0;padding:14px;background:#16161a;border:1px solid #2a2a30;border-radius:10px;text-align:center}
.ic{height:28px;display:flex;align-items:center;justify-content:center;color:#fff}
.ic svg{width:24px;height:24px}figcaption{margin-top:10px;color:#9a9aa2;font-size:11px;word-break:break-all}</style>
<h2>${matches.length} ${setName} match(es) for "${terms.join(' ')}"</h2><main>${cells.join('')}</main>`;
  const out = join(root, 'icon-preview.html');
  writeFileSync(out, html);
  console.log(`\nPreview (top ${Math.min(matches.length, 60)}): ${out}`);
}
