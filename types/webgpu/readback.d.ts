/**
 * Reads a rect of a texture back to the CPU.
 *
 * WebGPU requires bytesPerRow % 256 === 0 for texture→buffer copies; the
 * padding is stripped before returning, so `data` is tightly packed
 * (width × height × bytesPerPixel).
 *
 * @param {import('./device.js').GpuContext} gpu
 * @param {GPUTexture} texture must have COPY_SRC usage
 * @param {{x?: number, y?: number, width?: number, height?: number,
 *          bytesPerPixel?: number}} [rect] default: full texture, 4 bpp
 * @returns {Promise<{data: Uint8Array, width: number, height: number}>}
 */
export function readTexture(gpu: import("./device.js").GpuContext, texture: GPUTexture, rect?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    bytesPerPixel?: number;
}): Promise<{
    data: Uint8Array;
    width: number;
    height: number;
}>;
/**
 * Reads a GPU buffer (or a slice of it) back to the CPU.
 *
 * @param {import('./device.js').GpuContext} gpu
 * @param {GPUBuffer} buffer must have COPY_SRC usage
 * @param {{offset?: number, size?: number}} [opts] size defaults to
 *   buffer.size - offset; both must be multiples of 4
 * @returns {Promise<ArrayBuffer>} a CPU-owned copy — safe to view with any
 *   typed array (Float32Array, Uint32Array, …) and to keep after return
 */
export function readBuffer(gpu: import("./device.js").GpuContext, buffer: GPUBuffer, opts?: {
    offset?: number;
    size?: number;
}): Promise<ArrayBuffer>;
