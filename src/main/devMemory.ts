// What to do about a dev server Radial runs once it is over its memory limit.
//
// A restart frees the memory in seconds, so that's the answer, at most once per
// quiet window. A server that doubles past the limit is restarted sooner. It is
// stopped only when it doubles past again after two recent restarts: restarting
// isn't helping, so it would just churn. (0.38.0 stopped a server at its second
// 3 GB breach in 2 hours, which killed busy-but-healthy Next dev servers mid-work.)

const QUIET_MS = 15 * 60 * 1000;   // a normal breach restarts at most this often
const RUNAWAY_MS = 10 * 60 * 1000; // two restarts this close, then doubled again: stop

/** What to do about the server: leave it, wait out the quiet window, restart it or stop it. */
export type DevMemoryAction = 'ok' | 'wait' | 'restart' | 'stop';

export interface DevMemoryCheck {
  mb: number;
  limit: number;
  restarts?: readonly number[];
  now?: number;
}

// A quarter of the Mac's memory, never under 4 GB.
function limitMb(totalBytes: number): number {
  return Math.max(4096, Math.round(totalBytes / 1048576 / 4));
}

// The headless core's limit (radial serve): half the machine's memory. A VM or
// a container mostly runs the site, and the Mac's 4 GB floor would be all of a
// small one's memory, so there is no floor.
function headlessLimitMb(totalBytes: number): number {
  return Math.round(totalBytes / 1048576 / 2);
}

// mb: the server's memory now; restarts: times of its recent memory restarts.
// Returns 'ok' | 'wait' | 'restart' | 'stop'.
function decide({ mb, limit, restarts = [], now = Date.now() }: DevMemoryCheck): DevMemoryAction {
  if (mb <= limit) return 'ok';
  const doubled = mb >= 2 * limit;
  if (doubled && restarts.filter((t) => now - t < RUNAWAY_MS).length >= 2) return 'stop';
  if (!doubled && restarts.some((t) => now - t < QUIET_MS)) return 'wait';
  return 'restart';
}

export { limitMb, headlessLimitMb, decide, QUIET_MS, RUNAWAY_MS };
