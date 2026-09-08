// =============================================================================
// Compositor Runtime Hooks
// =============================================================================

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

let compositorRuntime = {
  clearTarget: () => {
    throw new Error("No compositor runtime adapter registered.");
  },
  ensureBlendShaderProgram: () => {
    throw new Error("No compositor runtime adapter registered.");
  },
  ensureBlendSourceFramebuffer: () => {
    throw new Error("No compositor runtime adapter registered.");
  },
  createFramebuffer: () => {
    throw new Error("No compositor runtime adapter registered.");
  },
  runBlendShaderPass: () => {
    throw new Error("No compositor runtime adapter registered.");
  },
  blitSourceToFramebuffer: () => {
    throw new Error("No compositor runtime adapter registered.");
  },
};

/**
 * Registers or updates host compositor hooks used by core compositing code.
 *
 * @param {object} hooks
 */
export function setCompositorRuntime(hooks) {
  compositorRuntime = { ...compositorRuntime, ...hooks };
}

export const clearTarget = (...args) => compositorRuntime.clearTarget(...args);
export const ensureBlendShaderProgram = (...args) =>
  compositorRuntime.ensureBlendShaderProgram(...args);
export const ensureBlendSourceFramebuffer = (...args) =>
  compositorRuntime.ensureBlendSourceFramebuffer(...args);
export const createFramebuffer = (...args) =>
  compositorRuntime.createFramebuffer(...args);
export const runBlendShaderPass = (...args) =>
  compositorRuntime.runBlendShaderPass(...args);
export const blitSourceToFramebuffer = (...args) =>
  compositorRuntime.blitSourceToFramebuffer(...args);
