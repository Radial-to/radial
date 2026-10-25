// The update rehearsal's own logic (scripts/rehearsalFeed.mts): the version
// order electron-updater decides by, the feed folder and its server, the
// control socket's hello, and what the macOS tools print.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import net from 'net';
import path from 'path';
import crypto from 'crypto';
import {
  compareVersions, controlRequest, feedPort, gateTestFiles, parseCodesign, parseSpctl, parseVersion, pickPair,
  processesMatching, readAppUpdateConfig, readFeed, rehearsalBuilds, scrubEnv, setMinimumSystemVersion, startFeedServer, writeFeed,
} from '../scripts/rehearsalFeed.mjs';
import { tmpDir } from './support/tmp';

const ROOT = path.join(__dirname, '..');

test('compareVersions orders versions the way semver (and electron-updater) does', () => {
  // The SemVer spec's own example, then the rehearsal's versions.
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0-rc.2', '1.0.0-rc.10', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  for (let i = 0; i < ordered.length; i++) {
    for (let k = 0; k < ordered.length; k++) {
      assert.equal(compareVersions(ordered[i], ordered[k]), Math.sign(i - k), `${ordered[i]} vs ${ordered[k]}`);
    }
  }
  assert.equal(compareVersions('0.38.1', '1.0.0-rc.1'), -1, 'the 0.38 line is older than any 1.0 pre-release');
  assert.equal(compareVersions('v1.0.0+build.7', '1.0.0'), 0, 'build metadata and a leading v do not count');
  assert.throws(() => compareVersions('1.0', '1.0.0'), /not a semver version/);
  assert.equal(parseVersion('1.0'), null);
  assert.equal(parseVersion('01.0.0'), null);
  assert.deepEqual(parseVersion('1.0.0-rc.2'), { major: 1, minor: 0, patch: 0, pre: ['rc', 2] });
});

test('setMinimumSystemVersion adds, replaces and removes the floor, leaving the rest of latest-mac.yml alone', () => {
  const yml = 'version: 1.0.0-rc.2\nfiles:\n  - url: Radial-1.0.0-rc.2-arm64-mac.zip\npath: Radial-1.0.0-rc.2-arm64-mac.zip\nreleaseDate: \'2026-10-18T00:00:00.000Z\'\n';
  const added = setMinimumSystemVersion(yml, '22.0.0');
  assert.equal(added, yml + 'minimumSystemVersion: 22.0.0\n');
  const floor = setMinimumSystemVersion(added, '99.0.0');
  assert.match(floor, /^minimumSystemVersion: 99\.0\.0$/m);
  assert.equal(floor.match(/minimumSystemVersion/g)!.length, 1, 'replaced, not added twice');
  assert.equal(setMinimumSystemVersion(floor, null), yml, 'null takes the line out again');
  assert.equal(setMinimumSystemVersion('version: 1.0.0', '22.0.0'), 'version: 1.0.0\nminimumSystemVersion: 22.0.0\n', 'a file without a final newline gets one first');
});

// A build folder in miniature: a zip, its blockmap and the yml that lists them.
function makeBuild(dir: string, version: string, { lieAbout }: { lieAbout?: 'size' | 'sha512' } = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const zip = `Radial-${version}-arm64-mac.zip`;
  const body = Buffer.from(`the ${version} update zip `.repeat(50));
  fs.writeFileSync(path.join(dir, zip), body);
  fs.writeFileSync(path.join(dir, `${zip}.blockmap`), 'blockmap');
  const sha512 = lieAbout === 'sha512' ? crypto.createHash('sha512').update('something else').digest('base64') : crypto.createHash('sha512').update(body).digest('base64');
  const size = lieAbout === 'size' ? body.length + 1 : body.length;
  fs.writeFileSync(path.join(dir, 'latest-mac.yml'), `version: ${version}\nfiles:\n  - url: ${zip}\n    sha512: ${sha512}\n    size: ${size}\npath: ${zip}\nsha512: ${sha512}\nreleaseDate: '2026-10-18T00:00:00.000Z'\nminimumSystemVersion: 22.0.0\n`);
  return dir;
}

test('writeFeed links the update files beside a latest-mac.yml with the floor it is given', () => {
  const root = tmpDir('rehearsal-feed-');
  const build = makeBuild(path.join(root, 'build'), '1.0.0-rc.2');
  const floor = writeFeed(build, path.join(root, 'floor'), { minimumSystemVersion: '99.0.0' });
  assert.equal(floor.version, '1.0.0-rc.2');
  assert.deepEqual(floor.files.sort(), ['Radial-1.0.0-rc.2-arm64-mac.zip', 'Radial-1.0.0-rc.2-arm64-mac.zip.blockmap', 'latest-mac.yml']);
  assert.equal(readFeed(path.join(root, 'floor')).minimumSystemVersion, '99.0.0');
  assert.equal(fs.statSync(path.join(root, 'floor', floor.zip)).ino, fs.statSync(path.join(build, floor.zip)).ino, 'the zip is hard-linked, not copied');
  const asBuilt = writeFeed(build, path.join(root, 'real'));
  assert.equal(fs.readFileSync(path.join(root, 'real', 'latest-mac.yml'), 'utf8'), fs.readFileSync(path.join(build, 'latest-mac.yml'), 'utf8'), 'left out, the yml is served as built');
  assert.equal(readFeed(path.join(root, 'real')).minimumSystemVersion, '22.0.0');
  assert.equal(asBuilt.zip, 'Radial-1.0.0-rc.2-arm64-mac.zip');
  assert.throws(() => writeFeed(build, path.join(root, 'real')), /already exists/, 'a feed folder is written once');
});

test('writeFeed refuses a build whose yml and files disagree, or that is not a build', () => {
  const root = tmpDir('rehearsal-feed-bad-');
  assert.throws(() => writeFeed(makeBuild(path.join(root, 'size'), '1.0.0-rc.2', { lieAbout: 'size' }), path.join(root, 'out1')), /bytes, latest-mac\.yml says/);
  assert.throws(() => writeFeed(makeBuild(path.join(root, 'sha'), '1.0.0-rc.2', { lieAbout: 'sha512' }), path.join(root, 'out2')), /sha512 doesn't match/);
  const missing = makeBuild(path.join(root, 'missing'), '1.0.0-rc.2');
  fs.rmSync(path.join(missing, 'Radial-1.0.0-rc.2-arm64-mac.zip'));
  assert.throws(() => writeFeed(missing, path.join(root, 'out3')), /which is not in/);
  assert.throws(() => readFeed(path.join(root, 'nothing')), /is missing/);
  assert.equal(fs.existsSync(path.join(root, 'out1')), false, 'nothing is written for a bad build');
});

test('the feed server serves the folder it is pointed at, with ranges, and nothing outside it', async () => {
  const root = tmpDir('rehearsal-serve-');
  const a = makeBuild(path.join(root, 'a'), '1.0.0-rc.2');
  const b = path.join(root, 'b'); fs.mkdirSync(b); fs.writeFileSync(path.join(b, 'latest-mac.yml'), 'version: 9.9.9\n');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'outside the feed');
  const server = await startFeedServer(a);
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const yml = await fetch(server.url + 'latest-mac.yml?noCache=1x2y');
    assert.equal(yml.status, 200);
    assert.match(await yml.text(), /^version: 1\.0\.0-rc\.2$/m, 'the query string electron-updater adds is ignored');
    const zipUrl = server.url + 'Radial-1.0.0-rc.2-arm64-mac.zip';
    const whole = Buffer.from(await (await fetch(zipUrl)).arrayBuffer());
    assert.deepEqual(whole, fs.readFileSync(path.join(a, 'Radial-1.0.0-rc.2-arm64-mac.zip')));
    const part = await fetch(zipUrl, { headers: { Range: 'bytes=4-10' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 4-10/${whole.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), whole.subarray(4, 11));
    assert.equal((await fetch(zipUrl, { headers: { Range: 'bytes=-5' } }).then((r) => r.arrayBuffer())).byteLength, 5, 'a suffix range');
    assert.equal((await fetch(zipUrl, { headers: { Range: `bytes=${whole.length + 5}-` } })).status, 416);
    assert.equal((await fetch(zipUrl, { method: 'HEAD' })).headers.get('content-length'), String(whole.length));
    assert.equal((await fetch(server.url + '..%2fsecret.txt')).status, 404, 'no way out of the folder');
    assert.equal((await fetch(server.url + 'nope.zip')).status, 404);
    assert.equal((await fetch(server.url + 'latest-mac.yml', { method: 'POST' })).status, 405);
    server.serve(b);
    assert.match(await (await fetch(server.url + 'latest-mac.yml')).text(), /9\.9\.9/, 'serve() switches folders between requests');
    assert.ok(server.requests.some((r) => r.path === '/Radial-1.0.0-rc.2-arm64-mac.zip' && r.status === 200 && r.bytes === whole.length), JSON.stringify(server.requests));
    assert.ok(server.requests.some((r) => r.status === 206 && r.range === 'bytes=4-10'));
    await assert.rejects(startFeedServer(a, { port: server.port }), /is taken/, 'a taken port is a plain error');
  } finally { await server.close(); }
});

test('controlRequest gets the reply frame from a control socket, and null when nothing answers', async () => {
  const dir = tmpDir('rehearsal-sock-');
  const sock = path.join(dir, 'cli.sock');
  const seen: Record<string, unknown>[] = [];
  const server = net.createServer((s) => {
    s.setEncoding('utf8');
    s.on('data', (line: string) => {
      const frame = JSON.parse(line.trim()) as Record<string, unknown>;
      seen.push(frame);
      if (frame.op === 'silent') return;
      s.write(JSON.stringify({ op: 'progress', reqId: frame.reqId, text: 'working' }) + '\n');
      s.write(JSON.stringify({ op: 'reply', reqId: frame.reqId, ok: true, version: '1.0.0-rc.2', pid: 42, windowReady: true }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  try {
    const reply = await controlRequest(sock, { op: 'hello' });
    assert.equal(reply?.op, 'reply');
    assert.equal(reply?.version, '1.0.0-rc.2');
    assert.equal(seen[0].op, 'hello'); assert.equal(typeof seen[0].reqId, 'string');
    assert.equal(await controlRequest(sock, { op: 'silent' }, 300), null, 'no reply in time');
    assert.equal(await controlRequest(path.join(dir, 'missing.sock'), { op: 'hello' }), null, 'nothing listening');
  } finally { server.close(); }
});

test('parseCodesign reads a Developer ID signature, an ad-hoc one and none', () => {
  const signed = [
    'Executable=/tmp/x/Radial.app/Contents/MacOS/Radial', 'Identifier=to.radial.mac', 'Format=app bundle with Mach-O thin (arm64)',
    'CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=27+7 location=embedded', 'Signature size=9000',
    'Authority=Developer ID Application: Example Person (ABCDE12345)', 'Authority=Developer ID Certification Authority', 'Authority=Apple Root CA',
    'Timestamp=18 Oct 2026 at 10:00:00', 'Notarization Ticket=stapled', 'TeamIdentifier=ABCDE12345', 'Sealed Resources version=2 rules=13 files=200',
  ].join('\n');
  assert.deepEqual(parseCodesign(signed), { signed: true, adhoc: false, identifier: 'to.radial.mac', teamId: 'ABCDE12345', authorities: ['Developer ID Application: Example Person (ABCDE12345)', 'Developer ID Certification Authority', 'Apple Root CA'], developerId: true, hardenedRuntime: true, stapled: true });
  const adhoc = parseCodesign('Executable=/x/Radial\nIdentifier=Electron\nCodeDirectory v=20400 size=500 flags=0x20002(adhoc,linker-signed) hashes=10+0 location=embedded\nSignature=adhoc\nTeamIdentifier=not set\n');
  assert.equal(adhoc.signed, true); assert.equal(adhoc.adhoc, true); assert.equal(adhoc.developerId, false); assert.equal(adhoc.teamId, null); assert.equal(adhoc.hardenedRuntime, false);
  assert.equal(parseCodesign('/x/Radial.app: code object is not signed at all\n').signed, false);
});

test('parseSpctl reads Gatekeeper\'s verdict', () => {
  assert.deepEqual(parseSpctl('/x/Radial.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Example Person (ABCDE12345)\n'), { accepted: true, source: 'Notarized Developer ID', origin: 'Developer ID Application: Example Person (ABCDE12345)' });
  assert.deepEqual(parseSpctl('/x/Radial.app: rejected\nsource=no usable signature\n'), { accepted: false, source: 'no usable signature', origin: null });
});

test('processesMatching finds processes by what their command line runs from', () => {
  const out = '    1 /sbin/launchd\n  812 /tmp/radial-rehearsal-run-ab12/Applications/Radial.app/Contents/MacOS/Radial --inspect=0\n  813 /tmp/radial-rehearsal-run-ab12/Applications/Radial.app/Contents/MacOS/Radial /tmp/radial-rehearsal-run-ab12/Applications/Radial.app/Contents/Resources/app.asar/out/main/term-daemon.js /tmp/radial-rehearsal-run-ab12/profile/term-daemon.sock\n 9001 /Applications/Radial.app/Contents/MacOS/Radial\n';
  assert.deepEqual(processesMatching(out, ['/tmp/radial-rehearsal-run-ab12/']).map((p) => p.pid), [812, 813]);
  assert.deepEqual(processesMatching(out, ['/tmp/radial-rehearsal-run-ab12/profile/term-daemon.sock']).map((p) => p.pid), [813]);
  assert.deepEqual(processesMatching(out, ['']), [], 'an empty needle matches nothing');
});

test('scrubEnv keeps the basics and drops RADIAL_ variables, agent markers and credentials', () => {
  const env = scrubEnv({
    PATH: '/usr/bin', HOME: '/Users/x', LANG: 'en_US.UTF-8', SSH_AUTH_SOCK: '/tmp/agent', TMPDIR: '/tmp/x/',
    RADIAL_CLI_SOCK: '/Users/x/Library/Application Support/Radial/cli.sock', RADIAL_USERDATA: '/tmp/p', ELECTRON_RUN_AS_NODE: '1',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', APPLE_ID: 'a@b.c', APPLE_APP_SPECIFIC_PASSWORD: 'p', APPLE_TEAM_ID: 'T',
    CSC_LINK: 'x', GH_TOKEN: 't', GITHUB_TOKEN: 't', ANTHROPIC_API_KEY: 'k', RADIAL_POSTHOG_KEY: 'k', NPM_CONFIG_SECRET: 's', AWS_PROFILE: 'p', UNDEFINED: undefined,
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'SSH_AUTH_SOCK', 'TMPDIR']);
});

const RELEASE_GATE = path.join(ROOT, 'scripts', 'release.mts');
test('gateTestFiles reads the release gate\'s packaged tests from scripts/release.mts, and they all exist', { skip: !fs.existsSync(RELEASE_GATE) && 'the release tooling isn\'t part of the public copy' }, () => {
  const files = gateTestFiles(fs.readFileSync(RELEASE_GATE, 'utf8'));
  assert.ok(files.length >= 20, `found ${files.length}`);
  assert.equal(files[0], 'test/nativeChat.e2e.mts');
  assert.ok(files.includes('test/agentPark.e2e.mts'));
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is in the gate but not in the repo`);
  assert.equal(new Set(files).size, files.length);
});

test('rehearsalBuilds sorts build folders by version, and pickPair updates the oldest to the newest', () => {
  const root = tmpDir('rehearsal-builds-');
  for (const v of ['1.0.0-rc.2', '1.0.0-rc.10', '1.0.0-rc.1']) makeBuild(path.join(root, v), v);
  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(path.join(root, 'journal.json'), '{}');
  const builds = rehearsalBuilds(root);
  assert.deepEqual(builds.map((b) => b.version), ['1.0.0-rc.1', '1.0.0-rc.2', '1.0.0-rc.10']);
  const pair = pickPair(builds);
  assert.equal(pair.from.version, '1.0.0-rc.1'); assert.equal(pair.to.version, '1.0.0-rc.10');
  assert.throws(() => pickPair(builds.slice(0, 1)), /needs two builds/);
  assert.throws(() => pickPair([builds[0], { ...builds[0] }]), /all version/);
  assert.deepEqual(rehearsalBuilds(path.join(root, 'none')), []);
});

test('readAppUpdateConfig and feedPort read where an app looks for updates', () => {
  const generic = readAppUpdateConfig('provider: generic\nurl: http://127.0.0.1:8765/\nupdaterCacheDirName: radial-platform-updater\n');
  assert.deepEqual(generic, { provider: 'generic', url: 'http://127.0.0.1:8765/', owner: null, repo: null, channel: null, updaterCacheDirName: 'radial-platform-updater' });
  assert.equal(feedPort(generic.url!), 8765);
  const github = readAppUpdateConfig('owner: Radial-to\nrepo: radial-releases\nprovider: github\nupdaterCacheDirName: radial-platform-updater\n');
  assert.equal(github.provider, 'github'); assert.equal(github.url, null); assert.equal(github.repo, 'radial-releases');
  assert.throws(() => feedPort('https://127.0.0.1:8765/'), /isn't on this Mac/);
  assert.throws(() => feedPort('http://example.com:8765/'), /isn't on this Mac/);
  assert.equal(feedPort('http://localhost/'), 80);
});
