/**
 * Agent sleep policy — which idle agent terminals may be shut down when their
 * project sleeps (or the app quits), and how a slept Claude session is found
 * again for `claude --resume`. Kept free of main.js imports so the policy is
 * unit-testable.
 *
 * Only Claude agents are ever reaped: Claude is the one CLI we can bring back
 * losslessly (`--session-id` at spawn → `--resume` on wake, conversation intact
 * from its own ~/.claude session store). Codex/Cursor have no equivalent we
 * control, and a plain shell may be running anything — those all stay alive in
 * the daemon exactly as before.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * The fields of terminal.ts's PtyMeta that the sleep policy and Home's activity
 * snapshot (workspaceActivity) read. Replace with
 * Pick<PtyMeta, 'engine' | 'sessionId' | 'keepAwake' | 'home' | 'label'> once
 * terminal.ts is typed (ts/w1-misc).
 */
export interface AgentPtyMeta {
  /** terminal.ts's PtyEngine (engine.ts ENGINES); null for a plain shell. */
  engine?: 'claude' | 'codex' | 'cursor' | null;
  /** The Claude session id passed at spawn; absent on pre-feature spawns. */
  sessionId?: string | null;
  keepAwake?: boolean;
  /** The Home workspace's own terminal. */
  home?: boolean;
  /** The session's name in the rail. */
  label?: string | null;
}

/**
 * The fields of terminal.ts's PtyInfo (one entry of the daemon's list) that the
 * sleep policy reads. Becomes a Pick of PtyInfo, through
 * `import type { PtyInfo, PtyMeta } from './terminal'`, once terminal.ts is typed.
 */
export interface AgentPty {
  alive?: boolean;
  /** Shown in a running app's window. */
  attached?: boolean;
  /** Last output; an old daemon doesn't report it. */
  lastDataAt?: number;
  meta?: AgentPtyMeta;
}

// How long a pty must be output-silent to count as idle. A working Claude keeps
// painting (spinner + elapsed-time ticks), and typing echoes — so silence this
// long means it's parked at the prompt (or at worst a stale permission ask,
// which --resume survives minus the pending approval).
const AGENT_IDLE_MS = Number(process.env.RADIAL_AGENT_IDLE_MS) > 0 ? Number(process.env.RADIAL_AGENT_IDLE_MS) : 90_000; // env: e2e seam only

// Kept awake (meta.keepAwake — the rail's "Keep awake", `radial agent keep`):
// a session the person wants reachable for as long as it lives, typically one
// they drive from their phone through Claude Code's remote control, which dies
// with the process. Exempt from EVERY parking path — project sleep, quit, and
// the ceiling below — and the daemon keeps the Mac from idle-sleeping while one
// is alive. The flag rides on the pty's meta in the daemon, so it survives a
// Radial restart together with the session it protects.
function isKeptAwake(p: AgentPty | null | undefined): boolean { return !!(p && p.meta && p.meta.keepAwake); }

function pickReapable<P extends AgentPty>(ptys: readonly P[] | null | undefined, now = Date.now(), idleMs = AGENT_IDLE_MS): P[] {
  return (ptys || []).filter((p) => p
    && p.alive !== false
    && p.meta && p.meta.engine === 'claude' // only claude resumes losslessly
    && p.meta.sessionId                     // pre-feature spawns can't --resume — leave them running
    && !isKeptAwake(p)                      // kept awake on purpose — never parked
    && typeof p.lastDataAt === 'number'     // old daemon reports no activity → unknown → keep
    && now - p.lastDataAt >= idleMs);
}

// Hard ceiling for parked agents, enforced by the daemon itself (and the app as
// a belt-and-braces sweep): ANY engine agent silent this long is finished or
// stalled and is just holding RSS — the founder-machine incident was ~20 such
// sessions, 12h-2.7 days old, maxing out swap. Applies regardless of sessionId
// (legacy spawns too) and engine (codex/cursor can't resume; after 2 idle hours
// that trade is right). Plain shells are exempt: they're cheap and may host
// silent-but-alive work like an editor. Attached ptys (visible in a running
// app) are exempt — closing those is the user's call, and claude ones already
// get the gentler sleep-reap.
const AGENT_IDLE_CEILING_MS = 2 * 60 * 60 * 1000;

// While the app runs, sessions it has open are parked after this long with no
// output or input (unless on screen or kept awake). Before this, attached
// sessions were never parked, so an app left running for days kept every
// finished conversation's CLI alive (docs/memory-leak-report-2026-10-11.md).
const AGENT_PARK_MS = Number(process.env.RADIAL_AGENT_PARK_MS) > 0 ? Number(process.env.RADIAL_AGENT_PARK_MS) : AGENT_IDLE_CEILING_MS; // env: e2e seam only
function pickExpired<P extends AgentPty>(ptys: readonly P[] | null | undefined, now = Date.now()): P[] {
  return (ptys || []).filter((p) => p
    && p.alive !== false
    && !p.attached
    && !isKeptAwake(p)                     // kept awake on purpose — the ceiling doesn't apply
    && p.meta && p.meta.engine             // engine agents only; shells are exempt
    && typeof p.lastDataAt === 'number'
    && now - p.lastDataAt >= AGENT_IDLE_CEILING_MS);
}

// The Claude CLI's own session store: <config>/projects/<munged cwd>/<id>.jsonl
// (path munged to dashes), its config folder being CLAUDE_CONFIG_DIR when set,
// else ~/.claude, as the chats read transcripts (chat/interactive.ts). The CLI
// munges its PHYSICAL cwd — a PTY spawned at a symlinked path (e.g. /tmp →
// /private/tmp) chdirs to the resolved one — so resolve before munging or the
// lookup misses. If the file is missing/empty the session never got a first
// message — resume would error, so the caller spawns fresh instead. A test
// passes `home` to read that home's ~/.claude instead.
function claudeProjectDir(repoDir: string, home?: string): string {
  let real = String(repoDir);
  try { real = fs.realpathSync(real); } catch {}
  const config = home != null ? path.join(home, '.claude') : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(config, 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'));
}
function sessionFileExists(repoDir: string, sessionId: string, home?: string): boolean {
  try { return fs.statSync(path.join(claudeProjectDir(repoDir, home), sessionId + '.jsonl')).size > 0; } catch { return false; }
}

export { AGENT_IDLE_MS, AGENT_IDLE_CEILING_MS, AGENT_PARK_MS, isKeptAwake, pickReapable, pickExpired, claudeProjectDir, sessionFileExists };
