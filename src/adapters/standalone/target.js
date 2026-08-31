// =============================================================================
// Adapter: Standalone Target Hooks (WebGPU, W3)
//
// The standalone target is now WebGPU-backed. brush.load()/createCanvas()
// synchronously create the renderer and START async device acquisition;
// callers must `await brush.ready()` before drawing (the WebGPU device
// request has no synchronous form — recorded as a divergence in FORK.md).
// =============================================================================

import {
  setTargetRuntime,
  setTargetState,
} from "../../core/target.js";
import { createGpuHost } from "./gpu.js";

let activeTarget = null;
let isLoaded = false;
let activeDensity = 1;
let activeWidth = 0;
let activeHeight = 0;
let activeRenderer = null;

function isCanvasTarget(target) {
  return (
    typeof HTMLCanvasElement !== "undefined" &&
    target instanceof HTMLCanvasElement
  );
}

function isOffscreenCanvasTarget(target) {
  return (
    typeof OffscreenCanvas !== "undefined" &&
    target instanceof OffscreenCanvas
  );
}

function isSupportedTarget(target) {
  return isCanvasTarget(target) || isOffscreenCanvasTarget(target);
}

function createRenderer(target, width, height, density) {
  const host = createGpuHost(target, width, height, density);

  return {
    canvas: target,
    host,
    // No WebGL context. Shared core code stores bookkeeping fields on the
    // renderer (shaderProgram, blendSourceFramebuffer, glMask, mask) and
    // adapter hooks read `renderer.host` for GPU access.
    drawingContext: null,
    width,
    height,
    pixelDensity: () => density,
  };
}

function applyLoadedTarget(target, width, height, density) {
  activeTarget = target;
  activeWidth = width;
  activeHeight = height;
  activeDensity = density;

  activeRenderer = createRenderer(target, width, height, density);
  setTargetState({
    Renderer: activeRenderer,
    Cwidth: width,
    Cheight: height,
    Density: density,
  });
  isLoaded = true;
}

/**
 * Resolves when the active target's WebGPU device is initialized and
 * drawing may begin. Callable any time after load()/createCanvas().
 * @returns {Promise<void>}
 */
export async function ready() {
  if (!activeRenderer) {
    throw new Error("brush.ready(): no target loaded — call brush.load()/createCanvas() first.");
  }
  await activeRenderer.host.ready;
  // Warm up the GPU stroke walker so synchronous drawing right after
  // ready() can route eligible strokes to strokewalk-compute.
  const { initWalkRouter } = await import("../../stroke/gl_draw.js");
  await initWalkRouter(activeRenderer.host);
}

/**
 * OUT-OF-BAND readback of the painting texture as RGBA pixels (gotcha #9:
 * never called from any frame path — this is an explicit async API for
 * inspection, export, and the parity harness, which cannot drawImage()
 * a WebGPU canvas in every headless configuration).
 *
 * @returns {Promise<{width: number, height: number, pixels: Uint8ClampedArray}>}
 */
export async function readPixels() {
  if (!activeRenderer) {
    throw new Error("brush.readPixels(): no target loaded.");
  }
  const host = activeRenderer.host;
  await host.ready;
  host.requireReady();
  const { readTexture } = await import("../../webgpu/readback.js");
  const raw = await readTexture(host.gpu, host.painting);
  const pixels = new Uint8ClampedArray(raw.data ?? raw);
  // Swizzle BGRA → RGBA when the preferred canvas format is bgra8unorm.
  if (host.gpu.format === "bgra8unorm") {
    for (let i = 0; i < pixels.length; i += 4) {
      const b = pixels[i];
      pixels[i] = pixels[i + 2];
      pixels[i + 2] = b;
    }
  }
  return { width: host.painting.width, height: host.painting.height, pixels };
}

/**
 * Loads a standalone draw target from a DOM canvas or OffscreenCanvas.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} target
 */
export function load(target = activeTarget) {
  if (!isSupportedTarget(target)) {
    throw new Error(
      "Standalone brush.load(target) requires an HTMLCanvasElement or OffscreenCanvas.",
    );
  }

  applyLoadedTarget(target, target.width, target.height, 1);
}

/**
 * Creates a standalone DOM canvas, configures its backing resolution according
 * to the provided pixel density, appends it optionally to the DOM, and loads it
 * as the active brush target.
 *
 * @param {number} width Logical canvas width.
 * @param {number} height Logical canvas height.
 * @param {{pixelDensity?: number, parent?: string|Element|null, id?: string}} [options]
 * @returns {HTMLCanvasElement}
 */
export function createCanvas(width, height, options = {}) {
  if (typeof document === "undefined") {
    throw new Error("brush.createCanvas() requires a browser document.");
  }

  const logicalWidth = Math.max(1, Math.round(width));
  const logicalHeight = Math.max(1, Math.round(height));
  const density = Math.max(1, Number(options.pixelDensity) || 1);
  const canvas = document.createElement("canvas");

  canvas.width = Math.max(1, Math.round(logicalWidth * density));
  canvas.height = Math.max(1, Math.round(logicalHeight * density));
  canvas.style.width = `${logicalWidth}px`;
  canvas.style.height = `${logicalHeight}px`;
  canvas.id = options.id ?? "brush-canvas";

  const parentTarget = options.parent !== undefined ? options.parent : document.body;
  if (parentTarget) {
    const parent =
      typeof parentTarget === "string"
        ? document.querySelector(parentTarget)
        : parentTarget;
    if (!parent) {
      throw new Error(`Could not find parent "${options.parent}" for brush.createCanvas().`);
    }
    parent.appendChild(canvas);
  }

  applyLoadedTarget(canvas, logicalWidth, logicalHeight, density);
  return canvas;
}

/**
 * Refreshes the standalone target density.
 *
 * @returns {number}
 */
export function syncDensity() {
  setTargetState({
    Cwidth: activeWidth,
    Cheight: activeHeight,
    Density: activeDensity,
  });
  return activeDensity;
}

/**
 * Ensures a standalone target has been loaded.
 */
export function isCanvasReady() {
  if (!isLoaded) {
    throw new Error(
      "No standalone target loaded. Call brush.load(canvasOrOffscreenCanvas) first.",
    );
  }
}

/**
 * Standalone build does not use p5 instance switching, so these are no-ops.
 */
export function instance() {}
export function activateInstance() {}
export function deactivateInstance() {}

/**
 * Standalone build does not support framebuffer targets — matches upstream
 * (adapters/standalone returned null pre-port; the plan's open question is
 * resolved by keeping this unimplemented: no scenario or tile ever draws
 * into a p5.Framebuffer in the standalone build, and the composite's
 * u_targetIsFramebuffer branch therefore never triggers here).
 *
 * @returns {null}
 */
export function getActiveFramebuffer() {
  return null;
}

/**
 * Returns whether the given target behaves like a framebuffer target.
 *
 * @returns {boolean}
 */
export function isFramebufferTarget() {
  return arguments[0]?.__brushFramebuffer === true;
}

export function initStandaloneTargetRuntime() {
  setTargetRuntime({
    load,
    syncDensity,
    isCanvasReady,
    instance,
    activateInstance,
    deactivateInstance,
    getActiveFramebuffer,
    isFramebufferTarget,
  });
}
