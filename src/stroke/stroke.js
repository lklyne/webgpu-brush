// =============================================================================
// Module: Brush
// =============================================================================
/**
 * The Brush module provides a comprehensive set of functions and classes for
 * simulating various drawing tools ranging from pens, markers, pencils, to
 * custom image-based brushes. This module controls brush properties such as
 * weight, color, vibration, and spacing, and manages the drawing process through
 * stateful methods that enable features like pressure sensitivity, clipping, and
 * blending. By supporting multiple brush types and dynamic parameter adjustments,
 * the Brush module facilitates the creation of realistic and expressive stroke effects.
 */

// Core imports
import { isCanvasReady } from "../core/target.js";
import { defaultContext, registerContextInit } from "../core/context.js";
import {
  map,
  dist,
  calcAngle,
  toDegrees,
  cos,
  sin,
  STREAM,
} from "../core/utils.js";
import { Stats } from "../core/stats.js";
import { Position, isFieldReady } from "../core/flowfield.js";
import { Polygon } from "../core/polygon.js";
import { Plot } from "../core/plot.js";
import { createTipSurface, loadImageTip } from "./runtime.js";

// Internal module imports
import { initStrokeComposite } from "./composite.js";
import {
  isReady,
  glDraw,
  glDrawImages,
  circle,
  stampImage,
  invalidateTexEntry,
  snapshotMatrix,
  walkEligible,
  queueWalkStroke,
} from "./gl_draw.js";
// Inspection seam (guarded by ctx.inspect.active — no-op when unused)
import { _notifyStrokeBegin } from "../webgpu/inspect.js";

initStrokeComposite(); // Register the stroke composite system for offscreen mask rendering and compositing.

// ---------------------------------------------------------------------------
// Brush State and Helpers
// ---------------------------------------------------------------------------

/**
 * A context's stroke state.
 * @returns {object} The `ctx.state.stroke` slice.
 */
export function createStrokeState() {
  return {
    color: null,
    weight: 1,
    type: "HB",
    isActive: false,
    opacity: 1,
  };
}

/**
 * The in-flight stroke: where the walk currently is, and the per-stroke
 * parameters saveState() latches for the tip functions. One per context, so
 * two paintings can be mid-stroke at once.
 *
 * @returns {object} The `ctx.strokeCursor` object.
 */
function createStrokeCursor() {
  return {
    /** @type {Position|undefined} walking position */
    position: undefined,
    /** stroke length in sketch units */
    length: undefined,
    /** @type {Plot|false|undefined} plot being followed, or false */
    plot: undefined,
    /** stroke direction in internal degrees */
    dir: undefined,
    /** plot angle cached for the current step */
    cachedPlotAngle: 0,
    /** per-stroke parameters latched by saveState() */
    current: {},
  };
}

// Fixed-size gaussian pool, hash-picked per stamp.
const GAUSS_POOL_N = 512;

/**
 * The stroke randomness scope: the per-stroke id the stamp salts are built
 * from, and the fixed-size gaussian pool the stamps hash-pick out of. Both
 * are keyed to the seed, so they live on the context's rng and `seed()`
 * resets them — this context's, and no other's.
 *
 * @returns {object} The `ctx.rng.scopes.stroke` object.
 */
function createStrokeScope() {
  return {
    /**
     * Per-stroke scope counter for the hash streams. The stamp salt reserves
     * the low 2 bits for the draw phase: 0 = main stamp loop, 1 = markerTip
     * at stroke start, 2 = markerTip at stroke end.
     */
    id: 0,
    /** @type {number[]} hash-picked gaussian pool */
    pool: new Array(GAUSS_POOL_N),
    /** filled lazily at the first stroke after a reseed */
    poolReady: false,
  };
}

registerContextInit((ctx) => {
  ctx.state.stroke = createStrokeState();
  ctx.strokeCursor = createStrokeCursor();
  const scope = createStrokeScope();
  ctx.rng.scopes.stroke = scope;
  ctx.rng.onSeed(() => {
    scope.poolReady = false;
    scope.id = 0;
  });
});

let list = new Map();

const DEFAULT_CUSTOM_PRESSURE_VARIATION = {
  offset: 0.08,
  scale: 0.08,
  warp: 0.06,
  tilt: 0.06,
};

/**
 * Retrieves a shallow copy of the current stroke state.
 * @param {import("../core/context.js").BrushContext} ctx
 * @returns {object} The stroke state.
 */
export function BrushState(ctx) {
  return { ...ctx.state.stroke };
}

/**
 * Updates the stroke state.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {object} state - The new stroke state.
 */
export function BrushSetState(ctx, state) {
  ctx.state.stroke = { ...state };
}

// =============================================================================
// Section: Brush Manager
// =============================================================================

/**
 * Adds a new brush with the specified parameters to the brush list.
 * @param {string} name - The unique name for the new brush.
 * @param {object} params - The parameters defining the brush behavior and appearance.
 */
/**
 * Normalizes the pressure parameter to the internal { type, min_max, curve } format.
 * Accepts:
 *   [start, end]         — linear ramp between two pressure values
 *   [start, mid, end]    — piecewise linear (e.g. [1.5, 0.5, 1.5] for U-curve)
 *   (t) => value         — custom function, t ∈ [0,1], return value ∈ [0,1]
 *   { mode: "gaussian", curve, min_max } — advanced built-in pressure profile
 *   { curve, min_max }   — legacy gaussian format, preserved for compatibility
 */
export function normalizePressure(p) {
  if (!p) return p;
  if (typeof p === "function")
    return {
      type: "custom",
      min_max: [0, 1],
      curve: p,
      variation: { ...DEFAULT_CUSTOM_PRESSURE_VARIATION },
    };
  if (typeof p === "object" && !Array.isArray(p)) {
    if (p.type === "custom" || p.mode === "custom") {
      const { mode, ...rest } = p;
      return {
        ...rest,
        type: "custom",
        variation: {
          ...DEFAULT_CUSTOM_PRESSURE_VARIATION,
          ...(rest.variation ?? {}),
        },
      };
    }
    if (
      p.type === "gaussian" ||
      p.mode === "gaussian" ||
      (Array.isArray(p.curve) && Array.isArray(p.min_max))
    ) {
      return {
        ...p,
        type: "gaussian",
        curve: p.curve,
        min_max: p.min_max,
      };
    }
    return p;
  }
  if (Array.isArray(p)) {
    const [s, m, e] = p.length === 2 ? [p[0], (p[0] + p[1]) / 2, p[1]] : p;
    const min = Math.min(s, m, e),
      max = Math.max(s, m, e);
    const range = max - min || 1;
    const [ns, nm, ne] = [
      (s - min) / range,
      (m - min) / range,
      (e - min) / range,
    ];
    return {
      type: "custom",
      min_max: [min, max],
      variation: { ...DEFAULT_CUSTOM_PRESSURE_VARIATION },
      // Raw control points ride along so the GPU walk's descriptor
      // builder can evaluate array pressures without calling into JS.
      // Function-curve customs (no points) stay on the CPU walk.
      points: [s, m, e],
      curve: (t) =>
        t < 0.5 ? ns + (nm - ns) * t * 2 : nm + (ne - nm) * (t - 0.5) * 2,
    };
  }
}

export function add(name, params) {
  const validTypes = ["marker", "custom", "image", "spray"];
  params.type = validTypes.includes(params.type) ? params.type : "default";
  if (params.markerTip === undefined) params.markerTip = true;
  if (params.noise === undefined) params.noise = 0.3;
  params.noise = Math.max(0, Math.min(1, params.noise));
  // Accept legacy param names for backward compatibility
  if (params.vibration !== undefined && params.scatter === undefined)
    params.scatter = params.vibration;
  if (params.definition !== undefined && params.sharpness === undefined)
    params.sharpness = params.definition;
  if (params.quality !== undefined && params.grain === undefined)
    params.grain = params.quality;
  params.pressure = normalizePressure(params.pressure);
  if (params.type === "custom") {
    if (typeof params.tip !== "function") {
      throw new Error(`Brush "${name}" is type "custom" but is missing a tip function.`);
    }
    // Rasterise the tip once into a 500×500 P2D buffer.
    // Users draw in a 100×100 coordinate space (origin at centre);
    // dark fills/strokes → high opacity, light/white → transparent.
    const key = `custom::${name}`;
    // Discard a stale GPU texture if the tip changed. Brush definitions are
    // a global registry, so this reaches the default painting's tip cache.
    invalidateTexEntry(defaultContext, key);
    const g = createTipSurface(500, 500);
    g.pixelDensity(1);
    g.background(255);
    g.noSmooth();
    g.push();
    g.translate(250, 250); // centre origin
    g.scale(5); // 100 user units → 500 px
    g.noStroke();
    params.tip(g);
    g.pop();
    T.imageToWhite(g); // dark → high alpha, RGB → white for tint
    T.tips.set(key, g);
    params.tipKey = key;
    list.set(name, { param: params, colors: [], buffers: [] });
    return;
  }
  if (params.type === "image") {
    if (!params.image || !params.image.src) {
      throw new Error(
        `Brush "${name}" is type "image" but is missing params.image.src. Example: image: { src: "./tip.jpg" }`,
      );
    }
    T.add(params.image.src);
    list.set(name, { param: params, colors: [], buffers: [] });
    return T.load(); // returns a Promise; only loads images not yet loaded
  }
  list.set(name, { param: params, colors: [], buffers: [] });
}

/**
 * Retrieves the list of available brush names.
 * @returns {Array<string>} Array of brush names.
 */
export function box() {
  return [...list.keys()];
}

export function getBrushParams(brushName) {
  return list.get(brushName)?.param ?? null;
}

/**
 * Scales standard brush parameters by the provided factor.
 * @param {number} scaleFactor - The scaling factor to apply.
 */
export function scaleBrushes(scaleFactor) {
  for (const { param } of list.values()) {
    if (param) {
      param.weight *= scaleFactor;
      param.scatter *= scaleFactor;
      param.spacing *= scaleFactor;
    }
  }
}

/**
 * Sets the current brush type by name.
 * @param {string} brushName - The name of the brush.
 */
export function pick(brushName) {
  return _pick(defaultContext, brushName);
}

/**
 * Context-taking implementation of pick().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {string} brushName - The name of the brush.
 */
export function _pick(ctx, brushName) {
  assertBrush(brushName);
  ctx.state.stroke.type = brushName;
}

/**
 * Throws if no brush is registered under `brushName`.
 * @param {string} brushName - The name of the brush.
 */
export function assertBrush(brushName) {
  if (!list.has(brushName)) {
    throw new Error(
      `Brush "${brushName}" not found. Available brushes: ${[...list.keys()].join(", ")}.`,
    );
  }
}

/**
 * Sets the stroke style (color) for the current brush.
 * @param {number|string|Color} r - Red component, CSS color string, or Color object.
 * @param {number} [g] - Green component.
 * @param {number} [b] - Blue component.
 */
export function stroke(r, g, b) {
  return _stroke(defaultContext, ...arguments);
}

/**
 * Context-taking implementation of stroke().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {...*} args - Color arguments, forwarded verbatim to the host.
 */
export function _stroke(ctx, ...args) {
  isCanvasReady();
  const state = ctx.state.stroke;
  state.color = ctx.createColor(...args);
  state.isActive = true;
}

/**
 * Sets the brush weight (thickness).
 * @param {number} weight - The weight value.
 */
export function strokeWeight(weight) {
  return _strokeWeight(defaultContext, weight);
}

/**
 * Context-taking implementation of strokeWeight().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} weight - The weight value.
 */
export function _strokeWeight(ctx, weight) {
  ctx.state.stroke.weight = weight;
}

/**
 * Sets the current brush with name, color, and weight.
 * @param {string} brushName - The brush name.
 * @param {string|Color} color - The brush color.
 * @param {number} [weight=1] - The brush weight.
 */
export function set(brushName, color, weight = 1) {
  return _set(defaultContext, brushName, color, weight);
}

/**
 * Context-taking implementation of set().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {string} brushName - The brush name.
 * @param {string|Color} color - The brush color.
 * @param {number} [weight=1] - The brush weight.
 */
export function _set(ctx, brushName, color, weight = 1) {
  _pick(ctx, brushName);
  _stroke(ctx, color);
  _strokeWeight(ctx, weight);
}

/**
 * Disables the stroke effect.
 */
export function noStroke() {
  return _noStroke(defaultContext);
}

/**
 * Context-taking implementation of noStroke().
 * @param {import("../core/context.js").BrushContext} ctx
 */
export function _noStroke(ctx) {
  ctx.state.stroke.isActive = false;
}

/**
 * Defines a clipping region for strokes.
 * The region uses the same coordinate space as brush drawing commands,
 * with the current runtime transform captured at call time.
 * @param {number[]} region - Array as [x1, y1, x2, y2] defining the clipping region.
 */
export function clip(region) {
  isCanvasReady();
  return region;
}

/**
 * Disables the clipping region.
 */
export function noClip() {
  return;
}

// ---------------------------------------------------------------------------
// Drawing Variables and Functions
// ---------------------------------------------------------------------------
/**
 * Initializes the drawing state.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} x - Starting x-coordinate.
 * @param {number} y - Starting y-coordinate.
 * @param {number} length - Length of stroke.
 * @param {Plot|false} [plot=false] - Plot object for path-following strokes.
 */
function initializeDrawingState(ctx, x, y, length, plot = false) {
  const sc = ctx.strokeCursor;
  snapshotMatrix(ctx);
  sc.position = new Position(x + ctx.width / 2, y + ctx.height / 2, ctx);
  sc.length = length;
  sc.plot = plot;
  if (sc.plot) sc.plot.calcIndex(0);
}

/**
 * Fills the context's gaussian pool with the sequential seeded generator —
 * the pool contents are CPU-side data the GPU compute shaders receive as a
 * buffer; only the PICK is counter-based.
 * @param {import("../core/context.js").BrushContext} ctx
 */
function fillGaussPool(ctx) {
  const scope = ctx.rng.scopes.stroke;
  const gaussian = ctx.rng.gaussian;
  for (let i = 0; i < GAUSS_POOL_N; i++) scope.pool[i] = gaussian();
  scope.poolReady = true;
}

/** Hash-picked gaussian pool sample. */
const gaussPick = (ctx, streamId, salt, index) =>
  ctx.rng.scopes.stroke.pool[
    ctx.rng.hashU32(streamId, salt, index) % GAUSS_POOL_N
  ];

/**
 * Executes the drawing operation.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} angleScale - Angle (in degrees) or scaling factor.
 * @param {boolean} isPlot - True if plotting a shape.
 */
function draw(ctx, angleScale, isPlot) {
  const sc = ctx.strokeCursor;
  const cur = sc.current;
  if (!isPlot) sc.dir = angleScale;
  // Route eligible line/flowLine strokes to the GPU flow-field walk.
  // Plots, image/custom tips, function-curve pressures, non-translation
  // transforms, and Stats-instrumented runs take the retained CPU walk.
  if (!isPlot && tryGpuWalk(ctx, angleScale)) return;
  saveState(ctx);

  const stepSize = spacing(ctx);
  const totalSteps = Math.round(
    (sc.length * (isPlot ? angleScale : 1)) / stepSize,
  );
  if (Stats.enabled && Stats._stroke) Stats._stroke.steps = totalSteps;
  cur.pressureCount = 10;
  cur.cachedPressure = undefined;

  for (let i = 0; i < totalSteps; i++) {
    if (isPlot) sc.cachedPlotAngle = sc.plot.angle(sc.position.plotted);
    tip(ctx, i);
    if (isPlot) {
      sc.position.plotTo(sc.plot, stepSize, stepSize, angleScale, sc.cachedPlotAngle);
    } else {
      sc.position._moveToDegrees(angleScale, stepSize, stepSize);
    }
  }
  restoreState(ctx);
}

/**
 * GPU-walk router. Replicates saveState()'s environment side effects
 * (gauss pool fill order, strokeId sequencing, blend-cycle bookkeeping)
 * and hands the stroke to strokewalk-compute via gl_draw's batch queue.
 * The cross-stroke pressure-cache chain (upstream's leak) is synced
 * through the descriptor builder so CPU- and GPU-walked strokes can
 * interleave without diverging from the all-CPU sequence.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} dirDegrees internal-degrees stroke direction
 * @returns {boolean} true when the stroke was queued on the GPU path
 */
function tryGpuWalk(ctx, dirDegrees) {
  const sc = ctx.strokeCursor;
  const cur = sc.current;
  const State = ctx.state;
  const Mix = ctx.mix;
  const param = list.get(State.stroke.type)?.param;
  if (!walkEligible(ctx, param)) return false;

  const scope = ctx.rng.scopes.stroke;
  if (!scope.poolReady) fillGaussPool(ctx); // same lazy fill point as saveState
  scope.id++;

  isReady(ctx);
  const switchingToBrush = Mix.isBrush !== true;
  Mix.isBrush = true;
  if (switchingToBrush) Mix.justChanged = true;
  Mix.blend(ctx, State.stroke.color);

  const chain = queueWalkStroke(ctx, {
    strokeId: scope.id,
    kind: param.type === "marker" || param.type === "spray" ? param.type : "default",
    x: sc.position.x - ctx.width / 2,
    y: sc.position.y - ctx.height / 2,
    dir: dirDegrees,
    length: sc.length,
    brush: param,
    strokeWeight: State.stroke.weight,
    fieldActive: State.field?.isActive ?? false,
    wiggle: State.field?.wiggle ?? 1,
    gaussPool: scope.pool,
    chain: { pc: cur.pressureCount, cached: cur.cachedPressure },
  });
  cur.pressureCount = chain.pc;
  cur.cachedPressure = chain.cached;
  return true;
}

/**
 * Prepares the environment for a brush stroke.
 * @param {import("../core/context.js").BrushContext} ctx
 */
function saveState(ctx) {
  const sc = ctx.strokeCursor;
  const cur = sc.current;
  const State = ctx.state;
  const Mix = ctx.mix;
  const { rh, nh, hash01 } = ctx.rng;
  if (Stats.enabled) Stats.beginStroke();
  const scope = ctx.rng.scopes.stroke;
  if (!scope.poolReady) fillGaussPool(ctx);
  scope.id++;
  // Inspection seam: latch the stream/hook decision for this CPU-walked stroke.
  if (ctx.inspect.active) _notifyStrokeBegin(ctx, scope.id);
  // Stamp salt: low 2 bits reserved for draw phase (0 loop, 1 start, 2 end).
  cur.salt = (scope.id << 2) >>> 0;
  cur.phase = 0;
  const salt = cur.salt;
  cur.seed = hash01(STREAM.STROKE_SETUP, salt, 6) * 999999;
  const { param } = list.get(State.stroke.type) ?? {};
  if (!param) return;
  cur.p = param;

  // Set pressure values for the stroke — STROKE_SETUP slots 0..5: a, b, cp,
  // ct, cs, ck (slot 6 above is the legacy per-stroke seed).
  const { pressure } = param;
  cur.isCustomPressure = pressure.type === "custom";
  cur.a = !cur.isCustomPressure ? rh(STREAM.STROKE_SETUP, salt, 0, -1, 1) : 0;
  cur.b = !cur.isCustomPressure ? rh(STREAM.STROKE_SETUP, salt, 1, 1, 1.5) : 0;
  if (!cur.isCustomPressure) {
    cur.cp = rh(STREAM.STROKE_SETUP, salt, 2, 3, 3.5);
    cur.ct = 0;
    cur.cs = 1;
    cur.ck = 0;
  } else {
    const variation = pressure.variation ?? DEFAULT_CUSTOM_PRESSURE_VARIATION;
    cur.cp = rh(STREAM.STROKE_SETUP, salt, 2, -variation.offset, variation.offset);
    cur.ct = rh(STREAM.STROKE_SETUP, salt, 3, -variation.warp, variation.warp);
    cur.cs = rh(STREAM.STROKE_SETUP, salt, 4, 1 - variation.scale, 1 + variation.scale);
    cur.ck = rh(STREAM.STROKE_SETUP, salt, 5, -variation.tilt, variation.tilt);
  }
  [cur.min, cur.max] = pressure.min_max;



  // Cache stroke direction for direction-aware dispersion (non-plot strokes only)
  if (!sc.plot) {
    cur.cos = cos(sc.dir);
    cur.sin = sin(sc.dir);
  }

  // Ensure GL is ready and blend state
  isReady(ctx);
  const switchingToBrush = Mix.isBrush !== true;
  Mix.isBrush = true;
  if (switchingToBrush) Mix.justChanged = true;
  Mix.blend(ctx, State.stroke.color);

  // Set additional state values
  // Stroke-level noise: modulate alpha once per stroke so whole strokes are
  // subtly lighter or darker — organic variation without per-tip cost.
  const baseAlpha = calculateAlpha(ctx);
  const noiseStrength = 0.1 * (cur.p.noise ?? 0);
  cur.alpha = noiseStrength > 0
    ? Math.max(0, baseAlpha * (1 + nh(STREAM.STROKE_ALPHA_NOISE, salt, 0, 0, noiseStrength)))
    : baseAlpha;
  cur.overscan = getImageTipOverscan(ctx);
  cur.drawFn =
    cur.p.type === "spray"  ? drawSpray :
    cur.p.type === "marker" ? drawMarker :
    (cur.p.type === "custom" || cur.p.type === "image") ? drawImageTip :
    drawDefault;

  markerTip(ctx, 1);
}

/**
 * Restores drawing state after completing a stroke.
 * @param {import("../core/context.js").BrushContext} ctx
 */
function restoreState(ctx) {
  const cur = ctx.strokeCursor.current;
  markerTip(ctx, 2);
  if (Stats.enabled) Stats.endStroke();
  glDraw(ctx);
  const type = cur.p?.type;
  if (type === "image") glDrawImages(ctx, T.tips.get(cur.p.image.src), cur.p.image.src);
  else if (type === "custom") glDrawImages(ctx, T.tips.get(cur.p.tipKey), cur.p.tipKey);
}

/**
 * Renders the brush tip based on current pressure and position.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} index - Stamp index along the stroke.
 */
function tip(ctx, index) {
  const pressure = calculatePressure(ctx);

  ctx.strokeCursor.current.drawFn(ctx, pressure, index);
}

/**
 * Calculates the effective brush pressure.
 * @param {import("../core/context.js").BrushContext} ctx
 * @returns {number} The calculated pressure.
 */
function calculatePressure(ctx) {
  const sc = ctx.strokeCursor;
  const cur = sc.current;
  if (cur.pressureCount >= 10 || cur.cachedPressure === undefined) {
    cur.cachedPressure = sc.plot
      ? simPressure(ctx) * sc.plot.pressure(sc.position.plotted)
      : simPressure(ctx);
    cur.pressureCount = 0;
  }
  cur.pressureCount++;
  return cur.cachedPressure;
}

/**
 * Simulates brush pressure based on stroke parameters.
 * @param {import("../core/context.js").BrushContext} ctx
 * @returns {number} Simulated pressure value.
 */
function simPressure(ctx) {
  const sc = ctx.strokeCursor;
  const cur = sc.current;
  if (!cur.isCustomPressure) return gauss(ctx);
  const t = sc.position.plotted / sc.length;
  return map(
    cur.p.pressure.curve(
      Math.max(0, Math.min(1, 0.5 + (t - 0.5 + cur.ct) * cur.cs)),
    ) +
      cur.cp +
      cur.ck * (t - 0.5),
    0,
    1,
    cur.min,
    cur.max,
    true,
  );
}

/**
 * Generates a Gaussian-based pressure value.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} [a] - Center parameter.
 * @param {number} [b] - Width parameter.
 * @param {number} [c] - Shape parameter.
 * @param {number} [min] - Minimum pressure.
 * @param {number} [max] - Maximum pressure.
 * @returns {number} Gaussian pressure value.
 */
function gauss(ctx, a, b, c, min, max) {
  const sc = ctx.strokeCursor;
  const cur = sc.current;
  a ??= 0.5 + cur.p.pressure.curve[0] * cur.a;
  b ??= 1 - cur.p.pressure.curve[1] * cur.b;
  c ??= cur.cp;
  min ??= cur.min;
  max ??= cur.max;
  const peakPos = a * sc.length;
  const halfWidth =
    (sc.position.plotted < peakPos ? b * 1.2 : b * 0.8) * (sc.length / 2);
  return map(
    1 /
      (1 +
        Math.pow(Math.abs((sc.position.plotted - peakPos) / halfWidth), 2 * c)),
    0,
    1,
    min,
    max,
  );
}

/**
 * Calculates the alpha (opacity) level for a brush stroke.
 * @param {import("../core/context.js").BrushContext} ctx
 * @returns {number} The calculated opacity.
 */
function calculateAlpha(ctx) {
  const cur = ctx.strokeCursor.current;
  return ["default", "spray"].includes(cur.p.type)
    ? cur.p.opacity
    : cur.p.opacity / Math.min(ctx.state.stroke.weight, 1.3);
}

/**
 * Calculates the step spacing based on the current brush parameters.
 * @param {import("../core/context.js").BrushContext} ctx
 * @returns {number} The spacing value.
 */
function spacing(ctx) {
  return ctx.strokeCursor.current.p?.spacing ?? 1;
}

/**
 * @param {import("../core/context.js").BrushContext} ctx
 */
function getImageTipOverscan(ctx) {
  const cur = ctx.strokeCursor.current;
  const weight = ctx.state.stroke.weight;
  const maxPressure = Math.max(1, cur.max ?? 1);
  const scatterReach = weight * cur.p.scatter;
  const tipReach = weight * cur.p.weight * maxPressure;

  // Custom/image tips can extend beyond their nominal square because the tip
  // drawing itself may be large and because high scatter creates sparse large
  // stamps near the edge. Keep culling/dirty tracking conservative.
  return Math.max(8, scatterReach * 1.5 + tipReach * 0.75);
}

// ---------------------------------------------------------------------------
// Brush Tip Rendering Methods
// ---------------------------------------------------------------------------

/**
 * Draws the spray tip effect.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} pressure - Current pressure.
 */
function drawSpray(ctx, pressure, idx) {
  const sc = ctx.strokeCursor;
  const cur = sc.current;
  const rh = ctx.rng.rh;
  const weight = ctx.state.stroke.weight;
  const salt = (cur.salt | cur.phase) >>> 0;
  const vibration =
    weight * cur.p.scatter * pressure +
    (weight * gaussPick(ctx, STREAM.SPRAY_GAUSS, salt, idx) * cur.p.scatter) / 3;
  const sw = cur.p.weight * rh(STREAM.SPRAY_SW, salt, idx, 0.9, 1.1);
  const iterations = Math.ceil(cur.p.grain / pressure);
  for (let j = 0; j < iterations; j++) {
    const dotIdx = ((idx << 12) + j) >>> 0;
    const r = rh(STREAM.SPRAY_DOT_R, salt, dotIdx, 0.9, 1.1);
    const rX = r * vibration * rh(STREAM.SPRAY_DOT_X, salt, dotIdx, -1, 1);
    const yRandomFactor = rh(STREAM.SPRAY_DOT_Y, salt, dotIdx, -1, 1);
    const sqrtPart = Math.sqrt((r * vibration) ** 2 - rX ** 2);
    circle(
      ctx,
      sc.position.x + rX,
      sc.position.y + yRandomFactor * sqrtPart,
      sw,
      cur.alpha,
    );
  }
}

/**
 * Draws the marker tip effect.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} pressure - Current pressure.
 * @param {boolean} [vibrate=true] - Whether to apply vibration.
 */
function drawMarker(
  ctx,
  pressure,
  idx,
  vibrate = true,
  alpha = ctx.strokeCursor.current.alpha,
) {
  const sc = ctx.strokeCursor;
  const cur = sc.current;
  const rh = ctx.rng.rh;
  const weight = ctx.state.stroke.weight;
  const salt = (cur.salt | cur.phase) >>> 0;
  const vibration = vibrate ? weight * cur.p.scatter : 0;
  const rx = vibrate ? vibration * rh(STREAM.MARKER_VIB_X, salt, idx, -1, 1) : 0;
  const ry = vibrate ? vibration * rh(STREAM.MARKER_VIB_Y, salt, idx, -1, 1) : 0;
  circle(
    ctx,
    sc.position.x + rx,
    sc.position.y + ry,
    weight * cur.p.weight * pressure,
    alpha * Math.max(0.8, pressure) * rh(STREAM.MARKER_ALPHA, salt, idx, 0.9, 1.1),
  );
}

/**
 * Queues a stamp for instanced GL rendering.
 * Handles both "image" and "custom" tip types.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} pressure - Current pressure.
 * @param {number} alpha - Opacity [0..255].
 */
function drawImageTip(
  ctx,
  pressure,
  idx,
  alpha = ctx.strokeCursor.current.alpha,
) {
  const sc = ctx.strokeCursor;
  const cur = sc.current;
  const rh = ctx.rng.rh;
  const weight = ctx.state.stroke.weight;
  const salt = (cur.salt | cur.phase) >>> 0;
  const vibration = weight * cur.p.scatter;
  const rx = vibration * rh(STREAM.TIP_VIB_X, salt, idx, -1, 1);
  const ry = vibration * rh(STREAM.TIP_VIB_Y, salt, idx, -1, 1);
  const size = cur.p.weight * weight * pressure;
  const overscan = cur.overscan;
  let angle = 0;
  if (cur.p.rotate === "random") {
    angle = ~~rh(STREAM.TIP_ROT, salt, idx, 0, 360) * (Math.PI / 180);
  } else if (cur.p.rotate === "natural") {
    angle = ((sc.plot ? -sc.cachedPlotAngle : -sc.dir) + sc.position.angle()) * (Math.PI / 180);
  }
  stampImage(
    ctx,
    sc.position.x + rx,
    sc.position.y + ry,
    size,
    angle,
    alpha * Math.max(0.8, pressure) * rh(STREAM.TIP_ALPHA, salt, idx, 0.9, 1.1),
    overscan,
  );
}

/**
 * Draws the default brush tip.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} pressure - Current pressure.
 */
function drawDefault(ctx, pressure, idx) {
  const sc = ctx.strokeCursor;
  const cur = sc.current;
  const rh = ctx.rng.rh;
  const weight = ctx.state.stroke.weight;
  const salt = (cur.salt | cur.phase) >>> 0;
  if (ctx.rng.hash01(STREAM.DEFAULT_GATE, salt, idx) >= cur.p.grain * pressure) return;
  const vibration =
    weight *
    cur.p.scatter *
    (cur.p.sharpness +
      ((1 - cur.p.sharpness) * gaussPick(ctx, STREAM.DEFAULT_SCATTER, salt, idx)) / pressure);
    let dx, dy;
    if (sc.plot) {
      const plotAngle = sc.cachedPlotAngle;
      const plotCos = cos(plotAngle);
      const plotSin = sin(plotAngle);
      const perp = vibration * rh(STREAM.DEFAULT_PERP, salt, idx, -1, 1);
      const along = 0.3 * vibration * rh(STREAM.DEFAULT_ALONG, salt, idx, -1, 1);
      dx = perp * plotSin + along * plotCos;
      dy = perp * plotCos - along * plotSin;
    } else {
      const perp = vibration * rh(STREAM.DEFAULT_PERP, salt, idx, -1, 1);
      const along = 0.3 * vibration * rh(STREAM.DEFAULT_ALONG, salt, idx, -1, 1);
      dx = perp * cur.sin + along * cur.cos;
      dy = perp * cur.cos - along * cur.sin;
    }
    const diameter =
      pressure *
      pressure *
      cur.p.weight *
      rh(STREAM.DEFAULT_SIZE, salt, idx, 0.85, 1.15) *
      weight;
    const alpha = Math.max(0.9, pressure) * cur.alpha * rh(STREAM.DEFAULT_ALPHA, salt, idx, 0.75, 1.1);
    circle(
      ctx,
      sc.position.x + dx,
      sc.position.y + dy,
      diameter,
      alpha,
    );
  
}

/**
 * Draws the marker tip with a blend effect.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} phase - 1 = stroke start, 2 = stroke end.
 */
function markerTip(ctx, phase) {
  const cur = ctx.strokeCursor.current;
  if (cur.p.markerTip === false) return;
  const prevPhase = cur.phase;
  cur.phase = phase; // 1 = stroke start, 2 = stroke end
  let pressure = calculatePressure(ctx);
  let alpha = cur.alpha;
  if (cur.p.type === "marker") {
    for (let s = 1; s < 10; s++) {
      drawMarker(ctx, (pressure * s) / 10, s, true, alpha * 8);
    }
  } else if (cur.p.type === "custom" || cur.p.type === "image") {
    for (let s = 1; s < 5; s++) {
      drawImageTip(ctx, (pressure * s) / 10, s, alpha * 2);
    }
  }
  cur.phase = prevPhase;
}

// ---------------------------------------------------------------------------
// Basic Drawing Operations
// ---------------------------------------------------------------------------

/**
 * Draws a line using the current brush.
 * @param {number} x1 - Start x-coordinate.
 * @param {number} y1 - Start y-coordinate.
 * @param {number} x2 - End x-coordinate.
 * @param {number} y2 - End y-coordinate.
 */
export function line(x1, y1, x2, y2) {
  return _line(defaultContext, x1, y1, x2, y2);
}

/**
 * Context-taking implementation of line().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} x1 - Start x-coordinate.
 * @param {number} y1 - Start y-coordinate.
 * @param {number} x2 - End x-coordinate.
 * @param {number} y2 - End y-coordinate.
 */
export function _line(ctx, x1, y1, x2, y2) {
  const stroke = ctx.state.stroke;
  if (!stroke.isActive || !stroke.color) {
    throw new Error(
      "No brush or color set. Call brush.set('brushName', color) before drawing.",
    );
  }
  isFieldReady(ctx);
  let d = dist(x1, y1, x2, y2);
  if (d == 0) return;
  initializeDrawingState(ctx, x1, y1, d);
  let angle = calcAngle(x1, y1, x2, y2);
  draw(ctx, angle, false);
}

/**
 * Draws a stroke from a starting point in a given direction.
 * @param {number} x - Starting x-coordinate.
 * @param {number} y - Starting y-coordinate.
 * @param {number} length - Length of the stroke.
 * @param {number} dir - Direction, interpreted using the current runtime angle units.
 */
export function flowLine(x, y, length, dir) {
  return _flowLine(defaultContext, x, y, length, dir);
}

/**
 * Context-taking implementation of flowLine().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} x - Starting x-coordinate.
 * @param {number} y - Starting y-coordinate.
 * @param {number} length - Length of the stroke.
 * @param {number} dir - Direction, interpreted using the current runtime angle units.
 */
export function _flowLine(ctx, x, y, length, dir) {
  const stroke = ctx.state.stroke;
  if (!stroke.isActive || !stroke.color) {
    throw new Error(
      "No brush or color set. Call brush.set('brushName', color) before drawing.",
    );
  }
  isFieldReady(ctx);
  initializeDrawingState(ctx, x, y, length);
  draw(ctx, toDegrees(ctx, dir), false);
}

/**
 * Draws a predefined plot.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {object} p - Shape object representing the plot.
 * @param {number} x - Starting x-coordinate.
 * @param {number} y - Starting y-coordinate.
 * @param {number} scale - Scale factor.
 */
function plot(ctx, p, x, y, scale) {
  isFieldReady(ctx);
  initializeDrawingState(ctx, x, y, p.length, p);
  draw(ctx, scale, true);
}

// ---------------------------------------------------------------------------
// Standard Brushes Definition and Initialization
// ---------------------------------------------------------------------------

/**
 * Defines a set of standard brushes with specific characteristics. Each brush is defined
 * with properties such as weight, scatter, sharpness, grain, opacity, spacing, and
 * pressure sensitivity. Some brushes have additional properties like type, tip, and rotate.
 */
const _vals = [
  "weight",
  "scatter",
  "sharpness",
  "grain",
  "opacity",
  "spacing",
  "pressure",
  "type",
  "tip",
  "rotate",
  "markerTip",
  "noise",
];
const _standard_brushes = [
  [
    "pen",
    [0.3, 0.15, 0.9, 0.7, 150, 0.1, { curve: [0.15, 0.2], min_max: [1.2, 1] }],
  ],
  [
    "rotring",
    [0.15, 0.05, 0.7, 0.9, 210, 0.1, { curve: [0.35, 0.2], min_max: [1.3, 1] }],
  ],
  [
    "2B",
    [0.3, 0.75, 0.45, 0.8, 180, 0.1, { curve: [0.1, 0.3], min_max: [1.1, 0.9] }],
  ],
  [
    "HB",
    [0.3, 0.6, 0.3, 0.7, 170, 0.1, { curve: [0.15, 0.2], min_max: [1.1, 0.9] }],
  ],
  [
    "2H",
    [0.2, 0.6, 0.3, 0.75, 120, 0.1, { curve: [0.15, 0.2], min_max: [1.1, 0.9] }],
  ],
  [
    "cpencil",
    [0.35, 0.55, 0.8, 0.7, 75, 0.1, { curve: [0.15, 0.2], min_max: [0.95, 1.1] }],
  ],
  [
    "pastel",
    [
      0.7,
      5,
      0.91,
      1,
      30,
      0.085 / 3,
      { mode: "gaussian", curve: [0.4, 0.05], min_max: [1.09, 0.93] },
      "default",
      undefined,
      "natural",
      true,
      1,
    ],
  ],
  [
    "crayon",
    [
      0.33,
      1.9,
      0.75,
      2,
      159,
      0.07,
      [1.1, 0.9],
      "default",
      undefined,
      "natural",
      true,
      1,
    ],
  ],
  [
    "charcoal",
    [
      0.35,
      1.5,
      0.68,
      2,
      120,
      0.03,
      { curve: [0.15, 0.4], min_max: [1.1, 0.95] },
    ],
  ],
  [
    "spray",
    [
      0.2,
      6,
      15,
      40,
      90,
      0.5,
      { curve: [0.2, 0.35], min_max: [0.7, 1] },
      "spray",
    ],
  ],
  [
    "marker",
    [
      2,
      0.2,
      null,
      null,
      1,
      0.03,
      { curve: [0.35, 0.25], min_max: [1.2, 0.85] },
      "marker",
    ],
  ],
];

for (let s of _standard_brushes) {
  let obj = {};
  for (let i = 0; i < s[1].length; i++) obj[_vals[i]] = s[1][i];
  add(s[0], obj);
}

// ---------------------------------------------------------------------------
// Extensions to Polygon and Plot Prototypes
// ---------------------------------------------------------------------------

/**
 * Draws the polygon using the current brush.
 * @param {boolean} [_brush=false] - Optional brush name override.
 * @param {string|Color} [_color] - Optional color override.
 * @param {number} [_weight] - Optional weight override.
 */
Polygon.prototype.draw = function (_brush = false, _color, _weight) {
  const ctx = this.owner ?? defaultContext;
  let state = BrushState(ctx);
  if (_brush) _set(ctx, _brush, _color, _weight);
  if (state.isActive) {
    for (let s of this.sides) {
      _line(ctx, s[0].x, s[0].y, s[1].x, s[1].y);
    }
  }
  BrushSetState(ctx, state);
  return this;
};

/**
 * Draws the plot using the current brush.
 * @param {number} x - Starting x-coordinate.
 * @param {number} y - Starting y-coordinate.
 * @param {number} scale - Scale factor.
 */
Plot.prototype.draw = function (x, y, scale) {
  const ctx = this.owner ?? defaultContext;
  if (BrushState(ctx).isActive) {
    if (this.origin) ((x = this.origin[0]), (y = this.origin[1]), (scale = 1));
    plot(ctx, this, x, y, scale);
  }
  return this;
};

// =============================================================================
// Section: Loading Custom Image Tips
// =============================================================================
/**
 * This section defines the functionality for managing the loading and processing of image tips.
 * Images are loaded from specified source URLs, converted to a white tint for visual effects,
 * and then stored for future use. It includes methods to add new images, convert their color
 * scheme, and integrate them into the active host image pipeline.
 */

/**
 * Manages loading and processing of image tips.
 * Images are converted to white with inverted alpha for tinting via shaders.
 */
const T = {
  tips: new Map(),

  /**
   * Registers an image source for later loading.
   * @param {string} src - The source URL of the image.
   */
  add(src) {
    if (!this.tips.has(src)) this.tips.set(src, false);
  },

  /**
   * Converts image to white with inverted alpha for tint-based rendering.
   * @param {object} image - The host image object to convert.
   */
  imageToWhite(image) {
    image.loadPixels();
    for (let i = 0; i < 4 * image.width * image.height; i += 4) {
      let average =
        (image.pixels[i] + image.pixels[i + 1] + image.pixels[i + 2]) / 3;
      image.pixels[i] = image.pixels[i + 1] = image.pixels[i + 2] = 255;
      image.pixels[i + 3] = 255 - average;
    }
    image.updatePixels();
  },

  /**
   * Loads all registered image tips. Returns a promise that resolves
   * when all images are loaded and processed.
   * @returns {Promise}
   */
  async load() {
    const entries = [...this.tips.keys()].filter((k) => !this.tips.get(k));
    await Promise.all(
      entries.map(
        (src) =>
          loadImageTip(src, T.imageToWhite).then((p5img) => {
            this.tips.set(src, p5img);
          }),
      ),
    );
  },
};
