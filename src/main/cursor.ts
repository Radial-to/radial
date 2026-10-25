/**
 * Cursor Agent CLI detection/auth. The chat bridge that used to live here was
 * removed 2026-07-27 with the SDK chat surface — Cursor runs as a terminal
 * agent via engine.js/term-daemon (which uses bin() to resolve the CLI, since
 * ~/.local/bin is usually off the app's PATH). The local chat experiment uses
 * the CLI ACP adapter in chat/providers.js; it does not restore the old SDK.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { childEnv, which } from './env';
import type { CliAuth } from '../shared/radialApi';

/** checkAuth()'s answer: ok = signed in, hasCli = the binary is present. radialApi's CliAuth CLI member without `method` (it crosses IPC as agent:checkAuth). */
export type CursorAuth = Omit<Extract<CliAuth, { hasCli: boolean }>, 'method'>;

// Resolve the CLI: PATH first, then the standard install spot (~/.local/bin),
// which the app's PATH usually doesn't include.
function bin(): string | null {
  const onPath = which && which('cursor-agent');
  if (onPath) return onPath;
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'cursor-agent'),
    '/usr/local/bin/cursor-agent',
    '/opt/homebrew/bin/cursor-agent',
  ];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

function isInstalled(): boolean { return !!bin(); }

// { ok, hasCli, hasNode } — ok=authed, hasCli=binary present (drives the auth notice).
function checkAuth(): CursorAuth {
  const b = bin();
  if (!b) return { ok: false, hasCli: false, hasNode: true };
  try {
    const out = execFileSync(b, ['status'], { env: childEnv(), timeout: 8000, encoding: 'utf8' });
    return { ok: /logged in/i.test(out) && !/not logged in/i.test(out), hasCli: true, hasNode: true };
  } catch (e) {
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, hasCli: false, hasNode: true };
    return { ok: false, hasCli: true, hasNode: true }; // installed but not authed (status exits non-zero)
  }
}

export { bin, isInstalled, checkAuth };
