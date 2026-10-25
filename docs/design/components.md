# Components and patterns

Source paths are relative to the repo root. The HTML examples in the live library use these classes; no undocumented variants are supported.

## Buttons

Use `.btn` for actions; use a link for navigation to a URL. Use `.btn.icon-btn` for a compact icon action and provide `aria-label`.

Variants: `.btn` (default), `.btn-primary` (one dominant action), `.btn-danger` (destructive confirmation), `.btn-mini` (quiet inline secondary). Dense canvas actions use existing `.tp-cta` / `.tp-ghost-btn`, not a new global variant.

```html
<!-- Correct: index.html Home action -->
<button id="hgNew" class="btn">Open project</button>
<!-- Incorrect: the previous Home action promoted a routine action -->
<button id="hgNew" class="btn btn-primary">Open project</button>
```

```text
Action or navigation?
├─ URL navigation → <a>
└─ Action
   ├─ Destructive confirmation → .btn.btn-danger
   ├─ Dominant action → .btn.btn-primary
   ├─ Quiet inline secondary → .btn-mini
   └─ Default → .btn
```

Compatibility consumers `.set-connect`, `.pm-action`, and `.psr-act` retain context geometry. They are not permission to introduce new palettes.

## Fields

Use `.field` for compact input and `.text-input` for forms. Use `.field--edit` for inline rename. Command-palette search deliberately remains borderless.

Variants: default and `field--edit` only. Native `disabled` and `aria-invalid` carry state; placeholder text is not a label.

```html
<!-- Correct: Home search has an accessible name -->
<input id="hgSearch" class="text-input" aria-label="Search projects or paste a GitHub link">
<!-- Incorrect: previous Home search relied on placeholder text -->
<input id="hgSearch" class="text-input" placeholder="Search, or paste a GitHub link">
```

## Segmented choices and navigation

Use `.theme-seg` for independent small choices, `.qa-seg` for dense instrument choices, and a nav with `aria-current` for settings pages. Do not declare `role="tablist"` without its arrow-key behavior.

Variants: `.theme-seg button.active`, `.qa-seg button.on`, settings nav `[aria-current="page"]`. Selection must also be represented in `aria-pressed` or `aria-current`.

```html
<!-- Correct: updated settings renderer -->
<button data-theme="dark" class="active" aria-pressed="true">Dark</button>
<!-- Incorrect: previous selected state was visual only -->
<button data-theme="dark" class="active">Dark</button>
```

## Surface

Use `.menu` for transient actions, `.modal-card` for a blocking decision, `.set-card` for settings groups, `.tool-panel` for canvas instruments. Size and placement stay with the host; color/elevation come from shared tokens.

Variants: app panel, grouped card, blocking dialog, always-dark canvas instrument. These roles intentionally differ.

```css
/* Correct: styles.css shared menu base */
.menu, .branch-menu { box-shadow: var(--shadow-panel); }
/* Incorrect: former URL menu made a separate shadow family */
.nav-url-menu { box-shadow: 0 8px 24px oklch(0 0 0 / 0.35); }
```

```text
What is the container doing?
├─ Blocking decision → .modal-card
├─ Transient app actions → .menu / .branch-menu
├─ Preferences grouped by intent → .set-card
└─ Instrument over site content → .tool-panel
```

## Settings row

Use `.set-item` within `.set-card` for title, optional description, and one action group. Use a project row, not a settings row, when clicking opens a project. `setItem` renders detected connection states; `renderGlobalSettings` owns preferences.

Variants: preference, connection. Layout is shared through `#settingsView` / `.settings-pattern` in `workspace.css`.

```html
<!-- Correct: current shared grouping -->
<div class="set-card"><div class="set-item"><div class="set-item-main">…</div><div class="set-item-act">…</div></div></div>
<!-- Incorrect: the former page concatenated every category in one undifferentiated scroll -->
<!-- themeHtml + previewHtml + privacyHtml -->
```

## Publish

The current topbar menu uses `refreshPublishSurface` / `togglePublishMenu`. The native panel uses `buildPublishBody`. The old `mountPublishSurface` helper exists but the panel registry no longer uses it. Do not mistake that helper for a shared live implementation. Do not bypass production confirmation or create a third publish implementation for a restyle.

Variants: popover and native panel; setup, ready, publishing, success, and failure are state-driven. Their separate compositions are tracked audit debt, not verified parity. The library uses safe static data; app status must remain real.

```js
// Correct: refresh the existing topbar surface.
refreshPublishSurface(true);
// Incorrect: do not copy buildPublishBody into another stateful wizard.
```

## Confirmations and composers

Use `confirmAction` for destructive confirmation and `promptText` for a short input request. Focus the safe action, trap focus, support Escape, and return focus. Do not bind Enter at document level to approve deletion regardless of which button is focused.

Use `.composer` + `.composer-text` + `.composer-bar` for message entry. Floating comment/quick-edit surfaces retain their canvas skin. Never turn the terminal itself into a themed app card: its colors and selection are terminal behavior.
