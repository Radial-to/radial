# Tokens

Source: `src/renderer/styles.css`. The library's Foundations page reads current values from computed CSS; it does not keep a copied palette.

## Color and surface

Components use semantic variables, never raw color values. Raw values belong in token definitions or the documented isolated guest-page/terminal systems.

| Role | Token | Where it belongs |
| --- | --- | --- |
| Window canvas | `--bg` | Lowest surface, recessed fields |
| App panel | `--bg-2` | Menus, page shells, sidebar |
| Grouped or raised content | `--bg-3` | Settings cards, inputs |
| Hovered row | `--bg-hover` | Menus and lists |
| Neutral action | `--btn`, `--btn-hover` | Default filled buttons |
| Primary action | `--btn-primary`, `--on-btn-primary` | One dominant action per view |
| Text | `--text`, `--muted`, `--faint` | Main, secondary, tertiary roles |
| Structural boundaries | `--border`, `--border-strong` | Dividers and input borders, never text |
| Status | `--success`, `--warning`, `--danger` | Always accompanied by a label/icon |
| Canvas instrument | `--canvas-surface`, `--canvas-text`, `--canvas-muted`, `--canvas-border` | Always-dark floating controls |

```css
/* Correct: source .menu / .branch-menu */
background: var(--bg-2);
box-shadow: var(--shadow-panel);

/* Incorrect: legacy .tool-panel literal, migrated to a named canvas token */
background: #161311;
```

Choose the role:

```text
Does it float over an edited website?
├─ Canvas instrument → --canvas-* (deliberately dark)
└─ App interface
   ├─ Menu / panel / page → --bg-2
   ├─ Grouped content / field → --bg-3
   └─ Recessed canvas → --bg
```

Do not recolor user images, syntax tokens, terminal escape colors, or brand logos to match app surfaces. The `--accent-2` compatibility token remains for existing consumers; new success indications use `--success`.

## Type

Inter, loaded from `vendor/inter.woff2`; code uses the existing system monospace stack. Use the declared weight tokens, not a new font or a weight change on hover.

| Token | Size | Role |
| --- | --- | --- |
| `--fs-2xs` | 10px | Existing dense instrument metadata only |
| `--fs-xs` | 11px | Captions, shortcuts, compact secondary labels |
| `--fs-sm` | 12px | Controls and secondary UI |
| `--fs-md` | 13px | Default app text |
| `--fs-lg` | 14px | Section emphasis |
| `--fs-xl` | 16px | Compact headings |
| `--fs-2xl` | 19px | Modal hierarchy |
| `--fs-3xl` | 24px | Workspace page heading |

Use 1.5–1.65 line-height for descriptions that wrap. Keep full truncated values reachable through a tooltip, accessible name, or expanded view. Use tabular numerals for counts and timestamps.

## Radius and elevation

Existing radii: `--r-xs` 4, `--r-sm` 6, `--r-md` 8, `--r-lg` 10, `--r-xl` 12, `--r-2xl` 14, `--r-float` 22, `--r-pill` 999px.

- Controls: `--r-sm` / `--r-md`. Grouped cards: `--r-xl`.
- Menus with 6px padding and 8px rows: `--r-2xl`.
- Canvas quick-edit/comment pill: `--r-float`; not an app-settings card.
- Floating app menus: `--shadow-panel`; dialogs: `--shadow-dialog`.
- Raised controls retain `--raise-btn`; primary actions use `--raise-cta`; segmented tracks/thumbs retain `--raise-track` / `--raise-thumb`.
- Do not add an independent box-shadow to a new menu. Change its shared token if the family needs to change.

## Motion

Use the existing `--ease-out`. Frequent navigation is immediate; short press feedback stays interruptible. Every moving status also has a persistent label or icon. Reduced motion must suppress transforms, pulses, and staged entrances without hiding state.
