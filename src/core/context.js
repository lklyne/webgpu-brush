// =============================================================================
// Module: Drawing Context
// =============================================================================
/**
 * `ctx` — the object every internal drawing function takes as its first
 * argument, and the object that OWNS the library's mutable drawing state.
 *
 * A context holds the brush state slices, the compositor (`mix`), the active
 * target (`width` / `height` / `density` / `renderer`), the host hook tables,
 * the push/pop stack, the flow-field grids and every in-flight drawing cursor.
 * Two contexts therefore paint independently.
 *
 * `ctx.rng` is still a facade over the module-level generators in
 * core/utils.js: seeds, counters and gaussian pools have not moved yet, so
 * two contexts share one random stream.
 *
 * ## How a context is assembled
 *
 * Core cannot import the modules that own the individual slices — stroke,
 * fill, wash, hatch, mass and flowfield all import core — so those modules
 * REGISTER an initializer here at import time (`registerContextInit`) and
 * `createContext()` runs the registered set. Registering also runs the
 * initializer against `defaultContext`, which exists before any of them are
 * imported; that is exactly what the old `State.stroke = {...}` bolt-on at
 * module scope did, minus the shared object.
 *
 * A context created while only part of the library has been imported gets
 * only the slices of the modules actually in the graph. The unit suites rely
 * on that: they mock whole modules away.
 */

import * as utils from "./utils.js";

const identityMatrix = {
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  x: 0,
  y: 0,
};

/**
 * Seeded randomness, in one place. `noise` / `noise2` are reassigned by
 * noiseSeed(), and the hash helpers read the module seed word, so these are
 * getters rather than copied function references.
 *
 * @typedef {object} BrushRng
 * @property {typeof utils.random} random User-facing uniform draw.
 * @property {typeof utils.rr2} rr2 Uniform float in [min, max) — user stream.
 * @property {typeof utils.randInt2} randInt2 Uniform integer — user stream.
 * @property {typeof utils.rArray} rArray Uniform pick from an array.
 * @property {typeof utils.gaussian} gaussian Sequential gaussian draw.
 * @property {typeof utils.weightedRand} weightedRand Weighted key pick.
 * @property {(x: number, y: number) => number} noise Simplex noise.
 * @property {(x: number, y: number) => number} noise2 Second noise stream.
 * @property {typeof utils.hashU32} hashU32 Counter-based hash.
 * @property {typeof utils.hash01} hash01 Counter-based uniform float.
 * @property {typeof utils.rh} rh Counter-based uniform float in a range.
 * @property {typeof utils.nh} nh Counter-based gaussian.
 * @property {typeof utils.seed} seed Reseeds every stream.
 * @property {typeof utils.noiseSeed} noiseSeed Reseeds the noise streams.
 * @property {typeof utils._onSeed} onSeed Registers a reseed callback.
 * @property {typeof utils._getSeedU32} seedU32 Current hash-stream seed word.
 */

/**
 * The context handed to every internal drawing function.
 *
 * @typedef {object} BrushContext
 * @property {object} state Brush state slices (stroke, fill, wash, hatch,
 *   mass, field), each installed by its owning module.
 * @property {object|null} mix Compositor / blending object (core/color.js).
 * @property {number} width Logical target width.
 * @property {number} height Logical target height.
 * @property {number} density Target pixel density.
 * @property {object} renderer Active renderer (host attached).
 * @property {BrushRng} rng Seeded randomness (still module-global).
 * @property {() => boolean} usesRadians True when the host angle mode is radians.
 * @property {(angle: number) => number} fromDegrees Degrees → host angle units.
 * @property {(...args: unknown[]) => object} createColor Host color factory.
 * @property {() => {a:number,b:number,c:number,d:number,x:number,y:number}} getAffineMatrix
 *   Current host transform.
 * @property {() => void} notifyDraw Tells the host a draw call happened.
 * @property {object} compositor Host compositor hooks (core/compositor_runtime.js).
 * @property {object[]} stateStack push()/pop() brush-state stack (core/save.js).
 * @property {object|null} recorder Host deferred-call recorder, or null.
 */

/**
 * Builds the randomness facade over core/utils.js.
 * @returns {BrushRng}
 */
function createRng() {
  return {
    get random() {
      return utils.random;
    },
    get rr2() {
      return utils.rr2;
    },
    get randInt2() {
      return utils.randInt2;
    },
    get rArray() {
      return utils.rArray;
    },
    get gaussian() {
      return utils.gaussian;
    },
    get weightedRand() {
      return utils.weightedRand;
    },
    get noise() {
      return utils.noise;
    },
    get noise2() {
      return utils.noise2;
    },
    get hashU32() {
      return utils.hashU32;
    },
    get hash01() {
      return utils.hash01;
    },
    get rh() {
      return utils.rh;
    },
    get nh() {
      return utils.nh;
    },
    get seed() {
      return utils.seed;
    },
    get noiseSeed() {
      return utils.noiseSeed;
    },
    get onSeed() {
      return utils._onSeed;
    },
    get seedU32() {
      return utils._getSeedU32;
    },
  };
}

/** @type {Array<(ctx: BrushContext) => void>} */
const initializers = [];

/**
 * Creates a drawing context that owns its own state.
 *
 * @returns {BrushContext}
 */
export function createContext() {
  /** @type {BrushContext} */
  const ctx = {
    // Brush state. Slices are added by their owning modules.
    state: {},
    mix: null,

    // Active target. Written by the host adapter through setTarget().
    width: undefined,
    height: undefined,
    density: undefined,
    renderer: undefined,

    // Seeded randomness. Still one module-global stream behind the facade.
    rng: createRng(),

    // Host runtime hooks. These neutral defaults are what core does with no
    // adapter registered; setRuntime() (core/runtime.js) replaces them.
    usesRadians: () => false,
    fromDegrees: (angle) => angle,
    createColor: () => {
      throw new Error("No runtime color adapter registered.");
    },
    getAffineMatrix: () => identityMatrix,
    notifyDraw: () => {},

    // Host compositor hooks, installed by core/compositor_runtime.js.
    compositor: undefined,

    // push()/pop(). A stack, not a slot: applyShader() nests a push/pop pair
    // inside a draw, so a flat object would be overwritten mid-stroke.
    stateStack: [],

    // Host deferred-call recorder, installed by the standalone entry.
    recorder: null,
  };
  for (const init of initializers) init(ctx);
  return ctx;
}

/**
 * The context the module-level API draws into. Every public wrapper binds
 * this one, and classes built without an explicit owner fall back to it.
 * @type {BrushContext}
 */
export const defaultContext = createContext();

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
export function registerContextInit(init) {
  initializers.push(init);
  init(defaultContext);
}

/**
 * Installs the host's deferred-call recorder on a context. Core never imports
 * an adapter, so the adapter registers itself here instead.
 *
 * @param {BrushContext} ctx
 * @param {object} recorder
 */
export function setRecorder(ctx, recorder) {
  ctx.recorder = recorder;
}
