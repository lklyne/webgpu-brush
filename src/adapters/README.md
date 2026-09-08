# Adapters

The core modules (`src/core`, `src/stroke`, `src/fill`, `src/hatch`) never touch a GPU API directly. They call hooks that a host adapter registers at startup:

- `core/target.js` (`setTargetRuntime`): `load`, `syncDensity`, `isCanvasReady`, `instance`, `activateInstance`, `deactivateInstance`, `getActiveFramebuffer`, `isFramebufferTarget`, plus the shared target state (`Renderer`, `Cwidth`, `Cheight`, `Density`) via `setTargetState`.
- `core/runtime.js` (`setRuntime`): `usesRadians`, `fromDegrees`, `createColor`, `getAffineMatrix`, `notifyDraw`. Angle mode, colors, and the transform stack.
- `core/compositor_runtime.js` (`setCompositorRuntime`): `clearTarget`, `ensureBlendShaderProgram`, `ensureBlendSourceFramebuffer`, `createFramebuffer`, `runBlendShaderPass`, `blitSourceToFramebuffer`. The spectral composite of a stroke or fill mask onto the painting.
- `stroke/runtime.js` (`setStrokeRuntime`): `createTipSurface`, `loadImageTip`. Brush-tip rasterization for custom and image brushes.

`standalone/` is the only adapter. It implements every hook on a WebGPU host; see its [README](standalone/README.md).

The p5 adapter that upstream shipped was removed. It drove the hooks through p5's WebGL renderer, which this fork no longer has. A future host adapter (another engine, a worker, a test double) would implement the same hook set and register it the way `src/index.standalone.js` does for the standalone adapter.
