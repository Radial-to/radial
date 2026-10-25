// Official builds (signed and released by Radial) carry one generated file,
// official-build.json, next to this module. scripts/official-build.mts writes
// it at package time and removes it afterwards; it is never committed.
//
// It holds what only the official app should have: the analytics key and the
// update feed. A build from source has no such file, so it sends no usage
// stats and never looks for updates.

import fs from 'fs';
import path from 'path';

/** official-build.json as scripts/official-build.mts writes it. */
export interface OfficialConfig {
  posthogKey: string;
  posthogHost: string;
}

const FILE = path.join(__dirname, 'official-build.json');

let file = FILE;
let cached: OfficialConfig | null | undefined; // undefined = not read yet; null = no file (a build from source)

function read(): OfficialConfig | null {
  if (cached !== undefined) return cached;
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    cached = data && typeof data === 'object' ? data as OfficialConfig : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** True only in a build made by scripts/official-build.mjs. */
function isOfficial(): boolean { return !!read(); }

/** One field of the official config, or undefined in a build from source. */
function get<K extends keyof OfficialConfig>(key: K): OfficialConfig[K] | undefined {
  const data = read();
  return data ? data[key] : undefined;
}

// Tests point this at a temporary file; production never calls it.
function _setFile(p: string | null | undefined): void { file = p || FILE; cached = undefined; }

export { isOfficial, get, FILE, _setFile };
