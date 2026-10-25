import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import type { ExecFileException } from 'child_process';
import { promisify } from 'util';
import { childEnv, which } from '../env';
import type { ChatAttachmentUpload, ChatFile, ChatFileMatch, ChatFilePreview, ChatResourceResult } from '../../shared/radialApi';
/** What a file lookup needs from a chat: the project its references resolve against. */
export interface ChatFileScope { repoDir: string }
/** A file reference resolved to a real file inside the project or the attachments folder. */
export interface ResolvedChatFile { file: string; name: string; size: number; mime: string; line: number }
/** A file to attach: the window's ChatAttachmentUpload, or the same with the bytes as a plain array (the tests pass one). */
export interface ChatFileUpload extends Omit<ChatAttachmentUpload, 'bytes'> { bytes: ChatAttachmentUpload['bytes'] | readonly number[] }
/** nativeChat:resource's describe reply (describe): the file, and a data: URL for an image preview. */
export type ChatFileDescription = Extract<ChatResourceResult, ChatFile>;
const previewTypes: Partial<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' };
const LIMIT = 20 * 1024 * 1024;
function within(root: string, target: string): boolean { const rel = path.relative(root, target); return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); }
const SKIP_DIRS = ['.git', 'node_modules', 'dist', 'build'];
const listable = (file: string): boolean => !file.split('/').some(part => SKIP_DIRS.includes(part)) && !path.basename(file).startsWith('.env') && !file.endsWith('.lock');
// ripgrep is optional on a Mac. Without it, a git repo lists what rg would
// (tracked and untracked files, .gitignore respected) and anything else is walked.
async function projectFiles(dir: string, rg: string | null = which('rg')): Promise<string[]> {
  const options = { cwd: dir, env: childEnv(), maxBuffer: 4 * 1024 * 1024, timeout: 5000 }, run = promisify(execFile);
  if (rg) {
    const { stdout } = await run(rg, ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules', '-g', '!dist', '-g', '!build', '-g', '!.env*', '-g', '!*.lock'], options).catch((error: unknown) => { if ((error as ExecFileException).code === 1) return { stdout: '' }; throw error; });
    return stdout.split('\n');
  }
  const git = await run(which('git') || 'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], options).catch(() => null);
  if (git) return git.stdout.split('\0');
  const files: string[] = [], dirs = [''];
  while (dirs.length && files.length < 20000) {
    const rel = dirs.pop()!;
    let entries; try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { if (!SKIP_DIRS.includes(entry.name)) dirs.push(file); } else if (entry.isFile()) files.push(file);
    }
  }
  return files;
}
class ChatResources {
  declare root: string;
  constructor(root: string) { this.root = root; }
  resolve(session: ChatFileScope, reference: string): ResolvedChatFile {
    if (typeof reference !== 'string' || !reference || reference.includes('\0')) throw new Error('Invalid file reference.');
    let value; try { value = decodeURIComponent(reference); } catch { throw new Error('Invalid file reference.'); }
    const location = value.match(/(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?)$/);
    if (location) value = value.slice(0, location.index);
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) throw new Error('Use a local project file.');
    const file = fs.realpathSync(path.resolve(session.repoDir, value));
    const roots = [fs.realpathSync(session.repoDir)];
    if (fs.existsSync(this.root)) roots.push(fs.realpathSync(this.root));
    if (!roots.some(root => within(root, file))) throw new Error('This file is outside this chat’s project. Attach it first to use it here.');
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('Choose a file, not a folder.');
    return { file, name: path.basename(file), size: stat.size, mime: previewTypes[path.extname(file).toLowerCase()] || '', line: Number(location?.[1] || location?.[2]) || 1 };
  }
  describe(session: ChatFileScope, reference: string, preview = false): ChatFileDescription {
    const item = this.resolve(session, reference);
    return { path: item.file, name: item.name, size: item.size, mime: item.mime, ...(preview && item.mime.startsWith('image/') && item.size <= LIMIT ? { src: `data:${item.mime};base64,${fs.readFileSync(item.file).toString('base64')}` } : {}) };
  }
  preview(session: ChatFileScope, reference: string): ChatFilePreview & { bytes: Buffer } {
    const item = this.resolve(session, reference);
    if (!item.mime || !item.size || item.size > LIMIT) throw new Error('Preview unavailable for this file.');
    return { name: item.name, type: item.mime, bytes: fs.readFileSync(item.file) };
  }
  import({ name, bytes }: ChatFileUpload): ChatFile {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Choose a named file.');
    const buffer = Buffer.from(bytes || []);
    if (!buffer.length || buffer.length > LIMIT) throw new Error('Attachments must be between 1 byte and 20 MB.');
    const folder = path.join(this.root, randomUUID()); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, path.basename(name).replace(/[\x00-\x1f]/g, '_'));
    fs.writeFileSync(file, buffer, { mode: 0o600 });
    return { path: file, name: path.basename(file), size: buffer.length, mime: previewTypes[path.extname(file).toLowerCase()] || '' };
  }
  async list(session: ChatFileScope, query = ''): Promise<ChatFileMatch[]> {
    const files = await projectFiles(session.repoDir).catch(() => { throw new Error('Could not list project files. Use Attach files instead.'); });
    return files.filter(file => file && listable(file) && file.toLowerCase().includes(String(query).toLowerCase())).slice(0, 50).map(file => ({ path: file, name: file }));
  }
}
export { ChatResources, LIMIT, within, projectFiles };
