// =============================================================================
// Adapter: Standalone deferred-call recorder
//
// Upstream p5.brush is synchronous: createCanvas() then draw. WebGPU device
// acquisition has no synchronous form, so between createCanvas()/load() and
// the device resolving, the standalone build RECORDS every stateful public
// call and replays the whole sequence in program order once the device (and
// the GPU stroke walker) is ready. `await brush.ready()` is therefore
// optional; sketches written for upstream run unmodified.
//
// Cost after the first flush: one boolean check per public call.
//
// One recorder per painting (`ctx.recorder`): a second painting still
// initializing must not swallow the calls of one that is already up, and
// each replays only its own queue. `guardFor(ctx, fn)` wraps a call for one
// context and reads that context's recorder at call time; `guard(fn)` is
// the default painting's wrapper, which is what the module-level API uses.
//
// What is deferred: anything that mutates library state or draws — the
// whole call sequence must replay in order, because a deferred line() has
// to see the set()/fill()/push() state that was current when it was called.
// What is not: pure functions (random, noise, box, listFields, ...),
// lifecycle (createCanvas, load, ready, readPixels, gpu), the inspection
// API, and snapshots (they return handles, so they cannot be deferred and
// still throw before ready). seed()/noiseSeed() apply immediately AND are
// replayed in full, see index.standalone.js.
//
// Semantics that differ from a synchronous run, all pre-ready only:
//   - upstream's argument and precondition errors (unknown brush/field
//     name, bad angle mode, drawing with no brush set, vertex() outside
//     beginShape(), refreshField() with no field, ...) still throw at the
//     call site: precheck.js runs them against a shadow of the checked
//     state via the `validate` hook below. Anything not covered there
//     (an invalid color value, a Plot/Polygon-level error) surfaces at
//     replay, inside the ready() promise, not at the call site;
//   - random() shares its stream with circle()/Plot/mass()/field generation
//     (upstream design). A random() value read after a pre-ready seed() is
//     that stream's first draw, where a synchronous run would have consumed
//     the intervening drawing first. The replayed image and the post-ready
//     random() sequence both match the synchronous run exactly.
// =============================================================================

import { defaultContext, registerContextInit } from "../../core/context.js";

/**
 * The recorder of one painting: the recording flag, the call queue, and the
 * listeners that re-seed derived state when recording starts (precheck.js's
 * shadow).
 *
 * @returns {object} The `ctx.recorder` object.
 */
export function createRecorder() {
  /** @type {Set<() => void>} */
  const armListeners = new Set();
  return {
    deferring: false,
    /** @type {Array<[Function, unknown, unknown[]]>} */
    queue: [],

    /** Register a callback that runs whenever recording starts. */
    onArm(fn) {
      armListeners.add(fn);
      return () => armListeners.delete(fn);
    },

    /** Start recording (called when a new target is loaded). */
    arm() {
      this.deferring = true;
      for (const fn of armListeners) fn();
    },

    /**
     * Stop recording and replay everything recorded, in order. Calls made
     * while replaying run immediately (deferring is already off).
     */
    flush() {
      this.deferring = false;
      const pending = this.queue;
      this.queue = [];
      for (let i = 0; i < pending.length; i++) {
        const [fn, self, args] = pending[i];
        fn.apply(self, args);
      }
    },
  };
}

registerContextInit((ctx) => {
  ctx.recorder = createRecorder();
});

/**
 * Register a callback that runs whenever this context starts recording
 * (precheck.js re-seeds its shadow there).
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {() => void} fn
 * @returns {() => boolean} unregister
 */
export function onArm(ctx, fn) {
  return ctx.recorder.onArm(fn);
}

/**
 * Start recording this context's stateful calls.
 * @param {import("../../core/context.js").BrushContext} ctx
 */
export function armDeferred(ctx) {
  ctx.recorder.arm();
}

/**
 * Stop recording and replay this context's queue, in order.
 * @param {import("../../core/context.js").BrushContext} ctx
 */
export function flushDeferred(ctx) {
  ctx.recorder.flush();
}

/**
 * @param {import("../../core/context.js").BrushContext} ctx
 * @returns {boolean} true while this context is recording.
 */
export function isDeferring(ctx) {
  return ctx.recorder.deferring;
}

/**
 * Wrap a stateful call FOR ONE CONTEXT: recorded while that context is
 * recording, direct otherwise. The recorder is read at call time, so a
 * wrapper built before the adapter installed one still works.
 *
 * Preserves `this` so prototype methods (Polygon#show, Plot#show) wrap too.
 * A deferred call returns undefined.
 *
 * `validate`, when given, runs synchronously at the call site while
 * deferring, so argument errors that need no device state (unknown brush
 * or field name, bad angle mode) throw exactly where a synchronous run
 * would throw them. When not deferring, `fn` performs its own checks.
 *
 * @template {Function} F
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {F} fn
 * @param {(...args: unknown[]) => void} [validate]
 * @returns {F}
 */
export function guardFor(ctx, fn, validate) {
  return /** @type {F} */ (
    function guarded(...args) {
      const rec = ctx.recorder;
      if (rec && rec.deferring) {
        if (validate) validate.apply(this, args);
        rec.queue.push([fn, this, args]);
        return undefined;
      }
      return fn.apply(this, args);
    }
  );
}

/**
 * Wrap a stateful call for the DEFAULT painting — what the module-level
 * public API is built from.
 *
 * @template {Function} F
 * @param {F} fn
 * @param {(...args: unknown[]) => void} [validate]
 * @returns {F}
 */
export function guard(fn, validate) {
  return guardFor(defaultContext, fn, validate);
}

/**
 * Wrap a call that must take effect NOW (its result is observable before
 * ready) and ALSO hold its place in one context's replayed sequence.
 *
 * @template {Function} F
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {F} fn
 * @param {Function} replay called with the same arguments at flush time
 * @returns {F}
 */
export function guardReplayFor(ctx, fn, replay) {
  return /** @type {F} */ (
    function guarded(...args) {
      const result = fn.apply(this, args);
      const rec = ctx.recorder;
      if (rec && rec.deferring) rec.queue.push([replay, this, args]);
      return result;
    }
  );
}

/**
 * `guardReplayFor` bound to the default painting.
 *
 * @template {Function} F
 * @param {F} fn
 * @param {Function} replay called with the same arguments at flush time
 * @returns {F}
 */
export function guardReplay(fn, replay) {
  return guardReplayFor(defaultContext, fn, replay);
}
