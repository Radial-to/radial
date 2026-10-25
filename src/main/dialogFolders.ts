// Where each file picker opens. Without a defaultPath, Electron 43+ opens
// every picker in ~/Downloads (before, macOS reopened the last folder the app
// had used), so each picker says where it starts: the projects folder for
// project folders, the project itself for its images, the project's own
// folder when moving it, and the last folder used for migration files.
import fs from 'fs';
import path from 'path';

/** What the start folders depend on; main.ts fills it from the app's state. */
export interface FolderDeps {
  /** The projects folder the Home screen lists (recents), when one is set. */
  projectsDir: string | null;
  /** Where Radial clones GitHub repos (~/Radial). */
  workspaceRoot: string;
  home: string;
}

function isDir(dir: string | null | undefined): dir is string {
  if (!dir) return false;
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

/** The first of these folders that exists, else the home folder. */
function firstDir(dirs: (string | null | undefined)[], deps: FolderDeps): string {
  return dirs.find(isDir) || deps.home;
}

/** Pickers for project folders (open, create, the projects folder): the projects folder, else ~/Radial, else home. */
export function projectsFolder(deps: FolderDeps): string {
  return firstDir([deps.projectsDir, deps.workspaceRoot], deps);
}

/** Image pickers: the project's public/ when it has one, else the project. */
export function imagesFolder(repoDir: string, deps: FolderDeps): string {
  return firstDir([path.join(repoDir, 'public'), repoDir], deps);
}

/** Moving a project: the folder it is in now, so the picker shows it among its neighbors. */
export function besideProject(repoDir: string, deps: FolderDeps): string {
  return firstDir([path.dirname(repoDir)], deps);
}

/** Migration files: the folder the last pick came from, else the projects folder. */
export function lastUsedFolder(last: string | null | undefined, deps: FolderDeps): string {
  return firstDir([last, deps.projectsDir, deps.workspaceRoot], deps);
}
