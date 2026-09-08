// =============================================================================
// WebGPU device scaffold
//
// Adapter/device acquisition, canvas configuration (premultiplied alpha —
// plan gotcha #7), device-lost handling, the resize path, and tracked
// resource creation so leak assertions are cheap ("20 resizes leak
// nothing" is asserted against these counters, not hoped for).
//
// Everything downstream (pipeline cache, readback, the compute and render
// components)
// receives the `GpuContext` returned by `initDevice()` and creates GPU
// resources through it, never through `device.create*` directly — that is
// what keeps the counters truthful.
// =============================================================================

/**
 * @typedef {Object} GpuStats
 * @property {number} buffers        currently-live buffers created via ctx
 * @property {number} textures       currently-live textures created via ctx
 * @property {number} buffersCreated  total ever created
 * @property {number} texturesCreated total ever created
 * @property {number} bufferBytes    bytes in live buffers
 */

/**
 * @typedef {Object} GpuContext
 * @property {GPUAdapter} adapter
 * @property {GPUDevice} device
 * @property {GPUCanvasContext|null} context  null when headless (no canvas)
 * @property {HTMLCanvasElement|OffscreenCanvas|null} canvas
 * @property {GPUTextureFormat} format   preferred canvas format
 * @property {number} width   canvas backing-store width (px)
 * @property {number} height  canvas backing-store height (px)
 * @property {number} density pixel density multiplier applied by resize()
 * @property {boolean} lost
 * @property {GPUDeviceLostInfo|null} lostInfo
 * @property {GpuStats} stats
 * @property {(w: number, h: number, density?: number) => void} resize
 * @property {(desc: GPUBufferDescriptor) => GPUBuffer} createBuffer
 * @property {(desc: GPUTextureDescriptor) => GPUTexture} createTexture
 * @property {() => void} destroy
 */

/**
 * Requests an adapter + device and (optionally) configures a canvas.
 *
 * The canvas is configured with `alphaMode: 'premultiplied'`, matching
 * upstream's `getContext('webgl2', { premultipliedAlpha: true })`
 * (adapters/standalone/target.js) — colors shift subtly otherwise.
 * Usage includes COPY_SRC so the current swapchain texture can be copied
 * out for parity readback (you can copy it, you just cannot *sample* it —
 * gotcha #3 still stands for the painting texture design).
 *
 * @param {Object} [opts]
 * @param {HTMLCanvasElement|OffscreenCanvas|null} [opts.canvas]
 * @param {number} [opts.width]  initial size; defaults to canvas size
 * @param {number} [opts.height]
 * @param {number} [opts.density] pixel density (default 1, matching
 *   adapters/standalone/target.js:84)
 * @param {(info: GPUDeviceLostInfo, ctx: GpuContext) => void} [opts.onDeviceLost]
 * @param {GPUDevice} [opts.device] an externally owned device to use
 *   instead of requesting one (shared-device interop, e.g. a three.js
 *   WebGPURenderer). The caller keeps ownership: destroy() unconfigures
 *   the canvas but never destroys an injected device. The device must
 *   carry limits large enough for the target (the fork's own request asks
 *   for the adapter maximum of maxTextureDimension2D / maxBufferSize /
 *   maxStorageBufferBindingSize).
 * @param {GPUAdapter|null} [opts.adapter] the injected device's adapter,
 *   informational only.
 * @returns {Promise<GpuContext>}
 */
export async function initDevice(opts = {}) {
  const { canvas = null, density = 1, onDeviceLost } = opts;
  if (!navigator.gpu) {
    throw new Error("WebGPU not available (navigator.gpu is undefined)");
  }
  const external = !!opts.device;
  let adapter = opts.adapter ?? null;
  let device = opts.device ?? null;
  if (!external) {
    adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("WebGPU: no adapter");
    // Tall standalone canvases (visual_suite is 2800x11400 device px)
    // exceed the 8192 default limit — request the adapter's real maximum.
    // Request every feature the adapter supports — the same request
    // three.js's WebGPUBackend makes — so a host that adopts this device
    // sees the feature set it would have asked for itself (core features
    // keep it out of compatibility mode; timestamp-query feeds GPU timing).
    // The fork's own shaders need nothing beyond the defaults.
    device = await adapter.requestDevice({
      requiredFeatures: [...adapter.features],
      requiredLimits: {
        maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      },
    });
  }
  const format = navigator.gpu.getPreferredCanvasFormat();

  /** @type {GpuStats} */
  const stats = {
    buffers: 0,
    textures: 0,
    buffersCreated: 0,
    texturesCreated: 0,
    bufferBytes: 0,
  };

  /** @type {GpuContext} */
  const ctx = {
    adapter,
    device,
    /** true when the device was injected — never destroyed here */
    external,
    context: null,
    canvas,
    format,
    width: 0,
    height: 0,
    density,
    lost: false,
    lostInfo: null,
    stats,
    resize,
    createBuffer,
    createTexture,
    destroy,
  };

  device.lost.then((info) => {
    ctx.lost = true;
    ctx.lostInfo = info;
    if (onDeviceLost) onDeviceLost(info, ctx);
    else if (info.reason !== "destroyed") {
      console.error(`WebGPU device lost: ${info.reason} — ${info.message}`);
    }
  });
  // Surface validation errors during bring-up instead of losing them.
  device.addEventListener?.("uncapturederror", (e) => {
    console.error("WebGPU uncaptured error:", e.error?.message ?? e);
  });

  if (canvas) {
    ctx.context = canvas.getContext("webgpu");
    if (!ctx.context) throw new Error("WebGPU: canvas.getContext('webgpu') failed");
    ctx.context.configure({
      device,
      format,
      alphaMode: "premultiplied", // gotcha #7
      // COPY_DST: the adapter presents by copying the persistent
      // painting texture into the swapchain (gotcha #3 — the swapchain is
      // write-only in this design).
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    resize(
      opts.width ?? canvas.width / density,
      opts.height ?? canvas.height / density,
      density,
    );
  }

  /**
   * Resize path. Sets the canvas backing store to logical size × density.
   * A configured GPUCanvasContext follows the canvas size automatically —
   * no reconfigure needed; the next getCurrentTexture() has the new size.
   * Persistent offscreen textures (the painting texture) are owned by
   * their creators, which must listen for size changes themselves; this
   * scaffold only guarantees the swapchain side.
   * @param {number} w logical width
   * @param {number} h logical height
   * @param {number} [d] pixel density
   */
  function resize(w, h, d = ctx.density) {
    ctx.density = d;
    ctx.width = Math.max(1, Math.round(w * d));
    ctx.height = Math.max(1, Math.round(h * d));
    if (canvas) {
      canvas.width = ctx.width;
      canvas.height = ctx.height;
      if (canvas.style) {
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
    }
  }

  /**
   * Tracked buffer creation. Use instead of device.createBuffer so the
   * live-resource counters stay truthful for leak assertions.
   * @param {GPUBufferDescriptor} desc
   * @returns {GPUBuffer}
   */
  function createBuffer(desc) {
    const buffer = device.createBuffer(desc);
    stats.buffers++;
    stats.buffersCreated++;
    stats.bufferBytes += desc.size;
    const origDestroy = buffer.destroy.bind(buffer);
    let destroyed = false;
    buffer.destroy = () => {
      if (!destroyed) {
        destroyed = true;
        stats.buffers--;
        stats.bufferBytes -= desc.size;
      }
      origDestroy();
    };
    return buffer;
  }

  /**
   * Tracked texture creation.
   * @param {GPUTextureDescriptor} desc
   * @returns {GPUTexture}
   */
  function createTexture(desc) {
    const texture = device.createTexture(desc);
    stats.textures++;
    stats.texturesCreated++;
    const origDestroy = texture.destroy.bind(texture);
    let destroyed = false;
    texture.destroy = () => {
      if (!destroyed) {
        destroyed = true;
        stats.textures--;
      }
      origDestroy();
    };
    return texture;
  }

  function destroy() {
    ctx.context?.unconfigure();
    if (!external) device.destroy();
  }

  return ctx;
}
