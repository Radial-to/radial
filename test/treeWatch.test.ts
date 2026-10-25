// A watch over a whole folder tree (src/main/treeWatch.ts), both ways it
// works: the OS's recursive watch (macOS, Windows) and a watch per folder
// (Linux, where Node's recursive watch adds one inotify watch per folder,
// node_modules included, and throws an uncaught exception from its own
// listener when a folder appears that it can't watch).

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import { watchTree } from '../src/main/treeWatch';
import type { TreeWatchOptions } from '../src/main/treeWatch';
import { tmpDir } from './support/tmp';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const skip = (name: string) => name.startsWith('.') || name === 'node_modules';
// The native watch is the OS's own recursive one, which Linux's Node fakes the way this file says it shouldn't be used.
const modes: NonNullable<TreeWatchOptions['mode']>[] = process.platform === 'linux' ? ['walk'] : ['native', 'walk'];
const root = process.getuid?.() === 0; // root reads a folder whatever its permissions

/** A tree with a source folder, a dependency folder and a dot folder. */
function tree(): string {
  const dir = tmpDir('radial-treewatch-');
  for (const sub of ['src/pages', 'node_modules/pkg/lib', '.git/objects']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), 'v1');
  return dir;
}
/** Collects what a watch reports; seen(file) waits until it reported that file. */
function collect() {
  const files = new Set<string>();
  return {
    onChange: (_event: string, file: string) => { files.add(file.split(path.sep).join('/')); },
    files,
    seen: async (file: string, ms = 5000) => { const t0 = Date.now(); while (!files.has(file)) { if (Date.now() - t0 > ms) return false; await sleep(25); } return true; },
  };
}

for (const mode of modes) {
  test(`${mode}: changes anywhere in the tree come with their path from the root, in folders made after the watch too; skipped folders say nothing`, async () => {
    const dir = tree();
    const c = collect();
    const w = watchTree(dir, c.onChange, { skip, mode });
    try {
      await sleep(150);
      fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'lib', 'x.js'), '1');
      fs.writeFileSync(path.join(dir, '.git', 'objects', 'y'), '1');
      fs.writeFileSync(path.join(dir, 'src', 'pages', 'about.html'), 'about');
      assert.ok(await c.seen('src/pages/about.html'), [...c.files].join(', '));
      fs.mkdirSync(path.join(dir, 'src', 'blog', '2026'), { recursive: true });
      await sleep(150); // a new folder joins the watch
      fs.writeFileSync(path.join(dir, 'src', 'blog', '2026', 'post.html'), 'post');
      assert.ok(await c.seen('src/blog/2026/post.html'), [...c.files].join(', '));
      await sleep(200);
      assert.deepEqual([...c.files].filter((f) => f.startsWith('node_modules') || f.startsWith('.git')), [], 'nothing from node_modules or .git');
    } finally { w.close(); }
  });
}

test('walk: a folder it can’t watch, there from the start or made later, goes unwatched without throwing, and the rest keeps reporting', { skip: root && 'root can read any folder' }, async () => {
  const dir = tree();
  fs.mkdirSync(path.join(dir, 'locked-early'), { mode: 0o000 });
  const c = collect();
  const w = watchTree(dir, c.onChange, { skip, mode: 'walk' });
  try {
    await sleep(150);
    fs.mkdirSync(path.join(dir, 'locked-late'), { mode: 0o000 }); // Node's own recursive watch throws an uncaught EACCES here on Linux
    await sleep(300);
    fs.writeFileSync(path.join(dir, 'src', 'pages', 'still.html'), 'still');
    assert.ok(await c.seen('src/pages/still.html'), [...c.files].join(', '));
  } finally {
    w.close();
    for (const d of ['locked-early', 'locked-late']) fs.chmodSync(path.join(dir, d), 0o755); // so tmp cleanup can remove them
  }
});

test('the root itself must be watchable: a missing one throws, as fs.watch does', () => {
  assert.throws(() => watchTree(path.join(tmpDir('radial-treewatch-'), 'gone'), () => {}, { mode: 'walk' }), /ENOENT/);
});
