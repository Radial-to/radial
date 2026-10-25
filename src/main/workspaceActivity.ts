import path from 'path';
import type { ChildProcess } from 'child_process';
import type { AgentPty, AgentPtyMeta } from './agentSleep';
import type { DevServerHandle } from './devHeal';

/** The parts of a dev-server handle (devServer.start's result) the snapshot reads, beyond the healer's. */
export interface ActivityServerHandle extends DevServerHandle {
  /** An adopted external server's pid; Radial's own servers have a child instead. */
  pid?: number;
  child?: Partial<Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>>;
  external?: boolean;
  startedAt?: number;
  observedAt?: number;
}

/**
 * The parts of an open project's session the snapshot reads. main.ts's session
 * record must satisfy both this and devHeal's HealSession. `project` is
 * devServer.detectProject's result (devServer.ts), which also carries `name`:
 * its eventual type is project.ts's PageProject plus name, or a type
 * devServer.ts will own. A Pick of PageProject alone won't do.
 */
export interface ActivitySession {
  handle?: ActivityServerHandle | null;
  suspended?: boolean;
  project?: { name?: string; framework?: string | null; type?: string | null };
}

/**
 * A pty from the terminal daemon's list (term-daemon.ts), agent or plain shell,
 * or a native chat shown as one: the fields of terminal.ts's PtyInfo the
 * snapshot reads. Its meta is agentSleep's AgentPtyMeta. Becomes a Pick of
 * PtyInfo once terminal.ts is typed (ts/w1-misc).
 */
export interface ActivityTerminal extends AgentPty {
  id: string;
  repoDir: string;
  alive: boolean;
  pid?: number | null;
  startedAt?: number;
  lastBellAt?: number;
  lastInputAt?: number;
}

/** A recents entry (recents.listRecents); recents.ts owns this shape once it is typed. */
export interface ActivityRecent {
  path: string;
  name?: string;
  lastOpened?: number;
}

export interface ActivityInput {
  sessions: ReadonlyMap<string, ActivitySession>;
  agents: readonly ActivityTerminal[];
  recents?: readonly ActivityRecent[];
  /** Radial's own pid, shown for a server that runs in-process. */
  pid: number;
  now?: number;
}

export type ProjectActivityState = 'running' | 'asleep' | 'stopped';

export interface ServerActivity {
  url: string;
  pid: number;
  /** null for an external server: when it really started is unknown. */
  startedAt: number | null;
  observedAt: number | null;
  external: boolean;
}

export interface ProjectActivity {
  repoDir: string;
  name: string;
  state: ProjectActivityState;
  framework: string | null;
  server: ServerActivity | null;
}

export type TerminalActivityState = 'waiting' | 'working' | 'idle';

export interface TerminalActivity {
  id: string;
  repoDir: string;
  home: boolean;
  project: string;
  label: string;
  /** null for a plain shell. */
  engine: NonNullable<AgentPtyMeta['engine']> | null;
  pid: number | null;
  startedAt: number | null;
  keepAwake: boolean;
  state: TerminalActivityState;
}

export interface RecentProjectActivity {
  name: string;
  repoDir: string;
  lastOpened: number | null;
}

/** The workspace:activity reply that Home's activity list renders. */
export interface WorkspaceActivity {
  capturedAt: number;
  projects: ProjectActivity[];
  terminals: TerminalActivity[];
  recentProjects: RecentProjectActivity[];
}

// Snapshot only Radial's own sessions. No machine-wide process scanning, and
// multiple previews of one project still represent a single dev server.
function snapshot({ sessions, agents, recents = [], pid, now = Date.now() }: ActivityInput): WorkspaceActivity {
  const projects = [...sessions].map(([repoDir, session]): ProjectActivity => {
    const h = session.handle;
    const running = !!(h && !h.stopped && !session.suspended
      && (!h.child || (h.child.exitCode == null && !h.child.signalCode)));
    return {
      repoDir, name: session.project?.name || path.basename(repoDir),
      state: running ? 'running' : session.suspended ? 'asleep' : 'stopped',
      framework: session.project?.framework || session.project?.type || null,
      server: running ? {
        url: h.url, pid: h.child?.pid || h.pid || pid,
        startedAt: h.external ? null : h.startedAt || null,
        observedAt: h.observedAt || null, external: !!h.external,
      } : null,
    };
  });
  const terminals = agents.filter(t => t.alive).map((t): TerminalActivity => ({
    id: t.id, repoDir: t.repoDir, home: !!t.meta?.home,
    project: t.meta?.home ? 'Workspace' : projects.find(p => p.repoDir === t.repoDir)?.name || path.basename(t.repoDir || ''),
    label: t.meta?.label || t.meta?.engine || 'Terminal', engine: t.meta?.engine || null,
    pid: t.pid || null, startedAt: t.startedAt || null, keepAwake: !!t.meta?.keepAwake,
    state: t.lastBellAt && t.lastBellAt >= (t.lastInputAt || 0) && t.lastBellAt >= (t.startedAt || 0)
      ? 'waiting' : t.lastDataAt && now - t.lastDataAt < 3000 ? 'working' : 'idle',
  }));
  return { capturedAt: now, projects, terminals,
    recentProjects: recents.map(r => ({ name: r.name || path.basename(r.path), repoDir: r.path, lastOpened: r.lastOpened || null })),
  };
}
export { snapshot };
