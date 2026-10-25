import * as projectData from './projectData';

// New Project — scaffold a net-new marketing site from a baseline, then hand
// it to the normal open pipeline (plans/new-project-from-baseline.md).
//
// Framework baselines run the OFFICIAL create CLIs non-interactively — Radial
// maintains no framework templates. Plain HTML has no official scaffolder, so
// a tiny built-in starter ships with the app (src/main/templates/plain-html).
//
//   preflight ──► scaffold ──────────────────► git init + first commit
//   (name slug,   html: copy built-in files     (github.ensureGitRepo +
//    collision,    next/astro: spawn create CLI,  ensureInitialCommit)
//    npm check)    stream output, stall guard)
//
// Cleanup rule: on scaffold failure/cancel we delete the project dir ONLY if
// this create call made it (preflight guarantees the path didn't exist). A
// pre-existing dir is never touched, and after git-ify nothing is deleted —
// a git failure keeps the files and tells the user where they are.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { childEnv, which } from './env';
import * as github from './github';
import type { SpawnOptions } from 'child_process';
import type { PackageJson } from './devServer';
import type { NewProjectArgs, NewProjectResult, ProjectTemplate } from '../shared/radialApi';

/** buildScaffoldArgs(): the create CLI to run (found on the PATH) and its arguments. */
export interface ScaffoldInvocation { cmd: 'npx' | 'npm'; args: string[] }
/** One of a scaffold child's output streams: chunks arrive as Buffers (no encoding is set). */
export interface ScaffoldOutput { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
/**
 * The scaffolder's process, as far as this module drives it: its output (null
 * when a stream isn't piped), its error and exit, and kill (a stall kills it,
 * Stop sends SIGTERM then SIGKILL, quitting SIGKILL). spawn()'s ChildProcess is
 * one; a test's fake is another.
 */
export interface ScaffoldChild {
  stdout: ScaffoldOutput | null;
  stderr: ScaffoldOutput | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}
/** How a scaffold starts its create CLI: child_process.spawn, or a test's fake. */
export type ScaffoldSpawn = (command: string, args: string[], options: SpawnOptions) => ScaffoldChild;
/**
 * createProject()'s options: the window's NewProjectArgs without the GitHub
 * step (main.ts createNewProject does that one). Any templateId is accepted:
 * one TEMPLATES doesn't list fails preflight. onLog gets each progress line,
 * the scaffolder's output included; spawnImpl defaults to spawn.
 */
export interface CreateProjectOptions extends Omit<NewProjectArgs, 'templateId' | 'github'> {
  templateId: string;
  onLog?: (line: string) => void;
  spawnImpl?: ScaffoldSpawn;
}
/** The create in flight (activeCreate): its scaffolder while one runs, the project folder, whether this create made the folder, and whether the user stopped it. */
interface CreateState { child: ScaffoldChild | null; dir: string; createdDir: boolean; cancelled: boolean }
/** runScaffold()'s options: where to run, where output lines go, the create's state (cancel finds the child there), and the spawn to use. */
interface ScaffoldRunOptions { cwd: string; onLog: (line: string) => void; state: CreateState; spawnImpl: ScaffoldSpawn }
/** A create that stopped before git (radialApi's NewProjectResult): the stage and what to tell the user. */
type CreateFailure = Exclude<Extract<NewProjectResult, { ok: false }>, { stage: 'git' }>;

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

const TEMPLATES: ProjectTemplate[] = [
  { id: 'astro', label: 'Astro', desc: 'Fast content sites', needsNode: true },
  { id: 'next', label: 'Next.js', desc: 'React, app-like sites', needsNode: true },
  { id: 'html', label: 'Plain HTML', desc: 'No build step, instant', needsNode: false },
];

/** Folder + npm-safe slug: lowercase kebab, no path separators, can't start
 *  with a dot/underscore (npm name rules), never empty-by-accident. */
function sanitizeProjectName(input: string | null | undefined): string {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/['’]/g, ''); // "Jo's" → "jos", not "jo-s"
  s = s.replace(/[^a-z0-9._-]+/g, '-');
  s = s.replace(/-{2,}/g, '-');
  s = s.replace(/^[-._]+|[-._]+$/g, '');
  return s.slice(0, 100);
}

const escapeHtml = (s: string): string => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c as '&' | '<' | '>' | '"' | "'"]
));

/**
 * The exact non-interactive invocations. Every prompt-bearing option is pinned
 * AND `--yes` backstops prompts the CLIs add later; install and git are both
 * disabled so the existing open pipeline (streaming install, stall guard) and
 * ensureGitRepo/ensureInitialCommit own those steps uniformly.
 * Verified against live `--help` output 2026-07-06 (create-astro v5.2.2).
 */
function buildScaffoldArgs(templateId: 'next' | 'astro', dir: string): ScaffoldInvocation;
function buildScaffoldArgs(templateId: 'html', dir: string): null;
function buildScaffoldArgs(templateId: ProjectTemplate['id'], dir: string): ScaffoldInvocation | null;
function buildScaffoldArgs(templateId: ProjectTemplate['id'], dir: string): ScaffoldInvocation | null {
  if (templateId === 'next') {
    return {
      cmd: 'npx',
      args: ['--yes', 'create-next-app@latest', dir,
        '--ts', '--tailwind', '--eslint', '--app', '--import-alias', '@/*',
        '--use-npm', '--skip-install', '--disable-git', '--yes'],
    };
  }
  if (templateId === 'astro') {
    // npm forwards everything after `--` to create-astro ([dir] [...flags]).
    return {
      cmd: 'npm',
      args: ['create', '-y', 'astro@latest', '--', dir,
        '--template', 'basics', '--no-install', '--no-git', '--skip-houston', '--yes'],
    };
  }
  return null;
}

// Text files get {{TOKEN}} replacement; everything else is byte-copied.
// read+write (not copyFileSync) so copying out of the packaged asar works.
const TEXT_EXT = new Set(['.html', '.css', '.js', '.md', '.txt', '.json', '.svg']);
function copyTemplate(srcDir: string, destDir: string, tokens: Record<string, string>): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === 'AGENTS.md' && projectData.isLocal(destDir)) continue;
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) { copyTemplate(from, to, tokens); continue; }
    if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) {
      let body = fs.readFileSync(from, 'utf8');
      for (const [k, v] of Object.entries(tokens)) body = body.split(`{{${k}}}`).join(v);
      fs.writeFileSync(to, body, 'utf8');
    } else {
      fs.writeFileSync(to, fs.readFileSync(from));
    }
  }
}

function runScaffold(cmd: string, args: string[], { cwd, onLog, state, spawnImpl }: ScaffoldRunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(cmd, args, {
      cwd,
      env: childEnv({ FORCE_COLOR: '0', CI: '1', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }),
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.child = child;
    let done = false;
    // Same stall policy as devServer.install(): a scaffold that produces no
    // output for 8 minutes is wedged (network stall or a prompt that slipped
    // past CI=1 + --yes) — kill it rather than spin forever.
    const STALL = 8 * 60 * 1000;
    let timer = setTimeout(onStall, STALL);
    function onStall() {
      if (done) return; done = true;
      try { child.kill(); } catch {}
      reject(new Error('Scaffold stalled (no output for 8 min). Check your network and try again.'));
    }
    const bump = () => { clearTimeout(timer); timer = setTimeout(onStall, STALL); };
    const onData = (buf: Buffer) => {
      bump();
      String(buf).replace(ANSI_RE, '').split(/\r?\n/).forEach((l) => { if (l.trim()) onLog(l.trim()); });
    };
    if (child.stdout) child.stdout.on('data', onData);
    if (child.stderr) child.stderr.on('data', onData);
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); });
    child.on('exit', (code, signal) => {
      if (done) return; done = true; clearTimeout(timer);
      state.child = null;
      if (state.cancelled || code === 0) return resolve(); // caller checks cancelled
      reject(new Error(`Scaffold failed (exit ${code == null ? signal : code}). See the log above for the reason.`));
    });
  });
}

let activeCreate: CreateState | null = null; // single-flight: one create at a time

const fail = (stage: CreateFailure['stage'], error: string): CreateFailure => ({ ok: false, stage, error });

/**
 * Create a project. Returns { ok, dir, displayName } or { ok:false, stage, error }.
 * stages: busy | preflight | scaffold | cancelled | git (git keeps the dir).
 */
async function createProject({ templateId, name, parentDir, onLog = () => {}, spawnImpl = spawn }: CreateProjectOptions): Promise<NewProjectResult> {
  if (activeCreate) return fail('busy', 'A project is already being created.');
  const t = TEMPLATES.find((x) => x.id === templateId);
  if (!t) return fail('preflight', 'Unknown template.');
  const displayName = String(name || '').trim();
  const slug = sanitizeProjectName(displayName);
  if (!slug) return fail('preflight', 'Enter a project name.');
  if (!parentDir || !String(parentDir).trim()) return fail('preflight', 'Choose where to create the project.');
  const parent = path.resolve(String(parentDir).trim());
  const dir = path.join(parent, slug);
  if (path.dirname(dir) !== parent) return fail('preflight', 'Invalid project name.');
  if (fs.existsSync(dir)) return fail('preflight', `A folder named “${slug}” already exists in ${parent}. Choose another name.`);
  try { fs.mkdirSync(parent, { recursive: true }); }
  catch (e) { return fail('preflight', `Could not create ${parent}: ${(e as Error).message}`); }
  if (t.needsNode && !which('npm')) {
    return fail('preflight', 'Node.js / npm not found. Install Node 18+ from nodejs.org, then try again, or start with Plain HTML.');
  }

  const state: CreateState = { child: null, dir, createdDir: false, cancelled: false };
  activeCreate = state;
  const cleanup = () => {
    if (!state.createdDir) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  try {
    if (t.id === 'html') {
      onLog('[radial] creating a plain HTML site…');
      state.createdDir = true;
      copyTemplate(path.join(__dirname, 'templates', 'plain-html'), dir, {
        SITE_NAME: escapeHtml(displayName || slug),
      });
    } else {
      const inv = buildScaffoldArgs(t.id, dir);
      const cmd = which(inv.cmd) || inv.cmd;
      onLog(`[radial] running ${inv.cmd} ${inv.args.join(' ')}`);
      // Preflight proved this path didn't exist, so whatever the scaffolder
      // puts there is ours to remove on failure.
      state.createdDir = true;
      await runScaffold(cmd, inv.args, { cwd: parent, onLog, state, spawnImpl });
    }
    if (state.cancelled) { cleanup(); return fail('cancelled', 'Cancelled.'); }
    // create-astro names the package after the whole target path
    // (var-folders-…-site); the project is its folder name.
    try {
      const pkgFile = path.join(dir, 'package.json');
      const pkg: PackageJson = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      if (pkg.name !== slug) { pkg.name = slug; fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n'); }
    } catch {}

    onLog('[radial] initialising git…');
    try {
      await github.ensureGitRepo(dir);
      await github.ensureInitialCommit(dir);
    } catch (e) {
      // The files on disk are valid — keep them and say where they are.
      return { ok: false, stage: 'git', dir, error: `Project created at ${dir}, but git setup failed: ${(e as Error).message}` };
    }
    onLog('[radial] ready');
    return { ok: true, dir, displayName: displayName || slug };
  } catch (e) {
    cleanup();
    if (state.cancelled) return fail('cancelled', 'Cancelled.');
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') return fail('scaffold', 'npx / npm wasn’t found. Install Node.js 18+ from nodejs.org.');
    return fail('scaffold', ((e as Error) && (e as Error).message) || 'Scaffold failed.');
  } finally {
    activeCreate = null;
  }
}

/** Stop the in-flight create (user hit Stop). The create resolves as cancelled. */
function cancel(): boolean {
  const st = activeCreate;
  if (!st) return false;
  st.cancelled = true;
  const child = st.child;
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
    const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
    if (hard.unref) hard.unref();
  }
  return true;
}

/** App is quitting mid-create: kill the child and best-effort remove the
 *  partial dir (a leftover just surfaces as a collision error on retry). */
function abortForQuit(): void {
  const st = activeCreate;
  if (!st) return;
  st.cancelled = true;
  try { if (st.child) st.child.kill('SIGKILL'); } catch {}
  if (st.createdDir) { try { fs.rmSync(st.dir, { recursive: true, force: true }); } catch {} }
}

export { TEMPLATES, sanitizeProjectName, buildScaffoldArgs, createProject, cancel, abortForQuit };
