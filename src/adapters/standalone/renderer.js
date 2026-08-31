// =============================================================================
// Adapter: Standalone Renderer Hooks (WebGPU, W3)
//
// The three renderer hooks existed to bracket raw WebGL usage: bind the
// mask FBO / restore the default framebuffer / reset host shader-tracking
// state. In WebGPU every render pass carries its own complete state, so
// all three are no-ops. The hooks (and their call sites in
// stroke/gl_draw.js) are kept because they are the library-level contract:
// they describe host concerns, not GL concerns, and the p5 adapter still
// implements them meaningfully.
// =============================================================================

import { setRendererRuntime } from "../../core/renderer_runtime.js";

function beginDirectMaskDraw(_renderer, _gl, _target) {
  return null;
}

function endDirectMaskDraw(_renderer, _gl, _state) {}

function resetDirectShaderTracking(_renderer, _gl) {}

export function initStandaloneRendererRuntime() {
  setRendererRuntime({
    beginDirectMaskDraw,
    endDirectMaskDraw,
    resetDirectShaderTracking,
  });
}
