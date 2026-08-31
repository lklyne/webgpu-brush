// =============================================================================
// strokewalk-compute (W2) — JS host for the GPU flow-field walk.
//
// One thread per stroke, sequential along the stroke, parallel across
// strokes. Three barrier-ordered passes per batch, no readback in the path:
//
//   1. countStamps   — exact per-stroke stamp counts (scalar math only)
//   2. scanExclusive — prefix scan -> deterministic per-stroke base offsets
//                      (plan gotcha #10: NO atomic append; buffer order is a
//                      pure function of stroke index)
//   3. walkStrokes   — the walk; writes stamps to offsets[stroke] + k
//
// The CPU walk in src/stroke/stroke.js stays untouched — it is the debugger
// and the W4b manipulation path. This module is consumed by W3's adapter and
// by scripts/oracle-strokewalk.mjs (which compares GPU output stamp-for-stamp
// against the CPU walk).
//
// API sketch (W3):
//   const walker = createStrokeWalker(gpu);           // gpu: GpuContext (W1a)
//   await walker.ensureReady();                       // fetch + compile WGSL
//   walker.setEnvironment({ seedU32, width, height, gaussPool, field });
//   const builder = createDescriptorBuilder({ seedU32, width, height });
//   const descs = strokes.map((s) => builder.build(s));
//   const batch = walker.walk(descs);                 // submits; no stalls
//   ... batch.stampsBuffer / batch.offsetsBuffer feed the raster pass ...
//   const { offsets, stamps } = await walker.readBatch(batch); // OUT-OF-BAND
//   batch.destroy();
//
// Sequential-seeded data (gaussian pool, flow field, trig LUT) is uploaded as
// buffers, never re-derived on the GPU.
// =============================================================================

import { readBuffer } from "./readback.js";
import { STROKEWALK_WGSL } from "./wgsl/strokewalk.wgsl.js";
import { PREFIX_SCAN_WGSL } from "./wgsl/prefix-scan.wgsl.js";

// ---------------------------------------------------------------------------
// Hash RNG — JS mirror of src/core/utils.js (kept private there; W3 should
// wire the real seed word through rather than re-deriving where possible).
// ---------------------------------------------------------------------------

/**
 * Maps any seed value to a non-zero uint32 — bit-identical to utils.js
 * _hashSeed (which is not exported). Needed to hand the GPU the same seed
 * word the library derives from brush.seed(s).
 * @param {number|string} seed
 * @returns {number} uint32
 */
export function hashSeedU32(seed) {
  let h = 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x9e3779b9) | 0;
    h ^= h >>> 15;
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) | 0;
  return (h ^ (h >>> 16)) >>> 0 || 1;
}

/**
 * hashU32 parameterized by seed word — bit-identical to utils.js hashU32 and
 * to the WGSL transcription (the oracle asserts all three agree).
 */
export const makeHashU32 = (seedU32) => (streamId, salt, index) => {
  let h =
    (seedU32 ^
      Math.imul(streamId, 0x9e3779b1) ^
      Math.imul(salt, 0x85ebca77) ^
      Math.imul(index, 0xc2b2ae3d)) |
    0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
};

// STREAM ids used by the descriptor builder (subset of utils.js STREAM).
const ST_STROKE_SETUP = 1;
const ST_STROKE_ALPHA_NOISE = 2;

// ---------------------------------------------------------------------------
// Trig LUT — mirror of utils.js (1440-entry Float32Array tables).
// ---------------------------------------------------------------------------
const TRIG_N = 1440;
const RAD_PER_IDX = (2 * Math.PI) / TRIG_N;
const cLookup = new Float32Array(TRIG_N);
const sLookup = new Float32Array(TRIG_N);
for (let i = 0; i < TRIG_N; i++) {
  cLookup[i] = Math.cos(i * RAD_PER_IDX);
  sLookup[i] = Math.sin(i * RAD_PER_IDX);
}

/** utils.js angleToIdx, verbatim. */
function angleToIdx(angle) {
  if (angle < 0) {
    if (angle >= -360) return ~~((angle + 360) * 4);
    angle = angle % 360;
    return ~~((angle < 0 ? angle + 360 : angle) * 4);
  }
  if (angle < 360) return ~~(angle * 4);
  if (angle < 720) return ~~((angle - 360) * 4);
  if (angle < 1080) return ~~((angle - 720) * 4);
  angle = angle % 360;
  return ~~((angle < 0 ? angle + 360 : angle) * 4);
}

/** Combined trig table for upload: cos[0..1439] ++ sin[1440..2879]. */
export function buildTrigTable() {
  const t = new Float32Array(TRIG_N * 2);
  t.set(cLookup, 0);
  t.set(sLookup, TRIG_N);
  return t;
}

/**
 * Internal-degrees direction of a line — utils.js calcAngle for the
 * degrees angle mode (atan2 with y flipped, normalized to [0, 360)).
 */
export function calcAngleDegrees(x1, y1, x2, y2) {
  let a = ((Math.atan2(-(y2 - y1), x2 - x1) * 180) / Math.PI) % 360;
  return a < 0 ? a + 360 : a;
}

// ---------------------------------------------------------------------------
// Stroke descriptor builder
//
// Replicates stroke.js saveState() per-stroke setup in f64 (the hash draws
// for pressure params and alpha noise consume the same STREAM slots the CPU
// path consumes) and bakes the results into a flat descriptor. Per-stroke
// setup is O(#strokes) scalar work — keeping it on the CPU sidesteps the
// JS-vs-WGSL transcendental mismatch for Box-Muller (Math.log/cos) entirely.
//
// It also carries upstream's pressure-cache leak: markerTip(1) runs BEFORE
// draw() resets the pressure cache, so the marker start-cap pressure can be
// the *previous stroke's* cached value. The builder simulates that chain
// sequentially (build() must be called in stroke draw order) and bakes
// phase1P per stroke.
// ---------------------------------------------------------------------------

const KIND = { default: 0, marker: 1, spray: 2 };
const FLAG_MARKER_TIP = 1;
const FLAG_FIELD_ACTIVE = 2;
const FLAG_CUSTOM_PRESSURE = 4;

const DEFAULT_VARIATION = { offset: 0.08, scale: 0.08, warp: 0.06, tilt: 0.06 };

// Descriptor packing: 36 4-byte words per stroke, mixed f32/u32 views.
export const STROKE_WORDS = 36;
const U_TOTAL_STEPS = 30;
const U_SALT = 31;
const U_KIND = 32;
const U_FLAGS = 33;

/**
 * f64 replica of stroke.js simPressure()/gauss() for the phase-1 pressure
 * chain. `d` is a built descriptor's f64 shadow.
 */
function simPressureF64(d, plotted) {
  if (d.customPressure) {
    const t = plotted / d.len;
    const tc = Math.max(0, Math.min(1, 0.5 + (t - 0.5 + d.ct) * d.cs));
    const cv =
      tc < 0.5 ? d.ns + (d.nm - d.ns) * tc * 2 : d.nm + (d.ne - d.nm) * (tc - 0.5) * 2;
    const r = cv + d.cp + d.ck * (t - 0.5);
    const v = d.pmin + r * (d.pmax - d.pmin);
    const lo = Math.min(d.pmin, d.pmax);
    const hi = Math.max(d.pmin, d.pmax);
    return Math.max(lo, Math.min(hi, v));
  }
  const peakPos = d.aa * d.len;
  const halfWidth = (plotted < peakPos ? d.bb * 1.2 : d.bb * 0.8) * (d.len / 2);
  const v = 1 / (1 + Math.pow(Math.abs((plotted - peakPos) / halfWidth), 2 * d.cp));
  return d.pmin + v * (d.pmax - d.pmin);
}

/**
 * @param {{seedU32: number, width: number, height: number}} opts
 *   width/height: logical canvas size (Cwidth/Cheight).
 */
export function createDescriptorBuilder({ seedU32, width, height }) {
  const hashU32 = makeHashU32(seedU32);
  const hash01 = (st, sa, ix) => hashU32(st, sa, ix) * 2.3283064365386963e-10;
  const rh = (st, sa, ix, lo, hi) => lo + hash01(st, sa, ix) * (hi - lo);
  const nh = (st, sa, ix, mean, stdev) => {
    const u = 1 - hash01(st, sa, ix * 2);
    const v = hash01(st, sa, ix * 2 + 1);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * stdev + mean;
  };

  // Pressure-cache chain state (stroke.js `current` persists across strokes).
  let chainPc; // undefined until first markerTip-enabled stroke
  let chainCached; // undefined = "cachedPressure === undefined"

  let nextStrokeId = 1;

  /**
   * Build one stroke descriptor. MUST be called in stroke draw order (the
   * phase-1 pressure chain and strokeId are sequential).
   *
   * @param {Object} inp
   * @param {"default"|"marker"|"spray"} inp.kind
   * @param {number} inp.x user-space start x (line()'s x1)
   * @param {number} inp.y
   * @param {number} inp.dir internal degrees (calcAngleDegrees for line())
   * @param {number} inp.length
   * @param {Object} inp.brush brush params: weight, scatter, sharpness,
   *   grain, opacity, spacing, markerTip, noise, and pressure — either
   *   {type:'gaussian', curve:[c0,c1], min_max:[min,max]} or
   *   {type:'custom', points:[s,e]|[s,m,e], min_max?, variation?} (the raw
   *   array control points; arbitrary-function curves are unsupported on the
   *   GPU — route those strokes to the CPU walk).
   * @param {number} inp.strokeWeight State.stroke.weight
   * @param {{x:number, y:number}} [inp.matrix] affine translation (default 0,0)
   * @param {boolean} [inp.fieldActive]
   * @param {number} [inp.wiggle]
   * @param {number} [inp.strokeId] override (default: sequential from 1)
   */
  function build(inp) {
    const {
      kind,
      x,
      y,
      dir,
      length,
      brush,
      strokeWeight,
      matrix = { x: 0, y: 0 },
      fieldActive = false,
      wiggle = 1,
    } = inp;
    if (!(kind in KIND)) {
      throw new Error(
        `strokewalk: unsupported kind "${kind}" (W2 supports default/marker/spray; ` +
          `image/custom tips stay on the CPU walk until W3)`,
      );
    }
    const strokeId = inp.strokeId ?? nextStrokeId;
    nextStrokeId = strokeId + 1;
    const salt = (strokeId << 2) >>> 0;

    // --- pressure setup (STROKE_SETUP slots 0..5, same draws as saveState) --
    const pr = brush.pressure;
    const isCustom = pr.type === "custom";
    const a = !isCustom ? rh(ST_STROKE_SETUP, salt, 0, -1, 1) : 0;
    const b = !isCustom ? rh(ST_STROKE_SETUP, salt, 1, 1, 1.5) : 0;
    let cp, ct, cs, ck;
    let aa = 0, bb = 0, ns = 0, nm = 0, ne = 0;
    let pmin, pmax;
    if (!isCustom) {
      cp = rh(ST_STROKE_SETUP, salt, 2, 3, 3.5);
      ct = 0;
      cs = 1;
      ck = 0;
      aa = 0.5 + pr.curve[0] * a;
      bb = 1 - pr.curve[1] * b;
      [pmin, pmax] = pr.min_max;
    } else {
      const variation = pr.variation ?? DEFAULT_VARIATION;
      cp = rh(ST_STROKE_SETUP, salt, 2, -variation.offset, variation.offset);
      ct = rh(ST_STROKE_SETUP, salt, 3, -variation.warp, variation.warp);
      cs = rh(ST_STROKE_SETUP, salt, 4, 1 - variation.scale, 1 + variation.scale);
      ck = rh(ST_STROKE_SETUP, salt, 5, -variation.tilt, variation.tilt);
      // normalizePressure() array branch
      const p = pr.points;
      if (!Array.isArray(p)) {
        throw new Error(
          "strokewalk: custom pressure needs raw control points " +
            "(pressure.points) — function curves cannot run in WGSL; " +
            "route those strokes to the CPU walk.",
        );
      }
      const [s, m, e] = p.length === 2 ? [p[0], (p[0] + p[1]) / 2, p[1]] : p;
      const lo = Math.min(s, m, e);
      const hi = Math.max(s, m, e);
      const range = hi - lo || 1;
      ns = (s - lo) / range;
      nm = (m - lo) / range;
      ne = (e - lo) / range;
      pmin = lo;
      pmax = hi;
    }

    // --- alpha (calculateAlpha + per-stroke noise gaussian) ----------------
    const baseAlpha =
      kind === "default" || kind === "spray"
        ? brush.opacity
        : brush.opacity / Math.min(strokeWeight, 1.3);
    const noiseStrength = 0.1 * (brush.noise ?? 0);
    const alpha =
      noiseStrength > 0
        ? Math.max(0, baseAlpha * (1 + nh(ST_STROKE_ALPHA_NOISE, salt, 0, 0, noiseStrength)))
        : baseAlpha;

    const stepSize = brush.spacing ?? 1;
    const totalSteps = Math.round(length / stepSize);
    const markerTipOn = brush.markerTip !== false;

    // f64 shadow for the pressure chain
    const d64 = {
      customPressure: isCustom,
      len: length,
      cp, ct, cs, ck, aa, bb, ns, nm, ne, pmin, pmax,
    };

    // --- phase-1 pressure via the cross-stroke cache chain -----------------
    // markerTip(1) runs before draw() resets the cache: recompute only if the
    // previous stroke left the cache expired (or nothing is cached yet).
    let phase1P = 0;
    if (markerTipOn) {
      if (chainPc >= 10 || chainCached === undefined) {
        chainCached = simPressureF64(d64, 0);
        chainPc = 0;
      }
      chainPc++;
      phase1P = chainCached;
    }
    // draw() resets the cache, then the loop recomputes at i % 10 == 0.
    if (totalSteps > 0) {
      chainCached = simPressureF64(
        d64,
        10 * Math.floor((totalSteps - 1) / 10) * stepSize,
      );
      chainPc = ((totalSteps - 1) % 10) + 1;
    } else {
      chainPc = 10;
      chainCached = undefined;
    }
    // markerTip(2)
    if (markerTipOn) {
      if (chainPc >= 10 || chainCached === undefined) {
        chainCached = simPressureF64(d64, totalSteps * stepSize);
        chainPc = 0;
      }
      chainPc++;
    }

    // --- direction precomputes (LUT f32 values -> exact upload) ------------
    const dIdx = angleToIdx(dir);
    const nIdx = angleToIdx(-dir);

    // --- stamp-count upper bound for buffer allocation ---------------------
    let maxStamps;
    if (kind === "marker") maxStamps = totalSteps + (markerTipOn ? 18 : 0);
    else if (kind === "default") maxStamps = totalSteps;
    else {
      const minP = Math.min(pmin, pmax);
      maxStamps = totalSteps * (Math.ceil(brush.grain / minP) + 1);
    }

    return {
      // f32 words 0..29
      x0: x + width / 2,
      y0: y + height / 2,
      dxc: stepSize * cLookup[nIdx],
      dyc: stepSize * sLookup[nIdx],
      dir,
      dirCos: cLookup[dIdx],
      dirSin: sLookup[dIdx],
      stepSize,
      len: length,
      strokeWeight,
      pWeight: brush.weight,
      scatter: brush.scatter ?? 0,
      sharpness: brush.sharpness ?? 0,
      grain: brush.grain ?? 0,
      alpha,
      wiggle,
      mx: matrix.x,
      my: matrix.y,
      pmin,
      pmax,
      cp, ct, cs, ck, aa, bb, ns, nm, ne,
      phase1P,
      // u32 words 30..33
      totalSteps,
      salt,
      kind: KIND[kind],
      flags:
        (markerTipOn ? FLAG_MARKER_TIP : 0) |
        (fieldActive ? FLAG_FIELD_ACTIVE : 0) |
        (isCustom ? FLAG_CUSTOM_PRESSURE : 0),
      maxStamps,
    };
  }

  function reset() {
    chainPc = undefined;
    chainCached = undefined;
    nextStrokeId = 1;
  }

  /**
   * W3: pressure-cache chain sync for mixed CPU/GPU routing. The chain is
   * upstream's cross-stroke leak (stroke.js `current.pressureCount` /
   * `current.cachedPressure`); when strokes alternate between the CPU walk
   * and the GPU walk, the router copies the chain in before build() and
   * back out after, so both paths see the exact upstream sequence.
   */
  function getChain() {
    return { pc: chainPc, cached: chainCached };
  }
  function setChain(chain) {
    chainPc = chain.pc;
    chainCached = chain.cached;
  }

  return { build, reset, getChain, setChain };
}

/** Pack built descriptors into the GPU layout (STROKE_WORDS words each). */
export function packDescriptors(descs) {
  const buf = new ArrayBuffer(descs.length * STROKE_WORDS * 4);
  const f = new Float32Array(buf);
  const u = new Uint32Array(buf);
  descs.forEach((d, i) => {
    const o = i * STROKE_WORDS;
    f[o + 0] = d.x0;
    f[o + 1] = d.y0;
    f[o + 2] = d.dxc;
    f[o + 3] = d.dyc;
    f[o + 4] = d.dir;
    f[o + 5] = d.dirCos;
    f[o + 6] = d.dirSin;
    f[o + 7] = d.stepSize;
    f[o + 8] = d.len;
    f[o + 9] = d.strokeWeight;
    f[o + 10] = d.pWeight;
    f[o + 11] = d.scatter;
    f[o + 12] = d.sharpness;
    f[o + 13] = d.grain;
    f[o + 14] = d.alpha;
    f[o + 15] = d.wiggle;
    f[o + 16] = d.mx;
    f[o + 17] = d.my;
    f[o + 18] = d.pmin;
    f[o + 19] = d.pmax;
    f[o + 20] = d.cp;
    f[o + 21] = d.ct;
    f[o + 22] = d.cs;
    f[o + 23] = d.ck;
    f[o + 24] = d.aa;
    f[o + 25] = d.bb;
    f[o + 26] = d.ns;
    f[o + 27] = d.nm;
    f[o + 28] = d.ne;
    f[o + 29] = d.phase1P;
    u[o + U_TOTAL_STEPS] = d.totalSteps;
    u[o + U_SALT] = d.salt;
    u[o + U_KIND] = d.kind;
    u[o + U_FLAGS] = d.flags;
  });
  return buf;
}

// ---------------------------------------------------------------------------
// The walker
// ---------------------------------------------------------------------------

const WG = 64;

/**
 * @param {import('./device.js').GpuContext} gpu
 * @param {{wgsl?: {walk?: string, scan?: string}}} [opts] inline WGSL sources
 *   (skips fetch — for bundled builds).
 */
export function createStrokeWalker(gpu, opts = {}) {
  const { device } = gpu;
  let countPipeline, walkPipeline, scanPipeline, indirectPipeline;
  let countLayout, walkLayout, scanLayout, indirectLayout;
  let ready = null;

  // Environment buffers (setEnvironment)
  let env = null;
  let trigBuf = null;
  let gaussBuf = null;
  let fieldBuf = null;

  function ensureReady() {
    if (!ready) {
      ready = (async () => {
        // W3: WGSL is bundled (.wgsl.js string exports) — no runtime fetch.
        const walkSrc = opts.wgsl?.walk ?? STROKEWALK_WGSL;
        const scanSrc = opts.wgsl?.scan ?? PREFIX_SCAN_WGSL;
        const walkModule = device.createShaderModule({
          label: "strokewalk",
          code: walkSrc,
        });
        const scanModule = device.createShaderModule({
          label: "prefix-scan",
          code: scanSrc,
        });
        countPipeline = device.createComputePipeline({
          label: "strokewalk-count",
          layout: "auto",
          compute: { module: walkModule, entryPoint: "countStamps" },
        });
        walkPipeline = device.createComputePipeline({
          label: "strokewalk-walk",
          layout: "auto",
          compute: { module: walkModule, entryPoint: "walkStrokes" },
        });
        scanPipeline = device.createComputePipeline({
          label: "prefix-scan",
          layout: "auto",
          compute: { module: scanModule, entryPoint: "scanExclusive" },
        });
        indirectPipeline = device.createComputePipeline({
          label: "strokewalk-indirect",
          layout: "auto",
          compute: { module: scanModule, entryPoint: "writeIndirect" },
        });
        // getBindGroupLayout returns a fresh wrapper per call — hold them.
        countLayout = countPipeline.getBindGroupLayout(0);
        walkLayout = walkPipeline.getBindGroupLayout(0);
        scanLayout = scanPipeline.getBindGroupLayout(0);
        indirectLayout = indirectPipeline.getBindGroupLayout(0);
      })();
    }
    return ready;
  }

  /**
   * Upload the walk environment. Call once per seed/field/canvas change.
   * @param {Object} e
   * @param {number} e.seedU32 the library's seed word (hashSeedU32(seed))
   * @param {number} e.width  logical canvas width (Cwidth)
   * @param {number} e.height logical canvas height (Cheight)
   * @param {Float32Array} e.gaussPool the 512-entry sequential-seeded pool
   *   from stroke.js — uploaded, never re-derived
   * @param {?{data: Float32Array, numColumns: number, numRows: number,
   *          resolution: number, leftX: number, topY: number}} [e.field]
   *   flattened col-major (c * numRows + r); null when no field is active
   */
  function setEnvironment(e) {
    env = e;
    trigBuf?.destroy();
    gaussBuf?.destroy();
    fieldBuf?.destroy();
    const trig = buildTrigTable();
    trigBuf = gpu.createBuffer({
      label: "strokewalk-trig",
      size: trig.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(trigBuf, 0, trig);
    gaussBuf = gpu.createBuffer({
      label: "strokewalk-gauss-pool",
      size: e.gaussPool.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(gaussBuf, 0, e.gaussPool);
    const fieldData = e.field?.data ?? new Float32Array(1);
    fieldBuf = gpu.createBuffer({
      label: "strokewalk-field",
      size: fieldData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(fieldBuf, 0, fieldData);
  }

  /**
   * Encode + submit the three passes for a batch of packed descriptors.
   * No readback here (gotcha #9); use readBatch() out-of-band.
   * @param {Array} descs createDescriptorBuilder().build() outputs
   * @returns {{stampsBuffer: GPUBuffer, offsetsBuffer: GPUBuffer,
   *            countsBuffer: GPUBuffer, strokeCount: number,
   *            capacity: number, destroy: () => void}}
   */
  function walk(descs) {
    if (!countPipeline) {
      throw new Error("strokewalk: call await walker.ensureReady() first");
    }
    if (!env) throw new Error("strokewalk: call walker.setEnvironment() first");
    const n = descs.length;
    const capacity = Math.max(
      1,
      descs.reduce((s, d) => s + d.maxStamps, 0),
    );

    const envData = new ArrayBuffer(48);
    {
      const u = new Uint32Array(envData);
      const f = new Float32Array(envData);
      u[0] = env.seedU32;
      u[1] = n;
      u[2] = env.field?.numColumns ?? 0;
      u[3] = env.field?.numRows ?? 0;
      f[4] = env.width;
      f[5] = env.height;
      f[6] = env.field?.resolution ?? 1;
      f[7] = env.field?.leftX ?? 0;
      f[8] = env.field?.topY ?? 0;
    }
    const envBuf = gpu.createBuffer({
      label: "strokewalk-env",
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(envBuf, 0, envData);

    const packed = packDescriptors(descs);
    const strokesBuf = gpu.createBuffer({
      label: "strokewalk-strokes",
      size: packed.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(strokesBuf, 0, packed);

    const countsBuf = gpu.createBuffer({
      label: "strokewalk-counts",
      size: n * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const offsetsBuf = gpu.createBuffer({
      label: "strokewalk-offsets",
      size: (n + 1) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const stampsBuf = gpu.createBuffer({
      label: "strokewalk-stamps",
      size: capacity * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    // W3: drawIndirect args written GPU-side by the writeIndirect pass —
    // {4, totalStamps, 0, 0}; the raster pass never reads the total back.
    const indirectBuf = gpu.createBuffer({
      label: "strokewalk-indirect",
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
    });
    const scanParamsBuf = gpu.createBuffer({
      label: "strokewalk-scan-params",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(scanParamsBuf, 0, new Uint32Array([n, 0, 0, 0]));

    const countBG = device.createBindGroup({
      label: "strokewalk-count-bg",
      layout: countLayout,
      entries: [
        { binding: 0, resource: { buffer: envBuf } },
        { binding: 1, resource: { buffer: strokesBuf } },
        { binding: 2, resource: { buffer: countsBuf } },
      ],
    });
    const scanBG = device.createBindGroup({
      label: "strokewalk-scan-bg",
      layout: scanLayout,
      entries: [
        { binding: 0, resource: { buffer: scanParamsBuf } },
        { binding: 1, resource: { buffer: countsBuf } },
        { binding: 2, resource: { buffer: offsetsBuf } },
      ],
    });
    const indirectBG = device.createBindGroup({
      label: "strokewalk-indirect-bg",
      layout: indirectLayout,
      entries: [
        { binding: 0, resource: { buffer: scanParamsBuf } },
        { binding: 2, resource: { buffer: offsetsBuf } },
        { binding: 3, resource: { buffer: indirectBuf } },
      ],
    });
    const walkBG = device.createBindGroup({
      label: "strokewalk-walk-bg",
      layout: walkLayout,
      entries: [
        { binding: 0, resource: { buffer: envBuf } },
        { binding: 1, resource: { buffer: strokesBuf } },
        { binding: 3, resource: { buffer: trigBuf } },
        { binding: 4, resource: { buffer: gaussBuf } },
        { binding: 5, resource: { buffer: fieldBuf } },
        { binding: 6, resource: { buffer: offsetsBuf } },
        { binding: 7, resource: { buffer: stampsBuf } },
      ],
    });

    const encoder = device.createCommandEncoder({ label: "strokewalk" });
    const pass = encoder.beginComputePass({ label: "strokewalk" });
    pass.setPipeline(countPipeline);
    pass.setBindGroup(0, countBG);
    pass.dispatchWorkgroups(Math.ceil(n / WG));
    pass.setPipeline(scanPipeline);
    pass.setBindGroup(0, scanBG);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(indirectPipeline);
    pass.setBindGroup(0, indirectBG);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(walkPipeline);
    pass.setBindGroup(0, walkBG);
    pass.dispatchWorkgroups(Math.ceil(n / WG));
    pass.end();
    device.queue.submit([encoder.finish()]);

    return {
      stampsBuffer: stampsBuf,
      offsetsBuffer: offsetsBuf,
      countsBuffer: countsBuf,
      indirectBuffer: indirectBuf,
      strokeCount: n,
      capacity,
      destroy() {
        stampsBuf.destroy();
        offsetsBuf.destroy();
        countsBuf.destroy();
        strokesBuf.destroy();
        envBuf.destroy();
        scanParamsBuf.destroy();
        indirectBuf.destroy();
      },
    };
  }

  /**
   * OUT-OF-BAND readback of a batch (gotcha #9 — never in a frame path).
   * @returns {Promise<{offsets: Uint32Array, total: number,
   *                    stamps: Float32Array}>} stamps is total*4 floats
   *   (x, y, size, alpha per stamp), ordered by (stroke index, emit order).
   */
  async function readBatch(batch) {
    const offsets = new Uint32Array(await readBuffer(gpu, batch.offsetsBuffer));
    const total = offsets[batch.strokeCount];
    const stamps =
      total > 0
        ? new Float32Array(
            await readBuffer(gpu, batch.stampsBuffer, { size: total * 16 }),
          )
        : new Float32Array(0);
    return { offsets, total, stamps };
  }

  function destroy() {
    trigBuf?.destroy();
    gaussBuf?.destroy();
    fieldBuf?.destroy();
  }

  return { ensureReady, setEnvironment, walk, readBatch, destroy };
}
