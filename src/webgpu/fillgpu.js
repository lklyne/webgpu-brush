// =============================================================================
// gpu-fill driver — the FillPoly DAG, GPU-resident end to end
//
// Fills cannot be moved to the GPU piecemeal: `FillPoly.fill()` interleaves
// grow chains with scatter(), erase() and the layer border, all of which read
// vertices, and the op-salt counter's consumption is data-dependent (trim's
// fast path keys on the CURRENT vertex count). Any CPU op in the middle of the
// chain would need that counter back — a mid-frame readback, which gotcha #9
// forbids. So it is all-or-nothing: grow, scatter, erase and the border
// expansion all move together, which is what this module coordinates.
//
// Shape:
//   - A pool of grow-compute poly buffers, handed out per op and recycled
//     when the fill ends. Nothing is aliased WITHIN a fill, so no lifetime
//     analysis is needed and no op can clobber a buffer a later draw reads.
//   - Ops are RECORDED (a flat list), not encoded: the fill surface owns the
//     command encoder and only creates it at flush time. flushCompute()
//     replays the list into one compute pass, ahead of the render pass that
//     the stencil-fill batch encodes into the same encoder.
//   - Nothing crosses back to the CPU. Vertex counts reach the rasterizer as
//     drawIndirect args, bounding boxes as vertex data (poly header + the
//     shared dirty-rect buffer). `grep mapAsync src/` still matches only
//     webgpu/readback.js.
// =============================================================================

import {
  createGrowComputeSync,
  INDIRECT_BYTE_OFFSET,
  BORDER_INDIRECT_BYTE_OFFSET,
} from "./grow.js";

/**
 * @param {import('./device.js').GpuContext} gpu
 * @param {ReturnType<import('./pipeline.js').createPipelineCache>} cache
 * @param {ReturnType<import('./fill.js').createFillRenderer>} fillR
 */
export function createGpuFillDriver(gpu, cache, fillR, opts = {}) {
  const gc = createGrowComputeSync(gpu, cache, opts);

  /** @type {Array<{buffer: GPUBuffer, capacity: number, id: number}>} */
  const polyPool = [];
  let polyCursor = 0;
  /** @type {Array<object>} */
  const erasePool = [];
  let eraseCursor = 0;
  let circleCursor = 0;

  /** Recorded compute ops for the current batch, replayed by flushCompute. */
  let recorded = [];
  let fillOpen = false;

  let poolsVersion = -1;

  const stats = { fills: 0, ops: 0, polysAllocated: 0 };

  function nextPoly() {
    if (polyCursor === polyPool.length) {
      polyPool.push(gc.createPoly(`gpu-fill-poly-${polyPool.length}`));
      stats.polysAllocated = polyPool.length;
    }
    return polyPool[polyCursor++];
  }

  function nextEraseHandle() {
    if (eraseCursor === erasePool.length) {
      erasePool.push(gc.createEraseHandle(`gpu-fill-erase-${erasePool.length}`));
    }
    return erasePool[eraseCursor++];
  }

  const api = {
    grow: gc,
    get capacity() {
      return gc.capacity;
    },
    stats,

    /** Per-seed(): the gaussian pools are plain data. */
    uploadPools(a, b) {
      gc.uploadPools(a, b);
    },

    /** Uploads the pools only when fill.js reports a new seed generation. */
    uploadPoolsIfStale(version, a, b) {
      if (version === poolsVersion) return;
      poolsVersion = version;
      gc.uploadPools(a, b);
    },

    /**
     * Opens a fill. Returns the root poly handle.
     * @param {object} o
     * @param {Float32Array} o.rootVerts flat xy, user space
     * @param {ArrayLike<number>} o.rootMods
     * @param {ArrayLike<number>} o.rootDirs
     * @param {{x,y}} o.midP
     * @param {number} o.sizeX
     * @param {number} o.sizeY
     * @param {Float32Array} o.polygonVerts original polygon, flat xy
     * @param {{minX,minY,maxX,maxY}} o.polygonBBox
     * @param {number} o.fillId
     * @param {number} o.opCounter
     * @param {number} o.bleedStrength
     * @param {string} o.direction
     * @param {number} o.growCap
     * @param {{a,b,c,d,e,f}} o.rectMatrix final device px transform
     * @param {number} o.rectPad
     */
    beginFill(o) {
      if (fillOpen) throw new Error("gpu-fill: beginFill while a fill is open");
      fillOpen = true;
      polyCursor = 0;
      eraseCursor = 0;
      circleCursor = 0;
      stats.fills++;
      gc.setState({
        bleedStrength: o.bleedStrength,
        direction: o.direction,
        growCap: o.growCap,
      });
      gc.setPolygon(o.polygonVerts, o.polygonBBox);
      gc.setRectTransform(o.rectMatrix, o.rectPad);
      const root = nextPoly();
      gc.writePoly(root, {
        verts: o.rootVerts,
        mods: o.rootMods,
        dirs: o.rootDirs,
        midP: o.midP,
        sizeX: o.sizeX,
        sizeY: o.sizeY,
      });
      recorded.push({ t: "opInit", fillId: o.fillId, op: o.opCounter });
      stats.ops++;
      return root;
    },

    endFill() {
      fillOpen = false;
    },

    /** Records `src.grow(f)`; returns the destination handle. */
    recordGrow(src, f, flipDirs) {
      const dst = nextPoly();
      recorded.push({ t: "grow", src, dst, f, flipDirs: !!flipDirs });
      stats.ops++;
      return dst;
    },

    /** Records `src.scatter(ratio)`; returns the destination handle. */
    recordScatter(src, ratio) {
      const dst = nextPoly();
      recorded.push({ t: "scatter", src, dst, ratio });
      stats.ops++;
      return dst;
    },

    /**
     * Records an erase-circle generation. Returns { handle, base } —
     * the drawIndirect args land in handle at INDIRECT_BYTE_OFFSET.
     * @param {number} maxCircles conservative upper bound (CPU-known: the
     *   count draw is rh(80,110) * countFactor, so 110 * countFactor bounds
     *   it and the arena reservation stays a pure CPU decision)
     */
    recordErase(params, maxCircles) {
      const handle = nextEraseHandle();
      const base = circleCursor;
      circleCursor += maxCircles;
      gc.ensureCircles(circleCursor);
      recorded.push({ t: "erase", handle, params, base });
      stats.ops++;
      return { handle, base };
    },

    /** True when compute work awaits flushCompute(). */
    pending() {
      return recorded.length > 0;
    },

    /**
     * Encodes every recorded op into ONE compute pass on the caller's
     * encoder, then uploads the uniform arena with a single writeBuffer.
     * Must run before the render pass that consumes the poly buffers.
     */
    flushCompute(encoder) {
      if (recorded.length === 0) return;
      gc.beginBatch();
      const pass = encoder.beginComputePass({ label: "gpu-fill-ops" });
      gc.rectInit(pass);
      for (const op of recorded) {
        switch (op.t) {
          case "opInit":
            gc.opInit(pass, op.fillId, op.op);
            break;
          case "grow":
            gc.grow(pass, op.src, op.dst, op.f, { flipDirs: op.flipDirs });
            break;
          case "scatter":
            gc.scatter(pass, op.src, op.dst, op.ratio);
            break;
          case "erase":
            gc.erase(pass, op.handle, op.params, op.base);
            break;
          default:
            throw new Error(`gpu-fill: unknown op ${op.t}`);
        }
      }
      pass.end();
      gc.uploadBatch();
      recorded = [];
    },

    /** Records a layer draw of a GPU-resident polygon. */
    drawLayer(poly, matrix, fillAlpha, lineWidth, strokeAlpha) {
      fillR.layerGpu(
        poly.buffer,
        matrix,
        { r: 1, g: 0, b: 0, a: fillAlpha },
        lineWidth,
        { r: 1, g: 0, b: 0, a: strokeAlpha },
        { fill: INDIRECT_BYTE_OFFSET, border: BORDER_INDIRECT_BYTE_OFFSET },
      );
    },

    /** Records an erase draw of GPU-generated circles. */
    drawErase(handle, base, matrix, radiusScale, alpha) {
      fillR.eraseGpu(
        gc.circleRef,
        handle.buffer,
        INDIRECT_BYTE_OFFSET,
        matrix,
        radiusScale,
        alpha,
        base,
      );
    },

    /** CPU-owned half of the dirty-rect buffer (see spectral.wgsl vsRect). */
    writeRectCpuHalf(cpuRect, width, height) {
      gc.writeRectCpuHalf(cpuRect, width, height);
    },

    get rectBuffer() {
      return gc.rectBuffer;
    },

    destroy() {
      for (const p of polyPool) p.buffer.destroy();
      for (const e of erasePool) e.buffer.destroy();
      polyPool.length = 0;
      erasePool.length = 0;
      recorded = [];
      gc.destroy();
    },
  };

  return api;
}
