import * as projectData from './projectData';

/**
 * Agent → Radial restart channel. Vite/Astro HMR can wedge: a perfectly healthy
 * listener keeps serving pre-edit CSS until the dev server is restarted. Agents
 * are barred from killing or starting servers themselves (devGuard + the shared
 * preview notes), so give them a sanctioned way to ask: create an empty
 * `.radial/restart-dev-server` in the project root, and Radial performs one
 * clean restart (fresh port, dev.json republished, preview repointed).
 *
 * Detection is a plain interval poll of the request path. fs.watch directory
 * events proved undeliverable on macOS here, and fs.watchFile only reports
 * CHANGES between its samples — a file created before its first sample becomes
 * the baseline and never fires. One stat per second per open project is free,
 * and sub-second latency doesn't matter for a restart.
 */

import fs from 'fs';
import path from 'path';

const REQUEST_BASENAME = 'restart-dev-server';
const POLL_MS = 1000;
/** The request files agents create in .radial/: a dev-server restart, or a launch-check rescan (main.ts). */
export type RequestBasename = typeof REQUEST_BASENAME | 'run-launch-check';
// The same touch-file protocol serves other agent requests too (e.g.
// `run-launch-check`, plans/agent-state-files.md) — callers pass a basename
// to watch a different request file; the default keeps every existing caller.
function requestPath(repoDir: string, basename: RequestBasename = REQUEST_BASENAME): string { return projectData.dataDir(repoDir, basename); }

// Consume a pending request — true (and the file is removed) if one existed.
// Deleting BEFORE acting makes a request fire exactly once even if watchFile
// reports the same appearance twice.
function consume(repoDir: string, basename: RequestBasename = REQUEST_BASENAME): boolean {
  try { fs.unlinkSync(requestPath(repoDir, basename)); return true; } catch { return false; }
}

/**
 * Watch a project for requests; onRequest() fires each time the file
 * appears — including one already present when the watch starts (left while
 * the project was closed). Returns a disposer.
 */
function watch(repoDir: string, onRequest: () => void, pollMs: number = POLL_MS, basename: RequestBasename = REQUEST_BASENAME): () => void {
  const p = requestPath(repoDir, basename);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {} // so a `touch` of the request path always works
  const check = () => { if (consume(repoDir, basename)) onRequest(); };
  const timer = setInterval(check, pollMs);
  if (timer.unref) timer.unref(); // never keep the process alive just for this poll
  check();
  return () => clearInterval(timer);
}

export { watch, consume, requestPath, REQUEST_BASENAME, POLL_MS };
