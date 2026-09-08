// =============================================================================
// Adapter: Standalone Target Hooks (WebGPU)
//
// The standalone target is WebGPU-backed. brush.load()/createCanvas()
// synchronously create the renderer and START async device acquisition
// (the WebGPU device request has no synchronous form — recorded as a
// divergence in FORK.md). Awaiting `brush.ready()` before drawing is
// optional: stateful calls made before the device resolves are recorded
// and replayed in program order (see deferred.js).
// =============================================================================

import {
  setTargetRuntime,
  setTarget,
} from "../../core/target.js";
import { defaultContext, registerContextInit } from "../../core/context.js";
import { _onTargetResized } from "../../core/flowfield.js";
import { createGpuHost } from "./gpu.js";
import { armDeferred, flushDeferred } from "./deferred.js";

/**
 * The target of ONE painting: the canvas it was loaded from, the renderer
 * built over it, the size and density it was loaded at, and the promise for
 * its device coming up (which also replays that painting's recorded calls).
 *
 * @returns {object} The `ctx.target` object.
 */
function createTargetState() {
  return {
    /** @type {HTMLCanvasElement|OffscreenCanvas|null} */
    canvas: null,
    /** @type {object|null} */
    renderer: null,
    isLoaded: false,
    /** @type {Promise<void>|null} device + walker + deferred replay */
    ready: null,
    width: 0,
    height: 0,
    density: 1,
  };
}

registerContextInit((ctx) => {
  ctx.target = createTargetState();
});

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

function createRenderer(target, width, height, density, gpuOptions) {
  const host = createGpuHost(target, width, height, density, gpuOptions);

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

/**
 * @param {import("../../core/context.js").BrushContext} ctx
 */
function applyLoadedTarget(ctx, target, width, height, density, gpuOptions = {}) {
  const state = ctx.target;
  state.canvas = target;
  state.width = width;
  state.height = height;
  state.density = density;

  state.renderer = createRenderer(target, width, height, density, gpuOptions);
  setTarget(ctx, {
    Renderer: state.renderer,
    Cwidth: width,
    Cheight: height,
    Density: density,
  });
  // The flow-field grid is derived from the target size; a target of a
  // different size needs a new one. Same size: nothing is discarded.
  _onTargetResized(ctx, width, height);
  state.isLoaded = true;
  // Record stateful calls until the device is ready, then replay them.
  // ready() starts now so a sketch that never awaits it still runs; the
  // catch only silences the unhandled-rejection report — the same promise
  // is what ready() and readPixels() hand back, so failures stay observable.
  armDeferred(ctx);
  state.ready = null;
  startReady(ctx).catch(() => {});
}

/**
 * @param {import("../../core/context.js").BrushContext} ctx
 * @returns {Promise<void>}
 */
function startReady(ctx) {
  const state = ctx.target;
  if (state.ready) return state.ready;
  const renderer = state.renderer;
  state.ready = (async () => {
    await renderer.host.ready;
    // Warm up the GPU stroke walker BEFORE replaying, so deferred strokes
    // route to strokewalk-compute exactly as post-ready strokes do.
    const { initWalkRouter } = await import("../../stroke/gl_draw.js");
    await initWalkRouter(renderer.host);
    flushDeferred(ctx);
  })();
  return state.ready;
}

/**
 * Resolves when the active target's WebGPU device is initialized, the GPU
 * stroke walker is warm, and every call recorded before that point has
 * been replayed. Optional — drawing before ready is recorded and
 * replayed in order — but awaiting it is still the way to know the
 * painting is current before an out-of-band read. Callable any time after
 * load()/createCanvas().
 * @returns {Promise<void>}
 */
export async function ready() {
  return _ready(defaultContext);
}

/**
 * Context-taking implementation of ready().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @returns {Promise<void>}
 */
export async function _ready(ctx) {
  if (!ctx.target.renderer) {
    throw new Error("brush.ready(): no target loaded — call brush.load()/createCanvas() first.");
  }
  return startReady(ctx);
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
  return _readPixels(defaultContext);
}

/**
 * Context-taking implementation of readPixels().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @returns {Promise<{width: number, height: number, pixels: Uint8ClampedArray}>}
 */
export async function _readPixels(ctx) {
  if (!ctx.target.renderer) {
    throw new Error("brush.readPixels(): no target loaded.");
  }
  // Includes the deferred replay: pixels reflect every call made so far.
  await _ready(ctx);
  const host = ctx.target.renderer.host;
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
 * Shared-device interop handle for the active target. Lets a host
 * renderer that lives on the SAME GPUDevice (three.js `WebGPURenderer`
 * constructed with `{ device }`, then `new ExternalTexture(painting)`)
 * sample the painting with zero copies: same device, same queue, so the
 * fork's submissions land before the host's in submission order — no
 * fences. Synchronous; requires `await brush.ready()` first (the device
 * has no synchronous form). `painting` is the LIVE texture — it is
 * recreated on resize; subscribe with `onPaintingChanged` to re-wrap.
 * Image convention: row 0 is the top of the canvas, colors are
 * premultiplied in `format` (the preferred canvas format, not sRGB-typed).
 *
 * @returns {{
 *   device: GPUDevice,
 *   adapter: GPUAdapter|null,
 *   format: GPUTextureFormat,
 *   painting: GPUTexture,
 *   onPaintingChanged: (fn: (painting: GPUTexture) => void) => () => void,
 * }}
 */
export function gpu() {
  return _gpu(defaultContext);
}

/**
 * Context-taking implementation of gpu().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 */
export function _gpu(ctx) {
  if (!ctx.target.renderer) {
    throw new Error("brush.gpu(): no target loaded — call brush.load()/createCanvas() first.");
  }
  const host = ctx.target.renderer.host;
  host.requireReady();
  return {
    device: host.gpu.device,
    adapter: host.gpu.adapter,
    format: host.gpu.format,
    get painting() {
      return host.painting;
    },
    onPaintingChanged: host.onPaintingChanged,
  };
}

/**
 * Loads a standalone draw target from a DOM canvas or OffscreenCanvas.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} target
 * @param {{device?: GPUDevice, adapter?: GPUAdapter|null}} [options]
 *   adopt an externally owned device (see `gpu()`).
 */
export function load(target, options) {
  return _loadTarget(defaultContext, target, options);
}

/**
 * Context-taking implementation of load(). Registered as the `load` target
 * hook, so core/color.js's load() reaches it with its own context.
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {HTMLCanvasElement|OffscreenCanvas} [target] defaults to the one this
 *   context already draws into.
 * @param {{device?: GPUDevice, adapter?: GPUAdapter|null}} [options]
 */
export function _loadTarget(ctx, target = ctx.target.canvas, options = {}) {
  if (!isSupportedTarget(target)) {
    throw new Error(
      "Standalone brush.load(target) requires an HTMLCanvasElement or OffscreenCanvas.",
    );
  }

  applyLoadedTarget(ctx, target, target.width, target.height, 1, {
    device: options.device,
    adapter: options.adapter,
  });
}

/**
 * Creates a standalone DOM canvas, configures its backing resolution according
 * to the provided pixel density, appends it optionally to the DOM, and loads it
 * as the active brush target.
 *
 * @param {number} width Logical canvas width.
 * @param {number} height Logical canvas height.
 * @param {{
 *   pixelDensity?: number,
 *   parent?: string|Element|null,
 *   id?: string,
 *   device?: GPUDevice,
 *   adapter?: GPUAdapter|null,
 * }} [options] `device`/`adapter`: adopt an externally owned device
 *   instead of requesting one — see `gpu()`.
 * @returns {HTMLCanvasElement}
 */
export function createCanvas(width, height, options = {}) {
  return _createCanvas(defaultContext, width, height, options);
}

/**
 * Context-taking implementation of createCanvas().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {number} width
 * @param {number} height
 * @param {object} [options]
 * @returns {HTMLCanvasElement}
 */
export function _createCanvas(ctx, width, height, options = {}) {
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

  applyLoadedTarget(ctx, canvas, logicalWidth, logicalHeight, density, {
    device: options.device,
    adapter: options.adapter,
  });
  return canvas;
}

/**
 * Refreshes the standalone target density.
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @returns {number}
 */
export function syncDensity(ctx) {
  const state = ctx.target;
  setTarget(ctx, {
    Cwidth: state.width,
    Cheight: state.height,
    Density: state.density,
  });
  return state.density;
}

/**
 * Ensures this context's standalone target has been loaded.
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 */
export function isCanvasReady(ctx) {
  if (!ctx.target.isLoaded) {
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

const hooks = {
  load: _loadTarget,
  syncDensity,
  isCanvasReady,
  instance,
  activateInstance,
  deactivateInstance,
  getActiveFramebuffer,
  isFramebufferTarget,
};

// The hooks act on the context they are handed, so every context this adapter
// drives gets the same table.
registerContextInit((ctx) => setTargetRuntime(ctx, hooks));

export function initStandaloneTargetRuntime() {
  setTargetRuntime(defaultContext, hooks);
}
