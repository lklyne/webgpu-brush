> **FORK NOTICE — brush-gpu**
>
> This is a fork of [p5.brush](https://github.com/acamposuribe/p5.brush) by
> Alejandro Campos Uribe (MIT License, preserved in [LICENSE.md](./LICENSE.md)),
> forked at upstream commit `fc37da3da3fa07e58edf880fb2788c5529a51ebe` (v2.2.2).
> The renderer has been replaced with pure WebGPU + WGSL and GPU-resident
> geometry. Upstream p5.brush (installed from npm at the pinned version) remains
> the visual reference; see `FORK.md` for the baseline and the divergence list.
> All credit for the library's design and algorithms belongs to upstream.

# brush-gpu

brush-gpu is a natural drawing library for the browser: pencils, charcoal, markers, watercolor fills, hatch patterns, and vector fields that bend strokes. It is p5.brush's drawing API on a WebGPU renderer. Stroke geometry is generated in compute shaders, fills are rasterized on the GPU, and the painting lives in a GPU texture that other WebGPU code can sample without copies.

It does not depend on p5.js.

## Table of Contents
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Differences from upstream p5.brush](#differences-from-upstream-p5brush)
- [Reference](#reference)
- [Further reading](#further-reading)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## Requirements

A browser with WebGPU (`navigator.gpu`). Nothing else: no p5.js, no WebGL.

## Installation

### npm

```
npm install brush-gpu
```

```js
import * as brush from 'brush-gpu/standalone';
```

The package exposes one subpath, `brush-gpu/standalone`. It resolves to `dist/brush.esm.js` for `import` and `dist/brush.js` for `require`. In a pnpm workspace, add `"brush-gpu": "workspace:*"` and import the same way.

### Script tag

`dist/brush.js` is a UMD bundle that defines a global `brush`.

```html
<script src="path_to/brush.js"></script>
```

### Local ESM file

```js
import * as brush from './dist/brush.esm.js';
```

## Quick Start

```js
import * as brush from 'brush-gpu/standalone';

const W = 700, H = 410;

brush.createCanvas(W, H, { parent: document.body });
brush.scaleBrushes(3);

brush.clear('#f6f1e8');
brush.push();
brush.translate(-W / 2, -H / 2); // origin is the canvas center; work in top-left coordinates

brush.set('HB', '#2f2a26', 1.4);
brush.line(100, 120, 520, 240);

brush.fill('#d7c3a3', 120);
brush.noStroke();
brush.circle(470, 230, 70);

brush.set('rotring', '#1f4b99', 0.8);
brush.noFill();
brush.hatch(7, 35);
brush.rect(210, 250, 120, 90, 'center');

brush.pop();
brush.render(); // flush to the canvas
```

The order is always: create a canvas, set state (`set`, `fill`, `hatch`, ...), draw primitives, call `render()`. Nothing appears until `render()` runs.

You can start drawing right after `createCanvas()`. The WebGPU device comes up asynchronously; calls made before it is ready are recorded and replayed in order. `await brush.ready()` when you need to know the painting is current (before `readPixels()`, `gpu()`, or `snapshot()`).

## Differences from upstream p5.brush

The drawing API is upstream's, unchanged. What differs:

- **WebGPU renderer.** No WebGL, no p5. The canvas must support a WebGPU context.
- **`brush.ready()`** resolves when the device is up. Awaiting it is optional: stateful calls made before that are recorded and replayed in program order. One caveat, pre-ready only: a `brush.random()` value read after a `seed()` is that stream's first draw, where a synchronous run would have consumed the intervening drawing first. Once ready, `random()` continues where the synchronous sequence would.
- **`brush.readPixels()`** (async) is the supported way to capture output. `drawImage()` of a WebGPU canvas onto a 2D canvas can be blank in headless browsers.
- **`brush.cpuGeometry()` / `brush.noCpuGeometry()`** force or release the CPU geometry producers. Same image, slower. A toggle pair like `fill()`/`noFill()`.
- **`brush.gpu()`** returns `{ device, adapter, format, painting, onPaintingChanged }` for zero-copy interop with another renderer on the same device (three.js `WebGPURenderer`, for example). `createCanvas()` accepts `{ device, adapter }` to adopt an externally owned device.
- **`brush.snapshot()` / `brush.restore()` / `brush.freeSnapshot()`** copy the painting texture aside and back on the GPU. Undo for host applications.
- **Geometry inspection:** `brush.stream()`, `brush.onGeometry()`, `brush.beginGeometry()` / `brush.endGeometry()`, `brush.readGeometry()` expose and let you edit stroke stamps between generation and rasterization.
- **Hash RNG.** Internal random draws are a counter-based hash, which GPU compute can reproduce and a sequential stream cannot. The same seed gives a different, equally plausible image than upstream p5.brush. Run-to-run reproducibility per seed is preserved. `random()`, `wRand()`, and `noise()` are unchanged.
- **Standalone only.** Transforms (`brush.push/pop/translate/rotate/scale`), angle mode (`brush.angleMode`), seeding (`brush.seed/noiseSeed`), clearing (`brush.clear`), and the frame flush (`brush.render`) are all library calls. `brush.load()` takes an `HTMLCanvasElement` or `OffscreenCanvas`. There are no framebuffer targets and `brush.instance()` is a no-op.

Exports whose names start with an underscore (`_stats`, `_geometryStats`, `_resetGeometryStats`, `_fillDriverStats`) are test instrumentation, not API.

## Reference

### Table of Functions

| Section | Functions | Section | Functions |
|---|---|---|---|
| [Canvas and lifecycle](#canvas-and-lifecycle) | `brush.createCanvas()`, `brush.load()`, `brush.ready()`, `brush.render()`, `brush.clear()`, `brush.readPixels()`, `brush.scaleBrushes()` | [Fill Operations](#fill-operations) | `brush.fill()`, `brush.noFill()`, `brush.wash()`, `brush.noWash()`, `brush.fillBleed()`, `brush.fillTexture()` |
| [Transforms, angles, seeding](#transforms-angles-seeding) | `brush.push()`, `brush.pop()`, `brush.translate()`, `brush.rotate()`, `brush.scale()`, `brush.angleMode()`, `brush.seed()`, `brush.noiseSeed()`, `brush.random()`, `brush.wRand()`, `brush.noise()` | [Hatch Operations](#hatch-operations) | `brush.hatch()`, `brush.noHatch()`, `brush.hatchStyle()`, `brush.mass()`, `brush.noMass()`, `brush.hatchArray()`, `brush.massArray()` |
| [Vector Fields](#vector-fields) | `brush.field()`, `brush.noField()`, `brush.refreshField()`, `brush.listFields()`, `brush.addField()`, `brush.wiggle()` | [Primitives](#primitives) | `brush.line()`, `brush.flowLine()`, `brush.beginStroke()`, `brush.move()`, `brush.endStroke()`, `brush.spline()`, `brush.rect()`, `brush.circle()`, `brush.arc()`, `brush.beginShape()`, `brush.vertex()`, `brush.endShape()`, `brush.polygon()` |
| [Brush Management](#brush-management) | `brush.box()`, `brush.add()`, `brush.clip()`, `brush.noClip()` | [Exposed Classes](#exposed-classes) | `brush.Polygon`, `brush.Plot`, `brush.Position`, `brush.Color` |
| [Stroke Operations](#stroke-operations) | `brush.set()`, `brush.pick()`, `brush.stroke()`, `brush.noStroke()`, `brush.strokeWeight()` | [GPU interop and geometry](#gpu-interop-and-geometry) | `brush.gpu()`, `brush.cpuGeometry()`, `brush.noCpuGeometry()`, `brush.snapshot()`, `brush.restore()`, `brush.freeSnapshot()`, `brush.stream()`, `brush.onGeometry()`, `brush.beginGeometry()`, `brush.endGeometry()`, `brush.readGeometry()` |

---

<sub>[back to table](#table-of-functions)</sub>
### Canvas and lifecycle

- `brush.createCanvas(width, height, options)`
  - **Description**: Creates a `<canvas>`, sizes its backing store by `pixelDensity`, appends it to the DOM, and loads it as the draw target. Starts WebGPU device acquisition. Returns the canvas element.
  - **Parameters**:
    - `width`, `height` (Number): Logical size in CSS pixels.
    - `options` (Object): Optional.
      - `pixelDensity`: Backing resolution multiplier. Defaults to `1`. Pass `window.devicePixelRatio` for sharp output on HiDPI screens.
      - `parent`: CSS selector string or DOM element to append the canvas to. Defaults to `document.body`. Pass `null` to leave the canvas detached.
      - `id`: `id` attribute of the canvas. Defaults to `"brush-canvas"`.
      - `device`, `adapter`: Adopt an externally owned `GPUDevice` instead of requesting one. See [`brush.gpu()`](#gpu-interop-and-geometry).
  - **Usage**:
    ```javascript
    brush.createCanvas(800, 600, {
      parent: '#sketch',
      pixelDensity: window.devicePixelRatio,
    });
    ```

---

- `brush.load(target)`
  - **Description**: Loads an existing `HTMLCanvasElement` or `OffscreenCanvas` as the draw target and starts device acquisition for it. Only needed when you create the canvas yourself or want to switch targets; `createCanvas()` calls it for you. Call it again with another canvas to redirect drawing. There is no argument-less form: with no target it throws.
  - **Parameters**:
    - `target` (HTMLCanvasElement | OffscreenCanvas): The canvas to draw into.
  - **Usage**:
    ```javascript
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    document.body.appendChild(canvas);
    brush.load(canvas);

    // OffscreenCanvas, for example in a worker
    brush.load(new OffscreenCanvas(800, 600));
    ```

---

- `brush.ready()`
  - **Description**: Returns a promise that resolves when the WebGPU device is initialized, the GPU stroke walker is warm, and every call recorded before that point has been replayed. Rejects if the device request fails. Awaiting it is optional for drawing; it is required before `gpu()` and `snapshot()`, and `readPixels()` awaits it internally.
  - **Returns**: `Promise<void>`.
  - **Usage**:
    ```javascript
    brush.createCanvas(600, 600);
    brush.set('HB', '#222', 1);
    brush.line(50, 50, 550, 550); // recorded, replayed once the device is up
    brush.render();
    await brush.ready();           // painting is now current
    ```

---

- `brush.render()`
  - **Description**: Flushes pending stroke and fill compositing into the canvas. Call it at the end of every drawing pass: once per frame when animating, once after a static draw. If drawing calls are made and `render()` never runs, the library logs a warning and nothing appears.

---

- `brush.clear(color)`
  - **Description**: Clears the painting. With no argument, clears to transparent. With a color, clears to that color at full opacity. Also discards uncomposited work.
  - **Usage**:
    ```javascript
    brush.clear();               // transparent
    brush.clear('#f5f0e0');      // solid color
    brush.clear(240, 235, 220);  // RGB
    ```

---

- `brush.readPixels()`
  - **Description**: Reads the painting back as RGBA pixels. Awaits `ready()` first, so the result reflects every call made so far. Row 0 is the top of the canvas; the size is the painting's size in device pixels (logical size times `pixelDensity`). This is the supported way to capture output; `drawImage()` of a WebGPU canvas onto a 2D canvas can be blank in headless browsers.
  - **Returns**: `Promise<{ width: number, height: number, pixels: Uint8ClampedArray }>`.
  - **Usage**:
    ```javascript
    brush.render();
    const { width, height, pixels } = await brush.readPixels();
    const image = new ImageData(pixels, width, height);
    ```

---

- `brush.scaleBrushes(scale)`
  - **Description**: Adjusts the global scale of all currently registered brush parameters, including weight, scatter, and spacing, by the given factor.
  - **Parameters**:
    - `scale` (Number): The scaling factor.
  - **Important**: With the built-in brushes this is usually not optional. Without it they look far too small for most canvas sizes. For a `600x600` canvas, `brush.scaleBrushes(3)` is a good starting point; confirm visually.
  - **Note**: This affects the brushes that exist when you call it. If you only want the built-in brushes scaled, call it before adding custom brushes. If you add custom brushes later, call it again to scale them too.
  - **Usage**:
    ```javascript
    brush.scaleBrushes(3);
    ```

---

<sub>[back to table](#table-of-functions)</sub>
### Transforms, angles, seeding

The library keeps its own transform stack and state stack.

- `brush.push()` / `brush.pop()`
  - Save and restore the transform matrix together with all brush state (stroke, fill, hatch, wash, mass settings).
- `brush.translate(x, y)`
- `brush.rotate(angle)`
  - `angle` follows the current `brush.angleMode()`.
- `brush.scale(x, y)`
  - Omit `y` to scale uniformly.

**Origin**: the origin is the center of the canvas. To work in top-left coordinates, translate at the start of each frame:

```javascript
brush.push();
brush.translate(-W / 2, -H / 2);
// draw
brush.pop();
brush.render();
```

---

- `brush.angleMode(mode)`
  - **Description**: Sets how every angle argument is interpreted: `brush.DEGREES` or `brush.RADIANS`. The default is radians. Affects `brush.rotate()`, `brush.hatch()`, `brush.fillBleed()`, `brush.flowLine()`, `brush.arc()`, `brush.move()`, `brush.endStroke()`, `brush.addField()` output (unless the field declares its own mode), and `brush.Position.moveTo()`.
  - **Usage**:
    ```javascript
    brush.angleMode(brush.DEGREES);
    brush.hatch(8, 45);
    ```
- `brush.DEGREES` / `brush.RADIANS`
  - Exported string constants for `brush.angleMode()`.

---

- `brush.seed(n)`
  - **Description**: Seeds the library's random number generator. Call before drawing for reproducible output. The internal RNG is a counter-based hash, so a given seed produces the same image every run in brush-gpu but not the same image upstream p5.brush would produce.
- `brush.noiseSeed(n)`
  - **Description**: Seeds the library's noise generator.
- `brush.random(min, max)`
  - **Description**: Seeded random number. `random()` returns `[0, 1)`; `random(n)` returns `[0, n)`; `random(a, b)` returns `[a, b)`; `random(array)` returns a random element.
- `brush.wRand(weights)`
  - **Description**: Picks a key from an object of `{ key: weight }` entries with probability proportional to its weight.
- `brush.noise(x, y)`
  - **Description**: Seeded 2D simplex noise in `[-1, 1]`.

---

<sub>[back to table](#table-of-functions)</sub>
### Vector Fields

Vector fields bend strokes so they follow a flow across the canvas. If you do not use them, brush-gpu works like a normal drawing library.

#### Basic vector-field functions

---

- `brush.field(name)`
  - **Description**: Activates a named vector field. While a field is active it influences the direction of strokes for shapes drawn afterwards. Some shapes are exempt; the exceptions are documented per primitive.
  - **Parameters**:
    - `name` (String): The name of a built-in field or one created with `brush.addField()`.
  - **Default Fields**: `hand`, `curved`, `zigzag`, `waves`, `seabed`, `spiral`, and `columns`.
  - **Usage**:
    ```javascript
    brush.field("waves");
    brush.field("myCustomField");
    ```

---

- `brush.noField()`
  - **Description**: Deactivates the current vector field.
  - **Usage**:
    ```javascript
    brush.noField();
    ```

---

- `brush.wiggle(wiggle)`
  - **Description**: Activates the built-in `"hand"` field with a given wiggle intensity. A shorthand for a subtle hand-drawn wobble.
  - **Parameters**:
    - `wiggle` (Number): Intensity of the wobble, e.g. 1–10.
  - **Usage**:
    ```javascript
    brush.wiggle(3);
    ```

---

- `brush.refreshField(time)`
  - **Description**: Regenerates the current field from its time-dependent generator. Use it in an animation loop.
  - **Parameters**:
    - `time` (Number): The time input passed to the generator, typically derived from a frame count.
  - **Usage**:
    ```javascript
    function frame(t) {
      brush.refreshField(t / 10);
      // draw, then brush.render()
    }
    ```

---

- `brush.listFields()`
  - **Description**: Returns the names of all available fields, built-in and custom.
  - **Returns**: `Array<string>`.
  - **Usage**:
    ```javascript
    for (const name of brush.listFields()) console.log(name);
    ```

---

#### Advanced vector-field functions

---

- `brush.addField(name, generatorFunction, options)`
  - **Description**: Creates a custom vector field. A field is a grid of angles; each cell tells the brush which way to point. You give the field a name and a function that fills the grid. Activate it with `brush.field(name)` like any built-in field.
  - **Parameters**:
    - `name` (String): Any name, e.g. `"myField"`.
    - `generatorFunction` (Function): `(t, field) => field`. Fills every cell with an angle and returns the grid. `t` is the time value passed through `brush.refreshField(t)`.
    - `options` (Object): Optional.
      - `angleMode`: `"degrees"` (default) or `"radians"`. How the values written into `field[column][row]` are interpreted.
  - **How the grid works**: `field` is a 2D array indexed `field[column][row]`. Small angles (±10°) make subtle curves; large ones (±90° or more) make dramatic bends.
  - **Example**, a diagonal flow that rotates over time:
    ```javascript
    brush.addField("diagonal", function (t, field) {
      for (let col = 0; col < field.length; col++) {
        for (let row = 0; row < field[0].length; row++) {
          field[col][row] = 45 + t * 10;
        }
      }
      return field; // always return the grid
    });

    brush.field("diagonal");
    ```
  - **Tip**: Ignore `t` if you do not need animation.

---

<sub>[back to table](#table-of-functions)</sub>
### Brush Management

Choosing brushes, adding your own, and clipping where strokes may appear.

---

- `brush.box()`
  - **Description**: Returns the names of all available brushes, built-in and custom.
  - **Returns**: `Array<string>`.
  - **Default Brushes**: `2B`, `HB`, `2H`, `cpencil`, `pen`, `rotring`, `spray`, `marker`, `marker2`, `charcoal`, and `hatch_brush` (for clean hatching).
  - **Usage**:
    ```javascript
    console.log(brush.box());
    ```

---

- `brush.add(name, params)`
  - **Description**: Registers a new brush. Once added, use it like any built-in brush with `brush.set("myBrush", color, weight)`.
  - **Parameters**:
    - `name` (String): A name for the brush.
    - `params` (Object):
      - `type`: `"default"` (pencil-like), `"spray"` (scattered dots), `"marker"` (flat solid), `"custom"` (you draw the tip), `"image"` (an image file is the tip).
      - `weight`: Thickness in canvas units.
      - `scatter`: Sideways wobble in canvas units.
      - `sharpness`: 0 to 1. Lower is softer. `"default"` type only.
      - `grain`: Texture density. Higher is smoother. `"default"` and `"spray"` types only.
      - `opacity`: Opacity of each mark, 0 to 255. Pressure also affects it.
      - `spacing`: Gap between stamps along the stroke. `1` means no overlap; lower values are denser.
      - `pressure`: How the brush size changes along a stroke.
         - `[start, end]`, e.g. `[2, 0.5]` starts thick and ends thin.
         - `[start, middle, end]`, e.g. `[0.5, 2, 0.5]`.
         - A function `(t) => value` with `t` from 0 to 1.
         - These modes include a little per-stroke variation automatically.
         - Advanced: the built-in Gaussian profile, `{ mode: "gaussian", curve: [0.15, 0.2], min_max: [1.1, 0.9] }`. `curve` adjusts the wobble and asymmetry of the envelope; `min_max` sets the mapped pressure range.
      - `tip`: `"custom"` type only. A function that draws the tip. See **Custom tip brushes** below.
      - `image`: `"image"` type only. `{ src: "./tip.jpg" }`.
      - `rotate`: `"none"` keeps the tip fixed, `"natural"` follows the stroke direction, `"random"` spins randomly.
      - `markerTip`: `"marker"`, `"custom"`, and `"image"` types. Set `false` to disable the soft tip buildup at the start and end of each stroke. Defaults to `true`.
      - `noise`: Per-stroke opacity variation. `0` makes every stroke identical; `1` is maximum variation. Defaults to `0.3`.
  - **Usage**:
    ```javascript
    // Image brush. brush.add() returns a Promise for type "image";
    // await it so the image is loaded before you draw with it.
    await brush.add("watercolor", {
      type: "image",
      weight: 10,
      scatter: 2,
      opacity: 30,
      spacing: 1.5,
      pressure: [1, 0.5],
      image: { src: "./brush_tips/brush.jpg" },
      rotate: "random",
      markerTip: false,
    });
    brush.set("watercolor", "blue", 1);
    brush.line(100, 100, 400, 100);

    // Gaussian pressure profile
    brush.add("soft-pencil", {
      type: "default",
      weight: 0.3,
      scatter: 0.6,
      sharpness: 0.3,
      grain: 10,
      opacity: 170,
      spacing: 0.1,
      pressure: { mode: "gaussian", curve: [0.15, 0.2], min_max: [1.1, 0.9] },
      rotate: "none",
    });
    ```
    Only image brushes return a Promise. Other types need no `await`.

    **Custom tip brushes**: the `tip` function receives `_m`, a small 2D-canvas-backed drawing surface. The coordinate space is 100×100 units with the origin at the center, so draw around `(0, 0)` within roughly ±50 units. The result becomes a mask: dark fills are opaque, light or white is transparent. The color from `brush.set()` or `brush.stroke()` is applied at draw time.

    Available methods: `push()`, `pop()`, `translate(x, y)`, `scale(x, y)`, `rotate(angle)` (always radians, regardless of `brush.angleMode()`), `fill(value)`, `noFill()`, `stroke(value)`, `noStroke()`, `strokeWeight(w)`, `rect(x, y, w, h)`, `circle(x, y, d)`, `ellipse(x, y, w, h)`, `line(x1, y1, x2, y2)`, `beginShape()` / `vertex(x, y)` / `endShape(close)`, and `loadPixels()` / `updatePixels()` / `pixels`. Colors are a grayscale number (0 black, 255 white) or a CSS color string.
    ```javascript
    brush.add("diamond", {
      type: "custom",
      weight: 5,
      scatter: 0.08,
      opacity: 23,
      spacing: 0.6,
      pressure: [0.5, 1.5, 0.5],
      tip: (_m) => {
        _m.rotate(Math.PI / 4);
        _m.rect(-1.5, -1.5, 3, 3);
      },
      rotate: "natural",
      markerTip: false,
    });
    ```

---

- `brush.clip(clippingRegion)`
  - **Description**: Sets a rectangular clipping region for subsequent strokes. Strokes outside it are not rendered. Affects stroke and hatch operations, not fills. The region is in the same coordinate space as your drawing calls, with the transform captured when `brush.clip()` is called. Stays in effect until `brush.noClip()`.
  - **Parameters**:
    - `clippingRegion` (Array): `[x1, y1, x2, y2]`, two opposite corners.
  - **Usage**:
    ```javascript
    brush.clip([10, 10, 250, 200]);
    brush.line(100, 90, 300, 40); // clipped
    brush.noClip();
    brush.line(0, 0, 200, 300);   // not clipped
    ```

---

- `brush.noClip()`
  - **Description**: Removes the clipping region.

---

<sub>[back to table](#table-of-functions)</sub>
### Stroke Operations

Which brush is active, its color, and its thickness.

Colors anywhere in the API are a CSS color string (`"red"`, `"#3a2f1e"`, `"rgb(60, 47, 30)"`), RGB numbers, a grayscale number, or a `brush.Color`.

---

- `brush.set(brushName, color, weight)`
  - **Description**: Selects a brush and sets its color and weight in one call. Activates stroke mode for subsequent geometry.
  - **Parameters**:
    - `brushName` (String): The brush to use.
    - `color` (String | brush.Color): The stroke color.
    - `weight` (Number): Weight multiplier on the brush's base size.
  - **Usage**:
    ```javascript
    brush.set("HB", "#002185", 1);
    ```

---

- `brush.pick(brushName)`
  - **Description**: Changes the brush type without changing color or weight.
  - **Usage**:
    ```javascript
    brush.pick("charcoal");
    ```

---

- `brush.stroke(r, g, b)` or `brush.stroke(color)`
  - **Description**: Sets the stroke color and activates stroke mode.
  - **Usage**:
    ```javascript
    brush.stroke(105, 111, 34);
    brush.stroke("#002185");
    ```

---

- `brush.noStroke()`
  - **Description**: Disables stroke for subsequent shapes.

---

- `brush.strokeWeight(weight)`
  - **Description**: Sets the weight multiplier of the current brush.
  - **Usage**:
    ```javascript
    brush.strokeWeight(2.3);
    ```

---

<sub>[back to table](#table-of-functions)</sub>
### Fill Operations

How closed shapes are filled: watercolor-style fills, flat washes, bleed, and texture.

---

- `brush.fill(a, b, c, d)` or `brush.fill(color, opacity)`
  - **Description**: Sets the fill color and opacity and activates fill mode. Accepts RGB components plus opacity, or a color plus optional opacity.
  - **Parameters**:
    - `a` (Number | String | brush.Color): Red component, grayscale value, or color.
    - `b` (Number): Optional. Green component, or opacity when two arguments are given.
    - `c` (Number): Optional. Blue component.
    - `d` (Number): Optional. Opacity, 0 to 255.
  - **Usage**:
    ```javascript
    brush.fill(244, 15, 24, 75);
    brush.fill("#002185", 110);
    ```
  - **Performance**: group shapes by fill color and opacity so the library can reuse its internal caching.

---

- `brush.noFill()`
  - **Description**: Disables fill for subsequent shapes.

---

- `brush.wash(color, opacity)`
  - **Description**: A fast solid fill. Unlike `fill()`, no bleed or texture is simulated; the shape is filled with a flat color at the given opacity.
  - **Usage**:
    ```javascript
    brush.wash("#f7e4a0", 255);
    brush.circle(W / 2, H / 2, 180);
    brush.noWash();
    ```

---

- `brush.noWash()`
  - **Description**: Disables wash mode.

---

- `brush.fillBleed(strength, direction, angle)`
  - **Description**: Sets the edge diffusion of watercolor fills.
  - **Parameters**:
    - `strength` (Number): 0 to 1.
    - `direction` (String): Optional. `"out"` or `"in"`.
    - `angle` (Number): Optional. Wash direction in the current angle mode. Omit for a random direction.
  - **Usage**:
    ```javascript
    brush.fillBleed(0.3, "out", 0);
    ```

---

- `brush.fillTexture(textureStrength, borderIntensity, scatter)`
  - **Description**: Sets the texture and border intensity of watercolor fills.
  - **Parameters**:
    - `textureStrength` (Number): 0 to 1.
    - `borderIntensity` (Number): 0 to 1.
    - `scatter` (Boolean): Optional, default `true`. Whether to draw the sparse scattered polygon layers that add edge noise. `false` gives a cleaner gradient trim.
  - **Usage**:
    ```javascript
    brush.fillTexture(0.6, 0.4);
    brush.fillTexture(0.6, 0.4, false);
    ```

---

<sub>[back to table](#table-of-functions)</sub>
### Hatch Operations

Hatching and massing inside shapes: repeated lines or layered marks that build tone.

---

- `brush.hatch(dist, angle, options)`
  - **Description**: Activates hatching for subsequent shapes.
  - **Parameters**:
    - `dist` (Number): Distance between lines, in canvas units.
    - `angle` (Number): Line angle in the current `brush.angleMode()`.
    - `options` (Object): Optional.
      - `rand`: Randomness in line placement, 0 to 1 or `false`.
      - `continuous`: Connect the end of each line to the start of the next.
      - `gradient`: Vary the spacing to create a gradient, 0 to 1 or `false`.
      - Defaults to `{ rand: false, continuous: false, gradient: false }`.
  - **Usage**:
    ```javascript
    brush.hatch(5, 30, { rand: 0.1, continuous: true, gradient: 0.3 });
    ```

---

- `brush.noHatch()`
  - **Description**: Disables hatching.

---

- `brush.hatchStyle(brushName, color, weight)`
  - **Description**: Sets the brush, color, and weight used for hatching. If not called, hatching uses the current stroke settings.
  - **Usage**:
    ```javascript
    brush.hatchStyle("rotring", "green", 1.3);
    ```

---

- `brush.mass(brushName, color, options)`
  - **Description**: Enables massing for subsequent shapes. Massing builds layered hand-filled value from generated hatch geometry and curved gestures rather than watercolor fills. Works best with crayon or pastel-like brushes.
  - **Parameters**:
    - `brushName` (String): Brush used for the mass strokes. Always required.
    - `color` (String | brush.Color): Color of the mass.
    - `options` (Object): Optional.
      - `precision`: 0 to 1. Higher values reduce jitter.
      - `strength`: 0 to 1. How many of the three internal layers are drawn.
      - `gradient`: 0 to 1. Passed through to hatch generation for spacing variation.
      - `outline`: Boolean. If true, the first polygon is also outlined.
  - **Usage**:
    ```javascript
    brush.mass("pastel", "#4b6cb7", { precision: 0.55, strength: 0.9, gradient: 0.35, outline: true });
    brush.circle(W / 2, H / 2, 180);
    ```

---

- `brush.noMass()`
  - **Description**: Disables massing.

---

Hatching normally applies to shapes as they are drawn, like stroke and fill. You can also hatch or mass several stored polygons at once, including their intersections:

- `brush.hatchArray(polygons)`
  - **Description**: Applies the current hatch settings across a `brush.Polygon` or an array of them.
  - **Usage**:
    ```javascript
    const triangles = [];
    for (let i = 0; i < 10; i++) {
      triangles.push(new brush.Polygon([
        [brush.random(W), brush.random(H)],
        [brush.random(W), brush.random(H)],
        [brush.random(W), brush.random(H)],
      ]));
    }
    brush.hatchArray(triangles);
    ```

---

- `brush.massArray(polygons)`
  - **Description**: Applies the current `mass()` state to a `brush.Polygon` or an array of them as one combined gesture. The first polygon is the outer boundary; further polygons act as holes or inner layers via even-odd logic.
  - **Usage**:
    ```javascript
    const outer = new brush.Polygon([[50, 50], [350, 50], [350, 350], [50, 350]]);
    const inner = new brush.Polygon([[100, 100], [300, 100], [300, 300], [100, 300]]);
    brush.mass("HB", "#002185", { strength: 1 });
    brush.massArray([outer, inner]); // inner becomes a hole
    ```

---

<sub>[back to table](#table-of-functions)</sub>
### Primitives

The functions that draw lines, paths, and shapes with the current stroke, fill, and hatch settings.

#### Lines, Strokes, Splines, and Plots

These are affected only by stroke settings; fill and hatch are ignored.

---

- `brush.line(x1, y1, x2, y2)`
  - **Description**: Draws a line with the current brush. Draws nothing after `noStroke()`.
  - **Usage**:
    ```javascript
    brush.stroke("red");
    brush.line(15, 10, 200, 10);
    ```

---

- `brush.flowLine(x, y, length, dir)`
  - **Description**: Draws a line that follows the active vector field from a start point, with a length and an initial direction.
  - **Parameters**:
    - `x`, `y` (Number): Start point.
    - `length` (Number): Length of the line.
    - `dir` (Number): Direction, anticlockwise from the x-axis, in the current `brush.angleMode()`.
  - **Usage**:
    ```javascript
    brush.field("seabed");
    brush.flowLine(15, 10, 185, 0);
    ```

---

The next three functions build a stroke segment by segment, with pressure and direction at each control point. Two stroke types exist: `"curve"` (curvature interpolated between control points) and `"segments"`.

- `brush.beginStroke(type, x, y)`
  - **Description**: Starts a stroke of the given type at `(x, y)`.
  - **Usage**:
    ```javascript
    brush.beginStroke("curve", 15, 30);
    ```

- `brush.move(angle, length, pressure)`
  - **Description**: Adds a segment. `angle` is anticlockwise from the x-axis in the current angle mode; `pressure` applies at the segment start.
  - **Usage**:
    ```javascript
    brush.move(30, 150, 0.6);
    brush.move(75, 40, 1.1);
    ```

- `brush.endStroke(angle, pressure)`
  - **Description**: Sets the final angle and pressure and renders the stroke.
  - **Usage**:
    ```javascript
    brush.endStroke(-45, 0.8);
    ```

---

- `brush.spline(array_points, curvature)`
  - **Description**: Draws a curve through control points. The path connects the first and last points and is shaped by the intermediate ones; corners are rounded.
  - **Parameters**:
    - `array_points` (Array): Points as `[x, y]` or `[x, y, pressure]`.
    - `curvature` (Number): Optional, 0 to 1. `0` gives straight segments.
  - **Returns**: `brush.Plot`. Store it to `.hatch()`, `.mass()`, `.fill()`, or `.draw()` later at another position.
  - **Usage**:
    ```javascript
    brush.spline([[30, 70], [85, 20, 1.5], [130, 100], [180, 50]], 0.5);
    ```

---

#### Shapes and Polygons

These are affected by stroke, fill, and hatch settings.

---

- `brush.rect(x, y, w, h, mode)`
  - **Description**: Draws a rectangle. Rectangles are influenced by active vector fields.
  - **Parameters**:
    - `mode` (String): Optional. `"corner"` (default) puts `(x, y)` at the top-left; `"center"` centers the rectangle on `(x, y)`.
  - **Usage**:
    ```javascript
    brush.noStroke();
    brush.noHatch();
    brush.fill("#002185", 75);
    brush.rect(150, 100, 50, 35, "center");
    ```

---

- `brush.circle(x, y, radius, r)`
  - **Description**: Draws a circle. Circles follow active vector fields.
  - **Parameters**:
    - `r` (Number | Boolean): Optional hand-drawn irregularity. 0 to 1 for subtle variation; `true` for a strong one.
  - **Returns**: `[plot, offsetX, offsetY]`, the `brush.Plot` and its top-left offset. Pass them to `plot.hatch(offsetX, offsetY)`, `plot.mass(offsetX, offsetY)`, and so on to reuse the geometry.
  - **Usage**:
    ```javascript
    brush.circle(100, 150, 75, true);
    ```

---

- `brush.arc(x, y, radius, start, end)`
  - **Description**: Draws an arc as a stroke only; fill is not applied.
  - **Parameters**:
    - `start`, `end` (Number): Angles in the current `brush.angleMode()`.
  - **Returns**: `brush.Plot`, or `null` when `start` equals `end`.
  - **Usage**:
    ```javascript
    brush.arc(200, 200, 50, 0, Math.PI);
    ```

---

Custom shapes are built vertex by vertex, with optional pressure per vertex. The curvature model differs from other libraries' `beginShape`/`endShape`.

- `brush.beginShape(curvature)`
  - **Description**: Starts recording vertices. `curvature` (optional, 0 to 1) rounds the shape's edges.
- `brush.vertex(x, y, pressure)`
  - **Description**: Adds a vertex, with optional pressure.
- `brush.endShape(close)`
  - **Description**: Finishes the shape and renders it with the current stroke, fill, and hatch settings. Pass `true` to close it.
  - **Returns**: `brush.Plot`.
  - **Usage**:
    ```javascript
    brush.beginShape(0.3);
    brush.vertex(50, 100);
    brush.vertex(100, 150, 0.5);
    brush.vertex(150, 100);
    brush.endShape(true);
    ```

---

- `brush.polygon(pointsArray)`
  - **Description**: Draws a polygon from `[[x, y], ...]`. Polygons are not affected by vector fields.
  - **Returns**: `brush.Polygon`. Store it to `.hatch()`, `.mass()`, `.fill()`, or `.draw()` later, or pass it to `brush.hatchArray()` / `brush.massArray()`.
  - **Usage**:
    ```javascript
    brush.polygon([[50, 50], [350, 50], [350, 350], [50, 350]]);
    ```

---

<sub>[back to table](#table-of-functions)</sub>
### Composing Shapes

Primitives return their geometry: a `brush.Polygon` from `brush.polygon()`, a `brush.Plot` from `brush.arc()` / `brush.spline()` / `brush.endShape()`, and `[plot, x, y]` from `brush.circle()`. Store the return value to redraw or apply effects to the same geometry later.

```javascript
const frame = brush.polygon([[50, 50], [350, 50], [350, 350], [50, 350]]);

brush.hatch(8, Math.PI / 4);
frame.hatch();

brush.mass("pastel", "#4b6cb7", { strength: 0.8 });
frame.mass();
```

Prefer the main primitives for visible geometry. Use `Polygon` and `Plot` methods when the stored geometry is what you need, such as input to `hatchArray()` / `massArray()`.

---

<sub>[back to table](#table-of-functions)</sub>
### Exposed Classes

#### Class: `brush.Polygon`

- **Constructor**: `new brush.Polygon(pointsArray)`, with points as `[x, y]`.
- **Methods**:
  - `.intersect(line)`: intersects the polygon with `{ point1, point2 }`. Returns an array of `{ x, y }`.
  - `.draw(brush, color, weight)`: draws the outline with the current stroke state or the given params.
  - `.fill(color, opacity, bleed, texture, border, direction, angle)`: fills with the current fill state or the given params.
  - `.wash(color, opacity)`: washes with the current wash state or the given params.
  - `.hatch(distance, angle, options)`: hatches with the current hatch state or the given params.
  - `.mass()`: applies the current mass state.
  - `.show()`: draws stroke, fill, hatch, and mass according to the current state, as the primitives do.
- **Attributes**: `.vertices` (array of `{ x, y }`), `.sides` (array of segments).

---

#### Class: `brush.Plot`

- **Constructor**: `new brush.Plot(type)`, with `type` `"curve"` or `"segments"`.
- **Methods**:
  - `.addSegment(angle, length, pressure)`
  - `.endPlot(angle, pressure)`
  - `.rotate(angle)`
  - `.genPol(x, y)`: returns a `brush.Polygon` for the plot placed at `(x, y)`.
  - `.draw(x, y, scale)`, `.fill(x, y, scale)`, `.wash(x, y, scale)`, `.hatch(x, y, scale)`, `.mass(x, y, scale)`: render at `(x, y)` with the corresponding current state; `scale` is optional (default `1`).
  - `.show(x, y, scale)`: draws stroke, fill, hatch, and mass according to the current state, optionally scaled (default `1`).
- **Attributes**: `.segments`, `.angles`, `.pres`, `.type`, `.pol` (the polygon from the last `.genPol()`).

---

#### Class: `brush.Position`

A point that moves through the active vector field.

- **Constructor**: `new brush.Position(x, y)`.
- **Methods**:
  - `.moveTo(dir, length, stepLength)`: moves along the field. `dir` is anticlockwise from the x-axis in the current `brush.angleMode()`.
  - `.plotTo(plot, length, stepLength, scale)`: follows a `brush.Plot` through the field.
  - `.angle()`: the field angle at the current position.
  - `.reset()`: resets `.plotted` to 0. Needed between consecutive different plots.
- **Attributes**: `.x`, `.y`, `.plotted` (distance moved since the last reset).

---

#### Class: `brush.Color`

- **Constructor**: `new brush.Color(value)` from a CSS color string, or `new brush.Color(r, g, b)`, or `new brush.Color(gray)`.
- **Attributes**: `.r`, `.g`, `.b` (0 to 255), `.hex`.

Every color argument in the API accepts the same inputs, so constructing a `Color` explicitly is rarely necessary.

---

<sub>[back to table](#table-of-functions)</sub>
### GPU interop and geometry

Everything in this section is specific to brush-gpu.

- `brush.gpu()`
  - **Description**: Returns the shared-device interop handle for the active target. Synchronous; requires `await brush.ready()` and throws before it. Use it to let another renderer on the same `GPUDevice` sample the painting with zero copies: same device, same queue, so brush-gpu's submissions land before the host's in submission order.
  - **Returns**: `{ device, adapter, format, painting, onPaintingChanged }`.
    - `device` (GPUDevice), `adapter` (GPUAdapter | null).
    - `format` (GPUTextureFormat): the preferred canvas format. Colors are premultiplied; the format is not sRGB-typed.
    - `painting` (GPUTexture): a getter for the live painting texture. Row 0 is the top of the canvas. The texture is recreated on resize.
    - `onPaintingChanged(fn)`: subscribe to painting recreation; `fn` receives the new texture. Returns a dispose function.
  - **Adopting a device**: pass `{ device, adapter }` to `brush.createCanvas()` to draw on a device you own. The injected device must have limits large enough for the target. brush-gpu never destroys an injected device.
  - **Usage** (three.js):
    ```javascript
    brush.createCanvas(W, H);
    await brush.ready();
    const { device, painting, onPaintingChanged } = brush.gpu();
    const renderer = new WebGPURenderer({ device });
    let tex = new ExternalTexture(painting);
    onPaintingChanged((next) => { tex = new ExternalTexture(next); /* swap into your material */ });
    ```

---

- `brush.cpuGeometry()` / `brush.noCpuGeometry()`
  - **Description**: Force, or release, the CPU geometry producers (stroke walk and fill graph). Output is the same within float precision; the CPU path is slower. Useful for debugging or on devices where the compute path misbehaves. The default is the GPU producers.

---

- `brush.snapshot()`
  - **Description**: Copies the current painting into a pooled GPU texture and returns a handle. Pending compositing is flushed first, so the snapshot contains everything drawn up to the call. Requires `await brush.ready()`. At most 20 snapshots are live at once; taking one beyond that drops the oldest.
  - **Returns**: `{ __brushSnapshot: number, width: number, height: number }`, an opaque handle.
- `brush.restore(handle)`
  - **Description**: Copies a snapshot back into the painting and re-presents the canvas. Uncomposited work is discarded. The handle stays valid, so one handle serves both undo and redo. Throws on a freed or dropped handle, or if the canvas was resized since the snapshot.
- `brush.freeSnapshot(handle)`
  - **Description**: Returns a snapshot's texture to the pool. Returns `true` if the handle was live, `false` otherwise (no-op).
  - **Usage**:
    ```javascript
    await brush.ready();
    const before = brush.snapshot();
    brush.set('HB', '#222', 1);
    brush.line(0, 0, 200, 200);
    brush.render();
    brush.restore(before);   // undo
    brush.freeSnapshot(before);
    ```

---

Geometry inspection exposes stroke stamps, the discs and image tips that make up a stroke, between generation and rasterization. A **stream** is a label you assign to a group of strokes; hooks are scoped per stream. Stamp format, both producers: `vertices` is a `Float32Array` with 4 floats per disc stamp (x, y in device pixels after transform; radius in device pixels; alpha 0 to 1); `counts` is a `Uint32Array` of stamps per stroke; `strokeIds` is a `Uint32Array` of the library's sequential stroke ids, which is draw order. Image-tip stamps use 5 floats (x, y, halfSize, angle in radians, alpha). Fill and hatch-mass polygon geometry is not captured.

- `brush.stream(id)`
  - **Description**: Gets or sets the current stream. Every stroke drawn afterwards is tagged with it. The default stream is `"default"`. Omit `id` to read the current stream.
  - **Returns**: the current stream id as a string.
- `brush.onGeometry(streamId, fn)`
  - **Description**: Registers a hook for a stream, or removes it with `fn = null`. The hook runs once per stroke flush with `{ streamId, kind: "disc" | "image", stride, vertices, counts, strokeIds }`. Mutate `vertices` in place or return `{ vertices }` with a replacement whose length is a multiple of `stride`. Strokes of a hooked stream take the CPU producer, so that stream forfeits the GPU-walk speedup; other streams are unaffected.
  - **Returns**: a dispose function.
  - **Usage**:
    ```javascript
    const stop = brush.onGeometry("layer1", (geo) => {
      for (let i = 0; i < geo.vertices.length; i += geo.stride) geo.vertices[i] += 40; // shift x
    });
    brush.stream("layer1");
    brush.line(0, 0, 200, 200);
    brush.stream("default");
    stop();
    ```
- `brush.beginGeometry()`
  - **Description**: Opens a capture scope. Every stroke generated while it is open is recorded, from both producers. GPU batches are retained on the GPU and read only when `readGeometry()` is awaited, so capture does not slow drawing. One scope at a time.
  - **Returns**: an opaque handle.
- `brush.readGeometry(handle)`
  - **Description**: Closes the scope and reads its geometry. The one place brush-gpu reads GPU buffers back on your behalf; call it outside the frame loop.
  - **Returns**: `Promise<{ vertices, counts, strokeIds, images }>`. `images` is `{ vertices, counts, strokeIds }` for image-tip stamps when any were captured, else `null`.
- `brush.endGeometry(handle)`
  - **Description**: Abandons a capture without reading it and releases retained GPU batches. Only needed for an unread capture.
  - **Usage**:
    ```javascript
    const cap = brush.beginGeometry();
    brush.set('2B', '#000', 1);
    brush.line(0, 0, 300, 100);
    brush.render();
    const { vertices, counts, strokeIds } = await brush.readGeometry(cap);
    console.log(counts[0], 'stamps in stroke', strokeIds[0]);
    ```

---

## Further reading

- [docs/standalone.md](docs/standalone.md): setup, frame lifecycle, transforms, custom tips, and the fork-specific APIs with examples.
- [llms.txt](llms.txt): a condensed reference for code assistants.
- [FORK.md](FORK.md): the port's history, divergences from upstream, hook contracts, timings, and verification.

## License

brush-gpu is released under the MIT License, the same license as p5.brush. See [LICENSE.md](./LICENSE.md).

## Acknowledgements

- [p5.brush](https://github.com/acamposuribe/p5.brush) by Alejandro Campos Uribe is the origin of every drawing algorithm here: the brush system, watercolor fills, hatching, massing, vector fields, and the API. The library website is [p5-brush.cargo.site](https://p5-brush.cargo.site/).
- The fill operations follow the steps explained by Tyler Hobbs [here](https://tylerxhobbs.com/essays/2017/a-generative-approach-to-simulating-watercolor-paints).
- Color blending is calculated with [spectral.js](https://github.com/rvanwijnen/spectral.js) by Ronald van Wijnen.
