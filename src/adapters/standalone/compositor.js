// =============================================================================
// Adapter: Standalone Compositor Hooks (WebGPU)
//
// The six compositor hooks, implemented on the WebGPU host:
//
//   clearTarget                — clear a framebuffer duck / fill-mask wrapper
//   ensureBlendShaderProgram   — spectral composite pipeline handle
//   ensureBlendSourceFramebuffer — persistent blend-source texture
//   createFramebuffer          — GPUTexture wrapped in upstream's duck type
//   runBlendShaderPass         — fullscreen spectral pass, scissored
//   blitSourceToFramebuffer    — copyTextureToTexture of the dirty rect only
//                                (gotcha #3: painting stays in one texture)
//
// create2DCanvas/get2DContext stay in core/compositor_runtime.js — they
// still back brush-tip rasterization (a CPU data-prep path, not rendering).
// =============================================================================

import { setCompositorRuntime } from "../../core/compositor_runtime.js";

function requireHost(renderer) {
  const host = renderer?.host;
  if (!host) {
    throw new Error("brush-gpu: renderer has no WebGPU host — was a target loaded?");
  }
  host.requireReady();
  return host;
}

function clearTarget(renderer, target, isFramebufferTarget) {
  if (!target) return;
  const host = requireHost(renderer);

  if (isFramebufferTarget(target)) {
    host.clearFramebuffer(target);
    return;
  }
  // Fill-mask wrapper (fill/composite.js) — clears through its recorder so
  // ordering with queued fill passes is preserved.
  if (typeof target.__clearFillMask === "function") {
    target.__clearFillMask();
    return;
  }
  throw new Error("brush-gpu: clearTarget received an unknown target type.");
}

/**
 * The composite runs the WGSL spectral pipeline (spectral.wgsl.js) with the
 * CPU-hoisted reflectance uniforms; the handle only marks it as prepared.
 */
function ensureBlendShaderProgram(renderer) {
  renderer.shaderProgram ??= { __webgpuSpectral: true };
  return renderer.shaderProgram;
}

function createFramebuffer(renderer, options) {
  const host = requireHost(renderer);
  return host.createFramebufferTexture(
    options.width,
    options.height,
    options.density ?? 1,
  );
}

function ensureBlendSourceFramebuffer(
  renderer,
  currentFramebuffer,
  width,
  height,
  density,
) {
  currentFramebuffer?.remove?.();
  const host = requireHost(renderer);
  return host.createFramebufferTexture(width, height, density, "blend-source");
}

function blitSourceToFramebuffer({
  renderer,
  sourceTarget,
  sourceFramebuffer,
  dirtyRect,
}) {
  const host = requireHost(renderer);
  // Standalone: sourceTarget is the renderer itself (painting texture);
  // a framebuffer duck would be a framebuffer target (p5-only today).
  const fromTexture = sourceTarget?.__brushFramebuffer
    ? sourceTarget.colorTexture
    : host.painting;
  host.copyToBlendSource(sourceFramebuffer, fromTexture, dirtyRect ?? null);
  return sourceFramebuffer;
}

function runBlendShaderPass({
  renderer,
  source,
  mask,
  color,
  isBrushMask,
  dirtyRect,
  targetIsFramebuffer,
}) {
  const host = requireHost(renderer);
  if (targetIsFramebuffer) {
    // getActiveFramebuffer() returns null in the standalone build (matches
    // upstream — see target.js); the framebuffer-target composite path is
    // p5-adapter-only and deliberately unimplemented here.
    throw new Error("brush-gpu standalone: framebuffer targets are not supported.");
  }
  const maskView = mask.view ?? mask.colorTexture?.createView();
  host.runComposite({
    source,
    maskView,
    color,
    isBrush: isBrushMask,
    rect: dirtyRect ?? null,
    targetFramebuffer: null,
  });
}

export function initStandaloneCompositorRuntime() {
  setCompositorRuntime({
    clearTarget,
    ensureBlendShaderProgram,
    ensureBlendSourceFramebuffer,
    createFramebuffer,
    runBlendShaderPass,
    blitSourceToFramebuffer,
  });
}
