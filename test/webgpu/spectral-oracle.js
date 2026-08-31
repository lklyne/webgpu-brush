// ============================================================
// W2 spectral-wgsl oracle — browser half. Driven by
// scripts/oracle-spectral.mjs.
//
// LUT capture: the REAL upstream GLSL (src/core/gl/shader.frag +
// shader.vert, fetched verbatim) rendered in a WebGL2 framebuffer with a
// uniform source color and uniform mask alpha = t. With a uniform mask
// the blur-edge derivatives are zero, so u_isBrush=false yields exactly
// spectral_mix(bg, u_color, t); u_isBrush=true with t > 0.7 exercises
// the darken branch (the full-path survivor in the WGSL port).
//
// The WGSL side renders the same cases through the actual composite
// entry in src/webgpu/wgsl/spectral.wgsl with uniforms packed by
// src/webgpu/spectral.js (the reflectance hoist under test).
//
// Gate: every pixel, every channel < 1.5/255 vs the GLSL LUT.
// Extra: CPU spectralMix cross-check, and a cheap timing of the hoist
// (precomputed entry vs a full-mix variant of the same shader).
//
// Results: window.__oracleResults = { adapter, tests, timing }
// ============================================================

import { initDevice } from "../../src/webgpu/device.js";
import { createPipelineCache, createUniformRing, uploadTexture } from "../../src/webgpu/pipeline.js";
import { readTexture } from "../../src/webgpu/readback.js";
import { packBlendUniforms, spectralMix } from "../../src/webgpu/spectral.js";
import { SPECTRAL_WGSL } from "../../src/webgpu/wgsl/spectral.wgsl.js";

const statusEl = document.getElementById("status");
const canvasesEl = document.getElementById("canvases");
const SIZE = 16;
const CENTER = (Math.floor(SIZE / 2) * SIZE + Math.floor(SIZE / 2)) * 4;

const PAIRS = [
  { name: "red-blue", bg: [1, 0, 0], color: [0, 0, 1] },
  { name: "white-black", bg: [1, 1, 1], color: [0, 0, 0] },
  { name: "desaturated", bg: [0.72, 0.55, 0.45], color: [0.42, 0.55, 0.66] },
];
const TS = [0, 0.25, 0.5, 0.75, 1];
// isBrush cases: t=0.5 stays on the precomputed path (≤ DARKEN_THRESHOLD),
// 0.85 / 1.0 take the darken branch → spectral_mix_full.
const BRUSH_TS = [0.5, 0.85, 1];

function solidPixels(rgb, alpha) {
  const px = new Uint8Array(SIZE * SIZE * 4);
  const r = Math.round(rgb[0] * 255);
  const g = Math.round(rgb[1] * 255);
  const b = Math.round(rgb[2] * 255);
  const a = Math.round(alpha * 255);
  for (let i = 0; i < SIZE * SIZE; i++) {
    px[i * 4] = r;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = b;
    px[i * 4 + 3] = a;
  }
  return px;
}

function maxChannelDiff(a, b) {
  let max = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i + c] - b[i + c]);
      if (d > max) max = d;
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// GLSL reference (upstream shader.frag, verbatim)
// ---------------------------------------------------------------------------

function makeGlslRenderer(vertSrc, fragSrc) {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true });
  if (!gl) throw new Error("webgl2 unavailable");

  const prog = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vertSrc],
    [gl.FRAGMENT_SHADER, fragSrc],
  ]) {
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
  gl.useProgram(prog);

  function makeTex(unit) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  const sourceTex = makeTex(0);
  const maskTex = makeTex(1);
  gl.uniform1i(gl.getUniformLocation(prog, "u_source"), 0);
  gl.uniform1i(gl.getUniformLocation(prog, "u_mask"), 1);

  // Raw shader output, no blending, own framebuffer (not the canvas).
  const fbTex = makeTex(2);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fbTex, 0);
  gl.viewport(0, 0, SIZE, SIZE);
  gl.disable(gl.BLEND);

  return function render({ bg, color, t, isBrush }) {
    gl.activeTexture(gl.TEXTURE0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      solidPixels(bg, 1));
    gl.activeTexture(gl.TEXTURE1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      solidPixels([1, 1, 1], t));
    gl.uniform3fv(gl.getUniformLocation(prog, "u_color"), color);
    gl.uniform1i(gl.getUniformLocation(prog, "u_isBrush"), isBrush ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_targetIsFramebuffer"), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(SIZE * SIZE * 4);
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
}

// ---------------------------------------------------------------------------
// WGSL side (the actual spectral.wgsl composite)
// ---------------------------------------------------------------------------

function makeWgslRenderer(gpu, cache, ring, wgsl, label) {
  const target = gpu.createTexture({
    label: `spectral-target-${label}`,
    size: { width: SIZE, height: SIZE },
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const view = target.createView();
  const sampler = gpu.device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
  const pipeline = cache.getRenderPipeline({
    code: wgsl,
    blend: null,
    format: "rgba8unorm",
    label: `spectral-${label}`,
  });
  const layout = pipeline.getBindGroupLayout(0);

  async function render({ bg, color, t, isBrush }) {
    const sourceTex = uploadTexture(gpu, solidPixels(bg, 1), {
      width: SIZE, height: SIZE, label: "source",
    });
    const maskTex = uploadTexture(gpu, solidPixels([1, 1, 1], t), {
      width: SIZE, height: SIZE, label: "mask",
    });
    ring.reset();
    const u = ring.write(packBlendUniforms({ color, isBrush, targetIsFramebuffer: false }));
    const bindGroup = cache.getBindGroup(layout, [
      { binding: 0, resource: { buffer: u.buffer, offset: u.offset, size: u.size } },
      { binding: 1, resource: sourceTex.createView() },
      { binding: 2, resource: maskTex.createView() },
      { binding: 3, resource: sampler },
    ]);
    const encoder = gpu.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);
    const { data } = await readTexture(gpu, target);
    sourceTex.destroy();
    maskTex.destroy();
    return data;
  }
  render.destroy = () => target.destroy();
  return render;
}

// ---------------------------------------------------------------------------
// Hoist timing (informational): precomputed entry vs full-mix variant
// ---------------------------------------------------------------------------

async function timeHoist(gpu, cache, ring, wgsl) {
  const PRECOMP_CALL = "spectral_mix_precomputed(bgColor, u.r2, u.lum2, mixIntensity)";
  if (!wgsl.includes(PRECOMP_CALL)) throw new Error("timing: precomputed call site not found");
  const fullWgsl = wgsl.replace(PRECOMP_CALL, "spectral_mix_full(bgColor, u.color.rgb, mixIntensity)");

  const W = 768;
  const target = gpu.createTexture({
    label: "timing-target",
    size: { width: W, height: W },
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const view = target.createView();
  const sampler = gpu.device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
  const sourceTex = uploadTexture(gpu, solidPixels([0.72, 0.55, 0.45], 1), { width: SIZE, height: SIZE });
  const maskTex = uploadTexture(gpu, solidPixels([1, 1, 1], 0.5), { width: SIZE, height: SIZE });

  async function run(code, label) {
    const pipeline = cache.getRenderPipeline({ code, blend: null, format: "rgba8unorm", label });
    const layout = pipeline.getBindGroupLayout(0);
    ring.reset();
    const u = ring.write(packBlendUniforms({ color: [0.42, 0.55, 0.66], isBrush: false }));
    const bindGroup = cache.getBindGroup(layout, [
      { binding: 0, resource: { buffer: u.buffer, offset: u.offset, size: u.size } },
      { binding: 1, resource: sourceTex.createView() },
      { binding: 2, resource: maskTex.createView() },
      { binding: 3, resource: sampler },
    ]);
    const PASSES = 150;
    const frame = (n) => {
      const encoder = gpu.device.createCommandEncoder();
      for (let i = 0; i < n; i++) {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
      }
      gpu.device.queue.submit([encoder.finish()]);
      return gpu.device.queue.onSubmittedWorkDone();
    };
    await frame(10); // warmup + compile
    const t0 = performance.now();
    await frame(PASSES);
    const ms = performance.now() - t0;
    return ms / PASSES;
  }

  const msFull = await run(fullWgsl, "timing-full");
  const msPre = await run(wgsl, "timing-precomputed");
  target.destroy();
  sourceTex.destroy();
  maskTex.destroy();
  return {
    resolution: `${W}x${W}`,
    passes: 150,
    msPerPassFull: Number(msFull.toFixed(4)),
    msPerPassPrecomputed: Number(msPre.toFixed(4)),
    speedup: Number((msFull / msPre).toFixed(3)),
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const results = [];
let timing = null;
try {
  if (!navigator.gpu) throw new Error("navigator.gpu missing — WebGPU disabled");
  const adapter = await navigator.gpu.requestAdapter();
  const adapterInfo = adapter?.info
    ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture }
    : null;

  const [fragSrc, vertSrc] = await Promise.all([
    fetch("../../src/core/gl/shader.frag").then((r) => r.text()),
    fetch("../../src/core/gl/shader.vert").then((r) => r.text()),
  ]);
  const wgsl = SPECTRAL_WGSL; // W3: bundled .wgsl.js is the canonical source

  const renderGlsl = makeGlslRenderer(vertSrc, fragSrc);
  const gpu = await initDevice({});
  const cache = createPipelineCache(gpu);
  const ring = createUniformRing(gpu);
  const renderWgsl = makeWgslRenderer(gpu, cache, ring, wgsl, "main");

  for (const pair of PAIRS) {
    for (const isBrush of [false, true]) {
      const ts = isBrush ? BRUSH_TS : TS;
      const rows = [];
      let worst = 0;
      for (const t of ts) {
        const cfg = { bg: pair.bg, color: pair.color, t, isBrush };
        const glPx = renderGlsl(cfg);
        const gpuPx = await renderWgsl(cfg);
        const diff = maxChannelDiff(glPx, gpuPx);
        worst = Math.max(worst, diff);
        // CPU float64 reference (informational; only exact for the
        // non-brush uniform-mask path where mixIntensity == quantized t).
        const tq = Math.round(t * 255) / 255;
        const cpu = !isBrush && tq > 0
          ? spectralMix(pair.bg, pair.color, tq).map((v) => Math.round(v * 255))
          : null;
        rows.push({
          t,
          maxDiff: diff,
          glsl: [...glPx.slice(CENTER, CENTER + 3)],
          wgsl: [...gpuPx.slice(CENTER, CENTER + 3)],
          cpu,
        });
      }
      results.push({
        name: `${pair.name}${isBrush ? "-brush" : ""}`,
        pass: worst < 1.5,
        worstDiff: worst,
        rows,
      });
    }
  }

  timing = await timeHoist(gpu, cache, ring, wgsl);
  renderWgsl.destroy();
  gpu.destroy();

  window.__oracleResults = { adapter: adapterInfo, tests: results, timing };
} catch (err) {
  window.__oracleResults = { error: String(err?.stack ?? err), tests: results, timing };
}

statusEl.textContent = window.__oracleResults.error
  ? `ERROR: ${window.__oracleResults.error}`
  : results.map((t) => `${t.pass ? "PASS" : "FAIL"} ${t.name} worst=${t.worstDiff}`).join("\n");
