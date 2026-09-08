import { defaultContext } from "../core/context.js";
import { toDegreesSigned, map, STREAM } from "../core/utils.js";
import { Polygon } from "../core/polygon.js";
import { Plot } from "../core/plot.js";
import { BrushState, BrushSetState, _set, _line } from "../stroke/stroke.js";

// =============================================================================
// Module: Classic Hatch
// =============================================================================

// ---------------------------------------------------------------------------
// Hatch State
// ---------------------------------------------------------------------------

defaultContext.state.hatch = {
  isActive: false,
  dist: 5,
  angle: 45,
  options: {},
  hBrush: false,
};

// Hash-stream scope counter: one id per getHatchLines() invocation.
let _hatchId = 0;
defaultContext.rng.onSeed(() => {
  _hatchId = 0;
});

/**
 * Returns a shallow snapshot of the current hatch modifier state.
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @returns {{isActive:boolean, dist:number, angle:number, options:Object, hBrush:Object|false}}
 */
export function HatchState(ctx) {
  return { ...ctx.state.hatch };
}

/**
 * Restores hatch modifier state from a previously captured snapshot.
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {{isActive:boolean, dist:number, angle:number, options:Object, hBrush:Object|false}} state
 */
export function HatchSetState(ctx, state) {
  ctx.state.hatch = { ...state };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Activates classic scanline hatching for subsequent shapes.
 *
 * @param {number} [dist=5] Distance between scanlines.
 * @param {number} [angle=45] Hatch angle in the current runtime angle units.
 * @param {{rand?: number|false, continuous?: boolean, gradient?: number|false}} [options]
 */
export function hatch(
  dist = 5,
  angle = 45,
  options = { rand: false, continuous: false, gradient: false }
) {
  return _hatch(defaultContext, dist, angle, options);
}

/**
 * Context-taking implementation of hatch().
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} [dist=5] Distance between scanlines.
 * @param {number} [angle=45] Hatch angle in the current runtime angle units.
 * @param {{rand?: number|false, continuous?: boolean, gradient?: number|false}} [options]
 */
export function _hatch(
  ctx,
  dist = 5,
  angle = 45,
  options = { rand: false, continuous: false, gradient: false }
) {
  let s = ctx.state.hatch;
  s.isActive = true;
  s.dist = dist;
  s.angle = toDegreesSigned(angle);
  s.options = options;
}

/**
 * Overrides the brush, color, and weight used specifically for hatch strokes.
 *
 * @param {string} brush
 * @param {string|object} [color="black"]
 * @param {number} [weight=1]
 */
export function hatchStyle(brush, color = "black", weight = 1) {
  return _hatchStyle(defaultContext, brush, color, weight);
}

/**
 * Context-taking implementation of hatchStyle().
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {string} brush
 * @param {string|object} [color="black"]
 * @param {number} [weight=1]
 */
export function _hatchStyle(ctx, brush, color = "black", weight = 1) {
  ctx.state.hatch.hBrush = { brush, color, weight };
}

/**
 * Deactivates hatching and clears any hatch-specific brush override.
 */
export function noHatch() {
  return _noHatch(defaultContext);
}

/**
 * Context-taking implementation of noHatch().
 *
 * @param {import("../core/context.js").BrushContext} ctx
 */
export function _noHatch(ctx) {
  const hatchState = ctx.state.hatch;
  hatchState.isActive = false;
  hatchState.hBrush = false;
}

// ---------------------------------------------------------------------------
// Scanline Generation
// ---------------------------------------------------------------------------

/**
 * Computes hatch segments for one polygon by rotating it into scanline space,
 * intersecting horizontal scanlines against its edges, and rotating the
 * resulting segments back into canvas space.
 *
 * @param {Polygon} polygon
 * @param {number} angle Hatch angle in degrees.
 * @param {number} dist Base scanline spacing.
 * @param {number} gradient Multiplicative spacing growth per scanline.
 * @returns {{scanY:number, x1:number, y1:number, x2:number, y2:number}[]}
 */
// Reusable buffers for scanlineHatch to avoid per-call allocations
let _sRotX = new Float64Array(256);
let _sRotY = new Float64Array(256);
let _eX1 = new Float64Array(512);
let _eY1 = new Float64Array(512);
let _eX2 = new Float64Array(512);
let _eY2 = new Float64Array(512);

function scanlineHatch(polygons, angle, dist, gradient) {
  if (!Array.isArray(polygons)) polygons = [polygons];

  const rad = (angle * Math.PI) / 180;
  const cosA = Math.cos(rad),
    sinA = Math.sin(rad);
  // cos(-rad) = cosA, sin(-rad) = -sinA — no extra trig needed
  const sinB = -sinA;

  let totalVerts = 0;
  for (const polygon of polygons) totalVerts += polygon.a.length;
  if (totalVerts === 0) return [];

  // Grow reusable vertex buffers if needed
  if (_sRotX.length < totalVerts) {
    _sRotX = new Float64Array(totalVerts * 2);
    _sRotY = new Float64Array(totalVerts * 2);
  }

  // Rotate all contour vertices into scan space; track the combined Y extent
  let minY = Infinity,
    maxY = -Infinity;
  let eLen = 0;
  let vLen = 0;
  if (_eX1.length < totalVerts) {
    _eX1 = new Float64Array(totalVerts * 2);
    _eY1 = new Float64Array(totalVerts * 2);
    _eX2 = new Float64Array(totalVerts * 2);
    _eY2 = new Float64Array(totalVerts * 2);
  }

  // Build one flat edge list across all contours so crossings pair globally.
  for (const polygon of polygons) {
    const verts = polygon.a;
    const n = verts.length;
    const base = vLen;

    for (let i = 0; i < n; i++) {
      const x = verts[i][0],
        y = verts[i][1];
      _sRotX[vLen] = x * cosA - y * sinA;
      _sRotY[vLen] = x * sinA + y * cosA;
      if (_sRotY[vLen] < minY) minY = _sRotY[vLen];
      if (_sRotY[vLen] > maxY) maxY = _sRotY[vLen];
      vLen++;
    }

    for (let i = 0; i < n; i++) {
      const j = i + 1 < n ? i + 1 : 0;
      const ai = base + i;
      const bj = base + j;
      const ay = _sRotY[ai], by = _sRotY[bj];
      if (ay !== by) {
        _eX1[eLen] = _sRotX[ai];
        _eY1[eLen] = ay;
        _eX2[eLen] = _sRotX[bj];
        _eY2[eLen] = by;
        eLen++;
      }
    }
  }

  // Scan, find crossings, rotate back
  const segments = [];
  const cx = [];
  let Y = minY + dist * 0.5,
    step = dist;
  const useGradient = gradient !== 1;
  while (Y < maxY) {
    cx.length = 0;
    for (let i = 0; i < eLen; i++) {
      const y1 = _eY1[i], y2 = _eY2[i];
      // Simplified scanline crossing test: (y1<=Y) XOR (y2<=Y)
      if ((y1 <= Y) !== (y2 <= Y))
        cx.push(_eX1[i] + ((Y - y1) / (y2 - y1)) * (_eX2[i] - _eX1[i]));
    }
    // Fast path for the common case of exactly 2 crossings (convex polygon)
    const cxLen = cx.length;
    if (cxLen === 2) {
      let xi = cx[0], xj = cx[1];
      if (xi > xj) { const t = xi; xi = xj; xj = t; }
      segments.push({
        scanY: Y,
        x1: xi * cosA + Y * sinA,
        y1: -xi * sinA + Y * cosA,
        x2: xj * cosA + Y * sinA,
        y2: -xj * sinA + Y * cosA,
      });
    } else if (cxLen > 2) {
      cx.sort((a, b) => a - b);
      for (let i = 0; i < cxLen - 1; i += 2) {
        const xi = cx[i], xj = cx[i + 1];
        segments.push({
          scanY: Y,
          x1: xi * cosA + Y * sinA,
          y1: -xi * sinA + Y * cosA,
          x2: xj * cosA + Y * sinA,
          y2: -xj * sinA + Y * cosA,
        });
      }
    }
    Y += step;
    if (useGradient) step *= gradient;
  }
  return segments;
}

/**
 * Collects and orders hatch segments for one polygon or a polygon list.
 *
 * Segments are sorted in scanline traversal order so downstream rendering can
 * optionally connect them into a continuous serpentine path.
 *
 * @param {Polygon|Polygon[]} polygons
 * @param {number} dist
 * @param {number} angle
 * @param {number} gradient
 * @returns {{scanY:number, x1:number, y1:number, x2:number, y2:number}[]}
 */
function getHatchSegments(polygons, dist, angle, gradient) {
  const segs = scanlineHatch(polygons, angle, dist, gradient);
  segs.sort((a, b) => (a.scanY === b.scanY ? a.x1 - b.x1 : a.scanY - b.scanY));
  return segs;
}

// ---------------------------------------------------------------------------
// Hatch Configuration
// ---------------------------------------------------------------------------

/**
 * Runs hatch drawing with the temporary hatch-specific brush style if one is active,
 * then restores the outer stroke state.
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {() => void} drawFn
 */
function withHatchStyle(ctx, drawFn) {
  const save = BrushState(ctx);
  drawFn();
  BrushSetState(ctx, save);
}

/**
 * Resolves the active hatch parameters and precomputes the ordered scanline segments.
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {Polygon|Polygon[]} polygons
 * @returns {{dist:number, options:Object, segs:Object[]}}
 */
function getActiveHatchConfig(ctx, polygons) {
  const hatchState = ctx.state.hatch;
  const dist = hatchState.dist;
  const angle = ((hatchState.angle % 180) + 180) % 180;
  const options = hatchState.options;
  const gradient = options.gradient ? map(options.gradient, 0, 1, 1, 1.1, true) : 1;
  const segs = getHatchSegments(polygons, dist, angle, gradient);
  return { dist, options, segs };
}

// ---------------------------------------------------------------------------
// Hatch Lines
// ---------------------------------------------------------------------------

/**
 * Expands ordered hatch segments into the actual line list that will be drawn.
 *
 * This includes endpoint jitter when `rand` is active and inserts the serpentine
 * connector lines when `continuous` is enabled.
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {Polygon|Polygon[]} polygons
 * @returns {{x1:number, y1:number, x2:number, y2:number, scanY:number, isConnector:boolean}[]}
 */
export function getHatchLines(ctx, polygons) {
  const rh = ctx.rng.rh;
  const { dist, options, segs } = getActiveHatchConfig(ctx, polygons);
  const r = options.rand || 0;
  const lines = [];
  _hatchId++;
  const salt = _hatchId;

  for (let j = 0; j < segs.length; j++) {
    const s = segs[j];
    let x1 = s.x1, y1 = s.y1, x2 = s.x2, y2 = s.y2;
    if (r) {
      x1 += 2 * r * dist * rh(STREAM.HATCH_JIT_X1, salt, j, -1, 1);
      y1 += 2 * r * dist * rh(STREAM.HATCH_JIT_Y1, salt, j, -1, 1);
      x2 += 2 * r * dist * rh(STREAM.HATCH_JIT_X2, salt, j, -1, 1);
      y2 += 2 * r * dist * rh(STREAM.HATCH_JIT_Y2, salt, j, -1, 1);
    }
    const reverse = options.continuous && j % 2 === 1;
    const line = reverse
      ? { x1: x2, y1: y2, x2: x1, y2: y1, scanY: s.scanY, isConnector: false }
      : { x1, y1, x2, y2, scanY: s.scanY, isConnector: false };
    lines.push(line);
    if (j > 0 && options.continuous) {
      const prev = lines[lines.length - 2];
      lines.push({
        x1: prev.x2,
        y1: prev.y2,
        x2: line.x1,
        y2: line.y1,
        scanY: s.scanY,
        isConnector: true,
      });
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Hatch Rendering
// ---------------------------------------------------------------------------

/**
 * Iterates the generated hatch lines and delegates the actual rendering of each
 * segment to the provided callback.
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {Polygon|Polygon[]} polygons
 * @param {(x1:number, y1:number, x2:number, y2:number, index:number, segs:Object[]) => void} drawSegment
 */
function renderHatchSegments(ctx, polygons, drawSegment) {
  const segs = getHatchLines(ctx, polygons);
  withHatchStyle(ctx, () => {
    for (let j = 0; j < segs.length; j++) {
      const s = segs[j];
      drawSegment(s.x1, s.y1, s.x2, s.y2, j, segs);
    }
  });
}

/**
 * Draws classic hatch lines over one polygon or an array of polygons.
 *
 * @param {Polygon|Polygon[]} polygons
 */
export function createHatch(polygons) {
  return _createHatch(defaultContext, polygons);
}

/**
 * Context-taking implementation of createHatch().
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {Polygon|Polygon[]} polygons
 */
export function _createHatch(ctx, polygons) {
  const rh = ctx.rng.rh;
  renderHatchSegments(ctx, polygons, (x1, y1, x2, y2, j) => {
    const hBrush = ctx.state.hatch.hBrush;
    if (hBrush) _set(ctx, hBrush.brush, hBrush.color, hBrush.weight * rh(STREAM.HATCH_WEIGHT, _hatchId, j, 0.9, 1.1));
    _line(ctx, x1, y1, x2, y2);
  });
}

// ---------------------------------------------------------------------------
// Prototype Extensions
// ---------------------------------------------------------------------------

/**
 * Applies the currently active hatch modifier to a polygon, or temporarily
 * overrides hatch parameters for this call only.
 *
 * @param {number|false} [_dist=false]
 * @param {number} [_angle]
 * @param {{rand?: number|false, continuous?: boolean, gradient?: number|false}} [_options]
 */
Polygon.prototype.hatch = function (_dist = false, _angle, _options) {
  const ctx = this.owner ?? defaultContext;
  let state = HatchState(ctx);
  if (_dist) _hatch(ctx, _dist, _angle, _options);
  if (ctx.state.hatch.isActive) _createHatch(ctx, this);
  HatchSetState(ctx, state);
  return this;
};

/**
 * Converts the plot to a polygon and applies the currently active hatch modifier.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} scale
 */
Plot.prototype.hatch = function (x, y, scale) {
  const ctx = this.owner ?? defaultContext;
  if (HatchState(ctx).isActive) {
    if (this.origin) (x = this.origin[0]), (y = this.origin[1]), (scale = 1);
    this.pol = this.genPol(x, y, scale, 0.3);
    this.pol.hatch();
  }
};
