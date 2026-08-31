/**
 * @fileoverview Standalone entry point for brush.
 */

export * from "./adapters/standalone/runtime.js";
export * from "./adapters/standalone/frame.js";
export { createCanvas, ready, readPixels } from "./adapters/standalone/target.js";
export * from "./index.shared.js";
export { random, noise } from "./core/utils.js";
// W3/W4b: force the retained CPU geometry path (GPU walk off).
export { _setUseCpuWalk as useCpuGeometry } from "./stroke/gl_draw.js";
// W4b: inspection and manipulation API — geometry streams, hooks between
// generate and rasterize, and out-of-band geometry capture/readback.
export {
  stream,
  onGeometry,
  beginGeometry,
  endGeometry,
  readGeometry,
  _geometryStats, // test instrumentation, not API
  _resetGeometryStats,
} from "./webgpu/inspect.js";

import { initStandaloneTargetRuntime } from "./adapters/standalone/target.js";
import { initStandaloneRendererRuntime } from "./adapters/standalone/renderer.js";
import { initStandaloneCompositorRuntime } from "./adapters/standalone/compositor.js";
import { initStandaloneStrokeRuntime } from "./adapters/standalone/stroke.js";
import { initStandaloneRuntime } from "./adapters/standalone/runtime.js";

initStandaloneTargetRuntime();
initStandaloneRuntime();
initStandaloneRendererRuntime();
initStandaloneCompositorRuntime();
initStandaloneStrokeRuntime();
