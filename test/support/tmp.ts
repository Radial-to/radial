// Temporary folders for the unit tests. tmpDir(prefix) makes one the way
// fs.mkdtempSync(path.join(os.tmpdir(), prefix)) does, and removes it when the
// test file's process exits, whether its tests passed or not, so a run of the
// suite leaves nothing behind in the system temp folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made: string[] = [];
process.on('exit', () => {
  for (const dir of made) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} // one that can't go doesn't stop the rest
  }
});

/** A new, empty folder in the system temp folder, removed when this test file finishes. */
export function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
