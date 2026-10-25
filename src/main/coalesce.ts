/**
 * In-flight call coalescing, keyed by an arbitrary key.
 *
 * The first call for a key runs `fn()` and remembers its promise; any concurrent
 * call for the SAME key awaits that same promise instead of running `fn()` again.
 * Once the promise settles (resolve OR reject) the key is freed, so a later call
 * runs fresh.
 *
 * Radial uses this to guarantee one dev server per project. Opening or resuming a
 * project awaits `devServer.start`, which can run for a minute (install + boot)
 * before the session and pid are recorded. A second open in that window — a
 * double-click, session-restore racing a manual open, an IPC retry, a second
 * window — would clear the "already open" guard (not yet set) and spawn ANOTHER
 * dev server. The extra ones overwrite the sessions/devPids record and leak as
 * untracked, CPU-pinned orphans. Coalescing collapses them onto one start.
 */
export function makeCoalescer<K, V>() {
  const inflight = new Map<K, Promise<V>>();

  function run(key: K, fn: () => V | PromiseLike<V>): Promise<V> {
    const existing = inflight.get(key);
    if (existing) return existing;
    let p: Promise<V>;
    try { p = Promise.resolve(fn()); }
    catch (e) { p = Promise.reject(e); }
    inflight.set(key, p);
    // Free the key once settled. Passing a handler for BOTH outcomes means this
    // cleanup chain never becomes an unhandled rejection; the original `p` still
    // carries any rejection to real callers. Guard against deleting a newer entry.
    const free = () => { if (inflight.get(key) === p) inflight.delete(key); };
    p.then(free, free);
    return p;
  }
  run.has = (key: K) => inflight.has(key);
  run.size = () => inflight.size;
  return run;
}
