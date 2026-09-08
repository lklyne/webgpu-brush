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

let deferring = false;
/** @type {Array<[Function, unknown, unknown[]]>} */
let queue = [];

/** @type {Set<() => void>} */
const armListeners = new Set();

/** Register a callback that runs whenever recording starts (precheck.js). */
export function onArm(fn) {
  armListeners.add(fn);
  return () => armListeners.delete(fn);
}

/** Start recording (called when a new target is loaded). */
export function armDeferred() {
  deferring = true;
  for (const fn of armListeners) fn();
}

export function isDeferring() {
  return deferring;
}

/**
 * Stop recording and replay everything recorded, in order. Calls made
 * while replaying run immediately (deferring is already off).
 */
export function flushDeferred() {
  deferring = false;
  const pending = queue;
  queue = [];
  for (let i = 0; i < pending.length; i++) {
    const [fn, self, args] = pending[i];
    fn.apply(self, args);
  }
}

/**
 * Wrap a stateful call: recorded while deferring, direct otherwise.
 * Preserves `this` so prototype methods (Polygon#show, Plot#show) wrap too.
 * A deferred call returns undefined.
 *
 * `validate`, when given, runs synchronously at the call site while
 * deferring, so argument errors that need no device state (unknown brush
 * or field name, bad angle mode) throw exactly where a synchronous run
 * would throw them. When not deferring, `fn` performs its own checks.
 * @template {Function} F
 * @param {F} fn
 * @param {(...args: unknown[]) => void} [validate]
 * @returns {F}
 */
export function guard(fn, validate) {
  return /** @type {F} */ (
    function guarded(...args) {
      if (deferring) {
        if (validate) validate.apply(this, args);
        queue.push([fn, this, args]);
        return undefined;
      }
      return fn.apply(this, args);
    }
  );
}

/**
 * Wrap a call that must take effect NOW (its result is observable before
 * ready) and ALSO hold its place in the replayed sequence via `replay`.
 * @template {Function} F
 * @param {F} fn
 * @param {Function} replay called with the same arguments at flush time
 * @returns {F}
 */
export function guardReplay(fn, replay) {
  return /** @type {F} */ (
    function guarded(...args) {
      const result = fn.apply(this, args);
      if (deferring) queue.push([replay, this, args]);
      return result;
    }
  );
}
