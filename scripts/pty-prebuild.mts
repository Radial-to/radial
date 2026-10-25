#!/usr/bin/env node
// node-pty's binary for Linux, built here, for the radial-cli package to carry
// (plans/headless-core.md, phase 5). node-pty ships prebuilt binaries for
// macOS and Windows only; with these in its prebuilds folder, an install on
// Linux x64 or arm64 needs no compiler.
//
//   node scripts/pty-prebuild.mts --out <dir> [--max-glibc 2.28]
//
// Run it on the architecture to build for, on an old glibc, so the binary
// loads on newer ones too: AlmaLinux 8 has glibc 2.28, the oldest Node's own
// Linux builds run on, so wherever Node runs this loads. Debian bullseye (2.31)
// has left Debian's mirrors, and a build on 2.34 or newer needs 2.34 (forkpty
// moved into libc), which leaves out Ubuntu 20.04 and RHEL 8. The CI job and
// Docker here run, on each architecture (a Mac's Docker emulates x64):
//
//   docker run --rm -e npm_config_python=/usr/bin/python3.11 -v "$PWD:/src:ro" -v "$PWD/pty-prebuilds:/out" almalinux:8 sh -c \
//     'dnf -y module enable nodejs:22 && dnf -y install nodejs npm gcc-c++ make python3.11 binutils && node /src/scripts/pty-prebuild.mts --out /out'
//
// (node-gyp needs Python 3.8 or newer; AlmaLinux 8's python3 is 3.6.) It
// installs the node-pty version in package-lock.json into a scratch folder
// (node-gyp compiles it, against the image's own Node headers when it has
// them), checks the newest glibc symbol version the binary needs (objdump),
// checks that it loads from a prebuilds folder and runs a shell, and writes
// <dir>/linux-<arch>/pty.node. node-pty is N-API, so one binary serves every
// Node version.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The newest GLIBC_x.y version among objdump -T's lines, or null when it names none. */
export function newestGlibc(objdump: string): string | null {
  let best: number[] | null = null;
  for (const m of objdump.matchAll(/GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g)) {
    const v = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
    if (!best || v[0] > best[0] || (v[0] === best[0] && (v[1] > best[1] || (v[1] === best[1] && v[2] > best[2])))) best = v;
  }
  return best ? best.slice(0, best[2] ? 3 : 2).join('.') : null;
}
/** Whether version a (2.31) is newer than b (2.28). */
export function newer(a: string, b: string): boolean {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}

function main(argv: string[]): void {
  let out = '', maxGlibc = '2.28';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = path.resolve(argv[++i]);
    else if (argv[i] === '--max-glibc') maxGlibc = argv[++i];
    else throw new Error(`Unknown option ${argv[i]}. Usage: node scripts/pty-prebuild.mts --out <dir> [--max-glibc 2.28]`);
  }
  if (!out) throw new Error('--out <dir> is needed');
  if (process.platform !== 'linux') throw new Error('This builds node-pty for Linux: run it on Linux (CI, or Docker).');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };
  const version = lock.packages['node_modules/node-pty']?.version;
  if (!version) throw new Error('package-lock.json has no node-pty');
  const arch = process.arch;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-prebuild-'));
  try {
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ private: true, dependencies: { 'node-pty': version } }));
    // node-gyp needs Node's headers: the official Node images carry them, so nothing has to be downloaded for them.
    const env: NodeJS.ProcessEnv = { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
    const prefix = path.dirname(path.dirname(process.execPath));
    if (fs.existsSync(path.join(prefix, 'include', 'node', 'node_api.h'))) env.npm_config_nodedir = prefix;
    console.log(`Building node-pty ${version} for linux-${arch} (Node ${process.versions.node}${env.npm_config_nodedir ? `, headers from ${prefix}` : ''})…`);
    execFileSync('npm', ['install', '--foreground-scripts'], { cwd: work, env, stdio: 'inherit' });
    const pty = path.join(work, 'node_modules', 'node-pty');
    const built = path.join(pty, 'build', 'Release', 'pty.node');
    if (!fs.existsSync(built)) throw new Error(`node-gyp left no ${built}`);
    // The newest glibc it needs: what the oldest Linux it loads on must have.
    const dump = execFileSync('objdump', ['-T', built], { encoding: 'utf8' });
    const glibc = newestGlibc(dump);
    console.log(`pty.node needs glibc ${glibc || '(no versioned symbols)'} or newer.`);
    if (glibc && newer(glibc, maxGlibc)) throw new Error(`pty.node needs glibc ${glibc}, newer than ${maxGlibc}: build it on an older Linux (almalinux:8 has 2.28).`);
    // Loaded the way installs will load it: from prebuilds/linux-<arch>, with no build folder.
    const prebuilt = path.join(pty, 'prebuilds', `linux-${arch}`);
    fs.mkdirSync(prebuilt, { recursive: true });
    fs.copyFileSync(built, path.join(prebuilt, 'pty.node'));
    fs.rmSync(path.join(pty, 'build'), { recursive: true, force: true });
    const check = spawnSync(process.execPath, ['-e', `
      const pty = require('node-pty');
      let text = '';
      const p = pty.spawn('/bin/sh', ['-c', 'echo pty-ok $((6*7))'], { name: 'xterm', cols: 80, rows: 24 });
      p.onData((d) => { text += d; });
      p.onExit(({ exitCode }) => { if (exitCode !== 0 || !/pty-ok 42/.test(text)) { console.error('Error: the shell said ' + JSON.stringify(text)); process.exit(1); } process.exit(0); });
      setTimeout(() => { console.error('Error: the shell never exited'); process.exit(3); }, 10000);
    `], { cwd: work, encoding: 'utf8' });
    if (check.status !== 0) throw new Error(`The prebuilt binary doesn't run a shell: ${check.stderr || check.stdout}`);
    const dest = path.join(out, `linux-${arch}`);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(built.replace(path.join('build', 'Release'), path.join('prebuilds', `linux-${arch}`)), path.join(dest, 'pty.node'));
    fs.writeFileSync(path.join(dest, 'BUILD.json'), JSON.stringify({ nodePty: version, arch, glibc, builtWith: `Node ${process.versions.node}`, at: new Date().toISOString() }, null, 2) + '\n');
    console.log(`Wrote ${path.join(dest, 'pty.node')} (${fs.statSync(path.join(dest, 'pty.node')).size} bytes): it loads from a prebuilds folder and runs a shell.`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`✗ ${(e as Error).message}`); process.exit(1); }
}
