import { test } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import * as devServer from '../src/main/devServer';
import * as project from '../src/main/project';
import * as editEngine from '../src/main/editEngine';
import * as publish from '../src/main/publish';
import type { StaticProject } from '../src/main/devServer';
import type { TextEditDone } from '../src/main/editEngine';
import type { PublishReceipt } from '../src/shared/radialApi';
import { tmpDir } from './support/tmp';

const SAMPLE = path.join(__dirname, '..', 'samples', 'static-site');

/** What the server answered: its status code and the whole body. */
interface Fetched { status: number | undefined; body: string }

function get(url: string): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

test('detects the static sample site', () => {
  const p = devServer.detectProject(SAMPLE) as StaticProject;
  assert.equal(p.type, 'static');
  assert.equal(p.framework, 'static');
});

test('discovers all three pages', () => {
  const p = devServer.detectProject(SAMPLE);
  const pages = project.listPages(SAMPLE, p);
  const routes = pages.map((x) => x.route).sort();
  assert.deepEqual(routes, ['/', '/about', '/contact']);
  assert.equal(pages[0].route, '/'); // Home first
});

test('serves the running site and edits round-trip to source', async () => {
  // copy sample to a temp dir so we don't mutate the repo's sample (skip any
  // dotfiles/dirs like a stray .radial that a dev run may have left behind)
  const dir = tmpDir('radial-int-');
  for (const f of fs.readdirSync(SAMPLE)) {
    if (f.startsWith('.')) continue;
    const src = path.join(SAMPLE, f);
    if (!fs.statSync(src).isFile()) continue;
    fs.copyFileSync(src, path.join(dir, f));
  }

  const handle = await devServer.start(dir, { onLog: () => {} });
  try {
    const res = await get(handle.url);
    assert.equal(res.status, 200);
    assert.match(res.body, /We design brands people remember/);

    // Simulate an overlay edit of the hero title.
    const edit = {
      originalText: 'We design brands people remember',
      newText: 'We build brands people remember',
      context: { tagName: 'h1', classList: ['hero-title'], occurrenceIndex: 0 },
    };
    const result = editEngine.applyTextEdit(dir, edit) as TextEditDone;
    assert.equal(result.ok, true);
    assert.equal(result.relFile, 'index.html');

    // Server should now serve the new text (no-store cache).
    const after = await get(handle.url);
    assert.match(after.body, /We build brands people remember/);

    // Disambiguation: "Learn more" appears 3x with the same class — occurrence index resolves it.
    const dup = editEngine.applyTextEdit(dir, {
      originalText: 'Learn more',
      newText: 'See details',
      context: { tagName: 'a', classList: ['card-link'], occurrenceIndex: 1 },
    });
    assert.equal(dup.ok, true);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.equal((html.match(/Learn more/g) || []).length, 2); // one replaced
  } finally {
    await handle.stop();
  }
});

test('publish commits to a real git repo', async () => {
  const dir = tmpDir('radial-git-');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main']); // the production branch, whatever git's default (Linux git says master)
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);

  // edit, then publish to staging (no remote -> push skipped gracefully)
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Hello there</h1>');
  const res = await publish.publish(dir, { target: 'staging', push: true }) as PublishReceipt;
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'preview');
  assert.equal(res.branch, 'staging');
  assert.ok(res.steps.some((s) => /committed edits/.test(s)));
  assert.ok(res.steps.some((s) => /no origin remote/.test(s)));

  // vNext branch model: you stay where you work; staging is only a remote destination.
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).toString().trim();
  assert.equal(branch, 'main');
  assert.match(execFileSync('git', ['show', 'main:index.html'], { cwd: dir }).toString(), /Hello there/);
});
