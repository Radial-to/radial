/**
 * Persistent project memory / agent rules. Lives in AGENTS.md at the repo root —
 * the cross-tool convention that Claude Code, Codex, Cursor, etc. read — so the
 * rules apply whether someone works in Radial or any other agent. Kept out of
 * the published site via .vercelignore (and our static server blocks it).
 */

import fs from 'fs';
import path from 'path';
import * as projectData from './projectData';
import * as cliSpec from './cliSpec';
import type { ContextFile, ProjectReference } from '../shared/radialApi';

/** The parts of a `.context/` file the context index reads (context.list rows). */
export type IndexedContextFile = Pick<ContextFile, 'rel' | 'local'>;
/** The parts of an attached reference the context index reads (references.list rows). */
export type IndexedReference = Pick<ProjectReference, 'label' | 'url'>;

function agentsPath(repoDir: string): string { return projectData.rulesPath(repoDir); }
const RULES_HEADING = '## Project rules';

// Where agents find the live preview. Radial's dev servers run on OS-assigned
// ports (new port every restart), so this pointer — not a guessed default port —
// is the only reliable way for a CLI agent (Codex, Cursor, or one run outside
// Radial) to reach the preview. Claude Code also gets this via its seeded
// system prompt (engine.js), but AGENTS.md is the channel the others read.
const PREVIEW_HEADING = '## Live preview';
const PREVIEW_NOTE = `${PREVIEW_HEADING}\n\n`
  + `Radial runs this project's dev server and hot-reloads the preview on every file edit.\n\n`
  + `- The server's current URL is in \`.radial/dev.json\` (its \`url\` field). The port is OS-assigned and changes on every restart — never assume a default port (3000, 4321, 5173) and never port-scan; read the file instead.\n`
  + `- If that file is missing or its URL doesn't answer, the preview isn't running — say so rather than starting a dev server yourself (a second server collides with Radial's shared preview).\n`
  + `- If an edit doesn't show up, hot reload may have wedged (the server answers but serves pre-edit output). Verify by fetching from the dev.json URL and comparing with disk; if they disagree, create an empty \`.radial/restart-dev-server\` file and Radial restarts the preview cleanly — then re-read \`.radial/dev.json\` for the new URL. Never kill or start dev-server processes yourself.\n`;

// The other Radial↔agent contract (plans/agent-state-files.md): review
// comments and the launch-check report live as files any agent can read and
// act on. Documented here because AGENTS.md is the one channel every CLI
// reads. Keyed for idempotence on the comments.json mention — this note
// freezes at first write, which is also why `resolvedBy` ships in v1: a
// field added later would never reach repos that already have the note.
const STATE_FILES_HEADING = '## Radial state files';
const STATE_FILES_NOTE = `${STATE_FILES_HEADING}\n\n`
  + `Radial (the visual app) shares state with agents through files in \`.radial/\`:\n\n`
  + `- \`.radial/comments.json\` is review feedback pinned to pages. Each comment anchors to a \`route\` + CSS \`selector\` (or a context \`file\` + \`quote\`), with \`text\`, optional \`images\` (repo-relative paths you can read), and \`resolved\`. Only act on comments when the user asks you to (people batch feedback and send it when the set is ready; a comment sitting in the file is not a request yet). When asked: read the comments where \`resolved\` is false, make the fixes, then set \`resolved\` to true on exactly those comments, plus \`resolvedBy\` with your agent's name (for example "claude-code"). Edit fields in place and keep the file a valid JSON array; Radial picks up your edits within a second.\n`
  + `- \`.radial/launch-check.json\` is the latest pre-launch checklist report (SEO, accessibility, broken links). Read \`results[].issues\` for what to fix; \`scannedAt\` says how fresh it is. After fixing, create an empty \`.radial/run-launch-check\` file and Radial re-scans and rewrites the report (the project must be open in Radial with its preview running).\n`;

// ── Radial CLI ─────────────────────────────────────────────────────────
// How an agent (or anyone) in a plain terminal drives this project through the
// app: the `radial` verbs (cliSpec.js is the one source). Unlike the
// freeze-at-first-write notes above, this is a MANAGED block: fenced by
// markers and rewritten whenever the verb table changes, so an agent reading
// AGENTS.md never sees a stale command list. The pre-fence note ("## Opening
// this project in Radial", `radial .` only) is replaced once on the next open.
const CLI_HEADING = '## Radial CLI';
const CLI_BEGIN = '<!-- radial:cli (managed by Radial; edits here are overwritten) -->';
const CLI_END = '<!-- /radial:cli -->';
const LEGACY_OPEN_HEADING = '## Opening this project in Radial';
function cliBlock(): string { return CLI_BEGIN + '\n' + cliSpec.agentsMdBlock() + '\n' + CLI_END; }
function cliSection(): string { return CLI_HEADING + '\n\n' + cliBlock() + '\n'; }

// ── Project context index ──────────────────────────────────────────────
// The ALWAYS-FRESH map of `.context/` files + attached references. Unlike the
// freeze-at-first-write notes above, this block is rewritten (inside marker
// fences) whenever context or references change — it's what makes the context
// usable by Codex/Cursor/outside-Claude sessions and by humans without Radial.
// Radial-launched Claude also gets it injected, but AGENTS.md is the channel
// everything else reads.
const CONTEXT_HEADING = '## Project context';
const CTX_BEGIN = '<!-- radial:context-index (managed by Radial; edits here are overwritten) -->';
const CTX_END = '<!-- /radial:context-index -->';
function contextIndexBlock(repoDir: string, ctxList: IndexedContextFile[], refList: IndexedReference[]): string {
  const files = (ctxList || []).filter((f) => f && (projectData.isLocal(repoDir) || !f.local));
  const refs = refList || [];
  const firstLine = (rel: string) => {
    try {
      const t = fs.readFileSync(path.join(projectData.contextDir(repoDir), rel), 'utf8');
      const m = t.split(/\r?\n/).find((l) => l.trim());
      return (m || '').replace(/^#+\s*/, '').trim().slice(0, 90);
    } catch { return ''; }
  };
  let b = CTX_BEGIN + '\n';
  if (files.length) {
    b += `Brand, positioning, and working docs live in \`${projectData.reference(repoDir, projectData.contextDir(repoDir))}/\`. Read the relevant ones before writing copy or making claims - they override any defaults:\n\n`;
    files.forEach((f) => {
      const d = /\.(md|mdx|txt)$/i.test(f.rel) ? firstLine(f.rel) : '';
      b += '- `' + projectData.reference(repoDir, path.join(projectData.contextDir(repoDir), f.rel)) + '`' + (d ? ' - ' + d : '') + '\n';
    });
  }
  if (refs.length) {
    b += (files.length ? '\n' : '') + 'Attached references - pointers, not mirrors; pull each yourself when relevant (clone, `gh`, or a plain fetch):\n\n';
    refs.forEach((r) => { b += '- ' + r.label + ': ' + r.url + '\n'; });
  }
  if (!files.length && !refs.length) b += 'No context files or references attached yet.\n';
  b += CTX_END;
  return b;
}
function syncContextIndex(repoDir: string, ctxList: IndexedContextFile[], refList: IndexedReference[]): void {
  const p = agentsPath(repoDir);
  let content = '';
  try { content = fs.readFileSync(p, 'utf8'); } catch {}
  const hasAny = (ctxList || []).some((f) => f && !f.local) || (refList || []).length;
  if (!content && !hasAny) return; // nothing to say - don't create AGENTS.md just for an empty index
  if (!content) { ensure(repoDir); try { content = fs.readFileSync(p, 'utf8'); } catch { return; } }
  const block = contextIndexBlock(repoDir, ctxList, refList);
  const bi = content.indexOf(CTX_BEGIN);
  const ei = content.indexOf(CTX_END);
  let next: string;
  if (bi !== -1 && ei !== -1 && ei > bi) {
    next = content.slice(0, bi) + block + content.slice(ei + CTX_END.length);
  } else {
    const section = CONTEXT_HEADING + '\n\n' + block + '\n';
    const ri = content.indexOf(RULES_HEADING);
    next = ri !== -1
      ? content.slice(0, ri) + section + '\n' + content.slice(ri)
      : content.replace(/\s*$/, '') + '\n\n' + section;
  }
  if (next !== content) fs.writeFileSync(p, next, 'utf8'); // changed-guard: no mtime/git churn on idle re-syncs
}

function read(repoDir: string): string {
  try { return fs.readFileSync(agentsPath(repoDir), 'utf8'); } catch { return ''; }
}
function readForAgent(repoDir: string): string {
  const local = read(repoDir);
  if (!projectData.isLocal(repoDir)) return local;
  let shared = '';
  try { shared = fs.readFileSync(path.join(repoDir, 'AGENTS.md'), 'utf8'); } catch {}
  return projectData.agentText(repoDir, [shared, local].filter(Boolean).join('\n\n'));
}
function exists(repoDir: string): boolean { return fs.existsSync(agentsPath(repoDir)); }

// Make sure AGENTS.md exists with a Radial-managed "Project rules" section.
function ensure(repoDir: string): string {
  const p = agentsPath(repoDir);
  let content = '';
  try { content = fs.readFileSync(p, 'utf8'); } catch {}
  if (!content) {
    content = `# Project guide\n\n`
      + `Context and rules for anyone (or any AI agent) working on this project — read this first.\n`
      + `Maintained with Radial; safe to edit by hand.\n\n`
      + `${PREVIEW_NOTE}\n`
      + `${STATE_FILES_NOTE}\n`
      + `${cliSection()}\n`
      + `${RULES_HEADING}\n\n`;
    fs.writeFileSync(p, projectData.agentText(repoDir, content), 'utf8');
  } else if (!content.includes(RULES_HEADING)) {
    content = content.replace(/\s*$/, '') + `\n\n${RULES_HEADING}\n\n`;
    fs.writeFileSync(p, content, 'utf8');
  }
  excludeFromDeploy(repoDir);
  return p;
}

// Idempotently add the Live preview section to an EXISTING AGENTS.md (ensure()
// bakes it into new files). Keyed on any mention of .radial/dev.json — not the
// heading — so a note the user reworded or moved is respected, not re-fought.
function ensurePreviewNote(repoDir: string): void {
  if (projectData.isLocal(repoDir)) return;
  const p = agentsPath(repoDir);
  let content = '';
  try { content = fs.readFileSync(p, 'utf8'); } catch { return; } // no AGENTS.md → nothing to annotate
  if (content.includes('.radial/dev.json')) return;
  fs.writeFileSync(p, content.replace(/\s*$/, '\n\n') + PREVIEW_NOTE, 'utf8');
}

// Idempotently add the state-files note to an EXISTING AGENTS.md, same
// pattern as ensurePreviewNote: keyed on any mention of comments.json so a
// note the user reworded or moved is respected, not re-fought.
function ensureStateFilesNote(repoDir: string): void {
  if (projectData.isLocal(repoDir)) return;
  const p = agentsPath(repoDir);
  let content = '';
  try { content = fs.readFileSync(p, 'utf8'); } catch { return; } // no AGENTS.md → nothing to annotate
  if (content.includes('.radial/comments.json')) return;
  fs.writeFileSync(p, content.replace(/\s*$/, '\n\n') + STATE_FILES_NOTE, 'utf8');
}

// Keep the managed "## Radial CLI" block current in an EXISTING AGENTS.md
// (ensure() bakes it into new files). Four cases, in order: no file → nothing
// (Radial never creates AGENTS.md just for this); fence present → rewrite the
// inside when the verb table changed (changed-guard: no mtime/git churn);
// the legacy "## Opening this project in Radial" section → replaced once by the
// managed section (to the next "## " heading or EOF); otherwise → appended once.
// A user-reworded legacy note (heading gone) is left alone next to ours.
function ensureCliNote(repoDir: string): void {
  if (projectData.isLocal(repoDir)) return;
  const p = agentsPath(repoDir);
  let content = '';
  try { content = fs.readFileSync(p, 'utf8'); } catch { return; } // no AGENTS.md → nothing to annotate
  const bi = content.indexOf(CLI_BEGIN);
  const ei = content.indexOf(CLI_END);
  let next: string;
  if (bi !== -1 && ei !== -1 && ei > bi) {
    next = content.slice(0, bi) + cliBlock() + content.slice(ei + CLI_END.length);
  } else {
    const li = content.indexOf(LEGACY_OPEN_HEADING);
    if (li !== -1) {
      const after = content.indexOf('\n## ', li + LEGACY_OPEN_HEADING.length);
      const end = after === -1 ? content.length : after + 1;
      next = content.slice(0, li) + cliSection() + (after === -1 ? '' : '\n') + content.slice(end);
    } else {
      next = content.replace(/\s*$/, '\n\n') + cliSection();
    }
  }
  if (next !== content) fs.writeFileSync(p, next, 'utf8');
}
const ensureOpenNote = ensureCliNote; // old name, same job

// The Home terminal's folder (~/Radial) is Radial-owned: give it a minimal
// AGENTS.md so Codex/Cursor Home agents learn the CLI too. Managed block only.
function ensureHomeAgentsMd(dir: string): void {
  if (projectData.isLocal(dir)) return;
  const p = path.join(dir, 'AGENTS.md');
  if (fs.existsSync(p)) { ensureCliNote(dir); return; }
  fs.writeFileSync(p, '# Radial home\n\nThis folder holds the sites Radial clones and creates. No project is open here: use the `radial` command to open one.\n\n' + cliSection(), 'utf8');
}

// Append a rule as a bullet under "## Project rules".
function addRule(repoDir: string, text: string): { ok: boolean } {
  const rule = String(text || '').trim();
  if (!rule) return { ok: false };
  ensure(repoDir);
  const p = agentsPath(repoDir);
  let content = fs.readFileSync(p, 'utf8');
  const idx = content.indexOf(RULES_HEADING);
  const insertAt = content.indexOf('\n', idx) + 1;
  const bullet = `- ${rule.replace(/^[-*]\s*/, '')}\n`;
  content = content.slice(0, insertAt) + bullet + content.slice(insertAt);
  fs.writeFileSync(p, content, 'utf8');
  return { ok: true };
}

// Keep AGENTS.md / CLAUDE.md out of deploys (matters for root-served static sites).
function excludeFromDeploy(repoDir: string): void {
  if (projectData.isLocal(repoDir)) return;
  try {
    const vi = path.join(repoDir, '.vercelignore');
    let content = ''; try { content = fs.readFileSync(vi, 'utf8'); } catch {}
    const lines = content.split(/\r?\n/);
    const want = ['AGENTS.md', 'CLAUDE.md'];
    const missing = want.filter((w) => !lines.some((l) => l.trim() === w));
    if (!missing.length) return;
    const prefix = content && !content.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(vi, content + `${prefix}# Radial — project memory, not deployed\n${missing.join('\n')}\n`, 'utf8');
  } catch { /* best effort */ }
}

export { read, readForAgent, exists, ensure, addRule, ensurePreviewNote, ensureStateFilesNote, ensureCliNote, ensureOpenNote, ensureHomeAgentsMd, excludeFromDeploy, agentsPath, STATE_FILES_NOTE, syncContextIndex, CLI_HEADING, CLI_BEGIN, CLI_END, LEGACY_OPEN_HEADING, cliSection };
