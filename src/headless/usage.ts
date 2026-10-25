/**
 * Anonymous usage events for radial serve, the same contract as the Mac
 * app's (src/main/telemetry.ts): event names from one allowlist, never
 * content, a random install ID in the data dir, every event sent also
 * written to the data dir's telemetry-log.jsonl, and an off switch.
 * - Only the official radial-cli package sends: scripts/pack-cli.mts
 *   --official puts the key in it. A copy built from source has none and
 *   sends nothing.
 * - Off whenever CI or DO_NOT_TRACK is set, and in a throwaway data dir.
 * - `radial telemetry off | on | status`, kept in the data dir, so it's per
 *   data dir (a container's volume keeps it); a running serve picks a change
 *   up at its next event.
 * - The first time radial serve starts where it would send, it prints a
 *   one-time note: what's sent, how to turn it off, where the list is.
 */
import path from 'path';
import * as telemetry from '../main/telemetry';
import * as dataDirs from '../main/dataDirs';
import type { CliIo, Flags } from '../main/cli';

/** Where the events are listed, in plain words. */
export const DOCS_URL = 'https://radial.to/docs/usage-data';

/** Whether this data dir's radial serve sends usage events now, and why not when it doesn't. */
export type UsageState =
  | { on: true }
  | { on: false; why: 'source' | 'off' | 'CI' | 'DO_NOT_TRACK' | 'throwaway' };

/** The state for a data dir in an environment: no key (built from source), CI or DO_NOT_TRACK, a throwaway data dir, or switched off. */
export function state(dataDir: string, env: NodeJS.ProcessEnv = process.env): UsageState {
  if (!telemetry.keyFor(env)) return { on: false, why: 'source' };
  const opt = telemetry.envOptOut(env);
  if (opt) return { on: false, why: opt };
  if (!telemetry.sendAllowedFor('headless', env)) return { on: false, why: 'throwaway' };
  if (!telemetry.readSettings(dataDir).enabled) return { on: false, why: 'off' };
  return { on: true };
}

/** What the note and status say is sent, in one place. */
const WHAT = 'anonymous usage events: which commands and features ran, and errors in Radial\'s own code (what kind, and where in its code), with the app version and OS, under a random ID for this data dir. Never content: no files, page text, prompts, paths, project names, addresses or tokens.';

/**
 * The one-time note, the first time radial serve starts (or is started) on a
 * data dir where it sends; null once it was shown, or when nothing is sent.
 * Showing it marks it shown.
 */
export function notice(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!state(dataDir, env).on || telemetry.readSettings(dataDir).noticeShown) return null;
  try { telemetry.writeSettings(dataDir, { noticeShown: true }); } catch { return null; } // a note that can't be remembered would show every time
  return [
    `Radial sends ${WHAT}`,
    `The list of events: ${DOCS_URL}. Each one sent is also written to ${path.join(dataDir, telemetry.LOG_NAME)}.`,
    'To turn it off: radial telemetry off, or set DO_NOT_TRACK=1.',
  ].join('\n');
}

/** `radial telemetry [status | on | off] [--json]` as the CLI runs it: 0, or 2 for an unknown action. */
export async function command(positional: string[], flags: Flags, io: Pick<CliIo, 'stdout' | 'stderr' | 'env'>): Promise<number> {
  const dataDir = dataDirs.headlessDataDir(io.env);
  const action = positional[0] || 'status';
  const json = !!flags.json;
  if (!['status', 'on', 'off'].includes(action)) {
    const error = `Unknown telemetry command: ${action}. Use radial telemetry status, on or off.`;
    if (json) io.stdout.write(JSON.stringify({ ok: false, code: 'bad-request', error }) + '\n'); else io.stderr.write(`radial: ${error}\n`);
    return 2;
  }
  if (action !== 'status') telemetry.writeSettings(dataDir, { enabled: action === 'on', ...(action === 'off' ? { noticeShown: true } : {}) });
  const s = state(dataDir, io.env);
  const enabled = telemetry.readSettings(dataDir).enabled;
  const log = path.join(dataDir, telemetry.LOG_NAME);
  if (json) { io.stdout.write(JSON.stringify({ ok: true, on: s.on, ...(s.on ? {} : { why: s.why }), enabled, dataDir, log, docs: DOCS_URL }) + '\n'); return 0; }
  const why: Record<Exclude<UsageState, { on: true }>['why'], string> = {
    source: 'This copy of Radial was built from source, so it has no key and sends nothing.',
    off: 'Switched off for this data dir. radial telemetry on turns it back on.',
    CI: 'Off while CI is set in the environment.',
    DO_NOT_TRACK: 'Off while DO_NOT_TRACK is set in the environment.',
    throwaway: 'Off in a throwaway data dir (RADIAL_USERDATA).',
  };
  const lines = [
    action === 'off' ? 'Usage events are off for this data dir. Nothing is sent, not even that you turned them off.'
      : action === 'on' ? (s.on ? 'Usage events are on for this data dir.' : `Usage events are switched on for this data dir, but nothing is sent here. ${why[s.why]}`)
      : s.on ? 'Usage events are on.' : `Usage events are off. ${why[s.why]}`,
    `What's sent: ${WHAT}`,
    `The list: ${DOCS_URL}`,
    `Every event sent is written to ${log}`,
    enabled ? 'To turn it off: radial telemetry off, or set DO_NOT_TRACK=1.' : 'To turn it on: radial telemetry on.',
  ];
  io.stdout.write(lines.join('\n') + '\n');
  return 0;
}
