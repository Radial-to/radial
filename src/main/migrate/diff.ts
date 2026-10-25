// Pixel comparison for migration parity (plans/site-migration.md). Works on raw
// 4-byte-per-pixel bitmaps so it runs without Electron; compare.js decodes PNGs
// with nativeImage. Only the overlapping area is compared pixel by pixel, and a
// height difference is reported beside it, never hidden.

/** A raw image: `data` holds 4 bytes per pixel, row by row (nativeImage's toBitmap()). */
export interface Bitmap { width: number; height: number; data: Uint8Array }
export interface DiffOptions { threshold?: number; bandGap?: number }
/** A run of rows with changed pixels (inclusive), and how many changed in it. */
export interface DiffBand { top: number; bottom: number; pixels: number }
export interface BitmapDiff {
  width: number; height: number; compared: number; changed: number; ratio: number;
  heights: { live: number; local: number; delta: number }; widths: { live: number; local: number };
  bands: DiffBand[];
  /** The overlap with changes in magenta over a gray backdrop, ready for nativeImage.createFromBitmap. */
  image: Bitmap & { data: Buffer };
}

// a, b: { width, height, data } with 4 bytes per pixel (RGBA or BGRA: the
// highlight is magenta and the backdrop gray, so channel order never matters).
function diffBitmaps(a: Bitmap, b: Bitmap, { threshold = 40, bandGap = 12 }: DiffOptions = {}): BitmapDiff {
  const width = Math.min(a.width, b.width), height = Math.min(a.height, b.height);
  const out = Buffer.alloc(width * height * 4);
  const rows = new Uint32Array(height);
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * a.width + x) * 4, j = (y * b.width + x) * 4, o = (y * width + x) * 4;
      const d = Math.max(Math.abs(a.data[i] - b.data[j]), Math.abs(a.data[i + 1] - b.data[j + 1]), Math.abs(a.data[i + 2] - b.data[j + 2]));
      if (d > threshold) { changed++; rows[y]++; out[o] = 255; out[o + 1] = 0; out[o + 2] = 255; }
      else { const g = 170 + Math.round((a.data[i] + a.data[i + 1] + a.data[i + 2]) / 9); out[o] = out[o + 1] = out[o + 2] = g; }
      out[o + 3] = 255;
    }
  }
  // Changed bands (top to bottom), merged across small gaps: where to look.
  const bands: DiffBand[] = [];
  for (let y = 0; y < height; y++) {
    if (!rows[y]) continue;
    const last = bands[bands.length - 1];
    if (last && y - last.bottom <= bandGap) { last.bottom = y; last.pixels += rows[y]; }
    else bands.push({ top: y, bottom: y, pixels: rows[y] });
  }
  return {
    width, height, compared: width * height, changed, ratio: width * height ? changed / (width * height) : 0,
    heights: { live: a.height, local: b.height, delta: b.height - a.height }, widths: { live: a.width, local: b.width },
    bands: bands.sort((p, q) => q.pixels - p.pixels).slice(0, 12).sort((p, q) => p.top - q.top),
    image: { width, height, data: out },
  };
}

export { diffBitmaps };
