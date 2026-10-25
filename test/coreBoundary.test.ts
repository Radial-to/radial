// The core (src/core) and its headless host (src/headless) run under plain
// Node, so nothing they load may be Electron (plans/headless-core.md). This
// walks the import graph from their entry points the way the app loads it:
// each file compiled by the build's own compile(), then every module it
// requires or imports by name, type-only imports gone as they are at runtime.
// A require with a computed name can't be followed; packages are leaves.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { builtinModules } from 'module';
import { compile } from '../scripts/transpile.mts';

const SRC = path.join(__dirname, '..', 'src');
const FORBIDDEN = ['electron', 'electron-updater'];

/** The module names a compiled file loads: require("x"), import("x"), and an ES module's import or export from "x". */
function loads(js: string): string[] {
  const names: string[] = [];
  for (const m of js.matchAll(/\brequire\(\s*"([^"]+)"\s*\)|\bimport\(\s*"([^"]+)"\s*\)|^\s*(?:import|export)\b[^;"]*?\bfrom\s*"([^"]+)"|^\s*import\s*"([^"]+)"/gm)) {
    names.push(m[1] || m[2] || m[3] || m[4]);
  }
  return names;
}

/** The source file a relative module name points at, as Node resolves it after the build (x.js was x.ts), or null for a missing one. */
function resolveIn(dir: string, name: string): string | null {
  const base = path.resolve(dir, name);
  const candidates = [base, `${base}.ts`, `${base}.cts`, `${base}.mts`, base.replace(/\.js$/, '.ts'), base.replace(/\.cjs$/, '.cts'), base.replace(/\.mjs$/, '.mts'), path.join(base, 'index.ts')];
  return candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) || null;
}

/** The package a bare module name belongs to (electron/main is electron's), or null for a Node built-in. */
function packageOf(name: string): string | null {
  if (name.startsWith('node:') || builtinModules.includes(name)) return null;
  const parts = name.split('/');
  return name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Every forbidden package reachable from an entry (a path inside src/), each with the chain of files that loads it. */
function forbiddenFrom(entry: string): string[] {
  const start = path.join(SRC, entry);
  assert.ok(fs.existsSync(start), `src/${entry} exists`);
  const from = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  const found = new Set<string>();
  const chain = (file: string): string[] => { const out: string[] = []; for (let f: string | null = file; f; f = from.get(f) ?? null) out.unshift(path.relative(SRC, f)); return out; };
  while (queue.length) {
    const file = queue.shift()!; // the loop runs while there is one
    const code = fs.readFileSync(file, 'utf8');
    const js = /\.(ts|cts|mts)$/.test(file) ? compile(path.relative(SRC, file).split(path.sep).join('/'), code) : code;
    for (const name of loads(js)) {
      if (name.startsWith('.') || path.isAbsolute(name)) {
        const next = resolveIn(path.dirname(file), name);
        if (!next || from.has(next) || !next.startsWith(SRC + path.sep) || !/\.(ts|cts|mts|js|cjs|mjs)$/.test(next)) continue; // missing (an optional file), seen, outside src/ (package.json), or data (JSON)
        from.set(next, file);
        queue.push(next);
      } else {
        const pkg = packageOf(name);
        if (pkg && FORBIDDEN.includes(pkg)) found.add([...chain(file), name].join(' → '));
      }
    }
  }
  return [...found];
}

// The radial-cli package's own entry points too: its bin and its postinstall (scripts/pack-cli.mts).
for (const entry of ['core/index.ts', 'headless/index.ts', 'headless/npmBin.ts', 'headless/nodePty.ts']) {
  test(`src/${entry} reaches neither electron nor electron-updater`, () => {
    assert.deepEqual(forbiddenFrom(entry), [], 'the core runs under plain Node: give it what it needs from Electron through a seam its host fills (plans/headless-core.md)');
  });
}

test('the walk finds Electron where the app does load it: main.ts, and the updater’s lazy require', () => {
  const fromMain = forbiddenFrom('main/main.ts');
  assert.ok(fromMain.includes('main/main.ts → electron'), 'main.ts imports electron');
  assert.ok(fromMain.includes('main/main.ts → main/migrate/shots.ts → electron'), 'and so does a module main.ts loads');
  assert.ok(fromMain.includes('main/main.ts → main/updater.ts → electron-updater'), 'updater.ts requires electron-updater inside a function');
  assert.deepEqual(forbiddenFrom('main/cliServer.ts'), [], 'the control server is Electron-free');
});
