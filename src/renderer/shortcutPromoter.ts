(function () {
  'use strict';
  const storageKey = 'radial.shortcutHints';
  const hintDuration = 10000;
  const mac = navigator.platform.includes('Mac');
  const selectors: [selector: string, id: string][] = [
    ['#publishBtn, #navPublish', 'publish'],
    ['#pagesBtn', 'pages'],
    ['[data-rt="terminal"]', 'terminal'],
    ['[data-rt="comments"]', 'comments'],
    ['#navFocus', 'preview'],
    ['#navReload', 'reload-preview'],
    ['#navBack', 'back'], ['#navFwd', 'forward'],
    ['#tsShot', 'screenshot'],
  ];
  const toolLabels: Record<CanvasToolMode, string> = { none: 'Browse', select: 'Select elements', text: 'Edit text', comment: 'Comment', inspect: 'Inspect styles', draw: 'Draw' };
  let state: { enabled: boolean; shown: Record<string, number> } = { enabled: true, shown: {} };
  try {
    // What persist() saved; a missing key parses as null.
    const saved = JSON.parse(localStorage.getItem(storageKey) as string) as { enabled?: boolean; shown?: Record<string, number> } | null;
    if (saved) state = { enabled: saved.enabled !== false, shown: saved.shown || {} };
  } catch { /* Storage can be unavailable; hints remain optional. */ }
  let bindings: Partial<Record<string, ShortcutBinding>> = {}, card: HTMLDivElement | null = null, timer: TimerId | null = null, lastShown = -Infinity;
  function persist() { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch {} }
  function format(accelerator: string): string {
    const parts = accelerator.split('+').map(key => {
      if (/^(CmdOrCtrl|CommandOrControl)$/.test(key)) return mac ? '⌘' : 'Ctrl';
      return ({ Shift: mac ? '⇧' : 'Shift', Alt: mac ? '⌥' : 'Alt', Command: '⌘', Cmd: '⌘', Control: 'Ctrl', Ctrl: 'Ctrl', Return: '↵', Enter: '↵', Plus: '+', Space: 'Space' } as Record<string, string>)[key] || key;
    });
    return parts.join(mac ? '' : '+');
  }
  async function refresh() {
    try { bindings = await window.radial.shortcutBindings(); } catch { bindings = {}; }
  }
  function hide() {
    clearTimeout(timer);
    card?.remove(); card = null;
  }
  function setEnabled(enabled: boolean): void {
    state.enabled = enabled;
    persist();
    if (!enabled) hide();
    const control = document.getElementById('shortcutHintsEnabled') as HTMLInputElement | null;
    if (control) control.checked = enabled;
  }
  function show(id: string, binding: ShortcutBinding): void {
    const now = Date.now();
    const token = id + ':' + binding.accelerator;
    if (!state.enabled || now - lastShown < 30000 || (state.shown[token] || 0) >= 3) return;
    // Existing feedback and update notices take priority. Hints are never queued.
    if (document.querySelector('.toast.show, #updateCard.show') || document.getElementById('settingsView')?.checkVisibility()) return;
    hide();
    lastShown = now;
    state.shown[token] = (state.shown[token] || 0) + 1;
    persist();
    card = document.createElement('div');
    card.className = 'shortcut-hint';
    card.innerHTML = '<div class="shortcut-hint-copy" role="status"><span class="shortcut-hint-title"></span><span class="shortcut-hint-next">Next time <kbd></kbd></span></div><button type="button" class="shortcut-hint-close" aria-label="Dismiss shortcut hint">×</button><button type="button" class="shortcut-hint-off">Turn off hints</button>';
    card.querySelector('.shortcut-hint-title')!.textContent = binding.label;
    card.querySelector('kbd')!.textContent = format(binding.accelerator);
    card.querySelector<HTMLButtonElement>('.shortcut-hint-off')!.onclick = () => setEnabled(false);
    card.querySelector<HTMLButtonElement>('.shortcut-hint-close')!.onclick = hide;
    card.addEventListener('pointerenter', () => clearTimeout(timer));
    card.addEventListener('pointerleave', () => { timer = setTimeout(hide, hintDuration); });
    card.addEventListener('focusin', () => clearTimeout(timer));
    card.addEventListener('focusout', () => { timer = setTimeout(hide, hintDuration); });
    document.body.appendChild(card);
    timer = setTimeout(hide, hintDuration);
  }
  document.addEventListener('click', event => {
    if (!event.isTrusted || event.detail === 0 || event.button !== 0 || !state.enabled) return;
    const button = (event.target as Element).closest('button');
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    if (typeof activeTab !== 'function' || !activeTab()) return;
    let id: string | undefined, binding: ShortcutBinding | undefined;
    if (button.matches('.bn-tool[data-mode]')) {
      if (button.classList.contains('active')) return;
      const mode = button.dataset.mode!; // it matched [data-mode]
      const key = Object.keys(window.RadialToolKeys).find(k => window.RadialToolKeys[k] === mode);
      if (!key) return;
      id = 'tool-' + mode;
      binding = { label: toolLabels[mode as CanvasToolMode], accelerator: key.toUpperCase() }; // the tool key found above has this mode
    } else {
      id = selectors.find(([selector]) => button.matches(selector))?.[1];
      // No matching selector looks up 'undefined', which no binding has.
      binding = bindings[id as string];
      if (button.matches('[data-rt].active')) return;
    }
    if (binding) queueMicrotask(() => show(id!, binding)); // a binding was found by id
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); }, true);
  window.addEventListener('blur', hide);
  window.radial.onShortcutMenuUsed(({ id, binding }) => {
    const globalAction = ['open-project', 'open-folder', 'open-github', 'command-palette', 'projects-sidebar'].includes(id);
    if (binding?.accelerator && (globalAction || (typeof activeTab === 'function' && activeTab()))) show(id, binding);
  });
  window.radial.onShortcutBindingsChanged(refresh);
  refresh();
  window.RadialShortcutPromoter = {
    bindingLabel(id) { return bindings[id] ? format(bindings[id]!.accelerator) : ''; },
    manual(id, event) {
      if (event?.isTrusted && event.detail > 0 && bindings[id]) show(id, bindings[id]!);
    },
    mountSettings(host) {
      host.innerHTML = '<div class="set-section-head">Keyboard shortcuts</div><div class="set-card"><div class="set-item"><div class="set-item-main"><label class="set-item-title" for="shortcutHintsEnabled">Show shortcut hints</label><div class="set-item-desc" id="shortcutHintsHelp">Learn shortcuts as you click. Occasional reminders stay on this machine.</div></div><div class="set-item-act"><input id="shortcutHintsEnabled" class="setting-switch" type="checkbox" role="switch" aria-describedby="shortcutHintsHelp" /></div></div></div>';
      const input = host.querySelector('input')!;
      input.checked = state.enabled;
      input.onchange = () => setEnabled(input.checked);
    },
  };
})();
