# App UI audit — 2026-09-08

## Scope and coverage

Consistency audit of the desktop renderer: `index.html`, `styles.css`, `workspace.css`, the component/rendering functions in `renderer.js`, and the isolated guest overlay boundary in `overlay.js`. The live library inventories 15 surface families, including the full registered instrument-panel family. It does not include marketing-site components or user-authored website styles.

Existing conventions found: `plans/ui-primitives.md` (shared menu, field, composer, and icon primitives; explicit must-differ surfaces). New guidance: `DESIGN.md` and this folder. Stack: Electron with plain JavaScript and CSS tokens. No framework migration.

Source inspection is app-wide; visual/behavioral verification is bounded to the states listed below. Authenticated publish success/failure, real provider connections, screen-reader output, all experimental tools, and every nested modal are **not verified**. No real deployments, account changes, or project deletions were performed.

| Domain | Evidence | Coverage |
| --- | --- | --- |
| Accessibility | Home action semantics; settings choice state; confirm/prompt keyboard paths; library navigation and examples | Focus and naming improvements; whole-app screen-reader pass not verified |
| Layout | Home library, settings shell, menu/dialog geometry, panel registry | Wide/narrow, RTL and zoom checks in workspace test; all authenticated states not verified |
| Writing | Home/settings labels, shared confirmation, source-linked library descriptions | Demo vs real state explicit; publish implementation divergence documented |
| Typography | Shared type/weight tokens, legacy canvas labels, workspace long names | No new app type scale; documentation-only 32px heading |
| Colors | Both theme blocks, canvas literals, status roles, button hover/primary | Common text-pair measurements in library E2E; not every alpha-over-image pair |
| UI polish | Menu/panel/dialog shadows, shared connection actions, state affordances | Shared tokens consolidated; remaining context-specific values retained deliberately |

## Findings and changes

| Severity | Domain | Location | Before → After | Why |
| --- | --- | --- | --- | --- |
| HIGH | Accessibility | `renderer.js:300` `confirmAction`; `index.html` `#confirmModal` | Focus destructive action; document Enter approved from Cancel → safe initial focus, native activation, focus trap/restoration, dialog naming | Prevent an unintended destructive action and keep keyboard focus in the decision |
| HIGH | Accessibility | `renderer.js` `promptText` | Unlabeled field and document-wide Enter → named input, input-only submit shortcut, focus trap/restoration | Cancel must not silently submit; background controls must not receive focus |
| HIGH | Accessibility | `styles.css:154`; `workspace.css` shared focus rule | Field outline resets could override the early focus rule → final-cascade keyboard indicator, semantic focus color, forced-colors support | A shared control must retain visible keyboard focus |
| MEDIUM | Colors | `styles.css` `.btn`, `.btn:hover`, `html.light .btn` | Dark literal hover and light-theme specificity leaking into primary labels → semantic hover and explicit inverse labels | The same action must retain its emphasis in either theme |
| MEDIUM | UI polish | `styles.css` `.menu`, `.nav-url-menu`, `.term-new-menu`, `.tool-panel`, `.fig-dialog`, `.modal-card` | Independent shadow recipes → `--shadow-panel` / `--shadow-dialog`; extreme menu layer removed | Shared surface families need shared depth and predictable layering |
| MEDIUM | Colors | `styles.css` canvas instruments, quick edit, comment controls | Repeated fixed neutrals and low-alpha labels → `--canvas-*` tokens | Preserve intentional always-dark surfaces while removing palette drift |
| MEDIUM | Colors | `styles.css` publish/status styles | Repeated success/warning literals → semantic `--success` / `--warning` references | Theme-aware status colors with consistent meaning |
| MEDIUM | UI polish | `styles.css:738` `.set-connect` | Separate control size/fill/shadow → default button palette, type, and raised depth | Settings connections should look like Radial actions |
| MEDIUM | Layout | `workspace.css`, `renderGlobalSettings` | Single long settings dump → section navigation, grouped rows, narrow wrapping | Preferences, account readiness, and app info have distinct tasks |
| MEDIUM | Accessibility | `renderHomeGrid`, `renderHomeGridFirstRun` | Hover spans inside project buttons; input nested in button → separate named action buttons, valid input container, filter empty state | Pin/remove actions must be keyboard reachable |
| MEDIUM | Layout | `renderer.js` settings draw and license paint | Async refresh could erase a draft/focus → preserve draft/focus and reject stale renders | A background tool check must not interrupt typing |
| MEDIUM | UI polish | `renderer.js` `refreshPublishSurface`, `buildPublishBody`, `TOOL_PANELS` | Two live publish compositions plus an obsolete hosting helper → **remaining**: explicitly documented, shared style tokens only | Do not claim one implementation or parity without reconciling both flows |
| MEDIUM | UI polish | `styles.css` `.qa-*`, `.tp-*`, isolated `overlay.js` styles | Dense per-control literals remain → **remaining**: inventory documents contextual variants; continue migration with rendered specimens | A broad blind replacement can erase useful editor density or break guest styles |

## Intentional differences

- Floating quick edit, comments, and instrument panels use an always-dark canvas skin over arbitrary site content.
- Docked instruments can inherit app-theme overrides. Floating and docked geometry is not interchangeable.
- Command palette search is borderless; normal form fields are boxed.
- Inline rename uses an editing border; it is not an error state.
- Preview guest overlays cannot inherit app CSS and must not collide with the site's selectors.
- Terminal/syntax colors, user content, brand assets, and image previews are not application surface tokens.
- The welcome experiment stays shelved. Its code is preserved but never imported into the library or normal startup.

## Verification record

- **Passed** `node --test test/workspaceViews.e2e.mjs`: isolated real app, Home filtering/pinning/sorting/list-grid, safe confirmation keyboard behavior, settings sections/theme, narrow/RTL/200% layouts, actual local-project Publish, Content/Code/Layers/Page/Publish panels, and project settings.
- **Passed** `node --test test/uiLibrary.e2e.mjs`: all 12 pages/source links, live panel census, safe publish demonstration, native dialog dismissal/focus, theme controls, and narrow layout. Measured normal-text contrast across `--text` / `--muted` on `--bg-2` / `--bg-3`: **6.10:1–15.13:1**, both themes.
- **Passed** `node --test test/uiLibrary.test.js`: four checks covering catalog/source integrity, live stylesheet use, no raw component colors in new surfaces, census integrity, release exclusions, and read-only server boundary.
- **Passed** full unit run: 834 tests at the first checkpoint; the additional census test passed in the focused rerun.
- **Passed** `node --test test/homeAgent.e2e.mjs test/welcome.e2e.mjs`: four existing regressions, including Home terminal persistence and normal/packaged onboarding exclusion.
- `npm run ui:audit`: 71 tokens, 2,347 selector groups, 22 registered panels, and 257 raw declarations flagged for contextual review at this checkpoint. Counts are regenerated from source; not every literal is a defect.
- No claim of exhaustive WCAG conformance or production-publish state parity. Remaining publication-flow consolidation needs a focused follow-up with authenticated fixtures.

## Verdict

**Approve the verified shared-style and library changes.** The **whole app is not signed off as fully consistent**: separate publish implementations and remaining instrument-specific styles are named follow-up work, not hidden behind a completed checklist. Authenticated provider/deployment states and screen-reader behavior still require targeted verification.
