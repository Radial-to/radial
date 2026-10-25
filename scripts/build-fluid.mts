import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = path.join(root, 'src/renderer/vendor/fluid');
await mkdir(outdir, { recursive: true });
const result = await build({ absWorkingDir: root, entryPoints: ['src/renderer/fluid/bridge.tsx'], outfile: path.join(outdir, 'chat.js'), bundle: true, format: 'iife', globalName: 'RadialFluidChat', platform: 'browser', target: 'chrome152', jsx: 'automatic', minify: true, legalComments: 'linked', metafile: true, define: { 'process.env.NODE_ENV': '"production"' } });
execFileSync(process.execPath, [path.join(root,'node_modules/@tailwindcss/cli/dist/index.mjs'), '-i', 'src/renderer/fluid/theme.css', '-o', path.join(outdir, 'chat.css'), '--minify'], { cwd: root, stdio: 'inherit' });
const css = await readFile(path.join(outdir, 'chat.css'), 'utf8');
// Native CSS scope keeps Tailwind utilities and Fluid tokens off the rest of
// the vanilla renderer. No Tailwind preflight is loaded.
await writeFile(path.join(outdir, 'chat.css'), '@scope (.fluid-chat) {\n' + css.replaceAll(':root', ':scope').replaceAll(':host', ':scope').replaceAll('.dark{', ':scope.dark{') + '\n}\n' + await readFile(path.join(root, 'src/renderer/fluid/radial.css'), 'utf8'));
await copyFile(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'), path.join(outdir, 'pdf.worker.min.mjs'));
const packages = new Map<string, string>();
for (const input of Object.keys(result.metafile.inputs).filter(input => input.includes('node_modules/'))) {
  let dir = path.dirname(path.join(root,input));
  while (dir !== root && !existsSync(path.join(dir,'package.json'))) dir=path.dirname(dir);
  if (dir === root || packages.has(dir)) continue;
  const pkg: { name: string; version: string; license?: string }=JSON.parse(readFileSync(path.join(dir,'package.json'),'utf8'));
  const licenses=readdirSync(dir).filter(file=>/^(licen[cs]e|notice)(\.|$)/i.test(file));
  packages.set(dir, `${pkg.name}@${pkg.version} (${pkg.license || 'see notice'})\n${licenses.map(file=>readFileSync(path.join(dir,file),'utf8')).join('\n')}`);
}
await writeFile(path.join(outdir,'LICENSES.txt'), await readFile(path.join(root,'src/renderer/fluid/LICENSE.txt'),'utf8')+'\n\n'+[...packages.values()].sort().join('\n\n----------------------------------------\n\n'));
console.log('Built scoped Fluid chat UI.');
