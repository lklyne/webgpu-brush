// =============================================================================
// Module: GL Draw (WebGPU)
//
// Replaces the WebGL2 batching module outright (plan: no second backend).
// What is deliberately KEPT from the original:
//   - matrix snapshotting once per stroke (snapshotMatrix)
//   - flat Float32Array queue packing with doubling growth
//     (lives in webgpu/stamps.js — reallocate only when exceeded)
//   - dirty-rect accumulation in device pixels
//
// Two stamp producers feed the brush mask:
//   - CPU walk (stroke.js tip loop) → circle()/stampImage() queues →
//     glDraw()/glDrawImages() flush through the instanced stamp renderer
//   - GPU walk (strokewalk-compute) → queueWalkStroke() descriptors,
//     grouped by (translation, color) ACROSS color changes → flushWalkBatch()
//     walks every group in one dispatch, then rasterizes each group straight
//     from the storage buffer with drawIndirect and composites deferred
//     groups in draw order (no readback — gotcha #9; FORK.md, deferred
//     stroke groups)
//
// ORDER: the mask blend (one-minus-dst-alpha, one) is order-dependent
// (gotcha #10), so every CPU flush, every other composite, frame end and
// clear() flush the pending GPU-walk groups first — stamps and composites
// always land in draw order.
// =============================================================================

import { isMixReady } from "../core/color.js";
import { _fieldSnapshot, _fieldEpochNow } from "../core/flowfield.js";
import { Stats } from "../core/stats.js";
import {
  createStrokeWalker,
  createDescriptorBuilder,
  RECT_BYTES,
} from "../webgpu/strokewalk.js";
import { createUniformRing } from "../webgpu/pipeline.js";
import { STAMP_BLEND } from "../webgpu/stamps.js";
import { WALK_RASTER_WGSL } from "../webgpu/wgsl/walkraster.wgsl.js";
// Inspection/manipulation seam — every call below is `_iflag.active`-
// guarded (one boolean test when no hooks/captures exist; see inspect.js).
import {
  _iflag,
  _tapDisc,
  _tapImage,
  _drainStroke,
  _captureWalkBatch,
  _strokeHookActive,
  _noteGpuStroke,
} from "../webgpu/inspect.js";

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
 * @param {import("../core/context.js").BrushContext} ctx
 */
export function snapshotMatrix(ctx) {
  const m = ctx.getAffineMatrix();
  _ma = m.a;
  _mb = m.b;
  _mc = m.c;
  _md = m.d;
  _mx = m.x;
  _my = m.y;
  _halfW = ctx.width / 2;
  _halfH = ctx.height / 2;
  _scale = Math.sqrt(_ma * _ma + _mb * _mb);
  _density = ctx.density;
}

/** True when the snapshotted matrix is a pure translation (GPU-walk gate). */
export function matrixIsTranslation() {
  return _ma === 1 && _mb === 0 && _mc === 0 && _md === 1;
}

/**
 * @param {import("../core/context.js").BrushContext} ctx
 */
function ensureBrushMaskTarget(ctx) {
  const rendererMask = ctx.renderer?.glMask;
  if (!rendererMask) return null;
  rendererMask.dirtyRect ??= null;
  rendererMask.isDrawn ??= false;
  ctx.mix.glMask = rendererMask;
  return rendererMask;
}

/**
 * Ensures the WebGPU stamp path is ready. Mirrors the old isReady():
 * (re)binds the mask target and refreshes size-dependent state.
 * @param {import("../core/context.js").BrushContext} ctx
 */
export function isReady(ctx) {
  isMixReady(ctx);
  ensureBrushMaskTarget(ctx);

  const nextHost = ctx.renderer.host;
  nextHost.requireReady();
  const needsRefresh =
    !isLoaded ||
    host !== nextHost ||
    loadedWidth !== ctx.width ||
    loadedHeight !== ctx.height ||
    loadedDensity !== ctx.density;
  if (!needsRefresh) return;

  host = nextHost;
  loadedWidth = ctx.width;
  loadedHeight = ctx.height;
  loadedDensity = ctx.density;
  host.stamps.setSize(
    Math.max(1, Math.round(ctx.width * ctx.density)),
    Math.max(1, Math.round(ctx.height * ctx.density)),
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
  // Inspection hooks: hooked-stream strokes stage into inspect.js instead
  // (replayed — possibly mutated — at glDraw); captures record without
  // diverting.
  if (_iflag.active && _tapDisc(dScreenX, dScreenY, radius, alpha / 255)) return;
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
  if (
    _iflag.active &&
    _tapImage(dScreenX, dScreenY, halfSize, angle, alpha / 255, extraRadius)
  ) {
    return;
  }
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
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {object} p5img - The preprocessed brush-tip surface (from T.tips).
 * @param {string} src - The image src string / tip key, texture cache key.
 */
export function glDrawImages(ctx, p5img, src) {
  // Inspection hooks: replay this stroke's staged (hooked) image stamps into
  // the queue, recomputing the dirty rect from post-hook positions.
  if (_iflag.active && host) {
    const staged = _drainStroke("image");
    if (staged) {
      const v = staged.vertices;
      for (let i = 0; i < v.length; i += 5) {
        host.stamps.image(v[i], v[i + 1], v[i + 2], v[i + 3], v[i + 4], staged.pad);
        const br = v[i + 2] * 1.42 + staged.pad;
        imgDirtyRect = accumulateDirtyRect(
          imgDirtyRect,
          v[i] - br - 1,
          v[i + 1] - br - 1,
          v[i] + br + 1,
          v[i + 1] + br + 1,
        );
      }
    }
  }
  if (host?.stamps.imageCount === 0 || !p5img) {
    if (host && host.stamps.imageCount > 0 && !p5img) {
      throw new Error(`brush-gpu: no tip surface for image brush "${src}"`);
    }
    return;
  }
  flushWalkBatch(ctx, true); // preserve stamp order (gotcha #10); same-color group joins
  const Mix = ctx.mix;
  Mix.glMask.isDrawn = true;

  const color = ctx.state.stroke.color._array;
  host.stamps.drawImages(null, {
    view: Mix.glMask.view,
    color,
    src,
    source: p5img.canvas,
  });

  if (imgDirtyRect) {
    Mix.markDirtyRect(ctx, Mix.glMask, imgDirtyRect);
    imgDirtyRect = null;
  }
}

/**
 * Removes a cached tip texture by key, forcing re-upload on next draw.
 */
export function invalidateTexEntry(key) {
  host?.stamps.invalidateTip(key);
}

/**
 * Flush all queued circle stamps in one instanced draw.
 * @param {import("../core/context.js").BrushContext} ctx
 */
export function glDraw(ctx) {
  // Inspection hooks: replay this stroke's staged (hooked) disc stamps into
  // the queue, recomputing the dirty rect from post-hook positions.
  if (_iflag.active && host) {
    const staged = _drainStroke("disc");
    if (staged) {
      const v = staged.vertices;
      for (let i = 0; i < v.length; i += 4) {
        host.stamps.disc(v[i], v[i + 1], v[i + 2], v[i + 3]);
        circleDirtyRect = accumulateDirtyRect(
          circleDirtyRect,
          v[i] - v[i + 2] - 1,
          v[i + 1] - v[i + 2] - 1,
          v[i] + v[i + 2] + 1,
          v[i + 1] + v[i + 2] + 1,
        );
      }
    }
  }
  if (!host || host.stamps.discCount === 0) return;
  flushWalkBatch(ctx, true); // preserve stamp order (gotcha #10); same-color group joins
  const Mix = ctx.mix;
  Mix.glMask.isDrawn = true;

  const color = ctx.state.stroke.color._array;
  host.stamps.drawDiscs(null, { view: Mix.glMask.view, color });

  if (circleDirtyRect) {
    Mix.markDirtyRect(ctx, Mix.glMask, circleDirtyRect);
    circleDirtyRect = null;
  }
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
const rasterUniform = new Float32Array(16);

// Environment cache — re-upload only when any input changed.
const envState = { seed: -1, fieldEpoch: -1, fieldName: null, w: 0, h: 0, density: 0, pool: null };

// Pending super-batch: descriptors from MANY color/translation groups, walked
// together in one dispatch at flush time. Each group is a contiguous range of
// `pending` that shares translation + stroke color, in draw order.
//
// Two group modes, decided when the group opens:
//   deferred  — the brush mask held no CPU stamps, so the group's composite
//               is ours to run: at flush, every deferred group rasterizes into
//               the (cleared) mask, blits its GPU-resident dirty rect into the
//               blend-source and spectral-composites, in order. Mix.blend's
//               per-color composite sees isDrawn === false and skips.
//   immediate — CPU stamps (plot/image-tip strokes) already sit in the mask
//               for this color, so the group must join THAT mask and be
//               composited by Mix.blend like before: it rasterizes with
//               loadOp "load", marks a conservative CPU dirty rect, and
//               getStrokeShaderMask pulls it in via flushWalkBatch().
// A group never mixes modes; a CPU stamp flush drains deferred groups first
// (draw order, gotcha #10) and a composite clears isDrawn after immediates.
let pending = [];
let groups = []; // { start, end, key: {mx, my, r, g, b}, color, immediate }
let openGroup = null;

/** Allow tests / users to force the retained CPU walk. */
let useCpuWalk = false;
export function _setUseCpuWalk(v) {
  useCpuWalk = !!v;
}
/** brush.cpuGeometry() is one switch: it also forces the CPU fill DAG. */
export function _getUseCpuWalk() {
  return useCpuWalk;
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
  // A hooked stream forfeits the GPU walk (documented honest cost) —
  // its strokes take the retained CPU producer so the hook can run on
  // CPU-resident arrays with zero readback. Scoped: other streams keep
  // the GPU walk untouched.
  if (_iflag.active && _strokeHookActive()) return false;
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

/**
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {ArrayLike<number>} gaussPool
 */
function ensureEnvironment(ctx, gaussPool) {
  const seed = ctx.rng.seedU32();
  const fieldEpoch = _fieldEpochNow();
  const field = _fieldSnapshot(ctx);
  const fieldName = field?.name ?? null;
  if (
    envState.seed === seed &&
    envState.fieldEpoch === fieldEpoch &&
    envState.fieldName === fieldName &&
    envState.w === ctx.width &&
    envState.h === ctx.height &&
    envState.density === ctx.density &&
    envState.pool === gaussPool
  ) {
    return;
  }
  // Environment (seed word, field, pools) is about to change: any pending
  // descriptors were built against the CURRENT environment and must walk
  // under it, not the new one.
  flushWalkBatch(ctx);
  walker.setEnvironment({
    seedU32: seed,
    width: ctx.width,
    height: ctx.height,
    gaussPool: Float32Array.from(gaussPool),
    field,
    density: ctx.density,
  });
  builder = createDescriptorBuilder({ seedU32: seed, width: ctx.width, height: ctx.height });
  envState.seed = seed;
  envState.fieldEpoch = fieldEpoch;
  envState.fieldName = fieldName;
  envState.w = ctx.width;
  envState.h = ctx.height;
  envState.density = ctx.density;
  envState.pool = gaussPool;
}

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
export function queueWalkStroke(ctx, o) {
  _noteGpuStroke(); // inspection routing counter (per stroke, trivial)
  ensureEnvironment(ctx, o.gaussPool);

  const Mix = ctx.mix;
  const color = ctx.state.stroke.color._array;
  const immediate = Mix.glMask.isDrawn === true;
  if (
    openGroup &&
    (openGroup.immediate !== immediate ||
      openGroup.key.mx !== _mx || openGroup.key.my !== _my ||
      openGroup.key.r !== color[0] || openGroup.key.g !== color[1] ||
      openGroup.key.b !== color[2])
  ) {
    sealGroup();
  }
  if (!openGroup) {
    openGroup = {
      start: pending.length,
      end: pending.length,
      key: { mx: _mx, my: _my, r: color[0], g: color[1], b: color[2] },
      color: [color[0], color[1], color[2], color[3] ?? 1],
      immediate,
    };
  }

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
  desc.group = groups.length; // index openGroup takes when sealed
  pending.push(desc);
  ctx.notifyDraw();

  // Conservative CPU dirty rect (device px), used only when the group joins
  // the live mask (immediate now, or converted by a same-color CPU stamp
  // flush — see flushWalkBatch). With a field active the walk can bend
  // anywhere within `length` of the start; without one it is a straight
  // segment. Margin covers scatter + tip size + marker tips. Deferred
  // groups composite through an exact GPU rect instead.
  {
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
    desc.cpuRect = {
      minX: (minX + _mx) * d,
      minY: (minY + _my) * d,
      maxX: (maxX + _mx) * d,
      maxY: (maxY + _my) * d,
    };
  }
  if (immediate) Mix.markDirtyRect(ctx, Mix.glMask, desc.cpuRect);

  return builder.getChain();
}

function sealGroup() {
  if (!openGroup) return;
  openGroup.end = pending.length;
  groups.push(openGroup);
  openGroup = null;
}

const rasterUniformU32 = new Uint32Array(rasterUniform.buffer);

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
export function flushWalkBatch(ctx, joinMask = false) {
  sealGroup();
  if (pending.length === 0) return;
  const Mix = ctx.mix;
  const descs = pending;
  const gs = groups;
  pending = [];
  groups = [];

  if (joinMask) {
    const last = gs[gs.length - 1];
    const c = ctx.state.stroke.color._array;
    if (
      !last.immediate &&
      last.key.mx === _mx && last.key.my === _my &&
      last.key.r === c[0] && last.key.g === c[1] && last.key.b === c[2]
    ) {
      last.immediate = true;
      for (let i = last.start; i < last.end; i++) {
        Mix.markDirtyRect(ctx, Mix.glMask, descs[i].cpuRect);
      }
      Mix.glMask.isDrawn = true;
    }
  }

  const batch = walker.walk(
    descs,
    gs.map((g) => ({ start: g.start, end: g.end })),
  ); // submits its own compute encoder
  // An open geometry capture retains the batch (no readback here — it is
  // mapped only when readGeometry() is awaited, out-of-band).
  const captured = _iflag.active && _captureWalkBatch(walker, batch, descs, ctx.density);
  ensureRasterPipeline();
  isMixReady(ctx); // blend-source framebuffer for deferred composites

  const device = host.gpu.device;
  const W = Math.max(1, Math.round(ctx.width * ctx.density));
  const H = Math.max(1, Math.round(ctx.height * ctx.density));
  const deferredCount = gs.reduce((n, g) => n + (g.immediate ? 0 : 1), 0);
  rasterRing.reserve(gs.length);
  host.reserveBlendSlots(deferredCount);

  const enc = device.createCommandEncoder({ label: "walk-flush" });
  let maskHoldsDeferred = false;
  gs.forEach((g, gi) => {
    rasterUniform[0] = 2 / W;
    rasterUniform[1] = -2 / H;
    rasterUniform[2] = -1;
    rasterUniform[3] = 1;
    rasterUniform[4] = g.key.r;
    rasterUniform[5] = g.key.g;
    rasterUniform[6] = g.key.b;
    rasterUniform[7] = 1;
    rasterUniform[8] = g.key.mx;
    rasterUniform[9] = g.key.my;
    rasterUniform[10] = ctx.density;
    rasterUniform[11] = 0;
    rasterUniformU32[12] = g.start;
    rasterUniformU32[13] = 0;
    rasterUniformU32[14] = 0;
    rasterUniformU32[15] = 0;
    const slot = rasterRing.write(rasterUniform);
    // Per-batch buffers churn, so bypass the bind-group cache (its own
    // documented guidance for churning resources).
    const bind = device.createBindGroup({
      label: "walk-raster-bg",
      layout: rasterLayout,
      entries: [
        { binding: 0, resource: { buffer: slot.buffer, offset: slot.offset, size: slot.size } },
        { binding: 1, resource: { buffer: batch.stampsBuffer } },
        { binding: 2, resource: { buffer: batch.offsetsBuffer } },
      ],
    });
    const pass = enc.beginRenderPass({
      label: "walk-raster",
      colorAttachments: [
        {
          view: Mix.glMask.view,
          // A deferred group owns the mask outright: clear on load (free on
          // tile-based GPUs) instead of a separate clear pass per group. An
          // immediate group joins the live mask — unless a deferred group's
          // stamps are still sitting in it, which it must not inherit.
          loadOp: g.immediate && !maskHoldsDeferred ? "load" : "clear",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(rasterPipeline);
    pass.setBindGroup(0, bind);
    pass.drawIndirect(batch.indirectBuffer, gi * 16);
    pass.end();

    if (g.immediate) {
      maskHoldsDeferred = false;
      return;
    }
    host.encodeRectComposite(enc, {
      source: ctx.renderer.blendSourceFramebuffer,
      maskView: Mix.glMask.view,
      color: g.color,
      rect: { buffer: batch.rectsBuffer, offset: gi * RECT_BYTES, size: RECT_BYTES },
    });
    maskHoldsDeferred = true;
  });
  if (maskHoldsDeferred) {
    // Leave the mask empty for whatever CPU stamps come next.
    enc
      .beginRenderPass({
        label: "walk-mask-clear",
        colorAttachments: [
          { view: Mix.glMask.view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" },
        ],
      })
      .end();
  }
  if (deferredCount > 0) host.present(enc);
  device.queue.submit([enc.finish()]);
  rasterRing.reset(); // writeBuffer is queue-ordered — safe post-submit
  host.resetBlendSlots();
  if (!captured) batch.destroy(); // deferred by WebGPU until execution completes
}
