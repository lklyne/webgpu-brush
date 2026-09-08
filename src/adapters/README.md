# Adapters

The core modules (`src/core`, `src/stroke`, `src/fill`, `src/hatch`) never touch a GPU API directly. They call hooks that a host adapter registers at startup:

- `core/target.js` (`setTargetRuntime`): `load`, `syncDensity`, `isCanvasReady`, `instance`, `activateInstance`, `deactivateInstance`, `getActiveFramebuffer`, `isFramebufferTarget`. Still one module-global table — the standalone adapter drives one target. The target itself is per-context (`ctx.renderer`, `ctx.width`, `ctx.height`, `ctx.density`), written with `setTarget(ctx, …)`.
- `core/runtime.js` (`setRuntime(ctx, hooks)`): `usesRadians`, `fromDegrees`, `createColor`, `getAffineMatrix`, `notifyDraw`, installed as fields on a drawing context. Angle mode (`ctx.angleMode`) and the transform stack (`ctx.transform` / `ctx.transformStack`) are context state the hooks close over.
- `core/compositor_runtime.js` (`setCompositorRuntime(ctx, hooks)`): `clearTarget`, `ensureBlendShaderProgram`, `ensureBlendSourceFramebuffer`, `createFramebuffer`, `runBlendShaderPass`, `blitSourceToFramebuffer`, installed on a context as `ctx.compositor`. The spectral composite of a stroke or fill mask onto the painting.
- `stroke/runtime.js` (`setStrokeRuntime`): `createTipSurface`, `loadImageTip`. Brush-tip rasterization for custom and image brushes.

An adapter that wants every context to get its hooks registers a context initializer with `registerContextInit()` (`core/context.js`); registering also installs on `defaultContext`, which exists before any adapter is imported.

`standalone/` is the only adapter. It implements every hook on a WebGPU host; see its [README](standalone/README.md).

The p5 adapter that upstream shipped was removed. It drove the hooks through p5's WebGL renderer, which this fork no longer has. A future host adapter (another engine, a worker, a test double) would implement the same hook set and register it the way `src/index.standalone.js` does for the standalone adapter.
