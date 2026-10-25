import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as settings from '../src/main/chat/claudeSettings';
import * as permissions from '../src/shared/chatPermissions';
import { tmpDir } from './support/tmp';
function fixture(t: TestContext) {
  const dir = tmpDir('radial-claude-default-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, env: { CLAUDE_CONFIG_DIR: dir }, file: path.join(dir, 'settings.json') };
}
test('saving Full access preserves native settings and creates a private backup', t => {
  const { env, file } = fixture(t);
  const original = JSON.stringify({ model: 'opus', hooks: { Stop: [] }, permissions: { allow: ['Read'], deny: ['Bash(rm *)'], defaultMode: 'acceptEdits' }, extra: true });
  fs.writeFileSync(file, original);
  const before = settings.get(env); assert.equal(before.mode, 'edits');
  assert.equal(settings.set('full', before.revision, env).mode, 'full');
  const saved: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { ...(JSON.parse(original) as Record<string, unknown>), permissions: { ...(JSON.parse(original) as { permissions: Record<string, unknown> }).permissions, defaultMode: 'bypassPermissions' } }); // original is the JSON built above
  assert.equal(fs.readFileSync(file + '.radial-backup', 'utf8'), original);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(permissions.args('claude', 'cli'), []);
  assert.deepEqual(permissions.args('claude', 'full'), ['--permission-mode', 'bypassPermissions']);
  assert.deepEqual(permissions.args('claude', 'default'), ['--permission-mode', 'manual']);
});
test('new config and reset only change the native permission default', t => {
  const { env, file } = fixture(t);
  assert.equal(settings.get(env).mode, 'cli');
  settings.set('full', settings.get(env).revision, env);
  settings.set('cli', settings.get(env).revision, env);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
});
test('invalid settings and stale writes never overwrite user configuration', t => {
  const { env, file } = fixture(t);
  for (const raw of ['{ broken', '[]', '{"permissions":[]}', 'null']) {
    fs.writeFileSync(file, raw);
    assert.throws(() => settings.set('full', '', env), /invalid/);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
  fs.writeFileSync(file, '{}'); const stale = settings.get(env);
  fs.writeFileSync(file, '{"model":"sonnet"}');
  assert.throws(() => settings.set('full', stale.revision, env), /settings changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"model":"sonnet"}');
  assert.throws(() => settings.set('__proto__', settings.get(env).revision, env), /Unsupported/);
});
test('settings symlinks stay intact and unknown native modes are not misrepresented', t => {
  const { env, file, dir } = fixture(t);
  const target = path.join(dir, 'dotfiles.json');
  fs.writeFileSync(target, '{"permissions":{"defaultMode":"auto"}}'); fs.symlinkSync(target, file);
  assert.equal(settings.get(env).mode, 'custom');
  settings.set('default', settings.get(env).revision, env);
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  assert.equal((JSON.parse(fs.readFileSync(target, 'utf8')) as { permissions: { defaultMode?: unknown } }).permissions.defaultMode, 'default'); // the file settings.set() just wrote
});
