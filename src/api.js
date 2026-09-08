// =============================================================================
// Module: Public surface per painting
// =============================================================================
/**
 * @fileoverview `createBrush()` — one painting, one API object.
 *
 * `buildApi(ctx)` returns the whole public surface bound to ONE drawing
 * context: the same functions, the same names and the same signatures the
 * module-level entry exports, wrapped in the same deferred-call guards and
 * the same prechecks, but reading and writing that context's state.
 *
 * The module-level API in index.standalone.js is the same construction over
 * `defaultContext` — `guard(f)` is `guardFor(defaultContext, f)` and
 * `precheck` is `createPrecheck(defaultContext)` — so the singleton path is
 * one instance among several rather than a separate mechanism. A unit test
 * asserts the two surfaces match name for name.
 *
 * What an instance does NOT carry, and why:
 *   - `_stats`, `_geometryStats`, `_resetGeometryStats`, `_fillDriverStats`
 *     — test instrumentation, module-level only.
 *   - `initStandaloneRuntime` — an adapter installer, not drawing API.
 *   - `instance` — the deprecated p5 no-op.
 * What it carries beyond the module surface: `dispose()` and `canvas`.
 *
 * Registries stay global on purpose (brush definitions, image tips, field
 * generators, STREAM, the trig tables): a brush added once is available to
 * every painting, which is what `add()`/`addField()` always meant.
 */

import { createContext, disposeContext } from "./core/context.js";
import {
  guardFor,
  guardReplayFor,
} from "./adapters/standalone/deferred.js";
import { createPrecheck } from "./adapters/standalone/precheck.js";
import * as runtime from "./adapters/standalone/runtime.js";
import * as frame from "./adapters/standalone/frame.js";
import * as target from "./adapters/standalone/target.js";
import * as snapshots from "./adapters/standalone/snapshot.js";
import * as inspect from "./webgpu/inspect.js";
import * as flow from "./core/flowfield.js";
import * as prim from "./core/primitives.js";
import * as strokes from "./stroke/stroke.js";
import * as hatching from "./hatch/hatch.js";
import * as masses from "./hatch/mass.js";
import * as fills from "./fill/fill.js";
import * as washes from "./fill/wash.js";
import { load as coreLoad, _load } from "./core/color.js";
import { Polygon } from "./core/polygon.js";
import { Plot } from "./core/plot.js";
import { Position } from "./core/flowfield.js";
import { _setUseCpuWalk, flushWalkBatch } from "./stroke/gl_draw.js";

/**
 * Types an instance entry as the module-level function it mirrors.
 *
 * Every public function in this library has a `_name(ctx, ...sameArgs)`
 * sibling, so the instance entry is one closure over `ctx` — but a closure's
 * inferred type is `(...args: any[]) => any`, which would erase the whole
 * declared surface. `ref` is used for its TYPE only; it is never called.
 *
 * @template {Function} F
 * @param {F} ref the module-level public function this entry mirrors
 * @param {Function} impl the context-bound implementation
 * @returns {F}
 */
function like(ref, impl) {
  return /** @type {F} */ (/** @type {unknown} */ (impl));
}

/**
 * Builds the public surface of ONE painting.
 *
 * The return type is INFERRED from the object literal below, on purpose: it
 * is what `types/api.d.ts` publishes as the instance shape, and an explicit
 * `@returns {object}` would erase every method from it.
 *
 * @param {import("./core/context.js").BrushContext} ctx
 */
export function buildApi(ctx) {
  const pre = createPrecheck(ctx);
  /**
   * This painting's deferred-call wrapper. Typed like `guardFor` so the
   * inferred instance shape keeps every wrapped function's real signature.
   *
   * @template {Function} F
   * @param {F} fn
   * @param {(...args: unknown[]) => void} [validate]
   * @returns {F}
   */
  const guard = (fn, validate) => guardFor(ctx, fn, validate);
  const rng = ctx.rng;

  // Class factories. Subclasses rather than wrappers, so `new api.Polygon(p)
  // instanceof Polygon` stays true for consumers that type-check against the
  // module's class; all they add is the owner every prototype patch reads.
  class OwnedPolygon extends Polygon {
    /**
     * @param {Array} pointsArray
     * @param {boolean} [useRawVertices=false]
     */
    constructor(pointsArray, useRawVertices = false) {
      super(pointsArray, useRawVertices);
      this.owner = ctx;
    }
  }
  class OwnedPlot extends Plot {
    /** @param {string} type */
    constructor(type) {
      super(type);
      this.owner = ctx;
    }
  }
  class OwnedPosition extends Position {
    /**
     * @param {number} x
     * @param {number} y
     */
    constructor(x, y) {
      super(x, y, ctx);
    }
  }

  const api = {
    // -----------------------------------------------------------------------
    // Immediate: pure data, lifecycle, inspection.
    // -----------------------------------------------------------------------
    DEGREES: runtime.DEGREES,
    RADIANS: runtime.RADIANS,
    Color: runtime.Color,
    getAngleMode: like(runtime.getAngleMode, () => runtime._getAngleMode(ctx)),

    createCanvas: like(target.createCanvas, (w, h, options) =>
      target._createCanvas(ctx, w, h, options),
    ),
    load: like(coreLoad, (buffer, options) => _load(ctx, buffer, options)),
    ready: like(target.ready, () => target._ready(ctx)),
    readPixels: like(target.readPixels, () => target._readPixels(ctx)),
    gpu: like(target.gpu, () => target._gpu(ctx)),

    // This painting's randomness — `seed()` below resets this stream alone.
    random: rng.random,
    noise: rng.noise,
    wRand: rng.weightedRand,

    // Global registries, reachable from any painting (see the file header).
    add: strokes.add,
    box: strokes.box,
    addField: flow.addField,
    listFields: flow.listFields,

    clip: like(strokes.clip, (region) => strokes._clip(ctx, region)),
    hatchArray: like(hatching.createHatch, (polygons) =>
      hatching._createHatch(ctx, polygons),
    ),
    massArray: like(masses.createMassArray, (polygons) =>
      masses._createMassArray(ctx, polygons),
    ),

    // Cast to the base class: `new api.Polygon(pts) instanceof Polygon` is
    // true, and consumers keep the declared class type.
    Polygon: /** @type {typeof Polygon} */ (OwnedPolygon),
    Plot: /** @type {typeof Plot} */ (OwnedPlot),
    Position: /** @type {typeof Position} */ (OwnedPosition),

    // Geometry inspection and manipulation.
    stream: like(inspect.stream, (id) => inspect._stream(ctx, id)),
    onGeometry: like(inspect.onGeometry, (streamId, fn) =>
      inspect._onGeometry(ctx, streamId, fn),
    ),
    beginGeometry: like(inspect.beginGeometry, () => inspect._beginGeometry(ctx)),
    endGeometry: like(inspect.endGeometry, (handle) =>
      inspect._endGeometry(ctx, handle),
    ),
    readGeometry: like(inspect.readGeometry, (handle) =>
      inspect._readGeometry(ctx, handle),
    ),

    // Painting snapshots. Handles are bound to the painting that took them.
    snapshot: like(snapshots.snapshot, () => snapshots._snapshot(ctx)),
    restore: like(snapshots.restore, (handle) => snapshots._restore(ctx, handle)),
    freeSnapshot: like(snapshots.freeSnapshot, (handle) =>
      snapshots._freeSnapshot(ctx, handle),
    ),

    // -----------------------------------------------------------------------
    // Seeds: immediate AND replayed in place (see index.standalone.js).
    // -----------------------------------------------------------------------
    seed: guardReplayFor(ctx, rng.seed, rng.seed),
    noiseSeed: guardReplayFor(ctx, rng.noiseSeed, rng.noiseSeed),

    // -----------------------------------------------------------------------
    // Deferred: state and drawing.
    // -----------------------------------------------------------------------
    angleMode: guard(
      like(runtime.angleMode, (mode) => runtime._angleMode(ctx, mode)),
      pre.angleMode,
    ),
    push: guard(like(runtime.push, () => runtime._push(ctx)), pre.push),
    pop: guard(like(runtime.pop, () => runtime._pop(ctx)), pre.pop),
    translate: guard(
      like(runtime.translate, (x, y) => runtime._translate(ctx, x, y)),
    ),
    rotate: guard(like(runtime.rotate, (angle) => runtime._rotate(ctx, angle))),
    scale: guard(like(runtime.scale, (x, y) => runtime._scale(ctx, x, y))),

    render: guard(like(frame.render, () => frame._render(ctx))),
    clear: guard(like(frame.clear, (...a) => frame._clear(ctx, ...a))),

    field: guard(like(flow.field, (a) => flow._field(ctx, a)), pre.field),
    noField: guard(like(flow.noField, () => flow._noField(ctx)), pre.noField),
    refreshField: guard(
      like(flow.refreshField, (t) => flow._refreshField(ctx, t)),
      pre.refreshField,
    ),
    wiggle: guard(like(flow.wiggle, (a) => flow._wiggle(ctx, a)), pre.wiggle),

    rect: guard(
      like(prim.rect, (x, y, w, h, mode) => prim._rect(ctx, x, y, w, h, mode)),
    ),
    circle: guard(
      like(prim.circle, (x, y, radius, r) => prim._circle(ctx, x, y, radius, r)),
    ),
    arc: guard(
      like(prim.arc, (x, y, radius, start, end) =>
        prim._arc(ctx, x, y, radius, start, end),
      ),
    ),
    beginShape: guard(
      like(prim.beginShape, (curvature) => prim._beginShape(ctx, curvature)),
      pre.beginShape,
    ),
    vertex: guard(
      like(prim.vertex, (x, y, pressure) => prim._vertex(ctx, x, y, pressure)),
      pre.vertex,
    ),
    endShape: guard(
      like(prim.endShape, (close) => prim._endShape(ctx, close)),
      pre.endShape,
    ),
    beginStroke: guard(
      like(prim.beginStroke, (type, x, y) => prim._beginStroke(ctx, type, x, y)),
      pre.beginStroke,
    ),
    move: guard(
      like(prim.move, (angle, length, pressure) =>
        prim._move(ctx, angle, length, pressure),
      ),
      pre.move,
    ),
    endStroke: guard(
      like(prim.endStroke, (angle, pressure) =>
        prim._endStroke(ctx, angle, pressure),
      ),
      pre.endStroke,
    ),
    spline: guard(
      like(prim.spline, (points, curvature) =>
        prim._spline(ctx, points, curvature),
      ),
      pre.spline,
    ),
    polygon: guard(
      like(prim.polygon, (pointsArray) => prim._polygon(ctx, pointsArray)),
    ),

    scaleBrushes: guard(
      like(strokes.scaleBrushes, (factor) => strokes._scaleBrushes(ctx, factor)),
    ),
    pick: guard(
      like(strokes.pick, (name) => strokes._pick(ctx, name)),
      pre.pick,
    ),
    stroke: guard(
      like(strokes.stroke, (...a) => strokes._stroke(ctx, ...a)),
      pre.stroke,
    ),
    strokeWeight: guard(
      like(strokes.strokeWeight, (weight) => strokes._strokeWeight(ctx, weight)),
    ),
    set: guard(
      like(strokes.set, (name, color, weight) =>
        strokes._set(ctx, name, color, weight),
      ),
      pre.set,
    ),
    noStroke: guard(
      like(strokes.noStroke, () => strokes._noStroke(ctx)),
      pre.noStroke,
    ),
    noClip: guard(strokes.noClip),
    line: guard(
      like(strokes.line, (x1, y1, x2, y2) => strokes._line(ctx, x1, y1, x2, y2)),
      pre.line,
    ),
    flowLine: guard(
      like(strokes.flowLine, (x, y, length, dir) =>
        strokes._flowLine(ctx, x, y, length, dir),
      ),
      pre.flowLine,
    ),

    hatch: guard(
      like(hatching.hatch, (dist, angle, options) =>
        hatching._hatch(ctx, dist, angle, options),
      ),
    ),
    hatchStyle: guard(
      like(hatching.hatchStyle, (brush, color, weight) =>
        hatching._hatchStyle(ctx, brush, color, weight),
      ),
    ),
    noHatch: guard(like(hatching.noHatch, () => hatching._noHatch(ctx))),
    mass: guard(
      like(masses.mass, (brush, color, options) =>
        masses._mass(ctx, brush, color, options),
      ),
    ),
    noMass: guard(like(masses.noMass, () => masses._noMass(ctx))),

    fill: guard(like(fills.fill, (...a) => fills._fill(ctx, ...a))),
    noFill: guard(like(fills.noFill, () => fills._noFill(ctx))),
    fillTexture: guard(
      like(fills.fillTexture, (texture, border, scatter) =>
        fills._fillTexture(ctx, texture, border, scatter),
      ),
    ),
    fillBleed: guard(
      like(fills.fillBleed, (i, direction, angle) =>
        fills._fillBleed(ctx, i, direction, angle),
      ),
    ),
    wash: guard(like(washes.wash, (...a) => washes._wash(ctx, ...a))),
    noWash: guard(like(washes.noWash, () => washes._noWash(ctx))),

    cpuGeometry: guard(() => _setUseCpuWalk(true, ctx)),
    noCpuGeometry: guard(() => _setUseCpuWalk(false, ctx)),

    // -----------------------------------------------------------------------
    // Instance-only.
    // -----------------------------------------------------------------------
    /**
     * This painting's canvas, or null before createCanvas()/load().
     * @returns {HTMLCanvasElement|OffscreenCanvas|null}
     */
    get canvas() {
      return ctx.target.canvas;
    },

    /**
     * Releases this painting. See `disposeInstance()` for exactly what is
     * freed; afterwards every method on this object throws.
     */
    dispose() {
      disposeInstance(api, ctx);
    },
  };

  return api;
}

/**
 * Frees one painting's resources and makes its API object inert.
 *
 * Freed: any open geometry capture (its retained GPU batches), every live and
 * pooled snapshot texture, the recorded-but-unreplayed call queue, the
 * pending stroke super-batch, and the GPU host — painting texture, fill mask,
 * stamp/fill/grow renderers, the canvas configuration and, ONLY IF THIS
 * PAINTING REQUESTED IT, the device (`GpuContext.external`: an injected
 * device is the injector's to destroy).
 *
 * Not freed: the per-DEVICE stroke walker and raster pipeline
 * (stroke/gl_draw.js) — another painting on the same device is still using
 * them — and the global registries.
 *
 * The context is dropped from the live-context registry, so a later
 * `brush.add()` no longer walks into it.
 *
 * @param {object} api
 * @param {import("./core/context.js").BrushContext} ctx
 */
function disposeInstance(api, ctx) {
  if (ctx.disposed) return;

  const capture = ctx.inspect?.capture;
  if (capture) inspect._endGeometry(ctx, capture);

  const host = ctx.target?.renderer?.host;
  if (host?.isReady?.()) {
    // Drop descriptors queued for a walk that will never run.
    try {
      flushWalkBatch(ctx);
    } catch {
      // A painting disposed mid-error should still release its textures.
    }
    snapshots._freeAllSnapshots(ctx);
  }
  ctx.batch.pending.length = 0;
  ctx.batch.groups.length = 0;
  ctx.batch.openGroup = null;
  ctx.batch.host = null;
  ctx.batch.isLoaded = false;

  if (ctx.recorder) {
    ctx.recorder.deferring = false;
    ctx.recorder.queue.length = 0;
  }

  host?.destroy();
  ctx.target.renderer = null;
  ctx.target.canvas = null;
  ctx.target.isLoaded = false;
  ctx.target.ready = null;
  ctx.renderer = undefined;

  disposeContext(ctx);

  const dead = (name) => () => {
    throw new Error(
      `brush-gpu: ${name}() was called on a disposed painting. ` +
        "createBrush() a new one — dispose() is final.",
    );
  };
  for (const key of Object.keys(api)) {
    if (typeof api[key] === "function") api[key] = dead(key);
  }
  api.dispose = () => {};
}

/**
 * Creates an independent painting and returns its API.
 *
 * Synchronous, like the module-level `createCanvas()`: the deferred-call
 * recorder makes drawing before the device resolves legal, so
 *
 * ```js
 * const a = createBrush({ width: 800, height: 600 });
 * a.set("HB", "#000", 1);
 * a.line(-100, 0, 100, 0);
 * a.render();
 * const { pixels } = await a.readPixels();   // resolves after the replay
 * ```
 *
 * works with no `await` before the draw. `await a.ready()` resolves once the
 * device and the GPU stroke walker are up and the recorded calls have run.
 *
 * With no `width`/`height`/`canvas` the instance has no target yet; call
 * `api.createCanvas(w, h)` or `api.load(canvas)` when one exists.
 *
 * @param {object} [options]
 * @param {number} [options.width] logical painting width — with `height`,
 *   creates the canvas immediately.
 * @param {number} [options.height] logical painting height.
 * @param {number} [options.pixelDensity=1]
 * @param {string|Element|null} [options.parent] where to append the canvas
 *   (`document.body` by default, `null` to keep it out of the DOM).
 * @param {string} [options.id] canvas element id.
 * @param {HTMLCanvasElement|OffscreenCanvas} [options.canvas] draw into an
 *   existing canvas instead of creating one (`width`/`height` are ignored;
 *   the canvas's own size is used, as `load()` does).
 * @param {GPUDevice} [options.device] adopt an externally owned device
 *   instead of requesting one — pass `other.gpu().device` to put two
 *   paintings on one device.
 * @param {GPUAdapter|null} [options.adapter] the adapter that device came
 *   from, when the caller has it.
 * @returns {ReturnType<typeof buildApi>}
 */
export function createBrush(options = {}) {
  const ctx = createContext();
  const api = buildApi(ctx);
  const { width, height, canvas, device, adapter, ...canvasOptions } = options;

  if (canvas) {
    api.load(canvas, { device, adapter });
  } else if (width !== undefined && height !== undefined) {
    api.createCanvas(width, height, { ...canvasOptions, device, adapter });
  }
  return api;
}
