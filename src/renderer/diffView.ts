/* global window, document */
'use strict';

window.RadialDiffs = (() => {
  let library: Promise<DiffsBundle> | undefined;
  let layout: 'unified' | 'split' = 'unified';
  try { if (localStorage.getItem('radial.diff-layout') === 'split') layout = 'split'; } catch {}
  const views = new Map<HTMLElement, DiffViewState>();
  const theme = () => document.documentElement.classList.contains('light') ? 'light' : 'dark';
  // vendor/diffs/diffs.js is @pierre/diffs's File, FileDiff and parsePatchFiles, bundled (scripts/build-diffs.mts).
  // tsc reads the minified bundle as plain JavaScript and can't see its types through it.
  const load = (): Promise<DiffsBundle> => library ||= import('./vendor/diffs/diffs.js') as unknown as Promise<DiffsBundle>;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string | null, className?: string): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  };

  function clear(root: HTMLElement): void {
    for (const [host, view] of views) {
      if (host === root || root.contains(host)) { view.instance?.cleanUp(); views.delete(host); }
    }
  }

  function setLayout(value: 'unified' | 'split'): void {
    layout = value;
    try { localStorage.setItem('radial.diff-layout', value); } catch {}
    for (const view of views.values()) {
      for (const button of view.buttons) button.setAttribute('aria-pressed', String(button.dataset.layout === value));
      if (view.instance && view.isDiff) {
        // A diff view's instance is a FileDiff (render makes one when isDiff).
        (view.instance as DiffsFileDiff).setOptions({ ...(view.instance as DiffsFileDiff).options, diffStyle: value });
        view.instance.rerender();
      }
    }
  }

  async function render(host: HTMLElement, data: LooseUnion<DiffViewData>): Promise<void> {
    clear(host);
    const view: DiffViewState = { instance: null, buttons: [], isDiff: data.kind !== 'file' };
    views.set(host, view);
    host.className = 'radial-diff-view';
    host.replaceChildren();
    const notice = node('p', 'Loading diff…', 'collab-note');
    notice.setAttribute('role', 'status');
    host.append(notice);
    const raw = data.patch ?? data.newFile?.contents ?? data.file?.contents ?? '';
    if (raw.length > 2 * 1024 * 1024 || raw.split('\n').length > 15000) {
      notice.textContent = 'This file is too large for the inline viewer. Open it in your editor or on GitHub to review the full contents.';
      return;
    }
    try {
      const { FileDiff, File, parsePatchFiles } = await load();
      if (views.get(host) !== view) return;
      let fileDiff;
      if (data.kind === 'patch') {
        if (!data.patch) { notice.textContent = 'No text changes.'; return; }
        // GitHub's per-file patch contains only hunks. Parse them with neutral
        // headers, then supply the real names as metadata, never as patch syntax.
        const patch = data.hunksOnly ? `--- a/file\n+++ b/file\n${data.patch.endsWith('\n') ? data.patch : data.patch + '\n'}` : data.patch;
        const files = parsePatchFiles(patch, undefined, true).flatMap(patch => patch.files);
        if (files.length !== 1) throw new Error('Expected one file patch.');
        fileDiff = files[0];
        if (data.name) fileDiff.name = data.name;
        if (data.hunksOnly) fileDiff.prevName = data.previousName || data.name;
        if (data.previousName) fileDiff.prevName = data.previousName;
        if (data.status === 'added') fileDiff.type = 'new';
        if (data.status === 'removed') fileDiff.type = 'deleted';
      }
      notice.remove();
      if (view.isDiff) {
        const toolbar = node('div', null, 'radial-diff-toolbar');
        toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', 'Diff layout');
        for (const [value, label] of [['unified', 'Unified'], ['split', 'Split']] as const) {
          const button = node('button', label, 'btn'); button.type = 'button'; button.dataset.layout = value;
          button.setAttribute('aria-pressed', String(layout === value));
          button.onclick = () => setLayout(value);
          view.buttons.push(button); toolbar.append(button);
        }
        host.append(toolbar);
      }
      const content = node('div', null, 'radial-diff-content');
      content.tabIndex = 0;
      content.setAttribute('role', 'region');
      content.setAttribute('aria-label', `${view.isDiff ? 'Changes in' : 'Contents of'} ${data.name || data.file?.name || data.newFile?.name || data.oldFile?.name || 'file'}`);
      host.append(content);
      const options: DiffsViewOptions = {
        theme: { light: 'pierre-light', dark: 'pierre-dark' }, themeType: theme(),
        preferredHighlighter: 'shiki-js', diffStyle: layout, diffIndicators: 'classic',
        overflow: 'wrap', lineDiffType: 'word-alt', hunkSeparators: 'metadata',
        onPostRender: (_node: HTMLElement, _instance: unknown, phase: string) => { if (phase !== 'unmount') host.dataset.rendered = 'true'; },
      };
      view.instance = view.isDiff ? new FileDiff(options) : new File(options);
      // fileDiff comes from a patch, which is a diff; only kind 'file' makes a File.
      // A patch always has fileDiff here (or returned or threw above), so a diff
      // without one is kind 'files', and a view that isn't a diff is kind 'file'.
      if (fileDiff) (view.instance as DiffsFileDiff).render({ fileDiff, containerWrapper: content });
      else if (view.isDiff) (view.instance as DiffsFileDiff).render({ oldFile: (data as DiffViewFiles).oldFile, newFile: (data as DiffViewFiles).newFile, containerWrapper: content });
      else (view.instance as DiffsFile).render({ file: (data as DiffViewSingleFile).file, containerWrapper: content });
    } catch {
      if (views.get(host) !== view) return;
      view.instance?.cleanUp(); view.instance = null;
      host.replaceChildren(node('p', 'The formatted view is unavailable. Showing the source below.', 'collab-note'), node('pre', raw, 'collab-diff'));
    }
  }

  new MutationObserver(() => { for (const view of views.values()) view.instance?.setThemeType(theme()); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('beforeunload', () => clear(document.body));
  return { render, clear };
})();
