/**
 * Codex CLI detection/auth. The App Server chat bridge that used to live here
 * (Codex threads translated into chat events) was removed 2026-07-27 with the
 * SDK chat surface — Codex now runs as a first-class TERMINAL agent via
 * engine.js/term-daemon. See git history for the old bridge.
 */

import { execFileSync } from 'child_process';
import { childEnv, which } from './env';
import type { CliAuth } from '../shared/radialApi';

/** checkAuth()'s answer: ok = signed in (method says how), hasCli = the binary is present. The CLI member of radialApi's CliAuth (it crosses IPC as agent:checkAuth and SetupCheck.codex). */
export type CodexAuth = Extract<CliAuth, { hasCli: boolean }>;

function checkAuth(): CodexAuth {
  const bin = which('codex');
  if (!bin) return { ok: false, hasCli: false, hasNode: !!which('node') };
  try {
    const output = execFileSync(bin, ['login', 'status'], {
      encoding: 'utf8', timeout: 6000, env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'],
    });
    const method = /chatgpt/i.test(output) ? 'chatgpt' : (/api key/i.test(output) ? 'api_key' : 'codex');
    return { ok: /logged in/i.test(output), method, hasCli: true, hasNode: !!which('node') };
  } catch {
    return { ok: false, hasCli: true, hasNode: !!which('node') };
  }
}

export { checkAuth };
