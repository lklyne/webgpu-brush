# brush-gpu — Standalone Build

brush-gpu ships one build (`dist/brush.js` / `dist/brush.esm.js`). It runs without p5.js and needs nothing beyond a WebGPU-capable browser (`navigator.gpu`).

The drawing API is upstream p5.brush's; see the [README reference](../README.md#reference) for every stroke, fill, hatch, primitive, and field function. This page covers setup, the frame lifecycle, and the APIs that exist only in brush-gpu.

---

## Table of Contents
- [Installation](#installation)
- [Setup](#setup)
- [Readiness](#readiness)
- [Frame lifecycle](#frame-lifecycle)
- [Transforms](#transforms)
- [Angle mode](#angle-mode)
- [Seeding](#seeding)
- [Reading pixels](#reading-pixels)
- [Sharing the GPU device](#sharing-the-gpu-device)
- [CPU geometry](#cpu-geometry)
- [Snapshots](#snapshots)
- [Geometry inspection](#geometry-inspection)
- [API reference](#api-reference)
- [Custom tip brushes](#custom-tip-brushes)
- [Differences from upstream p5.brush](#differences-from-upstream-p5brush)
- [Full example](#full-example)

---

## Installation

### Script tag (UMD)

`dist/brush.js` exposes a global `brush` object.

```html
<script src="path_to/brush.js"></script>
```

### ESM module via npm

```js
// After: npm install brush-gpu
import * as brush from 'brush-gpu/standalone';
```

### ESM module via local file

```js
import * as brush from './dist/brush.esm.js';
```

---

## Setup

### Using `brush.createCanvas()`

The simplest path. Creates a `<canvas>` element, attaches it to the DOM, loads it as the draw target, and starts WebGPU device acquisition. No separate `brush.load()` call needed.

```js
brush.createCanvas(width, height, options?)
```

**Options:**

| Property | Description |
|---|---|
| `pixelDensity` | Backing resolution multiplier. Defaults to `1`. Pass `window.devicePixelRatio` for sharp output on HiDPI screens. |
| `parent` | CSS selector string or DOM element to append the canvas to. Defaults to `document.body`; pass `null` to leave it detached. |
| `id` | `id` attribute for the created `<canvas>`. Defaults to `"brush-canvas"`. |
| `device`, `adapter` | Adopt an externally owned `GPUDevice` instead of requesting one. See [Sharing the GPU device](#sharing-the-gpu-device). |

```js
import * as brush from 'brush-gpu/standalone';

brush.createCanvas(800, 600, {
  parent: '#sketch-container',
  pixelDensity: window.devicePixelRatio,
});

brush.scaleBrushes(4);
brush.angleMode(brush.DEGREES);
```

### Bringing your own canvas

If you create the canvas element yourself (or use an `OffscreenCanvas`), call `brush.load(canvas)` once to register it as the draw target.

```js
const canvas = document.createElement('canvas');
canvas.width  = 800;
canvas.height = 600;
document.body.appendChild(canvas);

brush.load(canvas);
```

`brush.load()` also lets you **switch between multiple canvases** at runtime. Call it again with a different canvas whenever you want to redirect drawing. It always needs a target; there is no argument-less form.

> **WebGPU required.** Both `brush.createCanvas()` and `brush.load()` configure a `webgpu` context on the canvas. Check `navigator.gpu` before calling either.

---

## Readiness

Requesting a WebGPU device is asynchronous, while `createCanvas()` and `load()` return immediately. Between the two, every stateful call (state setters, transforms, drawing, `render()`, `clear()`) is recorded and replayed in program order once the device is up. A sketch written for upstream p5.brush therefore runs unmodified:

```js
brush.createCanvas(600, 600);
brush.set('HB', '#222', 1);
brush.line(50, 50, 550, 550);
brush.render();
// nothing awaited; the strokes appear once the device is ready
```

`brush.ready()` returns the promise for that moment. Await it when you need to know the painting is current, or before an API that needs the device:

```js
await brush.ready();
```

- `readPixels()` awaits it for you.
- `gpu()` and `snapshot()` return handles, so they cannot be deferred; they throw before ready.
- Upstream's argument and precondition errors throw at the call site, as they would synchronously: an unknown brush or field name, an invalid angle mode, drawing with no brush set, `vertex()`/`endShape()` outside `beginShape()`, `move()`/`endStroke()` outside `beginStroke()`, `spline()` with fewer than two points, `refreshField()` with no field active. Anything else that throws during a recorded call (an invalid color value, for example) surfaces at replay, inside the `ready()` promise.
- `seed()` and `noiseSeed()` take effect immediately and are also replayed at their place in the sequence. One consequence, pre-ready only: a `brush.random()` value read after a `seed()` is that stream's first draw, where a synchronous run would have consumed the intervening drawing first (circles, plots, masses, and field generation draw from the same stream, as upstream does). The replayed image and the post-ready `random()` continuation both match a synchronous run.

After the first replay, every wrapped call costs one boolean check.

---

## Frame lifecycle

brush-gpu does not flush or clear automatically. Do both yourself each frame.

### `brush.render()`

Flushes any pending stroke and fill compositing into the active canvas. Call this **at the end of each drawing pass**: once per frame if you are animating, or once after a static draw. If you draw and never call it, the library warns once in the console and nothing appears.

```js
brush.clear('#f5f0e0');
brush.push();
brush.translate(-W / 2, -H / 2);

brush.set('HB', '#333', 1);
brush.line(100, 100, 700, 500);

brush.pop();
brush.render(); // flush to canvas
```

### `brush.clear(color?)`

Clears the painting and discards uncomposited work. Without arguments, clears to transparent. With a color argument, clears to that color at full opacity.

```js
brush.clear();              // transparent
brush.clear('#f5f0e0');     // off-white background
brush.clear(240, 235, 220); // RGB
```

---

## Transforms

brush-gpu manages its own transform stack.

```js
brush.push()           // save current transform + brush state
brush.pop()            // restore
brush.translate(x, y)
brush.rotate(angle)    // angle follows current angleMode
brush.scale(x, y?)     // omit y to scale uniformly
```

`push()` and `pop()` save and restore both the transform matrix and brush state (stroke, fill, hatch settings).

### Origin

The origin is at the **center** of the canvas. To work in top-left coordinates, shift the origin at the start of each frame:

```js
brush.push();
brush.translate(-W / 2, -H / 2);

// draw everything here...

brush.pop();
brush.render();
```

---

## Angle mode

```js
brush.angleMode(brush.DEGREES);  // all angle inputs in degrees
brush.angleMode(brush.RADIANS);  // all angle inputs in radians (default)
```

The exported constants are `brush.DEGREES` and `brush.RADIANS`. The mode affects every API that accepts an angle: `brush.rotate()`, `brush.hatch()`, `brush.fillBleed()`, `brush.flowLine()`, `brush.arc()`, `brush.move()`, `brush.endStroke()`, `brush.addField()`, and `brush.Position.moveTo()`.

```js
brush.angleMode(brush.DEGREES);
brush.hatch(8, 45);            // 45°
brush.flowLine(x, y, 100, 90); // pointing down
```

For custom vector fields, pass `{ angleMode: 'radians' }` if your generator writes radians:

```js
brush.addField('myField', (t, field) => {
  for (let c = 0; c < field.length; c++)
    for (let r = 0; r < field[0].length; r++)
      field[c][r] = Math.sin(c * 0.3 + t) * Math.PI;
  return field;
}, { angleMode: 'radians' });
```

---

## Seeding

```js
brush.seed(n)        // seed the internal RNG
brush.noiseSeed(n)   // seed the internal noise generator
```

Call before drawing to get reproducible results. Both accept any number.

```js
brush.seed(42);
brush.noiseSeed(42);
```

The internal RNG is a counter-based hash rather than upstream's sequential stream, because GPU compute cannot reproduce a sequential stream. A given seed produces the same image on every run of brush-gpu, but a different image than upstream p5.brush produces for that seed. `brush.random()`, `brush.wRand()`, and `brush.noise()` are unchanged from upstream.

---

## Reading pixels

`brush.readPixels()` reads the painting back as RGBA. It awaits `ready()` internally, so the result includes every call made so far. Row 0 is the top of the canvas and the size is the painting's size in device pixels (logical size times `pixelDensity`).

```js
brush.render();
const { width, height, pixels } = await brush.readPixels();
const img = new ImageData(pixels, width, height);
```

This is the supported way to capture output. Drawing a WebGPU canvas onto a 2D canvas with `drawImage()` can produce a blank image in headless browsers.

---

## Sharing the GPU device

`brush.gpu()` returns a handle for zero-copy interop with another renderer on the same `GPUDevice`. It is synchronous and requires `await brush.ready()`.

```js
const { device, adapter, format, painting, onPaintingChanged } = brush.gpu();
```

| Field | Description |
|---|---|
| `device` | The `GPUDevice` brush-gpu draws with. |
| `adapter` | The `GPUAdapter`, or `null` for an adopted device without one. |
| `format` | The preferred canvas format. Colors are premultiplied; the format is not sRGB-typed. |
| `painting` | Getter for the live painting `GPUTexture`. Row 0 is the top of the canvas. Recreated on resize. |
| `onPaintingChanged(fn)` | Called with the new texture whenever the painting is recreated. Returns a dispose function. |

Because both sides share one device and one queue, brush-gpu's submissions land before the host's render in submission order. No fences, no copies.

With three.js:

```js
brush.createCanvas(W, H);
await brush.ready();

const { device, painting, onPaintingChanged } = brush.gpu();
const renderer = new WebGPURenderer({ device });
let tex = new ExternalTexture(painting);
onPaintingChanged((next) => {
  tex = new ExternalTexture(next); // swap into your material
});
```

To draw on a device you already own, pass it in: `brush.createCanvas(W, H, { device, adapter })`, or `brush.load(canvas, { device, adapter })` for a canvas you created yourself. The device must have limits large enough for the target. brush-gpu never destroys a device it did not create.

---

## CPU geometry

```js
brush.cpuGeometry();    // force the CPU stroke walk and fill graph
brush.noCpuGeometry();  // back to the GPU producers (default)
```

The image is the same within float precision; the CPU path is slower. A toggle pair like `fill()` / `noFill()`. Useful when debugging or on a device where the compute path misbehaves.

---

## Snapshots

GPU-side copies of the painting, for undo in host applications. p5.brush is immediate-mode, so there are no stroke objects to replay; undo is "copy the painting aside, copy it back later". All three require `await brush.ready()`.

```js
const handle = brush.snapshot();   // copy the painting into a pooled texture
brush.restore(handle);             // copy it back and re-present the canvas
brush.freeSnapshot(handle);        // return the texture to the pool; true if it was live
```

- `snapshot()` flushes pending compositing first, so the copy includes everything drawn up to the call. It returns an opaque handle `{ __brushSnapshot, width, height }`.
- `restore()` discards uncomposited work, copies the snapshot back, and presents. The handle stays valid, so one handle serves undo and redo. Throws on a freed handle or if the canvas was resized since.
- At most 20 snapshots are live; taking one beyond that drops the oldest.

```js
await brush.ready();
const before = brush.snapshot();

brush.set('HB', '#222', 1);
brush.line(0, 0, 200, 200);
brush.render();

brush.restore(before);   // undo
brush.freeSnapshot(before);
```

---

## Geometry inspection

Strokes are rasterized from stamps: discs, or rotated image tips. brush-gpu lets you read those stamps, or edit them between generation and rasterization.

**Stamp format** (both producers, normalized):

| Array | Contents |
|---|---|
| `vertices` | `Float32Array`, 4 floats per disc stamp: x, y (device pixels, after transform), radius (device pixels), alpha (0 to 1). |
| `counts` | `Uint32Array`, stamps per stroke. |
| `strokeIds` | `Uint32Array`, the library's sequential stroke id per stroke, which is draw order. |

Image-tip stamps use 5 floats (x, y, halfSize, angle in radians, alpha) and are reported separately. Fill and hatch-mass polygon geometry is not captured.

### Streams and hooks

A stream is a label you assign to a group of strokes. `brush.stream(id)` sets the current stream (default `"default"`); every stroke drawn afterwards belongs to it. Omit `id` to read the current stream.

`brush.onGeometry(streamId, fn)` registers a hook that runs once per stroke flush on that stream with `{ streamId, kind: "disc" | "image", stride, vertices, counts, strokeIds }`. Mutate `vertices` in place, or return `{ vertices }` with a replacement whose length is a multiple of `stride`. Pass `fn = null` to unregister, or call the returned dispose function.

```js
const stop = brush.onGeometry('wobble', (geo) => {
  for (let i = 0; i < geo.vertices.length; i += geo.stride) {
    geo.vertices[i + 1] += Math.sin(geo.vertices[i] * 0.05) * 6; // bend y
  }
});

brush.stream('wobble');
brush.line(0, 300, 800, 300);
brush.stream('default');
brush.render();
stop();
```

Cost: strokes on a hooked stream take the CPU producer, so that stream forfeits the GPU-walk speedup. Other streams are unaffected.

### Capture

`brush.beginGeometry()` opens a capture scope and returns a handle. Every stroke generated while it is open is recorded, from both producers. GPU batches are retained on the GPU and only read when you await `brush.readGeometry(handle)`, which closes the scope and returns `{ vertices, counts, strokeIds, images }` (`images` is `null` when no image-tip stamps were captured). `brush.endGeometry(handle)` discards an unread capture. One scope at a time.

```js
const cap = brush.beginGeometry();
brush.set('2B', '#000', 1);
brush.line(0, 0, 300, 100);
brush.circle(200, 200, 50);
brush.render();

const geo = await brush.readGeometry(cap);
console.log(geo.counts.length, 'strokes,', geo.vertices.length / 4, 'stamps');
```

`readGeometry()` is the one place brush-gpu reads GPU buffers back on your behalf. Call it outside the frame loop.

---

## API reference

Everything below is specific to brush-gpu or to running without p5. For the drawing API, see the [README reference](../README.md#reference).

### Configuration

#### `brush.createCanvas(width, height, options?)`

Creates a `<canvas>` element and loads it as the draw target. Returns the canvas element. See [Setup](#setup) for the options.

#### `brush.load(canvas)`

Loads an existing `HTMLCanvasElement` or `OffscreenCanvas` as the draw target. Only needed when you create the canvas yourself or want to switch targets.

```js
const canvas = document.createElement('canvas');
canvas.width = 800; canvas.height = 600;
brush.load(canvas);

const offscreen = new OffscreenCanvas(800, 600); // e.g. in a Web Worker
brush.load(offscreen);
```

#### `brush.ready()`

Returns a promise that resolves once the device is initialized and every recorded call has been replayed. See [Readiness](#readiness).

#### `brush.render()`

Flushes compositing. Call at the end of every drawing pass. See [Frame lifecycle](#frame-lifecycle).

#### `brush.clear(color?)`

Clears the canvas to transparent (no args) or to a solid color. See [Frame lifecycle](#frame-lifecycle).

#### `brush.readPixels()`

Returns `Promise<{ width, height, pixels: Uint8ClampedArray }>`. See [Reading pixels](#reading-pixels).

#### `brush.gpu()`

Returns `{ device, adapter, format, painting, onPaintingChanged }`. Requires `await brush.ready()`. See [Sharing the GPU device](#sharing-the-gpu-device).

#### `brush.cpuGeometry()` / `brush.noCpuGeometry()`

Force or release the CPU geometry producers. See [CPU geometry](#cpu-geometry).

#### `brush.snapshot()` / `brush.restore(handle)` / `brush.freeSnapshot(handle)`

GPU-side painting snapshots. See [Snapshots](#snapshots).

#### `brush.stream(id?)` / `brush.onGeometry(streamId, fn)` / `brush.beginGeometry()` / `brush.readGeometry(handle)` / `brush.endGeometry(handle)`

Geometry inspection. See [Geometry inspection](#geometry-inspection).

### Transforms

#### `brush.push()` / `brush.pop()`

Save and restore the current transform matrix and all brush state (stroke, fill, hatch).

#### `brush.translate(x, y)`

#### `brush.rotate(angle)`

Angle follows the current `brush.angleMode()`.

#### `brush.scale(x, y?)`

Omit `y` to scale uniformly.

### Angle mode

#### `brush.angleMode(mode)`

Set to `brush.DEGREES` or `brush.RADIANS`. Default is `brush.RADIANS`.

#### `brush.DEGREES` / `brush.RADIANS`

Exported string constants used with `brush.angleMode()`.

### Seeding and randomness

#### `brush.seed(n)`

Seed the internal RNG.

#### `brush.noiseSeed(n)`

Seed the internal noise generator.

#### `brush.random(min?, max?)`

Seeded random number. `random()` gives `[0, 1)`, `random(n)` gives `[0, n)`, `random(a, b)` gives `[a, b)`, `random(array)` picks an element.

#### `brush.wRand(weights)`

Picks a key from `{ key: weight, ... }` with probability proportional to its weight.

#### `brush.noise(x, y)`

Seeded 2D simplex noise in `[-1, 1]`.

### Colors

#### `brush.Color`

`new brush.Color('#3a2f1e')`, `new brush.Color(r, g, b)`, or `new brush.Color(gray)`. Every color argument in the API accepts the same inputs (CSS strings, RGB numbers, a grayscale number, or a `Color`), so constructing one explicitly is rarely needed.

---

## Custom tip brushes

The `tip` function of a `"custom"` brush receives a **minimal 2D-canvas-backed surface**. Its method names match the ones p5 users know, so tip functions written for upstream generally work unchanged as long as they use radians and plain color values.

### Available methods

| Method | Notes |
|---|---|
| `push()` / `pop()` | Save / restore transform and state |
| `translate(x, y)` | |
| `scale(x, y?)` | |
| `rotate(angle)` | **Always radians**, ignores `brush.angleMode()` |
| `fill(value)` | Grayscale number `0–255` or CSS color string |
| `noFill()` | |
| `stroke(value)` | Grayscale number `0–255` or CSS color string |
| `noStroke()` | |
| `strokeWeight(value)` | |
| `rect(x, y, w, h)` | |
| `circle(x, y, diameter)` | |
| `ellipse(x, y, w, h)` | |
| `line(x1, y1, x2, y2)` | |
| `beginShape()` / `vertex(x, y)` / `endShape(close?)` | |
| `loadPixels()` / `updatePixels()` / `pixels` | Raw pixel access |

### Coordinate space

The tip surface is 500×500 px internally but the user-facing coordinate space is **100×100 units with the origin at the centre** (the library applies a ×5 scale and a translate to the centre automatically). Draw within roughly ±50 units.

**Dark fills → high opacity. Light/white → transparent.** The library converts the tip to a white-tinted mask so it can be tinted with any brush color at draw time.

### Colors

Colors accept a **grayscale number** (0 = black/opaque, 255 = white/transparent) or any **CSS color string** (`'red'`, `'#3a2f1e'`, `'rgb(60, 47, 30)'`). Color objects from other libraries are not supported.

```js
brush.add('diamond', {
  type: 'custom',
  weight: 5,
  scatter: 0.08,
  opacity: 23,
  spacing: 0.6,
  pressure: [0.5, 1.5, 0.5],
  tip: (_m) => {
    _m.rotate(Math.PI / 4); // radians
    _m.rect(-1.5, -1.5, 3, 3);
  },
  rotate: 'natural',
  markerTip: false,
});
```

---

## Differences from upstream p5.brush

| | upstream p5.brush (p5 build) | brush-gpu |
|---|---|---|
| Renderer | p5's WebGL renderer | WebGPU + WGSL, GPU-resident geometry |
| Requires | p5.js 2.x | A WebGPU-capable browser |
| Canvas creation | `createCanvas(w, h, WEBGL)` | `brush.createCanvas(w, h)` |
| Loading an existing canvas | `brush.load(p5Graphics\|framebuffer)` | `brush.load(htmlCanvas\|offscreenCanvas)` |
| Device readiness | Synchronous | `brush.ready()`; awaiting it is optional (calls are recorded and replayed) |
| Compositing flush | Automatic | `brush.render()` required each frame |
| Clearing | `background()` | `brush.clear(color?)` |
| Transforms | p5's `push/pop`, `translate`, `rotate`, `scale` | `brush.push/pop`, `brush.translate`, `brush.rotate`, `brush.scale` |
| Angle mode | p5's `angleMode()` | `brush.angleMode(brush.DEGREES \| brush.RADIANS)` |
| Seeding | `randomSeed()` / `noiseSeed()` seed the library too | `brush.seed()` / `brush.noiseSeed()` |
| Same seed, same image as upstream | Yes | No: the internal RNG is a counter-based hash. Reproducible per seed within brush-gpu. |
| Capturing output | `saveCanvas()`, `drawImage()` | `await brush.readPixels()` |
| Instance mode | `brush.instance(p)` | Not applicable (`brush.instance()` is a no-op) |
| Framebuffer targets | Supported via `brush.load(framebuffer)` | Not supported |
| GPU interop | None | `brush.gpu()`, `createCanvas(..., { device, adapter })` |
| Undo | None | `brush.snapshot()` / `restore()` / `freeSnapshot()` |
| Geometry access | None | `stream()`, `onGeometry()`, `beginGeometry()` / `readGeometry()` / `endGeometry()` |
| CPU fallback | n/a | `brush.cpuGeometry()` / `brush.noCpuGeometry()` |

---

## Full example

```js
import * as brush from 'brush-gpu/standalone';

const W = 800, H = 600;

// Create and load the canvas in one call
brush.createCanvas(W, H, {
  parent: document.body,
  pixelDensity: window.devicePixelRatio,
});

brush.scaleBrushes(4);
brush.angleMode(brush.DEGREES);
brush.seed(42);

// Draw
brush.clear('#f5f0e0');
brush.push();
brush.translate(-W / 2, -H / 2);

brush.set('HB', '#1a2a3a', 1);
brush.line(80, 80, 720, 520);

brush.fill('#003c32', 110);
brush.fillBleed(0.2, 'out', 0);
brush.noStroke();
brush.circle(W / 2, H / 2, 120);

brush.hatchStyle('HB', '#1a2a3a', 0.8);
brush.hatch(6, 45, { rand: 0.05 });
brush.noFill();
brush.rect(100, 100, 200, 160, 'corner');
brush.noHatch();

brush.pop();
brush.render(); // flush to canvas

// Optional: wait for the device, then capture
await brush.ready();
const { width, height, pixels } = await brush.readPixels();
```
