import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const dir = new URL('../src/renderer/vendor/chat/', import.meta.url);
await mkdir(dir, { recursive: true });
await build({ entryPoints: ['scripts/chat-entry.mts'], outfile: 'src/renderer/vendor/chat/content.js', bundle: true, format: 'iife', globalName: 'RadialChatContent', platform: 'browser', target: 'chrome152', minify: true, legalComments: 'linked' });
const licenses: string[] = [];
for (const [name, file] of [['marked','LICENSE'],['dompurify','LICENSE'],['highlight.js','LICENSE']]) {
  licenses.push(name + '\n' + await readFile(new URL('../node_modules/' + name + '/' + file, import.meta.url), 'utf8'));
}
await writeFile(new URL('LICENSES.txt', dir), licenses.join('\n\n'));
