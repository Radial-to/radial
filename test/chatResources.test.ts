import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir } from './support/tmp';
const fs = require('fs') as typeof import('fs'), os = require('os') as typeof import('os'), path = require('path') as typeof import('path');
const { ChatResources, projectFiles } = require('../src/main/chat/resources') as typeof import('../src/main/chat/resources');
test('chat file access stays in its project or explicit attachments, including symlinks', () => {
  const root = tmpDir('radial-chat-files-');
  try {
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'hello world.md'), 'Hello'); fs.writeFileSync(path.join(root, 'private.txt'), 'Secret');
    fs.symlinkSync(path.join(root, 'private.txt'), path.join(repo, 'escape.txt'));
    const files = new ChatResources(path.join(root, 'attachments')), session = { repoDir: repo };
    assert.equal(files.resolve(session, 'hello%20world.md:12').line, 12);
    assert.throws(() => files.resolve(session, '../private.txt'), /outside/);
    assert.throws(() => files.resolve(session, 'escape.txt'), /outside/);
    assert.throws(() => files.resolve(session, 'https://example.com'), /local/);
    const attachment = files.import({ name: '../../reference.png', bytes: [1, 2, 3] });
    assert.equal(attachment.name, 'reference.png');
    assert.match(files.describe(session, attachment.path, true).src!, /^data:image\/png;base64,/);
    assert.throws(() => files.import({ name: 'empty.txt', bytes: [] }), /20 MB/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('draft previews allow bounded images and PDFs within the project or imported attachments', () => {
  const root = tmpDir('radial-chat-previews-');
  try {
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
    const files = new ChatResources(path.join(root, 'attachments')), session = { repoDir: repo };
    const pdf = files.import({ name: 'reference.pdf', bytes: Buffer.from('%PDF-1.4\n') });
    assert.equal(pdf.mime, 'application/pdf');
    assert.equal(files.preview(session, pdf.path).bytes.toString(), '%PDF-1.4\n');
    assert.equal(files.describe(session, pdf.path, true).src, undefined, 'PDF data is not exposed as an image URL');
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'text');
    assert.throws(() => files.preview(session, 'notes.txt'), /unavailable/);
    fs.writeFileSync(path.join(root, 'outside.pdf'), '%PDF');
    fs.symlinkSync(path.join(root, 'outside.pdf'), path.join(repo, 'escape.pdf'));
    assert.throws(() => files.preview(session, 'escape.pdf'), /outside/);
    fs.writeFileSync(path.join(repo, 'large.pdf'), Buffer.alloc(20 * 1024 * 1024 + 1));
    assert.throws(() => files.preview(session, 'large.pdf'), /unavailable/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('project file suggestions work without ripgrep: git repos list like rg, other folders are walked', async () => {
  const root = tmpDir('radial-chat-list-');
  try {
    const plain = path.join(root, 'plain'), repo = path.join(root, 'repo');
    for (const dir of [plain, repo]) {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Hi</h1>'); fs.writeFileSync(path.join(dir, 'src', 'index.js'), '');
      fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), ''); fs.writeFileSync(path.join(dir, '.env.local'), 'SECRET=1'); fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    }
    fs.mkdirSync(path.join(repo, '.next')); fs.writeFileSync(path.join(repo, '.next', 'index.html'), ''); fs.writeFileSync(path.join(repo, '.gitignore'), '.next\n');
    (require('child_process') as typeof import('child_process')).execFileSync('git', ['init', '-q'], { cwd: repo });
    const sorted = (list: string[]) => list.filter(Boolean).sort();
    assert.deepEqual(sorted(await projectFiles(plain, null)), ['.env.local', 'index.html', 'src/index.js', 'yarn.lock'], 'the walk skips node_modules');
    const tracked = await projectFiles(repo, null);
    assert.ok(tracked.includes('src/index.js') && !tracked.includes('.next/index.html'), 'git lists untracked files and leaves out ignored build output');
    // Whichever lister this machine has, suggestions apply the same exclusions.
    const files = new ChatResources(path.join(root, 'attachments'));
    for (const dir of [plain, repo]) assert.deepEqual((await files.list({ repoDir: dir }, 'index')).map(item => item.path).sort(), ['index.html', 'src/index.js']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
