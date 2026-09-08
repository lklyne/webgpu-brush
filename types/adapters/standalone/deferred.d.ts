/** Register a callback that runs whenever recording starts (precheck.js). */
export function onArm(fn: any): () => boolean;
/** Start recording (called when a new target is loaded). */
export function armDeferred(): void;
export function isDeferring(): boolean;
/**
 * Stop recording and replay everything recorded, in order. Calls made
 * while replaying run immediately (deferring is already off).
 */
export function flushDeferred(): void;
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
export function guard<F extends Function>(fn: F, validate?: (...args: unknown[]) => void): F;
/**
 * Wrap a call that must take effect NOW (its result is observable before
 * ready) and ALSO hold its place in the replayed sequence via `replay`.
 * @template {Function} F
 * @param {F} fn
 * @param {Function} replay called with the same arguments at flush time
 * @returns {F}
 */
export function guardReplay<F extends Function>(fn: F, replay: Function): F;
