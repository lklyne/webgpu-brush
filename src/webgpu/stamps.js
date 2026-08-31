// =============================================================================
// Stamp renderer (W2 stamp-pipeline)
//
// WebGPU replacement for the two stamp paths in stroke/gl_draw.js:
//   - the point-sprite circle path  → instanced-quad "disc" pipeline
//   - the image-tip instanced path  → instanced-quad "image" pipeline
//
// Both pipelines share ONE per-instance vertex layout (5 f32: x, y,
// halfSize, angle, alpha — upstream's IMG_FLOATS layout with pos split
// out); the disc vertex stage simply ignores `angle`. Two pipelines are
// cheaper than one shader with a uniform branch (plan, stamp-pipeline).
//
// Blend: gotcha #4 row 1 — srcFactor one-minus-dst-alpha, dstFactor one
// ("under" operator; order-dependent, gotcha #10 — instances draw in queue
// order, which is deterministic because the queue is filled by sequential
// CPU code exactly like gl_draw.js).
//
// Units contract (differs from gl_draw.js only by density):
//   x, y      — stamp center, DEVICE pixels (gl_draw stores logical px and
//               lets the viewport scale; here W3 multiplies by Density at
//               queue time, same as gl_draw's dScreenX/dScreenY already do
//               for dirty rects)
//   halfSize  — radius / half quad size, device px (same as gl_draw)
//   angle     — radians (ignored for discs)
//   alpha     — [0..1] (callers divide by 255, same as gl_draw)
//
// Frame protocol:
//   setSize(w, h)            once per resize (device px)
//   beginFrame()             once per frame/submit batch
//   disc(...) / image(...)   queue stamps
//   drawDiscs(encoder, o)    one instanced draw; encoder === null → the
//   drawImages(encoder, o)   renderer creates+submits its own encoder
//
// Passing your own encoder batches multiple flushes into one submit; each
// flush sub-allocates from a per-frame vertex buffer at increasing offsets
// so any number of flushes per frame is safe. After YOUR submit, call
// beginFrame() again. Internal-submit mode (encoder === null) resets
// automatically after each submit.
// =============================================================================

import { createUniformRing } from "./pipeline.js";
import stampWGSL from "./wgsl/stamp.wgsl.js";

const FLOATS = 5; // x, y, halfSize, angle, alpha — per instance
const STRIDE = FLOATS * 4;
const INITIAL_CAPACITY = 2048; // instances per queue, doubles as needed

/** Gotcha #4 row 1 — stamp accumulate ("under"). */
export const STAMP_BLEND = {
  color: { srcFactor: "one-minus-dst-alpha", dstFactor: "one" },
  alpha: { srcFactor: "one-minus-dst-alpha", dstFactor: "one" },
};

/** Shared per-instance vertex buffer layout for both pipelines. */
export const INSTANCE_LAYOUT = [
  {
    arrayStride: STRIDE,
    stepMode: "instance",
    attributes: [
      { shaderLocation: 0, offset: 0, format: "float32x2" }, // pos
      { shaderLocation: 1, offset: 8, format: "float32" },   // halfSize
      { shaderLocation: 2, offset: 12, format: "float32" },  // angle
      { shaderLocation: 3, offset: 16, format: "float32" },  // alpha
    ],
  },
];

/**
 * @typedef {Object} StampDrawOpts
 * @property {GPUTextureView} view        render target view
 * @property {number[]} color             stroke color rgb(a), [0..1] — rgb used
 * @property {GPULoadOp} [loadOp]         default "load"
 * @property {GPUColor} [clearValue]      default transparent black
 * @property {{x:number,y:number,w:number,h:number}} [scissor] device px
 */

/**
 * Creates the stamp renderer. One instance per GpuContext/target-format
 * pair; share the pipeline cache with everything else (two caches compile
 * every pipeline twice).
 *
 * @param {import('./device.js').GpuContext} gpu
 * @param {ReturnType<import('./pipeline.js').createPipelineCache>} cache
 * @param {{format?: GPUTextureFormat}} [opts] render target format,
 *   default "rgba8unorm" (the brush mask texture format)
 */
export function createStampRenderer(gpu, cache, opts = {}) {
  const format = opts.format ?? "rgba8unorm";
  const module = cache.getModule(stampWGSL, "stamp");

  // Uniforms: proj vec4f + color vec4f.
  const uniformData = new Float32Array(8);
  const ring = createUniformRing(gpu, { slots: 64 });
  const proj = { sx: 0, sy: 0, ox: -1, oy: -1 };

  const sampler = gpu.device.createSampler({
    label: "stamp-tip",
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  // CPU-side queues — flat Float32Arrays with doubling, like gl_draw.js.
  let discData = new Float32Array(INITIAL_CAPACITY * FLOATS);
  let discCount = 0;
  let imgData = new Float32Array(INITIAL_CAPACITY * FLOATS);
  let imgCount = 0;
  let discDirtyRect = null;
  let imgDirtyRect = null;

  // Per-frame GPU vertex buffer, sub-allocated at increasing offsets so
  // several flushes can be recorded into one encoder. Grown-out buffers are
  // retired (still referenced by recorded passes) and destroyed at the next
  // beginFrame(), after their submit has been made.
  let vbuf = null;
  let vbufSize = 0;
  let vbufCursor = 0;
  /** @type {GPUBuffer[]} */
  const retired = [];

  // Pipelines + bind-group layouts, created lazily and held (caller
  // contract in pipeline.js: getBindGroupLayout returns a fresh wrapper
  // per call — hold one reference).
  let discPipeline = null;
  let discLayout = null;
  let imgPipeline = null;
  let imgLayout = null;

  // Texture cache for image tips, keyed by src string like gl_draw's
  // texCache. Values: { texture, view }.
  const tipCache = new Map();

  function ensureVertexSpace(bytes) {
    if (vbuf && vbufCursor + bytes <= vbufSize) return;
    if (vbuf) retired.push(vbuf);
    vbufSize = Math.max(vbufSize * 2, vbufCursor + bytes, INITIAL_CAPACITY * STRIDE);
    vbuf = gpu.createBuffer({
      label: "stamp-instances",
      size: vbufSize,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    vbufCursor = 0;
  }

  function accumulate(rect, minX, minY, maxX, maxY) {
    if (!rect) return { minX, minY, maxX, maxY };
    if (minX < rect.minX) rect.minX = minX;
    if (minY < rect.minY) rect.minY = minY;
    if (maxX > rect.maxX) rect.maxX = maxX;
    if (maxY > rect.maxY) rect.maxY = maxY;
    return rect;
  }

  function push(queue, count, x, y, halfSize, angle, alpha) {
    const base = count * FLOATS;
    queue[base] = x;
    queue[base + 1] = y;
    queue[base + 2] = halfSize;
    queue[base + 3] = angle;
    queue[base + 4] = alpha;
  }

  /**
   * Records one instanced draw of `count` instances from `data` into
   * `pass`-target `o.view`. Returns after resetting nothing — callers own
   * queue resets.
   */
  function drawBatch(encoder, o, pipeline, entries, data, count) {
    const bytes = count * STRIDE;
    ensureVertexSpace(bytes);
    const offset = vbufCursor;
    vbufCursor = Math.ceil((vbufCursor + bytes) / 4) * 4;
    gpu.device.queue.writeBuffer(vbuf, offset, data.buffer, 0, bytes);

    const ownEncoder = encoder === null;
    const enc = ownEncoder
      ? gpu.device.createCommandEncoder({ label: "stamp-flush" })
      : encoder;
    const pass = enc.beginRenderPass({
      label: "stamps",
      colorAttachments: [
        {
          view: o.view,
          loadOp: o.loadOp ?? "load",
          clearValue: o.clearValue ?? { r: 0, g: 0, b: 0, a: 0 },
          storeOp: "store",
        },
      ],
    });
    if (o.scissor) pass.setScissorRect(o.scissor.x, o.scissor.y, o.scissor.w, o.scissor.h);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, entries);
    pass.setVertexBuffer(0, vbuf, offset, bytes);
    pass.draw(4, count);
    pass.end();
    if (ownEncoder) {
      gpu.device.queue.submit([enc.finish()]);
      // Internal-submit mode: previous work is on the queue, safe to reuse
      // the vertex buffer from offset 0 and retire nothing-in-flight.
      api.beginFrame();
    }
  }

  function uniformBinding(color) {
    uniformData[0] = proj.sx;
    uniformData[1] = proj.sy;
    uniformData[2] = proj.ox;
    uniformData[3] = proj.oy;
    uniformData[4] = color[0];
    uniformData[5] = color[1];
    uniformData[6] = color[2];
    uniformData[7] = color[3] ?? 1;
    const u = ring.write(uniformData);
    return { binding: 0, resource: { buffer: u.buffer, offset: u.offset, size: u.size } };
  }

  const api = {
    /**
     * Sets the render-target size (DEVICE pixels) used to build the
     * projection. flipY=true (default) puts y=0 at texture row 0 — image
     * convention, what a compositor sampling the mask with standard uvs
     * wants. flipY=false reproduces upstream's GL framebuffer orientation
     * exactly (used by the parity oracle).
     * @param {number} width  device px
     * @param {number} height device px
     * @param {{flipY?: boolean}} [o]
     */
    setSize(width, height, o = {}) {
      const flipY = o.flipY ?? true;
      proj.sx = 2 / width;
      proj.ox = -1;
      proj.sy = (flipY ? -2 : 2) / height;
      proj.oy = flipY ? 1 : -1;
    },

    /** Start of a frame / after your own submit. */
    beginFrame() {
      ring.reset();
      vbufCursor = 0;
      for (const b of retired) b.destroy();
      retired.length = 0;
    },

    /**
     * Queue a disc stamp (replaces gl_draw.circle after its transform).
     * @param {number} x center, device px
     * @param {number} y center, device px
     * @param {number} radius device px
     * @param {number} alpha [0..1]
     */
    disc(x, y, radius, alpha) {
      if (discCount * FLOATS >= discData.length) {
        const next = new Float32Array(discData.length * 2);
        next.set(discData);
        discData = next;
      }
      push(discData, discCount, x, y, radius, 0, alpha);
      discDirtyRect = accumulate(
        discDirtyRect,
        x - radius - 1, y - radius - 1, x + radius + 1, y + radius + 1,
      );
      discCount++;
    },

    /**
     * Queue an image stamp (replaces gl_draw.stampImage after its
     * transform).
     * @param {number} x center, device px
     * @param {number} y center, device px
     * @param {number} halfSize device px
     * @param {number} angle radians
     * @param {number} alpha [0..1]
     * @param {number} [extraPadding] extra dirty-rect padding, device px
     */
    image(x, y, halfSize, angle, alpha, extraPadding = 0) {
      if (imgCount * FLOATS >= imgData.length) {
        const next = new Float32Array(imgData.length * 2);
        next.set(imgData);
        imgData = next;
      }
      push(imgData, imgCount, x, y, halfSize, angle, alpha);
      // Rotated-square worst case, same bound as gl_draw.stampImage.
      const r = halfSize * 1.42 + extraPadding;
      imgDirtyRect = accumulate(imgDirtyRect, x - r - 1, y - r - 1, x + r + 1, y + r + 1);
      imgCount++;
    },

    get discCount() {
      return discCount;
    },
    get imageCount() {
      return imgCount;
    },

    /**
     * Flush queued discs as one instanced draw (replaces glDraw()).
     * @param {GPUCommandEncoder|null} encoder null → own encoder + submit
     * @param {StampDrawOpts} o
     * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
     *   accumulated dirty rect (device px), null if nothing drawn
     */
    drawDiscs(encoder, o) {
      if (discCount === 0) return null;
      if (!discPipeline) {
        discPipeline = cache.getRenderPipeline({
          module,
          vertexEntry: "vs_disc",
          fragmentEntry: "fs_disc",
          buffers: INSTANCE_LAYOUT,
          blend: STAMP_BLEND,
          format,
          topology: "triangle-strip",
          label: "stamp-disc",
        });
        discLayout = discPipeline.getBindGroupLayout(0);
      }
      const bg = cache.getBindGroup(discLayout, [uniformBinding(o.color)], "stamp-disc");
      drawBatch(encoder, o, discPipeline, bg, discData, discCount);
      discCount = 0;
      const rect = discDirtyRect;
      discDirtyRect = null;
      return rect;
    },

    /**
     * Flush queued image stamps as one instanced draw (replaces
     * glDrawImages()).
     * @param {GPUCommandEncoder|null} encoder null → own encoder + submit
     * @param {StampDrawOpts & {src: string,
     *   source?: ImageBitmap|HTMLCanvasElement|OffscreenCanvas|Uint8Array,
     *   width?: number, height?: number}} o
     *   `src` keys the tip texture cache; `source` (+ width/height for
     *   typed arrays) is required only on first use of a given src.
     * @returns dirty rect like drawDiscs
     */
    drawImages(encoder, o) {
      if (imgCount === 0) return null;
      const tip = api.getTipTexture(o.src, o.source, o);
      if (!imgPipeline) {
        imgPipeline = cache.getRenderPipeline({
          module,
          vertexEntry: "vs_image",
          fragmentEntry: "fs_image",
          buffers: INSTANCE_LAYOUT,
          blend: STAMP_BLEND,
          format,
          topology: "triangle-strip",
          label: "stamp-image",
        });
        imgLayout = imgPipeline.getBindGroupLayout(0);
      }
      const bg = cache.getBindGroup(
        imgLayout,
        [
          uniformBinding(o.color),
          { binding: 1, resource: tip.view },
          { binding: 2, resource: sampler },
        ],
        "stamp-image",
      );
      drawBatch(encoder, o, imgPipeline, bg, imgData, imgCount);
      imgCount = 0;
      const rect = imgDirtyRect;
      imgDirtyRect = null;
      return rect;
    },

    /**
     * Tip-texture cache, keyed by src string like gl_draw's texCache.
     * Lazy-uploads on first use; subsequent calls ignore `source`.
     * @param {string} src cache key
     * @param {ImageBitmap|HTMLCanvasElement|OffscreenCanvas|Uint8Array} [source]
     * @param {{width?: number, height?: number}} [o] required for typed arrays
     * @returns {{texture: GPUTexture, view: GPUTextureView}}
     */
    getTipTexture(src, source, o = {}) {
      let tip = tipCache.get(src);
      if (!tip) {
        if (!source) {
          throw new Error(`stamp tip "${src}" not cached and no source given`);
        }
        const isPixels = ArrayBuffer.isView(source);
        const width = o.width ?? source.width;
        const height = o.height ?? source.height;
        const texture = gpu.createTexture({
          label: `stamp-tip:${src.slice(0, 48)}`,
          size: { width, height },
          format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
        });
        if (isPixels) {
          gpu.device.queue.writeTexture(
            { texture },
            source,
            { bytesPerRow: width * 4, rowsPerImage: height },
            { width, height },
          );
        } else {
          gpu.device.queue.copyExternalImageToTexture(
            { source },
            { texture },
            { width, height },
          );
        }
        tip = { texture, view: texture.createView() };
        tipCache.set(src, tip);
      }
      return tip;
    },

    /**
     * Drops a cached tip texture, forcing re-upload on next use — call when
     * a custom tip function changes after brush.add() (mirrors gl_draw's
     * invalidateTexEntry).
     * @param {string} src
     */
    invalidateTip(src) {
      const tip = tipCache.get(src);
      if (tip) tip.texture.destroy();
      tipCache.delete(src);
    },

    destroy() {
      for (const tip of tipCache.values()) tip.texture.destroy();
      tipCache.clear();
      for (const b of retired) b.destroy();
      retired.length = 0;
      if (vbuf) vbuf.destroy();
      vbuf = null;
      vbufSize = 0;
      vbufCursor = 0;
      ring.destroy();
    },
  };

  return api;
}
