#!/usr/bin/env node
// The official (signed) build: the only build that sends anonymous usage stats
// and updates itself.
//
//   npm run dist:signed          (loads .env.local, then runs this)
//
// Writes src/main/official-build.json with the analytics key, runs
// electron-builder with the update feed (Radial-to/radial-releases, which bakes
// app-update.yml into the app), and always removes the file again, so it never
// lands in git and a build from source has neither. Needs RADIAL_POSTHOG_KEY
// (and optionally RADIAL_POSTHOG_HOST) in the environment, usually from
// .env.local.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildAll } from './build.mts';

/**
 * official-build.json, which the app reads back as OfficialConfig in
 * src/main/officialBuild.ts. Restated, not imported: an import would pull src/
 * into the scripts project, whose settings src/ doesn't type-check under. Keep
 * the two the same.
 */
interface OfficialConfig { posthogKey: string; posthogHost: string }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = path.join(root, 'src', 'main', 'official-build.json');

const posthogKey = (process.env.RADIAL_POSTHOG_KEY || '').trim();
if (!posthogKey) {
  console.error('✗ RADIAL_POSTHOG_KEY is not set. Official builds need the PostHog project key: add RADIAL_POSTHOG_KEY=… to .env.local.');
  process.exit(1);
}

const config: OfficialConfig = {
  posthogKey,
  posthogHost: (process.env.RADIAL_POSTHOG_HOST || '').trim() || 'https://us.i.posthog.com',
};
// Installed apps look for updates here; the release gate uploads to the same repo.
const FEED = ['-c.publish.provider=github', '-c.publish.owner=Radial-to', '-c.publish.repo=radial-releases'];

fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
let status = 1;
try {
  await buildAll(); // copies official-build.json into out/main with the compiled app
  const builder = path.join(root, 'node_modules', '.bin', 'electron-builder');
  const r = spawnSync(builder, ['--mac', 'dmg', 'zip', ...FEED, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
  status = r.status === null ? 1 : r.status;
} finally {
  fs.rmSync(configFile, { force: true });
  // and its compiled copy, so a later dev run from out/ isn't treated as official
  fs.rmSync(path.join(root, 'out', 'main', 'official-build.json'), { force: true });
}
process.exit(status);
