import { test } from 'node:test';
import assert from 'node:assert';

import * as env from '../src/main/env';

test('childEnv PATH survives a minimal Finder-launch process.env (packaged-app regression)', () => {
  const orig = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  try {
    const out = env.childEnv();
    // The enhanced PATH must win over the minimal launch PATH — when it lost,
    // every npm shebang died with `env: node: No such file or directory`.
    assert.equal(out.PATH, env.enhancedPath());
    assert.notEqual(out.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  } finally { process.env.PATH = orig; }
});

test('childEnv still honors an explicit PATH override', () => {
  assert.equal(env.childEnv({ PATH: '/custom' }).PATH, '/custom');
});

test('childEnv strips inherited agent-session markers', () => {
  process.env.CLAUDE_CODE_TEST_MARKER = '1';
  try {
    const out = env.childEnv();
    assert.equal(out.CLAUDE_CODE_TEST_MARKER, undefined);
  } finally { delete process.env.CLAUDE_CODE_TEST_MARKER; }
});

test('childEnv keeps the Claude Code settings a person sets: Bedrock, Vertex, a sign-in token; a session marker still goes', () => {
  const set = { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_OAUTH_TOKEN: 'token-for-test', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1' };
  Object.assign(process.env, set);
  try {
    const out = env.childEnv();
    assert.deepEqual([out.CLAUDE_CODE_USE_BEDROCK, out.CLAUDE_CODE_USE_VERTEX, out.CLAUDE_CODE_OAUTH_TOKEN], ['1', '1', 'token-for-test']);
    assert.deepEqual([out.CLAUDE_CODE_ENTRYPOINT, out.CLAUDE_CODE_CHILD_SESSION, out.CLAUDECODE], [undefined, undefined, undefined]);
  } finally { for (const k of Object.keys(set)) delete process.env[k]; }
});

test('childEnv drops the e2e suites\' background and foreground switches: a terminal in the app under test never inherits them', () => {
  const set = { RADIAL_E2E_BACKGROUND: '1', RADIAL_E2E_FOREGROUND: '1' };
  Object.assign(process.env, set);
  try {
    const out = env.childEnv();
    assert.deepEqual([out.RADIAL_E2E_BACKGROUND, out.RADIAL_E2E_FOREGROUND], [undefined, undefined]);
  } finally { for (const k of Object.keys(set)) delete process.env[k]; }
});

test('enhancedPath covers npm-global and claude local install dirs when present', () => {
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const fs = require('fs') as typeof import('fs');
  const dir = path.join(os.homedir(), '.npm-global', 'bin');
  if (!fs.existsSync(dir)) return; // machine without the convention — nothing to assert
  assert.ok(env.enhancedPath().split(path.delimiter).includes(dir));
});

test('the shell is SHELL, or with SHELL unset (a container sets none) the first of zsh, bash and sh that exists', () => {
  const present = (...files: string[]) => (file: string) => files.includes(file);
  assert.equal(env.userShell({ SHELL: '/opt/homebrew/bin/fish' }, present('/bin/zsh')), '/opt/homebrew/bin/fish');
  assert.equal(env.userShell({}, present('/bin/zsh', '/bin/bash', '/bin/sh')), '/bin/zsh', 'a Mac');
  assert.equal(env.userShell({}, present('/bin/bash', '/bin/sh')), '/bin/bash', 'a Debian or Ubuntu image');
  assert.equal(env.userShell({}, present('/bin/sh')), '/bin/sh', 'a minimal image');
  assert.equal(env.userShell({ SHELL: '' }, present('/bin/bash', '/bin/sh')), '/bin/bash', 'an empty SHELL counts as unset');
  assert.equal(env.userShell({}, present()), '/bin/sh', 'with none of them found, sh, which POSIX systems have');
});
