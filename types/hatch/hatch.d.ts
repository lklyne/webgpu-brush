/**
 * Returns a shallow snapshot of the current hatch modifier state.
 *
 * @returns {{isActive:boolean, dist:number, angle:number, options:Object, hBrush:Object|false}}
 */
export function HatchState(): {
    isActive: boolean;
    dist: number;
    angle: number;
    options: any;
    hBrush: any | false;
};
/**
 * Restores hatch modifier state from a previously captured snapshot.
 *
 * @param {{isActive:boolean, dist:number, angle:number, options:Object, hBrush:Object|false}} state
 */
export function HatchSetState(state: {
    isActive: boolean;
    dist: number;
    angle: number;
    options: any;
    hBrush: any | false;
}): void;
/**
 * Activates classic scanline hatching for subsequent shapes.
 *
 * @param {number} [dist=5] Distance between scanlines.
 * @param {number} [angle=45] Hatch angle in the current runtime angle units.
 * @param {{rand?: number|false, continuous?: boolean, gradient?: number|false}} [options]
 */
export function hatch(dist?: number, angle?: number, options?: {
    rand?: number | false;
    continuous?: boolean;
    gradient?: number | false;
}): void;
/**
 * Overrides the brush, color, and weight used specifically for hatch strokes.
 *
 * @param {string} brush
 * @param {string|object} [color="black"]
 * @param {number} [weight=1]
 */
export function hatchStyle(brush: string, color?: string | object, weight?: number): void;
/**
 * Deactivates hatching and clears any hatch-specific brush override.
 */
export function noHatch(): void;
/**
 * Expands ordered hatch segments into the actual line list that will be drawn.
 *
 * This includes endpoint jitter when `rand` is active and inserts the serpentine
 * connector lines when `continuous` is enabled.
 *
 * @param {Polygon|Polygon[]} polygons
 * @returns {{x1:number, y1:number, x2:number, y2:number, scanY:number, isConnector:boolean}[]}
 */
export function getHatchLines(polygons: Polygon | Polygon[]): {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    scanY: number;
    isConnector: boolean;
}[];
/**
 * Draws classic hatch lines over one polygon or an array of polygons.
 *
 * @param {Polygon|Polygon[]} polygons
 */
export function createHatch(polygons: Polygon | Polygon[]): void;
import { Polygon } from "../core/polygon.js";
