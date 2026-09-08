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
export function map(value: number, a: number, b: number, c: number, d: number, withinBounds?: boolean): number;
export function constrain(n: number, low: number, high: number): number;
export function toDegrees(ctx: import("./context.js").BrushContext, rad: number, isRad?: boolean): number;
export function toDegreesSigned(ctx: import("./context.js").BrushContext, angle: number, isRad?: boolean): number;
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
export { createRng, hashU32From, hash01From, random, rr2, randInt2, rArray, gaussian, weightedRand, noise, noise2, hashU32, hash01, rh, nh, seed, noiseSeed, _getSeedU32 } from "./rng.js";
export { cos, sin, cossin } from "./trig.js";
