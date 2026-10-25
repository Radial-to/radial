// Where the file pickers open (src/main/dialogFolders.ts): Electron 43+ opens
// a picker without a start folder in ~/Downloads, so each one names its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectsFolder, imagesFolder, besideProject, lastUsedFolder } from '../src/main/dialogFolders';
import type { FolderDeps } from '../src/main/dialogFolders';
import { tmpDir } from './support/tmp';

/** A home folder with a projects folder and ~/Radial in it, all on disk. */
function machine(): FolderDeps & { projectsDir: string } {
  const home = tmpDir('radial-pickers-');
  const projectsDir = path.join(home, 'Sites');
  const workspaceRoot = path.join(home, 'Radial');
  fs.mkdirSync(projectsDir);
  fs.mkdirSync(workspaceRoot);
  return { home, projectsDir, workspaceRoot };
}

test('project folder pickers open in the projects folder, then ~/Radial, then home', () => {
  const m = machine();
  assert.equal(projectsFolder(m), m.projectsDir);
  assert.equal(projectsFolder({ ...m, projectsDir: null }), m.workspaceRoot, 'no projects folder set');
  fs.rmSync(m.projectsDir, { recursive: true });
  assert.equal(projectsFolder(m), m.workspaceRoot, 'the projects folder was deleted');
  fs.rmSync(m.workspaceRoot, { recursive: true });
  assert.equal(projectsFolder(m), m.home, 'nothing Radial knows is left');
});

test('image pickers open in the project, in its public/ when it has one', () => {
  const m = machine();
  const site = path.join(m.projectsDir, 'site');
  fs.mkdirSync(site);
  assert.equal(imagesFolder(site, m), site);
  fs.mkdirSync(path.join(site, 'public'));
  assert.equal(imagesFolder(site, m), path.join(site, 'public'));
  assert.equal(imagesFolder(path.join(site, 'gone'), m), m.home, 'a project that is gone falls back to home');
});

test('moving a project opens next to it', () => {
  const m = machine();
  const site = path.join(m.projectsDir, 'site');
  fs.mkdirSync(site);
  assert.equal(besideProject(site, m), m.projectsDir);
});

test('migration files open in the folder the last pick came from, else the projects folder', () => {
  const m = machine();
  const brand = path.join(m.home, 'Brand assets');
  fs.mkdirSync(brand);
  assert.equal(lastUsedFolder(brand, m), brand);
  assert.equal(lastUsedFolder(null, m), m.projectsDir, 'no pick yet');
  fs.rmSync(brand, { recursive: true });
  assert.equal(lastUsedFolder(brand, m), m.projectsDir, 'the last folder is gone');
});

test('a file where a folder should be is passed over', () => {
  const m = machine();
  const file = path.join(m.home, 'notes.txt');
  fs.writeFileSync(file, '');
  assert.equal(lastUsedFolder(file, m), m.projectsDir);
  assert.equal(projectsFolder({ ...m, projectsDir: file }), m.workspaceRoot);
});
