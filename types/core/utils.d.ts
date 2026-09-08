/**
 * Generates a random number or picks a random element from an array.
 * - random()        → float in [0, 1)
 * - random(max)     → float in [0, max)
 * - random(min,max) → float in [min, max)
 * - random(array)   → random element from array
 * @param {number|Array} [e=0]
 * @param {number} [r=1]
 * @returns {number}
 */
export function random(e?: number | any[], r?: number, ...args: any[]): number;
export namespace STREAM {
    let STROKE_SETUP: number;
    let STROKE_ALPHA_NOISE: number;
    let SPRAY_GAUSS: number;
    let SPRAY_SW: number;
    let SPRAY_DOT_R: number;
    let SPRAY_DOT_X: number;
    let SPRAY_DOT_Y: number;
    let MARKER_VIB_X: number;
    let MARKER_VIB_Y: number;
    let MARKER_ALPHA: number;
    let TIP_VIB_X: number;
    let TIP_VIB_Y: number;
    let TIP_ROT: number;
    let TIP_ALPHA: number;
    let DEFAULT_GATE: number;
    let DEFAULT_SCATTER: number;
    let DEFAULT_PERP: number;
    let DEFAULT_ALONG: number;
    let DEFAULT_SIZE: number;
    let DEFAULT_ALPHA: number;
    let FILL_WR: number;
    let FILL_MOD: number;
    let FILL_SHIFT: number;
    let FILL_CENTER_X: number;
    let FILL_CENTER_Y: number;
    let FILL_DARKER: number;
    let GROW_MOD999: number;
    let GROW_ROT: number;
    let GROW_DIST_POOL: number;
    let GROW_DIST_SCALE: number;
    let GROW_MOD_POOL: number;
    let TRIM_SAMPLE: number;
    let TRIM_JIT_X: number;
    let TRIM_JIT_Y: number;
    let TRIM_MOD: number;
    let SCATTER_PICK: number;
    let SCATTER_PULL_X: number;
    let SCATTER_PULL_Y: number;
    let ERASE_COUNT: number;
    let ERASE_X: number;
    let ERASE_Y: number;
    let ERASE_R: number;
    let HATCH_JIT_X1: number;
    let HATCH_JIT_Y1: number;
    let HATCH_JIT_X2: number;
    let HATCH_JIT_Y2: number;
    let HATCH_WEIGHT: number;
}
export function _getSeedU32(): number;
export function hashU32(streamId: number, salt: number, index: number): number;
export function hash01(streamId: any, salt: any, index: any): number;
export function rh(streamId: number, salt: number, index: number, min?: number, max?: number): number;
export function nh(streamId: any, salt: any, index: any, mean?: number, stdev?: number): number;
export function _onSeed(cb: Function): number;
export function seed(s: number | string): void;
/**
 * Simplex‐noise 2D function.
 * @type {function(number, number): number}
 */
export let noise: (arg0: number, arg1: number) => number;
export let noise2: import("simplex-noise").NoiseFunction2D;
export function noiseSeed(s: number | string): void;
export function rr2(e?: number, r?: number): number;
export function rArray(array: T[]): T;
export function randInt2(e: any, r: any): number;
export function gaussian(mean?: number, stdev?: number): number;
export function weightedRand(weights: any): string | number;
export function map(value: number, a: number, b: number, c: number, d: number, withinBounds?: boolean): number;
export function constrain(n: number, low: number, high: number): number;
export function cos(angle: number): number;
export function sin(angle: number): number;
export function cossin(angle: any): Float32Array<ArrayBuffer>;
export function toDegrees(rad: number, isRad?: boolean): number;
export function toDegreesSigned(angle: number, isRad?: boolean): number;
export function rotate(cx: number, cy: number, x: number, y: number, angle: number): {
    x: number;
    y: number;
};
export function dist(x1: number, y1: number, x2: number, y2: number): number;
export function calcAngle(x1: number, y1: number, x2: number, y2: number): number;
export function intersectLines(s1a: {
    x: number;
    y: number;
}, s1b: {
    x: number;
    y: number;
}, s2a: {
    x: number;
    y: number;
}, s2b: {
    x: number;
    y: number;
}, includeSegmentExtension?: boolean): {
    x: number;
    y: number;
} | false;
/**
 * A uniform PRNG function. Returns a float in [0,1).
 */
export type RNG = () => number;
