// Types the core's modules share (src/main/main.ts declared them before
// phase 1 of plans/headless-core.md moved its orchestration here).
import type { RadialApi } from '../shared/radialApi';

/** Every key of every member of a union. */
export type KeysOfUnion<T> = T extends unknown ? keyof T : never;
/**
 * A union whose members each read the other members' fields as undefined, so
 * code can read a field before narrowing (the window's LooseUnion, in
 * src/renderer/types.d.ts). Narrowing on the discriminant still works.
 */
export type LooseUnion<T, All = T> = T extends unknown ? T & { [K in Exclude<KeysOfUnion<All>, keyof T>]?: undefined } : never;

// The window's contract (radialApi's RadialApi), method by method: the core
// answers what the window's calls answer.
/** What the ipcMain handler behind a window.radial method answers: the value its promise resolves to. */
export type AnswerTo<M extends keyof RadialApi> = RadialApi[M] extends (...args: never[]) => Promise<infer R> ? R : never;
/** A window.radial method's argument at position I, as the preload passes it on. */
export type ArgTo<M extends keyof RadialApi, I extends number> = RadialApi[M] extends (...args: infer P) => unknown ? P[I] : never;
/**
 * The object the preload packs a window.radial method's arguments into, keyed by
 * the names it gives them in order: PackedArgs<'contextWrite', ['repoDir', 'rel', 'content']>
 * is the preload's `{ repoDir, rel, content }`, each field typed as that argument of contextWrite.
 */
export type PackedArgs<M extends keyof RadialApi, Names extends readonly string[]> = { [I in keyof Names as I extends `${number}` ? Names[I] : never]: I extends `${infer N extends number}` ? ArgTo<M, N> : never };
