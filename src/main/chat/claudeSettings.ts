// Only edit Claude's native user permission default. Never replace its other
// settings or mutate a running session to make it match a future default.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash, randomUUID } from 'crypto';
/**
 * The picker's choices that map to one of Claude Code's own permission modes.
 * These are the Claude mode ids of shared/chatPermissions.ts (modes.claude),
 * which the window compares against: when that module is typed it should own
 * the Claude permission-mode union, and this becomes `Exclude<ClaudePermissionMode, 'cli'>`.
 */
export type ClaudeNativeDefault = 'default' | 'edits' | 'plan' | 'full';
/** What the settings file says: a native mode, 'cli' when it sets none, 'custom' for a mode Radial doesn't offer. */
export type ClaudeDefaultMode = ClaudeNativeDefault | 'cli' | 'custom';
export interface ClaudeDefaultState { mode: ClaudeDefaultMode; revision: string }
// The parts of ~/.claude/settings.json read here; read() refuses anything else.
interface ClaudePermissions { defaultMode?: unknown; [key: string]: unknown }
interface ClaudeSettings { permissions?: ClaudePermissions; [key: string]: unknown }
const nativeModes: Record<ClaudeNativeDefault, string> = { default: 'default', edits: 'acceptEdits', plan: 'plan', full: 'bypassPermissions' };
const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value);
function read(env: NodeJS.ProcessEnv = process.env) {
  let file = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
  let raw = '';
  try { file = fs.realpathSync(file); raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Parsed from a file the person edits: this type only holds after the object() checks below.
  let settings: ClaudeSettings;
  try { settings = raw ? JSON.parse(raw) : {}; } catch { throw new Error('Claude Code settings contain invalid JSON. Fix that file before changing its default.'); }
  if (!object(settings) || (settings.permissions !== undefined && !object(settings.permissions))) throw new Error('Claude Code settings have an invalid permissions object. The file was not changed.');
  const revision = createHash('sha256').update(file + '\0' + raw).digest('hex');
  const nativeMode = settings.permissions?.defaultMode;
  const mode: ClaudeDefaultMode = (Object.keys(nativeModes) as ClaudeNativeDefault[]).find(key => nativeModes[key] === nativeMode) || (nativeMode === 'manual' ? 'default' : nativeMode == null ? 'cli' : 'custom');
  return { file, raw, settings, revision, mode };
}
function get(env?: NodeJS.ProcessEnv): ClaudeDefaultState { const { mode, revision } = read(env); return { mode, revision }; }
// mode comes from the window unchecked: anything but 'cli' or a native choice throws.
function set(mode: string, expectedRevision: string, env?: NodeJS.ProcessEnv): ClaudeDefaultState {
  if (mode !== 'cli' && !Object.hasOwn(nativeModes, mode)) throw new Error('Unsupported Claude Code default.');
  const { file, raw, settings, revision } = read(env);
  if (expectedRevision !== revision) throw new Error('Claude Code settings changed. Reopen the default picker and try again.');
  const next = { ...settings, permissions: { ...settings.permissions } };
  if (mode === 'cli') delete next.permissions.defaultMode;
  else next.permissions.defaultMode = nativeModes[mode as ClaudeNativeDefault];
  if (!Object.keys(next.permissions).length) delete (next as ClaudeSettings).permissions;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.radial-' + randomUUID();
  try {
    if (raw) fs.writeFileSync(file + '.radial-backup', raw, { mode: 0o600 });
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return get(env);
}
export { get, set };
