export namespace Stats {
    export let enabled: boolean;
    export let strokes: any[];
    export let fills: any[];
    export { FNV_OFFSET as geomHash };
    export let _stroke: any;
    export let _fill: any;
    export function reset(): void;
    /** FNV-1a over the raw float64 bits of each number. */
    export function hashNums(...nums: any[]): void;
    export function beginStroke(): void;
    export function countStamp(): void;
    export function endStroke(): void;
    export function beginFill(): void;
    export function recordLayer(layerIndex: any, vertexCount: any): void;
    export function endFill(): void;
}
/**
 * Opt-in structural instrumentation used by the parity/goldens harness
 * (test/parity/structure.js + scripts/assert-structure.mjs).
 *
 * Disabled by default; every hook is behind `Stats.enabled` so the cost in
 * normal rendering is a single boolean check. Exposed on the public module as
 * `_stats` (underscore: test-only, not API).
 *
 * Collected per run:
 * - strokes[]: { steps, drawn } — tip() invocations per stroke (exact,
 *   RNG-independent) and grain-gated stamps actually submitted.
 * - fills[]:  { layers: { [layerIndex]: [vertexCount, ...] } } — FillPoly
 *   vertex-count distribution per layer.
 * - geomHash: FNV-1a over the exact float64 bits of all submitted stroke
 *   stamps, fill-layer vertices and erase circles — a run-to-run identity
 *   fingerprint that sidesteps the canvas2d pixel noise floor.
 */
declare const FNV_OFFSET: number;
export {};
