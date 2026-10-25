// The paste primitives the window and the core share (src/shared/agentPaste.ts),
// against a fake terminal: a CLI's screen, its activity, and what was typed.
// Short timings stand in for the real ones (agentPaste.TIMING).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMING, pasteVerified, typeTask, whenReady } from '../src/shared/agentPaste';
import { asksAfterTyping, asksOwnQuestion } from '../src/shared/cliQuestion';
import type { AgentTerm, Timing } from '../src/shared/agentPaste';

const FAST: Timing = { settleMs: 40, capMs: 400, bootWindowMs: 2000, tickMs: 10, shellCapMs: 150, pasteTries: 3, pasteChecks: 4, checkMs: 10, enterDelayMs: 5, questionWaitMs: 3000, questionPollMs: 10, quietMs: 40 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake terminal: what it shows, and every key a primitive sent it. */
function fakeTerm({ agent = true, ready = true, spawnedAt = Date.now() as number | null, lastDataAt = Date.now() } = {}) {
  const state = { agent, ready, spawnedAt, lastDataAt, exited: false, gone: false, asking: false, screen: '', typed: [] as string[], pasted: [] as string[], submitted: 0 };
  // By default a paste shows on the screen at once; landsAfter says how many pastes are wiped first.
  let wiped = 0;
  const control = { landsAfter: 0, shows: true };
  const term: AgentTerm = {
    agent,
    activity: () => ({ ready: state.ready, lastDataAt: state.lastDataAt, spawnedAt: state.spawnedAt, exited: state.exited }),
    recentText: () => state.screen,
    asking: () => state.asking,
    paste: (text) => { state.typed.push(`paste:${text}`); if (wiped++ >= control.landsAfter && control.shows) state.screen += `\n❯ ${text}`; },
    enter: () => { state.typed.push('enter'); },
    pasteAndEnter: (text) => { state.typed.push(`paste+enter:${text}`); },
    gone: () => state.gone || state.exited,
    pasting: (text) => { state.pasted.push(text); },
    submitted: () => { state.submitted++; },
  };
  return { term, state, control };
}

test('the real timings are the window’s: settle 450 ms, cap 8 s, boot window 10 s, three pastes checked every 250 ms', () => {
  assert.deepEqual([TIMING.settleMs, TIMING.capMs, TIMING.bootWindowMs, TIMING.tickMs, TIMING.shellCapMs], [450, 8000, 10000, 120, 2000]);
  assert.deepEqual([TIMING.pasteTries, TIMING.pasteChecks, TIMING.checkMs, TIMING.enterDelayMs], [3, 6, 250, 150]);
  assert.deepEqual([TIMING.questionWaitMs, TIMING.questionPollMs, TIMING.quietMs], [30 * 60000, 250, 1000]);
});

test('whenReady waits for an agent CLI’s boot paint to go quiet, not for its first byte', async () => {
  const { term, state } = fakeTerm({ ready: false });
  let done = false;
  const ready = whenReady(term, FAST).then(() => { done = true; });
  // It starts painting, and keeps painting for a while.
  for (let i = 0; i < 6; i++) { await sleep(15); state.ready = true; state.lastDataAt = Date.now(); }
  assert.equal(done, false, 'still painting');
  await ready;
  assert.ok(Date.now() - state.lastDataAt >= FAST.settleMs, 'resolved once quiet for settleMs');
});

test('whenReady: a CLI that never goes quiet gets the paste at the cap; one past its boot window or ended at once', async () => {
  const chatty = fakeTerm({ ready: true });
  const timer = setInterval(() => { chatty.state.lastDataAt = Date.now(); }, 5);
  const t0 = Date.now();
  await whenReady(chatty.term, FAST);
  clearInterval(timer);
  assert.ok(Date.now() - t0 >= FAST.capMs, 'held until the cap');

  const old = fakeTerm({ ready: true, spawnedAt: Date.now() - FAST.bootWindowMs - 1 });
  old.state.lastDataAt = Date.now(); // mid-stream, but long past its boot
  const t1 = Date.now();
  await whenReady(old.term, FAST);
  assert.ok(Date.now() - t1 < FAST.settleMs, 'past its boot window: at once');

  const reattached = fakeTerm({ ready: true, spawnedAt: null });
  reattached.state.lastDataAt = Date.now();
  const t2 = Date.now();
  await whenReady(reattached.term, FAST);
  assert.ok(Date.now() - t2 < FAST.settleMs, 'booted before the host was watching: at once');

  const ended = fakeTerm({ ready: false });
  ended.state.exited = true;
  await whenReady(ended.term, FAST); // resolves, nothing to wait for
});

test('whenReady: a plain shell is ready at its first output, or after shellCapMs', async () => {
  const shell = fakeTerm({ agent: false, ready: false });
  setTimeout(() => { shell.state.ready = true; }, 20);
  const t0 = Date.now();
  await whenReady(shell.term, FAST);
  assert.ok(Date.now() - t0 < FAST.shellCapMs, 'its first output');
  const silent = fakeTerm({ agent: false, ready: false });
  const t1 = Date.now();
  await whenReady(silent.term, FAST);
  assert.ok(Date.now() - t1 >= FAST.shellCapMs, 'or the cap');
});

test('pasteVerified pastes once the screen shows the text, then Enter on its own; staged, no Enter', async () => {
  const { term, state } = fakeTerm();
  assert.equal(await pasteVerified(term, 'Fix the hero', true, FAST), true);
  assert.deepEqual(state.typed, ['paste:Fix the hero', 'enter']);
  assert.deepEqual(state.pasted, ['Fix the hero']); assert.equal(state.submitted, 1);
  const staged = fakeTerm();
  assert.equal(await pasteVerified(staged.term, 'Rewrite the footer', false, FAST), true);
  assert.deepEqual(staged.state.typed, ['paste:Rewrite the footer']);
  assert.equal(staged.state.submitted, 0);
});

test('pasteVerified pastes again when a repaint wiped the first one, and finds text the CLI wrapped across lines', async () => {
  const { term, state, control } = fakeTerm();
  control.landsAfter = 1;
  assert.equal(await pasteVerified(term, 'Make the pricing table two columns', true, FAST), true);
  assert.deepEqual(state.typed, ['paste:Make the pricing table two columns', 'paste:Make the pricing table two columns', 'enter']);
  const wrapped = fakeTerm();
  wrapped.control.shows = false;
  const paste = wrapped.term.paste;
  wrapped.term.paste = (text) => { paste(text); wrapped.state.screen += '\n❯ Make the pricing\n  table two columns'; }; // its input wraps it
  assert.equal(await pasteVerified(wrapped.term, 'Make the pricing table two columns', false, FAST), true);
  assert.deepEqual(wrapped.state.typed, ['paste:Make the pricing table two columns'], 'pasted once, and found across its rows');
});

test('pasteVerified counts a new "[Pasted text" chip as landed, but not one already on screen', async () => {
  const { term, state, control } = fakeTerm();
  state.screen = '❯ [Pasted text #1 +12 lines]';
  control.shows = false;
  const paste = term.paste;
  term.paste = (text) => { paste(text); state.screen += '\n❯ [Pasted text #2 +40 lines]'; };
  assert.equal(await pasteVerified(term, 'line one\nline two\nline three', true, FAST), true);
  assert.deepEqual(state.typed, ['paste:line one\nline two\nline three', 'enter']);
});

test('pasteVerified: a paste never seen after three tries is submitted on the old direct path, and says it wasn’t seen', async () => {
  const { term, state, control } = fakeTerm();
  control.shows = false;
  assert.equal(await pasteVerified(term, 'Fix the hero', true, FAST), false);
  assert.deepEqual(state.typed, ['paste:Fix the hero', 'paste:Fix the hero', 'paste:Fix the hero', 'paste+enter:Fix the hero']);
  assert.equal(state.submitted, 1);
});

test('pasteVerified presses no Enter into a question that comes up as the text goes in, and typeTask waits for it, then submits what the input kept', async () => {
  const { term, state } = fakeTerm();
  const paste = term.paste;
  term.paste = (text) => { paste(text); state.asking = true; }; // a permission prompt comes up right after the paste
  assert.equal(await pasteVerified(term, 'Fix the hero', true, FAST), false);
  assert.deepEqual([state.typed, state.submitted], [['paste:Fix the hero'], 0], 'no Enter: it would answer the question');
  const waits = fakeTerm();
  const plain = waits.term.paste;
  waits.term.paste = (text) => { plain(text); waits.state.asking = true; };
  const waited = await typeTask(waits.term, 'Fix the hero', true, FAST);
  assert.deepEqual([waited.landed, waited.waiting], [false, true]);
  waits.term.paste = plain;
  await sleep(60);
  assert.deepEqual(waits.state.typed, ['paste:Fix the hero'], 'nothing more while it asks');
  waits.state.asking = false; waits.state.lastDataAt = Date.now(); // answered: the CLI draws its input again, with the text in it
  for (let i = 0; i < 100 && waits.state.typed.length < 2; i++) await sleep(10);
  assert.deepEqual([waits.state.typed, waits.state.submitted], [['paste:Fix the hero', 'enter'], 1], 'its Enter alone, as the text still shows');
  assert.equal(await waited.delivered, true, 'and it says when it went in');
  // A question that comes up the moment before the paste: nothing typed until it is answered.
  const before = fakeTerm();
  let looks = 0;
  before.term.asking = () => ++looks === 2;
  const first = await typeTask(before.term, 'Fix the hero', true, FAST);
  assert.deepEqual([first.landed, first.waiting, before.state.typed], [false, true, []]);
  before.state.lastDataAt = Date.now() - 1000;
  for (let i = 0; i < 100 && before.state.typed.length < 2; i++) await sleep(10);
  assert.deepEqual(before.state.typed, ['paste:Fix the hero', 'enter']);
});

test('typeTask types at once into a CLI showing its input', async () => {
  const { term, state } = fakeTerm();
  const now = await typeTask(term, 'Fix the hero', true, FAST);
  assert.deepEqual([now.landed, now.waiting, await now.delivered], [true, false, true]);
  assert.deepEqual(state.typed, ['paste:Fix the hero', 'enter']);
});

test('typeTask never types into a CLI asking its own question: the task waits, and goes in once it is answered and the CLI is quiet', async () => {
  const { term, state } = fakeTerm();
  state.asking = true;
  const staged = await typeTask(term, 'Rewrite the footer', false, FAST);
  assert.deepEqual([staged.landed, staged.waiting], [false, true]);
  await sleep(100);
  assert.deepEqual(state.typed, [], 'nothing typed into the question');
  state.asking = false; state.lastDataAt = Date.now(); // answered: the CLI draws its input
  await sleep(15);
  assert.deepEqual(state.typed, [], 'not before it has been quiet a moment');
  for (let i = 0; i < 100 && !state.typed.length; i++) await sleep(10);
  assert.deepEqual(state.typed, ['paste:Rewrite the footer'], 'then the task goes in, staged');
  assert.equal(await staged.delivered, true);
});

test('typeTask: a task waiting on a question gives up when the session goes, and a second question waits too', async () => {
  const gone = fakeTerm();
  gone.state.asking = true;
  const lost = await typeTask(gone.term, 'Fix the hero', true, FAST);
  gone.state.gone = true; gone.state.asking = false;
  assert.equal(await lost.delivered, false, 'the session went: it says it never went in');
  assert.deepEqual(gone.state.typed, [], 'and nothing was typed');

  const twice = fakeTerm();
  twice.state.asking = true;
  await typeTask(twice.term, 'Fix the hero', true, FAST);
  twice.state.lastDataAt = Date.now() - 1000; // quiet, but a second question is up
  await sleep(100);
  assert.deepEqual(twice.state.typed, []);
  twice.state.asking = false;
  for (let i = 0; i < 100 && twice.state.typed.length < 2; i++) await sleep(10);
  assert.deepEqual(twice.state.typed, ['paste:Fix the hero', 'enter']);
});

/**
 * A CLI's input as its screen shows it (drawn by `draw` from what was typed and not yet sent), checked for a question
 * of its own as the window and the core check it (asksAfterTyping, the text sent so far left out). sent: what Enter
 * submitted.
 */
function inputTerm(draw: (input: string) => string[]) {
  const state = { input: '', pastes: 0, sent: [] as string[], lastDataAt: Date.now() - 5000 };
  const shown = () => draw(state.input).join('\n');
  const term: AgentTerm = {
    agent: true,
    activity: () => ({ ready: true, lastDataAt: state.lastDataAt, spawnedAt: null, exited: false }),
    recentText: () => shown(),
    asking: (typed) => (typed ? asksAfterTyping(shown(), typed) : asksOwnQuestion(shown())),
    paste: (text) => { state.pastes++; state.input += text; state.lastDataAt = Date.now(); },
    enter: () => { state.sent.push(state.input); state.input = ''; state.lastDataAt = Date.now(); },
    pasteAndEnter: (text) => { state.pastes++; state.input += text; state.sent.push(state.input); state.input = ''; },
    gone: () => false,
  };
  return { term, state };
}
// Codex 0.163 at its prompt: "? for shortcuts" under its input only while it's empty; a paste over 1000 characters
// shows as "[Pasted Content N chars]".
const codex = (input: string) => ['  >_ OpenAI Codex (v0.163.0)', '     /work/site', '', input ? '› ' + (input.length > 1000 ? `[Pasted Content ${input.length} chars]` : input) : '› Ask Codex to do anything', '', '  GPT-6.1-Sol default · /work/site', ...(input ? [] : ['  ? for shortcuts'])];
// Cursor Agent 2026.10 at its prompt: its input two columns in, its model and its folder under it.
const cursor = (input: string) => ['  Cursor Agent', '  v2026.10.19-6bbf2c4', '', `  → ${input || 'Plan, search, build anything'}`, '', '', `  Auto${' '.repeat(78)}Run Everything`, '  /work/site'];

test('a message with a question\'s words in it goes into Codex and Cursor Agent and is sent: its own words never hold it as a question', async () => {
  for (const [name, draw] of [['Codex', codex], ['Cursor Agent', cursor]] as const) {
    for (const text of ['Make the hero headline bigger', 'Make the Sign in button blue', 'Match the design in the screenshot', 'Fix the dialog in the pricing page']) {
      const { term, state } = inputTerm(draw);
      const r = await typeTask(term, text, true, FAST);
      assert.deepEqual([r.landed, r.waiting, r.typed, await r.delivered, state.sent, state.input], [true, false, true, true, [text], ''], `${name}: ${text}`);
    }
  }
});

test('a send always types its text: an earlier message on screen that starts the same is no sign it landed', async () => {
  // Every one-element quick edit starts "The user selected 1 element on": the first one is still in the transcript.
  const quickEdit = (ask: string) => `The user selected 1 element on /:\n\nElement 1:\n- CSS selector: h1.hero\n- Rendered HTML:\n<h1 class="hero">Ship faster</h1>\n\nFind this in the source and act on the request below.\n\n${ask}`;
  const { term, state } = inputTerm((input) => ['> ' + quickEdit('Make it bigger').split('\n').join('\n  '), '', '⏺ Reading src/pages/index.astro…', '', '─'.repeat(80), '❯ ' + input, '─'.repeat(80), '  ? for shortcuts']);
  const r = await typeTask(term, quickEdit('Now make it blue'), true, FAST);
  assert.deepEqual([r.landed, r.typed, await r.delivered, state.pastes], [true, true, true, 1]);
  assert.deepEqual(state.sent, [quickEdit('Now make it blue')], 'the second edit, sent once');
});

test('a long paste Codex shows as "[Pasted Content N chars]" lands once', async () => {
  const { term, state } = inputTerm(codex);
  const prompt = 'The user selected 1 element on /:\n\nElement 1:\n- CSS selector: section.hero\n- Rendered HTML:\n' + '<div class="x">'.repeat(100).slice(0, 1500) + '\n\nMake it bigger';
  const r = await typeTask(term, prompt, true, FAST);
  assert.deepEqual([r.landed, state.pastes, state.sent], [true, 1, [prompt]]);
});

test('a send says whether it typed anything: nothing typed into a question, the text typed even when it was never seen', async () => {
  const asking = fakeTerm();
  asking.state.asking = true;
  const waits = await typeTask(asking.term, 'Fix the hero', true, { ...FAST, questionWaitMs: 50 });
  assert.deepEqual([waits.typed, waits.waiting, await waits.delivered], [false, true, false]);
  const unseen = fakeTerm();
  unseen.control.shows = false;
  const blind = await typeTask(unseen.term, 'Fix the hero', true, FAST);
  assert.deepEqual([blind.landed, blind.typed, blind.waiting], [false, true, false], 'pasted and sent the old direct way: typed, so no resend');
});

// A send looks for the CLI's own question before it types, leaving its text out of the look. That once left out
// Claude Code's " ❯ 1. Yes" for a message with "1. Yes" in it: the permission prompt read as no question, and the
// send typed into it and pressed Enter, which answered "1. Yes". Under the prompt that led to it, as Claude Code
// draws it, or with nothing above.
test('a send waits at Claude Code\'s permission prompt whatever its words, and goes in once the prompt is answered', async () => {
  for (const earlier of [false, true]) {
    const state = { asking: true, input: '', answered: [] as string[], sent: [] as string[], pastes: 0, lastDataAt: Date.now() - 5000 };
    const above = earlier ? ['❯ Clean the build output'.padEnd(80), '', '⏺ Bash(rm -rf dist)'] : [];
    const shown = () => (state.asking
      ? [...above, '  ⎿ \u00a0Waiting…', '', '─'.repeat(80), ' Bash command', '', '   rm -rf dist', '   Remove the build output', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don\'t ask again for rm commands in /work/site', '   3. No, and tell Claude what to do differently (esc)', '', ' Esc to cancel · Tab to amend']
      : [...above, '  ⎿ \u00a0Interrupted · What should Claude do instead?', '', '─'.repeat(80), `❯\u00a0${state.input}`, '─'.repeat(80), state.input ? '  ⏸ manual mode on' : '  ⏸ manual mode on · ? for shortcuts']).join('\n');
    const term: AgentTerm = {
      agent: true,
      activity: () => ({ ready: true, lastDataAt: state.lastDataAt, spawnedAt: null, exited: false }),
      recentText: () => shown(),
      asking: (typed) => (typed ? asksAfterTyping(shown(), typed) : asksOwnQuestion(shown())),
      paste: (text) => { state.pastes++; if (state.asking) state.answered.push(`typed:${text}`); else state.input += text; },
      enter: () => { if (state.asking) state.answered.push('1. Yes'); else { state.sent.push(state.input); state.input = ''; } },
      pasteAndEnter: (text) => { state.pastes++; if (state.asking) state.answered.push(`typed:${text}`, '1. Yes'); else { state.sent.push(state.input + text); state.input = ''; } },
      gone: () => false,
    };
    const text = '1. Yes, use the blue one 2. Keep the footer';
    const r = await typeTask(term, text, true, FAST);
    assert.deepEqual([r.landed, r.waiting, r.typed], [false, true, false], `waits${earlier ? ', under the earlier prompt' : ''}`);
    await sleep(100);
    assert.deepEqual([state.answered, state.pastes], [[], 0], 'nothing typed into the prompt, no Enter');
    state.asking = false; // the person answers it
    assert.equal(await r.delivered, true);
    assert.deepEqual([state.sent, state.pastes, state.answered], [[text], 1, []], 'then typed once and sent');
  }
});

// A paste landed when the screen showed its text more often than before, and a one-character text is all over a
// working CLI's screen: with a timer ticking ("✻ Cogitating… (9s · ↓ 1.0k tokens)"), "1" came and went with the
// clock, was pasted twice, and "11" was sent. A short text lands by the CLI's input changing to end with it.
test('a short send lands by the CLI\'s input, not the whole screen: typed once while a timer ticks', async () => {
  const claude = (tick: () => string) => (input: string) => [tick(), '', '─'.repeat(80), `❯\u00a0${input}`, '─'.repeat(80), input ? '  ⏸ manual mode on' : '  ⏸ manual mode on · ? for shortcuts'];
  for (const text of ['1', 'y', '12', 'yes']) {
    let sec = 9;
    const { term, state } = inputTerm(claude(() => `✻ Cogitating… (${sec++}s · ↓ 1.${sec % 10}k tokens)`)); // a tick each look
    const r = await typeTask(term, text, true, FAST);
    assert.deepEqual([r.landed, state.pastes, state.sent], [true, 1, [text]], `Claude Code: ${text}`);
  }
  // Codex's and Cursor Agent's inputs, their placeholders before; and one already holding the same text.
  for (const [name, draw] of [['Codex', codex], ['Cursor Agent', cursor]] as const) {
    const { term, state } = inputTerm(draw);
    assert.deepEqual([(await typeTask(term, 'y', true, FAST)).landed, state.pastes, state.sent], [true, 1, ['y']], name);
  }
  const { term, state } = inputTerm(claude(() => ''));
  state.input = '1';
  assert.deepEqual([(await typeTask(term, '1', true, FAST)).landed, state.pastes, state.sent], [true, 1, ['11']], 'the person\'s own "1" there before: typed once more');
  // Three identical sends, each typed once.
  const again = inputTerm(claude(() => ''));
  for (let i = 0; i < 3; i++) await typeTask(again.term, 'continue', true, FAST);
  assert.deepEqual([again.state.pastes, again.state.sent], [3, ['continue', 'continue', 'continue']]);
});

test('a send waiting for a question can be called off: nothing is typed after, and it says it never went in', async () => {
  const asking = fakeTerm();
  asking.state.asking = true;
  const r = await typeTask(asking.term, 'Fix the hero', true, FAST);
  assert.equal(r.waiting, true);
  assert.equal(r.cancel(), true, 'called off');
  asking.state.asking = false; asking.state.lastDataAt = Date.now() - 1000; // the question goes
  assert.equal(await r.delivered, false);
  await sleep(100);
  assert.deepEqual(asking.state.typed, [], 'nothing typed');
  // One that went in at once: calling it off changes nothing.
  const sent = await typeTask(fakeTerm().term, 'Fix the hero', true, FAST);
  assert.equal(sent.cancel(), false);
  assert.equal(await sent.delivered, true);
});

// Called off between a waiting send's paste and its Enter (the beat pasteChecked waits before Enter), a send once
// stopped there with its text left in the CLI's input, and a retry from Home sent both copies. Once its text has
// begun to go in, it goes on to its Enter: cancel answers false, and the text is sent once.
test('a waiting send called off once its text has begun to go in goes on to its Enter, and is sent once', async () => {
  const state = { asking: true, input: '', sent: [] as string[], pastes: 0, lastDataAt: Date.now() - 5000, refused: [] as boolean[] };
  let task: Awaited<ReturnType<typeof typeTask>> | null = null;
  const shown = () => (state.asking ? ['─'.repeat(80), ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend'] : ['─'.repeat(80), `❯\u00a0${state.input}`, '─'.repeat(80), state.input ? '  ⏸ manual mode on' : '  ⏸ manual mode on · ? for shortcuts']).join('\n');
  const term: AgentTerm = {
    agent: true,
    activity: () => ({ ready: true, lastDataAt: state.lastDataAt, spawnedAt: null, exited: false }),
    recentText: () => shown(),
    asking: (typed) => (typed ? asksAfterTyping(shown(), typed) : asksOwnQuestion(shown())),
    // The person calls it off right after the paste, before its Enter.
    paste: (text) => { state.pastes++; state.input += text; queueMicrotask(() => { state.refused.push(task!.cancel()); }); },
    enter: () => { state.sent.push(state.input); state.input = ''; },
    pasteAndEnter: (text) => { state.pastes++; state.sent.push(state.input + text); state.input = ''; },
    gone: () => false,
  };
  task = await typeTask(term, 'What changed today?', true, FAST);
  let began = false;
  void task.typing.then(() => { began = true; });
  assert.equal(task.waiting, true);
  await sleep(30);
  assert.equal(began, false, 'nothing typed while the question is up');
  state.asking = false; // the person answers the question
  assert.equal(await task.delivered, true);
  assert.deepEqual([began, state.refused, state.pastes, state.sent, state.input], [true, [false], 1, ['What changed today?'], ''], 'sent once, nothing left in the input');
});
