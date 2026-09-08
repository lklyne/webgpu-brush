/**
 * @param {object} obj
 * @returns {number} stable id for the object's lifetime
 */
export function idOf(obj: object): number;
/**
 * @typedef {Object} RenderPipelineDesc
 * @property {string} [code]        WGSL source (cached per source string)
 * @property {GPUShaderModule} [module] pre-created module (else `code`)
 * @property {string} [vertexEntry]   default "vs"
 * @property {string} [fragmentEntry] default "fs"; null → no fragment stage
 * @property {GPUVertexBufferLayout[]} [buffers] vertex buffer layouts
 * @property {GPUBlendState|null} [blend]  null → no blending (replace)
 * @property {GPUTextureFormat} [format]   color target format
 * @property {GPUColorWriteFlags} [writeMask]
 * @property {GPUDepthStencilState|null} [stencil] full depthStencil state
 * @property {GPUPrimitiveTopology} [topology] default "triangle-list"
 * @property {GPUCullMode} [cullMode] default "none"
 * @property {string} [label]
 */
/**
 * Creates the shared caches. One instance per GpuContext; pass it around —
 * two instances would compile every pipeline twice.
 *
 * @param {import('./device.js').GpuContext} gpu
 */
export function createPipelineCache(gpu: import("./device.js").GpuContext): {
    getModule: (code: string, label?: string) => GPUShaderModule;
    getRenderPipeline: (desc: RenderPipelineDesc) => GPURenderPipeline;
    getComputePipeline: (desc: {
        code?: string;
        module?: GPUShaderModule;
        entry?: string;
        label?: string;
    }) => GPUComputePipeline;
    getBindGroup: (layout: GPUBindGroupLayout, entries: GPUBindGroupEntry[], label?: string) => GPUBindGroup;
    stats: {
        modules: number;
        pipelines: number;
        pipelineHits: number;
        bindGroups: number;
        bindGroupHits: number;
    };
};
/**
 * A per-frame uniform allocator: one GPUBuffer, 256-byte-aligned slots,
 * written with queue.writeBuffer. Call reset() once per frame; write()
 * returns a { buffer, offset, size } binding for getBindGroup. The buffer
 * identity is stable, so bind groups keyed on (buffer, offset) cache
 * across frames once every slot has been seen.
 *
 * Growth policy matches gl_draw.js: reallocate only when exceeded (the
 * old buffer is destroyed; in-flight frames referencing it are complete
 * because growth happens at write time, before submit).
 *
 * @param {import('./device.js').GpuContext} gpu
 * @param {{slots?: number, slotSize?: number}} [opts]
 */
export function createUniformRing(gpu: import("./device.js").GpuContext, opts?: {
    slots?: number;
    slotSize?: number;
}): {
    /** Start of frame. */
    reset(): void;
    /**
     * Guarantee `n` slots fit without a mid-batch reallocation. Call BEFORE
     * encoding a batch that writes many slots into one command encoder:
     * growth destroys the old buffer, which would invalidate bind groups
     * already recorded against it in that encoder.
     * @param {number} n
     */
    reserve(n: number): void;
    /**
     * @param {ArrayBufferView} data byte length ≤ slotSize
     * @returns {{buffer: GPUBuffer, offset: number, size: number}}
     */
    write(data: ArrayBufferView): {
        buffer: GPUBuffer;
        offset: number;
        size: number;
    };
    readonly buffer: GPUBuffer;
    destroy(): void;
};
/**
 * Uploads pixels to a new (tracked) texture.
 *
 * @param {import('./device.js').GpuContext} gpu
 * @param {Uint8Array|Uint8ClampedArray|ImageBitmap|HTMLCanvasElement|OffscreenCanvas} source
 *   Typed array → queue.writeTexture (tightly packed rows assumed).
 *   Image-ish → copyExternalImageToTexture.
 * @param {{width: number, height: number, format?: GPUTextureFormat,
 *          usage?: GPUTextureUsageFlags, label?: string,
 *          premultipliedAlpha?: boolean}} opts
 *   width/height required for typed arrays; inferred for images.
 * @returns {GPUTexture}
 */
export function uploadTexture(gpu: import("./device.js").GpuContext, source: Uint8Array | Uint8ClampedArray | ImageBitmap | HTMLCanvasElement | OffscreenCanvas, opts?: {
    width: number;
    height: number;
    format?: GPUTextureFormat;
    usage?: GPUTextureUsageFlags;
    label?: string;
    premultipliedAlpha?: boolean;
}): GPUTexture;
export type RenderPipelineDesc = {
    /**
     * WGSL source (cached per source string)
     */
    code?: string;
    /**
     * pre-created module (else `code`)
     */
    module?: GPUShaderModule;
    /**
     * default "vs"
     */
    vertexEntry?: string;
    /**
     * default "fs"; null → no fragment stage
     */
    fragmentEntry?: string;
    /**
     * vertex buffer layouts
     */
    buffers?: GPUVertexBufferLayout[];
    /**
     * null → no blending (replace)
     */
    blend?: GPUBlendState | null;
    /**
     * color target format
     */
    format?: GPUTextureFormat;
    writeMask?: GPUColorWriteFlags;
    /**
     * full depthStencil state
     */
    stencil?: GPUDepthStencilState | null;
    /**
     * default "triangle-list"
     */
    topology?: GPUPrimitiveTopology;
    /**
     * default "none"
     */
    cullMode?: GPUCullMode;
    label?: string;
};
