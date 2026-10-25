/**
 * Context files — markdown notes/docs that live WITH a project but are not part
 * of the published website: positioning, copy docs, call transcripts, agent
 * setup/skills, etc. They're stored in `.context/` (a neutrally-named folder —
 * the one Radial directory that's committed) so the in-repo agent (Claude Code)
 * can read them anywhere the repo is, while being excluded from the deploy.
 *
 * Everything else Radial writes — comments, images, linked sources, project
 * config — lives under `.radial/` / `.radial.json` and is kept out of git via the
 * per-clone `.git/info/exclude` (never committed, so the connected repo carries no
 * record of Radial).
 */

import fs from 'fs';
import path from 'path';
import * as projectData from './projectData';
import type { ContextFile, ContextFileResult, ContextReadResult, OkOrError, RadialApi } from '../shared/radialApi';

/** The ignore policy's one choice: commit .radial.json with the repo (default: keep it local). */
export interface IgnoreOptions { commitConfig?: boolean }
/** Runs git in a repo; migrate() takes publish.git so this module stays git-free. */
export type GitRunner = (repoDir: string, args: string[]) => Promise<unknown>;
/** setLocal(): the file's local flag after the toggle, or why sharing is refused (radialApi's contextSetLocal reply). */
export type LocalToggleResult = Awaited<ReturnType<RadialApi['contextSetLocal']>>;
/** importFiles(): the names the dropped files got in the context dir (radialApi's contextImport reply). */
export type ContextImport = Awaited<ReturnType<RadialApi['contextImport']>>;

const CTX_DIRNAME = '.context';            // committed; the only Radial dir in git
const CTX_PREFIX = CTX_DIRNAME + '/';      // '.context/' — per-file local-override lines
function contextDir(repoDir: string): string { return projectData.contextDir(repoDir); }

function readLines(file: string): string | null { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function hasLine(content: string | null, ...vals: string[]): boolean {
  return (content || '').split(/\r?\n/).some((l) => vals.includes(l.trim()));
}

// Append any missing lines to an ignore file under one comment header. Idempotent.
function appendIgnoreLines(file: string, lines: string[], comment: string): void {
  const content = readLines(file) || '';
  const missing = lines.filter((l) => !hasLine(content, l));
  if (!missing.length) return;
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, content + `${prefix}${comment}\n${missing.join('\n')}\n`, 'utf8');
}

// Resolve `.git/info/exclude` — git's per-clone ignore file, which is NEVER
// committed or pushed. Follows a `.git` *file* (linked worktrees / submodules)
// back to the shared git dir. Returns null when this isn't a git repo yet.
function localExcludePath(repoDir: string): string | null {
  const dotgit = path.join(repoDir, '.git');
  let gitDir: string;
  try {
    const st = fs.statSync(dotgit);
    if (st.isDirectory()) gitDir = dotgit;
    else {
      const m = (fs.readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+)$/m) || [])[1];
      if (!m) return null;
      let gd = m.trim();
      if (!path.isAbsolute(gd)) gd = path.resolve(repoDir, gd);
      // A linked worktree's gitdir is <common>/.git/worktrees/<name>; the exclude
      // file lives in the shared common dir's info/.
      const wt = gd.match(/^(.*)[/\\]worktrees[/\\][^/\\]+$/);
      gitDir = wt ? wt[1] : gd;
    }
  } catch { return null; }
  return path.join(gitDir, 'info', 'exclude');
}

// Append local-only ignore lines to `.git/info/exclude` (never committed).
function appendExcludeLines(repoDir: string, lines: string[]): void {
  const file = localExcludePath(repoDir);
  if (!file) return;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
  appendIgnoreLines(file, lines, '# local working files (not committed)');
}

// Keep Radial out of the connected repo entirely. Radial's own working data
// (.radial/, and .radial.json unless the project opts to commit its config) is
// ignored via the per-clone .git/info/exclude — never committed, so the repo
// carries no record of it. The committed-but-neutral .context/ is still excluded
// from the deploy via a real .vercelignore, because the host reads .vercelignore
// from the working tree (NOT .git/info/exclude); .radial/ is listed there too so
// local data never ships to a public preview. (.vercel is handled by vercel.js.)
function ensureIgnores(repoDir: string, { commitConfig = false }: IgnoreOptions = {}): void {
  if (projectData.isLocal(repoDir)) return;
  try {
    const localLines = ['.radial/'];
    if (!commitConfig) localLines.push('.radial.json');
    appendExcludeLines(repoDir, localLines);
    appendIgnoreLines(path.join(repoDir, '.vercelignore'), ['.context/', '.radial/'], '# Not deployed');
  } catch { /* best effort */ }
}
// Back-compat alias for callers that just want the ignore policy applied.
function ensureCommitted(repoDir: string): void { ensureIgnores(repoDir); }

// De-brand a tracked .gitignore left by older Radial versions (idempotent):
//   - stale context location: blanket '.radial/context/' dropped (context commits
//     now); a per-file override '.radial/context/x' becomes '.context/x'.
//   - Radial's own working data ('.radial/', '.radial.json') + its branded comment
//     are removed; they're re-applied to .git/info/exclude by ensureIgnores.
//   - the (generic, kept) build-artifact comment is neutralized.
function migrateIgnoreLines(repoDir: string): void {
  const gi = path.join(repoDir, '.gitignore');
  const content = readLines(gi);
  if (content == null) return;
  const out: string[] = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t === '.radial/context/' || t === '.radial/context') continue;
    if (/Radial context files/.test(t)) continue;
    if (t === '# Radial — local working files (not committed)') continue;
    if (t === '.radial/' || t === '.radial.json') continue;
    if (t === '# Radial — build artifacts (not committed)') { out.push('# Build output (not committed)'); continue; }
    const m = t.match(/^\.radial\/context\/(.+)$/);
    if (m) { out.push(CTX_PREFIX + m[1]); continue; }
    out.push(line);
  }
  const next = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (next !== content) fs.writeFileSync(gi, next, 'utf8');
}

// De-brand a tracked .vercelignore left by older versions (idempotent): the
// "kept in the repo" comment and the hidden-pages markers become neutral. The
// path lines (.context/, .radial/, draft pages) are left as-is.
function migrateVercelignore(repoDir: string): void {
  const vi = path.join(repoDir, '.vercelignore');
  const content = readLines(vi);
  if (content == null) return;
  const rename: Record<string, string> = {
    '# Radial — kept in the repo, not deployed': '# Not deployed',
    '# Radial: hidden pages (draft — not deployed)': '# drafts — not deployed',
    '# Radial: end hidden pages': '# end drafts',
  };
  const next = content.split('\n').map((l) => (l.trim() in rename ? rename[l.trim()] : l)).join('\n');
  if (next !== content) fs.writeFileSync(vi, next, 'utf8');
}

// One-time move from the old branded layout to the new one, run on project open:
//   .radial/context/  →  .context/        (committed, neutrally named)
//   per-file overrides .radial/context/x  →  .context/x
//   strip Radial branding from any tracked .gitignore/.vercelignore and relocate
//     Radial's own ignores to .git/info/exclude (so the repo carries no record).
//   untrack the now-local .radial/ + .radial.json if a prior version committed them.
// Idempotent + best-effort. `gitRm` is publish.git (injected to keep this git-free).
async function migrate(repoDir: string, gitRm?: GitRunner | null, opts: IgnoreOptions = {}): Promise<void> {
  if (projectData.isLocal(repoDir)) return;
  try {
    const oldCtx = path.join(repoDir, '.radial', 'context');
    const newCtx = contextDir(repoDir);
    if (fs.existsSync(oldCtx) && path.resolve(oldCtx) !== path.resolve(newCtx)) {
      fs.mkdirSync(newCtx, { recursive: true });
      for (const name of fs.readdirSync(oldCtx)) {
        const to = path.join(newCtx, name);
        if (fs.existsSync(to)) continue; // don't clobber an already-migrated file
        try { fs.renameSync(path.join(oldCtx, name), to); }
        catch { try { fs.copyFileSync(path.join(oldCtx, name), to); fs.rmSync(path.join(oldCtx, name)); } catch {} }
      }
      try { if (fs.readdirSync(oldCtx).length === 0) fs.rmdirSync(oldCtx); } catch {}
    }
  } catch { /* best effort */ }
  // Run for every repo on open (not just the old-layout ones) so a previously
  // connected repo gets its branded ignore lines cleaned out. Both are no-ops
  // when there's nothing to rewrite.
  try { migrateIgnoreLines(repoDir); } catch { /* best effort */ }
  try { migrateVercelignore(repoDir); } catch { /* best effort */ }
  ensureIgnores(repoDir, opts);
  if (gitRm) {
    const toUntrack = ['.radial'];
    if (!opts.commitConfig) toUntrack.push('.radial.json');
    for (const p of toUntrack) {
      try { await gitRm(repoDir, ['rm', '-r', '--cached', '--ignore-unmatch', p]); } catch { /* not tracked / not a repo */ }
    }
  }
}

// Per-file local-only override: a `.gitignore` line for just that file, e.g.
// `.context/secrets.md`. The context dir itself stays committed.
const giPath = (repoDir: string): string => path.join(repoDir, '.gitignore');
const fileIgnore = (rel: string): string => (CTX_PREFIX + String(rel || '')).replace(/\\/g, '/');

function isLocal(repoDir: string, rel: string): boolean {
  if (projectData.isLocal(repoDir)) return true;
  const c = readLines(giPath(repoDir));
  return !!c && hasLine(c, fileIgnore(rel));
}
function setLocal(repoDir: string, rel: string, local: boolean): LocalToggleResult {
  if (projectData.isLocal(repoDir)) return local ? { ok: true, local: true } : { ok: false, error: 'This project keeps all Radial data on this machine. Change its storage preference in Project settings to share files.' };
  ensureIgnores(repoDir); // keep the policy applied; we only toggle THIS file
  const gi = giPath(repoDir);
  const content = readLines(gi) || '';
  const line = fileIgnore(rel);
  const has = hasLine(content, line);
  try {
    if (local && !has) {
      const prefix = content && !content.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(gi, content + `${prefix}${line}\n`, 'utf8');
    } else if (!local && has) {
      const kept = content.split('\n').filter((l) => l.trim() !== line);
      fs.writeFileSync(gi, kept.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
    }
  } catch { /* best effort */ }
  return { ok: true, local: !!local };
}

function ensureDir(repoDir: string): string {
  const dir = contextDir(repoDir);
  fs.mkdirSync(dir, { recursive: true });
  ensureIgnores(repoDir); // keep the ignore policy applied whenever we touch context
  return dir;
}

// Resolve a relative name to an absolute path strictly inside the context dir.
function resolveSafe(repoDir: string, rel: string): string | null {
  const base = contextDir(repoDir);
  const abs = path.resolve(base, rel || '');
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

// Text files open in the in-app editor/viewer; everything else (PDF, images,
// docx, …) is stored as-is — the agent (Claude) can still read most of them.
const TEXT_RE = /\.(md|markdown|txt|mdx|csv|tsv|json|ya?ml|html?|xml|log)$/i;
function fileKind(name: string): ContextFile['kind'] { return TEXT_RE.test(name) ? 'text' : 'file'; }

function list(repoDir: string): ContextFile[] {
  const dir = contextDir(repoDir);
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const gi = readLines(giPath(repoDir)) || ''; // read once; flag per-file local overrides
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => {
      let mtime = 0; try { mtime = fs.statSync(path.join(dir, e.name)).mtimeMs; } catch {}
      return { name: e.name, rel: e.name, mtime, kind: fileKind(e.name), local: projectData.isLocal(repoDir) || hasLine(gi, fileIgnore(e.name)), storageLocal: projectData.isLocal(repoDir), abs: path.join(dir, e.name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function uniqueName(dir: string, fname: string): string {
  if (!fs.existsSync(path.join(dir, fname))) return fname;
  const ext = path.extname(fname);
  const base = ext ? fname.slice(0, -ext.length) : fname;
  let i = 2;
  while (fs.existsSync(path.join(dir, `${base}-${i}${ext}`))) i++;
  return `${base}-${i}${ext}`;
}

// Copy dropped files into the context dir (binary-safe), so they become context
// the agent and team can use. Any type is accepted; names are sanitized/deduped.
function importFiles(repoDir: string, paths?: readonly string[] | null): ContextImport {
  ensureDir(repoDir);
  const dir = contextDir(repoDir);
  const imported: string[] = [];
  for (const src of (paths || [])) {
    try {
      if (!fs.statSync(src).isFile()) continue; // skip folders
      let fname = (path.basename(src) || 'file').replace(/[/\\]/g, '-').replace(/[^a-zA-Z0-9._ -]/g, '').replace(/^\.+/, '').trim() || 'file';
      if (!path.extname(fname)) fname += '.txt';
      fname = uniqueName(dir, fname);
      fs.copyFileSync(src, path.join(dir, fname));
      imported.push(fname);
    } catch { /* skip unreadable */ }
  }
  return { ok: true, imported };
}

function absPath(repoDir: string, rel: string): string | null { return resolveSafe(repoDir, rel); }

function read(repoDir: string, rel: string): ContextReadResult {
  const abs = resolveSafe(repoDir, rel);
  if (!abs) return { ok: false, error: 'Invalid path' };
  try { return { ok: true, content: fs.readFileSync(abs, 'utf8'), abs }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

function write(repoDir: string, rel: string, content?: string | null): OkOrError {
  const abs = resolveSafe(repoDir, rel);
  if (!abs) return { ok: false, error: 'Invalid path' };
  try { ensureDir(repoDir); fs.writeFileSync(abs, content == null ? '' : String(content), 'utf8'); return { ok: true }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

function sanitizeName(name: string): string {
  // Leading dots would make a hidden file that list() filters out.
  let n = (name || '').trim().replace(/[/\\]/g, '-').replace(/[^a-zA-Z0-9._ -]/g, '').replace(/^\.+/, '').trim();
  if (!n) n = 'untitled';
  // Context can be any file type — keep a real extension (screenshot.png,
  // palette.json); only a bare name defaults to a markdown note.
  if (!path.extname(n)) n += '.md';
  return n;
}

function create(repoDir: string, name: string): ContextFileResult {
  ensureDir(repoDir);
  let fname = sanitizeName(name);
  const dir = contextDir(repoDir);
  if (fs.existsSync(path.join(dir, fname))) {
    const ext = path.extname(fname);
    const base = fname.slice(0, -ext.length);
    let i = 2;
    while (fs.existsSync(path.join(dir, `${base}-${i}${ext}`))) i++;
    fname = `${base}-${i}${ext}`;
  }
  const title = path.basename(fname, path.extname(fname)).replace(/[-_]/g, ' ');
  const seed = /\.(md|markdown)$/i.test(fname) ? `# ${title}\n\n` : '';
  try { fs.writeFileSync(path.join(dir, fname), seed, 'utf8'); return { ok: true, rel: fname, name: fname }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

// Write raw bytes (a pasted screenshot, a clipboard image) straight into the
// context dir — the paste-side twin of importFiles.
function importBytes(repoDir: string, name: string, bytes: Uint8Array): ContextFileResult {
  ensureDir(repoDir);
  const dir = contextDir(repoDir);
  let fname = (name || 'pasted.png').replace(/[/\\]/g, '-').replace(/[^a-zA-Z0-9._ -]/g, '').replace(/^\.+/, '').trim() || 'pasted.png';
  if (!path.extname(fname)) fname += '.png';
  fname = uniqueName(dir, fname);
  try { fs.writeFileSync(path.join(dir, fname), Buffer.from(bytes)); return { ok: true, rel: fname, name: fname }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

function rename(repoDir: string, rel: string, newName: string): ContextFileResult {
  const from = resolveSafe(repoDir, rel);
  if (!from) return { ok: false, error: 'Invalid path' };
  const fname = sanitizeName(newName);
  const to = resolveSafe(repoDir, fname);
  if (!to) return { ok: false, error: 'Invalid name' };
  if (from === to) return { ok: true, rel: fname, name: fname };
  if (fs.existsSync(to)) return { ok: false, error: 'A file with that name already exists' };
  try {
    const wasLocal = isLocal(repoDir, rel);
    fs.renameSync(from, to);
    if (wasLocal) { setLocal(repoDir, rel, false); setLocal(repoDir, fname, true); } // carry the local flag across the rename
    return { ok: true, rel: fname, name: fname };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

function remove(repoDir: string, rel: string): OkOrError {
  const abs = resolveSafe(repoDir, rel);
  if (!abs) return { ok: false, error: 'Invalid path' };
  try { fs.unlinkSync(abs); setLocal(repoDir, rel, false); return { ok: true }; } // drop any stale ignore line
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

export { list, read, write, create, rename, remove, contextDir, ensureCommitted, ensureIgnores, migrate, setLocal, isLocal, importFiles, importBytes, absPath };
