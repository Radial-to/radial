/**
 * A watch over a whole folder tree that holds on every OS: the moments watcher
 * (moments.ts watchRepo) and the static preview's live reload (devServer.ts).
 *
 * macOS (FSEvents) and Windows watch a tree natively, and keep doing so. On
 * Linux, Node's recursive fs.watch adds an inotify watch for every folder in
 * the tree, node_modules and .git included: tens of thousands for a Next
 * site, which blocks Node while it walks them and can pass the machine's
 * inotify limit. And a folder it can't watch (one it can't read, or one past
 * that limit) makes it throw from inside its own listener: an uncaught
 * exception, which takes a process down unless something catches everything
 * (Node 24). So on Linux each folder is watched on its own, the skipped ones
 * (node_modules, dot folders) never, and a folder that can't be watched only
 * goes unwatched.
 */
import fs from 'fs';
import path from 'path';

/** What the watch reports: the change, and the file's path relative to the root. */
export type TreeChange = (event: fs.WatchEventType, file: string) => void;
export interface TreeWatchOptions {
  /** A folder (or file) name whose changes, and everything under it, don't matter. */
  skip?: (name: string) => boolean;
  /** native: the OS's recursive watch; walk: a watch per folder. By default walk on Linux, native elsewhere (a test can choose). */
  mode?: 'native' | 'walk';
}
export interface TreeWatch { close(): void }

/** Watches root and everything under it; throws only when root itself can't be watched. */
export function watchTree(root: string, onChange: TreeChange, { skip = () => false, mode = process.platform === 'linux' ? 'walk' : 'native' }: TreeWatchOptions = {}): TreeWatch {
  const skipped = (rel: string) => rel.split(/[\\/]/).some((seg) => !!seg && skip(seg));
  if (mode === 'native') {
    const watcher = fs.watch(root, { recursive: true }, (event, file) => {
      const rel = String(file || '');
      if (rel && !skipped(rel)) onChange(event, rel);
    });
    watcher.on('error', () => { try { watcher.close(); } catch {} }); // the OS gave up on it: stop, never throw
    return { close: () => { try { watcher.close(); } catch {} } };
  }

  const watchers = new Map<string, fs.FSWatcher>();
  let closed = false;
  function add(dir: string): void {
    if (closed || watchers.has(dir)) return;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, (event, name) => {
        if (!name) return;
        const abs = path.join(dir, String(name));
        const rel = path.relative(root, abs);
        if (skipped(rel)) return;
        // A new folder (a rename here) joins the watch, with what's already in it.
        if (event === 'rename') { try { if (fs.statSync(abs).isDirectory()) add(abs); } catch {} }
        onChange(event, rel);
      });
    } catch (e) {
      if (dir === root) throw e; // nothing to watch at all
      return; // unreadable, or past the inotify limit: this folder goes unwatched
    }
    watcher.on('error', () => { try { watcher.close(); } catch {} watchers.delete(dir); });
    watchers.set(dir, watcher);
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const entry of entries) if (entry.isDirectory() && !skip(entry.name)) add(path.join(dir, entry.name));
  }
  add(root);
  return {
    close: () => {
      closed = true;
      for (const w of watchers.values()) { try { w.close(); } catch {} }
      watchers.clear();
    },
  };
}
