/**
 * Enables massing mode with a brush, color, and optional configuration.
 *
 * @param {string} brush - Brush name to use for the mass pass.
 * @param {string|Color} color - Color to use for the mass pass.
 * @param {object} [options={}] - Massing options such as precision, strength, gradient, and outline.
 */
export function mass(brush: string, color: string | Color, options?: object): void;
/**
 * Disables massing mode for subsequent geometry.
 */
export function noMass(): void;
/**
 * Creates the built-in "massing" effect for a polygon or plot.
 * A mass is built from up to three jittered polygon layers, each hatched and
 * then redrawn as arc gestures around a shared pivot bias.
 * @param {Polygon|Polygon[]|Plot} shape
 * @param {number|false} x
 * @param {number} y
 * @param {number} scale
 */
export function createMass(shape: Polygon | Polygon[] | Plot, x: number | false, y: number, scale: number): void;
export function createMassArray(polygons: any): void;
import { Polygon } from "../core/polygon.js";
import { Plot } from "../core/plot.js";
