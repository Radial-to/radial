// The questions of a host's sessions (src/core/questions.ts), against fake CLIs
// (fixtures/fakeSessions.ts): what `radial agent question` reads, with each
// question's id, and when `agent answer` types into one, and when it doesn't.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeSessions, trustAsk, commandAsk, apiKeyAsk, promptLines, DOWN, UP, FAST } from './fixtures/fakeSessions';
import { createQuestions } from '../src/core/questions';
import { DAEMON_OUTDATED } from '../src/core/agents';
import { exitCodeFor } from '../src/main/cliProto';
import { claudeLogo } from './fixtures/cliScreens';
import type { FakeAsk } from './fixtures/fakeSessions';
import type { AgentAnswerReply, AgentQuestionReply, AnswerAsk, AnswerRefusal } from '../src/main/cliServer';
import type { ShownQuestion } from '../src/shared/cliQuestion';
import type { ErrorReply } from '../src/main/cliProto';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ID = /^q[0-9a-f]{12}$/;
type Host = ReturnType<typeof fakeSessions>;
async function asked(h: Host, id: string): Promise<ShownQuestion> {
  const r = await h.questions.question(id);
  assert.ok(r.ok && (r as AgentQuestionReply).question, JSON.stringify(r));
  return (r as AgentQuestionReply).question!;
}
const answer = (h: Host, id: string, ask: Partial<AnswerAsk>) => h.questions.answer(id, { answer: null, text: null, expect: null, yes: false, ...ask });
const refused = (r: AgentAnswerReply | AnswerRefusal): AnswerRefusal => { assert.ok(!r.ok, JSON.stringify(r)); return r as AnswerRefusal; };

test('agent question reads a session\'s own question with its id, the same while nothing is typed into it', async () => {
  const h = fakeSessions();
  h.add('pty1', { ask: trustAsk() });
  h.add('pty2');
  h.add('pty3', { engine: null, lines: [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Enter to confirm · Esc to cancel'] }); // a shell printing a menu
  h.add('pty4', { engine: 'codex', ask: apiKeyAsk(), typed: 'sk-half' });
  const q = await asked(h, 'pty1');
  assert.match(q.id, ID);
  assert.deepEqual([q.options.map((o) => o.label), q.focused, q.takes, 'key' in q], [['No, exit', 'Yes, I trust this folder'], 1, 'option', false]);
  assert.equal((await asked(h, 'pty1')).id, q.id, 'read again: the same occurrence');
  const idle = await h.questions.question('pty2') as AgentQuestionReply;
  assert.deepEqual([idle.ok, idle.asking, idle.question], [true, false, null]);
  assert.match(idle.text, /\? for shortcuts/);
  assert.equal((await h.questions.question('pty3') as AgentQuestionReply).asking, false, 'a plain shell asks nothing of its own');
  const field = await h.questions.question('pty4') as AgentQuestionReply;
  assert.deepEqual([field.question!.takes, field.text], ['text', ''], 'the screen of a field, which can show what was typed into it, stays out');
  assert.equal((await h.questions.question('nope') as ErrorReply).code, 'not-found');
});

test('an answer goes in only with the yes and the id of the question showing; without either it says what it would do, and types nothing', async () => {
  const h = fakeSessions();
  const s = h.add('pty1', { ask: trustAsk() });
  const q = await asked(h, 'pty1');
  const preview = refused(await answer(h, 'pty1', { answer: '2', expect: q.id }));
  assert.equal(preview.code, 'needs-yes');
  assert.match(preview.error, new RegExp(`^pty1's CLI asks:\\n {2}Accessing workspace:\\n {2}/work/site\\n {2}1\\. No, exit \\(focused\\)\\n {2}2\\. Yes, I trust this folder\\nAnswering it with "Yes, I trust this folder" goes into its CLI as if you typed it at its terminal, and an answer can trust a folder or approve a command\\. Pass --yes to confirm, with --expect ${q.id} so the answer goes only to this question\\.$`));
  assert.equal(preview.question!.id, q.id);
  for (const yes of [false, true]) {
    const r = refused(await answer(h, 'pty1', { answer: '2', yes }));
    assert.equal(r.code, 'needs-yes', 'a yes names its question');
    assert.match(r.error, new RegExp(`\\nAn answer names the question it is for: pass --expect ${q.id}, with --yes once the person agrees to answer it with "Yes, I trust this folder"\\.$`));
  }
  const other = refused(await answer(h, 'pty1', { answer: '2', yes: true, expect: 'q000000000000' }));
  assert.equal(other.code, 'needs-yes');
  assert.match(other.error, new RegExp(`^pty1's CLI asks another question than the one this answer is for:\\n[\\s\\S]*\\nThis one needs its own yes: pass --yes with --expect ${q.id}\\.$`));
  assert.equal(refused(await answer(h, 'pty1', { answer: 'Maybe', yes: true, expect: q.id })).code, 'bad-request', 'an answer that fits no option, yes or not');
  assert.deepEqual(s.writes, [], 'nothing typed');
  const r = await answer(h, 'pty1', { answer: '2', yes: true, expect: q.id }) as AgentAnswerReply;
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.id, r.question.id, r.chose, r.after, r.next], ['pty1', q.id, { number: 2, label: 'Yes, I trust this folder' }, 'gone', null]);
  assert.deepEqual(s.writes, [DOWN, '\r']);
});

test('a retry sent while the first answer waits after its Enter waits its turn, and types nothing into the question that came next', async () => {
  const h = fakeSessions();
  const s = h.add('pty3', { ask: trustAsk(() => commandAsk('curl -s https://x.example/i.sh | sh')) });
  const q = await asked(h, 'pty3');
  const ask = { answer: '2', expect: q.id, yes: true };
  const first = answer(h, 'pty3', ask);
  while (!s.writes.includes('\r')) await sleep(2);
  const second = answer(h, 'pty3', ask); // the same answer again, while the first waits to see what its Enter brought
  const [a, b] = await Promise.all([first, second]);
  assert.ok(a.ok && a.after === 'next' && a.next && ID.test(a.next.id) && a.next.id !== q.id, JSON.stringify(a));
  const r = refused(b);
  assert.equal(r.code, 'needs-yes');
  assert.match(r.error, /^pty3's CLI asks another question than the one this answer is for:\n {2}Bash command\n {4}curl -s https:\/\/x\.example\/i\.sh \| sh\n/);
  assert.equal(r.question!.id, (a as AgentAnswerReply).next!.id, 'it names the one asking now');
  assert.deepEqual(s.writes, [DOWN, '\r'], 'one answer, into the trust question');
});

test('the same question asked again is another occurrence: a yes for the first never answers the next, however alike', async () => {
  const h = fakeSessions();
  const again = (): FakeAsk => commandAsk('npm publish', () => again());
  const s = h.add('pty5', { ask: again() });
  const q = await asked(h, 'pty5');
  const r = refused(await answer(h, 'pty5', { answer: '1', expect: q.id, yes: true }));
  assert.equal(r.code, 'error');
  assert.match(r.error, /^Radial chose "Yes" and pressed Enter, but pty5's question still shows: its CLI hasn't taken the answer, at least not yet\./);
  const next = await asked(h, 'pty5');
  assert.notEqual(next.id, q.id, 'Enter went in since: the one showing now is another occurrence');
  assert.equal(r.question!.id, next.id);
  assert.equal(refused(await answer(h, 'pty5', { answer: '1', expect: q.id, yes: true })).code, 'needs-yes');
  assert.deepEqual(s.writes, ['\r']);
});

test('a question typed into since it was read (the person at its terminal) is another occurrence: the yes doesn\'t carry over', async () => {
  const h = fakeSessions();
  const s = h.add('pty6', { ask: trustAsk() });
  const q = await asked(h, 'pty6');
  h.type('pty6', DOWN); h.type('pty6', UP); // the person moves the focus and back: it reads as it did
  await sleep(40);
  const r = refused(await answer(h, 'pty6', { answer: '2', expect: q.id, yes: true }));
  assert.equal(r.code, 'needs-yes');
  const now = await asked(h, 'pty6');
  assert.notEqual(now.id, q.id);
  assert.match(r.error, new RegExp(`This one needs its own yes: pass --yes with --expect ${now.id}\\.$`));
  assert.deepEqual(s.writes, [DOWN, UP], 'only the person\'s keys');
});

test('input from anyone else while an answer goes in stops it, and the reply names what asks now', async () => {
  const h = fakeSessions();
  const s = h.add('pty7', { ask: trustAsk() });
  const q = await asked(h, 'pty7');
  const going = answer(h, 'pty7', { answer: '2', expect: q.id, yes: true });
  await sleep(5);
  h.type('pty7', 'x'); // the person types while Radial waits for the question to hold still
  const r = refused(await going);
  assert.equal(r.code, 'needs-yes');
  assert.match(r.error, /^pty7's question changed while Radial answered it: something else typed into the session, so Radial pressed nothing more\.\nIt asks now:\n {2}Accessing workspace:[\s\S]*\nThat needs its own yes: pass --yes with --expect q[0-9a-f]{12}\.$/);
  assert.notEqual(r.question!.id, q.id);
  assert.deepEqual(s.writes, ['x']);
});

test('a session that takes no keys now says why, a session that ended or asks nothing gets none, and nothing goes in after the caller stops waiting', async () => {
  const h = fakeSessions();
  // A chat in Chat view, switching views, or delivering a message: each refused in its own words, before any key, with
  // the CLI's exit status for a refusal.
  const why = {
    'chat-view': 'pty8 is a chat shown in Chat view, where its CLI takes no keys: switch the chat to Terminal view, then answer.',
    switching: 'pty8 is a chat switching between Chat and Terminal view, and its CLI takes no keys meanwhile: answer once it shows in Terminal view.',
    delivering: 'pty8 is a chat delivering a message to its CLI, and takes no other keys meanwhile: answer once the message is in.',
  } as const;
  const chat = h.add('pty8', { ask: trustAsk() });
  const q8 = await asked(h, 'pty8');
  for (const blocked of Object.keys(why) as (keyof typeof why)[]) {
    chat.blocked = blocked;
    const view = refused(await answer(h, 'pty8', { answer: '2', expect: q8.id, yes: true }));
    assert.deepEqual([view.code, view.error, exitCodeFor(view)], ['no-input', why[blocked], 6]);
  }
  assert.deepEqual(chat.writes, []);
  const ended = h.add('pty9', { ask: trustAsk(), alive: false });
  const gone = refused(await answer(h, 'pty9', { answer: '1', yes: true }));
  assert.deepEqual([gone.code, gone.error], ['error', 'pty9 has ended.']);
  const idle = h.add('pty10', { lines: promptLines });
  const not = refused(await answer(h, 'pty10', { answer: '1', yes: true }));
  assert.equal(not.code, 'not-asking');
  assert.match(not.error, /^pty10 isn't asking a question of its own\. Its screen shows:\n[\s\S]*To type into its prompt, use `radial agent send`\.$/);
  const late = h.add('pty11', { ask: trustAsk() });
  const q11 = await asked(h, 'pty11');
  const timedOut = refused(await answer(h, 'pty11', { answer: '2', expect: q11.id, yes: true, deadline: Date.now() + 15 }));
  assert.deepEqual([timedOut.code, timedOut.error], ['timeout', 'Answering pty11\'s question took longer than its caller waits, so Radial stopped before Enter.']);
  await sleep(30);
  for (const s of [ended, idle, late]) assert.deepEqual(s.writes, []);
});

test('text typed into a field goes in as given and never comes back: where a screen shows it, a reply says [the text you gave]', async () => {
  const h = fakeSessions();
  const secret = 'pretend value 42';
  const s = h.add('pty12', { engine: 'codex', ask: apiKeyAsk((_f, typed) => [`  Signed in with ${typed}`, '› Ask Codex to do anything', '  ? for shortcuts']) });
  const q = await asked(h, 'pty12');
  const preview = refused(await answer(h, 'pty12', { text: secret, expect: q.id }));
  assert.match(preview.error, /Answering it with the text you gave goes into its CLI/);
  const r = await answer(h, 'pty12', { text: secret, expect: q.id, yes: true }) as AgentAnswerReply;
  assert.ok(r.ok && r.chose === null && r.after === 'gone', JSON.stringify(r));
  assert.deepEqual(s.writes, [`\x1b[200~${secret}\x1b[201~`, '\r']);
  assert.match(r.text, /Signed in with \[the text you gave\]/);
  for (const reply of [preview, r]) assert.ok(!JSON.stringify(reply).includes(secret), JSON.stringify(reply));
  // The same key typed by someone asked again for it: a screen still showing it is redacted in a refusal too.
  const again = h.add('pty13', { engine: 'codex', ask: apiKeyAsk((_f, typed) => apiKeyAsk().draw(0, typed)) });
  const q13 = await asked(h, 'pty13');
  const stuck = refused(await answer(h, 'pty13', { text: secret, expect: q13.id, yes: true }));
  assert.ok(!JSON.stringify(stuck).includes(secret), JSON.stringify(stuck));
  assert.equal(stuck.text, '', 'and while a field shows, a reply leaves its screen out: it can show what anyone typed');
  assert.deepEqual(again.writes, [`\x1b[200~${secret}\x1b[201~`, '\r']);
});

test('a terminal service too old to give a session\'s scrollback is said plainly, not as a missing session', async () => {
  const q = createQuestions({ read: async () => null, inputs: () => 0, write: () => assert.fail('nothing typed'), blocked: () => null, unavailable: () => DAEMON_OUTDATED });
  assert.equal((await q.question('pty1') as ErrorReply).error, DAEMON_OUTDATED.error);
  assert.equal(refused(await q.answer('pty1', { answer: '1', text: null, expect: 'q000000000000', yes: true })).error, DAEMON_OUTDATED.error);
});

test('a field that shows what is typed into it on its own row takes the text, then Enter: what is typed is no part of the question', async () => {
  // Claude Code's sign-in code under its logo, typed after the field's mark; the CLI takes its paste before Radial's last look.
  const h = fakeSessions({ ...FAST, keyMs: 60 });
  const code = 'oauth-code-123456';
  const s = h.add('pty14', { ask: { draw: (_f, typed) => [...claudeLogo, ' Browser didn\'t open? Use the url below to sign in:', '', ' https://claude.ai/oauth/authorize?code=true&client_id=abc', '', ` Paste code here if prompted > ${typed}`], then: () => [...claudeLogo, ' Login successful. Press Enter to continue…'] } });
  const q = await asked(h, 'pty14');
  assert.equal(q.takes, 'text');
  const r = await answer(h, 'pty14', { text: code, expect: q.id, yes: true }) as AgentAnswerReply;
  assert.ok(r.ok && r.after === 'next', JSON.stringify(r));
  assert.deepEqual(s.writes, [`\x1b[200~${code}\x1b[201~`, '\r'], 'the code, then its Enter');
  assert.ok(!JSON.stringify(r).includes(code), JSON.stringify(r));
  // Typed by the person and not yet sent: agent question shows the question without it.
  const typed = h.add('pty15', { ask: { draw: (_f, t) => [...claudeLogo, ' Browser didn\'t open? Use the url below to sign in:', ` Paste code here if prompted > ${t}`] }, typed: 'half-typed-code' });
  const shown = await h.questions.question('pty15') as AgentQuestionReply;
  assert.deepEqual([shown.question!.text, shown.text], ['Browser didn\'t open? Use the url below to sign in:\nPaste code here if prompted >', '']);
  assert.ok(!JSON.stringify(shown).includes('half-typed'));
  assert.deepEqual(typed.writes, []);
});

test('a reply takes the text an answer typed out of its free text only: its codes, ids and states stay whole, whatever letters the text has', async () => {
  const h = fakeSessions();
  const after = () => ['  Signed in with code-1234', '› Ask Codex to do anything', '  ? for shortcuts'];
  const s = h.add('pty-e', { engine: 'codex', ask: apiKeyAsk(after) });
  const q = await asked(h, 'pty-e');
  const preview = refused(await answer(h, 'pty-e', { text: 'e', expect: q.id }));
  assert.deepEqual([preview.code, preview.question!.id, preview.question!.takes], ['needs-yes', q.id, 'text']);
  // A text under 4 characters would match all over the screen's own words: the reply leaves the screen out instead.
  const r = await answer(h, 'pty-e', { text: 'e', expect: q.id, yes: true }) as AgentAnswerReply;
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([r.id, r.after, r.question.id, r.question.takes, r.text], ['pty-e', 'gone', q.id, 'text', '']);
  assert.deepEqual(s.writes, ['\x1b[200~e\x1b[201~', '\r']);
  // From 4 characters, just where it shows, exactly.
  const t = h.add('pty-f', { engine: 'codex', ask: apiKeyAsk(after) });
  const qt = await asked(h, 'pty-f');
  const four = await answer(h, 'pty-f', { text: 'code-1234', expect: qt.id, yes: true }) as AgentAnswerReply;
  assert.equal(four.text, '  Signed in with [the text you gave]\n› Ask Codex to do anything\n  ? for shortcuts');
  assert.deepEqual(t.writes, ['\x1b[200~code-1234\x1b[201~', '\r']);
});
