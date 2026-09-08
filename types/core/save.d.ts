/**
 * Pushes the current brush state onto the stack.
 *
 * @param {import("./context.js").BrushContext} ctx
 */
export function push(ctx: import("./context.js").BrushContext): void;
/**
 * Pops the top brush state from the stack and restores it.
 *
 * @param {import("./context.js").BrushContext} ctx
 */
export function pop(ctx: import("./context.js").BrushContext): void;
