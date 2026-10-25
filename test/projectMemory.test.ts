import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as projectMemory from '../src/main/projectMemory';
import { tmpDir } from './support/tmp';

function tmp() { return tmpDir('radial-mem-'); }
const read = (dir: string) => fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
const vercelignore = (dir: string) => { try { return fs.readFileSync(path.join(dir, '.vercelignore'), 'utf8'); } catch { return ''; } };

test('ensure creates AGENTS.md with a Project rules section', () => {
  const dir = tmp();
  assert.equal(projectMemory.exists(dir), false);
  projectMemory.ensure(dir);
  assert.equal(projectMemory.exists(dir), true);
  assert.match(read(dir), /## Project rules/);
});

test('ensure is idempotent — it does not duplicate the heading', () => {
  const dir = tmp();
  projectMemory.ensure(dir);
  projectMemory.ensure(dir);
  const headings = (read(dir).match(/## Project rules/g) || []).length;
  assert.equal(headings, 1);
});

test('ensure adds the rules heading to a pre-existing AGENTS.md without clobbering it', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# My project\n\nSome existing notes.\n');
  projectMemory.ensure(dir);
  const txt = read(dir);
  assert.match(txt, /Some existing notes\./); // original content preserved
  assert.match(txt, /## Project rules/);       // heading appended
});

test('addRule appends a bullet under the rules heading', () => {
  const dir = tmp();
  projectMemory.addRule(dir, 'Never introduce new type styles unless asked.');
  const txt = read(dir);
  assert.match(txt, /## Project rules/);
  assert.match(txt, /- Never introduce new type styles unless asked\./);
});

test('addRule accumulates multiple rules', () => {
  const dir = tmp();
  projectMemory.addRule(dir, 'Rule one');
  projectMemory.addRule(dir, 'Rule two');
  const bullets = (read(dir).match(/^- Rule /gm) || []).length;
  assert.equal(bullets, 2);
});

test('addRule strips a leading bullet marker from the input', () => {
  const dir = tmp();
  projectMemory.addRule(dir, '- already a bullet');
  assert.match(read(dir), /^- already a bullet$/m);
  assert.doesNotMatch(read(dir), /^- - already/m);
});

test('addRule with empty text is a no-op', () => {
  const dir = tmp();
  const res = projectMemory.addRule(dir, '   ');
  assert.equal(res.ok, false);
  assert.equal(projectMemory.exists(dir), false);
});

test('ensure excludes AGENTS.md and CLAUDE.md from the deploy', () => {
  const dir = tmp();
  projectMemory.ensure(dir);
  const vi = vercelignore(dir);
  assert.match(vi, /^AGENTS\.md$/m);
  assert.match(vi, /^CLAUDE\.md$/m);
});

test('excludeFromDeploy is idempotent', () => {
  const dir = tmp();
  projectMemory.excludeFromDeploy(dir);
  projectMemory.excludeFromDeploy(dir);
  const vi = vercelignore(dir);
  assert.equal((vi.match(/^AGENTS\.md$/gm) || []).length, 1);
});

test('excludeFromDeploy only adds the entry that is missing', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.vercelignore'), 'node_modules\nAGENTS.md\n'); // already has AGENTS.md
  projectMemory.excludeFromDeploy(dir);
  const vi = vercelignore(dir);
  assert.equal((vi.match(/^AGENTS\.md$/gm) || []).length, 1); // not duplicated
  assert.match(vi, /^CLAUDE\.md$/m);                           // the missing one is added
});

test('excludeFromDeploy appends a newline before its block when needed', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.vercelignore'), 'dist'); // no trailing newline
  projectMemory.excludeFromDeploy(dir);
  const vi = vercelignore(dir);
  assert.doesNotMatch(vi, /distAGENTS/); // the existing entry isn't run together with ours
  assert.match(vi, /^AGENTS\.md$/m);
});

test('read returns empty string when AGENTS.md is absent', () => {
  assert.equal(projectMemory.read(tmp()), '');
});

test('ensure bakes the Live preview pointer into a new AGENTS.md', () => {
  const dir = tmp();
  projectMemory.ensure(dir);
  const txt = read(dir);
  assert.match(txt, /## Live preview/);
  assert.match(txt, /\.radial\/dev\.json/);
});

test('ensurePreviewNote appends the section to an existing AGENTS.md without clobbering it', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# My project\n\nSome existing notes.\n');
  projectMemory.ensurePreviewNote(dir);
  const txt = read(dir);
  assert.match(txt, /Some existing notes\./);
  assert.match(txt, /## Live preview/);
  assert.match(txt, /\.radial\/dev\.json/);
});

test('ensurePreviewNote is idempotent and respects a hand-reworded note', () => {
  const dir = tmp();
  projectMemory.ensurePreviewNote(dir); // no AGENTS.md → no-op, must not create one
  assert.equal(projectMemory.exists(dir), false);
  // A user-authored mention of .radial/dev.json (no Radial heading) counts as covered.
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Guide\n\nPreview URL: see .radial/dev.json.\n');
  projectMemory.ensurePreviewNote(dir);
  assert.doesNotMatch(read(dir), /## Live preview/);
  // And repeated calls never duplicate the section.
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Guide\n');
  projectMemory.ensurePreviewNote(dir);
  projectMemory.ensurePreviewNote(dir);
  assert.equal((read(dir).match(/## Live preview/g) || []).length, 1);
});

// ── State-files note (plans/agent-state-files.md) ─────────────────────────

test('ensure() bakes the state-files contract into a new AGENTS.md', () => {
  const dir = tmp();
  projectMemory.ensure(dir);
  const txt = read(dir);
  assert.match(txt, /## Radial state files/);
  assert.match(txt, /\.radial\/comments\.json/);
  assert.match(txt, /\.radial\/launch-check\.json/);
  assert.match(txt, /run-launch-check/);
  assert.match(txt, /resolvedBy/);
  assert.match(txt, /Only act on comments when the user asks/); // batching stays safe by default
});

test('ensureStateFilesNote appends to an existing AGENTS.md exactly once', () => {
  const dir = tmp();
  projectMemory.ensureStateFilesNote(dir); // no AGENTS.md → no-op, must not create one
  assert.equal(projectMemory.exists(dir), false);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# My project\n\nExisting notes.\n');
  projectMemory.ensureStateFilesNote(dir);
  projectMemory.ensureStateFilesNote(dir);
  const txt = read(dir);
  assert.match(txt, /Existing notes\./);
  assert.equal((txt.match(/## Radial state files/g) || []).length, 1);
});

test('ensureStateFilesNote respects a hand-reworded note (keyed on comments.json mention)', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Guide\n\nFeedback lives in .radial/comments.json, go read it.\n');
  projectMemory.ensureStateFilesNote(dir);
  assert.doesNotMatch(read(dir), /## Radial state files/);
});

// ── The managed "## Radial CLI" block ──────────────────────────────────
const { CLI_BEGIN, CLI_END, LEGACY_OPEN_HEADING } = projectMemory;
const cliSpec = require('../src/main/cliSpec') as typeof import('../src/main/cliSpec');
const mtime = (dir: string) => fs.statSync(path.join(dir, 'AGENTS.md')).mtimeMs;

test('ensure bakes the managed Radial CLI block, with every verb, into a new AGENTS.md', () => {
  const dir = tmp();
  projectMemory.ensure(dir);
  const txt = read(dir);
  assert.match(txt, /## Radial CLI/);
  assert.ok(txt.includes(CLI_BEGIN) && txt.includes(CLI_END));
  for (const c of cliSpec.COMMANDS.filter((x) => x.lane !== 'meta')) assert.ok(txt.includes(`\`radial ${c.name}`), `lists ${c.name}`);
  assert.ok(!txt.includes(LEGACY_OPEN_HEADING), 'no legacy heading in new files');
  assert.ok(txt.indexOf('## Radial CLI') < txt.indexOf('## Project rules'), 'CLI block sits above the rules');
});

test('ensureCliNote replaces the legacy open-in-Radial section once and leaves the neighbours intact', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'),
    '# Guide\n\n## Live preview\n\nRead `.radial/dev.json`.\n\n'
    + LEGACY_OPEN_HEADING + '\n\nFrom any terminal, `radial .` opens this folder in the Radial app (works whether or not the app is running).\n\n'
    + '## Project rules\n\n- Keep it blue.\n');
  projectMemory.ensureCliNote(dir);
  const txt = read(dir);
  assert.ok(!txt.includes(LEGACY_OPEN_HEADING), 'legacy heading gone');
  assert.ok(!txt.includes('works whether or not the app is running'), 'legacy body gone');
  assert.equal((txt.match(/## Radial CLI/g) || []).length, 1);
  assert.ok(txt.includes('## Live preview\n\nRead `.radial/dev.json`.'), 'section before untouched');
  assert.ok(txt.includes('## Project rules\n\n- Keep it blue.'), 'section after untouched');
  assert.ok(txt.indexOf('## Radial CLI') < txt.indexOf('## Project rules'), 'stays in place');
  const before = read(dir); const t0 = mtime(dir);
  projectMemory.ensureCliNote(dir);
  assert.equal(read(dir), before, 'idempotent'); assert.equal(mtime(dir), t0, 'no rewrite when unchanged');
});

test('ensureCliNote rewrites a stale fenced block in place and leaves a hand-reworded legacy note alone', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Guide\n\n## Radial CLI\n\n' + CLI_BEGIN + '\nold verbs\n' + CLI_END + '\n\n## Project rules\n');
  projectMemory.ensureCliNote(dir);
  const txt = read(dir);
  assert.ok(!txt.includes('old verbs'));
  assert.ok(txt.includes('`radial open'));
  assert.equal((txt.match(/## Radial CLI/g) || []).length, 1, 'fence rewritten, heading not duplicated');
  // No fence, no legacy heading, but the user kept their own wording: ours is appended once, theirs stays.
  const dir2 = tmp();
  fs.writeFileSync(path.join(dir2, 'AGENTS.md'), '# Guide\n\nTo open here, run `radial .` in a shell.\n');
  projectMemory.ensureCliNote(dir2); projectMemory.ensureCliNote(dir2);
  const t2 = read(dir2);
  assert.ok(t2.includes('run `radial .` in a shell'), 'user wording kept');
  assert.equal((t2.match(/## Radial CLI/g) || []).length, 1, 'appended exactly once');
  // No AGENTS.md at all → nothing is created.
  const dir3 = tmp();
  projectMemory.ensureCliNote(dir3);
  assert.equal(projectMemory.exists(dir3), false);
});

test('ensureHomeAgentsMd writes a minimal, managed AGENTS.md into the Home folder and keeps an existing one current', () => {
  const dir = tmp();
  projectMemory.ensureHomeAgentsMd(dir);
  const txt = read(dir);
  assert.match(txt, /^# Radial home/); assert.ok(txt.includes(CLI_BEGIN) && txt.includes(CLI_END)); assert.ok(txt.includes('`radial open'));
  assert.ok(!txt.includes('## Project rules'), 'not a project: no rules section');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Mine\n\n## Radial CLI\n\n' + CLI_BEGIN + '\nstale\n' + CLI_END + '\n');
  projectMemory.ensureHomeAgentsMd(dir);
  const t2 = read(dir);
  assert.match(t2, /^# Mine/); assert.ok(!t2.includes('stale')); assert.ok(t2.includes('`radial open'));
});
