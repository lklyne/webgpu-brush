// =============================================================================
// grow-compute — JS driver for wgsl/grow.wgsl, covering the full FillPoly
// op set
//
// GPU port of src/fill/fill.js FillPoly.grow() (which internally calls
// trim()), plus scatter() and erase(). The CPU implementation is
// untouched and remains the manipulation path and the debugger; this module
// only adds a parallel producer.
//
// Frame-path contract (plan gotchas #9/#10):
//   - Every op records ONE dispatch on a caller-provided compute pass.
//     No submit, no mapAsync, no readback anywhere in this path.
//   - Output slots are a pure function of (input, layer op salts, vertex
//     index) — no atomics, deterministic buffer order.
//   - The drawIndirect args live INSIDE the output poly buffer:
//       byte offset 32 — fan fill, vertexCount = 3 * (count - 2)
//       byte offset 48 — border expansion, vertexCount = 12 * count
//     and the vertex bounding box (user space) at words 16..19, so the
//     render side needs no CPU-side geometry to bound its cover quad.
//
// Dispatch contract:
//   const gc = await createGrowCompute(gpu, cache);
//   gc.setState({ bleedStrength, direction });        // per fill() call
//   gc.uploadPools(gaussA, gaussB);                   // per seed() (data!)
//   gc.setPolygon(flatVerts, bbox);                   // per createFill()
//   gc.beginBatch();                                  // per encoder
//   const pass = encoder.beginComputePass();
//   gc.opInit(pass, fillId, opCounter);               // per fill scope
//   gc.grow(pass, srcPoly, dstPoly, f, { flipDirs });
//   gc.scatter(pass, srcPoly, dstPoly, ratio);
//   gc.erase(pass, handlePoly, eraseParams, outBase);
//   pass.end();
//   gc.uploadBatch();  // ONE writeBuffer for every uniform slot recorded
//   // later: renderPass.drawIndirect(dstPoly.buffer, INDIRECT_BYTE_OFFSET)
//
// The fill-op salt counter (fill.js _fillOp) is GPU-RESIDENT (a 4-byte
// buffer) because trim()'s salt consumption depends on the polygon's
// CURRENT vertex count (`v.length <= 8` fast path skips a salt), and vertex
// counts only exist on the GPU mid-chain. This is why the GPU fill DAG is
// all-or-nothing: every salt consumer in fill() — grow, scatter, erase —
// lives on the GPU together, because the counter can never come back to
// the CPU without a readback (gotcha #9).
//
// Exact-parity machinery (mirrors grow.wgsl header):
//   - decomposeFrac(): a positive f64 < = 1 as exact mantissa/shift so the
//     GPU reproduces `~~(frac * N)` bit-exactly for any N. Used for both
//     trim's (1 - f) and scatter's ratio.
//   - buildStepTable(): T[s] = largest idx with the ACTUAL JS expression
//     `idx > GROW_CAP ? Math.ceil(idx / GROW_CAP) : 1` yielding <= s.
//   - buildTrigTables(): utils.js's 1440-entry f32 cos/sin LUT, rebuilt
//     with the identical expression and verified against the exported
//     cos()/sin() at load.
//   - deriveSeedU32(): cross-checks the painting's seed word by inverting
//     the lowbias32 finalizer on hashU32(seed,0,0,0) — it fails loudly if
//     the hash construction ever changes.
// =============================================================================

import { STREAM, hashU32From, _getSeedU32, cos as utilCos, sin as utilSin } from "../core/utils.js";
import { GROW_WGSL } from "./wgsl/grow.wgsl.js";

// --------------------------------------------------------------------------
// Poly buffer layout (bytes) — keep in sync with grow.wgsl header.
// --------------------------------------------------------------------------
export const HDR_WORDS = 24;
export const INDIRECT_BYTE_OFFSET = 32;
export const BORDER_INDIRECT_BYTE_OFFSET = 48;
export const BBOX_WORD = 16;
export const VERTS_BYTE_OFFSET = HDR_WORDS * 4; // 96

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
  "SCATTER_PICK",
  "SCATTER_PULL_X",
  "SCATTER_PULL_Y",
  "ERASE_COUNT",
  "ERASE_X",
  "ERASE_Y",
  "ERASE_R",
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
 * Full grow WGSL: prelude + the bundled source (WGSL ships as a .wgsl.js
 * string export so rollup bundles it like any module — no runtime fetch).
 * Kept async for its callers.
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
 * Checks a painting's hash-stream seed word against the hash construction and
 * returns it. The word itself is handed over by the caller (fill.js reads it
 * off `ctx.rng`); the finalizer inversion survives purely as a cross-check
 * that the construction this module was built against still holds — it fails
 * loudly if core/rng.js changes it. Defaults to the DEFAULT painting's word,
 * which is what the component's initial state uses.
 * @param {number} [seedWord]
 * @returns {number} u32
 */
export function deriveSeedU32(seedWord = _getSeedU32()) {
  const direct = seedWord >>> 0;
  const out = hashU32From(direct, 0, 0, 0);
  let h = unxorshift(out, 15);
  h = Math.imul(h, INV_735A2D97) >>> 0;
  h = unxorshift(h, 15);
  h = Math.imul(h, INV_21F0AAAD) >>> 0;
  h = unxorshift(h, 16);
  if (lowbias32(h) !== out || (h >>> 0) !== direct) {
    throw new Error(
      "grow-compute: hash construction in core/rng.js no longer matches " +
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
 * Decomposes a positive fraction g <= 1 into { mHi, mLo, shift } with
 * g === (mHi * 2^32 + mLo) * 2^-shift exactly. shift === 0 is the
 * "g <= 0 → result 0" sentinel.
 */
export function decomposeFrac(g) {
  if (!(g > 0)) return { mHi: 0, mLo: 0, shift: 0 };
  if (g > 1) throw new Error(`grow-compute: fraction ${g} out of range`);
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

const UNIFORM_WORDS = 40; // struct Uniforms — 160 bytes
const UNIFORM_BYTES = UNIFORM_WORDS * 4;
const ALIGN = 256; // minUniformBufferOffsetAlignment

// Uniform word slots (keep in sync with the WGSL struct).
const U_F = 0, U_SEED = 1, U_SALTBASE = 2, U_CAP = 3, U_BLEED = 4,
  U_BLEEDDIR = 5, U_GROWCAP = 6, U_FLOORCAP = 7, U_GHI = 8, U_GLO = 9,
  U_GSHIFT = 10, U_FLAGS = 11, U_RHI = 12, U_RLO = 13, U_RSHIFT = 14,
  U_SIDECOUNT = 15, U_BBMINX = 16, U_BBMINY = 17, U_BBMAXX = 18,
  U_BBMAXY = 19, U_ECOUNTF = 20, U_EHSX = 21, U_EHSY = 22, U_EMINF = 23,
  U_EMAXF = 24, U_EMIDX = 25, U_EMIDY = 26, U_EOUTBASE = 27, U_OPINIT = 28,
  U_RA = 29, U_RB = 30, U_RC = 31, U_RD = 32, U_RE = 33, U_RF = 34,
  U_RPAD = 35;

/** Words of the shared dirty-rect buffer (see spectral.wgsl vsRect). */
export const RECT_WORDS = 12;

const FLAG_FLIP_SRC_DIRS = 1;

/**
 * @param {import('./device.js').GpuContext} gpu
 * @param {ReturnType<import('./pipeline.js').createPipelineCache>} cache
 * @param {{capacity?: number, code?: string}} [opts]
 *   capacity — max vertices per poly buffer (default 8192; GROW_CAP bounds
 *   real counts to <= 2 * GROW_MAX_VERTS = 4048, so the default has slack
 *   for trim inserts on top of the cap).
 */
export async function createGrowCompute(gpu, cache, opts = {}) {
  return createGrowComputeSync(gpu, cache, opts);
}

/**
 * Synchronous form. The WGSL is a bundled string, so nothing here actually
 * needs to await — and the driver has to be constructible from inside a
 * synchronous draw call so it can be built lazily on the first fill rather
 * than costing every stroke-only sketch its shader compilation at startup.
 * @see createGrowCompute for the parameter contract.
 */
export function createGrowComputeSync(gpu, cache, opts = {}) {
  const capacity = opts.capacity ?? 8192;
  const code = opts.code ?? (buildGrowPrelude() + GROW_WGSL);
  const { device } = gpu;

  // Explicit layout (not 'auto'): the uniform binding needs
  // hasDynamicOffset, which auto layouts never declare. One layout serves
  // every entry point — a pipeline layout may declare bindings an entry
  // does not use.
  const bgLayout = device.createBindGroupLayout({
    label: "grow-bgl",
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_BYTES },
      },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ],
  });
  const pipeLayout = device.createPipelineLayout({
    label: "grow-pl",
    bindGroupLayouts: [bgLayout],
  });

  const mkPipe = (entry, label) =>
    cache.getComputePipeline({ code, entry, label, layout: pipeLayout });

  const growPipe = mkPipe("growStep", "grow-step");
  const rectInitPipe = mkPipe("rectInit", "grow-rect-init");
  const scatterPipe = mkPipe("scatterStep", "grow-scatter");
  const erasePipe = mkPipe("eraseStep", "grow-erase");
  const opInitPipe = mkPipe("opInit", "grow-opinit");
  // Oracle-only entry points (lazy — see selfTest below).
  let hashPipe = null;
  let intPipe = null;

  const opStateBuf = gpu.createBuffer({
    label: "grow-op-state",
    size: 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  const constsBuf = gpu.createBuffer({
    label: "grow-consts",
    size: CONSTS_WORDS * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  // Placeholders for bindings an entry point does not use. Two distinct
  // buffers: binding 1 is read-only and binding 2 is read-write, and one
  // buffer cannot hold both usages in the same synchronization scope.
  const dummyBuf = gpu.createBuffer({
    label: "grow-dummy-src",
    size: 256,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const dummyDstBuf = gpu.createBuffer({
    label: "grow-dummy-dst",
    size: 256,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  // Shared fill dirty rect — the composite reads it as vertex data (see the
  // vsRect note in spectral.wgsl). Never read back.
  const rectBuf = gpu.createBuffer({
    label: "fill-dirty-rect",
    size: RECT_WORDS * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // Original-polygon vertices for scatter's point-in-polygon test.
  let sidesBuf = gpu.createBuffer({
    label: "grow-sides",
    size: 4096,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  // Erase circle arena (x, y, radius, unused) — read by the fill renderer's
  // instanced disc pipeline via drawIndirect.
  let circlesBuf = gpu.createBuffer({
    label: "grow-circles",
    size: 4096 * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  let circlesSlots = 4096;
  // Stable reference the render side records instead of the buffer itself:
  // a later erase in the same batch can grow the arena, and a bind group
  // captured at record time would then point at a destroyed buffer.
  const circleRef = { buffer: circlesBuf };

  // --------------------------------------------------------------------------
  // Uniform staging: every op appends a 256-byte-aligned slot to a CPU
  // arena; uploadBatch() issues ONE writeBuffer for the whole batch. Per-call
  // queue.writeBuffer was measured as the single most expensive thing
  // this codebase can do in a frame.
  // --------------------------------------------------------------------------
  //
  // The GPU buffer can only be resized at beginBatch(): bind groups created
  // during recording hold it, so replacing it mid-batch would leave already
  // recorded dispatches pointing at a destroyed buffer. Overflow inside a
  // batch therefore throws rather than silently corrupting; 8192 ops is ~9x
  // the biggest fill batch this library can produce.
  let uniCapacity = 8192; // slots
  let uniStage = new ArrayBuffer(ALIGN * uniCapacity);
  let uniF32 = new Float32Array(uniStage);
  let uniU32 = new Uint32Array(uniStage);
  let uniBuf = allocUniforms();
  let uniCursor = 0;
  let uniHighWater = 0;

  function allocUniforms() {
    return gpu.createBuffer({
      label: "grow-uniforms",
      size: ALIGN * uniCapacity,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  const trig = buildTrigTables();
  device.queue.writeBuffer(constsBuf, CONSTS_COS * 4, trig.cos);
  device.queue.writeBuffer(constsBuf, CONSTS_SIN * 4, trig.sin);

  // State mirrored into per-dispatch uniforms.
  const state = {
    seed: deriveSeedU32(),
    bleedStrength: 0.07,
    bleedDirDeg: -90, // "out"
    growCap: computeGrowCap(0.07),
    floorCap: Math.floor(computeGrowCap(0.07)),
    saltBase: 0,
    sideCount: 0,
    bbMinX: 0,
    bbMinY: 0,
    bbMaxX: 0,
    bbMaxY: 0,
    // dirty-rect transform (final device px) + the CPU path's pad rule
    rect: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, pad: 0 },
  };
  let stepTableDirty = true;

  function writeStepTable() {
    const table = buildStepTable(state.growCap, 2 * capacity);
    device.queue.writeBuffer(constsBuf, CONSTS_STEP_TABLE * 4, table);
    stepTableDirty = false;
  }

  /** Reserves the next uniform slot and fills the fields shared by all ops. */
  function slot() {
    if (uniCursor >= uniCapacity) {
      throw new Error(
        `grow-compute: more than ${uniCapacity} GPU fill ops in one batch; ` +
          "flush the fill surface more often or raise the uniform capacity",
      );
    }
    const w = uniCursor * (ALIGN / 4);
    const off = uniCursor * ALIGN;
    uniCursor++;
    uniU32.fill(0, w, w + UNIFORM_WORDS);
    uniU32[w + U_SEED] = state.seed;
    uniU32[w + U_SALTBASE] = state.saltBase;
    uniU32[w + U_CAP] = capacity;
    uniF32[w + U_BLEED] = state.bleedStrength;
    uniF32[w + U_BLEEDDIR] = state.bleedDirDeg;
    uniF32[w + U_GROWCAP] = state.growCap;
    uniU32[w + U_FLOORCAP] = state.floorCap;
    uniU32[w + U_SIDECOUNT] = state.sideCount;
    uniF32[w + U_BBMINX] = state.bbMinX;
    uniF32[w + U_BBMINY] = state.bbMinY;
    uniF32[w + U_BBMAXX] = state.bbMaxX;
    uniF32[w + U_BBMAXY] = state.bbMaxY;
    uniF32[w + U_RA] = state.rect.a;
    uniF32[w + U_RB] = state.rect.b;
    uniF32[w + U_RC] = state.rect.c;
    uniF32[w + U_RD] = state.rect.d;
    uniF32[w + U_RE] = state.rect.e;
    uniF32[w + U_RF] = state.rect.f;
    uniF32[w + U_RPAD] = state.rect.pad;
    return { w, off };
  }

  // Bind groups are keyed on (src, dst) only — the uniform binding covers
  // the whole buffer and is selected per dispatch with a dynamic offset.
  const bindCache = new Map();
  function bindFor(src, dst) {
    const key = `${src.id}|${dst.id}`;
    let bg = bindCache.get(key);
    if (bg) return bg;
    bg = device.createBindGroup({
      layout: bgLayout,
      entries: [
        { binding: 0, resource: { buffer: uniBuf, offset: 0, size: UNIFORM_BYTES } },
        { binding: 1, resource: { buffer: src.buffer } },
        { binding: 2, resource: { buffer: dst.buffer } },
        { binding: 3, resource: { buffer: opStateBuf } },
        { binding: 4, resource: { buffer: circlesBuf } },
        { binding: 5, resource: { buffer: constsBuf } },
        { binding: 6, resource: { buffer: sidesBuf } },
        { binding: 7, resource: { buffer: rectBuf } },
      ],
    });
    bindCache.set(key, bg);
    return bg;
  }

  let nextPolyId = 1;
  const dummyPoly = { buffer: dummyBuf, capacity: 0, id: 0 };
  const dummyDst = { buffer: dummyDstBuf, capacity: 0, id: -1 };

  const api = {
    capacity,
    /** Byte offset of the fill drawIndirect args inside every poly buffer. */
    indirectByteOffset: INDIRECT_BYTE_OFFSET,
    /** Byte offset of the border drawIndirect args. */
    borderIndirectByteOffset: BORDER_INDIRECT_BYTE_OFFSET,
    /** The erase circle arena (vec4f per disc). */
    get circleBuffer() {
      return circlesBuf;
    },
    /** Stable handle to the arena; `.buffer` follows reallocation. */
    circleRef,

    /**
     * @param {{seed?: number, bleedStrength?: number,
     *          direction?: string, growCap?: number}} s
     * seed is the drawing painting's hash-stream word (fill.js passes
     * `ctx.rng.seedU32()`); it falls back to the default painting's.
     * growCap defaults to the fill.js formula from bleedStrength.
     */
    setState(s = {}) {
      state.seed = deriveSeedU32(s.seed);
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
      device.queue.writeBuffer(constsBuf, CONSTS_POOL_A * 4, Float32Array.from(poolA));
      device.queue.writeBuffer(constsBuf, CONSTS_POOL_B * 4, Float32Array.from(poolB));
    },

    /**
     * The ORIGINAL polygon scatter()'s point-in-polygon test runs against
     * (fill.js `_polygon.sides` + `_bbMinX.._bbMaxY`). Uploaded once per
     * createFill().
     * @param {Float32Array} flatVerts xy pairs, user space
     * @param {{minX,minY,maxX,maxY}} bbox
     */
    setPolygon(flatVerts, bbox) {
      const bytes = Math.max(16, flatVerts.byteLength);
      if (bytes > sidesBuf.size) {
        sidesBuf.destroy();
        let cap = sidesBuf.size * 2;
        while (cap < bytes) cap *= 2;
        sidesBuf = gpu.createBuffer({
          label: "grow-sides",
          size: cap,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        bindCache.clear();
      }
      device.queue.writeBuffer(sidesBuf, 0, flatVerts);
      state.sideCount = flatVerts.length / 2;
      state.bbMinX = bbox.minX;
      state.bbMinY = bbox.minY;
      state.bbMaxX = bbox.maxX;
      state.bbMaxY = bbox.maxY;
    },

    /** Ensures the erase circle arena holds at least `slots` vec4f. */
    ensureCircles(slots) {
      if (slots <= circlesSlots) return;
      circlesBuf.destroy();
      let cap = circlesSlots * 2;
      while (cap < slots) cap *= 2;
      circlesSlots = cap;
      circlesBuf = gpu.createBuffer({
        label: "grow-circles",
        size: cap * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      circleRef.buffer = circlesBuf;
      bindCache.clear();
    },

    /**
     * Per-createFill() scope. saltBase = fillId << 10 (fill.js nextOpSalt).
     * The op counter itself is seeded from inside the compute pass by
     * opInit() so its ordering against the dispatches is structural.
     */
    setFill(fillId, opCounter = 0) {
      state.saltBase = (fillId << 10) >>> 0;
      device.queue.writeBuffer(opStateBuf, 0, new Uint32Array([opCounter >>> 0]));
    },

    /** Records the GPU-resident op-counter reset. */
    opInit(pass, fillId, opCounter) {
      state.saltBase = (fillId << 10) >>> 0;
      const { w, off } = slot();
      uniU32[w + U_SALTBASE] = state.saltBase;
      uniU32[w + U_OPINIT] = opCounter >>> 0;
      pass.setPipeline(opInitPipe);
      pass.setBindGroup(0, bindFor(dummyPoly, dummyDst), [off]);
      pass.dispatchWorkgroups(1);
    },

    /** The GPU-resident fill dirty rect (device px). Never read back. */
    get rectBuffer() {
      return rectBuf;
    },

    /**
     * Sets the transform used to project vertex bounds into the shared
     * dirty rect, plus the CPU path's `1 + lineWidth/2` padding rule.
     */
    setRectTransform(m, pad) {
      state.rect = { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f, pad };
    },

    /**
     * Writes the parts of the rect buffer the CPU owns: the retained fill
     * path's own bounds (unioned in by the composite) and the target size.
     * @param {{minX,minY,maxX,maxY}|null} cpuRect device px
     */
    writeRectCpuHalf(cpuRect, width, height) {
      const words = new Float32Array(RECT_WORDS - 4);
      const u = new Uint32Array(words.buffer);
      if (cpuRect) {
        words[0] = cpuRect.minX;
        words[1] = cpuRect.minY;
        words[2] = cpuRect.maxX;
        words[3] = cpuRect.maxY;
        u[4] = 1;
      }
      words[5] = width;
      words[6] = height;
      device.queue.writeBuffer(rectBuf, 16, words);
    },

    /** Records the dirty-rect reset at the head of a batch. */
    rectInit(pass) {
      const { off } = slot();
      pass.setPipeline(rectInitPipe);
      pass.setBindGroup(0, bindFor(dummyPoly, dummyDst), [off]);
      pass.dispatchWorkgroups(1);
    },

    /** Reset the uniform ring. Call once per command encoder / batch. */
    beginBatch() {
      uniHighWater = Math.max(uniHighWater, uniCursor);
      uniCursor = 0;
    },

    /** ONE writeBuffer for every uniform slot recorded since beginBatch(). */
    uploadBatch() {
      if (uniCursor === 0) return;
      device.queue.writeBuffer(uniBuf, 0, uniStage, 0, uniCursor * ALIGN);
    },

    /** Ops recorded in the current batch (test instrumentation). */
    get opsRecorded() {
      return uniCursor;
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
      return { buffer, capacity, id: nextPolyId++ };
    },

    /** Small handle buffer for an erase draw (header + indirect args only). */
    createEraseHandle(label = "grow-erase-handle") {
      const buffer = gpu.createBuffer({
        label,
        size: HDR_WORDS * 4,
        usage:
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT,
      });
      return { buffer, capacity: 0, id: nextPolyId++ };
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
      u32[8] = count >= 3 ? 3 * (count - 2) : 0;
      u32[9] = 1;
      u32[12] = count >= 2 ? 12 * count : 0;
      u32[13] = 1;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < count; i++) {
        const x = isFlat ? data.verts[2 * i] : data.verts[i].x;
        const y = isFlat ? data.verts[2 * i + 1] : data.verts[i].y;
        f32[HDR_WORDS + 2 * i] = x;
        f32[HDR_WORDS + 2 * i + 1] = y;
        f32[HDR_WORDS + 2 * capacity + i] = data.mods[i];
        u32[HDR_WORDS + 3 * capacity + i] = data.dirs[i] ? 1 : 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      f32[BBOX_WORD] = minX;
      f32[BBOX_WORD + 1] = minY;
      f32[BBOX_WORD + 2] = maxX;
      f32[BBOX_WORD + 3] = maxY;
      device.queue.writeBuffer(poly.buffer, 0, words);
    },

    /**
     * Records one grow step (fill.js `poly.grow(f)`) on an open compute
     * pass — ONE dispatch of ONE workgroup (see grow.wgsl). src and dst
     * must be distinct poly handles; src is not modified, so DAG patterns
     * (`pol.grow(a)` / `pol.grow(b)` from the same pol) just reuse src.
     * @param {GPUComputePassEncoder} pass
     * @param {{flipDirs?: boolean}} [o] flipDirs applies FillPoly.flipDirs()
     *   to the SOURCE as it is read (the CPU chain always consumes a
     *   flipDirs() result with a grow, so no copy kernel is needed).
     */
    grow(pass, src, dst, f = 1, o = {}) {
      if (src === dst) throw new Error("grow-compute: src and dst must differ");
      if (stepTableDirty) writeStepTable();
      const g = decomposeFrac(1 - f);
      const { w, off } = slot();
      uniF32[w + U_F] = f;
      uniU32[w + U_GHI] = g.mHi;
      uniU32[w + U_GLO] = g.mLo;
      uniU32[w + U_GSHIFT] = g.shift;
      if (o.flipDirs) uniU32[w + U_FLAGS] = FLAG_FLIP_SRC_DIRS;
      pass.setPipeline(growPipe);
      pass.setBindGroup(0, bindFor(src, dst), [off]);
      pass.dispatchWorkgroups(1);
    },

    /** Records one FillPoly.scatter(ratio). */
    scatter(pass, src, dst, ratio) {
      if (src === dst) throw new Error("grow-compute: src and dst must differ");
      const r = decomposeFrac(ratio);
      const { w, off } = slot();
      uniU32[w + U_RHI] = r.mHi;
      uniU32[w + U_RLO] = r.mLo;
      uniU32[w + U_RSHIFT] = r.shift;
      pass.setPipeline(scatterPipe);
      pass.setBindGroup(0, bindFor(src, dst), [off]);
      pass.dispatchWorkgroups(1);
    },

    /**
     * Records one FillPoly.erase(). Every scalar but the salt is CPU-known;
     * circles land at `outBase` in the circle arena and the instanced
     * drawIndirect args are written into `handle`.
     * @param {object} handle from createEraseHandle()
     * @param {{countFactor,halfSizeX,halfSizeY,minSizeFactor,maxSizeFactor,
     *          midX,midY}} p
     * @param {number} outBase first vec4f slot
     */
    erase(pass, handle, p, outBase) {
      const { w, off } = slot();
      uniF32[w + U_ECOUNTF] = p.countFactor;
      uniF32[w + U_EHSX] = p.halfSizeX;
      uniF32[w + U_EHSY] = p.halfSizeY;
      uniF32[w + U_EMINF] = p.minSizeFactor;
      uniF32[w + U_EMAXF] = p.maxSizeFactor;
      uniF32[w + U_EMIDX] = p.midX;
      uniF32[w + U_EMIDY] = p.midY;
      uniU32[w + U_EOUTBASE] = outBase >>> 0;
      pass.setPipeline(erasePipe);
      pass.setBindGroup(0, bindFor(dummyPoly, handle), [off]);
      pass.dispatchWorkgroups(1);
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
        borderIndirect: [u32[12], u32[13], u32[14], u32[15]],
        bbox: { minX: f32[16], minY: f32[17], maxX: f32[18], maxY: f32[19] },
      };
    },

    /** OUT-OF-BAND: current GPU-resident fill op counter. */
    async readOpCounter(readBuffer) {
      const raw = await readBuffer(gpu, opStateBuf, { size: 4 });
      return new Uint32Array(raw)[0];
    },

    /** OUT-OF-BAND: erase circles (oracle only). */
    async readCircles(readBuffer, count, base = 0) {
      const raw = await readBuffer(gpu, circlesBuf, { size: (base + count) * 16 });
      return new Float32Array(raw).subarray(base * 4, (base + count) * 4);
    },

    /**
     * Oracle-only: dispatches hashSelfTest / intSelfTest into dst and
     * returns the raw result words. n <= capacity.
     */
    async selfTest(kind, dst, readBuffer, f = 0.5) {
      if (!hashPipe) {
        hashPipe = mkPipe("hashSelfTest", "grow-hash-test");
        intPipe = mkPipe("intSelfTest", "grow-int-test");
      }
      if (stepTableDirty) writeStepTable();
      const pipe = kind === "hash" ? hashPipe : intPipe;
      const g = decomposeFrac(1 - f);
      const { w, off } = slot();
      uniF32[w + U_F] = f;
      uniU32[w + U_GHI] = g.mHi;
      uniU32[w + U_GLO] = g.mLo;
      uniU32[w + U_GSHIFT] = g.shift;
      api.uploadBatch();
      const encoder = device.createCommandEncoder({ label: `grow-${kind}-test` });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bindFor(dummyPoly, dst), [off]);
      pass.dispatchWorkgroups(Math.ceil(capacity / 64));
      pass.end();
      device.queue.submit([encoder.finish()]);
      const raw = await readBuffer(gpu, dst.buffer);
      return new Uint32Array(raw).subarray(HDR_WORDS, HDR_WORDS + 3 * capacity);
    },

    destroy() {
      opStateBuf.destroy();
      constsBuf.destroy();
      dummyBuf.destroy();
      dummyDstBuf.destroy();
      sidesBuf.destroy();
      circlesBuf.destroy();
      rectBuf.destroy();
      uniBuf.destroy();
    },
  };

  return api;
}
