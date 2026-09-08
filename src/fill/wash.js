// =============================================================================
// Module: Wash
// =============================================================================
/**
 * Minimal stateful API for the `wash()` fill modifier.
 * 
 * Wash provides a simpler, solid-color fill that uses the existing 2D canvas
 * pipeline instead of direct WebGL rendering, avoiding the need for polygon
 * triangulation.
 */

import { isCanvasReady } from "../core/target.js";
import { defaultContext } from "../core/context.js";
import { Polygon } from "../core/polygon.js";
import { Plot } from "../core/plot.js";

defaultContext.state.wash = {
  color: null,
  opacity: 150,
  isActive: false,
};

// =============================================================================
// Public API
// =============================================================================

/**
 * Enables wash mode with a color and opacity.
 *
 * @param {number|string|Color} a - Either the red component, a CSS color string, or a Color object.
 * @param {number} [b] - The green component or the opacity if using grayscale.
 * @param {number} [c] - The blue component.
 * @param {number} [d] - The opacity.
 */
export function wash(a, b, c, d) {
  return _wash(defaultContext, ...arguments);
}

/**
 * Context-taking implementation of wash().
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {...*} args - Color arguments plus optional opacity.
 */
export function _wash(ctx, ...args) {
  const [a, b, c, d] = args;
  isCanvasReady();
  const state = ctx.state.wash;
  state.opacity = (args.length < 4 ? b : d) ?? 150;
  state.color = args.length < 3 ? ctx.createColor(a) : ctx.createColor(a, b, c);
  state.isActive = true;
}

/**
 * Disables wash mode for subsequent drawing operations.
 */
export function noWash() {
  return _noWash(defaultContext);
}

/**
 * Context-taking implementation of noWash().
 *
 * @param {import("../core/context.js").BrushContext} ctx
 */
export function _noWash(ctx) {
  ctx.state.wash.isActive = false;
}

// =============================================================================
// Drawing Implementation
// =============================================================================

/**
 * Draws a solid wash fill to the polygon using the 2D canvas pipeline.
 * Follows the same pattern as fill() for consistency with the color caching system.
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {Polygon} polygon - The polygon to fill with the current wash state.
 */
function drawWashPolygon(ctx, polygon) {
  const State = ctx.state;
  const Mix = ctx.mix;
  if (!State.wash?.isActive || !State.wash.color || polygon.vertices.length < 3) return;

  // Track if we're switching from brush to fill mode
  const switchingToWash = Mix.isBrush !== false;
  Mix.isBrush = false;
  if (switchingToWash) Mix.justChanged = true;

  // CRITICAL: Call Mix.blend() BEFORE drawing!
  // This checks if color changed and composites previous mask if needed.
  // Our drawing will go to the mask and composite on the next draw call.
  Mix.blend(ctx, State.wash.color);

  // Same density-scaled centering matrix as fill()
  const density = ctx.density;
  const m = ctx.getAffineMatrix();
  const matrix = {
    a: density * m.a,
    b: density * m.b,
    c: density * m.c,
    d: density * m.d,
    e: density * (m.x + ctx.width / 2),
    f: density * (m.y + ctx.height / 2),
  };

  // One nonzero-winding fill pass on the GPU fill surface (dirty rects
  // are tracked by the surface).
  const alpha = State.wash.opacity / 255;
  Mix.ctx.washPolygon(polygon.vertices, matrix, alpha);
}

// =============================================================================
// Prototype methods
// =============================================================================

/**
 * Applies a wash fill to the polygon using the current wash state.
 *
 * @param {Color|string|false} [_color] - Optional override color for this call.
 * @param {number} [_opacity] - Optional override opacity for this call.
 */
Polygon.prototype.wash = function (_color = false, _opacity) {
  const ctx = this.owner ?? defaultContext;
  const State = ctx.state;
  const state = { ...State.wash };
  if (_color !== false) _wash(ctx, _color, _opacity);

  if (State.wash.isActive) {
    drawWashPolygon(ctx, this);
  }

  State.wash = { ...state };
  return this;
};

/**
 * Applies wash to a plot by first generating the plot polygon, mirroring the
 * existing fill-path behavior, and then drawing that polygon with wash.
 *
 * @param {number} x - The x-coordinate.
 * @param {number} y - The y-coordinate.
 * @param {number} scale - The scale factor.
 */
Plot.prototype.wash = function (x, y, scale) {
  const ctx = this.owner ?? defaultContext;
  if (!ctx.state.wash?.isActive) return;
  if (this.origin) {
    x = this.origin[0];
    y = this.origin[1];
    scale = 1;
  }
  this.pol = this.genPol(x, y, scale, 0, -1);
  this.pol.wash();
};
