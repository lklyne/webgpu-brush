// ============================================================
// W1a oracle — browser half. Driven by scripts/oracle-w1a.mjs.
//
// Four tests (plan, "W1a — Done when"):
//   1. premultiplied — hand-fed uniform mask + known color, WebGPU canvas
//      vs upstream-configured WebGL2 canvas, both composited onto white
//      via canvas2d. Gate: < 1.5/255.
//   2. dirty-rect — scissored draw in one corner; everything outside the
//      scissor byte-unchanged, inside changed.
//   3. resize-leaks — 20 resize+render cycles: no device loss, no growth
//      in tracked buffer/texture counts, no pipeline growth.
//   4. pipeline-stability — pipeline & bind-group counts identical after
//      warmup across 60 frames of mixed-blend drawing (gotcha #8).
//
// Results: window.__oracleResults = { tests: [...], error? }
// ============================================================

import { initDevice } from "../../src/webgpu/device.js";
import {
  createPipelineCache,
  createUniformRing,
  uploadTexture,
} from "../../src/webgpu/pipeline.js";
import { readTexture } from "../../src/webgpu/readback.js";

const statusEl = document.getElementById("status");
const canvasesEl = document.getElementById("canvases");
const SIZE = 128;

// Known color + uniform mask, shared by test 1's two renderers.
const COLOR = [0.2, 0.45, 0.8, 0.7]; // straight-alpha rgba
const MASK_ALPHA = 0.6;

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

// Fullscreen triangle + uniform-color × mask-alpha composite.
// Output is PREMULTIPLIED (rgb * a), matching upstream's composite blend
// gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) (adapters/standalone/renderer.js:33).
const MASK_WGSL = /* wgsl */ `
struct U { color: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var maskTex: texture_2d<f32>;
@group(0) @binding(2) var maskSamp: sampler;

struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)); // (0,0)(2,0)(0,2)
  var out: VSOut;
  out.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(xy.x, 1.0 - xy.y);
  return out;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let a = textureSample(maskTex, maskSamp, in.uv).a * u.color.a;
  return vec4f(u.color.rgb * a, a);
}
`;

// Solid premultiplied color (test 2 / 3 / 4).
const SOLID_WGSL = /* wgsl */ `
struct U { color: vec4f };
@group(0) @binding(0) var<uniform> u: U;

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn fs() -> @location(0) vec4f {
  return vec4f(u.color.rgb * u.color.a, u.color.a);
}
`;

// Position-varying checker so every byte is position-dependent — a scissor
// leak of even one pixel shows up as a byte diff (test 2).
const CHECKER_WGSL = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let c = (floor(p.x / 8.0) + floor(p.y / 8.0)) % 2.0;
  return vec4f(c, fract(p.x / 255.0), fract(p.y / 255.0), 1.0);
}
`;

const COMPOSITE_BLEND = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
};

// Stamp-accumulate blend (gotcha #4 row 1) — exercised in test 4 so the
// cache sees more than one blend state.
const STAMP_BLEND = {
  color: { srcFactor: "one-minus-dst-alpha", dstFactor: "one" },
  alpha: { srcFactor: "one-minus-dst-alpha", dstFactor: "one" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCanvas(w, h, label) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.title = label;
  canvasesEl.appendChild(c);
  return c;
}

/** Uniform-alpha rgba8 mask, width×height. */
function uniformMask(w, h, alpha) {
  const px = new Uint8Array(w * h * 4);
  const a = Math.round(alpha * 255);
  for (let i = 0; i < w * h; i++) {
    px[i * 4 + 0] = 255;
    px[i * 4 + 1] = 255;
    px[i * 4 + 2] = 255;
    px[i * 4 + 3] = a;
  }
  return px;
}

/** Composites a (possibly WebGL/WebGPU) canvas onto white, returns pixels. */
function compositeOnWhite(srcCanvas) {
  const c = document.createElement("canvas");
  c.width = srcCanvas.width;
  c.height = srcCanvas.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(srcCanvas, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height).data;
}

function diffStats(a, b) {
  let maxDiff = 0;
  let sumSq = 0;
  let diffBytes = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 0) diffBytes++;
    if (d > maxDiff) maxDiff = d;
    sumSq += d * d;
  }
  return { maxDiff, rmse: Math.sqrt(sumSq / a.length), diffBytes };
}

// ---------------------------------------------------------------------------
// WebGL2 reference renderer (upstream context settings)
// ---------------------------------------------------------------------------

function renderWebGLReference() {
  const canvas = makeCanvas(SIZE, SIZE, "webgl reference");
  // Same context options as adapters/standalone/target.js:36.
  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error("webgl2 unavailable");

  const vsSrc = `#version 300 es
  out vec2 v_uv;
  void main() {
    vec2 xy = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(xy * 2.0 - 1.0, 0.0, 1.0);
    v_uv = vec2(xy.x, 1.0 - xy.y);
  }`;
  const fsSrc = `#version 300 es
  precision highp float;
  uniform vec4 u_color;
  uniform sampler2D u_mask;
  in vec2 v_uv;
  out vec4 outColor;
  void main() {
    float a = texture(u_mask, v_uv).a * u_color.a;
    outColor = vec4(u_color.rgb * a, a);
  }`;
  const prog = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vsSrc],
    [gl.FRAGMENT_SHADER, fsSrc],
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

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    uniformMask(SIZE, SIZE, MASK_ALPHA),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  gl.uniform4fv(gl.getUniformLocation(prog, "u_color"), COLOR);
  gl.uniform1i(gl.getUniformLocation(prog, "u_mask"), 0);

  gl.viewport(0, 0, SIZE, SIZE);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // upstream composite blend
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return canvas;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testPremultiplied(results) {
  const glCanvas = renderWebGLReference();

  const canvas = makeCanvas(SIZE, SIZE, "webgpu");
  const gpu = await initDevice({ canvas, width: SIZE, height: SIZE, density: 1 });
  const cache = createPipelineCache(gpu);
  const ring = createUniformRing(gpu);

  const mask = uploadTexture(gpu, uniformMask(SIZE, SIZE, MASK_ALPHA), {
    width: SIZE, height: SIZE, label: "mask",
  });
  const sampler = gpu.device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
  const pipeline = cache.getRenderPipeline({
    code: MASK_WGSL, blend: COMPOSITE_BLEND, label: "mask-composite",
  });
  const layout = pipeline.getBindGroupLayout(0);

  ring.reset();
  const u = ring.write(new Float32Array(COLOR));
  const bindGroup = cache.getBindGroup(layout, [
    { binding: 0, resource: { buffer: u.buffer, offset: u.offset, size: u.size } },
    { binding: 1, resource: mask.createView() },
    { binding: 2, resource: sampler },
  ]);

  const encoder = gpu.device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: gpu.context.getCurrentTexture().createView(),
      loadOp: "clear",
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
      storeOp: "store",
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  gpu.device.queue.submit([encoder.finish()]);

  // drawImage must happen in the same task, before the frame is presented
  // and the drawing buffer becomes inaccessible.
  const gpuPixels = compositeOnWhite(canvas);
  const glPixels = compositeOnWhite(glCanvas);
  const stats = diffStats(gpuPixels, glPixels);

  // Analytic expectation on white: white*(1-a) + color*a, a = mask*colorA.
  const a = MASK_ALPHA * COLOR[3];
  const expected = [0, 1, 2].map((i) =>
    Math.round((255 * (1 - a)) + COLOR[i] * a * 255),
  );
  const center = (SIZE / 2 * SIZE + SIZE / 2) * 4;
  const analyticDiff = Math.max(
    ...[0, 1, 2].map((i) => Math.abs(gpuPixels[center + i] - expected[i])),
  );

  results.push({
    name: "premultiplied",
    pass: stats.maxDiff < 1.5 && analyticDiff <= 2,
    maxDiff: stats.maxDiff,
    rmse: Number(stats.rmse.toFixed(4)),
    analyticDiff,
    expected,
    gotCenter: [...gpuPixels.slice(center, center + 3)],
  });
  gpu.destroy();
}

async function testDirtyRect(results) {
  const gpu = await initDevice({});
  const cache = createPipelineCache(gpu);
  const ring = createUniformRing(gpu);
  const W = 256;
  const target = gpu.createTexture({
    label: "dirty-rect-target",
    size: { width: W, height: W },
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const view = target.createView();

  // Pass 1: full-surface position-dependent checker.
  {
    const encoder = gpu.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }],
    });
    pass.setPipeline(cache.getRenderPipeline({ code: CHECKER_WGSL, blend: null, format: "rgba8unorm" }));
    pass.draw(3);
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);
  }
  const before = (await readTexture(gpu, target)).data;

  // Pass 2: loadOp 'load' + scissor to the 64×64 top-left corner.
  const RECT = { x: 0, y: 0, w: 64, h: 64 };
  {
    const pipeline = cache.getRenderPipeline({
      code: SOLID_WGSL, blend: COMPOSITE_BLEND, format: "rgba8unorm", label: "solid",
    });
    const layout = pipeline.getBindGroupLayout(0);
    ring.reset();
    const u = ring.write(new Float32Array([1, 0.5, 0, 1]));
    const bg = cache.getBindGroup(layout, [
      { binding: 0, resource: { buffer: u.buffer, offset: u.offset, size: u.size } },
    ]);
    const encoder = gpu.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: "load", storeOp: "store" }],
    });
    pass.setScissorRect(RECT.x, RECT.y, RECT.w, RECT.h);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3); // fullscreen triangle — scissor must clip it
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);
  }
  const after = (await readTexture(gpu, target)).data;

  let outsideChanged = 0;
  let insideChanged = 0;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const changed =
        before[i] !== after[i] || before[i + 1] !== after[i + 1] ||
        before[i + 2] !== after[i + 2] || before[i + 3] !== after[i + 3];
      if (!changed) continue;
      const inside = x >= RECT.x && x < RECT.x + RECT.w && y >= RECT.y && y < RECT.y + RECT.h;
      if (inside) insideChanged++;
      else outsideChanged++;
    }
  }
  results.push({
    name: "dirty-rect",
    pass: outsideChanged === 0 && insideChanged === RECT.w * RECT.h,
    outsideChangedPixels: outsideChanged,
    insideChangedPixels: insideChanged,
    insideExpected: RECT.w * RECT.h,
  });
  target.destroy();
  gpu.destroy();
}

async function testResizeLeaks(results) {
  const canvas = makeCanvas(300, 200, "resize");
  const gpu = await initDevice({ canvas, width: 300, height: 200, density: 1 });
  const cache = createPipelineCache(gpu);
  const ring = createUniformRing(gpu);
  const pipeline = cache.getRenderPipeline({ code: SOLID_WGSL, blend: COMPOSITE_BLEND, label: "resize-solid" });
  const layout = pipeline.getBindGroupLayout(0);

  function frame(i) {
    ring.reset();
    const u = ring.write(new Float32Array([i / 30, 0.4, 0.9, 1]));
    const bg = cache.getBindGroup(layout, [
      { binding: 0, resource: { buffer: u.buffer, offset: u.offset, size: u.size } },
    ]);
    const encoder = gpu.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: gpu.context.getCurrentTexture().createView(),
        loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store",
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);
  }

  // Warmup, then snapshot.
  frame(0);
  await gpu.device.queue.onSubmittedWorkDone();
  const snap = { ...gpu.stats, pipelines: cache.stats.pipelines };

  const sizes = [[512, 384], [64, 64], [800, 600], [333, 217], [1024, 768]];
  for (let i = 0; i < 20; i++) {
    const [w, h] = sizes[i % sizes.length];
    gpu.resize(w, h, 1 + (i % 2)); // exercise density too
    frame(i + 1);
  }
  await gpu.device.queue.onSubmittedWorkDone();

  const end = { ...gpu.stats, pipelines: cache.stats.pipelines };
  results.push({
    name: "resize-leaks",
    pass:
      !gpu.lost &&
      end.buffers === snap.buffers &&
      end.textures === snap.textures &&
      end.bufferBytes === snap.bufferBytes &&
      end.pipelines === snap.pipelines,
    deviceLost: gpu.lost,
    resizes: 20,
    buffers: { before: snap.buffers, after: end.buffers },
    textures: { before: snap.textures, after: end.textures },
    bufferBytes: { before: snap.bufferBytes, after: end.bufferBytes },
    pipelines: { before: snap.pipelines, after: end.pipelines },
  });
  gpu.destroy();
}

async function testPipelineStability(results) {
  const gpu = await initDevice({});
  const cache = createPipelineCache(gpu);
  const ring = createUniformRing(gpu);
  const W = 128;
  const target = gpu.createTexture({
    size: { width: W, height: W },
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const view = target.createView();

  // Three draw configs a frame: composite blend, stamp blend, no blend —
  // distinct pipelines, all cached. Layouts held once (caller contract).
  const configs = [
    { code: SOLID_WGSL, blend: COMPOSITE_BLEND, format: "rgba8unorm", label: "s-composite" },
    { code: SOLID_WGSL, blend: STAMP_BLEND, format: "rgba8unorm", label: "s-stamp" },
    { code: SOLID_WGSL, blend: null, format: "rgba8unorm", label: "s-replace" },
  ];
  const layouts = new Map();

  function frame(i) {
    ring.reset();
    const encoder = gpu.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }],
    });
    for (const [j, cfg] of configs.entries()) {
      const pipeline = cache.getRenderPipeline(cfg);
      if (!layouts.has(cfg)) layouts.set(cfg, pipeline.getBindGroupLayout(0));
      const u = ring.write(new Float32Array([(i % 60) / 60, j / 3, 0.5, 0.8]));
      const bg = cache.getBindGroup(layouts.get(cfg), [
        { binding: 0, resource: { buffer: u.buffer, offset: u.offset, size: u.size } },
      ]);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.draw(3);
    }
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);
  }

  const WARMUP = 5;
  const FRAMES = 60;
  let warmupStats = null;
  for (let i = 0; i < FRAMES; i++) {
    frame(i);
    if (i === WARMUP - 1) warmupStats = { ...cache.stats };
  }
  await gpu.device.queue.onSubmittedWorkDone();
  const end = { ...cache.stats };

  results.push({
    name: "pipeline-stability",
    pass:
      end.pipelines === warmupStats.pipelines &&
      end.bindGroups === warmupStats.bindGroups &&
      end.pipelines === configs.length,
    frames: FRAMES,
    warmupFrames: WARMUP,
    pipelines: { afterWarmup: warmupStats.pipelines, end: end.pipelines },
    bindGroups: { afterWarmup: warmupStats.bindGroups, end: end.bindGroups },
    pipelineHits: end.pipelineHits,
    bindGroupHits: end.bindGroupHits,
  });
  target.destroy();
  gpu.destroy();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const results = [];
try {
  if (!navigator.gpu) throw new Error("navigator.gpu missing — WebGPU disabled");
  const adapter = await navigator.gpu.requestAdapter();
  const adapterInfo = adapter?.info
    ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description }
    : null;

  await testPremultiplied(results);
  await testDirtyRect(results);
  await testResizeLeaks(results);
  await testPipelineStability(results);

  window.__oracleResults = { adapter: adapterInfo, tests: results };
} catch (err) {
  window.__oracleResults = { error: String(err?.stack ?? err), tests: results };
}

statusEl.textContent = window.__oracleResults.error
  ? `ERROR: ${window.__oracleResults.error}`
  : results.map((t) => `${t.pass ? "PASS" : "FAIL"} ${t.name}`).join("\n");
