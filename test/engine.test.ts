// The engine adapter: launch the REAL Claude Code / Codex CLIs as Radial's agent,
// seeded with the project's marketing-site context. Slice 1 of the "thin visual
// frontend to the CLIs" direction (plans/radial-thin-cli-frontend.md).

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as engine from '../src/main/engine';
import * as agentMod from '../src/main/agent';
import { tmpDir } from './support/tmp';

test('available() reports both engines as booleans', () => {
  const a = engine.available();
  assert.equal(typeof a.claude, 'boolean');
  assert.equal(typeof a.codex, 'boolean');
});

test('contextFor() carries the marketing craft and the project AGENTS.md rules', () => {
  const dir = tmpDir('radial-eng-');
  // Without an AGENTS.md, still seeds the marketing-site expertise.
  const base = engine.contextFor(dir);
  assert.ok(base.includes('MARKETING-SITE EXPERTISE'), 'includes the marketing craft');
  assert.ok(base.length > 200);

  // With AGENTS.md, the project's own rules are appended.
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '## Project rules\n- Always use the brand blue #0a7ae6.\n');
  const withRules = engine.contextFor(dir);
  assert.ok(withRules.includes('brand blue #0a7ae6'), 'appends AGENTS.md rules');
  assert.ok(withRules.includes('AGENTS.md'), 'labels the rules section');
});

test('contextFor() injects project references so the agent pulls the sources itself', () => {
  const references = require('../src/main/references') as typeof import('../src/main/references');
  const dir = tmpDir('radial-eng-');
  assert.ok(!engine.contextFor(dir).includes('PROJECT REFERENCES'), 'no section without refs');
  references.add(dir, 'https://github.com/acme/widgets');
  const ctx = engine.contextFor(dir);
  assert.ok(ctx.includes('PROJECT REFERENCES'), 'section present with refs');
  assert.ok(ctx.includes('https://github.com/acme/widgets'), 'carries the link');
});

test('contextFor() drops the Radial-UI formatting rules (terminal renders markdown)', () => {
  const dir = tmpDir('radial-eng-');
  const ctx = engine.contextFor(dir);
  // The built-in chat forbids markdown / localhost mentions for its plain-text UI;
  // a real terminal renders markdown and shows output, so those rules must NOT leak in.
  assert.ok(!/do NOT use Markdown/i.test(ctx), 'no "do not use markdown" rule');
  assert.ok(!/localhost/i.test(ctx), 'no "do not mention localhost" rule');
  // But the actual marketing expertise IS present.
  assert.ok(ctx.includes(agentMod.MARKETING_SKILLS.slice(0, 40)));
});

test('spawnSpec() shapes the launch per engine (when installed) or returns null', () => {
  const dir = tmpDir('radial-eng-');
  const avail = engine.available();
  // available() and spawnSpec() find a CLI the same way (engineBin), so the `!`s
  // read the spec of an engine available() reported installed.

  const claude = engine.spawnSpec(dir, 'claude');
  if (avail.claude) {
    assert.equal(claude!.engine, 'claude');
    assert.equal(claude!.args[0], '--append-system-prompt');
    assert.ok(claude!.args[1].includes('MARKETING-SITE EXPERTISE'), 'seeds context as an appended prompt');
  } else {
    assert.equal(claude, null, 'null when the CLI is not installed');
  }

  const codex = engine.spawnSpec(dir, 'codex');
  if (avail.codex) {
    assert.equal(codex!.engine, 'codex');
    assert.deepEqual(codex!.args, [], 'codex reads AGENTS.md from disk; no args');
  } else {
    assert.equal(codex, null);
  }

  // Unknown engine falls back to Claude Code's behavior.
  const unknown = engine.spawnSpec(dir, 'bogus');
  if (avail.claude) assert.equal(unknown!.engine, 'claude', 'unknown key resolves to claude');
  else assert.equal(unknown, null, 'null when claude (the fallback) is not installed');
});

test('spawnSpec() treats an Object.prototype name like any other unknown engine key', () => {
  const dir = tmpDir('radial-eng-');
  const fallback = engine.spawnSpec(dir, 'bogus'); // Claude Code's launch, or null when it isn't installed
  for (const key of ['constructor', 'toString', '__proto__']) {
    assert.equal(engine.spawnSpec(dir, key)?.engine, fallback?.engine, key);
  }
});

test('spawnSpec() pins claude to a session id at spawn and resumes one on wake', () => {
  const dir = tmpDir('radial-eng-');
  if (!engine.available().claude) return; // flags only exist when the CLI does
  // Claude is installed (the return above), so each spec below is set (the `!`s).

  // Fresh spawn: --session-id first, so agent sleep can --resume it later.
  const fresh = engine.spawnSpec(dir, 'claude', { sessionId: 'sid-1' })!;
  assert.deepEqual(fresh.args.slice(0, 2), ['--session-id', 'sid-1']);
  assert.equal(fresh.args[2], '--append-system-prompt', 'context still seeded');

  // Wake of a slept agent: --resume replaces --session-id, same conversation.
  const woke = engine.spawnSpec(dir, 'claude', { sessionId: null, resumeSessionId: 'sid-1' })!;
  assert.deepEqual(woke.args.slice(0, 2), ['--resume', 'sid-1']);
  assert.equal(woke.args[2], '--append-system-prompt');

  // resume wins if both are passed (belt and braces).
  const both = engine.spawnSpec(dir, 'claude', { sessionId: 'new', resumeSessionId: 'old' })!;
  assert.deepEqual(both.args.slice(0, 2), ['--resume', 'old']);

  // No session opts → unchanged legacy shape (context first).
  const plain = engine.spawnSpec(dir, 'claude')!;
  assert.equal(plain.args[0], '--append-system-prompt');
});

test('spawnSpec() session opts never leak into codex/cursor launches', () => {
  const dir = tmpDir('radial-eng-');
  const avail = engine.available();
  // Each spec is read only when available() reported its engine installed (the `!`s).
  if (avail.codex) {
    const codex = engine.spawnSpec(dir, 'codex', { sessionId: 'sid', resumeSessionId: 'sid' })!;
    assert.deepEqual(codex.args, [], 'codex has no session flags we control');
  }
  if (avail.cursor) {
    const cursor = engine.spawnSpec(dir, 'cursor', { sessionId: 'sid' })!;
    assert.deepEqual(cursor.args, []);
  }
});

test('pasteSequence wraps text in bracketed paste so a multi-line prompt does not submit early', () => {
  const seq = engine.pasteSequence('line one\nline two');
  assert.ok(seq.startsWith('\x1b[200~'), 'opens bracketed paste');
  assert.ok(seq.endsWith('\x1b[201~'), 'closes bracketed paste, no trailing CR (staged)');
  assert.ok(seq.includes('line one\nline two'), 'carries the full multi-line text intact');
  assert.ok(!seq.endsWith('\r'), 'staged by default — never auto-submits');
});

test('pasteSequence(submit:true) appends a carriage return to run it', () => {
  const seq = engine.pasteSequence('go', { submit: true });
  assert.ok(seq.endsWith('\x1b[201~\r'), 'CR after the paste close submits');
});

test('pasteSequence tolerates null/undefined', () => {
  assert.equal(engine.pasteSequence(null), '\x1b[200~\x1b[201~');
  assert.equal(engine.pasteSequence(undefined), '\x1b[200~\x1b[201~');
});

test('contextFor() seeds the radial CLI note, and the Home scope gets the Home brief instead of the marketing craft', () => {
  const cliSpec = require('../src/main/cliSpec') as typeof import('../src/main/cliSpec');
  const dir = tmpDir('radial-eng-');
  const ctx = engine.contextFor(dir);
  assert.ok(ctx.includes(cliSpec.agentNote()), 'every Claude session learns the radial verbs');
  assert.ok(ctx.includes('radial open '), 'the open verb is named');
  const home = engine.homeContext(dir);
  assert.ok(home.startsWith('RADIAL HOME'), 'the Home brief leads');
  assert.ok(home.includes(`Working directory: ${dir}`));
  assert.ok(home.includes(cliSpec.agentNote()), 'Home knows the CLI too');
  assert.ok(!home.includes('MARKETING-SITE EXPERTISE'), 'no project craft on Home');
  assert.ok(!home.includes('SHARED PREVIEW'), 'no shared-preview contract on Home');
});

test('once the migration playbook is installed, Home can start a migration and recommends a frontier model; projects can capture', () => {
  const dir = tmpDir('radial-eng-');
  assert.ok(!engine.homeContext(dir).includes('SITE MIGRATION'), 'no playbook, no migration note');
  engine.setMigrationPlaybook('/skills/site-migration/SKILL.md');
  try {
    const home = engine.homeContext(dir);
    assert.ok(home.includes('radial migrate start <url> --framework astro|next'), 'Home starts the whole flow');
    assert.ok(home.includes('latest frontier models at high to max effort'), 'Home passes on the model recommendation');
    assert.ok(home.includes('/skills/site-migration/SKILL.md'));
    const project = engine.contextFor(dir);
    assert.ok(project.includes('radial migrate capture <url>') && project.includes('radial migrate compare'), 'a project captures into itself');
    assert.ok(!project.includes('migrate start'), 'projects do not scaffold another project');
  } finally { engine.setMigrationPlaybook(null); }
});
