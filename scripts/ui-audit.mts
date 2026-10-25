import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The census's shape is defined once, in the UI library page's data module: this
// script can load that module, but the window can't load this script's Node types.
import type { UiAudit } from '../src/renderer/ui/catalog.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
/** The source census: the inventory page renders it, and ui-library.mts serves it at /ui-audit.json. */
export type { UiAudit };
/** A raw color declaration in the stylesheets, for review in context. */
type RawDeclaration = UiAudit['rawDeclarations'][number];
export async function auditUI(): Promise<UiAudit> {
  const files = ['src/renderer/styles.css', 'src/renderer/workspace.css'];
  const tokens = new Set<string>();
  const declarations: RawDeclaration[] = [];
  const selectors = new Set<string>();
  for (const file of files) {
    const source = await fs.readFile(path.join(root, file), 'utf8');
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
    for (const match of clean.matchAll(/--([\w-]+)\s*:/g)) tokens.add(`--${match[1]}`);
    for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].trim();
      if (selector.startsWith('@')) continue;
      selectors.add(selector);
      for (const declaration of match[2].matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)) {
        if (declaration[1].startsWith('--')) continue;
        const value = declaration[2];
        if (!/(?:#[\da-f]{3,8}\b|(?:rgba?|hsla?|oklch)\()/i.test(value)) continue;
        const offset = match.index + match[0].indexOf(match[2]) + declaration.index;
        declarations.push({ file, line: clean.slice(0, offset).split('\n').length, selector, property: declaration[1], value: value.trim() });
      }
    }
  }
  const renderer = await fs.readFile(path.join(root, 'src/renderer/renderer.ts'), 'utf8');
  const registry = renderer.match(/const TOOL_PANELS = \[([\s\S]*?)\n\];/)?.[1] || '';
  const panels = [...registry.matchAll(/\{ id: '([^']+)', title: '([^']+)'([^\n]*)/g)].map((m) => ({ id: m[1], title: m[2], experimental: /experimental: true/.test(m[3]) }));
  return { files, tokenCount: tokens.size, tokens: [...tokens].sort(), selectorCount: selectors.size, rawDeclarationCount: declarations.length, rawDeclarations: declarations, panels, note: 'Source census, not an automatic visual verdict. Raw alpha scrims, color swatches, editor indicators, and isolated canvas values require contextual review.' };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await auditUI();
  console.log(JSON.stringify(process.argv.includes('--json') ? report : {
    files: report.files, tokens: report.tokenCount, selectorGroups: report.selectorCount,
    registeredPanels: report.panels, rawDeclarationsForReview: report.rawDeclarationCount,
    note: report.note,
  }, null, 2));
}
