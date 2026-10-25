/**
 * Wire protocol shared by the app's control server (cliServer.js), the CLI
 * client (cli.js) and the MCP adapter (mcp.js): newline-delimited JSON over a
 * unix socket, one request → zero or more progress frames → exactly one reply.
 * Same framing the PTY daemon uses. radial serve's HTTP listener speaks it too:
 * a POST to /rpc carries one request, and its response streams the same frames
 * (src/headless/listen.ts). Pure; no Electron.
 *
 *   client → server  {op, reqId, cwd, tty, ...args}
 *   server → client  {op:'progress', reqId, text}* then {op:'reply', reqId, ok, ...}
 *
 * Errors are {ok:false, code, error}. The code maps to the CLI's exit status.
 */

const PROTOCOL = 1;

// unauthorized: radial serve's HTTP listener refused the token (RADIAL_TOKEN), or there was none.
// not-asking: `agent answer` found the session's CLI at its prompt, or working, not asking a question of its own.
// no-input: `agent answer` found the session taking no keys now: a chat shown in Chat view, switching views, or
// delivering a message to its CLI.
const CODES = ['ambiguous', 'not-found', 'not-open', 'node-missing', 'needs-yes', 'no-dev-server', 'no-engine', 'no-browser', 'not-asking', 'no-input', 'timeout', 'unreachable', 'unauthorized', 'bad-request', 'error'] as const;

/** Why a request failed; each code maps to the CLI's exit status (EXIT). */
export type ErrorCode = (typeof CODES)[number];

/** The CLI's exit status: 0 ok, 1 error, 2 usage or ambiguous, 3 not found, 4 app unreachable, 6 refused. */
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 6;

/** Correlates a request with its progress frames and reply (the CLI sends 'c' + a base-36 time). */
export type RequestId = string;

/**
 * client → server: {op, reqId, cwd, tty, ...args}. `op` is a socket op (cliSpec's
 * `op`, else the verb, plus `hello`); the rest are that op's own arguments.
 */
export interface RequestFrame {
  op: string;
  reqId?: RequestId;
  /** The caller's working directory; the server falls back to its own. */
  cwd?: string;
  /** Whether the caller is a terminal (a person may be watching). */
  tty?: boolean;
  // The common block the CLI (cli.js buildPayload) and the MCP adapter (mcp.js argsToPayload) send with every op:
  /** The project: a path, a name, a GitHub link or owner/repo; null means the caller's cwd. */
  target?: string | null;
  /** `open` waits for the project to come up (false: queue it and answer at once). */
  wait?: boolean;
  /** Confirms an op that otherwise refuses with needs-yes. */
  yes?: boolean;
  /** `ls`: include recent projects that are not open. */
  all?: boolean;
  /** `comments`: only unresolved ones. */
  open?: boolean;
  /** The page an op works on, e.g. /pricing. */
  route?: string | null;
  /** How long the client waits for the reply; ops that wait on the app use it too. */
  timeoutMs?: number;
  /** The op's own arguments. */
  [arg: string]: unknown;
}

/**
 * One choice in an ambiguous reply: a project (projectResolve), or a place in
 * the source (`file:line` for an edit, `mode (file:line)` for a token).
 */
export interface Candidate {
  name: string;
  /** The project's folder, or the file relative to the project. */
  path: string;
  open?: boolean;
  suspended?: boolean;
  lastOpened?: number | null;
  /** How a project matched the query. */
  reason?: 'exact' | 'fuzzy';
  line?: number;
  mode?: string;
  value?: string;
}

/** Detail an error reply may carry whatever the op; clients read these off any error. */
export interface ErrorDetails {
  repoDir?: string;
  /** The failing module's own reason (a not-found or ambiguous kind, a git or Vercel code…). */
  reason?: string | null;
  /** false: the candidates are places in the source, not projects for the CLI to offer as a pick. */
  pick?: boolean;
  candidates?: Candidate[];
  /** A prompt to hand an agent in the project, and the label for the button that offers it. */
  fixPrompt?: string;
  fixLabel?: string;
  /** The command that clears the refusal (a no-browser refusal: `radial browser install`). */
  fix?: string;
  /** The command that does the job another way meanwhile (a no-browser refusal: without a browser). */
  instead?: string;
}

/** A failed request: {ok:false, code, error}, plus whatever detail the op adds (repoDir, candidates…). */
export interface ErrorReply extends ErrorDetails {
  ok: false;
  code: ErrorCode;
  error: string;
}

/** A successful request: {ok:true, ...} with the op's own fields (T, when the op's result is known). */
export type OkReply<T extends object = Record<string, unknown>> = { ok: true } & T;

/** What a request resolves to. */
export type Reply<T extends object = Record<string, unknown>> = OkReply<T> | ErrorReply;

/** server → client, zero or more per request before its reply. */
export interface ProgressFrame {
  op: 'progress';
  reqId?: RequestId;
  text: string;
}

/** server → client, exactly one per request: the reply with its op and reqId. */
export type ReplyFrame = { op: 'reply'; reqId?: RequestId } & Reply;

/** Anything the server writes to the socket. */
export type ServerFrame = ProgressFrame | ReplyFrame;

// 0 ok · 1 error · 2 usage or ambiguous · 3 not found · 4 app unreachable · 6 refused
const EXIT: Record<ErrorCode, ExitCode> = {
  ambiguous: 2, 'bad-request': 2,
  'not-found': 3,
  unreachable: 4, timeout: 4,
  'needs-yes': 6, 'not-open': 6, 'no-dev-server': 6, 'no-engine': 6, 'no-browser': 6, 'not-asking': 6, 'no-input': 6, unauthorized: 6,
  'node-missing': 1, error: 1,
};
function exitCodeFor(reply: { ok: true } | { ok: false; code: string } | null | undefined): ExitCode {
  if (!reply) return EXIT.unreachable;
  if (reply.ok) return 0;
  return Object.prototype.hasOwnProperty.call(EXIT, reply.code) ? EXIT[reply.code as ErrorCode] : 1;
}

function encode(msg: RequestFrame | ServerFrame): string { return JSON.stringify(msg) + '\n'; }

/** A stateful line decoder: feed chunks, get one callback per parseable JSON line. */
// It only checks for a JSON object (an array passes too), so each caller narrows,
// or casts at its own call site a frame the app itself wrote.
function makeDecoder(onMsg: (msg: Record<string, unknown>) => void): (chunk: string | Buffer) => void {
  let buf = '';
  return (chunk: string | Buffer) => {
    buf += String(chunk);
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let m: unknown; try { m = JSON.parse(line); } catch { continue; }
      if (m && typeof m === 'object') onMsg(m as Record<string, unknown>);
    }
  };
}

// The extra is spread last, so it may add detail but never carry ok, code or error.
type ErrExtra = ErrorDetails & { ok?: never; code?: never; error?: never };
function err(code: ErrorCode, error: string): ErrorReply;
function err<E extends object>(code: ErrorCode, error: string, extra: E & ErrExtra): ErrorReply & E;
function err(code: ErrorCode, error: string, extra?: object): ErrorReply { return { ok: false, code: CODES.includes(code) ? code : 'error', error, ...(extra || {}) }; }

export { PROTOCOL, CODES, EXIT, exitCodeFor, encode, makeDecoder, err };
