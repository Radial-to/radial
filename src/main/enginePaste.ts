/**
 * The window's paste into an agent CLI's terminal (main's engine:paste): one
 * bracketed paste, then, when asked, Enter as a separate write a beat later (a
 * TUI that gets the paste's end and Enter in one chunk submits an empty line).
 * Never into a CLI asking a question of its own, as the PTY daemon's screen
 * shows it (the core's sessionAsking, the pasted text's rows left out): a key
 * in the text could answer the question, and the Enter would. The window's
 * sends look first (shared/agentPaste.ts typeTask) and wait for the question;
 * this is the last word. Each look takes a moment, in which a chat can change
 * view or a question come up, so the chat's input gate is asked again right
 * before each write. A look that fails can't say: the window's own decides.
 */
export interface EnginePasteHost {
  /** Whether the session takes typed input now: a chat's terminal shown in Chat view takes none. */
  accepts(id: string): boolean;
  /** Whether its CLI asks a question of its own now, the rows that show `typed` left out; null when that can't be read. */
  asking(id: string, typed: string): Promise<boolean | null>;
  /** A chat's bookkeeping for what goes into its terminal. */
  record(id: string, text: string): void;
  write(id: string, data: string): void;
  /** The text as one bracketed paste. */
  pasteSequence(text: string): string;
}

/** The paste, for a host: resolves once it has written what it will. */
export function enginePaster(host: EnginePasteHost, enterDelayMs = 90): (id: string, text: string, submit: boolean) => Promise<void> {
  const asking = async (id: string, typed: string): Promise<boolean> => {
    try { return !!(await host.asking(id, typed)); } catch { return false; }
  };
  return async (id, text, submit) => {
    if (!id || !host.accepts(id)) return;
    if (await asking(id, text) || !host.accepts(id)) return;
    host.record(id, text);
    host.write(id, host.pasteSequence(text));
    if (!submit) return;
    await new Promise((resolve) => setTimeout(resolve, enterDelayMs));
    if (!host.accepts(id) || await asking(id, text) || !host.accepts(id)) return;
    host.write(id, '\r');
  };
}
