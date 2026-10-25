import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import * as projectState from '../src/main/projectState';
import { tmpDir } from './support/tmp';

function tmp() { return tmpDir('radial-ps-'); }

test('get returns an empty object for an unknown project', () => {
  projectState.init(tmp());
  assert.deepEqual(projectState.get('/no/such/repo'), {});
  assert.deepEqual(projectState.get(null), {});
});

test('set stores a patch and get reads it back', () => {
  projectState.init(tmp());
  const repo = '/repo/a';
  projectState.set(repo, { draft: 'hello', chat: [{ role: 'user', text: 'hi' }] });
  const s = projectState.get(repo);
  assert.equal(s.draft, 'hello');
  assert.equal(s.chat!.length, 1);
});

test('set merges patches rather than replacing the whole record', () => {
  projectState.init(tmp());
  const repo = '/repo/b';
  projectState.set(repo, { draft: 'keep me' });
  projectState.set(repo, { agentSessionId: 'sess-123' });
  const s = projectState.get(repo);
  assert.equal(s.draft, 'keep me');       // earlier field survives
  assert.equal(s.agentSessionId, 'sess-123');
});

test('clear removes a project record', () => {
  projectState.init(tmp());
  const repo = '/repo/c';
  projectState.set(repo, { draft: 'x' });
  projectState.clear(repo);
  assert.deepEqual(projectState.get(repo), {});
});

test('state survives a restart — the agent session id is restored from disk', () => {
  const userData = tmp();
  const repo = '/repo/persist';
  projectState.init(userData);
  projectState.set(repo, { agentSessionId: 'resume-me', chat: [{ role: 'user', text: 'remember this' }] });
  projectState.flush(); // write immediately instead of waiting on the debounce

  // Simulate an app restart: a fresh init pointed at the same userData dir.
  projectState.init(userData);
  const s = projectState.get(repo);
  assert.equal(s.agentSessionId, 'resume-me');
  // The legacy transcript is stored untyped (unknown[]); this entry is the one set above.
  assert.equal((s.chat![0] as { text: string }).text, 'remember this');
});

test('reset clears the persisted session id (set to null)', () => {
  const userData = tmp();
  const repo = '/repo/reset';
  projectState.init(userData);
  projectState.set(repo, { agentSessionId: 'old' });
  projectState.set(repo, { agentSessionId: null }); // what agent.reset() does
  projectState.flush();
  projectState.init(userData);
  assert.equal(projectState.get(repo).agentSessionId, null);
});

test('a corrupt store file is treated as empty, not a crash', () => {
  const userData = tmp();
  fs.writeFileSync(path.join(userData, 'radial-project-state.json'), '{ not valid json');
  projectState.init(userData); // should not throw
  assert.deepEqual(projectState.get('/anything'), {});
});
