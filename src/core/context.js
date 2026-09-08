// =============================================================================
// Module: Drawing Context
// =============================================================================
/**
 * `ctx` — the object every internal drawing function takes as its first
 * argument.
 *
 * Right now it is a FACADE: it owns nothing. Every accessor reads straight
 * through to the module-level singletons that still hold the state — `State`
 * and `Mix` in core/color.js, the live target bindings in core/target.js, the
 * runtime hook table in core/runtime.js, the seeded generators in
 * core/utils.js, and (installed by the host adapter) the deferred-call
 * recorder. The value of the indirection is the READ SITES: once every
 * internal function reads `ctx.state.fill` instead of `State.fill`, the state
 * itself can move onto the context without touching a single read again.
 *
 * Every accessor is a getter or a forwarding call, never a copied reference,
 * for two reasons: the target bindings and the runtime hooks are reassignable
 * `let`s whose current value must be read at call time, and a partially
 * mocked module (the unit suites mock core/color.js, core/target.js,
 * core/utils.js) is then only touched for what a caller actually uses.
 */

import * as color from "./color.js";
import * as target from "./target.js";
import * as runtime from "./runtime.js";
import * as utils from "./utils.js";

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
 *   mass, field).
 * @property {object} mix Compositor / blending object.
 * @property {number} width Logical target width.
 * @property {number} height Logical target height.
 * @property {number} density Target pixel density.
 * @property {object} renderer Active renderer (host attached).
 * @property {BrushRng} rng Seeded randomness.
 * @property {() => boolean} usesRadians True when the host angle mode is radians.
 * @property {(angle: number) => number} fromDegrees Degrees → host angle units.
 * @property {(...args: unknown[]) => object} createColor Host color factory.
 * @property {() => {a:number,b:number,c:number,d:number,x:number,y:number}} getAffineMatrix
 *   Current host transform.
 * @property {() => void} notifyDraw Tells the host a draw call happened.
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

/**
 * Creates a drawing context.
 *
 * Every context created today is a view onto the same singletons, so calling
 * this twice does NOT give two independent paintings — it gives two handles
 * onto one. Ownership moves here in later steps.
 *
 * @returns {BrushContext}
 */
export function createContext() {
  return {
    get state() {
      return color.State;
    },
    get mix() {
      return color.Mix;
    },
    get width() {
      return target.Cwidth;
    },
    get height() {
      return target.Cheight;
    },
    get density() {
      return target.Density;
    },
    get renderer() {
      return target.Renderer;
    },
    rng: createRng(),
    usesRadians: () => runtime.usesRadians(),
    fromDegrees: (angle) => runtime.fromDegrees(angle),
    createColor: (...args) => runtime.createColor(...args),
    getAffineMatrix: () => runtime.getAffineMatrix(),
    notifyDraw: () => runtime.notifyDraw(),
    recorder: null,
  };
}

/**
 * The context the module-level API draws into. Every public wrapper binds
 * this one, and classes built without an explicit owner fall back to it.
 * @type {BrushContext}
 */
export const defaultContext = createContext();

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
