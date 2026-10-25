import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Module, createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import * as env from '../src/main/env';
import { tmpDir } from './support/tmp';

/** Node's internal Module#_compile, which @types/node leaves out: runs source as this module's body. */
type CompilableModule = Module & { _compile(content: string, filename: string): void };
/** A fixture server's record of how it was launched (server.cjs below). */
interface Received { args: string[]; port?: string; agent?: string }

for (const runner of ['npm', 'pnpm', 'npm fallback']) {
  test(`Astro-style preview receives the assigned port through ${runner}`, { timeout: 20000 }, async t => {
    if (runner === 'pnpm' && !env.which('pnpm')) { t.skip('pnpm is not installed'); return; }
    const dir = tmpDir('radial-port-args-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', '.pnpm'));
    fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'astro'), 'fixture');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { dev: 'node server.cjs' }, dependencies: { astro: '0.0.0' },
    }));
    if (runner !== 'npm') fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    fs.writeFileSync(path.join(dir, 'server.cjs'), `
      const args = process.argv.slice(2);
      require('fs').writeFileSync('received.json', JSON.stringify({args, port: process.env.PORT, agent: process.env.CLAUDECODE}));
      if(args.length !== 2 || args[0] !== '--port') { console.error('Unexpected framework arguments: ' + JSON.stringify(args)); process.exit(1); }
      const server = require('http').createServer((req,res)=>res.end('preview ready'));
      server.listen(Number(args[1]), '127.0.0.1', ()=>console.log('http://127.0.0.1:' + server.address().port + '/'));
    `);
    // Exercise real package managers without asking Corepack to download a version.
    const filename = require.resolve('../src/main/devServer'), req = createRequire(filename);
    const mod = new Module(filename); mod.filename = filename;
    mod.require = name => name === './env' ? { ...env, which: cmd => cmd === 'corepack' || runner === 'npm fallback' && cmd === 'pnpm' ? null : env.which(cmd) } satisfies typeof env : req(name);
    // Compile the TypeScript source to CommonJS, as the build does, so its imports
    // go through mod.require above (as ES module source they'd bypass the stub).
    (mod as CompilableModule)._compile(transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', platform: 'node', sourcefile: filename }).code, filename);
    const handle = await (mod.exports as typeof import('../src/main/devServer')).start(dir, { timeoutMs: 12000 });
    t.after(() => handle.stop());
    const received: Received = JSON.parse(fs.readFileSync(path.join(dir, 'received.json'), 'utf8'));
    assert.deepEqual(received.args, ['--port', received.port]);
    assert.equal(new URL(handle.url).port, received.port);
    assert.equal(received.agent, undefined);
    assert.equal(await (await fetch(handle.url)).text(), 'preview ready');
  });
}
