#!/usr/bin/env node
// Type-checks every TypeScript project in the repo (tsc only checks; the build
// compiles). Prints each project's error count and exits non-zero on any.
//   node scripts/typecheck.mts            all projects
//   node scripts/typecheck.mts src/main   one project (its folder)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS = ['src/main', 'src/core', 'src/headless', 'src/preload', 'src/renderer', 'src/renderer/fluid', 'src/overlay', 'test', 'scripts'];
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const wanted = process.argv.slice(2).map((p) => p.replace(/\/$/, ''));
let failed = 0;
for (const project of PROJECTS) {
  if (wanted.length && !wanted.includes(project)) continue;
  const config = path.join(root, project, 'tsconfig.json');
  if (!fs.existsSync(config)) continue;
  const r = spawnSync(process.execPath, [tsc, '-p', config, '--pretty', 'false'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const errors = out.split('\n').filter((l) => /error TS\d+/.test(l));
  // "No inputs were found" just means no file in that project is TypeScript yet.
  const empty = /TS18003/.test(out);
  if (r.status !== 0 && !empty) {
    failed++;
    process.stdout.write(out);
  }
  console.log(`${project}: ${empty ? 'no TypeScript yet' : `${errors.length} errors`}`);
}
process.exit(failed ? 1 : 0);
