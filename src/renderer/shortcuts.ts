// The keyboard map, in one place — and the ⇧/ cheat sheet that renders it.
//
// This table is the CANONICAL list shown to users. The bindings themselves
// live where their systems live (menu accelerators in main.js, canvas keys in
// renderer.js, in-preview forwarding in overlay.js — the V/S/C/I/D/T and
// 1/2/3 maps are duplicated there BY DESIGN, one per input surface); when you
// add or change a binding, update this table in the same commit or the sheet
// lies. Sheet opens on ⇧/ (Webflow's key), the command palette, or
// window.openShortcutSheet().
(function () {
  'use strict';

  window.RadialToolKeys = Object.freeze({ v: 'none', s: 'select', c: 'comment', i: 'inspect', d: 'draw', t: 'text', h: 'none' });

  const MOD = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+';
  const SHORTCUTS: [category: string, rows: [keys: string, label: string, tag?: 'experimental'][]][] = [
    ['Tools', [
      ['V', 'Browse — clicks go to the page'],
      ['H', 'Browse (hand)'],
      ['S', 'Select elements'],
      ['T', 'Edit text · swap images'],
      ['C', 'Comment'],
      ['I', 'Inspect styles'],
      ['⌥ (hold)', 'In Select: measure from the selection · click to inspect'],
      ['D', 'Draw for the agent'],
      [MOD + 'E · A', 'Add an element (experimental)', 'experimental'],
      ['Esc', 'Back to browse · deselect'],
    ]],
    ['View & zoom', [
      [MOD + '+ / ' + MOD + '−', 'Zoom in / out'],
      ['⇧1', 'Fit the page'],
      ['⇧2', 'Zoom to selection'],
      [MOD + '0 · ⇧0', 'Reset zoom'],
      ['Space + drag', 'Pan while zoomed'],
      [MOD + '\\', 'Preview — hide the chrome'],
      ['⇧R', 'Rulers & guides'],
      [MOD + '⇧F', 'Full-page screenshot'],
    ]],
    ['Pages & viewport', [
      ['1 / 2 / 3', 'Desktop · tablet · mobile (canvas)'],
      ['M', 'Sitemap'],
      [MOD + 'P', 'All pages'],
      [MOD + '⇧P', 'Page settings'],
      [MOD + 'R', 'Reload the preview'],
      [MOD + '[ / ' + MOD + ']', 'Back / forward'],
    ]],
    ['While selecting', [
      ['↑ / ↓', 'Parent / back down'],
      ['← / →', 'Previous / next sibling'],
      ['⇧↑', 'Add parent to selection'],
      ['Delete', 'Remove element'],
    ]],
    ['Agent', [
      [MOD + 'I', 'Agent panel'],
      [MOD + 'L', 'Type to the agent'],
      [MOD + 'J', 'Terminal'],
      [MOD + 'T', 'New chat'],
      [MOD + '⇧I', 'Screenshot to agent'],
    ]],
    ['App', [
      [MOD + '⇧↩', 'Publish'],
      [MOD + 'K', 'Command palette'],
      [MOD + '⇧C', 'Comments panel'],
      [MOD + 'Z / ' + MOD + '⇧Z', 'Undo / redo'],
      [MOD + '⇧A', 'Projects sidebar'],
      [MOD + '⇧S', 'Agent sidebar'],
      [MOD + '⇧D', 'Panels sidebar'],
      ['1 · 2 · 3', 'Tabs of the sidebar you last clicked'],
      [MOD + '1…9', 'Home · switch projects'],
      [MOD + 'N', 'Open project'],
      [MOD + 'O', 'Open a folder'],
      [MOD + 'W', 'Close project'],
      [MOD + '⇧L', 'Dev-server log'],
      ['⇧/', 'This sheet'],
    ]],
  ];

  let sheet: HTMLDivElement | null = null;
  function closeShortcutSheet() { if (sheet) { sheet.remove(); sheet = null; } }
  function openShortcutSheet() {
    if (sheet) { closeShortcutSheet(); return; }
    sheet = document.createElement('div');
    sheet.id = 'skSheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Keyboard shortcuts');
    const card = document.createElement('div');
    card.className = 'sk-card';
    card.innerHTML = '<div class="sk-head"><span>Keyboard shortcuts</span><button class="sk-close" aria-label="Close">✕</button></div>';
    const grid = document.createElement('div');
    grid.className = 'sk-grid';
    SHORTCUTS.forEach(([cat, items]) => {
      const sec = document.createElement('div');
      sec.className = 'sk-sec';
      sec.innerHTML = '<div class="sk-cat"></div>';
      sec.firstChild!.textContent = cat;
      const expOn = (() => { try { return localStorage.getItem('radial.experimental') === '1'; } catch { return false; } })();
      items.filter(([, , tag]) => tag !== 'experimental' || expOn).forEach(([keys, label]) => {
        const row = document.createElement('div');
        row.className = 'sk-row';
        const l = document.createElement('span'); l.className = 'sk-label'; l.textContent = label;
        const k = document.createElement('span'); k.className = 'sk-keys'; k.textContent = keys;
        row.appendChild(l); row.appendChild(k);
        sec.appendChild(row);
      });
      grid.appendChild(sec);
    });
    card.appendChild(grid);
    sheet.appendChild(card);
    document.body.appendChild(sheet);
    card.querySelector<HTMLButtonElement>('.sk-close')!.onclick = closeShortcutSheet;
    sheet.addEventListener('click', (e) => { if (e.target === sheet) closeShortcutSheet(); });
  }
  window.openShortcutSheet = openShortcutSheet;

  document.addEventListener('keydown', (e) => {
    if (sheet && e.key === 'Escape') { e.stopPropagation(); closeShortcutSheet(); return; }
    if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    e.preventDefault();
    openShortcutSheet();
  }, true);
})();
