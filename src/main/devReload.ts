// Development-only source watcher. It deliberately uses Node's built-in
// watcher so `npm start` works without another dev dependency or process.
import fs from 'fs';
import path from 'path';

/** A renderer or preload change reloads the window; a main-process change restarts the app. */
export type DevReloadAction = 'reload' | 'restart';

export interface WatchSourcesOptions {
  rootDir: string;
  onReload: (files: string[]) => void;
  onRestart: (files: string[]) => void;
  rebuild?: (files: string[]) => Promise<void>;
  delay?: number;
  log?: Pick<Console, 'warn'>;
}

function ignored(filePath: string): boolean {
  const name = path.basename(String(filePath || ''));
  return !name || name === '.DS_Store' || name.startsWith('.') ||
    name.endsWith('~') || name.endsWith('.swp') || name.endsWith('.tmp');
}

function actionForPath(rootDir: string, filePath: string): DevReloadAction | null {
  if (ignored(filePath)) return null;
  const relative = path.relative(rootDir, filePath).split(path.sep).join('/');
  if (!relative || relative.startsWith('../')) return null;
  // The core (src/core) runs in the main process too (plans/headless-core.md).
  if (relative === 'package.json' || relative.startsWith('src/main/') || relative.startsWith('src/core/')) return 'restart';
  if (relative.startsWith('src/renderer/') || relative.startsWith('src/preload/') || relative.startsWith('src/overlay/')) return 'reload';
  return null;
}

// Recursive fs.watch is unavailable on some Linux versions. Watching each
// source directory also lets a newly-created child directory join the watch.
function watchTree(root: string, onChange: (filePath: string) => void): () => void {
  const watchers = new Map<string, fs.FSWatcher>();
  let closed = false;

  function addDirectory(dir: string): void {
    if (closed || watchers.has(dir)) return;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, (_event: fs.WatchEventType, filename: string | null) => {
        const changed = filename ? path.join(dir, filename.toString()) : dir;
        // A rename may be a newly-created directory; watch it as well.
        try { if (fs.statSync(changed).isDirectory()) addDirectory(changed); } catch {}
        onChange(changed);
      });
    } catch { return; }
    watchers.set(dir, watcher);
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) addDirectory(path.join(dir, entry.name));
      }
    } catch {}
  }

  addDirectory(root);
  return () => {
    closed = true;
    for (const watcher of watchers.values()) { try { watcher.close(); } catch {} }
    watchers.clear();
  };
}

// `rebuild(files)` compiles the changed src/ files into out/ (the app runs
// from out/) before the window reloads or the app restarts.
function watchSources({ rootDir, onReload, onRestart, rebuild = async () => {}, delay = 120, log = console }: WatchSourcesOptions): () => void {
  let nextAction: DevReloadAction | null = null;
  let timer: NodeJS.Timeout | null = null;
  const changed = new Set<string>();

  function queue(filePath: string): void {
    const action = actionForPath(rootDir, filePath);
    if (!action) return;
    // A main-process change wins over renderer changes in the same save burst.
    nextAction = nextAction === 'restart' || action === 'restart' ? 'restart' : 'reload';
    changed.add(path.relative(rootDir, filePath));
    clearTimeout(timer as NodeJS.Timeout | undefined); // null is a no-op; @types/node leaves it out
    timer = setTimeout(async () => {
      const actionToRun = nextAction;
      const files = [...changed];
      nextAction = null;
      changed.clear();
      try { await rebuild(files); }
      catch (error) { log.warn('[dev-reload] Build failed, not reloading:', (error as Error).message); return; }
      if (actionToRun === 'restart') onRestart(files);
      else if (actionToRun === 'reload') onReload(files);
    }, delay);
  }

  const stopSourceWatch = watchTree(path.join(rootDir, 'src'), queue);
  let packageWatcher: fs.FSWatcher | null = null;
  try { packageWatcher = fs.watch(path.join(rootDir, 'package.json'), () => queue(path.join(rootDir, 'package.json'))); }
  catch (error) { log.warn('[dev-reload] Could not watch package.json:', (error as Error).message); }

  return () => {
    clearTimeout(timer as NodeJS.Timeout | undefined);
    stopSourceWatch();
    try { packageWatcher && packageWatcher.close(); } catch {}
  };
}

function enabled(app: { isPackaged: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  return !app.isPackaged && !env.RADIAL_SMOKE && env.RADIAL_AUTO_RELOAD !== '0';
}

export { actionForPath, enabled, watchSources };
