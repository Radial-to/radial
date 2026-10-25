# TypeScript in Radial

Radial for Mac is written in TypeScript. Electron runs the compiled JavaScript
in `out/`, which `npm run build` makes from `src/`.

## How it fits together

- **Build.** `scripts/build.mts` compiles every `.ts` file under `src/` with
  esbuild, one file at a time, into the same place under `out/`, and copies
  everything else (HTML, CSS, images, vendored bundles). `out/` mirrors `src/`,
  so a path the app builds from `__dirname` resolves the same way in both.
  `scripts/transpile.mts` decides how each file compiles:
  - **Main process, preload, shared** (`src/main`, `src/preload`, `src/shared`):
    ES module syntax in the source, CommonJS for Electron's Node 24, strict mode.
    The Electron-free core and its headless host (`src/core`, `src/headless`,
    plans/headless-core.md) compile the same way and also run under plain Node.
    A folder `scripts/transpile.mts` doesn't list fails the build.
  - **Window scripts** (`src/renderer/*.ts`, `src/renderer/chat/`): classic
    scripts that share one global scope, loaded in order by `index.html`. They
    never `import` or `export`; their top-level declarations are globals.
  - **Shared modules** (`DUAL` in `scripts/transpile.mts`): modules for Node and
    the tests, and globals in the window (`window.RadialFuzzy` and so on).
  - **Browser modules** (`src/renderer/ui/`): the UI library page's ES modules.
  - **The preview overlay** (`src/overlay/`): the preload of the site preview
    (`<webview>`), a classic script that runs inside the page being edited, so
    it has its own global scope and type-check project.
  - The React chat UI (`src/renderer/fluid/`) is bundled separately by
    `npm run build:fluid` into `src/renderer/vendor/fluid/`.
- **Types.** `tsc` only type-checks. Each area has its own `tsconfig.json`
  (`src/main`, `src/core`, `src/headless`, `src/preload`, `src/renderer`,
  `src/renderer/fluid`, `src/overlay`, `test`, `scripts`), all extending
  `tsconfig.base.json` with `strict` on and JavaScript off: everything
  first-party is TypeScript, and a vendored bundle the code imports brings a
  `.d.ts` (`vendor/diffs/diffs.d.ts`, written by `npm run build:diffs`).
  `src/core` and `src/headless` get Node's types only, with no DOM and no
  Electron: there, `electron` and `electron-updater` resolve to a module with
  nothing in it. `npm run typecheck` checks them all and must report 0
  errors; `npm run check` runs it and the unit tests, and the release gate
  runs it before building.
- **Tests.** `npm test` builds, then runs `test/*.test.ts` with Node's test
  runner through `tsx`. Among them, `test/coreBoundary.test.ts` walks the
  import graph from `src/core` and `src/headless` and fails if anything they
  load reaches Electron. `npm run test:e2e` drives the built app with Playwright;
  those tests (`test/*.e2e.mts`) run under Node's own type stripping, not tsx,
  because Playwright sends functions into the page as text and tsx would wrap
  them in a helper the page doesn't have. They launch the app through
  `test/support/app.ts`, in the background (`src/main/e2eBackground.ts`): its
  windows stay off the screen and never come forward, its dialogs answer as
  cancelled, what it would open outside the app is only logged, it makes no
  sound, and its clipboard and its workspace folder are its own, so they can
  run while someone uses the Mac. `RADIAL_E2E_FOREGROUND=1` shows the app as a normal window instead.
  `npm run test:smoke` (`scripts/smoke.mts`), `scripts/update-rehearsal.mts`
  and `scripts/perf/chatPerf.mts` drive the real app in the foreground on
  purpose, so run them only when nobody is using the Mac.
  `npm run test:headless` runs `test/headless.e2e.mts` alone: `radial serve` on
  plain Node, no Electron, driven through the real CLI and MCP, on macOS and
  Linux, with no browser.
  `npm run test:headless:browser` runs `test/headlessBrowser.e2e.mts`: the
  same serve with Playwright's Chrome Headless Shell for its page work
  (fields, shots, migration compares), which `radial browser install` adds.
  `npm run test:headless:remote` runs `test/headlessRemote.e2e.mts`: serve
  with `--listen`, reached over HTTP with only its address and a token (MCP,
  the CLI's /rpc, events, files and the preview proxies).
- **The npm package.** `npm run pack:cli` makes `radial-cli`, Radial without a
  window for any machine with Node (`scripts/pack-cli.mts`): the modules the
  headless core loads, traced from its entry points, and node-pty with its
  prebuilt binaries, then a size test on the tarball.
  `test/cliPackage.test.ts` packs one into a scratch folder;
  `scripts/cli-package-smoke.mts` drives an installed one, and
  `scripts/docker-smoke.mts` drives the images `docker/Dockerfile` builds
  from it.
- **Scripts.** `scripts/*.mts` run directly on Node 22.18+ (it strips the
  types), so they use erasable syntax, `import type` for types, and real file
  extensions on relative imports. The few that load app source run through tsx.
- **Development.** `npm start` builds and opens the app. While it runs, saving a
  file under `src/` compiles it and reloads the window (or restarts the app for
  main-process files).

## Writing TypeScript here

- `strict` is on. No `any`: use `unknown` and narrow it, or describe the shape
  you rely on. Annotate parameters and the return types of exported functions,
  and give empty collections their type (`new Map<string, Session>()`).
- A shape that crosses modules (IPC payloads, project state, session records)
  is an exported `interface` or `type` in the module that owns it; importers use
  `import type`.
- Only erasable syntax (`erasableSyntaxOnly`): no `enum`, `namespace`,
  parameter properties or `import x = require()`. Use `as const` objects and
  union types.
- Node built-ins and packages: default imports (`import fs from 'fs'`). App
  modules: named imports, or `import * as x from './x'` for a whole module.
- A `require()` inside a function is deliberately lazy (startup time, optional
  packages, cycles). Keep it lazy and type it:
  `const { shoot } = require('./migrate/shots') as typeof import('./migrate/shots');`
- `catch (e)`: `e` is `unknown`. `(e as Error).message` when the code expects an
  Error; `(e as NodeJS.ErrnoException).code` for system errors.
- `!` and `as` state something the code already guarantees (an element the page
  always has, a JSON shape the app wrote itself). Never `as any`. A
  `// @ts-expect-error` needs a comment saying why.
- Module exports are read-only once compiled. To let a test replace a
  dependency, give the module a deliberate seam (an injected parameter, or a
  `deps` object it calls through, like `projectLibrary.deps`).
- Window scripts reach the shared modules and the preload's API through the
  globals declared in `src/renderer/globals.d.ts`. A window script keeps the
  `'use strict'` line it has, or doesn't have.

## How the app moved to TypeScript (October 2026)

The JavaScript app moved in two kinds of commits, so behavior couldn't drift:

1. **Mechanical**: files renamed to TypeScript and `require`/`module.exports`
   switched to `import`/`export` by a codemod, with no types. A `require` below
   other top-level code stayed a `require`, so modules load in the same order.
   The unit and end-to-end suites matched the JavaScript baseline.
2. **Types only**: annotations, interfaces and casts, added in waves in
   dependency order. A checker stripped each file's types and required the
   result to match the mechanical version exactly, so typing couldn't change
   what runs; the few deliberate code changes are explained in their commits.

The codemod and the checker were one-time tools and were removed afterwards;
they're in the history of this change.
