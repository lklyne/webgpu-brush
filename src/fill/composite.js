// =============================================================================
// Fill compositor (WebGPU)
//
// The canvas2d fill-mask path is GONE: no CPU mask canvas, no
// FillMaskUploadCanvas, no texSubImage2D staging. Fills draw through the
// stencil-fill renderer (webgpu/fill.js) into an MSAA mask target whose
// resolve texture the spectral composite samples directly.
//
// `Mix.ctx` is no longer a CanvasRenderingContext2D. It is the FILL
// SURFACE created here: an explicit recorder API (layer / wash / erase /
// flush) consumed by fill/fill.js and fill/wash.js. Geometry arrives in
// user space plus the fill matrix; the surface transforms to device
// pixels, queues stencil-fill passes on a pending command encoder, and
// tracks dirty rects. The encoder is submitted (flushed) right before the
// composite samples the mask.
// =============================================================================

import * as Color from "../core/color.js";

let isFillCompositeRegistered = false;
const DIRTY_FILL_PADDING = 4;

/** Clamp helper matching canvas2d alpha parsing. */
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Creates the fill surface bound to a renderer's WebGPU host.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {object} Renderer active renderer (host attached)
 * @param {object} mask the fill-mask wrapper (dirty-rect bookkeeping)
 */
function createFillSurface(ctx, Renderer, mask) {
  const host = Renderer.host;
  const SS = host.fillSS ?? 1; // supersampling factor of the fill target
  // The fill renderer records ops CPU-side (no encoder needed until
  // flush); flush() creates one encoder, encodes the whole batch as one
  // render pass, and submits.

  /**
   * Transforms {x,y} vertices by a 2D matrix into a flat device-px array
   * and accumulates bounds.
   */
  function transformVerts(verts, m, bounds) {
    const n = verts.length;
    const flat = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const v = verts[i];
      const tx = m.a * v.x + m.c * v.y + m.e;
      const ty = m.b * v.x + m.d * v.y + m.f;
      flat[i * 2] = tx;
      flat[i * 2 + 1] = ty;
      if (tx < bounds.minX) bounds.minX = tx;
      if (ty < bounds.minY) bounds.minY = ty;
      if (tx > bounds.maxX) bounds.maxX = tx;
      if (ty > bounds.maxY) bounds.maxY = ty;
    }
    return flat;
  }

  const matrixScale = (m) =>
    Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));

  /** Matrix scaled up to the supersampled fill-target space. */
  const scaledMatrix = (m) =>
    SS === 1
      ? m
      : { a: m.a * SS, b: m.b * SS, c: m.c * SS, d: m.d * SS, e: m.e * SS, f: m.f * SS };

  const surface = {
    /**
     * One FillPoly.layer(): canvas2d fill() + stroke() on the polygon path.
     * @param {Array<{x,y}>} verts user-space vertices
     * @param {{a,b,c,d,e,f}} matrix fill matrix (density-scaled)
     * @param {number} fillAlpha 0..1
     * @param {number} lineWidth user units (0 disables the border)
     * @param {number} strokeAlpha 0..1
     */
    layer(verts, matrix, fillAlpha, lineWidth, strokeAlpha) {
      if (verts.length < 3) return;
      const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      // The fill target is supersampled: draw geometry at SS x device px.
      const flat = transformVerts(verts, scaledMatrix(matrix), bounds);
      const lwDevice = lineWidth * matrixScale(matrix);
      host.fillR.layer(
        null,
        flat,
        { r: 1, g: 0, b: 0, a: clamp01(fillAlpha) },
        lwDevice * SS,
        { r: 1, g: 0, b: 0, a: clamp01(strokeAlpha) },
      );
      // Same padding rule as the old mask.js: stroke half-width + 1.
      // Dirty rects are tracked in FINAL device px.
      const pad = 1 + lwDevice / 2;
      Color.Mix.markDirtyRect(ctx, mask, {
        minX: bounds.minX / SS - pad,
        minY: bounds.minY / SS - pad,
        maxX: bounds.maxX / SS + pad,
        maxY: bounds.maxY / SS + pad,
      });
    },

    /**
     * FillPoly.erase(): destination-out discs.
     * @param {number[]} circles flat [x, y, diameter] triples, user space
     * @param {{a..f}} matrix
     * @param {number} alpha 0..1 erase strength
     */
    erase(circles, matrix, alpha) {
      const n = circles.length / 3;
      if (n === 0 || alpha <= 0) return;
      const m = scaledMatrix(matrix);
      const s = matrixScale(m);
      const flat = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const x = circles[i * 3];
        const y = circles[i * 3 + 1];
        const d = circles[i * 3 + 2];
        flat[i * 3] = m.a * x + m.c * y + m.e;
        flat[i * 3 + 1] = m.b * x + m.d * y + m.f;
        flat[i * 3 + 2] = (d / 2) * s;
      }
      // Upstream's canvas2d erase never fed dirty-rect tracking; keep that
      // (erase only removes alpha inside already-dirty polygon bounds).
      host.fillR.erase(null, flat, clamp01(alpha));
    },

    /**
     * wash(): a plain nonzero-winding fill, no border.
     */
    washPolygon(verts, matrix, alpha) {
      surface.layer(verts, matrix, alpha, 0, 0);
    },

    // ------------------------------------------------------------------
    // GPU-resident fill geometry. These mirror layer()/erase() above
    // but take a grow-compute poly handle instead of CPU vertices, and let
    // the dirty rect accumulate GPU-side (there is no CPU bbox to mark).
    // ------------------------------------------------------------------

    /** The GPU fill DAG driver, built on first use; null before ready. */
    get gpuFill() {
      return host.ensureFillGpu();
    },

    /**
     * Opens a GPU-resident fill and returns the root poly handle. All the
     * device-space maths (supersampling, the dirty-rect transform and pad)
     * lives here, next to the rest of it — fill/fill.js stays in user space.
     * @param {object} o see webgpu/fillgpu.js beginFill, plus:
     *   matrix — the fill matrix in FINAL device px;
     *   maxLineWidth — the layer border width at i = 0 (its maximum), which
     *   sets the dirty-rect padding the CPU path uses (1 + lineWidth / 2).
     */
    beginGpuFill(o) {
      const lwDevice = o.maxLineWidth * matrixScale(o.matrix);
      return host.fillGpu.beginFill({
        ...o,
        rectMatrix: o.matrix,
        rectPad: 1 + lwDevice / 2 + DIRTY_FILL_PADDING,
      });
    },

    endGpuFill() {
      host.fillGpu.endFill();
    },

    layerGpu(poly, matrix, fillAlpha, lineWidth, strokeAlpha) {
      const lwDevice = lineWidth * matrixScale(matrix);
      host.fillGpu.drawLayer(
        poly,
        scaledMatrix(matrix),
        clamp01(fillAlpha),
        lwDevice * SS,
        clamp01(strokeAlpha),
      );
      // markDirtyRect() would normally set this; the GPU path has no CPU
      // bbox to merge, so isDrawn has to be raised here or applyShader()
      // skips the composite entirely.
      mask.isDrawn = true;
      mask.gpuDirty = true;
    },

    eraseGpu(handle, base, matrix, alpha) {
      const m = scaledMatrix(matrix);
      // Upstream stores a DIAMETER in the third slot (composite halves it).
      host.fillGpu.drawErase(handle, base, m, 0.5 * matrixScale(m), clamp01(alpha));
    },

    /** Queue a clear of the fill mask target (keeps pass ordering). */
    clear() {
      host.fillR.clear(null);
    },

    /**
     * Submit all pending fill passes. Call before sampling the mask.
     * The GPU-resident ops are encoded FIRST, as one compute pass on the
     * same encoder — the render pass that follows consumes their poly
     * buffers through drawIndirect.
     */
    flush() {
      const gpuPending = host.fillGpu?.pending();
      if (!host.fillR.pending() && !gpuPending) return;
      const encoder = host.gpu.device.createCommandEncoder({ label: "fill-batch" });
      if (gpuPending) host.fillGpu.flushCompute(encoder);
      host.fillR.flushInto(encoder);
      host.gpu.device.queue.submit([encoder.finish()]);
      host.fillR.finish();
    },
  };

  return surface;
}

/**
 * Ensures fill compositing resources exist for the active renderer.
 * Returns { mask, ctx } — mask carries dirty-rect bookkeeping and exposes
 * the resolve texture; ctx is the fill surface (see header).
 *
 * @param {import("../core/context.js").BrushContext} drawContext
 */
export function ensureFillCompositeResources(
  drawContext,
  Renderer,
  Cwidth,
  Cheight,
  Density,
  _clearTarget,
) {
  const host = Renderer.host;
  host.requireReady();
  const maskWidth = Math.max(1, Math.round(Cwidth * Density));
  const maskHeight = Math.max(1, Math.round(Cheight * Density));
  const SS = host.fillSS ?? 1;
  host.fillR.ensureTarget(maskWidth * SS, maskHeight * SS);
  host.ensureFillMask();

  if (
    !Renderer.mask ||
    Renderer.mask.width !== maskWidth ||
    Renderer.mask.height !== maskHeight
  ) {
    const mask = {
      __fillMask: true,
      width: maskWidth,
      height: maskHeight,
      dirtyRect: null,
      /** true when GPU-resident fill geometry contributed to this cycle */
      gpuDirty: false,
      isDrawn: false,
      get colorTexture() {
        return Renderer.host.ensureFillMask().texture;
      },
      get view() {
        return Renderer.host.ensureFillMask().view;
      },
      __clearFillMask() {
        Renderer.mask.surface.clear();
      },
    };
    mask.surface = createFillSurface(drawContext, Renderer, mask);
    Renderer.mask = mask;
  }

  return {
    mask: Renderer.mask,
    ctx: Renderer.mask.surface,
  };
}

/**
 * Clears the current fill mask and resets its bookkeeping flags.
 */
export function clearFillMask(target, clearTarget) {
  if (!target) return;
  clearTarget(target);
  target.isDrawn = false;
  target.dirtyRect = null;
  target.gpuDirty = false;
}

/**
 * Returns the fill dirty rect to composite into the main target.
 */
export function getFillCompositeRect(
  target,
  _getActiveFramebuffer,
  getFullDirtyRect,
  expandDirtyRect,
  normalizeDirtyRect,
) {
  if (!target) return null;
  if (target.gpuDirty) {
    // GPU-resident fill geometry has no CPU-side bbox, so the rect is a
    // GPU BUFFER the composite and the blend-source blit read as vertex
    // data. Flushing here (rather than in getShaderMask, which core calls
    // AFTER the blit) is what guarantees the compute pass that fills that
    // buffer has been submitted before either consumer runs.
    const driver = target.surface.gpuFill;
    target.surface.flush();
    const cpu = target.dirtyRect
      ? normalizeDirtyRect(expandDirtyRect(target.dirtyRect, DIRTY_FILL_PADDING))
      : null;
    driver.writeRectCpuHalf(cpu, target.width, target.height);
    return { __gpuRect: true, buffer: driver.rectBuffer };
  }
  if (!target.dirtyRect) return getFullDirtyRect();
  return normalizeDirtyRect(
    expandDirtyRect(target.dirtyRect, DIRTY_FILL_PADDING),
  );
}

/**
 * Flushes pending fill passes and returns the mask resource the composite
 * binds as u_mask (the single-sample resolve texture).
 *
 * @param {import("../core/context.js").BrushContext} _ctx - Unused here.
 */
export function getFillShaderMask(
  _ctx,
  Renderer,
  mask,
  _dirtyRect,
  _getFullDirtyRect,
  _clearTarget,
) {
  mask.surface.flush();
  // Box-downsample the supersampled fill target into the mask texture the
  // composite samples (also runs at SS = 1; it is then a plain copy pass).
  Renderer.host.downsampleFillMask();
  return mask;
}

/**
 * Registers the fill compositor with the shared color/composite core.
 * Safe to call multiple times.
 */
export function initFillComposite() {
  if (isFillCompositeRegistered) return;
  Color.registerFillComposite?.({
    ensureResources: ensureFillCompositeResources,
    clearMask: clearFillMask,
    getCompositeRect: getFillCompositeRect,
    getShaderMask: getFillShaderMask,
  });
  isFillCompositeRegistered = true;
}
