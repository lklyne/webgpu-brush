/**
 * @typedef {Object} GpuStats
 * @property {number} buffers        currently-live buffers created via ctx
 * @property {number} textures       currently-live textures created via ctx
 * @property {number} buffersCreated  total ever created
 * @property {number} texturesCreated total ever created
 * @property {number} bufferBytes    bytes in live buffers
 */
/**
 * @typedef {Object} GpuContext
 * @property {GPUAdapter} adapter
 * @property {GPUDevice} device
 * @property {GPUCanvasContext|null} context  null when headless (no canvas)
 * @property {HTMLCanvasElement|OffscreenCanvas|null} canvas
 * @property {GPUTextureFormat} format   preferred canvas format
 * @property {number} width   canvas backing-store width (px)
 * @property {number} height  canvas backing-store height (px)
 * @property {number} density pixel density multiplier applied by resize()
 * @property {boolean} lost
 * @property {GPUDeviceLostInfo|null} lostInfo
 * @property {GpuStats} stats
 * @property {(w: number, h: number, density?: number) => void} resize
 * @property {(desc: GPUBufferDescriptor) => GPUBuffer} createBuffer
 * @property {(desc: GPUTextureDescriptor) => GPUTexture} createTexture
 * @property {() => void} destroy
 */
/**
 * Requests an adapter + device and (optionally) configures a canvas.
 *
 * The canvas is configured with `alphaMode: 'premultiplied'`, matching
 * upstream's `getContext('webgl2', { premultipliedAlpha: true })`
 * (adapters/standalone/target.js) — colors shift subtly otherwise.
 * Usage includes COPY_SRC so the current swapchain texture can be copied
 * out for parity readback (you can copy it, you just cannot *sample* it —
 * gotcha #3 still stands for the painting texture design).
 *
 * @param {Object} [opts]
 * @param {HTMLCanvasElement|OffscreenCanvas|null} [opts.canvas]
 * @param {number} [opts.width]  initial size; defaults to canvas size
 * @param {number} [opts.height]
 * @param {number} [opts.density] pixel density (default 1, matching
 *   adapters/standalone/target.js:84)
 * @param {(info: GPUDeviceLostInfo, ctx: GpuContext) => void} [opts.onDeviceLost]
 * @param {GPUDevice} [opts.device] an externally owned device to use
 *   instead of requesting one (shared-device interop, e.g. a three.js
 *   WebGPURenderer). The caller keeps ownership: destroy() unconfigures
 *   the canvas but never destroys an injected device. The device must
 *   carry limits large enough for the target (the fork's own request asks
 *   for the adapter maximum of maxTextureDimension2D / maxBufferSize /
 *   maxStorageBufferBindingSize).
 * @param {GPUAdapter|null} [opts.adapter] the injected device's adapter,
 *   informational only.
 * @returns {Promise<GpuContext>}
 */
export function initDevice(opts?: {
    canvas?: HTMLCanvasElement | OffscreenCanvas | null;
    width?: number;
    height?: number;
    density?: number;
    onDeviceLost?: (info: GPUDeviceLostInfo, ctx: GpuContext) => void;
    device?: GPUDevice;
    adapter?: GPUAdapter | null;
}): Promise<GpuContext>;
export type GpuStats = {
    /**
     * currently-live buffers created via ctx
     */
    buffers: number;
    /**
     * currently-live textures created via ctx
     */
    textures: number;
    /**
     * total ever created
     */
    buffersCreated: number;
    /**
     * total ever created
     */
    texturesCreated: number;
    /**
     * bytes in live buffers
     */
    bufferBytes: number;
};
export type GpuContext = {
    adapter: GPUAdapter;
    device: GPUDevice;
    /**
     * null when headless (no canvas)
     */
    context: GPUCanvasContext | null;
    canvas: HTMLCanvasElement | OffscreenCanvas | null;
    /**
     * preferred canvas format
     */
    format: GPUTextureFormat;
    /**
     * canvas backing-store width (px)
     */
    width: number;
    /**
     * canvas backing-store height (px)
     */
    height: number;
    /**
     * pixel density multiplier applied by resize()
     */
    density: number;
    lost: boolean;
    lostInfo: GPUDeviceLostInfo | null;
    stats: GpuStats;
    resize: (w: number, h: number, density?: number) => void;
    createBuffer: (desc: GPUBufferDescriptor) => GPUBuffer;
    createTexture: (desc: GPUTextureDescriptor) => GPUTexture;
    destroy: () => void;
};
