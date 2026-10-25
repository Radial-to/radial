// Pure math for the preview rulers + guides. No DOM — so it's unit-testable
// (mirrors viewport.js). Loaded as a plain <script> exposing window.RadialGuides
// in the renderer (CSP blocks require there), and as a CommonJS module in tests.
//
// Guides are TEMPORARY, SCREEN-FIXED overlay lines drawn over the whole #preview
// view in plain screen pixels — not page coords, not artboard coords. So the math
// here is deliberately tiny: an offset within the preview content area, and the
// tick marks for the ruler strips. No scale / zoom / artboard involved on purpose.

// Map a pointer client coordinate to a guide offset (px) within the ruled area,
// clamped so a guide can't sit outside the view.
//   client — clientX (vertical guide) or clientY (horizontal guide)
//   edge   — the area's left (vertical) or top (horizontal) in client space
//   size   — the area's width (vertical) or height (horizontal) in px
function clampOffset(client: number, edge: number, size: number): number {
  const off = client - edge;
  if (off < 0) return 0;
  if (off > size) return size;
  return off;
}

/** One tick on a ruler strip: its offset in px, and its label when major. */
export interface RulerTick { off: number; major: boolean; label: string }

// Tick marks for a ruler strip of length `size`, one every `step` px. Every 5th
// tick is "major" and carries a px label; the rest are minor and unlabeled.
// Returns [{ off, major, label }].
function rulerTicks(size: number, step: number): RulerTick[] {
  step = step > 0 ? step : 10;
  const ticks: RulerTick[] = [];
  const majorEvery = step * 5;
  for (let off = 0; off <= size; off += step) {
    const major = off % majorEvery === 0;
    ticks.push({ off, major, label: major ? String(off) : '' });
  }
  return ticks;
}

export { clampOffset, rulerTicks };
