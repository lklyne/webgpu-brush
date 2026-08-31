// =============================================================================
// Readback primitive (W1a)
//
// Staging buffer + mapAsync + typed-array views. OUT-OF-BAND ONLY — plan
// gotcha #9: readback is fatal in the frame path. These functions await
// GPU completion; nothing here may ever be called from inside a frame.
// Consumers: oracle scripts, grow-compute / strokewalk-compute
// verification, and (W4b) brush.readGeometry / geometry hooks.
// =============================================================================

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
export async function readTexture(gpu, texture, rect = {}) {
  const x = rect.x ?? 0;
  const y = rect.y ?? 0;
  const width = rect.width ?? texture.width - x;
  const height = rect.height ?? texture.height - y;
  const bpp = rect.bytesPerPixel ?? 4;
  const bytesPerRow = Math.ceil((width * bpp) / 256) * 256;

  const staging = gpu.createBuffer({
    label: "readback-staging",
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = gpu.device.createCommandEncoder({ label: "readback" });
  encoder.copyTextureToBuffer(
    { texture, origin: { x, y } },
    { buffer: staging, bytesPerRow, rowsPerImage: height },
    { width, height },
  );
  gpu.device.queue.submit([encoder.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(staging.getMappedRange());
  const data = new Uint8Array(width * height * bpp);
  for (let row = 0; row < height; row++) {
    data.set(
      padded.subarray(row * bytesPerRow, row * bytesPerRow + width * bpp),
      row * width * bpp,
    );
  }
  staging.unmap();
  staging.destroy();
  return { data, width, height };
}

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
export async function readBuffer(gpu, buffer, opts = {}) {
  const offset = opts.offset ?? 0;
  const size = opts.size ?? buffer.size - offset;

  const staging = gpu.createBuffer({
    label: "readback-staging",
    size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = gpu.device.createCommandEncoder({ label: "readback" });
  encoder.copyBufferToBuffer(buffer, offset, staging, 0, size);
  gpu.device.queue.submit([encoder.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const copy = staging.getMappedRange().slice(0);
  staging.unmap();
  staging.destroy();
  return copy;
}
