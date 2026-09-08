# Standalone Adapter

The WebGPU host for brush-gpu. It implements the core's hook contracts (see [../README.md](../README.md)) and adds the lifecycle the public API needs.

- `gpu.js`: the WebGPU host. Owns the device and canvas context, the pipeline cache, the stamp renderer, the fill renderers, the spectral composite pipeline, and the persistent painting texture. Everything else in this folder reaches the GPU through `renderer.host`.
- `target.js`: target hooks (`core/target.js`). `createCanvas()`, `load()`, `ready()`, `readPixels()`, `gpu()`; creates the renderer object and starts device acquisition.
- `runtime.js`: runtime hooks (`core/runtime.js`). Angle mode, the `Color` class, and the `push`/`pop`/`translate`/`rotate`/`scale` transform stack.
- `compositor.js`: compositor hooks (`core/compositor_runtime.js`). Framebuffer ducks over `GPUTexture`, dirty-rect blit of the painting, and the scissored spectral composite pass.
- `stroke.js`: stroke-tip hooks (`stroke/runtime.js`). A canvas2d-backed tip surface for `"custom"` brushes and image loading for `"image"` brushes.
- `frame.js`: `render()` and `clear()`, plus the warning when drawing happens without a `render()`.
- `deferred.js`: the call recorder that makes `await brush.ready()` optional. Stateful public calls made before the device resolves are queued and replayed in program order.
- `snapshot.js`: `snapshot()` / `restore()` / `freeSnapshot()`, GPU-side copies of the painting for undo.

`src/index.standalone.js` wires it up: it registers the four hook sets, wraps the stateful exports with the recorder, and exports the public API.
