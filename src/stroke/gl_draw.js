// =============================================================================
// Module: GL Draw (WebGPU, W3)
//
// Replaces the WebGL2 batching module outright (plan: no second backend).
// What is deliberately KEPT from the original:
//   - matrix snapshotting once per stroke (snapshotMatrix)
//   - flat Float32Array queue packing with doubling growth
//     (lives in webgpu/stamps.js — reallocate only when exceeded)
//   - dirty-rect accumulation in device pixels
//   - the begin/end/resetDirectShaderTracking hook call sites (they are
//     host-contract concerns; the standalone WebGPU adapter no-ops them)
//
// Two stamp producers feed the brush mask:
//   - CPU walk (stroke.js tip loop) → circle()/stampImage() queues →
//     glDraw()/glDrawImages() flush through the W2 stamp renderer
//   - GPU walk (strokewalk-compute) → queueWalkStroke() descriptors →
//     flushWalkBatch() rasterizes stamps straight from the storage buffer
//     with drawIndirect (no readback — gotcha #9)
//
// ORDER: the mask blend (one-minus-dst-alpha, one) is order-dependent
// (gotcha #10), so every CPU flush and every composite flushes the pending
// GPU-walk batch first — stamps always land in draw order.
// =============================================================================

import { Cwidth, Cheight, Density, Renderer } from "../core/target.js";
import {
  Mix,
  isMixReady,
  State,
} from "../core/color.js";
import {
  beginDirectMaskDraw,
  endDirectMaskDraw,
  resetDirectShaderTracking,
} from "../core/renderer_runtime.js";
import { getAffineMatrix, notifyDraw } from "../core/runtime.js";
import { _getSeedU32 } from "../core/utils.js";
import { _fieldSnapshot, _fieldEpochNow } from "../core/flowfield.js";
import { Stats } from "../core/stats.js";
import {
  createStrokeWalker,
  createDescriptorBuilder,
} from "../webgpu/strokewalk.js";
import { createUniformRing } from "../webgpu/pipeline.js";
import { STAMP_BLEND } from "../webgpu/stamps.js";
import { WALK_RASTER_WGSL } from "../webgpu/wgsl/walkraster.wgsl.js";

// =============================================================================
// Section: Initialization and Setup
// =============================================================================

let isLoaded = false;
let host = null; // Renderer.host once loaded
let loadedWidth = 0,
  loadedHeight = 0,
  loadedDensity = 1;

// Cached matrix values — snapshotted once per stroke in snapshotMatrix()
let _ma = 1,
  _mb = 0,
  _mc = 0,
  _md = 1,
  _mx = 0,
  _my = 0,
  _halfW = 0,
  _halfH = 0,
  _scale = 1,
  _density = 1;

/**
 * Snapshots the current runtime affine transform. Call once at the start of each stroke.
 */
export function snapshotMatrix() {
  const m = getAffineMatrix();
  _ma = m.a;
  _mb = m.b;
  _mc = m.c;
  _md = m.d;
  _mx = m.x;
  _my = m.y;
  _halfW = Cwidth / 2;
  _halfH = Cheight / 2;
  _scale = Math.sqrt(_ma * _ma + _mb * _mb);
  _density = Density;
}

/** True when the snapshotted matrix is a pure translation (GPU-walk gate). */
export function matrixIsTranslation() {
  return _ma === 1 && _mb === 0 && _mc === 0 && _md === 1;
}

function ensureBrushMaskTarget() {
  const rendererMask = Renderer?.glMask;
  if (!rendererMask) return null;
  rendererMask.dirtyRect ??= null;
  rendererMask.isDrawn ??= false;
  Mix.glMask = rendererMask;
  return rendererMask;
}

/**
 * Ensures the WebGPU stamp path is ready. Mirrors the old isReady():
 * (re)binds the mask target and refreshes size-dependent state.
 */
export function isReady() {
  isMixReady();
  ensureBrushMaskTarget();

  const nextHost = Renderer.host;
  nextHost.requireReady();
  const needsRefresh =
    !isLoaded ||
    host !== nextHost ||
    loadedWidth !== Cwidth ||
    loadedHeight !== Cheight ||
    loadedDensity !== Density;
  if (!needsRefresh) return;

  host = nextHost;
  loadedWidth = Cwidth;
  loadedHeight = Cheight;
  loadedDensity = Density;
  host.stamps.setSize(
    Math.max(1, Math.round(Cwidth * Density)),
    Math.max(1, Math.round(Cheight * Density)),
    { flipY: true },
  );
  initWalker();
  isLoaded = true;
}

function accumulateDirtyRect(currentRect, minX, minY, maxX, maxY) {
  if (!currentRect) return { minX, minY, maxX, maxY };
  if (minX < currentRect.minX) currentRect.minX = minX;
  if (minY < currentRect.minY) currentRect.minY = minY;
  if (maxX > currentRect.maxX) currentRect.maxX = maxX;
  if (maxY > currentRect.maxY) currentRect.maxY = maxY;
  return currentRect;
}

let circleDirtyRect = null;
let imgDirtyRect = null;

// =============================================================================
// Section: Drawing Primitives (CPU walk producers)
// =============================================================================

/**
 * Queue a circle stamp. Same coordinate contract as the WebGL module:
 * x/y in position space (user coords + Cwidth/2, Cheight/2), diameter in
 * user units, alpha in [0..255]. Applies the snapshotted affine transform.
 */
export function circle(x, y, diameter, alpha) {
  if (Stats.enabled) {
    Stats.countStamp();
    Stats.hashNums(x, y, diameter, alpha);
  }
  const px = x - _halfW;
  const py = y - _halfH;

  const screenX = _ma * px + _mc * py + _mx + _halfW;
  const screenY = _mb * px + _md * py + _my + _halfH;
  const radius = (_density * diameter * _scale) / 2;

  const dScreenX = screenX * _density;
  const dScreenY = screenY * _density;
  host.stamps.disc(dScreenX, dScreenY, radius, alpha / 255);
  circleDirtyRect = accumulateDirtyRect(
    circleDirtyRect,
    dScreenX - radius - 1,
    dScreenY - radius - 1,
    dScreenX + radius + 1,
    dScreenY + radius + 1,
  );
}

/**
 * Queue an image stamp. Same contract as circle(); size is the full stamp
 * diameter in user units, angle in radians.
 */
export function stampImage(x, y, size, angle, alpha, extraPadding = 0) {
  if (Stats.enabled) {
    Stats.countStamp();
    Stats.hashNums(x, y, size, angle, alpha);
  }
  const px = x - _halfW;
  const py = y - _halfH;
  const screenX = _ma * px + _mc * py + _mx + _halfW;
  const screenY = _mb * px + _md * py + _my + _halfH;
  const halfSize = (_density * size * _scale) / 2;
  const extraRadius = _density * extraPadding * _scale;

  const dScreenX = screenX * _density;
  const dScreenY = screenY * _density;
  host.stamps.image(dScreenX, dScreenY, halfSize, angle, alpha / 255, extraRadius);
  const boundsRadius = halfSize * 1.42 + extraRadius;
  imgDirtyRect = accumulateDirtyRect(
    imgDirtyRect,
    dScreenX - boundsRadius - 1,
    dScreenY - boundsRadius - 1,
    dScreenX + boundsRadius + 1,
    dScreenY + boundsRadius + 1,
  );
}

/**
 * Flush all queued image stamps in one instanced draw.
 * @param {object} p5img - The preprocessed brush-tip surface (from T.tips).
 * @param {string} src - The image src string / tip key, texture cache key.
 */
export function glDrawImages(p5img, src) {
  if (host?.stamps.imageCount === 0 || !p5img) {
    if (host && host.stamps.imageCount > 0 && !p5img) {
      throw new Error(`brush-gpu: no tip surface for image brush "${src}"`);
    }
    return;
  }
  flushWalkBatch(); // preserve stamp order (gotcha #10)
  Mix.glMask.isDrawn = true;
  const targetState = beginDirectMaskDraw(Renderer, null, Mix.glMask);

  const color = State.stroke.color._array;
  host.stamps.drawImages(null, {
    view: Mix.glMask.view,
    color,
    src,
    source: p5img.canvas,
  });

  endDirectMaskDraw(Renderer, null, targetState);
  if (imgDirtyRect) {
    Mix.markDirtyRect(Mix.glMask, imgDirtyRect);
    imgDirtyRect = null;
  }
  resetDirectShaderTracking(Renderer, null);
}

/**
 * Removes a cached tip texture by key, forcing re-upload on next draw.
 */
export function invalidateTexEntry(key) {
  host?.stamps.invalidateTip(key);
}

/**
 * Flush all queued circle stamps in one instanced draw.
 */
export function glDraw() {
  if (!host || host.stamps.discCount === 0) return;
  flushWalkBatch(); // preserve stamp order (gotcha #10)
  Mix.glMask.isDrawn = true;
  const targetState = beginDirectMaskDraw(Renderer, null, Mix.glMask);

  const color = State.stroke.color._array;
  host.stamps.drawDiscs(null, { view: Mix.glMask.view, color });

  endDirectMaskDraw(Renderer, null, targetState);
  if (circleDirtyRect) {
    Mix.markDirtyRect(Mix.glMask, circleDirtyRect);
    circleDirtyRect = null;
  }
  resetDirectShaderTracking(Renderer, null);
}

// =============================================================================
// Section: GPU walk router (strokewalk-compute integration)
// =============================================================================

let walker = null;
let walkerReady = false;
let builder = null;
let rasterPipeline = null;
let rasterLayout = null;
let rasterRing = null;
const rasterUniform = new Float32Array(12);

// Environment cache — re-upload only when any input changed.
const envState = { seed: -1, fieldEpoch: -1, fieldName: null, w: 0, h: 0, pool: null };

// Pending batch: descriptors + the shared translation/color they were
// queued under. A change in any batch key flushes first.
let pending = [];
let pendingKey = null; // { mx, my, r, g, b }

/** Allow tests / users to force the retained CPU walk. */
let useCpuWalk = false;
export function _setUseCpuWalk(v) {
  useCpuWalk = !!v;
}

function initWalker() {
  if (walker || !host?.gpu) return;
  walker = createStrokeWalker(host.gpu);
  walker.ensureReady().then(
    () => {
      walkerReady = true;
    },
    (err) => {
      console.warn("brush-gpu: GPU stroke walk unavailable, using CPU walk:", err);
      walker = null;
    },
  );
  rasterRing = createUniformRing(host.gpu, { slots: 64 });
}

/**
 * Awaitable walker warmup, called from brush.ready(): a whole sketch can
 * render in one synchronous block right after ready() resolves, so the
 * walker must be compiled BEFORE the first draw call or every stroke of
 * that block falls back to the CPU walk.
 * @param {object} rendererHost the adapter's GPU host
 */
export async function initWalkRouter(rendererHost) {
  host = rendererHost;
  initWalker();
  if (walker) await walker.ensureReady();
}

function ensureRasterPipeline() {
  if (rasterPipeline) return;
  rasterPipeline = host.cache.getRenderPipeline({
    code: WALK_RASTER_WGSL,
    vertexEntry: "vs",
    fragmentEntry: "fs",
    blend: STAMP_BLEND,
    format: host.gpu.format,
    topology: "triangle-strip",
    label: "walk-raster",
  });
  rasterLayout = rasterPipeline.getBindGroupLayout(0);
}

/**
 * Router gate: can this stroke take the GPU walk?
 * Coverage (recorded in FORK.md): line/flowLine strokes with
 * default/marker/spray tips, gaussian or array-control-point pressure,
 * pure-translation transform. Everything else — plots, image/custom tips,
 * function-curve pressure, rotated/scaled transforms, Stats capture runs —
 * takes the retained CPU walk (a first-class producer, not a fallback).
 */
export function walkEligible(param) {
  if (useCpuWalk || Stats.enabled) return false;
  if (!walker || !walkerReady || !host?.gpu) return false;
  if (!param) return false;
  const type = param.type ?? "default";
  if (type !== "default" && type !== "marker" && type !== "spray") return false;
  const pr = param.pressure;
  if (!pr) return false;
  if (pr.type === "custom" && !Array.isArray(pr.points)) return false;
  if (!matrixIsTranslation()) return false;
  return true;
}

function ensureEnvironment(gaussPool) {
  const seed = _getSeedU32();
  const fieldEpoch = _fieldEpochNow();
  const field = _fieldSnapshot();
  const fieldName = field?.name ?? null;
  if (
    envState.seed === seed &&
    envState.fieldEpoch === fieldEpoch &&
    envState.fieldName === fieldName &&
    envState.w === Cwidth &&
    envState.h === Cheight &&
    envState.pool === gaussPool
  ) {
    return;
  }
  // Environment (seed word, field, pools) is about to change: any pending
  // descriptors were built against the CURRENT environment and must walk
  // under it, not the new one.
  flushWalkBatch();
  walker.setEnvironment({
    seedU32: seed,
    width: Cwidth,
    height: Cheight,
    gaussPool: Float32Array.from(gaussPool),
    field,
  });
  builder = createDescriptorBuilder({ seedU32: seed, width: Cwidth, height: Cheight });
  envState.seed = seed;
  envState.fieldEpoch = fieldEpoch;
  envState.fieldName = fieldName;
  envState.w = Cwidth;
  envState.h = Cheight;
  envState.pool = gaussPool;
}

/**
 * Queue one stroke for the GPU walk. Caller (stroke.js) has already run
 * Mix.blend and owns strokeId sequencing and the pressure-cache chain.
 *
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
export function queueWalkStroke(o) {
  ensureEnvironment(o.gaussPool);

  const key = pendingKey;
  const color = State.stroke.color._array;
  if (
    key &&
    (key.mx !== _mx || key.my !== _my ||
      key.r !== color[0] || key.g !== color[1] || key.b !== color[2])
  ) {
    flushWalkBatch();
  }
  pendingKey = { mx: _mx, my: _my, r: color[0], g: color[1], b: color[2] };

  builder.setChain(o.chain);
  const desc = builder.build({
    kind: o.kind,
    x: o.x,
    y: o.y,
    dir: o.dir,
    length: o.length,
    brush: o.brush,
    strokeWeight: o.strokeWeight,
    matrix: { x: _mx, y: _my },
    fieldActive: o.fieldActive,
    wiggle: o.wiggle,
    strokeId: o.strokeId,
  });
  pending.push(desc);
  notifyDraw();

  // Conservative dirty rect (device px). With a field active the walk can
  // bend anywhere within `length` of the start; without one it is a
  // straight segment. Margin covers scatter + tip size + marker tips.
  const margin =
    2 +
    o.strokeWeight *
      ((o.brush.scatter ?? 0) * 2 + (o.brush.weight ?? 1) * Math.max(1, desc.pmax ?? 1) * 2);
  const x0 = desc.x0;
  const y0 = desc.y0;
  let minX, minY, maxX, maxY;
  if (o.fieldActive) {
    minX = x0 - o.length - margin;
    maxX = x0 + o.length + margin;
    minY = y0 - o.length - margin;
    maxY = y0 + o.length + margin;
  } else {
    const ex = x0 + desc.dxc * desc.totalSteps;
    const ey = y0 + desc.dyc * desc.totalSteps;
    minX = Math.min(x0, ex) - margin;
    maxX = Math.max(x0, ex) + margin;
    minY = Math.min(y0, ey) - margin;
    maxY = Math.max(y0, ey) + margin;
  }
  const d = _density;
  Mix.glMask.isDrawn = true;
  Mix.markDirtyRect(Mix.glMask, {
    minX: (minX + _mx) * d,
    minY: (minY + _my) * d,
    maxX: (maxX + _mx) * d,
    maxY: (maxY + _my) * d,
  });

  return builder.getChain();
}

/**
 * Runs the pending GPU-walk batch: compute (count → scan → indirect →
 * walk) then one instanced drawIndirect into the brush mask. Called
 * before every CPU stamp flush and before every composite.
 */
export function flushWalkBatch() {
  if (pending.length === 0) return;
  const descs = pending;
  const key = pendingKey;
  pending = [];
  pendingKey = null;

  const batch = walker.walk(descs); // submits its own compute encoder
  ensureRasterPipeline();

  const W = Math.max(1, Math.round(Cwidth * Density));
  const H = Math.max(1, Math.round(Cheight * Density));
  rasterUniform[0] = 2 / W;
  rasterUniform[1] = -2 / H;
  rasterUniform[2] = -1;
  rasterUniform[3] = 1;
  rasterUniform[4] = key.r;
  rasterUniform[5] = key.g;
  rasterUniform[6] = key.b;
  rasterUniform[7] = 1;
  rasterUniform[8] = key.mx;
  rasterUniform[9] = key.my;
  rasterUniform[10] = Density;
  rasterUniform[11] = 0;
  const slot = rasterRing.write(rasterUniform);

  // Per-batch buffers churn, so bypass the bind-group cache (its own
  // documented guidance for churning resources).
  const bind = host.gpu.device.createBindGroup({
    label: "walk-raster-bg",
    layout: rasterLayout,
    entries: [
      { binding: 0, resource: { buffer: slot.buffer, offset: slot.offset, size: slot.size } },
      { binding: 1, resource: { buffer: batch.stampsBuffer } },
    ],
  });

  const enc = host.gpu.device.createCommandEncoder({ label: "walk-raster" });
  const pass = enc.beginRenderPass({
    label: "walk-raster",
    colorAttachments: [
      { view: Mix.glMask.view, loadOp: "load", storeOp: "store" },
    ],
  });
  pass.setPipeline(rasterPipeline);
  pass.setBindGroup(0, bind);
  pass.drawIndirect(batch.indirectBuffer, 0);
  pass.end();
  host.gpu.device.queue.submit([enc.finish()]);
  rasterRing.reset(); // writeBuffer is queue-ordered — safe post-submit
  batch.destroy(); // deferred by WebGPU until execution completes
}
