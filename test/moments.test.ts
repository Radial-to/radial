// LooseUnion, for a check that reads a field the other kind has, is the
// window's ambient type: no module exports it yet.
/// <reference path="../src/renderer/types.d.ts" />
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import * as moments from '../src/main/moments';
import type { Moment, MomentRecordResult, MomentRestoreResult, SnapshotFailure } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

// The side of a result a test expects: it asserts that side, or reads only its fields.
type Recorded = Extract<MomentRecordResult, { moment: Moment }>;
type Unchanged = Extract<MomentRecordResult, { skipped: 'unchanged' }>;
type RestoreRefused = Extract<MomentRestoreResult, { ok: false }>;

function repo() {
  const dir = tmpDir('moments-');
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.radial/\n');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>v1</h1>');
  g('add', '-A'); g('commit', '-q', '-m', 'init');
  return dir;
}
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

test('record snapshots the tree and lists newest first', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>v2</h1>');
  const a = await moments.record(dir, { kind: 'edit', label: 'Edited index.html', files: ['index.html'] });
  assert.equal(a.ok, true);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>v3</h1>');
  const b = await moments.record(dir, { kind: 'agent', label: 'make it pop', files: ['index.html'] });
  assert.equal(b.ok, true);
  const { moments: list } = moments.list(dir);
  assert.equal(list.length, 2);
  assert.equal(list[0].label, 'make it pop'); // newest first
  assert.equal(list[0].kind, 'agent');
});

test('an unchanged tree is not recorded twice, but publish markers always are', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>v2</h1>');
  const a = await moments.record(dir, { label: 'one' }) as Recorded;
  const b = await moments.record(dir, { label: 'two' }) as Unchanged;
  assert.equal(b.skipped, 'unchanged');
  assert.equal(b.id, a.moment.id);
  const c: LooseUnion<MomentRecordResult> = await moments.record(dir, { kind: 'publish', label: 'Published' });
  assert.equal(c.ok, true);
  assert.equal(c.skipped, undefined);
  assert.equal(moments.list(dir).moments.length, 2);
});

test('preview rewinds the working tree; backToNow returns exactly, including new files', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>old</h1>');
  const a = await moments.record(dir, { label: 'old moment' }) as Recorded;
  // The present: index changed AND a brand-new file the old moment lacks.
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>new</h1>');
  fs.writeFileSync(path.join(dir, 'extra.css'), 'body{}');
  await moments.record(dir, { label: 'newer moment' });

  const p = await moments.preview(dir, a.moment.id);
  assert.equal(p.ok, true);
  assert.equal(read(dir, 'index.html'), '<h1>old</h1>');
  assert.equal(fs.existsSync(path.join(dir, 'extra.css')), false, 'file that postdates the moment disappears in preview');
  assert.equal(await moments.isPreviewing(dir), true);

  const back = await moments.backToNow(dir);
  assert.equal(back.ok, true);
  assert.equal(read(dir, 'index.html'), '<h1>new</h1>');
  assert.equal(read(dir, 'extra.css'), 'body{}', 'new file comes back');
  assert.equal(await moments.isPreviewing(dir), false);
});

test('restore keeps the previewed version and records a restore moment', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>keep me</h1>');
  const a = await moments.record(dir, { label: 'the good one' }) as Recorded;
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>regret</h1>');
  await moments.record(dir, { label: 'the bad one' });

  await moments.preview(dir, a.moment.id);
  const r = await moments.restore(dir, a.moment.id);
  assert.equal(r.ok, true);
  assert.equal(read(dir, 'index.html'), '<h1>keep me</h1>');
  assert.equal(await moments.isPreviewing(dir), false);
  const list = moments.list(dir).moments;
  assert.equal(list[0].kind, 'restore');
  assert.match(list[0].label, /Restored: the good one/);
  assert.equal(list.length, 3, 'nothing was deleted from history');
});

test('.radial is never part of a snapshot or clobbered by preview', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>a</h1>');
  const a = await moments.record(dir, { label: 'a' }) as Recorded;
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>b</h1>');
  await moments.record(dir, { label: 'b' });
  await moments.preview(dir, a.moment.id);
  assert.equal(fs.existsSync(path.join(dir, '.radial', 'history', 'moments.jsonl')), true, 'history log survives time travel');
  await moments.backToNow(dir);
});

test('history is capped: oldest moments (and their refs) are pruned', async () => {
  const dir = repo();
  for (let i = 0; i < moments.MAX_MOMENTS + 5; i++) {
    fs.writeFileSync(path.join(dir, 'index.html'), `<h1>v${i}</h1>`);
    await moments.record(dir, { label: `v${i}` });
  }
  const list = moments.list(dir).moments;
  assert.equal(list.length, moments.MAX_MOMENTS);
  assert.equal(list[0].label, `v${moments.MAX_MOMENTS + 4}`);
  const refs = execFileSync('git', ['for-each-ref', 'refs/radial/moments/'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
  assert.equal(refs.length, moments.MAX_MOMENTS, 'pruned moments drop their gc-pins too');
});

test('saveThumb stores a png for a known moment and rejects junk', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>x</h1>');
  const a = await moments.record(dir, { label: 'x' }) as Recorded;
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal(moments.saveThumb(dir, a.moment.id, px).ok, true);
  assert.equal(moments.list(dir).moments[0].thumb, moments.thumbPath(dir, a.moment.id));
  assert.equal(moments.saveThumb(dir, 'nope', px).ok, false);
  assert.equal(moments.saveThumb(dir, a.moment.id, 'data:text/html;base64,x').ok, false);
});

test('watchRepo onTouch fires fast (short debounce) alongside the slow moment burst', async () => {
  const dir = repo();
  const touches: string[][] = [];
  const bursts: string[][] = [];
  const w = moments.watchRepo(dir, { idleMs: 2500, onBurst: (f) => bursts.push(f), touchMs: 200, onTouch: (f) => touches.push(f) });
  await new Promise((r) => setTimeout(r, 1200)); // clear the FSEvents replay grace
  fs.writeFileSync(path.join(dir, 'about.html'), '<h1>new page</h1>');
  fs.mkdirSync(path.join(dir, '.radial'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.radial', 'dev.json'), '{}');
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(touches.length, 1, 'touch ping fired without waiting out the moment idle window');
  assert.deepEqual(touches[0], ['about.html'], 'same noise filtering as bursts');
  assert.equal(bursts.length, 0, 'the slow moment burst has not fired yet');
  w.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('watchRepo coalesces outside-edit bursts and ignores noise dirs', async () => {
  const dir = repo();
  const bursts: string[][] = [];
  const w = moments.watchRepo(dir, { idleMs: 400, onBurst: (files) => bursts.push(files) });
  await new Promise((r) => setTimeout(r, 1200)); // clear the FSEvents replay grace
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>terminal-agent-edit</h1>');
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), 'x');
  fs.mkdirSync(path.join(dir, '.radial'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.radial', 'dev.json'), '{}');
  await new Promise((r) => setTimeout(r, 1500));
  w.close();
  assert.equal(bursts.length, 1, 'one coalesced burst');
  assert.deepEqual(bursts[0], ['index.html'], 'noise dirs excluded');
  // A write after close must not fire.
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>after close</h1>');
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(bursts.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('revertTo restores the checkpoint once changes landed, refuses while nothing changed', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>before</h1>');
  const cp = await moments.record(dir, { kind: 'edit', label: 'Before adjust: padding-top 16→24' }) as Recorded;
  assert.equal(cp.ok, true);
  // Nothing landed yet (the agent is still working) — revert must refuse
  // rather than "restore" an identical tree and read as a no-op Undo.
  const early = await moments.revertTo(dir, cp.moment.id) as RestoreRefused;
  assert.equal(early.ok, false);
  assert.equal(early.reason, 'unchanged');
  assert.equal(read(dir, 'index.html'), '<h1>before</h1>');
  // The agent lands its edit; revert restores the checkpoint exactly and
  // records the revert as a new restore moment (nothing is deleted).
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>agent-adjusted</h1>');
  const r = await moments.revertTo(dir, cp.moment.id, 'Reverted adjust: padding-top 16→24');
  assert.equal(r.ok, true);
  assert.equal(read(dir, 'index.html'), '<h1>before</h1>');
  const { moments: list } = moments.list(dir);
  assert.equal(list[0].kind, 'restore');
  assert.equal(list[0].label, 'Reverted adjust: padding-top 16→24');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('revertTo an unknown id fails cleanly', async () => {
  const dir = repo();
  const r = await moments.revertTo(dir, 'nope') as RestoreRefused;
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-found');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('returning from history refuses to overwrite terminal edits made while previewing', async () => {
  const dir = repo();
  const old = await moments.record(dir, { label: 'original' }) as Recorded;
  fs.writeFileSync(path.join(dir, 'index.html'), 'present');
  assert.equal((await moments.preview(dir, old.moment.id)).ok, true);
  fs.writeFileSync(path.join(dir, 'index.html'), 'terminal edit during history');
  const result = await moments.backToNow(dir) as SnapshotFailure;
  assert.equal(result.reason, 'checkout-changed');
  assert.equal(read(dir, 'index.html'), 'terminal edit during history');
  assert.equal(await moments.isPreviewing(dir), true);
});

test('a repo with no git identity anywhere still records moments, as its OS user: a fresh VM or container has no git config', async () => {
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const dir = repo(); // its first commit names an author of its own
  try {
    for (const k of keys) delete process.env[k];
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'; // no user.name or user.email in any config git reads
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>v2</h1>');
    const r = await moments.record(dir, { kind: 'edit', label: 'Edited index.html' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const author = execFileSync('git', ['log', '-1', '--format=%an <%ae>', (r as Recorded).moment.commit], { cwd: dir, encoding: 'utf8' }).trim();
    const user = os.userInfo().username;
    assert.equal(author, `${user} <${user}@localhost>`, 'the OS user, never a guess from the host name');
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
