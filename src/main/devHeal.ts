/**
 * Crash-healing policy for project dev servers. A server can die after it was
 * ready (OOM, a framework crash, something killed the process) — without
 * healing, the session keeps the dead handle and the preview silently shows
 * the last render, so edits "don't show up" until the project is reopened.
 *
 * This module is the pure decision; main.js watches each server's child
 * process and acts on the verdict. Restarts are capped inside a rolling
 * window so a server that crashes on boot (e.g. a broken config an agent just
 * wrote) can't restart-loop forever.
 */

const WINDOW_MS = 2 * 60 * 1000;
const MAX_RESTARTS = 3;

export type HealAction = 'ignore' | 'restart' | 'give-up';

/**
 * A dev-server handle: the slice of devServer.start's result the healer reads,
 * until devServer.ts owns the type (workspaceActivity's ActivityServerHandle
 * extends it). Compared by identity; stop() sets `stopped`.
 */
export interface DevServerHandle {
  url: string;
  stopped?: boolean;
}

/**
 * The parts of a project session the healer reads. main.ts's session record
 * must satisfy both this and workspaceActivity's ActivitySession.
 */
export interface HealSession {
  handle?: DevServerHandle | null;
  suspended?: boolean;
  heals?: number[];
}

export interface HealInput {
  session: HealSession | undefined;
  deadHandle: DevServerHandle;
  now: number;
}

export interface HealVerdict {
  action: HealAction;
  heals: number[];
}

/**
 * What to do about a dev-server child that exited.
 * `session` is the live session record (or undefined if the project closed),
 * `deadHandle` the handle whose child died, `now` the current timestamp.
 * Returns { action: 'ignore' | 'restart' | 'give-up', heals } where `heals`
 * is the updated list of recent restart timestamps to store back on the session.
 */
function decide({ session, deadHandle, now }: HealInput): HealVerdict {
  const prior = (session && session.heals) || [];
  // Project closed, server already replaced, or session deliberately
  // suspended — this exit is expected (or moot). Same for an explicit stop().
  if (!session || session.handle !== deadHandle || session.suspended) return { action: 'ignore', heals: prior };
  if (deadHandle && deadHandle.stopped) return { action: 'ignore', heals: prior };
  const heals = prior.filter((t) => now - t < WINDOW_MS);
  heals.push(now);
  return { action: heals.length > MAX_RESTARTS ? 'give-up' : 'restart', heals };
}

export { decide, WINDOW_MS, MAX_RESTARTS };
