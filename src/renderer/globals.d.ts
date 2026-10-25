// The window's globals that come from other files: the shared modules the
// build exposes as globals (DUAL in scripts/transpile.mts) and the API the
// preload script puts on window. Window scripts reach each other's top-level
// declarations directly, since they share one global scope. A global `var` is
// also a property of window (typeof globalThis), so each of these reads both
// as `RadialGuides` and as `window.RadialGuides`.
declare var RadialAdjustDirect: typeof import('./adjustDirect');
declare var RadialCliQuestion: typeof import('../shared/cliQuestion');
declare var RadialAgentPaste: typeof import('../shared/agentPaste');
declare var RadialFuzzy: typeof import('./fuzzy');
declare var RadialGuides: typeof import('./guides');
declare var RadialNavigation: typeof import('./navigation');
declare var RadialTaskTitle: typeof import('./taskTitle');
declare var RadialThreadPreview: typeof import('./threadPreview');
declare var RadialViewport: typeof import('./viewport');
declare var RadialChatPermissions: typeof import('../shared/chatPermissions');
declare var classifyUrl: typeof import('./agentUrl').classifyUrl;
declare var decodeOsc52: typeof import('./osc52').decodeOsc52;

// The preload's API (contextBridge.exposeInMainWorld('radial', …)). Its type
// lives in a module with no Electron or Node imports, so the window's
// type-check never sees Node's globals: the window has no Node at runtime.
declare var radial: import('../shared/radialApi').RadialApi;

// What the window scripts put on window for each other (their shapes are in
// types.d.ts), in index.html's order. Each is set when its script runs, before
// renderer.js, the last script, starts.
declare var RadialToolKeys: RadialToolKeyMap; // shortcuts.js
declare var openShortcutSheet: () => void; // shortcuts.js
declare var RadialShortcutPromoter: RadialShortcutPromoterApi; // shortcutPromoter.js
declare var RadialDiffs: RadialDiffsApi; // diffView.js
declare var RadialPublishSettings: RadialPublishSettingsApi; // publishSettings.js
declare var RadialProjectStorageSettings: RadialProjectStorageSettingsApi; // projectStorageSettings.js
declare var RadialPublish: RadialPublishApi; // publishWorkflow.js
declare var RadialCollaboration: RadialCollaborationApi; // collaboration.js
declare var RadialProjectLibrary: RadialProjectLibraryApi; // projectLibrary.js
declare var RadialWorkspaceHome: RadialWorkspaceHomeApi; // workspaceHome.js
declare var RadialChatResponses: RadialChatResponsesApi; // chat/responses.js
declare var RadialChatComposer: RadialChatComposerApi; // chat/composer.js
declare var RadialNativeChat: RadialNativeChatApi; // nativeChat.js
declare var RadialColorPicker: RadialColorPickerApi; // colorPicker.js

// Bundles and generated files the page loads as plain scripts.
/** The icon set's SVG markup by name (icons.gen.js, scripts/build-icons.mts); icon() checks for it and for the name. */
declare var RADIAL_ICONS: Partial<Record<string, string>> | undefined;
/** vendor/chat/content.js (scripts/build-chat.mts, globalName RadialChatContent). */
declare var RadialChatContent: RadialChatContentBundle;
/**
 * vendor/fluid/chat.js (scripts/build-fluid.mts, globalName RadialFluidChat).
 * The native chat and its composer check for it and fall back to plain DOM without it.
 */
declare var RadialFluidChat: RadialFluidChatApi | undefined;
/** vendor/xterm.js: the UMD build copies its exports onto the global object. */
declare var Terminal: typeof import('@xterm/xterm').Terminal;
/** vendor/addon-fit.js: the UMD build puts its exports under one global. */
declare var FitAddon: typeof import('@xterm/addon-fit');

// The window enables Electron's <webview> tag: createElement('webview') makes one.
interface HTMLElementTagNameMap { webview: RadialWebview }

// Chromium's EyeDropper API (colorPicker.js checks for it before use).
interface EyeDropperResult { sRGBHex: string }
interface EyeDropper { open(options?: { signal?: AbortSignal }): Promise<EyeDropperResult> }
declare var EyeDropper: { prototype: EyeDropper; new (): EyeDropper } | undefined;

// Flags the renderer keeps on window.
/** The first preview load was marked for the perf log. */
declare var __firstPreviewMarked: boolean | undefined;
/** The button the publish menu opened from, for positioning it. */
declare var _pubMenuAnchor: HTMLElement | null | undefined;

// The HTML timers take any id, null included (it converts to 0, which names no
// timer); the scripts clear timers whose variable starts out null.
declare function clearTimeout(id: number | null | undefined): void;
declare function clearInterval(id: number | null | undefined): void;
