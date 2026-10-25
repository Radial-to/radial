// The `radial` CLI (bin/radial, shipped in the app bundle) opens project
// folders by spawning the app binary with repeatable --open-path=<abs> flags.
// Electron's single-instance lock forwards that argv to the running instance
// (second-instance event); a cold launch parses its own process.argv. Extracted
// from main.js so the parsing is unit-testable without Electron.
//
// Flag-based on purpose, not positional: positional argv is ambiguous across
// dev (`electron . <path>`) and packaged (`Radial <path>`) launches, and other
// spawners (Playwright, LaunchServices) shove their own tokens into argv. And
// on purpose NOT a radial:// deep link: opening a folder starts its dev
// script, and a URL any webpage can fire must never reach that.

import fs from 'fs';
import path from 'path';

const FLAG = '--open-path=';

/**
 * Every --open-path= value in an argv array, resolved and validated to
 * absolute existing directories (deduped, order kept). `cwd` anchors relative
 * paths — for second-instance argv that's the CLI's working directory.
 */
function parseOpenPaths(argv: readonly unknown[], cwd?: string): string[] {
  const out: string[] = [];
  // Array.isArray narrows to an untyped array; the cast keeps each element unknown until the check below.
  for (const a of (Array.isArray(argv) ? argv : []) as readonly unknown[]) {
    if (typeof a !== 'string' || !a.startsWith(FLAG)) continue;
    const dir = normalizeOpenPath(a.slice(FLAG.length), cwd);
    if (dir && !out.includes(dir)) out.push(dir);
  }
  return out;
}

/**
 * Absolute existing directory for a CLI- or Finder-supplied path, or null.
 * A file resolves to its containing folder (`open -a Radial some/index.html`
 * should open the project, not error).
 */
function normalizeOpenPath(p: string | null | undefined, cwd?: string): string | null {
  if (typeof p !== 'string' || !p.trim()) return null;
  const abs = path.resolve(cwd || process.cwd(), p.trim());
  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) return abs;
    if (st.isFile()) return path.dirname(abs);
  } catch {}
  return null;
}

export { parseOpenPaths, normalizeOpenPath, FLAG };
