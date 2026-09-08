/**
 * A context's wash state.
 * @returns {object} The `ctx.state.wash` slice.
 */
export function createWashState(): object;
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
 * Context-taking implementation of wash().
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {...*} args - Color arguments plus optional opacity.
 */
export function _wash(ctx: import("../core/context.js").BrushContext, ...args: any[]): void;
/**
 * Disables wash mode for subsequent drawing operations.
 */
export function noWash(): void;
/**
 * Context-taking implementation of noWash().
 *
 * @param {import("../core/context.js").BrushContext} ctx
 */
export function _noWash(ctx: import("../core/context.js").BrushContext): void;
