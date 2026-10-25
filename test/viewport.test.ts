import { test } from 'node:test';
import assert from 'node:assert';
import { fitArtboard } from '../src/renderer/viewport';

test('a contained artboard preserves all of itself in the available canvas', () => {
  const r = fitArtboard({ width: 1440, height: 900, fill: true, fit: 'contain' }, { width: 1000, height: 750 })!;
  assert.equal(Number(r.scale.toFixed(4)), 0.6944);
  assert.equal(Number(r.visualWidth.toFixed(2)), 1000);
  assert.equal(Number(r.visualHeight.toFixed(2)), 625);
  assert.equal(Number(r.y.toFixed(2)), 62.5);
});

test('a width-fitted desktop fills height without cropping either side', () => {
  const r = fitArtboard({ width: 1440, height: 900, fill: true, fit: 'width' }, { width: 1000, height: 750 })!;
  assert.equal(Number(r.scale.toFixed(4)), 0.6944);
  assert.equal(Number(r.height.toFixed(2)), 1080);
  assert.equal(Number(r.visualWidth.toFixed(2)), 1000);
  assert.equal(Number(r.visualHeight.toFixed(2)), 750);
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
});

test('a device/manual artboard is not enlarged beyond its native size', () => {
  const r = fitArtboard({ width: 390, height: 844, fill: false }, { width: 1200, height: 900 })!;
  assert.equal(r.scale, 1);
  assert.equal(r.x, 405);
  assert.equal(r.y, 28);
});
