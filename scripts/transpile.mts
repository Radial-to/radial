// How each TypeScript file under src/ becomes the JavaScript the app runs.
// Shared by scripts/build.mts and the tests that load a compiled module into a
// sandbox, so both compile a file the same way. `rel` is a path inside src/.
import { transformSync } from 'esbuild';

/**
 * How a DUAL module shows up in the window: one global that holds the whole
 * module, or each named export as a global of the same name.
 */
export type DualModule = { global: string; names?: undefined } | { names: string[]; global?: undefined };

// Shared files that are Node modules (for the main process and the tests) and
// browser globals in the window, which loads them with a <script> tag. Each is
// written as a module; the build wraps it so that in Node it exports normally
// and in the window it sets `global` (the whole module) or each of `names`.
export const DUAL: Partial<Record<string, DualModule>> = {
  'renderer/agentUrl.ts': { names: ['classifyUrl'] },
  'renderer/osc52.ts': { names: ['decodeOsc52'] },
  'renderer/adjustDirect.ts': { global: 'RadialAdjustDirect' },
  'shared/cliQuestion.ts': { global: 'RadialCliQuestion' },
  'shared/agentPaste.ts': { global: 'RadialAgentPaste' },
  'renderer/fuzzy.ts': { global: 'RadialFuzzy' },
  'renderer/guides.ts': { global: 'RadialGuides' },
  'renderer/navigation.ts': { global: 'RadialNavigation' },
  'renderer/taskTitle.ts': { global: 'RadialTaskTitle' },
  'renderer/threadPreview.ts': { global: 'RadialThreadPreview' },
  'renderer/viewport.ts': { global: 'RadialViewport' },
  'shared/chatPermissions.ts': { global: 'RadialChatPermissions' },
  'renderer/windowErrors.ts': { global: 'RadialWindowErrors' },
};

export const TS = /\.(ts|cts|mts)$/;
export const outName = (rel: string): string => rel.replace(/\.cts$/, '.cjs').replace(/\.mts$/, '.mjs').replace(/\.ts$/, '.js');
// Browser ES modules (<script type="module">): the UI library page.
const BROWSER_MODULES = [/^renderer\/ui\//];
// Main-process code, compiled for Node: the main process, its preload, the
// modules main shares with the window and the tests, and the Electron-free
// core with its headless host (plans/headless-core.md), which also run under
// plain Node.
const NODE_DIRS = ['main/', 'preload/', 'shared/', 'core/', 'headless/'];
// What each part of src/ runs on: Electron 44 ships Node 24 and Chromium 152.
const kindOf = (rel: string): 'dual' | 'module' | 'script' | 'node' => {
  if (DUAL[rel]) return 'dual';
  if (BROWSER_MODULES.some((re) => re.test(rel))) return 'module';
  if (rel.startsWith('renderer/') || rel.startsWith('overlay/')) return 'script';
  if (NODE_DIRS.some((dir) => rel.startsWith(dir))) return 'node';
  throw new Error(`src/${rel}: scripts/transpile.mts doesn't say how src/${rel.split('/')[0]}/ runs; add the folder to one of its kinds`);
};

/** The JavaScript for src/<rel>, given its TypeScript source. */
export function compile(rel: string, code: string): string {
  return compileWithMap(rel, code).code;
}

/**
 * The JavaScript for src/<rel> and its source map, which maps it back to
 * src/<rel> (sources) without the source itself (no sourcesContent): the app
 * ships the maps to say where an error happened, and main reads them for that
 * (errorReport.ts). The build writes the map beside the file (scripts/build.mts).
 */
export function compileWithMap(rel: string, code: string): { code: string; map: string } {
  const kind = kindOf(rel);
  const sourcefile = `src/${rel}`;
  const mapping = { sourcefile, sourcemap: 'external' as const, sourcesContent: false };
  if (kind === 'node') {
    // ES module syntax is always strict, and so was every main-process file
    // before TypeScript; esbuild's CommonJS output doesn't say so on its own.
    const format = rel.endsWith('.mts') ? 'esm' : 'cjs';
    const banner = format === 'cjs' ? '"use strict";' : '';
    return transformSync(code, { loader: 'ts', format, platform: 'node', target: 'node24', banner, ...mapping });
  }
  if (kind === 'script') {
    // A classic script: no wrapper, so its top-level declarations stay globals
    // shared with the window's other scripts.
    if (/^\s*(import|export)\s/m.test(code)) throw new Error(`${sourcefile}: window scripts share one global scope, so they can't import or export (or add it to DUAL in scripts/transpile.mts)`);
    return transformSync(code, { loader: 'ts', target: 'chrome152', ...mapping });
  }
  if (kind === 'module') return transformSync(code, { loader: 'ts', format: 'esm', target: 'chrome152', ...mapping });
  const { code: cjs, map } = transformSync(code, { loader: 'ts', format: 'cjs', target: 'chrome152', ...mapping });
  const dual = DUAL[rel]!; // kindOf returned 'dual' because this lookup hit
  const expose = dual.global
    ? `root.${dual.global} = api;`
    : dual.names!.map((n) => `root.${n} = api.${n};`).join(' ');
  const head = `// Built from ${sourcefile}: a Node module, or globals in the window.\n` +
    `(function (root, factory) {\n` +
    `  if (typeof module === 'object' && module.exports) module.exports = factory();\n` +
    `  else { const api = factory(); ${expose} }\n` +
    `})(typeof window === 'undefined' ? globalThis : window, function () {\n` +
    `  'use strict';\n` +
    `  const module = { exports: {} }; const exports = module.exports;\n`;
  // The wrapper's lines come first: the map starts that many lines down (an empty line of mappings each).
  const shifted = JSON.parse(map) as { mappings: string };
  shifted.mappings = ';'.repeat(head.split('\n').length - 1) + shifted.mappings;
  return { code: `${head}${cjs}\n  return module.exports;\n});\n`, map: JSON.stringify(shifted) };
}

