/**
 * What the core does itself when its host has no window or no browser
 * (`radial serve`, plans/headless-core.md phase 2a). With a window, these are
 * the viewer's and the page's; without one:
 * - open: openRepo, with startRepo's open-time preparation (which keeps
 *   .radial/ out of the repo's commits), and the waiting CLI hears how it went;
 * - close: the project's terminals end and its slept agents' records go, as
 *   the window's closeTab does, then the session stops;
 * - focus has nothing to show, and reload with no browser nothing to reload:
 *   they answer headless: true;
 * - agent start, send and Home: the core's own sessions (agentLane.ts), which
 *   a migration's agent starts in too (flows.ts migrateLaunch);
 * - with no browser (radial serve before `radial browser install`; its page
 *   is src/headless/page.ts), screenshots, fields and a migration compare
 *   refuse with that command and one that does the job meanwhile
 *   (cliServer's noBrowser), and a migration capture takes no reference
 *   screenshots.
 */
import * as terminal from '../main/terminal';
import * as projectState from '../main/projectState';
import type { PtyInfo } from '../main/terminal';
import { openProject, settleOpen } from './control';
import { stopSession } from './sessions';

/** Opens a project with no window to do it, and settles the CLI's open with the outcome. */
export function openWithoutWindow(repoDir: string): void {
  openProject(repoDir).catch((e: Error) => settleOpen(repoDir, { ok: false, error: e.message })); // openRepo answers its own failures; an unexpected one must not leave the CLI waiting
}

/** Closes a project with no window: its terminals end, then its session stops. */
export async function closeWithoutWindow(repoDir: string): Promise<void> {
  let ptys: PtyInfo[] = [];
  try { ptys = await terminal.list(repoDir); } catch {}
  for (const t of ptys) terminal.kill(t.id);
  // A slept agent has no terminal to end; dropping its record keeps a later open from bringing it back (the window's closeTab).
  try { if ((projectState.get(repoDir).sleptAgents || []).length) projectState.set(repoDir, { sleptAgents: [] }); } catch {}
  await stopSession(repoDir);
}
