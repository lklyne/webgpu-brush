// ============================================================
// W2 grow-compute oracle — browser half. Driven by scripts/oracle-grow.mjs.
//
// Diffs GPU grow() (src/webgpu/grow.js + wgsl/grow.wgsl) against the REAL
// CPU FillPoly.grow() (extracted from src/fill/fill.js at runtime — see
// grow-cpu-ref.js), vertex for vertex, on fixed seeds.
//
// Tests:
//   1. hash-parity     — 8192 hashU32(stream, salt, index) triples, GPU vs
//                        CPU. EXACT u32 equality (the W2 hard gate).
//   2. int-parity      — nTrim = ~~((1-f)*N) and the GROW_CAP step
//                        expression for every N in 0..8191 across the
//                        fill() f-schedule and two bleed values. EXACT —
//                        this is what the f64-emulation + step-table
//                        machinery exists for.
//   3..N. grow chains  — multi-layer grow sequences mirroring fill()'s
//                        call patterns (999/997 pairs, trims, darker, cap
//                        downsampling, skipInserted, branching DAG, both
//                        bleed directions) on two polygon sizes. Gates:
//                        counts/dirs/opCounter/indirect EXACT; vertex
//                        positions and mods within float tolerance.
//   last. batched      — case A's whole chain recorded in ONE compute
//                        pass, single submit, read only the final output:
//                        must be bit-identical to the step-by-step run
//                        (proves in-pass dispatch ordering, i.e. the real
//                        frame-path usage with zero readbacks mid-chain).
//
// Tolerances (f32 GPU vs f64 CPU, identical f32-quantized inputs):
//   verts: 0.05 px — hash01 loses 8 low bits in f32 (≤2^-25 abs per draw),
//     trig LUT quantization boundaries can shift one 0.25° step, pool
//     values are f32-rounded; displacements are a few px per layer and
//     errors compound roughly linearly over ≤8 chained layers. Expected
//     typical ≲1e-3; 0.05 keeps an order of magnitude of headroom while
//     staying far below the half-pixel threshold that could change
//     rasterization.
//   mods: 1e-5 — mods accumulate additively from f32-rounded pool values
//     (≤1e-8 per layer).
// ============================================================

import { seed, gaussian, rh, hashU32, STREAM } from "../../src/core/utils.js";
import { initDevice } from "../../src/webgpu/device.js";
import { createPipelineCache } from "../../src/webgpu/pipeline.js";
import { readBuffer } from "../../src/webgpu/readback.js";
import {
  createGrowCompute,
  deriveSeedU32,
  computeGrowCap,
  POOL_SIZE,
} from "../../src/webgpu/grow.js";
import { buildFillPolyRef } from "./grow-cpu-ref.js";

const statusEl = document.getElementById("status");
const CAPACITY = 8192;
const FIXTURE_SEED = "grow-oracle-1";
const VERT_TOL = 0.05;
const MOD_TOL = 1e-5;

const tests = [];
const log = (s) => {
  statusEl.textContent += `\n${s}`;
};

function makeFixture(n, cx, cy, R, bleed, fillId) {
  const verts = [];
  for (let i = 0; i < n; i++) {
    const th = (i / n) * 2 * Math.PI;
    const r = R * (1 + 0.25 * Math.sin(3 * th) + 0.15 * Math.cos(7 * th + 1));
    // f32-quantize inputs so CPU and GPU start from identical bits and the
    // diff isolates the algorithm itself.
    verts.push({
      x: Math.fround(cx + r * Math.cos(th)),
      y: Math.fround(cy + r * Math.sin(th)),
    });
  }
  // Modifiers shaped like createFill()'s (same stream, real draw ranges).
  const fluid = ~~(n * 0.25 * 2);
  const salt0 = (fillId << 10) >>> 0;
  const mods = [];
  const dirs = [];
  for (let i = 0; i < n; i++) {
    mods.push(
      Math.fround((i > fluid ? 1 : 0.3) * rh(STREAM.FILL_MOD, salt0, i, 0.85, 1.4) * bleed),
    );
    dirs.push(i % 7 !== 0);
  }
  let sx = 0,
    sy = 0,
    mx = 0,
    my = 0;
  for (const v of verts) {
    mx += v.x;
    my += v.y;
  }
  mx = Math.fround(mx / n);
  my = Math.fround(my / n);
  for (const v of verts) {
    sx = Math.max(sx, Math.abs(mx - v.x));
    sy = Math.max(sy, Math.abs(my - v.y));
  }
  return { verts, mods, dirs, midP: { x: mx, y: my }, sizeX: Math.fround(sx), sizeY: Math.fround(sy) };
}

function comparePoly(name, gpuP, cpuP) {
  const res = {
    name,
    countGpu: gpuP.count,
    countCpu: cpuP.v.length,
    maxVertDev: 0,
    maxModDev: 0,
    dirMismatches: 0,
    indirectOk: false,
    pass: false,
  };
  if (gpuP.count !== cpuP.v.length) return res;
  for (let i = 0; i < gpuP.count; i++) {
    res.maxVertDev = Math.max(
      res.maxVertDev,
      Math.abs(gpuP.verts[2 * i] - cpuP.v[i].x),
      Math.abs(gpuP.verts[2 * i + 1] - cpuP.v[i].y),
    );
    res.maxModDev = Math.max(res.maxModDev, Math.abs(gpuP.mods[i] - cpuP.m[i]));
    if ((gpuP.dirs[i] !== 0) !== !!cpuP.dir[i]) res.dirMismatches++;
  }
  const fan = gpuP.count >= 3 ? 3 * (gpuP.count - 2) : 0;
  res.indirectOk =
    gpuP.indirect[0] === fan &&
    gpuP.indirect[1] === 1 &&
    gpuP.indirect[2] === 0 &&
    gpuP.indirect[3] === 0;
  res.pass =
    res.maxVertDev <= VERT_TOL &&
    res.maxModDev <= MOD_TOL &&
    res.dirMismatches === 0 &&
    res.indirectOk;
  return res;
}

async function main() {
  // Deterministic CPU state: seeds the hash streams AND the sequential
  // generator feeding the gaussian pools. No other brush module is
  // imported here, so no _onSeed callbacks perturb the pool draws.
  seed(FIXTURE_SEED);
  const pools = [[], []];
  for (let i = 0; i < POOL_SIZE; i++) {
    // Interleaved exactly like fill.js _fillGaussianPools(); f32-quantized
    // so CPU ref and GPU share bit-identical pool data.
    pools[0][i] = Math.fround(gaussian(0.5, 0.2));
    pools[1][i] = Math.fround(gaussian(0, 0.02));
  }
  const seedU32 = deriveSeedU32();

  const fillSource = await (await fetch(new URL("../../src/fill/fill.js", import.meta.url))).text();

  const gpu = await initDevice({});
  const adapterInfo = gpu.adapter.info
    ? { vendor: gpu.adapter.info.vendor, architecture: gpu.adapter.info.architecture }
    : null;
  const cache = createPipelineCache(gpu);
  const gc = await createGrowCompute(gpu, cache, { capacity: CAPACITY });
  gc.uploadPools(pools[0], pools[1]);
  const scratch = gc.createPoly("grow-selftest");

  // -------------------------------------------------------------------
  // 1. hash-parity (exact)
  // -------------------------------------------------------------------
  {
    gc.setState({ seed: seedU32, bleedStrength: 0.07, direction: "out" });
    gc.beginBatch();
    const out = await gc.selfTest("hash", scratch, readBuffer);
    let mismatches = 0;
    for (let k = 0; k < CAPACITY; k++) {
      const cpu = hashU32(k % 53, (k * 2654435761) >>> 0, k * 7 + 3);
      if (out[k] !== cpu) mismatches++;
    }
    tests.push({
      name: "hash-parity",
      pass: mismatches === 0,
      samples: CAPACITY,
      mismatches,
    });
    log(`hash-parity: ${mismatches} mismatches / ${CAPACITY}`);
  }

  // -------------------------------------------------------------------
  // 2. int-parity (exact) — nTrim & cap-step across the fill() schedule
  // -------------------------------------------------------------------
  {
    const fs = [
      0.975, 0.9875, 0.95, 0.9125, 0.9, 0.7, 0.6875, 0.45, 0.4, 0.35,
      0.2837190375, 0.15, 0.0125,
    ];
    const bleeds = [0.07, 0.4];
    let mismatches = 0;
    let checked = 0;
    let firstBad = null;
    for (const bleed of bleeds) {
      const growCap = computeGrowCap(bleed);
      gc.setState({ seed: seedU32, bleedStrength: bleed, direction: "out" });
      for (const f of fs) {
        gc.beginBatch();
        const out = await gc.selfTest("int", scratch, readBuffer, f);
        for (let k = 0; k < CAPACITY; k++) {
          const nTrimJs = ~~((1 - f) * k);
          const stepJs = k > growCap ? Math.ceil(k / growCap) : 1;
          checked += 2;
          if (out[k] !== nTrimJs || out[CAPACITY + k] !== stepJs) {
            mismatches++;
            if (!firstBad) {
              firstBad = { f, bleed, k, gpu: [out[k], out[CAPACITY + k]], js: [nTrimJs, stepJs] };
            }
          }
        }
      }
    }
    tests.push({ name: "int-parity", pass: mismatches === 0, checked, mismatches, firstBad });
    log(`int-parity: ${mismatches} mismatches / ${checked} checks`);
  }

  // -------------------------------------------------------------------
  // 3+. grow chains vs the extracted CPU implementation
  // -------------------------------------------------------------------
  const cases = [
    // A: small polygon, default bleed, full fill()-style layer schedule;
    //    chain reaches GROW_CAP (404.8) → exercises skipInserted.
    { name: "chain-A-n24-out", n: 24, R: 60, bleed: 0.07, direction: "out", fillId: 1,
      chain: [1, 999, 997, 0.9875, 999, 997, 0.35, 999] },
    // B: large polygon, heavy bleed (GROW_CAP 1619.2), incl. the
    //    f = 0.975 exact-integer trim attractor.
    { name: "chain-B-n200-out", n: 200, R: 140, bleed: 0.4, direction: "out", fillId: 2,
      chain: [1, 1, 999, 997, 0.975, 0.45, 999, 997] },
    // C: tiny bleed → mod < 0.05 midpoint branch dominates; direction "in".
    { name: "chain-C-n24-in", n: 24, R: 60, bleed: 0.03, direction: "in", fillId: 3,
      chain: [1, 999, 997, 0.7, 999, 997] },
    // E: idx = 1100 with GROW_CAP 404.8 → odd step 3 → real downsampling.
    { name: "chain-E-n550-cap", n: 550, R: 160, bleed: 0.07, direction: "out", fillId: 5,
      chain: [1, 0.9, 999] },
  ];

  const polyA = gc.createPoly("grow-a");
  const polyB = gc.createPoly("grow-b");
  const polyC = gc.createPoly("grow-c");

  let globalMaxVert = 0;
  let globalMaxMod = 0;

  async function runStep(src, dst, f) {
    gc.beginBatch();
    const encoder = gpu.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    gc.grow(pass, src, dst, f);
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);
    return gc.readPoly(dst, readBuffer);
  }

  for (const c of cases) {
    const opStart = 3; // arbitrary nonzero — mimics setup ops already consumed
    const fx = makeFixture(c.n, 10, -20, c.R, c.bleed, c.fillId);
    const op = { value: opStart };
    const state = { fill: { direction: c.direction, bleed_strength: c.bleed } };
    const Ref = buildFillPolyRef({
      source: fillSource,
      state,
      growCap: computeGrowCap(c.bleed),
      gaussians: pools,
      op,
      fillId: c.fillId,
    });
    let cpu = new Ref(fx.verts, fx.mods, fx.midP, fx.dirs, false, fx.sizeX, fx.sizeY);

    gc.setState({ seed: seedU32, bleedStrength: c.bleed, direction: c.direction });
    gc.setFill(c.fillId, opStart);
    gc.writePoly(polyA, fx);

    let src = polyA;
    let dst = polyB;
    const steps = [];
    let pass = true;
    const counts = [];
    for (const f of c.chain) {
      cpu = cpu.grow(f);
      const gpuP = await runStep(src, dst, f);
      const r = comparePoly(`f=${f}`, gpuP, cpu);
      steps.push(r);
      counts.push(r.countCpu);
      pass = pass && r.pass;
      globalMaxVert = Math.max(globalMaxVert, r.maxVertDev);
      globalMaxMod = Math.max(globalMaxMod, r.maxModDev);
      // ping-pong; keep polyA as the untouched original only for case A? no
      // — rotate through B/C so the fixture buffer is never overwritten.
      src = dst;
      dst = dst === polyB ? polyC : polyB;
    }
    const opGpu = await gc.readOpCounter(readBuffer);
    const opOk = opGpu === op.value;
    pass = pass && opOk;
    tests.push({
      name: c.name,
      pass,
      layers: c.chain.length,
      chain: c.chain,
      counts,
      maxVertDev: Math.max(...steps.map((s) => s.maxVertDev)),
      maxModDev: Math.max(...steps.map((s) => s.maxModDev)),
      opCounter: { gpu: opGpu, cpu: op.value, ok: opOk },
      steps,
    });
    log(`${c.name}: ${pass ? "PASS" : "FAIL"} maxVertDev=${Math.max(...steps.map((s) => s.maxVertDev)).toExponential(2)}`);
  }

  // -------------------------------------------------------------------
  // D: branching DAG — two grows from the SAME source polygon (fill()'s
  // `pols = [pol.grow(a), pol.grow(b), ...]` pattern); op salts must
  // interleave exactly like sequential CPU calls.
  // -------------------------------------------------------------------
  {
    const opStart = 7;
    const fillId = 4;
    const bleed = 0.07;
    const fx = makeFixture(40, -30, 15, 80, bleed, fillId);
    const op = { value: opStart };
    const Ref = buildFillPolyRef({
      source: fillSource,
      state: { fill: { direction: "out", bleed_strength: bleed } },
      growCap: computeGrowCap(bleed),
      gaussians: pools,
      op,
      fillId,
    });
    const base = new Ref(fx.verts, fx.mods, fx.midP, fx.dirs, false, fx.sizeX, fx.sizeY);
    const q1 = base.grow(1);
    const q2 = base.grow(0.5);
    const q3 = q1.grow(999);
    const q4 = q3.grow(997);

    gc.setState({ seed: seedU32, bleedStrength: bleed, direction: "out" });
    gc.setFill(fillId, opStart);
    gc.writePoly(polyA, fx);
    const r1 = comparePoly("grow(1)", await runStep(polyA, polyB, 1), q1);
    const r2 = comparePoly("grow(0.5)", await runStep(polyA, polyC, 0.5), q2);
    const r3 = comparePoly("grow(999)", await runStep(polyB, polyC, 999), q3);
    const r4 = comparePoly("grow(997)", await runStep(polyC, polyB, 997), q4);
    const opGpu = await gc.readOpCounter(readBuffer);
    const steps = [r1, r2, r3, r4];
    const opOk = opGpu === op.value;
    const pass = steps.every((s) => s.pass) && opOk;
    for (const s of steps) {
      globalMaxVert = Math.max(globalMaxVert, s.maxVertDev);
      globalMaxMod = Math.max(globalMaxMod, s.maxModDev);
    }
    tests.push({
      name: "chain-D-branching",
      pass,
      layers: 4,
      counts: steps.map((s) => s.countCpu),
      maxVertDev: Math.max(...steps.map((s) => s.maxVertDev)),
      maxModDev: Math.max(...steps.map((s) => s.maxModDev)),
      opCounter: { gpu: opGpu, cpu: op.value, ok: opOk },
      steps,
    });
    log(`chain-D-branching: ${pass ? "PASS" : "FAIL"}`);
  }

  // -------------------------------------------------------------------
  // Batched: case A's chain in ONE compute pass, one submit, no readback
  // until the end — the actual frame-path shape. Must equal the
  // step-by-step run bit for bit.
  // -------------------------------------------------------------------
  {
    const c = cases[0];
    const opStart = 3;
    const fx = makeFixture(c.n, 10, -20, c.R, c.bleed, c.fillId);
    const op = { value: opStart };
    const Ref = buildFillPolyRef({
      source: fillSource,
      state: { fill: { direction: c.direction, bleed_strength: c.bleed } },
      growCap: computeGrowCap(c.bleed),
      gaussians: pools,
      op,
      fillId: c.fillId,
    });
    let cpu = new Ref(fx.verts, fx.mods, fx.midP, fx.dirs, false, fx.sizeX, fx.sizeY);
    for (const f of c.chain) cpu = cpu.grow(f);

    gc.setState({ seed: seedU32, bleedStrength: c.bleed, direction: c.direction });
    gc.setFill(c.fillId, opStart);
    gc.writePoly(polyA, fx);
    gc.beginBatch();
    const encoder = gpu.device.createCommandEncoder({ label: "grow-batched" });
    const pass0 = encoder.beginComputePass();
    let src = polyA;
    let dst = polyB;
    for (const f of c.chain) {
      gc.grow(pass0, src, dst, f);
      src = dst;
      dst = dst === polyB ? polyC : polyB;
    }
    pass0.end();
    gpu.device.queue.submit([encoder.finish()]);
    const gpuP = await gc.readPoly(src, readBuffer);
    const r = comparePoly("batched-final", gpuP, cpu);
    globalMaxVert = Math.max(globalMaxVert, r.maxVertDev);
    globalMaxMod = Math.max(globalMaxMod, r.maxModDev);
    tests.push({
      name: "batched-single-pass",
      pass: r.pass,
      layers: c.chain.length,
      finalCount: r.countCpu,
      maxVertDev: r.maxVertDev,
      maxModDev: r.maxModDev,
      step: r,
    });
    log(`batched-single-pass: ${r.pass ? "PASS" : "FAIL"}`);
  }

  window.__oracleResults = {
    adapter: adapterInfo,
    tolerances: { vert: VERT_TOL, mod: MOD_TOL },
    globalMaxVertDev: globalMaxVert,
    globalMaxModDev: globalMaxMod,
    tests,
  };
  statusEl.textContent += "\ndone";
}

main().catch((err) => {
  console.error(err);
  window.__oracleResults = { error: `${err.stack ?? err}`, tests };
  statusEl.textContent = `ERROR: ${err.stack ?? err}`;
});
