// Agent sleep policy: which idle agents may be shut down with a sleeping
// project, and how a slept Claude session is located for --resume.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import { AGENT_IDLE_MS, AGENT_IDLE_CEILING_MS, isKeptAwake, pickReapable, pickExpired, claudeProjectDir, sessionFileExists } from '../src/main/agentSleep';
import type { AgentPty } from '../src/main/agentSleep';
import type { PtyInfo } from '../src/main/terminal';
import { tmpDir } from './support/tmp';

/** A daemon list entry as the sleep policy reads it, plus the id the tests pick results out by. */
type FakePty = AgentPty & Pick<PtyInfo, 'id'>;

const NOW = 1_800_000_000_000;
const idleSince = NOW - AGENT_IDLE_MS - 1000;
const claudePty = (over: Partial<FakePty> = {}): FakePty => ({
  id: 'pty1', alive: true, lastDataAt: idleSince,
  meta: { engine: 'claude', label: 'Claude Code', sessionId: 'abc-123' },
  ...over,
});

test('pickReapable takes only idle claude agents with a session id', () => {
  const idle = claudePty();
  assert.deepEqual(pickReapable([idle], NOW), [idle], 'idle claude with a session id is reapable');
});

test('pickReapable never touches working agents, shells, or other engines', () => {
  const working = claudePty({ id: 'w', lastDataAt: NOW - 5000 });
  const shell = claudePty({ id: 's', meta: { engine: null, label: null, sessionId: null } });
  const codex = claudePty({ id: 'c', meta: { engine: 'codex', label: 'Codex', sessionId: 'x' } });
  const cursor = claudePty({ id: 'u', meta: { engine: 'cursor', label: 'Cursor', sessionId: 'x' } });
  const dead = claudePty({ id: 'd', alive: false });
  assert.deepEqual(pickReapable([working, shell, codex, cursor, dead], NOW), []);
});

test('a kept-awake session is never reaped: not by project sleep, not by the ceiling', () => {
  const kept = claudePty({ id: 'k', meta: { engine: 'claude', label: 'Phone', sessionId: 'abc', keepAwake: true } });
  assert.deepEqual(pickReapable([kept], NOW), [], 'idle, resumable, and still left alone');
  const parked: FakePty = { id: 'p', alive: true, attached: false, lastDataAt: NOW - AGENT_IDLE_CEILING_MS - 1, meta: { engine: 'claude', keepAwake: true } };
  assert.deepEqual(pickExpired([parked], NOW), [], 'past the ceiling and detached, still left alone');
  assert.deepEqual(pickExpired([{ ...parked, meta: { engine: 'claude' } }], NOW).map((p) => p.id), ['p'], 'the same session without the flag expires');
  assert.equal(isKeptAwake(kept), true); assert.equal(isKeptAwake(claudePty()), false); assert.equal(isKeptAwake(null), false);
});

test('pickReapable skips pre-feature agents (no session id — they cannot --resume)', () => {
  const old = claudePty({ meta: { engine: 'claude', label: 'Claude Code' } });
  assert.deepEqual(pickReapable([old], NOW), []);
});

test('pickReapable treats a missing lastDataAt (old daemon) as unknown → keep', () => {
  const unknown = claudePty({ lastDataAt: undefined });
  assert.deepEqual(pickReapable([unknown], NOW), [], 'old daemon reports no activity; never reap blind');
});

test('pickExpired: the parked-agent ceiling catches every engine, sessionId or not', () => {
  const parkedFor = (ms: number, over: Partial<FakePty> = {}) => claudePty({ lastDataAt: NOW - ms, ...over });
  const day = 24 * 60 * 60 * 1000;
  // The founder-machine shape: legacy claude (no sessionId) parked for a day,
  // and a cursor-agent parked for two — both expire.
  const legacy = parkedFor(day, { id: 'l', meta: { engine: 'claude', label: 'Claude Code' } });
  const cursor = parkedFor(2 * day, { id: 'c', meta: { engine: 'cursor', label: 'Cursor' } });
  assert.deepEqual(pickExpired([legacy, cursor], NOW).map((p) => p.id), ['l', 'c']);
  // Just under the ceiling → keep.
  assert.deepEqual(pickExpired([parkedFor(AGENT_IDLE_CEILING_MS - 1000)], NOW), []);
});

test('pickExpired: never shells, never attached, never unknown-activity, never dead', () => {
  const day = 24 * 60 * 60 * 1000;
  const shell = claudePty({ id: 's', lastDataAt: NOW - day, meta: { engine: null, label: null } });
  const attached = claudePty({ id: 'a', lastDataAt: NOW - day, attached: true });
  const unknown = claudePty({ id: 'u', lastDataAt: undefined });
  const dead = claudePty({ id: 'd', lastDataAt: NOW - day, alive: false });
  assert.deepEqual(pickExpired([shell, attached, unknown, dead], NOW), []);
});

test('the sleep-reap threshold is minutes; the ceiling is hours (sanity ordering)', () => {
  assert.ok(AGENT_IDLE_MS < 10 * 60 * 1000, 'sleep-reap reacts within minutes');
  assert.ok(AGENT_IDLE_CEILING_MS >= 60 * 60 * 1000, 'ceiling is a coarse backstop, not the product behavior');
  assert.ok(AGENT_IDLE_CEILING_MS > AGENT_IDLE_MS);
});

test('claudeProjectDir munges the repo path the way the Claude CLI does', () => {
  const dir = claudeProjectDir('/Users/you/Projects/my-site', '/home/x');
  assert.equal(dir, path.join('/home/x', '.claude', 'projects', '-Users-you-Projects-my-site'));
  // Dots munge too (e.g. a folder like site.v2).
  assert.ok(claudeProjectDir('/a/site.v2', '/h').endsWith('-a-site-v2'));
});

test('sessionFileExists: true only for a non-empty <id>.jsonl in the munged dir', () => {
  const home = tmpDir('radial-sleep-');
  const repo = '/tmp/proj';
  const sess = path.join(claudeProjectDir(repo, home));
  fs.mkdirSync(sess, { recursive: true });
  assert.equal(sessionFileExists(repo, 'nope', home), false, 'missing file');
  fs.writeFileSync(path.join(sess, 'empty.jsonl'), '');
  assert.equal(sessionFileExists(repo, 'empty', home), false, 'empty session never got a message — resume would error');
  fs.writeFileSync(path.join(sess, 'real.jsonl'), '{"type":"user"}\n');
  assert.equal(sessionFileExists(repo, 'real', home), true);
});

test('with CLAUDE_CONFIG_DIR set, Claude keeps its sessions there, and a slept session is found there to resume', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const config = tmpDir('radial-claude-config-');
  const repo = tmpDir('radial-sleep-repo-');
  try {
    process.env.CLAUDE_CONFIG_DIR = config;
    const sess = claudeProjectDir(repo);
    assert.equal(sess, path.join(config, 'projects', fs.realpathSync(repo).replace(/[^a-zA-Z0-9]/g, '-')), 'not ~/.claude');
    fs.mkdirSync(sess, { recursive: true });
    fs.writeFileSync(path.join(sess, 'kept.jsonl'), '{"type":"user"}\n');
    assert.equal(sessionFileExists(repo, 'kept'), true, 'so waking it resumes the conversation instead of starting over');
  } finally { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; }
});

test('a running app parks sessions after a longer idle than sleep does, and the cutoff is the caller\'s', () => {
  const { AGENT_PARK_MS, AGENT_IDLE_MS } = require('../src/main/agentSleep') as typeof import('../src/main/agentSleep');
  assert.ok(AGENT_PARK_MS > AGENT_IDLE_MS, 'parking while running waits far longer than sleep-at-quit');
  const halfHour: FakePty = { id: 'a', alive: true, meta: { engine: 'claude', sessionId: 's' }, lastDataAt: NOW - 30 * 60 * 1000 };
  assert.deepEqual(pickReapable([halfHour], NOW), [halfHour], 'idle past the sleep threshold');
  assert.deepEqual(pickReapable([halfHour], NOW, AGENT_PARK_MS), [], 'but not yet past the running-app threshold');
});
