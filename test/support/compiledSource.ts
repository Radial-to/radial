'use strict';
// The JavaScript the build makes from an app source file, for tests that run a
// module inside a sandbox (node:vm) with stand-ins for what it requires.
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..', '..', 'src');

function compiledSource(file: string): string {
  const code = fs.readFileSync(file, 'utf8');
  if (!/\.(ts|cts|mts)$/.test(file)) return code;
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  return (require('../../scripts/transpile.mts') as typeof import('../../scripts/transpile.mts')).compile(rel, code);
}

export { compiledSource };
