/**
 * Radial owns the dev server and the live preview. A Bash command from the agent
 * that spawns a competing dev server, or deletes the framework build/cache dir
 * out from under the running one, corrupts the preview — this is the source of
 * the "another dev server is already running" loops and the stale-`.next`
 * `Cannot read properties of undefined (reading '/_app')` crashes.
 *
 * Guidance in the system prompt reduces this but can't guarantee it, so the
 * hook Radial gives the Claude Code chats it starts (chat/observe.cjs, set up
 * by chat/interactive.ts) refuses these commands before they run. The hook
 * loads a copy of this module's compiled file from beside itself, outside the
 * app, so this module imports nothing. Codex and Cursor chats, and agents
 * started in a plain terminal, aren't covered.
 * `forbiddenBashReason` returns a message to hand back to the agent (so it
 * self-corrects this turn), or null.
 */

// Starting/serving a dev (or prod) server: framework binaries + `<pm> run dev`.
const DEV_SERVER_RE = /\b(?:next\s+dev|next\s+start|astro\s+dev|remix\s+(?:vite:)?dev|gatsby\s+develop|ng\s+serve|webpack(?:-dev-server|\s+serve)|react-scripts\s+start|(?:npm|pnpm|yarn|bun|npx)\s+(?:run\s+)?(?:dev|develop|serve|start))\b/i;

// Binaries that serve with no subcommand (`vite`, `nuxt`) count only when a
// command runs them: first in it (after any VAR=value, a launcher such as npx,
// bunx or `pnpm exec`, or a path to the binary), with no subcommand, a flag, or
// a serving one. Named anywhere else (`cat vite.config.ts`, `npm i -D vite`,
// `rg vite`) or given another subcommand (`vite build`), they start nothing.
const SERVER_BINS: Record<string, RegExp> = { vite: /^(?:$|-|(?:dev|serve|preview)\b)/i, nuxt: /^(?:$|-|(?:dev|preview)\b)/i, nuxi: /^(?:dev|preview)\b/i };
const LAUNCHERS_RE = /^(?:(?:npx|bunx|exec|env|bun\s+x|npm\s+(?:exec|x)|(?:pnpm|yarn)(?:\s+(?:exec|dlx))?)\s+(?:-\S+\s+)*)*/i;
function runsServerBin(cmd: string): boolean {
  return cmd.split(/&&|\|\||\$\(|[;|&\n()`]/).some((clause) => {
    const words = clause.trim().replace(/^(?:\w+=\S*\s+)*/, '').replace(LAUNCHERS_RE, '').split(/\s+/);
    const bin = (words[0] || '').split('/').pop()!.toLowerCase();
    return Object.hasOwn(SERVER_BINS, bin) && SERVER_BINS[bin].test(words.slice(1).join(' '));
  });
}

// Deleting/moving a framework build or cache dir.
const DELETES_BUILD_RE = /\brm\b[^;|&\n]*?(?:^|[\s/'"])\.(?:next|vite|svelte-kit|nuxt|astro|turbo)(?:[\s/'"]|$)/i;

// Killing processes: any kill-family command; the pid check happens against
// the CALLER-provided set of this project's dev-server pids (we can't know
// process identity from text alone). pkill/killall by dev-server-ish NAME is
// always denied — it reaps every matching process on the machine.
const KILL_RE = /\b(?:kill|pkill|killall)\b/i;
const KILL_BY_NAME_RE = /\b(?:pkill|killall)\b[^;|&\n]*\b(?:node|next|vite|astro|nuxt|remix|gatsby|webpack)\b/i;

const RESTART_HINT = 'If the preview looks stale (served output disagrees with the file on disk), run `radial restart --yes` and Radial restarts the server cleanly. Read the new URL with `radial url`.';

// Kill via a runtime pid lookup (`lsof -ti:PORT | xargs kill`, `fuser -k`,
// `npx kill-port`) — the pid never appears literally, so the pid-set check
// can't see it; the lookup itself gives the intent away.
const KILL_BY_PORT_RE = /\bkill-port\b|\bfuser\b[^;|\n]*-k|(?=[\s\S]*\bkill)[\s\S]*\blsof\b[^;|\n]*-t/i;

/** Which rule denied a command, so the caller can react beyond messaging. */
export type ForbiddenBashKind = 'server' | 'build' | 'kill-port' | 'kill-name' | 'kill-pid';

export interface ForbiddenBashVerdict {
  kind: ForbiddenBashKind;
  /** Handed back to the agent so it self-corrects this turn. */
  message: string;
}

/** The preview server's pids, or a provider of them that may throw. */
export type DevServerPids = ReadonlySet<number> | (() => ReadonlySet<number>);

export interface ForbiddenBashOptions {
  devServerPids?: DevServerPids;
}

/**
 * Why this Bash command must be denied: { kind, message } or null. `kind` lets
 * the caller react beyond messaging (e.g. a kill aimed at the preview's server
 * triggers the clean restart the agent actually wanted). `opts.devServerPids`
 * is a lazy provider (Set or () => Set) of the preview server's pids —
 * evaluated only when the command is kill-shaped.
 */
function forbiddenBash(command: unknown, opts: ForbiddenBashOptions = {}): ForbiddenBashVerdict | null {
  const cmd = String(command || '');
  if (DEV_SERVER_RE.test(cmd) || runsServerBin(cmd)) {
    return { kind: 'server', message: 'Radial already runs this project\'s dev server and shows it in the live preview (it hot-reloads on every edit). Do not start, restart, or stop a dev server: a second one collides with Radial\'s and corrupts the preview. Just edit the files; Radial recompiles and reloads automatically. To verify, run a typecheck like `tsc --noEmit`. ' + RESTART_HINT };
  }
  if (DELETES_BUILD_RE.test(cmd)) {
    return { kind: 'build', message: 'Do not delete the framework build/cache dir (`.next`, `.vite`, etc.): Radial\'s dev server is using it, and removing it corrupts the running preview. Edit the source and let Radial recompile. ' + RESTART_HINT };
  }
  // Checked OUTSIDE the kill-word gate: `fuser -k` and friends kill without
  // ever saying "kill".
  if (KILL_BY_PORT_RE.test(cmd)) {
    return { kind: 'kill-port', message: 'Do not kill processes by port lookup: that targets the live preview\'s dev server. ' + RESTART_HINT };
  }
  if (KILL_RE.test(cmd)) {
    if (KILL_BY_NAME_RE.test(cmd)) {
      return { kind: 'kill-name', message: 'Do not kill dev-server processes by name: that reaps every match on the machine, including the live preview\'s server (and servers from other projects). ' + RESTART_HINT };
    }
    let pids: DevServerPids | null | undefined = opts.devServerPids;
    if (typeof pids === 'function') { try { pids = pids(); } catch { pids = null; } }
    if (pids && [...pids].some((p) => p && new RegExp('\\b' + p + '\\b').test(cmd))) {
      return { kind: 'kill-pid', message: 'That pid belongs to the live preview\'s dev server. Do not kill it: the preview dies with it. ' + RESTART_HINT };
    }
  }
  return null;
}

function forbiddenBashReason(command: unknown, opts: ForbiddenBashOptions = {}): string | null {
  const r = forbiddenBash(command, opts);
  return r ? r.message : null;
}

export { forbiddenBash, forbiddenBashReason };
