/**
 * A small PNG decoder and encoder in plain Node (zlib only), for the migration
 * compare under `radial serve` (plans/headless-core.md, phase 3): the Mac app
 * decodes screenshots and encodes the diff with Electron's nativeImage, which
 * plain Node doesn't have.
 *
 * decodePng reads any non-interlaced PNG: grayscale, RGB, palette, grayscale
 * with alpha and RGBA, at every bit depth the format allows, with tRNS
 * transparency. Browsers write 8-bit RGB or RGBA. It answers 4 bytes a pixel,
 * RGBA; diff.ts compares RGBA as well as nativeImage's BGRA, since its magenta
 * and gray are the same either way. Interlaced PNGs are refused.
 *
 * encodePng writes 8-bit RGBA, or RGB when every pixel is opaque, each row
 * filtered the way that compresses best (libpng's heuristic).
 *
 * inlineCopy makes the small copy of a screenshot an MCP tool result carries
 * (phase 4): a 2x full-page shot can be tens of MB, so the copy is scaled down
 * to fit a box and a byte budget. It decodes the 8-bit RGB and RGBA browsers
 * write row by row as they inflate, so a tall page never needs its whole
 * bitmap in memory.
 */
import zlib from 'zlib';
import type { Bitmap } from '../main/migrate/diff';

/** A decoded image: 4 bytes a pixel, RGBA, row by row. */
export interface RgbaImage extends Bitmap { data: Buffer }

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Samples a pixel has, by colour type: grayscale, RGB, palette, grayscale and alpha, RGBA. */
const CHANNELS: Partial<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** The bit depths each colour type allows. */
const DEPTHS: Partial<Record<number, number[]>> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/** Why a PNG can't be read: what's wrong with it, in words. */
function damaged(why: string): Error { return new Error(`The PNG can't be read: ${why}.`); }

/** The PNG filters' predictor for the Paeth type: whichever of left, up and up-left is closest to left + up - up-left. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undoes one scanline's filter in place: `line` is its bytes after the filter byte, `prev` the row above, unfiltered (zeros for the first). */
function unfilter(type: number, line: Uint8Array, prev: Uint8Array, bpp: number): void {
  const n = line.length;
  switch (type) {
    case 0: return;
    case 1: for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 255; return;
    case 2: for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 255; return;
    case 3:
      for (let i = 0; i < n; i++) line[i] = (line[i] + (((i >= bpp ? line[i - bpp] : 0) + prev[i]) >> 1)) & 255;
      return;
    case 4:
      for (let i = 0; i < n; i++) line[i] = (line[i] + paeth(i >= bpp ? line[i - bpp] : 0, prev[i], i >= bpp ? prev[i - bpp] : 0)) & 255;
      return;
    default: throw damaged(`a row has filter type ${type}, which PNG doesn't define`);
  }
}

/** Decodes a PNG into RGBA, 4 bytes a pixel. Throws an Error that says why for a file it can't read. */
export function decodePng(png: Buffer): RgbaImage {
  if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) throw damaged('it doesn\'t start with the PNG signature');
  let width = 0, height = 0, depth = 0, type = -1, interlace = 0;
  let palette: Buffer | null = null, trns: Buffer | null = null, ended = false;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length && !ended;) {
    if (at + 12 > png.length) throw damaged('it ends in the middle of a chunk');
    const length = png.readUInt32BE(at);
    const name = png.toString('latin1', at + 4, at + 8);
    if (at + 12 + length > png.length) throw damaged(`its ${name} chunk runs past the end of the file`);
    const data = png.subarray(at + 8, at + 8 + length);
    if (zlib.crc32(png.subarray(at + 4, at + 8 + length)) !== png.readUInt32BE(at + 8 + length)) throw damaged(`its ${name} chunk is damaged (the checksum doesn't match)`);
    at += 12 + length;
    if (name === 'IHDR') {
      if (length !== 13) throw damaged('its header is the wrong size');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12];
      if (!width || !height) throw damaged('it has no pixels');
      if (!DEPTHS[type]) throw damaged(`its colour type ${type} isn't one PNG defines`);
      if (!DEPTHS[type]!.includes(depth)) throw damaged(`bit depth ${depth} isn't allowed for colour type ${type}`);
      if (data[10] !== 0 || data[11] !== 0) throw damaged('it uses a compression or filter method PNG doesn\'t define');
      if (interlace === 1) throw new Error('Interlaced PNGs aren\'t supported: save it without interlacing.');
      if (interlace !== 0) throw damaged(`its interlace method ${interlace} isn't one PNG defines`);
    } else if (!width) throw damaged('its first chunk isn\'t the header');
    else if (name === 'PLTE') palette = data;
    else if (name === 'tRNS') trns = data;
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') ended = true;
  }
  if (!width) throw damaged('it has no header');
  if (!idat.length) throw damaged('it has no image data');
  if (type === 3 && !palette) throw damaged('it has palette colours but no palette');

  const channels = CHANNELS[type]!;
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3); // the filters' step: whole bytes a pixel, at least one
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  let raw: Buffer;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { throw damaged(`its image data doesn't decompress (${(e as Error).message})`); }
  if (raw.length < (stride + 1) * height) throw damaged('its image data is shorter than its size says');

  const out = Buffer.alloc(width * height * 4);
  const max = (1 << depth) - 1; // the largest sample at this depth (16-bit samples are read as their high byte)
  // tRNS for grayscale and RGB: the one colour that is transparent, as raw samples.
  const clearGray = trns && type === 0 && trns.length >= 2 ? trns.readUInt16BE(0) : -1;
  const clearRgb = trns && type === 2 && trns.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const line = new Uint8Array(raw.subarray(start + 1, start + 1 + stride)); // a copy: unfiltered in place
    unfilter(raw[start], line, prev, bpp);
    prev = line;
    if (depth === 8 && (type === 2 || type === 6) && !clearRgb) { // what browsers write: copy the bytes across
      for (let x = 0, i = 0, o = y * width * 4; x < width; x++, i += channels, o += 4) {
        out[o] = line[i]; out[o + 1] = line[i + 1]; out[o + 2] = line[i + 2]; out[o + 3] = type === 6 ? line[i + 3] : 255;
      }
      continue;
    }
    /** Sample s of pixel x, as stored (0..max, or 0..65535 at 16 bits). */
    const sample = depth === 8 ? (x: number, s: number) => line[x * channels + s]
      : depth === 16 ? (x: number, s: number) => (line[(x * channels + s) * 2] << 8) | line[(x * channels + s) * 2 + 1]
      : (x: number, s: number) => { const bit = (x * channels + s) * depth; return (line[bit >> 3] >> (8 - depth - (bit & 7))) & max; };
    const to8 = depth === 16 ? (v: number) => v >> 8 : depth === 8 ? (v: number) => v : (v: number) => Math.round((v * 255) / max);
    for (let x = 0, o = y * width * 4; x < width; x++, o += 4) {
      if (type === 3) {
        const i = sample(x, 0);
        if (i * 3 + 2 >= palette!.length) throw damaged(`a pixel uses palette entry ${i}, past the end of its palette`);
        out[o] = palette![i * 3]; out[o + 1] = palette![i * 3 + 1]; out[o + 2] = palette![i * 3 + 2];
        out[o + 3] = trns && i < trns.length ? trns[i] : 255;
      } else if (type === 0 || type === 4) {
        const g = sample(x, 0);
        out[o] = out[o + 1] = out[o + 2] = to8(g);
        out[o + 3] = type === 4 ? to8(sample(x, 1)) : g === clearGray ? 0 : 255;
      } else {
        const r = sample(x, 0), g = sample(x, 1), b = sample(x, 2);
        out[o] = to8(r); out[o + 1] = to8(g); out[o + 2] = to8(b);
        out[o + 3] = type === 6 ? to8(sample(x, 3)) : clearRgb && r === clearRgb[0] && g === clearRgb[1] && b === clearRgb[2] ? 0 : 255;
      }
    }
  }
  return { width, height, data: out };
}

/** One chunk: its length, name, data and checksum. */
function chunk(name: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(name, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** How encodePng filters its rows: the best of the five for each row (adaptive, the default), or one type for every row. */
export interface EncodeOptions { filter?: 'adaptive' | 0 | 1 | 2 | 3 | 4 }

/** Filters one row with one type into `out` (its filter byte first); answers the sum of the bytes read as signed, the heuristic's cost. */
function filterRow(type: number, row: Uint8Array, prev: Uint8Array, bpp: number, out: Uint8Array): number {
  out[0] = type;
  const n = row.length;
  switch (type) {
    case 0: for (let i = 0; i < n; i++) out[i + 1] = row[i]; break;
    case 1: for (let i = 0; i < n; i++) out[i + 1] = (row[i] - (i >= bpp ? row[i - bpp] : 0)) & 255; break;
    case 2: for (let i = 0; i < n; i++) out[i + 1] = (row[i] - prev[i]) & 255; break;
    case 3: for (let i = 0; i < n; i++) out[i + 1] = (row[i] - (((i >= bpp ? row[i - bpp] : 0) + prev[i]) >> 1)) & 255; break;
    default: for (let i = 0; i < n; i++) out[i + 1] = (row[i] - paeth(i >= bpp ? row[i - bpp] : 0, prev[i], i >= bpp ? prev[i - bpp] : 0)) & 255;
  }
  let cost = 0;
  for (let i = 1; i <= n; i++) { const v = out[i]; cost += v < 128 ? v : 256 - v; }
  return cost;
}

/** Encodes an RGBA image (4 bytes a pixel) as a PNG: RGB when every pixel is opaque, RGBA otherwise. */
export function encodePng(image: Bitmap, { filter = 'adaptive' }: EncodeOptions = {}): Buffer {
  const { width, height, data } = image;
  if (!width || !height || data.length < width * height * 4) throw new Error(`The image to encode should be ${width}×${height} at 4 bytes a pixel.`);
  let opaque = true;
  for (let i = 3; i < width * height * 4; i += 4) if (data[i] !== 255) { opaque = false; break; }
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const candidates = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride + 1));
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(stride);
    for (let x = 0, i = y * width * 4; x < width; x++, i += 4) {
      const o = x * channels;
      row[o] = data[i]; row[o + 1] = data[i + 1]; row[o + 2] = data[i + 2];
      if (channels === 4) row[o + 3] = data[i + 3];
    }
    let best = 0;
    if (filter === 'adaptive') {
      let cost = Infinity;
      for (let t = 0; t < 5; t++) { const c = filterRow(t, row, prev, channels, candidates[t]); if (c < cost) { cost = c; best = t; } }
    } else { best = filter; filterRow(best, row, prev, channels, candidates[best]); }
    raw.set(candidates[best], y * (stride + 1));
    prev = row;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = opaque ? 2 : 6; // 8 bits a sample; RGB or RGBA
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The size a PNG says it is (its header), or null when it isn't a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(SIGNATURE) || png.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** A copy of a PNG small enough to send inline (an MCP tool result's image), and the size of what it was made from. */
export interface InlineCopy { png: Buffer; width: number; height: number; fullWidth: number; fullHeight: number }
/** How small inlineCopy makes it: a box (a 2x shot is taken back to 1x first) and a byte budget. */
export interface InlineOptions {
  /** The shot's device scale: 2 for a 2x shot, which the copy takes back to 1x. */
  scale?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** The most the copy's PNG may weigh: 2.5 MB is 3.3 MB as base64, under the 5 MB a model's API takes for one image. */
  maxBytes?: number;
  /** A bigger image isn't copied at all: past this many pixels, the decode alone takes too long. */
  maxPixels?: number;
}

/**
 * A copy of a PNG that fits the box and the byte budget, scaled down evenly
 * (each pixel of the copy is the average of the pixels it covers); the PNG
 * itself when it already fits. Null when no copy fits within a few tries, or
 * the PNG is too big (or not one) to copy.
 */
export async function inlineCopy(png: Buffer, { scale = 1, maxWidth = 1440, maxHeight = 4000, maxBytes = 2_500_000, maxPixels = 64_000_000 }: InlineOptions = {}): Promise<InlineCopy | null> {
  const size = pngSize(png);
  if (!size || !size.width || !size.height) return null;
  const { width, height } = size;
  if (scale <= 1 && width <= maxWidth && height <= maxHeight && png.length <= maxBytes) return { png, width, height, fullWidth: width, fullHeight: height };
  if (width * height > maxPixels) return null;
  const first = Math.max(1, scale, width / maxWidth, height / maxHeight);
  for (const k of [first, first * 1.5, first * 2.25, first * 3.4]) {
    let small: RgbaImage | null;
    try { small = await shrink(png, k); } catch { return null; }
    if (!small) return null;
    const out = encodePng(small);
    if (out.length <= maxBytes) return { png: out, width: small.width, height: small.height, fullWidth: width, fullHeight: height };
  }
  return null;
}

/** A PNG scaled down by k: browsers' 8-bit RGB or RGBA a row at a time as it inflates; any other kind (small ones only) decoded whole first. */
async function shrink(png: Buffer, k: number): Promise<RgbaImage | null> {
  let width = 0, height = 0, depth = 0, type = -1, interlace = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at + 12 <= png.length;) {
    const length = png.readUInt32BE(at);
    const name = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    at += 12 + length;
    if (name === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
  }
  if (!width || !height || !idat.length) throw damaged('it has no header or no image data');
  const outW = Math.max(1, Math.round(width / k)), outH = Math.max(1, Math.round(height / k));
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace !== 0) {
    if (width * height > 16_000_000) return null; // not what a browser writes: only a small one is worth decoding whole
    const whole = decodePng(png);
    const acc = accumulator(width, height, outW, outH, 4);
    for (let y = 0; y < height; y++) acc.row(y, whole.data.subarray(y * width * 4, (y + 1) * width * 4), true);
    return acc.done();
  }
  const channels = type === 6 ? 4 : 3;
  const stride = width * channels;
  const acc = accumulator(width, height, outW, outH, channels);
  let prev = new Uint8Array(stride), line = new Uint8Array(stride);
  let pending: Buffer = Buffer.alloc(0);
  let y = 0;
  const inflate = zlib.createInflate();
  const finished = new Promise<void>((resolve, reject) => {
    inflate.on('data', (data: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, data]) : data;
      let at = 0;
      while (y < height && pending.length - at >= stride + 1) {
        line.set(pending.subarray(at + 1, at + 1 + stride));
        unfilter(pending[at], line, prev, channels);
        acc.row(y++, line, channels === 4);
        const t = prev; prev = line; line = t;
        at += stride + 1;
      }
      pending = pending.subarray(at);
    });
    inflate.on('end', () => resolve());
    inflate.on('error', reject);
  });
  for (const d of idat) inflate.write(d);
  inflate.end();
  await finished;
  if (y < height) throw damaged('its image data is shorter than its size says');
  return acc.done();
}

/** Sums source rows into a smaller image: each source pixel adds to the one copy pixel it falls in, and each copy pixel is their average. */
function accumulator(width: number, height: number, outW: number, outH: number, channels: number) {
  const out = Buffer.alloc(outW * outH * 4);
  const xs = new Int32Array(width);
  for (let x = 0; x < width; x++) xs[x] = Math.min(outW - 1, Math.floor((x * outW) / width));
  const sums = new Uint32Array(outW * 4), counts = new Uint32Array(outW);
  let current = 0;
  const flush = () => {
    for (let ox = 0, o = current * outW * 4; ox < outW; ox++, o += 4) {
      const n = counts[ox] || 1;
      out[o] = Math.round(sums[ox * 4] / n); out[o + 1] = Math.round(sums[ox * 4 + 1] / n); out[o + 2] = Math.round(sums[ox * 4 + 2] / n); out[o + 3] = Math.round(sums[ox * 4 + 3] / n);
    }
    sums.fill(0); counts.fill(0);
  };
  return {
    /** Source row y, `channels` bytes a pixel (RGB, or RGBA when alpha). */
    row(y: number, line: Uint8Array, alpha: boolean): void {
      const oy = Math.min(outH - 1, Math.floor((y * outH) / height));
      if (oy !== current) { flush(); current = oy; }
      for (let x = 0, i = 0; x < width; x++, i += channels) {
        const s = xs[x] * 4;
        sums[s] += line[i]; sums[s + 1] += line[i + 1]; sums[s + 2] += line[i + 2]; sums[s + 3] += alpha ? line[i + 3] : 255;
        counts[xs[x]]++;
      }
    },
    done(): RgbaImage { flush(); return { width: outW, height: outH, data: out }; },
  };
}
