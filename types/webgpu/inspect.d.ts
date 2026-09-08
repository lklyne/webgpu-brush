/**
 * Gets or sets the current geometry stream. Every stroke drawn after
 * `stream(id)` is tagged with that stream; hooks registered via
 * onGeometry(id, fn) apply only to matching strokes.
 * @param {string|number} [id] omit to read the current stream
 * @returns {string} the current stream id
 */
export function stream(id?: string | number): string;
/**
 * Context-taking implementation of stream().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {string|number} [id]
 * @returns {string}
 */
export function _stream(ctx: import("../core/context.js").BrushContext, id?: string | number): string;
/**
 * Registers (or with fn=null removes) a geometry hook for a stream. The
 * hook runs between generation and rasterization, once per stroke flush:
 *
 *   brush.onGeometry("layer1", (geo) => {
 *     // geo: { streamId, kind: "disc"|"image", stride, vertices, counts,
 *     //        strokeIds } — see format at the top of this file.
 *     for (let i = 0; i < geo.vertices.length; i += geo.stride)
 *       geo.vertices[i] += 40;                  // mutate in place…
 *     // …or return { vertices } replacements (length % stride === 0).
 *   });
 *
 * COST: strokes of a hooked stream take the retained CPU walk (same output
 * as the GPU walk within float precision — asserted by oracle-w4b). Other
 * streams keep the GPU walk; a hook never degrades an unrelated draw.
 *
 * @param {string|number} streamId
 * @param {Function|null} fn hook, or null to unregister
 * @returns {() => void} dispose function
 */
export function onGeometry(streamId: string | number, fn: Function | null): () => void;
/**
 * Context-taking implementation of onGeometry().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {string|number} streamId
 * @param {Function|null} fn
 * @returns {() => void}
 */
export function _onGeometry(ctx: import("../core/context.js").BrushContext, streamId: string | number, fn: Function | null): () => void;
/**
 * Opens a geometry capture scope and returns its handle. Every stroke
 * generated while the scope is open — CPU-walked or GPU-walked — is
 * recorded; GPU-walk batches are retained on the GPU (zero readback during
 * drawing) and only mapped when readGeometry() is awaited.
 *
 * One capture scope at a time (immediate-mode library, single canvas).
 * @returns {object} opaque handle for readGeometry()/endGeometry()
 */
export function beginGeometry(): object;
/**
 * Context-taking implementation of beginGeometry().
 * @param {import("../core/context.js").BrushContext} ctx
 * @returns {object}
 */
export function _beginGeometry(ctx: import("../core/context.js").BrushContext): object;
/**
 * Abandons a capture scope without reading it, releasing any retained GPU
 * batches. readGeometry() closes the scope itself; endGeometry() is only
 * needed to discard an unread capture.
 * @param {object} handle from beginGeometry()
 */
export function endGeometry(handle: object): void;
/**
 * Context-taking implementation of endGeometry().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {object} handle
 */
export function _endGeometry(ctx: import("../core/context.js").BrushContext, handle: object): void;
/**
 * Closes the capture scope and reads its geometry — the explicit, async,
 * OUT-OF-BAND readback API (one frame of hitch, invisible at inspection /
 * export timescales; never called by the frame path itself).
 *
 * @param {object} handle from beginGeometry()
 * @returns {Promise<{vertices: Float32Array, counts: Uint32Array,
 *   strokeIds: Uint32Array,
 *   images: {vertices: Float32Array, counts: Uint32Array,
 *            strokeIds: Uint32Array}|null}>}
 *   Disc-stamp geometry in the normalized format above, ordered by
 *   strokeId (draw order). `images` carries image-tip stamps when any were
 *   captured (5 floats per stamp), else null.
 */
export function readGeometry(handle: object): Promise<{
    vertices: Float32Array;
    counts: Uint32Array;
    strokeIds: Uint32Array;
    images: {
        vertices: Float32Array;
        counts: Uint32Array;
        strokeIds: Uint32Array;
    } | null;
}>;
/**
 * Context-taking implementation of readGeometry().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {object} handle
 */
export function _readGeometry(ctx: import("../core/context.js").BrushContext, handle: object): Promise<{
    vertices: Float32Array<ArrayBuffer>;
    counts: Uint32Array<any>;
    strokeIds: Uint32Array<any>;
    images: {
        vertices: Float32Array<ArrayBuffer>;
        counts: Uint32Array<any>;
        strokeIds: Uint32Array<any>;
    };
}>;
/** Test instrumentation, not API (oracle-w4b asserts routing with these). */
export function _geometryStats(ctx?: import("../core/context.js").BrushContext): any;
export function _resetGeometryStats(ctx?: import("../core/context.js").BrushContext): void;
/** walkEligible() gate: current stream has a hook -> CPU producer. */
export function _strokeHookActive(ctx: any): any;
/** queueWalkStroke() counter (per stroke, unconditional, trivial). */
export function _noteGpuStroke(ctx: any): void;
/**
 * stroke.js saveState(): a CPU-walked stroke is beginning. Latches the
 * stream/hook decision for the whole stroke (stream changes mid-stroke are
 * impossible — draw calls are synchronous).
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} strokeId the stroke scope counter (ctx.rng.scopes.stroke.id)
 */
export function _notifyStrokeBegin(ctx: import("../core/context.js").BrushContext, strokeId: number): void;
/**
 * gl_draw.circle() seam. Returns true when the stamp was diverted into the
 * hook staging area (caller must skip its own queueing).
 * @param {number} x device px  @param {number} y device px
 * @param {number} radius device px  @param {number} alpha [0..1]
 */
export function _tapDisc(ctx: any, x: number, y: number, radius: number, alpha: number): boolean;
/**
 * gl_draw.stampImage() seam — like _tapDisc for image-tip stamps.
 * @param {number} pad extra dirty-rect padding (device px, per stroke)
 */
export function _tapImage(ctx: any, x: any, y: any, halfSize: any, angle: any, alpha: any, pad: number): boolean;
/**
 * gl_draw.glDraw()/glDrawImages() seam: drains staged stamps for the
 * finishing stroke, runs the stream's hook on them (mutate in place or
 * return {vertices} replacements), records the post-hook result into any
 * open capture, and hands the final arrays back for replay into the stamp
 * queue. Null when nothing was staged.
 *
 * @param {"disc"|"image"} kind
 * @returns {{vertices: Float32Array, pad: number}|null}
 */
export function _drainStroke(ctx: any, kind: "disc" | "image"): {
    vertices: Float32Array;
    pad: number;
} | null;
/**
 * gl_draw.flushWalkBatch() seam: retains a just-submitted GPU walk batch
 * for the open capture. Returns true when the batch was retained (the
 * caller must then NOT destroy it — readGeometry()/endGeometry() will).
 * No readback happens here.
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {object} walker createStrokeWalker() instance (readBatch owner)
 * @param {object} batch walker.walk() return value
 * @param {Array} descs the built descriptors of this batch (salt -> id, mx/my)
 * @param {number} density device pixel density at flush time
 * @returns {boolean}
 */
export function _captureWalkBatch(ctx: import("../core/context.js").BrushContext, walker: object, batch: object, descs: any[], density: number): boolean;
