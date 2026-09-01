// =============================================================================
// Module: Fill
// =============================================================================
/**
 * The Fill module contains functions and classes dedicated to handling
 * the fill properties of shapes within the drawing context. It supports complex fill
 * operations with effects such as bleeding to simulate watercolor-like textures. The
 * methods provided allow for setting the fill color with opacity, controlling the
 * intensity of the bleed effect, and enabling or disabling the fill operation.
 *
 * The watercolor effect implementation is inspired by Tyler Hobbs'
 * techniques for simulating watercolor paints.
 */

// Core imports
import { Cwidth, Cheight, Density } from "../core/target.js";
import {
  Mix,
  State,
} from "../core/color.js";
import {
  constrain,
  map,
  gaussian,
  rotate,
  cossin,
  toDegreesSigned,
  _onSeed,
  STREAM,
  hashU32,
  rh,
  nh,
} from "../core/utils.js";
import { isFieldReady } from "../core/flowfield.js";
import { createColor, getAffineMatrix } from "../core/runtime.js";
import { Polygon } from "../core/polygon.js";
import { Plot } from "../core/plot.js";
import { Stats } from "../core/stats.js";
import { _getUseCpuWalk } from "../stroke/gl_draw.js";

// Internal module imports
import { initFillComposite } from "./composite.js";

initFillComposite(); // Register the fill composite with the core color module

// =============================================================================
// Fill State and helpers
// =============================================================================

// Vertex cap for grow() — set to 0 or false to disable
const GROW_MAX_VERTS = 2024;
let GROW_CAP;

// Reusable scratch arrays for grow() — avoids 4 allocations per call (~15× per fill)
let _growInsX = [];
let _growInsY = [];
let _growMods = [];
let _growDirs = [];

/**
 * Global fill state settings.
 */
State.fill = {
  opacity: 150,
  bleed_strength: 0.07,
  texture_strength: 0.8,
  border_strength: 0.5,
  direction: "out",
  angle: null,
  scatter: true,
  isActive: false,
};

// Cache the current state
const FillState = () => ({ ...State.fill });
const FillSetState = (state) => {
  State.fill = { ...state };
};

// ---------------------------------------------------------------------------
// Fill Style Functions
// ---------------------------------------------------------------------------

/**
 * Sets the fill color and opacity for subsequent drawing operations.
 * @param {number|string|Color} a - Either the red component, a CSS color string, or a Color object.
 * @param {number} [b] - The green component or the opacity if using grayscale.
 * @param {number} [c] - The blue component.
 * @param {number} [d] - The opacity.
 */
export function fill(a, b, c, d) {
  State.fill.opacity = (arguments.length < 4 ? b : d) || 150;
  State.fill.color = arguments.length < 3 ? createColor(a) : createColor(a, b, c);
  State.fill.isActive = true;
}

/**
 * Sets the bleed (watercolor) intensity and direction.
 * @param {number} _i - The bleed intensity (clamped to [0,1]).
 * @param {string} [_direction="out"] - The bleeding direction.
 * @param {number|null} [_angle=null] - Optional wash direction angle in current angle mode.
 */
export function fillBleed(_i, _direction = "out", _angle = null) {
  State.fill.bleed_strength = constrain(_i, 0, 1);
  State.fill.direction = _direction;
  State.fill.angle = _angle == null ? null : toDegreesSigned(_angle);
}

/**
 * Sets the texture and border strengths for the fill.
 * @param {number} [_texture=0.4] - The texture strength (clamped to [0,1]).
 * @param {number} [_border=0.4] - The border strength (clamped to [0,1]).
 * @param {boolean} [_scatter=true] - Whether to draw the scattered sparse polygon layers.
 *   Set to false to disable the scatter effect, which can help when a clean
 *   gradient trim is needed without extra texture noise at the edges.
 */
export function fillTexture(_texture = 0.4, _border = 0.4, _scatter = true) {
  State.fill.texture_strength = constrain(_texture, 0, 1);
  State.fill.border_strength = constrain(_border, 0, 1);
  State.fill.scatter = _scatter;
}

/**
 * Disables fill for subsequent drawing operations.
 */
export function noFill() {
  State.fill.isActive = false;
}

// ---------------------------------------------------------------------------
// Fill Manager Functions
// ---------------------------------------------------------------------------

let _polygon;
let _bbMinX, _bbMinY, _bbMaxX, _bbMaxY;

// Hash-stream scope counters (W1b). Each createFill() gets a fresh fill id;
// each randomized FillPoly operation (constructor setup, trim, grow, scatter,
// erase, fill-level draws) grabs the next op salt. The op ORDER is fixed
// control flow inside fill(), so (fillId, opId) is reproducible and is what
// the W2 grow-compute dispatch receives as a uniform.
let _fillId = 0;
let _fillOp = 0;
const nextOpSalt = () => (((_fillId << 10) + _fillOp++) >>> 0);

_onSeed(() => {
  _fillId = 0;
  _fillOp = 0;
});

// Pre-compute gaussians for reuse
const GAUSSIAN_POOL_SIZE = 512;
const _gaussians = [[], []]; // [a, b]
// Bumped whenever the pools are refilled, so the GPU producer can re-upload
// them exactly once per seed() instead of once per fill.
let _poolsVersion = 0;
function _fillGaussianPools() {
  for (let i = 0; i < GAUSSIAN_POOL_SIZE; i++) {
    _gaussians[0][i] = gaussian(0.5, 0.2);
    _gaussians[1][i] = gaussian(0, 0.02);
  }
  _poolsVersion++;
}
_onSeed(_fillGaussianPools);

function _fillStartIndex(pts, angle) {
  const cs = cossin(angle);
  const dx = cs[0], dy = -cs[1];
  let best = 0, bestDot = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dot = pts[i].x * dx + pts[i].y * dy;
    if (dot < bestDot) { bestDot = dot; best = i; }
  }
  return best;
}

/**
 * Calculates the centroid of a polygon from its vertices.
 * @param {Object[]} pts - Array of points with {x, y}.
 * @returns {Object} The center point {x, y}.
 */
function _center(pts) {
  const n = pts.length;
  if (n === 0) {
    return { x: 0, y: 0 };
  }

  if (n < 8) {
    // Simple average for small polygons
    let sumX = 0, sumY = 0;
    for (let i = 0; i < n; i++) { sumX += pts[i].x; sumY += pts[i].y; }
    return { x: sumX / n, y: sumY / n };
  }

  // Shoelace formula with implicit polygon closing (no array copy needed)
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 < n ? i + 1 : 0; // wrap around for closing edge
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    const cross = xi * yj - xj * yi;
    area += cross;
    cx += (xi + xj) * cross;
    cy += (yi + yj) * cross;
  }

  area *= 0.5;
  return area
    ? { x: cx / (6 * area), y: cy / (6 * area) }
    : { x: pts[0].x, y: pts[0].y };
}

/**
 * Fills a given polygon with a watercolor effect.
 * @param {Polygon} polygon - The polygon to fill.
 */
export function createFill(polygon) {
  if (!State.fill.isActive || !State.fill.color) {
    throw new Error(
      "No fill color set. Call brush.fill(color) before drawing shapes.",
    );
  }
  if (Stats.enabled) Stats.beginFill();
  _polygon = polygon;
  _bbMinX = Infinity; _bbMinY = Infinity; _bbMaxX = -Infinity; _bbMaxY = -Infinity;
  for (const [a] of polygon.sides) {
    if (a.x < _bbMinX) _bbMinX = a.x;
    if (a.x > _bbMaxX) _bbMaxX = a.x;
    if (a.y < _bbMinY) _bbMinY = a.y;
    if (a.y > _bbMaxY) _bbMaxY = a.y;
  }
  _fillId++;
  _fillOp = 0;
  const salt = nextOpSalt();
  const v = [...polygon.vertices];
  const _wr = rh(STREAM.FILL_WR, salt, 0, 0, 75);
  const fluid = ~~(v.length * 0.25 * (_wr < 5 ? 1 : _wr < 15 ? 2 : 3));
  const strength = State.fill.bleed_strength;
  const modifiers = v.map(
    (_, i) => (i > fluid ? 1 : 0.3) * rh(STREAM.FILL_MOD, salt, i, 0.85, 1.4) * strength,
  );
  const shift = State.fill.angle == null
    ? ~~rh(STREAM.FILL_SHIFT, salt, 0, 0, v.length)
    : _fillStartIndex(v, State.fill.angle);
  const n = v.length;
  const shifted = new Array(n);
  for (let i = 0; i < n; i++) shifted[i] = v[(i + shift) % n];
  const center = _center(shifted);
  return new FillPoly(shifted, modifiers, center, [], true).fill(
    State.fill.color,
    map(State.fill.opacity, 0, 255, 0, 1, true),
    State.fill.texture_strength,
  );
}

// ---------------------------------------------------------------------------
// FillPolygon Class
// ---------------------------------------------------------------------------

/**
 * The FillPolygon class is used to create and manage the properties of the polygons that produces
 * the watercolor effect. It includes methods to grow (expand) the polygon and apply layers
 * of color with varying intensity and erase parts to simulate a natural watercolor bleed.
 * The implementation follows Tyler Hobbs' guide to simulating watercolor:
 * https://tylerxhobbs.com/essays/2017/a-generative-approach-to-simulating-watercolor-paints
 */
class FillPoly {
  /**
   * Constructs a FillPolygon.
   * @param {Object[]} _v - Vertices of the polygon.
   * @param {number[]} _m - Multipliers for the bleed effect at each vertex.
   * @param {Object} _center - The polygon's center {x, y}.
   * @param {boolean[]} dir - Array indicating bleed direction per vertex.
   * @param {boolean} isFirst - True for initial polygon.
   */
  constructor(v, m, center, dir = [], isFirst = false, sx, sy) {
    // Initialize properties
    this.v = v;
    this.m = m;
    this.dir = dir;
    this.midP = center;

    // Initialize size and direction for first polygon
    if (isFirst) {
      // Calculate size bounds
      let maxX = 0,
        maxY = 0;
      const rayCalc = [];

      for (let i = 0; i < v.length; i++) {
        // Store vertex distances to center for size calculation
        const dx = Math.abs(center.x - v[i].x);
        const dy = Math.abs(center.y - v[i].y);
        maxX = Math.max(maxX, dx);
        maxY = Math.max(maxY, dy);

        // Store edge info for ray calculations
        const v1 = v[i],
          v2 = v[(i + 1) % v.length];
        const side = { x: v2.x - v1.x, y: v2.y - v1.y };
        const rt = rotate(0, 0, side.x, side.y, 90);
        const mid = { x: v1.x + side.x / 2, y: v1.y + side.y / 2 };

        rayCalc.push({
          v1,
          v2,
          ray: {
            point1: mid,
            point2: { x: mid.x + rt.x, y: mid.y + rt.y },
          },
        });
      }

      // Store sizes
      this.sizeX = maxX;
      this.sizeY = maxY;

      // Calculate directions — inline ray-polygon intersection to avoid
      // O(n) overhead of Polygon.intersect() (cache-key string building,
      // object allocation, intersectLines wrapper) per edge.
      const polySides = _polygon.sides;
      this.dir = Array(v.length);
      for (let i = 0; i < rayCalc.length; i++) {
        const rc = rayCalc[i];
        const r1x = rc.ray.point1.x, r1y = rc.ray.point1.y;
        const r2x = rc.ray.point2.x, r2y = rc.ray.point2.y;
        const rdx = r2x - r1x, rdy = r2y - r1y;
        // Precompute _isLeft threshold: _isLeft(v1,v2,P) = ua*(-|edgeSide|²) > 0.01
        const eSx = rc.v2.x - rc.v1.x, eSy = rc.v2.y - rc.v1.y;
        const eNeg = -(eSx * eSx + eSy * eSy); // always < 0
        let count = 0;
        for (let j = 0; j < polySides.length; j++) {
          const sa = polySides[j][0], sb = polySides[j][1];
          const sdx = sb.x - sa.x, sdy = sb.y - sa.y;
          const denom = sdy * rdx - sdx * rdy;
          if (denom === 0) continue;
          const ub = (rdx * (r1y - sa.y) - rdy * (r1x - sa.x)) / denom;
          if (ub < 0 || ub > 1) continue;
          const ua = (sdx * (r1y - sa.y) - sdy * (r1x - sa.x)) / denom;
          if (ua * eNeg <= 0.01) continue; // exact _isLeft equivalent, no ix/iy needed
          count++;
        }
        this.dir[i] = count % 2 === 0;
      }

      // Randomize center (single calculation)
      const csalt = nextOpSalt();
      const rx = rh(STREAM.FILL_CENTER_X, csalt, 0, -0.6, 0.6) * maxX;
      const ry = rh(STREAM.FILL_CENTER_Y, csalt, 0, -0.6, 0.6) * maxY;
      this.midP = { x: center.x + rx, y: center.y + ry };
    } else {
      this.sizeX = sx;
      this.sizeY = sy;
    }
  }

  /**
   * Trims vertices from the polygon based on a factor.
   * @param {number} [factor=1] - Factor determining amount of trimming.
   * @returns {Object} An object containing trimmed vertices, multipliers, and direction.
   */
  trim(f = 1) {
    // Fast path for common case
    if (f >= 1 || f < 0 || this.v.length <= 8) {
      return { v: this.v, m: this.m, dir: this.dir };
    }

    const totalN = this.v.length;
    const nTrim = ~~((1 - f) * totalN);
    const s = ~~(totalN / 2 - nTrim / 2);

    // Resolve the bridge endpoints first so they're available for edge-length
    // and density calculations below.
    const trimStart = s, trimEnd = s + nTrim;
    const eStart = this.v[(trimStart - 1 + totalN) % totalN];
    const eEnd   = this.v[trimEnd % totalN];
    const evx = eEnd.x - eStart.x, evy = eEnd.y - eStart.y;
    const edgeLen = Math.hypot(evx, evy);

    const salt = nextOpSalt();

    // Estimate typical vertex spacing from one random kept vertex pair,
    // then insert at least 0.2× that density along the bridge.
    const sampleIdx = s >= 2 ? ~~rh(STREAM.TRIM_SAMPLE, salt, 0, 0, s - 1) : (trimEnd < totalN - 1 ? trimEnd : 0);
    const sa = this.v[sampleIdx], sb = this.v[(sampleIdx + 1) % totalN];
    const typicalSpacing = Math.max(1, Math.hypot(sb.x - sa.x, sb.y - sa.y));
    const nInsert = Math.max(2, Math.ceil(edgeLen / typicalSpacing * 0.05));
    const finalLen = totalN - nTrim + nInsert;

    // Pre-allocate with final size — avoids splice() and element shifting
    const v = new Array(finalLen);
    const m = new Array(finalLen);
    const dir = new Array(finalLen);
    let dst = 0;

    for (let i = 0; i < s; i++, dst++) {
      v[dst] = this.v[i]; m[dst] = this.m[i]; dir[dst] = this.dir[i];
    }

    // Insert nInsert vertices evenly spaced along the bridge edge, with a
    // small jitter so the cut never renders as a ruler-straight line.
    const jitterAmt = edgeLen * 0.06;
    const dirBase = this.dir[trimStart % this.dir.length];
    for (let k = 0; k < nInsert; k++, dst++) {
      const t = (k + 1) / (nInsert + 1);
      v[dst] = { x: eStart.x + evx * t + rh(STREAM.TRIM_JIT_X, salt, k, -jitterAmt, jitterAmt),
                 y: eStart.y + evy * t + rh(STREAM.TRIM_JIT_Y, salt, k, -jitterAmt, jitterAmt) };
      m[dst] = rh(STREAM.TRIM_MOD, salt, k, 0.3, 0.5);
      dir[dst] = dirBase;
    }

    for (let i = trimEnd; i < totalN; i++, dst++) {
      v[dst] = this.v[i]; m[dst] = this.m[i]; dir[dst] = this.dir[i];
    }

    return { v, m, dir };
  }

  /**
   * Randomly samples a fraction of vertices, keeping their order.
   * Any sampled vertex outside the original polygon is pulled inward.
   * @param {number} [ratio=0.3] - Fraction of vertices to keep.
   * @returns {FillPoly} A new FillPoly with fewer vertices, guaranteed inside the original.
   */
  scatter(ratio = 0.3) {
    const L = this.v.length;
    const keep = Math.max(3, ~~(L * ratio));
    const step = L / keep;
    const stepRand = step * 0.8;

    const sv = [],
      sm = [],
      sd = [];
    const mid = this.midP;
    const sides = _polygon.sides;

    const salt = nextOpSalt();
    for (let i = 0; i < keep; i++) {
      const j = ~~(i * step + rh(STREAM.SCATTER_PICK, salt, i, 0, stepRand)) % L;
      let p = this.v[j];
      let outside = false;
      // Bounding box reject — vertex outside AABB is definitely outside polygon
      if (p.x < _bbMinX || p.x > _bbMaxX || p.y < _bbMinY || p.y > _bbMaxY) {
        outside = true;
      } else {
        let crossings = 0;
        for (const [a, b] of sides) {
          const ay = a.y,
            by = b.y;
          if ((ay > p.y) === (by > p.y)) continue;
          const t = (p.y - ay) / (by - ay);
          if (p.x < a.x + t * (b.x - a.x)) crossings++;
        }
        outside = crossings % 2 === 0;
      }
      if (outside) {
        p = {
          x: mid.x + (p.x - mid.x) * rh(STREAM.SCATTER_PULL_X, salt, i, 0.3, 0.6),
          y: mid.y + (p.y - mid.y) * rh(STREAM.SCATTER_PULL_Y, salt, i, 0.3, 0.6),
        };
      }
      sv.push(p);
      sm.push(this.m[j]);
      sd.push(!this.dir[j]);
    }

    return new FillPoly(sv, sm, this.midP, sd, false, this.sizeX, this.sizeY);
  }

  /**
   * Returns a copy with all bleed directions flipped.
   */
  flipDirs() {
    return new FillPoly(this.v, this.m, this.midP, this.dir.map(d => !d), false, this.sizeX, this.sizeY);
  }

  /**
   * Grows (or shrinks) the polygon vertices to simulate watercolor spread.
   * @param {number} [growthFactor=1] - Factor controlling growth.
   * @returns {FillPoly} A new FillPoly with adjusted vertices.
   */
  grow(f = 1) {
    const { v: tr_v, m: tr_m, dir: tr_dir } = this.trim(f);
    const len = tr_v.length;

    const outLen = len * 2;
    if (_growInsX.length < len) { _growInsX = new Array(len); _growInsY = new Array(len); }
    if (_growMods.length < outLen) { _growMods = new Array(outLen); _growDirs = new Array(outLen); }
    const insertedX = _growInsX;
    const insertedY = _growInsY;
    const newMods = _growMods;
    const newDirs = _growDirs;
    const bleedDirDeg = State.fill.direction === "out" ? -90 : 90;

    if (_gaussians[0].length === 0) _fillGaussianPools();
    const gPool = _gaussians[0],
      gPoolLen = gPool.length;
    const g2Pool = _gaussians[1],
      g2PoolLen = g2Pool.length;

    const salt = nextOpSalt();
    let idx = 0;
    let insertedIdx = 0;
    let mod = f === 999 ? rh(STREAM.GROW_MOD999, salt, 0, 0.6, 0.8) : State.fill.bleed_strength;

    // Pre-compute GROW_CAP step — if even step (step=2,4,...), all odd-indexed inserted
    // vertices will be discarded by downsampling. Skip cossin+rotation.
    // (Counter-based RNG: nothing to consume to keep sequences aligned.)
    const preStep = GROW_CAP && len * 2 > GROW_CAP ? Math.ceil(len * 2 / GROW_CAP) : 1;
    const skipInserted = preStep >= 2 && (preStep & 1) === 0;

    if (skipInserted) {
      // Fast path: inserted vertices will be discarded by GROW_CAP step=2.
      // Result is exactly the trimmed polygon — skip all array writes.
      return new FillPoly(tr_v, tr_m, this.midP, tr_dir, false, this.sizeX, this.sizeY);
    } else {
    for (let i = 0; i < len; i++) {
      const cv = tr_v[i];
      const nv = tr_v[i + 1 < len ? i + 1 : 0];
      const mi = tr_m[i];
      const di = tr_dir[i];

      if (f < 997) mod = mi;

      // If mod is smaller than 0.02, skip growing math and just insert the middle vertex
      if (mod < 0.05) {
        newMods[idx] = mi;
        newDirs[idx] = di;
        idx++;
        insertedX[insertedIdx] = (cv.x + nv.x) / 2;
        insertedY[insertedIdx] = (cv.y + nv.y) / 2;
        newMods[idx] = mi;
        newDirs[idx] = di;
        idx++;
        insertedIdx++;
        continue;
      }

      const rotDeg = (di ? bleedDirDeg : -bleedDirDeg) + rh(STREAM.GROW_ROT, salt, i, -1, 1) * 5;
      const _cs = cossin(rotDeg);
      const c = _cs[0], s = _cs[1];

      const sideX = nv.x - cv.x;
      const sideY = nv.y - cv.y;
      const dirX = c * sideX + s * sideY;
      const dirY = c * sideY - s * sideX;

      const d = gPool[hashU32(STREAM.GROW_DIST_POOL, salt, i) % gPoolLen] *
        rh(STREAM.GROW_DIST_SCALE, salt, i, 0.65, 1.35) * mod;
      const nextMod = mi + g2Pool[hashU32(STREAM.GROW_MOD_POOL, salt, i) % g2PoolLen];

      newMods[idx] = mi;
      newDirs[idx] = di;
      idx++;

      insertedX[insertedIdx] = cv.x + sideX * 0.5 + dirX * d;
      insertedY[insertedIdx] = cv.y + sideY * 0.5 + dirY * d;
      newMods[idx] = nextMod;
      newDirs[idx] = di;
      idx++;
      insertedIdx++;
    }
    }

    let fv,
      fm,
      fd;
    
    if (GROW_CAP && idx > GROW_CAP) {
      const step = Math.ceil(idx / GROW_CAP);
      const kept = Math.ceil(idx / step);
      fv = new Array(kept);
      fm = new Array(kept);
      fd = new Array(kept);
      let dst = 0;
      for (let j = 0; j < idx; j += step, dst++) {
        fv[dst] =
          j % 2 === 0
            ? tr_v[j >> 1]
            : { x: insertedX[j >> 1], y: insertedY[j >> 1] };
        fm[dst] = newMods[j];
        fd[dst] = newDirs[j];
      }
    } else {
      fv = new Array(idx);
      for (let j = 0; j < idx; j++) {
        fv[j] =
          j % 2 === 0
            ? tr_v[j >> 1]
            : { x: insertedX[j >> 1], y: insertedY[j >> 1] };
      }
      fm = newMods.slice(0, idx);
      fd = newDirs.slice(0, idx);
    }
    return new FillPoly(fv, fm, this.midP, fd, false, this.sizeX, this.sizeY);
  }

  /**
   * Fills the polygon with multiple layers to simulate a watercolor effect.
   * @param {Color|string} color - The fill color.
   * @param {number} intensity - Opacity intensity (mapped from 0 to 1).
   * @param {number} tex - Texture factor.
   */
  /**
   * The layer border width and the two alphas, shared verbatim by the CPU
   * and GPU producers (see GpuFillPoly.layer) so there is one source of
   * truth for the arithmetic.
   */
  _layerStyle(i, size, int) {
    return {
      lineWidth:
        map(i, 0, 24, size / 25, size / 30, true) * State.fill.border_strength,
      // canvas2d "rgb(255 0 0 / int%)": percentage alpha, clamped to 100%.
      fillAlpha: Math.min(100, Math.max(0, int)) / 100,
      borderAlpha: State.fill.border_strength * 0.01,
    };
  }

  fill(color, intensity, tex) {
    const numLayers = 20;
    const texture = tex * 3;
    const int = 2 * intensity * (1 + tex / 2);

    const switchingToFill = Mix.isBrush !== false;
    Mix.isBrush = false;
    if (switchingToFill) Mix.justChanged = true;
    Mix.blend(color);

    // W3: the fill matrix is a plain object handed to the GPU fill
    // surface (was ctx.setTransform + ctx.getTransform round trip).
    const m = getAffineMatrix();
    const fillMatrix = {
      a: Density * m.a,
      b: Density * m.b,
      c: Density * m.c,
      d: Density * m.d,
      e: Density * (m.x + Cwidth / 2),
      f: Density * (m.y + Cheight / 2),
    };
    GROW_CAP = GROW_MAX_VERTS * Math.max(0.2, 2 * State.fill.bleed_strength);
    const size = Math.max(this.sizeX, this.sizeY);
    const darker = rh(STREAM.FILL_DARKER, nextOpSalt(), 0, 0.15, 0.7);

    // W5: `root` is either `this` (the retained CPU producer) or a
    // GpuFillPoly handle. Everything below is producer-agnostic — one
    // control flow, so the op order (and therefore the salt sequence) can
    // never drift between the two.
    const root = _tryGpuFill(this, fillMatrix, size) ?? this;
    try {
      this._fillBody(root, numLayers, texture, int, intensity, size, darker, color, fillMatrix);
    } finally {
      if (root !== this) Mix.ctx.endGpuFill();
    }

    if (Stats.enabled) Stats.endFill();
  }

  /** @private the layer schedule; see fill() for the producer routing. */
  _fillBody(root, numLayers, texture, int, intensity, size, darker, color, fillMatrix) {
    let pol = root.grow();
    const sparse = root.scatter(0.1).grow().scatter(0.75).flipDirs();
    let pols;

    for (let i = 0; i < numLayers; i++) {
      if (i % 4 === 0) {
        pol = pol.grow();
      }

      if (i % 2 === 0) {
        pols = [
          pol.grow(1 - 0.0125 * i),
          pol.grow(0.7 - 0.0125 * i),
          pol.grow(0.4 - 0.0125 * i),
        ];
      }

      for (const p of pols) {
        const grown = p.grow(999).grow(997);
        grown.layer(i, size, int, fillMatrix);
      }
      if (State.fill.scatter) {
        const sparseLayer = sparse.grow(999).flipDirs().grow(997);
        sparseLayer.layer(i, size, int * texture, fillMatrix);
      }
      if (i % 2 === 0) {
        const darkerLayer = pol.grow(darker).grow(999);
        darkerLayer.layer(i, size, int * 2, fillMatrix);
      }

      if (i % 8 === 0 || i === numLayers - 1) {
        if (texture !== 0) {
          pol.erase(texture * 3, intensity, fillMatrix);
        }
        Mix.blend(color, true);
      }
    }
  }

  /**
   * Draws a layer of the fill polygon with stroke and fill.
   * @param {number} i - The layer index.
   */
  layer(i, size, int, matrix) {
    if (Stats.enabled) {
      Stats.recordLayer(i, this.v.length);
      for (let k = 0; k < this.v.length; k++) Stats.hashNums(this.v[k].x, this.v[k].y);
    }
    const { lineWidth, fillAlpha, borderAlpha } = this._layerStyle(i, size, int);
    Mix.ctx.layer(this.v, matrix, fillAlpha, lineWidth, borderAlpha);
  }

  /**
   * Erases parts of the polygon to create a natural watercolor texture.
   * @param {number} texture - Texture strength factor.
   * @param {number} intensity - Intensity value for size scaling.
   */
  /**
   * Everything erase() needs except the SALT — all of it CPU-known, because
   * sizeX/sizeY/midP are constant along a whole FillPoly chain. The GPU
   * producer takes exactly this record; only the salt (and therefore the
   * circle count) has to be resolved GPU-side, since the op counter lives
   * there. Shared so the two producers cannot drift.
   */
  _eraseParams(texture, intensity) {
    const minSize = Math.min(this.sizeX, this.sizeY) * 1.3;
    return {
      countFactor: map(texture, 0, 1, 2, 3.5),
      halfSizeX: this.sizeX / 1.3,
      halfSizeY: this.sizeY / 1.3,
      minSizeFactor: 0.03 * minSize,
      maxSizeFactor: 0.45 * minSize,
      midX: this.midP.x,
      midY: this.midP.y,
      alpha: ((5 - map(intensity, 80, 100, 0.3, 0.7, true)) * texture) / 255,
    };
  }

  erase(texture, intensity, matrix) {
    const salt = nextOpSalt();
    const p = this._eraseParams(texture, intensity);
    const numCircles = ~~(rh(STREAM.ERASE_COUNT, salt, 0, 80, 110) * p.countFactor);
    const halfSizeX = p.halfSizeX;
    const halfSizeY = p.halfSizeY;
    const minSizeFactor = p.minSizeFactor;
    const maxSizeFactor = p.maxSizeFactor;
    const midX = p.midX;
    const midY = p.midY;
    const alpha = p.alpha;

    // Same draws/skips as the canvas2d path: every circle consumes its RNG
    // draws, but circles at i % 5 == 0 were never filled (their path was
    // discarded by the next beginPath) — they are not queued.
    const circles = [];
    for (let i = 0; i < numCircles; i++) {
      const x = midX + nh(STREAM.ERASE_X, salt, i, 0, halfSizeX);
      const y = midY + nh(STREAM.ERASE_Y, salt, i, 0, halfSizeY);
      const radius = rh(STREAM.ERASE_R, salt, i, minSizeFactor, maxSizeFactor);
      if (Stats.enabled) Stats.hashNums(x, y, radius);
      if (i % 5 !== 0) circles.push(x, y, radius);
    }
    Mix.ctx.erase(circles, matrix, alpha);
  }
}

// ---------------------------------------------------------------------------
// GPU-resident FillPoly (W5)
//
// A handle into the grow-compute poly pool wearing FillPoly's interface, so
// FillPoly.fill() below drives ONE control flow for both producers. Nothing
// here reads a vertex: grow/scatter/erase record compute dispatches, layer()
// records a drawIndirect. sizeX/sizeY/midP are CPU-side because they are
// invariant along a chain (every FillPoly constructor passes them through).
//
// flipDirs() is a lazy flag rather than a copy kernel: fill() only ever
// consumes a flipDirs() result with a grow, and grow reads the source dirs
// inverted when asked.
// ---------------------------------------------------------------------------

class GpuFillPoly {
  constructor(surface, handle, sizeX, sizeY, midP, flip = false) {
    this.s = surface;
    this.h = handle;
    this.sizeX = sizeX;
    this.sizeY = sizeY;
    this.midP = midP;
    this.flip = flip;
  }

  _wrap(handle) {
    return new GpuFillPoly(this.s, handle, this.sizeX, this.sizeY, this.midP);
  }

  grow(f = 1) {
    return this._wrap(this.s.gpuFill.recordGrow(this.h, f, this.flip));
  }

  scatter(ratio = 0.3) {
    if (this.flip) {
      // fill() never does this; a copy kernel would be needed if it did.
      throw new Error("gpu-fill: scatter() after flipDirs() is unsupported");
    }
    return this._wrap(this.s.gpuFill.recordScatter(this.h, ratio));
  }

  flipDirs() {
    return new GpuFillPoly(
      this.s,
      this.h,
      this.sizeX,
      this.sizeY,
      this.midP,
      !this.flip,
    );
  }

  layer(i, size, int, matrix) {
    const { lineWidth, fillAlpha, borderAlpha } = FillPoly.prototype._layerStyle.call(
      this,
      i,
      size,
      int,
    );
    this.s.layerGpu(this.h, matrix, fillAlpha, lineWidth, borderAlpha);
  }

  erase(texture, intensity, matrix) {
    const p = FillPoly.prototype._eraseParams.call(this, texture, intensity);
    // rh(..., 80, 110) bounds the count draw, so the arena reservation is a
    // pure CPU decision even though the count itself is resolved GPU-side.
    const maxCircles = Math.ceil(110 * p.countFactor) + 1;
    const { handle, base } = this.s.gpuFill.recordErase(p, maxCircles);
    this.s.eraseGpu(handle, base, matrix, p.alpha);
  }
}

/**
 * Opens a GPU-resident fill for `poly`, or returns null when the GPU path is
 * unavailable or deliberately bypassed:
 *   - `Stats.enabled` — structural capture reads CPU vertex arrays.
 *   - `brush.useCpuGeometry(true)` — the documented CPU producer switch.
 *   - no WebGPU fill driver, or a polygon past the poly-buffer capacity.
 */
function _tryGpuFill(poly, matrix, size) {
  if (Stats.enabled || _getUseCpuWalk()) return null;
  const surface = Mix.ctx;
  const driver = surface?.gpuFill;
  if (!driver || typeof surface.beginGpuFill !== "function") return null;
  const n = poly.v.length;
  if (n < 3 || n > driver.capacity) return null;
  if (_gaussians[0].length === 0) _fillGaussianPools();
  // The gaussian pools are DATA (drawn by the seeded sequential generator at
  // seed() time); the shader only hashes an INDEX into them.
  driver.uploadPoolsIfStale(_poolsVersion, _gaussians[0], _gaussians[1]);
  const polyVerts = _polygon.vertices;
  const rootVerts = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    rootVerts[2 * i] = poly.v[i].x;
    rootVerts[2 * i + 1] = poly.v[i].y;
  }
  const sides = new Float32Array(2 * polyVerts.length);
  for (let i = 0; i < polyVerts.length; i++) {
    sides[2 * i] = polyVerts[i].x;
    sides[2 * i + 1] = polyVerts[i].y;
  }
  const handle = surface.beginGpuFill({
    rootVerts,
    rootMods: poly.m,
    rootDirs: poly.dir,
    midP: poly.midP,
    sizeX: poly.sizeX,
    sizeY: poly.sizeY,
    polygonVerts: sides,
    polygonBBox: { minX: _bbMinX, minY: _bbMinY, maxX: _bbMaxX, maxY: _bbMaxY },
    fillId: _fillId,
    opCounter: _fillOp,
    bleedStrength: State.fill.bleed_strength,
    direction: State.fill.direction,
    growCap: GROW_CAP,
    matrix,
    // The border is widest at layer 0 — that sets the dirty-rect padding.
    maxLineWidth: (size / 25) * State.fill.border_strength,
  });
  return new GpuFillPoly(surface, handle, poly.sizeX, poly.sizeY, poly.midP);
}

// ---------------------------------------------------------------------------
// Test-only exports (W3). grow-cpu-ref.js currently rebuilds FillPoly by
// extracting trim()/grow() source text; this export lets the oracle move
// to the real class. setScope wires the module-level randomness scope the
// methods read (fill id / op counter / GROW_CAP / gaussian pools).
// Not public API.
// ---------------------------------------------------------------------------

/**
 * W5 test instrumentation (not API): the GPU fill driver's op counters, so
 * the oracle can assert routing rather than infer it from pixels.
 */
export function _fillDriverStats() {
  return Mix.ctx?.gpuFill?.stats ?? null;
}

export const _test = {
  get FillPoly() {
    return FillPoly;
  },
  setScope({ fillId, op, growCap, gaussians } = {}) {
    if (fillId !== undefined) _fillId = fillId;
    if (op !== undefined) _fillOp = op;
    if (growCap !== undefined) GROW_CAP = growCap;
    if (gaussians !== undefined) {
      _gaussians[0] = [...gaussians[0]];
      _gaussians[1] = [...gaussians[1]];
    }
  },
  getOp: () => _fillOp,
};

// ---------------------------------------------------------------------------
// Extend Polygon and Plot Prototypes for Fill
// ---------------------------------------------------------------------------

/**
 * Applies a fill effect to the polygon using the current fill state.
 * @param {Color|string} [_color] - The color for the fill.
 * @param {number} [_opacity] - The opacity value.
 * @param {number} [_bleed] - The bleed intensity.
 * @param {number} [_texture] - The texture strength.
 * @param {number} [_border] - The border strength.
 * @param {string} [_direction] - The bleed direction.
 * @param {number|null} [_angle] - Optional wash direction angle in current angle mode.
 */
Polygon.prototype.fill = function (
  _color = false,
  _opacity,
  _bleed,
  _texture,
  _border,
  _direction,
  _angle,
) {
  let state = FillState();
  if (_color) {
    fill(_color, _opacity);
    fillBleed(_bleed, _direction, _angle);
    fillTexture(_texture, _border);
  }
  if (state.isActive) {
    isFieldReady();
    createFill(this);
  }
  FillSetState(state);
  return this;
};

/**
 * Fills a plot on the canvas by generating a polygon based on the provided coordinates.
 * @param {number} x - The x-coordinate.
 * @param {number} y - The y-coordinate.
 * @param {number} scale - Scaling factor.
 */
Plot.prototype.fill = function (x, y, scale) {
  if (FillState().isActive) {
    if (this.origin) ((x = this.origin[0]), (y = this.origin[1]), (scale = 1));
    this.pol = this.genPol(
      x,
      y,
      scale,
      State.fill.bleed_strength < 0.06
      ? 0
      : map(State.fill.bleed_strength, 0, 0.6, 0.2, 0.60, true),
    );
    this.pol.fill();
  }
};
