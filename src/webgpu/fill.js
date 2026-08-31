// =============================================================================
// stencil-fill (W2, batched in W4a) — stencil-based nonzero-winding polygon
// fill
//
// Replaces the canvas2d fill-mask rasterizer (fill/mask.js drawPolygon/circle
// consumers in fill/fill.js, fill/wash.js) with WebGPU render passes. The
// canvas2d path is never ported: no FillMaskUploadCanvas, no
// copyExternalImageToTexture staging, no Mix.ctx (removal of those consumers
// is W3 integration work — they are shared files).
//
// W4a batching (was: one render pass + 2 queue.writeBuffer + 2 bind groups
// PER polygon — measured 4.1 s of the 5.0 s visual_suite first frame):
//   - Recording calls (layer / fillPolygon / strokePolygon / erase / clear)
//     write vertices into CPU staging arrays and append a draw op. No GPU
//     work, no writeBuffer, no bind groups.
//   - flushInto(encoder) uploads the whole batch with ONE writeBuffer per
//     arena, creates one bind group per pipeline, and encodes ONE render
//     pass for the whole batch (split only at clear() boundaries).
//   - Per-draw parameters live in a storage array indexed by
//     @builtin(instance_index) via draw()'s firstInstance — no per-draw
//     uniforms or bind groups.
//   - The cover pipeline's stencil passOp is 'zero': covering a polygon
//     zeroes exactly the stencil it consumed, so consecutive polygons need
//     no per-polygon stencil clear (the pass-level stencilLoadOp clear runs
//     once per pass).
//
// Per polygon (upstream FillPoly.layer() calls ctx.fill() then ctx.stroke()):
//   fill    fan->stencil (front inc-wrap / back dec-wrap, gotcha #5), then
//           cover quad (not-equal 0) writes color once and zeroes stencil.
//   stroke  border expansion geometry (edge quads + miter joins, gotcha #6)
//           -> stencil (inc-wrap both faces), then cover likewise.
// Every draw is scissored to the polygon bbox.
//
// erase() — upstream's ~100 destination-out circles — is one instanced
// AA-disc draw with the erase blend (gotcha #4 row 3) inside the same pass.
//
// Anti-aliasing: canvas2d fill() is antialiased; a raw stencil fill is not.
// The target renders at sampleCount 4 (MSAA — the stencil test runs
// per-sample) and resolves into a single-sample texture each pass.
//
// Determinism: no RNG here — geometry arrives fully formed (CPU grow() now,
// grow-compute storage buffers later). Draw order is caller order, and the
// batched encoding preserves it exactly (ops encode in record order inside
// one pass; WebGPU draws within a pass execute in order).
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

// Stencil state for pipelines that must coexist with the pass's stencil
// attachment without touching it (erase discs).
const STENCIL_NOOP = {
  format: STENCIL_FORMAT,
  stencilFront: { compare: "always", passOp: "keep" },
  stencilBack: { compare: "always", passOp: "keep" },
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
            // passOp 'zero' self-cleans the stencil the cover consumed —
            // this is what lets all polygons of a batch share one pass.
            stencilFront: { compare: "not-equal", passOp: "zero" },
            stencilBack: { compare: "not-equal", passOp: "zero" },
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
          depthStencil: STENCIL_NOOP, // shares the batched pass
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
  // CPU staging — vertices and per-draw params accumulate in growable typed
  // arrays; the GPU sees one writeBuffer per arena per flush.
  // --------------------------------------------------------------------------

  let stVerts = new Float32Array(1 << 16);
  let stVertsCursor = 0; // floats

  function pushVerts(data, alignFloats) {
    let cursor = Math.ceil(stVertsCursor / alignFloats) * alignFloats;
    const need = cursor + data.length;
    if (need > stVerts.length) {
      let cap = stVerts.length * 2;
      while (cap < need) cap *= 2;
      const next = new Float32Array(cap);
      next.set(stVerts.subarray(0, stVertsCursor));
      stVerts = next;
    }
    stVerts.set(data, cursor);
    stVertsCursor = need;
    stats.vertexFloatsWritten += data.length;
    return cursor; // base FLOAT index
  }

  // Per-draw params: {base u32, pad, pad, pad, color vec4f} = 32 bytes.
  const PARAM_FLOATS = 8;
  let stParams = new ArrayBuffer(256 * PARAM_FLOATS * 4);
  let stParamsF32 = new Float32Array(stParams);
  let stParamsU32 = new Uint32Array(stParams);
  let paramCount = 0;

  function pushParam(base, color) {
    if ((paramCount + 1) * PARAM_FLOATS * 4 > stParams.byteLength) {
      const next = new ArrayBuffer(stParams.byteLength * 2);
      new Uint8Array(next).set(new Uint8Array(stParams));
      stParams = next;
      stParamsF32 = new Float32Array(stParams);
      stParamsU32 = new Uint32Array(stParams);
    }
    const o = paramCount * PARAM_FLOATS;
    stParamsU32[o] = base;
    stParamsF32[o + 4] = color.r;
    stParamsF32[o + 5] = color.g;
    stParamsF32[o + 6] = color.b;
    stParamsF32[o + 7] = color.a;
    return paramCount++;
  }

  /**
   * Recorded draw ops, encoded in order by flushInto().
   * kind 1 = geo (stencil variant + cover), 2 = erase, 3 = clear.
   * @type {Array<object>}
   */
  let ops = [];

  // --------------------------------------------------------------------------
  // GPU buffers — grow-only-when-exceeded (the gl_draw growth policy).
  // Reallocation happens only inside flushInto, before bind groups are
  // created, so nothing ever references a stale buffer.
  // --------------------------------------------------------------------------

  let arena = null; // vertex storage
  let arenaCapacity = 0; // floats
  let paramsBuf = null; // per-draw params storage
  let paramsCapacity = 0; // bytes
  let vpBuf = null; // 16-byte viewport uniform

  function ensureGpuBuffers() {
    if (!vpBuf) {
      vpBuf = gpu.createBuffer({
        label: "fill-viewport",
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    if (stVertsCursor > arenaCapacity) {
      arena?.destroy();
      let cap = Math.max(arenaCapacity * 2, 1 << 16);
      while (cap < stVertsCursor) cap *= 2;
      arenaCapacity = cap;
      arena = gpu.createBuffer({
        label: "fill-vertex-arena",
        size: cap * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    const paramBytes = paramCount * PARAM_FLOATS * 4;
    if (paramBytes > paramsCapacity) {
      paramsBuf?.destroy();
      let cap = Math.max(paramsCapacity * 2, 1 << 13);
      while (cap < paramBytes) cap *= 2;
      paramsCapacity = cap;
      paramsBuf = gpu.createBuffer({
        label: "fill-params",
        size: cap,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
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
      stencilLoadOp: "clear", // once per pass; covers self-clean per polygon
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

  // Reusable scratch for border geometry (W4a: Array.push + Float32Array
  // conversion here was 87 ms of visual_suite). The returned subarray is
  // only valid until the next call — recordGeo copies it into staging
  // immediately.
  let strokeScratch = new Float32Array(1 << 12);
  let edgeScratch = new Float64Array(1 << 10);
  // Bounds of the last buildStrokeGeometry result (conservative superset —
  // input verts expanded by halfW per axis, plus exact join points). A
  // superset scissor is output-neutral: the cover draw is stencil-gated,
  // and a box containing all geometry still self-cleans completely.
  const strokeBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  /**
   * Border expansion (gotcha #6): per edge a quad offset ±lineWidth/2 along
   * the edge normal, plus a MITER join (canvas2d default, miterLimit 10,
   * bevel fallback — upstream sets lineCap:'round' but never lineJoin, and
   * closed paths have no caps) at every vertex. Overlaps are fine — the
   * coverage-stencil pipeline counts any coverage once.
   * @returns {Float32Array} triangle-list xy pairs (view into scratch)
   */
  function buildStrokeGeometry(flat, halfW) {
    const n = flat.length / 2;
    const MITER_LIMIT = 10; // canvas2d default
    // Worst case per vertex: 12 floats (edge quad) + 12 floats (miter join).
    const maxFloats = n * 24;
    if (strokeScratch.length < maxFloats) {
      let cap = strokeScratch.length * 2;
      while (cap < maxFloats) cap *= 2;
      strokeScratch = new Float32Array(cap);
    }
    const out = strokeScratch;
    let c = 0;
    let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
    // Per-edge dx/dy/len, computed ONCE and shared by the quad and join
    // loops (was recomputed with 4 sqrt per vertex). Same expressions on
    // the same f64 values — bit-identical to the two-loop version.
    if (edgeScratch.length < n * 3) {
      let cap = edgeScratch.length * 2;
      while (cap < n * 3) cap *= 2;
      edgeScratch = new Float64Array(cap);
    }
    const e = edgeScratch;
    for (let i = 0; i < n; i++) {
      const j = i + 1 < n ? i + 1 : 0;
      const dx = flat[j * 2] - flat[i * 2];
      const dy = flat[j * 2 + 1] - flat[i * 2 + 1];
      e[i * 3] = dx;
      e[i * 3 + 1] = dy;
      e[i * 3 + 2] = Math.sqrt(dx * dx + dy * dy);
    }
    // Edge quads.
    for (let i = 0; i < n; i++) {
      const x0 = flat[i * 2], y0 = flat[i * 2 + 1];
      if (x0 < bMinX) bMinX = x0;
      if (x0 > bMaxX) bMaxX = x0;
      if (y0 < bMinY) bMinY = y0;
      if (y0 > bMaxY) bMaxY = y0;
      const len = e[i * 3 + 2];
      if (len <= 1e-6) continue;
      const j = i + 1 < n ? i + 1 : 0;
      const x1 = flat[j * 2], y1 = flat[j * 2 + 1];
      const nx = (-e[i * 3 + 1] / len) * halfW;
      const ny = (e[i * 3] / len) * halfW;
      out[c++] = x0 + nx; out[c++] = y0 + ny;
      out[c++] = x1 + nx; out[c++] = y1 + ny;
      out[c++] = x0 - nx; out[c++] = y0 - ny;
      out[c++] = x1 + nx; out[c++] = y1 + ny;
      out[c++] = x1 - nx; out[c++] = y1 - ny;
      out[c++] = x0 - nx; out[c++] = y0 - ny;
    }
    // Joins: at vertex i, between edge (i-1 -> i) and edge (i -> i+1).
    for (let i = 0; i < n; i++) {
      const prev = i === 0 ? n - 1 : i - 1;
      const vx = flat[i * 2], vy = flat[i * 2 + 1];
      const l0 = e[prev * 3 + 2];
      const l1 = e[i * 3 + 2];
      if (l0 <= 1e-6 || l1 <= 1e-6) continue;
      const d0x = e[prev * 3] / l0, d0y = e[prev * 3 + 1] / l0;
      const d1x = e[i * 3] / l1, d1y = e[i * 3 + 1] / l1;
      const cross = d0x * d1y - d0y * d1x;
      if (Math.abs(cross) < 1e-9) continue; // collinear (or 180° cusp: quads overlap)
      // Outer side of the turn: right side for a left turn and vice versa.
      const sigma = cross > 0 ? -1 : 1;
      const n0x = -d0y * sigma, n0y = d0x * sigma;
      const n1x = -d1y * sigma, n1y = d1x * sigma;
      const ax = vx + n0x * halfW, ay = vy + n0y * halfW;
      const bx = vx + n1x * halfW, by = vy + n1y * halfW;
      let mx = n0x + n1x, my = n0y + n1y;
      const mlen = Math.sqrt(mx * mx + my * my);
      if (mlen < 1e-9) continue;
      mx /= mlen; my /= mlen;
      const denom = mx * n0x + my * n0y; // cos(half turn angle)
      if (denom >= 1 / MITER_LIMIT) {
        // Miter: two triangles out to the miter point.
        const tx = vx + (mx * halfW) / denom, ty = vy + (my * halfW) / denom;
        if (tx < bMinX) bMinX = tx;
        if (tx > bMaxX) bMaxX = tx;
        if (ty < bMinY) bMinY = ty;
        if (ty > bMaxY) bMaxY = ty;
        out[c++] = vx; out[c++] = vy; out[c++] = ax; out[c++] = ay;
        out[c++] = tx; out[c++] = ty; out[c++] = vx; out[c++] = vy;
        out[c++] = tx; out[c++] = ty; out[c++] = bx; out[c++] = by;
      } else {
        // Bevel fallback (canvas2d behavior past the miter limit).
        out[c++] = vx; out[c++] = vy; out[c++] = ax; out[c++] = ay;
        out[c++] = bx; out[c++] = by;
      }
    }
    // Expand raw-point bounds by halfW per axis (offset vectors have length
    // halfW, so per-axis excursion <= halfW; miter tips were included raw).
    strokeBounds.minX = bMinX - halfW;
    strokeBounds.minY = bMinY - halfW;
    strokeBounds.maxX = bMaxX + halfW;
    strokeBounds.maxY = bMaxY + halfW;
    return out.subarray(0, c);
  }

  /** Integer scissor box from a bounds object, expanded by pad px. */
  function boundsBox(b, pad) {
    const x0 = Math.max(0, Math.floor(b.minX - pad));
    const y0 = Math.max(0, Math.floor(b.minY - pad));
    const x1 = Math.min(target.width, Math.ceil(b.maxX + pad));
    const y1 = Math.min(target.height, Math.ceil(b.maxY + pad));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // --------------------------------------------------------------------------
  // Recording API — signatures unchanged from the immediate-mode version;
  // the encoder argument is accepted but unused (encoding is deferred to
  // flushInto, which callers invoke on their encoder before submit).
  // --------------------------------------------------------------------------

  function recordGeo(stencilVariant, geomFlat, geomDrawCount, box, color) {
    const base = pushVerts(geomFlat, 2) / 2; // vec2f element index
    const paramIdx = pushParam(base, color);
    ops.push({ k: 1, variant: stencilVariant, drawCount: geomDrawCount, paramIdx, box });
  }

  /**
   * Nonzero-winding fill of one polygon (canvas2d fill() equivalent —
   * self-intersection overlap composites ONCE).
   * @param {GPUCommandEncoder} _encoder unused (deferred encoding)
   * @param {Float32Array|number[]} verts flat xy pairs, pixel space
   * @param {FillColor} color
   */
  function fillPolygon(_encoder, verts, color) {
    const flat = asFlat(verts);
    const n = flat.length / 2;
    if (n < 3 || color.a <= 0) return;
    const box = bbox(flat, 1);
    if (!box) return;
    recordGeo("fan-stencil", flat, (n - 2) * 3, box, color);
    stats.polygons++;
  }

  /**
   * Soft border of one polygon (canvas2d stroke() equivalent, miter joins).
   * @param {GPUCommandEncoder} _encoder unused (deferred encoding)
   * @param {Float32Array|number[]} verts flat xy pairs (closed implicitly)
   * @param {number} lineWidth pixels
   * @param {FillColor} color
   */
  function strokePolygon(_encoder, verts, lineWidth, color) {
    const flat = asFlat(verts);
    if (flat.length < 4 || lineWidth <= 0 || color.a <= 0) return;
    const halfW = lineWidth / 2;
    const geom = buildStrokeGeometry(flat, halfW);
    if (geom.length === 0) return;
    // Bounds tracked during generation — miter tips reach past verts+halfW.
    const box = boundsBox(strokeBounds, 1);
    if (!box) return;
    recordGeo("coverage-stencil", geom, geom.length / 2, box, color);
    stats.strokes++;
  }

  /**
   * Upstream FillPoly.layer(): ctx.fill() then ctx.stroke() on one path.
   * @param {GPUCommandEncoder} encoder unused (deferred encoding)
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
   * @param {GPUCommandEncoder} _encoder unused (deferred encoding)
   * @param {Float32Array|number[]} circles flat [x, y, radius] triples
   * @param {number} alpha erase strength 0..1
   */
  function erase(_encoder, circles, alpha) {
    const src = circles instanceof Float32Array ? circles : new Float32Array(circles);
    const count = src.length / 3;
    if (count === 0 || alpha <= 0) return;
    // Pad to vec4f stride (alpha in w) and compute the scissor box.
    const data = new Float32Array(count * 4);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = src[i * 3], y = src[i * 3 + 1], r = src[i * 3 + 2];
      data[i * 4] = x;
      data[i * 4 + 1] = y;
      data[i * 4 + 2] = r;
      data[i * 4 + 3] = alpha;
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

    const first = pushVerts(data, 4) / 4; // vec4f element index
    ops.push({ k: 2, first, count, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
    stats.erases++;
  }

  /**
   * Records a clear of the mask target (splits the batched pass).
   * @param {GPUCommandEncoder} _encoder unused (deferred encoding)
   * @param {{r:number,g:number,b:number,a:number}} [clearValue] premultiplied
   */
  function clear(_encoder, clearValue = { r: 0, g: 0, b: 0, a: 0 }) {
    ops.push({ k: 3, clearValue });
  }

  // --------------------------------------------------------------------------
  // Flush — upload staging, encode every recorded op
  // --------------------------------------------------------------------------

  const vpScratch = new Float32Array(4);

  /**
   * Uploads the staged batch and encodes it into the given encoder as one
   * render pass (split at clear() boundaries). Resets the recording state.
   * Call before encoder.finish()/submit.
   * @param {GPUCommandEncoder} encoder
   */
  function flushInto(encoder) {
    if (ops.length === 0) return;
    ensureGpuBuffers();
    vpScratch[0] = target.width;
    vpScratch[1] = target.height;
    device.queue.writeBuffer(vpBuf, 0, vpScratch.buffer, 0, 16);
    if (stVertsCursor > 0) {
      device.queue.writeBuffer(arena, 0, stVerts.buffer, 0, stVertsCursor * 4);
    }
    if (paramCount > 0) {
      device.queue.writeBuffer(paramsBuf, 0, stParams, 0, paramCount * PARAM_FLOATS * 4);
    }

    // Bind groups: one per pipeline per flush (auto layouts differ).
    const fan = getPipeline("fan-stencil");
    const tris = getPipeline("coverage-stencil");
    const cover = getPipeline("cover");
    const eraseP = getPipeline("erase-disc");
    const geoEntries = [
      { binding: 0, resource: { buffer: vpBuf } },
      { binding: 1, resource: { buffer: arena } },
      { binding: 2, resource: { buffer: paramsBuf } },
    ];
    const binds = {
      "fan-stencil": device.createBindGroup({ layout: fan.layout, entries: geoEntries }),
      "coverage-stencil": device.createBindGroup({ layout: tris.layout, entries: geoEntries }),
      cover: device.createBindGroup({
        layout: cover.layout,
        entries: [{ binding: 2, resource: { buffer: paramsBuf } }],
      }),
      erase: device.createBindGroup({
        layout: eraseP.layout,
        entries: [
          { binding: 0, resource: { buffer: vpBuf } },
          { binding: 1, resource: { buffer: arena } },
        ],
      }),
    };

    let pass = null;
    let pendingLoad = null; // {clearValue} when a clear precedes the next pass
    let currentPipeline = null;

    const beginPass = () => {
      pass = encoder.beginRenderPass({
        label: "fill-batch",
        colorAttachments: [
          pendingLoad
            ? colorAttachment("clear", pendingLoad.clearValue)
            : colorAttachment("load"),
        ],
        depthStencilAttachment: stencilAttachment(),
      });
      pendingLoad = null;
      currentPipeline = null;
      stats.passes++;
    };
    const setPipe = (variant, entry) => {
      if (currentPipeline === variant) return;
      pass.setPipeline(entry.pipeline);
      pass.setBindGroup(0, binds[variant === "erase-disc" ? "erase" : variant]);
      currentPipeline = variant;
    };

    for (const op of ops) {
      if (op.k === 3) {
        if (pass) {
          pass.end();
          pass = null;
        }
        pendingLoad = { clearValue: op.clearValue };
        continue;
      }
      if (!pass) beginPass();
      if (op.k === 1) {
        const geo = op.variant === "fan-stencil" ? fan : tris;
        pass.setScissorRect(op.box.x, op.box.y, op.box.w, op.box.h);
        setPipe(op.variant, geo);
        pass.draw(op.drawCount, 1, 0, op.paramIdx);
        setPipe("cover", cover);
        pass.draw(3, 1, 0, op.paramIdx); // fullscreen cover tri, scissored
        stats.draws += 2;
      } else {
        pass.setScissorRect(op.box.x, op.box.y, op.box.w, op.box.h);
        setPipe("erase-disc", eraseP);
        pass.draw(4, op.count, 0, op.first);
        stats.draws++;
      }
    }
    if (pass) {
      pass.end();
    } else if (pendingLoad) {
      // Trailing clear with no draws after it still must execute.
      beginPass();
      pass.end();
      pass = null;
    }

    ops = [];
    stVertsCursor = 0;
    paramCount = 0;
  }

  /** True when recorded ops await flushInto(). */
  function pending() {
    return ops.length > 0;
  }

  /**
   * Post-submit bookkeeping. With batched staging nothing needs retiring —
   * kept for API compatibility with the immediate-mode callers.
   */
  function finish() {}

  function resetStats() {
    stats.passes = 0;
    stats.draws = 0;
    stats.polygons = 0;
    stats.strokes = 0;
    stats.erases = 0;
    stats.vertexFloatsWritten = 0;
  }

  function destroy() {
    ops = [];
    stVertsCursor = 0;
    paramCount = 0;
    destroyTarget();
    arena?.destroy();
    paramsBuf?.destroy();
    vpBuf?.destroy();
    arena = null;
    paramsBuf = null;
    vpBuf = null;
    arenaCapacity = 0;
    paramsCapacity = 0;
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
    flushInto,
    pending,
    finish,
    stats,
    resetStats,
    destroy,
    sampleCount,
    format,
  };
}
