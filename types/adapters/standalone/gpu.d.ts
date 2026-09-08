/**
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {number} width logical
 * @param {number} height logical
 * @param {number} density
 * @param {{device?: GPUDevice, adapter?: GPUAdapter|null}} [gpuOptions]
 *   forwarded to initDevice — an injected device is adopted instead of
 *   requested (shared-device interop).
 */
export function createGpuHost(canvas: HTMLCanvasElement | OffscreenCanvas, width: number, height: number, density: number, gpuOptions?: {
    device?: GPUDevice;
    adapter?: GPUAdapter | null;
}): {
    canvas: OffscreenCanvas | HTMLCanvasElement;
    width: number;
    height: number;
    density: number;
    gpu: any;
    cache: any;
    stamps: any;
    fillR: any;
    /** GPU-resident fill DAG driver (webgpu/fillgpu.js), built lazily */
    fillGpu: any;
    ready: any;
    /** painting texture (image convention, gpu.format) */
    painting: any;
    paintingView: any;
    /** deferred clear color for pre-ready clear() calls */
    _pendingClear: {
        r: number;
        g: number;
        b: number;
        a: number;
    };
    /** fill-mask supersampling factor (box-downsampled before compositing);
     *  drops to 1 when 2x would exceed the device texture-size limit */
    fillSS: number;
};
