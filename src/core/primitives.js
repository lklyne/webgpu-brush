import {
  sin,
  cos,
  toDegreesSigned,
  constrain,
  dist,
  calcAngle,
  intersectLines,
} from "./utils.js";
import { Polygon } from "./polygon.js";
import { Plot } from "./plot.js";
import { defaultContext, registerContextInit } from "./context.js";

// =============================================================================
// Section: Primitives and Geommetry
// =============================================================================

/**
 * Creates a Polygon from an array of points and calls its show() method.
 * Polygons ignore fields and won't be good for fills and masses
 * @param {Array<Array<number>>} pointsArray - Array of points [x, y, pressure]
 */
export function polygon(pointsArray) {
  return _polygon(defaultContext, pointsArray);
}

/**
 * Context-taking implementation of polygon().
 * @param {import("./context.js").BrushContext} ctx
 * @param {Array<Array<number>>} pointsArray - Array of points [x, y, pressure]
 */
export function _polygon(ctx, pointsArray) {
  // Create a new Polygon instance. It draws through the prototype patches,
  // which resolve their painting from `owner`, so tag it with this one.
  const polygon = new Polygon(pointsArray);
  polygon.owner = ctx;
  polygon.show();
  return polygon;
}

/**
 * Draws a rectangle on the canvas using path functions.
 * @param {number} x - X-coordinate.
 * @param {number} y - Y-coordinate.
 * @param {number} w - Width.
 * @param {number} h - Height.
 * @param {boolean} [mode="corner"] - "corner" (default) or "center".
 */
export function rect(x, y, w, h, mode = "corner") {
  return _rect(defaultContext, x, y, w, h, mode);
}

/**
 * Context-taking implementation of rect().
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} x - X-coordinate.
 * @param {number} y - Y-coordinate.
 * @param {number} w - Width.
 * @param {number} h - Height.
 * @param {string} [mode="corner"] - "corner" (default) or "center".
 */
export function _rect(ctx, x, y, w, h, mode = "corner") {
  if (mode === "center") {
    x -= w / 2;
    y -= h / 2;
  }
  _beginShape(ctx, 0);
  _vertex(ctx, x, y);
  _vertex(ctx, x + w, y);
  _vertex(ctx, x + w, y + h);
  _vertex(ctx, x, y + h);
  _endShape(ctx, true);
}

/**
 * Draws a circle on the canvas.
 * @param {number} x - Center x.
 * @param {number} y - Center y.
 * @param {number} radius - Circle radius.
 * @param {boolean} [r=false] - Randomizes segment lengths if true.
 */
export function circle(x, y, radius, r = false) {
  return _circle(defaultContext, x, y, radius, r);
}

/**
 * Context-taking implementation of circle().
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} x - Center x.
 * @param {number} y - Center y.
 * @param {number} radius - Circle radius.
 * @param {boolean} [r=false] - Randomizes segment lengths if true.
 */
export function _circle(ctx, x, y, radius, r = false) {
  const rng = ctx.rng;
  const p = new Plot("curve");
  p.owner = ctx;
  const arcLength = Math.PI * radius;
  const angleOffset = rng.rr2(0, 360);
  const randomFactor = r ? () => 1 + r * 0.2 * rng.rr2() : () => 1;

  // Divide circle into 4 segments
  for (let i = 0; i < 4; i++) {
    const angle = -90 * i + angleOffset;
    p.addSegment(
      angle * randomFactor(),
      (arcLength / 2) * randomFactor(),
      1,
      true,
    );
  }

  // Optionally add a random final angle for the last segment
  if (r) {
    const randomAngle = r * rng.randInt2(-5, 5);
    p.addSegment(
      angleOffset,
      Math.abs(randomAngle) * (Math.PI / 180) * radius,
      1,
      true,
    );
    p.endPlot(randomAngle + angleOffset, 1, true);
  } else {
    p.endPlot(angleOffset, 1, true);
  }

  // Draw the circle
  const offsetX = x - radius * sin(angleOffset);
  const offsetY = y - radius * cos(-angleOffset);
  p.show(offsetX, offsetY, 1);
  return [p, offsetX, offsetY];
}

/**
 * Draws an arc on the canvas.
 * @param {number} x - Center x.
 * @param {number} y - Center y.
 * @param {number} radius - Radius.
 * @param {number} start - Start angle in the current runtime angle units.
 * @param {number} end - End angle in the current runtime angle units.
 * @returns {Plot|null} The drawn Plot, or null when the sweep is zero.
 */
export function arc(x, y, radius, start, end) {
  return _arc(defaultContext, x, y, radius, start, end);
}

/**
 * Context-taking implementation of arc().
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} x - Center x.
 * @param {number} y - Center y.
 * @param {number} radius - Radius.
 * @param {number} start - Start angle in the current runtime angle units.
 * @param {number} end - End angle in the current runtime angle units.
 * @returns {Plot|null} The drawn Plot, or null when the sweep is zero.
 */
export function _arc(ctx, x, y, radius, start, end) {
  const startDeg = toDegreesSigned(ctx, start);
  const endDeg = toDegreesSigned(ctx, end);
  const sweepDeg = ((endDeg - startDeg) % 360 + 360) % 360;
  if (sweepDeg === 0) return null;

  const p = new Plot("curve");
  p.owner = ctx;
  const segmentCount = Math.max(1, Math.ceil(sweepDeg / 90));
  const segmentSweep = sweepDeg / segmentCount;
  const arcLength = (Math.PI * radius * segmentSweep) / 180;

  for (let i = 0; i < segmentCount; i++) {
    p.addSegment(startDeg + i * segmentSweep + 90, arcLength, 1, true);
  }
  p.endPlot(startDeg + sweepDeg + 90, 1, true);

  const startX = x + radius * cos(startDeg);
  const startY = y - radius * sin(startDeg);
  p.draw(startX, startY, 1);
  return p;
}

// ---------------------------------------------------------------------------
// In-flight path and stroke cursors
// ---------------------------------------------------------------------------

/**
 * The open beginShape()/vertex()/endShape() path and the open
 * beginStroke()/move()/endStroke() plot. One set per context, so two
 * paintings can each have a shape open.
 */
function createShapeCursor() {
  return {
    /** @type {SubPath|false|undefined} open beginShape() path */
    current: undefined,
    /** curvature captured by the open beginShape() */
    curvature: undefined,
    /** @type {Plot|false|undefined} open beginStroke() plot */
    strokeArray: undefined,
    /** @type {number[]|undefined} [x, y] origin of the open stroke */
    strokeOrigin: undefined,
  };
}

registerContextInit((ctx) => {
  ctx.shape = createShapeCursor();
});

class SubPath {
  constructor(curvature) {
    this.isClosed = false;
    this.curvature = curvature;
    this.vert = [];
  }
  /**
   * Adds a vertex to this subpath.
   * @param {number} x
   * @param {number} y
   * @param {number} pressure
   */
  vertex(x, y, pressure) {
    this.vert.push([x, y, pressure]);
  }
  /**
   * Renders the subpath by creating a spline from its vertices.
   * @param {import("./context.js").BrushContext} ctx
   */
  show(ctx) {
    let plot = _createSpline(ctx, this.vert, this.curvature, this.isClosed);
    plot.show();
    return plot;
  }
}

/**
 * Begins a new path with a specified curvature.
 * @param {number} [curvature=0] - Curvature from 0 to 1.
 */
export function beginShape(curvature = 0) {
  return _beginShape(defaultContext, curvature);
}

/**
 * Context-taking implementation of beginShape().
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} [curvature=0] - Curvature from 0 to 1.
 */
export function _beginShape(ctx, curvature = 0) {
  const shape = ctx.shape;
  shape.curvature = constrain(curvature, 0, 1);
  shape.current = new SubPath(shape.curvature);
}

/**
 * Adds a line segment from the current point to the given coordinates.
 * @param {number} x - X-coordinate.
 * @param {number} y - Y-coordinate.
 * @param {number} [pressure=1] - Pressure value.
 */
export function vertex(x, y, pressure = 1) {
  return _vertex(defaultContext, x, y, pressure);
}

/**
 * Context-taking implementation of vertex().
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} x - X-coordinate.
 * @param {number} y - Y-coordinate.
 * @param {number} [pressure=1] - Pressure value.
 */
export function _vertex(ctx, x, y, pressure = 1) {
  const open = ctx.shape.current;
  if (!open) {
    throw new Error(
      "vertex() called outside of beginShape()/endShape(). Call beginShape() first.",
    );
  }
  open.vertex(x, y, pressure);
}

/**
 * Ends the current path and renders all subpaths.
 * @returns {Plot} The rendered Plot for the completed shape.
 */
export function endShape(close = false) {
  return _endShape(defaultContext, close);
}

/**
 * Context-taking implementation of endShape().
 * @param {import("./context.js").BrushContext} ctx
 * @param {boolean} [close=false] - Whether to close the shape.
 * @returns {Plot} The rendered Plot for the completed shape.
 */
export function _endShape(ctx, close = false) {
  const open = ctx.shape.current;
  if (!open) {
    throw new Error(
      "endShape() called without beginShape(). Call beginShape() first.",
    );
  }
  if (open.vert.length < 2) {
    throw new Error(
      "endShape() requires at least 2 vertices. Add more with vertex().",
    );
  }
  if (close) {
    open.vertex(...open.vert[0]);
    open.isClosed = true;
  }
  const plot = open.show(ctx);
  ctx.shape.current = false;
  return plot;
}

/**
 * Begins a new stroke with a given type and starting position.
 * @param {string} type - Stroke type.
 * @param {number} x - Starting x.
 * @param {number} y - Starting y.
 */
export function beginStroke(type, x, y) {
  return _beginStroke(defaultContext, type, x, y);
}

/**
 * Context-taking implementation of beginStroke().
 * @param {import("./context.js").BrushContext} ctx
 * @param {string} type - Stroke type.
 * @param {number} x - Starting x.
 * @param {number} y - Starting y.
 */
export function _beginStroke(ctx, type, x, y) {
  if (type !== "curve" && type !== "segments") {
    throw new Error(
      `beginStroke() type must be "curve" or "segments", got "${type}".`,
    );
  }
  ctx.shape.strokeOrigin = [x, y];
  ctx.shape.strokeArray = new Plot(type);
  ctx.shape.strokeArray.owner = ctx;
}

/**
 * Adds a segment to the stroke.
 * @param {number} angle - Segment angle.
 * @param {number} length - Segment length.
 * @param {number} pressure - Segment pressure.
 */
export function move(angle, length, pressure) {
  return _move(defaultContext, angle, length, pressure);
}

/**
 * Context-taking implementation of move().
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} angle - Segment angle.
 * @param {number} length - Segment length.
 * @param {number} pressure - Segment pressure.
 */
export function _move(ctx, angle, length, pressure) {
  const open = ctx.shape.strokeArray;
  if (!open) {
    throw new Error(
      "move() called without beginStroke(). Call beginStroke() first.",
    );
  }
  open.addSegment(angle, length, pressure);
}

/**
 * Completes and renders the stroke.
 * @param {number} angle - End angle.
 * @param {number} pressure - End pressure.
 */
export function endStroke(angle, pressure) {
  return _endStroke(defaultContext, angle, pressure);
}

/**
 * Context-taking implementation of endStroke().
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} angle - End angle.
 * @param {number} pressure - End pressure.
 */
export function _endStroke(ctx, angle, pressure) {
  const shape = ctx.shape;
  const open = shape.strokeArray;
  if (!open) {
    throw new Error(
      "endStroke() called without beginStroke(). Call beginStroke() first.",
    );
  }
  open.endPlot(angle, pressure);
  open.draw(shape.strokeOrigin[0], shape.strokeOrigin[1], 1);
  shape.strokeArray = false;
}

/**
 * Creates and draws a spline curve from an array of points.
 * @param {Array<Array<number>>} array_points - Array of points [x, y, pressure].
 * @param {number} [curvature=0.5] - Curvature from 0 to 1.
 */
export function spline(_array_points, _curvature = 0.5) {
  return _spline(defaultContext, _array_points, _curvature);
}

/**
 * Context-taking implementation of spline().
 * @param {import("./context.js").BrushContext} ctx
 * @param {Array<Array<number>>} _array_points - Array of points [x, y, pressure].
 * @param {number} [_curvature=0.5] - Curvature from 0 to 1.
 */
export function _spline(ctx, _array_points, _curvature = 0.5) {
  if (!_array_points || _array_points.length < 2) {
    throw new Error(
      "spline() requires at least 2 points. Each point should be [x, y, pressure].",
    );
  }
  let p = _createSpline(ctx, _array_points, _curvature);
  p.show();
  return p;
}

/**
 * Creates a new Plot object representing a spline curve.
 *
 * For curved segments (curvature > 0) with at least 3 points available,
 * the function either treats segments as straight (if their angles match)
 * or calculates control points to compute a circular arc.
 *
 * If no curvature is specified, a simple straight segment is used.
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {Array<Array<number>>} points - Array of points [x, y, pressure].
 * @param {number} [curvature=0.5] - Curvature value between 0 and 1.
 * @param {boolean} [close=false] - Whether to close the spline.
 * @returns {Plot} - The generated Plot object.
 */
function _createSpline(ctx, points, curvature = 0.5, close = false) {
  const plotType = curvature === 0 ? "segments" : "curve";
  const p = new Plot(plotType);
  p.owner = ctx;
  const PI2 = Math.PI * 2;

  // If closing the spline, add the second point to the end
  if (close && curvature !== 0) {
    points.push(points[1]);
  }

  if (points && points.length > 0) {
    let done = 0; // Tracks excess length from previous segment
    let pep, tep, pep2; // Variables used for initial calibration

    for (let i = 0; i < points.length - 1; i++) {
      // For curved segments (if curvature > 0 and there is at least 3 points ahead)
      if (curvature > 0 && i < points.length - 2) {
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2];

        const d1 = dist(p1[0], p1[1], p2[0], p2[1]);
        const d2 = dist(p2[0], p2[1], p3[0], p3[1]);
        const a1 = calcAngle(p1[0], p1[1], p2[0], p2[1]);
        const a2 = calcAngle(p2[0], p2[1], p3[0], p3[1]);

        // Compute the adjustment length based on curvature
        const curvAdjust = curvature * Math.min(d1, d2, 0.5 * Math.min(d1, d2));
        const dmax = Math.max(d1, d2);
        const s1 = d1 - curvAdjust;
        const s2 = d2 - curvAdjust;

        if (Math.floor(a1) === Math.floor(a2)) {
          // If angles are nearly the same, treat as a straight segment
          const temp = close ? (i === 0 ? 0 : d1 - done) : d1 - done;
          const temp2 = close ? (i === 0 ? 0 : d2 - pep2) : d2;

          p.addSegment(a1, temp, p1[2], true);
          if (i === points.length - 3) {
            p.addSegment(a2, temp2, p2[2], true);
          }

          done = 0;
          if (i === 0) {
            pep = d1;
            pep2 = curvAdjust;
            tep = points[1];
            done = 0;
          }
        } else {
          // For a curved segment, compute control points and arc segment details
          const point1 = {
            x: p2[0] - curvAdjust * cos(-a1),
            y: p2[1] - curvAdjust * sin(-a1),
          };
          const point2 = {
            x: point1.x + dmax * cos(-a1 + 90),
            y: point1.y + dmax * sin(-a1 + 90),
          };
          const point3 = {
            x: p2[0] + curvAdjust * cos(-a2),
            y: p2[1] + curvAdjust * sin(-a2),
          };
          const point4 = {
            x: point3.x + dmax * cos(-a2 + 90),
            y: point3.y + dmax * sin(-a2 + 90),
          };

          const intPt = intersectLines(point1, point2, point3, point4, true);
          const radius = dist(point1.x, point1.y, intPt.x, intPt.y);
          const halfDist = dist(point1.x, point1.y, point3.x, point3.y) / 2;
          const arcAngle = 2 * Math.asin(halfDist / radius) * (180 / Math.PI);
          const arcLength = (PI2 * radius * arcAngle) / 360;

          const temp = close ? (i === 0 ? 0 : s1 - done) : s1 - done;
          const temp2 =
            i === points.length - 3 ? (close ? pep - curvAdjust : s2) : 0;

          p.addSegment(a1, temp, p1[2], true);
          p.addSegment(a1, isNaN(arcLength) ? 0 : arcLength, p1[2], true);
          p.addSegment(a2, temp2, p2[2], true);

          done = curvAdjust;
          if (i === 0) {
            pep = s1;
            pep2 = curvAdjust;
            tep = [point1.x, point1.y];
          }
        }

        if (i === points.length - 3) {
          p.endPlot(a2, p2[2], true);
        }
      } else if (curvature === 0) {
        // If no curvature, add a simple straight segment
        const p1 = points[i];
        const p2 = points[i + 1];
        const d = dist(p1[0], p1[1], p2[0], p2[1]);
        const a = calcAngle(p1[0], p1[1], p2[0], p2[1]);

        p.addSegment(a, d, p2[2], true);
        if (i === points.length - 2) {
          p.endPlot(a, 1, true);
        }
      }
    }

    p.origin = close && curvature !== 0 ? tep : points[0];
  }

  return p;
}
