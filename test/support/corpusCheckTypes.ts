// scripts/corpus-check.mts restates the engine types it uses: the scripts
// project reads src/ as CommonJS and can't import them. This project can, so
// here each real module must still fit the gate's restated type. An error on a
// line below means the engine changed: update the types in corpus-check.mts.
// Types only; nothing imports or runs this file.
import type { EditEngine, EditInsert, ParsedHtml } from '../../scripts/corpus-check.mts';

/** Real, checked against what the gate says it is. */
type Fits<Restated, Real extends Restated> = Real;
export type InsertFits = Fits<EditInsert, typeof import('../../src/main/editInsert')>;
export type EngineFits = Fits<EditEngine, typeof import('../../src/main/editEngine')>;
export type ScanFits = Fits<{ parseNodes: (src: string) => ParsedHtml }, typeof import('../../src/main/htmlScan')>;
