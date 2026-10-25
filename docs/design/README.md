# Radial UI reference

The library is an inventory of working app styles, not a parallel design system. It imports `styles.css` and `workspace.css` directly, uses the actual component classes, and shows their markup, source files, and intended use.

## Start here

1. Read [tokens](tokens.md) before changing color, type, radius, or elevation.
2. Read [components](components.md) to choose between controls and surfaces.
3. Check [audit](audit.md) for coverage, deliberate exceptions, and remaining debt.
4. Open the live library with `npm run ui` → `http://127.0.0.1:4318`.
5. Run `npm run ui:audit` for the current token/selector/panel census, or `node scripts/ui-audit.mjs --json` for every flagged raw declaration with its source location.

## Implementation contract

- Stack: Electron, plain HTML, CSS custom properties, and JavaScript. React is not the renderer architecture.
- Runtime source: `src/renderer/styles.css`, `workspace.css`, `index.html`, and `renderer.js`.
- Library source: `src/renderer/ui/catalog.js`, `library.js`, and `library.css`. Its CSS owns documentation layout only; examples use application CSS.
- New stateful controls need shared behavior, not just a shared class. Existing action functions remain the integration points.
- Never execute a real publish, delete, account connection, or agent request from a library example. The library does not load the Electron preload or app renderer.
- Labels and status values in the app come from real state. Static example values must be marked as examples.

## Before merging an interface change

- Check the relevant component page in both appearances.
- Check its actual app host as well; a specimen cannot prove host layout or integration.
- Exercise keyboard focus, disabled/loading, empty/error states, and long values.
- Keep the 200% zoom path usable. Electron has no iOS input-zoom behavior; do not enlarge every dense desktop input to mobile dimensions.
- Run `node --test test/uiLibrary.test.js` and `node --test test/workspaceViews.e2e.mjs test/uiLibrary.e2e.mjs`.
- Do not publish or re-enable the shelved onboarding as part of a visual change.

## Reference

[Shiori UI](https://www.shiori.sh/ui/overview) informed the documentation structure: foundations, working component examples, product patterns, source references, and agent-readable guidance. Radial keeps its own palette, density, implementation, and interaction contracts.
