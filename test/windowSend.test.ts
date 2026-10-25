// Every main → window message goes through one function, main.ts's send():
// it's where a payload is checked against its channel in radialApi's
// WindowEvents, and the seam the headless core replaces with an event sink
// (plans/headless-core.md). A webContents.send anywhere else would skip both.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(full, out);
    else if (/\.(ts|cts|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

test('the main process sends to the window only through main.ts’s send()', () => {
  const sends: string[] = [];
  for (const file of tsFiles(path.join(SRC, 'main'))) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/webContents\??\.send\(/.test(line)) sends.push(`${path.relative(SRC, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(sends.map((at) => at.replace(/:\d+$/, '')), ['main/main.ts'], `webContents.send should appear once, in send(): found ${sends.join(', ')}`);
});
