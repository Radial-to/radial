// An applyInsert/applyMove/applyRemove result as the structural-edit tests read
// it before narrowing: `reason` fills the message of the assert on `ok`
// (undefined on success), `relFile` is read once `ok` is asserted (undefined on
// a failure). It is StructuralEditOutcome with the field each branch lacks
// marked absent, like editInsert's own `fail?: undefined`. Once
// src/main/editInsert.ts exports its outcome that way, import it instead.
import type { StructuralEditDone, StructuralEditFailure } from '../../src/main/editInsert';

export type StructuralEditReadout =
  | (StructuralEditDone & { reason?: undefined })
  | (StructuralEditFailure & { relFile?: undefined });
