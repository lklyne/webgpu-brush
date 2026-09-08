// =============================================================================
// Target Runtime Hooks
// =============================================================================

/**
 * The active drawing target lives on the drawing context: `ctx.renderer`,
 * `ctx.width`, `ctx.height`, `ctx.density`. Host adapters keep them updated
 * through `setTarget()`.
 *
 * The hooks that ACT on a target — load it, re-read its density, assert it
 * exists — are context fields too (`ctx.targetHooks`), installed by the host
 * adapter through `setTargetRuntime(ctx, hooks)`. The neutral table below is
 * what core does with no adapter registered.
 *
 * The exact renderer type is adapter-defined, but core code assumes it
 * exposes:
 * - `drawingContext`: the active graphics context
 * - `host`: the WebGPU host (standalone adapter)
 */

import { defaultContext, registerContextInit } from "./context.js";

function defaultTargetHooks() {
  return {
    load: () => {
      throw new Error("No target runtime adapter registered.");
    },
    syncDensity: (ctx) => ctx.density,
    isCanvasReady: () => {
      throw new Error("No target runtime adapter registered.");
    },
    instance: () => {},
    activateInstance: () => {},
    deactivateInstance: () => {},
    getActiveFramebuffer: () => null,
    isFramebufferTarget: () => false,
  };
}

registerContextInit((ctx) => {
  ctx.targetHooks = defaultTargetHooks();
});

/**
 * Points a drawing context at a target.
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {{Renderer?: object, Cwidth?: number, Cheight?: number, Density?: number}} state
 */
export function setTarget(ctx, state) {
  if ("Cwidth" in state) ctx.width = state.Cwidth;
  if ("Cheight" in state) ctx.height = state.Cheight;
  if ("Renderer" in state) ctx.renderer = state.Renderer;
  if ("Density" in state) ctx.density = state.Density;
}

/**
 * Registers or updates one context's host target hooks.
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {object} hooks
 */
export function setTargetRuntime(ctx, hooks) {
  ctx.targetHooks = { ...ctx.targetHooks, ...hooks };
}

export const load = (ctx, buffer = false, options) =>
  ctx.targetHooks.load(ctx, buffer, options);
export const syncDensity = (ctx) => ctx.targetHooks.syncDensity(ctx);
export const isCanvasReady = (ctx) => ctx.targetHooks.isCanvasReady(ctx);
export const instance = (inst) => defaultContext.targetHooks.instance(inst);
export const activateInstance = (inst) => defaultContext.targetHooks.activateInstance(inst);
export const deactivateInstance = () => defaultContext.targetHooks.deactivateInstance();
export const getActiveFramebuffer = (ctx) => ctx.targetHooks.getActiveFramebuffer(ctx);
export const isFramebufferTarget = (ctx, target) =>
  ctx.targetHooks.isFramebufferTarget(target);
