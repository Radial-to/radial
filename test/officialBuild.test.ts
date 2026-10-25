// Official builds carry src/main/official-build.json (written by
// scripts/official-build.mts); builds from source don't. Without it there is
// no analytics key, so nothing is sent.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import type { TelemetryClient } from '../src/main/telemetry';
import { tmpDir } from './support/tmp';

/** What the stand-in client's capture() is handed. */
type CapturedEvent = Parameters<TelemetryClient['capture']>[0];

delete process.env.RADIAL_POSTHOG_KEY;
const official = require('../src/main/officialBuild') as typeof import('../src/main/officialBuild');

test('a build from source has no official config', () => {
  assert.equal(fs.existsSync(official.FILE), false, 'official-build.json must never be committed');
  assert.equal(official.isOfficial(), false);
  assert.equal(official.get('posthogKey'), undefined);
});

test('an official config is read once and exposes its fields', () => {
  const dir = tmpDir('radial-official-');
  const file = path.join(dir, 'official-build.json');
  fs.writeFileSync(file, JSON.stringify({ posthogKey: 'phc_example', posthogHost: 'https://example.invalid' }));
  try {
    official._setFile(file);
    assert.equal(official.isOfficial(), true);
    assert.equal(official.get('posthogKey'), 'phc_example');
    official._setFile(path.join(dir, 'missing.json'));
    assert.equal(official.isOfficial(), false);
  } finally {
    official._setFile(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without a key, analytics never makes a client and sends nothing', () => {
  const telemetry = require('../src/main/telemetry') as typeof import('../src/main/telemetry');
  const dir = tmpDir('radial-tm-nokey-');
  const sent: CapturedEvent[] = [];
  try {
    telemetry.init(dir, { appVersion: '1.0.0', osVersion: '15.0', sendAllowed: true, makeClient: () => ({ capture: (p) => sent.push(p), shutdown: async () => {} }) });
    assert.equal(telemetry.POSTHOG_KEY, null);
    assert.equal(telemetry.isAvailable(), false);
    telemetry.capture('app_opened');
    assert.equal(sent.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'telemetry-log.jsonl')), false, 'nothing is logged as sent either');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
