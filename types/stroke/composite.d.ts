/**
 * Ensures the stroke compositor owns a framebuffer-backed mask with the current
 * canvas dimensions. Stroke stamps are rendered into this mask in WebGL before
 * being blended into the main target.
 *
 * @param {import("../core/context.js").BrushContext} _ctx - Unused here; the
 *   compositor hooks take the drawing context first so the ones that need it
 *   (getShaderMask, flushPending) can be called uniformly.
 * @param {object} Renderer - Active host renderer.
 * @param {number} Cwidth - Target width in sketch units.
 * @param {number} Cheight - Target height in sketch units.
 * @param {number} Density - Active pixel density.
 * @returns {object} The framebuffer used as stroke mask.
 */
export function ensureStrokeCompositeResources(_ctx: import("../core/context.js").BrushContext, Renderer: object, Cwidth: number, Cheight: number, Density: number): object;
/**
 * Clears the current stroke mask and resets its bookkeeping flags.
 *
 * @param {object|null} target - Stroke mask framebuffer.
 * @param {Function} clearTarget - Shared low-level clear helper from core.
 */
export function clearStrokeMask(target: object | null, clearTarget: Function): void;
/**
 * Returns the rect that should be composited from the stroke mask into the
 * main canvas. Stroke bounds are normally tight dirty rects, but when drawing
 * into an active framebuffer we keep the result conservative and composite the
 * full target.
 *
 * @param {object|null} target - Stroke mask framebuffer.
 * @param {Function} getActiveFramebuffer - Returns the currently bound framebuffer.
 * @param {Function} getFullDirtyRect - Returns the full-target dirty rect.
 * @param {Function} expandDirtyRect - Expands a rect by a constant padding.
 * @param {Function} normalizeDirtyRect - Clamps a rect to target bounds.
 * @param {number} padding - Extra brush padding in pixels.
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null} Composite rect.
 */
export function getStrokeCompositeRect(target: object | null, getActiveFramebuffer: Function, getFullDirtyRect: Function, expandDirtyRect: Function, normalizeDirtyRect: Function): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null;
/**
 * Returns the resource that should be bound to the blend shader's `u_mask`
 * uniform for stroke compositing.
 *
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {object} _Renderer - Active host renderer.
 * @param {object} mask - Stroke mask framebuffer.
 * @returns {object} Stroke mask framebuffer.
 */
export function getStrokeShaderMask(ctx: import("../core/context.js").BrushContext, _Renderer: object, mask: object): object;
/**
 * Registers the stroke compositor with the shared color/composite core.
 * Safe to call multiple times.
 */
export function initStrokeComposite(): void;
