// Storage policy belongs to this installation, never to a project's config.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/** Where a project keeps its Radial data: the machine default, this Mac only, or the project folder. */
export type StoragePreference = 'default' | 'local' | 'project';

/** One project's entry in project-data/preferences.json, keyed by its real path. */
export interface ProjectStorageRecord {
  /** Names the project's folder under project-data/. */
  id: string;
  preference: StoragePreference;
  /** Where the data lives now; it follows `preference` when the project next activates. */
  local: boolean;
  /** Content hashes from each switch, by side (`'true'` local, `'false'` project folder), then by relative path. */
  snapshots?: Record<string, Record<string, string>>;
}

/** project-data/preferences.json: this installation's storage policy. */
export interface ProjectStoragePreferences {
  defaultLocal: boolean;
  projects: Record<string, ProjectStorageRecord>;
}

/** The four places a project's Radial data lives, in the project folder or the local one. */
export interface StorageLocations {
  data: string;
  config: string;
  context: string;
  rules: string;
}

/** What the storage settings show; the location fields are missing before init(). */
export interface ProjectStorageStatus {
  defaultLocal: boolean;
  preference: StoragePreference;
  local: boolean;
  /** A switch waits for the project's terminals to close. */
  pending: boolean;
  folder?: string;
  contextPath?: string | null;
  rulesPath?: string | null;
  existingFiles?: string[];
}

/**
 * A change from the settings: one project's preference (with repoDir) or the
 * machine default. Typed as what the window sends over IPC (a select's value,
 * a checkbox's state); set() is the validator and throws on anything else.
 */
export interface ProjectStoragePatch {
  repoDir?: string | null;
  /** A StoragePreference; set() rejects any other value. */
  preference?: string;
  defaultLocal?: boolean;
}

interface StorageFile {
  from: string;
  to: string;
  rel: string;
  hash?: string;
}

let root: string | null = null;
let readOnly = false;
let store: ProjectStoragePreferences = { defaultLocal: false, projects: {} };
const active = new Set<string>();

function key(dir: string): string {
  const resolved = path.resolve(dir);
  try { return fs.realpathSync(resolved); }
  catch {
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(key(parent), path.basename(resolved));
  }
}
function init(userData: string, options: { readOnly?: boolean } = {}): void {
  root = path.join(key(userData), 'project-data');
  readOnly = !!options.readOnly;
  active.clear();
  try {
    const saved: ProjectStoragePreferences = JSON.parse(fs.readFileSync(path.join(root, 'preferences.json'), 'utf8'));
    if (typeof saved.defaultLocal !== 'boolean' || !saved.projects || typeof saved.projects !== 'object') throw new Error('Invalid project storage preferences');
    store = saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    store = { defaultLocal: false, projects: {} };
  }
}
function persist(): void {
  if (readOnly) throw new Error('Storage preferences are read-only in this process');
  fs.mkdirSync(root!, { recursive: true });
  const file = path.join(root!, 'preferences.json');
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function wanted(record: ProjectStorageRecord): boolean { return record?.preference === 'local' || (record?.preference !== 'project' && store.defaultLocal); }
function localRoot(dir: string, record: ProjectStorageRecord): string { return path.join(root!, record.id); }
// paths() passes an empty record before init(); local is false then, so it is never read.
function locations(dir: string, record: ProjectStorageRecord, local: boolean): StorageLocations;
function locations(dir: string, record: Partial<ProjectStorageRecord>, local: false): StorageLocations;
function locations(dir: string, record: Partial<ProjectStorageRecord>, local: boolean): StorageLocations {
  const base = local ? localRoot(dir, record as ProjectStorageRecord) : dir;
  return {
    data: path.join(base, '.radial'),
    config: path.join(base, '.radial.json'),
    context: path.join(base, '.context'),
    rules: path.join(base, 'AGENTS.md'),
  };
}
function entries(from: string, to: string, out: StorageFile[] = [], rel = ''): StorageFile[] {
  let stat;
  try { stat = fs.lstatSync(from); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return out; throw e; }
  if (stat.isSymbolicLink()) throw new Error(`Cannot move Radial data through a symbolic link: ${from}`);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(from)) {
      if (!rel && ['review-site', 'linked'].includes(name)) continue; // Rebuildable caches, not project data.
      entries(path.join(from, name), path.join(to, name), out, rel ? rel + '/' + name : name);
    }
  } else if (stat.isFile()) out.push({ from, to, rel });
  return out;
}
const digest = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function checkDestination(file: string): void {
  let at = file;
  while (at !== path.dirname(at)) {
    try { if (fs.lstatSync(at).isSymbolicLink()) throw new Error(`Cannot move Radial data through a symbolic link: ${at}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    at = path.dirname(at);
  }
}
function migrate(dir: string, record: ProjectStorageRecord, local: boolean): void {
  const from = locations(dir, record, !local), to = locations(dir, record, local);
  const kinds: (keyof StorageLocations)[] = local ? ['data', 'config', 'context'] : ['data', 'config', 'context', 'rules'];
  const files = kinds.flatMap(kind => entries(from[kind], to[kind]).map(file => ({ ...file, rel: kind + (file.rel ? '/' + file.rel : '') })));
  // Older versions kept notes under .radial/context. Import missing documents
  // on first use while preserving both versions if a modern copy also exists.
  if (local && !record.snapshots) {
    const known = new Set(files.map(file => file.rel));
    for (const file of entries(path.join(from.data, 'context'), to.context)) {
      const rel = 'context/' + file.rel;
      if (!known.has(rel)) files.push({ ...file, rel });
    }
  }
  const previousTarget: Record<string, string> = record.snapshots?.[String(local)] || {};
  const sourceSnapshot: Record<string, string> = {};
  for (const file of files) {
    checkDestination(file.to);
    file.hash = digest(file.from);
    sourceSnapshot[file.rel] = file.hash;
    if (!fs.existsSync(file.to)) continue;
    if (!fs.lstatSync(file.to).isFile()) throw new Error(`Storage destination is not a regular file: ${file.to}`);
    const targetHash = digest(file.to);
    if (targetHash !== file.hash && targetHash !== previousTarget[file.rel]) {
      throw new Error(`Both storage locations contain different versions of ${path.basename(file.to)}. The originals are preserved. Resolve the copies before switching storage.`);
    }
  }
  // Named for the time, and unique: two switches in one millisecond (a fast machine) must not share a folder.
  const backup = path.join(localRoot(dir, record), 'storage-backups', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  for (const file of files) {
    if (fs.existsSync(file.to)) {
      if (digest(file.to) === file.hash) continue;
      const saved = path.join(backup, file.rel);
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.copyFileSync(file.to, saved, fs.constants.COPYFILE_EXCL);
    }
    fs.mkdirSync(path.dirname(file.to), { recursive: true });
    const tmp = file.to + '.storage-tmp-' + process.pid;
    fs.copyFileSync(file.from, tmp);
    fs.renameSync(tmp, file.to);
  }
  record.snapshots = { ...record.snapshots, [String(!local)]: sourceSnapshot };
}
function recordFor(dir: string): ProjectStorageRecord {
  const k = key(dir);
  if (root === k || root!.startsWith(k + path.sep)) throw new Error('Radial’s application data folder must be outside this project.');
  if (!store.projects[k]) {
    const record: ProjectStorageRecord = { id: crypto.createHash('sha256').update(k).digest('hex').slice(0, 24), preference: 'default', local: false };
    if (!readOnly && wanted(record)) { migrate(k, record, true); record.local = true; }
    store.projects[k] = record;
    if (!readOnly) {
      try { persist(); } catch (error) { delete store.projects[k]; throw error; }
    }
  }
  return store.projects[k];
}
function isLocal(dir: string): boolean { return !!root && recordFor(dir).local; }
function paths(dir: string): StorageLocations {
  if (!root) return locations(dir, {}, false); // Standalone consumers retain the legacy layout until initialized.
  const record = recordFor(dir);
  const out = locations(key(dir), record, record.local);
  if (record.local && !readOnly) fs.mkdirSync(localRoot(dir, record), { recursive: true });
  return out;
}
function dataDir(dir: string, ...parts: string[]): string { return path.join(paths(dir).data, ...parts); }
function configPath(dir: string): string { return paths(dir).config; }
function contextDir(dir: string): string { return paths(dir).context; }
function rulesPath(dir: string): string { return paths(dir).rules; }
function reference(dir: string, absolute: string): string { return isLocal(dir) ? absolute : path.relative(dir, absolute).split(path.sep).join('/'); }
function resolveReference(dir: string, file: string): string {
  if (path.isAbsolute(file)) return file;
  if (file.startsWith('.radial/')) return dataDir(dir, file.slice(8));
  if (file.startsWith('.context/')) return path.join(contextDir(dir), file.slice(9));
  return path.resolve(dir, file);
}
function status(dir?: string | null): ProjectStorageStatus {
  if (!root) return { defaultLocal: false, preference: 'default', local: false, pending: false };
  const record = dir ? recordFor(dir) : null;
  return {
    defaultLocal: store.defaultLocal,
    preference: record?.preference || 'default',
    local: record ? record.local : store.defaultLocal,
    pending: record ? record.local !== wanted(record) : Object.values(store.projects).some(r => r.local !== wanted(r)),
    folder: record ? (record.local ? localRoot(dir!, record) : key(dir!)) : root,
    contextPath: record ? locations(key(dir!), record, record.local).context : null,
    rulesPath: record ? locations(key(dir!), record, record.local).rules : null,
    existingFiles: dir ? ['.radial', '.radial.json', '.context'].filter(name => fs.existsSync(path.join(dir, name))) : [],
  };
}
function set({ repoDir, preference, defaultLocal }: ProjectStoragePatch = {}): ProjectStorageStatus {
  if (!root) throw new Error('Project storage has not been initialized');
  const previous = JSON.stringify(store);
  if (repoDir) {
    if (!(['default', 'local', 'project'] as readonly (string | undefined)[]).includes(preference)) throw new Error('Invalid project storage preference');
    recordFor(repoDir).preference = preference as StoragePreference;
  } else {
    if (typeof defaultLocal !== 'boolean') throw new Error('Choose a machine default');
    store.defaultLocal = defaultLocal;
  }
  try { persist(); } catch (error) { store = JSON.parse(previous); throw error; }
  return status(repoDir);
}
function activate(dir: string, { defer = false }: { defer?: boolean } = {}): void {
  if (!root) return;
  const k = key(dir), record = recordFor(dir);
  if (!active.has(k) && !defer && record.local !== wanted(record)) {
    const next = wanted(record);
    migrate(k, record, next);
    record.local = next;
    try { persist(); } catch (error) { record.local = !next; throw error; }
  }
  active.add(k);
}
function release(dir: string): void { active.delete(key(dir)); }
function checkMove(oldDir: string, newDir: string): void {
  if (root && key(oldDir) !== key(newDir) && store.projects[key(newDir)]) {
    throw new Error('The destination already has Radial project data');
  }
}
function rekey(oldDir: string, newDir: string): void {
  if (!root) return;
  const oldKey = key(oldDir), newKey = key(newDir);
  if (store.projects[oldKey]) {
    if (store.projects[newKey]) throw new Error('The destination already has Radial project data');
    store.projects[newKey] = store.projects[oldKey];
    delete store.projects[oldKey];
    persist();
  }
  if (active.delete(oldKey)) active.add(newKey);
}
function agentText(dir: string, text: string): string {
  if (!isLocal(dir)) return text;
  return String(text).replace(/\.radial\/[\w./-]+/g, value => dataDir(dir, value.slice(8)))
    .replaceAll('at the project root', 'in Radial’s local data folder')
    .replaceAll('in the project root', 'in Radial’s local data folder');
}

export { init, isLocal, dataDir, configPath, contextDir, rulesPath, reference, resolveReference, status, set, activate, release, checkMove, rekey, agentText };
