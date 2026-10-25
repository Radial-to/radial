"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useIcon } from "@/lib/icon-context";
import { useShape } from "@/lib/shape-context";

// ─── Lazy pdfjs loader ────────────────────────────────────────────────────
// Imports pdfjs-dist on first PDF, caches the module, and points the worker
// at the packaged local worker; no network fetch is needed. The legacy build
// supplies typed-array helpers missing from Electron 33’s Chromium.
type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = new URL("vendor/fluid/pdf.worker.min.mjs", window.location.href).href;
      return mod;
    });
  }
  return pdfjsPromise;
}

async function renderPdfFirstPage(file: File, targetWidth: number): Promise<string> {
  const pdfjs = await loadPdfjs();
  const buffer = await file.arrayBuffer();
  // pdfjs 6 runs a PDF's functions without eval, so there is no isEvalSupported to turn off.
  const task = pdfjs.getDocument({ data: buffer });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    // Bound both dimensions, including unusually tall or wide pages.
    const scale = (Math.min(targetWidth, 800) * 2) / Math.max(baseViewport.width, baseViewport.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    await page.render({ canvas, viewport }).promise;
    return canvas.toDataURL("image/png");
  } finally { await task.destroy(); }

}

// ─── File thumbnail ───────────────────────────────────────────────────────
// Read-only square preview of a File. Images use object-cover via
// `URL.createObjectURL`; PDFs render the first page via pdfjs; while either is
// resolving the neutral preview surface stays quiet. Self-contained (outline + surface + sizing) so
// it can be reused both inside the composer's preview row and to render
// already-sent attachments in a chat transcript.
interface FileThumbnailProps {
  file: File;
  /** Side length of the square thumbnail in pixels. */
  size: number;
  /** Explicit corner radius for a known nested inset. Defaults to the active
   *  shape's regular image/control radius. */
  radius?: number;
  className?: string;
  onPreviewReady?: (url: string | null) => void;
}

function FileThumbnail({ file, size, radius, className, onPreviewReady }: FileThumbnailProps) {
  const shape = useShape();
  const FileIcon = useIcon("square-library");
  const [imageError, setImageError] = useState(false);
  const isImage = file.type.startsWith("image/");
  const isPdf = file.type === "application/pdf";

  // Create blob URL inside an effect (NOT useMemo) so the cleanup-revoke
  // and the URL-creation stay in sync. In React 18 StrictMode dev, a
  // useMemo-created URL gets revoked by the simulated effect-cleanup but
  // useMemo doesn't re-run on the simulated re-mount (no re-render happens),
  // leaving the DOM with a stale, revoked `blob:` URL — broken image.
  // Putting both in the same effect means the simulated re-mount creates a
  // fresh URL and updates state. The one-frame "before URL" state is
  // covered by the bg-accent (no fallback icon shown for images), so the
  // transition is visually clean.
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    setImageError(false);
    if (!isImage) {
      // Clear stale state if the `file` prop swaps type on the same mount —
      // otherwise a revoked blob URL would keep winning over the new preview.
      setImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [isImage, file]);

  // PDFs need async rendering — loading flash is unavoidable for the first
  // ~100–300ms while pdfjs loads. Falls back to the generic icon on error
  // (corrupt/password-protected file, worker unavailable).
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState(false);
  useEffect(() => {
    setPdfError(false);
    setPdfUrl(null);
    if (!isPdf) {
      setPdfUrl(null);
      return;
    }
    let cancelled = false;
    renderPdfFirstPage(file, size)
      .then((url) => {
        if (!cancelled) setPdfUrl(url);
      })
      .catch(() => {
        if (!cancelled) setPdfError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [file, isPdf, size]);

  const previewUrl = imageError ? null : imageUrl ?? pdfUrl;
  useEffect(() => { onPreviewReady?.(previewUrl); }, [previewUrl, onPreviewReady]);
  // Keep the surface quiet while a preview is pending; anything that can't
  // produce one (failed PDF, unsupported type) gets the generic icon instead.
  const isPending = (isImage && !imageUrl && !imageError) || (isPdf && !pdfUrl && !pdfError);

  return (
    <div
      className={cn(
        // Paint the hairline over the preview: unlike a border, it costs no
        // space, and pure neutral ink stays clean over every surface tint.
        "relative shrink-0 overflow-hidden bg-accent outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10",
        shape.bg,
        className
      )}
      style={{
        width: size,
        height: size,
        // Keep className radius overrides working at the default. Inline
        // geometry is reserved for an explicit nested-radius calculation.
        ...(radius == null ? {} : { borderRadius: radius }),
      }}
    >
      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={previewUrl}
          alt={file.name}
          onError={() => setImageError(true)}
          className={cn("absolute inset-0 w-full h-full", isPdf ? "object-contain" : "object-cover")}
        />
      ) : isPending ? (
        <div className="absolute inset-0 bg-muted" aria-hidden="true" />
      ) : (
        // Generic document glyph for files with no renderable preview.
        <div
          className="absolute inset-0 flex items-center justify-center text-muted-foreground"
          role="img"
          aria-label={file.name}
        >
          <FileIcon size={Math.max(16, size * 0.35)} />
        </div>
      )}
    </div>
  );
}

export { FileThumbnail, loadPdfjs, renderPdfFirstPage };
export type { FileThumbnailProps };
