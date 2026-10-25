
/** agent: each thread keeps its own preview view; shared: one view for all of them. */
export type PreviewMode = 'agent' | 'shared';
/** The preview's viewport choice (renderer.ts sets only these on a tab). */
export type ViewportMode = 'responsive' | 'locked' | 'tablet' | 'mobile' | 'custom';
/** The preview's view as the window saves it per thread (renderer.js readThreadPreview).
 *  Saved records can predate a field, so only the route is always there; the
 *  window's restore falls back for each missing one. This module owns the
 *  shape: pty meta, slept agents, chats and projectState.sharedPreview store it. */
export interface PreviewView {
  route: string;
  scroll?: { x: number; y: number };
  viewportMode?: ViewportMode;
  width?: number;
  zoom?: number;
  visualZoom?: number;
  panX?: number;
  panY?: number;
}
/** A thread (agent terminal or chat) that owns a saved view of the preview. */
export interface PreviewOwner<View> { preview?: View | null; previewSelectedAt?: number }
export interface ThreadPreviewOptions<View, Term extends PreviewOwner<View>> {
  /** The view on screen now. */
  read: () => View;
  /** Show a saved view; `current()` turns false once a newer restore started. */
  restore: (view: View, current: () => boolean) => Promise<void> | void;
  /** Save a thread's view. */
  persist: (term: Term) => void;
  mode?: PreviewMode;
  sharedPreview?: View | null;
  persistShared?: (view: View) => void;
}
export interface ThreadPreview<Term> {
  save(): void;
  select(term: Term): Promise<void>;
  setMode(next: PreviewMode): Promise<void>;
  readonly mode: PreviewMode;
  readonly restoring: boolean;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function create<View, Term extends PreviewOwner<View>>({ read, restore, persist, mode = 'agent', sharedPreview = null, persistShared = () => {} }: ThreadPreviewOptions<View, Term>): ThreadPreview<Term> {
  let owner: Term | null = null;
  let version = 0;
  let selectedAt = 0;
  let restoring = false;
  let pending = Promise.resolve();
  function save() {
    if (!owner || restoring) return;
    const view = read();
    if (mode === 'shared') {
      if (JSON.stringify(sharedPreview) !== JSON.stringify(view)) {
        sharedPreview = copy(view);
        persistShared(sharedPreview);
      }
      return;
    }
    if (JSON.stringify(owner.preview) === JSON.stringify(view)) return;
    owner.preview = copy(view);
    persist(owner);
  }
  function restoreView(view: View) {
    const ticket = ++version;
    restoring = true;
    const current = () => ticket === version;
    pending = Promise.resolve().then(() => {
      if (current()) return restore(copy(view), current);
    }).finally(() => { if (current()) restoring = false; });
    return pending;
  }
  function select(term: Term) {
    if (owner === term) return pending;
    save();
    const inherited = copy(owner?.preview || read());
    const first = !owner;
    owner = term;
    term.previewSelectedAt = selectedAt = Math.max(Date.now(), selectedAt + 1);
    if (mode === 'shared') {
      persist(term);
      return first && sharedPreview ? restoreView(sharedPreview) : pending;
    }
    const adoptsVisiblePage = first && !term.preview;
    if (!term.preview) term.preview = inherited;
    persist(term);
    // The first new agent already owns the visible page. Navigating it again
    // can dismiss a selection or draft the user opened while the agent booted.
    return adoptsVisiblePage ? pending : restoreView(term.preview);
  }
  async function setMode(next: PreviewMode) {
    if (!['agent', 'shared'].includes(next) || next === mode) return;
    await pending;
    save();
    mode = next;
    if (mode === 'shared') {
      sharedPreview = copy(read());
      persistShared(sharedPreview);
    } else if (owner) {
      const term = owner; owner = null;
      await select(term);
    }
  }
  return { save, select, setMode, get mode() { return mode; }, get restoring() { return restoring; } };
}
export { create };
