/**
 * The recorder of one painting: the recording flag, the call queue, and the
 * listeners that re-seed derived state when recording starts (precheck.js's
 * shadow).
 *
 * @returns {object} The `ctx.recorder` object.
 */
export function createRecorder(): object;
/**
 * Register a callback that runs whenever this context starts recording
 * (precheck.js re-seeds its shadow there).
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {() => void} fn
 * @returns {() => boolean} unregister
 */
export function onArm(ctx: import("../../core/context.js").BrushContext, fn: () => void): () => boolean;
/**
 * Start recording this context's stateful calls.
 * @param {import("../../core/context.js").BrushContext} ctx
 */
export function armDeferred(ctx: import("../../core/context.js").BrushContext): void;
/**
 * Stop recording and replay this context's queue, in order.
 * @param {import("../../core/context.js").BrushContext} ctx
 */
export function flushDeferred(ctx: import("../../core/context.js").BrushContext): void;
/**
 * @param {import("../../core/context.js").BrushContext} ctx
 * @returns {boolean} true while this context is recording.
 */
export function isDeferring(ctx: import("../../core/context.js").BrushContext): boolean;
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
export function guardFor<F extends Function>(ctx: import("../../core/context.js").BrushContext, fn: F, validate?: (...args: unknown[]) => void): F;
/**
 * Wrap a prototype method whose painting is the RECEIVER's owner
 * (`Polygon#show`, `Plot#show`). The context is resolved at call time from
 * `this.owner`, falling back to the default painting for an object built by
 * a bare `new Polygon(...)` — exactly what the method bodies themselves do.
 *
 * A fixed `guardFor(defaultContext, …)` would be wrong here: a shape owned by
 * one painting would be recorded into another painting's queue whenever that
 * other one happened to be initializing.
 *
 * @template {Function} F
 * @param {F} fn
 * @returns {F}
 */
export function guardOwned<F extends Function>(fn: F): F;
/**
 * Wrap a stateful call for the DEFAULT painting — what the module-level
 * public API is built from.
 *
 * @template {Function} F
 * @param {F} fn
 * @param {(...args: unknown[]) => void} [validate]
 * @returns {F}
 */
export function guard<F extends Function>(fn: F, validate?: (...args: unknown[]) => void): F;
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
export function guardReplayFor<F extends Function>(ctx: import("../../core/context.js").BrushContext, fn: F, replay: Function): F;
/**
 * `guardReplayFor` bound to the default painting.
 *
 * @template {Function} F
 * @param {F} fn
 * @param {Function} replay called with the same arguments at flush time
 * @returns {F}
 */
export function guardReplay<F extends Function>(fn: F, replay: Function): F;
