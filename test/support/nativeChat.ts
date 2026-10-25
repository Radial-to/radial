// Types the native chat tests share: what their stand-in CLIs and terminals
// record, and the stand-ins themselves. Types only: the tests import them with
// `import type`, which is erased, so nothing here runs.
//
// Stand-ins are typed as what they are (FakeTransport and FakeTerminal: the
// members of the real type they have) and cast from those to the real types:
// TypeScript can't always relate an object literal to the real type in one step,
// as its methods may take fewer arguments or answer narrower values.
import type { CodexParams, CodexPolicy, NativeChatReply, NativeChatTerminal, NativeChatTransport } from '../../src/main/nativeChat';
import type { InteractiveTransport } from '../../src/main/chat/interactive';
import type { PtyInfo, PtyMeta, TermCommand, TerminalStartOptions } from '../../src/main/terminal';
import type { ChatSession } from '../../src/shared/radialApi';

/** A chat as the store saves it: load() keeps a record with an id and a message list, and the tests leave out the fields they don't need. */
export type SavedChat = Pick<ChatSession, 'id' | 'messages'> & Partial<ChatSession>;

/** A native terminal's transport: what a Claude or Cursor chat connects through when NativeChat has a terminal to give it. */
export type Interactive = InteractiveTransport;

/** Input written to a pty (the terminal's write). */
export interface PtyWrite { id: string; data: string }

/**
 * A terminal launch as a Codex chat's terminal view (NativeChat.changeView) and
 * the native transport (initialize) make it: always with the CLI to run and the
 * pty's metadata.
 */
export type NativeStart = TerminalStartOptions & { command: Required<TermCommand>; meta: PtyMeta };

/** A request's params as NativeChat sends them (it always sends some), with what a thread or a turn carries: its model and effort, and its permissions. */
export type SentParams = CodexParams & Partial<CodexPolicy> & { model?: string; effort?: string | null };
/** A request a stand-in CLI recorded. */
export interface SentRequest { method: string; params: SentParams; id?: undefined; result?: undefined }
/** What a stand-in CLI saw: a request, or an answer NativeChat wrote back to it (write). */
export type Call = SentRequest | (NativeChatReply & { method?: undefined; params?: undefined });

/**
 * A stand-in for a chat's CLI (NativeChatTransport) with the members K that a
 * test's paths use, and a request that takes the params NativeChat sends and
 * answers what the test needs (the CLI's JSON, unchecked). bin and startedAt
 * are optional: nothing reads startedAt, so no stand-in has it, and only a
 * Codex chat's terminal view reads bin and endpoint, so only the stand-ins on
 * that path pick them. Typing them optional, rather than leaving them out,
 * keeps a stand-in with a field of its own (the options it was made with)
 * castable to the real type.
 */
export type FakeTransport<K extends Exclude<keyof NativeChatTransport, 'request'> = 'initialize' | 'close'> = Pick<NativeChatTransport, K> & Partial<Pick<NativeChatTransport, 'bin' | 'startedAt'>> & { request(method: string, params: SentParams): Promise<unknown> };

/**
 * A stand-in for the PTY daemon's client (NativeChatTerminal) with the members K
 * that a test's paths use, and a start that receives the launch (NativeStart)
 * and answers the pty's id, or null from a stand-in that opens none (which
 * NativeChat and the native transport refuse).
 */
export type FakeTerminal<K extends Exclude<keyof NativeChatTerminal, 'start'>> = Pick<NativeChatTerminal, K> & { start(repoDir: string, options: NativeStart): Promise<string | null> };
/** A stand-in's list of the daemon's ptys: each with only the fields F that NativeChat and the native transport read. */
export interface FakeList<F extends keyof PtyInfo> { list(): Promise<Pick<PtyInfo, F>[]> }
