/**
 * Seeded randomness for one painting.
 *
 * @typedef {object} BrushRng
 * @property {(e?: number|Array, r?: number) => number} random User-facing uniform draw.
 * @property {(e?: number, r?: number) => number} rr2 Uniform float in [min, max) — user stream.
 * @property {(e: number, r: number) => number} randInt2 Uniform integer — user stream.
 * @property {(array: Array) => any} rArray Uniform pick from an array.
 * @property {(mean?: number, stdev?: number) => number} gaussian Sequential gaussian draw.
 * @property {(weights: object) => string|number} weightedRand Weighted key pick.
 * @property {(x: number, y: number) => number} noise Simplex noise.
 * @property {(x: number, y: number) => number} noise2 Second noise stream.
 * @property {(streamId: number, salt: number, index: number) => number} hashU32 Counter-based hash.
 * @property {(streamId: number, salt: number, index: number) => number} hash01 Counter-based uniform float.
 * @property {(streamId: number, salt: number, index: number, min?: number, max?: number) => number} rh
 *   Counter-based uniform float in a range.
 * @property {(streamId: number, salt: number, index: number, mean?: number, stdev?: number) => number} nh
 *   Counter-based gaussian.
 * @property {(s: number|string) => void} seed Reseeds every stream and scope.
 * @property {(s: number|string) => void} noiseSeed Reseeds the noise streams.
 * @property {(cb: () => void) => void} onSeed Registers a reseed callback.
 * @property {() => number} seedU32 Current hash-stream seed word.
 * @property {object} scopes Per-module counters and pools, installed by their
 *   owning module and reset from that module's onSeed callback.
 */
/**
 * Builds an independent set of seeded generators.
 *
 * With no argument the streams are seeded from `Math.random()` — one draw per
 * stream, as the module-level generators always were. With a seed value the
 * sequential and hash streams take it through `seed()`; the noise fields stay
 * randomly seeded until `noiseSeed()` says otherwise, which is what `seed()`
 * does too.
 *
 * @param {number|string} [initialSeed]
 * @returns {BrushRng}
 */
export function createRng(initialSeed?: number | string): BrushRng;
export function hashU32From(seedU32: number, streamId: number, salt: number, index: number): number;
export function hash01From(seedU32: any, streamId: any, salt: any, index: any): number;
export function _getDefaultRng(): BrushRng;
/** @type {BrushRng["random"]} */
export const random: BrushRng["random"];
/** @type {BrushRng["rr2"]} */
export const rr2: BrushRng["rr2"];
/** @type {BrushRng["randInt2"]} */
export const randInt2: BrushRng["randInt2"];
/** @type {BrushRng["rArray"]} */
export const rArray: BrushRng["rArray"];
/** @type {BrushRng["gaussian"]} */
export const gaussian: BrushRng["gaussian"];
/** @type {BrushRng["weightedRand"]} */
export const weightedRand: BrushRng["weightedRand"];
/** @type {BrushRng["noise"]} */
export const noise: BrushRng["noise"];
/** @type {BrushRng["noise2"]} */
export const noise2: BrushRng["noise2"];
/** @type {BrushRng["hashU32"]} */
export const hashU32: BrushRng["hashU32"];
/** @type {BrushRng["hash01"]} */
export const hash01: BrushRng["hash01"];
/** @type {BrushRng["rh"]} */
export const rh: BrushRng["rh"];
/** @type {BrushRng["nh"]} */
export const nh: BrushRng["nh"];
/** @type {BrushRng["seed"]} */
export const seed: BrushRng["seed"];
/** @type {BrushRng["noiseSeed"]} */
export const noiseSeed: BrushRng["noiseSeed"];
export function _getSeedU32(): number;
/**
 * Seeded randomness for one painting.
 */
export type BrushRng = {
    /**
     * User-facing uniform draw.
     */
    random: (e?: number | any[], r?: number) => number;
    /**
     * Uniform float in [min, max) — user stream.
     */
    rr2: (e?: number, r?: number) => number;
    /**
     * Uniform integer — user stream.
     */
    randInt2: (e: number, r: number) => number;
    /**
     * Uniform pick from an array.
     */
    rArray: (array: any[]) => any;
    /**
     * Sequential gaussian draw.
     */
    gaussian: (mean?: number, stdev?: number) => number;
    /**
     * Weighted key pick.
     */
    weightedRand: (weights: object) => string | number;
    /**
     * Simplex noise.
     */
    noise: (x: number, y: number) => number;
    /**
     * Second noise stream.
     */
    noise2: (x: number, y: number) => number;
    /**
     * Counter-based hash.
     */
    hashU32: (streamId: number, salt: number, index: number) => number;
    /**
     * Counter-based uniform float.
     */
    hash01: (streamId: number, salt: number, index: number) => number;
    /**
     *   Counter-based uniform float in a range.
     */
    rh: (streamId: number, salt: number, index: number, min?: number, max?: number) => number;
    /**
     *   Counter-based gaussian.
     */
    nh: (streamId: number, salt: number, index: number, mean?: number, stdev?: number) => number;
    /**
     * Reseeds every stream and scope.
     */
    seed: (s: number | string) => void;
    /**
     * Reseeds the noise streams.
     */
    noiseSeed: (s: number | string) => void;
    /**
     * Registers a reseed callback.
     */
    onSeed: (cb: () => void) => void;
    /**
     * Current hash-stream seed word.
     */
    seedU32: () => number;
    /**
     * Per-module counters and pools, installed by their
     * owning module and reset from that module's onSeed callback.
     */
    scopes: object;
};
