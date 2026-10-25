/**
 * Discover the Claude Code skills + slash commands installed on this machine, so
 * the agent composer can offer them in a `/` autocomplete. We scan the same
 * locations Claude Code itself reads:
 *   - skills:   ~/.claude/skills/<name>/SKILL.md  (and the project's .claude)
 *   - commands: ~/.claude/commands  *.md          (and the project's .claude)
 *   - plugins:  ~/.claude/plugins   (skills + commands, best-effort, namespaced)
 * Execution is handled by the SDK (settingSources in agent.js) — this is purely
 * the catalog for the menu.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Readable } from 'stream';

export interface SkillMeta { name: string; description: string }
/** Where an entry was found: the open project's .claude, the user's ~/.claude, or an installed plugin. */
export type SkillSource = 'project' | 'user' | 'plugin';
/** One `/name` the composer can offer. */
export interface SkillEntry extends SkillMeta { kind: 'command' | 'skill'; source: SkillSource }
/** Where an install lands: the project's .claude/skills or the user's ~/.claude/skills. */
export type SkillScope = 'project' | 'global';
/**
 * What install() resolves. The skills:install IPC answer can also be main.ts's
 * catch fallback, `{ installed: [], errors: [message] }`, which has no scope:
 * type that answer as `InstallResult | { installed: []; errors: string[] }`
 * (or give the fallback a scope) when main.ts is typed.
 */
export interface InstallResult { installed: string[]; errors: string[]; scope: SkillScope }

// Minimal frontmatter reader (name/description live in a leading --- block).
function frontmatter(src: string): Partial<Record<string, string>> {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Partial<Record<string, string>> = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (mm) out[mm[1].toLowerCase()] = mm[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

function metaFor(file: string, fallbackName: string): SkillMeta | null {
  let src = '';
  try { src = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const fm = frontmatter(src);
  let desc = fm.description || '';
  if (!desc) {
    const body = src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    const line = body.split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
    desc = line || '';
  }
  return { name: fm.name || fallbackName, description: (desc || '').slice(0, 160) };
}

// Recursively collect *.md files under a directory (bounded so a deep tree or a
// symlink loop can't hang discovery).
function walkMd(dir: string, maxDepth = 6, depth = 0, acc: string[] = []): string[] {
  if (depth > maxDepth || acc.length > 1000) return acc;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(full, maxDepth, depth + 1, acc);
    else if (e.isFile() && e.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

// Slash commands: a .md under a commands/ dir. Nested dirs namespace the name
// with ':' (Claude Code convention: commands/foo/bar.md → /foo:bar).
function scanCommands(commandsDir: string, source: SkillSource, out: SkillEntry[]): void {
  for (const file of walkMd(commandsDir)) {
    const rel = path.relative(commandsDir, file).replace(/\.md$/, '');
    const fallback = rel.split(path.sep).join(':');
    const meta = metaFor(file, fallback);
    if (meta && meta.name) out.push({ name: meta.name === fallback ? fallback : meta.name, description: meta.description, kind: 'command', source });
  }
}

// Skills: each <skillsDir>/<name>/SKILL.md.
function scanSkills(skillsDir: string, source: SkillSource, out: SkillEntry[]): void {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(skillsDir, e.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const meta = metaFor(file, e.name);
    if (meta && meta.name) out.push({ name: meta.name, description: meta.description, kind: 'skill', source });
  }
}

// Plugins: ~/.claude/plugins holds marketplaces/repos; each plugin can ship
// skills/ and commands/. Best-effort: find those dirs and namespace by the
// plugin folder name (the segment right before skills|commands).
function scanPlugins(pluginsRoot: string, out: SkillEntry[]): void {
  let dirs: string[] = [];
  try {
    const stack = [{ dir: pluginsRoot, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop()!;
      if (depth > 5) continue;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = path.join(dir, e.name);
        if (e.name === 'skills' || e.name === 'commands') dirs.push(full);
        else stack.push({ dir: full, depth: depth + 1 });
      }
    }
  } catch { return; }
  for (const d of dirs) {
    const plugin = path.basename(path.dirname(d));
    const tmp: SkillEntry[] = [];
    if (d.endsWith('commands')) scanCommands(d, 'plugin', tmp);
    else scanSkills(d, 'plugin', tmp);
    for (const it of tmp) { it.name = `${plugin}:${it.name}`; out.push(it); }
  }
}

function list(repoDir?: string | null): SkillEntry[] {
  const home = os.homedir();
  const out: SkillEntry[] = [];
  // Project first, then user, then plugins — dedupe keeps the earliest (most local).
  if (repoDir) {
    scanCommands(path.join(repoDir, '.claude', 'commands'), 'project', out);
    scanSkills(path.join(repoDir, '.claude', 'skills'), 'project', out);
  }
  scanCommands(path.join(home, '.claude', 'commands'), 'user', out);
  scanSkills(path.join(home, '.claude', 'skills'), 'user', out);
  // Only the installed marketplaces (skip plugins/cache, whose versioned dirs
  // would namespace skills as "1.1.0:" etc.).
  scanPlugins(path.join(home, '.claude', 'plugins', 'marketplaces'), out);

  // One entry per /name (a command and a skill can't both be invoked by the same
  // slash); first-seen (project > user > plugin) wins.
  const seen = new Map<string, SkillEntry>();
  for (const it of out) if (it.name && !seen.has(it.name)) seen.set(it.name, it);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// --- installing skills from dropped/picked files ---------------------------
// Sources: a folder (or .zip/.skill) containing a SKILL.md, or a single .md
// whose frontmatter carries a name. Targets the global (~/.claude/skills) or
// project (<repo>/.claude/skills) directory.
// The parts of yauzl used here, declared locally: this code treats the package
// as optional (the require below is guarded), and package.json doesn't list
// @types/yauzl, which only arrives as an optional dependency of Electron's
// extract-zip. A callback gets an error or a value, never both.
interface ZipEntry { fileName: string }
interface ZipFile {
  readEntry(): void;
  openReadStream(entry: ZipEntry, callback: (...args: [err: Error, stream: undefined] | [err: null, stream: Readable]) => void): void;
  on(event: 'entry', listener: (entry: ZipEntry) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}
interface Yauzl { open(path: string, options: { lazyEntries?: boolean }, callback: (...args: [err: Error, zipfile: undefined] | [err: null, zipfile: ZipFile]) => void): void }
let yauzl: Yauzl | null = null;
try { yauzl = require('yauzl') as Yauzl; } catch {}

function slugify(name?: string | null): string {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill';
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

// The directory that directly holds a SKILL.md — the given dir or the first
// descendant containing one. Bounded depth so a deep tree / symlink loop can't
// hang (archives wrap the skill anywhere from 0 to a couple levels down).
function findSkillDir(dir: string, depth = 0): string | null {
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  if (depth >= 4) return null;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.isDirectory()) { const found = findSkillDir(path.join(dir, e.name), depth + 1); if (found) return found; }
  }
  return null;
}

function extractZip(zipPath: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!yauzl) return reject(new Error('Zip support unavailable'));
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('entry', (entry: ZipEntry) => {
        const out = path.join(dest, entry.fileName);
        if (!out.startsWith(dest + path.sep)) { zip.readEntry(); return; } // zip-slip guard
        if (/\/$/.test(entry.fileName)) { fs.mkdirSync(out, { recursive: true }); zip.readEntry(); return; }
        fs.mkdirSync(path.dirname(out), { recursive: true });
        zip.openReadStream(entry, (e, rs) => {
          if (e) return reject(e);
          const ws = fs.createWriteStream(out);
          rs.on('error', reject); ws.on('error', reject);
          ws.on('close', () => zip.readEntry());
          rs.pipe(ws);
        });
      });
      zip.on('end', resolve);
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

// Install one skill folder (dir holding SKILL.md) into the target base.
function installSkillDir(skillDir: string, base: string): string {
  const meta = metaFor(path.join(skillDir, 'SKILL.md'), path.basename(skillDir));
  if (!meta || !meta.name) throw new Error('SKILL.md is missing a name in its YAML frontmatter');
  const name = slugify(meta.name);
  copyDir(skillDir, path.join(base, name));
  return name;
}

async function installOne(p: string, base: string): Promise<string> {
  const stat = fs.statSync(p); // throws if missing → caught by caller
  if (stat.isDirectory()) {
    const dir = findSkillDir(p);
    if (!dir) throw new Error('No SKILL.md found in that folder');
    return installSkillDir(dir, base);
  }
  const ext = path.extname(p).toLowerCase();
  if (ext === '.md') {
    const meta = metaFor(p, path.basename(p, '.md'));
    if (!meta || !meta.name) throw new Error('That .md needs a name in its YAML frontmatter');
    const name = slugify(meta.name);
    fs.mkdirSync(path.join(base, name), { recursive: true });
    fs.copyFileSync(p, path.join(base, name, 'SKILL.md'));
    return name;
  }
  if (ext === '.zip' || ext === '.skill') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-skill-'));
    try {
      await extractZip(p, tmp);
      const dir = findSkillDir(tmp);
      if (!dir) throw new Error('No SKILL.md found in that archive');
      return installSkillDir(dir, base);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }
  throw new Error('Unsupported file. Use a folder, .zip/.skill, or a SKILL .md');
}

async function install(repoDir: string | null | undefined, scope: SkillScope, paths?: string[] | null): Promise<InstallResult> {
  const home = os.homedir();
  const base = (scope === 'project' && repoDir)
    ? path.join(repoDir, '.claude', 'skills')
    : path.join(home, '.claude', 'skills');
  fs.mkdirSync(base, { recursive: true });
  const installed: string[] = [], errors: string[] = [];
  for (const p of (paths || [])) {
    try { installed.push(await installOne(p, base)); }
    catch (e) { errors.push(`${path.basename(p)}: ${(e as Error).message}`); }
  }
  return { installed, errors, scope: scope === 'project' ? 'project' : 'global' };
}

// metaFor/slugify/findSkillDir exported for unit tests (pure-ish helpers).
export { list, install, slugify, findSkillDir, metaFor, frontmatter };
