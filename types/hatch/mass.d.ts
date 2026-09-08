/**
 * A context's mass state.
 * @returns {object} The `ctx.state.mass` slice.
 */
export function createMassState(): object;
/**
 * Enables massing mode with a brush, color, and optional configuration.
 *
 * @param {string} brush - Brush name to use for the mass pass.
 * @param {string|Color} color - Color to use for the mass pass.
 * @param {object} [options={}] - Massing options such as precision, strength, gradient, and outline.
 */
export function mass(brush: string, color: string | Color, options?: object): void;
/**
 * Context-taking implementation of mass().
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {string} brush - Brush name to use for the mass pass.
 * @param {string|Color} color - Color to use for the mass pass.
 * @param {object} [options={}] - Massing options.
 */
export function _mass(ctx: import("../core/context.js").BrushContext, brush: string, color: string | Color, options?: object): void;
/**
 * Disables massing mode for subsequent geometry.
 */
export function noMass(): void;
/**
 * Context-taking implementation of noMass().
 *
 * @param {import("../core/context.js").BrushContext} ctx
 */
export function _noMass(ctx: import("../core/context.js").BrushContext): void;
/**
 * Creates the built-in "massing" effect for a polygon or plot.
 * A mass is built from up to three jittered polygon layers, each hatched and
 * then redrawn as arc gestures around a shared pivot bias.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {Polygon|Polygon[]|Plot} shape
 * @param {number|false} x
 * @param {number} y
 * @param {number} scale
 */
export function createMass(ctx: import("../core/context.js").BrushContext, shape: Polygon | Polygon[] | Plot, x: number | false, y: number, scale: number): void;
export function createMassArray(polygons: any): void;
/**
 * Context-taking implementation of createMassArray().
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {Polygon|Polygon[]} polygons
 */
export function _createMassArray(ctx: import("../core/context.js").BrushContext, polygons: Polygon | Polygon[]): void;
import { Polygon } from "../core/polygon.js";
import { Plot } from "../core/plot.js";
