/**
 * Runs `fn` against every context still alive, pruning collected ones.
 *
 * For global registries with per-painting caches only — a definition changed
 * in one place has to invalidate what every painting derived from it.
 *
 * @param {(ctx: BrushContext) => void} fn
 */
export function forEachContext(fn: (ctx: BrushContext) => void): void;
/**
 * Drops a context from the live registry and marks it dead.
 *
 * Called by an instance's `dispose()`. The registry holds weak refs, so this
 * is not required for collection — it only stops `forEachContext` from
 * touching a painting whose GPU resources are gone.
 *
 * @param {BrushContext} ctx
 */
export function disposeContext(ctx: BrushContext): void;
/**
 * Creates a drawing context that owns its own state.
 *
 * @param {object} [options]
 * @param {import("./rng.js").BrushRng} [options.rng] an existing rng to adopt
 *   (`defaultContext` adopts core/rng.js's module-level one); a fresh
 *   `createRng()` otherwise.
 * @returns {BrushContext}
 */
export function createContext({ rng }?: {
    rng?: import("./rng.js").BrushRng;
}): BrushContext;
/**
 * Registers a per-context initializer.
 *
 * Called at import time by every module that owns a piece of drawing state.
 * The initializer runs for each context built from here on, and immediately
 * against `defaultContext` — which is created before those modules load, so
 * it would otherwise miss everything registered after it.
 *
 * @param {(ctx: BrushContext) => void} init
 */
export function registerContextInit(init: (ctx: BrushContext) => void): void;
/**
 * The context the module-level API draws into. Every public wrapper binds
 * this one, and classes built without an explicit owner fall back to it.
 * @type {BrushContext}
 */
export const defaultContext: BrushContext;
/**
 * The context handed to every internal drawing function.
 */
export type BrushContext = {
    /**
     * Brush state slices (stroke, fill, wash, hatch,
     * mass, field), each installed by its owning module.
     */
    state: object;
    /**
     * Compositor / blending object (core/color.js).
     */
    mix: object | null;
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
     * The painting's own seeded randomness.
     */
    rng: import("./rng.js").BrushRng;
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
     * Host compositor hooks (core/compositor_runtime.js).
     */
    compositor: object;
    /**
     * push()/pop() brush-state stack (core/save.js).
     */
    stateStack: object[];
    /**
     * This painting's deferred-call recorder,
     * installed by the host adapter (adapters/standalone/deferred.js).
     */
    recorder: object | null;
    /**
     * True once disposeContext() has run.
     */
    disposed: boolean;
};
