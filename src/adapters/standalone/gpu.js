// =============================================================================
// Adapter: Standalone WebGPU host (W3)
//
// Owns the per-target GPU state the standalone adapter hooks share:
// device/context (W1a scaffold), pipeline cache, stamp renderer (W2),
// fill renderer (W2), the spectral composite pipeline (W2), and the
// persistent PAINTING texture.
//
// Texture/orientation model (gotcha #3 — you cannot sample the swapchain):
//   - The painting lives in ONE persistent texture ("current always in A").
//     The swapchain is write-only: after every composite the painting is
//     copyTextureToTexture'd into getCurrentTexture(). There is no
//     ping-pong, so dirty rects stay valid.
//   - Composite source: the dirty rect of the painting is copied into the
//     blend-source texture (blitSourceToFramebuffer hook), then the
//     spectral pass samples blend-source + mask and writes the painting,
//     scissored to the dirty rect.
//   - EVERY texture uses image convention (row 0 = top of canvas, y down).
//     Stamp renderer runs with flipY: true; the fill renderer is y-down
//     natively; the spectral pass runs with flags = 0 (no UV flips).
//
// Async: requesting a WebGPU device is asynchronous while brush.load()/
// createCanvas() are synchronous API. init() starts device acquisition and
// the host records everything it can CPU-side; the first call that must
// encode GPU work before the device resolved throws with a pointer to
// brush.ready(). All harnesses await brush.ready() after createCanvas().
// =============================================================================

import { initDevice } from "../../webgpu/device.js";
import { createPipelineCache, createUniformRing } from "../../webgpu/pipeline.js";
import { createStampRenderer } from "../../webgpu/stamps.js";
import { createFillRenderer } from "../../webgpu/fill.js";
import { packBlendUniforms, BLEND_UNIFORM_BYTES } from "../../webgpu/spectral.js";
import { SPECTRAL_WGSL } from "../../webgpu/wgsl/spectral.wgsl.js";

/** Thrown helper for pre-ready GPU use. */
function notReady() {
  throw new Error(
    "brush-gpu: the WebGPU device is still initializing. " +
      "await brush.ready() after brush.createCanvas()/brush.load() before drawing.",
  );
}

/**
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {number} width logical
 * @param {number} height logical
 * @param {number} density
 */
export function createGpuHost(canvas, width, height, density) {
  const host = {
    canvas,
    width, // logical
    height,
    density,
    gpu: null,
    cache: null,
    stamps: null,
    fillR: null,
    ready: null,
    /** painting texture (image convention, gpu.format) */
    painting: null,
    paintingView: null,
    /** deferred clear color for pre-ready clear() calls */
    _pendingClear: { r: 1, g: 1, b: 1, a: 0 },
    /** fill-mask supersampling factor (box-downsampled before compositing);
     *  drops to 1 when 2x would exceed the device texture-size limit */
    fillSS: 2,
  };

  let compositePipeline = null;
  let compositeLayout = null;
  let blendRing = null;
  let sampler = null;
  const blendScratch = new Float32Array(BLEND_UNIFORM_BYTES / 4);

  function updateFillSS() {
    if (!host.gpu) return;
    const limit = host.gpu.device.limits.maxTextureDimension2D;
    host.fillSS = devW() * 2 <= limit && devH() * 2 <= limit ? 2 : 1;
  }

  function devW() {
    return Math.max(1, Math.round(host.width * host.density));
  }
  function devH() {
    return Math.max(1, Math.round(host.height * host.density));
  }

  function ensurePainting() {
    const w = devW();
    const h = devH();
    if (host.painting && host.painting.width === w && host.painting.height === h) return;
    host.painting?.destroy();
    host.painting = host.gpu.createTexture({
      label: "painting",
      size: { width: w, height: h },
      format: host.gpu.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    host.paintingView = host.painting.createView();
    if (host._pendingClear) {
      const c = host._pendingClear;
      host._pendingClear = null;
      host.clearPainting(c);
    }
  }

  host.ready = (async () => {
    const gpu = await initDevice({ canvas, width, height, density });
    host.gpu = gpu;
    host.cache = createPipelineCache(gpu);
    host.stamps = createStampRenderer(gpu, host.cache, { format: gpu.format });
    host.stamps.setSize(devW(), devH(), { flipY: true });
    // rgba16float mask: the fill accumulates ~90 translucent layers per
    // createFill; float accumulation removes this side's 8-bit rounding
    // drift (see stencil oracle full-fill-replay-16f vs -f16ref).
    // 2x supersampling on top of MSAA 4: the 4 MSAA sample positions are
    // FIXED, so per-layer coverage rounding along an edge is the same
    // every layer and accumulates systematically over ~90 layers (visible
    // as edge banding on edge-dense fills); 2x + box downsample gives 16
    // effective samples.
    host.fillR = createFillRenderer(gpu, host.cache, { format: "rgba16float" });
    host.fillR.ensureTarget(devW() * host.fillSS, devH() * host.fillSS);
    updateFillSS();
    blendRing = createUniformRing(gpu, { slots: 64, slotSize: 256 });
    sampler = gpu.device.createSampler({
      label: "composite",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    ensurePainting();
    return host;
  })();

  /** True once GPU encoding is possible. */
  host.isReady = () => !!host.gpu;
  host.requireReady = () => {
    if (!host.gpu) notReady();
    ensurePainting();
  };

  /**
   * Resize path — resizes the swapchain and painting texture. Contents are
   * not preserved (matches upstream: resizing a GL canvas clears it).
   */
  host.resize = (w, h, d = host.density) => {
    host.width = w;
    host.height = h;
    host.density = d;
    if (!host.gpu) return;
    host.gpu.resize(w, h, d);
    updateFillSS();
    host.stamps.setSize(devW(), devH(), { flipY: true });
    host.fillR.ensureTarget(devW() * host.fillSS, devH() * host.fillSS);
    ensurePainting();
  };

  // -------------------------------------------------------------------------
  // Fill-mask downsample: box-filters the supersampled fill target into a
  // single-sample mask texture the spectral composite samples.
  // -------------------------------------------------------------------------

  const DOWNSAMPLE_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)); // (0,0) (2,0) (0,2)
  var out: VSOut;
  // Row 0 (top, clip y = +1) gets uv.y = 0 — image convention both sides.
  out.pos = vec4f(xy.x * 2.0 - 1.0, 1.0 - xy.y * 2.0, 0.0, 1.0);
  out.uv = xy;
  return out;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  // Linear sample at the shared corner of the 2x2 source block = exact
  // box average of the block.
  return textureSample(src, samp, in.uv);
}
`;

  let dsPipeline = null;
  let dsLayout = null;
  let dsSampler = null;
  let dsSrcTex = null;
  let dsSrcView = null;
  let fillMaskTex = null;
  let fillMaskView = null;

  host.ensureFillMask = () => {
    const w = devW();
    const h = devH();
    if (fillMaskTex && fillMaskTex.width === w && fillMaskTex.height === h) {
      return { texture: fillMaskTex, view: fillMaskView };
    }
    fillMaskTex?.destroy();
    fillMaskTex = host.gpu.createTexture({
      label: "fill-mask-downsampled",
      size: { width: w, height: h },
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    fillMaskView = fillMaskTex.createView();
    return { texture: fillMaskTex, view: fillMaskView };
  };

  /** Encodes the supersampled→final downsample; own encoder + submit. */
  host.downsampleFillMask = () => {
    host.requireReady();
    const { view } = host.ensureFillMask();
    if (!dsPipeline) {
      dsPipeline = host.cache.getRenderPipeline({
        code: DOWNSAMPLE_WGSL,
        vertexEntry: "vs",
        fragmentEntry: "fs",
        blend: null,
        format: "rgba16float",
        label: "fill-mask-downsample",
      });
      dsLayout = dsPipeline.getBindGroupLayout(0);
      dsSampler = host.gpu.device.createSampler({
        label: "fill-downsample",
        magFilter: "linear",
        minFilter: "linear",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      });
    }
    if (dsSrcTex !== host.fillR.target.texture) {
      dsSrcTex = host.fillR.target.texture;
      dsSrcView = dsSrcTex.createView();
    }
    const bind = host.cache.getBindGroup(
      dsLayout,
      [
        { binding: 0, resource: dsSrcView },
        { binding: 1, resource: dsSampler },
      ],
      "fill-downsample-bg",
    );
    const enc = host.gpu.device.createCommandEncoder({ label: "fill-downsample" });
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view, loadOp: "clear", storeOp: "store" }],
    });
    pass.setPipeline(dsPipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    host.gpu.device.queue.submit([enc.finish()]);
    return { texture: fillMaskTex, view: fillMaskView };
  };

  /**
   * Wraps a GPUTexture in upstream's framebuffer duck type. Every field is
   * read directly by shared core code — keep the shape exact.
   */
  host.createFramebufferTexture = (w, h, d, label = "brush-framebuffer") => {
    host.requireReady();
    const pw = Math.max(1, Math.round(Math.max(1, w) * d));
    const ph = Math.max(1, Math.round(Math.max(1, h) * d));
    const texture = host.gpu.createTexture({
      label,
      size: { width: pw, height: ph },
      format: host.gpu.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    });
    const view = texture.createView();
    return {
      __brushFramebuffer: true,
      framebuffer: texture, // truthy handle slot (was the WebGL FBO)
      colorTexture: texture,
      view,
      width: Math.max(1, w),
      height: Math.max(1, h),
      density: d,
      pixelDensity: () => d,
      remove() {
        texture.destroy();
      },
    };
  };

  /** Clears a duck-typed framebuffer target to transparent black. */
  host.clearFramebuffer = (target) => {
    host.requireReady();
    const enc = host.gpu.device.createCommandEncoder({ label: "clear-fb" });
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: target.view,
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          storeOp: "store",
        },
      ],
    });
    pass.end();
    host.gpu.device.queue.submit([enc.finish()]);
  };

  /**
   * Clears the painting texture (brush.clear()). Pre-device calls are
   * deferred and applied when the painting texture first exists.
   * @param {{r,g,b,a}} color premultiplied-compatible clear color
   */
  host.clearPainting = (color) => {
    if (!host.gpu) {
      host._pendingClear = color;
      return;
    }
    ensurePainting();
    const enc = host.gpu.device.createCommandEncoder({ label: "clear-painting" });
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: host.paintingView, loadOp: "clear", clearValue: color, storeOp: "store" },
      ],
    });
    pass.end();
    host.present(enc);
    host.gpu.device.queue.submit([enc.finish()]);
  };

  /**
   * Copies the painting into the swapchain texture (the only way pixels
   * reach the screen — gotcha #3: the swapchain is never sampled).
   * @param {GPUCommandEncoder} enc
   */
  host.present = (enc) => {
    if (!host.gpu.context) return;
    const dst = host.gpu.context.getCurrentTexture();
    const w = Math.min(host.painting.width, dst.width);
    const h = Math.min(host.painting.height, dst.height);
    enc.copyTextureToTexture({ texture: host.painting }, { texture: dst }, { width: w, height: h });
  };

  /**
   * blitSourceToFramebuffer hook body: copy the dirty rect of the current
   * painting (or a framebuffer target) into the blend-source texture.
   * @param {object} sourceFramebuffer blend-source duck
   * @param {GPUTexture} fromTexture
   * @param {{minX,minY,maxX,maxY}|null} rect device px, image convention
   */
  host.copyToBlendSource = (sourceFramebuffer, fromTexture, rect) => {
    host.requireReady();
    const w = fromTexture.width;
    const h = fromTexture.height;
    const x0 = rect ? Math.max(0, Math.floor(rect.minX)) : 0;
    const y0 = rect ? Math.max(0, Math.floor(rect.minY)) : 0;
    const x1 = rect ? Math.min(w, Math.ceil(rect.maxX)) : w;
    const y1 = rect ? Math.min(h, Math.ceil(rect.maxY)) : h;
    if (x1 <= x0 || y1 <= y0) return;
    const enc = host.gpu.device.createCommandEncoder({ label: "blit-blend-source" });
    enc.copyTextureToTexture(
      { texture: fromTexture, origin: { x: x0, y: y0 } },
      { texture: sourceFramebuffer.colorTexture, origin: { x: x0, y: y0 } },
      { width: x1 - x0, height: y1 - y0 },
    );
    host.gpu.device.queue.submit([enc.finish()]);
  };

  /**
   * The spectral composite: fullscreen triangle sampling blend-source +
   * mask, scissored to the dirty rect, writing the painting (or a
   * framebuffer target), then presenting.
   *
   * @param {object} o
   * @param {object} o.source blend-source duck ({view})
   * @param {GPUTextureView} o.maskView single-sample mask view
   * @param {number[]} o.color [r,g,b,(a)] 0..1
   * @param {boolean} o.isBrush
   * @param {{minX,minY,maxX,maxY}|null} o.rect device px
   * @param {object|null} o.targetFramebuffer duck or null → painting
   */
  host.runComposite = (o) => {
    host.requireReady();
    const device = host.gpu.device;
    if (!compositePipeline) {
      compositePipeline = host.cache.getRenderPipeline({
        code: SPECTRAL_WGSL,
        vertexEntry: "vs",
        fragmentEntry: "fs",
        blend: {
          color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
        format: host.gpu.format,
        label: "spectral-composite",
      });
      compositeLayout = compositePipeline.getBindGroupLayout(0);
    }
    const toFramebuffer = !!o.targetFramebuffer;
    packBlendUniforms(
      {
        color: o.color,
        isBrush: o.isBrush,
        targetIsFramebuffer: toFramebuffer,
        flags: 0, // image convention everywhere — no UV flips
      },
      blendScratch,
    );
    const slot = blendRing.write(blendScratch);
    const bind = host.cache.getBindGroup(
      compositeLayout,
      [
        { binding: 0, resource: { buffer: slot.buffer, offset: slot.offset, size: slot.size } },
        { binding: 1, resource: o.source.view },
        { binding: 2, resource: o.maskView },
        { binding: 3, resource: sampler },
      ],
      "composite",
    );
    const targetView = toFramebuffer ? o.targetFramebuffer.view : host.paintingView;
    const targetTex = toFramebuffer ? o.targetFramebuffer.colorTexture : host.painting;
    const enc = device.createCommandEncoder({ label: "composite" });
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: targetView, loadOp: "load", storeOp: "store" }],
    });
    if (o.rect) {
      const x0 = Math.max(0, Math.floor(o.rect.minX));
      const y0 = Math.max(0, Math.floor(o.rect.minY));
      const x1 = Math.min(targetTex.width, Math.ceil(o.rect.maxX));
      const y1 = Math.min(targetTex.height, Math.ceil(o.rect.maxY));
      if (x1 <= x0 || y1 <= y0) {
        pass.end();
        host.gpu.device.queue.submit([enc.finish()]);
        return;
      }
      pass.setScissorRect(x0, y0, x1 - x0, y1 - y0);
    }
    pass.setPipeline(compositePipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    if (!toFramebuffer) host.present(enc);
    device.queue.submit([enc.finish()]);
    // queue.writeBuffer is an ordered queue operation, so rewinding the
    // ring immediately after submit is safe: a later write to slot 0
    // executes after this submit on the queue timeline.
    blendRing.reset();
  };

  return host;
}
