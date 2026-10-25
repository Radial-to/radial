# Fluid chat trial

Fluid Functionalism source installed with the shadcn CLI from
https://www.fluidfunctionalism.com/r/input-message.json and the Base UI
button, tooltip, dropdown, and scroll-area registry variants (2026-10-05).
The upstream MIT license is in LICENSE.txt and bundled into vendor/fluid/LICENSES.txt.

This trial uses the Fluid composer and Base UI popup menus for model, effort,
permissions, and attachments. Compact sizing and Rounded shape are fixed.
The existing Inter variable font, warm Radial colors, and Central icon slots
are reused. Theme follows Radial; reduced motion follows the OS.

## Integration

`bridge.tsx` mounts a React island inside the existing chat form. Fluid owns
its textarea and presentation; nativeChat.js remains the source of truth for
drafts, submission, CLI state, model settings, approvals, attachments and queues.
The native controls are moved into persistent slots without replacing handlers.
`sync()` reconciles programmatic draft changes with React. Native Enter handlers
prevent Fluid's keyboard handler from submitting the same message twice.

Local extensions to upstream source:
- InputMessage: contextSlot and sendControl let Radial keep attachment and
  Stop/Send behavior. Prevented keyboard events are respected. Queue/status
  announcements stay outside the input.
- DropdownContent: external anchor, portal container and focus restoration
  integrate existing controls. All portal styles remain inside the Fluid scope.
- FileThumbnail: PDF worker resolves locally rather than using a CDN.

`npm run build:fluid` bundles scripts, local assets and licenses, then compiles
Tailwind utilities inside a native CSS scope. There is no global preflight.
Generated output is committed for Electron to load without a dev server.
The unbundled TSX source is excluded from packaged apps.

The stable UI before this trial is commit 91a74a0 on
experiment/chat-ui-capabilities. This branch is experiment/fluid-chat-ui;
reverting the trial commit restores that interface.

## Response activity

Base UI ThinkingSteps wraps real tool events with compact expandable rows.
The app still owns command output, file actions and lazily rendered diffs;
those DOM nodes survive streaming updates. `clear()` unmounts React islands
before transcript replacement. Tool failures remain explicit and only active
events shimmer. Shared theme/motion settings apply to these islands too.

Response actions use Fluid ghost icon buttons and keyboard-accessible Base UI
tooltips. Copy feedback belongs to React and resets after 1.5 seconds; disabled
Retry state follows the existing chat lifecycle. Portals stay in their island.

Agent questions use Fluid AskUserQuestions with compact stacked options. The
adapter maps option IDs back to provider labels, validates all required answers,
disables duplicate submissions, and keeps answers available after send failures.
Secret questions retain Radial's password fields. Local upstream adaptations:
number shortcuts require focus in a visible, interactive card; IME Enter does
not submit; picking a single option clears an old free-text alternative.
Tooltip explicitly associates the popup and trigger with role/id/description.
Minimal element resets live in the scoped base layer, below utility styles.
Unchanged activity/action islands skip rerenders during unrelated stream events.
