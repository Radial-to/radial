// The files native-interactive.cjs, the test CLI, keeps for each session in
// <RADIAL_USERDATA>/native-fixture/, as the tests and scripts/perf read and
// write them. Types only: the CLI itself exports nothing.

/** <session>.state.json: the CLI's state, rewritten on every change. */
export interface FixtureState {
  engine: 'claude' | 'cursor';
  /** The CLI's command-line arguments. */
  args: string[];
  sessionId: string;
  cwd: string;
  pid: number;
  status: 'idle' | 'busy';
  /** Typed at the prompt and not sent yet. */
  draft: string;
  /** Every prompt sent, in order. */
  prompts: string[];
  /** Ctrl+C and Escape presses. */
  interrupts: number;
  /** Every reply printed, in order. */
  outputs: string[];
  /** How many lines of <session>.commands.jsonl it has run. */
  processed: number;
}

/** A line of <session>.commands.jsonl: print a reply, end the turn, or stream a Claude-style turn. */
export type FixtureCommand =
  | { type: 'output'; text: string }
  | { type: 'finish' }
  | { type: 'stream'; seconds?: number; fps?: number; every?: number; size?: number };
