/**
 * The handle returned by `brush.gpu()`.
 * @typedef {ReturnType<typeof brush.gpu>} BrushGpuInterop
 */
/**
 * @typedef {object} PaintingTexture
 * @property {import("three/webgpu").TextureNode} node TSL node sampling the
 *   painting, v flipped to three's plane UV convention. Its `.value` is
 *   swapped to a fresh ExternalTexture whenever brush recreates the painting
 *   (three initializes an ExternalTexture exactly once; it cannot be
 *   re-pointed). Use this in materials.
 * @property {ExternalTexture} texture Current wrapper; replaced on resize.
 * @property {() => void} dispose
 */
/**
 * @typedef {object} Attachment
 * @property {typeof brush} brush The drawing API (the same module as
 *   `brush-gpu/standalone`).
 * @property {HTMLCanvasElement} canvas brush's own canvas. Detached from the
 *   DOM unless `parent` was given; the painting is sampled through `node`.
 * @property {BrushGpuInterop} interop
 * @property {GPUDevice} device The shared device.
 * @property {PaintingTexture} painting
 * @property {import("three/webgpu").TextureNode} node Shortcut for
 *   `painting.node`.
 * @property {() => void} dispose Releases the three wrappers and the
 *   attachment slot. brush's canvas and device stay as they are (brush never
 *   destroys a device it did not create).
 */
/**
 * Options forwarded to `brush.createCanvas`. `parent` defaults to `null`
 * here (the painting is sampled by three, not shown as a DOM canvas).
 * @typedef {{ pixelDensity?: number, parent?: string|Element|null, id?: string }} AttachOptions
 */
/**
 * Wraps a `brush.gpu()` handle as a TSL texture node.
 *
 * The painting is image convention (row 0 = top) and three's plane UVs put
 * v=0 at the bottom, so the node samples with v flipped. Colors are
 * premultiplied values in the preferred canvas format; the texture is left in
 * NoColorSpace so they pass through untouched. Pair with a renderer whose
 * output color space is linear and tone mapping is off for a 1:1 display.
 *
 * @param {BrushGpuInterop} interop
 * @returns {PaintingTexture}
 */
export function createPaintingTexture(interop: BrushGpuInterop): PaintingTexture;
/**
 * Three owns the device; brush adopts it. Works with a renderer an existing
 * scene already created (r3f's `<Canvas>`, for instance). Initializes the
 * renderer if it has not been yet.
 *
 * A device three requested carries default limits unless the renderer was
 * given `requiredLimits`; paintings up to 8192 device pixels per side fit
 * the WebGPU default.
 *
 * @param {import("three/webgpu").WebGPURenderer} renderer
 * @param {number} width logical painting width
 * @param {number} height logical painting height
 * @param {AttachOptions} [options]
 * @returns {Promise<Attachment>}
 */
export function attachToRenderer(renderer: import("three/webgpu").WebGPURenderer, width: number, height: number, options?: AttachOptions): Promise<Attachment>;
/**
 * Brush owns the device; three adopts it. brush requests the adapter's full
 * texture and buffer limits plus every feature the adapter supports, so a
 * renderer built on this device is never in compatibility mode.
 *
 * ```js
 * const att = await createSharedDevice(1024, 1024);
 * const renderer = new WebGPURenderer({ device: att.device });
 * ```
 *
 * @param {number} width logical painting width
 * @param {number} height logical painting height
 * @param {AttachOptions} [options]
 * @returns {Promise<Attachment>}
 */
export function createSharedDevice(width: number, height: number, options?: AttachOptions): Promise<Attachment>;
/**
 * The handle returned by `brush.gpu()`.
 */
export type BrushGpuInterop = ReturnType<typeof brush.gpu>;
export type PaintingTexture = {
    /**
     * TSL node sampling the
     * painting, v flipped to three's plane UV convention. Its `.value` is
     * swapped to a fresh ExternalTexture whenever brush recreates the painting
     * (three initializes an ExternalTexture exactly once; it cannot be
     * re-pointed). Use this in materials.
     */
    node: import("three/webgpu").TextureNode;
    /**
     * Current wrapper; replaced on resize.
     */
    texture: ExternalTexture;
    dispose: () => void;
};
export type Attachment = {
    /**
     * The drawing API (the same module as
     * `brush-gpu/standalone`).
     */
    brush: typeof brush;
    /**
     * brush's own canvas. Detached from the
     * DOM unless `parent` was given; the painting is sampled through `node`.
     */
    canvas: HTMLCanvasElement;
    interop: BrushGpuInterop;
    /**
     * The shared device.
     */
    device: GPUDevice;
    painting: PaintingTexture;
    /**
     * Shortcut for
     * `painting.node`.
     */
    node: import("three/webgpu").TextureNode;
    /**
     * Releases the three wrappers and the
     * attachment slot. brush's canvas and device stay as they are (brush never
     * destroys a device it did not create).
     */
    dispose: () => void;
};
/**
 * Options forwarded to `brush.createCanvas`. `parent` defaults to `null`
 * here (the painting is sampled by three, not shown as a DOM canvas).
 */
export type AttachOptions = {
    pixelDensity?: number;
    parent?: string | Element | null;
    id?: string;
};
import * as brush from "../index.standalone.js";
import { ExternalTexture } from "three/webgpu";
