/**
 * The Plot class represents a collection of segments that define shapes or paths.
 * It supports operations like adding segments, calculating angles and pressures,
 * and generating polygons based on the plot's structure.
 */
export class Plot {
    /**
     * Creates a new Plot.
     * @param {string} _type - The type of plot, "curve" or "segments".
     */
    constructor(_type: string);
    segments: any[];
    angles: any[];
    pres: any[];
    type: string;
    dir: number;
    _cumLen: any[];
    length: number;
    index: number;
    suma: number;
    pol: boolean;
    /**
     * Adds a segment to the plot with specified angle, length, and pressure.
     * @param {number} _a - The angle of the segment.
     * @param {number} _length - The length of the segment.
     * @param {number} _pres - The pressure of the segment.
     * @param {boolean} _degrees - Whether the angle is in degrees.
     */
    addSegment(_a?: number, _length?: number, _pres?: number, _degrees?: boolean): void;
    /**
     * Finalizes the plot by setting the last angle and pressure.
     * @param {number} _a - The final angle.
     * @param {number} _pres - The final pressure.
     * @param {boolean} _degrees - Whether the angle is in degrees.
     */
    endPlot(_a?: number, _pres?: number, _degrees?: boolean): void;
    /**
     * Rotates the entire plot by a given angle.
     * @param {number} _a - The angle to rotate the plot.
     */
    rotate(_a: number): void;
    /**
     * Calculates the pressure at a given distance along the plot.
     * Inlined for performance — pressure values never need angle wrap-around.
     * NOTE: relies on this.index / this.suma being set by a prior angle() call.
     * @param {number} _d - The distance along the plot.
     * @returns {number} - The interpolated pressure.
     */
    pressure(_d: number): number;
    /**
     * Calculates the angle at a given distance along the plot.
     * @param {number} _d - The distance along the plot.
     * @returns {number} - The calculated angle.
     */
    angle(_d: number): number;
    /**
     * Calculates the current index of the plot based on the distance.
     * Uses sequential forward scan from the cached index (O(1) amortized for
     * monotone access patterns) with binary search fallback for backward jumps.
     * @param {number} _d - The distance along the plot.
     */
    calcIndex(_d: number): number;
    /**
     * Generates a polygon based on the plot.
     * @param {number} _x - The x-coordinate for the starting point.
     * @param {number} _y - The y-coordinate for the starting point.
     * @param {number} _scale - The scale factor for the polygon.
     * @param {number} _side - The side factor for the polygon.
     * @returns {Polygon} - The generated polygon.
     */
    genPol(_x: number, _y: number, _scale: number, _side: number): Polygon;
    /**
     * Displays the plot with optional stroke, hatch, and fill effects.
     * @param {number} x - The x-coordinate.
     * @param {number} y - The y-coordinate.
     * @param {number} scale - The scale factor.
     */
    show(x: number, y: number, scale?: number): void;
}
import { Polygon } from "./polygon.js";
