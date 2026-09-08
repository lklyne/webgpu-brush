// =============================================================================
// brush-gpu/three — three.js bridge (shared device, zero copies)
//
// The painting is a GPUTexture owned by brush-gpu. On the same GPUDevice,
// three's WebGPURenderer can bind it directly as an ExternalTexture: no
// upload, no readback. Same device means same queue, so brush submissions
// issued before the renderer's render call land first in submission order;
// no fences.
//
// Two ways to end up on one device:
//   attachToRenderer(renderer, w, h)  three owns the device, brush adopts it
//   createSharedDevice(w, h)          brush owns the device, three adopts it
//                                     (new WebGPURenderer({ device }))
// The second gives brush the adapter's full texture/buffer limits; the first
// is what an existing <Canvas> already has. Both resolve to an Attachment.
//
// Each attach creates its OWN brush instance (createBrush), so several
// paintings can be live on one page — one per renderer, or several on one
// renderer. `attachment.brush` is that instance: draw with
// `att.brush.line(...)`, not with the module-level exports, which belong to
// the default painting. `options.brush` adopts an existing instance instead
// (including the module namespace, when a sketch wants the default painting
// on a three plane); dispose() then leaves it alive.
// =============================================================================

// From the package entry, not api.js: rollup keeps `index.standalone.js`
// external and rewrites it to `./brush.esm.js`, so the bridge shares the
// consumer's library instance instead of bundling a second copy.
import { createBrush } from "../index.standalone.js";
import { texture, uv, vec2 } from "three/tsl";
import { ExternalTexture } from "three/webgpu";

/**
 * One painting's public API — what `createBrush()` returns and what the
 * module-level `brush-gpu` exports are the default instance of.
 * @typedef {ReturnType<typeof createBrush>} BrushInstance
 */

/**
 * The handle returned by `brush.gpu()`.
 * @typedef {ReturnType<BrushInstance["gpu"]>} BrushGpuInterop
 */

/**
 * @typedef {object} PaintingTexture
 * @property {import("three/webgpu").TextureNode} node TSL node sampling the
 *   painting, v flipped to three's plane UV convention. Its `.value` is
 *   swapped to a fresh ExternalTexture whenever brush recreates the painting
 *   (three initializes an ExternalTexture exactly once; it cannot be
 *   re-pointed). Use this in materials.
 * @property {ExternalTexture} texture Current wrapper; replaced on resize.
 * @property {() => void} dispose
 */

/**
 * @typedef {object} Attachment
 * @property {BrushInstance} brush This attachment's own painting — draw with
 *   `attachment.brush.line(...)`. Independent of the module-level exports and
 *   of every other attachment.
 * @property {HTMLCanvasElement} canvas brush's own canvas. Detached from the
 *   DOM unless `parent` was given; the painting is sampled through `node`.
 * @property {BrushGpuInterop} interop
 * @property {GPUDevice} device The shared device.
 * @property {PaintingTexture} painting
 * @property {import("three/webgpu").TextureNode} node Shortcut for
 *   `painting.node`.
 * @property {() => void} dispose Releases the three wrappers and, when this
 *   attachment created the instance, disposes it (freeing its painting and,
 *   if brush requested the device, the device). An instance passed in through
 *   `options.brush` is left alone — its owner disposes it.
 */

/**
 * Options forwarded to `createBrush`. `parent` defaults to `null` here (the
 * painting is sampled by three, not shown as a DOM canvas). `brush` attaches
 * an EXISTING instance instead of creating one; its canvas is re-created at
 * the requested size on the attachment's device.
 * @typedef {{
 *   pixelDensity?: number,
 *   parent?: string|Element|null,
 *   id?: string,
 *   brush?: BrushInstance,
 * }} AttachOptions
 */

/**
 * Wraps a `brush.gpu()` handle as a TSL texture node.
 *
 * The painting is image convention (row 0 = top) and three's plane UVs put
 * v=0 at the bottom, so the node samples with v flipped. Colors are
 * premultiplied values in the preferred canvas format; the texture is left in
 * NoColorSpace so they pass through untouched. Pair with a renderer whose
 * output color space is linear and tone mapping is off for a 1:1 display.
 *
 * @param {BrushGpuInterop} interop
 * @returns {PaintingTexture}
 */
export function createPaintingTexture(interop) {
  let current = new ExternalTexture(interop.painting);
  const flippedUv = vec2(uv().x, uv().y.oneMinus());
  const node = texture(current, flippedUv);

  const unsubscribe = interop.onPaintingChanged((painting) => {
    const next = new ExternalTexture(painting);
    node.value = next;
    current.dispose();
    current = next;
  });

  return {
    node,
    get texture() {
      return current;
    },
    dispose: () => {
      unsubscribe();
      current.dispose();
    },
  };
}

/**
 * @param {GPUDevice} device
 * @param {number} width
 * @param {number} height
 * @param {number} density
 */
function checkLimits(device, width, height, density) {
  const limit = device.limits.maxTextureDimension2D;
  const w = Math.round(width * density);
  const h = Math.round(height * density);
  if (w > limit || h > limit) {
    throw new Error(
      `brush-gpu/three: painting ${w}x${h} exceeds the device's maxTextureDimension2D (${limit}). ` +
        "Construct the WebGPURenderer with { requiredLimits: { maxTextureDimension2D: <adapter limit> } }, " +
        "or let brush own the device via createSharedDevice().",
    );
  }
}

/**
 * Brings one instance up and wraps its painting for three.
 *
 * @param {BrushInstance} instance
 * @param {HTMLCanvasElement} canvas
 * @param {boolean} owned true when this attachment created the instance and
 *   is therefore the one to dispose it
 * @returns {Promise<Attachment>}
 */
async function finish(instance, canvas, owned) {
  await instance.ready();
  const interop = instance.gpu();
  const painting = createPaintingTexture(interop);
  /** @type {Attachment} */
  const attachment = {
    brush: instance,
    canvas,
    interop,
    device: interop.device,
    painting,
    node: painting.node,
    dispose() {
      painting.dispose();
      if (owned) instance.dispose();
    },
  };
  return attachment;
}

/**
 * Creates (or adopts) the instance for an attachment and gives it a canvas on
 * the shared device.
 *
 * @param {AttachOptions} options
 * @param {number} width
 * @param {number} height
 * @param {{device?: GPUDevice, adapter?: GPUAdapter|null}} gpuOptions
 * @returns {{instance: BrushInstance, canvas: HTMLCanvasElement, owned: boolean}}
 */
function makeInstance(options, width, height, gpuOptions) {
  const { brush: existing, ...canvasOptions } = options;
  const instance = existing ?? createBrush();
  const canvas = instance.createCanvas(width, height, {
    parent: null,
    ...canvasOptions,
    ...gpuOptions,
  });
  return { instance, canvas, owned: !existing };
}

/**
 * Three owns the device; brush adopts it. Works with a renderer an existing
 * scene already created (r3f's `<Canvas>`, for instance). Initializes the
 * renderer if it has not been yet.
 *
 * A device three requested carries default limits unless the renderer was
 * given `requiredLimits`; paintings up to 8192 device pixels per side fit
 * the WebGPU default.
 *
 * @param {import("three/webgpu").WebGPURenderer} renderer
 * @param {number} width logical painting width
 * @param {number} height logical painting height
 * @param {AttachOptions} [options]
 * @returns {Promise<Attachment>}
 */
export async function attachToRenderer(renderer, width, height, options = {}) {
  await renderer.init();
  const backend = /** @type {{ device?: GPUDevice }} */ (renderer.backend);
  const device = backend?.device;
  if (!device) {
    throw new Error(
      "brush-gpu/three: the renderer has no WebGPU device. attachToRenderer() needs a " +
        "three.js WebGPURenderer on the WebGPU backend (the WebGL fallback cannot share a painting).",
    );
  }
  const density = Math.max(1, Number(options.pixelDensity) || 1);
  checkLimits(device, width, height, density);
  const { instance, canvas, owned } = makeInstance(options, width, height, {
    device,
    adapter: null,
  });
  return finish(instance, canvas, owned);
}

/**
 * Brush owns the device; three adopts it. brush requests the adapter's full
 * texture and buffer limits plus every feature the adapter supports, so a
 * renderer built on this device is never in compatibility mode.
 *
 * ```js
 * const att = await createSharedDevice(1024, 1024);
 * const renderer = new WebGPURenderer({ device: att.device });
 * ```
 *
 * @param {number} width logical painting width
 * @param {number} height logical painting height
 * @param {AttachOptions} [options]
 * @returns {Promise<Attachment>}
 */
export async function createSharedDevice(width, height, options = {}) {
  const { instance, canvas, owned } = makeInstance(options, width, height, {});
  return finish(instance, canvas, owned);
}
