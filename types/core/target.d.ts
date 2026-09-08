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
 * Registers or updates one context's host target hooks.
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {object} hooks
 */
export function setTargetRuntime(ctx: import("./context.js").BrushContext, hooks: object): void;
export function load(ctx: any, buffer: boolean, options: any): any;
export function syncDensity(ctx: any): any;
export function isCanvasReady(ctx: any): any;
export function instance(inst: any): any;
export function activateInstance(inst: any): any;
export function deactivateInstance(): any;
export function getActiveFramebuffer(ctx: any): any;
export function isFramebufferTarget(ctx: any, target: any): any;
