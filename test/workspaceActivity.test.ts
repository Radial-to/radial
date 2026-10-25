import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot } from '../src/main/workspaceActivity';
import type { ActivitySession } from '../src/main/workspaceActivity';
test('activity excludes sleeping/stopped servers and exited terminals, with honest external uptime', () => {
  const sessions = new Map<string, ActivitySession>([
    ['/a', { project: { name: 'Alpha', framework: 'astro' }, handle: { url: 'http://localhost:3001', startedAt: 100, child: { pid: 11, exitCode: null } } }],
    ['/b', { project: { name: 'Beta' }, suspended: true, handle: { url: 'stale' } }],
    ['/c', { project: {}, handle: { url: 'stale', child: { exitCode: 1 } } }],
    ['/d', { project: {}, handle: { url: 'http://localhost:3002', external: true, startedAt: 50, observedAt: 200, pid: 22 } }],
    ['/e', { project: {}, handle: { url: 'http://localhost:3003', startedAt: 300 } }],
  ]);
  const result = snapshot({ sessions, pid: 99, now: 10000, agents: [
    { id: '1', alive: true, repoDir: '/a', meta: { engine: 'claude', label: 'Fix navigation' }, startedAt: 100, lastDataAt: 9000 },
    { id: '2', alive: true, repoDir: '/workspace', meta: { home: true }, lastDataAt: 100, lastBellAt: 200, lastInputAt: 150 },
    { id: '3', alive: false, repoDir: '/b' },
  ] });
  assert.equal(result.projects.filter(p => p.server).length, 3);
  assert.equal(result.projects[0].server!.pid, 11);
  assert.equal(result.projects[3].server!.startedAt, null);
  assert.equal(result.projects[3].server!.observedAt, 200);
  assert.equal(result.projects[4].server!.pid, 99);
  assert.equal(result.terminals.length, 2);
  assert.equal(result.terminals[0].project, 'Alpha');
  assert.equal(result.terminals[0].state, 'working');
  assert.equal(result.terminals[1].project, 'Workspace');
  assert.equal(result.terminals[1].state, 'waiting');
});
