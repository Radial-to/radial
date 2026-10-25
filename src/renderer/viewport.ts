// DOM-free artboard math for the preview. Desktop can retain a stable logical
// width while its logical height expands to use the canvas; manually
// sized/device artboards only scale down.

/** The logical viewport the site renders at (renderer.js getViewport). */
export interface ArtboardViewport {
  width: number;
  height: number;
  /** width: fill the stage's width; device: keep the width, centred; otherwise contain. */
  fit?: 'width' | 'device' | 'contain';
  /** Contain may scale up past 1. */
  fill?: boolean;
}
/** The canvas area the artboard is fitted into, in px. */
export interface ArtboardStage { width: number; height: number }
/** Where the artboard lands: logical size, scale, offset and on-screen size. */
export interface Artboard {
  width: number;
  height: number;
  scale: number;
  x: number;
  y: number;
  visualWidth: number;
  visualHeight: number;
}

function fitArtboard(viewport: ArtboardViewport | null | undefined, stage: ArtboardStage | null | undefined): Artboard | null {
  const width = Number(viewport && viewport.width) || 0;
  const initialHeight = Number(viewport && viewport.height) || 0;
  const stageWidth = Number(stage && stage.width) || 0;
  const stageHeight = Number(stage && stage.height) || 0;
  if (width <= 0 || initialHeight <= 0 || stageWidth <= 0 || stageHeight <= 0) return null;
  if (viewport && viewport.fit === 'width') {
    const scale = stageWidth / width;
    const height = stageHeight / scale;
    return {
      width, height, scale,
      x: 0, y: 0,
      visualWidth: stageWidth, visualHeight: stageHeight,
    };
  }
  // Device width (tablet/mobile): keep the breakpoint width, centered, but let
  // the logical height fill the full stage so it shows full-height (no
  // letterbox). Only scales down when the device is wider than the stage.
  if (viewport && viewport.fit === 'device') {
    const scale = Math.min(1, stageWidth / width);
    const height = stageHeight / scale;
    const visualWidth = width * scale;
    return {
      width, height, scale,
      x: (stageWidth - visualWidth) / 2, y: 0,
      visualWidth, visualHeight: stageHeight,
    };
  }
  const height = initialHeight;
  const contain = Math.min(stageWidth / width, stageHeight / height);
  const scale = (viewport && viewport.fill) ? contain : Math.min(1, contain);
  const visualWidth = width * scale;
  const visualHeight = height * scale;
  return {
    width, height, scale,
    x: (stageWidth - visualWidth) / 2,
    y: (stageHeight - visualHeight) / 2,
    visualWidth, visualHeight,
  };
}

export { fitArtboard };
