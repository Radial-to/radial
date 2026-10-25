/**
 * Engine adapter — runs the REAL Claude Code / Codex CLIs as Radial's agent.
 *
 * Radial's job is not to reimplement the agent (that's competing with Anthropic);
 * it's to be the thinnest visual frontend that makes those CLIs effortless for
 * designers building marketing sites. This module knows how to launch each real
 * binary in a PTY with the project's marketing-site context seeded — so a session
 * inside Radial carries the same domain craft the built-in chat used to inject,
 * without Radial owning the conversation.
 *
 * Slice 1: detection + context + spawn spec. The visual bridge (fs-watch + git
 * for edit highlighting / undo) and prompt injection land in later slices.
 */

import { which, claudeBin } from './env';
import * as agent from './agent';
import * as cursor from './cursor'; // its bin() resolves cursor-agent in ~/.local/bin (off PATH)
import * as projectMemory from './projectMemory';
import * as references from './references';
import * as cliSpec from './cliSpec';
import * as projectData from './projectData';
import * as context from './context';
import type { ChatEngine } from '../shared/chatPermissions';
import type { TermCommand } from './terminal';

/** An agent CLI Radial can launch: the binary it looks for, and its name in the app. */
export interface EngineInfo { bin: string; label: string }

// Exactly the window's engines: a key missing here, or one the window doesn't have, fails to compile.
const ENGINES = {
  claude: { bin: 'claude', label: 'Claude Code' },
  codex: { bin: 'codex', label: 'Codex' },
  cursor: { bin: 'cursor-agent', label: 'Cursor' },
} satisfies Record<ChatEngine, EngineInfo>;

/**
 * An engine Radial launches: claude, codex or cursor. It is the window's
 * ChatEngine (radialApi's engineAvailable and term:start), which ENGINES' keys
 * match exactly.
 */
export type EngineKey = ChatEngine;

// cursor-agent installs to ~/.local/bin, which the app's PATH usually misses —
// resolve it via the cursor module instead of plain which(). Claude resolves by
// version (claudeBin) so a stale install can't shadow the real CLI's models.
function engineBin(key: EngineKey): string | null {
  if (key === 'cursor') return cursor.bin();
  if (key === 'claude') return claudeBin();
  return which(ENGINES[key].bin);
}

/** Which engine CLIs are installed on this machine (e.g. { claude:true, codex:false, cursor:true }). */
function available(): Record<EngineKey, boolean> {
  const out = {} as Record<EngineKey, boolean>; // the loop sets every key
  for (const key of Object.keys(ENGINES) as EngineKey[]) out[key] = !!engineBin(key);
  return out;
}

/**
 * Marketing-site domain craft to seed a raw CLI session — the SAME expertise the
 * built-in chat injected, MINUS the Radial-UI formatting rules (a terminal renders
 * markdown and shows real output, so "no markdown / don't mention localhost" don't
 * apply here). The project's own AGENTS.md rules are appended too; the CLIs also
 * read those from disk, but passing them guarantees the craft is present even on a
 * repo whose memory file the CLI wouldn't otherwise load.
 */
// Radial runs ONE dev server + live preview per project, shared by every agent
// terminal. A CLI that starts its own dev server (or wipes the build dir) collides
// with it and breaks the shared preview — so tell the agent not to. (Phrased to
// avoid the chat-only UI rules; a terminal renders markdown and shows output fine.)
const DEV_SERVER_NOTE = [
  'SHARED PREVIEW (important): Radial already runs this project\'s dev server and live preview, and hot-reloads it on every file edit. Multiple agents may be working in this same project and they all share that one preview.',
  '- The server\'s current URL is in `.radial/dev.json` at the project root (its `url` field). The port is OS-assigned and changes on every restart — NEVER assume a default port (3000, 4321, 5173) and never port-scan; whatever answers there is some other app. Re-read the file whenever you need the URL, and sanity-check that the page you fetched is actually this project before drawing conclusions from it.',
  '- If `.radial/dev.json` is missing or its URL doesn\'t answer, the preview isn\'t running: `radial wake` starts it again (`radial open .` when the project isn\'t open in Radial), or say so. Do NOT start another dev server (next dev, vite, npm/pnpm/yarn run dev) and do NOT delete the build/cache dir (.next, .vite, dist): that collides with Radial\'s server and breaks everyone\'s preview.',
  '- If an edit "doesn\'t show up": fetch the page/asset from the dev.json URL and compare it with the file on disk. Hot reload can wedge — a healthy server can keep serving PRE-edit output. When served output disagrees with disk, do NOT kill or restart processes yourself: create an empty file `.radial/restart-dev-server` in the project root and Radial will cleanly restart the preview within seconds. The URL changes — re-read `.radial/dev.json` afterwards.',
  '- You MAY install genuinely-missing dependencies and edit source/config. To check your work, prefer a fast typecheck (tsc --noEmit) or lint over a full production build. After you edit files, the preview updates on its own.',
].join('\n');

// Site migration (plans/site-migration.md): the playbook's on-disk path, set by
// main once it is installed; the triggers below point every agent at it.
let migrationPlaybook: string | null = null;
function setMigrationPlaybook(file: string | null): void { migrationPlaybook = file; }
const migrationNote = (home: boolean): string => !migrationPlaybook ? '' : home
  ? `\n\nSITE MIGRATION: when the person wants to bring in, migrate, import or copy an existing website (Webflow, Framer, Squarespace, Wix, WordPress, any URL) to edit in Radial, ask which framework they want (Astro or Next.js) if they have not said, then run \`radial migrate start <url> --framework astro|next\` (add --include <file> for anything they share from their site: CMS exports, logos, fonts, brand docs; add --only <path> when they want part of the site first, e.g. --only / for just the homepage). It creates the project, captures the live site and starts the migration agent there; tell them Claude Code may ask them to trust the new folder, and that migrations work best on one of the latest frontier models at high to max effort. Then follow it with \`radial agent output\`. Playbook: ${migrationPlaybook}`
  : `\n\nSITE MIGRATION: to bring an existing live site (Webflow, Framer, Squarespace, any URL) into this project, run \`radial migrate capture <url>\` and follow Radial's migration playbook: ${migrationPlaybook}. Check parity with \`radial migrate compare\`.`;

function contextFor(repoDir: string): string {
  const rules = (projectMemory.readForAgent(repoDir) || '').trim();
  // Project references ride along as POINTERS — the agent knows where each
  // source lives and pulls it itself (gh, fetch); Radial never mirrors content.
  let srcs = '';
  try { srcs = references.promptSection(repoDir); } catch {}
  // The `radial` verbs ride along (cliSpec is the one source): an agent told
  // "open X in Radial" or "what's the preview URL" has the command, not a guess.
  const local = projectData.isLocal(repoDir);
  const docs = local ? context.list(repoDir).map(f => f.abs).join('\n') : '';
  return agent.MARKETING_SKILLS + '\n\n' + projectData.agentText(repoDir, DEV_SERVER_NOTE) + '\n\n' + projectData.agentText(repoDir, cliSpec.agentNote())
    + (local ? '\n\nLOCAL RADIAL DATA: Keep all Radial metadata outside the repository. Do not create .radial files, add Radial instructions to AGENTS.md, or change ignore files for Radial. Use `radial context` for current notes and `radial restart --yes` to restart the preview.\n' + docs : '')
    + (srcs ? `\n\n${srcs}` : '')
    + migrationNote(false)
    + (rules ? `\n\n--- This project's saved rules (AGENTS.md — follow them) ---\n${rules.slice(0, 6000)}` : '');
}

// The Home terminal (plans/radial-agent-native.md): a session with NO project
// open, living in the projects folder. It gets a short brief instead of the
// project-scoped marketing craft + shared-preview contract — its job is to get
// the person into a project with the CLI, or to fan work out to per-site agents.
const HOME_NOTE = [
  "RADIAL HOME: you're in Radial's Home terminal, and no project is open. Radial runs marketing-site repos (Astro, Next.js, plain HTML) with a live preview plus agent terminals per project, in the Mac app or as `radial serve` on a server.",
  'You are the workspace assistant: answer questions across the person’s websites, inspect active agents and previews, help find or open projects, and carry out requested work in the relevant site. Use the `radial` CLI for live workspace state and project context. For questions, inspect and explain; only make changes when requested.',
  'The working directory is where clones and new sites land. Run `radial ls` before guessing a path; a GitHub link goes straight to `radial open <url>`; for work inside a site, `cd` into it or start a sub-agent there with `radial agent start`.',
  'For Codex command approvals, propose a narrowly scoped prefix_rule for each Radial subcommand (for example ["radial", "open"] or ["radial", "ls"]) so the user can choose to remember it. Keep separate commands separate; never request a blanket shell or radial-wide rule.',
  "Don't start dev servers here, and don't edit a site's files without opening it first.",
].join('\n');
function homeContext(cwd: string): string {
  return HOME_NOTE + (cwd ? `\nWorking directory: ${cwd}` : '') + '\n\n' + cliSpec.agentNote() + migrationNote(true);
}

/** spawnSpec's options: the first prompt, Claude's session pinning, and which brief the agent gets. */
export interface SpawnOptions {
  /** The agent's first prompt, passed as the CLI's positional argument. */
  initialText?: string | null;
  /** Claude: pin a fresh session to this id (--session-id). */
  sessionId?: string | null;
  /** Claude: resume this session (--resume); it wins over sessionId. */
  resumeSessionId?: string | null;
  /** 'home': the Home terminal's brief instead of the project's context. */
  scope?: 'project' | 'home';
}
/** How to launch an engine in a PTY (terminal.start's command): its binary, the arguments, and the engine it resolved to. */
export interface SpawnSpec extends TermCommand { args: string[]; engine: EngineKey }

/**
 * How to spawn an engine's real binary in a PTY: { bin, args, engine }, or null
 * when that CLI isn't installed. Unknown engine keys fall back to Claude Code.
 *
 * A LIVE session persists in the PTY daemon (term-daemon.js) across app close.
 * Claude additionally gets CLI-level continuity: every fresh spawn is pinned to
 * a Radial-minted `--session-id`, so an agent shut down by project sleep
 * (agentSleep.js) relaunches into the same conversation with `--resume`.
 */
function spawnSpec(repoDir: string, engineKey: string, { initialText = null, sessionId = null, resumeSessionId = null, scope = 'project' }: SpawnOptions = {}): SpawnSpec | null {
  // An engine's own key, else Claude Code: a name only Object.prototype has (constructor, toString) is unknown too.
  const key = Object.hasOwn(ENGINES, engineKey) ? engineKey as EngineKey : 'claude';
  const bin = engineBin(key);
  if (!bin) return null;
  // An initial prompt rides as the CLI's positional argument: the turn starts
  // WITH the boot. A paste into a freshly spawned TUI can be wiped by its async
  // boot repaint (Claude's doctor/MCP checks redraw a beat after first paint),
  // so auto-submitting sends into a NEW terminal use this instead of pasting.
  const tail = initialText ? [String(initialText)] : [];
  // Codex / Cursor read AGENTS.md (and .cursor rules) from the repo for context —
  // launch the interactive TUI plain. (No session pinning: neither has a
  // --session-id/--resume pair we control, which is why sleep never reaps them.)
  if (key === 'codex' || key === 'cursor') {
    if (initialText && scope !== 'home' && projectData.isLocal(repoDir)) tail[0] = contextFor(repoDir) + '\n\n--- Request ---\n' + initialText;
    return { bin, args: tail, engine: key };
  }
  // Claude Code seeds the marketing-site craft as an appended system prompt.
  const args: string[] = [];
  if (resumeSessionId) args.push('--resume', String(resumeSessionId));
  else if (sessionId) args.push('--session-id', String(sessionId));
  args.push('--append-system-prompt', scope === 'home' ? homeContext(repoDir) : contextFor(repoDir), ...tail);
  return { bin, args, engine: key };
}

// Bracketed paste: wrap injected text so the CLI's TUI treats a multi-line prompt
// as ONE pasted block (Claude Code / Codex won't submit on the first newline the
// way raw typed input would). Optional trailing CR submits it; by default we stage
// it so the designer reviews before pressing Enter. The CLI must have bracketed
// paste enabled (Ink-based TUIs like these do) for the markers to be honored;
// worst case they're stripped and the text still lands.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
function pasteSequence(text: string | null | undefined, { submit = false }: { submit?: boolean } = {}): string {
  return PASTE_START + String(text == null ? '' : text) + PASTE_END + (submit ? '\r' : '');
}

export { ENGINES, available, contextFor, homeContext, HOME_NOTE, spawnSpec, pasteSequence, setMigrationPlaybook };
