/**
 * Snapshots the current runtime affine transform. Call once at the start of each stroke.
 * @param {import("../core/context.js").BrushContext} ctx
 */
export function snapshotMatrix(ctx: import("../core/context.js").BrushContext): void;
/** True when the snapshotted matrix is a pure translation (GPU-walk gate). */
export function matrixIsTranslation(): boolean;
/**
 * Ensures the WebGPU stamp path is ready. Mirrors the old isReady():
 * (re)binds the mask target and refreshes size-dependent state.
 * @param {import("../core/context.js").BrushContext} ctx
 */
export function isReady(ctx: import("../core/context.js").BrushContext): void;
/**
 * Queue a circle stamp. Same coordinate contract as the WebGL module:
 * x/y in position space (user coords + Cwidth/2, Cheight/2), diameter in
 * user units, alpha in [0..255]. Applies the snapshotted affine transform.
 */
export function circle(x: any, y: any, diameter: any, alpha: any): void;
/**
 * Queue an image stamp. Same contract as circle(); size is the full stamp
 * diameter in user units, angle in radians.
 */
export function stampImage(x: any, y: any, size: any, angle: any, alpha: any, extraPadding?: number): void;
/**
 * Flush all queued image stamps in one instanced draw.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {object} p5img - The preprocessed brush-tip surface (from T.tips).
 * @param {string} src - The image src string / tip key, texture cache key.
 */
export function glDrawImages(ctx: import("../core/context.js").BrushContext, p5img: object, src: string): void;
/**
 * Removes a cached tip texture by key, forcing re-upload on next draw.
 */
export function invalidateTexEntry(key: any): void;
/**
 * Flush all queued circle stamps in one instanced draw.
 * @param {import("../core/context.js").BrushContext} ctx
 */
export function glDraw(ctx: import("../core/context.js").BrushContext): void;
export function _setUseCpuWalk(v: any): void;
/** brush.cpuGeometry() is one switch: it also forces the CPU fill DAG. */
export function _getUseCpuWalk(): boolean;
/**
 * Awaitable walker warmup, called from brush.ready(): a whole sketch can
 * render in one synchronous block right after ready() resolves, so the
 * walker must be compiled BEFORE the first draw call or every stroke of
 * that block falls back to the CPU walk.
 * @param {object} rendererHost the adapter's GPU host
 */
export function initWalkRouter(rendererHost: object): Promise<void>;
/**
 * Router gate: can this stroke take the GPU walk?
 * Coverage (recorded in FORK.md): line/flowLine strokes with
 * default/marker/spray tips, gaussian or array-control-point pressure,
 * pure-translation transform. Everything else — plots, image/custom tips,
 * function-curve pressure, rotated/scaled transforms, Stats capture runs —
 * takes the retained CPU walk (a first-class producer, not a fallback).
 */
export function walkEligible(param: any): boolean;
/**
 * Queue one stroke for the GPU walk. Caller (stroke.js) has already run
 * Mix.blend and owns strokeId sequencing and the pressure-cache chain.
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {object} o
 * @param {number} o.strokeId sequential stroke id (stroke.js _strokeId)
 * @param {"default"|"marker"|"spray"} o.kind
 * @param {number} o.x user-space start x
 * @param {number} o.y user-space start y
 * @param {number} o.dir internal degrees
 * @param {number} o.length
 * @param {object} o.brush brush params (normalized pressure)
 * @param {number} o.strokeWeight
 * @param {boolean} o.fieldActive
 * @param {number} o.wiggle
 * @param {ArrayLike<number>} o.gaussPool stroke.js gaussian pool
 * @param {{pc: number|undefined, cached: number|undefined}} o.chain
 * @returns {{pc, cached}} updated pressure-cache chain
 */
export function queueWalkStroke(ctx: import("../core/context.js").BrushContext, o: {
    strokeId: number;
    kind: "default" | "marker" | "spray";
    x: number;
    y: number;
    dir: number;
    length: number;
    brush: object;
    strokeWeight: number;
    fieldActive: boolean;
    wiggle: number;
    gaussPool: ArrayLike<number>;
    chain: {
        pc: number | undefined;
        cached: number | undefined;
    };
}): {
    pc: any;
    cached: any;
};
/**
 * Runs the pending super-batch: ONE compute submit walks every queued
 * stroke in parallel (count → scan → indirect → walk, per-group rects), then
 * one render encoder replays the groups in draw order — deferred groups as
 * clear-mask → raster → blit → composite, immediate groups as raster into
 * the live mask — and presents once. Called before every CPU stamp flush,
 * before any other composite, at frame end, and on environment change.
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {boolean} [joinMask=false] the caller is about to draw CPU stamps
 *   for the CURRENT stroke color/translation into the live mask. If the
 *   trailing deferred group matches, it is converted to immediate — it
 *   rasterizes into the mask and Mix.blend composites it together with the
 *   CPU stamps, exactly as upstream would with one mask per color. Without
 *   this the group would composite alone, and ink overlapping the CPU
 *   stamps would be spectrally mixed twice.
 */
export function flushWalkBatch(ctx: import("../core/context.js").BrushContext, joinMask?: boolean): void;
