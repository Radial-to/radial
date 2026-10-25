
/** The agent CLIs a chat (or a terminal agent) runs. */
export type ChatEngine = 'claude' | 'codex' | 'cursor';
/** Claude Code's presets (modes.claude): its own settings, or one of its permission modes. */
export type ClaudePermissionMode = 'cli' | 'default' | 'edits' | 'plan' | 'full';
/** Codex's presets (modes.codex): its own settings, or a sandbox. */
export type CodexPermissionMode = 'cli' | 'workspace' | 'read-only' | 'full';
/** Cursor's presets (modes.cursor). */
export type CursorPermissionMode = 'default' | 'plan' | 'full';
/** A permission preset a chat can pick, on one engine or another. */
export type PermissionModeId = ClaudePermissionMode | CodexPermissionMode | CursorPermissionMode;
/** A chat's permission mode: a preset, or `custom` when Codex reports a policy no preset matches. */
export type PermissionMode = PermissionModeId | 'custom';
/**
 * Claude Code's default for new chats as its settings file says it
 * (chat/claudeSettings.ts): a preset, or `custom` for a mode Radial doesn't offer.
 */
export type ClaudeDefaultMode = ClaudePermissionMode | 'custom';
/** One choice in a chat's permission menu. */
export interface PermissionOption<Id extends PermissionModeId = PermissionModeId> { id: Id; label: string }
/** Each engine's presets, in menu order. */
export interface EngineModes {
  claude: PermissionOption<ClaudePermissionMode>[];
  codex: PermissionOption<CodexPermissionMode>[];
  cursor: PermissionOption<CursorPermissionMode>[];
}
/** What Codex is told for a mode (the CLI flags and the app-server turn policy). */
export interface CodexPermissions {
  sandbox: 'danger-full-access' | 'read-only' | 'workspace-write';
  approvalPolicy: 'never' | 'on-request';
  sandboxPolicy: CodexSandboxPolicy;
}
export type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeSlashTmp: boolean; excludeTmpdirEnvVar: boolean };

const modes: EngineModes = {
  codex: [{ id: 'cli', label: 'Use Codex settings' }, { id: 'workspace', label: 'Workspace access' }, { id: 'read-only', label: 'Read only' }, { id: 'full', label: 'Full access' }],
  claude: [{ id: 'cli', label: 'Use Claude Code settings' }, { id: 'default', label: 'Ask permission' }, { id: 'edits', label: 'Accept edits' }, { id: 'plan', label: 'Plan only' }, { id: 'full', label: 'Full access' }],
  cursor: [{ id: 'default', label: 'Ask permission' }, { id: 'plan', label: 'Plan only' }, { id: 'full', label: 'Full access' }],
};
// Claude Code and Codex start from the user's own CLI settings.
function defaultMode(engine: ChatEngine): 'cli' | 'default' { return engine === 'claude' || engine === 'codex' ? 'cli' : 'default'; }
// mode can come from the window unchecked; past the throw it is one of the engine's presets.
function validate(engine: ChatEngine, mode: string = defaultMode(engine)): PermissionModeId {
  if (!modes[engine]?.some(item => item.id === mode)) throw new Error('This permission mode is not supported by this provider.');
  return mode as PermissionModeId;
}
// The CLI's own settings stay in charge: Radial sends no permission overrides.
function inherits(engine: ChatEngine, mode?: PermissionMode | null): boolean { mode ||= defaultMode(engine); return mode === 'cli' || mode === 'custom'; }
// 'custom' is the caller's to handle first: it sends no policy (nativeChat codexPermissions).
function codex(mode: PermissionModeId | null = 'workspace'): CodexPermissions {
  const sandbox = mode === 'full' ? 'danger-full-access' : mode === 'read-only' ? 'read-only' : 'workspace-write';
  const approvalPolicy = mode === 'full' ? 'never' : 'on-request';
  const sandboxPolicy: CodexSandboxPolicy = mode === 'full' ? { type: 'dangerFullAccess' } : mode === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeSlashTmp: false, excludeTmpdirEnvVar: false };
  return { sandbox, approvalPolicy, sandboxPolicy };
}
// 'custom' would throw in validate: callers settle it first, as nativeChat codexPermissions does.
function args(engine: ChatEngine, mode?: PermissionModeId | null): string[] {
  mode ||= defaultMode(engine);
  validate(engine, mode);
  if (mode === 'cli') return [];
  if (engine === 'codex') { const settings = codex(mode); return ['--sandbox', settings.sandbox, '--ask-for-approval', settings.approvalPolicy]; }
  if (engine === 'claude') return ['--permission-mode', { default: 'manual', edits: 'acceptEdits', plan: 'plan', full: 'bypassPermissions' }[mode as Exclude<ClaudePermissionMode, 'cli'>]];
  return mode === 'full' ? ['--force'] : mode === 'plan' ? ['--mode', 'plan'] : [];
}
export { modes, defaultMode, validate, inherits, codex, args };
