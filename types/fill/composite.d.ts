/**
 * Ensures fill compositing resources exist for the active renderer.
 * Returns { mask, ctx } — mask carries dirty-rect bookkeeping and exposes
 * the resolve texture; ctx is the fill surface (see header).
 */
export function ensureFillCompositeResources(Renderer: any, Cwidth: any, Cheight: any, Density: any, _clearTarget: any): {
    mask: any;
    ctx: any;
};
/**
 * Clears the current fill mask and resets its bookkeeping flags.
 */
export function clearFillMask(target: any, clearTarget: any): void;
/**
 * Returns the fill dirty rect to composite into the main target.
 */
export function getFillCompositeRect(target: any, _getActiveFramebuffer: any, getFullDirtyRect: any, expandDirtyRect: any, normalizeDirtyRect: any): any;
/**
 * Flushes pending fill passes and returns the mask resource the composite
 * binds as u_mask (the single-sample resolve texture).
 */
export function getFillShaderMask(Renderer: any, mask: any, _dirtyRect: any, _getFullDirtyRect: any, _clearTarget: any): any;
/**
 * Registers the fill compositor with the shared color/composite core.
 * Safe to call multiple times.
 */
export function initFillComposite(): void;
