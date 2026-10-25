/**
 * radial serve's API tokens (plans/headless-core.md, phase 4): what every HTTP
 * caller of `radial serve --listen` sends as `Authorization: Bearer <token>`,
 * on /mcp, /rpc, /events and file downloads alike, even on loopback, where the
 * other users of a shared machine can reach the port too. The approach is
 * radial-cloud's (src/lib/apiTokens.ts), copied here:
 * - a token is `rcore_` and 43 random characters (32 bytes): a prefix of its
 *   own, apart from Radial Cloud's `rad_`, so people and leak scanners can
 *   tell the two apart;
 * - it shows once, when it's made. The data dir keeps its SHA-256 only, in
 *   api-tokens.json (mode 0600), with its name, a short prefix and when it
 *   was made;
 * - a check hashes what came and compares it with every stored hash in
 *   constant time;
 * - `radial token create|list|revoke` edits the file. A running serve reads it
 *   again whenever it changes: a revoked token is refused from the next
 *   request on, and its open event streams end within half a second (watch);
 * - when each token was last used goes in api-tokens-used.json, which only
 *   serve writes, so serve never writes back a token the CLI just revoked.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { CliIo, Flags } from '../main/cli';
import * as dataDirs from '../main/dataDirs';

/** Every token starts with it. */
export const PREFIX = 'rcore_';
/** What a token looks like: the prefix and 43 base64url characters. */
const SHAPE = /^rcore_[A-Za-z0-9_-]{43}$/;
/** How much of a token `radial token list` shows: the prefix and 4 of its random characters. */
const SHOWN = PREFIX.length + 4;
/** How often serve looks at the file for a change its requests haven't caught yet (a revoke while only event streams are open). */
const WATCH_MS = 500;
/** How often serve writes down when its tokens were last used. */
const USED_FLUSH_MS = 60 * 1000;

/** One token as the data dir keeps it: never the token, only its hash. */
export interface StoredToken {
  id: string;
  name: string;
  /** SHA-256 of the token, hex. */
  hash: string;
  /** Its first characters, to tell tokens apart in a list. */
  prefix: string;
  createdAt: number;
}
/** A token as `radial token list` shows it. */
export interface TokenRow { id: string; name: string; prefix: string; createdAt: number; lastUsedAt: number | null }

/** api-tokens.json: the tokens serve accepts. */
export const tokensFile = (dataDir: string): string => path.join(dataDir, 'api-tokens.json');
/** api-tokens-used.json: when serve last saw each one. */
const usedFile = (dataDir: string): string => path.join(dataDir, 'api-tokens-used.json');

/** SHA-256 of a token, hex. */
export function hashToken(token: string): string { return crypto.createHash('sha256').update(token, 'utf8').digest('hex'); }

function read(dataDir: string): StoredToken[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(tokensFile(dataDir), 'utf8')) as { tokens?: unknown };
    return Array.isArray(parsed.tokens) ? (parsed.tokens as StoredToken[]).filter((t) => t && typeof t.hash === 'string' && /^[0-9a-f]{64}$/.test(t.hash) && typeof t.id === 'string') : [];
  } catch { return []; }
}
/** Writes the file whole (a new file renamed over the old one, mode 0600), so a reader never sees half of it. */
function write(dataDir: string, tokens: StoredToken[]): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = tokensFile(dataDir);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify({ tokens }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // the mode above only applies to a file that didn't exist, and the umask may have taken some
  fs.renameSync(tmp, file);
}
/**
 * Runs fn with the tokens file to itself: a second `radial token` writing at
 * the same moment waits, so neither undoes the other (a create that read the
 * file before a revoke would otherwise write the revoked token back). The lock
 * is a folder, made atomically; one older than 10 s was left by a command that
 * died, and goes.
 */
function locked<T>(dataDir: string, fn: () => T, waitMs = 5000): T {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); // a new data dir is this user's alone
  const lock = tokensFile(dataDir) + '.lock';
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmdirSync(lock); continue; } } catch { continue; } // gone meanwhile: try again
      if (Date.now() > deadline) throw new Error(`Another radial token command is changing the tokens. If none is running, remove ${lock} and try again.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); // a short pause; the CLI has nothing else to do meanwhile
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}
function readUsed(dataDir: string): Record<string, number> {
  try { const used = JSON.parse(fs.readFileSync(usedFile(dataDir), 'utf8')) as unknown; return used && typeof used === 'object' && !Array.isArray(used) ? used as Record<string, number> : {}; } catch { return {}; }
}

/** What create answers: the new token (shown this once) and its row, or why not. */
export type CreateResult = { ok: true; token: string; row: TokenRow } | { ok: false; code: 'exists' | 'bad-request'; error: string };

/** Makes a token named name (token-1, token-2… when none is given): a new random token, of which the data dir keeps the hash. */
export function create(dataDir: string, name?: string | null, now: number = Date.now()): CreateResult {
  let label = String(name || '').trim();
  if (label && !/^[\w.@-]{1,40}$/.test(label)) return { ok: false, code: 'bad-request', error: 'A token name is up to 40 letters, digits, dots, dashes, underscores or @, like laptop or ci.' };
  return locked(dataDir, (): CreateResult => {
    const tokens = read(dataDir);
    if (label && tokens.some((t) => t.name === label)) return { ok: false, code: 'exists', error: `There is already a token named ${label}. Pick another name, or revoke that one first (radial token revoke ${label}).` };
    if (!label) { let n = tokens.length + 1; while (tokens.some((t) => t.name === `token-${n}`)) n++; label = `token-${n}`; }
    const token = PREFIX + crypto.randomBytes(32).toString('base64url');
    const stored: StoredToken = { id: crypto.randomBytes(4).toString('hex'), name: label, hash: hashToken(token), prefix: token.slice(0, SHOWN), createdAt: now };
    write(dataDir, [...tokens, stored]);
    return { ok: true, token, row: { id: stored.id, name: stored.name, prefix: stored.prefix, createdAt: stored.createdAt, lastUsedAt: null } };
  });
}

/** The tokens serve accepts, oldest first, with when serve last saw each. */
export function list(dataDir: string): TokenRow[] {
  const used = readUsed(dataDir);
  return read(dataDir).map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, createdAt: t.createdAt, lastUsedAt: typeof used[t.id] === 'number' ? used[t.id] : null }));
}

/** What revoke answers. */
export type RevokeResult = { ok: true; row: TokenRow } | { ok: false; code: 'not-found' | 'bad-request'; error: string };

/** Revokes one token, by its id or its name: it goes from the file, and serve refuses it from its next request on. */
export function revoke(dataDir: string, which: string): RevokeResult {
  const key = String(which || '').trim();
  if (!key) return { ok: false, code: 'bad-request', error: 'Say which token: radial token revoke <id or name> (radial token list shows them).' };
  return locked(dataDir, (): RevokeResult => {
    const rows = list(dataDir);
    const row = rows.find((t) => t.id === key) || rows.find((t) => t.name === key);
    if (!row) return { ok: false, code: 'not-found', error: `No token ${key}. radial token list shows them.` };
    write(dataDir, read(dataDir).filter((t) => t.id !== row.id));
    return { ok: true, row };
  });
}

/** A request's token as the store judged it: whose it is, or why it was refused (none sent, or not one serve accepts). */
export type TokenCheck = { ok: true; id: string; name: string } | { ok: false; why: 'missing' | 'invalid' };

/** The token in an Authorization header (`Bearer <token>`), or null when there's none. */
export function bearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(value || '');
  return m ? m[1] : null;
}

/** serve's view of its tokens: it checks requests against them, and hears when they change. */
export interface TokenStore {
  /** A request's Authorization header, judged. */
  check(authorization: string | string[] | undefined): TokenCheck;
  /** Whether a token (by id) is still accepted: an open event stream's, or a share link's maker. */
  isLive(id: string): boolean;
  /** How many tokens there are (serve says how to make one when there are none). */
  count(): number;
  /** Calls fn whenever the file changes (a token made or revoked); answers how to stop. */
  onChange(fn: () => void): () => void;
  /** Stops watching, and writes down when the tokens were last used. */
  close(): void;
}

/** radial serve's token store on a data dir: the file read now, and again whenever it changes. */
export function store(dataDir: string, { now = Date.now, watchMs = WATCH_MS }: { now?: () => number; watchMs?: number } = {}): TokenStore {
  let tokens: StoredToken[] = [];
  let signature = '';
  const used = new Map<string, number>();
  let usedDirty = false;
  const listeners = new Set<() => void>();
  // The file's identity: a write renames a new file over it, so its inode changes even when its size and time don't.
  const sign = (): string => { try { const st = fs.statSync(tokensFile(dataDir)); return `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { return 'none'; } };
  /**
   * Reads the file again when it changed, and then tells the listeners, whoever
   * noticed first (a request, an isLive, the watch): a change is noticed once.
   */
  const refresh = (): void => {
    const sig = sign();
    if (sig === signature) return;
    signature = sig;
    tokens = read(dataDir);
    for (const fn of [...listeners]) { try { fn(); } catch {} } // a listener's own isLive finds nothing new
  };
  refresh();
  const watch = setInterval(refresh, watchMs);
  watch.unref();
  const flushUsed = () => {
    if (!usedDirty) return;
    usedDirty = false;
    const live = new Set(tokens.map((t) => t.id));
    const out: Record<string, number> = {};
    for (const [id, at] of used) if (live.has(id)) out[id] = at;
    try { fs.writeFileSync(usedFile(dataDir), JSON.stringify(out, null, 2) + '\n', { mode: 0o600 }); } catch {}
  };
  const flusher = setInterval(flushUsed, USED_FLUSH_MS);
  flusher.unref();

  return {
    check(authorization) {
      const token = bearer(authorization);
      if (!token) return { ok: false, why: 'missing' };
      refresh(); // a revoke takes effect at once, not at the next watch tick
      // The shape isn't secret: a string that can't be a token is refused before any hashing.
      if (!SHAPE.test(token)) return { ok: false, why: 'invalid' };
      const presented = Buffer.from(hashToken(token), 'hex');
      // Every stored hash is compared, the whole of each, whichever matches: the time taken says nothing about the token.
      let match: StoredToken | null = null;
      for (const t of tokens) { if (crypto.timingSafeEqual(presented, Buffer.from(t.hash, 'hex')) && !match) match = t; }
      if (!match) return { ok: false, why: 'invalid' };
      used.set(match.id, now());
      usedDirty = true;
      return { ok: true, id: match.id, name: match.name };
    },
    isLive(id) { refresh(); return tokens.some((t) => t.id === id); },
    count() { refresh(); return tokens.length; },
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    close() { clearInterval(watch); clearInterval(flusher); listeners.clear(); flushUsed(); },
  };
}

/** When something happened, for a person: "3 min ago", "2 days ago". */
function ago(at: number | null, now: number): string {
  if (!at) return 'never used';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'used just now';
  const [n, unit] = s < 3600 ? [Math.round(s / 60), 'min'] : s < 86400 ? [Math.round(s / 3600), 'hour'] : [Math.round(s / 86400), 'day'];
  return `last used ${n} ${unit}${n === 1 || unit === 'min' ? '' : 's'} ago`;
}
const day = (at: number): string => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

/**
 * `radial token create [name] | list | revoke <id or name>` as the CLI runs it,
 * on the headless core's data dir (where `radial serve` looks). A token shows
 * once, at create. Exit codes: 0, 2 usage, 3 no such token, 6 refused (a name
 * already in use).
 */
export async function command(positional: string[], flags: Flags, io: Pick<CliIo, 'stdout' | 'stderr' | 'env'>, listenAddress: string | null = null): Promise<number> {
  const dataDir = dataDirs.headlessDataDir(io.env);
  const json = !!flags.json;
  const fail = (code: string, error: string, exit: number): number => {
    if (json) io.stdout.write(JSON.stringify({ ok: false, code, error }) + '\n'); else io.stderr.write(`radial: ${error}\n`);
    return exit;
  };
  const [action, arg] = positional;
  if (action === 'create') {
    const r = create(dataDir, arg || null);
    if (!r.ok) return fail(r.code, r.error, r.code === 'exists' ? 6 : 2);
    if (json) { io.stdout.write(JSON.stringify({ ok: true, token: r.token, ...r.row }) + '\n'); return 0; }
    const url = listenAddress || 'http://127.0.0.1:<port>';
    io.stdout.write([
      `Made the token ${r.row.name} (${r.row.prefix}…). It shows only now, so keep it somewhere safe:`,
      '',
      r.token,
      '',
      'radial serve --listen takes it in an Authorization header (Bearer) on every request: MCP at /mcp, the CLI at /rpc, events at /events.',
      `For the CLI on another machine: RADIAL_URL=${url} RADIAL_TOKEN=<the token> radial ls`,
      `For an MCP client: ${url}/mcp, with the header Authorization: Bearer <the token>.`,
      '',
    ].join('\n'));
    return 0;
  }
  if (action === 'list' || !action) {
    const rows = list(dataDir);
    if (json) { io.stdout.write(JSON.stringify({ ok: true, tokens: rows }) + '\n'); return 0; }
    if (!rows.length) { io.stdout.write('No tokens yet. `radial token create <name>` makes one for radial serve --listen.\n'); return 0; }
    const now = Date.now();
    const w = Math.max(...rows.map((t) => t.name.length));
    for (const t of rows) io.stdout.write(`${t.name.padEnd(w)}  ${t.id}  ${t.prefix}…  made ${day(t.createdAt)}, ${ago(t.lastUsedAt, now)}\n`);
    return 0;
  }
  if (action === 'revoke') {
    const r = revoke(dataDir, arg || '');
    if (!r.ok) return fail(r.code, r.error, r.code === 'not-found' ? 3 : 2);
    if (json) io.stdout.write(JSON.stringify({ ok: true, revoked: r.row }) + '\n');
    else io.stdout.write(`Revoked ${r.row.name} (${r.row.id}). radial serve refuses it from now on.\n`);
    return 0;
  }
  return fail('bad-request', `Unknown token command: ${action}. Use radial token create [name], radial token list or radial token revoke <id or name>.`, 2);
}
