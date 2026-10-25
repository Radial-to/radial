import * as projectData from './projectData';

/**
 * Review comments pinned to elements on a page. Stored in .radial/comments.json,
 * which is local-only (gitignored) and kept out of the deployed site — they're
 * working annotations, not repo content. Each comment anchors to a route + CSS
 * selector so the agent can act on exactly what was flagged.
 */

import fs from 'fs';
import path from 'path';
import type { NewComment, OkOrError, RadialApi, ReviewComment } from '../shared/radialApi';

/** A Vercel comment's attachment as comments.json stores it (vercelComments.attachImages): `rel` is the downloaded copy, null while the download keeps failing (`tries` counts the failures). */
export interface StoredCommentAttachment { url: string; rel: string | null; tries?: number }
/**
 * A record in .radial/comments.json, the shape commentsList sends the window.
 * radialApi's ReviewComment except `attachments`: radialApi declares the
 * pre-download `{ url, name }`, but vercelComments stores the downloaded copies.
 * Reads check that each entry is an object and trust its fields (agents edit
 * the file too).
 */
export interface StoredComment extends Omit<ReviewComment, 'attachments'> { attachments?: StoredCommentAttachment[] }
/** readStrict(): the stored comments, or why the file can't be written over. */
export type CommentsRead = { ok: true; arr: StoredComment[] } | { ok: false; error: string };
/** add() and update() refuse with the readStrict error when the file is malformed (radialApi's commentsAdd and commentsUpdate refusal). */
export type CommentsRefusal = Exclude<Awaited<ReturnType<RadialApi['commentsAdd']>>, ReviewComment>;
/** importImage(): the copy's path as the comment stores it (repo-relative, or absolute for local storage) and on disk (radialApi's commentsImportImage reply). */
export type CommentImageImport = Awaited<ReturnType<RadialApi['commentsImportImage']>>;
/** saveImage(): the saved image's path as the comment stores it (radialApi's commentsSaveImage reply). */
export type CommentImageSave = Awaited<ReturnType<RadialApi['commentsSaveImage']>>;

let seq = 0;
function file(repoDir: string): string { return projectData.dataDir(repoDir, 'comments.json'); }

function ensureVercelignore(repoDir: string): void {
  if (projectData.isLocal(repoDir)) return;
  const vi = path.join(repoDir, '.vercelignore');
  let content = '';
  try { content = fs.readFileSync(vi, 'utf8'); } catch {}
  if (content.split(/\r?\n/).some((l) => l.trim() === '.radial/' || l.trim() === '.radial')) return;
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  try { fs.writeFileSync(vi, content + `${prefix}# Radial — kept in the repo, not deployed\n.radial/\n`, 'utf8'); } catch {}
}

// An entry the module can read as a comment: a JSON object. Agents edit the
// file too, so an entry may be anything (null, a string); its fields are trusted.
function isComment(c: unknown): c is StoredComment { return !!c && typeof c === 'object' && !Array.isArray(c); }

function list(repoDir: string): StoredComment[] {
  try {
    const arr: unknown = JSON.parse(fs.readFileSync(file(repoDir), 'utf8'));
    if (!Array.isArray(arr)) return [];
    // An entry that isn't an object is skipped, so it can't break or hide the others.
    const stored = arr.filter(isComment);
    return projectData.isLocal(repoDir) ? stored.map((c) => ({ ...c, images: (c.images || []).map(image => projectData.resolveReference(repoDir, image)) })) : stored;
  }
  catch { return []; }
}

// Strict read for WRITE paths. list() stays tolerant (a malformed file reads
// as no comments, a malformed entry as absent), but a mutation built on that
// tolerance would save over the user's data. External agents edit this file
// now (the AGENTS.md contract), so a bad agent write must make mutations
// refuse, not wipe.
function readStrict(repoDir: string): CommentsRead {
  let raw = '';
  try { raw = fs.readFileSync(file(repoDir), 'utf8'); } catch { return { ok: true, arr: [] }; }
  if (!raw.trim()) return { ok: true, arr: [] };
  try {
    const arr: unknown = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.every(isComment) ? { ok: true, arr } : { ok: false, error: 'The comments file has an entry that is not a JSON object. Fix the file (or ask your agent to) and try again.' };
  } catch {}
  return { ok: false, error: 'The comments file is not a valid JSON array. Fix the file (or ask your agent to) and try again.' };
}

// Atomic: temp file + rename. The 1s mtime poll (main.js) and outside agents
// read this file whenever they like; a half-written array must never be seen.
function save(repoDir: string, arr: StoredComment[]): void {
  fs.mkdirSync(projectData.dataDir(repoDir), { recursive: true });
  const target = file(repoDir);
  const tmp = target + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
  ensureVercelignore(repoDir);
}

function add(repoDir: string, comment: NewComment): StoredComment | CommentsRefusal {
  const strict = readStrict(repoDir);
  if (!strict.ok) return { error: strict.error };
  const arr = strict.arr;
  const item: StoredComment = {
    id: 'c' + Date.now().toString(36) + (++seq).toString(36),
    // Page comments anchor to a route + CSS selector; context-file comments
    // anchor to a repo-relative file + the quoted passage. A comment uses one
    // or the other (file is empty for page comments).
    route: comment.route || '/',
    selector: comment.selector || '',
    anchor: comment.anchor || '',
    // Click position within the element as a 0..1 fraction — the pin lands where
    // you clicked and tracks the element responsively.
    offsetX: (typeof comment.offsetX === 'number' ? comment.offsetX : null),
    offsetY: (typeof comment.offsetY === 'number' ? comment.offsetY : null),
    file: comment.file || '',     // repo-relative context file (e.g. .context/notes.md)
    quote: comment.quote || '',   // the selected passage within that file
    text: comment.text || '',
    who: comment.who || '', // author (teammate name in a shared session; empty = you)
    images: Array.isArray(comment.images) ? comment.images : [], // repo-relative paths
    resolved: false,
    createdAt: comment.createdAt || Date.now(),
  };
  arr.push(item);
  save(repoDir, arr);
  return item;
}

// Copy an attached image into .radial/comment-images/ so it travels with the
// repo (and the agent, cwd=repoDir, can read it). Returns its repo-relative path.
function importImage(repoDir: string, srcPath: string): CommentImageImport {
  try {
    if (!srcPath || !fs.existsSync(srcPath)) return { ok: false };
    const dir = projectData.dataDir(repoDir, 'comment-images');
    fs.mkdirSync(dir, { recursive: true });
    let name = (path.basename(srcPath) || 'image').replace(/[^a-zA-Z0-9._-]/g, '-');
    const ext = path.extname(name); const base = ext ? name.slice(0, -ext.length) : name;
    let fname = name, i = 2;
    while (fs.existsSync(path.join(dir, fname))) { fname = `${base}-${i}${ext}`; i++; }
    fs.copyFileSync(srcPath, path.join(dir, fname));
    ensureVercelignore(repoDir);
    return { ok: true, rel: projectData.reference(repoDir, path.join(dir, fname)), abs: path.join(dir, fname) };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

function update(repoDir: string, id: string, patch: Partial<StoredComment>): StoredComment | CommentsRefusal | null {
  const strict = readStrict(repoDir);
  if (!strict.ok) return { error: strict.error };
  const arr = strict.arr;
  const c = arr.find((x) => x.id === id);
  if (!c) return null;
  Object.assign(c, patch);
  save(repoDir, arr);
  return c;
}

function remove(repoDir: string, id: string): OkOrError {
  const strict = readStrict(repoDir);
  if (!strict.ok) return { ok: false, error: strict.error };
  save(repoDir, strict.arr.filter((x) => x.id !== id));
  return { ok: true };
}

// Write raw image bytes (from a file picker or a paste) into .radial/comment-images/.
function saveImage(repoDir: string, name: string, bytes: Uint8Array | readonly number[]): CommentImageSave {
  try {
    const dir = projectData.dataDir(repoDir, 'comment-images');
    fs.mkdirSync(dir, { recursive: true });
    let safe = (name || 'image.png').replace(/[^a-zA-Z0-9._-]/g, '-');
    if (!/\.[a-z0-9]+$/i.test(safe)) safe += '.png';
    const ext = path.extname(safe); const base = safe.slice(0, -ext.length);
    let fname = safe, i = 2;
    while (fs.existsSync(path.join(dir, fname))) { fname = `${base}-${i}${ext}`; i++; }
    fs.writeFileSync(path.join(dir, fname), Buffer.from(bytes));
    ensureVercelignore(repoDir);
    return { ok: true, rel: projectData.reference(repoDir, path.join(dir, fname)) };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export { list, readStrict, save, add, update, remove, importImage, saveImage };
