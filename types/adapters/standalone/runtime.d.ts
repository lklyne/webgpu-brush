/**
 * Sets the active standalone angle mode.
 *
 * @param {"degrees"|"radians"} mode
 */
export function angleMode(mode: "degrees" | "radians"): void;
/**
 * Returns the current standalone angle mode.
 *
 * @returns {"degrees"|"radians"}
 */
export function getAngleMode(): "degrees" | "radians";
/**
 * Pushes the current standalone transform onto the stack.
 */
export function push(): void;
/**
 * Pops the last standalone transform from the stack.
 */
export function pop(): void;
/**
 * Applies a translation to the current standalone transform.
 *
 * @param {number} x
 * @param {number} y
 */
export function translate(x: number, y: number): void;
/**
 * Applies a rotation to the current standalone transform.
 *
 * @param {number} angle
 */
export function rotate(angle: number): void;
/**
 * Applies a scale to the current standalone transform.
 *
 * @param {number} x
 * @param {number} [y=x]
 */
export function scale(x: number, y?: number): void;
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
