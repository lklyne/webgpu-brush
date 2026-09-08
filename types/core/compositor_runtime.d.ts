/**
 * Registers or updates host compositor hooks used by core compositing code.
 *
 * @param {object} hooks
 */
export function setCompositorRuntime(hooks: object): void;
export function create2DCanvas(width: any, height: any, willReadFrequently?: boolean): OffscreenCanvas | HTMLCanvasElement;
export function get2DContext(canvas: any, willReadFrequently?: boolean): any;
export function clearTarget(...args: any[]): never;
export function ensureBlendShaderProgram(...args: any[]): never;
export function ensureBlendSourceFramebuffer(...args: any[]): never;
export function createFramebuffer(...args: any[]): never;
export function runBlendShaderPass(...args: any[]): never;
export function blitSourceToFramebuffer(...args: any[]): never;
