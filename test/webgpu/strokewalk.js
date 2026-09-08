// ============================================================
// W2 strokewalk-compute oracle — browser half.
//
// Drives the REAL CPU walk (this fork's dist bundle, instrumented via the
// exported `_stats` hooks — per-stamp capture by wrapping hashNums) and the
// GPU walk (src/webgpu/strokewalk.js) over one fixture, then compares the
// stamp buffers stroke-for-stroke, stamp-for-stamp.
//
// Tests reported via window.__oracleResults:
//   1. hash-battery   — WGSL hashU32 vs JS hashU32, bit-exact on 4096 tuples
//   2. prefix-scan    — GPU exclusive scan vs JS reference (incl. total)
//   3. walk-parity    — GPU stamps vs CPU stamps: counts exact, positions /
//                       size / alpha within stated f32 tolerances. Fixture:
//                       strokes of very different lengths (5..750px),
//                       field-less + field-driven, canvas-exit + field-exit,
//                       default/marker/spray kinds, custom (array) pressure.
//   4. determinism    — two GPU walks of the same batch are byte-identical
//                       (gotcha #10: offsets are prefix-scanned, no atomics)
//   5. timing         — informational: GPU walk vs CPU walk on a
//                       stroke-heavy load (real target is measured at W4a)
//
// Driven headlessly by scripts/oracle-strokewalk.mjs.
// ============================================================

import { initDevice } from "/src/webgpu/device.js";
import { readBuffer } from "/src/webgpu/readback.js";
import { PREFIX_SCAN_WGSL } from "/src/webgpu/wgsl/prefix-scan.wgsl.js";
import {
  createStrokeWalker,
  createDescriptorBuilder,
  hashSeedU32,
  makeHashU32,
  buildTrigTable,
  calcAngleDegrees,
} from "/src/webgpu/strokewalk.js";

const SEED = "strokewalk-w2";
const W = 600;
const H = 600;

// Tolerances (stated; see FORK.md-report notes). Hash u32s are exact; f32
// drift comes from hash01 double-rounding (<=2^-24), WGSL pow vs Math.pow,
// and f32 position accumulation (Kahan on field walks, closed form on
// constant-direction walks).
// Field-driven walks get a wider position gate: a 1-ulp angle difference can
// flip the 0.25-degree trig-LUT index or a field-cell rounding for one step,
// bending the remaining walk by a bounded, sub-visual amount (deterministic
// run-to-run — this is CPU-f64-vs-GPU-f32 only).
const TOL_POS = 0.05; // px, field-less strokes
const TOL_POS_FIELD = 0.15; // px, field-driven strokes
const TOL_SIZE = (cpu) => Math.max(1e-3, 2e-3 * Math.abs(cpu));
const TOL_ALPHA = (cpu) => Math.max(2e-2, 2e-3 * Math.abs(cpu));

const status = document.getElementById("status");
const tests = [];

// ---------------------------------------------------------------------------
// Fixture brushes — copies of stroke.js _standard_brushes (getBrushParams is
// not exported from the dist bundle). Values must match src/stroke/stroke.js.
// ---------------------------------------------------------------------------
const BRUSHES = {
  HB: {
    kind: "default", weight: 0.3, scatter: 0.6, sharpness: 0.3, grain: 0.7,
    opacity: 170, spacing: 0.1, markerTip: true, noise: 0.3,
    pressure: { type: "gaussian", curve: [0.15, 0.2], min_max: [1.1, 0.9] },
  },
  crayon: {
    kind: "default", weight: 0.33, scatter: 1.9, sharpness: 0.75, grain: 2,
    opacity: 159, spacing: 0.07, markerTip: true, noise: 1,
    pressure: { type: "custom", points: [1.1, 0.9] },
  },
  marker: {
    kind: "marker", weight: 2, scatter: 0.2, sharpness: 0, grain: 0,
    opacity: 1, spacing: 0.03, markerTip: true, noise: 0.3,
    pressure: { type: "gaussian", curve: [0.35, 0.25], min_max: [1.2, 0.85] },
  },
  spray: {
    kind: "spray", weight: 0.2, scatter: 6, sharpness: 15, grain: 40,
    opacity: 90, spacing: 0.5, markerTip: true, noise: 0.3,
    pressure: { type: "gaussian", curve: [0.2, 0.35], min_max: [0.7, 1] },
  },
};

// Fixture strokes, in draw order. Integer flowLine dirs keep the GPU's
// f32 `fieldValue - dir` LUT indexing aligned with the CPU's f64 (dir is
// exactly representable); line() dirs never reach GPU trig (precomputed).
const STROKES = [
  { brush: "HB", weight: 1, line: [-250, -200, 150, 180] },
  { brush: "HB", weight: 1, line: [0, 0, 8, 5] }, // very short
  { brush: "crayon", weight: 1, line: [-200, 100, 220, 60] }, // custom pressure
  { brush: "marker", weight: 2, line: [-100, -150, 200, -100] },
  { brush: "spray", weight: 1, line: [-220, 200, 250, 150] },
  { brush: "HB", weight: 1, flow: [10, 10, 5, 45] }, // tiny flowLine
  { brush: "HB", weight: 1, line: [250, 13, 1000, 137] }, // exits canvas, freezes
  { activateField: true },
  { brush: "HB", weight: 1, flow: [-200, -100, 500, 20] }, // long field walk
  { brush: "spray", weight: 1, flow: [-100, 100, 300, -30] },
  { brush: "HB", weight: 1, flow: [280, 280, 600, -45] }, // exits field, freezes
  { brush: "marker", weight: 2, flow: [0, -50, 200, 120] },
];

// Deterministic fixture field. Assigning through Float32Array quantizes to
// f32 exactly as flowfield.js genField() storage does, so the uploaded grid
// is bit-identical to what the CPU walk reads.
const fieldValue = (c, r) =>
  30 * Math.sin(c * 0.17) + 25 * Math.cos(r * 0.13) + 10 * Math.sin((c + r) * 0.053);

// ---------------------------------------------------------------------------
// Gaussian-pool replica. The pool in stroke.js is module-private; it is
// filled by the seeded sequential generator (utils.js gaussian() -> rng) at
// the first saveState() after seed(). Replicated here verbatim — Mulberry32
// + Box-Muller with the cached-pair and 360*v LUT trig. Validated end-to-end:
// any divergence would break default/spray stamp parity immediately.
// (W3: wire the real pool out of stroke.js instead of re-deriving.)
// ---------------------------------------------------------------------------
function makePRNG(seed) {
  let s = hashSeedU32(seed);
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) * 2.3283064365386963e-10;
  };
}

function buildGaussPool(seed, trig) {
  const rng = makePRNG(seed);
  let cached = false;
  let z1 = 0;
  const gaussian = (mean = 0, stdev = 1) => {
    if (cached) {
      cached = false;
      return z1 * stdev + mean;
    }
    const u = 1 - rng();
    const v = rng();
    const r = Math.sqrt(-2.0 * Math.log(u));
    const idx = ~~(360 * v * 4);
    z1 = r * trig[1440 + idx]; // sin
    cached = true;
    return r * trig[idx] * stdev + mean; // cos
  };
  // seed() fires the rng's reseed callbacks: fill.js _fillGaussianPools
  // eagerly draws
  // its 2x512 pools from the same sequential stream BEFORE the stroke pool
  // is lazily filled at the first saveState(). Replicate that burn exactly
  // (the pair cache is shared across mean/stdev variants).
  for (let i = 0; i < 512; i++) {
    gaussian(0.5, 0.2);
    gaussian(0, 0.02);
  }
  const pool = new Float32Array(512);
  for (let i = 0; i < 512; i++) pool[i] = gaussian();
  return pool;
}

// ---------------------------------------------------------------------------
(async () => {
  try {
    // ---- CPU walk with per-stamp capture --------------------------------
    const brush = await import("/dist/brush.esm.js");
    const canvas = brush.createCanvas(W, H, {
      parent: document.getElementById("host"),
      pixelDensity: 1,
      id: "strokewalk-cpu",
    });
    void canvas;
    if (brush.ready) await brush.ready(); // W3: WebGPU device init is async
    brush.angleMode("degrees");
    brush.clear("#f6f1e8");

    // Field grid params mirror flowfield.js createField().
    const resolution = W * 0.01;
    const leftX = -0.5 * W;
    const topY = -0.5 * H;
    const numColumns = Math.round((2 * W) / resolution);
    const numRows = Math.round((2 * H) / resolution);
    brush.addField("oracle-field", (t, field) => {
      for (let c = 0; c < field.length; c++) {
        for (let r = 0; r < field[c].length; r++) field[c][r] = fieldValue(c, r);
      }
      return field;
    });

    brush.seed(SEED);
    brush.noiseSeed(SEED);

    const stats = brush._stats;
    const capture = [];
    stats.reset();
    stats.enabled = true;
    const origBegin = stats.beginStroke.bind(stats);
    const origHash = stats.hashNums.bind(stats);
    stats.beginStroke = () => {
      origBegin();
      capture.push([]);
    };
    stats.hashNums = (...nums) => {
      // 4-number records are circle() stamps: (x, y, diameter, alpha).
      if (capture.length && nums.length === 4) capture[capture.length - 1].push(nums);
      origHash(...nums);
    };

    const drawFixture = (list) => {
      for (const s of list) {
        if (s.activateField) {
          brush.field("oracle-field");
          continue;
        }
        brush.set(s.brush, "#204060", s.weight);
        if (s.line) brush.line(...s.line);
        else brush.flowLine(...s.flow);
      }
    };
    const cpuT0 = performance.now();
    drawFixture(STROKES);
    const cpuFixtureMs = performance.now() - cpuT0;
    stats.enabled = false;
    stats.beginStroke = origBegin;
    stats.hashNums = origHash;
    const cpuSteps = stats.strokes.map((s) => s.steps);

    // ---- GPU setup -------------------------------------------------------
    const gpu = await initDevice({});
    const adapterInfo = gpu.adapter.info
      ? { vendor: gpu.adapter.info.vendor, architecture: gpu.adapter.info.architecture }
      : null;

    const trig = buildTrigTable();
    const gaussPool = buildGaussPool(SEED, trig);
    const seedU32 = hashSeedU32(SEED);

    const fieldData = new Float32Array(numColumns * numRows);
    for (let c = 0; c < numColumns; c++) {
      for (let r = 0; r < numRows; r++) fieldData[c * numRows + r] = fieldValue(c, r);
    }

    const walker = createStrokeWalker(gpu);
    await walker.ensureReady();
    walker.setEnvironment({
      seedU32,
      width: W,
      height: H,
      gaussPool,
      field: { data: fieldData, numColumns, numRows, resolution, leftX, topY },
    });

    // ---- Test 1: hash battery -------------------------------------------
    {
      const N = 4096;
      const tuples = new Uint32Array(N * 4);
      const scramble = makeHashU32(0xdeadbeef);
      for (let i = 0; i < N; i++) {
        if (i < 8) {
          // edge tuples
          const edges = [
            [0, 0, 0], [1, 4, 0], [20, 0xffffffff, 0xffffffff],
            [15, 4, 1], [3, 0x7fffffff, 0x80000000], [47, 1, 2],
            [2, 0xfffffffc, 0], [19, 44, 123456789],
          ];
          tuples.set(edges[i], i * 4);
        } else {
          tuples[i * 4 + 0] = (scramble(1, i, 0) % 47) + 1;
          tuples[i * 4 + 1] = scramble(2, i, 1);
          tuples[i * 4 + 2] = scramble(3, i, 2);
        }
      }
      const code = `
        struct P { seed: u32, n: u32, pad0: u32, pad1: u32 }
        @group(0) @binding(0) var<uniform> p: P;
        @group(0) @binding(1) var<storage, read> inp: array<vec4u>;
        @group(0) @binding(2) var<storage, read_write> outp: array<u32>;
        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) g: vec3u) {
          if (g.x >= p.n) { return; }
          let t = inp[g.x];
          var h = p.seed ^ (t.x * 0x9E3779B1u) ^ (t.y * 0x85EBCA77u) ^ (t.z * 0xC2B2AE3Du);
          h = (h ^ (h >> 16u)) * 0x21F0AAADu;
          h = (h ^ (h >> 15u)) * 0x735A2D97u;
          outp[g.x] = h ^ (h >> 15u);
        }`;
      const pipeline = gpu.device.createComputePipeline({
        layout: "auto",
        compute: { module: gpu.device.createShaderModule({ code }), entryPoint: "main" },
      });
      const pBuf = gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      gpu.device.queue.writeBuffer(pBuf, 0, new Uint32Array([seedU32, N, 0, 0]));
      const inBuf = gpu.createBuffer({ size: tuples.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      gpu.device.queue.writeBuffer(inBuf, 0, tuples);
      const outBuf = gpu.createBuffer({ size: N * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const bg = gpu.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: pBuf } },
          { binding: 1, resource: { buffer: inBuf } },
          { binding: 2, resource: { buffer: outBuf } },
        ],
      });
      const enc = gpu.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(N / 64));
      pass.end();
      gpu.device.queue.submit([enc.finish()]);
      const gpuHashes = new Uint32Array(await readBuffer(gpu, outBuf));
      const jsHash = makeHashU32(seedU32);
      let mismatches = 0;
      for (let i = 0; i < N; i++) {
        if (gpuHashes[i] !== jsHash(tuples[i * 4], tuples[i * 4 + 1], tuples[i * 4 + 2])) mismatches++;
      }
      pBuf.destroy(); inBuf.destroy(); outBuf.destroy();
      tests.push({ name: "hash-battery", pass: mismatches === 0, tuples: N, mismatches });
    }

    // ---- Test 2: prefix scan --------------------------------------------
    {
      const n = 777; // not a multiple of the 256 tile
      const scramble = makeHashU32(0x5ca17e57);
      const counts = new Uint32Array(n);
      for (let i = 0; i < n; i++) counts[i] = i % 13 === 0 ? 0 : scramble(1, 0, i) % 5000;
      const scanSrc = PREFIX_SCAN_WGSL; // W3: bundled .wgsl.js
      const pipeline = gpu.device.createComputePipeline({
        layout: "auto",
        compute: { module: gpu.device.createShaderModule({ code: scanSrc }), entryPoint: "scanExclusive" },
      });
      const pBuf = gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      gpu.device.queue.writeBuffer(pBuf, 0, new Uint32Array([n, 0, 0, 0]));
      const srcBuf = gpu.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      gpu.device.queue.writeBuffer(srcBuf, 0, counts);
      const dstBuf = gpu.createBuffer({ size: (n + 1) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const bg = gpu.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: pBuf } },
          { binding: 1, resource: { buffer: srcBuf } },
          { binding: 2, resource: { buffer: dstBuf } },
        ],
      });
      const enc = gpu.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(1);
      pass.end();
      gpu.device.queue.submit([enc.finish()]);
      const gpuScan = new Uint32Array(await readBuffer(gpu, dstBuf));
      let mismatches = 0;
      let acc = 0;
      for (let i = 0; i < n; i++) {
        if (gpuScan[i] !== acc) mismatches++;
        acc += counts[i];
      }
      if (gpuScan[n] !== acc) mismatches++;
      pBuf.destroy(); srcBuf.destroy(); dstBuf.destroy();
      tests.push({ name: "prefix-scan", pass: mismatches === 0, n, total: acc, mismatches });
    }

    // ---- GPU walk of the fixture ----------------------------------------
    const builder = createDescriptorBuilder({ seedU32, width: W, height: H });
    let fieldOn = false;
    const descs = [];
    for (const s of STROKES) {
      if (s.activateField) {
        fieldOn = true;
        continue;
      }
      const b = BRUSHES[s.brush];
      let x, y, dir, length;
      if (s.line) {
        [x, y] = s.line;
        dir = calcAngleDegrees(...s.line);
        length = Math.hypot(s.line[2] - s.line[0], s.line[3] - s.line[1]);
      } else {
        [x, y, length, dir] = s.flow;
      }
      descs.push(
        builder.build({
          kind: b.kind, x, y, dir, length, brush: b,
          strokeWeight: s.weight, fieldActive: fieldOn, wiggle: 1,
        }),
      );
    }

    const batch = walker.walk(descs);
    await gpu.device.queue.onSubmittedWorkDone();
    const { offsets, total, stamps } = await walker.readBatch(batch);

    // ---- Test 3: walk parity --------------------------------------------
    {
      const perStroke = [];
      let pass = true;
      let worstPos = 0;
      let worstSizeRel = 0;
      let worstAlphaRel = 0;
      for (let i = 0; i < descs.length; i++) {
        const cpu = capture[i] ?? [];
        const gpuCount = offsets[i + 1] - offsets[i];
        const entry = {
          stroke: i,
          brush: STROKES.filter((s) => !s.activateField)[i].brush,
          steps: cpuSteps[i],
          stepsMatch: cpuSteps[i] === descs[i].totalSteps,
          cpuCount: cpu.length,
          gpuCount,
          maxPosDiff: 0,
          maxSizeDiff: 0,
          maxAlphaDiff: 0,
        };
        const isSpray = BRUSHES[entry.brush].kind === "spray";
        const tolPos = descs[i].flags & 2 ? TOL_POS_FIELD : TOL_POS;
        if (isSpray) {
          // Spray iteration counts sit on a ceil(grain/pressure) knife edge:
          // at the pressure plateau 40/p is exactly 40 in f64 but f32 pow can
          // give p just under 1.0 -> 41 dots. Intrinsic f32-vs-f64; align
          // per STEP instead (dots within a step share the hash-drawn `sw`
          // size — run-length segment both sides by exact size bits, dot j
          // matches dot j) and budget the flipped dots.
          const cpuRuns = [];
          const gpuRuns = [];
          {
            let s = 0;
            for (let k = 1; k <= cpu.length; k++) {
              if (k === cpu.length || cpu[k][2] !== cpu[k - 1][2]) {
                cpuRuns.push([s, k]);
                s = k;
              }
            }
            s = 0;
            const sz = (k) => stamps[(offsets[i] + k) * 4 + 2];
            for (let k = 1; k <= gpuCount; k++) {
              if (k === gpuCount || sz(k) !== sz(k - 1)) {
                gpuRuns.push([s, k]);
                s = k;
              }
            }
          }
          entry.cpuSteps = cpuRuns.length;
          entry.gpuSteps = gpuRuns.length;
          entry.flippedDots = 0;
          if (cpuRuns.length !== gpuRuns.length) {
            entry.fail = "step-runs";
            pass = false;
          } else {
            for (let ri = 0; ri < cpuRuns.length; ri++) {
              const [c0, c1] = cpuRuns[ri];
              const [g0, g1] = gpuRuns[ri];
              entry.flippedDots += Math.abs(c1 - c0 - (g1 - g0));
              const m = Math.min(c1 - c0, g1 - g0);
              for (let k = 0; k < m; k++) {
                const o = (offsets[i] + g0 + k) * 4;
                const [cx, cy, cs, ca] = cpu[c0 + k];
                const pd = Math.max(Math.abs(stamps[o] - cx), Math.abs(stamps[o + 1] - cy));
                const sd = Math.abs(stamps[o + 2] - cs);
                const ad = Math.abs(stamps[o + 3] - ca);
                if (pd > entry.maxPosDiff) entry.maxPosDiff = pd;
                if (sd > entry.maxSizeDiff) entry.maxSizeDiff = sd;
                if (ad > entry.maxAlphaDiff) entry.maxAlphaDiff = ad;
                if (pd > tolPos || sd > TOL_SIZE(cs) || ad > TOL_ALPHA(ca)) {
                  if (!entry.fail) {
                    entry.fail = `tolerance@step${ri}dot${k}`;
                    entry.firstBad = {
                      step: ri, dot: k, cpu: [cx, cy, cs, ca],
                      gpu: [stamps[o], stamps[o + 1], stamps[o + 2], stamps[o + 3]],
                    };
                  }
                  pass = false;
                }
              }
            }
            entry.flipFraction = entry.flippedDots / Math.max(1, cpu.length);
            if (entry.flipFraction > 0.005 && !entry.fail) {
              entry.fail = "flip-budget";
              pass = false;
            }
            worstPos = Math.max(worstPos, entry.maxPosDiff);
            worstSizeRel = Math.max(worstSizeRel, entry.maxSizeDiff);
            worstAlphaRel = Math.max(worstAlphaRel, entry.maxAlphaDiff);
          }
        } else if (!entry.stepsMatch || gpuCount !== cpu.length) {
          entry.fail = "count";
          pass = false;
        } else {
          for (let k = 0; k < cpu.length; k++) {
            const o = (offsets[i] + k) * 4;
            const [cx, cy, cs, ca] = cpu[k];
            const pd = Math.max(Math.abs(stamps[o] - cx), Math.abs(stamps[o + 1] - cy));
            const sd = Math.abs(stamps[o + 2] - cs);
            const ad = Math.abs(stamps[o + 3] - ca);
            if (pd > entry.maxPosDiff) entry.maxPosDiff = pd;
            if (sd > entry.maxSizeDiff) entry.maxSizeDiff = sd;
            if (ad > entry.maxAlphaDiff) entry.maxAlphaDiff = ad;
            if (pd > tolPos || sd > TOL_SIZE(cs) || ad > TOL_ALPHA(ca)) {
              if (!entry.fail) {
                entry.fail = `tolerance@stamp${k}`;
                entry.firstBad = { k, cpu: [cx, cy, cs, ca], gpu: [stamps[o], stamps[o + 1], stamps[o + 2], stamps[o + 3]] };
              }
              pass = false;
            }
          }
          worstPos = Math.max(worstPos, entry.maxPosDiff);
          worstSizeRel = Math.max(worstSizeRel, entry.maxSizeDiff);
          worstAlphaRel = Math.max(worstAlphaRel, entry.maxAlphaDiff);
        }
        perStroke.push(entry);
      }
      tests.push({
        name: "walk-parity",
        pass,
        strokes: descs.length,
        totalStamps: total,
        cpuTotalStamps: capture.reduce((s, c) => s + c.length, 0),
        worstPosDiff: worstPos,
        worstSizeDiff: worstSizeRel,
        worstAlphaDiff: worstAlphaRel,
        tolerances: {
          pos: TOL_POS,
          posField: TOL_POS_FIELD,
          size: "max(1e-3, 2e-3*|v|)",
          alpha: "max(2e-2, 2e-3*|v|)",
          sprayFlipBudget: 0.005,
        },
        perStroke,
      });
    }

    // ---- Test 4: determinism (gotcha #10) -------------------------------
    {
      const batch2 = walker.walk(descs);
      await gpu.device.queue.onSubmittedWorkDone();
      const r2 = await walker.readBatch(batch2);
      let identical = r2.total === total && r2.offsets.length === offsets.length;
      if (identical) {
        for (let i = 0; i < offsets.length; i++) {
          if (offsets[i] !== r2.offsets[i]) { identical = false; break; }
        }
      }
      if (identical) {
        const a = new Uint32Array(stamps.buffer, 0, total * 4);
        const b = new Uint32Array(r2.stamps.buffer, 0, total * 4);
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) { identical = false; break; }
        }
      }
      batch2.destroy();
      tests.push({ name: "determinism", pass: identical, totalStamps: total });
    }
    batch.destroy();

    // ---- Test 5: timing (informational — always passes) -----------------
    {
      const HEAVY_N = 256;
      const HEAVY_LEN = 250; // HB spacing 0.1 -> 2500 steps each
      const heavy = [];
      for (let i = 0; i < HEAVY_N; i++) {
        const gx = (i % 16) * 36 - 288;
        const gy = Math.floor(i / 16) * 36 - 288;
        heavy.push({ brush: "HB", weight: 1, flow: [gx, gy, HEAVY_LEN, (i * 7) % 360] });
      }
      // CPU (stats off — pure walk + stamp queueing, GL flush included)
      const t0 = performance.now();
      drawFixture(heavy);
      const cpuMs = performance.now() - t0;
      // GPU (descriptor build + upload + 3 passes + completion)
      const t1 = performance.now();
      const heavyDescs = heavy.map((s) =>
        builder.build({
          kind: "default", x: s.flow[0], y: s.flow[1], dir: s.flow[3],
          length: s.flow[2], brush: BRUSHES.HB, strokeWeight: 1,
          fieldActive: true, wiggle: 1,
        }),
      );
      const buildMs = performance.now() - t1;
      const t2 = performance.now();
      const hb = walker.walk(heavyDescs);
      await gpu.device.queue.onSubmittedWorkDone();
      const gpuMs = performance.now() - t2;
      const hOff = new Uint32Array(await readBuffer(gpu, hb.offsetsBuffer));
      const heavyStamps = hOff[hb.strokeCount];
      hb.destroy();
      tests.push({
        name: "timing",
        pass: true,
        informational: true,
        note: "field-driven walk, 256 strokes x 2500 steps; CPU includes gl_draw queueing/flush; real target measured at W4a",
        strokes: HEAVY_N,
        stepsPerStroke: HEAVY_LEN / BRUSHES.HB.spacing,
        gpuStamps: heavyStamps,
        cpuMs: Math.round(cpuMs * 10) / 10,
        gpuBuildDescMs: Math.round(buildMs * 10) / 10,
        gpuWalkMs: Math.round(gpuMs * 10) / 10,
        speedup: Math.round((cpuMs / gpuMs) * 10) / 10,
        cpuFixtureMs: Math.round(cpuFixtureMs * 10) / 10,
      });
    }

    walker.destroy();
    status.textContent = tests
      .map((t) => `${t.pass ? "PASS" : "FAIL"} ${t.name}`)
      .join("\n");
    window.__oracleResults = { adapter: adapterInfo, tests };
  } catch (err) {
    console.error(err);
    status.textContent = `ERROR: ${err.message}`;
    window.__oracleResults = { error: `${err.message}\n${err.stack}`, tests };
  }
})();
