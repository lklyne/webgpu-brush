/**
 * Flushes any pending stroke/fill compositing into the active standalone target.
 *
 * Standalone users should call this at the end of a drawing pass or frame.
 */
export function render(): void;
/**
 * Context-taking implementation of render().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 */
export function _render(ctx: import("../../core/context.js").BrushContext): void;
/**
 * Clears the active standalone target.
 *
 * With no arguments, clears to transparent white.
 * With a color, clears to that color at full opacity.
 *
 * @param {...*} args
 */
export function clear(...args: any[]): void;
/**
 * Context-taking implementation of clear().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {...*} args
 */
export function _clear(ctx: import("../../core/context.js").BrushContext, ...args: any[]): void;
