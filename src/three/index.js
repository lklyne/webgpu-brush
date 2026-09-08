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
// brush-gpu is a module singleton (one active painting per page), so only one
// attachment may be live at a time: dispose() before attaching again.
// =============================================================================

import * as brush from "../index.standalone.js";
import { texture, uv, vec2 } from "three/tsl";
import { ExternalTexture } from "three/webgpu";

/**
 * The handle returned by `brush.gpu()`.
 * @typedef {ReturnType<typeof brush.gpu>} BrushGpuInterop
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
 * @property {typeof brush} brush The drawing API (the same module as
 *   `brush-gpu/standalone`).
 * @property {HTMLCanvasElement} canvas brush's own canvas. Detached from the
 *   DOM unless `parent` was given; the painting is sampled through `node`.
 * @property {BrushGpuInterop} interop
 * @property {GPUDevice} device The shared device.
 * @property {PaintingTexture} painting
 * @property {import("three/webgpu").TextureNode} node Shortcut for
 *   `painting.node`.
 * @property {() => void} dispose Releases the three wrappers and the
 *   attachment slot. brush's canvas and device stay as they are (brush never
 *   destroys a device it did not create).
 */

/**
 * Options forwarded to `brush.createCanvas`. `parent` defaults to `null`
 * here (the painting is sampled by three, not shown as a DOM canvas).
 * @typedef {{ pixelDensity?: number, parent?: string|Element|null, id?: string }} AttachOptions
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

/** @type {Attachment|null} */
let live = null;

function claim() {
  if (live) {
    throw new Error(
      "brush-gpu/three: a painting is already attached. brush-gpu keeps one " +
        "active painting per page; call dispose() on the previous attachment first.",
    );
  }
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
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Attachment>}
 */
async function finish(canvas) {
  await brush.ready();
  const interop = brush.gpu();
  const painting = createPaintingTexture(interop);
  /** @type {Attachment} */
  const attachment = {
    brush,
    canvas,
    interop,
    device: interop.device,
    painting,
    node: painting.node,
    dispose() {
      painting.dispose();
      if (live === attachment) live = null;
    },
  };
  live = attachment;
  return attachment;
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
  claim();
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
  const canvas = brush.createCanvas(width, height, {
    parent: null,
    ...options,
    device,
    adapter: null,
  });
  return finish(canvas);
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
  claim();
  const canvas = brush.createCanvas(width, height, { parent: null, ...options });
  return finish(canvas);
}
