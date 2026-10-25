/**
 * Agent utilities. The SDK chat that used to live here (streamed turns, steer,
 * sessions) was removed 2026-07-27 — terminal agents (the real CLIs, spawned by
 * engine.js/term-daemon) are Radial's one agent surface; see git history if the
 * chat ever needs resurrecting. What remains:
 *   - MARKETING_SKILLS: the marketing-site craft appended to every terminal
 *     agent's system prompt (engine.js).
 *   - checkAuth: can the user's Claude tooling authenticate (setup UI).
 *   - One-shot generations (commit message, meta/alt suggestions, rule
 *     enhance/audit) via the user's own CLI headless (cliAgent.runPrint) —
 *     BYO auth, no SDK dependency.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { which } from './env';
import * as cliAgent from './cliAgent';
import type { AgentTextResult, CliAuth, RadialApi } from '../shared/radialApi';

/** checkAuth()'s answer: how Claude Code signs in, or what setup is missing (radialApi's CliAuth for Claude, sent as agent:checkAuth). */
export type ClaudeAuth = Extract<CliAuth, { ok: true }> | { ok: false; hasCli: boolean; hasNode: boolean };
/** suggestMeta()'s page: its route and visible text (agent:suggestMeta). */
export type MetaContext = Parameters<RadialApi['agentSuggestMeta']>[1];
/** suggestMeta()'s answer: the suggested title and description, or why there is none. */
export type MetaSuggestion = Awaited<ReturnType<RadialApi['agentSuggestMeta']>>;
/** suggestAlt()'s page: its route, share image and visible text (agent:suggestAlt). */
export type AltContext = Parameters<RadialApi['agentSuggestAlt']>[1];

// Marketing-site domain knowledge baked into every agent turn. This is the
// "only knows marketing sites" layer: Radial is built for one kind of site, so
// the agent ships with craft a general coding agent can't assume. Project rules
// (AGENTS.md) and brand/positioning docs (.context/) override these
// defaults — when they conflict, the project always wins.
const MARKETING_SKILLS = [
  'MARKETING-SITE EXPERTISE (this is always a marketing/landing site — apply this craft):',
  'Its job is the visitor\'s decision: understand the offer, trust it, and act. Optimize every edit for conversion and brand, not engineering elegance. Make the smallest change that achieves the goal — never redesign or restructure a page you weren\'t asked to.',
  'PRECEDENCE: this project\'s AGENTS.md rules and the brand voice/positioning in `.context/` always override the defaults below. If a change depends on a brand fact, a claim, a price, a statistic, or a logo/testimonial you cannot verify in the repo or context, ask the user — never invent or fabricate it.',
  '',
  'COPY & VOICE:',
  '- Match the site\'s existing voice and reading level. Lead with the benefit or outcome, not the feature. Be specific over clever; cut hype, filler, and throat-clearing.',
  '- Never fabricate claims, statistics, customer names, testimonials, logos, or pricing. Edit what is there; if asked to add proof that does not exist, flag it instead of making it up.',
  '',
  'STRUCTURE & SECTIONS:',
  '- Marketing pages have a rhythm: hero (value prop + primary CTA) → social proof → core value/benefits → features or how-it-works → pricing → FAQ → closing CTA. Preserve that hierarchy; do not bury the lede.',
  '- HERO: one clear value proposition, one primary CTA, instantly scannable. The headline states the outcome the visitor wants, not the mechanism.',
  '- CTAs: one primary action per section, an action-oriented verb, a consistent destination. Do not add competing primary CTAs or dilute the main one.',
  '- PRICING: keep tiers visually parallel and feature lists consistent, highlight one recommended/anchor tier, and show only real values. Never leave a tier half-filled.',
  '',
  'SEO & METADATA (a marketing site lives and dies on this — keep it intact):',
  '- Exactly one <h1> per page; semantic, ordered headings (never skip a level for styling). Keep <title> ~50-60 chars and meta description ~150-160 and benefit-driven.',
  '- When you change page content, keep the Open Graph and Twitter meta consistent with it and keep the canonical URL correct. Give every meaningful image descriptive alt text. Keep URLs and slugs human-readable.',
  '',
  'ACCESSIBILITY & RESPONSIVE (the preview shows real device sizes — respect them):',
  '- Use semantic, interactive elements (a real <a>/<button> for a CTA, never a clickable <div>). Keep visible focus states, label form fields, and maintain readable color contrast.',
  '- Changes must hold up at mobile, tablet, and desktop — never fix desktop and break mobile. Reuse the site\'s existing design tokens, spacing scale, and components instead of one-off inline styles.',
  '',
  'PERFORMANCE: a marketing site is judged on first impression and load speed. Prefer optimized, lazy-loaded images below the fold, and do not pull in a heavy dependency for an effect plain CSS can do.',
].join('\n');

/**
 * Can the agent authenticate? Radial reuses the user's Claude Code login.
 * We accept any of: an API key in the env, a Claude Code OAuth token, the
 * stored Claude Code credentials file, or the macOS Keychain entry. Returns
 * { ok, method } or { ok:false, hasCli, hasNode } so the UI can guide setup.
 */
function checkAuth(): ClaudeAuth {
  if (process.env.ANTHROPIC_API_KEY) return { ok: true, method: 'api_key' };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { ok: true, method: 'oauth_token' };

  const home = os.homedir();
  const credFiles = [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.config', 'claude', '.credentials.json'),
  ];
  for (const f of credFiles) {
    try { if (fs.existsSync(f) && fs.statSync(f).size > 2) return { ok: true, method: 'claude_code' }; } catch {}
  }
  if (process.platform === 'darwin') {
    try {
      execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { stdio: ['ignore', 'ignore', 'ignore'], timeout: 4000 });
      return { ok: true, method: 'keychain' };
    } catch {}
  }
  return { ok: false, hasCli: !!which('claude'), hasNode: !!which('node') };
}

/**
 * One-off, read-only AI suggestion for page title + meta description, based on
 * the page's visible content. Headless CLI, no tools — just returns text.
 */
async function suggestMeta(repoDir: string, context: MetaContext): Promise<MetaSuggestion> {
  const prompt = `You are an SEO assistant for a marketing website. Based on the page below, write:
- "title": an SEO page title, ideally 50-60 characters, specific and compelling.
- "description": a meta description, ideally 150-160 characters, benefit-driven and clear.

Page path: ${context.route || '/'}
Visible page content:
"""
${(context.bodyText || '').slice(0, 4000)}
"""

Respond with ONLY a single-line JSON object and nothing else:
{"title":"...","description":"..."}`;

  const r = await cliAgent.runPrint(repoDir, prompt, { timeoutMs: 60000 });
  if (!r.ok) return { ok: false, error: r.error };
  const m = String(r.text || '').match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: 'No suggestion returned' };
  try {
    const j = JSON.parse(m[0]) as { title?: string; description?: string }; // model output: trusted as the original did; non-strings pass through
    return { ok: true, title: j.title || '', description: j.description || '' };
  } catch {
    return { ok: false, error: 'Could not parse the suggestion' };
  }
}

/** One-off AI alt text for the page's social share image, from page context. */
async function suggestAlt(repoDir: string, context: AltContext): Promise<AgentTextResult<'alt'>> {
  const prompt = `Write concise, descriptive alt text (under 125 characters) for the social-share image of this web page, for accessibility. Describe what the image likely shows given the page.

Page path: ${context.route || '/'}
Image file: ${context.image || '(unknown)'}
Page content:
"""
${(context.bodyText || '').slice(0, 2000)}
"""

Respond with ONLY the alt text — no quotes, no labels.`;
  const r = await cliAgent.runPrint(repoDir, prompt, { timeoutMs: 60000 });
  if (!r.ok) return { ok: false, error: r.error };
  const alt = String(r.text || '').trim().replace(/^["']|["']$/g, '').split('\n').pop()!.trim(); // split() always returns a part
  if (!alt) return { ok: false, error: 'No alt text returned' };
  return { ok: true, alt };
}

/**
 * One-off: rewrite a rough note into a clear, agent-friendly project rule/skill,
 * following skill-authoring best practices. Read-only — returns text.
 */
async function enhanceRule(repoDir: string, text: string): Promise<AgentTextResult<'text'>> {
  const prompt = `Rewrite the note below into a clear, agent-friendly project rule/skill for an AI coding agent working on a marketing website. Follow skill-authoring best practices:
- Imperative and specific — say exactly what to do and not do.
- Scope it — when does it apply?
- Briefly give the rationale (why it matters).
- State the positive alternative — what to do INSTEAD.
- Concrete and unambiguous — avoid vague adjectives.
- Concise: a short paragraph or a few bullets. Plain Markdown. No preamble, no surrounding quotes, no heading.

Note:
"""
${(text || '').slice(0, 2000)}
"""

Return ONLY the rewritten rule.`;

  const r = await cliAgent.runPrint(repoDir, prompt, { timeoutMs: 60000 });
  if (!r.ok) return { ok: false, error: r.error };
  const out = String(r.text || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!out) return { ok: false, error: 'No suggestion returned' };
  return { ok: true, text: out };
}

/**
 * One-off: review a rule/skill/context and suggest improvements WITHOUT changing
 * its intent. Read-only — returns a Markdown bullet list of suggestions.
 */
async function auditRule(repoDir: string, text: string): Promise<AgentTextResult<'text'>> {
  const prompt = `Review the project rule/skill/context below, written for an AI coding agent on a marketing website. WITHOUT changing its intent, give concrete suggestions to make it clearer and more effective, judged against skill-authoring best practices: specific & imperative, scoped (when it applies), states the rationale, gives the positive alternative (what to do instead), unambiguous, and testable.

Rules:
- Do NOT rewrite the rule — only suggest how to improve it.
- Preserve the author's original intent; flag anything that would change meaning.
- If it's already solid, say so briefly and note any small polish.

Rule/skill/context:
"""
${(text || '').slice(0, 3000)}
"""

Respond with a short Markdown bullet list of suggestions only.`;

  const r = await cliAgent.runPrint(repoDir, prompt, { timeoutMs: 60000 });
  if (!r.ok) return { ok: false, error: r.error };
  const out = String(r.text || '').trim();
  if (!out) return { ok: false, error: 'No suggestions returned' };
  return { ok: true, text: out };
}

/**
 * One-off: write a concise git commit message from the working-tree changes.
 * Uses the cheapest model (Haiku) — a commit summary doesn't need more. Returns
 * { ok, message }; message is '' when there's nothing to commit.
 */
async function suggestCommitMessage(repoDir: string): Promise<AgentTextResult<'message'>> {
  const git = (args: string[]): string => { try { return execFileSync(which('git') || 'git', args, { cwd: repoDir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); } catch { return ''; } };
  const status = git(['status', '--porcelain']).trim();
  if (!status) return { ok: true, message: '' };
  const files = status.split('\n').slice(0, 50).join('\n');
  const diff = (git(['diff', 'HEAD', '--stat']) + '\n' + git(['diff', 'HEAD'])).slice(0, 6000);

  const prompt = `Write a git commit message for these uncommitted changes to a marketing website.
- One imperative subject line, present tense, ≤72 chars, no trailing period.
- No conventional-commit prefixes (no "feat:"/"chore:" etc.) unless genuinely natural.
- Optionally ONE short body line if it adds real clarity.
- Return ONLY the commit message — no preamble, no surrounding quotes.

Changed files:
${files}

Diff (truncated):
${diff}`;

  const r = await cliAgent.runPrint(repoDir, prompt, { model: 'claude-haiku-4-5-20251001', timeoutMs: 45000 });
  if (!r.ok) return { ok: false, error: r.error };
  const out = String(r.text || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  return { ok: true, message: out };
}

export { MARKETING_SKILLS, checkAuth, suggestMeta, suggestAlt, enhanceRule, auditRule, suggestCommitMessage };
