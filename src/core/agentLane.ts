/**
 * The core's own agent sessions, for a host with no window (radial serve,
 * plans/headless-core.md phase 2b): `radial agent start`, `agent send` and
 * `radial home`. With a window these are the viewer's, and the window's start
 * reuses a project's untouched session or first chat. Without one the core runs
 * the base case on the paste primitives it shares with the window
 * (shared/agentPaste.ts), reading the PTY daemon's scrollback rendered by
 * ttyText where the window reads its xterm:
 * - start: a submitted task rides as the CLI's first argument
 *   (engine.spawnSpec), so nothing races its first paint; a staged one is
 *   pasted once the boot paint settles. A CLI that first asks a question of its
 *   own (signing in, trusting the folder) gets nothing typed, and the reply says
 *   the task is waiting;
 * - send: pasted and checked as the window does, but never into a question (a
 *   follow-up typed into a permission prompt would answer it); a Claude session
 *   that was put to sleep (by `radial sleep`, or the daemon's two-hour ceiling)
 *   comes back with --resume and gets the text;
 * - home: a session in the Home folder with Home's brief (engine.homeContext).
 * Nothing here types into a CLI's own question: `radial agent answer` does,
 * when asked with a yes (questions.ts, in both hosts).
 * Sessions run whatever the person signed their CLI into, as ordinary
 * interactive terminals, and Radial never runs a CLI in its print mode. Radial
 * doesn't sign a CLI in itself: it types what its caller gives it (an answer's
 * text can be an API key) and keeps no copy.
 */
import * as terminal from '../main/terminal';
import * as engine from '../main/engine';
import * as ttyText from '../main/ttyText';
import * as projectState from '../main/projectState';
import * as agentPaste from '../shared/agentPaste';
import { asksAfterTyping, asksOwnQuestion } from '../shared/cliQuestion';
import type { AgentTerm, TermActivity } from '../shared/agentPaste';
import type { ChatEngine } from '../shared/chatPermissions';
import type { CliFailure, CliRequests, CliResult } from '../shared/radialApi';
import type { PtyInfo, PtyTail } from '../main/terminal';
import type { StoredSleptAgent } from './agents';
import { DAEMON_OUTDATED, homeCwd, mergeDaemonReaps, startTerminal } from './agents';
import { sessions, wake } from './sessions';
// The window's task labels (a UMD module it shares), so a session started here is named the same way.
const taskTitle = require('../renderer/taskTitle.js') as typeof import('../renderer/taskTitle.js');

/** The size of a terminal nobody shows: what `radial agent output` renders it at. */
const COLS = 120, ROWS = 40;

/**
 * A session as the core reads and types into it: the daemon's view of its
 * pty. Rendering its scrollback isn't free, so a screen read once the CLI has
 * gone quiet is kept until it prints again: a CLI that sits on a question for
 * half an hour is rendered once, not four times a second.
 */
function daemonTerm(id: string, agent: boolean): AgentTerm {
  const tail = async (bytes: number): Promise<PtyTail | null> => { try { const t = await terminal.tail(id, bytes); return t.ok ? t : null; } catch { return null; } };
  let kept: { lastDataAt: number; view: ttyText.ScreenView } | null = null;
  const view = async (): Promise<ttyText.ScreenView> => {
    const now = await tail(1);
    if (!now) return { screen: '', above: [], recent: '' };
    if (kept && kept.lastDataAt === now.lastDataAt) return kept.view;
    const t = await tail(200000);
    if (!t) return { screen: '', above: [], recent: '' };
    const v = await ttyText.screen(t.data, { cols: t.cols, rows: t.rows });
    // Only a quiet screen is kept: output in the same millisecond as the read would otherwise go unseen.
    kept = Date.now() - t.lastDataAt >= 100 ? { lastDataAt: t.lastDataAt, view: v } : null;
    return v;
  };
  return {
    agent,
    async activity(): Promise<TermActivity> {
      const t = await tail(1);
      return t ? { ready: t.data.length > 0, lastDataAt: t.lastDataAt, spawnedAt: t.startedAt || null, exited: !t.alive } : { ready: false, lastDataAt: 0, spawnedAt: null, exited: true };
    },
    recentText: async () => (await view()).recent,
    asking: async (typed) => agent && (typed ? asksAfterTyping((await view()).screen, typed) : asksOwnQuestion((await view()).screen)),
    paste: (text) => terminal.write(id, engine.pasteSequence(text)),
    enter: () => terminal.write(id, '\r'),
    // As main's engine:paste does for the window: the Enter a beat after the paste, or the TUI submits an empty line.
    pasteAndEnter: (text) => { terminal.write(id, engine.pasteSequence(text)); setTimeout(() => terminal.write(id, '\r'), 90); },
    gone: async () => { const t = await tail(1); return !t || !t.alive; },
  };
}

/**
 * A terminal service too old to show a session's screen: the core couldn't see
 * a paste land, and would paste it again and again.
 */
function outdated(): CliFailure { return { ok: false, code: 'error', error: DAEMON_OUTDATED.error }; }

/** The engine a session runs: the one asked for, else the first installed of Claude Code, Codex and Cursor. */
function pickEngine(wanted: ChatEngine | null, avail: Record<ChatEngine, boolean>): ChatEngine | null {
  return wanted || (avail.claude ? 'claude' : avail.codex ? 'codex' : avail.cursor ? 'cursor' : null);
}

/**
 * A session the core just started, once its CLI has painted itself: a task it
 * was given as its first prompt runs once any question of the CLI's own is
 * answered (waiting); one to stage is typed into its input, now or then.
 */
async function handOver(id: string, task: string, submit: boolean): Promise<{ landed: boolean; waiting: boolean }> {
  const term = daemonTerm(id, true);
  await agentPaste.whenReady(term);
  if (submit) return { landed: true, waiting: await term.asking() };
  return agentPaste.typeTask(term, task, false);
}

/** `radial agent start` with no window: a new session in the project's folder, the task submitted or staged. */
export async function startAgent({ repoDir, task, submit, engine: wanted, label }: CliRequests['agent']): Promise<CliResult<'agent'>> {
  if (!terminal.tailSupported()) return outdated();
  const s = sessions.get(repoDir);
  if (!s) return { ok: false, code: 'not-open', error: `${repoDir} is not open.` };
  if (s.suspended) { // the agent works on a running site, as the window's start wakes it
    await wake(repoDir);
    if (sessions.get(repoDir)?.suspended !== false) return { ok: false, code: 'no-dev-server', error: 'The project is asleep and could not be woken.' };
  }
  const avail = engine.available();
  const eng = pickEngine(wanted, avail);
  if (!eng || !avail[eng]) return { ok: false, code: 'no-engine', error: eng ? `${eng} is not installed on this machine.` : 'No agent CLI (Claude Code, Codex or Cursor) is installed on this machine.' };
  const name = taskTitle.summarize(label || taskTitle.summarize(task)) || engine.ENGINES[eng].label;
  let id: string | undefined;
  try { ({ id } = await startTerminal({ repoDir, cols: COLS, rows: ROWS, engine: eng, label: name, initialText: submit ? task : undefined, home: false })); }
  catch (e) { return { ok: false, code: 'error', error: `Could not start the session: ${(e as Error).message}` }; }
  if (!id) return { ok: false, code: 'error', error: 'Could not start the session.' };
  const { landed, waiting } = await handOver(id, task, submit);
  let startedAt = Date.now(); try { const t = await terminal.tail(id, 1); if (t.ok) startedAt = t.startedAt; } catch {}
  return { ok: true, id, label: name, engine: eng, submitted: submit, landed, reused: false, startedAt, ...(waiting ? { waiting } : {}) };
}

/** A Claude session put to sleep, found by the id its terminal had: where it slept, and its record. */
function sleptSession(id: string): { repoDir: string; rec: StoredSleptAgent } | null {
  mergeDaemonReaps(); // the daemon's ceiling may have parked it since the core's last sweep
  for (const [repoDir, state] of projectState.entries()) {
    const rec = (state.sleptAgents || []).find((r) => r.id === id);
    if (rec) return { repoDir, rec };
  }
  return null;
}

/**
 * Parked sessions a send woke, by the id they slept under, to the id they run
 * under now (a promise while the wake starts). A send to the old id goes to the
 * woken session: one that comes while the first is still waking it doesn't
 * resume the conversation a second time, and one that comes later finds it.
 */
const woken = new Map<string, Promise<string | undefined>>();
const WOKEN_KEPT = 200;

/** Text typed into a running session, as a send to a live one does (on Enter when submit). */
async function typeInto(id: string, text: string, submit: boolean, agent: boolean): Promise<{ landed: boolean; waiting: boolean }> {
  const term = daemonTerm(id, agent);
  await agentPaste.whenReady(term);
  return agentPaste.typeTask(term, text, submit);
}

/** `radial agent send` with no window: the text into a running session, or into a parked Claude session it wakes first. */
export async function sendToAgent({ id, text, submit }: CliRequests['agentSend']): Promise<CliResult<'agentSend'>> {
  if (!terminal.tailSupported()) return outdated();
  let live: PtyInfo | undefined;
  try { live = (await terminal.list(null)).find((t) => t.id === id && t.alive !== false); } catch {}
  if (live) {
    const { landed, waiting } = await typeInto(id, text, submit, !!(live.meta && live.meta.engine));
    return { ok: true, id, submitted: submit, landed, sentAt: Date.now(), ...(waiting ? { waiting } : {}) };
  }
  // Nothing below awaits until a wake is in `woken`: of two sends that find the session parked, only the first wakes it.
  const wokenAs = woken.get(id);
  if (wokenAs) {
    const now = await wokenAs.catch(() => undefined);
    if (!now) return { ok: false, code: 'error', error: `Could not wake session ${id}.` };
    const res = await sendToAgent({ id: now, text, submit }); // running: typed after the first send's text, its first prompt; parked again: woken again
    return res.ok && !res.resumedFrom ? { ...res, resumedFrom: id } : res;
  }
  const slept = sleptSession(id);
  if (!slept) return { ok: false, code: 'not-found', error: `No session ${id}. \`radial agent list\` shows the live ones.` };
  // Back with its conversation (claude --resume), the text its next prompt when it's to run.
  const { repoDir, rec } = slept;
  const wakeUp = startTerminal({ repoDir, cols: COLS, rows: ROWS, engine: rec.engine || 'claude', label: rec.label, restoreOf: rec.id, initialText: submit ? text : undefined, home: repoDir === homeCwd() }).then((r) => r.id);
  woken.set(id, wakeUp);
  if (woken.size > WOKEN_KEPT) woken.delete(woken.keys().next().value!);
  let woke: string | undefined;
  try { woke = await wakeUp; }
  catch (e) { woken.delete(id); return { ok: false, code: 'error', error: `Could not wake session ${id}: ${(e as Error).message}` }; }
  if (!woke) { woken.delete(id); return { ok: false, code: 'error', error: `Could not wake session ${id}.` }; }
  const { landed, waiting } = await handOver(woke, text, submit);
  return { ok: true, id: woke, submitted: submit, landed, sentAt: Date.now(), resumedFrom: id, ...(waiting ? { waiting } : {}) };
}

/** `radial home` with no window: the Home session if one runs, else a new one in the Home folder. */
export async function startHome({ engine: wanted }: CliRequests['home']): Promise<CliResult<'home'>> {
  const cwd = homeCwd();
  let running: PtyInfo | undefined;
  try { running = (await terminal.list(cwd)).find((t) => t.alive !== false && t.meta && t.meta.home); } catch {}
  if (running) return { ok: true, id: running.id, engine: running.meta.engine || 'shell', started: false };
  const avail = engine.available();
  const eng: ChatEngine | null = wanted === 'shell' ? null : wanted || (avail.claude ? 'claude' : avail.codex ? 'codex' : null);
  if (eng && !avail[eng]) return { ok: false, code: 'no-engine', error: `${eng} is not installed on this machine.` };
  try {
    const { id } = await startTerminal({ repoDir: cwd, cols: COLS, rows: ROWS, engine: eng || undefined, label: eng ? engine.ENGINES[eng].label : 'Shell', home: true });
    if (!id) return { ok: false, code: 'error', error: 'Could not start the Home agent.' };
    return { ok: true, id, engine: eng || 'shell', started: true };
  } catch (e) { return { ok: false, code: 'error', error: `Could not start the Home agent: ${(e as Error).message}` }; }
}
