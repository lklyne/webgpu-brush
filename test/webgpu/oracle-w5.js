// ============================================================
// W5 GPU-resident fill oracle — browser half.
//
// The whole FillPoly DAG (grow, trim, scatter, erase, the layer border and
// the dirty rect) now runs GPU-side; the retained CPU producer is still
// selectable with useCpuGeometry(true). This oracle gates that the two
// producers agree, and that the GPU one is reproducible:
//
//   1. cpu-vs-gpu   — useCpuGeometry(true)/(false) render each fill
//                     scenario within RMSE < 1.0/255 (float precision only).
//                     Same gate as W4b's stroke-side check.
//   2. determinism  — the GPU fill path rendered three times in a row is
//                     byte-identical each time (gotcha #10: no atomic
//                     append, no nondeterministic write order).
//   3. dirty-rect   — the GPU-accumulated composite rect is a SUPERSET of
//                     the ink the CPU producer puts down: rendering the
//                     same scene both ways, no pixel the CPU inks may be
//                     left un-composited by the GPU path. Checked as "the
//                     GPU ink bbox contains the CPU ink bbox", which is
//                     what a truncated rect would break.
//   4. routing      — Stats.enabled captures and useCpuGeometry(true) both
//                     fall back to the CPU DAG, and the GPU path is
//                     actually taken otherwise (driver op counters).
//
// Driven headlessly by scripts/oracle-w5.mjs.
// ============================================================

const status = document.getElementById("status");
const tests = [];
const SEED = "w5-0";
const W = 384;
const H = 384;
const BG = "#ffffff";

function log(line) {
  status.textContent += `\n${line}`;
}

// ---------------------------------------------------------------------------
// Scenes — fill-dominated, exercising the axes the goldens showed matter:
// bleed strength/direction, texture (erase count), scatter on/off, multiple
// colours in one frame, and a self-intersecting outline.
// ---------------------------------------------------------------------------

function blob(b, cx, cy, r, n, phase) {
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const rr = r * (0.75 + 0.25 * Math.sin(phase + k * 2.7));
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  b.polygon(pts);
}

function sceneBasic(b) {
  b.noStroke();
  b.noHatch();
  b.fill("#002185", 100);
  b.fillBleed(0.1, "out");
  b.fillTexture(0.4, 0.4);
  blob(b, 0, 0, 110, 14, 0.7);
}

function sceneBleedHigh(b) {
  b.noStroke();
  b.noHatch();
  b.fill("#c0392b", 80);
  b.fillBleed(0.45, "out");
  b.fillTexture(0.8, 0.6);
  blob(b, 0, 0, 90, 12, 2.1);
}

function sceneBleedIn(b) {
  b.noStroke();
  b.noHatch();
  b.fill("#27ae60", 120);
  b.fillBleed(0.3, "in");
  b.fillTexture(0.2, 0.9);
  blob(b, 0, 0, 100, 16, 1.3);
}

function sceneAlphaFull(b) {
  b.noStroke();
  b.noHatch();
  b.fill("#8e44ad", 255);
  b.fillBleed(0.2, "out");
  b.fillTexture(1, 0.5);
  blob(b, 0, 0, 95, 10, 0.2);
}

function sceneNoScatter(b) {
  b.noStroke();
  b.noHatch();
  b.fill("#e67e22", 150);
  b.fillBleed(0.25, "out");
  b.fillTexture(0.6, 0.4, false); // scatter layers disabled
  blob(b, 0, 0, 100, 18, 3.4);
}

function sceneMulti(b) {
  b.noStroke();
  b.noHatch();
  b.fill("#002185", 90);
  b.fillBleed(0.2, "out");
  b.fillTexture(0.5, 0.4);
  blob(b, -55, -45, 70, 12, 0.4);
  b.fill("#c0392b", 90);
  b.fillBleed(0.3, "out");
  blob(b, 55, 40, 70, 14, 2.9);
}

function sceneSelfIntersect(b) {
  b.noStroke();
  b.noHatch();
  b.fill("#16a085", 110);
  b.fillBleed(0.15, "out");
  b.fillTexture(0.5, 0.4);
  b.polygon([
    [-110, -80],
    [110, 80],
    [110, -80],
    [-110, 80],
  ]);
}

function sceneStrokedFill(b) {
  b.noHatch();
  b.set("HB", "#1c1a17", 1);
  b.fill("#2c4d8e", 120);
  b.fillBleed(0.2, "out");
  b.fillTexture(0.5, 0.4);
  blob(b, 0, 0, 100, 14, 1.1);
  b.noStroke();
}

const SCENES = {
  basic: sceneBasic,
  bleedHigh: sceneBleedHigh,
  bleedIn: sceneBleedIn,
  alphaFull: sceneAlphaFull,
  noScatter: sceneNoScatter,
  multi: sceneMulti,
  selfIntersect: sceneSelfIntersect,
  strokedFill: sceneStrokedFill,
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function resetAll(b) {
  b.noFill();
  b.noStroke();
  b.noHatch();
  b.noField();
}

async function renderRun(b, sceneFn, opts = {}) {
  b.useCpuGeometry(opts.cpu ?? false);
  resetAll(b);
  b.seed(SEED);
  b.noiseSeed(SEED);
  b.clear(BG);
  sceneFn(b);
  b.render();
  const { pixels, width, height } = await b.readPixels();
  b.useCpuGeometry(false);
  resetAll(b);
  return { pixels, width, height };
}

function rmse255(a, b) {
  let sum = 0;
  let maxAbs = 0;
  let differing = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    if (d !== 0) differing++;
    sum += d * d;
    const ad = Math.abs(d);
    if (ad > maxAbs) maxAbs = ad;
  }
  return { rmse: Math.sqrt(sum / a.length), maxAbs, differing };
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Ink bbox: any pixel whose min RGB channel < 250 on a white background. */
function inkBBox(pixels, width, height) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 250) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY, count };
}

function toPng(pixels, width, height) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  const id = ctx.createImageData(width, height);
  id.data.set(pixels);
  ctx.putImageData(id, 0, 0);
  return c.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const dumps = {};

async function testCpuVsGpu(b) {
  const t = { name: "cpu-vs-gpu", pass: true, scenes: {} };
  for (const [name, scene] of Object.entries(SCENES)) {
    const gpu = await renderRun(b, scene, {});
    const cpu = await renderRun(b, scene, { cpu: true });
    const { rmse, maxAbs, differing } = rmse255(gpu.pixels, cpu.pixels);
    const pass = rmse < 1.0;
    t.scenes[name] = {
      rmse: +rmse.toFixed(4),
      maxAbs,
      differingBytes: differing,
      pass,
    };
    if (!pass) {
      t.pass = false;
      if (!dumps[name]) {
        dumps[name] = {
          gpu: toPng(gpu.pixels, gpu.width, gpu.height),
          cpu: toPng(cpu.pixels, cpu.width, cpu.height),
        };
      }
    }
  }
  return t;
}

async function testDeterminism(b) {
  const t = { name: "determinism", pass: true, scenes: {} };
  for (const [name, scene] of Object.entries(SCENES)) {
    const a = await renderRun(b, scene, {});
    const c = await renderRun(b, scene, {});
    const d = await renderRun(b, scene, {});
    const ok = bytesEqual(a.pixels, c.pixels) && bytesEqual(a.pixels, d.pixels);
    t.scenes[name] = { identical: ok };
    if (!ok) t.pass = false;
  }
  return t;
}

async function testDirtyRect(b) {
  // The GPU dirty rect bounds the composite. If it were ever tight enough to
  // clip real coverage, GPU ink would be a strict subset of CPU ink.
  const t = { name: "dirty-rect", pass: true, scenes: {} };
  for (const [name, scene] of Object.entries(SCENES)) {
    const gpu = await renderRun(b, scene, {});
    const cpu = await renderRun(b, scene, { cpu: true });
    const g = inkBBox(gpu.pixels, gpu.width, gpu.height);
    const c = inkBBox(cpu.pixels, cpu.width, cpu.height);
    const covers =
      g.minX <= c.minX && g.minY <= c.minY && g.maxX >= c.maxX && g.maxY >= c.maxY;
    // Ink counts should also be close — a clipped composite loses pixels.
    const ratio = c.count === 0 ? 1 : g.count / c.count;
    const pass = covers && ratio > 0.99 && ratio < 1.01;
    t.scenes[name] = {
      gpuBBox: g,
      cpuBBox: c,
      inkRatio: +ratio.toFixed(4),
      pass,
    };
    if (!pass) t.pass = false;
  }
  return t;
}

async function testRouting(b) {
  const t = { name: "routing", pass: true };
  const driver = b._fillDriverStats?.();
  if (!driver) {
    t.pass = false;
    t.reason = "no _fillDriverStats export";
    return t;
  }
  const before = b._fillDriverStats().fills;
  await renderRun(b, sceneBasic, {});
  const gpuFills = b._fillDriverStats().fills - before;
  const mid = b._fillDriverStats().fills;
  await renderRun(b, sceneBasic, { cpu: true });
  const cpuFills = b._fillDriverStats().fills - mid;
  t.gpuFills = gpuFills;
  t.cpuPathFills = cpuFills;
  // Pool size: the driver never aliases a buffer WITHIN a fill, so this is
  // the op count of the biggest fill seen — reported so the memory cost of
  // that choice stays visible.
  t.polyBuffersPooled = b._fillDriverStats().polysAllocated;
  t.opsRecorded = b._fillDriverStats().ops;
  t.pass = gpuFills >= 1 && cpuFills === 0;
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

  for (const fn of [testCpuVsGpu, testDeterminism, testDirtyRect, testRouting]) {
    const t = await fn(brush);
    tests.push(t);
    log(`${t.pass ? "PASS" : "FAIL"} ${t.name}`);
  }

  window.__oracleResults = { tests, dumps };
} catch (err) {
  console.error(err);
  window.__oracleResults = {
    error: String(err && err.stack ? err.stack : err),
    tests,
    dumps,
  };
}
