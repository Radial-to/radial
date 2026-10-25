import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as cliAgent from '../src/main/cliAgent';
import type { RunPrintResult } from '../src/main/cliAgent';
import { tmpDir } from './support/tmp';

// Each test asserts which way runPrint went before it reads that side's fields.
type Printed = Extract<RunPrintResult, { ok: true }>;
type Failed = Extract<RunPrintResult, { ok: false }>;

// A stand-in `claude` binary: records its args, echoes stdin back transformed.
function stubBin(script: string) {
  const dir = tmpDir('cliagent-');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(bin, 0o755);
  return { bin, dir };
}

test('runPrint sends the prompt on stdin and returns trimmed stdout', async () => {
  const { bin, dir } = stubBin('echo "args: $@" >&2; sed "s/^/got: /"');
  const r = await cliAgent.runPrint(dir, 'write a commit message', { model: 'claude-haiku-4-5-20251001', bin }) as Printed;
  assert.equal(r.ok, true);
  assert.equal(r.text, 'got: write a commit message');
});

test('runPrint passes -p and model, and never a permission flag (read-only)', async () => {
  const { bin, dir } = stubBin('echo "$@"');
  const r = await cliAgent.runPrint(dir, 'x', { model: 'm1', bin }) as Printed;
  assert.equal(r.ok, true);
  assert.match(r.text, /-p/);
  assert.match(r.text, /--model m1/);
  assert.doesNotMatch(r.text, /--permission-mode/);
});

test('a nonzero exit surfaces stderr as the error', async () => {
  const { bin, dir } = stubBin('echo "no credit remaining" >&2; exit 1');
  const r = await cliAgent.runPrint(dir, 'x', { bin }) as Failed;
  assert.equal(r.ok, false);
  assert.match(r.error, /no credit remaining/);
});

test('a hung CLI times out instead of wedging the caller', async () => {
  const { bin, dir } = stubBin('sleep 30');
  const r = await cliAgent.runPrint(dir, 'x', { bin, timeoutMs: 500 }) as Failed;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
});

test('a missing binary fails cleanly', async () => {
  const r = await cliAgent.runPrint(os.tmpdir(), 'x', { bin: '/nope/claude-none' }) as Failed;
  assert.equal(r.ok, false);
  assert.ok(r.error);
});
