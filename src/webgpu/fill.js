// =============================================================================
// stencil-fill (W2) — stencil-based nonzero-winding polygon fill
//
// Replaces the canvas2d fill-mask rasterizer (fill/mask.js drawPolygon/circle
// consumers in fill/fill.js, fill/wash.js) with WebGPU render passes. The
// canvas2d path is never ported: no FillMaskUploadCanvas, no
// copyExternalImageToTexture staging, no Mix.ctx (removal of those consumers
// is W3 integration work — they are shared files).
//
// Per polygon (upstream FillPoly.layer() calls ctx.fill() then ctx.stroke()):
//   fill pass   [stencil clear] fan->stencil (front inc-wrap / back dec-wrap,
//               gotcha #5), then cover quad (not-equal 0) writes color once.
//   stroke pass [stencil clear] border expansion geometry (edge quads +
//               round-join discs, gotcha #6) -> stencil (inc-wrap both
//               faces), then cover writes the border color once.
// Both passes scissor every draw to the polygon bbox. The stencil clear is
// the pass's stencilLoadOp:'clear' — WebGPU load ops always clear the whole
// attachment (scissor state cannot apply to a load op), which is correct
// here and cheaper than a scissored clear draw would be.
//
// erase() — upstream's ~100 destination-out circles — is one instanced
// AA-disc pass with the erase blend (gotcha #4 row 3).
//
// Anti-aliasing: canvas2d fill() is antialiased; a raw stencil fill is not.
// The target renders at sampleCount 4 (MSAA — the stencil test runs
// per-sample) and resolves into a single-sample texture each pass.
//
// Encoder overhead (~2 passes x ~90 layer() calls per createFill) is
// measured by scripts/oracle-stencil.mjs and reported; batching layers that
// could share a stencil clear is deliberately left to W4a ("measure before
// optimizing"). One cheap future option, noted for W4a: giving the cover
// pipeline stencil passOp:'zero' self-cleans the stencil, which would let
// every polygon of a fill share one render pass.
//
// Determinism: no RNG here — geometry arrives fully formed (CPU grow() now,
// grow-compute storage buffers later). Draw order is caller order.
// =============================================================================

import { FILL_WGSL, ERASE_WGSL } from "./wgsl/fill.wgsl.js";

const STENCIL_FORMAT = "stencil8";

const SOURCE_OVER_BLEND = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
};

// canvas2d destination-out (gotcha #4 row 3).
const ERASE_BLEND = {
  color: { srcFactor: "zero", dstFactor: "one-minus-src-alpha" },
  alpha: { srcFactor: "zero", dstFactor: "one-minus-src-alpha" },
};

/**
 * @typedef {{r: number, g: number, b: number, a: number}} FillColor
 *   straight-alpha rgba, components 0..1
 */

/**
 * Creates the stencil-fill renderer.
 *
 * Pipelines are created through a local memo rather than
 * pipeline.js#getRenderPipeline because that cache has no `multisample`
 * field (papercut — W3 should extend RenderPipelineDesc and fold these in).
 * The memo is keyed the same way (format + sampleCount + variant) and the
 * pipeline set is closed (5 pipelines), so gotcha #8 still holds; counts are
 * exposed via `stats.pipelines`.
 *
 * @param {import('./device.js').GpuContext} gpu
 * @param {ReturnType<import('./pipeline.js').createPipelineCache>} cache
 * @param {{format?: GPUTextureFormat, sampleCount?: number}} [opts]
 *   format defaults to 'rgba8unorm' (the mask texture format);
 *   sampleCount 4 (set 1 to disable MSAA).
 */
export function createFillRenderer(gpu, cache, opts = {}) {
  const { device } = gpu;
  const format = opts.format ?? "rgba8unorm";
  const sampleCount = opts.sampleCount ?? 4;

  const fillModule = cache.getModule(FILL_WGSL, "fill-wgsl");
  const eraseModule = cache.getModule(ERASE_WGSL, "erase-wgsl");

  const stats = {
    passes: 0,
    draws: 0,
    polygons: 0,
    strokes: 0,
    erases: 0,
    vertexFloatsWritten: 0,
    pipelines: 0,
  };

  // --------------------------------------------------------------------------
  // Pipelines (local memo; layouts held once per pipeline — caller contract
  // of cache.getBindGroup)
  // --------------------------------------------------------------------------

  /** @type {Map<string, {pipeline: GPURenderPipeline, layout: GPUBindGroupLayout}>} */
  const pipelineMemo = new Map();

  function getPipeline(variant) {
    const key = `${variant}|${format}|${sampleCount}`;
    let entry = pipelineMemo.get(key);
    if (entry) return entry;

    /** @type {GPURenderPipelineDescriptor} */
    let desc;
    const multisample = { count: sampleCount };
    switch (variant) {
      case "fan-stencil": // gotcha #5: nonzero winding via inc/dec wrap
        desc = {
          label: "fill-fan-stencil",
          layout: "auto",
          vertex: { module: fillModule, entryPoint: "vsFan" },
          fragment: {
            module: fillModule,
            entryPoint: "fsNull",
            targets: [{ format, writeMask: 0 }],
          },
          primitive: { topology: "triangle-list", cullMode: "none" },
          depthStencil: {
            format: STENCIL_FORMAT,
            stencilFront: { compare: "always", passOp: "increment-wrap" },
            stencilBack: { compare: "always", passOp: "decrement-wrap" },
          },
          multisample,
        };
        break;
      case "coverage-stencil": // border geometry: any coverage counts once
        desc = {
          label: "fill-coverage-stencil",
          layout: "auto",
          vertex: { module: fillModule, entryPoint: "vsTris" },
          fragment: {
            module: fillModule,
            entryPoint: "fsNull",
            targets: [{ format, writeMask: 0 }],
          },
          primitive: { topology: "triangle-list", cullMode: "none" },
          depthStencil: {
            format: STENCIL_FORMAT,
            stencilFront: { compare: "always", passOp: "increment-wrap" },
            stencilBack: { compare: "always", passOp: "increment-wrap" },
          },
          multisample,
        };
        break;
      case "cover": // writes color exactly once where stencil != 0
        desc = {
          label: "fill-cover",
          layout: "auto",
          vertex: { module: fillModule, entryPoint: "vsCover" },
          fragment: {
            module: fillModule,
            entryPoint: "fsCover",
            targets: [{ format, blend: SOURCE_OVER_BLEND }],
          },
          primitive: { topology: "triangle-list", cullMode: "none" },
          depthStencil: {
            format: STENCIL_FORMAT,
            stencilFront: { compare: "not-equal", passOp: "keep" },
            stencilBack: { compare: "not-equal", passOp: "keep" },
          },
          multisample,
        };
        break;
      case "erase-disc":
        desc = {
          label: "fill-erase-disc",
          layout: "auto",
          vertex: { module: eraseModule, entryPoint: "vsErase" },
          fragment: {
            module: eraseModule,
            entryPoint: "fsErase",
            targets: [{ format, blend: ERASE_BLEND }],
          },
          primitive: { topology: "triangle-strip", cullMode: "none" },
          multisample,
        };
        break;
      default:
        throw new Error(`unknown fill pipeline variant: ${variant}`);
    }
    const pipeline = device.createRenderPipeline(desc);
    entry = { pipeline, layout: pipeline.getBindGroupLayout(0) };
    pipelineMemo.set(key, entry);
    stats.pipelines = pipelineMemo.size;
    return entry;
  }

  // --------------------------------------------------------------------------
  // Vertex arena — one storage buffer, grow-only-when-exceeded (the gl_draw
  // growth policy). Old buffers stay alive until finish(): earlier draws in
  // the current encoder hold bind groups on them.
  // --------------------------------------------------------------------------

  let arena = null;
  let arenaCapacity = 0; // floats
  let arenaCursor = 0; // floats
  /** @type {GPUBuffer[]} */
  const retired = [];

  function ensureArena(floatsNeeded) {
    if (arena && arenaCursor + floatsNeeded <= arenaCapacity) return;
    let cap = Math.max(arenaCapacity * 2, 1 << 16);
    while (cap < arenaCursor + floatsNeeded) cap *= 2;
    if (arena) retired.push(arena);
    arenaCapacity = cap;
    arenaCursor = 0;
    arena = gpu.createBuffer({
      label: "fill-vertex-arena",
      size: cap * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Writes floats into the arena at the requested element alignment
   * (2 floats for vec2f data, 4 for vec4f); returns the base FLOAT index.
   * The arena is always bound whole at offset 0 (storage-buffer binding
   * offsets need 256-byte alignment); shaders index from a uniform base.
   * @param {Float32Array} data
   * @param {number} alignFloats
   */
  function pushVerts(data, alignFloats) {
    ensureArena(data.length + alignFloats);
    arenaCursor = Math.ceil(arenaCursor / alignFloats) * alignFloats;
    const base = arenaCursor;
    device.queue.writeBuffer(arena, base * 4, data.buffer, data.byteOffset, data.byteLength);
    arenaCursor += data.length;
    stats.vertexFloatsWritten += data.length;
    return base;
  }

  // Uniform arena — same policy, 256-byte slots (dynamic-offset-free: each
  // slot becomes its own bind-group entry, cached by (buffer, offset)).
  const UNIFORM_SLOT = 256;
  let uni = null;
  let uniCapacity = 0; // slots
  let uniCursor = 0;

  function pushUniform(bytes) {
    if (!uni || uniCursor >= uniCapacity) {
      if (uni) retired.push(uni);
      uniCapacity = Math.max(uniCapacity * 2, 128);
      uniCursor = 0;
      uni = gpu.createBuffer({
        label: "fill-uniform-arena",
        size: uniCapacity * UNIFORM_SLOT,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    const offset = uniCursor * UNIFORM_SLOT;
    device.queue.writeBuffer(uni, offset, bytes.buffer, bytes.byteOffset, bytes.byteLength);
    uniCursor++;
    return { buffer: uni, offset, size: bytes.byteLength };
  }

  // FillU: vec2f viewport | u32 base | u32 count | vec4f color = 32 bytes.
  const fillUBytes = new ArrayBuffer(32);
  const fillUF32 = new Float32Array(fillUBytes);
  const fillUU32 = new Uint32Array(fillUBytes);

  function fillUniform(base, count, color) {
    fillUF32[0] = target.width;
    fillUF32[1] = target.height;
    fillUU32[2] = base;
    fillUU32[3] = count;
    fillUF32[4] = color.r;
    fillUF32[5] = color.g;
    fillUF32[6] = color.b;
    fillUF32[7] = color.a;
    return pushUniform(new Uint8Array(fillUBytes));
  }

  // --------------------------------------------------------------------------
  // Target — MSAA color + resolve + MSAA stencil
  // --------------------------------------------------------------------------

  let target = null;

  /**
   * (Re)creates the offscreen mask target at the given pixel size.
   * @param {number} width
   * @param {number} height
   */
  function ensureTarget(width, height) {
    if (target && target.width === width && target.height === height) return target;
    destroyTarget();
    const msaa = sampleCount > 1;
    const color = gpu.createTexture({
      label: "fill-mask-color",
      size: { width, height },
      format,
      sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const resolve = msaa
      ? gpu.createTexture({
          label: "fill-mask-resolve",
          size: { width, height },
          format,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.TEXTURE_BINDING,
        })
      : null;
    const stencil = gpu.createTexture({
      label: "fill-mask-stencil",
      size: { width, height },
      format: STENCIL_FORMAT,
      sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    target = {
      width,
      height,
      color,
      resolve,
      stencil,
      colorView: color.createView(),
      resolveView: resolve ? resolve.createView() : null,
      stencilView: stencil.createView(),
      /** the single-sample texture consumers read/sample */
      texture: resolve ?? color,
    };
    return target;
  }

  function destroyTarget() {
    if (!target) return;
    target.color.destroy();
    target.resolve?.destroy();
    target.stencil.destroy();
    target = null;
  }

  function colorAttachment(loadOp, clearValue) {
    const att = {
      view: target.colorView,
      loadOp,
      storeOp: "store",
    };
    if (clearValue) att.clearValue = clearValue;
    if (target.resolveView) att.resolveTarget = target.resolveView;
    return att;
  }

  function stencilAttachment() {
    return {
      view: target.stencilView,
      stencilLoadOp: "clear", // per-polygon stencil clear
      stencilClearValue: 0,
      stencilStoreOp: "discard",
    };
  }

  // --------------------------------------------------------------------------
  // Geometry helpers
  // --------------------------------------------------------------------------

  function asFlat(verts) {
    return verts instanceof Float32Array ? verts : new Float32Array(verts);
  }

  /** Integer scissor box of a flat vertex list, expanded by pad px. */
  function bbox(flat, pad) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i], y = flat[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const x0 = Math.max(0, Math.floor(minX - pad));
    const y0 = Math.max(0, Math.floor(minY - pad));
    const x1 = Math.min(target.width, Math.ceil(maxX + pad));
    const y1 = Math.min(target.height, Math.ceil(maxY + pad));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * Border expansion (gotcha #6): per edge a quad offset ±lineWidth/2 along
   * the edge normal, plus a MITER join (canvas2d default, miterLimit 10,
   * bevel fallback — upstream sets lineCap:'round' but never lineJoin, and
   * closed paths have no caps) at every vertex. Overlaps are fine — the
   * coverage-stencil pipeline counts any coverage once.
   * @returns {Float32Array} triangle-list xy pairs
   */
  function buildStrokeGeometry(flat, halfW) {
    const n = flat.length / 2;
    const MITER_LIMIT = 10; // canvas2d default
    /** @type {number[]} */
    const out = [];
    // Edge quads.
    for (let i = 0; i < n; i++) {
      const x0 = flat[i * 2], y0 = flat[i * 2 + 1];
      const j = (i + 1) % n;
      const x1 = flat[j * 2], y1 = flat[j * 2 + 1];
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len <= 1e-6) continue;
      const nx = (-dy / len) * halfW;
      const ny = (dx / len) * halfW;
      out.push(
        x0 + nx, y0 + ny, x1 + nx, y1 + ny, x0 - nx, y0 - ny,
        x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny,
      );
    }
    // Joins: at vertex i, between edge (i-1 -> i) and edge (i -> i+1).
    for (let i = 0; i < n; i++) {
      const px = flat[((i - 1 + n) % n) * 2], py = flat[((i - 1 + n) % n) * 2 + 1];
      const vx = flat[i * 2], vy = flat[i * 2 + 1];
      const qx = flat[((i + 1) % n) * 2], qy = flat[((i + 1) % n) * 2 + 1];
      const l0 = Math.hypot(vx - px, vy - py);
      const l1 = Math.hypot(qx - vx, qy - vy);
      if (l0 <= 1e-6 || l1 <= 1e-6) continue;
      const d0x = (vx - px) / l0, d0y = (vy - py) / l0;
      const d1x = (qx - vx) / l1, d1y = (qy - vy) / l1;
      const cross = d0x * d1y - d0y * d1x;
      if (Math.abs(cross) < 1e-9) continue; // collinear (or 180° cusp: quads overlap)
      // Outer side of the turn: right side for a left turn and vice versa.
      const sigma = cross > 0 ? -1 : 1;
      const n0x = -d0y * sigma, n0y = d0x * sigma;
      const n1x = -d1y * sigma, n1y = d1x * sigma;
      const ax = vx + n0x * halfW, ay = vy + n0y * halfW;
      const bx = vx + n1x * halfW, by = vy + n1y * halfW;
      let mx = n0x + n1x, my = n0y + n1y;
      const mlen = Math.hypot(mx, my);
      if (mlen < 1e-9) continue;
      mx /= mlen; my /= mlen;
      const denom = mx * n0x + my * n0y; // cos(half turn angle)
      if (denom >= 1 / MITER_LIMIT) {
        // Miter: two triangles out to the miter point.
        const tx = vx + (mx * halfW) / denom, ty = vy + (my * halfW) / denom;
        out.push(vx, vy, ax, ay, tx, ty, vx, vy, tx, ty, bx, by);
      } else {
        // Bevel fallback (canvas2d behavior past the miter limit).
        out.push(vx, vy, ax, ay, bx, by);
      }
    }
    return new Float32Array(out);
  }

  // --------------------------------------------------------------------------
  // Passes
  // --------------------------------------------------------------------------

  function stencilThenCover(encoder, stencilVariant, geomFlat, geomDrawCount, box, color) {
    const geomBase = pushVerts(geomFlat, 2) / 2; // vec2f element index
    const uBinding = fillUniform(geomBase, geomFlat.length / 2, color);
    const geo = getPipeline(stencilVariant);
    const cover = getPipeline("cover");
    // vsFan/vsTris read the storage buffer; vsCover/fsCover read only the
    // uniform — layout:'auto' gives them different bind group layouts.
    const geoBind = cache.getBindGroup(geo.layout, [
      { binding: 0, resource: { buffer: uBinding.buffer, offset: uBinding.offset, size: uBinding.size } },
      { binding: 1, resource: { buffer: arena } },
    ]);
    const coverBind = cache.getBindGroup(cover.layout, [
      { binding: 0, resource: { buffer: uBinding.buffer, offset: uBinding.offset, size: uBinding.size } },
    ]);

    const pass = encoder.beginRenderPass({
      label: `fill-${stencilVariant}`,
      colorAttachments: [colorAttachment("load")],
      depthStencilAttachment: stencilAttachment(),
    });
    pass.setScissorRect(box.x, box.y, box.w, box.h);
    pass.setPipeline(geo.pipeline);
    pass.setBindGroup(0, geoBind);
    pass.draw(geomDrawCount);
    pass.setPipeline(cover.pipeline);
    pass.setBindGroup(0, coverBind);
    pass.draw(3); // fullscreen cover triangle, clipped by the scissor
    pass.end();
    stats.passes++;
    stats.draws += 2;
  }

  /**
   * Nonzero-winding fill of one polygon (canvas2d fill() equivalent —
   * self-intersection overlap composites ONCE).
   * @param {GPUCommandEncoder} encoder
   * @param {Float32Array|number[]} verts flat xy pairs, pixel space
   * @param {FillColor} color
   */
  function fillPolygon(encoder, verts, color) {
    const flat = asFlat(verts);
    const n = flat.length / 2;
    if (n < 3 || color.a <= 0) return;
    const box = bbox(flat, 1);
    if (!box) return;
    stencilThenCover(encoder, "fan-stencil", flat, (n - 2) * 3, box, color);
    stats.polygons++;
  }

  /**
   * Soft border of one polygon (canvas2d stroke() equivalent, round joins).
   * @param {GPUCommandEncoder} encoder
   * @param {Float32Array|number[]} verts flat xy pairs (closed implicitly)
   * @param {number} lineWidth pixels
   * @param {FillColor} color
   */
  function strokePolygon(encoder, verts, lineWidth, color) {
    const flat = asFlat(verts);
    if (flat.length < 4 || lineWidth <= 0 || color.a <= 0) return;
    const halfW = lineWidth / 2;
    const geom = buildStrokeGeometry(flat, halfW);
    if (geom.length === 0) return;
    // bbox over the GENERATED geometry — miter tips reach past verts+halfW.
    const box = bbox(geom, 1);
    if (!box) return;
    stencilThenCover(encoder, "coverage-stencil", geom, geom.length / 2, box, color);
    stats.strokes++;
  }

  /**
   * Upstream FillPoly.layer(): ctx.fill() then ctx.stroke() on one path.
   * @param {GPUCommandEncoder} encoder
   * @param {Float32Array|number[]} verts
   * @param {FillColor} fillColor
   * @param {number} lineWidth
   * @param {FillColor} strokeColor
   */
  function layer(encoder, verts, fillColor, lineWidth, strokeColor) {
    fillPolygon(encoder, verts, fillColor);
    strokePolygon(encoder, verts, lineWidth, strokeColor);
  }

  /**
   * Upstream FillPoly.erase(): destination-out AA discs, one instanced draw.
   * @param {GPUCommandEncoder} encoder
   * @param {Float32Array|number[]} circles flat [x, y, radius] triples
   * @param {number} alpha erase strength 0..1
   */
  function erase(encoder, circles, alpha) {
    const src = circles instanceof Float32Array ? circles : new Float32Array(circles);
    const count = src.length / 3;
    if (count === 0 || alpha <= 0) return;
    // Pad to vec4f stride and compute the scissor box over all discs.
    const data = new Float32Array(count * 4);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = src[i * 3], y = src[i * 3 + 1], r = src[i * 3 + 2];
      data[i * 4] = x;
      data[i * 4 + 1] = y;
      data[i * 4 + 2] = r;
      if (x - r < minX) minX = x - r;
      if (x + r > maxX) maxX = x + r;
      if (y - r < minY) minY = y - r;
      if (y + r > maxY) maxY = y + r;
    }
    const x0 = Math.max(0, Math.floor(minX - 2));
    const y0 = Math.max(0, Math.floor(minY - 2));
    const x1 = Math.min(target.width, Math.ceil(maxX + 2));
    const y1 = Math.min(target.height, Math.ceil(maxY + 2));
    if (x1 <= x0 || y1 <= y0) return;

    const base = pushVerts(data, 4) / 4; // vec4f element index

    const eraseU = new ArrayBuffer(16);
    const uf = new Float32Array(eraseU);
    uf[0] = target.width;
    uf[1] = target.height;
    uf[2] = alpha;
    new Uint32Array(eraseU)[3] = base;
    const uBinding = pushUniform(new Uint8Array(eraseU));
    const entry = getPipeline("erase-disc");
    const bind = cache.getBindGroup(entry.layout, [
      { binding: 0, resource: { buffer: uBinding.buffer, offset: uBinding.offset, size: uBinding.size } },
      { binding: 1, resource: { buffer: arena } },
    ]);
    const pass = encoder.beginRenderPass({
      label: "fill-erase",
      colorAttachments: [colorAttachment("load")],
    });
    pass.setScissorRect(x0, y0, x1 - x0, y1 - y0);
    pass.setPipeline(entry.pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(4, count);
    pass.end();
    stats.passes++;
    stats.draws++;
    stats.erases++;
  }

  /**
   * Clears the mask target (and its resolve texture).
   * @param {GPUCommandEncoder} encoder
   * @param {{r:number,g:number,b:number,a:number}} [clearValue] premultiplied
   */
  function clear(encoder, clearValue = { r: 0, g: 0, b: 0, a: 0 }) {
    const pass = encoder.beginRenderPass({
      label: "fill-clear",
      colorAttachments: [colorAttachment("clear", clearValue)],
    });
    pass.end();
    stats.passes++;
  }

  /**
   * Call after queue.submit(): destroys buffers retired by mid-encode
   * growth (safe post-submit — WebGPU keeps them alive until execution
   * completes) and rewinds the arenas for the next batch.
   */
  function finish() {
    for (const buf of retired) buf.destroy();
    retired.length = 0;
    arenaCursor = 0;
    uniCursor = 0;
  }

  function resetStats() {
    stats.passes = 0;
    stats.draws = 0;
    stats.polygons = 0;
    stats.strokes = 0;
    stats.erases = 0;
    stats.vertexFloatsWritten = 0;
  }

  function destroy() {
    finish();
    destroyTarget();
    arena?.destroy();
    uni?.destroy();
    arena = null;
    uni = null;
    arenaCapacity = 0;
    uniCapacity = 0;
  }

  return {
    ensureTarget,
    get target() {
      return target;
    },
    clear,
    fillPolygon,
    strokePolygon,
    layer,
    erase,
    finish,
    stats,
    resetStats,
    destroy,
    sampleCount,
    format,
  };
}
