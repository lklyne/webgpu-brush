/**
 * Registers or updates host compositor hooks on a drawing context.
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {object} hooks
 */
export function setCompositorRuntime(ctx: import("./context.js").BrushContext, hooks: object): void;
export function create2DCanvas(width: any, height: any, willReadFrequently?: boolean): HTMLCanvasElement | OffscreenCanvas;
export function get2DContext(canvas: any, willReadFrequently?: boolean): any;
