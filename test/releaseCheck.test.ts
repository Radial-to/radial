import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { check, sha512b64, withMinimumSystemVersion, MIN_DARWIN } from '../scripts/releaseCheck.mjs';
import { tmpDir } from './support/tmp';

// The release check validates the macOS release on the Mac that builds it. Its
// fixtures are a Radial.app zipped with its framework links (zip -y, read back
// with zipinfo), which a Linux image needn't have: those tests run on macOS.
const notMac = process.platform !== 'darwin' && 'the release check validates the macOS build, on a Mac';

// An update zip in miniature: Radial.app with one framework laid out the way
// macOS frameworks are, its top-level entries and Versions/Current symlinks.
// keepLinks: false zips the way a 7-Zip that follows links did (copies).
function makeAppZip(zipPath: string, { keepLinks = true }: { keepLinks?: boolean } = {}) {
  const stage = tmpDir('relcheck-app-');
  const fw = path.join(stage, 'Radial.app', 'Contents', 'Frameworks', 'Electron Framework.framework');
  fs.mkdirSync(path.join(fw, 'Versions', 'A', 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(fw, 'Versions', 'A', 'Electron Framework'), 'binary');
  fs.writeFileSync(path.join(fw, 'Versions', 'A', 'Resources', 'Info.plist'), 'plist');
  fs.symlinkSync('A', path.join(fw, 'Versions', 'Current'));
  fs.symlinkSync('Versions/Current/Electron Framework', path.join(fw, 'Electron Framework'));
  fs.symlinkSync('Versions/Current/Resources', path.join(fw, 'Resources'));
  execFileSync('zip', [keepLinks ? '-qry' : '-qr', zipPath, 'Radial.app'], { cwd: stage });
}

// Builds a dist dir that satisfies the full contract for `version`, then lets
// a test break exactly one invariant and assert the check catches it. The dir
// also stands in for the app's Contents/Resources (app-update.yml, the CLI
// shim and the license files sit there), where the tests put them.
// latest-mac.yml is written the way electron-builder writes it, then given
// minimumSystemVersion the way release.mts does (asReleased: false skips that).
function makeDist(version: string, { keepLinks = true, asReleased = true }: { keepLinks?: boolean; asReleased?: boolean } = {}) {
  const dir = tmpDir('relcheck-');
  const zip = `Radial-${version}-arm64-mac.zip`;
  const dmg = `Radial-${version}-arm64.dmg`;
  makeAppZip(path.join(dir, zip), { keepLinks });
  fs.writeFileSync(path.join(dir, 'LICENSE.electron.txt'), 'MIT');
  fs.writeFileSync(path.join(dir, 'LICENSES.chromium.html'), '<html>licenses</html>');
  fs.writeFileSync(path.join(dir, `${zip}.blockmap`), 'blockmap');
  fs.writeFileSync(path.join(dir, dmg), `dmg-bytes-${version}`);
  const file = (name: string) => ({
    url: name,
    sha512: sha512b64(path.join(dir, name)),
    size: fs.statSync(path.join(dir, name)).size,
  });
  const yml = [
    `version: ${version}`,
    'files:',
    ...[file(zip), file(dmg)].flatMap((f) => [`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`]),
    `path: ${zip}`,
    `sha512: ${file(zip).sha512}`,
    `releaseDate: '2026-01-01T00:00:00.000Z'`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'latest-mac.yml'), asReleased ? withMinimumSystemVersion(yml) : yml);
  return dir;
}

test('a complete artifact set passes and yields the upload list', { skip: notMac }, () => {
  const dir = makeDist('1.2.3');
  const r = check({ probeCli: false, distDir: dir, version: '1.2.3' });
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.deepEqual(r.uploads.map((p) => path.basename(p)),
    ['latest-mac.yml', 'Radial-1.2.3-arm64-mac.zip', 'Radial-1.2.3-arm64-mac.zip.blockmap', 'Radial-1.2.3-arm64.dmg']);
});

test('missing latest-mac.yml fails hard', { skip: notMac }, () => {
  const dir = makeDist('1.2.3');
  fs.unlinkSync(path.join(dir, 'latest-mac.yml'));
  const r = check({ probeCli: false, distDir: dir, version: '1.2.3' });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /latest-mac\.yml missing/);
});

test('an empty or comment-only latest-mac.yml is refused, not a crash', { skip: notMac }, () => {
  // js-yaml loads an empty file as undefined and a comment-only one as null.
  for (const body of ['', '# nothing but a comment\n']) {
    const dir = makeDist('1.2.3');
    fs.writeFileSync(path.join(dir, 'latest-mac.yml'), body);
    const r = check({ probeCli: false, distDir: dir, version: '1.2.3' });
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.match(r.problems[0], /latest-mac\.yml/);
    assert.deepEqual(r.uploads, []);
  }
});

test('a stale yml from a previous build is caught by the version field', { skip: notMac }, () => {
  const dir = makeDist('1.2.2');
  const r = check({ probeCli: false, distDir: dir, version: '1.2.3' });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /says version 1\.2\.2, expected 1\.2\.3/.test(p)));
});

test('a zip that was renamed or rebuilt no longer matches its sha512', { skip: notMac }, () => {
  const dir = makeDist('1.2.3');
  fs.appendFileSync(path.join(dir, 'Radial-1.2.3-arm64-mac.zip'), 'tampered');
  const r = check({ probeCli: false, distDir: dir, version: '1.2.3' });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /sha512 does not match/.test(p)));
});

test('a missing blockmap blocks the release', { skip: notMac }, () => {
  const dir = makeDist('1.2.3');
  fs.unlinkSync(path.join(dir, 'Radial-1.2.3-arm64-mac.zip.blockmap'));
  const r = check({ probeCli: false, distDir: dir, version: '1.2.3' });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /blockmap missing/.test(p)));
});

test('a file the yml references but dist lacks is reported', { skip: notMac }, () => {
  const dir = makeDist('1.2.3');
  fs.unlinkSync(path.join(dir, 'Radial-1.2.3-arm64.dmg'));
  const r = check({ probeCli: false, distDir: dir, version: '1.2.3' });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /Radial-1\.2\.3-arm64\.dmg.*not found|missing from dist/.test(p)));
});

// The CLI shim ships next to app-update.yml inside the bundle (Resources/bin).
function makeShim(resourcesDir: string) {
  fs.mkdirSync(path.join(resourcesDir, 'bin'), { recursive: true });
  const shim = path.join(resourcesDir, 'bin', 'radial');
  fs.writeFileSync(shim, '#!/bin/sh\n');
  fs.chmodSync(shim, 0o755);
  return shim;
}

test('a build without app-update.yml cannot self-update and is refused', { skip: notMac }, () => {
  const dir = makeDist('1.2.3');
  const r = check({ probeCli: false, distDir: dir, version: '1.2.3', appUpdateYml: path.join(dir, 'nope', 'app-update.yml') });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /cannot self-update/.test(p)));
});

test('an app-update.yml pointing at the wrong feed is refused', { skip: notMac }, () => {
  const dir = makeDist('1.2.3');
  const feed = path.join(dir, 'app-update.yml');
  fs.writeFileSync(feed, 'provider: github\nowner: someone-else\nrepo: radial-releases\n');
  makeShim(dir);
  const r = check({ probeCli: false, distDir: dir, version: '1.2.3', appUpdateYml: feed });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /feed is someone-else\/radial-releases/.test(p)));
});

test('a correct app-update.yml passes alongside the artifact set', { skip: notMac }, () => {
  const dir = makeDist('1.2.3');
  const feed = path.join(dir, 'app-update.yml');
  fs.writeFileSync(feed, 'provider: github\nowner: Radial-to\nrepo: radial-releases\n');
  makeShim(dir);
  const r = check({ probeCli: false, distDir: dir, version: '1.2.3', appUpdateYml: feed });
  assert.equal(r.ok, true, r.problems.join('; '));
});

test('a build missing the CLI shim is refused', { skip: notMac }, () => {
  const dir = makeDist('1.2.3');
  const feed = path.join(dir, 'app-update.yml');
  fs.writeFileSync(feed, 'provider: github\nowner: Radial-to\nrepo: radial-releases\n');
  const r = check({ probeCli: false, distDir: dir, version: '1.2.3', appUpdateYml: feed });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /no CLI shim/.test(p)));
});

test('a CLI shim without its exec bit is refused', { skip: notMac }, () => {
  const dir = makeDist('1.2.3');
  const feed = path.join(dir, 'app-update.yml');
  fs.writeFileSync(feed, 'provider: github\nowner: Radial-to\nrepo: radial-releases\n');
  const shim = makeShim(dir);
  fs.chmodSync(shim, 0o644);
  const r = check({ probeCli: false, distDir: dir, version: '1.2.3', appUpdateYml: feed });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /not executable/.test(p)));
});

// The probe: the shim must resolve the bundled client and run it through the
// app binary as Node. A scripted shim stands in for the real one here; the
// real one is exercised by the release gate against the packaged app.
function makeProbeShim(dir: string, { version = '1.2.3', entry = '/app/Contents/Resources/app.asar/out/main/cli.js' }: { version?: string; entry?: string } = {}) {
  const shim = makeShim(dir);
  fs.writeFileSync(shim, '#!/bin/sh\nif [ -n "$RADIAL_CLI_DRYRUN" ]; then echo /app/Contents/MacOS/Radial; echo ' + entry + '; for A in "$@"; do echo "$A"; done; exit 0; fi\ncase "$1" in --version) echo ' + version + ' ;; esac\n');
  fs.chmodSync(shim, 0o755);
}
function goodFeed(dir: string) { const feed = path.join(dir, 'app-update.yml'); fs.writeFileSync(feed, 'provider: github\nowner: Radial-to\nrepo: radial-releases\n'); return feed; }

test('the CLI probe passes when the shim resolves the client and --version answers with the app version', { skip: notMac }, () => {
  const dir = makeDist('1.2.3');
  makeProbeShim(dir);
  const r = check({ distDir: dir, version: '1.2.3', appUpdateYml: goodFeed(dir) });
  assert.equal(r.ok, true, r.problems.join('; '));
});

test('the CLI probe refuses a shim that resolves the wrong client, and one whose client cannot run', { skip: notMac }, () => {
  const dir = makeDist('1.2.3');
  makeProbeShim(dir, { entry: '/app/Contents/Resources/bin/old-cli.sh' });
  const r = check({ distDir: dir, version: '1.2.3', appUpdateYml: goodFeed(dir) });
  assert.equal(r.ok, false); assert.ok(r.problems.some((p) => /does not resolve the bundled client/.test(p)), r.problems.join('; '));
  const dir2 = makeDist('1.2.3');
  makeProbeShim(dir2, { version: '' });
  const r2 = check({ distDir: dir2, version: '1.2.3', appUpdateYml: goodFeed(dir2) });
  assert.equal(r2.ok, false); assert.ok(r2.problems.some((p) => /radial --version/.test(p)), r2.problems.join('; '));
});

// The update zip has to unpack into an app whose frameworks still work: their
// links stored as links, not as copies (electron-builder 26.15.3 zipped with a
// 7-Zip that followed them).
test('an update zip that stores the framework links as copies is refused', { skip: notMac }, () => {
  const dir = makeDist('1.2.3', { keepLinks: false });
  const r = check({ probeCli: false, distDir: dir, version: '1.2.3' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems.filter((p) => !/framework link/.test(p)), [], 'only the links are wrong: ' + r.problems.join('; '));
  assert.match(r.problems.join('\n'), /stores 3 framework link\(s\) as copies/);
  assert.deepEqual(r.uploads, []);
});

test('a zip without the app in it is refused', { skip: notMac }, () => {
  const dir = makeDist('1.2.3');
  const zip = path.join(dir, 'Radial-1.2.3-arm64-mac.zip');
  fs.unlinkSync(zip);
  execFileSync('zip', ['-q', zip, 'LICENSE.electron.txt'], { cwd: dir });
  const r = check({ probeCli: false, distDir: dir, version: '1.2.3' });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /holds no \.framework/.test(p)), r.problems.join('; '));
});

test("Electron's and Chromium's licenses must ship inside the app", { skip: notMac }, () => {
  for (const name of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
    const dir = makeDist('1.2.3');
    makeShim(dir);
    fs.rmSync(path.join(dir, name));
    const r = check({ probeCli: false, distDir: dir, version: '1.2.3', appUpdateYml: goodFeed(dir) });
    assert.equal(r.ok, false, name);
    assert.deepEqual(r.problems, [`the packaged app has no ${name} in Contents/Resources: Electron's and Chromium's licenses must ship inside the app`]);
  }
  const empty = makeDist('1.2.3');
  makeShim(empty);
  fs.writeFileSync(path.join(empty, 'LICENSES.chromium.html'), '');
  assert.equal(check({ probeCli: false, distDir: empty, version: '1.2.3', appUpdateYml: goodFeed(empty) }).ok, false, 'an empty license file is no license');
});

// macOS 11 and 12 stay on the last Electron 33 build: electron-updater skips an
// update whose minimumSystemVersion (a Darwin version) is above os.release().
test('the update feed holds Macs below macOS 13 back with minimumSystemVersion 22.0.0', { skip: notMac }, () => {
  assert.equal(MIN_DARWIN, '22.0.0');
  const dir = makeDist('1.2.3');
  assert.match(fs.readFileSync(path.join(dir, 'latest-mac.yml'), 'utf8'), /^minimumSystemVersion: 22\.0\.0$/m);
  assert.equal(check({ probeCli: false, distDir: dir, version: '1.2.3' }).ok, true);
});

test('a feed as electron-builder writes it, without minimumSystemVersion, is refused', { skip: notMac }, () => {
  const dir = makeDist('1.2.3', { asReleased: false });
  const r = check({ probeCli: false, distDir: dir, version: '1.2.3' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['latest-mac.yml minimumSystemVersion is undefined, expected 22.0.0 (Darwin 22, macOS 13): without it Macs on macOS 11 and 12 would download a build that can\'t run there']);
  assert.deepEqual(r.uploads, []);
});

test('a feed with the wrong floor is refused: a macOS version, a number, an older Darwin', { skip: notMac }, () => {
  for (const value of ['13.0', '22', '21.0.0']) {
    const dir = makeDist('1.2.3');
    const yml = path.join(dir, 'latest-mac.yml');
    fs.writeFileSync(yml, fs.readFileSync(yml, 'utf8').replace(/^minimumSystemVersion: .*$/m, `minimumSystemVersion: ${value}`));
    const r = check({ probeCli: false, distDir: dir, version: '1.2.3' });
    assert.equal(r.ok, false, value);
    assert.ok(r.problems.some((p) => /minimumSystemVersion is .*expected 22\.0\.0/.test(p)), `${value}: ${r.problems.join('; ')}`);
  }
});

test('withMinimumSystemVersion adds the line once and replaces an old one', () => {
  const builder = 'version: 1.2.3\npath: Radial-1.2.3-arm64-mac.zip\nreleaseDate: \'2026-01-01T00:00:00.000Z\'\n';
  const once = withMinimumSystemVersion(builder);
  assert.equal(once, builder + 'minimumSystemVersion: 22.0.0\n');
  assert.equal(withMinimumSystemVersion(once), once, 'running it again changes nothing');
  assert.equal(withMinimumSystemVersion(builder.trimEnd()), builder + 'minimumSystemVersion: 22.0.0\n', 'a file without a final newline');
  assert.equal(withMinimumSystemVersion('minimumSystemVersion: 21.0.0\n' + builder), 'minimumSystemVersion: 22.0.0\n' + builder);
});

// The app refuses to open below its LSMinimumSystemVersion (package.json's
// build.mac.minimumSystemVersion), and the feed must hold back exactly those
// Macs: raise one, raise the other (macOS 13 is Darwin 22, 14 is 23, 15 is 24).
test('the feed\'s Darwin floor is the app\'s macOS floor', () => {
  const pkg: { build: { mac: { minimumSystemVersion: string } } } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const darwinFor: Record<string, string> = { '13.0': '22.0.0', '14.0': '23.0.0', '15.0': '24.0.0' };
  assert.equal(pkg.build.mac.minimumSystemVersion, '13.0');
  assert.equal(MIN_DARWIN, darwinFor[pkg.build.mac.minimumSystemVersion]);
});
