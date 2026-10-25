// Typing a task into an agent CLI the way a person would, for both of Radial's
// ways of running one: the window (renderer.ts, reading its xterm) and the core
// with no window (src/core/agentLane.ts, radial serve, reading the PTY
// daemon's scrollback rendered by ttyText). Three rules, each learned from a
// bug:
// - a freshly spawned CLI's first output is its TUI painting itself, and a
//   paste that lands mid-paint is swallowed or wiped by the repaint (Claude
//   Code's doctor and MCP checks redraw a beat after the first paint): wait
//   until the boot paint has settled (whenReady);
// - paste, then check the screen shows it once more than it did before,
//   pasting again until it does, and send Enter on its own a beat later: a TUI
//   that gets the paste's end and Enter in one chunk submits an empty line
//   (pasteVerified);
// - never type into a CLI asking a question of its own (signing in, trusting
//   the folder, approving a command: cliQuestion.ts): the text is lost and its
//   Enter answers the question. The task waits until the question is answered
//   (typeTask); a question that comes up while the text goes in gets no Enter
//   (pasteVerified), and the task waits for it too. Once the text is in the
//   CLI's input, the rows showing it are left out of that look: its own words
//   are never a question (cliQuestion.ts asksAfterTyping).
// Each side hands these an AgentTerm: what its terminal shows and how to type
// into it. Pure timing and text, with no DOM and no Node, so the window loads
// it as a global (RadialAgentPaste, scripts/transpile.mts DUAL) and the core
// imports it.

/** A terminal's program as its host sees it now. */
export interface TermActivity {
  /** It has printed something: its first paint has begun. */
  ready: boolean;
  /** When it last printed, in ms since the epoch; 0 before it has. */
  lastDataAt: number;
  /** When this run of it was spawned; null when it booted before the host was watching (a terminal reattached after a restart). */
  spawnedAt: number | null;
  /** It has ended. */
  exited: boolean;
}

/** A terminal an agent CLI (or a plain shell) runs in: what the primitives read from it and write to it. */
export interface AgentTerm {
  /** An agent CLI runs here (Claude Code, Codex, Cursor), not a plain shell. */
  readonly agent: boolean;
  /** Its program's activity now. */
  activity(): TermActivity | Promise<TermActivity>;
  /** The bottom of its buffer as text, the last 60 rows: where a paste is looked for. */
  recentText(): string | Promise<string>;
  /**
   * Its CLI is asking a question of its own instead of showing its input
   * (cliQuestion.ts, on the rows it shows). typed: text Radial has typed into
   * its input, whose rows are left out of the look (asksAfterTyping).
   */
  asking(typed?: string): boolean | Promise<boolean>;
  /** Writes text as one bracketed paste, not submitted. */
  paste(text: string): void;
  /** Presses Enter. */
  enter(): void;
  /** The last resort when a paste never shows: the paste and its Enter in one go. */
  pasteAndEnter(text: string): void;
  /** It ended, or it isn't the session the task was for any more: a task waiting on a question gives up. */
  gone(): boolean | Promise<boolean>;
  /** A paste of this text begins (the window keeps it to name the session by). */
  pasting?(text: string): void;
  /** What was pasted was submitted (the window moves the session up its recent threads). */
  submitted?(): void;
}

/** How long the primitives wait, in ms. */
export interface Timing {
  /** whenReady: the boot paint has settled once the CLI has been quiet this long. */
  settleMs: number;
  /** whenReady: a chatty CLI that never goes quiet gets the paste after this long anyway. */
  capMs: number;
  /** whenReady: a CLI spawned longer ago than this is past its boot, and takes a paste even mid-stream. */
  bootWindowMs: number;
  /** whenReady: how often it looks. */
  tickMs: number;
  /** whenReady, a plain shell: its first output, or this long. */
  shellCapMs: number;
  /** pasteVerified: how many times it pastes before giving up on seeing the text. */
  pasteTries: number;
  /** pasteVerified: how many times it looks after each paste, checkMs apart. */
  pasteChecks: number;
  checkMs: number;
  /** pasteVerified: the beat between a paste showing and its Enter. */
  enterDelayMs: number;
  /** typeTask: how long a task waits for the CLI's own question to be answered. */
  questionWaitMs: number;
  /** typeTask: how often it looks while it waits. */
  questionPollMs: number;
  /** typeTask: once the question is gone, the CLI has settled on its input after this long quiet. */
  quietMs: number;
}

const TIMING: Timing = {
  settleMs: 450, capMs: 8000, bootWindowMs: 10000, tickMs: 120, shellCapMs: 2000,
  pasteTries: 3, pasteChecks: 6, checkMs: 250, enterDelayMs: 150,
  questionWaitMs: 30 * 60000, questionPollMs: 250, quietMs: 1000,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves once the terminal takes a paste. An agent CLI: once its output has
 * started and then gone quiet for a beat (the boot paint is done), at once for
 * one past its boot window or ended, and after capMs at the latest, so a chatty
 * or mid-turn CLI still gets the paste. A plain shell: its first output, or
 * shellCapMs. (The window keeps its own shell branch, which hears the first
 * output as it arrives instead of looking for it.)
 */
async function whenReady(t: AgentTerm, timing: Timing = TIMING): Promise<void> {
  const started = Date.now();
  for (;;) {
    const a = await t.activity();
    const now = Date.now();
    if (!t.agent) {
      if (a.ready || a.exited || now - started >= timing.shellCapMs) return;
    } else {
      const pastBoot = a.ready && (!a.spawnedAt || now - a.spawnedAt >= timing.bootWindowMs);
      const settled = a.ready && !!a.lastDataAt && now - a.lastDataAt >= timing.settleMs;
      if (pastBoot || settled || a.exited || now - started >= timing.capMs) return;
    }
    await sleep(timing.tickMs);
  }
}

// What of a text a screen shows: how often its first and its last 24 characters
// appear (whitespace aside, so the TUI's line wrapping can't hide them), how
// many paste chips (Claude Code shows a long or multi-line paste as "[Pasted
// text #N +M lines]", Codex one over 1000 characters as "[Pasted Content N
// chars]"), and the CLI's input. A paste landed when any count went up; a short
// text (a digit, a "y") is all over a screen (a timer, a count of tokens), so it
// landed once the input changed to end with it, or, with no input to read, by
// the counts.
interface Seen { head: number; tail: number; chips: number; input: string | null }
const CHIPS = /\[Pasted (?:text|Content)\b/gi;
const SHORT = 6;
// The CLI's input: the words after the lowest mark of one where a CLI draws it (Claude Code's ❯ and Codex's › at the
// line's start, Cursor Agent's → two columns in at most, as cliQuestion.ts reads them), with the rows under it that
// go on indented, whitespace aside; null when none shows.
const INPUT_MARK = /^(?:[❯›]|[ \u00a0]{0,2}→)(?:[ \u00a0]+|$)/;
function inputOf(screen: string): string | null {
  const rows = screen.split('\n');
  let at = rows.length - 1;
  while (at >= 0 && !INPUT_MARK.test(rows[at])) at--;
  if (at < 0) return null;
  let text = rows[at].replace(INPUT_MARK, '');
  for (let i = at + 1; i < rows.length && /^[ \u00a0]+\S/.test(rows[i]); i++) text += rows[i];
  return text.replace(/\s+/g, '');
}
function seenOf(screen: string, text: string): Seen {
  const s = screen.replace(/\s+/g, ''), flat = text.replace(/\s+/g, '');
  const count = (needle: string): number => (needle ? s.split(needle).length - 1 : 0);
  return { head: count(flat.slice(0, 24)), tail: count(flat.slice(-24)), chips: (screen.match(CHIPS) || []).length, input: inputOf(screen) };
}
function more(now: Seen, before: Seen, text: string): boolean {
  const flat = text.replace(/\s+/g, '');
  if (flat.length < SHORT && now.input !== null && before.input !== null) return now.input !== before.input && now.input.endsWith(flat);
  return now.head > before.head || now.tail > before.tail || now.chips > before.chips;
}

/**
 * Pastes text, then checks the terminal shows it before (when asked) submitting
 * it with Enter on its own. A TUI's boot repaint can wipe a paste that landed
 * too early, so it reads the screen back and pastes again until the text
 * sticks. It always pastes once: the same words already on screen (an earlier
 * message that starts the same, a quick edit's "The user selected 1 element")
 * prove nothing, so it lands only when the screen shows the text, or a paste
 * chip, once more than before (a short text: when the CLI's input changed to end
 * with it). Answers whether the text was seen; one never
 * seen is still submitted on the old direct path. A question of the CLI's own
 * that comes up meanwhile (a permission prompt the moment before Enter) gets no
 * more pastes and no Enter: landed is false, and the text isn't submitted.
 */
async function pasteVerified(t: AgentTerm, text: string, submit: boolean, timing: Timing = TIMING): Promise<boolean> {
  return (await pasteChecked(t, text, submit, timing)).landed;
}
/**
 * pasteVerified's work: whether the text landed, whether a question of the
 * CLI's own stopped it before its Enter, whether it typed anything, and what
 * the screen showed of the text before its first paste. resume: that, from a
 * send a question stopped, whose text its input may have kept: it is pasted
 * again only when the screen no longer shows it. halted: the send was called
 * off before it typed anything, which stops it as a question does. typing: told
 * before each key it writes.
 */
async function pasteChecked(t: AgentTerm, text: string, submit: boolean, timing: Timing, resume: Seen | null = null, halted: () => boolean = () => false, typing: () => void = () => {}): Promise<{ landed: boolean; stopped: boolean; typed: boolean; before: Seen }> {
  t.pasting?.(text);
  const before = resume || seenOf(await t.recentText(), text);
  const shows = async (): Promise<boolean> => more(seenOf(await t.recentText(), text), before, text);
  const stop = async (): Promise<boolean> => halted() || await t.asking(text) || halted();
  let typed = false;
  let landed = !!resume && await shows();
  for (let attempt = 0; attempt < timing.pasteTries && !landed; attempt++) {
    if (await stop()) return { landed: false, stopped: true, typed, before };
    typing(); t.paste(text); typed = true;
    for (let w = 0; w < timing.pasteChecks && !(landed = await shows()); w++) await sleep(timing.checkMs);
  }
  if (submit) {
    if (landed) await sleep(timing.enterDelayMs);
    if (await stop()) return { landed: false, stopped: true, typed, before }; // its Enter would answer the question
    typing();
    if (landed) t.enter();
    else t.pasteAndEnter(text); // the last resort: the old direct path
    typed = true;
    t.submitted?.();
  }
  return { landed, stopped: false, typed, before };
}

/**
 * A task typed into a CLI (typeTask): seen landing now, or waiting for its CLI's
 * own question; typed when anything was written to it now (the text, maybe
 * unseen); delivered resolves once it went in (true), or when it never will
 * (false); typing resolves once it starts typing. cancel calls off one that
 * waits and has typed nothing yet: nothing is typed, delivered says false, and
 * it answers true. Once its text has begun to go in, the send goes on to its
 * Enter (a text left in the CLI's input would go in twice with a retry): it
 * answers false.
 */
export interface TypedTask { landed: boolean; waiting: boolean; typed: boolean; delivered: Promise<boolean>; typing: Promise<void>; cancel(): boolean }

/**
 * A task into a CLI, as a person would type it (pasteVerified). A CLI asking a
 * question of its own gets nothing now: the task goes in once the question is
 * answered and the CLI has drawn its input (a second question waits too),
 * unless the session ends or goes first. landed is false then, and waiting true.
 * So does one that asks while the text goes in: no Enter, and the text goes in
 * (or, when its input kept it, just its Enter) once that is answered. delivered
 * says when it went in, for a caller that marks something done by it (comments
 * pulled, a fix attempt): false when the session went, the wait ran out, or the
 * caller called it off (cancel) before it began to type.
 */
async function typeTask(t: AgentTerm, text: string, submit: boolean, timing: Timing = TIMING): Promise<TypedTask> {
  let before: Seen | null = null, typed = false, cancelled = false, started = false, begin = (): void => {};
  const typing = new Promise<void>((resolve) => { begin = resolve; });
  const start = (): void => { started = true; begin(); };
  const cancel = (): boolean => { if (!started) cancelled = true; return !started; };
  const halted = (): boolean => cancelled;
  if (!(await t.asking())) {
    const now = await pasteChecked(t, text, submit, timing, null, halted, start);
    if (!now.stopped) return { landed: now.landed, waiting: false, typed: now.typed, delivered: Promise.resolve(true), typing, cancel };
    // Stopped by a question: what it typed may sit in the CLI's input, kept for after the question.
    if (now.typed) before = now.before;
    typed = now.typed;
  }
  const delivered = (async () => {
    for (const until = Date.now() + timing.questionWaitMs; Date.now() < until; await sleep(timing.questionPollMs)) {
      if (cancelled || await t.gone()) return false;
      // Quiet for a moment with no question on screen: the CLI has settled on its input.
      if (Date.now() - (await t.activity()).lastDataAt >= timing.quietMs && !(await t.asking(text))) {
        const now = await pasteChecked(t, text, submit, timing, before, halted, start);
        if (!now.stopped) return true;
        if (now.typed) before ||= now.before;
      }
    }
    return false;
  })().catch(() => false); // a terminal that went away mid-wait just ends it
  return { landed: false, waiting: true, typed, delivered, typing, cancel };
}

export { TIMING, whenReady, pasteVerified, typeTask };
