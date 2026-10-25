/** A live example on a library page: its markup is rendered, then shown as code. */
export interface Specimen { title: string; html: string; note: string }
/** The sidebar sections, in the order the pages list them. */
export type CatalogGroup = 'Start here' | 'Components' | 'Product patterns' | 'Maintaining the system';
/** A page of the UI library (`#id` in the address). */
export interface CatalogPage {
  id: string;
  name: string;
  group: CatalogGroup;
  description: string;
  /** Files the page draws on, relative to the repo (served by scripts/ui-library.mts). */
  sources: string[];
  usage: string;
  examples: Specimen[];
}
/** A row of the surface inventory. */
export type Surface = [name: string, classes: string, source: string, family: string, note: string];
/**
 * The source census scripts/ui-audit.mts builds (auditUI) and scripts/ui-library.mts
 * serves at /ui-audit.json; the inventory page renders it. Kept here, the library's
 * data module, while scripts/ is JavaScript.
 * TODO: move to scripts/ui-audit once it is typed (auditUI(): Promise<UiAudit>).
 */
export interface UiAudit {
  /** The stylesheets read, relative to the repo. */
  files: string[];
  tokenCount: number;
  tokens: string[];
  selectorCount: number;
  rawDeclarationCount: number;
  /** Raw color declarations, for review in context. */
  rawDeclarations: { file: string; line: number; selector: string; property: string; value: string }[];
  /** renderer.ts's TOOL_PANELS. */
  panels: { id: string; title: string; experimental: boolean }[];
  note: string;
}

const css = 'src/renderer/styles.css';
const renderer = 'src/renderer/renderer.ts';
const specimen = (title: string, html: string, note = ''): Specimen => ({ title, html, note });
export const catalog: CatalogPage[] = [
  { id: 'overview', name: 'Overview', group: 'Start here', description: 'The interface we build with. The details we keep in common.', sources: [css, 'src/renderer/workspace.css'], usage: 'This is a working inventory of Radial, not a separate theme. Examples load the same stylesheets as the desktop app. Product actions here are safe demonstrations: nothing is published, deleted, or connected.', examples: [] },
  { id: 'foundations', name: 'Foundations', group: 'Start here', description: 'Warm neutrals. Compact typography. Quiet depth.', sources: [css], usage: 'Use semantic variables, not a sampled color. App surfaces follow appearance; canvas instruments deliberately stay dark over arbitrary websites. A radius or density may differ because the job differs, not because a screen defines its own theme.', examples: [] },
  { id: 'buttons', name: 'Buttons', group: 'Components', description: 'Actions, with the emphasis their consequences deserve.', sources: [css, 'src/renderer/index.html', renderer], usage: 'Use .btn by default, .btn-mini for a secondary inline action, and .btn.icon-btn for an icon action with a name. Reserve .btn-primary for one dominant action and .btn-danger for destructive confirmation. Keep panel actions compact with .tp-cta; do not copy its old raw colors into a new button.', examples: [
    specimen('Emphasis', '<button class="btn">Open project</button><button class="btn btn-primary">Save changes</button><button class="btn btn-danger">Delete project</button><button class="btn-mini">Cancel</button>'),
    specimen('States', '<button class="btn" disabled>Unavailable</button><button class="btn" disabled aria-busy="true">Saving…</button><button class="btn icon-btn" aria-label="Add project">+</button>', 'Native disabled blocks activation. A loading label keeps the action understandable without relying on a spinner.'),
    specimen('Compact panel action', '<div class="ui-canvas"><button class="tp-cta">Apply changes</button><button class="tp-ghost-btn">View source</button></div>', 'Used in Design, Code, Publish, and content panels. Density is intentional; the action still needs a keyboard path.') ] },
  { id: 'fields', name: 'Fields', group: 'Components', description: 'Labels that stay. States you can understand.', sources: [css, renderer], usage: 'Use .field for compact input and .text-input for forms. Use .field--edit only for inline rename. Keep the command palette’s borderless search distinct. Every control needs a persistent label; explain errors next to the field.', examples: [
    specimen('Text input', '<div class="ui-form"><label for="demo-project">Project name</label><input id="demo-project" class="field" value="Studio website" autocomplete="off"><label for="demo-url">Repository</label><input id="demo-url" class="text-input" placeholder="github.com/studio/website" spellcheck="false"></div>'),
    specimen('Validation and disabled', '<div class="ui-form"><label for="demo-error">Project name</label><input id="demo-error" class="field" aria-invalid="true" aria-describedby="demo-error-help" value=""><p id="demo-error-help">Enter a name before creating the project.</p><label for="demo-disabled">Current branch</label><input id="demo-disabled" class="field" value="main" disabled></div>'),
    specimen('Inline edit and multiline', '<div class="ui-form"><label for="demo-rename">Rename group</label><input id="demo-rename" class="field field--edit" value="Landing pages"><label for="demo-description">Description</label><textarea id="demo-description" class="field" rows="3">A quieter place for your work.</textarea></div>') ] },
  { id: 'selection', name: 'Selection controls', group: 'Components', description: 'An explicit choice, with a visible selected state.', sources: [css, renderer], usage: 'Use .theme-seg for a small independent choice group; synchronize .active and aria-pressed. Use native checkbox/radio/select for form choices. .qa-seg is the dense canvas-instrument variant, not a new app-wide control.', examples: [
    specimen('Segmented choice', '<div class="theme-seg" role="group" aria-label="Example appearance" data-demo-segment><button class="active" aria-pressed="true">Dark</button><button aria-pressed="false">Light</button></div>'),
    specimen('Native choices', '<div class="ui-form"><label><input type="checkbox" checked> Include staging</label><label><input type="radio" name="target" checked> Staging</label><label><input type="radio" name="target"> Production</label><label for="demo-target">Default destination</label><select id="demo-target" class="field"><option>Staging</option><option>Production</option></select></div>') ] },
  { id: 'navigation', name: 'Navigation', group: 'Components', description: 'Location and selection should never feel interchangeable.', sources: [css, 'src/renderer/workspace.css', renderer], usage: 'Use a nav with aria-current for pages. Use buttons with aria-pressed for filters. A tablist is only correct when arrow-key and roving-focus behavior is implemented. Active states must not change font weight or shift labels.', examples: [
    specimen('Section navigation', '<nav id="settingsNav" aria-label="Example sections" data-demo-nav><button aria-current="page">General</button><button>Connections</button><button>Privacy</button></nav>'),
    specimen('Filters', '<div class="hg-filters" role="group" aria-label="Example project filter" data-demo-segment><button aria-pressed="true">All projects</button><button aria-pressed="false">Pinned</button><button aria-pressed="false">Open now</button></div>') ] },
  { id: 'surfaces', name: 'Surfaces & menus', group: 'Components', description: 'A small family of surfaces, each with a job.', sources: [css, renderer], usage: 'Use .menu for floating app actions, .modal-card for a blocking decision, .set-card for grouped settings, and .tool-panel for a canvas instrument. Share border and shadow tokens; preserve the density, position, and shape each context needs.', examples: [
    specimen('Menu', '<div class="menu branch-menu ui-static"><div class="pane-head">Project</div><button class="bm-foot">Open in browser</button><button class="bm-foot">Reveal in Finder</button><div class="bm-sep"></div><button class="bm-foot">Project settings…</button></div>', 'Working native buttons in the real menu skin. This inline example is not an ARIA menu; application menus also own positioning, dismissal, and focus.'),
    specimen('Home project options', '<div class="term-new-menu hg-menu ui-static"><button>Pin project</button><button>Remove from Home</button></div>', 'The three-dot trigger uses openHomeMenu, also used by Home sorting. Arrow keys navigate; Escape restores trigger focus. Removing a project requires confirmation and never deletes its files. This inline specimen only shows the shared menu surface.'),
    specimen('Canvas instrument', '<section class="tool-panel show ui-static"><div class="tp-head"><span class="tp-title">Design</span></div><div class="tp-body"><div class="tp-sec">Layout</div><div class="tp-row"><button class="tp-cta">Apply changes</button></div><p class="tp-empty">Select an element to inspect its layout.</p></div></section>', 'Always-dark canvas skin is intentional. App menus still follow light/dark appearance.') ] },
  { id: 'feedback', name: 'Feedback & dialogs', group: 'Components', description: 'Say what happened, and what someone can do next.', sources: [css, 'src/renderer/index.html', renderer], usage: 'Use confirmAction for destructive choices and promptText for a short text request. Confirmations must focus the safe action and restore focus on close. Use status text in addition to color. Never demo a real destructive or publishing action in the library.', examples: [
    specimen('Status', '<div class="set-chips"><span class="set-chip"><span class="dot ok"></span>Connected</span><span class="set-chip bad"><span class="dot bad"></span>Not connected</span><span class="set-chip">Checking…</span></div>'),
    specimen('Confirmation', '<div class="modal-card confirm-card ui-static"><h2>Remove from recents?</h2><p class="muted">This removes the project from Home. Your files stay on disk.</p><div class="modal-actions"><button class="btn">Cancel</button><button class="btn btn-danger">Remove from recents</button></div></div>'),
    specimen('Try keyboard dismissal', '<button class="btn" data-demo-dialog>Open example dialog</button>') ] },
  { id: 'settings', name: 'Settings rows', group: 'Product patterns', description: 'Grouped by intent, with the control beside the explanation.', sources: ['src/renderer/workspace.css', renderer], usage: 'Use .set-section, .set-card, and .set-item inside the settings page. A row has a title, optional description, and one action group. Section navigation changes the visible group without changing preferences. Keep account and local-tool readiness truthful.', examples: [
    specimen('Preference group', '<div class="settings-pattern"><section class="set-section"><h2 class="set-section-head">Appearance</h2><div class="set-card"><div class="set-item"><div class="set-item-main"><div class="set-item-title">Theme</div><div class="set-item-desc">Switch between light and dark.</div></div><div class="set-item-act"><div class="theme-seg" role="group" aria-label="Example theme" data-demo-segment><button class="active" aria-pressed="true">Dark</button><button aria-pressed="false">Light</button></div></div></div></div></section></div>'),
    specimen('Connection row', '<div class="settings-pattern"><div class="set-card"><div class="set-item"><div class="set-item-main"><div class="set-item-title">GitHub</div><div class="set-item-desc">Connect your account to publish and pull.</div></div><div class="set-item-act"><button class="set-connect">Sign in</button></div></div></div></div>', 'Example only. In the app this row is produced by ghAccountRow and setItem using the detected connection state.') ] },
  { id: 'publish', name: 'Publish', group: 'Product patterns', description: 'Publishing in a menu or a workspace panel.', sources: [css, renderer], usage: 'The topbar uses refreshPublishSurface; the native panel uses buildPublishBody. They currently have separate compositions. Shared tokens keep their chrome aligned, but state parity still needs a dedicated consolidation. Do not create a third wizard that bypasses review, destination, or production confirmation.', examples: [
    specimen('Review pattern', '<div class="menu branch-menu publish-menu ui-static"><div class="pane-head">Publish</div><label for="demo-commit">Describe your changes</label><div class="pm-commit-wrap"><textarea id="demo-commit" class="pm-commit" rows="2" placeholder="Update the homepage"></textarea></div><label class="pm-target"><input type="checkbox" checked><span class="pm-target-main">Staging <code>staging</code></span></label><label class="pm-target"><input type="checkbox"><span class="pm-target-main">Production <code>main</code></span></label><button class="pm-action primary" data-demo-publish>Publish to staging</button><p class="pm-status-sub" role="status" data-demo-publish-status>Demo only. Nothing will be published.</p></div>', 'An isolated composition of the live publish classes—not a fake connected repository. Both target toggles are interactive.') ] },
  { id: 'composer', name: 'Agent & comments', group: 'Product patterns', description: 'One input vocabulary, adapted to its surroundings.', sources: [css, renderer], usage: 'Reuse .composer, .composer-text, .composer-tool, and .composer-send. The quick-edit pill and floating comment composer use the always-dark canvas skin. The agent composer remains part of its dock; do not restyle terminal output as app chrome.', examples: [
    specimen('Composer', '<div class="composer ui-composer"><label class="ui-sr" for="demo-prompt">Message</label><textarea id="demo-prompt" class="composer-text" rows="3" placeholder="What would you like to change?"></textarea><div class="composer-bar"><div class="composer-tools"><button class="composer-tool" aria-label="Attach context">+</button></div><button class="composer-send" aria-label="Send example message">↑</button></div></div>') ] },
  { id: 'inventory', name: 'Surface inventory', group: 'Maintaining the system', description: 'What exists, what shares a foundation, and what stays distinct.', sources: ['docs/design/audit.md', 'docs/design/components.md'], usage: 'The audit covers renderer source across the app. Runtime coverage is tracked separately: source inspection is not a claim that every authenticated, failure, or platform state has been exercised.', examples: [] },
];

export const surfaces: Surface[] = [
  ['Home / project library', '#homeGrid, .hg-card', 'workspace.css', 'App page', 'Search, sorting, filters, list/grid, empty states'],
  ['Settings / project settings', '#settingsView, .set-card', 'workspace.css', 'App page', 'General, connections, privacy, about, repo details'],
  ['Project creation / GitHub import', '.fr-page, .connect-card', 'styles.css', 'Form', 'Shared fields and buttons; source selection stays distinct'],
  ['Publish', '.publish-menu, .pm-action, .psr', 'styles.css', 'Menu / panel', 'Separate compositions; shared tokens. State parity remains audit debt.'],
  ['Design / content / layout / code', '.tool-panel, .tp-*, .qa-*', 'styles.css', 'Canvas instrument', 'Always-dark floating controls; dock overrides are intentional'],
  ['Agent / terminal', '.right-dock, .composer', 'styles.css', 'Dock', 'Terminal escape colors belong to terminal themes'],
  ['Comments / quick edit', '.comment-popover, .quick-edit', 'styles.css', 'Canvas instrument', 'Always-dark over arbitrary site content'],
  ['Branch / URL / project menus', '.branch-menu, .nav-url-menu, .term-new-menu', 'styles.css', 'Menu', 'Shared theme-aware panel shadow; dimensions stay local'],
  ['History / restore / moments', '.hist-*, .moment-*', 'styles.css', 'Panel', 'Shared compact actions and neutral surfaces'],
  ['Page settings / social preview', '.ps-*, .social-card', 'styles.css', 'Form / preview', 'Fields follow theme; rendered content imagery is not recolored'],
  ['Confirm / prompt / feedback', '.confirm-card, .toast', 'styles.css', 'Dialog / feedback', 'Shared keyboard and focus behavior; error persistence audited separately'],
  ['Command palette', '.cmdk-*', 'styles.css', 'Search overlay', 'Deliberate borderless search; not a normal boxed field'],
  ['Guest-page selection / overlays', '.radial-*', 'overlay.js', 'Separate document', 'Isolated styles prevent collisions with the edited site'],
];
