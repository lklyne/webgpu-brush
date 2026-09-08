// ============================================================
// W4b inspection/manipulation oracle — browser half.
//
// Drives the built standalone bundle (/dist/brush.esm.js) end to end and
// gates the four W4b "done when" criteria:
//   1. roundtrip     — identity hook (read → write back unmodified) is
//                      byte-identical to the CPU-producer baseline; a
//                      replacement-returning identity hook too; an open
//                      capture (readGeometry) does not perturb the render;
//                      captured geometry is structurally sound and the GPU
//                      capture matches a CPU capture stamp-for-stamp.
//   2. translate     — a hook adding +40 device px in x visibly translates
//                      the render: ink bbox moves +40 ± 2 px in x, ± 2 in y.
//   3. isolation     — hooked stream A + unhooked stream B in one scene;
//                      B's draw-path JS time with the hook registered is
//                      within noise of the no-hook run (threshold: median
//                      ≤ 1.5 × no-hook median + 3 ms over 7 reps) AND
//                      routing is asserted: B's strokes stay on the GPU
//                      walk (gpuStrokes counter), A's are hooked.
//   4. cpu-vs-gpu    — cpuGeometry()/noCpuGeometry() render each scenario
//                      within RMSE < 1.0/255 (float precision only).
//
// Chain note: stroke.js's cross-stroke pressure-cache chain (upstream's
// markerTip leak) survives seed(); every run draws one sacrificial
// CPU-path stroke, then reseeds and clears, so all runs start from the
// identical chain state regardless of run order.
//
// Driven headlessly by scripts/oracle-w4b.mjs.
// ============================================================

const status = document.getElementById("status");
const tests = [];
const SEED = "w4b-0";
const W = 384;
const H = 384;
const INK = "#1c1a17";
const BLUE = "#2c4d8e";
const RED = "#b23a2e";
const BG = "#ffffff";

function log(line) {
  status.textContent += `\n${line}`;
}

// ---------------------------------------------------------------------------
// Scenes — all strokes GPU-walk-eligible (line/flowLine, default/marker/
// spray tips, gaussian pressure, no transforms), coordinates centered
// (standalone build is center-origin) with ≥ 44 px margin so the +40 px
// translate test never clips.
// ---------------------------------------------------------------------------

function sceneLines(b) {
  b.set("HB", INK, 1);
  for (let i = 0; i < 10; i++) {
    b.line(-140, -130 + i * 26, 130, -130 + i * 26 + (i % 3) * 9);
  }
  b.set("2B", BLUE, 1);
  for (let i = 0; i < 4; i++) {
    b.line(-130 + i * 30, 140, -60 + i * 30, -140);
  }
}

function sceneMarkerSpray(b) {
  b.set("marker", BLUE, 1);
  for (let i = 0; i < 6; i++) b.line(-140, -120 + i * 24, 130, -120 + i * 24);
  b.set("spray", RED, 1);
  for (let i = 0; i < 5; i++) b.line(-140, 40 + i * 20, 130, 44 + i * 20);
}

function sceneField(b) {
  b.field("curved");
  b.set("HB", INK, 1);
  for (let i = 0; i < 8; i++) b.flowLine(-140, -140 + i * 36, 270, 0);
  b.noField();
}

function sceneMixed(b) {
  b.set("HB", INK, 1);
  for (let i = 0; i < 5; i++) b.line(-140, -140 + i * 18, 130, -140 + i * 18);
  b.set("marker", BLUE, 1);
  for (let i = 0; i < 4; i++) b.line(-140, -40 + i * 20, 130, -40 + i * 20);
  b.field("curved");
  b.set("2B", RED, 1);
  for (let i = 0; i < 4; i++) b.flowLine(-140, 60 + i * 20, 260, 0);
  b.noField();
}

const SCENES = {
  lines: sceneLines,
  markerSpray: sceneMarkerSpray,
  field: sceneField,
  mixed: sceneMixed,
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function resetAll(b) {
  b.noField();
  b.noFill();
  b.noHatch();
  b.noMass();
  b.noWash();
  b.noStroke();
  b.stream("default");
}

/** Normalize the cross-stroke pressure-cache chain (see header). */
function normalizeChain(b) {
  b.seed(`${SEED}:prewash`);
  b.noiseSeed(`${SEED}:prewash`);
  b.push();
  b.rotate(0.3); // non-translation transform -> always the CPU walk
  b.set("HB", INK, 1);
  b.line(-60, 0, 60, 0);
  b.pop();
}

/**
 * One deterministic render run.
 * @param {object} b brush module
 * @param {Function} sceneFn
 * @param {{cpu?: boolean, hooks?: Array<{stream: string, fn: Function}>,
 *          capture?: boolean, stats?: boolean}} [opts]
 */
async function renderRun(b, sceneFn, opts = {}) {
  if (opts.cpu) b.cpuGeometry();
  else b.noCpuGeometry();
  const disposers = (opts.hooks ?? []).map((h) => b.onGeometry(h.stream, h.fn));
  resetAll(b);
  normalizeChain(b);

  if (opts.stats) b._resetGeometryStats();
  const handle = opts.capture ? b.beginGeometry() : null;

  b.seed(SEED);
  b.noiseSeed(SEED);
  b.clear(BG);
  sceneFn(b);
  b.render();

  const geo = handle ? await b.readGeometry(handle) : null;
  const stats = opts.stats ? b._geometryStats() : null;
  const { pixels, width, height } = await b.readPixels();

  for (const d of disposers) d();
  b.noCpuGeometry();
  resetAll(b);
  return { pixels, width, height, geo, stats };
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function diffCount(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

function rmse255(a, b) {
  let sum = 0;
  let maxAbs = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
    const ad = Math.abs(d);
    if (ad > maxAbs) maxAbs = ad;
  }
  return { rmse: Math.sqrt(sum / a.length), maxAbs };
}

/** Ink bounding box: any pixel whose min RGB channel < 250 on white bg. */
function inkBBox(pixels, width, height) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 250) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        count++;
      }
    }
  }
  return { minX, minY, maxX, maxY, count };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testRoundtrip(b) {
  const t = { name: "roundtrip", pass: false };

  const cpuBase = await renderRun(b, sceneLines, { cpu: true });
  const gpuBase = await renderRun(b, sceneLines, {});

  // Identity hook: reads every value, mutates nothing.
  let hookCalls = 0;
  const idHook = await renderRun(b, sceneLines, {
    stats: true,
    hooks: [
      {
        stream: "default",
        fn: (g) => {
          hookCalls++;
          let acc = 0;
          for (let i = 0; i < g.vertices.length; i++) acc += g.vertices[i];
          t._acc = acc; // keep the read alive
        },
      },
    ],
  });

  // Replacement-returning identity hook (the "return replacements" path).
  const replHook = await renderRun(b, sceneLines, {
    hooks: [
      { stream: "default", fn: (g) => ({ vertices: Float32Array.from(g.vertices) }) },
    ],
  });

  // Open capture must not perturb the GPU render.
  const capGpu = await renderRun(b, sceneLines, { capture: true });
  const capCpu = await renderRun(b, sceneLines, { capture: true, cpu: true });

  t.identityByteIdentical = bytesEqual(cpuBase.pixels, idHook.pixels);
  t.identityDiffBytes = diffCount(cpuBase.pixels, idHook.pixels);
  t.replacementByteIdentical = bytesEqual(cpuBase.pixels, replHook.pixels);
  t.captureByteIdentical = bytesEqual(gpuBase.pixels, capGpu.pixels);
  t.hookCalls = hookCalls;
  t.hookedStrokes = idHook.stats.hookedStrokes;
  t.gpuStrokesDuringHook = idHook.stats.gpuStrokes;

  // Structural sanity of the captured geometry.
  const g = capGpu.geo;
  const sum = g.counts.reduce((s, c) => s + c, 0);
  t.capturedStrokes = g.counts.length;
  t.capturedStamps = sum;
  const structural =
    g.counts.length > 0 &&
    g.counts.length === g.strokeIds.length &&
    sum * 4 === g.vertices.length &&
    g.strokeIds.every((id, i) => i === 0 || id > g.strokeIds[i - 1]);
  t.structuralOk = structural;

  // GPU capture vs CPU capture of the same scene: same stroke/stamp
  // structure, positions within the strokewalk f32 tolerance.
  const gc = capCpu.geo;
  t.captureCountsMatch =
    g.counts.length === gc.counts.length && g.counts.every((c, i) => c === gc.counts[i]);
  let maxPosDiff = 0;
  if (t.captureCountsMatch) {
    for (let i = 0; i < g.vertices.length; i += 4) {
      maxPosDiff = Math.max(
        maxPosDiff,
        Math.abs(g.vertices[i] - gc.vertices[i]),
        Math.abs(g.vertices[i + 1] - gc.vertices[i + 1]),
      );
    }
  }
  t.captureMaxPosDiffPx = +maxPosDiff.toFixed(4);

  t.pass =
    t.identityByteIdentical &&
    t.replacementByteIdentical &&
    t.captureByteIdentical &&
    structural &&
    t.captureCountsMatch &&
    hookCalls > 0;
  delete t._acc;
  return t;
}

async function testTranslate(b) {
  const t = { name: "translate-hook", pass: false };
  const DX = 40;

  const base = await renderRun(b, sceneLines, { cpu: true });
  const shifted = await renderRun(b, sceneLines, {
    hooks: [
      {
        stream: "default",
        fn: (g) => {
          for (let i = 0; i < g.vertices.length; i += g.stride) g.vertices[i] += DX;
        },
      },
    ],
  });

  const b0 = inkBBox(base.pixels, base.width, base.height);
  const b1 = inkBBox(shifted.pixels, shifted.width, shifted.height);
  t.baseBBox = b0;
  t.shiftedBBox = b1;
  t.dxMin = b1.minX - b0.minX;
  t.dxMax = b1.maxX - b0.maxX;
  t.dyMin = b1.minY - b0.minY;
  t.dyMax = b1.maxY - b0.maxY;
  t.inkRatio = +(b1.count / b0.count).toFixed(4);
  t.pass =
    Math.abs(t.dxMin - DX) <= 2 &&
    Math.abs(t.dxMax - DX) <= 2 &&
    Math.abs(t.dyMin) <= 2 &&
    Math.abs(t.dyMax) <= 2 &&
    t.inkRatio > 0.9 &&
    t.inkRatio < 1.1;
  return t;
}

async function testIsolation(b) {
  const t = { name: "perf-isolation", pass: false };
  const NA = 80;
  const NB = 400;
  const REPS = 7;

  const drawAB = (timings) => (brush) => {
    brush.set("HB", INK, 1);
    brush.stream("A");
    for (let i = 0; i < NA; i++) {
      brush.line(-170, -180 + (i % 40) * 4, -20, -180 + (i % 40) * 4 + 2);
    }
    brush.stream("B");
    const t0 = performance.now();
    for (let i = 0; i < NB; i++) {
      brush.line(10, -180 + (i % 90) * 4, 170, -180 + (i % 90) * 4 + 2);
    }
    timings.push(performance.now() - t0);
    brush.stream("default");
  };

  // Warmup (pipeline compiles, JIT).
  await renderRun(b, drawAB([]), {});
  await renderRun(b, drawAB([]), { hooks: [{ stream: "A", fn: () => {} }] });

  const tBase = [];
  const tHooked = [];
  let hookedStats = null;
  let baseStats = null;
  for (let r = 0; r < REPS; r++) {
    const rb = await renderRun(b, drawAB(tBase), { stats: true });
    baseStats = rb.stats;
    const rh = await renderRun(b, drawAB(tHooked), {
      stats: true,
      hooks: [{ stream: "A", fn: () => {} }],
    });
    hookedStats = rh.stats;
  }

  t.repMsBase = tBase.map((x) => +x.toFixed(2));
  t.repMsHooked = tHooked.map((x) => +x.toFixed(2));
  t.medianMsBase = +median(tBase).toFixed(3);
  t.medianMsHooked = +median(tHooked).toFixed(3);
  t.thresholdMs = +(median(tBase) * 1.5 + 3).toFixed(3);
  // Routing: with the hook on A, B's strokes must all stay on the GPU
  // walk; A's must all be hooked. (normalizeChain adds 1 CPU stroke.)
  t.baseGpuStrokes = baseStats.gpuStrokes;
  t.hookedGpuStrokes = hookedStats.gpuStrokes;
  t.hookedStrokes = hookedStats.hookedStrokes;
  t.hookCalls = hookedStats.hookCalls;

  t.pass =
    t.medianMsHooked <= t.thresholdMs &&
    baseStats.gpuStrokes === NA + NB &&
    hookedStats.gpuStrokes === NB &&
    hookedStats.hookedStrokes === NA &&
    hookedStats.hookCalls >= NA;
  return t;
}

async function testCpuVsGpu(b) {
  const t = { name: "cpu-vs-gpu", pass: true, scenes: {} };
  for (const [name, scene] of Object.entries(SCENES)) {
    const gpu = await renderRun(b, scene, {});
    const cpu = await renderRun(b, scene, { cpu: true });
    const { rmse, maxAbs } = rmse255(gpu.pixels, cpu.pixels);
    const pass = rmse < 1.0;
    t.scenes[name] = { rmse: +rmse.toFixed(4), maxAbs, pass };
    if (!pass) t.pass = false;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  const brush = await import("/dist/brush.esm.js");
  const host = document.getElementById("host");
  brush.createCanvas(W, H, { pixelDensity: 1, parent: host });
  await brush.ready();

  for (const fn of [testRoundtrip, testTranslate, testIsolation, testCpuVsGpu]) {
    const t = await fn(brush);
    tests.push(t);
    log(`${t.pass ? "PASS" : "FAIL"} ${t.name}`);
  }

  window.__oracleResults = { tests };
} catch (err) {
  console.error(err);
  window.__oracleResults = { error: String(err && err.stack ? err.stack : err), tests };
}
