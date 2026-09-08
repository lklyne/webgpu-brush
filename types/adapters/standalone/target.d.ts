/**
 * Resolves when the active target's WebGPU device is initialized, the GPU
 * stroke walker is warm, and every call recorded before that point has
 * been replayed. Optional — drawing before ready is recorded and
 * replayed in order — but awaiting it is still the way to know the
 * painting is current before an out-of-band read. Callable any time after
 * load()/createCanvas().
 * @returns {Promise<void>}
 */
export function ready(): Promise<void>;
/**
 * OUT-OF-BAND readback of the painting texture as RGBA pixels (gotcha #9:
 * never called from any frame path — this is an explicit async API for
 * inspection, export, and the parity harness, which cannot drawImage()
 * a WebGPU canvas in every headless configuration).
 *
 * @returns {Promise<{width: number, height: number, pixels: Uint8ClampedArray}>}
 */
export function readPixels(): Promise<{
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
}>;
/**
 * Shared-device interop handle for the active target. Lets a host
 * renderer that lives on the SAME GPUDevice (three.js `WebGPURenderer`
 * constructed with `{ device }`, then `new ExternalTexture(painting)`)
 * sample the painting with zero copies: same device, same queue, so the
 * fork's submissions land before the host's in submission order — no
 * fences. Synchronous; requires `await brush.ready()` first (the device
 * has no synchronous form). `painting` is the LIVE texture — it is
 * recreated on resize; subscribe with `onPaintingChanged` to re-wrap.
 * Image convention: row 0 is the top of the canvas, colors are
 * premultiplied in `format` (the preferred canvas format, not sRGB-typed).
 *
 * @returns {{
 *   device: GPUDevice,
 *   adapter: GPUAdapter|null,
 *   format: GPUTextureFormat,
 *   painting: GPUTexture,
 *   onPaintingChanged: (fn: (painting: GPUTexture) => void) => () => void,
 * }}
 */
export function gpu(): {
    device: GPUDevice;
    adapter: GPUAdapter | null;
    format: GPUTextureFormat;
    painting: GPUTexture;
    onPaintingChanged: (fn: (painting: GPUTexture) => void) => () => void;
};
/**
 * Loads a standalone draw target from a DOM canvas or OffscreenCanvas.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} target
 * @param {{device?: GPUDevice, adapter?: GPUAdapter|null}} [options]
 *   adopt an externally owned device (see `gpu()`).
 */
export function load(target?: HTMLCanvasElement | OffscreenCanvas, options?: {
    device?: GPUDevice;
    adapter?: GPUAdapter | null;
}): void;
/**
 * Creates a standalone DOM canvas, configures its backing resolution according
 * to the provided pixel density, appends it optionally to the DOM, and loads it
 * as the active brush target.
 *
 * @param {number} width Logical canvas width.
 * @param {number} height Logical canvas height.
 * @param {{
 *   pixelDensity?: number,
 *   parent?: string|Element|null,
 *   id?: string,
 *   device?: GPUDevice,
 *   adapter?: GPUAdapter|null,
 * }} [options] `device`/`adapter`: adopt an externally owned device
 *   instead of requesting one — see `gpu()`.
 * @returns {HTMLCanvasElement}
 */
export function createCanvas(width: number, height: number, options?: {
    pixelDensity?: number;
    parent?: string | Element | null;
    id?: string;
    device?: GPUDevice;
    adapter?: GPUAdapter | null;
}): HTMLCanvasElement;
/**
 * Refreshes the standalone target density.
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @returns {number}
 */
export function syncDensity(ctx: import("../../core/context.js").BrushContext): number;
/**
 * Ensures a standalone target has been loaded.
 */
export function isCanvasReady(): void;
/**
 * Standalone build does not use p5 instance switching, so these are no-ops.
 */
export function instance(): void;
export function activateInstance(): void;
export function deactivateInstance(): void;
/**
 * Standalone build does not support framebuffer targets — matches upstream
 * (adapters/standalone returned null pre-port; the plan's open question is
 * resolved by keeping this unimplemented: no scenario or tile ever draws
 * into a p5.Framebuffer in the standalone build, and the composite's
 * u_targetIsFramebuffer branch therefore never triggers here).
 *
 * @returns {null}
 */
export function getActiveFramebuffer(): null;
/**
 * Returns whether the given target behaves like a framebuffer target.
 *
 * @returns {boolean}
 */
export function isFramebufferTarget(...args: any[]): boolean;
export function initStandaloneTargetRuntime(): void;
