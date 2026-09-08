/**
 * @typedef {{r: number, g: number, b: number, a: number}} FillColor
 *   straight-alpha rgba, components 0..1
 */
/**
 * Creates the stencil-fill renderer.
 *
 * Pipelines are created through a local memo rather than
 * pipeline.js#getRenderPipeline because that cache has no `multisample`
 * field (papercut: RenderPipelineDesc could grow one and fold these in).
 * The memo is keyed the same way (format + sampleCount + variant) and the
 * pipeline set is closed (5 pipelines), so gotcha #8 still holds; counts are
 * exposed via `stats.pipelines`.
 *
 * @param {import('./device.js').GpuContext} gpu
 * @param {ReturnType<import('./pipeline.js').createPipelineCache>} cache
 * @param {{format?: GPUTextureFormat, sampleCount?: number}} [opts]
 *   format defaults to 'rgba8unorm' (the mask texture format);
 *   sampleCount 4 (set 1 to disable MSAA).
 */
export function createFillRenderer(gpu: import("./device.js").GpuContext, cache: ReturnType<typeof import("./pipeline.js").createPipelineCache>, opts?: {
    format?: GPUTextureFormat;
    sampleCount?: number;
}): {
    ensureTarget: (width: number, height: number) => any;
    readonly target: any;
    clear: (_encoder: GPUCommandEncoder, clearValue?: {
        r: number;
        g: number;
        b: number;
        a: number;
    }) => void;
    fillPolygon: (_encoder: GPUCommandEncoder, verts: Float32Array | number[], color: FillColor) => void;
    strokePolygon: (_encoder: GPUCommandEncoder, verts: Float32Array | number[], lineWidth: number, color: FillColor) => void;
    layer: (encoder: GPUCommandEncoder, verts: Float32Array | number[], fillColor: FillColor, lineWidth: number, strokeColor: FillColor) => void;
    erase: (_encoder: GPUCommandEncoder, circles: Float32Array | number[], alpha: number) => void;
    layerGpu: (polyBuffer: GPUBuffer, matrix: {
        a: any;
        b: any;
        c: any;
        d: any;
        e: any;
        f: any;
    }, fillColor: FillColor, lineWidth: number, strokeColor: FillColor, indirect: {
        fill: number;
        border: number;
    }) => void;
    eraseGpu: (circleRef: {
        buffer: GPUBuffer;
    }, handleBuffer: GPUBuffer, indirectOffset: number, matrix: {
        a: any;
        b: any;
        c: any;
        d: any;
        e: any;
        f: any;
    }, radiusScale: number, alpha: number, base: number) => void;
    flushInto: (encoder: GPUCommandEncoder) => void;
    pending: () => boolean;
    finish: () => void;
    stats: {
        passes: number;
        draws: number;
        polygons: number;
        strokes: number;
        erases: number;
        vertexFloatsWritten: number;
        pipelines: number;
    };
    resetStats: () => void;
    destroy: () => void;
    sampleCount: number;
    format: GPUTextureFormat;
};
/**
 * straight-alpha rgba, components 0..1
 */
export type FillColor = {
    r: number;
    g: number;
    b: number;
    a: number;
};
