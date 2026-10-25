// Radial's own color picker — no dependencies. An anchored popover in the
// app's menu chrome: saturation/value plane, hue + alpha rails, HEX/RGB/OKLCH
// tabs with a typable field, the native eyedropper when Chromium offers it,
// and a session swatch history. Emits live changes; commit semantics belong
// to the caller (openColorPicker routes scope/instance on close).
(() => {
  // ── color math ────────────────────────────────────────────────────────────
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const f = (n: number): number => {
      const k = (n + h / 60) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5) * 255, f(3) * 255, f(1) * 255];
  }
  function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return [h, max ? d / max : 0, max];
  }
  // sRGB → OKLCH (Björn Ottosson's OKLab), for the OKLCH tab; parseColor reads colors back.
  const srgbToLinear = (c: number): number => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  function rgbToOklch(r: number, g: number, b: number): [number, number, number] {
    const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const C = Math.sqrt(a * a + bb * bb);
    let H = (Math.atan2(bb, a) * 180) / Math.PI;
    if (H < 0) H += 360;
    return [L, C, H];
  }
  // The one-pixel canvas parseColor paints a color on, to read it back in sRGB (made on first use).
  let swatch: CanvasRenderingContext2D | null = null;
  function parseColor(str: string): { r: number; g: number; b: number; a: number } {
    // Any CSS color → {r,g,b,a} via the browser's own parser.
    const el = document.createElement('span');
    el.style.color = '#000';
    el.style.color = str;
    document.body.appendChild(el);
    const cs = getComputedStyle(el).color;
    el.remove();
    const m = cs.match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?/);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] != null ? +m[4] : 1 };
    // Hex, named, rgb(), hsl() and hwb() colors compute to rgb(). The rest keep their own
    // space: oklch() (Tailwind v4's palette), lab(), lch(), oklab(), color(display-p3 …).
    // Chromium converts those to sRGB when it paints, so paint one pixel and read it back.
    // Paint it opaque: a translucent pixel keeps its channels premultiplied, losing precision,
    // so the alpha after the slash is cut off and read from the text instead.
    const parts = cs.match(/^(.*?)(?:\s*\/\s*([^\s)]+))?\)$/);
    if (!parts) return { r: 0, g: 0, b: 0, a: 1 };
    if (!swatch) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      // A new canvas always has a 2d context to give.
      swatch = canvas.getContext('2d', { willReadFrequently: true })!;
    }
    swatch.fillStyle = '#000';
    swatch.fillStyle = parts[1] + ')';
    swatch.fillRect(0, 0, 1, 1);
    const [r, g, b] = swatch.getImageData(0, 0, 1, 1).data;
    // An alpha of none paints as 0.
    return { r, g, b, a: parts[2] === undefined ? 1 : +parts[2] || 0 };
  }
  const toHex = (r: number, g: number, b: number): string => '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');

  // ── state ────────────────────────────────────────────────────────────────
  let root: HTMLDivElement | null = null, state: ColorPickerState | null = null;
  let lastTab: ColorPickerTab = 'hex'; // format choice survives across opens (commits stay in your format)
  let recents: string[] = [];
  try { recents = JSON.parse(localStorage.getItem('radial.pickerRecents') || '[]') as string[]; } catch {}

  function fmtValue(): string {
    const [r, g, b] = hsvToRgb(state!.h, state!.s, state!.v);
    const a = state!.a;
    if (state!.tab === 'hex') return a < 1 ? toHex(r, g, b) + Math.round(a * 255).toString(16).padStart(2, '0') : toHex(r, g, b);
    if (state!.tab === 'rgb') return a < 1 ? `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(a * 100) / 100})` : `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
    const [L, C, H] = rgbToOklch(r, g, b);
    const core = `${Math.round(L * 1000) / 1000} ${Math.round(C * 1000) / 1000} ${Math.round(H * 10) / 10}`;
    return a < 1 ? `oklch(${core} / ${Math.round(a * 100) / 100})` : `oklch(${core})`;
  }
  function cssValue(): string { // what gets applied/committed — the active tab's format
    return fmtValue();
  }

  function build(): void {
    root = document.createElement('div');
    root.className = 'rcp';
    root.innerHTML = `
      <div class="rcp-head">
        <span class="rcp-title">Color</span>
        <button class="rcp-x" aria-label="Close"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div class="rcp-sv" tabindex="0" aria-label="Saturation and brightness"><div class="rcp-loupe"></div></div>
      <div class="rcp-rails">
        <button class="rcp-eye" title="Pick from screen" aria-label="Pick a color from the screen"></button>
        <div class="rcp-cols">
          <div class="rcp-rail rcp-hue" tabindex="0" aria-label="Hue"><div class="rcp-handle"></div></div>
          <div class="rcp-rail rcp-alpha" tabindex="0" aria-label="Opacity"><div class="rcp-handle"></div></div>
        </div>
        <span class="rcp-chip"></span>
      </div>
      <div class="rcp-foot">
        <div class="rcp-tabs" role="group" aria-label="Format">
          <button data-tab="hex" class="on" aria-pressed="true">Hex</button>
          <button data-tab="rgb" aria-pressed="false">RGB</button>
          <button data-tab="oklch" aria-pressed="false">OKLCH</button>
        </div>
        <input class="rcp-input" spellcheck="false" aria-label="Color value" />
      </div>
      <div class="rcp-recents" aria-label="Recent colors"></div>`;
    document.body.appendChild(root);

    const sv = root.querySelector<HTMLDivElement>('.rcp-sv')!;
    const hue = root.querySelector<HTMLDivElement>('.rcp-hue')!;
    const alpha = root.querySelector<HTMLDivElement>('.rcp-alpha')!;
    const input = root.querySelector<HTMLInputElement>('.rcp-input')!;
    const eye = root.querySelector<HTMLButtonElement>('.rcp-eye')!;
    eye.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 8l2.5-2.5a2.1 2.1 0 1 1 3 3L17 11M14 8l-9 9-1.5 4L7.5 19.5l9-9M14 8l2.5 2.5"/></svg>';
    if (!window.EyeDropper) eye.style.display = 'none';

    // Rail/plane drags own the pointer (capture) — nothing interrupts them.
    const drag = (el: HTMLElement, fn: (x: number, y: number) => void): void => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent): void => {
          // Escape can close the picker mid-drag, and the captured pointer keeps
          // sending moves until it's released: those have nothing to change.
          if (!state) return;
          const r = el.getBoundingClientRect();
          fn(clamp01((ev.clientX - r.left) / r.width), clamp01((ev.clientY - r.top) / r.height));
          paint(); emit();
        };
        move(e);
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', () => el.removeEventListener('pointermove', move), { once: true });
      });
    };
    drag(sv, (x, y) => { state!.s = x; state!.v = 1 - y; });
    drag(hue, (x) => { state!.h = x * 360; });
    drag(alpha, (x) => { state!.a = Math.round(x * 100) / 100; });

    // The head drags the whole picker (the modal backdrop covers the webview,
    // so captured moves stay in the host document). Clamped fully on-screen.
    const head = root.querySelector<HTMLDivElement>('.rcp-head')!;
    head.addEventListener('pointerdown', (e) => {
      if ((e.target as Element).closest('button')) return;
      e.preventDefault();
      head.setPointerCapture(e.pointerId);
      const startX = e.clientX, startY = e.clientY;
      const startL = parseFloat(root!.style.left) || 0, startT = parseFloat(root!.style.top) || 0;
      const move = (ev: PointerEvent): void => {
        const x = Math.min(Math.max(8, startL + ev.clientX - startX), window.innerWidth - root!.offsetWidth - 8);
        const y = Math.min(Math.max(8, startT + ev.clientY - startY), window.innerHeight - root!.offsetHeight - 8);
        root!.style.left = x + 'px';
        root!.style.top = y + 'px';
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', () => head.removeEventListener('pointermove', move), { once: true });
    });
    root.querySelector<HTMLButtonElement>('.rcp-x')!.onclick = () => close(true); // same as the backdrop: commit what you see

    root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => {
      b.onclick = () => {
        state!.tab = lastTab = b.dataset.tab as ColorPickerTab;
        root!.querySelectorAll('[data-tab]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
        paint();
      };
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const c = parseColor(input.value.trim());
        const [h, s, v] = rgbToHsv(c.r, c.g, c.b);
        state!.h = h; state!.s = s; state!.v = v; state!.a = c.a;
        paint(); emit();
      } else if (e.key === 'Escape') { e.preventDefault(); close(false); }
    });
    eye.onclick = async () => {
      try {
        const res = await new window.EyeDropper!().open();
        const c = parseColor(res.sRGBHex);
        const [h, s, v] = rgbToHsv(c.r, c.g, c.b);
        state!.h = h; state!.s = s; state!.v = v; state!.a = 1;
        paint(); emit();
      } catch {}
    };
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } });
  }

  function paint(): void {
    const sv = root!.querySelector<HTMLDivElement>('.rcp-sv')!;
    const [hr, hg, hb] = hsvToRgb(state!.h, 1, 1);
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, rgb(${hr | 0},${hg | 0},${hb | 0}))`;
    const loupe = root!.querySelector<HTMLDivElement>('.rcp-loupe')!;
    loupe.style.left = `${state!.s * 100}%`;
    loupe.style.top = `${(1 - state!.v) * 100}%`;
    const [r, g, b] = hsvToRgb(state!.h, state!.s, state!.v);
    loupe.style.background = toHex(r, g, b);
    root!.querySelector<HTMLDivElement>('.rcp-hue .rcp-handle')!.style.left = `${(state!.h / 360) * 100}%`;
    const ar = root!.querySelector<HTMLDivElement>('.rcp-alpha')!;
    ar.style.setProperty('--rcp-a-color', toHex(r, g, b));
    ar.querySelector<HTMLDivElement>('.rcp-handle')!.style.left = `${state!.a * 100}%`;
    const chip = root!.querySelector<HTMLSpanElement>('.rcp-chip')!;
    chip.style.background = state!.a < 1 ? `rgba(${r | 0},${g | 0},${b | 0},${state!.a})` : toHex(r, g, b);
    const input = root!.querySelector<HTMLInputElement>('.rcp-input')!;
    if (document.activeElement !== input) input.value = fmtValue();
  }
  function emit(): void { if (state!.onChange) state!.onChange(cssValue()); state!.dirty = true; }
  function rememberRecent(): void {
    const v = toHex(...hsvToRgb(state!.h, state!.s, state!.v));
    recents = [v, ...recents.filter((x) => x !== v)].slice(0, 8);
    try { localStorage.setItem('radial.pickerRecents', JSON.stringify(recents)); } catch {}
  }
  function paintRecents(): void {
    const row = root!.querySelector<HTMLDivElement>('.rcp-recents')!;
    row.innerHTML = '';
    recents.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'ap-dot';
      b.title = c; b.setAttribute('aria-label', c);
      b.style.background = c;
      b.onclick = () => {
        const p = parseColor(c);
        const [h, s, v] = rgbToHsv(p.r, p.g, p.b);
        state!.h = h; state!.s = s; state!.v = v;
        paint(); emit();
      };
      row.appendChild(b);
    });
    row.style.display = recents.length ? '' : 'none';
  }
  function close(commit?: boolean): void {
    if (!root || !state) return;
    const st = state;
    // Read the final value and record the swatch while state is still alive —
    // only then tear down and hand the result to the caller.
    const css = commit !== false && st.dirty ? cssValue() : null;
    if (css) rememberRecent();
    state = null;
    root.style.display = 'none';
    if (st.onClose) st.onClose(css);
  }

  window.RadialColorPicker = {
    open({ color, anchorRect, title, onChange, onClose }) {
      if (!root) build();
      const c = parseColor(color || '#888888');
      const [h, s, v] = rgbToHsv(c.r, c.g, c.b);
      state = { h, s, v, a: c.a, tab: lastTab, onChange, onClose, dirty: false };
      root!.querySelector('.rcp-title')!.textContent = title || 'Color';
      root!.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((x) => { x.classList.toggle('on', x.dataset.tab === lastTab); x.setAttribute('aria-pressed', String(x.dataset.tab === lastTab)); });
      root!.style.display = 'flex';
      paint();
      paintRecents();
      // To the left of the trigger, tops aligned; flip right only when there's
      // no room. Clamped on-screen either way. Draggable after that (rcp-head).
      const w = root!.offsetWidth, hgt = root!.offsetHeight;
      let x: number, y: number;
      if (anchorRect) {
        x = anchorRect.left - w - 8;
        if (x < 8) x = anchorRect.right + 8;
        y = anchorRect.top;
      } else { x = (window.innerWidth - w) / 2; y = (window.innerHeight - hgt) / 2; }
      y = Math.min(Math.max(8, y), window.innerHeight - hgt - 8);
      x = Math.min(Math.max(8, x), window.innerWidth - w - 8);
      root!.style.left = x + 'px';
      root!.style.top = y + 'px';
      root!.querySelector<HTMLDivElement>('.rcp-sv')!.focus();
    },
    close,
    isOpen() { return !!state; },
  };
})();
