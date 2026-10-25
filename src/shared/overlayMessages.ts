// The messages between the site preview's overlay (src/overlay/overlay.ts, the
// <webview> preload that runs inside the page being edited) and Radial's window
// (renderer.ts handleWebviewMessage): what the overlay sends with
// ipcRenderer.sendToHost, and what the window sends it with webview.send.
// Types only. The overlay is a classic script, so it reaches these through
// import() type queries; the window's type-check includes src/shared. No DOM
// types here: the main process's type-check reads src/shared too.
//
// A selection is also an ElementContext: the window hands it to main's source
// resolvers as is (wrapElement's subject, an insert's anchor, a move's subject
// and target), so the overlay's shapes extend radialApi's contracts.

import type { ContentField, ElementContext, ElementPathLevel, InsertPosition, ReviewComment, TextEdit } from './radialApi';
import type { MediaStyleRule, StyleRule, StyleSource } from '../renderer/adjustDirect';

// ── What the overlay reads from the page ──

/** One level of an element's DOM ancestor path, element first (overlay.ts buildStructuralPath sets every field). */
export interface StructuralPathLevel extends ElementPathLevel {
  /** The element's classes, minus Radial's own radial-* markers. */
  cls: string[];
  /** The element's own direct text, whitespace collapsed, at most 60 characters. */
  own: string;
  /** Its slot among same-tag siblings (nth), and how many there are (cnt). */
  nth: number;
  cnt: number;
  /** Same-tag siblings (itself included) with exactly its class set. */
  twins: number;
  src: string | null;
  href: string | null;
  alt: string | null;
  ariaLabel: string | null;
  placeholder: string | null;
}

/** The same inside an @media block: readStyleSource always sets both px bounds, null when the query has none. */
export interface StyleSourceMediaRule extends MediaStyleRule {
  maxW: number | null;
  minW: number | null;
}
/** Where a selected element's adjustable properties come from (overlay.ts readStyleSource): adjustDirect's StyleSource with every field set. */
export interface StyleSourceReadout extends StyleSource {
  /** The full stylesheet walk ran. */
  _full: true;
  styleAttr: string;
  rules: StyleRule[];
  /** The element or a near ancestor carries Tailwind utility classes. */
  tw: boolean;
  mediaRules: StyleSourceMediaRule[];
  /** The max-width breakpoints the site's own @media blocks use, ascending. */
  breakpoints: number[];
  viewportW: number;
  rootPx: number;
}

/** The page-wide scans, once per page load (overlay.ts pageScans). */
export interface PageScanResult {
  /** Every distinct font size the page renders, ascending. */
  typeScale: number[];
  /** The page's most-used colors, most-used first. */
  palette: string[];
}

/** A box-shadow placed on the steppers' ladder by its blur radius. */
export type AdjustShadowStep = 'none' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
/** The computed values the quick-edit pill and the Design panel seed from (overlay.ts readAdjust): px as numbers, the rest as computed strings. */
export interface AdjustReadout {
  paddingTop: number; paddingRight: number; paddingBottom: number; paddingLeft: number;
  marginTop: number; marginRight: number; marginBottom: number; marginLeft: number;
  fontSize: number;
  fontWeight: number;
  gap: number;
  radius: number;
  hasBg: boolean;
  hasBorder: boolean;
  textAlign: string;
  display: string;
  flexDirection: string;
  justifyContent: string;
  alignItems: string;
  /** A ratio of the font size. */
  lineHeight: number;
  /** In em. */
  letterSpacing: number;
  textTransform: string;
  color: string;
  bgColor: string;
  /** 0 to 100. */
  opacity: number;
  borderWidth: number;
  shadow: AdjustShadowStep;
  /** 0 when there is none. */
  maxWidth: number;
  position: string;
  /** null where the side is auto. */
  insetTop: number | null; insetRight: number | null; insetBottom: number | null; insetLeft: number | null;
  zIndex: number;
  rotate: number;
  width: number; height: number;
  flexWrap: string;
  borderStyle: string;
  borderColor: string;
  boxShadowRaw: string;
  overflow: string;
  fontFamily: string;
  fontStyle: string;
  textDecoration: string;
  backgroundImage: string;
  backgroundSize: string;
  backgroundRepeat: string;
  radiusTL: number; radiusTR: number; radiusBR: number; radiusBL: number;
  bwTop: number; bwRight: number; bwBottom: number; bwLeft: number;
  minWidth: number; minHeight: number; maxHeight: number;
  /** '' when auto. */
  aspectRatio: string;
  objectFit: string;
  /** The parent's display, '' without a parent. */
  parentDisplay: string;
  alignSelf: string;
  flexGrow: number;
  flexShrink: number;
  flexBasis: string;
  order: number;
  /** '' when none. */
  translate: string;
  scale: number;
  filterRaw: string;
  backdropRaw: string;
  blend: string;
  /** The page's font families, most-used first. */
  fonts: string[];
}

/** The kind of a page element, for the Layers panel's type icons (overlay.ts layerKind). */
export type LayerKind = 'heading' | 'text' | 'img' | 'link' | 'btn' | 'list' | 'form' | 'media' | 'section' | 'grid' | 'flex' | 'box';
/** A box in the preview's viewport coordinates, in CSS px. */
export interface ViewportRect { x: number; y: number; w: number; h: number }

/** The selected element's parent signature, for locating elements with no needle of their own. */
export interface CapturedParent { tagName: string; id: string | null; classList: string[]; text: string }
/** Everything the window learns about a clicked element (overlay.ts captureSelection): the payload of every selection message. */
export interface CapturedSelection extends ElementContext {
  selector: string;
  tagName: string;
  /** The layer kind, for the Layers panel's type icons. */
  k: LayerKind;
  id: string | null;
  classList: string[];
  /** Its text, at most 240 characters. */
  text: string;
  html: string;
  /** The nearest preceding heading's text, null when there is none. */
  heading: string | null;
  href: string | null;
  src: string | null;
  alt: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  parent: CapturedParent | null;
  nthOfTag: number;
  tagSiblings: number;
  path: StructuralPathLevel[];
  rect: ViewportRect;
  url: string;
  adjust: AdjustReadout;
  /** The overlay sets true when radial:select-enrich will follow with the provenance (not on enrich: false captures); the window sets false once it lands. */
  pendingEnrich?: boolean;
  /** How long the capture took, in ms, and when it finished (Date.now()). */
  captureMs: number;
  capturedAt: number;
  /** Never in the capture: the stylesheet walk follows on radial:select-enrich. */
  styleSource?: undefined;
}
/** What an inline text edit sends about its element (overlay.ts captureContext). */
export interface CapturedEditContext extends ElementContext {
  tagName: string;
  classList: string[];
  id: string | null;
  /** Its index among leaf elements with the same text; -1 when it isn't one (mixed content, or the text changed). */
  occurrenceIndex: number;
  nearbyText: string[];
  path: StructuralPathLevel[];
}

// ── Overlay → window (sendToHost) ──
// radial:edit carries radialApi's TextEdit (context: a CapturedEditContext);
// radial:inspect-element and radial:delete-element carry a CapturedSelection.

/** radial:select-element: a selection, and whether ⇧ added it to the current one. */
export interface SelectElementPayload extends CapturedSelection { additive: boolean }
/** radial:comment-target: the element a comment anchors to, and the click point inside it as 0..1 fractions of its box. */
export interface CommentTargetPayload extends CapturedSelection { offsetX: number; offsetY: number }
/** radial:select-enrich: the heavy provenance that follows a selection on idle, matched to it by selector. */
export interface SelectEnrichPayload extends PageScanResult {
  selector: string;
  styleSource: StyleSourceReadout;
  enrichMs: number;
}
/** radial:editing: an inline text edit started or ended (the window routes ⌘Z into it while active). */
export interface InlineEditingState { active: boolean }
/** radial:edit-link: the hovered link's Edit link badge was clicked. */
export interface EditLinkRequest {
  href: string | null;
  /** The link's text, at most 80 characters. */
  text: string;
  context: ElementContext & { tagName: 'a'; attribute: 'href'; classList: string[]; id: string | null };
}
/** radial:image-click: an image was clicked (Text tool) or double-clicked (Select) to swap it. */
export interface ImageClickRequest {
  src: string | null;
  context: ElementContext & { tagName: 'img'; classList: string[]; id: string | null; alt: string | null };
}
/** What changed the route: the history method the site called, or a back/forward. */
export type RouteCommitSource = 'pushState' | 'replaceState' | 'popstate';
/** radial:route-commit: the page's route changed without a document load. */
export interface RouteCommit {
  /** The radial:navigate request this commit completes, null when it isn't one (undefined when that request came without an id). */
  id: string | null | undefined;
  url: string;
  source: RouteCommitSource;
}
/** radial:navigate-result: whether the overlay found an in-page link for the route and clicked it. */
export interface NavigateResult {
  /** The request's id, echoed (undefined only when the request had none). */
  id: string | undefined;
  attempted: boolean;
}
/** radial:insert-target: where an Add-panel drag landed (its answer to radial:insert-drop): the element and the slot beside or inside it. */
export interface InsertTarget { anchor: CapturedSelection; position: InsertPosition }
/** radial:canvas-move: the overlay moved an element on the canvas: the element, the neighbour or parent it moved to, and where. */
export interface CanvasMove { subject: CapturedSelection; target: CapturedSelection; position: InsertPosition }
/** The canvas tools (the window's canvas mode): radial:tool-key sends the one a tool key (V, S, C, I, D, T, H) picks. */
export type CanvasToolMode = 'none' | 'select' | 'comment' | 'inspect' | 'draw' | 'text';

// The overlay's answers to the window's reads (radial:read-*, radial:resolve-style,
// radial:style-audit, radial:variants-scan), by the panel that asks.

/** One row of the Layers tree (radial:tree-result), body first at depth 0. */
export interface LayerTreeNode {
  selector: string;
  tag: string;
  k: LayerKind;
  /** Its first two classes, dot-joined, minus Radial's own radial-* markers. */
  cls: string;
  /** Its own text nodes' text, at most 24 characters. */
  text: string;
  depth: number;
}
/** radial:tree-result: the page's layer tree; the overlay always sends it whole. */
export interface PageTreeResult { full: true; nodes: LayerTreeNode[] }

/** A colour the style audit found in use, and where (radial:style-audit-result). */
export interface StyleAuditColor { css: string; role: 'text' | 'fill' | 'border' }
/** A text style the style audit found in use. */
export interface StyleAuditType { family: string; size: number; weight: string }
/** A corner radius or a flex/grid gap the style audit found in use. */
export interface StyleAuditDim { kind: 'radius' | 'gap'; value: number }
/** How many elements use a value the style audit found. */
export interface StyleAuditCount { count: number }
/** A colour custom property on :root or html: one of the site's colour tokens. */
export interface ColorToken { name: string; value: string; href: string | null; selector: string }
/** radial:style-audit-result: the colours, type and sizes a page (or a subtree) uses, counted, most-used first, and the site's colour tokens. */
export interface StyleAuditResult {
  /** The subtree's selector; '' for the whole page. */
  scope: string;
  colors: (StyleAuditColor & StyleAuditCount)[];
  type: (StyleAuditType & StyleAuditCount)[];
  dims: (StyleAuditDim & StyleAuditCount)[];
  tokens: ColorToken[];
}

/** The selection's first transition and animation (radial:motion-result); times in ms. */
export interface MotionReadout { transitionProperty: string; duration: number; delay: number; easing: string; animationName: string | null; animationDuration: number }
/** An image selection's geometry, weight and alt (radial:image-result). */
export interface ImageReadout {
  src: string;
  /** A small thumbnail the page drew, as a data URL; null when it couldn't. */
  thumb: string | null;
  naturalW: number;
  naturalH: number;
  renderedW: number;
  renderedH: number;
  /** What loading it transferred (its resource timing), in bytes; null when the page can't tell (a cached or cross-origin image). */
  bytes: number | null;
  alt: string | null;
  loading: string | null;
}
/** The selection's accessible name, role and contrast, and the page's heading and image counts (radial:a11y-result). */
export interface A11yReadout {
  tag: string;
  role: string | null;
  name: string | null;
  focusable: boolean;
  interactive: boolean;
  color: string;
  /** The nearest opaque background up the tree; white when there is none. */
  bg: string;
  fontSize: number;
  fontWeight: number;
  h1Count: number;
  headingSkips: number;
  imgsMissingAlt: number;
  imgCount: number;
}
/** One colour the selection's subtree renders, and how often (radial:selcolors-result); hex is upper-case. */
export interface ColorCount { css: string; hex: string; count: number }
/** A button style shared by a cluster of the page's buttons (radial:variants-scan). */
export interface ButtonSignature {
  bg: string; color: string; borderW: number; borderC: string; radius: number;
  fontSize: number; fontWeight: string; padV: number; padH: number; transform: string;
}
/** One button style as radial:variants-result sends it. */
export interface VariantCluster {
  /** JSON of the signature. */
  key: string;
  signature: ButtonSignature;
  count: number;
  /** One instance's selector. */
  sample: string;
  /** The classes every instance shares. */
  core: string[];
}
/** radial:variants-result: the page's button styles, most-used first, and the key of the one the scanned element has (null when it isn't one of the buttons). */
export interface VariantsResult { selector: string; clusters: VariantCluster[]; currentKey: string | null }
/** One Content-panel field (radial:fields-result): radialApi's ContentField, with an image's in-page thumbnail (null past the first 200 images, or when it can't be drawn) and whether the field sits inside the focus selection. */
export type ContentFieldReadout =
  | (Extract<ContentField, { kind: 'image' }> & { thumb: string | null; inFocus: boolean })
  | (Exclude<ContentField, { kind: 'image' }> & { inFocus: boolean });
/** The page's head tags and text (overlay.ts gatherMeta): radial:meta. */
export interface PageMeta {
  title: string | null;
  description: string | null;
  canonical: string | null;
  robots: string | null;
  viewport: string | null;
  themeColor: string | null;
  lang: string | null;
  favicon: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  ogType: string | null;
  twitterCard: string | null;
  twitterTitle: string | null;
  twitterImage: string | null;
  ogImageAlt: string | null;
  twitterImageAlt: string | null;
  /** The body's text, whitespace collapsed, at most 4000 characters. */
  bodyText: string;
}
/**
 * Where one property's computed value comes from (radial:style-source): an
 * inline style, the winning stylesheet rule, a rule through a CSS variable, or
 * not found. href is the stylesheet's path on the dev server, count how many
 * elements the rule matches. The '*anchor' entry is the element's best rule
 * whatever the property: a rule with no count or value.
 */
export type StyleOrigin =
  | { kind: 'inline' | 'unknown' }
  | { kind: 'rule'; selectorText: string; href: string | null; count?: number; value?: string }
  | {
    kind: 'var'; varName: string; selectorText: string; count: number; value: string; href: string | null;
    /** The variable's definition that applies here, and how many definitions exist anywhere (more than one: hands off). */
    defHref: string | null; defSelector: string | null; defValue: string | null; defCount: number;
  };

/**
 * What the overlay sends with each message, by channel: args[0] of the
 * <webview>'s ipc-message event (renderer.ts handleWebviewMessage). The
 * overlay's ipcRenderer.sendToHost is typed against it, so every send is
 * checked. The window's `|| {}` fallbacks are defensive and don't mean a field
 * can be missing. undefined: the message carries nothing.
 */
export interface OverlayToHostPayloads {
  'radial:navigate-result': NavigateResult;
  'radial:style-audit-result': StyleAuditResult;
  'radial:tree-result': PageTreeResult;
  'radial:motion-result': { selector: string; motion: MotionReadout };
  'radial:image-result': { selector: string; image: ImageReadout };
  'radial:a11y-result': { selector: string; a11y: A11yReadout };
  'radial:selcolors-result': { selector: string; colors: ColorCount[] };
  'radial:fields-result': { focus: string | null; fields: ContentFieldReadout[] };
  'radial:style-source': { selector: string; sources: Record<string, StyleOrigin> };
  'radial:variants-result': VariantsResult;
  'radial:meta': PageMeta;
  'radial:tool-key': CanvasToolMode;
  /** Token values as the page computes them, and true for each one an inline style sets. */
  'radial:tokens-result': { values: Record<string, string>; inline: Record<string, boolean> };
  /** A right-click on the page, at x, y in the page's viewport. */
  'radial:context-menu': { sel: CapturedSelection; x: number; y: number };
  'radial:pinch-zoom': { deltaY: number; x: number; y: number };
  'radial:pan': { dx: number; dy: number };
  'radial:route-commit': RouteCommit;
  'radial:viewport-scroll': { url: string; x: number; y: number };
  'radial:edit': TextEdit;
  /** The site's favicon as a data URL. */
  'radial:favicon': string;
  /** The device hotkey pressed. */
  'radial:device': '1' | '2' | '3';
  'radial:editing': InlineEditingState;
  'radial:delete-element': CapturedSelection;
  'radial:ruler-key': undefined;
  /** ⇧1/⇧0 fit, ⇧2 zoom to the selection: the key's code. */
  'radial:zoom-key': 'Digit0' | 'Digit1' | 'Digit2';
  /** Space pressed (true) or released (false), for the hand tool. */
  'radial:space-key': boolean;
  'radial:sheet-key': undefined;
  /** The landing slot of an insert drop, null when there is none. */
  'radial:insert-target': InsertTarget | null;
  'radial:add-key': undefined;
  'radial:canvas-move': CanvasMove;
  /** A canvas drag that DOM order can't place; the first hint of a drag carries no reason. */
  'radial:canvas-drag-blocked': { selector: string; reason?: 'positioned' | 'grid-placed' | 'css-order' };
  'radial:node-captured': { id: string; sel: CapturedSelection | null };
  'radial:insert-node-done': { id: string; ok: boolean };
  'radial:tree-dirty': undefined;
  'radial:edit-link': EditLinkRequest;
  'radial:image-click': ImageClickRequest;
  'radial:select-enrich': SelectEnrichPayload;
  'radial:select-element': SelectElementPayload;
  'radial:inspect-element': CapturedSelection;
  /** ⌥ pressed (true) or released (false). */
  'radial:quick-inspect': boolean;
  /** An empty object; the window reads nothing from it. */
  'radial:focus-ask': Record<string, never>;
  /** The window's radial:copy-node request, echoed, with the element's markup and text. */
  'radial:node-copy': CopyNodeRequest & { html: string; text: string };
  'radial:layer-step': { dir: 1 | -1 };
  'radial:select-cancel': undefined;
  'radial:comment-target': CommentTargetPayload;
  /** A comment pin was clicked: its comment, and where the pin is in the page's viewport. */
  'radial:comment-pin-click': { id: string; rect: ViewportRect };
  /** A comment pin was dragged onto an element (overlay.ts attachPinDrag): the element, and where the pin landed as 0..1 fractions of its box. */
  'radial:comment-move': { id: string; target: CapturedSelection; offsetX: number; offsetY: number };
  // Sent, but the window has no handler for these two.
  /** The overlay switched edit mode on or off (radial:set-edit-mode). */
  'radial:ready': { editMode: boolean };
  /** The page's document is ready (DOMContentLoaded): its URL and title. */
  'radial:loaded': { url: string; title: string };
}

// ── Window → overlay (webview.send) ──

/** radial:navigate: open a route through the site's own router; a transaction id and the route. */
export interface HostNavigateRequest { id: string; route: string }
/** radial:copy-node: an element (its CSS path) and which form of it goes to the clipboard (radial:node-copy answers). */
export interface CopyNodeRequest { selector: string; kind: 'text' | 'html' }
/** radial:select-parent: select the current selection's parent (the pill's up button), adding to the selection with ⇧. */
export interface SelectParentRequest { additive?: boolean }
/** radial:comment-pins: one pin per comment on the open route (renderer.ts sendCommentPins builds it from the ReviewComment). */
export type CommentPin = Pick<ReviewComment, 'id' | 'selector' | 'resolved' | 'offsetX' | 'offsetY' | 'alt' | 'selText'> & {
  /** The comment's text, cut to 140 characters (the pin's tooltip). */
  text: string;
  /** Legacy pin: a pixel offset from the element's corner (0 on every other pin). */
  dx: number;
  dy: number;
};
/** What a Content field sends with radial:set-text: a keystroke preview, a cancel (restore), or the commit. */
export type SetTextBody =
  | { restore: true; live?: undefined; text?: undefined }
  | { live: true; text: string; restore?: undefined }
  | { text: string; live?: undefined; restore?: undefined };
/** radial:set-text: the element (a CSS path) and what to do with its text. */
export type SetTextRequest = { selector: string } & SetTextBody;
/** The many requests that name one element by its CSS path (overlay.ts cssPath, a Layers row's data-layer). */
export interface SelectorRequest { selector: string }
/** radial:select-node: select an element; `light` is rapid layer-stepping (outline only, no capture). */
export interface SelectNodeRequest { selector: string; light?: boolean }
/** radial:adjust-preview: inline styles to try on the selection, by CSS property. */
export interface AdjustPreviewRequest { selector: string; styles: Record<string, string> }
/** radial:highlight: scroll to and flash a commented element; a synced Vercel comment adds its fallbacks (alt selectors, the selected text). */
export interface HighlightRequest { selector: string; alt?: string[]; text?: string }
/** radial:resolve-style: the properties to trace ('*anchor' asks for the element's best rule); radial:style-source answers. */
export interface ResolveStyleRequest { selector: string; props: string[] }
/** radial:style-audit: a subtree to audit, or (no selector) the whole page. */
export interface StyleAuditRequest { selector?: string }
/** radial:read-tree: the window always asks for the whole tree. */
export interface ReadTreeRequest { full: true }
/** radial:move-node: move an element (CSS paths) beside or into another, in the live page. */
export interface MoveNodeRequest { subject: string; target: string; position: InsertPosition }
/** radial:insert-node: put markup beside or into an element; the id comes back on radial:insert-node-done. */
export interface InsertNodeRequest { id: string; anchor: string; position: InsertPosition; markup: string }
/** radial:wrap-node: wrap an element in a new div, with the class main's write gave it. */
export interface WrapNodeRequest { subject: string; wrapperClass?: string }
/** radial:unwrap-node: lift an element's children out and drop the element. */
export interface UnwrapNodeRequest { subject: string }
/** radial:read-tokens: the custom properties (`--name`) to read off the root. */
export interface ReadTokensRequest { names: string[] }
/** radial:read-fields: `focus` is the selection whose fields light up (null for none). */
export interface ReadFieldsRequest { focus: string | null }
/** radial:insert-hover: the pointer as fractions of the viewport (zoom-proof). */
export interface InsertHoverRequest { fx: number; fy: number }
/** radial:capture-node: capture an element; the id comes back on radial:node-captured. */
export interface CaptureNodeRequest { id: string; selector: string }

/**
 * What the window sends with each message the overlay listens for, by
 * channel: webview.send's argument after the channel (types.d.ts RadialWebview
 * types send against it, and overlay.ts its ipcRenderer.on). undefined: the
 * message carries nothing. The overlay's `= {}` defaults and `p &&` checks are
 * defensive and don't mean a field can be missing.
 */
export interface HostToOverlayPayloads {
  // Modes and settings.
  'radial:set-edit-mode': boolean;
  'radial:set-select-mode': boolean;
  'radial:set-comment-mode': boolean;
  'radial:set-inspect-mode': boolean;
  /** ⌥ held (true) or released (false) in the window. */
  'radial:quick-inspect': boolean;
  /** The preview's scale (locked-aspect fit, device down-scale). */
  'radial:set-preview-scale': number;
  /** The canvas is zoomed in: forward plain two-finger swipes as pans. */
  'radial:set-zoomed': boolean;
  'radial:set-animations-paused': boolean;
  'radial:set-canvas-reorder': boolean;
  'radial:dev-toolbars': boolean;
  'radial:reveal-empty': boolean;
  // Navigation and inline editing.
  'radial:navigate': HostNavigateRequest;
  'radial:undo': undefined;
  'radial:redo': undefined;
  'radial:set-text': SetTextRequest;
  // The selection.
  'radial:select-node': SelectNodeRequest;
  'radial:select-parent': SelectParentRequest;
  'radial:clear-selected': undefined;
  'radial:hover-node': SelectorRequest;
  'radial:unhover-node': undefined;
  'radial:capture-node': CaptureNodeRequest;
  'radial:adjust-preview': AdjustPreviewRequest;
  'radial:adjust-revert': undefined;
  'radial:adjust-forget': undefined;
  'radial:replay-animation': SelectorRequest;
  // Reads (the overlay answers on the radial:*-result channels).
  'radial:read-tree': ReadTreeRequest;
  'radial:resolve-style': ResolveStyleRequest;
  'radial:read-motion': SelectorRequest;
  'radial:read-image': SelectorRequest;
  'radial:read-a11y': SelectorRequest;
  'radial:read-selcolors': SelectorRequest;
  'radial:read-tokens': ReadTokensRequest;
  'radial:read-fields': ReadFieldsRequest;
  'radial:style-audit': StyleAuditRequest;
  'radial:variants-scan': SelectorRequest;
  // Optimistic structural edits in the live page (main writes the source).
  'radial:delete-node': SelectorRequest;
  'radial:restore-node': SelectorRequest;
  'radial:move-node': MoveNodeRequest;
  'radial:insert-node': InsertNodeRequest;
  'radial:wrap-node': WrapNodeRequest;
  'radial:unwrap-node': UnwrapNodeRequest;
  'radial:copy-node': CopyNodeRequest;
  // The Add panel's drag.
  'radial:insert-hover': InsertHoverRequest;
  'radial:insert-drop': undefined;
  'radial:insert-cancel': undefined;
  // Comments.
  'radial:comment-pins': CommentPin[];
  'radial:highlight': HighlightRequest;
}

/** What follows a message's channel in a send: nothing for an undefined payload, else the one payload. */
export type MessageArgs<P> = [P] extends [undefined] ? [] : [P];
