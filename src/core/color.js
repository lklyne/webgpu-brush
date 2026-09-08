import {
  load as loadTarget,
  isCanvasReady,
  syncDensity,
  getActiveFramebuffer,
  isFramebufferTarget,
} from "./target.js";
import {
  expandDirtyRect,
  normalizeDirtyRect as clampDirtyRect,
  unionDirtyRect,
  getFullDirtyRect as getFullRect,
} from "./dirty_rect.js";
import {
  clearTarget as clearRenderTarget,
  ensureBlendShaderProgram,
  ensureBlendSourceFramebuffer,
  runBlendShaderPass,
  blitSourceToFramebuffer,
} from "./compositor_runtime.js";

import { defaultContext } from "./context.js";

// =============================================================================
// Module: Configure and Initiate
// =============================================================================
/**
 * This module handles the configuration and initialization of the drawing system.
 * It manages canvas properties, ensures the system is ready for rendering, and
 * provides utilities for saving and restoring states.
 */

let strokeComposite = null;
let fillComposite = null;

export const registerStrokeComposite = (composite) => {
  strokeComposite = composite;
};

export const registerFillComposite = (composite) => {
  fillComposite = composite;
};

/**
 * @param {import("./context.js").BrushContext} ctx
 * @param {object} target - Render target to clear.
 */
const clearTarget = (ctx, target) => {
  clearRenderTarget(ctx.renderer, target, isFramebufferTarget);
};

// =============================================================================
// Section: Dirty Rect Utilities
// =============================================================================
/**
 * Returns the current render target size in physical pixels.
 * @param {import("./context.js").BrushContext} ctx
 * @returns {{width: number, height: number}} Pixel size of the active target.
 */
const getTargetPixelSize = (ctx) => ({
  width: Math.max(1, Math.round(ctx.width * ctx.density)),
  height: Math.max(1, Math.round(ctx.height * ctx.density)),
});

/**
 * @param {import("./context.js").BrushContext} ctx
 * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} rect
 */
const normalizeDirtyRect = (ctx, rect) => {
  if (!rect) return null;
  const { width, height } = getTargetPixelSize(ctx);
  return clampDirtyRect(rect, width, height);
};

/**
 * Returns a dirty rectangle covering the full active target.
 * @param {import("./context.js").BrushContext} ctx
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}} Full-target rect.
 */
const getFullDirtyRect = (ctx) => {
  const { width, height } = getTargetPixelSize(ctx);
  return getFullRect(width, height);
};

// =============================================================================
// Section: Scissor Helpers
// =============================================================================
/**
 * Converts a top-left-based dirty rectangle into a device-pixel scissor box.
 * @param {import("./context.js").BrushContext} ctx
 * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} rect - Dirty rect.
 * @returns {{x:number,y:number,width:number,height:number}|null} Scissor box or null.
 */
const toScissorBox = (ctx, rect, flipY = true) => {
  const normalized = normalizeDirtyRect(ctx, rect);
  if (!normalized) return null;

  const { height } = getTargetPixelSize(ctx);
  return {
    x: normalized.minX,
    y: flipY ? height - normalized.maxY : normalized.minY,
    width: normalized.maxX - normalized.minX,
    height: normalized.maxY - normalized.minY,
  };
};

/**
 * Runs a draw callback with a temporary scissor region.
 * @param {import("./context.js").BrushContext} ctx
 * @param {unknown} gl - Unused by the WebGPU host; kept for signature stability.
 * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} rect - Dirty rect.
 * @param {Function} draw - Draw callback executed under the scissor box.
 */
const withScissor = (ctx, gl, rect, draw, flipY = true) => {
  const box = toScissorBox(ctx, rect, flipY);
  if (!box) {
    draw();
    return;
  }

  // Scissor is never nested in this module, so we can set/clear it directly
  // without saving previous GL state.
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(box.x, box.y, box.width, box.height);

  try {
    draw();
  } finally {
    gl.disable(gl.SCISSOR_TEST);
  }
};

/**
 * Stores the current state of the drawing system.
 * Can be used to save and restore configurations or canvas states.
 */
export const State = {};
/**
 * Handles color blending through the host compositor. Implements advanced blending
 * effects based on Kubelka-Munk theory. Relies on spectral.js for blending logic.
 */

// =============================================================================
// Section: Color Blending / Rendering
// =============================================================================
/**
 * Ensures the Mix object is initialized and ready for blending.
 * @param {import("./context.js").BrushContext} ctx
 */
export const isMixReady = (ctx) => {
  if (!ctx.renderer?.loaded) {
    isCanvasReady();
    ctx.mix.load(ctx);
  }
};

/**
 * Manages blending operations through the compositor hooks.
 * @property {boolean} loaded - Indicates if shaders are loaded.
 * @property {boolean} isBlending - Indicates if blending is active.
 * @property {object} currentColor - Current color as a float array.
 * @property {function} load - Initializes blending resources.
 * @property {function} blend - Applies blending effects.
 */
export const Mix = {
  isBlending: false,
  cachedColor: null,

  /**
   * Merges a new dirty rectangle into the target's accumulated draw bounds.
   * @param {import("./context.js").BrushContext} ctx
   * @param {object} target - Mask buffer receiving draw output.
   * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} rect - Rect to merge.
   */
  markDirtyRect(ctx, target, rect) {
    const normalized = normalizeDirtyRect(ctx, rect);
    if (!target || !normalized) return;
    target.dirtyRect = unionDirtyRect(target.dirtyRect, normalized);
    target.isDrawn = true;
  },

  /**
   * Clears a mask buffer and resets its dirty-rect tracking.
   * @param {import("./context.js").BrushContext} ctx
   * @param {object} target - Mask buffer to reset.
   */
  clearMask(ctx, target) {
    if (!target) return;
    const composite = target === this.glMask ? strokeComposite : fillComposite;
    composite?.clearMask?.(target, (t) => clearTarget(ctx, t));
  },

  /**
   * Resolves the region that should be composited back into the destination.
   * @param {import("./context.js").BrushContext} ctx
   * @param {object} target - Mask buffer being sampled.
   * @param {boolean} isBrushMask - True when compositing the GL brush mask.
   * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null} Composite rect.
   */
  getCompositeRect(ctx, target, isBrushMask) {
    const composite = isBrushMask ? strokeComposite : fillComposite;
    return composite?.getCompositeRect?.(
      target,
      getActiveFramebuffer,
      () => getFullDirtyRect(ctx),
      expandDirtyRect,
      (rect) => normalizeDirtyRect(ctx, rect),
    );
  },

  // =============================================================================
  // Section: Setup and load shaders
  // =============================================================================
  /**
   * Ensures the mask buffers and blend shader exist for the current renderer.
   * @param {import("./context.js").BrushContext} ctx
   */
  load(ctx) {
    syncDensity();
    const renderer = ctx.renderer;
    const needsBlendSourceFramebuffer =
      !renderer.blendSourceFramebuffer ||
        renderer.blendSourceFramebuffer.width !== ctx.width ||
        renderer.blendSourceFramebuffer.height !== ctx.height ||
        (typeof renderer.blendSourceFramebuffer.pixelDensity === "function" &&
          renderer.blendSourceFramebuffer.pixelDensity() !== ctx.density);
    ensureBlendShaderProgram(renderer);

    this.glMask = strokeComposite?.ensureResources?.(
      ctx,
      renderer,
      ctx.width,
      ctx.height,
      ctx.density,
    );
    const fillResources = fillComposite?.ensureResources?.(
      ctx,
      renderer,
      ctx.width,
      ctx.height,
      ctx.density,
      (t) => clearTarget(ctx, t),
    ) ?? {
      mask: null,
      ctx: null,
    };

    if (needsBlendSourceFramebuffer) {
      renderer.blendSourceFramebuffer = ensureBlendSourceFramebuffer(
        renderer,
        renderer.blendSourceFramebuffer,
        ctx.width,
        ctx.height,
        ctx.density,
      );
    }

    this.mask = fillResources.mask;
    this.ctx = fillResources.ctx;
  },

  // =============================================================================
  // Section: Compositing
  // =============================================================================
  /**
   * Flushes pending mask work when the blend color changes or a frame ends.
   * @param {import("./context.js").BrushContext} ctx
   * @param {Color|false} [_color=false] - New blend color.
   * @param {boolean} [_isLast=false] - True when this is the final blend flush.
   */
  blend(ctx, _color = false, _isLast = false) {
    isMixReady(ctx);
    // Only one mask is "active" for the current drawing mode; the other one
    // may still need flushing if the mode just changed mid-frame.
    const isBrushMask = this.isBrush === true;
    const mask = isBrushMask ? this.glMask : this.mask;
    const otherMask = isBrushMask ? this.mask : this.glMask;
    const nextColor = _color?._array;
    const colorChanged =
      !!nextColor &&
      (this.cachedColor?.[0] !== nextColor[0] ||
        this.cachedColor?.[1] !== nextColor[1] ||
        this.cachedColor?.[2] !== nextColor[2] ||
        this.cachedColor?.[3] !== nextColor[3]);
    if (!this.isBlending && nextColor) {
      this.isBlending = true;
      this.cachedColor = nextColor;
      ctx.notifyDraw();
      // Reset the brush mask fully at the start of each blend cycle so stale
      // dirty-rect bookkeeping cannot leak an old stroke into the next color.
      this.clearMask(ctx, this.glMask);
    }

    if (_isLast || colorChanged) {
      if (this.justChanged) {
        this.applyShader(ctx, otherMask, !isBrushMask);
        this.justChanged = false;
      }
      if (this.isBlending) {
        this.applyShader(ctx, mask, isBrushMask);
      }
      if (nextColor) this.cachedColor = nextColor;
      if (_isLast) {
        this.isBlending = false;
        this.cachedColor = null;
        
      }
    }
  },

  /**
   * Runs the blend shader over a mask and composites the result into the active renderer.
   * @param {import("./context.js").BrushContext} ctx
   * @param {object} mask - Mask buffer to composite.
   * @param {boolean} isBrushMask - True when compositing the GL brush mask.
   */
  applyShader(ctx, mask, isBrushMask) {
    // Deferred GPU-walk stroke groups precede this composite in draw order:
    // flush them into the painting first (they were never rasterized into
    // the brush mask, so they are invisible to isDrawn below).
    if (!isBrushMask) strokeComposite?.flushPending?.(ctx);
    if (!mask?.isDrawn) return;

    const dirtyRect = this.getCompositeRect(ctx, mask, isBrushMask);
    if (!dirtyRect) {
      this.clearMask(ctx, mask);
      return;
    }

    const renderer = ctx.renderer;
    const gl = renderer.drawingContext;
    const shader = renderer.shaderProgram;
    const activeFramebuffer = getActiveFramebuffer();
    const source = blitSourceToFramebuffer({
      renderer,
      sourceTarget: activeFramebuffer ?? renderer,
      sourceFramebuffer: renderer.blendSourceFramebuffer,
      dirtyRect,
      isFramebufferTarget,
      Cwidth: ctx.width,
      Cheight: ctx.height,
      getTargetPixelSize: () => getTargetPixelSize(ctx),
      toScissorBox: (rect, flipY) => toScissorBox(ctx, rect, flipY),
      withScissor: (glCtx, rect, draw, flipY) =>
        withScissor(ctx, glCtx, rect, draw, flipY),
    });
    const targetIsFramebuffer = !!activeFramebuffer;
    const composite = isBrushMask ? strokeComposite : fillComposite;
    const shaderMask = composite.getShaderMask(
      ctx,
      renderer,
      mask,
      dirtyRect,
      () => getFullDirtyRect(ctx),
      (t) => clearTarget(ctx, t),
    );

    runBlendShaderPass({
      renderer,
      shader,
      source,
      mask: shaderMask,
      color: this.cachedColor,
      isBrushMask,
      Cwidth: ctx.width,
      Cheight: ctx.height,
      dirtyRect,
      targetIsFramebuffer,
      withScissor: (glCtx, rect, draw, flipY) =>
        withScissor(ctx, glCtx, rect, draw, flipY),
    });
    this.clearMask(ctx, mask);
  },
};

/**
 * Flushes any pending stroke/fill mask work into the current target and resets
 * the shared compositor back to its initial idle state.
 *
 * @param {import("./context.js").BrushContext} ctx
 */
export const flushActiveComposite = (ctx) => {
  isMixReady(ctx);
  strokeComposite?.flushPending?.(ctx);
  const mix = ctx.mix;
  mix.blend(ctx, false, true);
  mix.clearMask(ctx, mix.glMask);
  mix.clearMask(ctx, mix.mask);
  mix.justChanged = false;
  mix.isBlending = false;
  mix.isBrush = null;
  mix.cachedColor = null;
};

/**
 * Loads and initializes the drawing target, then refreshes compositing
 * resources if the renderer was already active.
 *
 * @param {object|false} [buffer=false] - Optional offscreen target.
 * @param {object} [options] - Host options forwarded to the target adapter
 *   (standalone: `{ device, adapter }` to adopt an external WebGPU device).
 */
export const load = (buffer = false, options) => _load(defaultContext, buffer, options);

/**
 * Context-taking implementation of load().
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {object|false} [buffer=false] - Optional offscreen target.
 * @param {object} [options] - Host options forwarded to the target adapter.
 */
export const _load = (ctx, buffer = false, options) => {
  loadTarget(buffer, options);
  if (ctx.renderer.loaded) ctx.mix.load(ctx);
};
