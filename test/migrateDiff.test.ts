import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffBitmaps } from '../src/main/migrate/diff';
import type { Bitmap } from '../src/main/migrate/diff';

const bitmap = (width: number, height: number, paint: (x: number, y: number) => [number, number, number] = () => [255, 255, 255]): Bitmap => {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const [r, g, b] = paint(x, y); data.set([r, g, b, 255], (y * width + x) * 4); }
  return { width, height, data };
};

test('identical pages report no change; a missing button is located, not averaged away', () => {
  const live = bitmap(100, 200, (x, y) => y >= 150 && y < 160 && x >= 40 && x < 60 ? [20, 20, 20] : [255, 255, 255]);
  assert.equal(diffBitmaps(live, live).changed, 0);
  const local = bitmap(100, 200);
  const result = diffBitmaps(live, local);
  assert.equal(result.changed, 200);
  assert.deepEqual(result.bands, [{ top: 150, bottom: 159, pixels: 200 }]);
  assert.equal(result.ratio, 200 / 20000);
  const o = (155 * 100 + 50) * 4;
  assert.deepEqual([...result.image.data.subarray(o, o + 4)], [255, 0, 255, 255], 'changes are highlighted');
});

test('small antialiasing noise stays under the threshold and height differences are reported', () => {
  const live = bitmap(50, 100), local = bitmap(50, 130, () => [250, 250, 250]);
  const result = diffBitmaps(live, local);
  assert.equal(result.changed, 0);
  assert.deepEqual(result.heights, { live: 100, local: 130, delta: 30 });
  assert.equal(result.height, 100, 'only the overlap is compared pixel by pixel');
});
