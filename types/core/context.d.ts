/**
 * Creates a drawing context.
 *
 * Every context created today is a view onto the same singletons, so calling
 * this twice does NOT give two independent paintings — it gives two handles
 * onto one. Ownership moves here in later steps.
 *
 * @returns {BrushContext}
 */
export function createContext(): BrushContext;
/**
 * Installs the host's deferred-call recorder on a context. Core never imports
 * an adapter, so the adapter registers itself here instead.
 *
 * @param {BrushContext} ctx
 * @param {object} recorder
 */
export function setRecorder(ctx: BrushContext, recorder: object): void;
/**
 * The context the module-level API draws into. Every public wrapper binds
 * this one, and classes built without an explicit owner fall back to it.
 * @type {BrushContext}
 */
export const defaultContext: BrushContext;
/**
 * Seeded randomness, in one place. `noise` / `noise2` are reassigned by
 * noiseSeed(), and the hash helpers read the module seed word, so these are
 * getters rather than copied function references.
 */
export type BrushRng = {
    /**
     * User-facing uniform draw.
     */
    random: typeof utils.random;
    /**
     * Uniform float in [min, max) — user stream.
     */
    rr2: typeof utils.rr2;
    /**
     * Uniform integer — user stream.
     */
    randInt2: typeof utils.randInt2;
    /**
     * Uniform pick from an array.
     */
    rArray: typeof utils.rArray;
    /**
     * Sequential gaussian draw.
     */
    gaussian: typeof utils.gaussian;
    /**
     * Weighted key pick.
     */
    weightedRand: typeof utils.weightedRand;
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
    hashU32: typeof utils.hashU32;
    /**
     * Counter-based uniform float.
     */
    hash01: typeof utils.hash01;
    /**
     * Counter-based uniform float in a range.
     */
    rh: typeof utils.rh;
    /**
     * Counter-based gaussian.
     */
    nh: typeof utils.nh;
    /**
     * Reseeds every stream.
     */
    seed: typeof utils.seed;
    /**
     * Reseeds the noise streams.
     */
    noiseSeed: typeof utils.noiseSeed;
    /**
     * Registers a reseed callback.
     */
    onSeed: typeof utils._onSeed;
    /**
     * Current hash-stream seed word.
     */
    seedU32: typeof utils._getSeedU32;
};
/**
 * The context handed to every internal drawing function.
 */
export type BrushContext = {
    /**
     * Brush state slices (stroke, fill, wash, hatch,
     * mass, field).
     */
    state: object;
    /**
     * Compositor / blending object.
     */
    mix: object;
    /**
     * Logical target width.
     */
    width: number;
    /**
     * Logical target height.
     */
    height: number;
    /**
     * Target pixel density.
     */
    density: number;
    /**
     * Active renderer (host attached).
     */
    renderer: object;
    /**
     * Seeded randomness.
     */
    rng: BrushRng;
    /**
     * True when the host angle mode is radians.
     */
    usesRadians: () => boolean;
    /**
     * Degrees → host angle units.
     */
    fromDegrees: (angle: number) => number;
    /**
     * Host color factory.
     */
    createColor: (...args: unknown[]) => object;
    /**
     *   Current host transform.
     */
    getAffineMatrix: () => {
        a: number;
        b: number;
        c: number;
        d: number;
        x: number;
        y: number;
    };
    /**
     * Tells the host a draw call happened.
     */
    notifyDraw: () => void;
    /**
     * Host deferred-call recorder, or null.
     */
    recorder: object | null;
};
import * as utils from "./utils.js";
