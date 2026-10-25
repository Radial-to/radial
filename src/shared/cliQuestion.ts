// Whether an agent CLI's screen shows a question of its own (signing in,
// trusting the folder, a first-run choice) instead of its input prompt. Text
// typed into such a question is lost, and an Enter answers it: it can trust the
// folder for the person, or quit the CLI. Read from what Claude Code 2.1, Codex
// 0.163 and Cursor Agent 2026.10 show in a new folder, and as they work:
// - Claude Code: menus put an indented ❯ on the chosen option (the theme, the
//   login method, "Accessing workspace: … ❯ No, exit / Yes, I trust this
//   folder", a command's "Do you want to proceed? ❯ 1. Yes"), above "Enter to
//   confirm · Esc to cancel" or "Press Enter to continue…". Its input is a box:
//   a ❯ at the start of the line between two rules across the screen, with
//   "? for shortcuts" under it while it is empty. Each earlier prompt of the
//   conversation shows above it with the same ❯ at the line's start (never
//   right under a rule), and stays on screen when a question takes the box's
//   place.
// - Codex: "Sign in with ChatGPT … Press enter to continue", "Trust this
//   folder? … › 1. Trust and continue … enter continue · esc back", and its
//   pickers ("Select Model and Effort … enter select · esc back"). Its menus put
//   their › at the line's start, as its input prompt does ("› Ask Codex to do
//   anything", with "? for shortcuts" below it, which goes once the input has
//   text): a draft "1. Fix the hero" reads "› 1. Fix the hero", like an option,
//   but with no hint of a menu under it. Under its input, draft or not, is its
//   footer: "GPT-6.1-Sol default · /work/site", its model and its folder.
// - Cursor Agent: "Press any key to log in...", "Workspace Trust Required …
//   Trust this workspace", its approvals ("Run this command?") and its mode
//   switches ("Switch to Agent mode?"). Its input prompt is an arrow two columns
//   in, "→ Plan, search, build anything" or "→ " and what was typed, with its
//   model and its folder under it. It keeps that row while it asks ("→ Waiting
//   for decision (y/n/p)..."), and marks a list's chosen option with an arrow
//   too, at times two columns in as well.
// Both sides ask it: main before it delivers a chat's message to its CLI
// (chat/interactive.ts readControls), and the window before `radial agent start`
// or `agent send` types into a CLI.
//
// What such a question asks, and its answer, for `radial agent question` and
// `agent answer` (readQuestion, planAnswer, answerQuestion):
// - its words, all of them, from where its CLI's own dialog begins down to its
//   options: Claude Code's rule across the screen at its first column, or its
//   logo over a first-run screen; Codex's title, two columns in, or its own mark
//   that it clipped the dialog; Cursor Agent's name over its log in screen. Rows
//   of the question's own content never count as one: a dialog's content is
//   indented, so a line of dashes or dots in a command is just a line of it. A
//   dialog that runs above the screen, that its CLI clipped, or whose beginning
//   Radial can't see, can't be read whole: it isn't answered;
// - its options as the screen lists them (numbered menus, a line under an
//   option saying more, and Claude Code's plain trust and API key menus,
//   numbered here by their place), and the one with the focus;
// - what answers it: an option, a line of text typed into its field (Codex's
//   API key), or Enter alone ("Press Enter to continue…", "Press any key");
// - its key: its words and options with their whitespace run together (but
//   for where an indent moves), so it reads the same at any width. The core
//   counts the occurrences of a key to give each question its id
//   (src/core/questions.ts).
// An answer goes in as a person types it: the arrow keys move the focus to the
// option, a look at the screen checks it is there, then Enter. Pure text and
// timing, with no DOM and no Node, so the window loads it as a global
// (RadialCliQuestion, scripts/transpile.mts DUAL) and the core imports it.

import type { ChatEngine } from './chatPermissions';

// Words and hints of the CLIs' own questions, as whole words: "design in" is no "sign in".
const QUESTION = /\b(?:trust this (?:folder|workspace)|trust the files|sign in|log in|login method|allow this|approve|run this command|permission required|enter to (?:confirm|continue|save)|press enter|enter (?:continue|select|default)|esc (?:back|quit)|esc to dismiss|press a number to choose|type to continue|press any key)\b/i;
// A numbered menu with its pointer on an option, indented: Claude Code's "❯ 2. Dark mode". Codex's start at the
// line's start ("› 1. Trust and continue"), where its input's › is too, and count by their hints (QUESTION).
const MENU = /^[ \u00a0]+[❯›>][ \u00a0]+\d+\.[ \u00a0]/m;
// Cursor Agent's approvals and mode switches: their titles, on rows of their own ("Write to this file?", "Switch to
// Agent mode?"), and its input's placeholder while an approval waits ("→ Waiting for decision (y/n/p)...").
const CURSOR_ASKS = /^[ \u00a0]*(?:(?:Run this (?:command(?: outside the sandbox)?|MCP tool)|Delete this file|Write to this file|Read this file|Proceed with this edit|Allow this web (?:search|fetch)|Switch to \S+ mode)\?[ \u00a0]*|→ Waiting for decision\b.*)$/m;
const asks = (screen: string): boolean => QUESTION.test(screen) || MENU.test(screen) || CURSOR_ASKS.test(screen);
// The input prompt, as only its CLI draws it: no text on screen (a command a question asks to run, an earlier
// prompt of the conversation, a line of the agent's) can pass for it.
// - Claude Code's input box: its ❯ at the line's start right under a rule, and a rule under it before any other row
//   that starts there (the rows that go on with its text are indented). Its rows are read without their trailing
//   spaces, so an empty box's row is the ❯ alone.
// - "? for shortcuts", the hint under Claude Code's and Codex's empty input: on one of the screen's last two rows.
// - Codex's footer under its input, draft or not: its model and then its folder after a dot ("GPT-6.1-Sol default
//   · /work/site"), on the screen's last row or the one above the hint.
// - Cursor Agent's → before its placeholder, two columns in at most. Only an empty input's placeholder counts: the
//   row stays on screen, with another placeholder, while Cursor Agent asks.
const CLAUDE_RULE = /^[─━]{3,}$/;
const CLAUDE_INPUT = /^❯(?:[ \u00a0]|$)/;
const CURSOR_PLACEHOLDER = /^[ \u00a0]{0,2}→ (?:Plan, search, build anything|Add a follow-up)/m;
const CODEX_FOOTER = /^ {2}\S.* · (?:~|\/|…)/;
function claudeInputBox(rows: string[]): boolean {
  for (let i = rows.length - 1; i > 0; i--) {
    if (!CLAUDE_INPUT.test(rows[i]) || !CLAUDE_RULE.test(rows[i - 1])) continue;
    for (let j = i + 1; j < rows.length; j++) {
      if (CLAUDE_RULE.test(rows[j])) return true;
      if (/^\S/.test(rows[j])) break;
    }
  }
  return false;
}
function atPrompt(screen: string): boolean {
  const rows = screen.split('\n').map((l) => l.replace(/[ \u00a0]+$/, ''));
  const filled = rows.filter(Boolean);
  const last = filled[filled.length - 1] || '';
  if (/\? for shortcuts/.test(filled.slice(-2).join('\n')) || CURSOR_PLACEHOLDER.test(screen) || claudeInputBox(rows)) return true;
  return CODEX_FOOTER.test(/\bfor (?:shortcuts|agents)\b/.test(last) ? filled[filled.length - 2] || '' : last);
}

/** screen: the rows the CLI shows now, joined with newlines. */
function asksOwnQuestion(screen: string): boolean {
  return asks(screen) && !atPrompt(screen);
}
// The mark of a CLI's input where it draws it: Claude Code's ❯ and Codex's › at the line's start, Cursor Agent's →
// two columns in at most. A dialog's pointer is indented (Claude Code's " ❯ 1. Yes", a Cursor Agent list's "   → ").
const INPUT_MARK = /^(?:[❯›]|[ \u00a0]{0,2}→)(?:[ \u00a0]+|$)/;
/**
 * The screen without the CLI's input, when it shows text Radial typed into it:
 * those words are the text's, not a question's. Its input is the lowest row with
 * an input's mark, with the rows under it that go on indented with the text; its
 * words must all be the text's, and nothing under it may ask anything (a menu's
 * pointer row has its other options and its hint under it). Any other row stays,
 * whatever its words: a question's own rows are never left out.
 */
function withoutTyped(screen: string, typed: string): string {
  const flat = typed.replace(/\s+/g, '');
  if (!flat) return screen;
  const rows = screen.split('\n');
  const words = (row: string): string => row.replace(/\s+/g, '');
  let at = rows.length - 1;
  while (at >= 0 && !INPUT_MARK.test(rows[at])) at--;
  if (at < 0) return screen;
  let shown = words(rows[at].replace(INPUT_MARK, '')), end = at + 1;
  while (end < rows.length && /^[ \u00a0]+\S/.test(rows[end]) && flat.includes(shown + words(rows[end]))) shown += words(rows[end++]);
  const under = rows.slice(end).join('\n');
  if (shown.length < 4 || !flat.includes(shown) || asks(under)) return screen;
  return [...rows.slice(0, at), ...rows.slice(end)].join('\n');
}
/** asksOwnQuestion, after Radial typed text into the CLI's input: that input left out (withoutTyped). */
function asksAfterTyping(screen: string, typed: string): boolean {
  return asksOwnQuestion(withoutTyped(screen, typed));
}

/** One of a question's options, as its screen lists it. */
export interface QuestionOption {
  /** Its number as shown ("2. Dark mode"), or its place in the list when the CLI shows none. */
  number: number;
  /** Its words as shown, without the pointer, the ✔ that marks the current setting, or a description beside them. */
  label: string;
  /** What it says more: a description beside its words (two spaces or more away), and the lines under it. */
  detail?: string;
}
/** What answers a question: one of its options, a line of text typed into its field, or Enter alone. */
export type QuestionTakes = 'option' | 'text' | 'enter';
/** A CLI's own question, as its screen shows it. */
export interface CliQuestion {
  /** Its words, options and what answers it, with whitespace run together but for indents: the same at any width, and wherever the focus is. */
  key: string;
  /** Its words: every row above its options (or its field), as shown, less the indent they all share. */
  text: string;
  /** Its options in order; none when it takes text or Enter alone. */
  options: QuestionOption[];
  /** The number of the option with the focus; null without options. */
  focused: number | null;
  /** What answers it; null for a question Radial won't answer: its menu can't be read, or Radial can't show it whole. */
  takes: QuestionTakes | null;
  /** Lines of its words that aren't on the screen (at least this many): above it, or clipped by its CLI. */
  hidden?: number;
  /** Radial can't see where its dialog begins: no frame of its CLI's on the screen or just above it. */
  unframed?: true;
  /** Its menu scrolls: there are options above or below the ones in view. */
  scrolls?: 'above' | 'below' | 'both';
}
/** A question as the core shows it: its id (one occurrence of its key) in place of the key. */
export type ShownQuestion = Omit<CliQuestion, 'key'> & { id: string };

// A line with a menu's pointer: " ❯ No, exit", "› 1. Trust and continue", "> 1. Sign in with ChatGPT".
const POINTER = /^([ \u00a0]*)([❯›>])([ \u00a0]+)(\S.*)$/;
// A numbered option, with the pointer on it or not: "   3. Light mode", " ❯ 2. Dark mode ✔".
const NUMBERED = /^[ \u00a0]*(?:[❯›>][ \u00a0]+)?(\d{1,2})\.[ \u00a0]+(\S.*)$/;
// Enter alone: Claude Code's security notes, Cursor Agent's log in.
const ENTER_ONLY = /press (?:enter|return) to continue|press any key/i;
// A field for a line of text: Codex's "Paste or type your API key below … Press enter to save".
const TEXT_FIELD = /\bpaste\b.*\b(?:here|below)\b|enter to save/i;
// A menu's own hint that more options are out of view, on the row beside its first or last option.
const MORE = /^[ \u00a0]*(?:[↑↓▲▼⌃⌄]|…?[ \u00a0]*\d+ more\b|more (?:above|below)\b)/i;
/** The most text an answer types: an API key, a code, a name. */
const TEXT_MAX = 4000;
// What text an answer types never holds: control characters (C0, DEL, C1), line and paragraph separators, the marks
// that reorder text (bidi), and invisible ones (zero-width, word joiners, a BOM, tags), any of which could end its
// paste, press keys of their own, or make it read as other words than it is.
const UNTYPABLE = /[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/u;

const indentOf = (line: string): number => line.length - line.replace(/^[ \u00a0]+/, '').length;
// A row inside a box ("│ ❯ 1. Yes │"), read without the box's sides.
const unbox = (line: string): string => { const m = /^[ \u00a0]*[│┃](.*?)[│┃]?[ \u00a0]*$/.exec(line); return m ? m[1] : line; };
const boxed = (line: string | undefined): boolean => /^[ \u00a0]*[│┃]/.test(line || '');
const boxTop = (line: string | undefined): boolean => /^[ \u00a0]*[╭┌]/.test(line || '');

// Where each CLI's dialogs begin, as it draws them (frameOf). Claude Code: a rule across the whole screen from its
// first column, over every dialog (its content is indented under it), and its logo over its first-run screens: the
// "Welcome to Claude Code" row, then rows of art. Codex: its dialogs' titles, two columns in, and the mark it puts at
// the top of one it clipped. Cursor Agent: its name over its log in screen.
const CLAUDE_LOGO = /^Welcome to Claude Code\b/;
const LOGO_ART = /^[\u2580-\u259f\u2800-\u28ff.*·•°˚✦✧✶✳'`+ \u00a0]*$/;
const CODEX_TITLE = /^ {2}(?:Would you like to (?:run the following command|make the following edits|grant these permissions|send input to the existing terminal)\?|Approve app tool call\?|Enable full access\?|Stop this attempt and retry\?|Folder access|Select (?:Model and Effort|Model|Reasoning Level for \S.*|Syntax Theme|Environment|Pet)|Update Model Permissions|Welcome to Codex, OpenAI's command-line coding agent)$/;
const CODEX_CLIPPED = /^[ \u00a0]*(?:…|\.{3})?[ \u00a0]*(\d+) earlier lines? hidden$/;
const CURSOR_TITLE = /^[ \u00a0]+Cursor Agent$/;
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
// An option's words, without the ✔ by the current setting; a description two spaces or more away goes to its detail.
function splitLabel(words: string): { label: string; beside: string | null } {
  const [label, ...rest] = words.replace(/[ \u00a0]+[✔✓]$/, '').trim().split(/[ \u00a0]{2,}/);
  return { label: label.replace(/[ \u00a0]+[✔✓]$/, ''), beside: rest.length ? rest.join(' ') : null };
}
function optionOf(number: number, words: string, below: string[]): QuestionOption {
  const { label, beside } = splitLabel(words);
  const detail = [beside, ...below].filter(Boolean).join(' ');
  return { number, label, ...(detail ? { detail } : {}) };
}

/** A menu read from the screen: its options, the focused one's number, the rows of its first option and its last line, and whether it scrolls. */
interface Menu { options: QuestionOption[]; focused: number; top: number; end: number; scrolls?: CliQuestion['scrolls'] }

// A numbered menu around the pointer's row: options numbered in order with their
// numbers in one column, a line indented under one saying more about it, and at
// most one blank row between them. One option alone is no choice, and no menu.
function numberedMenu(lines: string[], at: number, first: number): Menu | null {
  const col = lines[at].search(/\d/);
  const optionAt = (i: number, want: number): boolean => { const m = NUMBERED.exec(lines[i]); return !!m && Number(m[1]) === want && Math.abs(lines[i].search(/\d/) - col) <= 1; };
  const detailAt = (i: number): boolean => indentOf(lines[i]) > col && !NUMBERED.test(lines[i]) && !POINTER.test(lines[i]);
  const rows = [at];
  for (let i = at - 1, want = first - 1, blank = 0; i >= 0 && want >= 1; i--) {
    if (!lines[i].trim()) { if (++blank > 1) break; continue; }
    blank = 0;
    if (optionAt(i, want)) { rows.unshift(i); want--; } else if (!detailAt(i)) break;
  }
  let end = at;
  for (let i = at + 1, want = first + 1, blank = 0; i < lines.length; i++) {
    if (!lines[i].trim()) { if (++blank > 1) break; continue; }
    blank = 0;
    if (optionAt(i, want)) { rows.push(i); want++; end = i; } else if (detailAt(i)) end = i; else break;
  }
  if (rows.length < 2) return null;
  const options = rows.map((row, k) => {
    const m = NUMBERED.exec(lines[row])!; // each row was read as an option above
    return optionOf(Number(m[1]), m[2], lines.slice(row + 1, k + 1 < rows.length ? rows[k + 1] : end + 1).map((l) => l.trim()).filter(Boolean));
  });
  const above = options[0].number > 1 || MORE.test(lines[rows[0] - 1] || '');
  const below = [1, 2].some((d) => MORE.test(lines[end + d] || ''));
  return { options, focused: first, top: rows[0], end, ...(above || below ? { scrolls: above && below ? 'both' : above ? 'above' : 'below' } : {}) };
}

// Claude Code's plain menu around the pointer's row: the options are the rows
// right above and below it whose words start where the pointer's do.
function plainMenu(lines: string[], at: number, col: number, words: string): Menu | null {
  const optionAt = (i: number): boolean => !!lines[i].trim() && indentOf(lines[i]) === col && !POINTER.test(lines[i]);
  let top = at, bottom = at;
  while (top > 0 && optionAt(top - 1)) top--;
  while (bottom + 1 < lines.length && optionAt(bottom + 1)) bottom++;
  if (top === bottom) return null; // a lone row under a pointer is no menu
  const options: QuestionOption[] = [];
  for (let i = top; i <= bottom; i++) options.push(optionOf(i - top + 1, i === at ? words : lines[i], []));
  return { options, focused: at - top + 1, top, end: bottom };
}

// The menu at the bottom of the screen, read from the lowest pointer only: a
// pointer that is on no menu Radial can read leaves the question unanswered,
// never a list higher up the screen. A pointer at the line's start is Codex's,
// whose input marker it shares: its menus have their hint under them ("Press
// enter to continue", "enter select · esc back"), and a draft in its input none.
// A '>' on words (Codex's "> Use your own OpenAI API key") is a title, not a pointer.
function readMenu(lines: string[]): Menu | 'unreadable' | null {
  let i = lines.length - 1;
  while (i >= 0 && !POINTER.test(lines[i])) i--;
  if (i < 0) return null;
  const p = POINTER.exec(lines[i])!; // the loop stopped on a pointer
  const n = NUMBERED.exec(lines[i]);
  if (!n && p[2] === '>') return null;
  const menu = n ? numberedMenu(lines, i, Number(n[1]))
    : p[1].length ? plainMenu(lines, i, p[1].length + p[2].length + p[3].length, p[4]) // indented: Claude Code's; at the line's start, ❯ is its input
    : null;
  return menu && (p[1].length || lines.slice(menu.end + 1).some((l) => QUESTION.test(l))) ? menu : 'unreadable';
}

/** How a screen is read: the rows just above it (its scrollback, oldest first), the CLI drawing it, and its width. */
export interface QuestionView {
  /** The rows just above the screen, where a dialog taller than it begins; none for a full-screen CLI. */
  above?: readonly string[];
  /** The CLI on screen, whose dialogs' frames count; null for any of them. */
  engine?: ChatEngine | null;
  /** The screen's width, for Claude Code's rule across all of it. */
  cols?: number | null;
}
type Frame = { kind: 'rule' | 'box' | 'logo' | 'title' } | { kind: 'clipped'; clipped: number };
// Whether a row (as the screen shows it, box sides and all) is where one of the CLI's dialogs begins. inBox: the
// question's menu is drawn in a box, whose top is its frame. over: the row above it, when there is one. A title has
// a blank row above it, or none: a command that wraps back two columns in with a title's words is a line of it.
function frameOf(row: string | undefined, over: string | undefined, view: QuestionView, inBox: boolean): Frame | null {
  const r = (row || '').replace(/[ \u00a0]+$/, '');
  const by = (engine: ChatEngine): boolean => !view.engine || view.engine === engine;
  const clear = !over || !unbox(over).trim();
  if (by('claude') && CLAUDE_RULE.test(r) && (!view.cols || r.length >= view.cols - 1)) return { kind: 'rule' };
  if (by('claude') && CLAUDE_LOGO.test(r)) return { kind: 'logo' };
  if (inBox && boxTop(r)) return { kind: 'box' };
  if (by('codex') && clear && CODEX_TITLE.test(r)) return { kind: 'title' };
  const clipped = by('codex') ? CODEX_CLIPPED.exec(r) : null;
  if (clipped) return { kind: 'clipped', clipped: Number(clipped[1]) };
  if (by('cursor') && clear && CURSOR_TITLE.test(r)) return { kind: 'title' };
  return null;
}
// The first row of a question's words under its frame at row `at`: the title itself (a line of them), else the row
// under the frame, or under the logo's art.
function wordsFrom(rows: readonly string[], at: number, frame: Frame): number {
  if (frame.kind === 'title') return at;
  let i = at + 1;
  if (frame.kind === 'logo') while (i < rows.length && LOGO_ART.test(rows[i])) i++;
  return i;
}

// Where a question's words begin above row `end`, and how many of them aren't on the screen: from its frame on the
// screen, else from its frame in the rows just above it (those rows are hidden words), else from nowhere Radial can
// see (unframed: the rows above it, if any, are hidden words too).
function wordsSpan(raw: string[], end: number, view: QuestionView): { start: number; hidden: number; unframed: boolean } {
  const inBox = boxed(raw[end]);
  const above = view.above || [];
  for (let i = end - 1; i >= 0; i--) {
    const frame = frameOf(raw[i], i ? raw[i - 1] : above[above.length - 1], view, inBox);
    if (frame) return { start: wordsFrom(raw, i, frame), hidden: frame.kind === 'clipped' ? frame.clipped : 0, unframed: false };
  }
  for (let i = above.length - 1; i >= 0; i--) {
    const frame = frameOf(above[i], above[i - 1], view, inBox);
    if (!frame) continue;
    const from = wordsFrom(above, i, frame);
    const hidden = above.slice(from).filter((l) => unbox(l).trim()).length + (frame.kind === 'clipped' ? frame.clipped : 0);
    // A logo whose art runs on onto the screen: that art is no part of the words either.
    let start = 0;
    if (frame.kind === 'logo' && from === above.length) while (start < end && LOGO_ART.test(raw[start])) start++;
    return { start, hidden, unframed: false };
  }
  return { start: 0, hidden: above.filter((l) => unbox(l).trim()).length, unframed: true };
}

// A question's rows from start to end, blank ones left out: each one's words and their indent.
function rowsOf(lines: string[], start: number, end: number): { indent: number; words: string }[] {
  return lines.slice(start, end).filter((l) => l.trim()).map((l) => ({ indent: indentOf(l), words: l.trim() }));
}
// Its words as shown, every character of each row (a command's > too), indented as on screen less the indent all share.
function wordsOf(rows: { indent: number; words: string }[]): string {
  const least = Math.min(...rows.map((r) => r.indent));
  return rows.map((r) => ' '.repeat(r.indent - least) + r.words).join('\n');
}
// Its key: each row's whitespace run together, rows joined by a space where the indent holds and by how far it moves
// where it doesn't. A paragraph wrapped at another width reads the same; two commands whose blocks are indented
// differently (Python's) don't. Its options' words and what they say more, run together too.
function keyOf(takes: QuestionTakes | null, rows: { indent: number; words: string }[], options: QuestionOption[]): string {
  const words = rows.map((r, i) => (!i ? '' : r.indent === rows[i - 1].indent ? ' ' : `\n${r.indent - rows[i - 1].indent}\n`) + collapse(r.words)).join('');
  return JSON.stringify([takes, words, options.map((o) => [o.number, collapse(`${o.label} ${o.detail || ''}`)])]);
}

// A text field's row that shows what is typed into it after its mark: Claude Code's "Paste code here if prompted > …".
const FIELD_MARK = /^(.*?\b(?:paste|type|enter)\b[^>]*>)(?:[ \u00a0]|$)/i;

/**
 * The question a CLI's screen asks of its own, or null when it shows anything
 * else (its prompt, its work). view: the rows just above the screen (the
 * terminal's scrollback, oldest first), where a dialog taller than the screen
 * begins, none for a full-screen CLI; the CLI drawing it, whose own frames
 * bound its words; and the screen's width.
 */
function readQuestion(screen: string, view: QuestionView = {}): CliQuestion | null {
  if (!asksOwnQuestion(screen)) return null;
  const raw = screen.split('\n');
  const lines = raw.map(unbox);
  const menu = readMenu(lines);
  let last = lines.length - 1;
  while (last > 0 && !lines[last].trim()) last--;
  let takes: QuestionTakes | null, end: number, field: number | null = null;
  if (menu && menu !== 'unreadable') { takes = 'option'; end = menu.top; }
  else {
    takes = menu === 'unreadable' ? null : ENTER_ONLY.test(screen) ? 'enter' : TEXT_FIELD.test(screen) ? 'text' : null;
    end = last + 1;
    if (takes === 'text') {
      // Its field: a box (Codex's API key), whose words are above it; or a row that shows what is typed into it after
      // its mark, whose words end at the mark. What is typed is no part of the question.
      let i = last;
      while (i >= 0 && !boxTop(raw[i])) i--;
      if (i >= 0) end = i;
      else {
        for (i = last; i >= 0 && !TEXT_FIELD.test(lines[i]); i--);
        const mark = i >= 0 ? FIELD_MARK.exec(lines[i]) : null;
        if (mark) { end = i + 1; field = mark[1].length; }
      }
    }
  }
  const { start, hidden, unframed } = wordsSpan(raw, end, view);
  if (hidden || unframed) takes = null;
  const shown = field == null ? lines : lines.map((l, i) => (i === end - 1 ? l.slice(0, field!) : l));
  const rows = rowsOf(shown, start, end);
  const options = menu && menu !== 'unreadable' ? menu.options : [];
  const q: CliQuestion = { key: keyOf(takes, rows, options), text: rows.length ? wordsOf(rows) : '', options, focused: menu && menu !== 'unreadable' ? menu.focused : null, takes };
  if (hidden) q.hidden = hidden;
  if (unframed) q.unframed = true;
  if (menu && menu !== 'unreadable' && menu.scrolls) q.scrolls = menu.scrolls;
  return q;
}

/** A question's options as lines: each as listed, the focused one marked, and what an option says more under it. */
function listOptions(q: Pick<CliQuestion, 'options' | 'focused'>, indent = '  '): string {
  return q.options.map((o) => `${indent}${o.number}. ${o.label}${o.number === q.focused ? ' (focused)' : ''}${o.detail ? `\n${indent}   ${o.detail}` : ''}`).join('\n');
}
/** A question as lines: what of it isn't on the screen, its words, its options, and whether its menu scrolls. */
function describeQuestion(q: Pick<CliQuestion, 'text' | 'options' | 'focused' | 'hidden' | 'unframed' | 'scrolls'>, indent = '  '): string {
  return [
    ...(q.hidden ? [`${indent}(${q.hidden === 1 ? 'a line' : `${q.hidden} lines`} of it not on the screen, not shown)`] : q.unframed ? [`${indent}(where it begins isn't on the screen)`] : []),
    ...(q.text ? q.text.split('\n').map((l) => indent + l) : []),
    ...(q.options.length ? [listOptions(q, indent)] : []),
    ...(q.scrolls ? [`${indent}(its menu scrolls: more options are ${q.scrolls === 'both' ? 'above and below' : q.scrolls} these, out of view)`] : []),
  ].join('\n');
}

/** What an answer gives: an option (its number or its label), a line of text, or neither (Enter alone). */
export interface AnswerRequest { answer: string | null; text: string | null }
/** How an answer fits a question: the option it picks or the text it types, or why it doesn't fit, in the protocol's terms. */
export type AnswerPlan =
  | { ok: true; option: QuestionOption | null; text: string | null }
  | { ok: false; code: 'bad-request' | 'ambiguous' | 'error'; error: string };

const norm = (s: string): string => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
// The options an answer names: its number as listed ("2", "2."), its label in any case, or both ("2. Dark mode").
function optionsNamed(q: CliQuestion, answer: string): QuestionOption[] {
  const a = answer.trim();
  const m = /^(\d{1,3})\.?(?:[ \u00a0]+(\S.*))?$/.exec(a);
  if (m) {
    const byNumber = q.options.filter((o) => o.number === Number(m[1]) && (m[2] === undefined || norm(o.label) === norm(m[2])));
    if (byNumber.length) return byNumber;
  }
  return q.options.filter((o) => norm(o.label) === norm(a));
}

/** Whether an answer fits a question, and what it types: an option for a menu, text for a field, neither for Enter alone. id names the session in the refusals. */
function planAnswer(q: CliQuestion, { answer, text }: AnswerRequest, id: string): AnswerPlan {
  const refuse = (error: string, code: 'bad-request' | 'ambiguous' | 'error' = 'bad-request'): AnswerPlan => ({ ok: false, code, error });
  if (q.hidden) return refuse(`${q.hidden === 1 ? 'A line' : `${q.hidden} lines`} of ${id}'s question ${q.hidden === 1 ? 'isn\'t' : 'aren\'t'} on its screen, so Radial won't answer what it can't show whole. Answer it in its terminal, which shows more of it when it is taller.`, 'error');
  if (q.unframed) return refuse(`Radial can't see where ${id}'s question begins, so it won't answer what it can't show whole. Answer it in its terminal; \`radial agent output ${id}\` shows its screen.`, 'error');
  if (q.takes === null) return refuse(`Radial can't read the options of ${id}'s question, so it won't answer it. Answer it in its terminal; \`radial agent output ${id}\` shows it.`, 'error');
  if (q.takes === 'option') {
    const range = q.scrolls ? ` Its menu scrolls, and Radial answers only the options in view (${q.options[0].number} to ${q.options[q.options.length - 1].number}); answer any other in its terminal.` : '';
    const options = `Its options:\n${listOptions(q)}\nName one by its number or its label, as listed.${range}`;
    if (text != null) return refuse(`${id}'s question takes one of its options, not text. ${options}`);
    if (answer == null) return refuse(`${id}'s question takes one of its options. ${options}`);
    const named = optionsNamed(q, answer);
    if (named.length > 1) return refuse(`"${answer}" names more than one of ${id}'s options:\n${listOptions(q)}\nName it by its number.`, 'ambiguous');
    if (!named.length) return refuse(`"${answer}" is none of the options of ${id}'s question in view. ${options}`);
    return { ok: true, option: named[0], text: null };
  }
  if (q.takes === 'text') {
    if (text == null) return refuse(`${id}'s question takes a line of text, typed into its field: pass it with --text.`);
    if (UNTYPABLE.test(text)) return refuse('--text takes one line of plain text: no line breaks, terminal control characters, invisible characters, or marks that reorder text.');
    if (text.length > TEXT_MAX) return refuse(`--text takes at most ${TEXT_MAX} characters.`);
    return { ok: true, option: null, text };
  }
  if (answer != null || text != null) return refuse(`${id}'s question asks for Enter alone, with nothing to choose or type: answer it with no option and no text.`);
  return { ok: true, option: null, text: null };
}

/** A screen's rows as text: without the spaces that end them, or the blank rows above and below. */
function tidyScreen(screen: string): string {
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, ''));
  let a = 0, z = lines.length;
  while (a < z && !lines[a]) a++;
  while (z > a && !lines[z - 1]) z--;
  return lines.slice(a, z).join('\n');
}

/** What a terminal shows: the rows on its screen, how to read them (QuestionView), and whether its program still runs. */
export interface TermScreen extends QuestionView { screen: string; alive: boolean }
/**
 * Why a host typed nothing: someone else typed into the session since the
 * answer's last key (other-input), the session takes no keys now (a chat in
 * Chat view, switching views, or delivering a message to its CLI), or the
 * answer's caller stopped waiting (late).
 */
export type TypingRefusal = 'other-input' | 'chat-view' | 'switching' | 'delivering' | 'late';
/**
 * A terminal whose CLI's own question is answered (src/core/questions.ts, over
 * the PTY daemon): what it shows, and input into it that says whether it went
 * in. An input refused (with why) stops the answer, typing nothing more.
 */
export interface QuestionTerm {
  /** The session's id, for the replies' words. */
  readonly id: string;
  /** An agent CLI runs here, not a plain shell: a shell never asks a question of its own. */
  readonly agent: boolean;
  read(): TermScreen | Promise<TermScreen>;
  /** Presses keys (an arrow, Enter): true once they went in, else why not. */
  press(keys: string): true | TypingRefusal | Promise<true | TypingRefusal>;
  /** Types text as one bracketed paste, not submitted: true once it went in, else why not. */
  paste(text: string): true | TypingRefusal | Promise<true | TypingRefusal>;
}
/** Which question an answer is for, and when it gives up. */
export interface AnswerTarget {
  /** The key of the question it is for (CliQuestion.key): it is answered only while the screen shows that question. */
  expectKey: string;
  /** When its caller stops waiting (ms since the epoch): nothing is typed after it. */
  deadline?: number | null;
}

/** How answering waits, in ms. */
export interface AnswerTiming {
  /** Between keys, at a person's pace (a CLI that gets two arrows in one chunk may read neither). */
  keyMs: number;
  /** How long the screen gets to show the focus where the arrow keys moved it. */
  focusMs: number;
  /**
   * How long what the screen reads (the question and its focus, or none) holds
   * before Radial takes it as drawn: before the first arrow, after the arrows
   * (longer for a CLI slow to take them), and after Enter. By what it reads,
   * not by quiet, as a CLI that animates something else never goes quiet.
   */
  settleMs: number;
  /** How long, after Enter, it waits for that at most (and never past the answer's deadline). */
  afterMs: number;
  /** How often it looks. */
  pollMs: number;
}
const ANSWER_TIMING: AnswerTiming = { keyMs: 120, focusMs: 5000, settleMs: 600, afterMs: 8000, pollMs: 80 };
const DOWN = '\x1b[B', UP = '\x1b[A', ENTER = '\r';

/** What became of a question once answered: gone (its CLI went on), next (another question shows), exited (the session ended). */
export type AnswerAfter = 'gone' | 'next' | 'exited';
/** A question answered: what it asked, the option chosen (null for text or Enter alone), and what the session shows after. */
export interface Answered {
  ok: true;
  question: CliQuestion;
  chose: QuestionOption | null;
  after: AnswerAfter;
  /** The question showing after, when another one does. */
  next: CliQuestion | null;
  /** The session's screen after. */
  text: string;
  /** When Enter went in, in ms since the epoch. */
  answeredAt: number;
}
/**
 * Why a question went unanswered, in the protocol's terms, with the question as
 * read, or the screen when there was none. needs-yes: the screen shows another
 * question than the one the answer is for, or the question changed while it
 * was answered: whatever shows now needs a yes of its own.
 */
export interface Unanswered { ok: false; code: 'not-asking' | 'needs-yes' | 'no-input' | 'bad-request' | 'ambiguous' | 'timeout' | 'error'; error: string; question?: CliQuestion; text?: string }

/** Why a session takes no keys now, in a refusal's words (code no-input). */
function noInput(id: string, why: 'chat-view' | 'switching' | 'delivering'): string {
  if (why === 'chat-view') return `${id} is a chat shown in Chat view, where its CLI takes no keys: switch the chat to Terminal view, then answer.`;
  if (why === 'switching') return `${id} is a chat switching between Chat and Terminal view, and its CLI takes no keys meanwhile: answer once it shows in Terminal view.`;
  return `${id} is a chat delivering a message to its CLI, and takes no other keys meanwhile: answer once the message is in.`;
}

/** The refusal for a session whose CLI isn't asking a question of its own: it says so, and shows what the screen shows. */
function notAsking(id: string, screen: string): Unanswered {
  const shown = tidyScreen(screen);
  const tail = shown.split('\n').slice(-12).map((l) => (l ? '  ' + l : l)).join('\n');
  return { ok: false, code: 'not-asking', error: `${id} isn't asking a question of its own${shown ? `. Its screen shows:\n${tail}\n` : ', and its screen is empty. '}To type into its prompt, use \`radial agent send\`.`, text: shown };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const readOf = async (t: QuestionTerm): Promise<{ shown: TermScreen; q: CliQuestion | null }> => {
  const shown = await t.read();
  return { shown, q: t.agent && shown.alive ? readQuestion(shown.screen, shown) : null };
};

/**
 * Answers the question a CLI asks of its own, as a person would at its
 * terminal: an option by the arrow keys and Enter, once the screen shows the
 * focus on it; text as one paste, then Enter; or Enter alone. Never types into
 * a CLI that isn't asking (its prompt is `agent send`'s), into another question
 * than the one it is for (target.expectKey), an answer that doesn't fit, or
 * after its deadline; never presses an arrow twice, or Enter with the focus
 * anywhere but on the option asked for. Then it waits for the CLI to draw what
 * comes next, and says what that is: the question gone, the next one, or the
 * session ended. The same question still showing after Enter is no answer.
 */
async function answerQuestion(t: QuestionTerm, request: AnswerRequest, target: AnswerTarget, timing: AnswerTiming = ANSWER_TIMING): Promise<Answered | Unanswered> {
  const changed = (q: CliQuestion, when: string): Unanswered => ({ ok: false, code: 'needs-yes', error: `${t.id}'s question changed ${when}, so Radial pressed nothing more.`, question: q });
  const tooSlow = (q: CliQuestion): Unanswered => ({ ok: false, code: 'timeout', error: `Answering ${t.id}'s question took longer than its caller waits, so Radial stopped before Enter.`, question: q });
  const late = (q: CliQuestion): Unanswered | null => (target.deadline != null && Date.now() > target.deadline ? tooSlow(q) : null);
  const refused = (q: CliQuestion, why: TypingRefusal): Unanswered => why === 'other-input' ? changed(q, 'while Radial answered it: something else typed into the session')
    : why === 'late' ? tooSlow(q)
    : { ok: false, code: 'no-input', error: noInput(t.id, why), question: q };

  const first = await readOf(t);
  if (!first.shown.alive) return { ok: false, code: 'error', error: `${t.id} has ended.` };
  const question = first.q;
  if (!question) return notAsking(t.id, first.shown.screen);
  if (question.key !== target.expectKey) return { ok: false, code: 'needs-yes', error: `${t.id}'s CLI asks another question than the one this answer is for.`, question };
  const plan = planAnswer(question, request, t.id);
  if (!plan.ok) return { ...plan, question };

  // Arrows to the option: one at a time, each once. First the question holds still a moment (a CLI still drawing can
  // drop a key: Codex, asking the terminal about itself right after it draws). Then a look until the focus is on the
  // option and has held there, twice as long as the CLI took to move it at all, so an arrow still on its way shows
  // before Enter goes in. A focus that doesn't get there within focusMs gets no more keys.
  if (plan.option) {
    const index = (n: number | null): number => question.options.findIndex((o) => o.number === n);
    const steps = index(plan.option.number) - index(question.focused);
    let now = question;
    if (steps) {
      for (let since = Date.now(), began = since; Date.now() - since < timing.settleMs;) {
        if (Date.now() - began > timing.focusMs) return changed(now, 'while Radial waited for it to hold still');
        await sleep(timing.pollMs);
        const seen = (await readOf(t)).q;
        if (!seen || seen.key !== question.key) return changed(seen || question, 'before Radial moved the focus');
        if (seen.focused !== now.focused) since = Date.now();
        now = seen;
      }
      if (now.focused !== question.focused) return changed(now, 'before Radial moved the focus');
      for (let i = 0; i < Math.abs(steps); i++) {
        if (i) await sleep(timing.keyMs);
        const tooLate = late(question); if (tooLate) return tooLate;
        const put = await t.press(steps > 0 ? DOWN : UP);
        if (put !== true) return refused(question, put);
      }
      const pressedAt = Date.now();
      let moved = 0, since = pressedAt;
      for (;;) {
        await sleep(timing.pollMs);
        const seen = (await readOf(t)).q;
        if (!seen || seen.key !== question.key) return changed(seen || question, `while Radial moved the focus to "${plan.option.label}"`);
        if (seen.focused !== now.focused) { since = Date.now(); moved ||= since; }
        now = seen;
        const there = now.focused === plan.option.number && !!moved;
        if (there && Date.now() - since >= Math.max(timing.settleMs, 2 * (moved - pressedAt))) break;
        if (!there && Date.now() - pressedAt > timing.focusMs) return { ok: false, code: 'error', error: `Radial pressed the arrow keys once, but the focus of ${t.id}'s question is on "${now.options.find((o) => o.number === now.focused)?.label}", not "${plan.option.label}", so it pressed nothing more. An arrow its CLI takes late can still move the focus: \`radial agent question ${t.id}\` reads it again, or answer it in its terminal.`, question };
        const tooLate = late(question); if (tooLate) return tooLate;
      }
    }
  } else if (plan.text != null) {
    const tooLate = late(question); if (tooLate) return tooLate;
    const put = await t.paste(plan.text);
    if (put !== true) return refused(question, put);
  }
  await sleep(timing.keyMs); // a beat before Enter, as a person takes: a TUI that gets a paste and its Enter in one chunk can drop the text
  // A last look: the same question, the focus still on the option (a person at the terminal may have answered meanwhile).
  const still = (await readOf(t)).q;
  if (!still || still.key !== question.key || (plan.option && still.focused !== plan.option.number)) return changed(still || question, 'before Radial pressed Enter');
  const tooLate = late(question); if (tooLate) return tooLate;
  const answeredAt = Date.now();
  const entered = await t.press(ENTER);
  if (entered !== true) return refused(question, entered);
  // What the CLI draws next: once what the screen reads is no longer the question as answered and has held a moment,
  // or once afterMs has gone by, or the answer's deadline: its caller hears back while it still waits.
  const asAnswered = `${question.key}#${plan.option ? plan.option.number : ''}`;
  let reads = asAnswered, since = answeredAt, after = first;
  for (;;) {
    await sleep(timing.pollMs);
    after = await readOf(t);
    if (!after.shown.alive) return { ok: true, question, chose: plan.option, after: 'exited', next: null, text: tidyScreen(after.shown.screen), answeredAt };
    const r = after.q ? `${after.q.key}#${after.q.focused ?? ''}` : '';
    if (r !== reads) { reads = r; since = Date.now(); }
    if ((reads !== asAnswered && Date.now() - since >= timing.settleMs) || Date.now() - answeredAt >= timing.afterMs || (target.deadline != null && Date.now() >= target.deadline)) break;
  }
  const next = after.q;
  if (next && next.key === question.key) {
    return { ok: false, code: 'error', error: `Radial ${plan.option ? `chose "${plan.option.label}" and ` : ''}pressed Enter, but ${t.id}'s question still shows: its CLI hasn't taken the answer, at least not yet. \`radial agent question ${t.id}\` reads it again.`, question: next, text: tidyScreen(after.shown.screen) };
  }
  return { ok: true, question, chose: plan.option, after: next ? 'next' : 'gone', next, text: tidyScreen(after.shown.screen), answeredAt };
}

export { asksOwnQuestion, asksAfterTyping, withoutTyped, readQuestion, listOptions, describeQuestion, planAnswer, answerQuestion, notAsking, noInput, tidyScreen, ANSWER_TIMING, TEXT_MAX };
