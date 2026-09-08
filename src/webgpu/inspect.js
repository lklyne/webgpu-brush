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
// `_iflag.active` so the seam is a no-op when unused.
// =============================================================================

const DISC_STRIDE = 4;
const IMG_STRIDE = 5;

/**
 * Hot-path guard. gl_draw.js/stroke.js test `_iflag.active` before calling
 * anything else here, so the per-stamp cost with no hooks and no capture is
 * one property read. Kept in an object so the flag can be imported once.
 */
export const _iflag = { active: false };

/** @type {Map<string, Function>} streamId -> hook fn */
const hooks = new Map();
let currentStream = "default";

// --- per-stroke staging (hooked CPU-walk strokes) --------------------------
let diverting = false;
let curStrokeId = 0;
let curStreamId = "default";
let discStage = new Float32Array(2048 * DISC_STRIDE);
let discStageN = 0;
let imgStage = new Float32Array(512 * IMG_STRIDE);
let imgStageN = 0;
let imgStagePad = 0;

/** @type {null | {active: boolean, segments: Array, batchRefs: Array}} */
let capture = null;

const stats = {
  gpuStrokes: 0,
  cpuStrokes: 0,
  hookedStrokes: 0,
  hookCalls: 0,
  capturedBatches: 0,
};

function syncFlag() {
  _iflag.active = hooks.size > 0 || (capture !== null && capture.active);
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
  if (id !== undefined) currentStream = String(id);
  return currentStream;
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
  const id = String(streamId);
  if (fn == null) {
    hooks.delete(id);
    syncFlag();
    return () => {};
  }
  if (typeof fn !== "function") {
    throw new Error("brush.onGeometry(streamId, fn): fn must be a function or null");
  }
  hooks.set(id, fn);
  syncFlag();
  return () => {
    if (hooks.get(id) === fn) hooks.delete(id);
    syncFlag();
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
  if (capture && capture.active) {
    throw new Error("brush.beginGeometry(): a capture is already active — readGeometry() or endGeometry() it first.");
  }
  capture = { active: true, segments: [], batchRefs: [] };
  syncFlag();
  return capture;
}

/**
 * Abandons a capture scope without reading it, releasing any retained GPU
 * batches. readGeometry() closes the scope itself; endGeometry() is only
 * needed to discard an unread capture.
 * @param {object} handle from beginGeometry()
 */
export function endGeometry(handle) {
  if (!handle || handle !== capture) return;
  handle.active = false;
  capture = null;
  syncFlag();
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
  if (!handle || handle !== capture || !handle.active) {
    throw new Error("brush.readGeometry(handle): handle is not the active capture — pass the value returned by beginGeometry().");
  }
  // Flush any GPU-walk descriptors still pending so their batch is captured.
  // Dynamic import avoids a module cycle (gl_draw.js imports this module).
  const { flushWalkBatch } = await import("../stroke/gl_draw.js");
  flushWalkBatch();

  handle.active = false;
  capture = null;
  syncFlag();

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
export function _geometryStats() {
  return { ...stats, hookedStreams: hooks.size, captureActive: !!(capture && capture.active) };
}
export function _resetGeometryStats() {
  stats.gpuStrokes = 0;
  stats.cpuStrokes = 0;
  stats.hookedStrokes = 0;
  stats.hookCalls = 0;
  stats.capturedBatches = 0;
}

// =============================================================================
// Section: Seam calls (gl_draw.js / stroke.js only — all _iflag-guarded)
// =============================================================================

/** walkEligible() gate: current stream has a hook -> CPU producer. */
export function _strokeHookActive() {
  return hooks.size > 0 && hooks.has(currentStream);
}

/** queueWalkStroke() counter (per stroke, unconditional, trivial). */
export function _noteGpuStroke() {
  stats.gpuStrokes++;
}

/**
 * stroke.js saveState(): a CPU-walked stroke is beginning. Latches the
 * stream/hook decision for the whole stroke (stream changes mid-stroke are
 * impossible — draw calls are synchronous).
 * @param {number} strokeId stroke.js _strokeId
 */
export function _notifyStrokeBegin(strokeId) {
  stats.cpuStrokes++;
  curStrokeId = strokeId;
  curStreamId = currentStream;
  diverting = hooks.size > 0 && hooks.has(currentStream);
  if (diverting) stats.hookedStrokes++;
  discStageN = 0;
  imgStageN = 0;
  imgStagePad = 0;
}

function growStage(stage, needed) {
  if (needed <= stage.length) return stage;
  const next = new Float32Array(Math.max(stage.length * 2, needed));
  next.set(stage);
  return next;
}

function recordCapture(kind, strokeId, values, from, to) {
  const segments = capture.segments;
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
export function _tapDisc(x, y, radius, alpha) {
  if (diverting) {
    const base = discStageN * DISC_STRIDE;
    discStage = growStage(discStage, base + DISC_STRIDE);
    discStage[base] = x;
    discStage[base + 1] = y;
    discStage[base + 2] = radius;
    discStage[base + 3] = alpha;
    discStageN++;
    return true;
  }
  if (capture && capture.active) {
    recordCapture("disc", curStrokeId, [x, y, radius, alpha], 0, DISC_STRIDE);
  }
  return false;
}

/**
 * gl_draw.stampImage() seam — like _tapDisc for image-tip stamps.
 * @param {number} pad extra dirty-rect padding (device px, per stroke)
 */
export function _tapImage(x, y, halfSize, angle, alpha, pad) {
  if (diverting) {
    const base = imgStageN * IMG_STRIDE;
    imgStage = growStage(imgStage, base + IMG_STRIDE);
    imgStage[base] = x;
    imgStage[base + 1] = y;
    imgStage[base + 2] = halfSize;
    imgStage[base + 3] = angle;
    imgStage[base + 4] = alpha;
    imgStageN++;
    if (pad > imgStagePad) imgStagePad = pad;
    return true;
  }
  if (capture && capture.active) {
    recordCapture("image", curStrokeId, [x, y, halfSize, angle, alpha], 0, IMG_STRIDE);
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
export function _drainStroke(kind) {
  const stride = kind === "disc" ? DISC_STRIDE : IMG_STRIDE;
  const n = kind === "disc" ? discStageN : imgStageN;
  if (n === 0) return null;
  const stage = kind === "disc" ? discStage : imgStage;
  let vertices = stage.slice(0, n * stride);
  const pad = kind === "disc" ? 0 : imgStagePad;
  if (kind === "disc") discStageN = 0;
  else {
    imgStageN = 0;
    imgStagePad = 0;
  }

  const fn = hooks.get(curStreamId);
  if (fn) {
    stats.hookCalls++;
    const geo = {
      streamId: curStreamId,
      kind,
      stride,
      vertices,
      counts: Uint32Array.of(n),
      strokeIds: Uint32Array.of(curStrokeId),
    };
    const ret = fn(geo);
    const replacement = ret && ret.vertices ? ret.vertices : geo.vertices;
    if (replacement.length % stride !== 0) {
      throw new Error(
        `brush.onGeometry("${curStreamId}"): replacement vertices length ${replacement.length} is not a multiple of stride ${stride}`,
      );
    }
    vertices =
      replacement instanceof Float32Array ? replacement : Float32Array.from(replacement);
  }

  if (capture && capture.active && vertices.length > 0) {
    recordCapture(kind, curStrokeId, vertices, 0, vertices.length);
  }
  return { vertices, pad };
}

/**
 * gl_draw.flushWalkBatch() seam: retains a just-submitted GPU walk batch
 * for the open capture. Returns true when the batch was retained (the
 * caller must then NOT destroy it — readGeometry()/endGeometry() will).
 * No readback happens here.
 *
 * @param {object} walker createStrokeWalker() instance (readBatch owner)
 * @param {object} batch walker.walk() return value
 * @param {Array} descs the built descriptors of this batch (salt -> id, mx/my)
 * @param {number} density device pixel density at flush time
 * @returns {boolean}
 */
export function _captureWalkBatch(walker, batch, descs, density) {
  if (!capture || !capture.active) return false;
  stats.capturedBatches++;
  capture.batchRefs.push({ walker, batch, descs, density });
  return true;
}
