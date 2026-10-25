/**
 * Agent terminals: the agent lane the CLI and MCP read (output, wait, list,
 * kill, keep awake), the Home terminal's folder, putting idle agents to sleep
 * (with records that relaunch them with --resume) and keeping kept-awake ones
 * awake, starting a terminal, and the PTY daemon with the shims on its agents'
 * PATH. Moved from main.ts (plans/headless-core.md, phase 1); the window hears
 * about it through agents:slept, agents:keepAwake and the term: events.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import * as terminal from '../main/terminal';
import * as projectState from '../main/projectState';
import * as agentSleep from '../main/agentSleep';
import * as engine from '../main/engine';
import * as telemetry from '../main/telemetry';
import * as recents from '../main/recents';
import * as github from '../main/github';
import * as projectMemory from '../main/projectMemory';
import * as cliShim from '../main/cliShim';
import * as ttyText from '../main/ttyText';
import * as dataDirs from '../main/dataDirs';
import { asksOwnQuestion } from '../shared/cliQuestion';
import type { ErrorReply } from '../main/cliProto';
import type { AgentState, AgentSummary, AgentWaitReason, CliApi } from '../main/cliServer';
import type { PtyInfo, PtyTail } from '../main/terminal';
import type * as RadialIpc from '../shared/radialApi';
import type { HomeInfo, KeepAwakeResult } from '../shared/radialApi';
import type { AnswerTo } from './types';
import { options, platform, send, viewer } from './host';
import { prepareCold, sessions } from './sessions';

/** A slept agent as projectState stores it. */
export type StoredSleptAgent = import('../main/projectState').SleptAgent;
/**
 * A slept-agent record the reapers build from a pty's meta. Its preview is
 * terminal.ts's PreviewView, which (like the window's own, threadPreview.ts)
 * types as optional the zoom and pan fields projectState.ts's PreviewView
 * requires; recordSleptAgents says why the window's views have them.
 */
type SleptAgentFromPty = Omit<StoredSleptAgent, 'preview'> & Pick<import('../main/terminal').PtyMeta, 'preview'>;
/**
 * term:start's payload as the handler holds it. The preload never sends a null
 * engine: main widens radialApi's TermStartRequest so the handler can fall back
 * to a slept record's engine (`engineKey || rec.engine`), which may be null.
 */
export type TermStartPayload = Omit<RadialIpc.TermStartRequest, 'engine'> & { engine?: RadialIpc.TermStartRequest['engine'] | null };

// ── The agent lane (cliApi's, for `radial agent …` and MCP): real, visible
// sessions in the project's terminals. Completion is read from the bell the
// session rings (the daemon's lastBellAt) and its screen from the pty's tail,
// as is a question its CLI asks of its own.
export async function agentOutput(id: string, { lines }: { lines?: number | null } = {}): ReturnType<CliApi['agentOutput']> {
  if (!terminal.tailSupported()) return DAEMON_OUTDATED;
  const t = await tailTerminal(id);
  if (!t) return { ok: false, code: 'not-found', error: `No session ${id}. \`radial agent list\` shows the live ones.` };
  let text = await ttyText.render(t.data, { cols: t.cols, rows: t.rows });
  if (lines) text = ttyText.lastLines(text, lines);
  return { ok: true, ...tailSummary(t), text };
}
export async function agentWait(id: string, { waitMs, since, idleMs }: Parameters<CliApi['agentWait']>[1]): ReturnType<CliApi['agentWait']> {
  if (!terminal.tailSupported()) return DAEMON_OUTDATED;
  const deadline = Date.now() + waitMs;
  let t = await tailTerminal(id, 1);
  if (!t) return { ok: false, code: 'not-found', error: `No session ${id}. \`radial agent list\` shows the live ones.` };
  // A bell counts only after the latest input: for a task handed to a reused
  // session that is the paste, for a fresh boot the spawn.
  const from = since || Math.max(t.startedAt || 0, t.lastInputAt || 0);
  let reason: AgentWaitReason;
  for (;;) {
    if (t.lastBellAt && t.lastBellAt >= from) { reason = 'bell'; break; }
    if (!t.alive) { reason = 'exit'; break; }
    if (Date.now() - t.lastDataAt >= idleMs) { reason = 'idle'; break; }
    if (Date.now() >= deadline) { reason = 'timeout'; break; }
    await new Promise((r) => setTimeout(r, 500));
    const next = await tailTerminal(id, 1);
    if (!next) { t = { ...t, alive: false }; reason = 'exit'; break; } // the pty is gone
    t = next;
  }
  const full = await tailTerminal(id);
  const text = full ? await ttyText.render(full.data, { cols: full.cols, rows: full.rows }) : '';
  // Its CLI asking a question of its own (trust this folder, sign in): `agent question` reads it.
  const asking = !!full && full.alive && !!(full.meta && full.meta.engine) && asksOwnQuestion((await ttyText.screen(full.data, { cols: full.cols, rows: full.rows })).screen);
  return { ok: true, reason, ...tailSummary(full || t), text: ttyText.lastLines(text, 80), ...(asking ? { asking: true as const } : {}) };
}
export async function agentList(dir: string | null): ReturnType<CliApi['agentList']> {
  let list: PtyInfo[] = []; try { list = await terminal.list(dir || null); } catch {}
  return list.map((t) => {
    const s = sessions.get(t.repoDir); const m = t.meta || {};
    return { id: t.id, repoDir: t.repoDir, name: m.home ? 'Home' : (s && s.project && s.project.name) || path.basename(t.repoDir || ''), engine: m.engine || null, label: m.label || null, home: !!m.home, keepAwake: !!m.keepAwake, alive: !!t.alive, state: sessionState(t), startedAt: t.startedAt || null, lastDataAt: t.lastDataAt || null, lastBellAt: t.lastBellAt || null, lastInputAt: t.lastInputAt || null };
  });
}
export async function agentKill(id: string): ReturnType<CliApi['agentKill']> {
  let list: PtyInfo[] = []; try { list = await terminal.list(null); } catch {}
  if (!list.find((t) => t.id === id)) return { ok: false, code: 'not-found', error: `No session ${id}.` };
  terminal.kill(id);
  return { ok: true, id };
}
export async function agentKeep(id: string, { on = true }: { on?: boolean } = {}): Promise<KeepAwakeResult> { return setKeepAwake(id, on) as Promise<KeepAwakeResult>; /* bridge: setKeepAwake is typed in the other range; drop the cast at merge */ }

/** An outdated terminal service, kept alive for live sessions across an update, can't show a session's screen (tail, v7). */
export const DAEMON_OUTDATED: ErrorReply = { ok: false, code: 'error', error: 'Radial\'s terminal service is still the previous version because agent sessions were live during the update. It updates by itself once they close; or quit and reopen Radial.' };
// waiting: it rang the bell after the last input (done, or asking); working: output in the last few seconds; idle otherwise.
export function sessionState(t: PtyInfo): AgentState {
  if (!t.alive) return 'exited';
  if (t.lastBellAt && t.lastBellAt >= (t.lastInputAt || 0) && t.lastBellAt >= (t.startedAt || 0)) return 'waiting';
  if (t.lastDataAt && Date.now() - t.lastDataAt < 3000) return 'working';
  return 'idle';
}
async function tailTerminal(id: string, bytes = 200000): Promise<PtyTail | null> { try { const t = await terminal.tail(id, bytes); return t && t.ok ? t : null; } catch { return null; } }
function tailSummary(t: PtyTail): AgentSummary {
  const m = (t && t.meta) || {};
  return { id: t.id, repoDir: t.repoDir || null, engine: m.engine || null, label: m.label || null, alive: !!t.alive, startedAt: t.startedAt || null, lastDataAt: t.lastDataAt || null, lastBellAt: t.lastBellAt || null, lastInputAt: t.lastInputAt || null };
}
// ── The Home terminal's ground (plans/radial-agent-native.md) ─────────────
// The projects folder if the person chose one, else ~/Radial (where clones and
// new sites land). Created on demand: node-pty throws inside the daemon on a
// missing cwd, and the renderer would wait forever for its reply.
export function homeCwd(): string {
  const dir = recents.getProjectsDir() || github.workspaceRoot();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  // Codex/Cursor Home agents read AGENTS.md from disk; write the managed CLI
  // block into the Radial-owned folder only, never into a user-chosen one.
  try { if (dir === github.workspaceRoot()) projectMemory.ensureHomeAgentsMd(dir); } catch {}
  return dir;
}

// A sleeping project's agents are shut down too — but only the ones that are
// perfectly restorable (Claude, spawned with a session id) and provably idle
// (see agentSleep.js). An agent mid-task keeps running: quitting Radial while
// it finishes a build is a feature, not a leak. The record left in projectState
// is what relaunches it with `claude --resume` when the project wakes.
export async function reapIdleAgents(repoDir: string): Promise<void> {
  let ptys: PtyInfo[] = [];
  try { ptys = await terminal.list(repoDir); } catch { return; }
  const reap = agentSleep.pickReapable(ptys);
  if (!reap.length) return;
  for (const p of reap) terminal.kill(p.id);
  recordSleptAgents(repoDir, reap.map((p: PtyInfo) => ({ id: p.id, engine: p.meta.engine, label: p.meta.label || 'Claude Code', labelSource: p.meta.labelSource, sessionId: p.meta.sessionId, preview: p.meta.preview, previewSelectedAt: p.meta.previewSelectedAt, recentTaskAt: p.meta.recentTaskAt ?? p.meta.recentOpenedAt ?? 0, recentPinnedAt: p.meta.recentPinnedAt || 0, sleptAt: Date.now() })));
}

// Append slept records (deduped by pty id) and tell the renderer, so live rail
// rows flip to dimmed slept rows even if the reap didn't come through
// suspendSession (ceiling sweep, daemon-side expiry).
function recordSleptAgents(repoDir: string, recs: SleptAgentFromPty[]): void {
  if (!recs || !recs.length) return;
  const cur: StoredSleptAgent[] = projectState.get(repoDir).sleptAgents || [];
  const known = new Set(cur.map((r) => r.id));
  const fresh = recs.filter((r) => r && !known.has(r.id));
  if (!fresh.length) return;
  // The cast asserts the zoom and pan fields projectState.ts's PreviewView requires,
  // and every view the window has saved has them: readThreadPreview has set them all
  // since per-agent previews arrived (0.35.0; older records have no preview), and
  // every pty preview comes from the window (term:start only copies a slept
  // record's back). threadPreview.ts leaves them optional for a field added later.
  projectState.set(repoDir, { sleptAgents: [...cur, ...fresh] as StoredSleptAgent[] });
  send('agents:slept', { repoDir, slept: fresh.map((r) => r.id) });
}

export function discardSleptRecord(repoDir: string, sleptId: string): void {
  const cur: StoredSleptAgent[] = projectState.get(repoDir).sleptAgents || [];
  const next = cur.filter((r) => r.id !== sleptId);
  if (next.length !== cur.length) projectState.set(repoDir, { sleptAgents: next });
}

// Belt-and-braces for the daemon's own expiry sweep: kill agents parked past
// the idle ceiling across ALL repos — including projects not open in this app
// run, which the per-session paths never visit (the founder-machine leak: ~20
// finished agents aged 12h-2.7d). Resumable ones become slept records for
// whenever their project is next opened; a v4 daemon also does this itself so
// the ceiling holds even when Radial isn't running.
export async function reapExpiredAgents(): Promise<void> {
  let ptys: PtyInfo[] = [];
  try { ptys = await terminal.list(null); } catch { return; }
  const byRepo = new Map<string, SleptAgentFromPty[]>();
  for (const p of agentSleep.pickExpired(ptys)) {
    terminal.kill(p.id);
    if (p.meta.engine === 'claude' && p.meta.sessionId) {
      const recs = byRepo.get(p.repoDir) || [];
      recs.push({ id: p.id, engine: p.meta.engine, label: p.meta.label || 'Claude Code', labelSource: p.meta.labelSource, sessionId: p.meta.sessionId, preview: p.meta.preview, previewSelectedAt: p.meta.previewSelectedAt, recentTaskAt: p.meta.recentTaskAt ?? p.meta.recentOpenedAt ?? 0, recentPinnedAt: p.meta.recentPinnedAt || 0, sleptAt: Date.now() });
      byRepo.set(p.repoDir, recs);
    }
  }
  for (const [repoDir, recs] of byRepo) recordSleptAgents(repoDir, recs);
}

// While the app runs, park sessions nobody has used for AGENT_PARK_MS: chats
// (resumable by thread) and Claude terminals (resumable by session id). What
// is on screen right now is asked of the window and never parked.
export async function parkIdleAgents(): Promise<void> {
  let visible: Pick<RadialIpc.CliReplies['visibleAgents'], 'chatIds' | 'termIds'> = { chatIds: [], termIds: [] };
  try { const r = await viewer()?.visibleAgents(); if (r && r.ok) visible = r; } catch {} // no window: nothing is on screen
  try { await viewer()?.chats?.parkIdle({ idleMs: agentSleep.AGENT_PARK_MS, visible: visible.chatIds || [] }); } catch {}
  let ptys: PtyInfo[] = [];
  try { ptys = await terminal.list(null); } catch { return; }
  const onScreen = new Set(visible.termIds || []);
  const byRepo = new Map<string, SleptAgentFromPty[]>();
  for (const p of agentSleep.pickReapable(ptys, Date.now(), agentSleep.AGENT_PARK_MS)) {
    if (onScreen.has(p.id) || p.meta.nativeChatId) continue;
    terminal.kill(p.id);
    const recs = byRepo.get(p.repoDir) || [];
    recs.push({ id: p.id, engine: p.meta.engine, label: p.meta.label || 'Claude Code', labelSource: p.meta.labelSource, sessionId: p.meta.sessionId, preview: p.meta.preview, previewSelectedAt: p.meta.previewSelectedAt, recentTaskAt: p.meta.recentTaskAt ?? p.meta.recentOpenedAt ?? 0, recentPinnedAt: p.meta.recentPinnedAt || 0, sleptAt: Date.now() });
    byRepo.set(p.repoDir, recs);
  }
  for (const [repoDir, recs] of byRepo) recordSleptAgents(repoDir, recs);
}

// Agents the daemon expired while we weren't looking (possibly with the app
// closed): drain its reap log and keep the resumable ones as slept records.
export function mergeDaemonReaps(): void {
  const byRepo = new Map<string, SleptAgentFromPty[]>();
  for (const r of terminal.takeReaped()) {
    if (!r || !r.repoDir || !r.meta) continue;
    if (r.meta.engine !== 'claude' || !r.meta.sessionId) continue; // unrecoverable — just gone
    const recs = byRepo.get(r.repoDir) || [];
    recs.push({ id: r.id, engine: r.meta.engine, label: r.meta.label || 'Claude Code', labelSource: r.meta.labelSource, sessionId: r.meta.sessionId, preview: r.meta.preview, previewSelectedAt: r.meta.previewSelectedAt, recentTaskAt: r.meta.recentTaskAt ?? r.meta.recentOpenedAt ?? 0, recentPinnedAt: r.meta.recentPinnedAt || 0, sleptAt: r.reapedAt || Date.now() });
    byRepo.set(r.repoDir, recs);
  }
  for (const [repoDir, recs] of byRepo) recordSleptAgents(repoDir, recs);
}

// Keep awake (plans/radial-keep-awake.md): a session the person marked — the
// rail's "Keep awake", `radial agent keep`, MCP keep_agent_awake — is never
// parked (agentSleep skips meta.keepAwake in both sweeps, so project sleep,
// quit and the ceiling all leave it alone), and the Mac must not idle-sleep
// while it lives or a phone loses it: Claude Code's remote control dies with
// the process. The daemon holds that assertion itself (caffeinate, surviving
// Radial closing); the app holds one too while it runs (the platform's
// keepAwake), which also covers an outdated daemon kept alive for its ptys.
// Re-synced on every toggle, on the minute tick, and once at boot for sessions
// that were kept across a restart.
export async function syncKeepAwake(ptys?: PtyInfo[] | null): Promise<void> {
  if (!ptys) { try { ptys = await terminal.list(null); } catch { return; } }
  const want = (ptys || []).some((p) => p && p.alive !== false && agentSleep.isKeptAwake(p));
  platform().keepAwake(want);
}
export async function setKeepAwake(id: string, on: boolean): Promise<RadialIpc.KeepAwakeResult> {
  let list: PtyInfo[] = []; try { list = await terminal.list(null); } catch {}
  const p = list.find((t) => t.id === id);
  if (!p || p.alive === false) return { ok: false, code: 'not-found', error: `No live session ${id}.` };
  terminal.setMeta(id, { keepAwake: !!on }); // the flag lives with the pty in the daemon (survives a Radial restart)
  p.meta = { ...(p.meta || {}), keepAwake: !!on };
  await syncKeepAwake(list);
  telemetry.capture('agent_keep_awake', { on: !!on });
  send('agents:keepAwake', { id, on: !!on, repoDir: p.repoDir });
  return { ok: true, id, on: !!on, daemonOutdated: !terminal.keepAwakeSupported() };
}

// The radial-open browser shim. When an agent in a terminal launches a browser
// (via `open`, `xdg-open`, or $BROWSER), the shim routes http(s) URLs back into
// Radial's preview instead of letting them escape to the system browser. We
// materialize it to a writable dir at startup because a script inside the ASAR
// is not executable. NON-URL invocations pass through to the real tool, so
// `open .` / `open -a App` keep working. The env that activates it is injected
// ONLY into agent PTYs (term-daemon startPty), never globally.
const SHIM_SH = `#!/bin/sh
# Radial browser shim — http(s) URL → Radial preview; anything else → real tool.
self=$(basename "$0")
for a in "$@"; do
  case "$a" in
    http://*|https://*)
      [ -n "$RADIAL_SHIM_HELPER" ] && exec node "$RADIAL_SHIM_HELPER" "$a"
      ;;
  esac
done
case "$self" in
  xdg-open) exec /usr/bin/xdg-open "$@" ;;
  *) [ -x /usr/bin/open ] && exec /usr/bin/open "$@"; exit 1 ;;
esac
`;
const SHIM_HELPER_JS = `#!/usr/bin/env node
'use strict';
// Relays one browser URL to the Radial daemon over $RADIAL_OPEN_SOCK, tagged with
// $RADIAL_TERM_ID for routing, and waits for a delivery ack. Exits 0 only when the
// app confirmed receipt; exits 1 on timeout/nack so a dropped open is never
// reported as success. Hard ~750ms bound so it can never hang the agent.
const net = require('net');
const url = process.argv[2];
const SOCK = process.env.RADIAL_OPEN_SOCK;
const termId = process.env.RADIAL_TERM_ID || null;
if (!url || !SOCK) process.exit(1);
let done = false;
function finish(code) { if (done) return; done = true; try { sock.destroy(); } catch (e) {} process.exit(code); }
const timer = setTimeout(() => finish(1), 750);
const sock = net.createConnection(SOCK);
let buf = '';
sock.on('connect', () => { try { sock.write(JSON.stringify({ op: 'open', reqId: '1', termId, url }) + '\\n'); } catch (e) { finish(1); } });
sock.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    let m; try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.op === 'reply' && m.reqId === '1') { clearTimeout(timer); finish(m.ok ? 0 : 1); }
  }
});
sock.on('error', () => { clearTimeout(timer); finish(1); });
`;

const BROWSER_SHIMS = ['radial-open', 'open', 'xdg-open', 'radial-open-helper.js'];
function initShims(): string | null {
  if (process.platform === 'win32') return null; // no `open` to shadow; $BROWSER unset
  const dir = path.join(platform().dataDir, 'shims');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (options().browserShims) {
      fs.writeFileSync(path.join(dir, 'radial-open-helper.js'), SHIM_HELPER_JS, { mode: 0o755 });
      for (const name of ['radial-open', 'open', 'xdg-open']) {
        const p = path.join(dir, name);
        fs.writeFileSync(p, SHIM_SH, { mode: 0o755 });
        try { fs.chmodSync(p, 0o755); } catch {}
      }
    } else {
      // No preview for a browser launch to land in (radial serve): `open` and
      // xdg-open stay the system's, so an agent's sign-in link still opens.
      for (const name of BROWSER_SHIMS) { try { fs.rmSync(path.join(dir, name), { force: true }); } catch {} }
    }
    // The `radial` CLI itself, always on PATH inside Radial terminals and always
    // the running app's copy (plans/radial-agent-native.md). radial serve's says
    // so (headless), so its terminals' `radial` comes back to serve.
    const cliBin = platform().cliBin;
    const cliShimPath = path.join(dir, 'radial');
    fs.writeFileSync(cliShimPath, cliShim.radialShimSource({ bin: cliBin, sock: dataDirs.cliSocket(platform().dataDir), flavor: platform().flavor === 'headless' ? 'headless' : undefined }), { mode: 0o755 });
    try { fs.chmodSync(cliShimPath, 0o755); } catch {}
    return dir;
  } catch (e) { return null; }
}

export function initTerminalDaemon(): void {
  // The persistent PTY daemon owns the agent terminals so they survive app close.
  terminal.init({
    socketPath: dataDirs.daemonSocket(platform().dataDir),
    daemonScript: path.join(__dirname, '..', 'main', 'term-daemon.js'), // the daemon's script is src/main's
    shimDir: initShims(),
  });
  // Forward every terminal's output/exit to the renderer (routed by pty id there).
  // `open` carries an agent's browser launch → the renderer routes preview-vs-external.
  // Output chunks that arrive together (a busy CLI, a replay) go to the window as
  // one message per terminal instead of one per chunk. An exit flushes first.
  const termOut = new Map<string, string>(); let termOutTimer: NodeJS.Immediate | null = null;
  const flushTermOut = () => {
    clearImmediate(termOutTimer as NodeJS.Immediate | undefined); termOutTimer = null; // null is a no-op; @types/node leaves it out
    const out = [...termOut]; termOut.clear();
    for (const [id, data] of out) send('term:data', { id, data });
  };
  terminal.setGlobalHandlers({
    onData: (id: string, data: string) => { viewer()?.chats?.terminalData(id, data); termOut.set(id, (termOut.get(id) || '') + data); termOutTimer ||= setImmediate(flushTermOut); },
    onExit: (id: string) => { flushTermOut(); viewer()?.chats?.terminalExited(id); send('term:exit', { id }); },
    onOpenUrl: (termId: string | null, repoDir: string | null, url: string) => send('term:open-url', { termId, repoDir, url }),
  });
  // Warm a standing subscriber connection so a browser-open works even before the
  // first terminal is opened (otherwise the daemon has no app subscriber).
  terminal.connect().then(() => syncKeepAwake()).catch(() => {}); // sessions kept awake across a restart re-hold the Mac at once
}

// ── Terminals ──
const telemetryAgentSeen = new Set<string>();
// term:start, the window's new terminal (and the agent CLI in it).
export async function startTerminal({ repoDir, cols, rows, engine: engineKey, label, initialText, restoreOf, home }: TermStartPayload): Promise<AnswerTo<'termStart'>> {
  // An engine key (claude/codex) launches the REAL CLI as the terminal's process,
  // seeded with this project's marketing-site context. Falls back to a shell when
  // the requested CLI isn't installed (the renderer pre-checks, so that's rare).
  // The PTY lives in the daemon and keeps running after the app closes; engine/
  // label are stored as meta so we can relabel it on reattach after a restart.
  //
  // `restoreOf` relaunches an agent that was put to sleep (reapIdleAgents): its
  // slept record carries the Claude session id, so the CLI comes back mid-
  // conversation via --resume. Claude agents always spawn with a Radial-minted
  // --session-id — that's what MAKES them resumable at the next sleep.
  let resumeSessionId: string | null = null, labelSource: StoredSleptAgent['labelSource'];
  let preview: import('../main/terminal').PtyMeta['preview'] = null, previewSelectedAt = 0, recentTaskAt = 0, recentPinnedAt = 0;
  if (restoreOf) {
    const rec = (projectState.get(repoDir).sleptAgents || []).find((r: StoredSleptAgent) => r.id === restoreOf);
    if (rec) {
      preview = rec.preview || null;
      previewSelectedAt = rec.previewSelectedAt || 0;
      recentTaskAt = rec.recentTaskAt ?? rec.recentOpenedAt ?? 0;
      recentPinnedAt = rec.recentPinnedAt || 0;
      engineKey = engineKey || rec.engine;
      label = label || rec.label;
      labelSource = rec.labelSource;
      if (rec.engine === 'claude' && rec.sessionId && agentSleep.sessionFileExists(repoDir, rec.sessionId)) {
        resumeSessionId = rec.sessionId; // session file gone/empty → fresh spawn instead
      }
    }
  }
  // A project restored asleep runs its open prep first: the agent reads the AGENTS.md notes it writes as it starts.
  await prepareCold(repoDir);
  const sessionId = engineKey === 'claude' ? (resumeSessionId || randomUUID()) : null;
  const command = engineKey ? engine.spawnSpec(repoDir, engineKey, { initialText: initialText || null, sessionId: resumeSessionId ? null : sessionId, resumeSessionId, scope: home ? 'home' : 'project' }) : null;
  // One agent_session_started per project per app run — the metric is "did they
  // use the agent at all", not per-prompt volume (deliberately not recorded).
  // Wake-relaunches (restoreOf) don't count: the user isn't starting an agent,
  // Radial is putting theirs back.
  if (engineKey && !restoreOf && !telemetryAgentSeen.has(repoDir)) {
    telemetryAgentSeen.add(repoDir);
    telemetry.capture('agent_session_started', { provider: engineKey, source: home ? 'home' : 'project' });
  }
  const id = await terminal.start(repoDir, { cols, rows, command, meta: { engine: engineKey || null, label: label || null, labelSource, sessionId, home: !!home, preview, previewSelectedAt, recentTaskAt, recentPinnedAt } });
  // The daemon streams a terminal to the client that started it, and never
  // parks one a client is attached to: that's a window showing it. With no
  // window (radial serve) nobody shows it, so the core lets go, and the
  // daemon's idle ceiling parks it like any other unseen session.
  if (id && !viewer()) terminal.detach(id);
  if (restoreOf && id) discardSleptRecord(repoDir, restoreOf);
  return { id };
}

// home:info: the Home terminal's folder, and its agents put to sleep.
export async function homeInfo(): Promise<HomeInfo> {
  const cwd = homeCwd();
  return { cwd, sleptAgents: (projectState.get(cwd) || {}).sleptAgents || [] };
}
