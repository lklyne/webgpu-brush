/**
 * Points a drawing context at a target.
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {{Renderer?: object, Cwidth?: number, Cheight?: number, Density?: number}} state
 */
export function setTarget(ctx: import("./context.js").BrushContext, state: {
    Renderer?: object;
    Cwidth?: number;
    Cheight?: number;
    Density?: number;
}): void;
/**
 * Registers or updates host target hooks used by core modules.
 *
 * @param {object} hooks
 */
export function setTargetRuntime(hooks: object): void;
export function load(buffer: boolean, options: any): never;
export function syncDensity(ctx: any): any;
export function isCanvasReady(): never;
export function instance(inst: any): void;
export function activateInstance(inst: any): void;
export function deactivateInstance(): void;
export function getActiveFramebuffer(): any;
export function isFramebufferTarget(target: any): boolean;
