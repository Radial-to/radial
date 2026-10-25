// node-pty 1.1's macOS prebuilds ship spawn-helper without its execute bit, so after a
// fresh `npm ci` every terminal fails with "posix_spawnp failed" and no agent starts.
// Runs after install and puts the bit back. Safe to run again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty');
const candidates = [path.join(root, 'build', 'Release', 'spawn-helper')];
try {
  for (const dir of fs.readdirSync(path.join(root, 'prebuilds'))) {
    if (dir.startsWith('darwin')) candidates.push(path.join(root, 'prebuilds', dir, 'spawn-helper'));
  }
} catch {}
for (const file of candidates) {
  try {
    const mode = fs.statSync(file).mode;
    if ((mode & 0o111) !== 0o111) fs.chmodSync(file, mode | 0o755);
  } catch {}
}
