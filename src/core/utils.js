// =============================================================================
// Module: Utilities
// =============================================================================
/**
 * Numeric mapping, trigonometry and geometry helpers, plus the STREAM map
 * that names every counter-based randomness stream.
 *
 * The generators themselves live in core/rng.js (one set per painting) and
 * the trig tables in core/trig.js; both are re-exported here so this module
 * keeps the surface every consumer — and the public `random` / `noise` /
 * `wRand` exports of the standalone entry — already imports from it. The
 * re-exported functions all drive the DEFAULT painting's rng; internal code
 * draws through `ctx.rng` instead.
 */

export {
  createRng,
  hashU32From,
  hash01From,
  random,
  rr2,
  randInt2,
  rArray,
  gaussian,
  weightedRand,
  noise,
  noise2,
  hashU32,
  hash01,
  rh,
  nh,
  seed,
  noiseSeed,
  _getSeedU32,
} from "./rng.js";
export { cos, sin, cossin } from "./trig.js";

import { cossin } from "./trig.js";

/**
 * Stream identifiers — one per randomness purpose. GPU compute shaders must
 * reproduce these ids verbatim; never renumber, only append.
 */
export const STREAM = {
  // stroke: per-stroke setup (salt = strokeSalt, index = fixed slot 0..6)
  STROKE_SETUP: 1,
  // stroke: per-stroke alpha noise gaussian (salt = strokeSalt, index = 0)
  STROKE_ALPHA_NOISE: 2,
  // spray tip (salt = strokeSalt|phase, index = stamp i; dots (i<<12)+j)
  SPRAY_GAUSS: 3,
  SPRAY_SW: 4,
  SPRAY_DOT_R: 5,
  SPRAY_DOT_X: 6,
  SPRAY_DOT_Y: 7,
  // marker tip (salt = strokeSalt|phase, index = stamp i)
  MARKER_VIB_X: 8,
  MARKER_VIB_Y: 9,
  MARKER_ALPHA: 10,
  // image/custom tip (salt = strokeSalt|phase, index = stamp i)
  TIP_VIB_X: 11,
  TIP_VIB_Y: 12,
  TIP_ROT: 13,
  TIP_ALPHA: 14,
  // default tip (salt = strokeSalt|phase, index = stamp i)
  DEFAULT_GATE: 15,
  DEFAULT_SCATTER: 16,
  DEFAULT_PERP: 17,
  DEFAULT_ALONG: 18,
  DEFAULT_SIZE: 19,
  DEFAULT_ALPHA: 20,
  // fill setup (salt = fillSalt of op 0, index = vertex i or slot)
  FILL_WR: 21,
  FILL_MOD: 22,
  FILL_SHIFT: 23,
  FILL_CENTER_X: 24,
  FILL_CENTER_Y: 25,
  FILL_DARKER: 26,
  // FillPoly.grow (salt = fillSalt per op, index = vertex i)
  GROW_MOD999: 27,
  GROW_ROT: 28,
  GROW_DIST_POOL: 29,
  GROW_DIST_SCALE: 30,
  GROW_MOD_POOL: 31,
  // FillPoly.trim (salt = fillSalt per op, index = bridge vertex k)
  TRIM_SAMPLE: 32,
  TRIM_JIT_X: 33,
  TRIM_JIT_Y: 34,
  TRIM_MOD: 35,
  // FillPoly.scatter (salt = fillSalt per op, index = kept vertex i)
  SCATTER_PICK: 36,
  SCATTER_PULL_X: 37,
  SCATTER_PULL_Y: 38,
  // FillPoly.erase (salt = fillSalt per op, index = circle i)
  ERASE_COUNT: 39,
  ERASE_X: 40,
  ERASE_Y: 41,
  ERASE_R: 42,
  // hatch (salt = hatchId, index = segment j)
  HATCH_JIT_X1: 43,
  HATCH_JIT_Y1: 44,
  HATCH_JIT_X2: 45,
  HATCH_JIT_Y2: 46,
  HATCH_WEIGHT: 47,
};

// =============================================================================
// Section: Numeric Mapping & Constraints
// =============================================================================

/**
 * Maps a value from range [a,b] to [c,d], optionally clamped.
 * @param {number} value
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @param {number} d
 * @param {boolean} [withinBounds=false]
 * @returns {number}
 */
export const map = (value, a, b, c, d, withinBounds = false) => {
  let r = c + ((value - a) / (b - a)) * (d - c);
  if (!withinBounds) return r;
  if (c < d) return constrain(r, c, d);
  else return constrain(r, d, c);
};

/**
 * Constrains a number within the provided bounds.
 * @param {number} n - The number.
 * @param {number} low - Lower bound.
 * @param {number} high - Upper bound.
 * @returns {number} The constrained number.
 */
export const constrain = (n, low, high) => Math.max(Math.min(n, high), low);

// =============================================================================
// Section: Angles
// =============================================================================

/**
 * Radians to degrees, wrapped into [0,360). No angle mode involved.
 * @param {number} rad
 * @returns {number}
 */
const radToDegrees = (rad) => {
  const angle = ((rad * 180) / Math.PI) % 360;
  return angle < 0 ? angle + 360 : angle;
};

/**
 * Converts radians to degrees, normalized to [0,360).
 * The host angle mode is per-context, hence the leading `ctx`.
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} rad
 * @returns {number}
 */
export const toDegrees = (ctx, rad, isRad = false) =>
  isRad || ctx.usesRadians() ? radToDegrees(rad) : rad;

/**
 * Converts radians to degrees without wrapping the result.
 * Preserves signed angles so downstream scaling keeps its direction.
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} angle
 * @param {boolean} [isRad=false]
 * @returns {number}
 */
export const toDegreesSigned = (ctx, angle, isRad = false) =>
  isRad || ctx.usesRadians()
    ? (angle * 180) / Math.PI
    : angle;

// =============================================================================
// Section: Geometry & Transforms
// =============================================================================

/**
 * Rotates point (x,y) around center (cx,cy) by angle degrees.
 * @param {number} cx
 * @param {number} cy
 * @param {number} x
 * @param {number} y
 * @param {number} angle - Degrees
 * @returns {{x:number,y:number}}
 */
export const rotate = (cx, cy, x, y, angle) => {
  const cs = cossin(angle);
  const coseno = cs[0], seno = cs[1];
  const nx = coseno * (x - cx) + seno * (y - cy) + cx;
  const ny = coseno * (y - cy) - seno * (x - cx) + cy;
  return { x: nx, y: ny };
};

/**
 * Euclidean distance between two points.
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {number}
 */
export const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

/**
 * Angle in degrees between two points, measured clockwise from +X.
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {number}
 */
export const calcAngle = (x1, y1, x2, y2) =>
  radToDegrees(Math.atan2(-(y2 - y1), x2 - x1));

/**
 * Intersection of two line segments, or false if none.
 * @param {{x:number,y:number}} s1a
 * @param {{x:number,y:number}} s1b
 * @param {{x:number,y:number}} s2a
 * @param {{x:number,y:number}} s2b
 * @param {boolean} [includeSegmentExtension=false]
 * @returns {{x:number,y:number}|false}
 */
export const intersectLines = (
  s1a,
  s1b,
  s2a,
  s2b,
  includeSegmentExtension = false
) => {
  const x1 = s1a.x, y1 = s1a.y;
  const x2 = s1b.x, y2 = s1b.y;
  const x3 = s2a.x, y3 = s2a.y;
  const x4 = s2b.x, y4 = s2b.y;
  const dx1 = x2 - x1, dy1 = y2 - y1;
  const dx2 = x4 - x3, dy2 = y4 - y3;
  // Handles parallel lines AND zero-length segments (denominator = 0 in both cases)
  const denom = dy2 * dx1 - dx2 * dy1;
  if (denom === 0) return false;
  const dy13 = y1 - y3, dx13 = x1 - x3;
  const ua = (dx2 * dy13 - dy2 * dx13) / denom;
  const ub = (dx1 * dy13 - dy1 * dx13) / denom;
  if (!includeSegmentExtension && (ub < 0 || ub > 1)) return false;
  return { x: x1 + ua * dx1, y: y1 + ua * dy1 };
};
