import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksOwnQuestion, asksAfterTyping, readQuestion, planAnswer, answerQuestion, describeQuestion, TEXT_MAX } from '../src/shared/cliQuestion';
import type { AnswerTiming, CliQuestion, QuestionTerm, QuestionView, TypingRefusal } from '../src/shared/cliQuestion';
import { claudeLogo, rule, screen, screens, wideScreens, workingScreens } from './fixtures/cliScreens';

const QUESTIONS = ['claudeTheme', 'claudeLogin', 'claudeApiKey', 'claudeSecurityNotes', 'claudeTrust', 'codexSignIn', 'codexApiKey', 'codexTrust', 'codexTrustGit', 'codexModelPicker', 'codexReasoning', 'codexPermissions', 'cursorLogIn'] as const;

test('each CLI\'s own first-run, sign-in, trust and picker questions are questions', () => {
  for (const name of QUESTIONS) assert.equal(asksOwnQuestion(screen(screens[name])), true, name);
  // Codex's overlay for a model's own question, composed from its strings ("Press a number to choose", "esc to dismiss",
  // "type to continue"): only a model's question opens it, so it wasn't captured live.
  assert.equal(asksOwnQuestion(['  Which page should I start with?', '› 1. Home', '  2. Pricing', '  Press a number to choose · esc to dismiss · type to continue'].join('\n')), true);
});

test('an input prompt is not a question, even beside question words', () => {
  assert.equal(asksOwnQuestion(screen(screens.claudeReady)), false, 'Claude Code at its prompt');
  assert.equal(asksOwnQuestion(screen(screens.codexReady)), false, 'Codex at its prompt');
  assert.equal(asksOwnQuestion('  Cursor Agent\n→ Plan, search, build anything'), false, 'Cursor Agent at its prompt');
  // A conversation that mentions approving or signing in, under the prompt.
  assert.equal(asksOwnQuestion(['● I changed the sign in page; approve it when you are ready.', rule, '❯ ', rule, '  ? for shortcuts'].join('\n')), false);
  // An empty input line, read without its trailing space, under a question word.
  assert.equal(asksOwnQuestion(['● Done: the login page button now says "Sign in".', rule, '❯', rule].join('\n')), false);
  // The stand-ins the tests run (test/fixtures/native-interactive.cjs, agentLane's fake claude) and a shell.
  assert.equal(asksOwnQuestion('\n❯ '), false);
  assert.equal(asksOwnQuestion('FAKE CLAUDE ready\nTASK: Fix the hero\nturn done'), false);
  assert.equal(asksOwnQuestion('you@mac site % '), false);
  assert.equal(asksOwnQuestion(''), false);
});

// The four messages that once read as questions once in Codex's input: the second through "Sign in", the last two
// through "sign in" and "log in" inside other words.
const SENDS = ['Make the hero headline bigger', 'Make the Sign in button blue', 'Match the design in the screenshot', 'Fix the dialog in the pricing page'];

test('a CLI\'s input with a draft in it: Codex\'s footer under it marks it; Cursor Agent\'s arrow alone doesn\'t, as Cursor Agent keeps that row while it asks', () => {
  // Codex drops "? for shortcuts" once its input has text; the footer under its input ("<model> <effort> · <folder>") stays.
  const codex = (text: string) => screens.codexDraft.map((l) => (l.startsWith('› ') ? `› ${text}` : l));
  for (const text of SENDS) assert.equal(asksOwnQuestion(screen(codex(text))), false, `Codex: ${text}`);
  assert.equal(asksOwnQuestion(screen(workingScreens.codexDraftWrapped)), false, 'Codex as it draws a draft that wraps');
  // Cursor Agent at its prompt; with a draft, its question words read as a question until Radial leaves out what it typed.
  assert.equal(asksOwnQuestion(screen(workingScreens.cursorReady)), false, 'Cursor Agent at its prompt');
  const draft = 'Make the Sign in button blue and give the Log in link in the header more contrast so it reads at a glance on every page of the site';
  assert.equal(asksOwnQuestion(screen(workingScreens.cursorDraft)), true, 'its draft\'s words, read alone');
  assert.equal(asksAfterTyping(screen(workingScreens.cursorDraft), draft), false, 'Radial\'s own text, left out');
  // A question's own hint row has no folder after its dot: still a question.
  assert.equal(asksOwnQuestion(screen(screens.codexTrust)), true);
  // Those marks count only at the bottom of the screen, where the CLI draws its input: inside a question's content
  // (a command it asks to run) they're a line of the question.
  assert.equal(asksOwnQuestion(['  Would you like to run the following command?', '', '  $ ls · /tmp', '    → done', '', '› 1. Yes, proceed (y)', '  2. No, and tell Codex what to do differently (esc)', '', '  enter to confirm · esc to cancel'].join('\n')), true);
});

// Claude Code draws each earlier prompt of the conversation as "❯ <prompt>" at the line's start, the way its input box
// draws its draft: with a question on screen under such a prompt (the usual way: a task, then its first command needs
// a yes), the earlier prompt once read as the CLI's input. Then agent wait didn't say asking, agent question saw no
// question, and every send typed into the question and pressed Enter, which answered it. Only the input box counts:
// its ❯ between two rules.
test('Claude Code\'s earlier prompts are no input: a question under one is a question', () => {
  const asking = screen(workingScreens.claudePermission);
  assert.equal(asksOwnQuestion(asking), true, 'Claude Code asking to run a command, an earlier prompt above it');
  const q = readQuestion(asking, { engine: 'claude', cols: 100 });
  assert.ok(q);
  assert.deepEqual([q.options.map((o) => `${o.number}. ${o.label}`), q.focused, q.takes], [['1. Yes', '2. Yes, and always allow access to /private/var/folders/rs/T/peek-HgCy9v/work/clients/websites/fe', '3. Yes, and switch to auto mode · auto mode handles these prompts for you', '4. No'], 1, 'option']);
  assert.equal(q.options[1].detail, 'rnhill-and-pike/marketing-site-2026/packages/web-public/site from this project', 'the rest of the wrapped option, under it');
  assert.equal(q.text, 'Bash command\nTip: auto mode handles these prompts for you — choose "switch to auto mode" below\n  touch notes.txt\n  Create empty notes.txt file\nDo you want to proceed?', 'its words from the rule above it: not the earlier prompt');
  // The same once answered: the input box is back under the earlier prompt.
  assert.equal(asksOwnQuestion(screen(workingScreens.claudeRefused)), false);
  // The input box with a draft, its hint gone: the box alone marks it, whatever its words.
  assert.equal(asksOwnQuestion(screen(workingScreens.claudeDraft)), false);
  assert.equal(asksOwnQuestion(screen(workingScreens.claudeDraft.map((l) => l.replace('Run the shell command: touch notes.txt', 'Approve the Sign in copy')))), false);
  assert.equal(asksOwnQuestion([...claudeLogo.slice(0, 1), rule, '❯\u00a0Please approve the Sign in copy, then', '  log in and check the footer', rule, '  ⏸ manual mode on · ← for agents'].join('\n')), false, 'a draft over two rows');
  // An earlier prompt with a question's words, the input box under it.
  assert.equal(asksOwnQuestion(screen(workingScreens.claudeRefused.map((l) => l.replace('Run the shell command: touch notes.txt', 'Make the Sign in button blue')))), false);
  // The shapes the review found: an earlier prompt over a question, and a command that prints the input's hint.
  const permission = [rule, ' Bash command', '', '   rm -rf dist', '   Remove the build output', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don\'t ask again for rm commands in /work/site', '   3. No, and tell Claude what to do differently (esc)', ''];
  assert.equal(asksOwnQuestion(['❯ Clean the build output', '', '⏺ I\'ll remove the old build first.', '', ...permission].join('\n')), true);
  assert.ok(readQuestion(['❯ Clean the build output', '', '⏺ I\'ll remove the old build first.', '', ...permission].join('\n'), { engine: 'claude' }));
  assert.equal(asksOwnQuestion([rule, ' Bash command', '', '   grep -n "? for shortcuts" src/app.ts', '   Find the hint', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No, and tell Claude what to do differently (esc)', ''].join('\n')), true, '"? for shortcuts" counts only on the screen\'s last two rows');
  // A ❯ under a rule with no rule under it, before a row at the line's start, is no input box.
  assert.equal(asksOwnQuestion([rule, '❯ Approve the copy', '', '⏺ Approved.', ' ❯ 1. Yes', '   2. No'].join('\n')), true);
});

// Cursor Agent marks a list's chosen option with an arrow, as it does its input; its input row stays on screen while
// it asks ("→ Waiting for decision (y/n/p)..."), so only an empty input's placeholder marks its prompt. Composed from
// Cursor Agent 2026.10's strings: an approval shows only when its agent runs a command, so it wasn't captured live.
test('Cursor Agent\'s chosen option and its input row while it asks are no prompt', () => {
  const footer = ['', '  Auto                                                                              Ask Every Time', '  /private/var/folders/rs/T/peek-HgCy9v/site'];
  assert.equal(asksOwnQuestion(['  Run this command?', '  touch notes.txt', '   Run (once) (y)', ' → Skip (esc or n)'].join('\n')), true, 'the chosen option on the last row, an arrow before it');
  // Its approvals by their titles (most have no question's words), or by its input's placeholder while one waits;
  // Radial's text, left out of its input, leaves the title.
  for (const title of ['Run this command?', 'Write to this file?', 'Run this MCP tool?', 'Proceed with this edit?']) {
    const approval = (input: string) => ['  Cursor Agent', '', `  ${title}`.padEnd(99), '  touch notes.txt', '   → Proceed (y)', '     Skip (esc or n)', '', `  → ${input}`, ...footer].join('\n');
    assert.equal(asksOwnQuestion(approval('Waiting for decision (y/n/p)...')), true, title);
    assert.equal(asksAfterTyping(approval('Make the Sign in button blue'), 'Make the Sign in button blue'), true, `${title}, Radial's text in its input`);
  }
  assert.equal(asksOwnQuestion(['  Cursor Agent', '', '  → Waiting for decision (y/n/p)...', ...footer].join('\n')), true, 'the placeholder alone');
  // An agent's line that says the same words in a sentence is none of those; a title is a row of its own.
  assert.equal(asksAfterTyping(['  I\'ll read this file first. Write to this file? Yes, then the next.', '', '  → Make the hero bigger', ...footer].join('\n'), 'Make the hero bigger'), false);
  assert.equal(asksAfterTyping(['  Write to this file?', '', '  → Make the hero bigger', ...footer].join('\n'), 'Make the hero bigger'), true);
});

// Cursor Agent's mode switch, as its switch-mode surface draws it (2026.10.19): its countdown bar, its title, its
// options with the chosen one's arrow two columns in (where its input's is), and its footer. Its option was its only
// mark: a send whose text held that option's label left the row out as Cursor Agent's input, read no question, and
// its Enter approved the switch. Its title marks it now.
test('Cursor Agent\'s mode switch is a question by its title, whatever the text sent', () => {
  const modeSwitch = (mode: string) => ['━'.repeat(70) + '─'.repeat(30), ` Switch to ${mode} mode?`, ' The plan is ready to build.', '  → Approve mode switch (y)', '    Reject (n or esc)', '', ' ↑/↓ to navigate • Enter to select • auto-rejects when the bar runs out'].join('\n');
  for (const mode of ['Agent', 'Plan', 'Ask', 'Debug', 'Triage', 'Spec']) {
    assert.equal(asksOwnQuestion(modeSwitch(mode)), true, mode);
    assert.equal(asksAfterTyping(modeSwitch(mode), 'Approve mode switch (y), then fix the hero'), true, `${mode} mode, the option's label in the text`);
  }
  // An agent's line that says it in a sentence is no title.
  assert.equal(asksAfterTyping(['  Shall I switch to Plan mode? I can do that.', '', '  → Make the hero bigger', '', '  Auto                    Run Everything', '  /work/site'].join('\n'), 'Make the hero bigger'), false);
});

// withoutTyped once left out any row whose words were in the text, and a send looks before it types: a message with
// "1. Yes" in it left out the " ❯ 1. Yes" of Claude Code's permission prompt (its only mark: the prompt has no
// question's words), read no question, typed the text, and pressed Enter, which answered "1. Yes". Only the CLI's
// own input is left out now: its mark where the CLI draws it, its text all Radial's, and nothing under it asking.
test('only the CLI\'s input is left out after typing: a question\'s rows stay, whatever the text', () => {
  const permission = [rule, ' Bash command', '', '   rm -rf dist', '   Remove the build output', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don\'t ask again for rm commands in /work/site', '   3. No, and tell Claude what to do differently (esc)', ''].join('\n');
  for (const text of ['Make the hero bigger', '1. Yes, use the blue one 2. Keep the footer', 'Answers: 1. Yes', 'Bash command', 'Do you want to proceed? 1. Yes']) assert.equal(asksAfterTyping(permission, text), true, text);
  // Under an earlier prompt whose words are the text's, the question still asks.
  assert.equal(asksAfterTyping(screen(workingScreens.claudePermission), 'Run the shell command: touch notes.txt'), true);
  // A Codex menu whose option is the text: its other options and its hint are under it.
  assert.equal(asksAfterTyping(screen(screens.codexTrust), '1. Trust and continue'), true);
  assert.equal(asksAfterTyping(screen(screens.codexTrust), '1. Trust and continue 2. Back to Agent Command Center'), true);
  // Each CLI's input with the text in it, wrapped over rows: left out.
  const wrapped = 'Make the Sign in button blue and give the Log in link in the header more contrast so it reads at a glance on every page of the site';
  assert.equal(asksAfterTyping(screen(workingScreens.codexDraftWrapped), wrapped), false, 'Codex');
  assert.equal(asksAfterTyping(screen(workingScreens.cursorDraft), wrapped), false, 'Cursor Agent');
  assert.equal(asksAfterTyping(screen(workingScreens.claudeDraft.map((l) => l.replace('Run the shell command: touch notes.txt', 'Approve the Sign in copy'))), 'Approve the Sign in copy'), false, 'Claude Code');
  // An input that holds more than Radial's text (the person's own draft before it) stays.
  assert.equal(asksAfterTyping(screen(workingScreens.cursorDraft), 'and give the Log in link in the header more contrast'), true);
});
test('a question\'s words count only as whole words: "design in", "blog in" and "dialog in" are no "sign in" or "log in"', () => {
  for (const text of ['● Match the design in the screenshot.', '● The blog in the footer is updated.', '● Fixed the dialog in the pricing page.']) assert.equal(asksOwnQuestion(text), false, text);
  for (const text of ['Sign in with ChatGPT', 'Press any key to log in...', 'Approve app tool call?']) assert.equal(asksOwnQuestion(text), true, text);
});

test('after a paste, the rows that show what Radial typed are left out: its words never read as a question', () => {
  // A CLI whose input Radial can't tell apart (here Codex with its footer set to show no folder): the draft's words alone.
  const unknown = (text: string) => ['  >_ OpenAI Codex (v0.163.0)', '', `› ${text}`, '', '  GPT-6.1-Sol · Ready'];
  assert.equal(asksOwnQuestion(screen(unknown('Make the Sign in button blue'))), true, 'its words, read as a question');
  for (const text of SENDS) assert.equal(asksAfterTyping(screen(unknown(text)), text), false, text);
  // Wrapped over rows, with the CLI's own markers before them.
  const long = 'Make the Sign in button blue and log in links bold, then approve the copy on the pricing page';
  assert.equal(asksAfterTyping(['  >_ OpenAI Codex (v0.163.0)', '', '› Make the Sign in button blue and log in', '  links bold, then approve the copy on the', '  pricing page', '', '  GPT-6.1-Sol · Ready'].join('\n'), long), false);
  // A real question that comes up meanwhile still reads as one, whatever was typed.
  assert.equal(asksAfterTyping(screen(screens.claudeTrust), 'Make the Sign in button blue'), true);
  assert.equal(asksAfterTyping(screen(screens.codexTrust), 'Trust and continue'), true, 'its menu, hint and title are not all the text typed');
});

type Engine = 'claude' | 'codex' | 'cursor';
const engineOf = (name: string): Engine => (name.startsWith('codex') ? 'codex' : name.startsWith('cursor') ? 'cursor' : 'claude');
// What each question reads as, read as the core reads a session of its CLI (Claude Code's unless the view says).
const read = (lines: string[], view: QuestionView = {}): CliQuestion => { const q = readQuestion(screen(lines), { engine: 'claude', ...view }); assert.ok(q, lines.join('\n')); return q; };
const fx = (name: keyof typeof screens): CliQuestion => read(screens[name], { engine: engineOf(name) });
const labels = (q: CliQuestion) => q.options.map((o) => `${o.number}. ${o.label}`);

test('Claude Code\'s trust question: its plain menu numbered by place, the focus on "No, exit", and its words up to the rule above', () => {
  const q = fx('claudeTrust');
  assert.deepEqual([labels(q), q.focused, q.takes], [['1. No, exit', '2. Yes, I trust this folder'], 1, 'option']);
  assert.equal(q.text, [
    'Accessing workspace:',
    '/private/var/folders/rs/T/peek-HgCy9v/site',
    'Quick safety check: Is this a project you created or one you trust? (Like your own code, a',
    'well-known open source project, or work from your team). If not, take a moment to review what\'s in',
    'this folder first.',
    'Claude Code\'ll be able to read, edit, and execute files here.',
    'Security guide',
  ].join('\n'));
});

test('Claude Code\'s first-run menus: under its logo, numbered as shown (the ✔ by the current theme left out), or by place', () => {
  const login = fx('claudeLogin');
  assert.deepEqual([labels(login), login.focused, login.takes], [['1. Claude account with subscription · Pro, Max, Team, or Enterprise', '2. Anthropic Console account · API usage billing', '3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI'], 1, 'option']);
  assert.equal(login.text, 'Claude Code can be used with your Claude subscription or billed based on API usage through your\nConsole account.\nSelect login method:', 'its words start under the logo and its art');
  const theme = fx('claudeTheme');
  assert.deepEqual([labels(theme).length, labels(theme)[1], labels(theme)[6], theme.focused], [7, '2. Dark mode', '7. Light mode (ANSI colors only)', 2]);
  assert.equal(theme.text, 'Let\'s get started.\nChoose the text style that looks best with your terminal\nTo change this later, run /theme', 'its words, not the preview or the syntax theme line under the menu');
  const key = fx('claudeApiKey');
  assert.deepEqual([labels(key), key.focused], [['1. Yes', '2. No (recommended)'], 2], 'the focus on the second, the first above it');
  assert.equal(key.text, 'Detected a custom API key in your environment\nANTHROPIC_API_KEY: sk-ant-...000000AA\nDo you want to use this API key?', 'up to the rule under the logo');
});

test('Codex\'s sign-in, trust and pickers: from their titles; a line under an option, or words beside it, say more about it', () => {
  const signIn = fx('codexSignIn');
  assert.deepEqual(signIn.options, [
    { number: 1, label: 'Sign in with ChatGPT', detail: 'Usage included with Plus, Pro, Business, and Enterprise plans' },
    { number: 2, label: 'Sign in with Device Code' },
    { number: 3, label: 'Provide your own API key' },
  ]);
  assert.deepEqual([signIn.focused, signIn.takes], [1, 'option']);
  assert.match(signIn.text, /^Welcome to Codex, OpenAI's command-line coding agent\nSign in with ChatGPT/);
  const trust = fx('codexTrust');
  assert.deepEqual([labels(trust), trust.focused], [['1. Trust and continue', '2. Back to Agent Command Center'], 1]);
  assert.match(trust.text, /^Folder access\n.*\nTrust this folder\? Codex can read/);
  const git = fx('codexTrustGit');
  assert.deepEqual([labels(git), git.focused], [['1. Trust and continue', '2. Quit'], 1]);
  assert.match(git.text, /Note: You’re in a subdirectory of a Git project\. Trusting will apply to the repository root:/);
  const models = fx('codexModelPicker');
  assert.equal(models.options.length, 8);
  assert.deepEqual(models.options[1], { number: 2, label: 'GPT-6-Astra', detail: 'Frontier intelligence for the most demanding work.' });
  assert.deepEqual([models.options[0].label, models.focused, models.text], ['GPT-6.1-Sol (current)', 2, 'Select Model and Effort'], 'from its title: Codex\'s header above it is no part of it');
  const reasoning = fx('codexReasoning');
  assert.deepEqual([labels(reasoning)[4], reasoning.text], ['5. More reasoning…', 'Select Reasoning Level for GPT-6-Astra']);
  const permissions = fx('codexPermissions');
  assert.deepEqual(permissions.options[0], { number: 1, label: 'Ask for approval (current)', detail: 'Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace' });
  assert.deepEqual([permissions.options.length, permissions.text], [4, 'Update Model Permissions']);
});

test('a question with nothing to choose takes a line of text, or Enter alone; a numbered note is no menu', () => {
  const key = fx('codexApiKey');
  assert.deepEqual([key.options, key.focused, key.takes], [[], null, 'text']);
  assert.equal(key.text, '  Welcome to Codex, OpenAI\'s command-line coding agent\n> Use your own OpenAI API key for usage-based billing\n  Paste or type your API key below.', 'its words are above its field, as shown');
  const notes = fx('claudeSecurityNotes');
  assert.deepEqual([notes.options, notes.takes], [[], 'enter'], '"1. Claude can make mistakes." has no pointer: a note, not an option');
  assert.match(notes.text, /^Security notes:\n1\. Claude can make mistakes\.[\s\S]*Press Enter to continue…$/);
  const cursor = fx('cursorLogIn');
  assert.deepEqual([cursor.takes, cursor.text], ['enter', 'Cursor Agent\nv2026.10.14-941492e\nPress any key to log in...']);
});

test('a screen at its prompt asks nothing', () => {
  for (const name of ['claudeReady', 'codexReady'] as const) assert.equal(readQuestion(screen(screens[name]), { engine: engineOf(name) }), null, name);
  assert.equal(readQuestion('FAKE CLAUDE ready\nTASK: Fix the hero\nturn done'), null);
});

test('a numbered draft in Codex\'s input is no question; only the lowest pointer counts, and one Radial can\'t read is no menu', () => {
  // Typed into its input, "1. Fix the hero" reads "› 1. Fix the hero", and the "? for shortcuts" under the input goes.
  assert.equal(asksOwnQuestion(screen(screens.codexDraft)), false);
  assert.equal(readQuestion(screen(screens.codexDraft), { engine: 'codex' }), null);
  // Two lines of it, under a conversation that mentions a question word: Codex's footer under it says it's the input.
  assert.equal(readQuestion(screen(['● Approve the plan, then I can start.', '› 1. Fix the hero', '  2. Then the footer', '', '  GPT-6.1-Sol default · /work/site']), { engine: 'codex' }), null);
  // Without its footer (a screen cut short), still no menu Radial would answer.
  const two = read(['● Approve the plan, then I can start.', '› 1. Fix the hero', '  2. Then the footer'], { engine: 'codex' });
  assert.deepEqual([two.takes, two.options], [null, []]);
  assert.equal(planAnswer(two, { answer: '1', text: null }, 'pty3').ok, false, 'so an answer is refused, not typed into the draft');
  // A question whose own pointer Radial can't read, under an older numbered list: the list above is not its menu.
  for (const lines of [
    ['› 1. Fix the hero', '  2. Then the footer', '', '• Working (12s)', rule, '  Would you like to run the following command?', '  $ npm publish', '› 1. Yes, proceed', '', '  Press enter to confirm or esc to cancel'],
    ['> 1. Fix the hero', '  2. Then the footer', rule, ' Do you want to proceed?', ' ❯ Yes', '     No', ' Enter to confirm · Esc to cancel'],
    [rule, ' Allow this?', ' ❯ 1. Yes', '', ' Enter to confirm · Esc to cancel'],
  ]) {
    const q = read(lines, { engine: null });
    assert.deepEqual([q.takes, q.options, q.focused], [null, [], null], lines.join('\n'));
  }
});

// The stand-in's trust question (test/fixtures/fake-claude.cjs), as a 120 by 40 terminal shows it: blank rows between its paragraphs.
const standIn = (focus: 0 | 1) => [rule, ' Accessing workspace:', '', ' /work/site', '', ' Quick safety check: Is this a project you created or one you trust?', '', " Claude Code'll be able to read, edit, and execute files here.", '', (focus === 0 ? ' ❯ ' : '   ') + 'No, exit', (focus === 1 ? ' ❯ ' : '   ') + 'Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel', '', '', ''];

test('the stand-in\'s trust question reads the same, wherever the focus is', () => {
  for (const focus of [0, 1] as const) {
    const q = read(standIn(focus));
    assert.deepEqual([labels(q), q.focused, q.takes], [['1. No, exit', '2. Yes, I trust this folder'], focus + 1, 'option']);
    assert.equal(q.text, 'Accessing workspace:\n/work/site\nQuick safety check: Is this a project you created or one you trust?\nClaude Code\'ll be able to read, edit, and execute files here.');
  }
});

// Claude Code's permission prompt for a command, as its dialog draws it: a rule at the top, the command, the question, the menu.
const permission = (cmd: string[], desc: string) => [rule, ' Bash command', '', ...cmd.map((l) => '   ' + l), '   ' + desc, '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don\'t ask again for node commands in /work/site', '   3. No, and tell Claude what to do differently (esc)', ''];
const nodeCmd = ['node -e "', 'const fs = require(\'fs\');', 'fs.rmSync(require(\'os\').homedir(), { recursive: true, force: true });', 'if (process.argv.length > 9) {', '  console.log(1);', '}', 'console.log(\'done\')"'];
// Codex's approval for a command, as its overlay draws it under the conversation: its title two columns in, the command.
const approval = (cmd: string[]) => ['• I will clean up the build output.', '', '• Ran ls', '  └ dist  src', '', '  Would you like to run the following command?', '', ...cmd.map((l, i) => (i ? '    ' : '  $ ') + l), '', '› 1. Yes, proceed (y)', '  2. Yes, and don\'t ask again for this command (p)', '  3. No, and tell Codex what to do differently (esc)', '', '  enter to confirm · esc to cancel'];

test('a dialog\'s words are all of it, from its rule down: a "}" row, a box inside it, a long command; no rows without letters end it', () => {
  const q = read(permission(nodeCmd, 'Clean the build output'));
  assert.equal(q.text, ['Bash command', ...nodeCmd.map((l) => '  ' + l), '  Clean the build output', 'Do you want to proceed?'].join('\n'), 'the rmSync line above the "}" row is shown, and the command\'s indents');
  const other = read(permission(nodeCmd.map((l) => l.replace('homedir()', 'tmpdir()')), 'Clean the build output'));
  assert.notEqual(other.key, q.key, 'two commands that differ above a "}" row are two questions');
  const long = Array.from({ length: 16 }, (_, i) => (i === 0 ? 'rm -rf ~/Projects && \\' : `echo step ${i} && \\`));
  assert.match(read(permission(long, 'Run the build steps')).text, /^Bash command\n {2}rm -rf ~\/Projects && \\\n {2}echo step 1 && \\[\s\S]*echo step 15 && \\\n {2}Run the build steps/, 'a 16-line command, whole');
  // An edit's diff, in a box inside the dialog: part of its words.
  const edit = read([rule, ' Edit file', ' ╭' + '─'.repeat(30) + '╮', ' │ src/app.ts' + ' '.repeat(19) + '│', ' │  1 - old title' + ' '.repeat(14) + '│', ' │  1 + new title' + ' '.repeat(14) + '│', ' ╰' + '─'.repeat(30) + '╯', ' Do you want to make this edit to app.ts?', ' ❯ 1. Yes', '   2. Yes, allow all edits during this session (shift+tab)', '   3. No, and tell Claude what to do differently (esc)']);
  assert.match(edit.text, /^Edit file\n╭─+╮\nsrc\/app\.ts\n 1 - old title\n 1 \+ new title\n╰─+╯\nDo you want to make this edit to app\.ts\?$/);
  // A menu under a conversation reads from the rule above it; one in a box reads without its sides.
  const conv = read(['⏺ I found three things to fix:', '  1. The hero image', '  2. The footer links', '', ...permission(['npm test'], 'Run the tests')]);
  assert.deepEqual([labels(conv)[0], conv.focused, conv.text], ['1. Yes', 1, 'Bash command\n  npm test\n  Run the tests\nDo you want to proceed?'], 'the numbered list in the conversation is not the menu');
  const boxed = read(['╭' + '─'.repeat(40) + '╮', '│ Do you want to proceed?' + ' '.repeat(16) + '│', '│ ❯ 1. Yes' + ' '.repeat(31) + '│', '│   2. No' + ' '.repeat(32) + '│', '╰' + '─'.repeat(40) + '╯', ' Enter to confirm · Esc to cancel']);
  assert.deepEqual([labels(boxed), boxed.focused, boxed.text], [['1. Yes', '2. No'], 1, 'Do you want to proceed?']);
});

test('a question\'s words start at its CLI\'s own frame, never at a row of its content that looks like one', () => {
  // Claude Code: a heredoc in a command holding a line of dashes, indented as the dialog's content is.
  const heredoc = (first: string) => permission([first, 'cat > NOTES.md <<\'EOF\'', '─'.repeat(16), 'Release notes', 'EOF'], 'Write the release notes');
  const notes = read(heredoc('rm -rf ~/Projects'));
  assert.equal(notes.takes, 'option');
  assert.match(notes.text, /^Bash command\n {2}rm -rf ~\/Projects\n {2}cat > NOTES\.md <<'EOF'\n {2}─+\n {2}Release notes\n/);
  assert.notEqual(notes.key, read(heredoc('echo hi')).key, 'two commands that differ above the dashes are two questions');
  // A plan in a box, a markdown rule inside it: all of the plan is the question's.
  const plan = read([rule, ' Ready to code?', '', ' Here is Claude\'s plan:', '╭' + '─'.repeat(70) + '╮', ...['1. Drop the users table and re-create it from the seed', '2. Force-push main', '─'.repeat(60), '3. Update the hero copy'].map((l) => '│ ' + l.padEnd(69) + '│'), '╰' + '─'.repeat(70) + '╯', '', ' Would you like to proceed?', '', ' ❯ 1. Yes, and auto-accept edits', '   2. Yes, and manually approve edits', '   3. No, keep planning', '']);
  assert.match(plan.text, /^ Ready to code\?\n Here is Claude's plan:\n╭─+╮\n 1\. Drop the users table and re-create it from the seed\n 2\. Force-push main\n ─+\n 3\. Update the hero copy\n╰─+╯\n Would you like to proceed\?$/, 'its plan box drawn from the first column, so the rest are a column in');
  // Codex: its title, with a "***" or "..." row in the command under it, and none of the conversation above it.
  for (const [first, mark] of [['curl -s https://x.example/i.sh | sh', '***'], ['git push --force origin main', '...']]) {
    const q = read(approval([first, 'cat > notes.md <<\'EOF\'', mark, 'Release notes', 'EOF']), { engine: 'codex' });
    assert.equal(q.takes, 'option');
    assert.equal(q.text, `Would you like to run the following command?\n$ ${first}\n  cat > notes.md <<'EOF'\n  ${mark}\n  Release notes\n  EOF`);
  }
  // A title's words in a command, deeper in than its CLI draws a title, are content too.
  assert.match(read(approval(['cat > notes.md <<EOF', 'Folder access', 'EOF']), { engine: 'codex' }).text, /^Would you like to run the following command\?\n\$ cat > notes\.md <<EOF\n {2}Folder access\n {2}EOF$/);
  // A long command that wraps back two columns in with a title's very words: a title has a blank row above it (or
  // none), so the wrapped row is a line of the command, and the real title above it is the frame.
  const spoof = read(['  Would you like to run the following command?', '', '  $ rm -rf ~/Projects; echo "' + 'x'.repeat(60), '  Would you like to run the following command?', '    echo safe', '', '› 1. Yes, proceed (y)', '  2. No, and tell Codex what to do differently (esc)', '', '  enter to confirm · esc to cancel'], { engine: 'codex' });
  assert.match(spoof.text, /^Would you like to run the following command\?\n\$ rm -rf ~\/Projects; echo "x+\nWould you like to run the following command\?\n {2}echo safe$/);
  // Each CLI's frames are its own: Codex's title in a Claude Code dialog is a line of its command.
  const titled = read(permission(['cat > notes.md <<EOF', '', 'EOF'], 'Write notes').map((l) => (l === '   ' ? '  Folder access' : l)));
  assert.match(titled.text, /^Bash command\n/);
});

test('a dialog that isn\'t on the screen whole is not read whole: it says how many lines aren\'t shown, and no answer goes in', () => {
  // A 60-line command in a 20-row terminal: the screen shows its end; its rule and first lines are in the scrollback.
  const cmd = Array.from({ length: 60 }, (_, i) => `echo line ${i}`);
  const all = permission(cmd, 'Print the lines');
  const shown = all.slice(-20), above = all.slice(0, -20);
  const q = read(shown, { above });
  assert.equal(q.takes, null);
  const hidden = above.slice(1).filter((l) => l.trim()).length;
  assert.equal(q.hidden, hidden, 'every row with words between the rule and the screen');
  assert.match(describeQuestion(q), new RegExp(`^ {2}\\(${hidden} lines of it not on the screen, not shown\\)\\n {2,}echo line 47\\n`));
  const p = planAnswer(q, { answer: '1', text: null }, 'pty3');
  assert.ok(!p.ok && p.code === 'error' && /^\d+ lines of pty3's question aren't on its screen, so Radial won't answer what it can't show whole\./.test(p.error), JSON.stringify(p));
  // The same dialog with only its rule above the screen is whole; and a full-screen CLI has no rows above it at all.
  assert.equal(read(all.slice(1), { above: all.slice(0, 1) }).takes, 'option');
  assert.equal(fx('codexTrust').takes, 'option');
  // Its rule above the screen, and a row of dots on it (a Python stub's "..."): still not whole.
  const stub = read(['   class Stub:', '       ...', '   print("done")', '   EOF', '   Run the stub', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No, and tell Claude what to do differently (esc)', ''], { above: [rule, ' Bash command', '', '   rm -rf ~/Projects', '   python3 - <<\'EOF\''] });
  assert.deepEqual([stub.takes, stub.hidden], [null, 3]);
  // Codex's own mark at the top of a dialog it clipped: those lines aren't shown either.
  const clipped = read(['  Would you like to run the following command?', '  … 14 earlier lines hidden', '  echo done', '› 1. Yes, proceed (y)', '  2. No, and tell Codex what to do differently (esc)', '  enter to confirm · esc to cancel'], { engine: 'codex' });
  assert.deepEqual([clipped.takes, clipped.hidden], [null, 14]);
  const cut = planAnswer(clipped, { answer: '1', text: null }, 'pty3');
  assert.ok(!cut.ok && /^14 lines of pty3's question aren't on its screen/.test(cut.error), JSON.stringify(cut));
  // Nothing on the screen, or just above it, where a dialog of its CLI's begins: Radial can't say what it asks.
  const loose = read([' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Enter to confirm · Esc to cancel']);
  assert.deepEqual([loose.takes, loose.unframed, loose.hidden], [null, true, undefined]);
  assert.match(describeQuestion(loose), /^ {2}\(where it begins isn't on the screen\)\n/);
  const refused = planAnswer(loose, { answer: '1', text: null }, 'pty3');
  assert.ok(!refused.ok && /^Radial can't see where pty3's question begins, so it won't answer what it can't show whole\./.test(refused.error), JSON.stringify(refused));
  // Claude Code's rule spans the screen: knowing its width, a shorter line of dashes from the first column is none.
  assert.equal(read(permission(['echo hi'], 'Say hi'), { cols: 60 }).takes, 'option');
  assert.equal(read(permission(['echo hi'], 'Say hi'), { cols: 100 }).unframed, true);
  // As the real CLI draws it in wide terminals: the same question, at any width.
  for (const { cols, lines } of Object.values(wideScreens)) {
    const wide = read(lines, { cols });
    assert.deepEqual([wide.takes, wide.focused, labels(wide), wide.key], ['option', 1, ['1. No, exit', '2. Yes, I trust this folder'], fx('claudeTrust').key], `${cols} columns: the same key as at 100`);
  }
});

test('Codex\'s approval reads from its title, on the alternate screen or under a conversation that runs above it', () => {
  const full = read(approval(['rm -rf dist']), { engine: 'codex' });
  assert.deepEqual([full.takes, full.hidden, full.text], ['option', undefined, 'Would you like to run the following command?\n$ rm -rf dist']);
  const inline = read(approval(['rm -rf dist']), { engine: 'codex', above: ['› Clean the build output', '', '• Explored', '  └ List ls'] });
  assert.deepEqual([inline.takes, inline.hidden, inline.key], ['option', undefined, full.key], 'the conversation above it is no part of it');
});

test('the logo bounds a first-run question, and only the logo: Claude Code\'s, and Codex\'s braille one in a tall terminal', () => {
  const theme = fx('claudeTheme');
  assert.ok(!/[█░▓.*]{4}/.test(theme.text), theme.text);
  const braille = ['                          ⢠⣶⣶⣶⣶⣦⡀', '                          ⢾⣿⣿⣿⣿⣿⡇', '                           ⠘⠿⠿⠿⠿⠟⠁', '', '', ''];
  const signIn = read([...braille, ...screens.codexSignIn], { engine: 'codex' });
  assert.deepEqual([signIn.text, signIn.key], [fx('codexSignIn').text, fx('codexSignIn').key], 'the logo is no part of the question');
  // A row of dots in a dialog is a line of it, not art.
  const dotted = read(permission(['python3 - <<EOF', 'class Stub:', '    ...', 'EOF'], 'Run it'));
  assert.match(dotted.text, /^Bash command\n {2}python3 - <<EOF\n {2}class Stub:\n {6}\.\.\.\n {2}EOF\n/);
});

test('a field that shows what is typed into it keeps that out of the question\'s words and key', () => {
  // Claude Code's sign-in code, typed after the field's mark on the same row, under its logo.
  const oauth = (typed: string) => [...claudeLogo, ' Browser didn\'t open? Use the url below to sign in:', '', ' https://claude.ai/oauth/authorize?code=true&client_id=abc', '', ` Paste code here if prompted > ${typed}`];
  const empty = read(oauth('')), typed = read(oauth('oauth-code-123456'));
  assert.deepEqual([empty.takes, typed.takes], ['text', 'text']);
  assert.equal(typed.key, empty.key, 'the same question, whatever is typed');
  assert.equal(typed.text, 'Browser didn\'t open? Use the url below to sign in:\nhttps://claude.ai/oauth/authorize?code=true&client_id=abc\nPaste code here if prompted >');
});

test('a question\'s key holds wherever its focus is and at any width, and differs when its words or options do', () => {
  assert.equal(read(standIn(0)).key, read(standIn(1)).key, 'the same question with the focus moved');
  assert.notEqual(read(standIn(0).map((l) => l.replace('/work/site', '/work/other'))).key, read(standIn(0)).key, 'the same options for another folder');
  // The same trust question wrapped at about 100 and about 80 columns.
  const trustAt = (w: number) => {
    const words = 'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what\'s in this folder first.'.split(' ');
    const out: string[] = []; let line = '';
    for (const word of words) { if ((line + ' ' + word).trim().length > w) { out.push(' ' + line.trim()); line = word; } else line += ' ' + word; }
    out.push(' ' + line.trim());
    return [rule, ' Accessing workspace:', ' /work/site', ...out, ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'];
  };
  assert.equal(read(trustAt(96)).key, read(trustAt(76)).key);
  assert.notEqual(read(permission(['rm -rf / tmp'], 'Clean')).key, read(permission(['rm -rf /tmp'], 'Clean')).key, 'a space that changes a command changes the question');
  assert.equal(new Set(QUESTIONS.map((n) => fx(n).key)).size, QUESTIONS.length);
  // Two programs that differ only in which lines a block holds: the indents are part of the question.
  const inLoop = ['python3 - <<EOF', 'for f in files:', '    check(f)', '    os.remove(f)', 'EOF'], after = ['python3 - <<EOF', 'for f in files:', '    check(f)', 'os.remove(f)', 'EOF'];
  assert.notEqual(read(permission(inLoop, 'Clean')).key, read(permission(after, 'Clean')).key);
  assert.equal(read(permission(after, 'Clean')).text.split('\n').slice(2, 5).join('\n'), '  for f in files:\n      check(f)\n  os.remove(f)', 'shown with its indents');
});

test('a menu that scrolls says so, and an answer names only the options in view', () => {
  const lines = [rule, ' Select a session to resume', '   4. Fix the footer', ' ❯ 5. Rewrite the hero', '   6. Add a pricing page', '   ↓ 3 more', ' Enter to confirm · Esc to cancel'];
  const q = read(lines);
  assert.deepEqual([q.scrolls, labels(q), q.focused, q.takes], ['both', ['4. Fix the footer', '5. Rewrite the hero', '6. Add a pricing page'], 5, 'option']);
  assert.match(describeQuestion(q), /\(its menu scrolls: more options are above and below these, out of view\)$/);
  assert.equal(planAnswer(q, { answer: '6', text: null }, 'pty3').ok, true);
  const out = planAnswer(q, { answer: '8', text: null }, 'pty3');
  assert.ok(!out.ok && /Its menu scrolls, and Radial answers only the options in view \(4 to 6\); answer any other in its terminal\./.test(out.error), JSON.stringify(out));
});

test('an answer names an option by its number or its label, in any case; text and Enter alone fit only the questions that take them', () => {
  const trust = fx('claudeTrust'), theme = fx('claudeTheme');
  const pick = (q: CliQuestion, answer: string | null, text: string | null = null) => planAnswer(q, { answer, text }, 'pty3');
  assert.deepEqual(pick(trust, '2'), { ok: true, option: trust.options[1], text: null });
  assert.deepEqual(pick(trust, 'yes, i trust THIS folder'), { ok: true, option: trust.options[1], text: null });
  assert.deepEqual(pick(trust, '  Yes,  I trust this folder '), { ok: true, option: trust.options[1], text: null }, 'spaces aside');
  assert.deepEqual(pick(theme, '2.'), { ok: true, option: theme.options[1], text: null });
  assert.deepEqual(pick(theme, '4. Dark mode (colorblind-friendly)'), { ok: true, option: theme.options[3], text: null });
  assert.deepEqual(pick(theme, 'dark mode'), { ok: true, option: theme.options[1], text: null }, 'a label is matched whole: "Dark mode" is not "Dark mode (colorblind-friendly)"');
  assert.deepEqual(pick(fx('codexModelPicker'), 'gpt-6-astra'), { ok: true, option: fx('codexModelPicker').options[1], text: null }, 'a label without the description beside it');
  const key = fx('codexApiKey'), notes = fx('claudeSecurityNotes');
  assert.deepEqual(pick(key, null, 'sk-test'), { ok: true, option: null, text: 'sk-test' });
  assert.deepEqual(pick(notes, null), { ok: true, option: null, text: null });
});

test('an answer that fits no option, or not the question, is refused with its options listed; text is one plain line', () => {
  const trust = fx('claudeTrust');
  const refused = (q: CliQuestion, answer: string | null, text: string | null = null) => { const p = planAnswer(q, { answer, text }, 'pty3'); assert.ok(!p.ok); return p; };
  const none = refused(trust, 'Yes');
  assert.equal(none.code, 'bad-request');
  assert.equal(none.error, '"Yes" is none of the options of pty3\'s question in view. Its options:\n  1. No, exit (focused)\n  2. Yes, I trust this folder\nName one by its number or its label, as listed.');
  assert.equal(refused(trust, '3').code, 'bad-request');
  assert.match(refused(trust, null).error, /^pty3's question takes one of its options\. Its options:\n {2}1\. No, exit \(focused\)/, 'no answer: Enter would pick whatever has the focus');
  assert.match(refused(trust, null, 'yes').error, /takes one of its options, not text/);
  const twice: CliQuestion = { key: 'same', text: 'Pick one', options: [{ number: 1, label: 'Same' }, { number: 2, label: 'Same' }], focused: 1, takes: 'option' };
  const both = refused(twice, 'same');
  assert.deepEqual([both.code, /Name it by its number\.$/.test(both.error)], ['ambiguous', true]);
  const field = fx('codexApiKey');
  assert.match(refused(field, 'Sign in').error, /takes a line of text, typed into its field: pass it with --text/);
  assert.match(refused(fx('claudeSecurityNotes'), '1').error, /asks for Enter alone/);
  assert.match(refused(fx('claudeSecurityNotes'), null, 'ok').error, /asks for Enter alone/);
  // Controls, line breaks, marks that reorder text, and invisible characters: zero-width ones, word joiners, a BOM, tags.
  const c = (n: number) => String.fromCodePoint(n);
  for (const text of ['sk-1\x1b[201~\x1b[B\r', 'one\ntwo', `sk-${c(0x9b)}201~x`, `a${c(0x85)}b`, `a${c(0x2028)}b`, `a${c(0x2029)}b`, `key${c(0x202e)}gnirts`, `x${c(0x2066)}y`, `x${c(0x200f)}y`, `a${c(0x200b)}b`, `a${c(0x200d)}b`, `a${c(0x2060)}b`, `a${c(0x2063)}b`, `${c(0xfeff)}sk-test`, `a${c(0xe0041)}b`, `a${c(0xe007f)}b`]) {
    assert.match(refused(field, null, text).error, /^--text takes one line of plain text: no line breaks, terminal control characters, invisible characters, or marks that reorder text\.$/, JSON.stringify(text));
  }
  assert.equal(planAnswer(field, { answer: null, text: `sk-test-${c(0xe9)}${c(0x1f511)}` }, 'pty3').ok, true, 'any visible character is fine');
  assert.equal(refused(field, null, 'x'.repeat(TEXT_MAX + 1)).error, `--text takes at most ${TEXT_MAX} characters.`);
  assert.equal(planAnswer(field, { answer: null, text: 'x'.repeat(TEXT_MAX) }, 'pty3').ok, true);
});

test('describeQuestion: its words, then its options as listed, the focused one marked and a detail under its option', () => {
  assert.equal(describeQuestion(fx('codexSignIn'), ''), [
    'Welcome to Codex, OpenAI\'s command-line coding agent',
    'Sign in with ChatGPT to use Codex as part of your paid plan',
    'or connect an API key for usage-based billing',
    '1. Sign in with ChatGPT (focused)',
    '   Usage included with Plus, Pro, Business, and Enterprise plans',
    '2. Sign in with Device Code',
    '3. Provide your own API key',
  ].join('\n'));
});

// ── Answering, against a fake terminal: a CLI showing a screen, and the input it was sent ──

const FAST: AnswerTiming = { keyMs: 5, focusMs: 300, settleMs: 30, afterMs: 400, pollMs: 5 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = '\x1b[B', UP = '\x1b[A';
const keyOf = (lines: string[]) => read(lines, { engine: null }).key;

/**
 * A fake CLI asking a menu question: the arrow keys move its focus (unless
 * deaf), Enter does what `onEnter` says with the focused option's index, each
 * key it takes after `lag` ms. keys has everything it was sent; refuse makes
 * the host refuse an input, with that reason.
 */
function fakeCli(draw: (focus: number) => string[], { focus = 0, count = 2, deaf = false, lag = 10, onEnter = (_focus: number): string[] | 'exit' => [rule, '❯ ', rule, '  ? for shortcuts'] } = {}) {
  const state = { focus, lines: draw(focus), exited: false, keys: [] as string[], picked: -1, refuse: null as TypingRefusal | null };
  const term: QuestionTerm = {
    id: 'pty3',
    agent: true,
    read: () => ({ screen: state.lines.join('\n'), alive: !state.exited }),
    press: (keys) => {
      if (state.refuse) return state.refuse;
      state.keys.push(keys);
      if (keys === '\r') { setTimeout(() => { state.picked = state.focus; const next = onEnter(state.focus); if (next === 'exit') state.exited = true; else state.lines = next; }, lag); return true; }
      if (!deaf) setTimeout(() => { state.focus = Math.max(0, Math.min(count - 1, state.focus + (keys === DOWN ? 1 : keys === UP ? -1 : 0))); state.lines = draw(state.focus); }, lag);
      return true;
    },
    paste: (text) => { if (state.refuse) return state.refuse; state.keys.push(`paste:${text}`); return true; },
  };
  return { term, state };
}
const trustKey = keyOf(standIn(0));
// Claude Code's theme question as its first run draws it: under its logo.
const themeAsk = (labelsOf: string[]) => (f: number) => [...claudeLogo, ' Choose the text style that looks best with your terminal', ...labelsOf.map((l, i) => `${i === f ? ' ❯ ' : '   '}${i + 1}. ${l}`), ' Enter to confirm · Esc to cancel'];

test('answerQuestion moves the focus with the arrow keys, checks the screen shows it there, then presses Enter; the question gone, it says so', async () => {
  const { term, state } = fakeCli((f) => standIn(f as 0 | 1));
  const r = await answerQuestion(term, { answer: 'Yes, I trust this folder', text: null }, { expectKey: trustKey }, FAST);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(state.keys, [DOWN, '\r']);
  assert.deepEqual([r.chose, r.after, r.next], [{ number: 2, label: 'Yes, I trust this folder' }, 'gone', null]);
  assert.equal(r.question.focused, 1, 'the question as it was asked');
  assert.match(r.text, /\? for shortcuts/, 'and the screen after');
  const apiKey = (f: number) => [rule, '  Do you want to use this API key?', f === 0 ? '  ❯ Yes' : '    Yes', f === 1 ? '  ❯ No (recommended)' : '    No (recommended)', '  Enter to confirm · Esc to cancel'];
  const up = fakeCli(apiKey, { focus: 1 });
  const yes = await answerQuestion(up.term, { answer: '1', text: null }, { expectKey: keyOf(apiKey(1)) }, FAST);
  assert.ok(yes.ok && yes.chose!.label === 'Yes', JSON.stringify(yes));
  assert.deepEqual(up.state.keys, [UP, '\r'], 'up, to an option above the focus');
  const there = fakeCli((f) => standIn(f as 0 | 1), { focus: 1 });
  assert.ok((await answerQuestion(there.term, { answer: '2', text: null }, { expectKey: trustKey }, FAST)).ok);
  assert.deepEqual(there.state.keys, ['\r'], 'the focus already on it: Enter alone');
});

test('answerQuestion says what comes next: another question, or the session ended; the same question still showing is no answer', async () => {
  const theme = themeAsk(['Auto (match terminal)', 'Dark mode', 'Light mode']);
  const next = fakeCli(theme, { count: 3, onEnter: () => screens.claudeLogin });
  const r = await answerQuestion(next.term, { answer: 'Light mode', text: null }, { expectKey: keyOf(theme(0)) }, FAST);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(next.state.keys, [DOWN, DOWN, '\r'], 'one arrow at a time');
  assert.equal(r.after, 'next'); assert.deepEqual(r.next!.options.map((o) => o.number), [1, 2, 3]); assert.match(r.next!.text, /Select login method:/);
  const same = fakeCli((f) => standIn(f as 0 | 1), { onEnter: (f) => standIn(f as 0 | 1) });
  const s = await answerQuestion(same.term, { answer: '2', text: null }, { expectKey: trustKey }, FAST);
  assert.ok(!s.ok && s.code === 'error', JSON.stringify(s));
  assert.match(s.error, /^Radial chose "Yes, I trust this folder" and pressed Enter, but pty3's question still shows: its CLI hasn't taken the answer, at least not yet\./);
  const exit = fakeCli((f) => standIn(f as 0 | 1), { onEnter: () => 'exit' });
  const e = await answerQuestion(exit.term, { answer: 'No, exit', text: null }, { expectKey: trustKey }, FAST);
  assert.ok(e.ok && e.after === 'exited' && e.next === null, JSON.stringify(e));
  assert.deepEqual(exit.state.keys, ['\r']);
});

test('answerQuestion types text into a field, or presses Enter alone, as the question takes', async () => {
  const field = fakeCli(() => screens.codexApiKey, { count: 0 });
  const t = await answerQuestion(field.term, { answer: null, text: 'sk-test-123' }, { expectKey: keyOf(screens.codexApiKey) }, FAST);
  assert.ok(t.ok && t.chose === null && t.after === 'gone', JSON.stringify(t));
  assert.deepEqual(field.state.keys, ['paste:sk-test-123', '\r']);
  const notes = fakeCli(() => screens.claudeSecurityNotes, { count: 0, onEnter: () => screens.claudeTrust });
  const n = await answerQuestion(notes.term, { answer: null, text: null }, { expectKey: keyOf(screens.claudeSecurityNotes) }, FAST);
  assert.ok(n.ok && n.after === 'next' && n.next!.options.length === 2, JSON.stringify(n));
  assert.deepEqual(notes.state.keys, ['\r']);
});

test('answerQuestion never types into a CLI that isn\'t asking, another question than the one it is for, or an answer that doesn\'t fit', async () => {
  const prompt = fakeCli(() => screens.claudeReady);
  const idle = await answerQuestion(prompt.term, { answer: '1', text: null }, { expectKey: trustKey }, FAST);
  assert.ok(!idle.ok && idle.code === 'not-asking', JSON.stringify(idle));
  assert.match(idle.error, /^pty3 isn't asking a question of its own\. Its screen shows:\n {2}.*Claude Code v2\.1\.282[\s\S]*\? for shortcuts[^\n]*\nTo type into its prompt, use `radial agent send`\.$/);
  const shell = fakeCli((f) => standIn(f as 0 | 1));
  (shell.term as { agent: boolean }).agent = false;
  assert.equal((await answerQuestion(shell.term, { answer: '1', text: null }, { expectKey: trustKey }, FAST) as { code?: string }).code, 'not-asking', 'a plain shell asks nothing of its own');
  const other = fakeCli((f) => standIn(f as 0 | 1).map((l) => l.replace('/work/site', '/work/other')));
  const stale = await answerQuestion(other.term, { answer: '2', text: null }, { expectKey: trustKey }, FAST);
  assert.ok(!stale.ok && stale.code === 'needs-yes' && /asks another question than the one this answer is for/.test(stale.error), JSON.stringify(stale));
  const wrong = fakeCli((f) => standIn(f as 0 | 1));
  const no = await answerQuestion(wrong.term, { answer: 'Maybe', text: null }, { expectKey: trustKey }, FAST);
  assert.ok(!no.ok && no.code === 'bad-request' && no.question!.options.length === 2, JSON.stringify(no));
  const field = fakeCli(() => screens.codexApiKey, { count: 0 });
  const control = await answerQuestion(field.term, { answer: null, text: 'sk-1\x1b[201~\x1b[B\r' }, { expectKey: keyOf(screens.codexApiKey) }, FAST);
  assert.ok(!control.ok && control.code === 'bad-request', JSON.stringify(control));
  for (const t of [prompt, shell, other, wrong, field]) assert.deepEqual(t.state.keys, []);
});

test('answerQuestion presses each arrow once: a focus that doesn\'t get there, or a question that changes, gets no Enter', async () => {
  const deaf = fakeCli((f) => standIn(f as 0 | 1), { deaf: true });
  const stuck = await answerQuestion(deaf.term, { answer: 'Yes, I trust this folder', text: null }, { expectKey: trustKey }, FAST);
  assert.ok(!stuck.ok && stuck.code === 'error', JSON.stringify(stuck));
  assert.match(stuck.error, /pressed the arrow keys once, but the focus of pty3's question is on "No, exit", not "Yes, I trust this folder", so it pressed nothing more/);
  assert.deepEqual(deaf.state.keys, [DOWN], 'never pressed again, and no Enter');
  const moving = fakeCli((f) => standIn(f as 0 | 1), { deaf: true });
  const press = moving.term.press;
  moving.term.press = (keys) => { const r = press(keys); setTimeout(() => { moving.state.lines = screens.codexTrust; }, 1); return r; }; // another question takes its place
  const changed = await answerQuestion(moving.term, { answer: '2', text: null }, { expectKey: trustKey }, FAST);
  assert.ok(!changed.ok && changed.code === 'needs-yes' && /^pty3's question changed while Radial moved the focus/.test(changed.error), JSON.stringify(changed));
  await sleep(50);
  assert.deepEqual(moving.state.keys, [DOWN], 'no Enter on a question that changed');
  // The person answers it at the terminal while Radial takes its beat before Enter: one last look, and no Enter.
  const person = fakeCli(() => screens.claudeSecurityNotes, { count: 0 });
  const look = person.term.read;
  let reads = 0;
  person.term.read = () => { if (++reads === 1) setTimeout(() => { person.state.lines = screens.claudeReady; }, 10); return look(); };
  const beaten = await answerQuestion(person.term, { answer: null, text: null }, { expectKey: keyOf(screens.claudeSecurityNotes) }, { ...FAST, keyMs: 40 });
  assert.ok(!beaten.ok && beaten.code === 'needs-yes' && /question changed before Radial pressed Enter, so Radial pressed nothing more/.test(beaten.error), JSON.stringify(beaten));
  assert.deepEqual(person.state.keys, [], 'no Enter into the prompt the person left');
});

test('answerQuestion waits for a slow CLI to take its arrows, and holds longer for a slower one, so Enter lands on the option asked for', async () => {
  // A CLI that takes its keys in order, one every 40 ms: the focus shows on the option only once it has taken both arrows.
  const options = ['Auto (match terminal)', 'Dark mode', 'Light mode', 'Dark mode (colorblind-friendly)'];
  const draw = themeAsk(options);
  const queued = (lag: number, labelsOf: string[], wrap: boolean, drawIt: (f: number) => string[]) => {
    const state = { focus: 0, lines: drawIt(0), picked: '', keys: [] as string[] };
    const queue: string[] = []; let busy = false;
    const take = () => {
      const key = queue.shift(); if (key === undefined) { busy = false; return; }
      if (key === '\r') { state.picked = labelsOf[state.focus]; state.lines = [rule, '❯ ', rule, '  ? for shortcuts']; }
      else { state.focus = wrap ? (state.focus + (key === DOWN ? 1 : -1) + labelsOf.length) % labelsOf.length : Math.min(labelsOf.length - 1, state.focus + 1); state.lines = drawIt(state.focus); }
      setTimeout(take, lag);
    };
    const term: QuestionTerm = { id: 'pty5', agent: true, read: () => ({ screen: state.lines.join('\n'), alive: true }), press: (k) => { state.keys.push(k); queue.push(k); if (!busy) { busy = true; setTimeout(take, lag); } return true; }, paste: () => true };
    return { term, state };
  };
  const slow = queued(40, options, false, draw);
  const r = await answerQuestion(slow.term, { answer: 'Light mode', text: null }, { expectKey: keyOf(draw(0)) }, FAST);
  assert.ok(r.ok && r.chose!.number === 3, JSON.stringify(r));
  await sleep(150);
  assert.deepEqual([slow.state.keys, slow.state.picked], [[DOWN, DOWN, '\r'], 'Light mode'], 'Enter after both arrows: the third option, not the second it passed');
  // A key taken a long while after it is pressed (a CLI stalled on its terminal), on a two-option menu that wraps: the arrow
  // is never pressed again (twice would wrap the focus back), and Enter waits out a hold twice that long.
  const codex = ['Trust and continue', 'Back to Agent Command Center'];
  const drawCodex = (f: number) => ['  Folder access', '  Trust this folder? Codex can read, edit, and run files here.', ...codex.map((l, i) => `${i === f ? '›' : ' '} ${i + 1}. ${l}`), '  enter continue · esc back'];
  const stalled = queued(150, codex, true, drawCodex);
  const back = await answerQuestion(stalled.term, { answer: 'Back to Agent Command Center', text: null }, { expectKey: keyOf(drawCodex(0)) }, { ...FAST, focusMs: 1000 });
  await sleep(400);
  assert.ok(back.ok && back.chose!.number === 2, JSON.stringify(back));
  assert.deepEqual([stalled.state.keys, stalled.state.picked], [[DOWN, '\r'], 'Back to Agent Command Center']);
});

test('answerQuestion settles by what the screen reads on a CLI that never goes quiet, and waits for a question still drawing', async () => {
  // An animation over the question (Codex draws its logo in braille above its sign-in menu when the terminal is tall):
  // the screen changes every few ms, the question and its focus don't, and the answer goes in.
  let frame = 0;
  const art = () => `   ${'⣿⣶⣦⡀⠿'[frame % 5].repeat(8)}`;
  const signIn = (f: number) => [art(), '', ...screens.codexSignIn.map((l) => { const m = /^[ >] ([123])\./.exec(l); return m ? (Number(m[1]) === f + 1 ? '>' : ' ') + l.slice(1) : l; })];
  const animated = fakeCli(signIn, { count: 3 });
  const timer = setInterval(() => { frame++; animated.state.lines = [art(), ...animated.state.lines.slice(1)]; }, 5);
  try {
    const device = await answerQuestion(animated.term, { answer: 'Sign in with Device Code', text: null }, { expectKey: keyOf(signIn(0)) }, FAST);
    assert.ok(device.ok && device.chose!.number === 2, JSON.stringify(device));
    assert.deepEqual(animated.state.keys, [DOWN, '\r']);
  } finally { clearInterval(timer); }
  // A question whose focus is still moving when the answer comes gets no arrow until it holds still, and none at all
  // when it comes to rest elsewhere than it was read: the arrows counted from where it was would miss.
  const settling = fakeCli((f) => standIn(f as 0 | 1));
  let flips = 0;
  const flip = setInterval(() => { if (++flips < 6) { settling.state.focus = flips % 2; settling.state.lines = standIn(settling.state.focus as 0 | 1); } }, 10);
  try {
    const r = await answerQuestion(settling.term, { answer: '2', text: null }, { expectKey: trustKey }, FAST);
    assert.ok(!r.ok && r.code === 'needs-yes' && /changed before Radial moved the focus/.test(r.error), JSON.stringify(r));
    assert.deepEqual(settling.state.keys, []);
  } finally { clearInterval(flip); }
});

test('answerQuestion stops at an input the host refuses, each refusal in its own words, and types nothing after its deadline', async () => {
  const other = fakeCli((f) => standIn(f as 0 | 1));
  other.state.refuse = 'other-input';
  const typed = await answerQuestion(other.term, { answer: '2', text: null }, { expectKey: trustKey }, FAST);
  assert.ok(!typed.ok && typed.code === 'needs-yes' && /something else typed into the session/.test(typed.error), JSON.stringify(typed));
  const words: Record<'chat-view' | 'switching' | 'delivering', RegExp> = {
    'chat-view': /^pty3 is a chat shown in Chat view, where its CLI takes no keys: switch the chat to Terminal view, then answer\.$/,
    switching: /^pty3 is a chat switching between Chat and Terminal view, and its CLI takes no keys meanwhile: answer once it shows in Terminal view\.$/,
    delivering: /^pty3 is a chat delivering a message to its CLI, and takes no other keys meanwhile: answer once the message is in\.$/,
  };
  for (const [why, error] of Object.entries(words) as ['chat-view' | 'switching' | 'delivering', RegExp][]) {
    const chat = fakeCli((f) => standIn(f as 0 | 1), { focus: 1 });
    chat.state.refuse = why;
    const view = await answerQuestion(chat.term, { answer: '2', text: null }, { expectKey: trustKey }, FAST);
    assert.ok(!view.ok && view.code === 'no-input' && error.test(view.error), JSON.stringify(view));
    assert.deepEqual(chat.state.keys, []);
  }
  const late = fakeCli((f) => standIn(f as 0 | 1));
  const timedOut = await answerQuestion(late.term, { answer: '2', text: null }, { expectKey: trustKey, deadline: Date.now() + 20 }, FAST);
  assert.ok(!timedOut.ok && timedOut.code === 'timeout', JSON.stringify(timedOut));
  await sleep(30);
  assert.ok(!late.state.keys.includes('\r'), `no Enter after the deadline: ${JSON.stringify(late.state.keys)}`);
  const refusedLate = fakeCli((f) => standIn(f as 0 | 1));
  refusedLate.state.refuse = 'late';
  assert.equal((await answerQuestion(refusedLate.term, { answer: '2', text: null }, { expectKey: trustKey }, FAST) as { code?: string }).code, 'timeout', 'the host past the deadline: a timeout too');
  assert.deepEqual(other.state.keys, []);
});

test('answerQuestion\'s wait after Enter ends by its deadline, so its caller hears back while it still waits', async () => {
  const stuck = fakeCli((f) => standIn(f as 0 | 1), { focus: 1, onEnter: (f) => standIn(f as 0 | 1) }); // the question still shows after Enter
  const started = Date.now();
  const r = await answerQuestion(stuck.term, { answer: '2', text: null }, { expectKey: trustKey, deadline: started + 250 }, { ...FAST, afterMs: 5000 });
  const took = Date.now() - started;
  assert.ok(!r.ok && r.code === 'error' && /question still shows/.test(r.error), JSON.stringify(r));
  assert.deepEqual(stuck.state.keys, ['\r']);
  assert.ok(took < 1000, `answered in ${took} ms, not afterMs`);
});
