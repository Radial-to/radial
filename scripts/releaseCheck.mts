// Validates a dist/ directory against the auto-update asset contract before
// anything is uploaded. electron-updater (Squirrel.Mac) reads latest-mac.yml
// from the latest GitHub release and downloads the zip it names, verifying
// sha512 — so a renamed zip, a stale yml, or a hash mismatch silently strands
// every installed app on its current version. This module turns that contract
// into a machine check; scripts/release.mts refuses to upload unless it passes.
//
// Pure and dependency-light (js-yaml comes with electron-builder; the zip is
// listed with macOS's zipinfo) so the unit suite can exercise it against
// fixture dirs: check({ distDir, version }).

import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';

// js-yaml ships no types, so it loads through require (its CommonJS build, as
// before), typed as the one call made here.
const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(text: string): unknown };

const YML = 'latest-mac.yml';

/**
 * The oldest system an update may install on, as the Darwin version that
 * electron-updater compares with os.release() before it offers an update
 * (AppUpdater.checkIfUpdateSupported). Darwin 22 is macOS 13 Ventura, the
 * oldest macOS Electron 44 runs on and package.json's
 * build.mac.minimumSystemVersion; change the two together. Macs on macOS 11
 * and 12 (Darwin 20 and 21) then see no update and keep the last build that
 * runs there. electron-builder doesn't write the field, so release.mts adds it
 * to latest-mac.yml (withMinimumSystemVersion) and check() requires it.
 */
const MIN_DARWIN = '22.0.0';

/** latest-mac.yml's text with minimumSystemVersion set to MIN_DARWIN: the line replaced when there is one, else added. */
function withMinimumSystemVersion(yml: string): string {
  const line = `minimumSystemVersion: ${MIN_DARWIN}`;
  if (/^minimumSystemVersion:.*$/m.test(yml)) return yml.replace(/^minimumSystemVersion:.*$/m, line);
  return yml.replace(/\n*$/, '\n') + line + '\n';
}

/** check()'s input; release.mts passes appUpdateYml, the unit tests turn probeCli off. */
export interface CheckOptions {
  distDir: string;
  version: string;
  /** The packaged app's app-update.yml: when given, its feed and the CLI shim beside it are checked too. */
  appUpdateYml?: string;
  /** Run the bundled CLI shim (default true; the unit tests' shims are stubs). */
  probeCli?: boolean;
}
/** check()'s verdict: uploads is filled only when there are no problems. */
export interface CheckResult {
  ok: boolean;
  problems: string[];
  /** Absolute paths of every file the release must ship. */
  uploads: string[];
}
/** latest-mac.yml as electron-builder writes it, as far as the contract reads it. */
interface UpdateFeed {
  version?: string;
  path?: string;
  files?: { url: string; sha512?: string; size?: number }[];
  /** The Darwin version the update needs (MIN_DARWIN); YAML reads 22.0.0 as a string, a bare 22 as a number. */
  minimumSystemVersion?: unknown;
}
/** The packaged app's app-update.yml: the GitHub repo it updates from. */
interface AppUpdateConfig {
  owner?: string;
  repo?: string;
}

function sha512b64(file: string): string {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

/**
 * Electron's and Chromium's licenses, which both require shipping them with the
 * app. electron-builder (26.16.1+) moves them from beside the .app into its
 * Contents/Resources, the only part that reaches the zip and the dmg.
 */
const LICENSE_FILES = ['LICENSE.electron.txt', 'LICENSES.chromium.html'];

/** The license files missing (or empty) in the app's Contents/Resources. */
function licenseProblems(resourcesDir: string): string[] {
  return LICENSE_FILES.filter((name) => {
    try { return fs.statSync(path.join(resourcesDir, name)).size === 0; } catch { return true; }
  }).map((name) => `the packaged app has no ${name} in Contents/Resources: Electron's and Chromium's licenses must ship inside the app`);
}

/**
 * The update zip must keep the app's symlinks. Every entry at the top of a
 * .framework (its binary, Resources, Helpers...) and its Versions/Current are
 * links; a zip that stores them as copies (electron-builder 26.15.3's 7-Zip did)
 * unpacks into frameworks that are broken and fail their signature check, so
 * the update never launches. Reads the zip's listing with zipinfo.
 */
function zipLinkProblems(zipPath: string): string[] {
  const name = path.basename(zipPath);
  let listing: string;
  try { listing = execFileSync('zipinfo', [zipPath], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); }
  catch (e) { return [`${name} can't be listed with zipinfo: ${(e as Error).message.split('\n')[0]}`]; }
  // "lrwxr-xr-x  6.3 unx  35 bx stor 26-Oct-17 10:20 Radial.app/…/Resources": the mode, then the name after the time.
  const modes = new Map<string, string>();
  for (const line of listing.split('\n')) {
    const m = /^([-dl][-rwxsStT]{9})\s+\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+\S+\s(.+)$/.exec(line);
    if (m) modes.set(m[2].replace(/\/$/, ''), m[1]);
  }
  const links = [...modes.keys()].filter((entry) => /\.framework\/(Versions\/Current|[^/]+)$/.test(entry) && !entry.endsWith('.framework/Versions'));
  if (!links.length) return [`${name} holds no .framework: not the app's update zip?`];
  const copies = links.filter((entry) => !modes.get(entry)!.startsWith('l'));
  return copies.length ? [`${name} stores ${copies.length} framework link(s) as copies (${copies[0]}): the updated app's frameworks would be broken`] : [];
}

/**
 * @param opts
 *   appUpdateYml — optional path to the packaged app's embedded feed config;
 *   when given, its presence and repo are verified too (a build without it
 *   cannot self-update at all), and so are the license files and the CLI shim
 *   in the same Contents/Resources.
 * @returns
 *   uploads — absolute paths of every file the release must ship (yml, zip,
 *   blockmap, dmg). The stable-named dmg copy is the uploader's job.
 */
function check({ distDir, version, appUpdateYml, probeCli = true }: CheckOptions): CheckResult { // probeCli: run the bundled shim (off in unit tests with stub shims)
  const problems: string[] = [];
  const uploads: string[] = [];
  const p = (f: string) => path.join(distDir, f);

  const zipName = `Radial-${version}-arm64-mac.zip`;
  const dmgName = `Radial-${version}-arm64.dmg`;

  const ymlPath = p(YML);
  if (!fs.existsSync(ymlPath)) {
    return { ok: false, problems: [`${YML} missing from ${distDir}`], uploads: [] };
  }
  let loaded: unknown;
  try { loaded = yaml.load(fs.readFileSync(ymlPath, 'utf8')); }
  catch (e) { return { ok: false, problems: [`${YML} unparseable: ${(e as Error).message}`], uploads: [] }; }
  // An empty file loads as undefined and a comment-only one as null.
  if (!loaded || typeof loaded !== 'object') return { ok: false, problems: [`${YML} is empty or not a YAML mapping`], uploads: [] };
  const meta = loaded as UpdateFeed;

  if (meta.version !== version) {
    problems.push(`${YML} says version ${meta.version}, expected ${version} — stale build output?`);
  }
  if (meta.path !== zipName) {
    problems.push(`${YML} path is ${meta.path}, expected ${zipName} — updater downloads by this exact name`);
  }
  if (meta.minimumSystemVersion !== MIN_DARWIN) {
    problems.push(`${YML} minimumSystemVersion is ${JSON.stringify(meta.minimumSystemVersion)}, expected ${MIN_DARWIN} (Darwin 22, macOS 13): without it Macs on macOS 11 and 12 would download a build that can't run there`);
  }

  // Every file the yml references must exist with the exact size and sha512
  // it advertises: the updater rejects (or worse, half-applies) mismatches.
  for (const f of meta.files || []) {
    const fp = p(f.url);
    if (!fs.existsSync(fp)) { problems.push(`${YML} references ${f.url}, not found in dist`); continue; }
    const st = fs.statSync(fp);
    if (typeof f.size === 'number' && st.size !== f.size) {
      problems.push(`${f.url} is ${st.size} bytes, ${YML} says ${f.size} — mixed build outputs`);
    }
    if (f.sha512 && sha512b64(fp) !== f.sha512) {
      problems.push(`${f.url} sha512 does not match ${YML} — mixed build outputs`);
    }
  }

  for (const name of [zipName, `${zipName}.blockmap`, dmgName]) {
    if (!fs.existsSync(p(name))) problems.push(`${name} missing from dist`);
  }
  if (fs.existsSync(p(zipName))) problems.push(...zipLinkProblems(p(zipName)));

  if (appUpdateYml !== undefined) {
    problems.push(...licenseProblems(path.dirname(appUpdateYml)));
    if (!fs.existsSync(appUpdateYml)) {
      problems.push(`packaged app has no app-update.yml (${appUpdateYml}) — this build cannot self-update`);
    } else {
      try {
        const feed = yaml.load(fs.readFileSync(appUpdateYml, 'utf8')) as AppUpdateConfig;
        if (feed.repo !== 'radial-releases' || feed.owner !== 'Radial-to') {
          problems.push(`app-update.yml feed is ${feed.owner}/${feed.repo}, expected Radial-to/radial-releases`);
        }
      } catch (e) { problems.push(`app-update.yml unparseable: ${(e as Error).message}`); }
    }
    // The `radial` CLI ships as an extraResource next to app-update.yml. A
    // build without it (or with the exec bit lost) would silently drop the
    // terminal "open in Radial" rail from every machine that auto-updates.
    const shim = path.join(path.dirname(appUpdateYml), 'bin', 'radial');
    if (!fs.existsSync(shim)) {
      problems.push(`packaged app has no CLI shim (${shim}) — build.extraResources broken?`);
    } else {
      try { fs.accessSync(shim, fs.constants.X_OK); }
      catch { problems.push(`CLI shim ${shim} is not executable`); }
      // The shim must resolve the bundled client, and the client must run
      // THROUGH the app binary as Node (a disabled runAsNode fuse would break
      // this and the PTY daemon alike) — `--version` proves both, app closed.
      if (probeCli) try {
        const dry = execFileSync('/bin/sh', [shim, 'open', '.'], { env: { ...process.env, RADIAL_CLI_DRYRUN: '1' }, encoding: 'utf8' }).trim().split('\n');
        if (!dry[1] || !dry[1].endsWith('/app.asar/out/main/cli.js')) problems.push(`CLI shim does not resolve the bundled client (got ${dry[1]})`);
        const v = execFileSync('/bin/sh', [shim, '--version'], { encoding: 'utf8', timeout: 30000 }).trim();
        if (v !== version) problems.push(`\`radial --version\` printed ${JSON.stringify(v)}, expected ${version} — the client can't run through the app binary as Node`);
      } catch (e) { problems.push(`CLI shim probe failed: ${(e as Error).message}`); }
    }
  }

  if (!problems.length) uploads.push(ymlPath, p(zipName), p(`${zipName}.blockmap`), p(dmgName));
  return { ok: !problems.length, problems, uploads };
}

export { check, sha512b64, withMinimumSystemVersion, MIN_DARWIN };
