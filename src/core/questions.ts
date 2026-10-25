/**
 * The questions agent CLIs ask of their own in Radial's sessions (trust this
 * folder, sign in, approve a command), for `radial agent question` and `agent
 * answer` in both hosts: a session is read from the PTY daemon's scrollback,
 * rendered as `agent output` renders it, and typed into through this process
 * (terminal.write), never through the window, so the two verbs read a question
 * the same way, and an answer never takes the window's keyboard focus.
 * - A question's id names one occurrence of it: a fingerprint of its words and
 *   options (cliQuestion.ts key), the session, and which occurrence it is,
 *   counted here. One that anyone typed into since it was read (the person at
 *   the terminal, an answer), or that left the screen and came back, is another
 *   occurrence with another id: a yes for one never fits the next, however alike.
 * - An answer needs the yes and the id of the question it is for (expect), and
 *   goes in only while that occurrence shows.
 * - Answers to one session go in one at a time. Each key goes in only while no
 *   other input has reached the session since the answer's last (the person
 *   typing, a send), and while the session takes keys (a chat in Chat view,
 *   switching views or delivering a message takes none); a key refused stops the
 *   answer, with nothing more typed. Nothing is typed after the answer's
 *   deadline, when its caller has stopped waiting.
 * - Text an answer types (an API key, say) is typed as given, kept nowhere, and
 *   never in a reply: where a reply's message, screen or question shows it, it
 *   says [the text you gave]. A reply leaves out the screen while a question
 *   that takes text shows: its field can show what anyone typed into it.
 * The window's sends ask here too (sessionAsking) before they type into a CLI,
 * as its own terminal may not have drawn the screen yet.
 */
import { createHash, randomBytes } from 'crypto';
import * as terminal from '../main/terminal';
import * as ttyText from '../main/ttyText';
import * as engine from '../main/engine';
import { answerQuestion, asksAfterTyping, asksOwnQuestion, describeQuestion, noInput, notAsking, planAnswer, readQuestion, tidyScreen, ANSWER_TIMING } from '../shared/cliQuestion';
import type { AnswerTiming, CliQuestion, QuestionOption, QuestionTerm, ShownQuestion, TermScreen, TypingRefusal, Unanswered } from '../shared/cliQuestion';
import type { ErrorReply } from '../main/cliProto';
import type { AgentAnswerReply, AgentQuestionReply, AnswerAsk, AnswerRefusal } from '../main/cliServer';
import type { PtyEngine } from '../main/terminal';
import { viewer } from './host';
import { DAEMON_OUTDATED } from './agents';

/** A session's screen, as the questions read it: its rows, the rows above them, its width, whether its program runs, and its CLI. */
export interface SessionScreen extends TermScreen { engine: PtyEngine | null }
/** Why a session takes no keys now: a chat shown in Chat view, switching views, or delivering a message to its CLI. */
export type InputBlock = 'chat-view' | 'switching' | 'delivering';
/** How the questions reach a session: the PTY daemon in the app (daemonIo); a fake CLI in a test. */
export interface SessionIo {
  /** What the session shows now; null when there is no such session. */
  read(id: string): Promise<SessionScreen | null>;
  /** How many inputs that were typing the session has had (terminal.inputEpoch). */
  inputs(id: string): number;
  /** Writes input to the session. */
  write(id: string, data: string): void;
  /** Why the session takes no typed input now, else null. */
  blocked(id: string): InputBlock | null;
  /** Why no session can be read now (a terminal service too old to give its scrollback), else null. */
  unavailable?(): ErrorReply | null;
}
/** The questions of one host's sessions. */
export interface Questions {
  question(id: string): Promise<AgentQuestionReply | ErrorReply>;
  answer(id: string, ask: AnswerAsk): Promise<AgentAnswerReply | AnswerRefusal>;
}

/**
 * The daemon's view of a session. Rendering its scrollback isn't free, so a
 * look first asks only when it last printed, and a screen read once the CLI
 * has gone quiet is kept until it prints again (or its terminal is resized).
 */
function daemonIo(): SessionIo {
  const kept = new Map<string, { lastDataAt: number; size: string; view: ttyText.ScreenView }>();
  const tail = async (id: string, bytes: number): Promise<terminal.PtyTail | null> => { try { const t = await terminal.tail(id, bytes); return t.ok ? t : null; } catch { return null; } };
  return {
    async read(id) {
      const now = await tail(id, 1);
      if (!now) { kept.delete(id); return null; }
      let k = kept.get(id);
      if (!k || k.lastDataAt !== now.lastDataAt || k.size !== `${now.cols}x${now.rows}`) {
        const t = await tail(id, 200000);
        if (!t) { kept.delete(id); return null; }
        k = { lastDataAt: t.lastDataAt, size: `${t.cols}x${t.rows}`, view: await ttyText.screen(t.data, { cols: t.cols, rows: t.rows }) };
        // Only a quiet screen is kept: output in the same millisecond as the read would otherwise go unseen.
        if (Date.now() - t.lastDataAt >= 100) kept.set(id, k); else kept.delete(id);
      }
      return { screen: k.view.screen, above: k.view.above, cols: now.cols, alive: !!now.alive, engine: (now.meta && now.meta.engine) || null };
    },
    inputs: (id) => terminal.inputEpoch(id),
    write: (id, data) => terminal.write(id, data),
    blocked: (id) => viewer()?.chats?.inputBlock(id) ?? null,
    unavailable: () => (terminal.tailSupported() ? null : DAEMON_OUTDATED),
  };
}
let daemonReader: SessionIo | null = null;
const daemon = (): SessionIo => (daemonReader ||= daemonIo());

const notFound = (id: string): ErrorReply => ({ ok: false, code: 'not-found', error: `No session ${id}. \`radial agent list\` shows the live ones.` });
const shown = (q: CliQuestion, id: string): ShownQuestion => { const { key, ...rest } = q; return { id, ...rest }; };
// A refusal from cliQuestion.ts, with the question the session asks now in place of the one it read.
const refusal = (u: Unanswered, asks: ShownQuestion | null): AnswerRefusal => { const { question: _read, ...rest } = u; return { ...rest, ...(asks ? { question: asks } : {}) }; };
const GIVEN = '[the text you gave]';
// A reply with the text an answer typed taken out of its free text: its message, the screen, and the words and options
// of the questions in it, where the text shows exactly. Its codes, ids and states stay as they are, whatever letters
// the text has. A text under 4 characters would match all over the screen's own words: the reply leaves its screen
// out instead.
function redact<T extends AgentAnswerReply | AnswerRefusal>(reply: T, text: string | null): T {
  if (!text) return reply;
  if (text.length < 4) return typeof reply.text === 'string' ? { ...reply, text: '' } : reply;
  const out = (s: string): string => s.split(text).join(GIVEN);
  const option = (o: QuestionOption): QuestionOption => ({ ...o, label: out(o.label), ...(o.detail != null ? { detail: out(o.detail) } : {}) });
  const question = (q: ShownQuestion): ShownQuestion => ({ ...q, text: out(q.text), options: q.options.map(option) });
  const r: { error?: string; text?: string; question?: ShownQuestion; next?: ShownQuestion | null; chose?: QuestionOption | null } = { ...reply };
  if (typeof r.error === 'string') r.error = out(r.error);
  if (typeof r.text === 'string') r.text = out(r.text);
  if (r.question) r.question = question(r.question);
  if (r.next) r.next = question(r.next);
  if (r.chose) r.chose = option(r.chose);
  return { ...reply, ...r };
}

let hosts: Questions | null = null;
/** The host's questions: its sessions, as the PTY daemon shows them. */
export function questions(): Questions { return hosts ||= createQuestions(daemon()); }

/**
 * Whether a session's CLI asks a question of its own now, read from the PTY
 * daemon as agent question reads it, for the window's sends: its own terminal
 * may not have drawn the screen yet (a restart replays it), and what it would
 * type into a question could answer it. typed: text a send has typed into the
 * CLI's input, whose rows are left out (asksAfterTyping). null when the session
 * can't be read (none, or a terminal service too old to give its scrollback).
 */
export async function sessionAsking(id: string, typed?: string | null): Promise<boolean | null> {
  const io = daemon();
  if (io.unavailable?.()) return null;
  const s = await io.read(id);
  if (!s) return null;
  return s.alive && !!s.engine && (typed ? asksAfterTyping(s.screen, typed) : asksOwnQuestion(s.screen));
}

export function createQuestions(io: SessionIo = daemon(), timing: AnswerTiming = ANSWER_TIMING): Questions {
  // Each session's last question as read here: its key, which occurrence it is, and the session's inputs then.
  const seen = new Map<string, { key: string; occurrence: number; inputs: number }>();
  const salt = randomBytes(12).toString('hex');
  let occurrences = 0;
  const idOf = (session: string, q: CliQuestion, occurrence: number) => 'q' + createHash('sha256').update(`${salt}\0${session}\0${occurrence}\0${q.key}`).digest('hex').slice(0, 12);

  // The session's screen and its question with that question's id: the same occurrence while nothing typed into it
  // and it stayed on screen, else the next. inputs: the session's input count the screen was read at.
  async function look(id: string): Promise<{ screen: SessionScreen; question: CliQuestion | null; qid: string | null; inputs: number } | null> {
    const before = io.inputs(id);
    const screen = await io.read(id);
    if (!screen) return null;
    const after = io.inputs(id);
    const question = screen.alive && screen.engine ? readQuestion(screen.screen, screen) : null;
    if (!question) { seen.delete(id); return { screen, question: null, qid: null, inputs: after }; }
    let r = seen.get(id);
    if (!r || r.key !== question.key || r.inputs !== after || before !== after) { r = { key: question.key, occurrence: ++occurrences, inputs: after }; seen.set(id, r); }
    return { screen, question, qid: idOf(id, question, r.occurrence), inputs: after };
  }

  // One answer at a time in a session.
  const queues = new Map<string, Promise<unknown>>();
  async function inTurn<T>(id: string, work: () => Promise<T>): Promise<T> {
    const run = (queues.get(id) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(id, run);
    try { return await run; } finally { if (queues.get(id) === run) queues.delete(id); }
  }

  async function question(id: string): Promise<AgentQuestionReply | ErrorReply> {
    const down = io.unavailable?.();
    if (down) return down;
    const l = await look(id);
    if (!l) return notFound(id);
    // A question that takes text may show what was typed into its field so far: its screen stays out of the reply.
    const text = l.question && l.question.takes === 'text' ? '' : tidyScreen(l.screen.screen);
    return { ok: true, id, engine: l.screen.engine, alive: l.screen.alive, asking: !!l.question, question: l.question ? shown(l.question, l.qid!) : null, text };
  }

  async function answer(id: string, ask: AnswerAsk): Promise<AgentAnswerReply | AnswerRefusal> {
    const down = io.unavailable?.();
    if (down) return down;
    const deadline = ask.deadline ?? Date.now() + 60000;
    const reply = await inTurn(id, async (): Promise<AgentAnswerReply | AnswerRefusal> => {
      const l = await look(id);
      if (!l) return notFound(id);
      if (!l.screen.alive) return { ok: false, code: 'error', error: `${id} has ended.` };
      if (!l.question) return refusal(notAsking(id, l.screen.screen), null);
      const q = l.question, qid = l.qid!;
      if (!ask.yes || ask.expect !== qid) {
        const plan = planAnswer(q, ask, id);
        if (!plan.ok) return { ...plan, question: shown(q, qid) };
        const what = plan.option ? `"${plan.option.label}"` : plan.text != null ? 'the text you gave' : 'Enter alone';
        const why = !ask.expect ? `${id}'s CLI asks:\n${describeQuestion(q)}\nAn answer names the question it is for: pass --expect ${qid}, with --yes once the person agrees to answer it with ${what}.`
          : ask.expect !== qid ? `${id}'s CLI asks another question than the one this answer is for:\n${describeQuestion(q)}\nThis one needs its own yes: pass --yes with --expect ${qid}.`
          : `${id}'s CLI asks:\n${describeQuestion(q)}\nAnswering it with ${what} goes into its CLI as if you typed it at its terminal, and an answer can trust a folder or approve a command. Pass --yes to confirm, with --expect ${qid} so the answer goes only to this question.`;
        return { ok: false, code: 'needs-yes', error: why, question: shown(q, qid) };
      }
      // A session that takes no keys now is refused before anything is typed. Then each input goes in only while nothing
      // else has typed into the session since the answer's last one, the session takes keys, and its caller still waits.
      const blocked = io.blocked(id);
      if (blocked) return { ok: false, code: 'no-input', error: noInput(id, blocked), question: shown(q, qid) };
      let inputs = l.inputs;
      const put = (data: string): true | TypingRefusal => {
        if (Date.now() > deadline) return 'late';
        if (io.inputs(id) !== inputs) return 'other-input';
        const block = io.blocked(id);
        if (block) return block;
        io.write(id, data); inputs = io.inputs(id);
        return true;
      };
      const term: QuestionTerm = {
        id, agent: true,
        read: async () => (await io.read(id)) || { screen: '', above: [], alive: false },
        press: put,
        paste: (text) => put(engine.pasteSequence(text)),
      };
      const r = await answerQuestion(term, ask, { expectKey: q.key, deadline }, timing);
      // What the session shows after, with its question's id: the next occurrence once anything was typed.
      const now = await look(id);
      const asks = now && now.question ? shown(now.question, now.qid!) : null;
      const screen = (text: string): string => (asks && asks.takes === 'text' ? '' : text);
      if (!r.ok) {
        const again = r.code === 'needs-yes' && asks ? `\nIt asks now:\n${describeQuestion(asks)}\nThat needs its own yes: pass --yes with --expect ${asks.id}.` : '';
        return refusal({ ...r, error: r.error + again, ...(r.text != null ? { text: screen(r.text) } : {}) }, asks);
      }
      return { ok: true, id, question: shown(r.question, qid), chose: r.chose, after: r.after, next: r.next ? asks : null, text: screen(r.text), answeredAt: r.answeredAt };
    });
    return redact(reply, ask.text);
  }

  return { question, answer };
}
