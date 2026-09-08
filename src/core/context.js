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
 * `ctx.rng` (core/rng.js) is the painting's own randomness: its seed word,
 * its sequential and noise streams, and — under `ctx.rng.scopes` — the scope
 * counters and gaussian pools that `seed()` resets. `defaultContext` adopts
 * the rng that backs the module-level `random()` / `seed()` / `noise()`, so
 * those keep drawing from the same stream the default painting does.
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
 *
 * Live contexts are also tracked weakly (`forEachContext`), for the few
 * GLOBAL registries whose entries are cached per painting — re-registering a
 * custom brush tip has to drop that tip from every painting's texture cache,
 * not just the default one.
 */

import { createRng, _getDefaultRng } from "./rng.js";

const identityMatrix = {
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  x: 0,
  y: 0,
};

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
 * @property {import("./rng.js").BrushRng} rng The painting's own seeded randomness.
 * @property {() => boolean} usesRadians True when the host angle mode is radians.
 * @property {(angle: number) => number} fromDegrees Degrees → host angle units.
 * @property {(...args: unknown[]) => object} createColor Host color factory.
 * @property {() => {a:number,b:number,c:number,d:number,x:number,y:number}} getAffineMatrix
 *   Current host transform.
 * @property {() => void} notifyDraw Tells the host a draw call happened.
 * @property {object} compositor Host compositor hooks (core/compositor_runtime.js).
 * @property {object[]} stateStack push()/pop() brush-state stack (core/save.js).
 * @property {object|null} recorder This painting's deferred-call recorder,
 *   installed by the host adapter (adapters/standalone/deferred.js).
 * @property {boolean} disposed True once disposeContext() has run.
 */

/** @type {Array<(ctx: BrushContext) => void>} */
const initializers = [];

/**
 * Every context ever built, held weakly so a dropped painting can be
 * collected without the host announcing it.
 * @type {Set<WeakRef<BrushContext>>}
 */
const liveContexts = new Set();

/**
 * Runs `fn` against every context still alive, pruning collected ones.
 *
 * For global registries with per-painting caches only — a definition changed
 * in one place has to invalidate what every painting derived from it.
 *
 * @param {(ctx: BrushContext) => void} fn
 */
export function forEachContext(fn) {
  for (const ref of liveContexts) {
    const ctx = ref.deref();
    if (ctx) fn(ctx);
    else liveContexts.delete(ref);
  }
}

/**
 * Drops a context from the live registry and marks it dead.
 *
 * Called by an instance's `dispose()`. The registry holds weak refs, so this
 * is not required for collection — it only stops `forEachContext` from
 * touching a painting whose GPU resources are gone.
 *
 * @param {BrushContext} ctx
 */
export function disposeContext(ctx) {
  ctx.disposed = true;
  for (const ref of liveContexts) {
    const live = ref.deref();
    if (live === ctx || live === undefined) liveContexts.delete(ref);
  }
}

/**
 * Creates a drawing context that owns its own state.
 *
 * @param {object} [options]
 * @param {import("./rng.js").BrushRng} [options.rng] an existing rng to adopt
 *   (`defaultContext` adopts core/rng.js's module-level one); a fresh
 *   `createRng()` otherwise.
 * @returns {BrushContext}
 */
export function createContext({ rng = createRng() } = {}) {
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

    // Seeded randomness, counters and pools — this painting's alone.
    rng,

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

    // This painting's deferred-call recorder, installed by the host adapter.
    recorder: null,

    // Set by disposeContext(); the painting's GPU resources are gone.
    disposed: false,
  };
  liveContexts.add(new WeakRef(ctx));
  for (const init of initializers) init(ctx);
  return ctx;
}

/**
 * The context the module-level API draws into. Every public wrapper binds
 * this one, and classes built without an explicit owner fall back to it.
 * @type {BrushContext}
 */
export const defaultContext = createContext({ rng: _getDefaultRng() });

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
