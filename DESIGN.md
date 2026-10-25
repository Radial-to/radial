# Radial interface

Radial uses warm neutrals, compact controls, and restrained elevation. The app is a desktop editing tool: density serves the work. Consistency means shared roles and behavior, not forcing every context into an identical card.

- Start with [the design reference](docs/design/README.md).
- Run `npm run ui` and open `http://127.0.0.1:4318` for the live UI library.
- Use existing classes and semantic tokens from `src/renderer/styles.css`. Workspace layout lives in `src/renderer/workspace.css`.
- Do not sample a color from a screenshot, invent a button variant, or import a second component framework.
- Update the app, library example, and guidance together when changing a shared pattern.
- App chrome follows appearance. Canvas instruments deliberately retain the always-dark `--canvas-*` skin. Guest-page overlays remain isolated from the edited site's CSS.
- The welcome/onboarding experiment remains private and excluded from release packaging. The library is also a local development surface, not part of the distributed app.

See [components](docs/design/components.md), [tokens](docs/design/tokens.md), and the [audit and coverage record](docs/design/audit.md).
