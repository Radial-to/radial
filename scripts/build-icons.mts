#!/usr/bin/env node
/**
 * Extract ONLY the icons the app uses into src/renderer/icons.gen.js, as plain
 * SVG strings keyed by name (window.RADIAL_ICONS). The renderer inlines them via
 * `icon('IconName', size)`.
 *
 * Two sets, same names. The app always asks for Central's names (icon('IconGlobe')):
 *   - central: Central Icons, licensed. @central-icons-react/all is an optional
 *     dependency that only installs with CENTRAL_LICENSE_KEY. Official builds use it.
 *   - open: Lucide (ISC, the lucide-static dev dependency), matched name by name
 *     in scripts/icons-open-map.json. Builds from the public source use it.
 *
 *   npm run icons              central when it's installed, otherwise open
 *   npm run icons:open         open set -> src/renderer/icons.open.gen.js
 *   node scripts/build-icons.mts --set central|open --out <file>
 *
 * When you add an icon, add its Lucide match to icons-open-map.json in the same
 * change; the central run warns about any shipped name without one.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname, resolve, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rendererDir = join(root, 'src', 'renderer');
const require = createRequire(join(root, 'package.json'));
const OPEN_MAP_FILE = join(root, 'scripts', 'icons-open-map.json');

// House style, the same for both sets: outlined, stroke 2, round caps and joins,
// currentColor (icons inherit the text colour).
const STYLE = { join: 'round', fill: 'outlined', stroke: '2', radius: '3', color: 'currentColor', size: 24 } as const;
const SVG_OPEN = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="color:currentColor">';
const STROKE = 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

// Always include these (referenced via innerHTML strings / dynamically).
const SEED = [
  'IconConsole', 'IconSparkle', 'IconSettingsGear1', 'IconWindowApp', 'IconTablet',
  'IconPhone', 'IconCmd', 'IconRocket', 'IconChevronLeft', 'IconChevronRight',
  'IconHome', 'IconPageText', 'IconMagnifyingGlass', 'IconPlusMedium', 'IconPlay', 'IconMinimize',
  'IconMoon', 'IconStop', 'IconArrowUp', 'IconFileEdit', 'IconFolder1', 'IconSquareCursor', 'IconGlobe',
  'IconCode', 'IconGauge', 'IconFeather', // response-style icons (technical/moderate/simple)
  'IconEyeOpen', 'IconEyeSlash', 'IconTrashCan', 'IconBranch', 'IconChevronDownSmall', 'IconCloudDownload',
];
// Floating-toolbar candidates: only the ones that exist get shipped, and iconAny()
// moves on to the next name when one is missing, so a gap here is fine.
const CANDIDATES = [
  'IconCursor1', 'IconCursorClick', 'IconCursor', 'IconArrowCursor', 'IconMousePointer', 'IconPointer', 'IconArrowUpLeft',
  'IconPencil', 'IconPencil1', 'IconEdit',
  'IconSquareDashed', 'IconSelect',
  'IconMessageDots', 'IconMessage', 'IconMessage2', 'IconComment', 'IconCommentDots', 'IconChatBubble',
  'IconBubbleText', 'IconBubble2', 'IconBalloon',
];

/** The command line: which set to build (`central` or `open`) and where to write it, when given. */
interface IconArgs { set: string | null; out: string | null }

function parseArgs(argv: string[]): IconArgs {
  const opts: IconArgs = { set: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') opts.set = argv[++i];
    else if (a.startsWith('--set=')) opts.set = a.slice(6);
    else if (a === '--out') opts.out = argv[++i];
    else if (a.startsWith('--out=')) opts.out = a.slice(6);
    else { console.error(`Unknown argument: ${a}\nUsage: node scripts/build-icons.mts [--set central|open] [--out <file>]`); process.exit(1); }
  }
  if (opts.set && !['central', 'open'].includes(opts.set)) { console.error(`--set must be central or open (got ${opts.set})`); process.exit(1); }
  return opts;
}

// The renderer source the scans read: every script and page under src/renderer,
// in subfolders too (the window scripts in chat/), as paths relative to it.
// Not type declarations, the vendored bundles, or the generated icon files.
function rendererSources(): string[] {
  return readdirSync(rendererDir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(js|ts|html)$/.test(f) && !/\.d\.ts$/.test(f) && !f.startsWith(`vendor${sep}`) && !/^icons(\.\w+)?\.gen\.js$/.test(f))
    .sort();
}

// Scan renderer source for icon('IconXxx') and iconAny(['IconA','IconB']) usages.
// Required: SEED and literal icon('…') calls. Candidates: CANDIDATES and every
// name inside an iconAny([...]) list (the first one that exists wins).
function scanUsed(): { required: Set<string>; candidates: Set<string>; all: string[] } {
  const required = new Set(SEED);
  const candidates = new Set(CANDIDATES);
  for (const f of rendererSources()) {
    const src = readFileSync(join(rendererDir, f), 'utf8');
    for (const m of src.matchAll(/icon\(\s*['"]([A-Za-z0-9_]+)['"]/g)) required.add(m[1]);
    // iconAny(['IconA','IconB']): capture every quoted candidate in the array,
    // otherwise none of them ship and the button renders blank.
    for (const m of src.matchAll(/iconAny\(\s*\[([^\]]*)\]/g))
      for (const q of m[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g)) candidates.add(q[1]);
  }
  for (const n of required) candidates.delete(n);
  return { required, candidates, all: [...new Set([...required, ...candidates])].sort() };
}

// Flag dynamic icon() calls whose name the scanner can't resolve: icon(<expr>)
// where the argument is computed (a variable/member/function) with no shipped
// string literal to fall back on. Those won't ship and render blank unless the
// name is in SEED. (This is what bit the globe and lock icons.) Ternary/fallback
// calls whose literals are already shipped are NOT flagged; they're fine.
function scanDynamic(shipped: Set<string>): string[] {
  const hits: string[] = [];
  for (const f of rendererSources()) {
    const src = readFileSync(join(rendererDir, f), 'utf8');
    // Capture the first argument up to the next comma or closing paren.
    for (const m of src.matchAll(/(?<![A-Za-z])(?<!function )icon\(\s*([^),]*)/g)) {
      const arg = m[1].trim();
      if (!arg || /^['"]/.test(arg)) continue;        // literal first arg: handled by the scanner
      if (/^[a-z_$][\w$]*$/.test(arg)) continue;      // bare variable passthrough (e.g. iconAny's icon(n)): a helper, not a call site
      // Ternary/fallback with literals that all already ship: safe, don't warn.
      const lits = [...arg.matchAll(/['"](Icon[A-Za-z0-9_]+)['"]/g)].map((x) => x[1]);
      if (lits.length && lits.every((n) => shipped.has(n))) continue;
      const line = src.slice(0, m.index).split('\n').length;
      const eol = src.indexOf('\n', m.index);
      const snippet = src.slice(m.index, eol === -1 ? src.length : eol).trim().slice(0, 90);
      hits.push(`  ${f}:${line}  ${snippet}`);
    }
  }
  return hits;
}

function centralInstalled(): boolean {
  try { require.resolve('@central-icons-react/all'); return true; } catch { return false; }
}

async function centralRenderer(): Promise<(name: string) => string> {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { CentralIcon } = await import('@central-icons-react/all');
  return (name: string) => {
    let svg = renderToStaticMarkup(createElement(CentralIcon, { name, ...STYLE }));
    // Drop the root SVG's fixed pixel size so CSS/inline controls it (keep viewBox).
    // IMPORTANT: only strip from the opening <svg> tag. Inner shapes (e.g. the
    // <rect> body of IconTablet) carry their own width/height and must be kept.
    svg = svg.replace(/<svg\b[^>]*>/, (tag) => tag.replace(/\s(width|height)="[^"]*"/g, ''));
    return svg && svg.includes('<path') ? svg : '';
  };
}

function readOpenMap(): Partial<Record<string, string>> {
  try { return JSON.parse(readFileSync(OPEN_MAP_FILE, 'utf8')); }
  catch (e) { console.error(`Can't read ${relative(root, OPEN_MAP_FILE)}: ${(e as Error).message}`); process.exit(1); }
}

function lucideDir(): string {
  try { return join(dirname(require.resolve('lucide-static/package.json')), 'icons'); }
  catch { console.error('lucide-static is not installed. Run: npm install'); process.exit(1); }
}

// One Lucide file in the house shape: the same root tag as the Central set, with
// the stroke settings on a wrapping <g> (Lucide keeps them on its root <svg>).
function openRenderer(): (lucideName: string) => string {
  const dir = lucideDir();
  return (lucideName: string) => {
    const file = join(dir, `${lucideName}.svg`);
    if (!existsSync(file)) return '';
    const raw = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const inner = raw.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    const shapes = inner.replace(/\s+/g, ' ').replace(/\s*\/>/g, '/>').replace(/>\s+</g, '><').trim();
    if (!/<(path|circle|rect|line|polyline|polygon|ellipse)\b/.test(shapes)) return '';
    return `${SVG_OPEN}<g ${STROKE}>${shapes}</g></svg>`;
  };
}

function openLicenseHeader(): string {
  const pkgDir = dirname(require.resolve('lucide-static/package.json'));
  const version = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string }).version;
  const license = readFileSync(join(pkgDir, 'LICENSE'), 'utf8').trim().replace(/\*\//g, '* /');
  return `/*! Icons from Lucide (lucide-static ${version}), ISC License. Some derive from Feather, MIT License. */\n/*\n${license}\n*/\n`;
}

const opts = parseArgs(process.argv.slice(2));
const set = opts.set || (centralInstalled() ? 'central' : 'open');
const outFile = resolve(root, opts.out || join('src', 'renderer', 'icons.gen.js'));
if (set === 'central' && !centralInstalled()) {
  console.error('Central Icons not installed. Run: npm run icons:reinstall (needs CENTRAL_LICENSE_KEY in .env), or use --set open.');
  process.exit(1);
}
// Picked open only because Central isn't installed: never quietly swap the
// committed Central set for Lucide in the private repo. (The public repo's file
// is already Lucide, so this only stops the swap here.) Ask for it explicitly.
if (!opts.set && set === 'open' && existsSync(outFile) && !readFileSync(outFile, 'utf8').slice(0, 400).includes('Lucide')) {
  console.error(`${relative(root, outFile)} holds the licensed Central set and Central isn't installed here.`);
  console.error('Install it (npm run icons:reinstall) to regenerate it, or write the open set with npm run icons:open.');
  process.exit(1);
}

const { required, candidates, all } = scanUsed();
const openMap = readOpenMap();
const out: Record<string, string> = {};
const missingRequired: string[] = [];
const missingCandidates: string[] = [];
const unmatched: string[] = [];   // open set: names with no Lucide match in the map

if (set === 'central') {
  const svgFor = await centralRenderer();
  for (const n of all) {
    let s = '';
    try { s = svgFor(n); } catch { s = ''; }
    if (s) out[n] = s;
    else (required.has(n) ? missingRequired : missingCandidates).push(n);
  }
} else {
  const svgFor = openRenderer();
  for (const n of all) {
    const lucideName = openMap[n];
    if (!lucideName) {
      if (required.has(n)) unmatched.push(n); else missingCandidates.push(n);
      continue;
    }
    const s = svgFor(lucideName);
    if (s) out[n] = s;
    else (required.has(n) ? missingRequired : missingCandidates).push(`${n} (lucide "${lucideName}")`);
  }
}

const label = set === 'central' ? 'Central Icons (licensed, official builds only)' : 'Lucide (ISC)';
const banner = `// AUTO-GENERATED by scripts/build-icons.mts from ${label}. Do not edit; run \`npm run icons\`.\n`;
const body = `window.RADIAL_ICONS = ${JSON.stringify(out)};\n`;
writeFileSync(outFile, (set === 'open' ? openLicenseHeader() : '') + banner + body);
console.log(`Wrote ${Object.keys(out).length} ${set} icons -> ${relative(root, outFile)}`);

if (missingRequired.length) console.warn('Missing/unknown icon names:', missingRequired.join(', '));
if (unmatched.length) {
  console.warn(`No Lucide match for: ${unmatched.join(', ')}`);
  console.warn('   Add each to scripts/icons-open-map.json ("IconName": "lucide-name"), else it renders blank in open builds.');
}
if (missingCandidates.length) console.log(`(${missingCandidates.length} fallback candidates aren't in this set; iconAny() picks the next name.)`);

if (set === 'central') {
  // Keep the open set in step: every shipped Central name needs a Lucide match.
  const noMatch = Object.keys(out).filter((n) => !openMap[n]);
  if (noMatch.length) {
    console.warn(`\nNo Lucide match yet for: ${noMatch.join(', ')}`);
    console.warn('   Add them to scripts/icons-open-map.json and run `npm run icons:open`, so builds from the public source show them too.');
  }
}

const dynamic = scanDynamic(new Set(Object.keys(out)));
if (dynamic.length) {
  console.warn(`\n⚠  ${dynamic.length} dynamic icon() call(s) with a computed name the scanner can't verify.`);
  console.warn('   Make sure the resolved name(s) are in SEED, else the icon renders blank:');
  for (const d of dynamic) console.warn(d);
}
