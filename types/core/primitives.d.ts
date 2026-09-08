/**
 * Creates a Polygon from an array of points and calls its show() method.
 * Polygons ignore fields and won't be good for fills and masses
 * @param {Array<Array<number>>} pointsArray - Array of points [x, y, pressure]
 */
export function polygon(pointsArray: Array<Array<number>>): Polygon;
/**
 * Context-taking implementation of polygon().
 * @param {import("./context.js").BrushContext} ctx
 * @param {Array<Array<number>>} pointsArray - Array of points [x, y, pressure]
 */
export function _polygon(ctx: import("./context.js").BrushContext, pointsArray: Array<Array<number>>): Polygon;
/**
 * Draws a rectangle on the canvas using path functions.
 * @param {number} x - X-coordinate.
 * @param {number} y - Y-coordinate.
 * @param {number} w - Width.
 * @param {number} h - Height.
 * @param {boolean} [mode="corner"] - "corner" (default) or "center".
 */
export function rect(x: number, y: number, w: number, h: number, mode?: boolean): void;
/**
 * Context-taking implementation of rect().
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} x - X-coordinate.
 * @param {number} y - Y-coordinate.
 * @param {number} w - Width.
 * @param {number} h - Height.
 * @param {string} [mode="corner"] - "corner" (default) or "center".
 */
export function _rect(ctx: import("./context.js").BrushContext, x: number, y: number, w: number, h: number, mode?: string): void;
/**
 * Draws a circle on the canvas.
 * @param {number} x - Center x.
 * @param {number} y - Center y.
 * @param {number} radius - Circle radius.
 * @param {boolean} [r=false] - Randomizes segment lengths if true.
 */
export function circle(x: number, y: number, radius: number, r?: boolean): (number | Plot)[];
/**
 * Context-taking implementation of circle().
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} x - Center x.
 * @param {number} y - Center y.
 * @param {number} radius - Circle radius.
 * @param {boolean} [r=false] - Randomizes segment lengths if true.
 */
export function _circle(ctx: import("./context.js").BrushContext, x: number, y: number, radius: number, r?: boolean): (number | Plot)[];
/**
 * Draws an arc on the canvas.
 * @param {number} x - Center x.
 * @param {number} y - Center y.
 * @param {number} radius - Radius.
 * @param {number} start - Start angle in the current runtime angle units.
 * @param {number} end - End angle in the current runtime angle units.
 * @returns {Plot|null} The drawn Plot, or null when the sweep is zero.
 */
export function arc(x: number, y: number, radius: number, start: number, end: number): Plot | null;
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
export function _arc(ctx: import("./context.js").BrushContext, x: number, y: number, radius: number, start: number, end: number): Plot | null;
/**
 * Begins a new path with a specified curvature.
 * @param {number} [curvature=0] - Curvature from 0 to 1.
 */
export function beginShape(curvature?: number): void;
/**
 * Context-taking implementation of beginShape().
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} [curvature=0] - Curvature from 0 to 1.
 */
export function _beginShape(ctx: import("./context.js").BrushContext, curvature?: number): void;
/**
 * Adds a line segment from the current point to the given coordinates.
 * @param {number} x - X-coordinate.
 * @param {number} y - Y-coordinate.
 * @param {number} [pressure=1] - Pressure value.
 */
export function vertex(x: number, y: number, pressure?: number): void;
/**
 * Context-taking implementation of vertex().
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} x - X-coordinate.
 * @param {number} y - Y-coordinate.
 * @param {number} [pressure=1] - Pressure value.
 */
export function _vertex(ctx: import("./context.js").BrushContext, x: number, y: number, pressure?: number): void;
/**
 * Ends the current path and renders all subpaths.
 * @returns {Plot} The rendered Plot for the completed shape.
 */
export function endShape(close?: boolean): Plot;
/**
 * Context-taking implementation of endShape().
 * @param {import("./context.js").BrushContext} ctx
 * @param {boolean} [close=false] - Whether to close the shape.
 * @returns {Plot} The rendered Plot for the completed shape.
 */
export function _endShape(ctx: import("./context.js").BrushContext, close?: boolean): Plot;
/**
 * Begins a new stroke with a given type and starting position.
 * @param {string} type - Stroke type.
 * @param {number} x - Starting x.
 * @param {number} y - Starting y.
 */
export function beginStroke(type: string, x: number, y: number): void;
/**
 * Context-taking implementation of beginStroke().
 * @param {import("./context.js").BrushContext} ctx
 * @param {string} type - Stroke type.
 * @param {number} x - Starting x.
 * @param {number} y - Starting y.
 */
export function _beginStroke(ctx: import("./context.js").BrushContext, type: string, x: number, y: number): void;
/**
 * Adds a segment to the stroke.
 * @param {number} angle - Segment angle.
 * @param {number} length - Segment length.
 * @param {number} pressure - Segment pressure.
 */
export function move(angle: number, length: number, pressure: number): void;
/**
 * Context-taking implementation of move().
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} angle - Segment angle.
 * @param {number} length - Segment length.
 * @param {number} pressure - Segment pressure.
 */
export function _move(ctx: import("./context.js").BrushContext, angle: number, length: number, pressure: number): void;
/**
 * Completes and renders the stroke.
 * @param {number} angle - End angle.
 * @param {number} pressure - End pressure.
 */
export function endStroke(angle: number, pressure: number): void;
/**
 * Context-taking implementation of endStroke().
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} angle - End angle.
 * @param {number} pressure - End pressure.
 */
export function _endStroke(ctx: import("./context.js").BrushContext, angle: number, pressure: number): void;
/**
 * Creates and draws a spline curve from an array of points.
 * @param {Array<Array<number>>} array_points - Array of points [x, y, pressure].
 * @param {number} [curvature=0.5] - Curvature from 0 to 1.
 */
export function spline(_array_points: any, _curvature?: number): Plot;
/**
 * Context-taking implementation of spline().
 * @param {import("./context.js").BrushContext} ctx
 * @param {Array<Array<number>>} _array_points - Array of points [x, y, pressure].
 * @param {number} [_curvature=0.5] - Curvature from 0 to 1.
 */
export function _spline(ctx: import("./context.js").BrushContext, _array_points: Array<Array<number>>, _curvature?: number): Plot;
import { Polygon } from "./polygon.js";
import { Plot } from "./plot.js";
