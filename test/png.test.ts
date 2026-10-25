// The PNG codec radial serve's migration compare uses in place of Electron's
// nativeImage (src/headless/png.ts). The decoder is checked against PNGs from
// other encoders and against images built here byte by byte, with the
// expected pixels worked out by hand (and confirmed with Pillow when the
// tests were written); the encoder by decoding what it writes.

import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import { decodePng, encodePng, inlineCopy, pngSize } from '../src/headless/png';
import { diffBitmaps } from '../src/main/migrate/diff';

const ROOT = path.join(__dirname, '..');
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(name: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(name, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** A PNG built by hand: the header's fields, then rows exactly as stored (each with its filter byte), and any extra chunks before the data. */
function png({ width, height, depth, type, interlace = 0 }: { width: number; height: number; depth: number; type: number; interlace?: number }, rows: number[][], extra: [string, Buffer][] = []): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = type; header[12] = interlace;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), ...extra.map(([n, d]) => chunk(n, d)), chunk('IDAT', zlib.deflateSync(Buffer.from(rows.flat()))), chunk('IEND', Buffer.alloc(0))]);
}
/** The decoded pixels as [r, g, b, a] each. */
const pixels = (data: Buffer) => Array.from({ length: data.length / 4 }, (_, i) => [...data.subarray(i * 4, i * 4 + 4)]);
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

test('reads PNGs other encoders wrote, every filter type in use, exactly as Pillow does', () => {
  // test/fixtures/png/filters.png was written by Pillow, its 192 rows filtered with all five types (Paeth 107,
  // Up 58, Sub 10, Average 9, None 8); the hash is Pillow's own RGBA decode of it.
  const image = decodePng(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'png', 'filters.png')));
  assert.deepEqual([image.width, image.height], [256, 192]);
  assert.equal(sha256(image.data), '3fbc41edab9a55822d0d1b71157ba8b1be6d127ee3cd7f6844d2e34376610751');
  assert.deepEqual(pixels(image.data)[0], [0, 0, 0, 0], 'a transparent corner');
});

// The official app's own icon and logo, which a public copy replaces with placeholders.
const ICON = path.join(ROOT, 'build', 'icon.png');
const LOGO = path.join(ROOT, 'src', 'renderer', 'radial-logo-flame-dark.png');
const officialBrand = fs.existsSync(ICON) && sha256(fs.readFileSync(ICON)) === '24f7d98aea1c6e38ea070d861be6c8b8ef3f6034f3e6c7cbe6e8c8aecba52536';
test('reads the official icon and logo exactly as Pillow does', { skip: !officialBrand && 'this copy has the placeholder brand' }, () => {
  // build/icon.png filters its 512 rows with all five types (Paeth 333, None 68, Sub 49, Up 41, Average 21).
  const icon = decodePng(fs.readFileSync(ICON));
  assert.deepEqual([icon.width, icon.height], [512, 512]);
  assert.equal(sha256(icon.data), '9e43aea3a8288d2b0068b222f91da607b3093565608d540fcf20f660c1c95805');
  assert.deepEqual(pixels(icon.data)[0], [0, 0, 0, 0], 'a transparent corner');
  const logo = decodePng(fs.readFileSync(LOGO));
  assert.deepEqual([logo.width, logo.height], [1200, 318]);
  assert.equal(sha256(logo.data), '6bc441256f19165cf06e2894604d113145c3a2340edd21f89c65060f07a37571');
});

test('undoes each of the five filters, worked by hand', () => {
  // 2×5 RGB; the rows filtered Sub, Paeth, Average, Up and None.
  const image = decodePng(png({ width: 2, height: 5, depth: 8, type: 2 }, [
    [1, 10, 20, 30, 5, 5, 5], // Sub: the second pixel adds the first
    [4, 1, 1, 1, 2, 2, 2], // Paeth: up for both pixels here
    [3, 0, 0, 0, 0, 0, 0], // Average of left and up, rounded down
    [2, 1, 1, 1, 1, 1, 1], // Up
    [0, 7, 8, 9, 10, 11, 12], // None
  ]));
  assert.deepEqual(pixels(image.data), [
    [10, 20, 30, 255], [15, 25, 35, 255],
    [11, 21, 31, 255], [17, 27, 37, 255],
    [5, 10, 15, 255], [11, 18, 26, 255],
    [6, 11, 16, 255], [12, 19, 27, 255],
    [7, 8, 9, 255], [10, 11, 12, 255],
  ]);
});

test('grayscale at 1, 2, 4, 8 and 16 bits, scaled to 8 bits, with its one transparent gray', () => {
  // 1 bit: 1011001110, padded to whole bytes.
  assert.deepEqual(pixels(decodePng(png({ width: 10, height: 1, depth: 1, type: 0 }, [[0, 0b10110011, 0b10000000]])).data).map((p) => p[0]), [255, 0, 255, 255, 0, 0, 255, 255, 255, 0]);
  // 2 bits: 0 1 2 3 1 → 0 85 170 255 85.
  assert.deepEqual(pixels(decodePng(png({ width: 5, height: 1, depth: 2, type: 0 }, [[0, 0b00011011, 0b01000000]])).data).map((p) => p[0]), [0, 85, 170, 255, 85]);
  // 4 bits: 0 7 15 → 0 119 255.
  assert.deepEqual(pixels(decodePng(png({ width: 3, height: 1, depth: 4, type: 0 }, [[0, 0x07, 0xf0]])).data).map((p) => p[0]), [0, 119, 255]);
  // 8 bits with tRNS 7: that gray is transparent, the next one isn't.
  assert.deepEqual(pixels(decodePng(png({ width: 2, height: 1, depth: 8, type: 0 }, [[0, 7, 8]], [['tRNS', Buffer.from([0, 7])]])).data), [[7, 7, 7, 0], [8, 8, 8, 255]]);
  // 16 bits: the high byte, and tRNS compares the whole sample.
  assert.deepEqual(pixels(decodePng(png({ width: 2, height: 1, depth: 16, type: 0 }, [[0, 0x12, 0x34, 0xab, 0xcd]], [['tRNS', Buffer.from([0x12, 0x34])]])).data), [[0x12, 0x12, 0x12, 0], [0xab, 0xab, 0xab, 255]]);
});

test('palette colours with tRNS alpha, grayscale with alpha, and 16-bit RGB and RGBA', () => {
  // 2-bit palette: red, green, blue; tRNS gives red 0 and green 128, blue stays opaque.
  const plte = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
  assert.deepEqual(pixels(decodePng(png({ width: 4, height: 1, depth: 2, type: 3 }, [[0, 0b00011001]], [['PLTE', plte], ['tRNS', Buffer.from([0, 128])]])).data),
    [[255, 0, 0, 0], [0, 255, 0, 128], [0, 0, 255, 255], [0, 255, 0, 128]]);
  assert.deepEqual(pixels(decodePng(png({ width: 2, height: 1, depth: 8, type: 4 }, [[0, 50, 200, 60, 0]])).data), [[50, 50, 50, 200], [60, 60, 60, 0]]);
  assert.deepEqual(pixels(decodePng(png({ width: 2, height: 1, depth: 16, type: 2 }, [[0, 1, 2, 3, 4, 5, 6, 0xff, 0, 0x80, 0, 0, 0]], [['tRNS', Buffer.from([1, 2, 3, 4, 5, 6])]])).data), [[1, 3, 5, 0], [255, 128, 0, 255]]);
  assert.deepEqual(pixels(decodePng(png({ width: 1, height: 1, depth: 16, type: 6 }, [[0, 0x11, 0x11, 0x22, 0x22, 0x33, 0x33, 0x44, 0x44]])).data), [[0x11, 0x22, 0x33, 0x44]]);
});

test('encodes RGBA, or RGB when every pixel is opaque, and reads back what it wrote, whichever filter', () => {
  const width = 37, height = 23;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7919 + (i >> 5) * 31) & 255; // noise with some structure
  const translucent = encodePng({ width, height, data });
  assert.equal(translucent[25], 6, 'RGBA when some pixel is translucent');
  assert.ok(decodePng(translucent).data.equals(data));
  const opaqueData = Buffer.from(data); for (let i = 3; i < opaqueData.length; i += 4) opaqueData[i] = 255;
  for (const filter of ['adaptive', 0, 1, 2, 3, 4] as const) {
    const out = encodePng({ width, height, data: opaqueData }, { filter });
    assert.equal(out[25], 2, `RGB when every pixel is opaque (filter ${filter})`);
    assert.ok(decodePng(out).data.equals(opaqueData), `round trip with filter ${filter}`);
  }
  // A real image: decoded, written and read back unchanged.
  const icon = decodePng(fs.readFileSync(path.join(ROOT, 'build', 'icon.png')));
  assert.ok(decodePng(encodePng(icon)).data.equals(icon.data));
  assert.throws(() => encodePng({ width: 4, height: 4, data: Buffer.alloc(10) }), /should be 4×4 at 4 bytes a pixel/);
});

test('the migration diff encodes and reads back: a compare’s screenshots decode, the diff image they make encodes', () => {
  const page = (shade: number) => { const d = Buffer.alloc(40 * 30 * 4, shade); for (let i = 3; i < d.length; i += 4) d[i] = 255; return { width: 40, height: 30, data: d }; };
  const live = page(200), local = page(200);
  for (let y = 10; y < 14; y++) for (let x = 0; x < 40; x++) local.data[(y * 40 + x) * 4] = 0; // a changed band
  const result = diffBitmaps(decodePng(encodePng(live)), decodePng(encodePng(local)));
  assert.equal(result.changed, 160); assert.deepEqual(result.bands, [{ top: 10, bottom: 13, pixels: 160 }]);
  const diff = decodePng(encodePng(result.image));
  assert.ok(diff.data.equals(result.image.data), 'the diff image survives the trip');
  assert.deepEqual(pixels(diff.data)[10 * 40], [255, 0, 255, 255], 'changed pixels are magenta');
});

test('says why it can’t read a file: not a PNG, damaged, cut short, interlaced, or a depth the format doesn’t allow', () => {
  const good = png({ width: 2, height: 1, depth: 8, type: 2 }, [[0, 1, 2, 3, 4, 5, 6]]);
  assert.throws(() => decodePng(Buffer.from('GIF89a, not a PNG')), /doesn't start with the PNG signature/);
  const flipped = Buffer.from(good); flipped[flipped.length - 20] ^= 0xff; // a byte inside IDAT
  assert.throws(() => decodePng(flipped), /IDAT chunk is damaged \(the checksum doesn't match\)/);
  assert.throws(() => decodePng(good.subarray(0, 40)), /runs past the end of the file|ends in the middle of a chunk/);
  assert.throws(() => decodePng(png({ width: 2, height: 1, depth: 8, type: 2, interlace: 1 }, [[0, 1, 2, 3, 4, 5, 6]])), /^Error: Interlaced PNGs aren't supported/);
  assert.throws(() => decodePng(png({ width: 2, height: 1, depth: 4, type: 2 }, [[0, 1, 2]])), /bit depth 4 isn't allowed for colour type 2/);
  assert.throws(() => decodePng(png({ width: 2, height: 1, depth: 8, type: 3 }, [[0, 0, 0]])), /palette colours but no palette/);
  assert.throws(() => decodePng(png({ width: 2, height: 2, depth: 8, type: 2 }, [[0, 1, 2, 3, 4, 5, 6]])), /shorter than its size says/);
  assert.throws(() => decodePng(png({ width: 1, height: 1, depth: 8, type: 2 }, [[9, 1, 2, 3]])), /filter type 9/);
});

/** Each copy pixel as the average of the source pixels it covers, worked out from the whole decoded image (what inlineCopy's streaming decode must match). */
function boxAverage(src: { width: number; height: number; data: Buffer }, outW: number, outH: number): Buffer {
  const out = Buffer.alloc(outW * outH * 4);
  const sums = new Float64Array(outW * outH * 4), counts = new Float64Array(outW * outH);
  for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
    const ox = Math.min(outW - 1, Math.floor((x * outW) / src.width)), oy = Math.min(outH - 1, Math.floor((y * outH) / src.height));
    for (let c = 0; c < 4; c++) sums[(oy * outW + ox) * 4 + c] += src.data[(y * src.width + x) * 4 + c];
    counts[oy * outW + ox]++;
  }
  for (let i = 0; i < outW * outH; i++) for (let c = 0; c < 4; c++) out[i * 4 + c] = Math.round(sums[i * 4 + c] / counts[i]);
  return out;
}

test('the inline copy of a shot: as it is when it fits; a 2x shot at 1x, each pixel the average it covers, streamed row by row whatever the filters', async () => {
  const small = encodePng({ width: 10, height: 6, data: crypto.randomBytes(10 * 6 * 4) });
  const same = await inlineCopy(small);
  assert.equal(same!.png, small, 'a PNG that fits goes as it is');
  assert.deepEqual(pngSize(small), { width: 10, height: 6 });
  assert.equal(pngSize(Buffer.from('not a png at all, no')), null);
  assert.equal(await inlineCopy(Buffer.from('GIF89a, not a PNG at all')), null);
  // Random RGBA, so encodePng's adaptive filters use every type: the streaming decode must undo each exactly.
  for (const [w, h, alpha] of [[37, 23, true], [64, 40, false], [5, 300, false]] as const) {
    const data = crypto.randomBytes(w * h * 4);
    if (!alpha) for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const copy = (await inlineCopy(encodePng({ width: w, height: h, data }), { scale: 2 }))!;
    const outW = Math.round(w / 2), outH = Math.round(h / 2);
    assert.deepEqual([copy.width, copy.height, copy.fullWidth, copy.fullHeight], [outW, outH, w, h]);
    const back = decodePng(copy.png);
    assert.ok(back.data.equals(boxAverage({ width: w, height: h, data }, outW, outH)), `${w}×${h}${alpha ? ' with alpha' : ''}: the averages`);
  }
});

test('the inline copy fits its box and its byte budget, or there is none', async () => {
  const wide = encodePng({ width: 3000, height: 20, data: Buffer.alloc(3000 * 20 * 4, 255) });
  const fitted = (await inlineCopy(wide))!;
  assert.deepEqual([fitted.width, fitted.height], [1440, 10], 'the width capped at 1440, the height in proportion');
  const tall = encodePng({ width: 100, height: 9000, data: Buffer.alloc(100 * 9000 * 4, 128) });
  const short = (await inlineCopy(tall))!;
  assert.deepEqual([short.width, short.height], [44, 4000], 'the height capped at 4000');
  // Noise doesn't compress: a byte budget smaller than the first copy makes smaller ones, until one fits.
  const noise = encodePng({ width: 400, height: 400, data: crypto.randomBytes(400 * 400 * 4) });
  const budget = (await inlineCopy(noise, { scale: 2, maxBytes: 60_000 }))!;
  assert.ok(budget.png.length <= 60_000 && budget.width < 200, `${budget.width}×${budget.height}, ${budget.png.length} bytes`);
  assert.equal(await inlineCopy(noise, { scale: 2, maxBytes: 500 }), null, 'none fits: no copy');
  assert.equal(await inlineCopy(noise, { scale: 2, maxPixels: 1000 }), null, 'too big to decode: no copy');
  // Kinds no browser writes are decoded whole first: 16-bit RGB here.
  const deep = png({ width: 2, height: 2, depth: 16, type: 2 }, [[0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0], [0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0]]);
  const one = (await inlineCopy(deep, { scale: 2 }))!;
  assert.deepEqual(pixels(decodePng(one.png).data), [[128, 64, 64, 255]], 'black, red, white and black, averaged');
});
