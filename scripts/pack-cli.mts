#!/usr/bin/env node
// The npm package `radial-cli`: Radial without a window, on any machine with
// Node (plans/headless-core.md, phase 5). Its `radial` runs the CLI, `radial
// serve` and `radial mcp` on that Node, and never looks for a Mac app.
//
//   npm run pack:cli [-- --out <dir>] [--prebuilds <dir>] [--official] [--no-build] [--keep]
//
//   --out <dir>        where the tarball goes (default dist/cli)
//   --prebuilds <dir>  node-pty binaries for Linux, <dir>/linux-x64/pty.node and
//                      <dir>/linux-arm64/pty.node, built against an old glibc by
//                      scripts/pty-prebuild.mts (the CI job, or Docker here).
//                      Without them, Linux installs compile node-pty.
//   --official         the official package, the only one that sends usage events:
//                      the analytics key (RADIAL_POSTHOG_KEY, from the environment
//                      or .env.local, never printed) goes into the package's
//                      official-build.json, as scripts/official-build.mts does for
//                      the app. Without it, the package sends nothing.
//   --no-build         use out/ as it is
//   --keep             leave the staged folder, and print where it is
//
// What it does:
//   1. Builds out/.
//   2. Traces every require from the package's entry points through out/: the
//      CLI, the headless core, the PTY daemon, the package's bin and its
//      postinstall. It refuses Electron, the Mac app's main process, the window's
//      code (but the shared modules the core uses) and any package it doesn't know.
//   3. Stages the package: those modules, the files they read at run time (the
//      page overlay, the new-site template, the migration playbook), bin/radial,
//      a README from the "Run Radial without a window" section of the public
//      README, LICENSE, NOTICE, a package.json of its own, and node-pty with its
//      prebuilt binaries, bundled (its own install script then finds them and
//      skips the compile).
//   4. npm pack, then checks the tarball (checkTarball): under the size budget,
//      the page overlay in it, and no Electron, renderer bundles or source maps.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');

/** The package's entry points in out/: the CLI (serve and mcp load from it), the headless core, the PTY daemon (its own process), the bin and the postinstall. */
export const ENTRIES = ['main/cli.js', 'headless/index.js', 'main/term-daemon.js', 'headless/npmBin.js', 'headless/nodePty.js'];
/** Files the code reads at run time rather than requires: the page overlay, the new-site template, the migration playbook. */
export const DATA = ['overlay/overlay.js', 'main/templates/', 'main/migrate/playbook/'];
/** The window's modules the core may load: the shared ones (scripts/transpile.mts DUAL) for project names, task titles and page links. */
const RENDERER_SHARED = ['renderer/fuzzy.js', 'renderer/taskTitle.js', 'renderer/navigation.js'];
/** Never in the package: the Mac app's main process and what only it loads, the preload, the window. */
const NEVER = [/^main\/main\.js$/, /^main\/updater\.js$/, /^main\/migrate\/shots\.js$/, /^preload\//, /^renderer\/(?!(fuzzy|taskTitle|navigation)\.js$)/, /\.map$/];
/** The packages the core may load, and how the package depends on each. */
export const PACKAGES: Record<string, 'dependency' | 'optional' | 'bundled'> = {
  '@xterm/headless': 'dependency', // agent output as text (ttyText)
  'posthog-node': 'dependency', // usage events, official packages only
  'node-pty': 'bundled', // the agent terminals; bundled with Linux prebuilds
  'playwright-core': 'optional', // the browser for page work (radial browser install)
};
const FORBIDDEN_PACKAGES = ['electron', 'electron-updater'];
/** Where the package's tarball must stay: what npm downloads, and what it unpacks. */
export const BUDGET = { packed: 4 * 1024 * 1024, unpacked: 12 * 1024 * 1024 };
/** node-pty's prebuilt binaries the package carries: node-pty's own for macOS, and Linux ones from --prebuilds. Windows isn't a platform radial serve runs on yet. */
const PTY_PREBUILDS = { own: ['darwin-arm64', 'darwin-x64'], linux: ['linux-x64', 'linux-arm64'] };

/** What a trace of out/ found: its files (relative to out/), and each package with the files that load it. */
export interface Trace { files: string[]; packages: Map<string, Set<string>>; missing: string[] }

const BUILTINS = new Set(['assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs', 'fs/promises', 'http', 'https', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'readline', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib']);
/** The package a module name belongs to (@scope/name/sub is @scope/name's), or null for a Node built-in. */
function packageOf(name: string): string | null {
  if (name.startsWith('node:') || BUILTINS.has(name)) return null;
  const parts = name.split('/');
  return name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Every file in out/ the entries load, following require("…") with a
 * literal name, the way esbuild's CommonJS output writes them. A require
 * with a computed name can't be followed: the core has none on these paths.
 */
export function trace(outDir: string, entries: string[] = ENTRIES): Trace {
  const files = new Set<string>(), packages = new Map<string, Set<string>>(), missing: string[] = [];
  const queue = entries.map((e) => path.join(outDir, e));
  while (queue.length) {
    const file = queue.shift()!;
    const rel = path.relative(outDir, file).split(path.sep).join('/');
    if (files.has(rel)) continue;
    if (!fs.existsSync(file)) { missing.push(rel); continue; }
    files.add(rel);
    if (!file.endsWith('.js') && !file.endsWith('.cjs')) continue;
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\brequire\("([^"]+)"\)/g)) {
      const name = m[1];
      if (name.startsWith('.')) {
        const base = path.resolve(path.dirname(file), name);
        const hit = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
        if (!hit) { missing.push(`${name} (from ${rel})`); continue; }
        if (!hit.startsWith(outDir + path.sep)) continue; // ../../package.json: the package's own, written here
        queue.push(hit);
      } else {
        const pkg = packageOf(name);
        if (!pkg) continue;
        if (!packages.has(pkg)) packages.set(pkg, new Set());
        packages.get(pkg)!.add(rel);
      }
    }
  }
  return { files: [...files].sort(), packages, missing };
}

/** What's wrong with a trace: a missing module, Electron, the app's or the window's code, a package nobody listed. */
export function checkTrace(t: Trace): string[] {
  const problems: string[] = [];
  for (const m of t.missing) problems.push(`can't find ${m}`);
  for (const f of t.files) if (NEVER.some((re) => re.test(f))) problems.push(`out/${f} is the Mac app's or the window's, and the core loads it`);
  for (const [pkg, from] of t.packages) {
    if (FORBIDDEN_PACKAGES.includes(pkg)) problems.push(`${pkg} is loaded by ${[...from].join(', ')}`);
    else if (!PACKAGES[pkg]) problems.push(`${pkg} (loaded by ${[...from].join(', ')}) isn't one of the package's dependencies: add it to PACKAGES in scripts/pack-cli.mts`);
  }
  return problems;
}

/** One file in a tarball: its path inside the package and its size. */
export interface TarEntry { path: string; size: number }
/**
 * The size test: what's wrong with a packed tarball (its files, and its size
 * on the wire). official: whether it was packed with --official, so it must
 * carry the analytics config, and any other package must not.
 */
export function checkTarball(entries: TarEntry[], packedBytes: number, { official = false }: { official?: boolean } = {}): string[] {
  const problems: string[] = [];
  const unpacked = entries.reduce((n, e) => n + e.size, 0);
  if (packedBytes > BUDGET.packed) problems.push(`the tarball is ${mb(packedBytes)}, over its ${mb(BUDGET.packed)} budget`);
  if (unpacked > BUDGET.unpacked) problems.push(`it unpacks to ${mb(unpacked)}, over its ${mb(BUDGET.unpacked)} budget`);
  const paths = entries.map((e) => e.path.replace(/^package\//, ''));
  if (!paths.includes('out/overlay/overlay.js')) problems.push('out/overlay/overlay.js (the page overlay) is missing');
  if (!paths.includes('bin/radial')) problems.push('bin/radial is missing');
  const config = paths.includes('out/main/official-build.json');
  if (official && !config) problems.push('out/main/official-build.json is missing from an --official package');
  if (!official && config) problems.push('out/main/official-build.json (the analytics key) is in a package made without --official');
  for (const p of paths) {
    if (/(^|\/)node_modules\/(electron|electron-updater)\//.test(p) || /(^|\/)electron(\.js)?$/.test(p)) problems.push(`${p} is Electron`);
    if (p.endsWith('.map')) problems.push(`${p} is a source map`);
    if (/^out\/renderer\//.test(p) && !RENDERER_SHARED.includes(p.slice('out/'.length))) problems.push(`${p} is the window's`);
    if (/^out\/(preload\/|main\/main\.js$|main\/updater\.js$)/.test(p)) problems.push(`${p} is the Mac app's`);
    if (/(^|\/)vendor\//.test(p) && p.startsWith('out/')) problems.push(`${p} is a vendored bundle`);
  }
  return problems;
}
const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** A value from the environment, else from .env.local (KEY=value lines), never printed. */
function secret(name: string): string {
  const fromEnv = (process.env[name] || '').trim();
  if (fromEnv) return fromEnv;
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && m[1] === name) return m[2].replace(/^(['"])(.*)\1$/, '$2').trim();
    }
  } catch {}
  return '';
}

/** The text under a README's `## <heading>`, up to the next `## `. */
function readmeSection(text: string, heading: string): string {
  const rest = text.slice(text.indexOf(`\n## ${heading}\n`) + 1).split('\n');
  const end = rest.findIndex((l, i) => i > 0 && /^## /.test(l));
  return rest.slice(1, end === -1 ? undefined : end).join('\n').trim();
}

/** The package's README, from the public README (oss/README.md here, README.md in the public copy): its "Run Radial without a window" section, and the part of "Usage data" about the package, from the first paragraph that names `radial-cli`. */
export function packageReadme(repo: string, root = ROOT): string {
  const source = ['oss/README.md', 'README.md'].map((f) => path.join(root, f)).find((f) => fs.existsSync(f) && /^## Run Radial without a window$/m.test(fs.readFileSync(f, 'utf8')));
  if (!source) throw new Error('No "## Run Radial without a window" section in oss/README.md (or README.md): the package\'s README comes from it.');
  const text = fs.readFileSync(source, 'utf8').replaceAll('{{REPO}}', repo).replaceAll('{{REPO_NAME}}', repo.split('/')[1]);
  const body = readmeSection(text, 'Run Radial without a window').replace(/^### /gm, '## ');
  const usage = /^## Usage data$/m.test(text) ? readmeSection(text, 'Usage data').split(/\n\n+/) : [];
  const from = usage.findIndex((p) => p.includes('`radial-cli`'));
  if (from === -1 || !usage.slice(from).some((p) => p.includes('radial telemetry off'))) throw new Error('The README\'s "## Usage data" section needs a paragraph about the `radial-cli` package and how to turn its events off (`radial telemetry off`): the package\'s README carries it.');
  return `# radial-cli\n\n${body}\n\n## Usage data\n\n${usage.slice(from).join('\n\n')}\n\n## Source\n\nRadial is open source under the Apache License 2.0: https://github.com/${repo}\n`;
}

/** The oldest Node the package runs on: Radial's own floor (doctor's MIN_NODE, bin/radial, the repo's engines). */
export const MIN_NODE = '22.18';
/** The package's bin/radial: refuses a Node too old to load the core, then runs it (src/headless/npmBin.ts). Plain old JavaScript, so any Node can read it far enough to say so. */
const BIN = `#!/usr/bin/env node
// radial-cli's \`radial\`: Radial without a window on this machine's Node (out/headless/npmBin.js).
'use strict';
var v = process.versions.node.split('.').map(Number);
if (v[0] < 22 || (v[0] === 22 && v[1] < 18)) {
  process.stderr.write('radial: Radial runs on Node ${MIN_NODE} or newer, and this is Node ' + process.versions.node + '.\\n');
  process.exit(1);
}
require('../out/headless/npmBin.js');
`;

/** Copies a file, keeping its mode (node-pty's spawn-helper must stay executable). */
function copy(from: string, to: string, mode?: number): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, mode ?? (fs.statSync(from).mode & 0o777));
}
function copyDir(from: string, to: string, keep: (rel: string) => boolean = () => true, base = from): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const abs = path.join(from, entry.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (!keep(rel)) continue;
    if (entry.isDirectory()) copyDir(abs, path.join(to, entry.name), keep, base);
    else if (entry.isFile()) copy(abs, path.join(to, entry.name));
  }
}

/**
 * node-pty for the bundle: its JavaScript, what a compile needs (binding.gyp,
 * the Unix sources, its install scripts), and prebuilt binaries for macOS
 * (its own) and Linux (--prebuilds). Not its Windows sources and binaries,
 * nor a build/ folder made on this machine for Electron.
 */
function stageNodePty(stage: string, prebuilds: string | null): string[] {
  const from = path.join(ROOT, 'node_modules', 'node-pty');
  const to = path.join(stage, 'node_modules', 'node-pty');
  const notes: string[] = [];
  for (const f of ['package.json', 'LICENSE', 'README.md', 'binding.gyp']) copy(path.join(from, f), path.join(to, f));
  copyDir(path.join(from, 'lib'), path.join(to, 'lib'), (rel) => !/\.test\.js$|\.map$/.test(rel));
  copyDir(path.join(from, 'scripts'), path.join(to, 'scripts'));
  copyDir(path.join(from, 'src', 'unix'), path.join(to, 'src', 'unix'));
  for (const dir of PTY_PREBUILDS.own) {
    const src = path.join(from, 'prebuilds', dir);
    if (!fs.existsSync(path.join(src, 'pty.node'))) throw new Error(`node_modules/node-pty/prebuilds/${dir}/pty.node is missing: run npm ci`);
    copyDir(src, path.join(to, 'prebuilds', dir));
    const helper = path.join(to, 'prebuilds', dir, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755); // node-pty 1.1 ships it without its execute bit
  }
  for (const dir of PTY_PREBUILDS.linux) {
    const bin = prebuilds ? path.join(prebuilds, dir, 'pty.node') : null;
    if (bin && fs.existsSync(bin)) { copy(bin, path.join(to, 'prebuilds', dir, 'pty.node'), 0o755); notes.push(dir); }
  }
  // node-addon-api: node-pty's one dependency, header files a compile needs. Bundled with it, so a compile needs nothing from the network but Node's headers.
  copyDir(path.join(ROOT, 'node_modules', 'node-addon-api'), path.join(stage, 'node_modules', 'node-addon-api'), (rel) => !/^(doc|tools)\//.test(rel) && !rel.endsWith('.md') || rel === 'LICENSE.md');
  return notes;
}

/** The installed version of a package, from its package.json in node_modules. */
function installedVersion(pkg: string): string {
  return (JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8')) as { version: string }).version;
}

/**
 * `files` for package.json, the allowlist npm packs from: each staged file of
 * out/ under the highest folder that ships whole (out/core/), else by itself
 * (out/main/cli.js), so a module the trace didn't ask for never ships.
 */
function filesAllowlist(stagedOut: string[]): string[] {
  const staged = new Set(stagedOut);
  const wholeCache = new Map<string, boolean>();
  const whole = (dir: string): boolean => {
    if (!wholeCache.has(dir)) {
      let all = true;
      const walk = (d: string) => { for (const e of fs.readdirSync(path.join(OUT, d), { withFileTypes: true })) { const r = `${d}/${e.name}`; if (e.isDirectory()) walk(r); else if (!staged.has(r) && !r.endsWith('.map')) all = false; } };
      walk(dir);
      wholeCache.set(dir, all);
    }
    return wholeCache.get(dir)!;
  };
  const out = new Set<string>();
  for (const f of stagedOut) {
    const parts = f.split('/');
    let entry = `out/${f}`;
    for (let i = 1; i < parts.length; i++) { const dir = parts.slice(0, i).join('/'); if (whole(dir)) { entry = `out/${dir}/`; break; } }
    out.add(entry);
  }
  return ['bin/radial', ...[...out].sort(), 'README.md', 'LICENSE', 'NOTICE'];
}

/** Parses this script's flags. */
function parseArgs(argv: string[]): { out: string; prebuilds: string | null; official: boolean; build: boolean; keep: boolean } {
  const a = { out: path.join(ROOT, 'dist', 'cli'), prebuilds: null as string | null, official: false, build: true, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = path.resolve(argv[++i]);
    else if (k === '--prebuilds') a.prebuilds = path.resolve(argv[++i]);
    else if (k === '--official') a.official = true;
    else if (k === '--no-build') a.build = false;
    else if (k === '--keep') a.keep = true;
    else throw new Error(`Unknown option ${k}. Usage: npm run pack:cli -- [--out <dir>] [--prebuilds <dir>] [--official] [--no-build] [--keep]`);
  }
  return a;
}

/** Packs the package; answers the tarball's path. */
export async function pack(argv: string[]): Promise<string> {
  const args = parseArgs(argv);
  const appPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string; repository?: { url?: string } };
  const repo = (/github\.com\/([^/]+\/[^/.]+)/.exec(appPkg.repository?.url || '') || [])[1] || 'Radial-to/radial';
  let key = '';
  if (args.official) {
    key = secret('RADIAL_POSTHOG_KEY');
    if (!key) throw new Error('--official needs RADIAL_POSTHOG_KEY, in the environment or .env.local: the official package carries the analytics key.');
  }
  if (args.prebuilds && !fs.existsSync(args.prebuilds)) throw new Error(`--prebuilds ${args.prebuilds} doesn't exist`);
  if (args.build) await (await import('./build.mts')).buildAll(); // loaded only to build: the tests pack with --no-build, from a CommonJS loader that can't take build.mts's top-level await

  // 2. What the package loads.
  const t = trace(OUT);
  const problems = checkTrace(t);
  if (problems.length) throw new Error(`The package's modules aren't right:\n  ${problems.join('\n  ')}`);
  const data: string[] = [];
  for (const d of DATA) {
    const abs = path.join(OUT, d);
    if (!fs.existsSync(abs)) throw new Error(`out/${d} is missing (run the build)`);
    if (fs.statSync(abs).isDirectory()) { const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else data.push(path.relative(OUT, f).split(path.sep).join('/')); } }; walk(abs); }
    else data.push(d);
  }
  const outFiles = [...new Set([...t.files, ...data])].filter((f) => !f.endsWith('.map')).sort();

  // 3. The staged package.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-cli-'));
  try {
    for (const f of outFiles) copy(path.join(OUT, f), path.join(stage, 'out', f));
    if (key) fs.writeFileSync(path.join(stage, 'out', 'main', 'official-build.json'), JSON.stringify({ posthogKey: key, posthogHost: secret('RADIAL_POSTHOG_HOST') || 'https://us.i.posthog.com' }, null, 2) + '\n');
    fs.mkdirSync(path.join(stage, 'bin'));
    fs.writeFileSync(path.join(stage, 'bin', 'radial'), BIN, { mode: 0o755 });
    fs.writeFileSync(path.join(stage, 'README.md'), packageReadme(repo));
    for (const f of ['LICENSE', 'NOTICE']) copy(path.join(ROOT, f), path.join(stage, f), 0o644);
    const linux = stageNodePty(stage, args.prebuilds);
    const versions = Object.fromEntries(Object.keys(PACKAGES).map((p) => [p, installedVersion(p)]));
    const pkg = {
      name: 'radial-cli',
      version: appPkg.version,
      description: 'Radial without a window: radial serve, the radial command line and radial mcp, for coding agents on a server, in a VM or in a container.',
      keywords: ['radial', 'mcp', 'coding-agent', 'claude-code', 'codex', 'marketing-site', 'headless'],
      homepage: 'https://radial.to',
      repository: { type: 'git', url: `https://github.com/${repo}.git` },
      bugs: { url: `https://github.com/${repo}/issues` },
      license: 'Apache-2.0',
      author: 'Radial LLC',
      bin: { radial: 'bin/radial' },
      engines: { node: `>=${MIN_NODE}` },
      os: ['darwin', 'linux'],
      files: [...filesAllowlist(outFiles), ...(key ? ['out/main/official-build.json'] : [])],
      scripts: { postinstall: 'node out/headless/nodePty.js install' },
      dependencies: Object.fromEntries(Object.entries(PACKAGES).filter(([, k]) => k !== 'optional').map(([p]) => [p, versions[p]])),
      optionalDependencies: Object.fromEntries(Object.entries(PACKAGES).filter(([, k]) => k === 'optional').map(([p]) => [p, versions[p]])),
      bundleDependencies: Object.entries(PACKAGES).filter(([, k]) => k === 'bundled').map(([p]) => p),
    };
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

    // 4. npm pack, and the size test.
    fs.mkdirSync(args.out, { recursive: true });
    const r = spawnSync('npm', ['pack', '--json', '--pack-destination', args.out], { cwd: stage, encoding: 'utf8', env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false', npm_config_fund: 'false' } });
    if (r.status !== 0) throw new Error(`npm pack failed:\n${r.stderr || r.stdout}`);
    const info = (JSON.parse(r.stdout) as { filename: string; size: number; unpackedSize: number; entryCount: number; files: { path: string; size: number }[] }[])[0];
    const tarball = path.join(args.out, info.filename);
    const bad = checkTarball(info.files.map((f) => ({ path: f.path, size: f.size })), info.size, { official: !!key });
    if (bad.length) throw new Error(`The tarball fails its checks:\n  ${bad.join('\n  ')}`);
    console.log(`radial-cli ${pkg.version}: ${tarball}`);
    console.log(`  ${info.entryCount} files, ${mb(info.size)} packed (budget ${mb(BUDGET.packed)}), ${mb(info.unpackedSize)} unpacked (budget ${mb(BUDGET.unpacked)})`);
    console.log(`  ${outFiles.filter((f) => f.endsWith('.js')).length} modules from out/, node-pty ${versions['node-pty']} bundled with prebuilt binaries for ${[...PTY_PREBUILDS.own, ...linux].join(', ')}${linux.length < PTY_PREBUILDS.linux.length ? `; ${PTY_PREBUILDS.linux.filter((d) => !linux.includes(d)).join(' and ')} compile${linux.length ? 's' : ''} on install (--prebuilds adds them)` : ''}`);
    console.log(`  ${key ? 'Official: sends anonymous usage events (the key is in out/main/official-build.json).' : 'Not official: no analytics key, sends nothing.'}`);
    if (args.keep) console.log(`  Staged in ${stage}`);
    return tarball;
  } finally {
    if (!args.keep) fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  pack(process.argv.slice(2)).catch((e: unknown) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
}
