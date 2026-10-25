import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as skills from '../src/main/skills';
import { tmpDir } from './support/tmp';

function tmp(): string { return tmpDir('radial-skill-test-'); }
function writeSkill(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: A test skill. Use when testing.\n---\n\nBody.\n`);
}
function hasPython() { try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }

test('slugify: kebab-cases, strips junk + edge hyphens, bounds length', () => {
  assert.equal(skills.slugify('PDF Processing!'), 'pdf-processing');
  assert.equal(skills.slugify('--Hello--World--'), 'hello-world');
  assert.equal(skills.slugify(''), 'skill');
  assert.equal(skills.slugify(null), 'skill');
  assert.ok(skills.slugify('x'.repeat(200)).length <= 64);
});

test('metaFor: parses name + description from frontmatter', () => {
  const d = tmp();
  writeSkill(path.join(d, 's'), 'my-skill');
  const meta = skills.metaFor(path.join(d, 's', 'SKILL.md'), 'fallback')!;
  assert.equal(meta.name, 'my-skill');
  assert.match(meta.description, /Use when testing/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('findSkillDir: root, one level, nested, and none', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: a\ndescription: b\n---');
  assert.equal(skills.findSkillDir(root), root);
  fs.rmSync(root, { recursive: true, force: true });

  const wrap = tmp(); // GitHub-style <repo>-main/ wrapper
  writeSkill(path.join(wrap, 'repo-main'), 'x');
  assert.equal(skills.findSkillDir(wrap), path.join(wrap, 'repo-main'));
  fs.rmSync(wrap, { recursive: true, force: true });

  const deep = tmp(); // two levels down
  writeSkill(path.join(deep, 'a', 'b'), 'x');
  assert.equal(skills.findSkillDir(deep), path.join(deep, 'a', 'b'));
  fs.rmSync(deep, { recursive: true, force: true });

  const none = tmp();
  fs.mkdirSync(path.join(none, 'sub'), { recursive: true });
  assert.equal(skills.findSkillDir(none), null);
  fs.rmSync(none, { recursive: true, force: true });
});

test('install: a folder with SKILL.md lands under project scope by slug', async () => {
  const repo = tmp(); const src = tmp();
  writeSkill(src, 'Cool Skill');
  const res = await skills.install(repo, 'project', [src]);
  assert.deepEqual(res.installed, ['cool-skill']);
  assert.equal(res.errors.length, 0);
  assert.equal(res.scope, 'project');
  assert.ok(fs.existsSync(path.join(repo, '.claude', 'skills', 'cool-skill', 'SKILL.md')));
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

test('install: a single .md becomes <slug>/SKILL.md', async () => {
  const repo = tmp(); const mdDir = tmp();
  const md = path.join(mdDir, 'whatever.md');
  fs.writeFileSync(md, '---\nname: solo-skill\ndescription: d\n---\nbody');
  const res = await skills.install(repo, 'project', [md]);
  assert.deepEqual(res.installed, ['solo-skill']);
  assert.ok(fs.existsSync(path.join(repo, '.claude', 'skills', 'solo-skill', 'SKILL.md')));
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(mdDir, { recursive: true, force: true });
});

test('install: a folder without SKILL.md errors, installs nothing', async () => {
  const repo = tmp(); const bad = tmp();
  fs.writeFileSync(path.join(bad, 'readme.txt'), 'no skill here');
  const res = await skills.install(repo, 'project', [bad]);
  assert.equal(res.installed.length, 0);
  assert.equal(res.errors.length, 1);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(bad, { recursive: true, force: true });
});

function buildZip(zipPath: string, entries: [name: string, body: string][]): void {
  const lines = ['import zipfile,sys', "z=zipfile.ZipFile(sys.argv[1],'w')"];
  for (const [name, body] of entries) lines.push(`z.writestr(${JSON.stringify(name)}, ${JSON.stringify(body)})`);
  lines.push('z.close()');
  execFileSync('python3', ['-c', lines.join('\n'), zipPath]);
}

test('install: a clean .zip installs the skill it wraps', { skip: !hasPython() }, async () => {
  const work = tmp(); const zip = path.join(work, 'pkg.zip');
  buildZip(zip, [['myskill/SKILL.md', '---\nname: zip-skill\ndescription: d\n---\nbody']]);
  const repo = tmp();
  const res = await skills.install(repo, 'project', [zip]);
  assert.deepEqual(res.installed, ['zip-skill']);
  assert.ok(fs.existsSync(path.join(repo, '.claude', 'skills', 'zip-skill', 'SKILL.md')));
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('install: a zip-slip archive is rejected and nothing escapes', { skip: !hasPython() }, async () => {
  const work = tmp(); const zip = path.join(work, 'evil.zip');
  buildZip(zip, [['myskill/SKILL.md', '---\nname: evil\ndescription: d\n---'], ['../escape.md', 'pwned']]);
  const repo = tmp();
  const res = await skills.install(repo, 'project', [zip]);
  assert.equal(res.installed.length, 0, 'malicious archive should install nothing');
  assert.equal(res.errors.length, 1);
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'escape.md')), 'zip-slip wrote outside the extract dir');
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});
