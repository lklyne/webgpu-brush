/**
 * @typedef {Object} StampDrawOpts
 * @property {GPUTextureView} view        render target view
 * @property {number[]} color             stroke color rgb(a), [0..1] — rgb used
 * @property {GPULoadOp} [loadOp]         default "load"
 * @property {GPUColor} [clearValue]      default transparent black
 * @property {{x:number,y:number,w:number,h:number}} [scissor] device px
 */
/**
 * Creates the stamp renderer. One instance per GpuContext/target-format
 * pair; share the pipeline cache with everything else (two caches compile
 * every pipeline twice).
 *
 * @param {import('./device.js').GpuContext} gpu
 * @param {ReturnType<import('./pipeline.js').createPipelineCache>} cache
 * @param {{format?: GPUTextureFormat}} [opts] render target format,
 *   default "rgba8unorm" (the brush mask texture format)
 */
export function createStampRenderer(gpu: import("./device.js").GpuContext, cache: ReturnType<typeof import("./pipeline.js").createPipelineCache>, opts?: {
    format?: GPUTextureFormat;
}): {
    /**
     * Sets the render-target size (DEVICE pixels) used to build the
     * projection. flipY=true (default) puts y=0 at texture row 0 — image
     * convention, what a compositor sampling the mask with standard uvs
     * wants. flipY=false reproduces upstream's GL framebuffer orientation
     * exactly (used by the parity oracle).
     * @param {number} width  device px
     * @param {number} height device px
     * @param {{flipY?: boolean}} [o]
     */
    setSize(width: number, height: number, o?: {
        flipY?: boolean;
    }): void;
    /** Start of a frame / after your own submit. */
    beginFrame(): void;
    /**
     * Queue a disc stamp (replaces gl_draw.circle after its transform).
     * @param {number} x center, device px
     * @param {number} y center, device px
     * @param {number} radius device px
     * @param {number} alpha [0..1]
     */
    disc(x: number, y: number, radius: number, alpha: number): void;
    /**
     * Queue an image stamp (replaces gl_draw.stampImage after its
     * transform).
     * @param {number} x center, device px
     * @param {number} y center, device px
     * @param {number} halfSize device px
     * @param {number} angle radians
     * @param {number} alpha [0..1]
     * @param {number} [extraPadding] extra dirty-rect padding, device px
     */
    image(x: number, y: number, halfSize: number, angle: number, alpha: number, extraPadding?: number): void;
    readonly discCount: number;
    readonly imageCount: number;
    /**
     * Flush queued discs as one instanced draw (replaces glDraw()).
     * @param {GPUCommandEncoder|null} encoder null → own encoder + submit
     * @param {StampDrawOpts} o
     * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
     *   accumulated dirty rect (device px), null if nothing drawn
     */
    drawDiscs(encoder: GPUCommandEncoder | null, o: StampDrawOpts): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    } | null;
    /**
     * Flush queued image stamps as one instanced draw (replaces
     * glDrawImages()).
     * @param {GPUCommandEncoder|null} encoder null → own encoder + submit
     * @param {StampDrawOpts & {src: string,
     *   source?: ImageBitmap|HTMLCanvasElement|OffscreenCanvas|Uint8Array,
     *   width?: number, height?: number}} o
     *   `src` keys the tip texture cache; `source` (+ width/height for
     *   typed arrays) is required only on first use of a given src.
     * @returns dirty rect like drawDiscs
     */
    drawImages(encoder: GPUCommandEncoder | null, o: StampDrawOpts & {
        src: string;
        source?: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | Uint8Array;
        width?: number;
        height?: number;
    }): any;
    /**
     * Tip-texture cache, keyed by src string like gl_draw's texCache.
     * Lazy-uploads on first use; subsequent calls ignore `source`.
     * @param {string} src cache key
     * @param {ImageBitmap|HTMLCanvasElement|OffscreenCanvas|Uint8Array} [source]
     * @param {{width?: number, height?: number}} [o] required for typed arrays
     * @returns {{texture: GPUTexture, view: GPUTextureView}}
     */
    getTipTexture(src: string, source?: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | Uint8Array, o?: {
        width?: number;
        height?: number;
    }): {
        texture: GPUTexture;
        view: GPUTextureView;
    };
    /**
     * Drops a cached tip texture, forcing re-upload on next use — call when
     * a custom tip function changes after brush.add() (mirrors gl_draw's
     * invalidateTexEntry).
     * @param {string} src
     */
    invalidateTip(src: string): void;
    destroy(): void;
};
export namespace STAMP_BLEND {
    namespace color {
        let srcFactor: string;
        let dstFactor: string;
    }
    namespace alpha {
        let srcFactor_1: string;
        export { srcFactor_1 as srcFactor };
        let dstFactor_1: string;
        export { dstFactor_1 as dstFactor };
    }
}
/** Shared per-instance vertex buffer layout for both pipelines. */
export const INSTANCE_LAYOUT: {
    arrayStride: number;
    stepMode: string;
    attributes: {
        shaderLocation: number;
        offset: number;
        format: string;
    }[];
}[];
export type StampDrawOpts = {
    /**
     * render target view
     */
    view: GPUTextureView;
    /**
     * stroke color rgb(a), [0..1] — rgb used
     */
    color: number[];
    /**
     * default "load"
     */
    loadOp?: GPULoadOp;
    /**
     * default transparent black
     */
    clearValue?: GPUColor;
    /**
     * device px
     */
    scissor?: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
};
