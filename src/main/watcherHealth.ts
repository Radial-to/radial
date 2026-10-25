/**
 * Is OS file-watching actually delivering events? On macOS, fseventsd can
 * wedge after long uptimes under heavy churn — when it does, EVERY watcher
 * (vite/astro HMR, chokidar, fs.watch on directories) goes silently blind
 * machine-wide while single-file kqueue watches keep working. Dev servers
 * then serve stale output until restarted, look healthy the whole time, and
 * nothing in their logs says why. (Diagnosed live on 2026-07-17: 24-day
 * uptime, fs.watch(dir) and the fsevents native module both dead everywhere,
 * /tmp included; a reboot clears it.)
 *
 * The canary: watch a fresh temp DIRECTORY (the broken primitive — file
 * watches use kqueue and stay alive, so they'd false-negative), write into
 * it, and see whether the event arrives.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const RECHECK_MS = 10 * 60 * 1000;
let lastResult: boolean | null = null; // null = never probed
let lastAt = 0;
let probing: Promise<boolean> | null = null;
let forced: boolean | undefined; // test seam

function probe(timeoutMs = 1500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let dir: string;
    try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radial-canary-')); } catch { return resolve(true); } // can't probe → assume fine
    let watcher: fs.FSWatcher | null = null;
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return; settled = true;
      try { if (watcher) watcher.close(); } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      resolve(ok);
    };
    try { watcher = fs.watch(dir, () => done(true)); } catch { return done(true); } // watch API failing outright is a different problem
    setTimeout(() => { try { fs.writeFileSync(path.join(dir, 'ping'), 'x'); } catch {} }, 150);
    setTimeout(() => done(false), timeoutMs);
  });
}

/** Latest verdict, refreshing in the background when stale. */
function healthy(): boolean {
  if (forced !== undefined) return forced;
  if (lastResult === null || Date.now() - lastAt > RECHECK_MS) check();
  return lastResult === null ? true : lastResult; // optimistic until first probe lands
}

/** Probe now (coalesced); resolves the fresh verdict. */
function check(): Promise<boolean> {
  if (forced !== undefined) return Promise.resolve(forced);
  if (!probing) {
    probing = probe().then((ok) => { lastResult = ok; lastAt = Date.now(); probing = null; return ok; });
  }
  return probing;
}

function _setForTest(v: boolean | undefined): void { forced = v; }

export { healthy, check, probe, _setForTest, RECHECK_MS };
