// ============================================================
// W2 stamp-pipeline oracle — browser half. Driven by
// scripts/oracle-stamps.mjs.
//
// Three tests (plan, "stamp-pipeline" — oracle tolerance < 2.0/255 RMSE;
// point-sprite vs quad AA differs, expected):
//
//   1. disc-grid  — fixed grid of disc stamps at known positions/sizes/
//      alphas: WebGPU instanced quads (src/webgpu/stamps.js) vs upstream's
//      ACTUAL WebGL point-sprite path — the verbatim shader sources
//      fetched from src/stroke/shader.{vert,frag} (unchanged from pinned
//      upstream), same projection matrix, same blend
//      (ONE_MINUS_DST_ALPHA, ONE), drawn with gl.POINTS.
//   2. image-grid — same idea for the image-tip path: verbatim
//      src/stroke/image.{vert,frag}, instanced TRIANGLE_STRIP quads, a
//      deterministic procedurally-generated asymmetric tip texture
//      (identical bytes uploaded to both APIs) at varied rotations.
//   3. brush-smoke — every built-in brush (enumerated via brush.box() on
//      the fork's dist build) plus the parity harness's custom + image
//      brushes: draw a line per brush, capture the exact stamp stream via
//      the _stats.hashNums hook (circle → 4 numbers, stampImage → 5), and
//      render that stream through the WebGPU stamp pipelines. Pass iff
//      every brush emits stamps and produces non-empty pixels. Not parity
//      — a smoke render per brush tip type.
//
// Comparison domain is the raw brush-mask RGBA (offscreen framebuffers on
// both sides — no canvas compositing, no premultiply step). GL readback
// rows are bottom-up, so they are flipped before diffing; the WebGPU side
// renders with flipY: false (upstream's exact clip-space math).
//
// Results: window.__oracleResults = { adapter, tests: [...], error? }
// ============================================================

import { initDevice } from "../../src/webgpu/device.js";
import { createPipelineCache } from "../../src/webgpu/pipeline.js";
import { readTexture } from "../../src/webgpu/readback.js";
import { createStampRenderer } from "../../src/webgpu/stamps.js";

const statusEl = document.getElementById("status");
const canvasesEl = document.getElementById("canvases");

const W = 320;
const H = 320;
const COLOR = [0.3, 0.16, 0.1, 1]; // stroke color, straight rgba like State.stroke.color._array
const RMSE_GATE = 2.0; // /255 — plan tolerance for stamp-pipeline

// ---------------------------------------------------------------------------
// Fixed stamp grids (shared verbatim by both renderers)
// ---------------------------------------------------------------------------

/** @returns {{x:number,y:number,r:number,a:number}[]} */
function discGrid() {
  // 0.1–0.5: sub-pixel radii — GL clamps point size to ≥1, the WGSL disc
  // vertex clamps halfSize to ≥0.5 to match (see stamp.wgsl.js).
  const radii = [0.1, 0.3, 1, 2.5, 4, 7, 12, 20];
  const alphas = [1, 0.7, 0.4, 0.15, 0.05];
  const stamps = [];
  for (let j = 0; j < alphas.length; j++) {
    for (let i = 0; i < radii.length; i++) {
      // Fractional centers on purpose — exercises AA placement.
      stamps.push({ x: 18.3 + i * 38, y: 26.7 + j * 52, r: radii[i], a: alphas[j] });
    }
  }
  // Overlap cluster: the one-minus-dst-alpha "under" blend is order
  // dependent; both sides draw in identical array order.
  for (let k = 0; k < 12; k++) {
    stamps.push({ x: 100 + k * 10.5, y: 288 + Math.sin(k * 0.9) * 9, r: 10, a: 0.5 });
  }
  return stamps;
}

/** @returns {{x:number,y:number,half:number,angle:number,a:number}[]} */
function imageGrid() {
  const halves = [5, 9, 14, 20, 26];
  const angles = [0, 0.35, 1.1, 2.4];
  const alphas = [1, 0.6, 0.3, 0.12];
  const stamps = [];
  for (let j = 0; j < angles.length; j++) {
    for (let i = 0; i < halves.length; i++) {
      stamps.push({
        x: 36.4 + i * 60,
        y: 41.6 + j * 68,
        half: halves[i],
        angle: angles[j] + i * 0.13,
        a: alphas[(i + j) % alphas.length],
      });
    }
  }
  // Overlapping rotated pair.
  stamps.push({ x: 150, y: 300, half: 16, angle: 0.7, a: 0.8 });
  stamps.push({ x: 162, y: 296, half: 16, angle: -1.9, a: 0.8 });
  return stamps;
}

/**
 * Deterministic 64×64 tip: white RGB, ink density in alpha (the
 * imageToWhite convention) — radial falloff with a horizontal ramp and an
 * off-center blob so rotation/uv-orientation errors show up.
 */
function makeTip() {
  const S = 64;
  const px = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - 32, y - 32) / 30;
      const base = Math.max(0, 1 - d) * (0.3 + (0.7 * x) / 63);
      const blob = 0.9 * Math.exp(-((x - 20) ** 2 + (y - 14) ** 2) / 60);
      const a = Math.min(1, base + blob);
      const i = (y * S + x) * 4;
      px[i] = 255;
      px[i + 1] = 255;
      px[i + 2] = 255;
      px[i + 3] = Math.round(a * 255);
    }
  }
  return { data: px, size: S };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showBuffer(label, data, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.title = label;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);
  canvasesEl.appendChild(c);
}

/** Flips rows (GL readPixels is bottom-up). */
function flipRows(data, w, h) {
  const out = new Uint8Array(data.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) out.set(data.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
  return out;
}

function diffStats(a, b) {
  let maxDiff = 0;
  let sumSq = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxDiff) maxDiff = d;
    sumSq += d * d;
  }
  return { maxDiff, rmse: Math.sqrt(sumSq / a.length) };
}

/** Pixels with nonzero alpha — guards against blank-vs-blank "0 RMSE". */
function coverage(data) {
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
  return n;
}

// ---------------------------------------------------------------------------
// WebGL reference — upstream's actual stamp path
// ---------------------------------------------------------------------------

/** Upstream framebufferProjMatrix (gl_draw.js isReady). */
function projMatrix(w, h) {
  return new Float32Array([2 / w, 0, 0, 0, 0, 2 / h, 0, 0, 0, 0, 1, 0, -1, -1, 0, 1]);
}

function compileProgram(gl, vsSrc, fsSrc) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vsSrc], [gl.FRAGMENT_SHADER, fsSrc]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(`glsl: ${gl.getShaderInfoLog(sh)}`);
    }
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
  }
  return prog;
}

function makeGl() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  // Same context options as adapters/standalone/target.js.
  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error("webgl2 unavailable");

  // Offscreen framebuffer: read the raw mask RGBA, no canvas compositing.
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE_MINUS_DST_ALPHA, gl.ONE); // gl_draw.js stamp blend
  return gl;
}

function readGl(gl) {
  const out = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return flipRows(out, W, H); // bottom-up → image order
}

/** Point-sprite discs through the verbatim upstream circle shaders. */
function renderGlDiscs(stamps, shaders) {
  const gl = makeGl();
  const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  const prog = compileProgram(gl, shaders.circleVert, shaders.circleFrag);
  gl.useProgram(prog);

  // Same layout as gl_draw.js circleData: x, y, radius, alpha.
  const data = new Float32Array(stamps.length * 4);
  stamps.forEach((s, i) => data.set([s.x, s.y, s.r, s.a], i * 4));
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const stride = 16;
  const aPos = gl.getAttribLocation(prog, "a_position");
  const aRad = gl.getAttribLocation(prog, "a_radius");
  const aAlp = gl.getAttribLocation(prog, "a_alpha");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(aRad);
  gl.vertexAttribPointer(aRad, 1, gl.FLOAT, false, stride, 8);
  gl.enableVertexAttribArray(aAlp);
  gl.vertexAttribPointer(aAlp, 1, gl.FLOAT, false, stride, 12);

  gl.uniform4f(gl.getUniformLocation(prog, "u_color"), ...COLOR);
  gl.uniformMatrix4fv(gl.getUniformLocation(prog, "u_matrix"), false, projMatrix(W, H));
  gl.drawArrays(gl.POINTS, 0, stamps.length);
  return { pixels: readGl(gl), pointSizeRange: [...range] };
}

/** Instanced image tips through the verbatim upstream image shaders. */
function renderGlImages(stamps, shaders, tip) {
  const gl = makeGl();
  const prog = compileProgram(gl, shaders.imageVert, shaders.imageFrag);
  gl.useProgram(prog);

  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA, tip.size, tip.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, tip.data,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
  gl.uniform4f(gl.getUniformLocation(prog, "u_color"), ...COLOR);
  gl.uniformMatrix4fv(gl.getUniformLocation(prog, "u_proj"), false, projMatrix(W, H));

  // Static corner VBO + instance VBO, exactly as gl_draw.js sets up imgVao.
  const cornerBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aCorner = gl.getAttribLocation(prog, "a_corner");
  gl.enableVertexAttribArray(aCorner);
  gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);

  const data = new Float32Array(stamps.length * 5);
  stamps.forEach((s, i) => data.set([s.x, s.y, s.half, s.angle, s.a], i * 5));
  const instBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const istride = 20;
  for (const [name, size, offset] of [
    ["a_pos", 2, 0], ["a_size", 1, 8], ["a_angle", 1, 12], ["a_alpha", 1, 16],
  ]) {
    const loc = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, istride, offset);
    gl.vertexAttribDivisor(loc, 1);
  }

  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, stamps.length);
  return { pixels: readGl(gl) };
}

// ---------------------------------------------------------------------------
// WebGPU renders
// ---------------------------------------------------------------------------

function makeTarget(gpu, w, h) {
  return gpu.createTexture({
    label: "stamp-oracle-target",
    size: { width: w, height: h },
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
}

async function renderGpuDiscs(gpu, cache, stamps) {
  const renderer = createStampRenderer(gpu, cache);
  renderer.setSize(W, H, { flipY: false }); // upstream GL orientation
  const target = makeTarget(gpu, W, H);
  for (const s of stamps) renderer.disc(s.x, s.y, s.r, s.a);
  renderer.drawDiscs(null, { view: target.createView(), loadOp: "clear", color: COLOR });
  const { data } = await readTexture(gpu, target);
  target.destroy();
  renderer.destroy();
  // flipY:false reproduces GL NDC exactly, so texture row 0 is already
  // NDC y=+1 — the same row order as the flipped GL readback. No flip.
  return data;
}

async function renderGpuImages(gpu, cache, stamps, tip) {
  const renderer = createStampRenderer(gpu, cache);
  renderer.setSize(W, H, { flipY: false });
  const target = makeTarget(gpu, W, H);
  for (const s of stamps) renderer.image(s.x, s.y, s.half, s.angle, s.a);
  renderer.drawImages(null, {
    view: target.createView(),
    loadOp: "clear",
    color: COLOR,
    src: "oracle-tip",
    source: tip.data,
    width: tip.size,
    height: tip.size,
  });
  const { data } = await readTexture(gpu, target);
  target.destroy();
  renderer.destroy();
  return data; // see renderGpuDiscs — already in the GL-flipped row order
}

// ---------------------------------------------------------------------------
// Tests 1 + 2: fixed grids vs upstream WebGL
// ---------------------------------------------------------------------------

async function fetchShaders() {
  const get = async (p) => {
    const r = await fetch(p);
    if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
    return r.text();
  };
  return {
    circleVert: await get("/src/stroke/shader.vert"),
    circleFrag: await get("/src/stroke/shader.frag"),
    imageVert: await get("/src/stroke/image.vert"),
    imageFrag: await get("/src/stroke/image.frag"),
  };
}

async function testDiscGrid(results, gpu, cache, shaders) {
  const stamps = discGrid();
  const glOut = renderGlDiscs(stamps, shaders);
  const gpuOut = await renderGpuDiscs(gpu, cache, stamps);
  showBuffer("disc-grid webgl", glOut.pixels, W, H);
  showBuffer("disc-grid webgpu", gpuOut, W, H);
  const stats = diffStats(glOut.pixels, gpuOut);
  const glCov = coverage(glOut.pixels);
  const gpuCov = coverage(gpuOut);
  results.push({
    name: "disc-grid",
    // Coverage floor: a blank-vs-blank comparison would also score RMSE 0
    // (plan: report that as a harness fault, not a pass).
    pass: stats.rmse < RMSE_GATE && glCov > 1000 && gpuCov > 1000,
    rmse: Number(stats.rmse.toFixed(4)),
    maxDiff: stats.maxDiff,
    stampCount: stamps.length,
    glCoverage: glCov,
    gpuCoverage: gpuCov,
    glPointSizeRange: glOut.pointSizeRange,
    gate: RMSE_GATE,
  });
}

async function testImageGrid(results, gpu, cache, shaders) {
  const stamps = imageGrid();
  const tip = makeTip();
  const glOut = renderGlImages(stamps, shaders, tip);
  const gpuOut = await renderGpuImages(gpu, cache, stamps, tip);
  showBuffer("image-grid webgl", glOut.pixels, W, H);
  showBuffer("image-grid webgpu", gpuOut, W, H);
  const stats = diffStats(glOut.pixels, gpuOut);
  const glCov = coverage(glOut.pixels);
  const gpuCov = coverage(gpuOut);
  results.push({
    name: "image-grid",
    pass: stats.rmse < RMSE_GATE && glCov > 1000 && gpuCov > 1000,
    rmse: Number(stats.rmse.toFixed(4)),
    maxDiff: stats.maxDiff,
    stampCount: stamps.length,
    glCoverage: glCov,
    gpuCoverage: gpuCov,
    gate: RMSE_GATE,
  });
}

// ---------------------------------------------------------------------------
// Test 3: per-brush smoke through the WebGPU pipelines
// ---------------------------------------------------------------------------

async function testBrushSmoke(results, gpu, cache) {
  const SMOKE = 220; // matches the standalone canvas below (center origin)
  const brush = await import("/dist/brush.esm.js");
  const { registerCustomBrush } = await import("../parity/tiles.js");

  const host = document.getElementById("brush-host");
  brush.createCanvas(SMOKE, SMOKE, { parent: host, pixelDensity: 1, id: "smoke" });
  await registerCustomBrush(brush); // adds parity-custom + parity-image (async tip load)
  brush.clear("#ffffff");

  // Capture the exact stamp stream via the Stats hook: gl_draw.circle
  // hashes 4 numbers (x, y, diameter, alpha), gl_draw.stampImage hashes 5
  // (x, y, size, angle, alpha). No fills run here, so nothing else with
  // those arities reaches hashNums during a stroke.
  const stats = brush._stats;
  const origHashNums = stats.hashNums;
  let sink = null;
  stats.hashNums = (...nums) => {
    if (!sink) return;
    if (nums.length === 4) sink.discs.push(nums);
    else if (nums.length === 5) sink.images.push(nums);
  };

  const tip = makeTip();
  const renderer = createStampRenderer(gpu, cache);
  renderer.setSize(SMOKE, SMOKE);
  const target = makeTarget(gpu, SMOKE, SMOKE);
  const view = target.createView();

  const brushes = [];
  try {
    for (const name of brush.box()) {
      brush.seed(`stamps-smoke:${name}`);
      brush.noiseSeed(`stamps-smoke:${name}`);
      sink = { discs: [], images: [] };
      stats.reset();
      stats.enabled = true;
      brush.set(name, "#46281a", 1);
      brush.line(-70, -50, 70, 50);
      stats.enabled = false;
      const { discs, images } = sink;
      sink = null;

      // Replay the captured stream through the WebGPU pipelines. Identity
      // transform, density 1: position space == device px; radius = d/2.
      for (const [x, y, d, a] of discs) renderer.disc(x, y, d / 2, a / 255);
      for (const [x, y, size, angle, a] of images) {
        renderer.image(x, y, size / 2, angle, a / 255);
      }
      let cleared = false;
      if (renderer.discCount > 0) {
        renderer.drawDiscs(null, { view, loadOp: "clear", color: COLOR });
        cleared = true;
      }
      if (renderer.imageCount > 0) {
        renderer.drawImages(null, {
          view,
          loadOp: cleared ? "load" : "clear",
          color: COLOR,
          src: "smoke-tip",
          source: tip.data,
          width: tip.size,
          height: tip.size,
        });
        cleared = true;
      }
      let pixels = 0;
      if (cleared) {
        const { data } = await readTexture(gpu, target);
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) pixels++;
      }
      const stampCount = discs.length + images.length;
      brushes.push({
        name,
        discStamps: discs.length,
        imageStamps: images.length,
        pixels,
        pass: stampCount > 0 && pixels >= 20,
      });
    }
  } finally {
    stats.hashNums = origHashNums;
    stats.enabled = false;
  }

  target.destroy();
  renderer.destroy();
  results.push({
    name: "brush-smoke",
    pass: brushes.length >= 12 && brushes.every((b) => b.pass),
    brushCount: brushes.length,
    brushes,
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const results = [];
try {
  if (!navigator.gpu) throw new Error("navigator.gpu missing — WebGPU disabled");
  const gpu = await initDevice({});
  const adapterInfo = gpu.adapter?.info
    ? {
        vendor: gpu.adapter.info.vendor,
        architecture: gpu.adapter.info.architecture,
        description: gpu.adapter.info.description,
      }
    : null;
  const cache = createPipelineCache(gpu);
  const shaders = await fetchShaders();

  await testDiscGrid(results, gpu, cache, shaders);
  await testImageGrid(results, gpu, cache, shaders);
  await testBrushSmoke(results, gpu, cache);

  // Pipeline hygiene while we're here (gotcha #8): the whole run needs
  // exactly two render pipelines (disc + image).
  results.push({
    name: "pipeline-count",
    pass: cache.stats.pipelines === 2,
    pipelines: cache.stats.pipelines,
    pipelineHits: cache.stats.pipelineHits,
  });

  gpu.destroy();
  window.__oracleResults = { adapter: adapterInfo, tests: results };
} catch (err) {
  window.__oracleResults = { error: String(err?.stack ?? err), tests: results };
}

statusEl.textContent = window.__oracleResults.error
  ? `ERROR: ${window.__oracleResults.error}`
  : results
      .map((t) => `${t.pass ? "PASS" : "FAIL"} ${t.name}${t.rmse !== undefined ? ` rmse=${t.rmse}` : ""}`)
      .join("\n");
