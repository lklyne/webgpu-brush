/**
 * Enables wash mode with a color and opacity.
 *
 * @param {number|string|Color} a - Either the red component, a CSS color string, or a Color object.
 * @param {number} [b] - The green component or the opacity if using grayscale.
 * @param {number} [c] - The blue component.
 * @param {number} [d] - The opacity.
 */
export function wash(a: number | string | Color, b?: number, c?: number, d?: number, ...args: any[]): void;
/**
 * Disables wash mode for subsequent drawing operations.
 */
export function noWash(): void;
