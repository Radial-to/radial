/**
 * Where this Radial was installed from, for the advice the headless commands
 * give: the radial-cli npm package (scripts/pack-cli.mts), or a checkout of
 * the repo (its own package.json, `npm ci`). Both lay out out/ the same way,
 * so the install's root is two folders above out/headless.
 */
import fs from 'fs';
import path from 'path';

/** Radial's own folder: the npm package's, or a checkout's. */
export function installRoot(): string { return path.join(__dirname, '..', '..'); }

/** Whether this is the radial-cli npm package (else a checkout), by the name in its package.json. */
export function isPackage(root: string = installRoot()): boolean {
  try { return (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: string }).name === 'radial-cli'; } catch { return false; }
}
