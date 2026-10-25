import { test } from 'node:test';
import assert from 'node:assert';
import { forbiddenBashReason } from '../src/main/devGuard';

test('blocks commands that start a dev server', () => {
  for (const cmd of [
    'next dev',
    'npm run dev',
    'pnpm dev',
    'pnpm run dev -- --port 3005',
    'yarn dev',
    'bun run dev',
    'npx next dev',
    'vite',
    'vite preview',
    'astro dev',
    'next start',
    'react-scripts start',
  ]) {
    assert.ok(forbiddenBashReason(cmd), `should block: ${cmd}`);
  }
});

test('blocks a framework binary that serves on its own, however it is run', () => {
  for (const cmd of [
    'npx vite',
    'vite --port 3000',
    'cd site && vite',
    'pnpm vite',
    'pnpm exec vite --host',
    'npx -y vite',
    'VITE_PORT=4000 vite',
    './node_modules/.bin/vite --host',
    'vite dev',
    'vite serve',
    'vite --port 3000 2>&1 | tee log',
    'nuxt',
    'nuxi dev',
    'npx nuxi dev --port 3000',
  ]) {
    assert.ok(forbiddenBashReason(cmd), `should block: ${cmd}`);
  }
});

test('allows commands that only name vite or nuxt, or build with them', () => {
  for (const cmd of [
    'cat vite.config.ts',
    'npm install -D vite',
    'pnpm add -D vite@latest',
    'rg vite src',
    'grep -rn "vite" package.json',
    'ls node_modules/.bin/vite',
    'npx vite build',
    'yarn vite build',
    'npm create vite@latest site',
    'cat nuxt.config.ts',
    'nuxt build',
  ]) {
    assert.equal(forbiddenBashReason(cmd), null, `should allow: ${cmd}`);
  }
});

test('blocks deleting the framework build/cache dir', () => {
  for (const cmd of [
    'rm -rf .next',
    'rm -rf ./.next',
    'rm -rf .next/cache',
    'rm -rf .vite',
    'rm -rf node_modules .next',
  ]) {
    assert.ok(forbiddenBashReason(cmd), `should block: ${cmd}`);
  }
});

test('allows legitimate build-fixing commands', () => {
  for (const cmd of [
    'pnpm install --ignore-workspace',
    'npm install',
    'tsc --noEmit',
    'pnpm run build',
    'cat next.config.ts',
    'ls node_modules/.bin',
    'rm -rf node_modules', // reinstalling deps is fine; it's not the build dir
    'git status',
    'echo "deploy to dev environment"', // "dev" as a word, not a server command
  ]) {
    assert.equal(forbiddenBashReason(cmd), null, `should allow: ${cmd}`);
  }
});

test('kill of a preview server pid is denied (leader or group member)', () => {
  const pids = new Set([812, 4321]);
  assert.match(forbiddenBashReason('kill 4321', { devServerPids: pids }) || '', /preview/);
  assert.match(forbiddenBashReason('kill -9 812 && echo done', { devServerPids: () => pids }) || '', /radial restart/);
});

test('kill of an unrelated pid is allowed', () => {
  const pids = new Set([812]);
  assert.equal(forbiddenBashReason('kill 9999', { devServerPids: pids }), null);
  assert.equal(forbiddenBashReason('kill 81', { devServerPids: pids }), null); // substring of 812 must not match
});

test('pkill/killall by dev-server name is always denied; plain kill without pid context is not', () => {
  assert.match(forbiddenBashReason('pkill -f next-server') || '', /by name/);
  assert.match(forbiddenBashReason('killall node') || '', /by name/);
  assert.equal(forbiddenBashReason('kill 1234'), null); // no pid set provided — nothing to match
  assert.equal(forbiddenBashReason('pkill -f my-batch-job'), null);
});

test('a throwing pid provider fails open (guard still covers the regex cases)', () => {
  assert.equal(forbiddenBashReason('kill 1234', { devServerPids: () => { throw new Error('x'); } }), null);
});

test('kill via port lookup is denied even though no pid is literal', () => {
  const { forbiddenBash } = require('../src/main/devGuard') as typeof import('../src/main/devGuard');
  for (const cmd of [
    'lsof -ti:58611 | xargs kill',
    'kill $(lsof -t -i:3000)',
    'npx kill-port 58611',
    'fuser -k 3000/tcp',
    'lsof -tiTCP:4321 -sTCP:LISTEN | xargs kill -9',
  ]) {
    const r = forbiddenBash(cmd);
    assert.ok(r && /^kill/.test(r.kind), `should deny: ${cmd}`);
  }
});

test('lsof without a kill (pure inspection) stays allowed', () => {
  const { forbiddenBash } = require('../src/main/devGuard') as typeof import('../src/main/devGuard');
  assert.equal(forbiddenBash('lsof -ti:58611'), null);
  assert.equal(forbiddenBash('lsof -nP -iTCP -sTCP:LISTEN'), null);
});

test('forbiddenBash exposes kinds for caller reactions', () => {
  const { forbiddenBash } = require('../src/main/devGuard') as typeof import('../src/main/devGuard');
  assert.equal(forbiddenBash('npm run dev')!.kind, 'server');
  assert.equal(forbiddenBash('pkill -f next-server')!.kind, 'kill-name');
  assert.equal(forbiddenBash('kill 4321', { devServerPids: new Set([4321]) })!.kind, 'kill-pid');
});
