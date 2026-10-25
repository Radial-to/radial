import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NativeChatInput, NativeChatItem, NativeChatOptions, NativeChatTransport } from '../src/main/nativeChat';
import type { ChatFileDescription } from '../src/main/chat/resources';
import type { ChatAttachmentUpload } from '../src/shared/radialApi';
import type { Call, FakeTransport, SentParams, SentRequest } from './support/nativeChat';
import { tmpDir } from './support/tmp';
const fs = require('fs') as typeof import('fs'), os = require('os') as typeof import('os'), path = require('path') as typeof import('path');
const { NativeChat, itemMessage } = require('../src/main/nativeChat') as typeof import('../src/main/nativeChat');
/** A turn/start request, whose params carry the prompt. */
interface TurnRequest extends SentRequest { method: 'turn/start'; params: SentParams & { input: NativeChatInput[] } }
/** A prompt's text. */
type TextPart = Extract<NativeChatInput, { type: 'text' }>;
/** An image attached to a prompt. */
type ImagePart = Extract<NativeChatInput, { type: 'localImage' }>;
function fixture() {
  const dir = tmpDir('radial-chat-workflow-'), calls: Call[] = [];
  const options: NativeChatOptions = { file: path.join(dir, 'chats.json'), context: () => '', emit() {}, transport: () => ({ initialize: async () => {}, close() {}, write: value => calls.push(value), request: async (method, params) => { calls.push({ method, params }); return method.startsWith('thread/') ? { thread: { id: 'thread' } } : { turn: { id: 'turn-' + calls.length } }; } }) as FakeTransport<'initialize' | 'close' | 'write'> as NativeChatTransport };
  const chat = new NativeChat(options); return { dir, calls, chat, options, cleanup() { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 160));
test('queued follow-ups run only after successful completion, pause on Stop, and survive restart paused', async () => {
  const f = fixture();
  try {
    const s = f.chat.create(f.dir); await f.chat.send(s.id, 'First');
    f.chat.enqueue(s.id, 'Second'); f.chat.enqueue(s.id, 'Third');
    assert.equal(s.messages.length, 1);
    f.chat.event(s, { method: 'turn/completed', params: { turn: { id: s.turnId, status: 'completed' } } });
    await tick(); assert.deepEqual(s.messages.filter(m => m.role === 'user').map(m => m.text), ['First', 'Second']);
    await f.chat.stop(s.id); await tick(); assert.equal(s.messages.length, 2); assert.equal(s.queue!.length, 1); // Third is still queued
    f.chat.close(); const loaded = new NativeChat(f.options); const resumed = loaded.get(s.id);
    assert.equal(resumed.queuePaused, true); assert.equal(resumed.queue![0].text, 'Third'); await tick(); assert.equal(resumed.messages.length, 2);
    loaded.resumeQueue(s.id); await tick(); assert.equal(resumed.messages.at(-1)!.text, 'Third'); loaded.close();
  } finally { f.cleanup(); }
});
test('attachments reach the provider and display metadata without storing base64 in history', async () => {
  const f = fixture();
  try {
    const s = f.chat.create(f.dir), attachment = f.chat.resources.import({ name: 'reference.png', bytes: [1,2,3] });
    await f.chat.send(s.id, 'Review', 'Review', [attachment]);
    const start = f.calls.find((c): c is TurnRequest => c.method === 'turn/start')!; // send started the turn
    assert.equal(start.params.input[1].type, 'localImage'); assert.equal((start.params.input[1] as ImagePart).path, fs.realpathSync(attachment.path));
    assert.match((start.params.input[0] as TextPart).text, /Attached files/); assert.equal(s.messages[0].text, 'Review'); assert.equal((s.messages[0].attachments![0] as ChatFileDescription).src, undefined); // the prompt's text comes first; the stored attachment, read as describe() answers one, has no image data
  } finally { f.cleanup(); }
});
test('structured questions preserve multiple choices and validate missing answers', async () => {
  const f = fixture();
  try {
    const s = f.chat.create(f.dir); await f.chat.send(s.id, 'Ask');
    f.chat.requestFromCli(s, { id: 'q', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'colors', multiSelect: true }] } });
    assert.throws(() => f.chat.respond(s.id, { requestId: 'q', answers: {} }), /Answer each/);
    f.chat.respond(s.id, { requestId: 'q', answers: { colors: ['Green','Blue'] } });
    assert.deepEqual(f.calls.at(-1)!.result!.answers!.colors.answers, ['Green','Blue']); // respond just wrote the answers
  } finally { f.cleanup(); }
});
test('unrecognized activity stays visible, private reasoning stays excluded, and interrupted sessions explain recovery', async () => {
  assert.equal(itemMessage({ id: 'custom', type: 'customTool', data: { status: 'done' } } as NativeChatItem)!.name, 'custom Tool'); // an item of a type Radial doesn't know, with fields of its own; itemMessage shows it as activity
  assert.equal(itemMessage({ id: 'reasoning', type: 'reasoning', text: 'hidden' }), null);
  const f = fixture();
  try { const s = f.chat.create(f.dir); await f.chat.send(s.id, 'Work'); f.chat.close(); const loaded = new NativeChat(f.options); assert.match(loaded.get(s.id).recovery!, /closed before/); loaded.close(); } finally { f.cleanup(); } // loading a chat closed mid-turn sets recovery
});

test('PDFs stay file context while images are sent through the image channel', async () => {
  const f = fixture();
  try {
    const s = f.chat.create(f.dir), pdf = f.chat.resources.import({ name: 'reference.pdf', bytes: Buffer.from('%PDF') }), image = f.chat.resources.import({ name: 'reference.png', bytes: [1,2,3] });
    await f.chat.send(s.id, 'Review files', 'Review files', [pdf, image]);
    const input = f.calls.find((c): c is TurnRequest => c.method === 'turn/start')!.params.input; // send started the turn
    assert.deepEqual(input.filter((part): part is ImagePart => part.type === 'localImage').map(part => part.path), [fs.realpathSync(image.path)]);
    assert.match((input[0] as TextPart).text, /reference.pdf/); // the prompt's text comes first
    assert.equal(s.messages[0].attachments![0].mime, 'application/pdf');
    assert.equal((s.messages[0].attachments![0] as Partial<ChatAttachmentUpload>).bytes, undefined); // the stored attachment, read as an upload, kept no bytes
  } finally { f.cleanup(); }
});
test('queue reorder preserves entries and paused state, rejects stale orders, and dispatches the new first item', async () => {
  const f = fixture();
  try {
    const s = f.chat.create(f.dir); await f.chat.send(s.id, 'First');
    f.chat.enqueue(s.id, 'Second'); f.chat.enqueue(s.id, 'Third'); f.chat.enqueue(s.id, 'Fourth');
    const [second, third, fourth] = s.queue!; // enqueue made the queue
    await f.chat.stop(s.id);
    f.chat.reorderQueue(s.id, [fourth.id, second.id, third.id]);
    assert.equal(s.queuePaused, true);
    assert.deepEqual(s.queue!.map(item => item.text), ['Fourth', 'Second', 'Third']);
    assert.throws(() => f.chat.reorderQueue(s.id, [fourth.id, second.id, second.id]), /queue changed/);
    assert.throws(() => f.chat.reorderQueue(s.id, [second.id]), /queue changed/);
    assert.deepEqual(s.queue!.map(item => item.id), [fourth.id, second.id, third.id]);
    f.chat.resumeQueue(s.id); await tick();
    assert.equal(s.messages.filter(item => item.role === 'user').at(-1)!.text, 'Fourth');
    assert.throws(() => f.chat.reorderQueue(s.id, [fourth.id, second.id, third.id]), /queue changed/);
    assert.throws(() => f.chat.removeQueued(s.id, fourth.id), /already left/);
    assert.deepEqual(s.queue!.map(item => item.text), ['Second', 'Third']);
  } finally { f.cleanup(); }
});
