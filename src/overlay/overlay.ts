'use strict';

/**
 * Radial preview overlay — runs as the <webview> preload, i.e. inside the
 * running site. It makes text directly editable and images clickable, captures
 * DOM context for the edit engine, and reports edits back to the host renderer
 * via ipcRenderer.sendToHost(). No framework knowledge here.
 */

// Types for the overlay's state and shared helpers (this half of the file).
// The overlay is a classic script, so these are visible to the whole file. The
// payloads it exchanges with Radial's window live in src/shared/overlayMessages.ts,
// where the window can import them; the aliases below name them for this file.

/** The element being edited inline (a page element, OverlayStyledElement below): the draggable attribute it had is parked on it while editing. */
type InlineEditTarget = OverlayStyledElement & { __radialDraggable?: string | null };
/** The page's focused element: an HTML one says whether it is contenteditable; SVG and MathML ones leave it undefined. */
type FocusedPageElement = Element & { isContentEditable?: boolean };
/** A pointer position in viewport coordinates. */
interface PickPoint { x: number; y: number }

type StructuralPathLevel = import('../shared/overlayMessages').StructuralPathLevel;
type CapturedEditContext = import('../shared/overlayMessages').CapturedEditContext;

type StyleSourceReadout = import('../shared/overlayMessages').StyleSourceReadout;

type PageScanResult = import('../shared/overlayMessages').PageScanResult;
type SelectEnrichPayload = import('../shared/overlayMessages').SelectEnrichPayload;
type AdjustReadout = import('../shared/overlayMessages').AdjustReadout;

/** What captureSelection takes. enrich: false skips the follow-up provenance scan. */
interface CaptureSelectionOptions { enrich?: boolean }
type CapturedSelection = import('../shared/overlayMessages').CapturedSelection;
/** A capture still being built: captureSelection sets the timings last, on both of its returns. */
type CapturedSelectionDraft = Omit<CapturedSelection, 'captureMs' | 'capturedAt'> & Partial<Pick<CapturedSelection, 'captureMs' | 'capturedAt'>>;
type SelectParentRequest = import('../shared/overlayMessages').SelectParentRequest;

type HostNavigateRequest = import('../shared/overlayMessages').HostNavigateRequest;
/** An SPA navigation the overlay started, waiting for its route to commit. */
interface PendingSpaNavigation { id: string | undefined; route: string }
type RouteCommitSource = import('../shared/overlayMessages').RouteCommitSource;

/**
 * This preload's ipcRenderer, both message directions typed by channel
 * against src/shared/overlayMessages.ts: what sendToHost sends against
 * OverlayToHostPayloads, what each `on` listener gets against
 * HostToOverlayPayloads.
 */
interface OverlayIpcRenderer extends Omit<import('electron').IpcRenderer, 'sendToHost' | 'on'> {
  sendToHost<C extends keyof OverlayToHostPayloads>(channel: C, ...args: MessageArgs<OverlayToHostPayloads[C]>): void;
  on<C extends keyof HostToOverlayPayloads>(channel: C, listener: (event: OverlayHostEvent, ...args: MessageArgs<HostToOverlayPayloads[C]>) => void): this;
}
const { ipcRenderer } = require('electron') as Omit<typeof import('electron'), 'ipcRenderer'> & { ipcRenderer: OverlayIpcRenderer };

// This preload runs non-isolated (contextIsolation=no), which leaks Node/CommonJS
// globals into the page's `window`. Frameworks like Next.js/webpack feature-detect
// `module`/`require`/`process`/`global` and take a broken code path — the page
// renders, then blanks on hydration. We've captured what we need (ipcRenderer)
// above, so scrub them and leave the page a clean browser environment.
for (const g of ['require', 'module', 'exports', 'process', 'global', 'Buffer', '__dirname', '__filename']) {
  try { delete (window as unknown as Record<string, unknown>)[g]; } catch {}
}

let editMode = false;
let selectMode = false; // "select element for the agent" mode
let commentMode = false; // "drop a comment on an element" mode
let inspectMode = false; // "read an element's type/color/box styles" mode
let inspectPinned = false; // a click freezes the readout on one element
let inspectTarget: Element | null = null; // the element the readout is currently showing
let inspectPanel: HTMLDivElement | null = null; // the floating readout panel (data-radial-ui)
let inspectScale = 1; // the host's current preview scale (lock-fit/zoom) — the
// panel counter-scales by 1/this so it stays a constant on-screen size.
let editingEl: InlineEditTarget | null = null;
let originalText = '';
let editingContext: CapturedEditContext | null = null;
let editingNodeText: (string | null)[] | null = null; // per-text-node snapshot for mixed-content diffs
let editingHTML = ''; // pristine markup, so Escape can restore without flattening
let lastEditHover: Element | null = null; // container-level hover highlight (may differ from e.target)
let radialProgrammaticNavigation = false;
let radialPendingNavigation: PendingSpaNavigation | null = null;
let radialRouteReportFrame: number | null = null;

const STYLE_ID = 'radial-overlay-style';

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* Astro's dev toolbar slides out of the same bottom-center spot as Radial's
       own canvas UI and reads as a second, unexplained toolbar inside the app.
       Hide it in the embedded preview only — "Open in your browser" still has it. */
    html:not(.__radial-toolbars-on) astro-dev-toolbar,
    html:not(.__radial-toolbars-on) astro-dev-overlay { display: none !important; }
    /* Next.js pre-15 build/prerender indicators (plain DOM). The 15/16
       shadow-DOM dev-tools button is pierced in radialHideNextIndicator. */
    html:not(.__radial-toolbars-on) #__next-build-watcher,
    html:not(.__radial-toolbars-on) [data-nextjs-build-indicator] { display: none !important; }
    .radial-hover { outline: 2px solid #4f8cff !important; outline-offset: 0 !important; cursor: text !important; }
    /* Edit-time presence for empty containers (mode-gated by the html class —
       the served site never carries either class, so it renders nothing). */
    html.radial-reveal-empty .radial-empty-el { min-height: 48px !important; outline: 1px dashed rgba(79, 140, 255, 0.45) !important; outline-offset: -2px !important; }
    /* Select tool: pointer work, never text work — no text selection sweeping
       under a drag, and no native image/link drags hijacking the reorder. */
    html.radial-select-on, html.radial-select-on * { user-select: none !important; -webkit-user-select: none !important; }
    html.radial-select-on img, html.radial-select-on a { -webkit-user-drag: none !important; }
    .radial-img-hover { outline: 2px solid #a855f7 !important; outline-offset: 0 !important; cursor: pointer !important; }
    .radial-editing { outline: 2px solid #22c55e !important; outline-offset: 0 !important; }
    .radial-select-hover { cursor: crosshair !important; } /* outline drawn by the floating #__radial_select_hl box */
    /* Selected: a real frame, not a hairline — selection has to stay legible
       while the parent button re-targets it (offset separates it from the
       element's own borders; outline only, so site box-shadows are untouched). */
    .radial-selected { outline: 2px solid #f59e0b !important; outline-offset: 1px !important; }
    /* Layer-row hover: a thinner preview line so you can see WHICH element a
       layer is before committing to select it — distinct from the 2px select. */
    .radial-layer-hover { outline: 1px solid #f59e0b !important; outline-offset: 1px !important; }
    .radial-selected.radial-selected-inset { outline-offset: -3px !important; }
    /* Live select-hover highlight: one floating box that transitions its bounds, so
       the outline grows/shrinks snappily as the pointer moves between elements. */
    #__radial_select_hl { position: fixed; pointer-events: none; z-index: 2147483644;
      outline: 1.5px solid #f59e0b; outline-offset: 0; opacity: 0;
      transition: left .06s cubic-bezier(.22,1,.36,1), top .06s cubic-bezier(.22,1,.36,1),
        width .06s cubic-bezier(.22,1,.36,1), height .06s cubic-bezier(.22,1,.36,1), opacity .1s ease-out; }
    @media (prefers-reduced-motion: reduce) { #__radial_select_hl { transition: opacity .1s ease-out; } }
    /* Comment-mode hover reuses the Select tool's floating box (#__radial_select_hl),
       just tinted blue — the .radial-comment-hover class only sets the cursor. */
    .radial-comment-hover { cursor: crosshair !important; }
    #__radial_select_hl.comment { outline-color: #0088ff; }
    /* Inspect tool: teal hover box + a compact floating readout of the element's
       type/color/box styles. Self-contained styles (radial- prefixed, so the
       site's CSS can't target them) keep the panel legible on any page. */
    .radial-inspect-hover { cursor: crosshair !important; }
    #__radial_select_hl.inspect { outline-color: #2bd07a; }
    /* Live (following the cursor): click-through so it never blocks/inspects
       itself. Pinned: interactive, so you can click a value to copy it. */
    .radial-inspect-panel { position: fixed; z-index: 2147483646; display: none; pointer-events: none;
      background: oklch(0.17 0.008 48 / 0.97); color: #ebe8e2; border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px; padding: 9px 11px; min-width: 152px; max-width: 248px;
      font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; -webkit-font-smoothing: antialiased;
      box-shadow: 0 10px 30px rgba(0,0,0,0.55); user-select: none; }
    .radial-inspect-panel.pinned { border-color: rgba(43,208,122,0.5); pointer-events: auto; }
    .radial-inspect-panel .ri-head { display: flex; align-items: center; justify-content: space-between; gap: 8px;
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 11.5px; color: #fff;
      margin-bottom: 7px; overflow: hidden; }
    .radial-inspect-panel .ri-fam { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .radial-inspect-panel .ri-tag { flex-shrink: 0; color: #2bd07a; background: rgba(43,208,122,0.15);
      padding: 1px 5px; border-radius: 4px; font-size: 10px; }
    .radial-inspect-panel .ri-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; align-items: center; }
    .radial-inspect-panel .ri-k { color: rgba(255,255,255,0.56); }
    .radial-inspect-panel .ri-v { color: #ebe8e2; text-align: right; cursor: copy; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    .radial-inspect-panel .ri-v:hover { color: #2bd07a; }
    .radial-inspect-panel .ri-sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px;
      border: 1px solid rgba(255,255,255,0.3); margin-right: 5px; vertical-align: -1px; }
    .radial-inspect-panel .ri-div { height: 1px; background: rgba(255,255,255,0.1); margin: 8px 0; }
    .radial-inspect-panel .ri-foot { margin-top: 8px; color: rgba(255,255,255,0.4); font-size: 10px;
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
    /* Inspect measurements (Figma-style): pinned element ↔ hovered element. */
    #__radial_measure { position: fixed; inset: 0; pointer-events: none; z-index: 2147483645; display: none; }
    #__radial_measure .rm-line { position: absolute; background: #f24822; }
    #__radial_measure .rm-line.h { height: 1px; }
    #__radial_measure .rm-line.v { width: 1px; }
    #__radial_measure .rm-label { position: absolute; background: #f24822; color: #fff;
      font: 600 10px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      padding: 3px 5px; border-radius: 3px; white-space: nowrap; }
    #__radial_measure .rm-label.h { transform: translate(-50%, calc(-100% - 4px)); }
    #__radial_measure .rm-label.v { transform: translate(6px, -50%); }
    #__radial_measure .rm-hl { position: absolute; outline: 1px dashed #f24822; }
    .radial-review-flash { outline: 3px solid #0088ff !important; outline-offset: 0 !important; border-radius: 3px; animation: radial-review-pulse 1.2s ease-out 2; }
    @keyframes radial-review-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(0,136,255,0); } 30% { box-shadow: 0 0 0 6px rgba(0,136,255,0.35); } }
    #__radial_pin_layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
    /* Shiny medium-grey silver pin: glossy gradient + soft blurred glow. */
    .radial-comment-pin { position: fixed; width: 20px; height: 20px; border-radius: 50% 50% 50% 2px;
      background: linear-gradient(145deg, #f4f5f7 0%, #c4c8cf 45%, #888d98 100%);
      border: 1px solid rgba(255,255,255,0.55); cursor: grab; pointer-events: auto;
      box-shadow: 0 3px 11px rgba(0,0,0,0.45), 0 0 7px rgba(255,255,255,0.10), inset 0 1px 1px rgba(255,255,255,0.65), inset 0 -1px 2px rgba(0,0,0,0.18);
      transform: translate(-50%, -100%); transition: transform .1s; }
    .radial-comment-pin:hover { transform: translate(-50%, -100%) scale(1.15); }
    .radial-comment-pin.grabbing { cursor: grabbing; }
    .radial-comment-pin.dragging { transition: none; transform: translate(-50%, -100%) scale(1.1); box-shadow: 0 6px 16px rgba(0,0,0,0.5); z-index: 2147483647; }
    .radial-comment-pin.resolved { background: #2bd07a; opacity: 0.85; }
    /* A pin drops in (scale + fade) only on first appearance — see __pinsSeen. */
    .radial-comment-pin.radial-pin-in { animation: radial-pin-in 220ms cubic-bezier(0.165,0.84,0.44,1) both; }
    @keyframes radial-pin-in { from { opacity: 0; transform: translate(-50%, -100%) scale(0.5); } }
    @media (prefers-reduced-motion: reduce) { .radial-comment-pin.radial-pin-in { animation: none; } }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function isEditableText(el: Element): boolean {
  if (!el || el.nodeType !== 1) return false;
  if (el.children.length !== 0) return false; // leaf elements only — avoids mixed content
  const skip = ['SCRIPT', 'STYLE', 'IMG', 'INPUT', 'TEXTAREA', 'SELECT', 'BR', 'HR'];
  if (skip.includes(el.tagName)) return false;
  return el.textContent.trim().length > 0;
}

// Mixed content like <a>Learn more <span>→</span></a> fails the leaf check, so
// clicking the bare "Learn more" text used to be a dead click (the text belongs
// to the anchor, which has element children). If every child is inline
// formatting, editing the container is safe: finishEdit diffs per text node,
// so only the piece the user actually changed is sent to the edit engine.
const INLINE_TAGS = new Set(['A', 'SPAN', 'B', 'I', 'EM', 'STRONG', 'CODE', 'SMALL', 'SUP', 'SUB', 'U', 'S', 'MARK', 'ABBR', 'TIME', 'BR', 'WBR']);
function isInlineContainer(el: Element): boolean {
  if (!el || el.nodeType !== 1 || !el.children.length || el.children.length > 8) return false;
  if (!el.textContent.trim()) return false;
  return [...el.children].every((c) => INLINE_TAGS.has(c.tagName) && c.children.length <= 2);
}
/** The element a text-edit click should act on, or null if nothing editable. */
function editTargetFor(el: Element): InlineEditTarget | null {
  if (!el || el.nodeType !== 1) return null;
  if (el.closest && el.closest('[data-radial-ui]')) return null; // never our own UI
  if (isEditableText(el)) return el as InlineEditTarget; // page elements are HTML, SVG or MathML
  const a = el.closest && el.closest('a');
  if (a && (isEditableText(a) || isInlineContainer(a))) return a;
  return isInlineContainer(el) ? el as InlineEditTarget : null;
}

function textNodesOf(el: Node): Text[] {
  const out: Text[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) out.push(n as Text); // SHOW_TEXT: only text nodes
  return out;
}

function isImage(el: Element): boolean {
  return el && el.nodeType === 1 && el.tagName === 'IMG';
}

function occurrenceIndex(el: Element, text: string): number {
  const all = [...document.querySelectorAll('*')].filter(
    (e) => e.children.length === 0 && e.textContent.trim() === text
  );
  return all.indexOf(el);
}

function captureContext(el: Element, text: string): CapturedEditContext {
  const prev = el.previousElementSibling;
  const next = el.nextElementSibling;
  const nearbyText = [];
  if (prev && prev.textContent.trim()) nearbyText.push(prev.textContent.trim().slice(0, 40));
  if (next && next.textContent.trim()) nearbyText.push(next.textContent.trim().slice(0, 40));
  if (el.parentElement && el.parentElement.id) nearbyText.push(el.parentElement.id);
  return {
    tagName: el.tagName.toLowerCase(),
    classList: [...el.classList],
    id: el.id || null,
    occurrenceIndex: occurrenceIndex(el, text),
    nearbyText,
    // The DOM ancestor path: the source engine pins THIS element before any
    // text search, so the same copy on another page can never take the edit.
    path: buildStructuralPath(el),
  };
}

// A short, readable CSS selector path for the element (for the agent).
function cssPath(el: Element | null): string {
  // Escape ids/classes: Tailwind arbitrary values (`max-w-[860px]`,
  // `text-[#011225]`, `lg:flex-row`, `after:content-['']`) contain [](){}#:'
  // which are selector syntax — an unescaped `.max-w-[860px]` reads as an
  // attribute selector and makes querySelector THROW, silently killing every
  // optimistic DOM op (insert/move/wrap) and live adjust-preview on Tailwind sites.
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');
  if (el === document.body) return 'body'; // the Layers root row
  const parts = [];
  while (el && el.nodeType === 1 && el.tagName !== 'BODY' && el.tagName !== 'HTML' && parts.length < 6) {
    let sel = el.tagName.toLowerCase();
    if (el.id) { parts.unshift(sel + '#' + esc(el.id)); break; }
    const cls = [...el.classList].filter((c) => !c.startsWith('radial-')).slice(0, 2);
    if (cls.length) sel += '.' + cls.map(esc).join('.');
    const parent = el.parentElement;
    if (parent) {
      const sibs = [...parent.children].filter((c) => c.tagName === el!.tagName); // el: the loop's current element
      if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(el) + 1})`;
    }
    parts.unshift(sel);
    el = el.parentElement;
  }
  return parts.join(' > ');
}

/** A computed value's number, or `fallback` when it doesn't parse; unlike `parseFloat(v) || fallback`, 0 stays 0. */
function numOr(v: string, fallback: number): number { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; }

// Computed values the quick-edit pill's adjust steppers seed from. Raw px
// numbers (not display strings like readInspect) so the renderer can step them.
function readAdjust(el: Element): AdjustReadout {
  const cs = getComputedStyle(el);
  const px = (v: string) => Math.round((parseFloat(v) || 0) * 10) / 10;
  const bg = cs.backgroundColor;
  return {
    paddingTop: px(cs.paddingTop), paddingRight: px(cs.paddingRight),
    paddingBottom: px(cs.paddingBottom), paddingLeft: px(cs.paddingLeft),
    marginTop: px(cs.marginTop), marginRight: px(cs.marginRight),
    marginBottom: px(cs.marginBottom), marginLeft: px(cs.marginLeft),
    fontSize: px(cs.fontSize),
    fontWeight: parseInt(cs.fontWeight, 10) || 400,
    gap: px(cs.gap), // "normal" (no gap set) parses to 0
    radius: px(cs.borderTopLeftRadius), // representative corner; the stepper writes shorthand
    hasBg: !!bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)',
    hasBorder: (parseFloat(cs.borderTopWidth) || 0) > 0,
    textAlign: cs.textAlign,
    display: cs.display,
    flexDirection: cs.flexDirection,
    justifyContent: cs.justifyContent,
    alignItems: cs.alignItems,
    // Dense-palette extras. Line height as a ratio of font size (the value
    // people reason in); letter spacing in em for the same reason.
    lineHeight: (() => { const lh = parseFloat(cs.lineHeight); const fs = parseFloat(cs.fontSize) || 16; return lh ? Math.round((lh / fs) * 100) / 100 : 1.2; })(),
    letterSpacing: (() => { const ls = parseFloat(cs.letterSpacing); const fs = parseFloat(cs.fontSize) || 16; return ls ? Math.round((ls / fs) * 1000) / 1000 : 0; })(),
    textTransform: cs.textTransform,
    color: cs.color,
    bgColor: bg,
    opacity: Math.round(numOr(cs.opacity, 1) * 100), // 0 is a value (an invisible slide), not a missing one
    borderWidth: px(cs.borderTopWidth),
    // Shadow classified onto the ladder by blur radius — enough to step from.
    shadow: (() => { const sh = cs.boxShadow; if (!sh || sh === 'none') return 'none';
      const m = sh.match(/(-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px/); const blur = m ? parseFloat(m[3]) : 8;
      return blur <= 2 ? 'sm' : blur <= 7 ? 'md' : blur <= 16 ? 'lg' : blur <= 26 ? 'xl' : '2xl'; })(),
    maxWidth: (() => { const mw = parseFloat(cs.maxWidth); return Number.isFinite(mw) ? Math.round(mw) : 0; })(), // 0 = none
    // Design-panel extras: the web-native versions of an inspector's Position/
    // Size/Stroke/Effects story.
    position: cs.position,
    insetTop: cs.top === 'auto' ? null : px(cs.top),
    insetRight: cs.right === 'auto' ? null : px(cs.right),
    insetBottom: cs.bottom === 'auto' ? null : px(cs.bottom),
    insetLeft: cs.left === 'auto' ? null : px(cs.left),
    zIndex: cs.zIndex === 'auto' ? 0 : (parseInt(cs.zIndex, 10) || 0),
    rotate: (() => { const r = parseFloat(cs.rotate); return Number.isFinite(r) ? r : 0; })(),
    width: px(cs.width), height: px(cs.height),
    flexWrap: cs.flexWrap,
    borderStyle: cs.borderTopStyle,
    borderColor: cs.borderTopColor,
    boxShadowRaw: cs.boxShadow,
    overflow: cs.overflow.split(' ')[0],
    // Typography depth
    fontFamily: (cs.fontFamily || '').split(',')[0].trim().replace(/^['"]|['"]$/g, ''),
    fontStyle: cs.fontStyle,
    textDecoration: (cs.textDecorationLine || 'none').split(' ')[0],
    // Fill layers
    backgroundImage: cs.backgroundImage,
    backgroundSize: cs.backgroundSize,
    backgroundRepeat: cs.backgroundRepeat,
    // Per-corner / per-side
    radiusTL: px(cs.borderTopLeftRadius), radiusTR: px(cs.borderTopRightRadius),
    radiusBR: px(cs.borderBottomRightRadius), radiusBL: px(cs.borderBottomLeftRadius),
    bwTop: px(cs.borderTopWidth), bwRight: px(cs.borderRightWidth),
    bwBottom: px(cs.borderBottomWidth), bwLeft: px(cs.borderLeftWidth),
    // Size depth
    minWidth: (() => { const v = parseFloat(cs.minWidth); return Number.isFinite(v) ? Math.round(v) : 0; })(),
    minHeight: (() => { const v = parseFloat(cs.minHeight); return Number.isFinite(v) ? Math.round(v) : 0; })(),
    maxHeight: (() => { const v = parseFloat(cs.maxHeight); return Number.isFinite(v) ? Math.round(v) : 0; })(),
    aspectRatio: cs.aspectRatio === 'auto' ? '' : cs.aspectRatio,
    objectFit: cs.objectFit,
    // Flex child (relative to the parent)
    parentDisplay: el.parentElement ? getComputedStyle(el.parentElement).display : '',
    alignSelf: cs.alignSelf,
    flexGrow: parseFloat(cs.flexGrow) || 0,
    flexShrink: parseFloat(cs.flexShrink) || 0,
    flexBasis: cs.flexBasis,
    order: parseInt(cs.order, 10) || 0,
    // Transforms + filters
    translate: cs.translate === 'none' ? '' : cs.translate,
    scale: cs.scale === 'none' ? 1 : numOr(cs.scale, 1),
    filterRaw: cs.filter === 'none' ? '' : cs.filter,
    backdropRaw: (cs.backdropFilter && cs.backdropFilter !== 'none') ? cs.backdropFilter : '',
    blend: cs.mixBlendMode,
    fonts: pageFontFamilies(),
  };
}

// Distinct font families the page actually renders, most-used first.
let _pageFontsCache: string[] | null = null;
function pageFontFamilies(): string[] {
  if (_pageFontsCache) return _pageFontsCache;
  const counts = new Map<string, number>();
  const els = document.querySelectorAll('body *');
  let n = 0;
  for (const el of els) {
    if (++n > 400) break;
    if (el.closest('[data-radial-ui]')) continue;
    const fam = (getComputedStyle(el).fontFamily || '').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
    if (fam) counts.set(fam, (counts.get(fam) || 0) + 1);
  }
  _pageFontsCache = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f).slice(0, 8);
  return _pageFontsCache;
}

// The page's own colors, most-used first — the palette swatches offer these so
// edits stay on-brand (same philosophy as pageTypeScale for sizes). Transparent,
// near-white-on-white noise and one-off colors rank out naturally by count.
function pagePalette(): string[] {
  const counts = new Map<string, number>();
  const els = document.querySelectorAll('body *');
  let n = 0;
  for (const el of els) {
    if (++n > 800) break;
    if (el.closest && el.closest('[data-radial-ui]')) continue;
    const cs = getComputedStyle(el);
    for (const c of [cs.color, cs.backgroundColor]) {
      if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') continue;
      counts.set(c, (counts.get(c) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);
}

// Where each adjustable property COMES FROM — captured at select time, before
// the stepper preview writes inline styles and muddies the water. This is the
// provenance the direct-write planner (renderer/adjustDirect.js) needs to
// decide "can Radial write this itself, or does the agent own it?".
const ADJUST_SOURCE_PROPS = [
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'font-size', 'font-weight', 'gap', 'border-radius',
  'text-align', 'justify-content', 'align-items',
  'line-height', 'letter-spacing', 'text-transform', 'color', 'background-color',
  'opacity', 'border-width', 'box-shadow', 'max-width',
  // Design panel depth (increments 2-6): longhands resolve through CSSOM even
  // when the file authors the shorthand, which css-set's append-wins handles.
  'width', 'height', 'min-width', 'min-height', 'max-height', 'aspect-ratio', 'object-fit',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-style', 'border-color', 'overflow', 'z-index', 'position',
  'top', 'right', 'bottom', 'left', 'display', 'flex-direction', 'flex-wrap',
  'font-family', 'font-style', 'text-decoration-line',
  'background-image', 'background-size', 'background-repeat',
  'translate', 'scale', 'rotate', 'filter', 'backdrop-filter', 'mix-blend-mode',
  'flex-grow', 'flex-shrink', 'flex-basis', 'align-self', 'order',
];
function readStyleSource(el: Element): StyleSourceReadout {
  const out: StyleSourceReadout = { _full: true, styleAttr: el.getAttribute('style') || '', rules: [], tw: false,
    mediaRules: [], breakpoints: [], viewportW: window.innerWidth,
    // root font size so a px target can be written back in the author's rem
    rootPx: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16 };
  // Tailwind-ish page? The element or a few ancestors carry utility tokens.
  const utility = /^-?(p|m)(t|r|b|l|x|y)?-\d|^(gap-|rounded(-|$)|items-|justify-|text-(xs|sm|base|lg|\dxl)$|font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$|flex$|grid$)/;
  let a: Element | null = el, depth = 0;
  while (a && depth++ < 6 && !out.tw) {
    out.tw = [...(a.classList || [])].some((c) => utility.test(c));
    a = a.parentElement;
  }
  // Matching plain CSS rules that declare one of our props. Generated sheets
  // (bundled Tailwind output can be thousands of rules) are skipped — the
  // utility-class path covers those pages, and el.matches() per rule is O(n).
  for (const sheet of document.styleSheets) {
    let rules: OverlayCssRuleList;
    try { rules = sheet.cssRules; } catch { continue; } // cross-origin
    if (!rules || rules.length > 2000) continue;
    let href = null;
    try { href = sheet.href ? new URL(sheet.href).pathname : null; } catch {}
    for (const rule of rules) {
      // Media blocks: breakpoint provenance (which rule supplies the value AT
      // THIS WIDTH) + the site's own authored breakpoints. Kept SEPARATE from
      // out.rules so the base planner's semantics don't shift.
      if (rule.media && rule.cssRules) {
        const mt = rule.media.mediaText;
        const maxW = (mt.match(/max-width:\s*([\d.]+)px/) || [])[1];
        const minW = (mt.match(/min-width:\s*([\d.]+)px/) || [])[1];
        if (maxW) out.breakpoints.push(parseFloat(maxW));
        if (rule.cssRules.length > 400) continue;
        let active = false;
        try { active = matchMedia(mt).matches; } catch {}
        for (const r2 of rule.cssRules) {
          if (!r2.selectorText || !r2.style) continue;
          if (r2.selectorText.includes(':')) continue;
          let match2 = false;
          try { match2 = el.matches(r2.selectorText); } catch {}
          if (!match2) continue;
          for (const prop of ADJUST_SOURCE_PROPS) {
            const v = r2.style.getPropertyValue(prop);
            if (v) out.mediaRules.push({ prop, value: v.trim(), selectorText: r2.selectorText, href, media: mt, active,
              maxW: maxW ? parseFloat(maxW) : null, minW: minW ? parseFloat(minW) : null });
          }
        }
        continue;
      }
      if (!rule.selectorText || !rule.style) continue;
      if (rule.selectorText.includes(':')) continue; // pseudo/hover — not the resting value
      let match = false;
      try { match = el.matches(rule.selectorText); } catch {}
      if (!match) continue;
      for (const prop of ADJUST_SOURCE_PROPS) {
        const v = rule.style.getPropertyValue(prop);
        if (v) out.rules.push({ prop, value: v.trim(), selectorText: rule.selectorText, href });
      }
    }
    out.breakpoints = [...new Set(out.breakpoints)].sort((a, b) => a - b);
  }
  return out;
}

// The page's own type ladder: every distinct font-size actually rendered,
// sorted. The pill's size stepper snaps along this, so a nudge always lands on
// a size the site already uses — never a seventeenth slightly-different one.
function pageTypeScale(): number[] {
  const sizes = new Set<number>();
  const els = document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,a,li,button,blockquote,figcaption,dt,dd');
  let n = 0;
  for (const el of els) {
    if (++n > 600) break; // plenty for a scale; keeps a huge page cheap
    if (el.closest && el.closest('[data-radial-ui]')) continue;
    const s = parseFloat(getComputedStyle(el).fontSize);
    if (s > 4 && s < 300) sizes.add(Math.round(s * 10) / 10);
  }
  return [...sizes].sort((a, b) => a - b);
}

// Page-wide scans (palette, type scale) are per-LOAD facts: the preload's
// module state resets on navigation and dev-server reloads re-run it, so one
// lazy scan serves every selection on this page.
let _pageScans: PageScanResult | null = null;
function pageScans(): PageScanResult {
  if (!_pageScans) _pageScans = { typeScale: pageTypeScale(), palette: pagePalette() };
  return _pageScans;
}
// The heavy provenance (stylesheet walk + page scans) rides AFTER the fast
// payload: panels paint on the click's frame, enrichment lands on idle and
// merges host-side (radial:select-enrich). Direct writes only need it at the
// 900ms settle — the 250ms idle timeout gets there with room to spare.
function scheduleEnrich(el: Element, selector: string): void {
  const run = () => {
    try {
      const t0 = performance.now();
      const payload: SelectEnrichPayload = {
        selector,
        styleSource: readStyleSource(el),
        ...pageScans(),
        enrichMs: Math.round(performance.now() - t0),
      };
      ipcRenderer.sendToHost('radial:select-enrich', payload);
    } catch {}
  };
  if ((window as Partial<Window>).requestIdleCallback) requestIdleCallback(run, { timeout: 250 });
  else setTimeout(run, 30);
}
// The element's DOM ancestor path (element first, up to <body>) — per level:
// tag, id, distinctive classes, own direct text, its slot among same-tag
// siblings, and locating attributes. The source resolver anchors on the
// deepest level that's unique in source, then descends by these slots.
function buildStructuralPath(el: Element): StructuralPathLevel[] {
  const out: StructuralPathLevel[] = [];
  let n: Element | null = el, depth = 0;
  while (n && n.nodeType === 1 && n.tagName !== 'HTML' && depth < 16) {
    const parent: HTMLElement | null = n.parentElement;
    let nth = 0, cnt = 0;
    if (parent) {
      for (const c of parent.children) {
        if (c.tagName === n.tagName && !c.hasAttribute('data-radial-ui')) { if (c === n) nth = cnt; cnt++; }
      }
    } else cnt = 1;
    let own = '';
    for (const c of n.childNodes) if (c.nodeType === 3) own += c.textContent;
    // Siblings (incl. self) with this element's exact class set: >1 means the
    // DOM has identical copies — the resolver refuses to edit a single source
    // template on their behalf; 1 means this element is unique among them.
    const myCls = [...n.classList].filter((c) => !c.startsWith('radial-')).join(' ');
    let twins = 1;
    if (parent) for (const c of parent.children) { if (c !== n && c.tagName === n.tagName && !c.hasAttribute('data-radial-ui') && [...c.classList].filter((x) => !x.startsWith('radial-')).join(' ') === myCls) twins++; }
    out.push({
      tag: n.tagName.toLowerCase(),
      id: n.id || null,
      cls: [...n.classList].filter((c) => !c.startsWith('radial-')),
      own: own.replace(/\s+/g, ' ').trim().slice(0, 60),
      nth, cnt, twins,
      src: n.tagName === 'IMG' ? n.getAttribute('src') : null,
      href: n.tagName === 'A' ? n.getAttribute('href') : null,
      alt: (n.getAttribute && n.getAttribute('alt')) || null,
      ariaLabel: (n.getAttribute && n.getAttribute('aria-label')) || null,
      placeholder: (n.getAttribute && n.getAttribute('placeholder')) || null,
    });
    if (n.tagName === 'BODY') break; // body is the top structural anchor
    n = parent; depth++;
  }
  return out;
}
// Rich context about a clicked element, so the agent knows exactly what's meant.
function captureSelection(el: Element & { innerText?: string }, opts: CaptureSelectionOptions = {}): CapturedSelection {
  const _t0 = performance.now();
  let heading = '';
  let h: Element | null = el;
  while (h && !heading) {
    let s = h.previousElementSibling;
    while (s) { if (/^H[1-6]$/.test(s.tagName)) { heading = s.textContent.trim().slice(0, 80); break; } s = s.previousElementSibling; }
    h = h.parentElement;
  }
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  let html = (el.outerHTML || '').replace(/\s+class="[^"]*radial-[^"]*"/g, '');
  if (html.length > 600) html = html.slice(0, 600) + '…';
  const r = el.getBoundingClientRect();
  const out: CapturedSelectionDraft = {
    selector: cssPath(el),
    tagName: el.tagName.toLowerCase(),
    k: layerKind(el),
    id: el.id || null,
    classList: [...el.classList].filter((c) => !c.startsWith('radial-')),
    text: text.slice(0, 240),
    html,
    heading: heading || null,
    href: (el.closest && el.closest('a[href]')) ? el.closest('a[href]')!.getAttribute('href') : null,
    src: el.tagName === 'IMG' ? el.getAttribute('src') : null,
    alt: (el.getAttribute && el.getAttribute('alt')) || null,
    placeholder: (el.getAttribute && el.getAttribute('placeholder')) || null,
    ariaLabel: (el.getAttribute && el.getAttribute('aria-label')) || null,
    // Sibling-index locator inputs: the parent's own signature plus this
    // element's slot among same-tag siblings — the source engine's fallback
    // for elements with no needle of their own (a bare div, a plain img).
    parent: (() => {
      const p = el.parentElement;
      if (!p || /^(html|body)$/i.test(p.tagName)) return null;
      return { tagName: p.tagName.toLowerCase(), id: p.id || null,
        classList: [...p.classList].filter((c) => !c.startsWith('radial-')),
        text: (p.innerText || p.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) };
    })(),
    nthOfTag: (() => { let n = 0, s: Element | null = el; while ((s = s.previousElementSibling)) { if (s.tagName === el.tagName && !s.hasAttribute('data-radial-ui')) n++; } return n; })(),
    tagSiblings: (() => { let n = 0; const kids = el.parentElement ? el.parentElement.children : []; for (const s of kids) { if (s.tagName === el.tagName && !s.hasAttribute('data-radial-ui')) n++; } return n; })(),
    // The full DOM ancestor path (element at index 0, up to <body>), each level
    // carrying its own signature + slot among same-tag siblings. This is what
    // the source resolver walks to pin a repeated element by POSITION rather
    // than by text — the reliable way to tell one identical card from another.
    path: buildStructuralPath(el),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    url: location.href,
    adjust: readAdjust(el),
  };
  if (opts.enrich === false) {
    // Context-only captures (comments, context menus, deletes): no provenance
    // needed, no follow-up scan scheduled.
    out.captureMs = Math.round(performance.now() - _t0);
    out.capturedAt = Date.now();
    return out as CapturedSelection; // both timings set just above
  }
  out.pendingEnrich = true;
  out.captureMs = Math.round(performance.now() - _t0);
  out.capturedAt = Date.now();
  scheduleEnrich(el, out.selector);
  return out as CapturedSelection; // both timings set above
}

let editStartedAt = 0; // spurious host-focus churn right after a dblclick handoff must not kill the edit
function beginEdit(el: InlineEditTarget, x: number, y: number): void {
  if (editingEl) finishEdit();
  editStartedAt = Date.now();
  editingEl = el;
  originalText = el.textContent.trim();
  editingNodeText = textNodesOf(el).map((n) => n.nodeValue);
  editingHTML = el.innerHTML;
  // Capture context NOW, while the element still holds the original text — the
  // occurrence index is computed by matching original text, which won't match
  // once the user starts typing.
  editingContext = captureContext(el, originalText);
  el.setAttribute('contenteditable', 'true');
  // Links are draggable by default — a selection drag inside an editing <a>
  // would start a link-drag instead of selecting text. Suspend it.
  el.__radialDraggable = el.getAttribute('draggable');
  el.setAttribute('draggable', 'false');
  el.classList.add('radial-editing');
  el.focus();
  placeCaretAt(el, x, y);
  ipcRenderer.sendToHost('radial:editing', { active: true }); // host routes ⌘Z here while editing
}

// Put the caret where the user clicked, rather than selecting the whole element.
function placeCaretAt(el: Element, x: number, y: number): void {
  const sel = window.getSelection()!; // a document with a window always has a Selection in Chromium
  sel.removeAllRanges();
  let range = null;
  if (typeof x === 'number' && document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  }
  if (range && el.contains(range.startContainer)) {
    range.collapse(true);
    sel.addRange(range);
  } else {
    // Fallback: caret at the end of the text.
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    sel.addRange(r);
  }
}

function finishEdit(): void {
  if (!editingEl) return;
  const el = editingEl;
  // Null the guard FIRST: removing contenteditable fires a synchronous
  // focusout, and its handler calls finishEdit again — with the guard still
  // up, the commit ran twice and the duplicate (original text already gone)
  // fell through to a needless agent handoff.
  editingEl = null;
  const newText = el.textContent.trim();
  el.removeAttribute('contenteditable');
  if (el.__radialDraggable == null) el.removeAttribute('draggable'); else el.setAttribute('draggable', el.__radialDraggable);
  delete el.__radialDraggable;
  el.classList.remove('radial-editing');
  ipcRenderer.sendToHost('radial:editing', { active: false });
  if (newText && newText !== originalText) {
    // Mixed content: if exactly one text node changed, send just that piece.
    // The flattened textContent of <a>Learn more <span>→</span></a> ("Learn
    // more →") never exists in source, so the engine could only hand it to the
    // agent — but "Learn more" alone matches the source verbatim.
    let edit = null;
    const nodes = textNodesOf(el);
    if (editingNodeText && nodes.length === editingNodeText.length) {
      const changed = nodes.map((n, i) => (n.nodeValue !== editingNodeText![i] ? i : -1)).filter((i) => i >= 0);
      if (changed.length === 1) {
        const o = editingNodeText[changed[0]]!.trim(); // text nodes' values are never null
        const n = nodes[changed[0]].nodeValue!.trim();
        if (o && n && o !== n) edit = { originalText: o, newText: n };
      }
    }
    ipcRenderer.sendToHost('radial:edit', {
      ...(edit || { originalText, newText }),
      context: editingContext || captureContext(el, originalText),
    });
  }
  editingContext = null;
  editingNodeText = null;
  editingHTML = '';
}

// --- link editing: hover badge -------------------------------------------

let linkBadge: HTMLDivElement | null = null;
let badgeLink: Element | null = null;
// Typed as Node's timer (this project's types); at runtime the page's setTimeout returns a number.
let badgeHideTimer: ReturnType<typeof setTimeout> | null = null;

function ensureBadge(): HTMLDivElement {
  if (linkBadge) return linkBadge;
  linkBadge = document.createElement('div');
  linkBadge.textContent = '🔗 Edit link';
  linkBadge.setAttribute('data-radial-ui', '1');
  Object.assign(linkBadge.style, {
    position: 'absolute', zIndex: '2147483647', background: '#4f8cff', color: '#fff',
    font: '600 11px -apple-system, BlinkMacSystemFont, sans-serif', padding: '3px 7px',
    borderRadius: '6px', cursor: 'pointer', display: 'none', lineHeight: '1',
    boxShadow: '0 2px 8px rgba(0,0,0,.35)', userSelect: 'none',
  });
  linkBadge.addEventListener('mouseenter', () => clearTimeout(badgeHideTimer as ReturnType<typeof setTimeout> | undefined)); // null is a no-op; the timer types leave it out
  linkBadge.addEventListener('mouseleave', hideBadge);
  linkBadge.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!badgeLink) return;
    ipcRenderer.sendToHost('radial:edit-link', {
      href: badgeLink.getAttribute('href'),
      text: badgeLink.textContent.trim().slice(0, 80),
      context: {
        tagName: 'a',
        attribute: 'href',
        classList: [...badgeLink.classList],
        id: badgeLink.id || null,
      },
    });
  });
  document.body.appendChild(linkBadge);
  return linkBadge;
}

function showBadgeFor(link: Element): void {
  const badge = ensureBadge();
  badgeLink = link;
  const r = link.getBoundingClientRect();
  badge.style.top = (window.scrollY + r.top - 11) + 'px';
  badge.style.left = (window.scrollX + r.left) + 'px';
  badge.style.display = 'block';
  clearTimeout(badgeHideTimer as ReturnType<typeof setTimeout> | undefined);
}

function hideBadge(): void {
  badgeHideTimer = setTimeout(() => {
    if (linkBadge) linkBadge.style.display = 'none';
    badgeLink = null;
  }, 250);
}

// --- event wiring ---------------------------------------------------------

// Framework dev overlays (Next.js / Vite error dialog, build-error toast, dev
// tools) own their own controls — never intercept clicks/hover there, or their
// copy/docs/dismiss buttons stop working inside Radial's preview.
function inDevOverlay(el: Element | null): boolean {
  if (!el) return false;
  const t = el.tagName;
  if (t === 'NEXTJS-PORTAL' || t === 'VITE-ERROR-OVERLAY' || t === 'VITE-PLUGIN-CHECKER-ERROR-OVERLAY') return true;
  try { if (el.closest && el.closest('nextjs-portal, vite-error-overlay, [data-nextjs-dialog-overlay], [data-nextjs-toast], #__next-build-watcher, #nextjs__container_errors')) return true; } catch {}
  return false;
}

// Only html/body are the untouchable shell — clicking THEIR empty margins is
// click-out. A full-bleed wrapper (main, .page) is real, selectable content
// (the old size heuristic made outermost wrappers
// unreachable by click).
function isOuterShell(el: Element | null): boolean {
  if (!el || el.nodeType !== 1) return true;
  return el.tagName === 'HTML' || el.tagName === 'BODY';
}
// Full-bleed selections draw their outline INSIDE the element — at the page
// edge the normal outside outline falls off-viewport and reads as "nothing
// got selected".
function markSelected(el: Element): void {
  el.classList.add('radial-selected');
  try {
    const r = el.getBoundingClientRect();
    el.classList.toggle('radial-selected-inset', r.width >= window.innerWidth - 4);
  } catch {}
}

// Live select-hover highlight — one floating box that animates its bounds as the
// pointer moves between elements (grows/shrinks the outline). See #__radial_select_hl.
let __selHlVisible = false;
function showSelectHl(el: Element): void {
  injectStyles();
  let box = document.getElementById('__radial_select_hl');
  if (!box) { box = document.createElement('div'); box.id = '__radial_select_hl'; box.setAttribute('data-radial-ui', '1'); (document.body || document.documentElement).appendChild(box); }
  box.classList.toggle('comment', !!commentMode); // blue in comment mode, amber in select mode
  box.classList.toggle('inspect', !!inspectMode); // teal in inspect mode
  const r = el.getBoundingClientRect();
  if (!__selHlVisible) {
    // First appearance: snap to the target instead of sliding in from the corner.
    box.style.transition = 'none';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    void box.offsetWidth; // flush the snap before the stylesheet transition resumes
    box.style.transition = '';
    box.style.opacity = '1';
    __selHlVisible = true;
  } else {
    // Moving between elements: animate the outline to the new bounds.
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
  }
}
function hideSelectHl(): void {
  const box = document.getElementById('__radial_select_hl');
  if (box) box.style.opacity = '0';
  __selHlVisible = false;
}

// --- deep select (hold ⌘) — like Figma ---------------------------------------
// Normal hover/click targets e.target: the innermost HIT-TESTABLE element. But
// overlays (stretched links on cards, hero scrims, z-index layers) cover the
// content underneath, so the child you actually want can be unreachable. While
// ⌘ is held, we pick from the FULL hit-test stack under the cursor
// (elementsFromPoint sees covered elements too) and take the smallest one —
// "select exactly the child you want". The highlight box previews the pick.
let pickPoint: PickPoint | null = null;   // last pointer position — lets ⌘ keydown/keyup retarget in place
let pickHoverEl: Element | null = null; // the current synthetic hover target (mouseout won't clean it)

// Truly visible: display/visibility AND the ancestor opacity chain — opacity:0
// layers (inactive carousel scenes) are still hit-testable, so without this
// they'd win the pick while invisible.
function deepVisible(el: Element): boolean {
  try { return !el.checkVisibility || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch { return true; }
}

function deepTarget(x: number, y: number): Element | null {
  let best: Element | null = null, bestArea = Infinity;
  let stack: Element[] = [];
  try { stack = document.elementsFromPoint(x, y) || []; } catch {}
  for (const el of stack) {
    if (!el || el.nodeType !== 1 || isOuterShell(el)) continue;
    if (el.getAttribute('data-radial-ui') || (el.closest && el.closest('[data-radial-ui]'))) continue;
    if (inDevOverlay(el)) continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (!(area > 0 && area < bestArea)) continue;
    // Strict < keeps the topmost of equal-size elements (an image over its
    // exact-fit wrapper picks the image — the deeper paint, like Figma).
    if (!deepVisible(el)) continue;
    best = el; bestArea = area;
  }
  return best && descendAt(best, x, y);
}

// Hit-testing can't see pointer-events:none layers (common on animated demo
// cards — the whole text layer is unclickable by design) or inside open shadow
// roots — but the user can. From the hit-tested pick, descend geometrically:
// keep taking the smallest VISIBLE child whose box contains the point,
// regardless of hit-testability. Skips zero-opacity/hidden children so stacked
// carousel scenes don't leak their inactive frames into the pick.
function descendAt(el: Element, x: number, y: number): Element {
  for (let guard = 0; el && guard < 64; guard++) {
    let best: Element | null = null, bestArea = Infinity;
    const kids = el.shadowRoot ? [...el.shadowRoot.children, ...el.children] : [...el.children];
    for (const k of kids) {
      if (!k || k.nodeType !== 1) continue;
      if (k.getAttribute && k.getAttribute('data-radial-ui')) continue;
      const r = k.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const a = r.width * r.height;
      if (!a || a >= bestArea) continue;
      if (!deepVisible(k)) continue;
      best = k; bestArea = a;
    }
    if (!best) break;
    el = best;
  }
  return el;
}

function inPickMode(): boolean { return selectMode || commentMode || inspectMode; }

/** Move the hover UI (class + highlight + inspect readout) to `el`. */
function applyPickHover(el: Element | null): void {
  if (pickHoverEl && pickHoverEl !== el) {
    pickHoverEl.classList && pickHoverEl.classList.remove('radial-select-hover', 'radial-comment-hover', 'radial-inspect-hover');
  }
  pickHoverEl = el;
  if (!el || isOuterShell(el)) {
    hideSelectHl();
    if (inspectMode && !inspectPinned && inspectPanel) inspectPanel.style.display = 'none';
    return;
  }
  if (el.classList) {
    el.classList.add(selectMode ? 'radial-select-hover' : commentMode ? 'radial-comment-hover' : 'radial-inspect-hover');
  }
  showSelectHl(el);
  if (inspectMode && !inspectPinned) showInspect(el);
}

/** Re-resolve the hover target at the last pointer position (⌘ press/release/move). */
function retargetPick(meta: boolean): void {
  if (!pickPoint || !inPickMode() || (inspectMode && inspectPinned)) return;
  const el = meta
    ? deepTarget(pickPoint.x, pickPoint.y)
    : document.elementFromPoint(pickPoint.x, pickPoint.y);
  if (el && el.getAttribute && el.getAttribute('data-radial-ui')) return;
  if (el && inDevOverlay(el)) return;
  applyPickHover(el && !isOuterShell(el) ? el : null);
}

// The drilled target changes WITHIN one hovered element as the cursor moves, so
// deep-hover rides mousemove (mouseover only fires on element boundaries).
document.addEventListener('mousemove', (e) => {
  pickPoint = { x: e.clientX, y: e.clientY };
  if (e.metaKey && inPickMode()) retargetPick(true);
}, true);
// Pressing/releasing ⌘ retargets in place — no wiggle needed, same as Figma.
document.addEventListener('keydown', (e) => { if (e.key === 'Meta') retargetPick(true); }, true);
document.addEventListener('keyup', (e) => { if (e.key === 'Meta') retargetPick(false); }, true);

/** The element a pick-mode click should act on (⌘ drills through overlays). */
function pickClickTarget(e: MouseEvent): Element {
  return (e.metaKey && deepTarget(e.clientX, e.clientY)) || e.target as Element;
}

// --- inspect tool: read & show an element's type/color/box styles ----------

function escOv(s: string): string {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c as '&' | '<' | '>' | '"']));
}
// rgb()/rgba() → #RRGGBB (or #RRGGBBAA when translucent). Pass through anything
// we can't parse (named colors, gradients live elsewhere).
function rgbToHex(c: string): string {
  const m = String(c || '').match(/rgba?\(([^)]+)\)/);
  if (!m) return c || '';
  const p = m[1].split(',').map((s) => parseFloat(s.trim()));
  if (p.length < 3 || p.some((n) => Number.isNaN(n))) return c;
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  let out = '#' + h(p[0]) + h(p[1]) + h(p[2]);
  if (p[3] !== undefined && p[3] < 1) out += h(p[3] * 255);
  return out.toUpperCase();
}
// "16px 24px 16px 24px" → "16 24 16 24", collapsing equal sides like CSS shorthand.
function shortBox(t: string, r: string, b: string, l: string): string {
  const n = [t, r, b, l].map((v) => Math.round(parseFloat(v) || 0));
  if (n[0] === n[1] && n[1] === n[2] && n[2] === n[3]) return String(n[0]);
  if (n[0] === n[2] && n[1] === n[3]) return `${n[0]} ${n[1]}`;
  return n.join(' ');
}
function readInspect(el: Element) {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    family: (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim() || '—',
    size: cs.fontSize,
    lineHeight: cs.lineHeight === 'normal' ? 'normal' : cs.lineHeight,
    weight: cs.fontWeight,
    // Always a concrete value ("normal" read as the tool not showing tracking
    // at all). Nonzero tracking also gets its em equivalent — the unit you'd
    // actually write in CSS.
    letterSpacing: (() => {
      if (cs.letterSpacing === 'normal') return '0px';
      const px = parseFloat(cs.letterSpacing);
      const fsPx = parseFloat(cs.fontSize);
      if (!px || !fsPx) return cs.letterSpacing;
      const em = (px / fsPx).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
      return `${cs.letterSpacing} · ${em}em`;
    })(),
    color: cs.color,
    colorHex: rgbToHex(cs.color),
    padding: shortBox(cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft),
    margin: shortBox(cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}
function ensureInspectPanel(): HTMLDivElement {
  if (inspectPanel && inspectPanel.isConnected) return inspectPanel;
  inspectPanel = document.createElement('div');
  inspectPanel.className = 'radial-inspect-panel';
  inspectPanel.setAttribute('data-radial-ui', 'inspect');
  // Click a value to copy it (the panel is data-radial-ui, so the inspect click
  // handler lets these through instead of re-pinning).
  inspectPanel.addEventListener('click', (e) => {
    const v = (e.target as Element).closest && (e.target as Element).closest('.ri-v');
    if (!v) return;
    e.preventDefault(); e.stopPropagation();
    const text = v.getAttribute('data-copy') || v.textContent.trim();
    try { navigator.clipboard.writeText(text); } catch {}
    const prev = v.innerHTML; v.textContent = 'copied';
    setTimeout(() => { if (v.isConnected) v.innerHTML = prev; }, 700);
  }, true);
  (document.body || document.documentElement).appendChild(inspectPanel);
  return inspectPanel;
}
function inspectRow(k: string, v: string): string {
  return `<span class="ri-k">${k}</span><span class="ri-v" data-copy="${escOv(v)}">${escOv(v)}</span>`;
}
function positionInspectPanel(panel: HTMLElement, el: Element): void {
  // Counter-scale by the preview's scale so the panel renders at a constant size
  // on screen no matter how the locked aspect ratio scales the page. We anchor at
  // the panel's top-left and reason in that same (post-scale) space: a panel of
  // offsetWidth occupies offsetWidth*inv of the guest's CSS pixels once scaled.
  const inv = inspectScale > 0 ? 1 / inspectScale : 1;
  panel.style.transformOrigin = '0 0';
  panel.style.transform = inv !== 1 ? `scale(${inv})` : '';
  const r = el.getBoundingClientRect();
  const pw = panel.offsetWidth * inv, ph = panel.offsetHeight * inv, gap = 10 * inv;
  let left = r.right + gap;
  if (left + pw > window.innerWidth - 8) left = r.left - pw - gap; // flip to the left
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));   // clamp on-screen
  const top = Math.max(8, Math.min(r.top, window.innerHeight - ph - 8));
  panel.style.left = Math.round(left) + 'px';
  panel.style.top = Math.round(top) + 'px';
}
function showInspect(el: Element): void {
  injectStyles();
  inspectTarget = el;
  const d = readInspect(el);
  const panel = ensureInspectPanel();
  const sizeLine = d.lineHeight === 'normal' ? d.size : `${d.size} / ${d.lineHeight}`;
  panel.innerHTML =
    `<div class="ri-head"><span class="ri-fam">${escOv(d.family)}</span><span class="ri-tag">${escOv(d.tag)}</span></div>` +
    `<div class="ri-grid">` +
      inspectRow('size', sizeLine) +
      inspectRow('weight', d.weight) +
      inspectRow('letter', d.letterSpacing) +
      `<span class="ri-k">color</span><span class="ri-v" data-copy="${escOv(d.colorHex)}"><span class="ri-sw" style="background:${escOv(d.color)}"></span>${escOv(d.colorHex)}</span>` +
    `</div><div class="ri-div"></div><div class="ri-grid">` +
      inspectRow('pad', d.padding) +
      inspectRow('mar', d.margin) +
      inspectRow('size', `${d.width} × ${d.height}`) +
    `</div>` +
    (inspectPinned
      ? `<div class="ri-foot">hover to measure · ⌥ to clear the panel · esc to release</div>`
      : `<div class="ri-foot">click to pin · ⌘ to drill in · esc to release</div>`);
  panel.classList.toggle('pinned', inspectPinned);
  panel.style.display = 'block';
  positionInspectPanel(panel, el);
}
function hideInspect(): void {
  inspectPinned = false;
  inspectTarget = null;
  if (inspectPanel) inspectPanel.style.display = 'none';
  clearMeasure();
  hideSelectHl();
}

// --- inspect tool: Figma-style measurements ---------------------------------
// Pin one element (click), hover another: the px distance between the two
// boxes on each axis, drawn as red lines with labels. Boxes apart on an axis
// get the facing-edge gap; overlapping boxes get both edge-to-edge deltas —
// so a child hovered against its container reads as its insets, like Figma.
let measureBox: HTMLDivElement | null = null;
let measureHoverEl: Element | null = null; // scroll/resize re-measure against this element

function ensureMeasureBox(): HTMLDivElement {
  if (measureBox && measureBox.isConnected) return measureBox;
  measureBox = document.createElement('div');
  measureBox.id = '__radial_measure';
  measureBox.setAttribute('data-radial-ui', 'measure');
  (document.body || document.documentElement).appendChild(measureBox);
  return measureBox;
}

function clearMeasure(): void {
  measureHoverEl = null;
  if (measureBox) { measureBox.style.display = 'none'; measureBox.innerHTML = ''; }
}

// Holding Option while measuring hides the pinned readout — the panel often
// sits exactly where the numbers land, and while it's down the measurements
// ARE the readout. Released (or the window loses focus): panel comes back.
let optionHold = false;
function restoreInspectPanel(): void {
  optionHold = false;
  if (inspectMode && inspectPinned && inspectTarget && inspectPanel) {
    inspectPanel.style.display = 'block';
    positionInspectPanel(inspectPanel, inspectTarget);
  }
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Alt' || optionHold) return;
  optionHold = true;
  if (inspectMode && inspectPinned && inspectPanel) inspectPanel.style.display = 'none';
}, true);
document.addEventListener('keyup', (e) => { if (e.key === 'Alt' && optionHold) restoreInspectPanel(); }, true);
window.addEventListener('blur', () => { if (optionHold) restoreInspectPanel(); });

function showMeasure(a: Element, b: Element): void {
  injectStyles();
  measureHoverEl = b;
  const A = a.getBoundingClientRect(), B = b.getBoundingClientRect();
  const parts: string[] = [];
  const hLine = (x1: number, x2: number, y: number) => {
    if (Math.round(x2 - x1) <= 0) return;
    parts.push(`<span class="rm-line h" style="left:${x1}px; top:${y}px; width:${x2 - x1}px"></span>`
      + `<span class="rm-label h" style="left:${(x1 + x2) / 2}px; top:${y}px">${Math.round(x2 - x1)}</span>`);
  };
  const vLine = (y1: number, y2: number, x: number) => {
    if (Math.round(y2 - y1) <= 0) return;
    parts.push(`<span class="rm-line v" style="left:${x}px; top:${y1}px; height:${y2 - y1}px"></span>`
      + `<span class="rm-label v" style="left:${x}px; top:${(y1 + y2) / 2}px">${Math.round(y2 - y1)}</span>`);
  };
  // Anchor each axis's lines inside the boxes' shared range when they overlap
  // (that's where the eye compares them); fall back to the pinned box's middle.
  const ovX1 = Math.max(A.left, B.left), ovX2 = Math.min(A.right, B.right);
  const ovY1 = Math.max(A.top, B.top), ovY2 = Math.min(A.bottom, B.bottom);
  const midX = ovX2 > ovX1 ? (ovX1 + ovX2) / 2 : (A.left + A.right) / 2;
  const midY = ovY2 > ovY1 ? (ovY1 + ovY2) / 2 : (A.top + A.bottom) / 2;
  if (B.left >= A.right) hLine(A.right, B.left, midY);            // B fully right of A
  else if (A.left >= B.right) hLine(B.right, A.left, midY);       // B fully left of A
  else {                                                          // overlap: both edge deltas
    hLine(Math.min(A.left, B.left), Math.max(A.left, B.left), midY);
    hLine(Math.min(A.right, B.right), Math.max(A.right, B.right), midY);
  }
  if (B.top >= A.bottom) vLine(A.bottom, B.top, midX);            // B fully below A
  else if (A.top >= B.bottom) vLine(B.bottom, A.top, midX);       // B fully above A
  else {
    vLine(Math.min(A.top, B.top), Math.max(A.top, B.top), midX);
    vLine(Math.min(A.bottom, B.bottom), Math.max(A.bottom, B.bottom), midX);
  }
  // Show the hovered box too — the second half of "measuring between what?".
  parts.push(`<span class="rm-hl" style="left:${B.left}px; top:${B.top}px; width:${B.width}px; height:${B.height}px"></span>`);
  const box = ensureMeasureBox();
  box.innerHTML = parts.join('');
  box.style.display = 'block';
}

document.addEventListener('mouseover', (e) => {
  const el = e.target as Element;
  if (el.getAttribute && el.getAttribute('data-radial-ui')) return;
  if (inDevOverlay(el)) return; // leave the dev error overlay alone
  // ⌘ held in a pick mode → the deep-select path owns the hover target.
  if (e.metaKey && inPickMode()) { retargetPick(true); return; }
  if (selectMode) { if (!isOuterShell(el)) { el.classList && el.classList.add('radial-select-hover'); showSelectHl(el); } else hideSelectHl(); return; }
  if (commentMode) { if (!isOuterShell(el)) { el.classList && el.classList.add('radial-comment-hover'); showSelectHl(el); } else hideSelectHl(); return; }
  if (inspectMode) {
    if (inspectPinned) {
      // Readout stays frozen on the pinned element; hovering anything else
      // measures the gap between the two (Figma-style).
      if (inspectTarget && !isOuterShell(el) && el !== inspectTarget) showMeasure(inspectTarget, el);
      else clearMeasure();
      return;
    }
    if (!isOuterShell(el)) { el.classList && el.classList.add('radial-inspect-hover'); showSelectHl(el); showInspect(el); }
    else { hideSelectHl(); if (inspectPanel) inspectPanel.style.display = 'none'; }
    return;
  }
  if (!editMode) return;
  const editable = editTargetFor(el);
  if (editable) {
    // The hover highlight may sit on a container (mixed-content link) rather
    // than e.target, so mouseout's target-based cleanup misses it — track it.
    if (lastEditHover && lastEditHover !== editable) lastEditHover.classList.remove('radial-hover');
    editable.classList.add('radial-hover');
    lastEditHover = editable;
  } else if (isImage(el)) el.classList.add('radial-img-hover');
  const link = el.closest && el.closest('a[href]');
  if (link) showBadgeFor(link);
}, true);

document.addEventListener('mouseout', (e) => {
  (e.target as Element).classList && (e.target as Element).classList.remove('radial-hover', 'radial-img-hover', 'radial-select-hover', 'radial-comment-hover', 'radial-inspect-hover');
  if (lastEditHover && (!e.relatedTarget || !(lastEditHover.contains && lastEditHover.contains(e.relatedTarget as Node)))) {
    lastEditHover.classList.remove('radial-hover');
    lastEditHover = null;
  }
  if ((selectMode || commentMode) && (!e.relatedTarget || isOuterShell(e.relatedTarget as Element))) hideSelectHl();
  // Inspect (live, not pinned): leaving the page area hides the readout; moving
  // onto the panel itself (data-radial-ui) keeps it so you can click to copy.
  if (inspectMode && !inspectPinned) {
    const toUi = e.relatedTarget && (e.relatedTarget as Element).getAttribute && (e.relatedTarget as Element).getAttribute('data-radial-ui');
    if (!toUi && (!e.relatedTarget || isOuterShell(e.relatedTarget as Element))) { hideSelectHl(); if (inspectPanel) inspectPanel.style.display = 'none'; }
  }
  // Pinned + measuring: leaving the page (or landing on our own UI) ends the
  // measurement; the pinned readout itself stays.
  if (inspectMode && inspectPinned && (!e.relatedTarget || isOuterShell(e.relatedTarget as Element))) clearMeasure();
  const toLink = e.relatedTarget && (e.relatedTarget as Element).closest && (e.relatedTarget as Element).closest('a[href]');
  const toBadge = e.relatedTarget && (e.relatedTarget as Element).getAttribute && (e.relatedTarget as Element).getAttribute('data-radial-ui');
  if (!toLink && !toBadge) hideBadge();
}, true);

let lastSelected: Element | null = null;
// Walk-up trail for parent selection: each step up pushes the element we left,
// so ArrowDown retraces the exact path back down. A fresh click starts over.
let selParentStack: Element[] = [];

// Select the parent of the current selection — for when the card you want is
// buried under the headline/divs you keep hitting. One honest DOM step at a
// time (no wrapper-skipping heuristics: a same-size wrapper is often exactly
// the styled card, and each step is visible), stopping at the page shell.
function selectParentEl(additive: boolean): void {
  if (!lastSelected || !lastSelected.isConnected) return;
  let parent = lastSelected.parentElement;
  while (parent && parent.getAttribute && parent.getAttribute('data-radial-ui')) parent = parent.parentElement;
  if (!parent || isOuterShell(parent)) return;
  selParentStack.push(lastSelected);
  if (!additive) {
    [...document.querySelectorAll('.radial-selected')].forEach((x) => { if (x !== parent) x.classList.remove('radial-selected'); });
  }
  markSelected(parent);
  lastSelected = parent;
  ipcRenderer.sendToHost('radial:select-element', { ...captureSelection(parent), additive: !!additive });
}
// Retrace one step back down the trail (the child we came up from).
function selectBackDown(): void {
  let child = selParentStack.pop();
  if (!child || !child.isConnected) { selParentStack = []; return; }
  [...document.querySelectorAll('.radial-selected')].forEach((x) => { if (x !== child) x.classList.remove('radial-selected'); });
  markSelected(child);
  lastSelected = child;
  ipcRenderer.sendToHost('radial:select-element', { ...captureSelection(child), additive: false });
}
// ← / → walk to the previous / next sibling (Webflow's hierarchy grammar,
// completing ↑ parent / ↓ child). Skips our own injected UI nodes; the parent
// trail resets — a sideways move starts a fresh branch.
function selectSibling(dir: -1 | 1): void {
  if (!lastSelected || !lastSelected.isConnected) return;
  let sib = dir < 0 ? lastSelected.previousElementSibling : lastSelected.nextElementSibling;
  while (sib && sib.getAttribute && sib.getAttribute('data-radial-ui')) {
    sib = dir < 0 ? sib.previousElementSibling : sib.nextElementSibling;
  }
  if (!sib) return;
  selParentStack = [];
  [...document.querySelectorAll('.radial-selected')].forEach((x) => { if (x !== sib) x.classList.remove('radial-selected'); });
  markSelected(sib);
  lastSelected = sib;
  ipcRenderer.sendToHost('radial:select-element', { ...captureSelection(sib), additive: false });
}
// ↑ selects the parent, ↓ walks back down, ←/→ walk siblings — only in Select
// mode with a live selection, never while typing in the page or editing text.
document.addEventListener('keydown', (e) => {
  if (!selectMode || editingEl || !lastSelected) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const ae = document.activeElement as FocusedPageElement | null;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
  e.preventDefault();
  if (e.key === 'ArrowUp') selectParentEl(e.shiftKey);
  else if (e.key === 'ArrowDown') selectBackDown();
  else selectSibling(e.key === 'ArrowLeft' ? -1 : 1);
}, true);
// The pill's up-to-parent button lands here.
ipcRenderer.on('radial:select-parent', (_e, { additive }: SelectParentRequest = {}) => selectParentEl(!!additive));
// Delete/Backspace on a selected element removes it (optimistic hide here; the
// host asks the agent to remove it from source, which is undoable with ⌘Z).
document.addEventListener('keydown', (e) => {
  if (!selectMode || editingEl) return;
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const ae = document.activeElement as FocusedPageElement | null;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
  if (!lastSelected || !lastSelected.isConnected) return;
  e.preventDefault();
  const payload = captureSelection(lastSelected, { enrich: false });
  (lastSelected as OverlayStyledElement).style.display = 'none'; // instant feedback; source edit follows
  lastSelected = null;
  ipcRenderer.sendToHost('radial:delete-element', payload);
}, true);
// Text tool: editing starts on MOUSEDOWN, not click. By the time the browser
// runs the mousedown's default action the element is already contenteditable,
// so press-and-drag selects text in one motion — no click-first required.
// Waiting for the click meant beginEdit ran AFTER a drag finished, and
// placeCaretAt collapsed the selection the user just made ("it selects and
// then deselects right away").
document.addEventListener('mousedown', (e) => {
  if (!editMode || e.button !== 0 || radialProgrammaticNavigation) return;
  const el = e.target as Element;
  if (el.closest && el.closest('[data-radial-ui]')) return;
  if (inDevOverlay(el)) return;
  if (editingEl && (el === editingEl || (editingEl.contains && editingEl.contains(el)))) return; // caret/drag inside the live edit is the browser's business
  if (isImage(el)) return; // image swap stays a click action
  const target = editTargetFor(el);
  if (target) {
    target.classList.remove('radial-hover');
    beginEdit(target, e.clientX, e.clientY);
    // No preventDefault: the mousedown's default action re-places the caret at
    // this same point and anchors any drag selection that follows.
  }
}, true);

document.addEventListener('click', (e) => {
  // Navigation initiated by Radial's sidebar deliberately follows the site's
  // own router. Do not turn that synthetic click into a Select/Edit action.
  if (radialProgrammaticNavigation) return;
  // Inspect mode: a click pins the readout to that element (and never navigates).
  // Clicks on the panel itself (data-radial-ui) fall through to its copy handler.
  if (inspectMode) {
    if ((e.target as Element).closest && (e.target as Element).closest('[data-radial-ui]')) return; // panel clicks (copy) pass through
    if (inDevOverlay(e.target as Element)) return;
    const el = pickClickTarget(e); // ⌘ drills into nested/covered elements
    e.preventDefault(); e.stopPropagation();
    if (isOuterShell(el)) { hideInspect(); return; } // click the page margins → release
    el.classList && el.classList.remove('radial-inspect-hover');
    clearMeasure(); // re-pinning: stale lines measured against the old pin
    inspectPinned = true;
    showSelectHl(el);
    if (quickInspect) {
      // ⌥-click from Select: the click selects (Select resumes on it, the next
      // hover measures from it); the in-page readout stays out of the way while
      // ⌥ is down — the host's Inspect panel is the readout.
      [...document.querySelectorAll('.radial-selected')].forEach((x) => { if (x !== el) x.classList.remove('radial-selected'); });
      markSelected(el); lastSelected = el; selParentStack = [];
      inspectTarget = el;
      if (inspectPanel) inspectPanel.style.display = 'none';
    } else {
      showInspect(el); // re-render pinned (drops the hint, adds the pinned border)
    }
    ipcRenderer.sendToHost('radial:inspect-element', captureSelection(el)); // the host's Inspect panel shows it
    return;
  }
  // Combined Select mode: a single click captures the element as agent context;
  // a double-click edits text / swaps an image (handled in the dblclick listener).
  if (selectMode) {
    if ((e.target as Element).getAttribute && (e.target as Element).getAttribute('data-radial-ui')) return;
    if (inDevOverlay(e.target as Element)) return; // dev error overlay controls work normally
    if (editingEl && (e.target === editingEl || (editingEl.contains && editingEl.contains(e.target as Node)))) return; // let the caret work while editing
    const el = pickClickTarget(e); // ⌘ drills into nested/covered elements
    // Clicking the page's outer margins = click out: drop the selection, do nothing else.
    if (isOuterShell(el)) {
      [...document.querySelectorAll('.radial-selected')].forEach((x) => x.classList.remove('radial-selected'));
      lastSelected = null;
      ipcRenderer.sendToHost('radial:select-cancel'); // host dismisses the quick-edit pill
      return;
    }
    e.preventDefault(); e.stopPropagation();
    // Second click of a double-click: the dblclick handler owns it.
    if (e.detail > 1) return;
    const additive = e.shiftKey; // ⇧-click adds to the selection; plain click replaces it
    // INSTANT select (the 350ms double-click gate made every single
    // click feel laggy). Figma's model: click selects NOW; a double-click
    // converts the selection into a text edit — the dblclick handler clears
    // the outline and hands off, same as dblclicking an already-selected
    // element always did.
    if (!additive) {
      [...document.querySelectorAll('.radial-selected')].forEach((x) => { if (x !== el) x.classList.remove('radial-selected'); });
    }
    el.classList && el.classList.remove('radial-select-hover');
    markSelected(el);
    lastSelected = el; // target for the Delete key
    selParentStack = []; // a fresh click starts a new walk-up trail
    ipcRenderer.sendToHost('radial:select-element', { ...captureSelection(el), additive });
    return;
  }
  // Comment mode: capture the element to anchor a review comment.
  if (commentMode) {
    if ((e.target as Element).getAttribute && (e.target as Element).getAttribute('data-radial-ui')) return;
    const el = pickClickTarget(e); // ⌘ drills into nested/covered elements
    e.preventDefault(); e.stopPropagation();
    el.classList && el.classList.remove('radial-comment-hover');
    hideSelectHl();
    // Capture the exact click point WITHIN the element as a 0..1 fraction, so the
    // pin lands where you clicked (not the corner) and tracks the element across
    // breakpoints/reflows.
    const cr = el.getBoundingClientRect();
    const ox = cr.width ? Math.min(1, Math.max(0, (e.clientX - cr.left) / cr.width)) : 0.5;
    const oy = cr.height ? Math.min(1, Math.max(0, (e.clientY - cr.top) / cr.height)) : 0.5;
    ipcRenderer.sendToHost('radial:comment-target', Object.assign(captureSelection(el, { enrich: false }), { offsetX: ox, offsetY: oy }));
    return;
  }
  if (!editMode) return;
  const el = e.target as Element;

  // Radial's own UI (the "Edit link" badge) owns its clicks. This handler runs
  // in the capture phase, so without this bail-out it would stopPropagation and
  // start "editing" the badge div — the badge's listener never fired.
  if (el.closest && el.closest('[data-radial-ui]')) return;

  // Clicks INSIDE the element being edited are the browser's business: drag
  // selections (mouseup fires a click), double-click word selection, caret
  // placement. Re-running beginEdit here collapsed the selection the instant
  // the user made it — the "I can't highlight text" bug. (Links don't navigate
  // inside contenteditable, so no preventDefault needed.)
  if (editingEl && (el === editingEl || (editingEl.contains && editingEl.contains(el)))) return;

  // Don't navigate while editing.
  const link = el.closest && el.closest('a');
  if (link) { e.preventDefault(); e.stopPropagation(); }

  if (isImage(el)) {
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.sendToHost('radial:image-click', {
      src: el.getAttribute('src'),
      context: { tagName: 'img', classList: [...el.classList], id: el.id || null, alt: el.getAttribute('alt') || null },
    });
    return;
  }

  const target = editTargetFor(el);
  if (target) {
    e.preventDefault();
    e.stopPropagation();
    target.classList.remove('radial-hover');
    beginEdit(target, e.clientX, e.clientY);
  } else if (editingEl && el !== editingEl) {
    // A selection drag that drifts outside the element's box fires its click
    // on the common ancestor of mousedown/mouseup — if the selection still
    // lives inside the edit, that's the tail of the drag, not a click-out.
    const s = window.getSelection();
    const r = s && s.rangeCount ? s.getRangeAt(0) : null;
    if (r && !s!.isCollapsed && editingEl.contains(r.commonAncestorContainer)) return; // r is set only when s is
    finishEdit();
  }
}, true);

// --- host-directed SPA navigation ----------------------------------------
// The renderer owns the transaction id; this preload owns the site-facing
// portion. Clicking the real link lets any framework keep its client state.
function radialNormRoute(route: string): string {
  const path = String(route || '/').split(/[?#]/, 1)[0] || '/';
  return path === '/' ? '/' : path.replace(/\/+$/, '');
}
function radialScheduleRouteCommit(source: RouteCommitSource): void {
  if (radialRouteReportFrame) cancelAnimationFrame(radialRouteReportFrame);
  radialRouteReportFrame = requestAnimationFrame(() => requestAnimationFrame(() => {
    radialRouteReportFrame = null;
    const route = radialNormRoute(location.pathname);
    const pending = radialPendingNavigation;
    const id = pending && radialNormRoute(pending.route) === route ? pending.id : null;
    if (id) radialPendingNavigation = null;
    ipcRenderer.sendToHost('radial:route-commit', { id, url: location.href, source });
    // SPA history changed without another DOMContentLoaded. Give the framework
    // a short beat to update <title>/<head>, then refresh the host metadata.
    scheduleMetaReport();
  }));
}

for (const method of ['pushState', 'replaceState'] as const) {
  const original = history[method];
  if (typeof original !== 'function') continue;
  history[method] = function radialHistoryMethod(this: History, ...args: Parameters<History['pushState']>) {
    const result = original.apply(this, args);
    radialScheduleRouteCommit(method);
    return result;
  };
}
window.addEventListener('popstate', () => radialScheduleRouteCommit('popstate'));

ipcRenderer.on('radial:navigate', (_e, { id, route }: Partial<HostNavigateRequest> = {}) => {
  let target;
  try { target = new URL(route!, location.href); } catch { // route!: the host's request always carries one
    ipcRenderer.sendToHost('radial:navigate-result', { id, attempted: false });
    return;
  }
  if (target.origin !== location.origin) {
    ipcRenderer.sendToHost('radial:navigate-result', { id, attempted: false });
    return;
  }
  const wanted = radialNormRoute(target.pathname);
  const link = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].find((a) => {
    try {
      const href = new URL(a.href, location.href);
      return href.origin === location.origin && radialNormRoute(href.pathname) === wanted
        && !a.target && !a.hasAttribute('download');
    } catch { return false; }
  });
  if (!link) {
    ipcRenderer.sendToHost('radial:navigate-result', { id, attempted: false });
    return;
  }
  radialPendingNavigation = { id, route: wanted };
  try {
    radialProgrammaticNavigation = true;
    link.click();
    ipcRenderer.sendToHost('radial:navigate-result', { id, attempted: true });
  } catch {
    radialPendingNavigation = null;
    ipcRenderer.sendToHost('radial:navigate-result', { id, attempted: false });
  } finally {
    radialProgrammaticNavigation = false;
  }
});

// Double-click in Select mode → edit text inline or swap an image.
document.addEventListener('dblclick', (e) => {
  if (!selectMode) return;
  const el = e.target as Element;
  if (el.getAttribute && el.getAttribute('data-radial-ui')) return;
  if (inDevOverlay(el)) return;
  // Already editing this element? Let the browser's native double-click select
  // the word — don't re-enter edit (which would collapse the caret).
  if (editingEl && (el === editingEl || (editingEl.contains && editingEl.contains(el)))) return;
  if (isOuterShell(el)) return; // don't edit the page shell
  const link = el.closest && el.closest('a');
  if (link) { e.preventDefault(); e.stopPropagation(); }
  if (isImage(el)) {
    e.preventDefault(); e.stopPropagation();
    ipcRenderer.sendToHost('radial:image-click', {
      src: el.getAttribute('src'),
      context: { tagName: 'img', classList: [...el.classList], id: el.id || null, alt: el.getAttribute('alt') || null },
    });
    return;
  }
  const target = editTargetFor(el);
  if (target) {
    e.preventDefault(); e.stopPropagation();
    target.classList.remove('radial-select-hover', 'radial-selected');
    // Text editing lives in the Text tool now — a double-click in Select hands
    // off to it (switching modes locally first so there's no IPC round-trip
    // race) and starts editing right where you clicked.
    selectMode = false; editMode = true;
    hideSelectHl();
    [...document.querySelectorAll('.radial-select-hover, .radial-selected')].forEach((x) => x.classList.remove('radial-select-hover', 'radial-selected'));
    injectStyles();
    ipcRenderer.sendToHost('radial:select-cancel'); // dismiss the quick-edit pill
    ipcRenderer.sendToHost('radial:tool-key', 'text'); // sync the host toolbar
    beginEdit(target, e.clientX, e.clientY);
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (!editingEl) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEdit(); editingEl = null; }
  if (e.key === 'Escape') {
    const el = editingEl!; // set: the guard above returned otherwise, and Enter isn't Escape
    editingEl = null; // guard down first — removing contenteditable fires a synchronous focusout
    el.innerHTML = editingHTML; // restore markup too — textContent would flatten inline children
    el.removeAttribute('contenteditable');
    if (el.__radialDraggable == null) el.removeAttribute('draggable'); else el.setAttribute('draggable', el.__radialDraggable);
    delete el.__radialDraggable;
    el.classList.remove('radial-editing');
    editingNodeText = null;
    editingHTML = '';
    ipcRenderer.sendToHost('radial:editing', { active: false });
  }
}, true);

// While editing inline, the host forwards ⌘Z/⌘⇧Z here so the contenteditable's
// own undo stack handles it (instead of the file-level history).
ipcRenderer.on('radial:undo', () => { if (editingEl) { editingEl.focus(); document.execCommand('undo'); } });
ipcRenderer.on('radial:redo', () => { if (editingEl) { editingEl.focus(); document.execCommand('redo'); } });

// Finish when the EDITING element loses focus — not on any focus churn. With
// beginEdit running at mousedown, the previously focused element's focusout
// fires after editingEl is already the new element; a blanket finishEdit here
// would kill the new edit the instant it started.
document.addEventListener('focusout', (e) => {
  if (!editingEl || e.target !== editingEl) return;
  if (e.relatedTarget && editingEl.contains(e.relatedTarget as Node)) return; // focus moved within the edit
  // No related target = focus left the page entirely. Right after a dblclick
  // handoff that's the HOST's pill/panel chrome settling (its select-then-
  // convert traffic), not the user leaving — reclaim instead of finishing.
  if (!e.relatedTarget && Date.now() - editStartedAt < 400) {
    const el2 = editingEl;
    setTimeout(() => { if (editingEl === el2) { try { el2.focus(); } catch {} } }, 0);
    return;
  }
  finishEdit();
}, true);

// Escape: in comment mode, exit back to the default Select mode. In Select mode,
// just clear the current selection highlights (Select stays — it's the default).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || editingEl) return;
  if (commentMode) {
    commentMode = false;
    [...document.querySelectorAll('.radial-comment-hover')].forEach((el) => el.classList.remove('radial-comment-hover'));
    ipcRenderer.sendToHost('radial:select-cancel');
  } else if (inspectMode) {
    hideInspect(); // release the pinned readout (resumes live hover)
  } else if (selectMode) {
    [...document.querySelectorAll('.radial-selected')].forEach((el) => el.classList.remove('radial-selected'));
    lastSelected = null;
    ipcRenderer.sendToHost('radial:select-cancel'); // host dismisses the quick-edit pill
  }
}, true);

// --- quick inspect: hold ⌥ in Select to borrow the Inspect tool ------------
// Figma's ⌥. With something selected, hovering measures the gap between the
// selection and the hovered element; a click inspects the clicked element (it
// becomes the selection, and the host opens its Inspect panel). Release ⌥ and
// Select is back exactly as it was. While ⌥ is down the in-page readout stays
// hidden (the measurements are the readout) and nothing is pinned for good.
// The host mirrors the same hold for keystrokes that land in its own chrome;
// whichever side sees the release ends it, and tells the other.
let quickInspect = false;
function setQuickInspect(on: boolean, fromHost?: boolean): void {
  on = !!on;
  if (on === quickInspect) return;
  if (on && (!selectMode || editingEl || commentMode || inspectMode)) return; // Select only
  quickInspect = on;
  if (on) {
    inspectMode = true; selectMode = false; // the selection markers stay put
    const ref = lastSelected && lastSelected.isConnected && lastSelected.classList.contains('radial-selected') ? lastSelected : null;
    inspectTarget = ref; inspectPinned = !!ref; // measure from the selection
    if (inspectPanel) inspectPanel.style.display = 'none';
    if (pickHoverEl && pickHoverEl.classList) pickHoverEl.classList.remove('radial-select-hover');
    // Measure at once against whatever is under the cursor (no wiggle needed).
    if (pickPoint) {
      const el = document.elementFromPoint(pickPoint.x, pickPoint.y);
      if (el && !(el.getAttribute && el.getAttribute('data-radial-ui')) && !inDevOverlay(el) && !isOuterShell(el)) {
        if (ref) { if (el !== ref) showMeasure(ref, el); }
        else applyPickHover(el); // nothing selected: the Inspect hover (readout) as usual
      }
    }
  } else {
    clearMeasure();
    inspectPinned = false; inspectTarget = null;
    if (inspectPanel) inspectPanel.style.display = 'none';
    inspectMode = false; selectMode = true;
    [...document.querySelectorAll('.radial-inspect-hover')].forEach((x) => x.classList.remove('radial-inspect-hover'));
    hideSelectHl();
    retargetPick(false); // the Select hover comes back under the cursor
  }
  injectStyles();
  if (!fromHost) ipcRenderer.sendToHost('radial:quick-inspect', on);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Alt' && !e.repeat) setQuickInspect(true); }, true);
document.addEventListener('keyup', (e) => { if (e.key === 'Alt') setQuickInspect(false); }, true);
window.addEventListener('blur', () => setQuickInspect(false));
ipcRenderer.on('radial:quick-inspect', (_e, on: boolean) => setQuickInspect(on, true));

// Device hotkeys (1/2/3) and tool hotkeys (V/S/C) — forwarded to the host, since
// keystrokes over the live site land in this guest frame, not the host document.
// Never fire while typing into a field.
document.addEventListener('keydown', (e) => {
  if (editingEl || e.metaKey || e.ctrlKey || e.altKey) return;
  const ae = document.activeElement as FocusedPageElement | null;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
  if (e.shiftKey && (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit0')) { e.preventDefault(); ipcRenderer.sendToHost('radial:zoom-key', e.code); return; } // ⇧1 fit · ⇧2 zoom-to-selection · ⇧0 = ⌘0
  if (e.key === '?') { e.preventDefault(); ipcRenderer.sendToHost('radial:sheet-key'); return; } // ⇧/ — the shortcuts sheet
  // Space while ZOOMED arms the host's hand tool (its shield takes the drag);
  // unzoomed, space stays the page's own scroll key — browse is sacred.
  if (e.code === 'Space' && __radialZoomed) { e.preventDefault(); ipcRenderer.sendToHost('radial:space-key', true); return; }
  if (e.key === '1' || e.key === '2' || e.key === '3') { ipcRenderer.sendToHost('radial:device', e.key); return; }
  if (e.key.toLowerCase() === 'r' && e.shiftKey) { e.preventDefault(); ipcRenderer.sendToHost('radial:ruler-key'); return; }
  if (e.key.toLowerCase() === 'a') { e.preventDefault(); ipcRenderer.sendToHost('radial:add-key'); return; } // quick add
  const tool = ({ v: 'none', s: 'select', c: 'comment', i: 'inspect', d: 'draw', t: 'text', h: 'none' } satisfies Record<string, CanvasToolMode>)[e.key.toLowerCase()];
  if (tool) { e.preventDefault(); ipcRenderer.sendToHost('radial:tool-key', tool); }
}, true);
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') ipcRenderer.sendToHost('radial:space-key', false); // host end no-ops when the hand isn't armed
}, true);

// --- host -> overlay messages --------------------------------------------
// The payloads the host (Radial's window) sends on the ipcRenderer.on channels
// below, and the shapes the rest of this file keeps or reports.
type OverlayHostEvent = import('electron').IpcRendererEvent;
/** What each message this file sends the host carries, by channel (the window types its handlers against the same map). */
type OverlayToHostPayloads = import('../shared/overlayMessages').OverlayToHostPayloads;
/** What each message the host sends this file carries, by channel (the window types its sends against the same map). */
type HostToOverlayPayloads = import('../shared/overlayMessages').HostToOverlayPayloads;
/** What follows a channel in a send: nothing, or the one payload. */
type MessageArgs<P> = import('../shared/overlayMessages').MessageArgs<P>;
/** The canvas tools: radial:tool-key sends the one a tool key picks. */
type CanvasToolMode = import('../shared/overlayMessages').CanvasToolMode;
/**
 * A page element the code styles inline (.style), focuses, or reads .dataset
 * or .tabIndex off: an HTML, SVG or MathML element, each of which has them. A
 * selection can be any of these (a clicked icon is an SVGSVGElement or an
 * SVGPathElement), so where only Element's own members are used, the code
 * says Element.
 */
type OverlayStyledElement = HTMLElement | SVGElement | MathMLElement;
/**
 * Where a node lands relative to an anchor: the Add, Layers and canvas drags
 * (radialApi's InsertPosition, which its InsertSpec and MoveSpec take). It
 * can't be named InsertPosition here: lib.dom's global InsertPosition
 * ('beforebegin'…) owns that name.
 */
type OverlayDropPosition = import('../shared/radialApi').InsertPosition;
// The host's requests (HostToOverlayPayloads' entries), under their shared names.
type SelectorRequest = import('../shared/overlayMessages').SelectorRequest;
type SelectNodeRequest = import('../shared/overlayMessages').SelectNodeRequest;
type CopyNodeRequest = import('../shared/overlayMessages').CopyNodeRequest;
type AdjustPreviewRequest = import('../shared/overlayMessages').AdjustPreviewRequest;
type HighlightRequest = import('../shared/overlayMessages').HighlightRequest;
type ReviewComment = import('../shared/radialApi').ReviewComment;
/** How a comment finds its element: its selector, relaxed fallbacks (a synced Vercel comment), the selected text. */
type OverlayCommentAnchor = Partial<Pick<ReviewComment, 'selector' | 'alt' | 'selText'>>;
type CommentPin = import('../shared/overlayMessages').CommentPin;
type SetTextRequest = import('../shared/overlayMessages').SetTextRequest;
type ResolveStyleRequest = import('../shared/overlayMessages').ResolveStyleRequest;
type StyleAuditRequest = import('../shared/overlayMessages').StyleAuditRequest;
type ReadTreeRequest = import('../shared/overlayMessages').ReadTreeRequest;
type MoveNodeRequest = import('../shared/overlayMessages').MoveNodeRequest;
type InsertNodeRequest = import('../shared/overlayMessages').InsertNodeRequest;
type WrapNodeRequest = import('../shared/overlayMessages').WrapNodeRequest;
type UnwrapNodeRequest = import('../shared/overlayMessages').UnwrapNodeRequest;
type ReadTokensRequest = import('../shared/overlayMessages').ReadTokensRequest;
type ReadFieldsRequest = import('../shared/overlayMessages').ReadFieldsRequest;
type InsertHoverRequest = import('../shared/overlayMessages').InsertHoverRequest;
type CaptureNodeRequest = import('../shared/overlayMessages').CaptureNodeRequest;

/** A Content-field preview in progress: the element's markup and text before the first keystroke. */
interface OverlayLiveTextMarks { __radialOrigHTML?: string; __radialOrigText?: string }
/** A stylesheet rule as the walks (readStyleSource and the ones below) read it: @media and @supports blocks carry cssRules (and an @media block its media); a rule with a selector has declarations. */
type OverlayCssRule = { cssRules?: OverlayCssRuleList; media?: MediaList; parentStyleSheet: CSSStyleSheet | null }
  & ({ selectorText: string; style: CSSStyleDeclaration } | { selectorText?: undefined; style?: CSSStyleDeclaration });
type OverlayCssRuleList = ArrayLike<OverlayCssRule> & Iterable<OverlayCssRule>;
/** A style rule: a selector and its declarations. */
type OverlayCssStyleRule = Extract<OverlayCssRule, { selectorText: string }>;
// What this file reports back (the answers to the host's reads): their shapes
// are the window's too, so they live in src/shared/overlayMessages.ts.
/** radial:style-source: where one property's computed value comes from. */
type StyleOrigin = import('../shared/overlayMessages').StyleOrigin;
/** radial:style-audit-result: one value in use and how many elements use it. */
type StyleAuditColor = import('../shared/overlayMessages').StyleAuditColor;
type StyleAuditType = import('../shared/overlayMessages').StyleAuditType;
type StyleAuditDim = import('../shared/overlayMessages').StyleAuditDim;
type StyleAuditCount = import('../shared/overlayMessages').StyleAuditCount;
/** A color custom property on :root or html. */
type ColorToken = import('../shared/overlayMessages').ColorToken;
/** One Content-panel field (radial:fields-result). */
type ContentFieldReadout = import('../shared/overlayMessages').ContentFieldReadout;
/** What kind of layer an element is: the type icon in Layers and in the selection. */
type LayerKind = import('../shared/overlayMessages').LayerKind;
/** One row of the Layers tree (radial:tree-result), body first at depth 0. */
type LayerTreeNode = import('../shared/overlayMessages').LayerTreeNode;
/** One color the selection's subtree renders (radial:selcolors-result). */
type ColorCount = import('../shared/overlayMessages').ColorCount;
/** A button style shared by a cluster of the page's buttons (radial:variants-scan). */
type ButtonSignature = import('../shared/overlayMessages').ButtonSignature;
/** One button style as radial:variants-result sends it: keyed by its signature's JSON, with the classes every instance shares. */
type VariantCluster = import('../shared/overlayMessages').VariantCluster;
/** The variants scan's own accumulator, one per signature: the class lists of every button that has it, and one button's selector. */
type OverlayButtonCluster = Omit<VariantCluster, 'key' | 'core'> & { classSets: string[][] };
/** The axis a container lays its children out along: a row, a column, or wrapping/grid. */
type OverlayCvAxis = 'x' | 'y' | '2d';
/** The slot under the pointer in a canvas drag: into an empty container, or beside a rendered neighbor. */
type OverlayCvSlot =
  | { c: Element; ref: null; pos: 'inside'; axis: OverlayCvAxis; boundary: null; twoD?: undefined }
  | { c: Element; ref: Element; pos: 'before' | 'after'; axis: 'x' | 'y'; boundary: number | null; twoD: boolean };
/** A press in Select mode that may become a canvas drag (the drag dims the element through its inline style). */
interface OverlayCvPress { el: OverlayStyledElement; x: number; y: number }
/** A canvas drag in flight: the lifted element, where it came from, and the slot it sits in now. */
interface OverlayCvDrag {
  el: OverlayStyledElement;
  prevOpacity: string;
  prevPE: string;
  /** null when the page detached the element between the press and the drag (a re-render). */
  origParent: ParentNode | null;
  origNext: ChildNode | null;
  container: Element | null;
  ref: Element | null;
  pos: OverlayDropPosition | null;
  axis: OverlayCvAxis | null;
  /** The current slot ('orig', 'in:<id>' or '<pos>:<id>'): an unchanged key skips re-placing. */
  key: string;
  orderHinted?: boolean;
}
/** A canvas drag that moved (cvEnd's answer): it has its slot. */
type OverlayCvFinishedDrag = OverlayCvDrag & { pos: OverlayDropPosition };
/** window.__cvTrace (set by hand while debugging the canvas drag): every slot decision and placement. */
type OverlayCvTraceEntry =
  | { x: number; y: number; c: string; ref: string | null; pos: OverlayDropPosition; axis: OverlayCvAxis; boundary: number | null; key: string; cur: string }
  | { placed: OverlayDropPosition; ref: string | null; order: string };
interface Window {
  __radialTreeObs?: MutationObserver;
  __cvTrace?: OverlayCvTraceEntry[];
}

// Empty containers get edit-time presence (Webflow's empty-div space): while
// a build mode is on, a truly empty container shows a min-height and a dashed
// hint so it can be clicked, dropped into, and dragged. The REAL site never
// sees any of this — overlay-only styling, gone the moment the mode is off.
let emptyObs: MutationObserver | null = null;
function markEmpties() {
  [...document.querySelectorAll('div, section, main, article, aside, header, footer, nav, ul, ol, li, figure, form')].forEach((el) => {
    if (el.closest && el.closest('[data-radial-ui]')) return;
    const empty = !el.children.length && !(el.textContent || '').trim();
    el.classList.toggle('radial-empty-el', empty);
  });
}
function setEmptyReveal(on: boolean) {
  document.documentElement.classList.toggle('radial-reveal-empty', !!on);
  if (on) {
    markEmpties();
    if (!emptyObs && window.MutationObserver) {
      emptyObs = new MutationObserver(() => markEmpties());
      emptyObs.observe(document.body, { childList: true, subtree: true });
    }
  } else if (emptyObs) {
    emptyObs.disconnect(); emptyObs = null;
    [...document.querySelectorAll('.radial-empty-el')].forEach((el) => el.classList.remove('radial-empty-el'));
  }
}

// Per-mode page chrome, in one place: empty-container reveal for the build
// modes, and the select tool's no-text-selection guard.
let radialRevealEmpty = false; // Settings → Preview → Reveal empty containers (off by default)
function syncModeChrome() {
  setEmptyReveal(radialRevealEmpty && (editMode || selectMode));
  document.documentElement.classList.toggle('radial-select-on', selectMode);
}
ipcRenderer.on('radial:reveal-empty', (_e: OverlayHostEvent, on: boolean) => { radialRevealEmpty = !!on; syncModeChrome(); });
// A native drag (image ghost, link drag) mid-reorder swallows our mousemove
// stream and strands the drop — the select tool owns the pointer.
document.addEventListener('dragstart', (e) => { if (selectMode) e.preventDefault(); }, true);

ipcRenderer.on('radial:set-edit-mode', (_e: OverlayHostEvent, value: boolean) => {
  quickInspect = false; // a real mode change ends an ⌥ hold
  editMode = !!value;
  if (editMode) { selectMode = false; commentMode = false; inspectMode = false; hideInspect(); }
  if (!editMode && editingEl) finishEdit();
  if (!editMode && linkBadge) { linkBadge.style.display = 'none'; badgeLink = null; }
  injectStyles();
  syncModeChrome();
  ipcRenderer.sendToHost('radial:ready', { editMode });
});

ipcRenderer.on('radial:set-select-mode', (_e: OverlayHostEvent, value: boolean) => {
  quickInspect = false; // a real mode change ends an ⌥ hold
  selectMode = !!value;
  if (selectMode) { editMode = false; commentMode = false; inspectMode = false; hideInspect(); }
  if (!selectMode) {
    hideSelectHl();
    [...document.querySelectorAll('.radial-select-hover, .radial-selected')].forEach((el) => el.classList.remove('radial-select-hover', 'radial-selected'));
  }
  injectStyles();
  syncModeChrome();
});

ipcRenderer.on('radial:set-comment-mode', (_e: OverlayHostEvent, value: boolean) => {
  quickInspect = false; // a real mode change ends an ⌥ hold
  commentMode = !!value;
  if (commentMode) { editMode = false; selectMode = false; inspectMode = false; hideInspect(); }
  if (!commentMode) {
    [...document.querySelectorAll('.radial-comment-hover')].forEach((el) => el.classList.remove('radial-comment-hover'));
  }
  syncModeChrome();
  injectStyles();
});

ipcRenderer.on('radial:set-inspect-mode', (_e: OverlayHostEvent, value: boolean) => {
  quickInspect = false; // a real mode change ends an ⌥ hold
  inspectMode = !!value;
  if (inspectMode) { editMode = false; selectMode = false; commentMode = false; }
  if (!inspectMode) {
    hideInspect();
    [...document.querySelectorAll('.radial-inspect-hover')].forEach((el) => el.classList.remove('radial-inspect-hover'));
  }
  syncModeChrome();
  injectStyles();
});

// The host's current preview scale (locked-aspect fit / device down-scale). The
// inspect panel uses it to stay a constant on-screen size instead of riding the
// page scale. Re-applies live if a readout is already showing.
ipcRenderer.on('radial:set-preview-scale', (_e: OverlayHostEvent, value: number) => {
  const s = (typeof value === 'number' && value > 0) ? value : 1;
  if (s === inspectScale) return;
  inspectScale = s;
  if (inspectMode && inspectTarget && inspectPanel && inspectPanel.style.display === 'block') {
    positionInspectPanel(inspectPanel, inspectTarget);
  }
});

// Pause/resume every kind of motion in the previewed page so you can point at
// elements mid-animation. Freezes CSS keyframe animations, Web Animations API
// timelines, requestAnimationFrame loops (canvas/WebGL/GSAP) and media — and on
// resume restores exactly the ones we paused (never auto-starts the site's own
// paused/finished animations).
let __radialPaused = false;
let __radialPausedAnims: Animation[] = [];
let __radialPausedMedia: HTMLMediaElement[] = [];
let __radialPausedSvgs: SVGSVGElement[] = [];
let __radialPauseSweep: ReturnType<typeof setInterval> | null = null;
const RADIAL_PAUSE_STYLE_ID = 'radial-pause-style';

// The rAF hold and the element.animate() intercept MUST run in the page's own
// JS world (a preload-context patch of window.requestAnimationFrame is
// invisible to the site when the preload is isolated) — so they're injected as
// a real <script> and driven by DOM events, which cross worlds.
function __radialEnsurePageHooks() {
  if (document.getElementById('radial-pause-hooks')) return;
  const sc = document.createElement('script');
  sc.id = 'radial-pause-hooks';
  sc.textContent = '(' + function () {
    let on = false, realRaf: ((cb: FrameRequestCallback) => number) | null = null, rafQ: FrameRequestCallback[] = [], pausedByUs: Animation[] = [], heldTimeouts: (() => void)[] = [];
    // Animations created WHILE frozen start paused (scroll/hover triggers,
    // timers re-creating element.animate() — a periodic sweep alone lets each
    // one run for a beat before it's caught).
    const realAnimate = Element.prototype.animate;
    if (realAnimate) {
      Element.prototype.animate = function () {
        const a = realAnimate.apply(this, arguments as unknown as Parameters<typeof realAnimate>); // the wrapper's own arguments, passed through
        if (on) { try { a.pause(); pausedByUs.push(a); } catch (e) {} }
        return a;
      };
    }
    // Timer-driven sequences (load-in storyboards, carousels, ticking clocks):
    // wrap the CALLBACKS at document-start, so every timer the site ever sets
    // goes through us. While frozen, timeouts that come due are held and run
    // on resume (in firing order); interval ticks are simply skipped.
    const realST = window.setTimeout, realSI = window.setInterval;
    // (The casts: the wrappers stand in for the page's timers, and pass their own arguments through.)
    // (cb: a string of code, or any function of the page's, called with whatever arguments it was given.)
    window.setTimeout = function (cb: string | ((...args: unknown[]) => unknown), delay?: number) {
      if (typeof cb !== 'function') return realST.apply(window, arguments as unknown as Parameters<typeof realST>);
      const args: unknown[] = Array.prototype.slice.call(arguments, 2);
      return realST(function () {
        if (on) { heldTimeouts.push(() => cb.apply(window, args)); return; }
        cb.apply(window, args);
      }, delay);
    } as typeof window.setTimeout;
    window.setInterval = function (cb: string | ((...args: unknown[]) => unknown), delay?: number) {
      if (typeof cb !== 'function') return realSI.apply(window, arguments as unknown as Parameters<typeof realSI>);
      const args: unknown[] = Array.prototype.slice.call(arguments, 2);
      return realSI(function () { if (!on) cb.apply(window, args); }, delay);
    } as typeof window.setInterval;
    document.addEventListener('__radial-pause-on', () => {
      if (on) return; on = true;
      // Hold rAF callbacks instead of running them; the site's loops won't
      // reschedule (their callback never fires), so the queue stays bounded.
      realRaf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = function (cb) { rafQ.push(cb); return 0; };
    });
    document.addEventListener('__radial-pause-off', () => {
      if (!on) return; on = false;
      if (realRaf) {
        const r = realRaf; realRaf = null;
        window.requestAnimationFrame = r;
        const q = rafQ; rafQ = [];
        q.forEach((cb) => { try { r(cb); } catch (e) {} });
      }
      const held = heldTimeouts; heldTimeouts = [];
      held.forEach((fn) => { try { fn(); } catch (e) {} });
      pausedByUs.forEach((a) => { try { a.play(); } catch (e) {} }); pausedByUs = [];
    });
  } + ')()';
  (document.head || document.documentElement).appendChild(sc);
  sc.textContent = ''; // executed; the emptied node stays as the injected-once marker
}
// Inject at document-start so timers the site sets during load are already
// wrapped when the user hits pause. At preload time the document may not have
// an <html> element yet — watch for it and inject the moment it lands, which
// is still before any site <script> executes.
try { __radialEnsurePageHooks(); } catch {}
if (!document.getElementById('radial-pause-hooks')) {
  const __radialHookObs = new MutationObserver(() => {
    if (!document.documentElement) return;
    try { __radialEnsurePageHooks(); } catch {}
    if (document.getElementById('radial-pause-hooks')) __radialHookObs.disconnect();
  });
  __radialHookObs.observe(document, { childList: true, subtree: true });
}

// One sweep = pause everything currently moving that we haven't caught yet.
// Runs at pause time and on a low-frequency interval while paused, so motion
// that STARTS after the freeze (scroll/hover triggers, element.animate() from
// timers, late-mounting components, SMIL svgs) gets frozen too.
function __radialPauseSweepTick() {
  try {
    (document.getAnimations ? document.getAnimations() : []).forEach((a) => {
      if (a.playState === 'running') { try { a.pause(); __radialPausedAnims.push(a); } catch {} }
    });
  } catch {}
  try {
    [...document.querySelectorAll('svg')].forEach((sv) => {
      if (sv.pauseAnimations && sv.animationsPaused && !sv.animationsPaused()) {
        try { sv.pauseAnimations(); __radialPausedSvgs.push(sv); } catch {}
      }
    });
  } catch {}
}
// Media that starts playing while frozen (autoplay-on-scroll videos) gets
// paused immediately and resumed with the rest.
function __radialOnMediaPlay(e: Event) {
  const m = e.target as HTMLMediaElement | null;
  if (!__radialPaused || !m || (m.tagName !== 'VIDEO' && m.tagName !== 'AUDIO')) return;
  try { m.pause(); if (!__radialPausedMedia.includes(m)) __radialPausedMedia.push(m); } catch {}
}

function radialSetAnimationsPaused(on: boolean) {
  on = !!on;
  if (on === __radialPaused) return;
  __radialPaused = on;
  if (on) {
    // In-flight animations/transitions freeze mid-state FIRST (the WAAPI pause
    // survives the stylesheet below), then the stylesheet stops future motion:
    // animation-play-state for keyframes, zero-duration for transitions (hover
    // and other interaction motion — play-state doesn't apply to transitions),
    // and no smooth-scroll drift.
    try {
      __radialPausedAnims = (document.getAnimations ? document.getAnimations() : []).filter((a) => a.playState === 'running');
      __radialPausedAnims.forEach((a) => { try { a.pause(); } catch {} });
    } catch { __radialPausedAnims = []; }
    if (!document.getElementById(RADIAL_PAUSE_STYLE_ID)) {
      const st = document.createElement('style');
      st.id = RADIAL_PAUSE_STYLE_ID;
      st.textContent = '*, *::before, *::after { animation-play-state: paused !important; -webkit-animation-play-state: paused !important;'
        + ' transition-duration: 0s !important; transition-delay: 0s !important; scroll-behavior: auto !important; }';
      (document.head || document.documentElement).appendChild(st);
    }
    __radialEnsurePageHooks();
    document.dispatchEvent(new Event('__radial-pause-on'));
    try {
      __radialPausedMedia = [...document.querySelectorAll<HTMLMediaElement>('video, audio')].filter((m) => !m.paused);
      __radialPausedMedia.forEach((m) => { try { m.pause(); } catch {} });
    } catch { __radialPausedMedia = []; }
    document.addEventListener('play', __radialOnMediaPlay, true);
    __radialPauseSweepTick();
    __radialPauseSweep = setInterval(__radialPauseSweepTick, 400);
  } else {
    clearInterval(__radialPauseSweep as ReturnType<typeof setInterval> | undefined); __radialPauseSweep = null; // null is a no-op; the timer types leave it out
    document.removeEventListener('play', __radialOnMediaPlay, true);
    const st = document.getElementById(RADIAL_PAUSE_STYLE_ID); if (st) st.remove();
    document.dispatchEvent(new Event('__radial-pause-off'));
    __radialPausedAnims.forEach((a) => { try { a.play(); } catch {} }); __radialPausedAnims = [];
    __radialPausedSvgs.forEach((sv) => { try { sv.unpauseAnimations(); } catch {} }); __radialPausedSvgs = [];
    __radialPausedMedia.forEach((m) => { try { const p = m.play(); if (p && p.catch) p.catch(() => {}); } catch {} }); __radialPausedMedia = [];
  }
}

ipcRenderer.on('radial:set-animations-paused', (_e: OverlayHostEvent, value: boolean) => { radialSetAnimationsPaused(value); });

// Host → drop the selection outline (quick-edit pill submitted or dismissed).
ipcRenderer.on('radial:clear-selected', () => {
  // A dropped selection never leaves a keystroke preview behind.
  if (liveTextEl && liveTextEl.__radialOrigHTML != null) {
    try { liveTextEl.innerHTML = liveTextEl.__radialOrigHTML; } catch {}
    delete liveTextEl.__radialOrigHTML; delete liveTextEl.__radialOrigText;
  }
  liveTextEl = null;
  [...document.querySelectorAll('.radial-selected')].forEach((el) => el.classList.remove('radial-selected'));
  lastSelected = null;
  selParentStack = [];
});

// --- adjust steppers: optimistic style preview ------------------------------
// The pill's steppers change styles HERE, instantly, as inline !important
// styles — a fitting room. Nothing touches source until the pill hands the
// batch to the agent; dismissing the pill restores the element exactly. After
// an apply the styles are kept (no flash back to the old look) and the dev
// server's reload of the agent's real edit replaces them.
const __adjustOrig = new Map<OverlayStyledElement, Record<string, string>>(); // el → { prop: prior inline value ('' = none) }
function adjustTargetFor(selector: string | undefined): OverlayStyledElement | null {
  if (lastSelected && lastSelected.isConnected) return lastSelected as OverlayStyledElement; // a selection is a rendered element: HTML, SVG or MathML
  try { return selector ? document.querySelector<OverlayStyledElement>(selector) : null; } catch { return null; }
}
ipcRenderer.on('radial:adjust-preview', (_e: OverlayHostEvent, { selector, styles }: Partial<AdjustPreviewRequest> = {}) => {
  const el = adjustTargetFor(selector);
  if (!el || !styles) return;
  let orig = __adjustOrig.get(el);
  if (!orig) { orig = {}; __adjustOrig.set(el, orig); }
  for (const [prop, value] of Object.entries(styles)) {
    if (!(prop in orig)) orig[prop] = el.style.getPropertyValue(prop) || '';
    el.style.setProperty(prop, value, 'important'); // outruns utility classes
  }
});
ipcRenderer.on('radial:adjust-revert', () => {
  for (const [el, orig] of __adjustOrig) {
    if (!el.isConnected) continue;
    for (const [prop, prev] of Object.entries(orig)) {
      if (prev) el.style.setProperty(prop, prev); else el.style.removeProperty(prop);
    }
  }
  __adjustOrig.clear();
});
// Applied: keep the preview styles, drop the revert state.
ipcRenderer.on('radial:adjust-forget', () => { __adjustOrig.clear(); });

// Scroll to + flash a commented element (used by the comment review flow).
ipcRenderer.on('radial:highlight', (_e: OverlayHostEvent, { selector, alt, text }: Partial<HighlightRequest> = {}) => {
  if (!selector && !(alt && alt.length) && !text) return;
  const el = resolveCommentEl({ selector, alt, selText: text });
  if (!el) return;
  injectStyles();
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('radial-review-flash');
  setTimeout(() => el.classList.remove('radial-review-flash'), 2600);
});

// Comment pins — Figma-style markers on the page at each commented element.
let __pins: CommentPin[] = [];
let __draggingPin = false; // suppress re-render (which would reset the dragged pin) mid-drag
const __pinsSeen = new Set<string>(); // pin ids already animated — so the pop fires once, not on every scroll re-render
function pinLayer(): HTMLElement {
  let l = document.getElementById('__radial_pin_layer');
  if (!l) { l = document.createElement('div'); l.id = '__radial_pin_layer'; l.setAttribute('data-radial-ui', 'pin-layer'); (document.body || document.documentElement).appendChild(l); }
  return l;
}
// A pin: click opens its comment; drag re-anchors it to whatever element it's
// dropped on. Marked data-radial-ui so the Select/Edit/Comment tools ignore it
// (otherwise Select would swallow the click and you couldn't open the comment).
function attachPinDrag(pin: HTMLElement, c: CommentPin) {
  pin.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    __draggingPin = true;
    pin.classList.add('grabbing');
    const onMove = (ev: MouseEvent) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      dragging = true;
      pin.classList.add('dragging');
      pin.style.left = ev.clientX + 'px';
      pin.style.top = ev.clientY + 'px';
    };
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      pin.classList.remove('grabbing', 'dragging');
      __draggingPin = false;
      if (!dragging) { const pr = pin.getBoundingClientRect(); ipcRenderer.sendToHost('radial:comment-pin-click', { id: c.id, rect: { x: pr.left, y: pr.top, w: pr.width, h: pr.height } }); return; } // a click → open the card next to the pin
      // A drag → RE-ANCHOR the comment to the element under the drop point (so its
      // context/selector/highlight follow), plus remember the exact drop offset
      // from that element's anchor so the pin lands precisely where you let go.
      const layer = document.getElementById('__radial_pin_layer');
      if (layer) layer.style.display = 'none'; // don't hit-test the pins themselves
      let target = document.elementFromPoint(ev.clientX, ev.clientY);
      if (layer) layer.style.display = '';
      while (target && target.getAttribute && target.getAttribute('data-radial-ui')) target = target.parentElement;
      if (target && !isOuterShell(target)) {
        // Re-anchor to the drop element and remember WHERE on it (0..1 fraction),
        // so the pin stays put responsively — not a fixed pixel offset.
        const r = target.getBoundingClientRect();
        const fx = r.width ? Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) : 0.5;
        const fy = r.height ? Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)) : 0.5;
        ipcRenderer.sendToHost('radial:comment-move', {
          id: c.id, target: captureSelection(target, { enrich: false }), offsetX: fx, offsetY: fy,
        });
      } else {
        renderCommentPins(); // dropped on nothing useful → snap back
      }
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  }, true);
}
// Where a comment's element is on THIS page. The stored selector first; then
// its fallbacks (a synced Vercel comment carries the selector without
// nth-of-type counts and the tag.classes descriptor of the element, because a
// dev DOM drifts from the deployed one by a wrapper); then the selected text.
function resolveCommentEl(c: OverlayCommentAnchor): Element | null {
  const q = (sel: string | undefined) => { try { return sel ? document.querySelector(sel) : null; } catch { return null; } };
  let el = q(c.selector);
  if (el) return el;
  const needle = String(c.selText || '').replace(/\s+/g, ' ').trim();
  for (const a of (Array.isArray(c.alt) ? c.alt : [])) {
    let all: Element[] = []; try { all = [...document.querySelectorAll(a)]; } catch { all = []; }
    if (!all.length) continue;
    // A relaxed selector can match siblings; the one holding the selected text wins.
    const withText = needle.length >= 3 ? all.find((n) => (n.textContent || '').replace(/\s+/g, ' ').includes(needle)) : null;
    return withText || all[0];
  }
  return findByText(needle);
}
function findByText(text: string): Element | null {
  const needle = String(text || '').replace(/\s+/g, ' ').trim();
  if (needle.length < 3) return null;
  let best = null, bestLen = Infinity;
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('[data-radial-ui]') || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
    const t = (el.textContent || '').replace(/\s+/g, ' ');
    if (t.length >= bestLen || !t.includes(needle)) continue;
    best = el; bestLen = t.length;
  }
  return best;
}
function renderCommentPins() {
  const layer = pinLayer();
  layer.innerHTML = '';
  for (const c of __pins) {
    const el = resolveCommentEl(c);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const pin = document.createElement('div');
    const fresh = c.id && !__pinsSeen.has(c.id); // first time we've shown this pin
    if (c.id) __pinsSeen.add(c.id);
    pin.className = 'radial-comment-pin' + (c.resolved ? ' resolved' : '') + (fresh ? ' radial-pin-in' : '');
    pin.setAttribute('data-radial-ui', 'comment-pin');
    // Fractional offset → place where the reviewer clicked, scaling with the
    // element. Legacy pins (pixel dx/dy from the corner) keep their old anchor.
    const fx = (typeof c.offsetX === 'number') ? c.offsetX : null;
    const fy = (typeof c.offsetY === 'number') ? c.offsetY : null;
    pin.style.left = (fx != null ? r.left + fx * r.width : Math.min(r.right, window.innerWidth - 4) + (c.dx || 0)) + 'px';
    pin.style.top = (fy != null ? r.top + fy * r.height : Math.max(r.top + 2, 14) + (c.dy || 0)) + 'px';
    pin.title = c.text || 'Comment';
    attachPinDrag(pin, c);
    layer.appendChild(pin);
  }
}
ipcRenderer.on('radial:comment-pins', (_e: OverlayHostEvent, pins: CommentPin[]) => { __pins = Array.isArray(pins) ? pins : []; injectStyles(); renderCommentPins(); });
function followInspect() {
  if (!inspectMode || !inspectPinned || !inspectTarget) return;
  if (!inspectTarget.isConnected) { hideInspect(); return; }
  showSelectHl(inspectTarget); // re-reads the rect, animates the box to follow
  if (inspectPanel) positionInspectPanel(inspectPanel, inspectTarget);
  // Measurements are drawn in viewport coords — scroll moves both boxes, so
  // re-measure against the same hovered element (or drop it if it's gone).
  if (measureHoverEl) {
    if (measureHoverEl.isConnected) showMeasure(inspectTarget, measureHoverEl);
    else clearMeasure();
  }
}
window.addEventListener('scroll', () => { if (__pins.length && !__draggingPin) renderCommentPins(); followInspect(); }, true);
window.addEventListener('resize', () => { if (__pins.length && !__draggingPin) renderCommentPins(); followInspect(); });

// Trackpad gestures over the preview:
//  • pinch (delivered as ctrl+wheel) → drive Radial's own visual zoom;
//  • when zoomed in, a plain two-finger swipe pans the magnified canvas instead
//    of scrolling the page. At 100% we leave the wheel alone so the site scrolls
//    normally. The host tells us whether we're zoomed via radial:set-zoomed.
let __radialZoomed = false;
// Pinch detection is PASSIVE. A non-passive wheel listener forces Chromium to
// wait on the main thread before EVERY scroll tick — the single biggest
// "doesn't scroll like a real browser" tax — and Electron gives ctrl+wheel no
// default action anyway (it only emits zoom-changed), so there is nothing to
// preventDefault at 100%.
window.addEventListener('wheel', (e) => {
  if (e.ctrlKey) ipcRenderer.sendToHost('radial:pinch-zoom', { deltaY: e.deltaY, x: e.clientX, y: e.clientY });
}, { passive: true, capture: true });
// Pan-instead-of-scroll only exists while zoomed, so the scroll-blocking
// listener is attached only then; plain 100% browsing keeps threaded scrolling.
function onZoomedWheel(e: WheelEvent) {
  e.preventDefault();
  if (!e.ctrlKey) ipcRenderer.sendToHost('radial:pan', { dx: e.deltaX, dy: e.deltaY }); // pinches were already forwarded above
}
// Panel-driven text edit (the Type panel's Content field): apply the new text
// live, then emit the SAME radial:edit the inline Text tool emits — the host's
// source matching, already-applied handling and agent fallback all apply.
let liveTextEl: (Element & OverlayLiveTextMarks) | null = null; // element carrying an uncommitted keystroke preview
ipcRenderer.on('radial:set-text', (_e: OverlayHostEvent, p: SetTextRequest) => {
  __selfWriteAt = performance.now(); // our own write: never animation churn
  try {
    const el = document.querySelector<Element & OverlayLiveTextMarks>(p && p.selector);
    if (!el) return;
    // Cancel: put back exactly what was there before the first live keystroke.
    if (p && p.restore) {
      if (el.__radialOrigHTML != null) { el.innerHTML = el.__radialOrigHTML; delete el.__radialOrigHTML; delete el.__radialOrigText; }
      if (liveTextEl === el) liveTextEl = null;
      return;
    }
    // Live: every keystroke lands in the page. First one stashes the original
    // (markup flattens while typing; restore/commit puts structure back).
    if (p && p.live) {
      if (el.__radialOrigHTML == null) { el.__radialOrigHTML = el.innerHTML; el.__radialOrigText = (el.textContent || '').trim(); }
      el.textContent = p.text;
      liveTextEl = el;
      return;
    }
    // Commit: restore structure, then emit the SAME radial:edit as inline
    // editing — source matching / already-applied / agent fallback all apply.
    const originalText = el.__radialOrigText != null ? el.__radialOrigText : (el.textContent || '').trim();
    if (el.__radialOrigHTML != null) { el.innerHTML = el.__radialOrigHTML; delete el.__radialOrigHTML; delete el.__radialOrigText; }
    if (liveTextEl === el) liveTextEl = null;
    const newText = String((p && p.text) || '').trim();
    if (!newText || newText === originalText) return;
    const context = captureContext(el, originalText);
    if (!el.children || el.children.length === 0) el.textContent = p.text; // plain text keeps showing the new words while the write lands
    ipcRenderer.sendToHost('radial:edit', { originalText, newText, context });
  } catch {}
});
// Scope resolution: where does this element's computed value COME FROM —
// inline, a shared rule, or a CSS variable? Drives the Color panel's scope
// control ("just this" vs "everyone with this style" vs the variable itself).
function radialSpecificity(sel: string): number {
  const ids = (sel.match(/#/g) || []).length;
  const cls = (sel.match(/[.\[:]/g) || []).length;
  const tags = (sel.match(/(^|[\s>+~])[a-z]/gi) || []).length;
  return ids * 100 + cls * 10 + tags;
}
ipcRenderer.on('radial:resolve-style', (_e: OverlayHostEvent, p: ResolveStyleRequest) => {
  try {
    const el = document.querySelector<OverlayStyledElement>(p && p.selector);
    if (!el) return;
    const sources: Record<string, StyleOrigin> = {};
    (p.props || []).forEach((prop) => {
      try {
        if (prop === '*anchor') {
          // The element's best rule regardless of property — the hook a new
          // declaration (e.g. a fresh :hover block) hangs off.
          let bestA = null as OverlayCssStyleRule | null, bestASpec = -1; // set inside walkA
          const walkA = (rules: OverlayCssRuleList) => {
            for (const r of rules) {
              if (r.cssRules && r.cssRules.length) { walkA(r.cssRules); continue; }
              if (!r.selectorText || !r.style || !r.style.length) continue;
              if (!r.parentStyleSheet || !r.parentStyleSheet.href) continue; // must be a writable source file
              if (r.selectorText.includes('radial-')) continue; // never Radial's own overlay chrome
              let m2 = false;
              try { m2 = el.matches(r.selectorText); } catch {}
              if (!m2) continue;
              const spec2 = radialSpecificity(r.selectorText);
              if (spec2 >= bestASpec) { bestASpec = spec2; bestA = r; }
            }
          };
          for (const sheet of document.styleSheets) {
            let rules; try { rules = sheet.cssRules; } catch { continue; }
            if (rules) walkA(rules);
          }
          sources['*anchor'] = bestA
            ? { kind: 'rule', selectorText: bestA.selectorText, href: (() => { try { return bestA!.parentStyleSheet && bestA!.parentStyleSheet.href ? new URL(bestA!.parentStyleSheet.href).pathname : null; } catch { return null; } })() }
            : { kind: 'unknown' };
          return;
        }
        if (el.style && el.style.getPropertyValue(prop)) { sources[prop] = { kind: 'inline' }; return; }
        let best = null as { selectorText: string; value: string; sheet: CSSStyleSheet | null } | null, bestSpec = -1; // set inside walk
        const walk = (rules: OverlayCssRuleList) => {
          for (const r of rules) {
            if (r.cssRules && r.cssRules.length) { walk(r.cssRules); continue; }
            if (!r.selectorText || !r.style) continue;
            const v = r.style.getPropertyValue(prop);
            if (!v) continue;
            let m = false;
            try { m = el.matches(r.selectorText); } catch {}
            if (!m) continue;
            const spec = radialSpecificity(r.selectorText);
            if (spec >= bestSpec) { bestSpec = spec; best = { selectorText: r.selectorText, value: v, sheet: r.parentStyleSheet }; }
          }
        };
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules; } catch { continue; } // cross-origin sheets stay opaque
          if (rules) walk(rules);
        }
        if (!best) { sources[prop] = { kind: 'unknown' }; return; }
        let count = 0;
        try { count = document.querySelectorAll(best.selectorText).length; } catch {}
        const hrefPath = (sheet: CSSStyleSheet | null) => { try { return sheet && sheet.href ? new URL(sheet.href).pathname : null; } catch { return null; } };
        const varM = String(best.value).match(/var\((--[A-Za-z0-9_-]+)/);
        if (varM) {
          // Resolve the variable's DEFINITION site so the host's direct writer
          // can edit the token itself. Count EVERY definition anywhere (themes,
          // media scopes): more than one means hands off — the agent decides.
          const varName = varM[1];
          let def = null as { selector: string; value: string; href: string | null } | null, defSpec = -1, defCountAll = 0; // set inside walkDefs
          const walkDefs = (rules: OverlayCssRuleList, sheet: CSSStyleSheet) => {
            for (const r of rules) {
              if (r.cssRules && r.cssRules.length) { walkDefs(r.cssRules, sheet); continue; }
              if (!r.selectorText || !r.style) continue;
              const dv = r.style.getPropertyValue(varName);
              if (!dv) continue;
              defCountAll++;
              let applies = false;
              try { applies = !!el.closest(r.selectorText); } catch {}
              if (!applies) continue;
              const spec2 = radialSpecificity(r.selectorText);
              if (spec2 >= defSpec) { defSpec = spec2; def = { selector: r.selectorText, value: dv.trim(), href: hrefPath(r.parentStyleSheet) }; }
            }
          };
          for (const sheet of document.styleSheets) {
            let rules; try { rules = sheet.cssRules; } catch { continue; }
            if (rules) walkDefs(rules, sheet);
          }
          sources[prop] = { kind: 'var', varName, selectorText: best.selectorText, count, value: best.value, href: hrefPath(best.sheet),
            defHref: def && def.href, defSelector: def && def.selector, defValue: def && def.value, defCount: defCountAll };
        } else {
          sources[prop] = { kind: 'rule', selectorText: best.selectorText, count, value: best.value, href: hrefPath(best.sheet) };
        }
      } catch { sources[prop] = { kind: 'unknown' }; }
    });
    ipcRenderer.sendToHost('radial:style-source', { selector: p.selector, sources });
  } catch {}
});

// Motion panel: the element's computed transition/animation story.
ipcRenderer.on('radial:read-motion', (_e: OverlayHostEvent, p: SelectorRequest) => {
  try {
    const el = document.querySelector(p && p.selector); if (!el) return;
    const c = getComputedStyle(el);
    const ms = (v: string) => Math.round((parseFloat(v) || 0) * (String(v).includes('ms') ? 1 : 1000));
    ipcRenderer.sendToHost('radial:motion-result', { selector: p.selector, motion: {
      transitionProperty: (c.transitionProperty || '').split(',')[0].trim(),
      duration: ms((c.transitionDuration || '0s').split(',')[0]),
      delay: ms((c.transitionDelay || '0s').split(',')[0]),
      easing: (c.transitionTimingFunction || 'ease').split(/,(?![^(]*\))/)[0].trim(),
      animationName: c.animationName !== 'none' ? c.animationName.split(',')[0].trim() : null,
      animationDuration: ms((c.animationDuration || '0s').split(',')[0]),
    } });
  } catch {}
});
ipcRenderer.on('radial:replay-animation', (_e: OverlayHostEvent, p: SelectorRequest) => {
  try {
    const el = document.querySelector<OverlayStyledElement>(p && p.selector); if (!el) return;
    const prev = el.style.animation;
    el.style.animation = 'none';
    // The reflow between the two writes restarts the animation. getBoundingClientRect
    // forces it on any element; offsetWidth exists only on HTML ones (an SVG icon has none).
    void el.getBoundingClientRect();
    el.style.animation = prev || '';
  } catch {}
});
// Style audit (the Check-designs read): every color / type combo / dimension
// value actually IN USE, counted — page-wide, or scoped to a subtree. Plus the
// site's own color tokens (:root custom props) as mapping targets.
ipcRenderer.on('radial:style-audit', (_e: OverlayHostEvent, p: StyleAuditRequest) => {
  try {
    const rootEl = p && p.selector ? document.querySelector(p.selector) : document.body;
    if (!rootEl) return;
    const colors = new Map<string, StyleAuditColor & StyleAuditCount>(), type = new Map<string, StyleAuditType & StyleAuditCount>(), dims = new Map<string, StyleAuditDim & StyleAuditCount>();
    const bump = <T>(m: Map<string, T & StyleAuditCount>, k: string, info: T) => { const e2 = m.get(k) || { count: 0, ...info }; e2.count++; m.set(k, e2); };
    let n = 0;
    const all = [rootEl, ...rootEl.querySelectorAll('*')];
    for (const el of all) {
      if (++n > 2500) break;
      if (el.closest && el.closest('[data-radial-ui]')) continue;
      if (['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT'].includes(el.tagName)) continue;
      const cs = getComputedStyle(el);
      const hasText = [...el.childNodes].some((x) => x.nodeType === 3 && x.textContent!.trim());
      if (hasText && cs.color) bump(colors, cs.color, { css: cs.color, role: 'text' });
      if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') bump(colors, cs.backgroundColor, { css: cs.backgroundColor, role: 'fill' });
      if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && cs.borderTopColor) bump(colors, cs.borderTopColor, { css: cs.borderTopColor, role: 'border' });
      if (hasText) {
        const fam = String(cs.fontFamily).split(',')[0].replace(/["']/g, '').trim();
        const size = Math.round(parseFloat(cs.fontSize) * 10) / 10;
        const weight = cs.fontWeight;
        bump(type, `${fam}|${size}|${weight}`, { family: fam, size, weight });
      }
      const rad = parseFloat(cs.borderTopLeftRadius);
      if (rad > 0) bump(dims, `radius|${rad}`, { kind: 'radius', value: rad });
      if ((cs.display.includes('flex') || cs.display.includes('grid')) && parseFloat(cs.columnGap) > 0) bump(dims, `gap|${parseFloat(cs.columnGap)}`, { kind: 'gap', value: parseFloat(cs.columnGap) });
    }
    // The site's color tokens: custom props on :root/html whose value is a color.
    const tokens: ColorToken[] = [];
    const probe = document.createElement('span');
    for (const sheet of document.styleSheets) {
      let rules2: OverlayCssRuleList;
      try { rules2 = sheet.cssRules; } catch { continue; }
      if (!rules2 || rules2.length > 2000) continue;
      let href = null;
      try { href = sheet.href ? new URL(sheet.href).pathname : null; } catch {}
      for (const rule of rules2) {
        if (!rule.selectorText || !/^(:root|html)\b/.test(rule.selectorText)) continue;
        for (const prop of rule.style) {
          if (!prop.startsWith('--')) continue;
          const v = rule.style.getPropertyValue(prop).trim();
          probe.style.color = ''; probe.style.color = v;
          if (probe.style.color) tokens.push({ name: prop, value: v, href, selector: rule.selectorText });
        }
      }
    }
    ipcRenderer.sendToHost('radial:style-audit-result', {
      scope: (p && p.selector) || '',
      colors: [...colors.values()].sort((a, b2) => b2.count - a.count),
      type: [...type.values()].sort((a, b2) => b2.count - a.count),
      dims: [...dims.values()].sort((a, b2) => b2.count - a.count),
      tokens,
    });
  } catch {}
});

// What KIND of layer is this element — drives the type icons in the Layers
// panel and the selection display (Figma/Webflow's per-type glyphs).
function layerKind(el: Element): LayerKind {
  const t = String(el.tagName || '').toUpperCase();
  if (/^H[1-6]$/.test(t)) return 'heading';
  if (['P', 'SPAN', 'BLOCKQUOTE', 'FIGCAPTION', 'LABEL', 'STRONG', 'EM', 'SMALL', 'CODE', 'PRE'].includes(t)) return 'text';
  if (t === 'IMG' || t === 'PICTURE' || t === 'SVG') return 'img';
  if (t === 'A') return 'link';
  if (t === 'BUTTON') return 'btn';
  if (['UL', 'OL', 'LI', 'DL'].includes(t)) return 'list';
  if (['INPUT', 'TEXTAREA', 'SELECT', 'FORM', 'FIELDSET'].includes(t)) return 'form';
  if (['VIDEO', 'IFRAME', 'AUDIO', 'CANVAS', 'EMBED'].includes(t)) return 'media';
  if (['SECTION', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'ASIDE', 'ARTICLE'].includes(t)) return 'section';
  try {
    const d = getComputedStyle(el).display;
    if (d.includes('grid')) return 'grid';
    if (d.includes('flex')) return 'flex';
  } catch {}
  return 'box';
}
// Layers panel: the WHOLE page's tree (the full list is
// always visible; selection only focuses a row). Capped so a pathological DOM
// can't flood the host; the cap is reported so the panel can say so.
// Structure-dirty signal: once the host has read the tree, watch for DOM
// structure changes (inserts, moves, HMR patches) and tell it — debounced,
// childList-only, so styling/animation churn never fires it. A fresh page
// load pings once so a full reload also invalidates the host's cached tree.
let __treeObsTimer: ReturnType<typeof setTimeout> | 0 = 0;
// Animation churn. A subtree that keeps changing on its own (a scripted demo,
// a word cycler, a ticker) must not keep dirtying the tree: the host would
// re-read Layers and re-list the Content fields on every beat (on
// a demo in a site's hero). Bursts (≥400ms apart) are counted up each mutation's
// ancestor chain; the LOWEST ancestor with 3 bursts inside 20s becomes an
// "animated root" — its mutations stop counting and stop dirtying, and
// read-fields lists it as one row. Radial's own writes (live text, inserts,
// moves) never count. Landmarks, and anything holding a big share of the
// page's fields, are never roots: that shape is HMR after edits, not animation.
const CHURN_FIELDS = 'h1,h2,h3,h4,h5,h6,p,a,button,li,blockquote,figcaption,dt,dd,label,summary,th,td,img';
// Bursts are kept per element AND per the child they arrived through, so that
// marking a root retracts its beats from every ancestor: a wrapper that holds
// the headline next to a demo is only ever judged on churn the demo doesn't
// explain (a hero demo's wrapper was swallowing the h1 otherwise).
const __churn = new WeakMap<Element, Map<Element, number[]>>(); // element → Map(via child | self → burst timestamps, last 20s)
const __animated = new Set<Element>();  // animated roots in this document
let __selfWriteAt = -1e9;
function animatedRootOf(el: Element): Element | null { for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) if (__animated.has(a)) return a; return null; }
function churnCount(el: Element, now: number): number {
  const m = __churn.get(el); if (!m) return 0;
  const windows = new Set<number>();
  for (const [via, arr] of m) { while (arr.length && now - arr[0] > 20000) arr.shift(); if (!arr.length) m.delete(via); else arr.forEach((t) => windows.add(Math.floor(t / 400))); }
  return windows.size;
}
function markAnimated(el: Element) {
  __animated.add(el); __churn.delete(el);
  for (let via = el, a = el.parentElement; a && a !== document.body; via = a, a = a.parentElement) { const m = __churn.get(a); if (m) m.delete(via); }
}
// Returns true when every record sits inside an animated root (nothing to tell the host).
function noteChurn(recs: MutationRecord[]): boolean {
  const now = performance.now();
  const chains: Element[][] = [];
  let outside = 0;
  for (const r of recs) {
    let a = r.target.nodeType === 1 ? r.target as Element : r.target.parentElement;
    if (!a || !a.isConnected || (a.closest && a.closest('[data-radial-ui]'))) continue;
    if (animatedRootOf(a)) continue;
    outside++;
    const chain: Element[] = [];
    for (let d = 0; a && a !== document.body && d < 16; a = a.parentElement, d++) chain.push(a);
    chains.push(chain);
  }
  if (!outside) return true;
  if (now - __selfWriteAt < 600 || __animated.size >= 24) return false; // our own edit landing / enough roots
  for (const chain of chains) {
    let via = null; // the child of `el` this record came through (null: el itself)
    for (const el of chain) {
      const m = __churn.get(el) || new Map<Element, number[]>(); const k = via || el; const arr = m.get(k) || [];
      if (!arr.length || now - arr[arr.length - 1] > 400) arr.push(now);
      m.set(k, arr); __churn.set(el, m);
      via = el;
    }
  }
  let pageFields = -1;
  for (const chain of chains) {
    for (const el of chain) {
      if (__animated.has(el)) break;
      if (churnCount(el, now) < 3) continue;
      if (el.matches('section, main, header, footer, article, nav, aside, form')) break; // landmarks never animate as a whole
      if (pageFields < 0) pageFields = document.body.querySelectorAll(CHURN_FIELDS).length;
      const inside = el.querySelectorAll(CHURN_FIELDS).length;
      if (inside > 40 || inside > Math.max(12, pageFields * 0.3)) break; // too much of the page: edits, not animation
      markAnimated(el);
      break;
    }
  }
  return false;
}
function armTreeWatch() {
  if (window.__radialTreeObs || !window.MutationObserver || !document.body) return;
  window.__radialTreeObs = new MutationObserver((recs) => {
    let quiet = false; try { quiet = noteChurn(recs); } catch {}
    if (quiet) return; // animation beats inside known roots: not a structure change
    clearTimeout(__treeObsTimer);
    __treeObsTimer = setTimeout(() => { try { ipcRenderer.sendToHost('radial:tree-dirty'); } catch {} }, 400);
  });
  window.__radialTreeObs.observe(document.body, { childList: true, subtree: true });
}
window.addEventListener('load', () => setTimeout(() => { try { ipcRenderer.sendToHost('radial:tree-dirty'); } catch {} }, 300));
ipcRenderer.on('radial:read-tree', (_e: OverlayHostEvent, p: ReadTreeRequest) => {
  armTreeWatch();
  try {
    // Text preview: only the element's OWN text nodes — textContent repeated
    // the same heading on every wrapper up the chain, so nothing stood out.
    const ownText = (x: Element) => {
      let s2 = '';
      for (const c of x.childNodes) if (c.nodeType === 3) s2 += c.textContent;
      return s2.trim().slice(0, 24);
    };
    const node = (x: Element) => ({ selector: cssPath(x), tag: x.tagName.toLowerCase(), k: layerKind(x),
      cls: [...x.classList].filter((c) => !c.startsWith('radial-')).slice(0, 2).join('.'),
      text: ownText(x) });
    const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BR', 'HR']);
    // No node cap (the full list is the point — you scan it to find
    // things). The depth guard only breaks pathological nesting/cycles.
    const out: LayerTreeNode[] = [];
    const walk = (el2: Element & { dataset?: DOMStringMap }, depth: number) => {
      if (SKIP.has(el2.tagName) || el2.hasAttribute('data-radial-ui')) return;
      if (el2.dataset && el2.dataset.radialPrevDisplay !== undefined) return; // pending delete — not part of the truth
      if ([...el2.classList].some((c) => c.startsWith('radial-') && c !== 'radial-selected')) return;
      out.push({ ...node(el2), depth });
      if (depth < 24) [...el2.children].forEach((c) => walk(c, depth + 1));
    };
    out.push({ ...node(document.body), depth: 0 }); // body = the root row
    [...document.body.children].forEach((c) => walk(c, 1));
    ipcRenderer.sendToHost('radial:tree-result', { full: true, nodes: out });
  } catch {}
});
// Enter while a selection is held (guest owns focus after a canvas click):
// hand the keyboard to the host's ask field — select → walk → prompt without
// a mouse.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  if (!selectMode || !lastSelected || editingEl) return;
  const t = e.target as (Element & { isContentEditable?: boolean }) | null; // the focused element; only an HTML one has isContentEditable
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  e.preventDefault();
  ipcRenderer.sendToHost('radial:focus-ask', {});
}, true);
// Arrow keys while a selection is held: walk the layer list even though the
// guest owns keyboard focus — the host holds the tree, so just report intent.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const combo = e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey; // Option+arrows always walk
  if (!combo && (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) return;
  if (!lastSelected) return;
  const t = e.target as (Element & { isContentEditable?: boolean }) | null; // the focused element; only an HTML one has isContentEditable
  if (!combo && t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  e.preventDefault();
  ipcRenderer.sendToHost('radial:layer-step', { dir: e.key === 'ArrowDown' ? 1 : -1 });
}, true);
// Layer context-menu plumbing: delete + copy work on any node by selector,
// no prior selection required.
ipcRenderer.on('radial:delete-node', (_e: OverlayHostEvent, p: SelectorRequest) => {
  __selfWriteAt = performance.now(); // our own write: never animation churn
  try {
    const el = document.querySelector<OverlayStyledElement>(p && p.selector); if (!el) return;
    const payload = captureSelection(el, { enrich: false });
    el.dataset.radialPrevDisplay = el.style.display || '';
    el.style.display = 'none'; // instant feedback; the source edit follows
    if (lastSelected === el) lastSelected = null;
    ipcRenderer.sendToHost('radial:delete-element', payload);
  } catch {}
});
// Optimistic move for the Layers drag: reorder the live DOM the instant the
// row drops; the host's queued source write makes it true on disk.
ipcRenderer.on('radial:move-node', (_e: OverlayHostEvent, p: MoveNodeRequest) => {
  __selfWriteAt = performance.now(); // our own write: never animation churn
  try {
    const s = document.querySelector(p && p.subject);
    const t = document.querySelector(p && p.target);
    if (!s || !t || s === t || s.contains(t)) return;
    if (p.position === 'before') t.before(s);
    else if (p.position === 'inside') t.appendChild(s);
    else t.after(s);
  } catch {}
});
// Optimistic add: inject the new element into the live DOM at the anchor and
// select it instantly, so the Add flow feels immediate (no waiting on a
// reload). The source write lands the SAME markup and the reconcile reload is
// suppressed host-side, so what you see already matches disk. Reports back so
// the host can fall back to the reload path if the anchor isn't here yet.
ipcRenderer.on('radial:insert-node', (_e: OverlayHostEvent, p: InsertNodeRequest) => {
  __selfWriteAt = performance.now(); // our own write: never animation churn
  let ok = false;
  try {
    const anchor = document.querySelector(p && p.anchor);
    if (anchor) {
      const tmp = document.createElement('template');
      tmp.innerHTML = String(p.markup || '').trim();
      const node = tmp.content.firstElementChild;
      if (node) {
        if (p.position === 'before') anchor.before(node);
        else if (p.position === 'inside') anchor.appendChild(node);
        else anchor.after(node);
        if (selectMode) {
          [...document.querySelectorAll('.radial-selected')].forEach((x) => x.classList.remove('radial-selected'));
          markSelected(node); lastSelected = node;
          try { node.scrollIntoView({ block: 'nearest' }); } catch {}
          ipcRenderer.sendToHost('radial:select-element', { ...captureSelection(node), additive: false });
        }
        ok = true;
      }
    }
  } catch {}
  ipcRenderer.sendToHost('radial:insert-node-done', { id: p && p.id, ok });
});
// Optimistic wrap: drop a fresh <div> around the element in the live DOM and
// select it — the source write lands the same wrapper, reload suppressed.
ipcRenderer.on('radial:wrap-node', (_e: OverlayHostEvent, p: WrapNodeRequest) => {
  try {
    const el = document.querySelector(p && p.subject);
    if (el && el.parentNode) {
      const div = document.createElement('div');
      if (p.wrapperClass) div.className = p.wrapperClass;
      el.parentNode.insertBefore(div, el);
      div.appendChild(el);
      if (selectMode) {
        [...document.querySelectorAll('.radial-selected')].forEach((x) => x.classList.remove('radial-selected'));
        markSelected(div); lastSelected = div;
        ipcRenderer.sendToHost('radial:select-element', { ...captureSelection(div), additive: false });
      }
    }
  } catch {}
});
// Optimistic unwrap: lift the element's children out and drop the element.
ipcRenderer.on('radial:unwrap-node', (_e: OverlayHostEvent, p: UnwrapNodeRequest) => {
  try {
    const el = document.querySelector(p && p.subject);
    if (el && el.parentNode) {
      while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
      el.remove();
    }
  } catch {}
});
// A failed delete must not leave a ghost: the host restores the element so
// what you SEE always matches what's on disk.
ipcRenderer.on('radial:restore-node', (_e: OverlayHostEvent, p: SelectorRequest) => {
  try {
    const el = document.querySelector<OverlayStyledElement>(p && p.selector); if (!el) return;
    el.style.display = el.dataset.radialPrevDisplay || '';
    delete el.dataset.radialPrevDisplay;
  } catch {}
});
ipcRenderer.on('radial:copy-node', (_e: OverlayHostEvent, p: CopyNodeRequest) => {
  try {
    const el = document.querySelector<Element & { innerText?: string }>(p && p.selector); if (!el) return; // innerText is an HTML element's: undefined on SVG and MathML, where textContent stands in
    const html = (el.outerHTML || '').replace(/\s+class="[^"]*radial-[^"]*"/g, '');
    const text = (el.innerText || el.textContent || '').trim();
    ipcRenderer.sendToHost('radial:node-copy', { selector: p.selector, kind: p.kind, html, text });
  } catch {}
});
// Layer-row hover → a thin preview outline on the matching element, so you can
// see what a layer points at while scanning the list. Skips the already-
// selected element (its 2px ring already shows it). Cleared on unhover.
let _layerHovered: Element | null = null;
function clearLayerHover() { if (_layerHovered) { _layerHovered.classList.remove('radial-layer-hover'); _layerHovered = null; } }
ipcRenderer.on('radial:hover-node', (_e: OverlayHostEvent, p: SelectorRequest) => {
  clearLayerHover();
  try {
    const el = document.querySelector(p && p.selector);
    if (!el || el.classList.contains('radial-selected')) return;
    el.classList.add('radial-layer-hover');
    _layerHovered = el;
  } catch {}
});
ipcRenderer.on('radial:unhover-node', () => clearLayerHover());
ipcRenderer.on('radial:select-node', (_e: OverlayHostEvent, p: SelectNodeRequest) => {
  try {
    clearLayerHover(); // a real selection supersedes the hover preview
    const el = document.querySelector<OverlayStyledElement>(p && p.selector); if (!el) return;
    [...document.querySelectorAll('.radial-selected')].forEach((x) => x.classList.remove('radial-selected'));
    markSelected(el);
    lastSelected = el;
    // light = rapid layer-stepping: just move the outline, instantly — the
    // full capture (style walk, palette, panels) runs ONCE when the burst
    // settles, via a follow-up non-light call.
    if (p && p.light) { el.scrollIntoView({ block: 'center' }); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' }); // centered, not parked at the viewport edge
    ipcRenderer.sendToHost('radial:select-element', { ...captureSelection(el), additive: false });
  } catch {}
});
// Image panel: intrinsic vs rendered geometry, weight, alt.
ipcRenderer.on('radial:read-image', (_e: OverlayHostEvent, p: SelectorRequest) => {
  try {
    const el = document.querySelector<HTMLImageElement>(p && p.selector); if (!el || el.tagName !== 'IMG') return;
    let bytes: number | null = null;
    try { const ent = performance.getEntriesByName(el.currentSrc)[0] as PerformanceResourceTiming | undefined; if (ent && ent.transferSize) bytes = ent.transferSize; } catch {}
    const r = el.getBoundingClientRect();
    ipcRenderer.sendToHost('radial:image-result', { selector: p.selector, image: {
      src: el.currentSrc || el.src, thumb: thumbOf(el, 240), naturalW: el.naturalWidth, naturalH: el.naturalHeight,
      renderedW: Math.round(r.width), renderedH: Math.round(r.height), bytes,
      alt: el.getAttribute('alt'), loading: el.getAttribute('loading') } });
  } catch {}
});
// A small thumbnail drawn IN the page and sent as a data URL. The host window
// can't always load the site's images itself: Vite 7 / Astro 6 dev servers
// answer 403 to cross-site image requests (Sec-Fetch-Site), hotlink-protected
// CDNs do the same, and cookies never travel. The page can, so it draws.
// Never upscales (a 16px icon stays 16px — the panel shows it at that size);
// PNG keeps logos' transparency, JPEG keeps photos small. Tainted canvases
// (cross-origin images without CORS) and unloaded images fall back to the URL.
function thumbOf(el: HTMLImageElement, box = 112): string | null { // the panel's 56×42 box at 2×; the Image panel asks for more
  try {
    if (!el || !el.complete || !el.naturalWidth || !el.naturalHeight) return null;
    const k = Math.min(1, box / el.naturalWidth, (box * 0.75) / el.naturalHeight);
    const w = Math.max(1, Math.round(el.naturalWidth * k)), h = Math.max(1, Math.round(el.naturalHeight * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(el, 0, 0, w, h);
    const png = /\.(png|svg|gif|webp|avif)(\?|#|$)/i.test(el.currentSrc || el.src || '') || w * h <= 128 * 128;
    return png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.8);
  } catch { return null; }
}
// Accessibility panel: the selection's name/role/contrast + page-level counts.
ipcRenderer.on('radial:read-a11y', (_e: OverlayHostEvent, p: SelectorRequest) => {
  try {
    const el = document.querySelector<OverlayStyledElement>(p && p.selector); if (!el) return;
    const c = getComputedStyle(el);
    let bgEl: Element | null = el, bg = 'rgba(0, 0, 0, 0)';
    while (bgEl) {
      const b = getComputedStyle(bgEl).backgroundColor;
      if (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') { bg = b; break; }
      bgEl = bgEl.parentElement;
    }
    if (bg === 'rgba(0, 0, 0, 0)') bg = 'rgb(255, 255, 255)';
    const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter((h) => !h.closest('[data-radial-ui]'));
    let skips = 0, prev = 0;
    headings.forEach((h) => { const lv = +h.tagName[1]; if (prev && lv > prev + 1) skips++; prev = lv; });
    const imgs = [...document.querySelectorAll('img')].filter((i) => !i.closest('[data-radial-ui]'));
    ipcRenderer.sendToHost('radial:a11y-result', { selector: p.selector, a11y: {
      tag: el.tagName.toLowerCase(), role: el.getAttribute('role'),
      name: el.getAttribute('aria-label') || (el.tagName === 'IMG' ? el.getAttribute('alt') : (el.textContent || '').trim().slice(0, 60)) || null,
      focusable: el.tabIndex >= 0 || ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName),
      interactive: ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || el.getAttribute('role') === 'button',
      color: c.color, bg, fontSize: parseFloat(c.fontSize) || 16, fontWeight: parseInt(c.fontWeight, 10) || 400,
      h1Count: headings.filter((h) => h.tagName === 'H1').length, headingSkips: skips,
      imgsMissingAlt: imgs.filter((i) => i.getAttribute('alt') == null).length, imgCount: imgs.length,
    } });
  } catch {}
});

// The Content panel's page-wide field list: every text block and image on the
// page in document order, grouped by the nearest landmark. `focus` (a selector)
// marks the fields inside the current selection so the panel can light them up.
// A text element owns its text unless a captured parent already does. Each
// field carries its structural path so attribute edits (alt) can pin the
// element in source.
// Tokens panel: the live value of each custom property on the root, so a
// saved token that the page hasn't picked up yet can say so. Custom properties
// on the root come back with var() substituted (aliases resolve here).
ipcRenderer.on('radial:read-tokens', (_e: OverlayHostEvent, p: ReadTokensRequest) => {
  try {
    const cs = getComputedStyle(document.documentElement);
    const values: Record<string, string> = {};
    for (const name of (p && p.names) || []) { try { values[name] = cs.getPropertyValue(name).trim(); } catch {} }
    const inline: Record<string, boolean> = {}; // set from JavaScript at runtime: the file is not the truth for these
    for (const name of (p && p.names) || []) { try { if (document.documentElement.style.getPropertyValue(name)) inline[name] = true; } catch {} }
    ipcRenderer.sendToHost('radial:tokens-result', { values, inline });
  } catch {}
});
ipcRenderer.on('radial:read-fields', (_e: OverlayHostEvent, p: ReadFieldsRequest) => {
  try {
    const TAGS = 'h1,h2,h3,h4,h5,h6,p,a,button,li,blockquote,figcaption,dt,dd,label,summary,th,td';
    let focusEl: Element | null = null; try { focusEl = p && p.focus ? document.querySelector(p.focus) : null; } catch {}
    const SCAFFOLD_ID = /^(main|content|main-content|maincontent|root|app|page|wrapper|container|body|site|layout|__next|__nuxt)$/i;
    const groupOf = (el: Element): string => {
      // Page-level sections first (how people think about a page: header, hero,
      // pricing, footer); nav/aside/form only when nothing section-level wraps it.
      const lm = el.closest('section, header, footer, main, article') || el.closest('nav, aside, form');
      if (!lm || lm === document.body) return 'Page';
      // A meaningful id names the section; a scaffolding id (#main-content,
      // #root) says nothing, so the section's own heading names it instead.
      if (lm.id && !SCAFFOLD_ID.test(lm.id)) return '#' + lm.id;
      const hd = lm.querySelector('h1,h2,h3');
      let t = hd ? (hd.textContent || '').replace(/\s+/g, ' ').trim() : '';
      if (t.length > 32) { const cut = t.slice(0, 32); t = (cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut) + '\u2026'; } // whole words, then an ellipsis
      return t || (lm.id ? '#' + lm.id : lm.tagName.toLowerCase());
    };
    // The field's kind in words — what a CMS would call it — from the tag plus
    // where it sits. The tag still rides along for the panel's inline chip.
    const roleOf = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'h1') return 'Heading';
      if (tag === 'h2' || tag === 'h3') return 'Subheading';
      if (/^h[4-6]$/.test(tag)) return 'Small heading';
      const cls = el.getAttribute('class') || '';
      if (tag === 'button' || el.getAttribute('role') === 'button' || (tag === 'a' && /(^|[\s_-])(btn|button|cta)([\s_-]|$)/i.test(cls))) return 'Button';
      if (tag === 'a') return el.closest('nav') ? 'Nav link' : 'Link';
      return ({ p: 'Body', li: 'List item', blockquote: 'Quote', figcaption: 'Caption', label: 'Label', summary: 'Summary', th: 'Header cell', td: 'Cell', dt: 'Term', dd: 'Definition' } as Partial<Record<string, string>>)[tag] || 'Text';
    };
    const visible = (el: Element) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0; };
    const inFocus = (el: Element) => !!(focusEl && (focusEl === el || focusEl.contains(el)));
    const fields: ContentFieldReadout[] = [], seen = new Set<Element | null>(), animSeen = new Set<Element>();
    let thumbs = 0; // in-page thumbnails are cheap but not free: the first 200 images get one
    for (const el of document.body.querySelectorAll(TAGS + ',img')) {
      if (fields.length >= 400) break;
      if (el.closest('[data-radial-ui]') || !visible(el)) continue;
      const aroot = animatedRootOf(el);
      if (aroot) { // a subtree that changes on its own lists once, as one row
        if (!animSeen.has(aroot)) {
          animSeen.add(aroot);
          const idEl = aroot.id ? aroot : aroot.querySelector('[id]');
          fields.push({ kind: 'animated', selector: cssPath(aroot), tag: aroot.tagName.toLowerCase(), role: 'Animated', name: idEl && idEl.id ? '#' + idEl.id : aroot.tagName.toLowerCase(), count: aroot.querySelectorAll(TAGS + ',img').length, group: groupOf(aroot), inFocus: inFocus(aroot) });
        }
        continue;
      }
      if (el.tagName === 'IMG') {
        const src = (el as HTMLImageElement).currentSrc || el.getAttribute('src') || '';
        if (!src) continue;
        fields.push({ kind: 'image', selector: cssPath(el), tag: 'img', role: 'Image', src, thumb: thumbs++ < 200 ? thumbOf(el as HTMLImageElement) : null, alt: el.getAttribute('alt'), naturalW: (el as HTMLImageElement).naturalWidth || 0, naturalH: (el as HTMLImageElement).naturalHeight || 0, group: groupOf(el), inFocus: inFocus(el), path: buildStructuralPath(el) });
        continue;
      }
      if (seen.has(el.parentElement)) continue; // its text already belongs to a captured parent
      const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue!.trim());
      if (!hasOwnText && el.querySelector(TAGS)) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      seen.add(el);
      fields.push({ kind: 'text', selector: cssPath(el), tag: el.tagName.toLowerCase(), role: roleOf(el), text: text.slice(0, 400), truncated: text.length > 400, hasMarkup: el.children.length > 0, group: groupOf(el), inFocus: inFocus(el), path: buildStructuralPath(el) }); // path: the structural pin `radial edit text --field` hands the source engine
    }
    ipcRenderer.sendToHost('radial:fields-result', { focus: (p && p.focus) || null, fields });
  } catch {}
});

// Design panel: every color the selection's subtree renders, most-used first.
ipcRenderer.on('radial:read-selcolors', (_e: OverlayHostEvent, p: SelectorRequest) => {
  try {
    const rootEl = document.querySelector(p && p.selector); if (!rootEl) return;
    const counts = new Map<string, ColorCount>();
    const toHex = (css: string): string | null => {
      const m = String(css).match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)(?:[,/ ]+([\d.]+))?/);
      if (!m) return null;
      if (m[4] != null && parseFloat(m[4]) === 0) return null; // fully transparent
      const hex = '#' + [m[1], m[2], m[3]].map((c) => (+c).toString(16).padStart(2, '0')).join('');
      return hex.toUpperCase();
    };
    const see = (css: string) => {
      const hex = toHex(css);
      if (!hex) return;
      const e2 = counts.get(hex) || { css, hex, count: 0 };
      e2.count++;
      counts.set(hex, e2);
    };
    const els = [rootEl, ...rootEl.querySelectorAll('*')].slice(0, 400);
    for (const el of els) {
      if (el.closest('[data-radial-ui]')) continue;
      const cs = getComputedStyle(el);
      see(cs.color);
      see(cs.backgroundColor);
      if ((parseFloat(cs.borderTopWidth) || 0) > 0) see(cs.borderTopColor);
    }
    const colors = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 12);
    ipcRenderer.sendToHost('radial:selcolors-result', { selector: p.selector, colors });
  } catch {}
});

// Right-click (Select tool only): offer the panels most relevant to the
// element. In browse mode the site's own context menu behavior stays intact.
window.addEventListener('contextmenu', (e) => {
  if (!selectMode || editingEl) return;
  if ((e.target as Element).closest && (e.target as Element).closest('[data-radial-ui]')) return;
  e.preventDefault();
  e.stopPropagation();
  try {
    ipcRenderer.sendToHost('radial:context-menu', { sel: captureSelection(e.target as Element, { enrich: false }), x: e.clientX, y: e.clientY });
  } catch {}
}, true);

// Variants panel: harvest the page's button family, cluster by computed visual
// signature (implementation-agnostic — named classes, Tailwind soup and
// CSS-in-JS all cluster the same), and report each cluster's shared class core.
ipcRenderer.on('radial:variants-scan', (_e: OverlayHostEvent, p: SelectorRequest) => {
  try {
    const btnish = (el: Element) => {
      if (el.matches('button, input[type="submit"], input[type="button"], [role="button"]')) return true;
      if (el.tagName === 'A') {
        const c = getComputedStyle(el);
        return (c.backgroundColor !== 'rgba(0, 0, 0, 0)' && c.backgroundColor !== 'transparent') || (parseFloat(c.borderTopWidth) || 0) > 0;
      }
      return false;
    };
    // (The casts: offsetWidth is an HTML element's. An SVG <a> or [role=button] matches too; its offsetWidth is undefined, and undefined > 0 drops it.)
    const els = [...document.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"]')]
      .filter((el) => (el as HTMLElement).offsetWidth > 0 && (el as HTMLElement).offsetHeight > 0 && !el.closest('[data-radial-ui]') && btnish(el));
    // Buckets kill pixel drift: a button 1px off its siblings is the same
    // style, not a new variant (the consolidation note still reports raw px).
    const b2 = (v: string) => Math.round((parseFloat(v) || 0) / 2) * 2;
    const sig = (el: Element): ButtonSignature => {
      const c = getComputedStyle(el);
      return { bg: c.backgroundColor, color: c.color,
        borderW: Math.round(parseFloat(c.borderTopWidth) || 0), borderC: c.borderTopColor,
        radius: b2(c.borderTopLeftRadius),
        fontSize: Math.round(parseFloat(c.fontSize) || 0), fontWeight: c.fontWeight,
        padV: b2(c.paddingTop), padH: b2(c.paddingLeft),
        transform: c.textTransform };
    };
    const target = p && p.selector ? document.querySelector(p.selector) : null;
    const clusters = new Map<string, OverlayButtonCluster>();
    let currentKey: string | null = null;
    els.forEach((el) => {
      const sv = sig(el);
      const key = JSON.stringify(sv);
      if (!clusters.has(key)) clusters.set(key, { signature: sv, count: 0, classSets: [], sample: cssPath(el) });
      const c = clusters.get(key)!;
      c.count++;
      c.classSets.push([...el.classList].filter((x) => !x.startsWith('radial-')));
      if (target && el === target) currentKey = key;
    });
    const out: VariantCluster[] = [...clusters.values()].map((c) => ({
      key: JSON.stringify(c.signature), signature: c.signature, count: c.count, sample: c.sample,
      // The style-defining core = classes shared by EVERY instance; per-instance
      // layout one-offs (mt-4 on one button) fall out naturally.
      core: c.classSets.length ? c.classSets.reduce((a, b) => a.filter((x) => b.includes(x))) : [],
    })).sort((a, b) => b.count - a.count);
    ipcRenderer.sendToHost('radial:variants-result', { selector: p && p.selector, clusters: out, currentKey });
  } catch {}
});

ipcRenderer.on('radial:set-zoomed', (_e: OverlayHostEvent, v: boolean) => {
  const on = !!v;
  if (on === __radialZoomed) return;
  __radialZoomed = on;
  if (on) window.addEventListener('wheel', onZoomedWheel, { passive: false, capture: true });
  else window.removeEventListener('wheel', onZoomedWheel, { capture: true });
});

// --- Add-element drop targeting -------------------------------------------
// The host drags a card from the Add panel; its shield owns the pointer, so
// we receive FRACTIONAL viewport coords (zoom-proof), resolve the element
// under them, and light the landing slot before the drop: a bar above/below
// the target (before/after) or a dashed inset ring (inside, as last child).
// Top/bottom 30% of the target means before/after; the middle means inside.
let insTarget: Element | null = null, insPos: OverlayDropPosition | null = null, insBar: HTMLElement | null = null, insRing: HTMLElement | null = null;
function insEls() {
  if (insBar) return;
  insBar = document.createElement('div');
  insBar.setAttribute('data-radial-ui', '1');
  insBar.style.cssText = 'position:fixed;z-index:2147483646;height:3px;border-radius:2px;background:#4f8cff;pointer-events:none;display:none;box-shadow:0 0 0 1px rgba(255,255,255,0.3)';
  insRing = document.createElement('div');
  insRing.setAttribute('data-radial-ui', '1');
  insRing.style.cssText = 'position:fixed;z-index:2147483646;border:2px dashed #4f8cff;border-radius:4px;pointer-events:none;display:none';
  document.documentElement.appendChild(insBar);
  document.documentElement.appendChild(insRing);
}
function insClear() {
  insTarget = null; insPos = null;
  if (insBar) insBar.style.display = 'none';
  if (insRing) insRing.style.display = 'none';
}
ipcRenderer.on('radial:insert-hover', (_e: OverlayHostEvent, { fx, fy }: InsertHoverRequest) => {
  insEls();
  const x = Math.max(0, Math.min(window.innerWidth - 1, fx * window.innerWidth));
  const y = Math.max(0, Math.min(window.innerHeight - 1, fy * window.innerHeight));
  let el = document.elementFromPoint(x, y);
  while (el && el.getAttribute && el.getAttribute('data-radial-ui')) el = el.parentElement;
  if (!el || /^(html|body|script|style)$/i.test(el.tagName)) { insClear(); return; }
  const r = el.getBoundingClientRect();
  const frac = (y - r.top) / Math.max(1, r.height);
  const voidEl = /^(img|br|hr|input|source|embed|video|iframe|svg)$/i.test(el.tagName);
  insTarget = el;
  insPos = frac < 0.3 ? 'before' : frac > 0.7 ? 'after' : (voidEl ? 'after' : 'inside');
  if (insPos === 'inside') { // (insEls above made the bar and the ring)
    insRing!.style.display = 'block'; insBar!.style.display = 'none';
    insRing!.style.left = (r.left + 2) + 'px'; insRing!.style.top = (r.top + 2) + 'px';
    insRing!.style.width = Math.max(0, r.width - 8) + 'px'; insRing!.style.height = Math.max(0, r.height - 8) + 'px';
  } else {
    insBar!.style.display = 'block'; insRing!.style.display = 'none';
    insBar!.style.left = r.left + 'px'; insBar!.style.width = r.width + 'px';
    insBar!.style.top = ((insPos === 'before' ? r.top : r.bottom) - 1.5) + 'px';
  }
});
ipcRenderer.on('radial:insert-drop', () => {
  const t = insTarget, p = insPos;
  insClear();
  ipcRenderer.sendToHost('radial:insert-target', t ? { anchor: captureSelection(t), position: p! } : null); // insPos is set with insTarget
});
ipcRenderer.on('radial:insert-cancel', () => insClear());
// Capture an arbitrary node's selection payload by selector — the insert
// fallback ladder uses this to try ancestors when an anchor is unlocatable.
ipcRenderer.on('radial:capture-node', (_e: OverlayHostEvent, p: CaptureNodeRequest) => {
  let sel = null;
  try { const el = document.querySelector(p && p.selector); if (el) sel = captureSelection(el, { enrich: false }); } catch {}
  ipcRenderer.sendToHost('radial:node-captured', { id: p && p.id, sel });
});

// --- Canvas drag-to-reorder (Select mode) ---------------------------------
// Mouse down on any element and pull: past a small threshold the element
// lifts (dimmed, pointer-transparent) and the SAME landing indicators as the
// Add drag light the slot — bar for before/after, dashed ring for into. The
// drop moves the DOM immediately (the source write + hot reload confirm it);
// Esc cancels. A plain click never trips the threshold, so selection clicks
// are untouched.
let cvArm: OverlayCvPress | null = null, cvDrag: OverlayCvDrag | null = null, cvSuppressClick = false;
// Canvas drag-to-reorder is OFF by default. The slot logic
// here is axis-blind — the vertical thirds of the hovered element decide
// before/after/inside, and "inside" appends as the LAST child — so on flex rows,
// gapped layouts and drops into containers the blue bar and the landing spot
// disagree. Layers is the reliable reorder surface. The host flips this on
// (localStorage radial.canvasReorder=1, or the command palette) while the
// axis-aware, live-reflow version is built behind the same switch.
let canvasReorder = false, cvHint: OverlayCvPress | null = null, cvHintShown = false;
ipcRenderer.on('radial:set-canvas-reorder', (_e: OverlayHostEvent, v: boolean) => {
  canvasReorder = !!v;
  if (!canvasReorder) { cvArm = null; cvHint = null; if (cvDrag) cvEnd(true); } // switching off mid-gesture restores the element
});
// ── Canvas drag-to-reorder: axis-aware, live-reflow (the Figma/Webflow feel) ──
// The browser is the layout engine, so the PREVIEW IS THE RESULT: as the
// pointer moves, the lifted element is really moved in the live DOM to the slot
// under it and the page reflows around it — what you see is what lands. The
// slot is computed along the target container's main axis (a row → X, a
// column/block → Y, wrap/grid → the row band under the pointer, then X)
// against the siblings' RENDERED centers, so \`order\` and reversed directions
// can't lie; a placement is verified by measurement and the DOM insertion is
// flipped when it rendered on the wrong side. Hovering a container drops INTO
// it at the pointer's slot; its edge bands mean "beside it" in the parent's
// flow. Out-of-flow (absolute/fixed) and explicitly grid-placed elements can't
// be reordered by DOM position — they refuse with a reason. On drop the
// original arrangement is restored for one frame so subject/target payloads
// describe the tree the source scanner will see, then the final arrangement
// is re-applied and committed through the same applyMove as Layers.
const CV_TEXTLIKE = /^(p|h[1-6]|span|a|b|i|em|strong|small|label|button|code|kbd|abbr|cite|q|s|u|sub|sup|mark|time|var|dfn|bdi|bdo|data|output|legend|summary|option|textarea|select|pre|blockquote|figcaption|dt|dd|caption|th|td)$/i;
const CV_INLINE = /^(span|a|b|i|em|strong|small|code|kbd|abbr|cite|q|s|u|sub|sup|mark|time|var|dfn|img|br|wbr|input|button|label|svg|picture|video|audio)$/i;
const CV_VOIDISH = /^(img|br|hr|input|source|embed|video|audio|iframe|svg|canvas|picture|object|track|wbr|meta|link|script|style|template|noscript)$/i;
function cvOutOfFlow(el: Element): boolean { const p = getComputedStyle(el).position; return p === 'absolute' || p === 'fixed'; }
function cvGridPlaced(el: Element): boolean { const cs = getComputedStyle(el); return (['gridRowStart', 'gridColumnStart'] as const).some((k) => cs[k] && cs[k] !== 'auto'); }
let _cvIds = new WeakMap<Element, number>(), _cvSeq = 0;
const cvId = (n: Element | null): string => { if (!n) return '-'; if (!_cvIds.has(n)) _cvIds.set(n, ++_cvSeq); return String(_cvIds.get(n)); };
const cvName = (n: Element): string => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + ([...n.classList].filter((c) => !c.startsWith('radial-'))[0] ? '.' + [...n.classList].filter((c) => !c.startsWith('radial-'))[0] : '');
// May the lifted element \`el\` be dropped inside container \`c\`?
function cvCanHold(c: Element, el: Element): boolean {
  if (!c || c === el || el.contains(c) || c.nodeType !== 1) return false;
  if (c.getAttribute && c.getAttribute('data-radial-ui')) return false;
  if (/^(html|head|script|style|template)$/i.test(c.tagName) || CV_VOIDISH.test(c.tagName)) return false;
  const li = /^li$/i.test(el.tagName), list = /^(ul|ol)$/i.test(c.tagName);
  if (list) return li;                 // lists take only items
  if (li) return false;                // an item lives only in a list
  if (CV_TEXTLIKE.test(c.tagName) && !CV_INLINE.test(el.tagName)) return false; // a block can't live inside text
  const d = getComputedStyle(c).display;
  if (d === 'none' || d === 'contents' || d === 'inline' || d.startsWith('table') || d.startsWith('ruby')) return false;
  // A box whose only content is text is a LEAF (a text block), not a container:
  // dragging across a row of such boxes must slot BETWEEN them, never into one.
  // An empty box (no elements, no text) is a container you can fill; a box with
  // element children is a structural container. Inline subjects may still join text.
  const hasEls = [...c.children].some((k) => !(k.getAttribute && k.getAttribute('data-radial-ui')));
  const hasText = !hasEls && /\S/.test(c.textContent || '');
  if (hasText && !CV_INLINE.test(el.tagName)) return false;
  return true;
}
// The container's flow axis: 'x' (row), 'y' (column/block) or '2d' (wrap/grid).
function cvLayout(c: Element): OverlayCvAxis {
  const cs = getComputedStyle(c), d = cs.display;
  if (d.includes('grid')) return '2d';
  if (d.includes('flex')) { const dir = cs.flexDirection || 'row'; return cs.flexWrap !== 'nowrap' ? '2d' : (dir.startsWith('row') ? 'x' : 'y'); }
  return 'y';
}
// The container under the pointer: the deepest holder, unless the pointer sits
// in an edge band of it and its parent can hold — then it's "beside", in the
// parent's flow. (Edge zones are how Figma/Webflow disambiguate beside vs into.)
function cvResolve(x: number, y: number, el: Element): Element | null {
  let h = document.elementFromPoint(x, y);
  while (h && h.getAttribute && h.getAttribute('data-radial-ui')) h = h.parentElement;
  while (h && (h === el || el.contains(h))) h = h.parentElement;
  let c = h;
  while (c && !cvCanHold(c, el)) c = c.parentElement;
  if (!c || /^html$/i.test(c.tagName)) return null;
  const p = c.parentElement;
  // Edge bands only apply when the pointer is on the container's OWN area (its
  // padding/gaps). Reaching it by climbing from a child means the pointer is
  // inside its content — that's "into", whatever the distance to the border.
  // …and not when the pointer is over the lifted element's own slot (hit-testing
  // sees through it to the container, which is not an edge hit).
  const er = el.getBoundingClientRect();
  const overSelf = x >= er.left && x <= er.right && y >= er.top && y <= er.bottom;
  if (h === c && !overSelf && c !== document.body && p && cvCanHold(p, el)) {
    const r = c.getBoundingClientRect();
    const band = Math.max(4, Math.min(10, r.width * 0.2, r.height * 0.2));
    const ax = cvLayout(p);
    const nearX = x - r.left < band || r.right - x < band, nearY = y - r.top < band || r.bottom - y < band;
    if ((ax === 'x' && nearX) || (ax === 'y' && nearY) || (ax === '2d' && (nearX || nearY))) c = p;
  }
  return c;
}
// The slot in \`c\` at the pointer: before a visual neighbor, after the last, or
// inside an empty container. Siblings are measured where they RENDER and sorted
// along the axis, so DOM order, \`order\` and reversed directions don't matter.
function cvSlot(c: Element, x: number, y: number, el: Element): OverlayCvSlot {
  const kids = [...c.children].filter((k) => k !== el && !el.contains(k) && !(k.getAttribute && k.getAttribute('data-radial-ui')) && !cvOutOfFlow(k) && getComputedStyle(k).display !== 'none');
  if (!kids.length) return { c, ref: null, pos: 'inside', axis: cvLayout(c), boundary: null };
  const rects = kids.map((k) => { const r = k.getBoundingClientRect(); return { k, r, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
  let axis = cvLayout(c);
  if (rects.length >= 2) {
    const ys = rects.map((o) => o.cy), xs = rects.map((o) => o.cx);
    const oneRow = Math.max(...ys) - Math.min(...ys) < 8, oneCol = Math.max(...xs) - Math.min(...xs) < 8;
    axis = oneRow && !oneCol ? 'x' : oneCol && !oneRow ? 'y' : (oneRow && oneCol ? axis : '2d');
  }
  let cand = rects; const twoD = axis === '2d';
  if (axis === '2d') { // the row band nearest the pointer, then X within it
    const dist = (o: (typeof rects)[number]) => y < o.r.top ? o.r.top - y : y > o.r.bottom ? y - o.r.bottom : 0;
    const best = Math.min(...rects.map(dist));
    cand = rects.filter((o) => dist(o) <= best + 1).sort((a, b) => a.cx - b.cx);
    axis = 'x';
  } else cand = rects.slice().sort((a, b) => (axis === 'x' ? a.cx - b.cx : a.cy - b.cy));
  const at = (o: (typeof rects)[number]) => (axis === 'x' ? o.cx : o.cy), pointer = axis === 'x' ? x : y;
  let k = 0; while (k < cand.length && at(cand[k]) < pointer) k++;
  const near = [cand[k - 1], cand[k]].filter(Boolean).map(at);
  const boundary = near.length ? near.reduce((b, v) => (Math.abs(v - pointer) < Math.abs(b - pointer) ? v : b), near[0]) : null;
  return k < cand.length ? { c, ref: cand[k].k, pos: 'before', axis, boundary, twoD } : { c, ref: cand[cand.length - 1].k, pos: 'after', axis, boundary, twoD };
}
// Insert at the slot, verify where it RENDERED, flip the DOM side if the layout
// reversed it (row-reverse, \`order\`). Returns the DOM position to commit, or null
// when no DOM position expresses the slot.
function cvPlace(slot: OverlayCvSlot, el: Element): OverlayDropPosition | null {
  const ins = (pos: OverlayDropPosition) => { if (slot.pos === 'inside') slot.c.appendChild(el); else if (pos === 'before') slot.ref.before(el); else slot.ref.after(el); };
  ins(slot.pos);
  if (slot.pos === 'inside') return 'inside';
  const side = (pos: 'before' | 'after') => {
    const a = el.getBoundingClientRect(), b = slot.ref.getBoundingClientRect();
    // In a wrapping/grid layout "before" means earlier in READING order (row band,
    // then X): the neighbor may have wrapped to the next row after the insertion.
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2, bx = b.left + b.width / 2, by = b.top + b.height / 2;
    const delta = slot.twoD ? (Math.abs(ay - by) > 8 ? ay - by : ax - bx) : (slot.axis === 'x' ? ax - bx : ay - by);
    return pos === 'before' ? delta <= 0 : delta >= 0;
  };
  if (side(slot.pos)) return slot.pos;
  const flipped = slot.pos === 'before' ? 'after' : 'before';
  ins(flipped);
  return side(slot.pos) ? flipped : null;
}
// FLIP: siblings glide from where they were to where they now are.
let cvAnims: Animation[] = [];
function cvCancelAnims() { for (const a of cvAnims) { try { a.cancel(); } catch {} } cvAnims = []; }
function cvFlipStart(nodes: Iterable<Element>): Map<Element, DOMRect> { cvCancelAnims(); const m = new Map<Element, DOMRect>(); let n = 0; for (const el of nodes) { if (!el || el.nodeType !== 1 || (el.getAttribute && el.getAttribute('data-radial-ui'))) continue; if (++n > 80) break; m.set(el, el.getBoundingClientRect()); } return m; }
function cvFlipEnd(m: Map<Element, DOMRect>) {
  for (const [el, b] of m) {
    const a = el.getBoundingClientRect(); const dx = b.left - a.left, dy = b.top - a.top;
    if (!dx && !dy) continue;
    try { cvAnims.push(el.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' })); } catch {}
  }
}
let cvLabelEl: HTMLElement | null = null;
function cvLabel(text: string | null, x?: number, y?: number) {
  if (!text) { if (cvLabelEl) cvLabelEl.style.display = 'none'; return; }
  if (!cvLabelEl) {
    cvLabelEl = document.createElement('div'); cvLabelEl.setAttribute('data-radial-ui', '1');
    cvLabelEl.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:11px/1 system-ui,sans-serif;color:#fff;background:#4f8cff;padding:4px 7px;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.25);white-space:nowrap';
    document.documentElement.appendChild(cvLabelEl);
  }
  cvLabelEl.textContent = text; cvLabelEl.style.display = 'block';
  cvLabelEl.style.left = (x! + 14) + 'px'; cvLabelEl.style.top = (y! + 14) + 'px'; // a label always comes with the pointer
}
// The insertion bar sits on the slot's edge, ORIENTED to the axis (a vertical
// bar between row items); a dashed ring marks "into" an empty container.
function cvIndicate(d: OverlayCvDrag) {
  insEls();
  if (!d.pos) { insClear(); return; }
  // (A placed drag has its container, and its ref unless it went inside; insEls made the bar and the ring.)
  if (d.pos === 'inside') {
    const r = d.container!.getBoundingClientRect();
    insRing!.style.display = 'block'; insBar!.style.display = 'none';
    insRing!.style.left = (r.left + 2) + 'px'; insRing!.style.top = (r.top + 2) + 'px';
    insRing!.style.width = Math.max(0, r.width - 8) + 'px'; insRing!.style.height = Math.max(0, r.height - 8) + 'px';
    return;
  }
  const r = d.ref!.getBoundingClientRect();
  insBar!.style.display = 'block'; insRing!.style.display = 'none';
  if (d.axis === 'x') {
    insBar!.style.width = '3px'; insBar!.style.height = r.height + 'px'; insBar!.style.top = r.top + 'px';
    insBar!.style.left = ((d.pos === 'before' ? r.left : r.right) - 1.5) + 'px';
  } else {
    insBar!.style.height = '3px'; insBar!.style.width = r.width + 'px'; insBar!.style.left = r.left + 'px';
    insBar!.style.top = ((d.pos === 'before' ? r.top : r.bottom) - 1.5) + 'px';
  }
}
// (origParent!: when the page took the element out before the drag it is null, and the TypeError lands in the catch.)
function cvRestoreOriginal(d: OverlayCvDrag) { try { if (d.origNext && d.origNext.parentNode === d.origParent) d.origParent!.insertBefore(d.el, d.origNext); else d.origParent!.appendChild(d.el); } catch {} }
function cvApplyFinal(d: OverlayCvDrag) { try { if (d.pos === 'inside') d.container!.appendChild(d.el); else if (d.pos === 'before') d.ref!.before(d.el); else d.ref!.after(d.el); } catch {} }
function cvEnd(cancelled: boolean): OverlayCvFinishedDrag | null {
  if (!cvDrag) return null;
  const d = cvDrag; cvDrag = null;
  cvCancelAnims();
  d.el.style.opacity = d.prevOpacity; d.el.style.pointerEvents = d.prevPE;
  insClear(); cvLabel(null);
  const moved = !!d.pos && !(d.el.parentNode === d.origParent && d.el.nextSibling === d.origNext);
  if (cancelled || !moved) { cvRestoreOriginal(d); return null; }
  return d as OverlayCvFinishedDrag; // moved: d.pos is set
}
document.addEventListener('mousedown', (e) => {
  if (!selectMode || editingEl || e.button !== 0) return;
  const el = e.target as OverlayStyledElement | null; // whatever was pressed: an HTML, SVG or MathML element
  if (!el || !el.closest || el.closest('[data-radial-ui]')) return;
  if (/^(html|body)$/i.test(el.tagName)) return;
  if (!canvasReorder) { cvHint = { el, x: e.clientX, y: e.clientY }; return; } // gesture off: remember the press so a real drag can point at Layers
  cvArm = { el, x: e.clientX, y: e.clientY };
}, true);
document.addEventListener('mousemove', (e) => {
  if (cvHint) {
    // A drag attempt while the gesture is off: once per page, tell the host so
    // it can point at (and open) the Layers panel. The element is not moved.
    if (Math.abs(e.clientX - cvHint.x) + Math.abs(e.clientY - cvHint.y) >= 7) {
      const el = cvHint.el; cvHint = null;
      if (!cvHintShown) { cvHintShown = true; try { ipcRenderer.sendToHost('radial:canvas-drag-blocked', { selector: cssPath(el) }); } catch {} }
    }
    return;
  }
  if (!cvArm && !cvDrag) return;
  if (cvArm && !cvDrag) {
    if (Math.abs(e.clientX - cvArm.x) + Math.abs(e.clientY - cvArm.y) < 7) return;
    const el = cvArm.el; cvArm = null;
    // DOM order can't place these — say so instead of faking a drop.
    const why = cvOutOfFlow(el) ? 'positioned' : cvGridPlaced(el) ? 'grid-placed' : null;
    if (why) { try { ipcRenderer.sendToHost('radial:canvas-drag-blocked', { selector: cssPath(el), reason: why }); } catch {} return; }
    cvDrag = { el, prevOpacity: el.style.opacity, prevPE: el.style.pointerEvents, origParent: el.parentNode, origNext: el.nextSibling, container: null, ref: null, pos: null, axis: null, key: 'orig' };
    el.style.opacity = '0.35';
    el.style.pointerEvents = 'none'; // hit-testing sees through the lifted element; it still holds its slot's space
    insEls();
  }
  if (!cvDrag) return;
  e.preventDefault();
  const d = cvDrag;
  if (cvAnims.some((a) => a.playState === 'running')) { cvIndicate(d); return; } // let the reflow settle before re-slotting
  const c = cvResolve(e.clientX, e.clientY, d.el);
  if (!c) { cvIndicate(d); return; } // over nothing droppable: keep the current placement
  const slot = cvSlot(c, e.clientX, e.clientY, d.el);
  const key = slot.pos === 'inside' ? 'in:' + cvId(c) : slot.pos + ':' + cvId(slot.ref);
  if (window.__cvTrace) window.__cvTrace.push({ x: e.clientX, y: e.clientY, c: cvName(c), ref: slot.ref && cvName(slot.ref), pos: slot.pos, axis: slot.axis, boundary: slot.boundary, key, cur: d.key });
  if (key === d.key) { cvIndicate(d); return; }
  // Hysteresis: a neighbor's center must be crossed by a margin, not grazed.
  if (slot.boundary != null && Math.abs((slot.axis === 'x' ? e.clientX : e.clientY) - slot.boundary) < 6) { cvIndicate(d); return; }
  const flip = cvFlipStart([d.el, ...(d.el.parentNode ? d.el.parentNode.children : []), ...c.children]);
  const pos = cvPlace(slot, d.el);
  if (pos == null) {
    cvRestoreOriginal(d); d.key = 'orig'; d.container = null; d.ref = null; d.pos = null; insClear();
    if (!d.orderHinted) { d.orderHinted = true; try { ipcRenderer.sendToHost('radial:canvas-drag-blocked', { selector: cssPath(d.el), reason: 'css-order' }); } catch {} }
    return;
  }
  d.container = c; d.ref = slot.ref; d.pos = pos; d.axis = slot.axis; d.key = key;
  if (window.__cvTrace) window.__cvTrace.push({ placed: pos, ref: slot.ref && cvName(slot.ref), order: [...(d.el.parentNode ? d.el.parentNode.children : [])].map((k) => k.id || k.tagName).join('') });
  cvFlipEnd(flip);
  cvIndicate(d);
  cvLabel(c !== d.origParent ? 'into ' + cvName(c) : null, e.clientX, e.clientY);
}, true);
document.addEventListener('mouseup', () => {
  cvArm = null; cvHint = null;
  if (!cvDrag) return;
  const fin = cvEnd(false);
  if (!fin) return;
  cvSuppressClick = true;
  // The source scanner sees the PRE-move tree: restore it for one frame,
  // capture both payloads, then re-apply the final arrangement (no paint between).
  cvRestoreOriginal(fin);
  const subject = captureSelection(fin.el, { enrich: false });
  const target = captureSelection(fin.pos === 'inside' ? fin.container! : fin.ref!, { enrich: false }); // a finished move has its slot
  cvApplyFinal(fin);
  ipcRenderer.sendToHost('radial:canvas-move', { subject, target, position: fin.pos }); // cvEnd returns only a drag that moved, which has its slot
}, true);
document.addEventListener('click', (e) => {
  if (cvSuppressClick) { cvSuppressClick = false; e.preventDefault(); e.stopPropagation(); }
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && cvDrag) { e.stopPropagation(); cvEnd(true); }
}, true);

function gatherMeta(): import('../shared/overlayMessages').PageMeta {
  const attr = (sel: string, a = 'content') => { const el = document.querySelector(sel); return el ? el.getAttribute(a) : null; };
  return {
    title: document.title || null,
    description: attr('meta[name="description"]'),
    canonical: attr('link[rel="canonical"]', 'href'),
    robots: attr('meta[name="robots"]'),
    viewport: attr('meta[name="viewport"]'),
    themeColor: attr('meta[name="theme-color"]'),
    lang: document.documentElement.getAttribute('lang'),
    favicon: attr('link[rel~="icon"]', 'href') || attr('link[rel="shortcut icon"]', 'href'),
    ogTitle: attr('meta[property="og:title"]'),
    ogDescription: attr('meta[property="og:description"]'),
    ogImage: attr('meta[property="og:image"]'),
    ogType: attr('meta[property="og:type"]'),
    twitterCard: attr('meta[name="twitter:card"]'),
    twitterTitle: attr('meta[name="twitter:title"]'),
    twitterImage: attr('meta[name="twitter:image"]'),
    ogImageAlt: attr('meta[property="og:image:alt"]'),
    twitterImageAlt: attr('meta[name="twitter:image:alt"]'),
    bodyText: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 4000),
  };
}

let metaReportTimer: ReturnType<typeof setTimeout> | null = null;
function sendMeta() { ipcRenderer.sendToHost('radial:meta', gatherMeta()); }
function scheduleMetaReport(delay = 40) {
  clearTimeout(metaReportTimer as ReturnType<typeof setTimeout> | undefined); // null is a no-op; the timer types leave it out
  metaReportTimer = setTimeout(() => { metaReportTimer = null; sendMeta(); }, delay);
}
// Next, React Helmet, and similar tools commonly update title/meta after they
// change history. Observe only <head>, debounce, and keep the chrome aligned
// with the live page without reacting to normal body mutations.
function watchMeta() {
  if (!document.head || !window.MutationObserver) return;
  const observer = new MutationObserver(() => scheduleMetaReport());
  observer.observe(document.head, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['content', 'href'],
  });
}

// Fetch the favicon from the site (same-origin here) and hand it to the host as
// a data URL — avoids cross-origin/CSP/port issues loading it in the host.
async function sendFavicon() {
  const link = document.querySelector('link[rel~="icon"]') || document.querySelector('link[rel="shortcut icon"]');
  const href = (link && link.getAttribute('href')) || '/favicon.ico'; // an icon link with no href points nowhere: use the default too
  try {
    const res = await fetch(new URL(href, location.href).href);
    if (!res.ok) return;
    const blob = await res.blob();
    const reader = new FileReader();
    reader.onload = () => ipcRenderer.sendToHost('radial:favicon', reader.result as string); // readAsDataURL's load result is a string (the data URL)
    reader.readAsDataURL(blob);
  } catch {}
}

window.addEventListener('DOMContentLoaded', () => {
  injectStyles();
  ipcRenderer.sendToHost('radial:loaded', { url: location.href, title: document.title });
  sendMeta();
  watchMeta();
  sendFavicon();
});

// --- Next.js dev indicator ---------------------------------------------------
// Next 15/16 mounts a floating dev-tools button inside <nextjs-portal>'s
// shadow root, out of reach of the stylesheet above. Pierce each portal and
// hide the indicator ONLY — the error overlay sharing that portal stays
// (build errors must keep showing). Same "embedded preview only" contract as
// the Astro rule: "Open in your browser" keeps the toolbars.
let radialShowToolbars = false; // hidden by default; Radial Settings can turn them on
(function radialHideNextIndicator() {
  const CSS = '[data-nextjs-dev-tools-button], [data-next-badge-root], [data-next-badge], #next-logo { display: none !important; }';
  function pierce(el: Element, attempt?: number) {
    try {
      if (!el || radialShowToolbars) return;
      if (!el.shadowRoot) { if ((attempt || 0) < 5) setTimeout(() => pierce(el, (attempt || 0) + 1), 250); return; }
      if (el.shadowRoot.getElementById('__radial_next_hide')) return;
      const st = document.createElement('style');
      st.id = '__radial_next_hide';
      st.textContent = CSS;
      el.shadowRoot.appendChild(st);
    } catch {}
  }
  function sweep() { try { document.querySelectorAll('nextjs-portal').forEach((el) => pierce(el, 0)); } catch {} }
  function arm() {
    injectStyles(); // the stylesheet half (Astro + legacy Next) on plain loads too
    sweep();
    try { new MutationObserver(sweep).observe(document.body, { childList: true }); } catch {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arm, { once: true });
  else arm();

  // Radial Settings → Preview → Framework dev toolbars. On: lift the
  // stylesheet rules (class on <html>) and pull the shadow styles back out.
  ipcRenderer.on('radial:dev-toolbars', (_e: OverlayHostEvent, show: boolean) => {
    radialShowToolbars = !!show;
    try {
      document.documentElement.classList.toggle('__radial-toolbars-on', radialShowToolbars);
      document.querySelectorAll('nextjs-portal').forEach((el) => {
        const st = el.shadowRoot && el.shadowRoot.getElementById('__radial_next_hide');
        if (st && radialShowToolbars) st.remove();
      });
      if (!radialShowToolbars) sweep();
    } catch {}
  });
})();

// Remember the page position for the active terminal thread without polling.
let threadScrollFrame = 0;
function reportThreadScroll() {
  if (threadScrollFrame) return;
  threadScrollFrame = requestAnimationFrame(() => {
    threadScrollFrame = 0;
    ipcRenderer.sendToHost('radial:viewport-scroll', { url: location.href, x: scrollX, y: scrollY });
  });
}
window.addEventListener('scroll', reportThreadScroll, { passive: true });
window.addEventListener('pageshow', reportThreadScroll);
