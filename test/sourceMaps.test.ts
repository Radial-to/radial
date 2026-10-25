// The source maps the build writes beside each compiled file
// (scripts/transpile.mts compileWithMap): every kind of file maps its lines
// back to its TypeScript, a window module's wrapper included, and no map
// carries the source itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceMap } from 'node:module';
import type { SourceMapPayload } from 'node:module';
import { compile, compileWithMap } from '../scripts/transpile.mts';

const SOURCE = [
  'type Pair = { a: number; b: number };',
  '',
  'export function first(p: Pair): number {',
  "  return p.a + Number('MARK_FIRST');",
  '}',
  'export function second(p: Pair): number {',
  "  return p.b * Number('MARK_SECOND');",
  '}',
].join('\n');

/** Where a marker's line in the compiled code maps back to in the TypeScript. */
function mapsBack(rel: string, source: string, marker: string): { file: string; line: number } {
  const { code, map } = compileWithMap(rel, source);
  const payload = JSON.parse(map) as SourceMapPayload & { sourcesContent?: unknown };
  assert.equal(payload.sourcesContent, undefined, 'no source inside');
  const lines = code.split('\n');
  const at = lines.findIndex((l) => l.includes(marker));
  const origin = new SourceMap(payload).findOrigin(at + 1, lines[at].indexOf(marker) + 1);
  assert.ok('fileName' in origin, `${rel}: ${marker} maps nowhere`);
  return { file: origin.fileName, line: origin.lineNumber };
}

test('main-process, window-script and window-module files map back to their own lines', () => {
  const window = SOURCE.replace(/export /g, ''); // a classic window script can't export
  assert.deepEqual(mapsBack('main/pair.ts', SOURCE, 'MARK_SECOND'), { file: 'src/main/pair.ts', line: 7 });
  assert.deepEqual(mapsBack('renderer/pair.ts', window, 'MARK_FIRST'), { file: 'src/renderer/pair.ts', line: 4 });
  assert.deepEqual(mapsBack('renderer/ui/pair.ts', SOURCE, 'MARK_SECOND'), { file: 'src/renderer/ui/pair.ts', line: 7 });
});

test('a module the window and Node share keeps its lines under the wrapper the build puts around it', () => {
  // renderer/navigation.ts is one of DUAL's: wrapped so the window gets a global and Node a module.
  const { code } = compileWithMap('renderer/navigation.ts', SOURCE);
  assert.match(code, /^\/\/ Built from src\/renderer\/navigation\.ts/);
  assert.deepEqual(mapsBack('renderer/navigation.ts', SOURCE, 'MARK_FIRST'), { file: 'src/renderer/navigation.ts', line: 4 });
  assert.deepEqual(mapsBack('renderer/navigation.ts', SOURCE, 'MARK_SECOND'), { file: 'src/renderer/navigation.ts', line: 7 });
});

test('compile() is the same code, without the map', () => {
  assert.equal(compile('main/pair.ts', SOURCE), compileWithMap('main/pair.ts', SOURCE).code);
});
