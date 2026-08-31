// =============================================================================
// grow-compute (W2) — JS driver for wgsl/grow.wgsl
//
// GPU port of src/fill/fill.js FillPoly.grow() (which internally calls
// trim()). The CPU implementation is untouched and remains the manipulation
// path and the debugger; this module only adds a parallel producer.
//
// Frame-path contract (plan gotchas #9/#10):
//   - grow() only records two dispatches on a caller-provided compute pass.
//     No submit, no mapAsync, no readback anywhere in this path.
//   - Output slots are a pure function of (input, layer op salts, vertex
//     index) — no atomics, deterministic buffer order.
//   - The drawIndirect args live INSIDE the output poly buffer at byte
//     offset 32 (INDIRECT_BYTE_OFFSET): stencil-fill consumes a grown
//     polygon with renderPass.drawIndirect(poly.buffer, 32) after pulling
//     vertices from the same buffer (fan expansion in the vertex shader —
//     vertexCount is pre-expanded to 3 * (count - 2)).
//
// W3 dispatch contract (per grow step, i.e. per `.grow(f)` in fill()):
//   const gc = await createGrowCompute(gpu, cache);
//   gc.setState({ bleedStrength, direction });        // per fill() call
//   gc.uploadPools(gaussA, gaussB);                   // per seed() (data!)
//   gc.setFill(fillId, opCounter);                    // per createFill()
//   const pass = encoder.beginComputePass();
//   gc.beginBatch();                                  // per encoder
//   gc.grow(pass, srcPoly, dstPoly, f);               // any DAG of polys
//   pass.end();
//   // later: renderPass.drawIndirect(dstPoly.buffer, INDIRECT_BYTE_OFFSET)
//
// The fill-op salt counter (fill.js _fillOp) is GPU-RESIDENT (a 4-byte
// buffer) because trim()'s salt consumption depends on the polygon's
// CURRENT vertex count (`v.length <= 8` fast path skips a salt), and vertex
// counts only exist on the GPU mid-chain. CPU-side ops that interleave
// (scatter/erase/darker run on CPU in W3) must sync via
// setOpCounter()/readOpCounter() at fill boundaries — see FORK notes.
//
// Exact-parity machinery (mirrors grow.wgsl header):
//   - decomposeFrac(): (1 - f) as exact f64 mantissa/shift so the GPU
//     reproduces `~~((1 - f) * totalN)` bit-exactly for any N.
//   - buildStepTable(): T[s] = largest idx with the ACTUAL JS expression
//     `idx > GROW_CAP ? Math.ceil(idx / GROW_CAP) : 1` yielding <= s.
//   - buildTrigTables(): utils.js's 1440-entry f32 cos/sin LUT, rebuilt
//     with the identical expression and verified against the exported
//     cos()/sin() at load.
//   - deriveSeedU32(): recovers the private _seedU32 by inverting the
//     lowbias32 finalizer on hashU32(0,0,0) — no utils.js edit needed,
//     and it fails loudly if the hash construction ever changes.
// =============================================================================

import { STREAM, hashU32, _getSeedU32, cos as utilCos, sin as utilSin } from "../core/utils.js";
import { GROW_WGSL } from "./wgsl/grow.wgsl.js";

// --------------------------------------------------------------------------
// Poly buffer layout (bytes) — keep in sync with grow.wgsl header.
// --------------------------------------------------------------------------
export const HDR_WORDS = 16;
export const INDIRECT_BYTE_OFFSET = 32;
export const VERTS_BYTE_OFFSET = HDR_WORDS * 4; // 64

export const POOL_SIZE = 512; // fill.js GAUSSIAN_POOL_SIZE
export const GROW_MAX_VERTS = 2024; // fill.js GROW_MAX_VERTS

// consts buffer layout (f32 words) — keep in sync with grow.wgsl.
const CONSTS_POOL_A = 0;
const CONSTS_POOL_B = 512;
const CONSTS_COS = 1024;
const CONSTS_SIN = 2464;
const CONSTS_STEP_TABLE = 3904;
const STEP_TABLE_LEN = 64;
const CONSTS_WORDS = CONSTS_STEP_TABLE + STEP_TABLE_LEN; // 3968

/** Total byte size of a poly buffer with the given vertex capacity. */
export function polyByteSize(capacity) {
  return (HDR_WORDS + 4 * capacity) * 4;
}
export function modsByteOffset(capacity) {
  return (HDR_WORDS + 2 * capacity) * 4;
}
export function dirsByteOffset(capacity) {
  return (HDR_WORDS + 3 * capacity) * 4;
}

/** fill.js: GROW_CAP = GROW_MAX_VERTS * Math.max(0.2, 2 * bleed_strength) */
export function computeGrowCap(bleedStrength) {
  return GROW_MAX_VERTS * Math.max(0.2, 2 * bleedStrength);
}

// --------------------------------------------------------------------------
// WGSL assembly — stream ids are injected from the canonical STREAM map so
// the shader can never drift from core/utils.js.
// --------------------------------------------------------------------------

const PRELUDE_STREAMS = [
  "GROW_MOD999",
  "GROW_ROT",
  "GROW_DIST_POOL",
  "GROW_DIST_SCALE",
  "GROW_MOD_POOL",
  "TRIM_SAMPLE",
  "TRIM_JIT_X",
  "TRIM_JIT_Y",
  "TRIM_MOD",
];

/** Generated `const STREAM_*` prelude for grow.wgsl. */
export function buildGrowPrelude() {
  return (
    PRELUDE_STREAMS.map((name) => {
      const id = STREAM[name];
      if (!Number.isInteger(id)) {
        throw new Error(`grow-compute: STREAM.${name} missing from core/utils.js`);
      }
      return `const STREAM_${name}: u32 = ${id}u;`;
    }).join("\n") + "\n"
  );
}

/**
 * Full grow WGSL: prelude + the bundled source (W3 unified the raw .wgsl
 * fetch to a .wgsl.js string export so rollup bundles it).
 * Kept async for API compatibility with W2 callers.
 */
export async function fetchGrowWgsl() {
  return buildGrowPrelude() + GROW_WGSL;
}

// --------------------------------------------------------------------------
// Seed recovery — invert the lowbias32 finalizer on hashU32(0, 0, 0).
// hashU32(0,0,0) = finalizer(_seedU32 ^ 0 ^ 0 ^ 0), and every step of the
// finalizer is bijective on u32, so _seedU32 is recoverable exactly.
// --------------------------------------------------------------------------

function modInverse32(a) {
  // Newton iteration doubles correct bits; 5 rounds cover 32 bits (a odd).
  let x = a; // 4 bits correct: a * a ≡ 1 mod 16 for odd a... start refine
  for (let i = 0; i < 5; i++) {
    x = Math.imul(x, 2 - Math.imul(a, x)) | 0;
  }
  return x >>> 0;
}

const INV_21F0AAAD = modInverse32(0x21f0aaad);
const INV_735A2D97 = modInverse32(0x735a2d97);

function unxorshift(h, k) {
  // inverse of h ^= h >>> k (applied enough times to clear all bits)
  let r = h;
  for (let s = k; s < 32; s += k) r = (h ^ (r >>> k)) >>> 0;
  return r >>> 0;
}

function lowbias32(x) {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * The library's hash-stream seed word. W3: utils.js now exports it
 * directly (_getSeedU32); the finalizer inversion below survives purely as
 * a cross-check that the hash construction and the export stay in
 * agreement — it fails loudly if either changes.
 * @returns {number} u32
 */
export function deriveSeedU32() {
  const direct = _getSeedU32();
  const out = hashU32(0, 0, 0);
  let h = unxorshift(out, 15);
  h = Math.imul(h, INV_735A2D97) >>> 0;
  h = unxorshift(h, 15);
  h = Math.imul(h, INV_21F0AAAD) >>> 0;
  h = unxorshift(h, 16);
  if (lowbias32(h) !== out || (h >>> 0) !== direct) {
    throw new Error(
      "grow-compute: hash construction in core/utils.js no longer matches " +
        "the lowbias32 finalizer this module was built against",
    );
  }
  return direct;
}

// --------------------------------------------------------------------------
// Exact-integer helpers (see grow.wgsl header for why these exist)
// --------------------------------------------------------------------------

const _dv = new DataView(new ArrayBuffer(8));

/**
 * Decomposes g = (1 - f) into { mHi, mLo, shift } with
 * g === (mHi * 2^32 + mLo) * 2^-shift exactly. shift === 0 is the
 * "g <= 0 → nTrim = 0" sentinel.
 */
export function decomposeFrac(g) {
  if (!(g > 0)) return { mHi: 0, mLo: 0, shift: 0 };
  if (g > 1) throw new Error(`grow-compute: (1 - f) = ${g} out of range`);
  _dv.setFloat64(0, g);
  const hi = _dv.getUint32(0);
  const lo = _dv.getUint32(4);
  const expF = (hi >>> 20) & 0x7ff;
  if (expF === 0) return { mHi: 0, mLo: 0, shift: 0 }; // subnormal ≈ 0
  const mHi = (hi & 0xfffff) | 0x100000; // implicit leading 1 → mant <= 2^53
  return { mHi, mLo: lo, shift: 1075 - expF };
}

/**
 * T[s] (s = 1..STEP_TABLE_LEN) = largest integer idx for which the actual
 * fill.js expression `idx > GROW_CAP ? Math.ceil(idx / GROW_CAP) : 1`
 * yields <= s. Exact by construction: built by evaluating that expression.
 */
export function buildStepTable(growCap, maxIdx) {
  const jsStep = (idx) => (idx > growCap ? Math.ceil(idx / growCap) : 1);
  const table = new Uint32Array(STEP_TABLE_LEN);
  for (let s = 1; s <= STEP_TABLE_LEN; s++) {
    let c = Math.max(1, Math.floor(growCap * s));
    while (jsStep(c + 1) <= s) c++;
    while (c > 0 && jsStep(c) > s) c--;
    table[s - 1] = c;
  }
  if (table[STEP_TABLE_LEN - 1] < maxIdx) {
    throw new Error(
      `grow-compute: step table too short (T[${STEP_TABLE_LEN}] = ` +
        `${table[STEP_TABLE_LEN - 1]} < max idx ${maxIdx}); raise STEP_TABLE_LEN`,
    );
  }
  return table;
}

/** Rebuilds utils.js's trig LUT with the identical expression. */
export function buildTrigTables() {
  const totalDegrees = 1440;
  const radiansPerIndex = (2 * Math.PI) / totalDegrees;
  const c = new Float32Array(totalDegrees);
  const s = new Float32Array(totalDegrees);
  for (let i = 0; i < totalDegrees; i++) {
    c[i] = Math.cos(i * radiansPerIndex);
    s[i] = Math.sin(i * radiansPerIndex);
  }
  // Guard against utils.js changing its table without this module noticing.
  for (const deg of [0, 0.25, 45, 89.75, 90, 180, 271.25, 359.75]) {
    const idx = Math.round(deg * 4);
    if (c[idx] !== utilCos(deg) || s[idx] !== utilSin(deg)) {
      throw new Error(
        "grow-compute: trig LUT diverged from core/utils.js cos()/sin()",
      );
    }
  }
  return { cos: c, sin: s };
}

// --------------------------------------------------------------------------
// The compute component
// --------------------------------------------------------------------------

const UNIFORM_WORDS = 12; // struct Uniforms — 48 bytes

/**
 * @param {import('./device.js').GpuContext} gpu
 * @param {ReturnType<import('./pipeline.js').createPipelineCache>} cache
 * @param {{capacity?: number, code?: string}} [opts]
 *   capacity — max vertices per poly buffer (default 8192; GROW_CAP bounds
 *   real counts to <= 2 * GROW_MAX_VERTS = 4048, so the default has slack
 *   for trim inserts on top of the cap).
 */
export async function createGrowCompute(gpu, cache, opts = {}) {
  const capacity = opts.capacity ?? 8192;
  const code = opts.code ?? (await fetchGrowWgsl());

  const preparePipe = cache.getComputePipeline({ code, entry: "prepare", label: "grow-prepare" });
  const execPipe = cache.getComputePipeline({ code, entry: "exec", label: "grow-exec" });
  // Oracle-only entry points (lazy — see selfTest below).
  let hashPipe = null;
  let intPipe = null;

  // CALLER CONTRACT in pipeline.js: hold layouts, getBindGroupLayout()
  // returns a fresh wrapper per call.
  const prepareLayout = preparePipe.getBindGroupLayout(0);
  const execLayout = execPipe.getBindGroupLayout(0);

  const opStateBuf = gpu.createBuffer({
    label: "grow-op-state",
    size: 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  const paramsBuf = gpu.createBuffer({
    label: "grow-params",
    size: 80,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const constsBuf = gpu.createBuffer({
    label: "grow-consts",
    size: CONSTS_WORDS * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // Uniform ring: one 48-byte slot per grow() call in a batch.
  const ALIGN = 256;
  let uniCapacity = 64;
  let uniBuf = allocUniforms();
  let uniCursor = 0;
  function allocUniforms() {
    return gpu.createBuffer({
      label: "grow-uniforms",
      size: ALIGN * uniCapacity,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  const trig = buildTrigTables();
  gpu.device.queue.writeBuffer(constsBuf, CONSTS_COS * 4, trig.cos);
  gpu.device.queue.writeBuffer(constsBuf, CONSTS_SIN * 4, trig.sin);

  // State mirrored into per-dispatch uniforms.
  const state = {
    seed: deriveSeedU32(),
    bleedStrength: 0.07,
    bleedDirDeg: -90, // "out"
    growCap: computeGrowCap(0.07),
    floorCap: Math.floor(computeGrowCap(0.07)),
    saltBase: 0,
  };
  let stepTableDirty = true;

  const uniformScratch = new ArrayBuffer(UNIFORM_WORDS * 4);
  const uF32 = new Float32Array(uniformScratch);
  const uU32 = new Uint32Array(uniformScratch);

  function writeStepTable() {
    const table = buildStepTable(state.growCap, 2 * capacity);
    gpu.device.queue.writeBuffer(constsBuf, CONSTS_STEP_TABLE * 4, table);
    stepTableDirty = false;
  }

  function packUniforms(f) {
    const g = decomposeFrac(1 - f);
    uF32[0] = f;
    uU32[1] = state.seed;
    uU32[2] = state.saltBase;
    uU32[3] = capacity;
    uF32[4] = state.bleedStrength;
    uF32[5] = state.bleedDirDeg;
    uF32[6] = state.growCap;
    uU32[7] = state.floorCap;
    uU32[8] = g.mHi;
    uU32[9] = g.mLo;
    uU32[10] = g.shift;
    uU32[11] = 0;
    return uniformScratch;
  }

  function writeUniformSlot(f) {
    if (uniCursor >= uniCapacity) {
      uniCapacity *= 2;
      uniBuf.destroy();
      uniBuf = allocUniforms();
      uniCursor = 0;
    }
    const offset = uniCursor * ALIGN;
    gpu.device.queue.writeBuffer(uniBuf, offset, packUniforms(f));
    uniCursor++;
    return { buffer: uniBuf, offset, size: UNIFORM_WORDS * 4 };
  }

  const execWorkgroups = Math.ceil((2 * capacity) / 64);

  const api = {
    capacity,
    /** Byte offset of the drawIndirect args inside every poly buffer. */
    indirectByteOffset: INDIRECT_BYTE_OFFSET,

    /**
     * @param {{seed?: number, bleedStrength?: number,
     *          direction?: string, growCap?: number}} s
     * seed defaults to re-deriving from core/utils (call after brush seed()).
     * growCap defaults to the fill.js formula from bleedStrength.
     */
    setState(s = {}) {
      if (s.seed !== undefined) state.seed = s.seed >>> 0;
      else state.seed = deriveSeedU32();
      if (s.bleedStrength !== undefined) state.bleedStrength = s.bleedStrength;
      if (s.direction !== undefined) {
        state.bleedDirDeg = s.direction === "out" ? -90 : 90;
      }
      const cap = s.growCap ?? computeGrowCap(state.bleedStrength);
      if (cap !== state.growCap || stepTableDirty) {
        state.growCap = cap;
        state.floorCap = Math.floor(cap);
        stepTableDirty = true;
      }
      if (stepTableDirty) writeStepTable();
    },

    /**
     * Gaussian pools are DATA (filled by the seeded sequential generator at
     * seed() time on the CPU) — uploaded, never re-derived on the GPU.
     * @param {ArrayLike<number>} poolA fill.js _gaussians[0] (512)
     * @param {ArrayLike<number>} poolB fill.js _gaussians[1] (512)
     */
    uploadPools(poolA, poolB) {
      if (poolA.length !== POOL_SIZE || poolB.length !== POOL_SIZE) {
        throw new Error(
          `grow-compute: pools must be exactly ${POOL_SIZE} entries ` +
            `(got ${poolA.length}/${poolB.length})`,
        );
      }
      gpu.device.queue.writeBuffer(constsBuf, CONSTS_POOL_A * 4, Float32Array.from(poolA));
      gpu.device.queue.writeBuffer(constsBuf, CONSTS_POOL_B * 4, Float32Array.from(poolB));
    },

    /**
     * Per-createFill() scope: saltBase = fillId << 10 and the op counter
     * (fill.js nextOpSalt). The counter then lives on the GPU.
     */
    setFill(fillId, opCounter = 0) {
      state.saltBase = (fillId << 10) >>> 0;
      gpu.device.queue.writeBuffer(opStateBuf, 0, new Uint32Array([opCounter >>> 0]));
    },

    /** Reset the uniform ring. Call once per command encoder / batch. */
    beginBatch() {
      uniCursor = 0;
    },

    /** Allocates a poly buffer (STORAGE + INDIRECT; drawIndirect-ready). */
    createPoly(label = "grow-poly") {
      const buffer = gpu.createBuffer({
        label,
        size: polyByteSize(capacity),
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.INDIRECT,
      });
      return { buffer, capacity };
    },

    /**
     * Uploads a CPU-side polygon into a poly buffer.
     * @param {{buffer: GPUBuffer}} poly
     * @param {{verts: {x: number, y: number}[]|Float32Array, mods: ArrayLike<number>,
     *          dirs: ArrayLike<boolean|number>, midP?: {x,y}, sizeX?: number,
     *          sizeY?: number}} data
     */
    writePoly(poly, data) {
      const isFlat = ArrayBuffer.isView(data.verts);
      const count = isFlat ? data.verts.length / 2 : data.verts.length;
      if (count > capacity) {
        throw new Error(`grow-compute: ${count} verts > capacity ${capacity}`);
      }
      const words = new ArrayBuffer(polyByteSize(capacity));
      const f32 = new Float32Array(words);
      const u32 = new Uint32Array(words);
      u32[0] = count;
      f32[1] = data.midP?.x ?? 0;
      f32[2] = data.midP?.y ?? 0;
      f32[3] = data.sizeX ?? 0;
      f32[4] = data.sizeY ?? 0;
      for (let i = 0; i < count; i++) {
        f32[HDR_WORDS + 2 * i] = isFlat ? data.verts[2 * i] : data.verts[i].x;
        f32[HDR_WORDS + 2 * i + 1] = isFlat ? data.verts[2 * i + 1] : data.verts[i].y;
        f32[HDR_WORDS + 2 * capacity + i] = data.mods[i];
        u32[HDR_WORDS + 3 * capacity + i] = data.dirs[i] ? 1 : 0;
      }
      gpu.device.queue.writeBuffer(poly.buffer, 0, words);
    },

    /**
     * Records one grow step (fill.js `poly.grow(f)`) on an open compute
     * pass: prepare (1 thread) then exec (fixed 2*capacity threads; excess
     * threads early-out — no dispatchIndirect, no readback). src and dst
     * must be distinct poly handles; src is not modified, so DAG patterns
     * (`pol.grow(a)` / `pol.grow(b)` from the same pol) just reuse src.
     * @param {GPUComputePassEncoder} pass
     */
    grow(pass, src, dst, f = 1) {
      if (src === dst) throw new Error("grow-compute: src and dst must differ");
      if (stepTableDirty) writeStepTable();
      const uni = writeUniformSlot(f);
      const uniEntry = {
        binding: 0,
        resource: { buffer: uni.buffer, offset: uni.offset, size: uni.size },
      };
      const bgPrepare = cache.getBindGroup(prepareLayout, [
        uniEntry,
        { binding: 1, resource: { buffer: src.buffer } },
        { binding: 2, resource: { buffer: dst.buffer } },
        { binding: 3, resource: { buffer: opStateBuf } },
        { binding: 4, resource: { buffer: paramsBuf } },
        { binding: 5, resource: { buffer: constsBuf } },
      ], "grow-prepare-bg");
      const bgExec = cache.getBindGroup(execLayout, [
        uniEntry,
        { binding: 1, resource: { buffer: src.buffer } },
        { binding: 2, resource: { buffer: dst.buffer } },
        { binding: 4, resource: { buffer: paramsBuf } },
        { binding: 5, resource: { buffer: constsBuf } },
      ], "grow-exec-bg");
      pass.setPipeline(preparePipe);
      pass.setBindGroup(0, bgPrepare);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(execPipe);
      pass.setBindGroup(0, bgExec);
      pass.dispatchWorkgroups(execWorkgroups);
    },

    /**
     * OUT-OF-BAND readback of a poly buffer (oracle / inspection only —
     * never call from a frame path). Needs readback.js.
     */
    async readPoly(poly, readBuffer) {
      const raw = await readBuffer(gpu, poly.buffer);
      const u32 = new Uint32Array(raw);
      const f32 = new Float32Array(raw);
      const count = u32[0];
      const verts = new Float32Array(2 * count);
      const mods = new Float32Array(count);
      const dirs = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        verts[2 * i] = f32[HDR_WORDS + 2 * i];
        verts[2 * i + 1] = f32[HDR_WORDS + 2 * i + 1];
        mods[i] = f32[HDR_WORDS + 2 * capacity + i];
        dirs[i] = u32[HDR_WORDS + 3 * capacity + i];
      }
      return {
        count,
        verts,
        mods,
        dirs,
        midP: { x: f32[1], y: f32[2] },
        sizeX: f32[3],
        sizeY: f32[4],
        indirect: [u32[8], u32[9], u32[10], u32[11]],
      };
    },

    /** OUT-OF-BAND: current GPU-resident fill op counter. */
    async readOpCounter(readBuffer) {
      const raw = await readBuffer(gpu, opStateBuf, { size: 4 });
      return new Uint32Array(raw)[0];
    },

    /**
     * Oracle-only: dispatches hashSelfTest / intSelfTest into dst and
     * returns the raw result words. n <= capacity.
     */
    async selfTest(kind, dst, readBuffer, f = 0.5) {
      if (!hashPipe) {
        hashPipe = cache.getComputePipeline({ code, entry: "hashSelfTest", label: "grow-hash-test" });
        intPipe = cache.getComputePipeline({ code, entry: "intSelfTest", label: "grow-int-test" });
      }
      if (stepTableDirty) writeStepTable();
      const pipe = kind === "hash" ? hashPipe : intPipe;
      const layout = pipe.getBindGroupLayout(0);
      const uni = writeUniformSlot(f);
      const entries = [
        { binding: 0, resource: { buffer: uni.buffer, offset: uni.offset, size: uni.size } },
        { binding: 2, resource: { buffer: dst.buffer } },
      ];
      if (kind !== "hash") {
        entries.push({ binding: 5, resource: { buffer: constsBuf } });
      }
      const bg = gpu.device.createBindGroup({ layout, entries });
      const encoder = gpu.device.createCommandEncoder({ label: `grow-${kind}-test` });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(capacity / 64));
      pass.end();
      gpu.device.queue.submit([encoder.finish()]);
      const raw = await readBuffer(gpu, dst.buffer);
      return new Uint32Array(raw).subarray(HDR_WORDS, HDR_WORDS + 3 * capacity);
    },

    destroy() {
      opStateBuf.destroy();
      paramsBuf.destroy();
      constsBuf.destroy();
      uniBuf.destroy();
    },
  };

  return api;
}
