/**
 * The control socket (plans/radial-agent-native.md): one API behind the `radial`
 * CLI, `radial mcp` and the Home agent. cliServer.ts serves api.ts's cliApi on
 * the data dir's cli.sock (or in its short socket folder, dataDirs.ts). An open
 * it asks for comes back through openProject(): the window's project:open when
 * a window opened the project, or the core's own open when there is no window
 * (fallbacks.ts).
 */
import * as cliServer from '../main/cliServer';
import * as dataDirs from '../main/dataDirs';
import { err } from '../main/cliProto';
import type { CliApi, ControlServer, DispatchVia, OpRequest, SocketClaim } from '../main/cliServer';
import type { Reply } from '../main/cliProto';
import type { AnswerTo, ArgTo } from './types';
import { platform } from './host';
import { openRepo } from './sessions';

let cliCtl: ControlServer | null = null;

/** Starts serving the API on the data dir's control socket. */
export function startControlServer(api: CliApi): void {
  try { cliCtl = cliServer.start({ socketPath: dataDirs.cliSocket(platform().dataDir), api, log: (m) => console.log(m) }); }
  catch (e) { console.error('[cli] control socket failed:', (e as Error).message); }
}

/**
 * Settles once the control server listens, or knows it won't: another Radial
 * already answers on its socket (in-use), or it couldn't listen there.
 */
export function controlReady(): Promise<SocketClaim> {
  return cliCtl ? cliCtl.ready : Promise.resolve({ ok: false, code: 'error', error: 'The control socket did not start.' });
}

// project:open: the window opens a project (a click, or the CLI's open it
// passed on), or the core does with no window, and a CLI waiting on that
// folder hears how it went.
export async function openProject(repoDir: ArgTo<'openProject', 0>, opts?: ArgTo<'openProject', 1>): Promise<AnswerTo<'openProject'>> { const res = await openRepo(repoDir, opts || {}); settleOpen(repoDir, res); return res; }

/** Tells a CLI waiting on a folder's open how it went. */
export function settleOpen(repoDir: string, res: AnswerTo<'openProject'>): void { if (cliCtl) cliCtl.settleOpen(repoDir, res); }

/** Closes the control socket (at quit). */
export function stopControlServer(): void { if (cliCtl) { cliCtl.stop(); cliCtl = null; } }

/** Runs one request as the control socket would, for radial serve's HTTP listener (its /rpc and /mcp). */
export function dispatch(msg: OpRequest, via?: DispatchVia): Promise<Reply> {
  return cliCtl ? cliCtl.dispatch(msg, via) : Promise.resolve(err('unreachable', 'Radial is stopping.'));
}
