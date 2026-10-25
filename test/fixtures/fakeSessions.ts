// Sessions with a fake CLI in each, answered through the core's questions
// (src/core/questions.ts): a CLI shows its screen, takes each input a moment
// after it is written (an arrow moves its focus, a paste goes into its field,
// Enter answers), and then draws what comes next. Every input counts, as
// terminal.write counts it. The questions' own tests use these, and so do the
// CLI's, the socket's and MCP's over them.
import { createQuestions } from '../../src/core/questions';
import { rule } from './cliScreens';
import type { InputBlock, SessionIo } from '../../src/core/questions';
import type { AnswerTiming } from '../../src/shared/cliQuestion';
import type { PtyEngine } from '../../src/main/terminal';

/** Answering at test speed. */
export const FAST: AnswerTiming = { keyMs: 5, focusMs: 300, settleMs: 30, afterMs: 400, pollMs: 5 };
export const DOWN = '\x1b[B', UP = '\x1b[A';

/** A question a fake CLI asks: drawn with the focus on an option (by its index) and the text typed so far. */
export interface FakeAsk {
  draw(focus: number, typed: string): string[];
  /** How many options its arrows move between; none for a field or Enter alone. */
  count?: number;
  /** Where its focus starts. */
  focus?: number;
  /** What it shows after Enter, by the focus and the text typed: another question, a screen, or the session ending. */
  then?(focus: number, typed: string): FakeAsk | string[] | 'exit';
}
export interface FakeSession {
  engine: PtyEngine | null;
  alive: boolean;
  /** What it shows while it asks nothing. */
  lines: string[];
  ask: FakeAsk | null;
  focus: number;
  typed: string;
  /** Everything written to it, in order. */
  writes: string[];
  /** Why it takes no keys now: a chat shown in Chat view, switching views, or delivering a message to its CLI. */
  blocked?: InputBlock;
}

/** Claude Code at its prompt. */
export const promptLines = [rule, '❯ ', rule, '  ? for shortcuts'];
/** Claude Code's trust question, as the stand-in CLI draws it. */
export const trustAsk = (then?: FakeAsk['then']): FakeAsk => ({
  count: 2,
  draw: (f) => [rule, ' Accessing workspace:', ' /work/site', '', (f === 0 ? ' ❯ ' : '   ') + 'No, exit', (f === 1 ? ' ❯ ' : '   ') + 'Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel'],
  then,
});
/** Claude Code's permission prompt for a command. */
export const commandAsk = (cmd: string, then?: FakeAsk['then']): FakeAsk => ({
  count: 3,
  draw: (f) => [rule, ' Bash command', '', `   ${cmd}`, '   Install the tool', '', ' Do you want to proceed?', ...['Yes', `Yes, and don't ask again for ${cmd.split(' ')[0]} commands in /work/site`, 'No, and tell Claude what to do differently (esc)'].map((l, i) => `${i === f ? ' ❯ ' : '   '}${i + 1}. ${l}`), ''],
  then,
});
/** Codex's API key field, which shows what was typed into it. */
export const apiKeyAsk = (then?: FakeAsk['then']): FakeAsk => ({
  draw: (_f, typed) => ["  Welcome to Codex, OpenAI's command-line coding agent", '> Use your own OpenAI API key for usage-based billing', '  Paste or type your API key below.', '╭API key' + '─'.repeat(40) + '╮', '│' + (typed || 'Paste or type your API key').padEnd(47) + '│', '╰' + '─'.repeat(47) + '╯', '  Press enter to save', '  Press esc to go back'],
  then,
});

/** Fake sessions, and the questions of a host that has them. lag: how long each CLI takes to take an input. */
export function fakeSessions(timing: AnswerTiming = FAST, lag = 10) {
  const sessions = new Map<string, FakeSession>();
  const inputs = new Map<string, number>();
  const shown = (s: FakeSession): string[] => (s.ask && s.alive ? s.ask.draw(s.focus, s.typed) : s.lines);
  const show = (s: FakeSession, next: FakeAsk | string[] | 'exit'): void => {
    s.typed = '';
    if (next === 'exit') { s.alive = false; s.ask = null; return; }
    if (Array.isArray(next)) { s.ask = null; s.lines = next; return; }
    s.ask = next; s.focus = next.focus || 0;
  };
  const io: SessionIo = {
    async read(id) { const s = sessions.get(id); return s ? { screen: shown(s).join('\n'), above: [], cols: null, alive: s.alive, engine: s.engine } : null; },
    inputs: (id) => inputs.get(id) || 0,
    write(id, data) {
      const s = sessions.get(id);
      if (!s) return;
      inputs.set(id, (inputs.get(id) || 0) + 1);
      s.writes.push(data);
      setTimeout(() => {
        const ask = s.ask;
        if (!ask || !s.alive) return;
        if (data === DOWN || data === UP) { s.focus = Math.max(0, Math.min((ask.count || 1) - 1, s.focus + (data === DOWN ? 1 : -1))); return; }
        const paste = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data);
        if (paste) { s.typed += paste[1]; return; }
        if (data === '\r') { show(s, ask.then ? ask.then(s.focus, s.typed) : promptLines); return; }
        s.typed += data;
      }, lag);
    },
    blocked: (id) => sessions.get(id)?.blocked ?? null,
  };
  return {
    questions: createQuestions(io, timing),
    sessions,
    /** A session with a fake CLI: asking ask, else showing lines. */
    add(id: string, init: Partial<FakeSession> = {}): FakeSession {
      const s: FakeSession = { engine: 'claude', alive: true, lines: promptLines, ask: null, focus: 0, typed: '', writes: [], ...init };
      if (init.ask && init.focus == null) s.focus = init.ask.focus || 0;
      sessions.set(id, s);
      return s;
    },
    /** Someone else typing into a session: the person at its terminal, or a send. */
    type(id: string, data: string): void { io.write(id, data); },
  };
}
