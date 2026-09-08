export function registerStrokeComposite(composite: any): void;
export function registerFillComposite(composite: any): void;
/**
 * Stores the current state of the drawing system.
 * Can be used to save and restore configurations or canvas states.
 */
export const State: {};
export function isMixReady(): void;
export namespace Mix {
    let isBlending: boolean;
    let cachedColor: any;
    /**
     * Merges a new dirty rectangle into the target's accumulated draw bounds.
     * @param {object} target - Mask buffer receiving draw output.
     * @param {{minX:number,minY:number,maxX:number,maxY:number}|null} rect - Rect to merge.
     */
    function markDirtyRect(target: object, rect: {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    } | null): void;
    /**
     * Clears a mask buffer and resets its dirty-rect tracking.
     * @param {object} target - Mask buffer to reset.
     */
    function clearMask(target: object): void;
    /**
     * Resolves the region that should be composited back into the destination.
     * @param {object} target - Mask buffer being sampled.
     * @param {boolean} isBrushMask - True when compositing the GL brush mask.
     * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null} Composite rect.
     */
    function getCompositeRect(target: object, isBrushMask: boolean): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    } | null;
    /**
     * Ensures the mask buffers and blend shader exist for the current renderer.
     */
    function load(): void;
    /**
     * Flushes pending mask work when the blend color changes or a frame ends.
     * @param {Color|false} [_color=false] - New blend color.
     * @param {boolean} [_isLast=false] - True when this is the final blend flush.
     */
    function blend(_color?: Color | false, _isLast?: boolean): void;
    /**
     * Runs the blend shader over a mask and composites the result into the active renderer.
     * @param {object} mask - Mask buffer to composite.
     * @param {boolean} isBrushMask - True when compositing the GL brush mask.
     */
    function applyShader(mask: object, isBrushMask: boolean): void;
}
export function flushActiveComposite(): void;
export function load(buffer?: object | false, options?: object): void;
