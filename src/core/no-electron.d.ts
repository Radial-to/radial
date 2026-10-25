// What `electron` and `electron-updater` resolve to when the core and the
// headless host type-check (the paths in src/core/tsconfig.json and
// src/headless/tsconfig.json): a module with nothing in it. The core runs
// under plain Node, where neither package exists, so it can't use their types
// either; a host hands the core what it needs through the seams in
// plans/headless-core.md.
export {};
