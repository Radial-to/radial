import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { MARKETING_SKILLS } from '../src/main/agent';
import * as engine from '../src/main/engine';
import { tmpDir } from './support/tmp';

// The "only knows marketing sites" moat is a real system-prompt layer, not just
// positioning copy. These tests pin the domain knowledge the agent ships with so
// it can't silently regress back to a generic coding agent. Since the SDK chat
// was removed, the layer reaches the agent through engine.contextFor (the
// terminal agents' seeded context).

test('marketing skills cover the core marketing-site concerns', () => {
  assert.match(MARKETING_SKILLS, /MARKETING-SITE EXPERTISE/);
  assert.match(MARKETING_SKILLS, /hero/i);
  assert.match(MARKETING_SKILLS, /\bCTA(s)?\b/);
  assert.match(MARKETING_SKILLS, /pricing/i);
  assert.match(MARKETING_SKILLS, /Open Graph|<title>|meta description/);
  assert.match(MARKETING_SKILLS, /accessib|focus state|contrast/i);
  assert.match(MARKETING_SKILLS, /mobile.*desktop|responsive/i);
});

test('marketing skills defer to project rules and forbid fabrication', () => {
  assert.match(MARKETING_SKILLS, /PRECEDENCE/);
  assert.match(MARKETING_SKILLS, /AGENTS\.md/);
  assert.match(MARKETING_SKILLS, /`\.context\/`/);
  assert.match(MARKETING_SKILLS, /never invent or fabricate|never fabricate/i);
});

test('engine.contextFor wires the marketing layer into every terminal agent', () => {
  // A nonexistent repo exercises the safe fallbacks (no AGENTS.md, no refs)
  // and still returns the baked-in marketing guidance + dev-server protocol.
  const ctx = engine.contextFor('/nonexistent-radial-repo');
  assert.ok(ctx.includes(MARKETING_SKILLS), 'contextFor includes the marketing skills block verbatim');
  assert.match(ctx, /restart-dev-server/, 'dev-server protocol rides along');
});

test('engine.contextFor appends the project AGENTS.md rules', () => {
  const dir = tmpDir('engine-ctx-');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '## Project rules\n- Never use em dashes in copy.\n');
  const ctx = engine.contextFor(dir);
  assert.match(ctx, /Never use em dashes/);
  assert.match(ctx, /saved rules/i);
  fs.rmSync(dir, { recursive: true, force: true });
});
