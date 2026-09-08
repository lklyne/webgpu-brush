/**
 * Captures the current painting into a pooled GPU texture.
 *
 * Flushes pending stroke/fill compositing first, so the snapshot contains
 * everything drawn up to this call. Requires `await brush.ready()`.
 *
 * @returns {{__brushSnapshot: number, width: number, height: number}} opaque handle
 */
export function snapshot(): {
    __brushSnapshot: number;
    width: number;
    height: number;
};
/**
 * Context-taking implementation of snapshot().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @returns {{__brushSnapshot: number, width: number, height: number}} opaque handle
 */
export function _snapshot(ctx: import("../../core/context.js").BrushContext): {
    __brushSnapshot: number;
    width: number;
    height: number;
};
/**
 * Restores the painting from a snapshot handle and re-presents the canvas.
 *
 * Pending (uncomposited) mask work is discarded via the same flush/reset
 * path render() uses, so the next composite starts from clean dirty-rect
 * state. The handle stays valid — restore repeatedly, in any order.
 *
 * @param {{__brushSnapshot: number}} handle from snapshot()
 */
export function restore(handle: {
    __brushSnapshot: number;
}): void;
/**
 * Context-taking implementation of restore().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {{__brushSnapshot: number}} handle
 */
export function _restore(ctx: import("../../core/context.js").BrushContext, handle: {
    __brushSnapshot: number;
}): void;
/**
 * Returns a snapshot's texture to the pool. Safe to call with an already
 * freed/dropped handle, or with one belonging to another painting (no-op,
 * returns false).
 *
 * @param {{__brushSnapshot: number}} handle
 * @returns {boolean} true if the handle was live
 */
export function freeSnapshot(handle: {
    __brushSnapshot: number;
}): boolean;
/**
 * Context-taking implementation of freeSnapshot().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {{__brushSnapshot: number}} handle
 * @returns {boolean} true if the handle was live
 */
export function _freeSnapshot(ctx: import("../../core/context.js").BrushContext, handle: {
    __brushSnapshot: number;
}): boolean;
/**
 * Destroys every snapshot texture this painting holds, live and pooled.
 *
 * For dispose() only: `release()` recycles into the spare pool, which is
 * exactly wrong when the pool itself is going away.
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 */
export function _freeAllSnapshots(ctx: import("../../core/context.js").BrushContext): void;
/** Live snapshot bound; the oldest handle is dropped when exceeded. */
export const MAX_SNAPSHOTS: 20;
