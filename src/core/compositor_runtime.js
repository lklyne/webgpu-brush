// =============================================================================
// Compositor Runtime Hooks
// =============================================================================

import { registerContextInit } from "./context.js";

/**
 * Shared compositor helpers and host hooks.
 *
 * Framebuffer-like targets are duck-typed objects supplied by the host
 * adapter (the standalone adapter wraps GPU textures).
 *
 * Higher-level core modules attach their own bookkeeping fields onto the
 * active renderer and mask targets, such as:
 * - `shaderProgram`
 * - `blendSourceFramebuffer`
 * - `glMask`
 * - `fillMaskFramebuffer`
 * - `mask`
 *
 * These are library-level contract fields, not host-specific internals.
 */

export const create2DCanvas = (width, height, willReadFrequently = false) => {
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : (() => {
          const element = document.createElement("canvas");
          element.width = width;
          element.height = height;
          return element;
        })();
  canvas.drawingContext = canvas.getContext(
    "2d",
    willReadFrequently ? { willReadFrequently: true } : undefined,
  );
  return canvas;
};

export const get2DContext = (canvas, willReadFrequently = false) => {
  canvas.drawingContext ??= canvas.getContext(
    "2d",
    willReadFrequently ? { willReadFrequently: true } : undefined,
  );
  return canvas.drawingContext;
};

/**
 * The compositor hooks are per-context: `ctx.compositor`. The standalone
 * adapter installs the same table on every context it drives, but a host that
 * paints into two different surfaces can install two.
 *
 * @returns {object} A hook table that fails loudly until an adapter registers.
 */
function createCompositorHooks() {
  const missing = () => {
    throw new Error("No compositor runtime adapter registered.");
  };
  return {
    clearTarget: missing,
    ensureBlendShaderProgram: missing,
    ensureBlendSourceFramebuffer: missing,
    createFramebuffer: missing,
    runBlendShaderPass: missing,
    blitSourceToFramebuffer: missing,
  };
}

registerContextInit((ctx) => {
  ctx.compositor = createCompositorHooks();
});

/**
 * Registers or updates host compositor hooks on a drawing context.
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {object} hooks
 */
export function setCompositorRuntime(ctx, hooks) {
  ctx.compositor = { ...ctx.compositor, ...hooks };
}
