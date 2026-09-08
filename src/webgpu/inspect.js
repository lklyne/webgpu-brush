// =============================================================================
// Inspection and manipulation API
//
// One mechanism, four consumers (plan: "Inspection and manipulation"):
//   - readGeometry(handle)      inspect / log / export stroke geometry
//   - onGeometry(streamId, fn)  manipulate geometry between generate and
//                               rasterize
//   - the retained CPU walk     the debugger (unchanged, stroke.js)
//   - cpuGeometry()/noCpuGeometry()  force / release the CPU producer (gl_draw.js)
//
// THE RULE (plan gotcha #9): readback is fatal in the frame path, fine
// out-of-band. Nothing in this module stalls a frame:
//   - readGeometry() awaits GPU buffers only when the caller awaits — an
//     explicit async API at human timescales. Captured walk batches are
//     retained (destroy deferred) and mapped then, not during drawing.
//   - onGeometry() never reads a GPU buffer at all. Registering a hook
//     reroutes THAT STREAM's strokes to the retained CPU walk producer
//     (gl_draw.walkEligible consults _strokeHookActive()), whose stamps are
//     already CPU-resident — the hook runs synchronously on those arrays at
//     the stroke's flush, then they are replayed into the stamp queue.
//     HONEST COST: a hooked stream forfeits the GPU-walk speedup. Unhooked
//     streams are untouched — their strokes keep the GPU walk, and the only
//     added work anywhere is one `_iflag.active` boolean test per stamp.
//
// STREAMS. A stream is a user-chosen label for a group of strokes:
// `stream(id)` sets the current stream (default "default"); every stroke
// drawn afterwards belongs to it. Hooks are scoped per stream. Streams do
// not exist on the GPU — they are routing tags consulted per stroke.
//
// GEOMETRY FORMAT (both producers, normalized):
//   vertices  Float32Array, 4 floats per stamp: x, y (device px, post
//             transform), radius (device px, pre GL 1px clamp), alpha [0..1]
//   counts    Uint32Array, stamps per stroke
//   strokeIds Uint32Array, the library's sequential per-stroke id (shared
//             by both producers — global draw order)
// Image-tip stamps (image/custom brushes) use 5 floats per stamp — x, y,
// halfSize, angle (radians), alpha — and are reported separately (`images`).
//
// WHAT THIS IS NOT: persistent geometry editing. Immediate mode — generate,
// hook, rasterize, discard. Fill/hatch-mass polygon geometry is not captured
// here (fills are CPU-produced already; see fill/fill.js).
//
// Ownership: this file owns the mechanism; gl_draw.js/stroke.js carry only the
// minimal insertion points that call into it, every one guarded by
// `ctx.inspect.active` so the seam is a no-op when unused.
//
// Hooks, streams, staging and captures are all per painting — they describe
// what is being drawn — so the whole mechanism lives on `ctx.inspect`.
// =============================================================================

import { defaultContext, registerContextInit } from "../core/context.js";

const DISC_STRIDE = 4;
const IMG_STRIDE = 5;

/**
 * A painting's inspection state.
 *
 * `active` is the hot-path guard: gl_draw.js/stroke.js test it before calling
 * anything else here, so the per-stamp cost with no hooks and no capture is
 * one property read on an object those call sites already hold.
 *
 * @returns {object} The `ctx.inspect` object.
 */
function createInspectState() {
  return {
    active: false,
    /** @type {Map<string, Function>} streamId -> hook fn */
    hooks: new Map(),
    currentStream: "default",

    // --- per-stroke staging (hooked CPU-walk strokes) ---------------------
    diverting: false,
    curStrokeId: 0,
    curStreamId: "default",
    discStage: new Float32Array(2048 * DISC_STRIDE),
    discStageN: 0,
    imgStage: new Float32Array(512 * IMG_STRIDE),
    imgStageN: 0,
    imgStagePad: 0,

    /** @type {null | {active: boolean, segments: Array, batchRefs: Array}} */
    capture: null,

    stats: {
      gpuStrokes: 0,
      cpuStrokes: 0,
      hookedStrokes: 0,
      hookCalls: 0,
      capturedBatches: 0,
    },
  };
}

registerContextInit((ctx) => {
  ctx.inspect = createInspectState();
});

function syncFlag(ins) {
  ins.active = ins.hooks.size > 0 || (ins.capture !== null && ins.capture.active);
}

// =============================================================================
// Section: Public API (exported from index.standalone.js)
// =============================================================================

/**
 * Gets or sets the current geometry stream. Every stroke drawn after
 * `stream(id)` is tagged with that stream; hooks registered via
 * onGeometry(id, fn) apply only to matching strokes.
 * @param {string|number} [id] omit to read the current stream
 * @returns {string} the current stream id
 */
export function stream(id) {
  return _stream(defaultContext, id);
}

/**
 * Context-taking implementation of stream().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {string|number} [id]
 * @returns {string}
 */
export function _stream(ctx, id) {
  const ins = ctx.inspect;
  if (id !== undefined) ins.currentStream = String(id);
  return ins.currentStream;
}

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
export function onGeometry(streamId, fn) {
  return _onGeometry(defaultContext, streamId, fn);
}

/**
 * Context-taking implementation of onGeometry().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {string|number} streamId
 * @param {Function|null} fn
 * @returns {() => void}
 */
export function _onGeometry(ctx, streamId, fn) {
  const ins = ctx.inspect;
  const id = String(streamId);
  if (fn == null) {
    ins.hooks.delete(id);
    syncFlag(ins);
    return () => {};
  }
  if (typeof fn !== "function") {
    throw new Error("brush.onGeometry(streamId, fn): fn must be a function or null");
  }
  ins.hooks.set(id, fn);
  syncFlag(ins);
  return () => {
    if (ins.hooks.get(id) === fn) ins.hooks.delete(id);
    syncFlag(ins);
  };
}

/**
 * Opens a geometry capture scope and returns its handle. Every stroke
 * generated while the scope is open — CPU-walked or GPU-walked — is
 * recorded; GPU-walk batches are retained on the GPU (zero readback during
 * drawing) and only mapped when readGeometry() is awaited.
 *
 * One capture scope at a time (immediate-mode library, single canvas).
 * @returns {object} opaque handle for readGeometry()/endGeometry()
 */
export function beginGeometry() {
  return _beginGeometry(defaultContext);
}

/**
 * Context-taking implementation of beginGeometry().
 * @param {import("../core/context.js").BrushContext} ctx
 * @returns {object}
 */
export function _beginGeometry(ctx) {
  const ins = ctx.inspect;
  if (ins.capture && ins.capture.active) {
    throw new Error("brush.beginGeometry(): a capture is already active — readGeometry() or endGeometry() it first.");
  }
  ins.capture = { active: true, segments: [], batchRefs: [] };
  syncFlag(ins);
  return ins.capture;
}

/**
 * Abandons a capture scope without reading it, releasing any retained GPU
 * batches. readGeometry() closes the scope itself; endGeometry() is only
 * needed to discard an unread capture.
 * @param {object} handle from beginGeometry()
 */
export function endGeometry(handle) {
  return _endGeometry(defaultContext, handle);
}

/**
 * Context-taking implementation of endGeometry().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {object} handle
 */
export function _endGeometry(ctx, handle) {
  const ins = ctx.inspect;
  if (!handle || handle !== ins.capture) return;
  handle.active = false;
  ins.capture = null;
  syncFlag(ins);
  for (const b of handle.batchRefs) b.batch.destroy();
  handle.batchRefs.length = 0;
  handle.segments.length = 0;
}

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
export async function readGeometry(handle) {
  return _readGeometry(defaultContext, handle);
}

/**
 * Context-taking implementation of readGeometry().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {object} handle
 */
export async function _readGeometry(ctx, handle) {
  const ins = ctx.inspect;
  if (!handle || handle !== ins.capture || !handle.active) {
    throw new Error("brush.readGeometry(handle): handle is not the active capture — pass the value returned by beginGeometry().");
  }
  // Flush any GPU-walk descriptors still pending so their batch is captured.
  // Dynamic import avoids a module cycle (gl_draw.js imports this module).
  const { flushWalkBatch } = await import("../stroke/gl_draw.js");
  flushWalkBatch(ctx);

  handle.active = false;
  ins.capture = null;
  syncFlag(ins);

  const segs = handle.segments.map((s) => ({
    strokeId: s.strokeId,
    kind: s.kind,
    data: Float32Array.from(s.data),
  }));

  // Map retained GPU batches (the only readback, and the caller asked).
  for (const b of handle.batchRefs) {
    const { offsets, stamps } = await b.walker.readBatch(b.batch);
    for (let i = 0; i < b.batch.strokeCount; i++) {
      const start = offsets[i];
      const n = offsets[i + 1] - start;
      const d = b.descs[i];
      const out = new Float32Array(n * DISC_STRIDE);
      // Walk stamps are (x, y, diameter, alpha255) in position-space
      // logical units pre-translation (walkraster.wgsl.js contract);
      // normalize to the CPU producer's device-pixel format.
      for (let k = 0; k < n; k++) {
        const s4 = (start + k) * 4;
        const o4 = k * DISC_STRIDE;
        out[o4] = (stamps[s4] + d.mx) * b.density;
        out[o4 + 1] = (stamps[s4 + 1] + d.my) * b.density;
        out[o4 + 2] = stamps[s4 + 2] * b.density * 0.5;
        out[o4 + 3] = stamps[s4 + 3] / 255;
      }
      segs.push({ strokeId: d.salt >>> 2, kind: "disc", data: out });
    }
    b.batch.destroy();
  }
  handle.batchRefs.length = 0;

  segs.sort((a, b) => a.strokeId - b.strokeId);

  const assemble = (kind, stride) => {
    const mine = segs.filter((s) => s.kind === kind);
    let total = 0;
    for (const s of mine) total += s.data.length;
    const vertices = new Float32Array(total);
    const counts = new Uint32Array(mine.length);
    const strokeIds = new Uint32Array(mine.length);
    let off = 0;
    mine.forEach((s, i) => {
      vertices.set(s.data, off);
      off += s.data.length;
      counts[i] = s.data.length / stride;
      strokeIds[i] = s.strokeId;
    });
    return { vertices, counts, strokeIds };
  };

  const discs = assemble("disc", DISC_STRIDE);
  const imgs = assemble("image", IMG_STRIDE);
  return {
    vertices: discs.vertices,
    counts: discs.counts,
    strokeIds: discs.strokeIds,
    images: imgs.strokeIds.length > 0 ? imgs : null,
  };
}

/** Test instrumentation, not API (oracle-w4b asserts routing with these). */
export function _geometryStats(ctx = defaultContext) {
  const ins = ctx.inspect;
  return {
    ...ins.stats,
    hookedStreams: ins.hooks.size,
    captureActive: !!(ins.capture && ins.capture.active),
  };
}
export function _resetGeometryStats(ctx = defaultContext) {
  const stats = ctx.inspect.stats;
  stats.gpuStrokes = 0;
  stats.cpuStrokes = 0;
  stats.hookedStrokes = 0;
  stats.hookCalls = 0;
  stats.capturedBatches = 0;
}

// =============================================================================
// Section: Seam calls (gl_draw.js / stroke.js only — all ctx.inspect-guarded)
// =============================================================================

/** walkEligible() gate: current stream has a hook -> CPU producer. */
export function _strokeHookActive(ctx) {
  const ins = ctx.inspect;
  return ins.hooks.size > 0 && ins.hooks.has(ins.currentStream);
}

/** queueWalkStroke() counter (per stroke, unconditional, trivial). */
export function _noteGpuStroke(ctx) {
  ctx.inspect.stats.gpuStrokes++;
}

/**
 * stroke.js saveState(): a CPU-walked stroke is beginning. Latches the
 * stream/hook decision for the whole stroke (stream changes mid-stroke are
 * impossible — draw calls are synchronous).
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} strokeId the stroke scope counter (ctx.rng.scopes.stroke.id)
 */
export function _notifyStrokeBegin(ctx, strokeId) {
  const ins = ctx.inspect;
  ins.stats.cpuStrokes++;
  ins.curStrokeId = strokeId;
  ins.curStreamId = ins.currentStream;
  ins.diverting = ins.hooks.size > 0 && ins.hooks.has(ins.currentStream);
  if (ins.diverting) ins.stats.hookedStrokes++;
  ins.discStageN = 0;
  ins.imgStageN = 0;
  ins.imgStagePad = 0;
}

function growStage(stage, needed) {
  if (needed <= stage.length) return stage;
  const next = new Float32Array(Math.max(stage.length * 2, needed));
  next.set(stage);
  return next;
}

function recordCapture(ins, kind, strokeId, values, from, to) {
  const segments = ins.capture.segments;
  let seg = segments.length > 0 ? segments[segments.length - 1] : null;
  if (!seg || seg.strokeId !== strokeId || seg.kind !== kind) {
    seg = { strokeId, kind, data: [] };
    segments.push(seg);
  }
  for (let i = from; i < to; i++) seg.data.push(values[i]);
}

/**
 * gl_draw.circle() seam. Returns true when the stamp was diverted into the
 * hook staging area (caller must skip its own queueing).
 * @param {number} x device px  @param {number} y device px
 * @param {number} radius device px  @param {number} alpha [0..1]
 */
export function _tapDisc(ctx, x, y, radius, alpha) {
  const ins = ctx.inspect;
  if (ins.diverting) {
    const base = ins.discStageN * DISC_STRIDE;
    const stage = growStage(ins.discStage, base + DISC_STRIDE);
    ins.discStage = stage;
    stage[base] = x;
    stage[base + 1] = y;
    stage[base + 2] = radius;
    stage[base + 3] = alpha;
    ins.discStageN++;
    return true;
  }
  if (ins.capture && ins.capture.active) {
    recordCapture(ins, "disc", ins.curStrokeId, [x, y, radius, alpha], 0, DISC_STRIDE);
  }
  return false;
}

/**
 * gl_draw.stampImage() seam — like _tapDisc for image-tip stamps.
 * @param {number} pad extra dirty-rect padding (device px, per stroke)
 */
export function _tapImage(ctx, x, y, halfSize, angle, alpha, pad) {
  const ins = ctx.inspect;
  if (ins.diverting) {
    const base = ins.imgStageN * IMG_STRIDE;
    const stage = growStage(ins.imgStage, base + IMG_STRIDE);
    ins.imgStage = stage;
    stage[base] = x;
    stage[base + 1] = y;
    stage[base + 2] = halfSize;
    stage[base + 3] = angle;
    stage[base + 4] = alpha;
    ins.imgStageN++;
    if (pad > ins.imgStagePad) ins.imgStagePad = pad;
    return true;
  }
  if (ins.capture && ins.capture.active) {
    recordCapture(ins, "image", ins.curStrokeId, [x, y, halfSize, angle, alpha], 0, IMG_STRIDE);
  }
  return false;
}

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
export function _drainStroke(ctx, kind) {
  const ins = ctx.inspect;
  const stride = kind === "disc" ? DISC_STRIDE : IMG_STRIDE;
  const n = kind === "disc" ? ins.discStageN : ins.imgStageN;
  if (n === 0) return null;
  const stage = kind === "disc" ? ins.discStage : ins.imgStage;
  let vertices = stage.slice(0, n * stride);
  const pad = kind === "disc" ? 0 : ins.imgStagePad;
  if (kind === "disc") ins.discStageN = 0;
  else {
    ins.imgStageN = 0;
    ins.imgStagePad = 0;
  }

  const fn = ins.hooks.get(ins.curStreamId);
  if (fn) {
    ins.stats.hookCalls++;
    const geo = {
      streamId: ins.curStreamId,
      kind,
      stride,
      vertices,
      counts: Uint32Array.of(n),
      strokeIds: Uint32Array.of(ins.curStrokeId),
    };
    const ret = fn(geo);
    const replacement = ret && ret.vertices ? ret.vertices : geo.vertices;
    if (replacement.length % stride !== 0) {
      throw new Error(
        `brush.onGeometry("${ins.curStreamId}"): replacement vertices length ${replacement.length} is not a multiple of stride ${stride}`,
      );
    }
    vertices =
      replacement instanceof Float32Array ? replacement : Float32Array.from(replacement);
  }

  if (ins.capture && ins.capture.active && vertices.length > 0) {
    recordCapture(ins, kind, ins.curStrokeId, vertices, 0, vertices.length);
  }
  return { vertices, pad };
}

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
export function _captureWalkBatch(ctx, walker, batch, descs, density) {
  const ins = ctx.inspect;
  if (!ins.capture || !ins.capture.active) return false;
  ins.stats.capturedBatches++;
  ins.capture.batchRefs.push({ walker, batch, descs, density });
  return true;
}
