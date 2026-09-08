// =============================================================================
// Adapter: Standalone WebGPU host
//
// Owns the per-target GPU state the standalone adapter hooks share:
// device/context, pipeline cache, stamp renderer, fill renderer, the
// spectral composite pipeline, and the persistent PAINTING texture.
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
import { createGpuFillDriver } from "../../webgpu/fillgpu.js";
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
 * @param {{device?: GPUDevice, adapter?: GPUAdapter|null}} [gpuOptions]
 *   forwarded to initDevice — an injected device is adopted instead of
 *   requested (shared-device interop).
 */
export function createGpuHost(canvas, width, height, density, gpuOptions = {}) {
  const host = {
    canvas,
    width, // logical
    height,
    density,
    gpu: null,
    cache: null,
    stamps: null,
    fillR: null,
    /** GPU-resident fill DAG driver (webgpu/fillgpu.js), built lazily */
    fillGpu: null,
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
  // Shared-device interop consumers holding the painting GPUTexture (e.g. a
  // three.js ExternalTexture) must re-wrap it after a resize recreates it.
  const paintingListeners = new Set();

  /**
   * @param {(painting: GPUTexture) => void} fn called with every NEW painting
   *   texture (resize); not for the one that already exists
   * @returns {() => void} dispose
   */
  host.onPaintingChanged = (fn) => {
    paintingListeners.add(fn);
    return () => paintingListeners.delete(fn);
  };

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
    for (const fn of paintingListeners) fn(host.painting);
  }

  host.ready = (async () => {
    const gpu = await initDevice({
      canvas,
      width,
      height,
      density,
      device: gpuOptions.device,
      adapter: gpuOptions.adapter,
    });
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

  /**
   * The GPU fill DAG driver, built on first use. Eager construction cost
   * every stroke-only sketch ~10 ms of shader compilation in ready().
   */
  host.ensureFillGpu = () => {
    if (!host.fillGpu && host.gpu) {
      host.fillGpu = createGpuFillDriver(host.gpu, host.cache, host.fillR);
    }
    return host.fillGpu;
  };

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
  // When fill geometry is GPU-resident there is no CPU-side dirty rect
  // (computing one would need a readback — gotcha #9). The rect lives in a
  // storage buffer instead, so the blend-source blit becomes a QUAD DRAW
  // pulling its corners from that buffer rather than a copyTextureToTexture
  // with CPU extents.
  const BLIT_RECT_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> u_rect: array<u32>;

fn ordU32ToF32(v: u32) -> f32 {
  if ((v & 0x80000000u) != 0u) { return bitcast<f32>(v - 0x80000000u); }
  return bitcast<f32>(~v);
}

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let size = vec2f(bitcast<f32>(u_rect[9]), bitcast<f32>(u_rect[10]));
  var mn = vec2f(ordU32ToF32(u_rect[0]), ordU32ToF32(u_rect[1]));
  var mx = vec2f(ordU32ToF32(u_rect[2]), ordU32ToF32(u_rect[3]));
  if (u_rect[8] != 0u) {
    mn = min(mn, vec2f(bitcast<f32>(u_rect[4]), bitcast<f32>(u_rect[5])));
    mx = max(mx, vec2f(bitcast<f32>(u_rect[6]), bitcast<f32>(u_rect[7])));
  }
  mn = clamp(floor(mn), vec2f(0.0), size);
  mx = clamp(ceil(mx), vec2f(0.0), size);
  var idx = vi;
  if (vi == 3u) { idx = 0u; } else if (vi == 4u) { idx = 2u; } else if (vi == 5u) { idx = 3u; }
  var p = mn;
  if (idx == 1u) { p = vec2f(mx.x, mn.y); }
  else if (idx == 2u) { p = mx; }
  else if (idx == 3u) { p = vec2f(mn.x, mx.y); }
  let ndc = p / size * 2.0 - 1.0;
  return vec4f(ndc.x, -ndc.y, 0.0, 1.0);
}

// textureLoad at the fragment's own pixel: an exact copy, no filtering.
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return textureLoad(src, vec2i(i32(pos.x), i32(pos.y)), 0);
}
`;

  let blitPipeline = null;
  let blitLayout = null;
  let blitSrcTex = null;
  let blitSrcView = null;

  function ensureBlitPipeline() {
    if (blitPipeline) return;
    blitPipeline = host.cache.getRenderPipeline({
      code: BLIT_RECT_WGSL,
      vertexEntry: "vs",
      fragmentEntry: "fs",
      blend: null,
      format: host.gpu.format,
      label: "blend-source-rect-blit",
    });
    blitLayout = blitPipeline.getBindGroupLayout(0);
  }

  function blitRectQuad(sourceFramebuffer, fromTexture, rectBuffer) {
    ensureBlitPipeline();
    if (blitSrcTex !== fromTexture) {
      blitSrcTex = fromTexture;
      blitSrcView = fromTexture.createView();
    }
    const bind = host.cache.getBindGroup(
      blitLayout,
      [
        { binding: 0, resource: blitSrcView },
        { binding: 1, resource: { buffer: rectBuffer } },
      ],
      "blend-source-rect-blit-bg",
    );
    const enc = host.gpu.device.createCommandEncoder({ label: "blit-blend-source" });
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: sourceFramebuffer.view, loadOp: "load", storeOp: "store" },
      ],
    });
    pass.setPipeline(blitPipeline);
    pass.setBindGroup(0, bind);
    pass.draw(6);
    pass.end();
    host.gpu.device.queue.submit([enc.finish()]);
  }

  host.copyToBlendSource = (sourceFramebuffer, fromTexture, rect) => {
    host.requireReady();
    if (rect && rect.__gpuRect) {
      blitRectQuad(sourceFramebuffer, fromTexture, rect.buffer);
      return;
    }
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
  let rectCompositePipeline = null;
  let rectCompositeLayout = null;

  /**
   * The spectral composite bounded by the GPU-resident fill dirty rect: the
   * same fragment shader, but the fullscreen triangle + setScissorRect is
   * replaced by a quad whose corners are pulled from the rect buffer
   * (spectral.wgsl vsRect). A scissor rect cannot be indirect, and reading
   * the rect back to the CPU would be a frame-path stall (gotcha #9).
   */
  function ensureRectCompositePipeline() {
    if (rectCompositePipeline) return;
    rectCompositePipeline = host.cache.getRenderPipeline({
      code: SPECTRAL_WGSL,
      vertexEntry: "vsRect",
      fragmentEntry: "fs",
      blend: {
        color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      },
      format: host.gpu.format,
      label: "spectral-composite-rect",
    });
    rectCompositeLayout = rectCompositePipeline.getBindGroupLayout(0);
  }

  function runCompositeRect(o, gpuRect) {
    const device = host.gpu.device;
    if (o.targetFramebuffer) {
      throw new Error("brush-gpu standalone: framebuffer targets are not supported.");
    }
    ensureRectCompositePipeline();
    packBlendUniforms(
      { color: o.color, isBrush: o.isBrush, targetIsFramebuffer: false, flags: 0 },
      blendScratch,
    );
    const slot = blendRing.write(blendScratch);
    const bind = host.cache.getBindGroup(
      rectCompositeLayout,
      [
        { binding: 0, resource: { buffer: slot.buffer, offset: slot.offset, size: slot.size } },
        { binding: 1, resource: o.source.view },
        { binding: 2, resource: o.maskView },
        { binding: 3, resource: sampler },
        { binding: 4, resource: { buffer: gpuRect.buffer } },
      ],
      "composite-rect",
    );
    const enc = device.createCommandEncoder({ label: "composite-rect" });
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: host.paintingView, loadOp: "load", storeOp: "store" }],
    });
    pass.setPipeline(rectCompositePipeline);
    pass.setBindGroup(0, bind);
    pass.draw(6);
    pass.end();
    host.present(enc);
    device.queue.submit([enc.finish()]);
    blendRing.reset();
  }

  host.runComposite = (o) => {
    host.requireReady();
    const device = host.gpu.device;
    const gpuRect = o.rect && o.rect.__gpuRect ? o.rect : null;
    if (gpuRect) return runCompositeRect(o, gpuRect);
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

  /**
   * Deferred stroke groups (gl_draw.js flushWalkBatch): encodes ONE group's
   * blend-source blit + spectral composite into the caller's encoder, both
   * bounded by a GPU-resident rect record bound at a buffer offset. No
   * submit, no present — the caller batches many groups per encoder and
   * presents once. Call reserveBlendSlots(n) first: every group takes a
   * blend-uniform ring slot and the ring must not reallocate mid-encoder.
   *
   * @param {GPUCommandEncoder} enc
   * @param {object} o
   * @param {object} o.source blend-source framebuffer duck ({view})
   * @param {GPUTextureView} o.maskView
   * @param {number[]} o.color [r,g,b,(a)] 0..1
   * @param {{buffer: GPUBuffer, offset: number, size: number}} o.rect
   *   rect record (strokewalk.wgsl layout == spectral.wgsl vsRect layout)
   */
  host.encodeRectComposite = (enc, o) => {
    host.requireReady();
    const device = host.gpu.device;
    ensureBlitPipeline();
    ensureRectCompositePipeline();
    const rectBinding = { buffer: o.rect.buffer, offset: o.rect.offset ?? 0, size: o.rect.size };
    // Per-batch rect buffers churn — bypass the identity-keyed cache.
    const blitBind = device.createBindGroup({
      label: "blend-source-rect-blit-bg",
      layout: blitLayout,
      entries: [
        { binding: 0, resource: host.paintingView },
        { binding: 1, resource: rectBinding },
      ],
    });
    const blit = enc.beginRenderPass({
      label: "blit-blend-source",
      colorAttachments: [{ view: o.source.view, loadOp: "load", storeOp: "store" }],
    });
    blit.setPipeline(blitPipeline);
    blit.setBindGroup(0, blitBind);
    blit.draw(6);
    blit.end();

    packBlendUniforms(
      { color: o.color, isBrush: true, targetIsFramebuffer: false, flags: 0 },
      blendScratch,
    );
    const slot = blendRing.write(blendScratch);
    const bind = device.createBindGroup({
      label: "composite-rect-bg",
      layout: rectCompositeLayout,
      entries: [
        { binding: 0, resource: { buffer: slot.buffer, offset: slot.offset, size: slot.size } },
        { binding: 1, resource: o.source.view },
        { binding: 2, resource: o.maskView },
        { binding: 3, resource: sampler },
        { binding: 4, resource: rectBinding },
      ],
    });
    const pass = enc.beginRenderPass({
      label: "composite-rect",
      colorAttachments: [{ view: host.paintingView, loadOp: "load", storeOp: "store" }],
    });
    pass.setPipeline(rectCompositePipeline);
    pass.setBindGroup(0, bind);
    pass.draw(6);
    pass.end();
  };

  /** See encodeRectComposite. */
  host.reserveBlendSlots = (n) => blendRing.reserve(n);

  /**
   * Rewind the blend-uniform ring after the caller's submit (see
   * runComposite: writeBuffer is queue-ordered, so this is safe post-submit).
   */
  host.resetBlendSlots = () => blendRing.reset();

  return host;
}
