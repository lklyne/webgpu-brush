export function registerStrokeComposite(composite: any): void;
export function registerFillComposite(composite: any): void;
/**
 * Stores the current state of the drawing system.
 * Can be used to save and restore configurations or canvas states.
 */
export const State: {};
export function isMixReady(ctx: import("./context.js").BrushContext): void;
export namespace Mix {
    let isBlending: boolean;
    let cachedColor: any;
    /**
     * Merges a new dirty rectangle into the target's accumulated draw bounds.
     * @param {import("./context.js").BrushContext} ctx
     * @param {object} target - Mask buffer receiving draw output.
     * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} rect - Rect to merge.
     */
    function markDirtyRect(ctx: import("./context.js").BrushContext, target: object, rect: {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    } | null): void;
    /**
     * Clears a mask buffer and resets its dirty-rect tracking.
     * @param {import("./context.js").BrushContext} ctx
     * @param {object} target - Mask buffer to reset.
     */
    function clearMask(ctx: import("./context.js").BrushContext, target: object): void;
    /**
     * Resolves the region that should be composited back into the destination.
     * @param {import("./context.js").BrushContext} ctx
     * @param {object} target - Mask buffer being sampled.
     * @param {boolean} isBrushMask - True when compositing the GL brush mask.
     * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null} Composite rect.
     */
    function getCompositeRect(ctx: import("./context.js").BrushContext, target: object, isBrushMask: boolean): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    } | null;
    /**
     * Ensures the mask buffers and blend shader exist for the current renderer.
     * @param {import("./context.js").BrushContext} ctx
     */
    function load(ctx: import("./context.js").BrushContext): void;
    /**
     * Flushes pending mask work when the blend color changes or a frame ends.
     * @param {import("./context.js").BrushContext} ctx
     * @param {Color|false} [_color=false] - New blend color.
     * @param {boolean} [_isLast=false] - True when this is the final blend flush.
     */
    function blend(ctx: import("./context.js").BrushContext, _color?: Color | false, _isLast?: boolean): void;
    /**
     * Runs the blend shader over a mask and composites the result into the active renderer.
     * @param {import("./context.js").BrushContext} ctx
     * @param {object} mask - Mask buffer to composite.
     * @param {boolean} isBrushMask - True when compositing the GL brush mask.
     */
    function applyShader(ctx: import("./context.js").BrushContext, mask: object, isBrushMask: boolean): void;
}
export function flushActiveComposite(ctx: import("./context.js").BrushContext): void;
export function load(buffer?: object | false, options?: object): void;
export function _load(ctx: import("./context.js").BrushContext, buffer?: object | false, options?: object): void;
