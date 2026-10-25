/**
 * Vercel Toolbar comments → Radial comments, one way, plus resolve-on-publish.
 *
 * Vercel has no comments API and no webhook; `vercel comments --json` (CLI 59.1
 * or newer) is the surface, and it is enough: list with cursor pagination,
 * inspect, resolve with a closing reply. Threads land in .radial/comments.json
 * next to Radial's own pins with ids `vercel-<threadId>`, so the Comments pane,
 * the canvas pins and every agent read them like any other
 * comment. Both sides anchor to a CSS-escaped selector (overlay.js cssPath
 * escapes too), so a Vercel selector passes through untouched.
 *
 * Ownership keeps the two sides from fighting:
 *  - Vercel owns what was said and where: text (replies folded in), route,
 *    selector, anchor, author, images. A pull overwrites them.
 *  - Radial owns `addressed`, the pin offsets and its own bookkeeping.
 *  - `resolved` moves forward only: a pull can resolve a comment, never reopen
 *    one resolved here. Comments without the prefix are never touched.
 *  - Resolving in Radial reaches Vercel after the next publish, with a note
 *    naming the pushed commit (resolvePushed).
 * Pulls are idempotent: an unchanged thread set writes nothing.
 */

import * as comments from './comments';
import type { StoredComment, StoredCommentAttachment } from './comments';
import type { VercelRunResult } from './vercel';
import type { VercelCommentInfo, VercelPullResult } from '../shared/radialApi';

/** Runs the Vercel CLI in `cwd` (main passes vercel.run with a timeout). */
export type VercelCliRun = (args: string[], options: { cwd: string }) => Promise<VercelRunResult>;
/** Downloads an attachment: globalThis.fetch, or a test's fake. */
export type VercelAttachmentFetch = (url: string, init?: { signal: AbortSignal }) => Promise<{ ok: boolean; headers?: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;
/** A message's author as the Vercel CLI prints it: a person or an app. */
export interface VercelAuthor { id?: string; name?: string; username?: string; type?: string; avatar?: string }
/** A thread's message: the first is the comment, the rest are replies. */
export interface VercelMessage { id?: string; author?: VercelAuthor | null; timestamp?: number; text?: string; attachments?: { url?: string; filename?: string }[] }
/** The reviewer's device, as the Toolbar recorded it. */
export interface VercelDevice { userAgent?: string; screenWidth?: number; screenHeight?: number; devicePixelRatio?: number }
/** Where a thread was left: the page, the element and its React component tree, and the device. */
export interface VercelThreadContext { href?: string; path?: string; pageTitle?: string; selector?: string; selection?: string; frameworkContext?: string; device?: VercelDevice | null }
/** A comment thread as `vercel comments list|inspect --json` prints it. */
export interface VercelThread {
  id: string;
  resolved?: boolean;
  resolvedBy?: VercelAuthor | null;
  branch?: string;
  webUrl?: string;
  isLocalhost?: boolean;
  /** How many messages the thread has; a listing may carry fewer. */
  messageCount?: number;
  context?: VercelThreadContext;
  messages?: VercelMessage[];
}
/** What `vercel comments … --json` prints, as this module reads it: a page of threads, one inspected thread, or an API error. */
export interface VercelCliOutput { threads?: VercelThread[]; pagination?: { nextCursor?: string | null }; messages?: VercelMessage[]; error?: { code?: string; message?: string } | null }
/** Why the Vercel CLI failed (classifyFailure): radialApi's VercelPullResult failure, with the codes that come from the CLI. */
export type VercelCliFailure = Extract<VercelPullResult, { ok: false }> & { code: 'unsupported-cli' | 'not-authed' | 'error' };
/** deviceOf()'s answer: a "platform · browser" label, the screen, and the viewport class that picks the canvas preset. */
export interface VercelDeviceInfo { label: string; w: number; h: number; dpr: number; viewport: VercelCommentInfo['viewport'] }
/** An attachment as mapThread lists it, before attachImages downloads it. */
export interface VercelAttachmentLink { url: string; name: string }
/** mapThread()'s answer: the Vercel-owned fields of the Radial comment a thread maps to. */
export interface VercelMappedThread {
  id: string;
  route: string;
  selector: string;
  alt: string[];
  selText: string;
  anchor: string;
  text: string;
  who: string;
  createdAt: number;
  resolved: boolean;
  resolvedBy: string;
  url: string;
  branch: string;
  vercel: VercelCommentInfo;
  /** mapThread's links, until attachImages replaces them with its records (rel null when not downloaded), which merge() stores. */
  attachments: VercelAttachmentLink[] | StoredCommentAttachment[];
  images: string[];
}
/** A mapped thread after attachImages: its attachments are attachImages' records (rel null when not downloaded), as merge() stores them. */
export type VercelSyncedThread = Omit<VercelMappedThread, 'attachments'> & { attachments: StoredCommentAttachment[] };
/** merge()'s answer: the comments to store, and what changed. */
export interface VercelMergeResult { arr: StoredComment[]; changed: boolean; added: number; updated: number; resolved: number }
/** pull()'s options: how to run the CLI, the team to try next, and how to download attachments (without it they stay links). */
export interface VercelPullOptions { run: VercelCliRun; scope?: string; orgId?: string; fetchImpl?: VercelAttachmentFetch }
/**
 * pull()'s answer: radialApi's VercelPullResult, less the failures main finds before pulling.
 * The success carries `code?: undefined` so main can read `r.code` before checking `ok`
 * (main.ts: `vcUnsupportedCli = r.code === 'unsupported-cli'`); radialApi's VercelPullResult needs the same.
 */
export type VercelPullOutcome = (Extract<VercelPullResult, { ok: true }> & { code?: undefined }) | VercelCliFailure;
/** resolvePushed()'s options: how to run the CLI, the team to retry in, the pushed commit for the note, and the clock for vercelPushedAt. */
export interface VercelResolveOptions { run: VercelCliRun; scope?: string; orgId?: string; sha?: string; now?: () => number }
/** resolvePushed()'s answer: the resolves sent, failed and pending, with the last failure's code and error. */
export interface VercelResolveResult { ok: boolean; done: number; failed: number; pending: number; code?: VercelCliFailure['code']; error?: string }

const PREFIX = 'vercel-';
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const FETCH_TIMEOUT_MS = 20000;
const MAX_ATTACHMENT_TRIES = 3;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const isSynced = (c: StoredComment | null | undefined): boolean => !!c && typeof c.id === 'string' && c.id.startsWith(PREFIX);
const lastLine = (txt: string): string => String(txt || '').split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean).pop() || '';

// The CLI prints a banner on stderr and, on API errors, `{ error }` on stdout
// with a non-zero exit. Take the outermost object from stdout whatever
// surrounds it.
function parseJson(stdout: string): VercelCliOutput | null {
  const s = String(stdout || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)) as VercelCliOutput; } catch { return null; }
}

function classifyFailure(r: VercelRunResult, parsed?: VercelCliOutput | null): VercelCliFailure {
  const txt = `${r.stderr || ''}\n${r.stdout || ''}`;
  if (/"comments" is not a valid|not a valid (target directory or )?subcommand/i.test(txt)) {
    return { ok: false, code: 'unsupported-cli', error: 'Vercel comments need the Vercel CLI 59.1 or newer (npm i -g vercel@latest).' };
  }
  const vercelCode = (parsed && parsed.error && parsed.error.code) ? String(parsed.error.code) : '';
  const msg = (parsed && parsed.error && parsed.error.message) ? String(parsed.error.message) : '';
  if (/No existing credentials|vercel login|not_authorized|unauthorized|forbidden/i.test(txt + ' ' + vercelCode)) {
    return { ok: false, code: 'not-authed', error: 'Sign in to the Vercel CLI (vercel login) to pull comments.' };
  }
  return { ok: false, code: 'error', error: msg || lastLine(txt) || 'The Vercel CLI failed.', vercelCode: vercelCode || undefined };
}

function authorLabel(a: VercelAuthor | null | undefined): string {
  if (!a) return '';
  const name = a.name || a.username || a.id || '';
  return a.type === 'app' && name ? `${name} (app)` : String(name);
}

// `href` carries the query string; `path` can be absent.
function routeOf(ctx: VercelThreadContext | null | undefined): string {
  if (ctx && ctx.href) { try { return new URL(String(ctx.href)).pathname || '/'; } catch { /* fall through */ } }
  const p = ctx && ctx.path ? String(ctx.path).split(/[?#]/)[0] : '';
  if (!p) return '/';
  return p.startsWith('/') ? p : '/' + p;
}

// Radial's anchor reads `<tag> “selected text”`: the tag from the selector's
// last compound (`section#pricing > div.flex > a.btn:nth-of-type(2)` → a).
function anchorOf(ctx: VercelThreadContext | null | undefined): string {
  const sel = String((ctx && ctx.selector) || '');
  const last = sel.split(/\s*>\s*|\s+/).filter(Boolean).pop() || '';
  const m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(last);
  const tag = m ? m[1].toLowerCase() : '';
  const text = String((ctx && ctx.selection) || '').replace(/\s+/g, ' ').trim();
  const quote = text ? `“${text.length > 60 ? text.slice(0, 59) + '…' : text}”` : '';
  if (tag && quote) return `<${tag}> ${quote}`;
  return tag ? `<${tag}>` : quote;
}

// The first message is the comment; replies fold in underneath so the pane and
// the agent see the whole conversation in one field.
function foldText(messages: VercelMessage[] | null | undefined): string {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return '';
  const first = String(list[0].text || '').trim();
  const replies = list.slice(1)
    .map((m) => ({ who: authorLabel(m.author) || 'Someone', text: String(m.text || '').trim() }))
    .filter((m) => m.text)
    .map((m) => `↳ ${m.who}: ${m.text}`);
  return [first, ...replies].join('\n');
}

// ── Everything else the CLI knows about a thread ────────────────────────────
// No pin coordinates come through (the Toolbar keeps those to itself), so
// "where it is on the live site" is rebuilt from what does: the element
// (selector, plus fallbacks for a DOM that differs locally), the reviewer's
// device (viewport class → the canvas preset), and the React component tree
// Vercel captured at the element (for the agent).

const cssEsc = (v: string): string => String(v).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);

// Fallback selectors, most specific first: the ancestors without their
// :nth-of-type() counts but the element keeping its own (dev and prod DOMs
// drift by a wrapper, not by which sibling was clicked), then every count
// dropped, then the tag.classes descriptor Vercel prints as "Selected: <div.a.b>".
function altSelectors(ctx: VercelThreadContext | null | undefined): string[] {
  const out: string[] = [];
  const sel = String((ctx && ctx.selector) || '');
  const push = (v: string) => { if (v && v !== sel && !out.includes(v)) out.push(v); };
  const parts = sel.split(/\s*>\s*/);
  const leaf = parts.pop() || '';
  const ancestorsRelaxed = [...parts.map((p) => p.replace(/:nth-of-type\(\d+\)/g, '')), leaf].join(' > ');
  if (parts.length) push(ancestorsRelaxed);
  push(sel.replace(/:nth-of-type\(\d+\)/g, ''));
  const m = /Selected:\s*<([a-zA-Z][a-zA-Z0-9-]*)((?:\.[^.\s>]+)*)>/.exec(String((ctx && ctx.frameworkContext) || ''));
  if (m) {
    const classes = m[2] ? m[2].split('.').filter(Boolean) : [];
    const d = m[1].toLowerCase() + classes.map((c) => '.' + cssEsc(c)).join('');
    if (d !== sel && !out.includes(d)) out.push(d);
  }
  return out;
}

// The component tree, minus the header and the minified framework frames:
// the last few lines are the section, wrappers and the element itself with
// their classNames, which is what places it in the source.
function treeLines(fc: string | null | undefined, max = 8): string[] {
  const lines = String(fc || '').split('\n').map((l) => l.trim())
    .filter((l) => l && !/^React Component Tree/i.test(l) && !/^Selected:/.test(l) && !/^\.\.\./.test(l) && !/\[minified\]/.test(l) && !/^<_\s/.test(l));
  return lines.slice(-max).map((l) => l.length > 160 ? l.slice(0, 159) + '…' : l);
}

function deviceOf(dev: VercelDevice | null | undefined): VercelDeviceInfo {
  const ua = String((dev && dev.userAgent) || '');
  const platform = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const w = Number(dev && dev.screenWidth) || 0, h = Number(dev && dev.screenHeight) || 0;
  const phone = /iPhone|Android.*Mobile/.test(ua) || (w > 0 && w <= 500);
  const tablet = !phone && (/iPad/.test(ua) || (w > 0 && w <= 1024));
  return {
    label: [platform, browser].filter(Boolean).join(' · '),
    w, h, dpr: Number(dev && dev.devicePixelRatio) || 0,
    viewport: phone ? 'mobile' : tablet ? 'tablet' : 'desktop',
  };
}

// The Vercel-owned fields of the Radial comment a thread maps to.
function mapThread(t: VercelThread): VercelMappedThread {
  const ctx = t.context || {};
  const msgs = Array.isArray(t.messages) ? t.messages : [];
  const attachments: VercelAttachmentLink[] = [];
  msgs.forEach((m) => (Array.isArray(m.attachments) ? m.attachments : []).forEach((a) => {
    if (a && a.url) attachments.push({ url: String(a.url), name: String(a.filename || '') });
  }));
  const first = msgs[0] || {};
  const dev = deviceOf(ctx.device);
  const vercel: VercelCommentInfo = {
    href: String(ctx.href || ''),
    path: String(ctx.path || ''),
    pageTitle: String(ctx.pageTitle || '').slice(0, 160),
    branch: String(t.branch || ''),
    localhost: !!t.isLocalhost,
    device: dev.label, screen: { w: dev.w, h: dev.h, dpr: dev.dpr }, viewport: dev.viewport,
    tree: treeLines(ctx.frameworkContext),
    avatar: String((first.author && first.author.avatar) || ''),
  };
  return {
    id: PREFIX + t.id,
    route: routeOf(ctx),
    selector: String(ctx.selector || ''),
    alt: altSelectors(ctx),
    selText: String(ctx.selection || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    anchor: anchorOf(ctx),
    text: foldText(msgs),
    who: authorLabel(first.author),
    createdAt: Number(first.timestamp) || 0,
    resolved: !!t.resolved,
    resolvedBy: (t.resolvedBy && (t.resolvedBy.name || t.resolvedBy.username)) ? String(t.resolvedBy.name || t.resolvedBy.username) : '',
    url: String(t.webUrl || ''),
    branch: String(t.branch || ''),
    vercel,
    attachments,
    images: [],
  };
}

// Merge mapped threads into the stored array. Untouched comments keep their
// position and content; new ones append oldest first.
function merge(existing: StoredComment[], mapped: VercelSyncedThread[]): VercelMergeResult {
  const arr = existing.map((c) => (c && typeof c === 'object' ? { ...c } : c));
  const byId = new Map<string, number>();
  arr.forEach((c, i) => { if (c && c.id) byId.set(c.id, i); });
  let added = 0, updated = 0, resolved = 0;
  for (const m of [...mapped].sort((a, b) => a.createdAt - b.createdAt)) {
    const i = byId.get(m.id);
    if (i == null) {
      arr.push({
        id: m.id, route: m.route, selector: m.selector, alt: m.alt, selText: m.selText, anchor: m.anchor, offsetX: null, offsetY: null, file: '', quote: '',
        text: m.text, who: m.who, images: m.images, resolved: m.resolved, resolvedBy: m.resolved ? (m.resolvedBy || 'Vercel') : '',
        createdAt: m.createdAt || Date.now(), addressed: false,
        source: 'vercel', url: m.url, branch: m.branch, vercel: m.vercel, attachments: m.attachments, vercelResolved: m.resolved,
      });
      added++;
      continue;
    }
    const c = arr[i];
    const before = JSON.stringify(c);
    c.route = m.route; c.selector = m.selector; c.alt = m.alt; c.selText = m.selText; c.anchor = m.anchor; c.text = m.text; c.who = m.who;
    c.images = m.images; c.attachments = m.attachments; c.url = m.url; c.branch = m.branch; c.vercel = m.vercel; c.source = 'vercel';
    if (m.createdAt) c.createdAt = m.createdAt;
    if (m.resolved && !c.resolved) { c.resolved = true; c.resolvedBy = m.resolvedBy || 'Vercel'; resolved++; }
    // What Vercel's side shows now; a resolve we pushed stays counted as done
    // even if the listing lags (or someone reopened it there: forward only).
    if (m.resolved) c.vercelResolved = true; else if (!c.vercelPushedAt) c.vercelResolved = false;
    if (JSON.stringify(c) !== before) updated++;
  }
  return { arr, changed: added > 0 || updated > 0, added, updated, resolved };
}

function extOf(name: string | undefined, type: string | undefined): string {
  const m = /\.(png|jpe?g|gif|webp|svg|avif)$/i.exec(name || '');
  if (m) return '.' + m[1].toLowerCase();
  const t = String(type || '').toLowerCase();
  if (t.includes('jpeg') || t.includes('jpg')) return '.jpg';
  if (t.includes('gif')) return '.gif';
  if (t.includes('webp')) return '.webp';
  if (t.includes('svg')) return '.svg';
  return '.png';
}

async function download(fetchImpl: VercelAttachmentFetch, url: string): Promise<{ bytes: Buffer; type: string } | null> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { try { if (ctl) ctl.abort(); } catch { /* ignore */ } }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, ctl ? { signal: ctl.signal } : undefined);
    if (!res || !res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_ATTACHMENT_BYTES) return null;
    const type = res.headers && typeof res.headers.get === 'function' ? (res.headers.get('content-type') || '') : '';
    return { bytes: buf, type };
  } catch { return null; } finally { clearTimeout(timer); }
}

// Attachments are plain public URLs. Download each once into
// .radial/comment-images (the agent reads paths, not URLs); one that keeps
// failing stays in the text as a link so nothing points at a missing file.
async function attachImages(repoDir: string, m: VercelMappedThread, prev: StoredComment | undefined, fetchImpl: VercelAttachmentFetch | undefined): Promise<void> {
  const prevMap = new Map(((prev && Array.isArray(prev.attachments)) ? prev.attachments : []).map((a) => [a.url, a]));
  const out: StoredCommentAttachment[] = []; const images: string[] = []; const failed: string[] = [];
  for (const a of m.attachments as VercelAttachmentLink[]) { // still mapThread's links: pull runs this once per thread
    const had = prevMap.get(a.url);
    if (had && had.rel) { out.push({ url: a.url, rel: had.rel }); images.push(had.rel); continue; }
    const tries = (had && had.tries) || 0;
    if (tries >= MAX_ATTACHMENT_TRIES || !fetchImpl) { out.push({ url: a.url, rel: null, tries }); failed.push(a.url); continue; }
    const got = await download(fetchImpl, a.url);
    if (got) {
      const saved = comments.saveImage(repoDir, `vercel-${m.id.slice(PREFIX.length)}-${out.length + 1}${extOf(a.name, got.type)}`, got.bytes);
      if (saved && saved.ok) { out.push({ url: a.url, rel: saved.rel }); images.push(saved.rel); continue; }
    }
    out.push({ url: a.url, rel: null, tries: tries + 1 }); failed.push(a.url);
  }
  m.attachments = out; m.images = images;
  if (failed.length) m.text += (m.text ? '\n' : '') + failed.map((u) => `(attachment: ${u})`).join('\n');
}

// A linked folder resolves its project and team by itself (the CLI reads
// .vercel/project.json). When it still lands in the wrong team, the known
// scope (or the link's orgId) is the second try.
async function listThreads(run: VercelCliRun, cwd: string, { scope, orgId }: { scope?: string; orgId?: string }): Promise<{ ok: true; threads: VercelThread[]; scopeArgs: string[] } | VercelCliFailure> {
  const variants: string[][] = [[]];
  if (scope) variants.push(['--scope', scope]);
  if (orgId && orgId !== scope) variants.push(['--scope', orgId]);
  let last: VercelCliFailure | null = null;
  for (const scopeArgs of variants) {
    const threads: VercelThread[] = []; let cursor: string | null | undefined = null; let failed: VercelCliFailure | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const args = ['comments', 'list', '--json', '--status', 'all', '--all-branches', '--limit', String(PAGE_LIMIT), ...(cursor ? ['--next', cursor] : []), ...scopeArgs];
      const r = await run(args, { cwd });
      const j = parseJson(r.stdout);
      if (!r.ok || !j || j.error || !Array.isArray(j.threads)) { failed = classifyFailure(r, j); break; }
      threads.push(...j.threads.filter((t) => t && t.id));
      cursor = j.pagination && j.pagination.nextCursor;
      if (!cursor) break;
    }
    if (!failed) return { ok: true, threads, scopeArgs };
    last = failed;
    if (failed.code !== 'error' || !/PROJECT_NOT_FOUND|scope|team/i.test(`${failed.vercelCode || ''} ${failed.error}`)) return failed;
  }
  return last!; // variants is never empty, so a failed try set it
}

/**
 * Pull every thread of the linked project into .radial/comments.json.
 * `run(args, {cwd})` runs the Vercel CLI → { ok, stdout, stderr }.
 * Returns { ok, total, added, updated, resolved, changed } or { ok:false, code, error }
 * with code ∈ unsupported-cli | not-authed | error.
 */
// Callers pass `run` (this overload); the implementation keeps its original
// `= {}` default, which no typed caller can reach.
function pull(repoDir: string, options: VercelPullOptions): Promise<VercelPullOutcome>;
async function pull(repoDir: string, { run, scope, orgId, fetchImpl }: VercelPullOptions = {} as VercelPullOptions): Promise<VercelPullOutcome> {
  const first = comments.readStrict(repoDir);
  if (!first.ok) return { ok: false, code: 'error', error: first.error };
  const listed = await listThreads(run, repoDir, { scope, orgId });
  if (!listed.ok) return listed;
  for (const t of listed.threads) {
    if (Number(t.messageCount) > (Array.isArray(t.messages) ? t.messages.length : 0)) {
      const r = await run(['comments', 'inspect', t.id, '--json', ...listed.scopeArgs], { cwd: repoDir });
      const j = parseJson(r.stdout);
      if (r.ok && j && Array.isArray(j.messages)) t.messages = j.messages;
    }
  }
  const prevById = new Map(first.arr.filter((c) => c && c.id).map((c) => [c.id, c]));
  const mapped: VercelSyncedThread[] = [];
  for (const t of listed.threads) {
    const m = mapThread(t);
    await attachImages(repoDir, m, prevById.get(m.id), fetchImpl);
    mapped.push(m as VercelSyncedThread); // attachImages just replaced the links
  }
  // Re-read right before writing: the listing and downloads took a while and
  // the pane may have resolved or added something meanwhile.
  const fresh = comments.readStrict(repoDir);
  if (!fresh.ok) return { ok: false, code: 'error', error: fresh.error };
  const res = merge(fresh.arr, mapped);
  if (res.changed) comments.save(repoDir, res.arr);
  return { ok: true, total: listed.threads.length, added: res.added, updated: res.updated, resolved: res.resolved, changed: res.changed };
}

// Comments resolved in Radial that Vercel still shows open.
function pendingResolves(repoDir: string): StoredComment[] {
  return comments.list(repoDir).filter((c) => isSynced(c) && c.resolved && !c.vercelResolved && !c.vercelPushedAt);
}

/**
 * After a publish: resolve on Vercel every synced comment resolved here, with a
 * closing reply naming the pushed commit. Best effort, one thread at a time;
 * each success is recorded so it is never sent twice.
 */
// Callers pass `run` (this overload); the implementation keeps its original
// `= {}` default, which no typed caller can reach.
function resolvePushed(repoDir: string, options: VercelResolveOptions): Promise<VercelResolveResult>;
async function resolvePushed(repoDir: string, { run, scope, orgId, sha, now }: VercelResolveOptions = {} as VercelResolveOptions): Promise<VercelResolveResult> {
  const list = pendingResolves(repoDir);
  const stamp = typeof now === 'function' ? now : Date.now;
  let done = 0, failed = 0, last: VercelCliFailure | null = null;
  for (const c of list) {
    const id = c.id.slice(PREFIX.length);
    const message = sha ? `Resolved in Radial, pushed as ${sha}` : 'Resolved in Radial';
    const args = ['comments', 'resolve', id, '-m', message, '--yes', '--json'];
    const scopeArgs = scope ? ['--scope', scope] : (orgId ? ['--scope', orgId] : []);
    let r = await run(args, { cwd: repoDir });
    let j = parseJson(r.stdout);
    if ((!r.ok || (j && j.error)) && scopeArgs.length) { r = await run([...args, ...scopeArgs], { cwd: repoDir }); j = parseJson(r.stdout); }
    if (r.ok && !(j && j.error)) { comments.update(repoDir, c.id, { vercelResolved: true, vercelPushedAt: stamp() }); done++; continue; }
    failed++; last = classifyFailure(r, j);
    if (last.code !== 'error') break; // auth or CLI problems fail every thread the same way
  }
  return { ok: !failed, done, failed, pending: list.length, ...(last ? { code: last.code, error: last.error } : {}) };
}

export { PREFIX, isSynced, parseJson, classifyFailure, mapThread, merge, pull, pendingResolves, resolvePushed, anchorOf, routeOf, foldText, authorLabel, altSelectors, treeLines, deviceOf };
