/**
 * Sets the active standalone angle mode.
 *
 * @param {"degrees"|"radians"} mode
 */
export function angleMode(mode: "degrees" | "radians"): void;
/**
 * Context-taking implementation of angleMode().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {"degrees"|"radians"} mode
 */
export function _angleMode(ctx: import("../../core/context.js").BrushContext, mode: "degrees" | "radians"): void;
/**
 * Returns the current standalone angle mode.
 *
 * @returns {"degrees"|"radians"}
 */
export function getAngleMode(): "degrees" | "radians";
/**
 * Context-taking implementation of getAngleMode().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @returns {"degrees"|"radians"}
 */
export function _getAngleMode(ctx: import("../../core/context.js").BrushContext): "degrees" | "radians";
/**
 * Pushes the current standalone transform onto the stack.
 */
export function push(): void;
/**
 * Context-taking implementation of push().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 */
export function _push(ctx: import("../../core/context.js").BrushContext): void;
/**
 * Pops the last standalone transform from the stack.
 */
export function pop(): void;
/**
 * Context-taking implementation of pop().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 */
export function _pop(ctx: import("../../core/context.js").BrushContext): void;
/**
 * Applies a translation to the current standalone transform.
 *
 * @param {number} x
 * @param {number} y
 */
export function translate(x: number, y: number): void;
/**
 * Context-taking implementation of translate().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {number} x
 * @param {number} y
 */
export function _translate(ctx: import("../../core/context.js").BrushContext, x: number, y: number): void;
/**
 * Applies a rotation to the current standalone transform.
 *
 * @param {number} angle
 */
export function rotate(angle: number): void;
/**
 * Context-taking implementation of rotate().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {number} angle
 */
export function _rotate(ctx: import("../../core/context.js").BrushContext, angle: number): void;
/**
 * Applies a scale to the current standalone transform.
 *
 * @param {number} x
 * @param {number} [y=x]
 */
export function scale(x: number, y?: number): void;
/**
 * Context-taking implementation of scale().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {number} x
 * @param {number} [y=x]
 */
export function _scale(ctx: import("../../core/context.js").BrushContext, x: number, y?: number): void;
/**
 * Installs the standalone runtime hooks used by core modules.
 */
export function initStandaloneRuntime(): void;
export const DEGREES: "degrees";
export const RADIANS: "radians";
/**
 * Runtime-native color object compatible with the expectations of core modules.
 */
export class Color {
    constructor(r: any, g: any, b: any);
    r: number;
    g: number;
    b: number;
    hex: any;
    _array: any[];
    gl: any[];
    rgbToHex(r: any, g: any, b: any): string;
    hexToRgb(hex: any): {
        r: number;
        g: number;
        b: number;
    };
    standardize(value: any): any;
    _getRed(): number;
    _getGreen(): number;
    _getBlue(): number;
}
