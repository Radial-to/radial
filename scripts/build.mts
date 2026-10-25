#!/usr/bin/env node
// Compiles the app into out/, a mirror of src/ that Electron runs.
//
//   node scripts/build.mts            clean build
//   node scripts/build.mts --watch    build, then rebuild each file as it changes
//   node scripts/build.mts --run      build, then start the app (with --watch: keep rebuilding)
//   node scripts/build.mts --files a.ts,b.css   rebuild just those (paths inside src/)
//
// TypeScript is compiled file by file with esbuild (types are checked
// separately by `npm run typecheck`), each with its source map beside it
// (out/<file>.js.map): the app ships them so an error report can say where in
// src/ it happened (src/main/errorReport.ts). A map holds positions and names,
// never the source (no sourcesContent, and no TypeScript ships), so DevTools
// can name a TypeScript file and line but not show it. Everything else under
// src/ (HTML, CSS, images, vendored bundles, files still in JavaScript) is
// copied as it is, so out/ keeps the same layout and every path the app builds
// from __dirname still resolves.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DUAL, TS, compileWithMap, outName } from './transpile.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'src');
const OUT = path.join(root, 'out');

// Never copied: the React chat sources (scripts/build-fluid.mts bundles them
// into renderer/vendor/fluid) and the TypeScript project files.
const SKIP = [/^renderer\/fluid\//, /(^|\/)tsconfig\.json$/, /\.d\.ts$/];

function walk(dir: string, list: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, list);
    else list.push(path.relative(SRC, full).split(path.sep).join('/'));
  }
  return list;
}

const skipped = (rel: string): boolean => SKIP.some((re) => re.test(rel));

async function buildOne(rel: string): Promise<void> {
  const from = path.join(SRC, rel);
  if (!fs.existsSync(from)) {
    // Deleted or renamed: drop its output (and its map) too.
    for (const name of new Set([rel, outName(rel), `${outName(rel)}.map`])) fs.rmSync(path.join(OUT, name), { force: true });
    return;
  }
  if (skipped(rel)) return;
  const to = path.join(OUT, TS.test(rel) ? outName(rel) : rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (TS.test(rel)) {
    const { code, map } = compileWithMap(rel, fs.readFileSync(from, 'utf8'));
    fs.writeFileSync(to, `${code}${code.endsWith('\n') ? '' : '\n'}//# sourceMappingURL=${path.basename(to)}.map\n`);
    fs.writeFileSync(`${to}.map`, map);
  } else fs.copyFileSync(from, to);
}

function check(files: string[]): void {
  const compiled = new Map<string, string>();
  for (const rel of files) {
    if (skipped(rel)) continue;
    const name = TS.test(rel) ? outName(rel) : rel;
    if (compiled.has(name)) throw new Error(`src/${rel} and src/${compiled.get(name)} would both become out/${name}: keep only one`);
    compiled.set(name, rel);
  }
  for (const rel of Object.keys(DUAL)) {
    const js = rel.replace(/\.ts$/, '.js');
    if (!files.includes(rel) && !files.includes(js)) throw new Error(`DUAL lists src/${rel}, which doesn't exist`);
  }
}

export async function buildAll(): Promise<void> {
  const started = Date.now();
  const files = walk(SRC);
  check(files);
  fs.rmSync(OUT, { recursive: true, force: true });
  const failures: string[] = [];
  await Promise.all(files.map((rel) => buildOne(rel).catch((e: unknown) => failures.push((e as Error).message))));
  if (failures.length) throw new Error(failures.join('\n'));
  const count = files.filter((f) => TS.test(f) && !skipped(f)).length;
  console.log(`[build] out/ ready: ${count} TypeScript files compiled, ${files.length - count} copied (${Date.now() - started} ms)`);
}

function watch(onChange?: (batch: string[]) => void): void {
  let timer: NodeJS.Timeout | null = null;
  const pending = new Set<string>();
  fs.watch(SRC, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel = filename.toString().split(path.sep).join('/');
    if (path.basename(rel).startsWith('.')) return;
    if (fs.existsSync(path.join(SRC, rel)) && fs.statSync(path.join(SRC, rel)).isDirectory()) return;
    pending.add(rel);
    clearTimeout(timer as NodeJS.Timeout | undefined); // null is a no-op; @types/node leaves it out
    timer = setTimeout(async () => {
      const batch = [...pending];
      pending.clear();
      for (const rel of batch) {
        try { await buildOne(rel); } catch (e) { console.error(`[build] ${(e as Error).message}`); }
      }
      console.log(`[build] rebuilt ${batch.join(', ')}`);
      onChange?.(batch);
    }, 60);
  });
  console.log('[build] watching src/');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const only = args.includes('--files') ? args[args.indexOf('--files') + 1].split(',').filter(Boolean) : null;
  try {
    if (only) {
      check(walk(SRC));
      for (const rel of only) await buildOne(rel);
      console.log(`[build] rebuilt ${only.join(', ')}`);
    } else {
      await buildAll();
    }
  } catch (e) {
    console.error(`[build] ${(e as Error).message}`);
    process.exit(1);
  }
  if (args.includes('--watch')) watch();
  if (args.includes('--run')) {
    const electron = path.join(root, 'node_modules', '.bin', 'electron');
    const app = spawn(electron, ['.'], { cwd: root, stdio: 'inherit' });
    app.on('exit', (code) => process.exit(code ?? 0));
  }
}
