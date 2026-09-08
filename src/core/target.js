// =============================================================================
// Target Runtime Hooks
// =============================================================================

/**
 * The active drawing target lives on the drawing context: `ctx.renderer`,
 * `ctx.width`, `ctx.height`, `ctx.density`. Host adapters keep them updated
 * through `setTarget()`. The exact renderer type is adapter-defined, but core
 * code assumes it exposes:
 * - `drawingContext`: the active graphics context
 * - `host`: the WebGPU host (standalone adapter)
 *
 * The hook table below is still module-global: the standalone adapter drives
 * exactly one target, so `load()` / `isCanvasReady()` and friends have nothing
 * per-context to say yet.
 */

let targetRuntime = {
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
 * Registers or updates host target hooks used by core modules.
 *
 * @param {object} hooks
 */
export function setTargetRuntime(hooks) {
  targetRuntime = { ...targetRuntime, ...hooks };
}

export const load = (buffer = false, options) => targetRuntime.load(buffer, options);
export const syncDensity = (ctx) => targetRuntime.syncDensity(ctx);
export const isCanvasReady = () => targetRuntime.isCanvasReady();
export const instance = (inst) => targetRuntime.instance(inst);
export const activateInstance = (inst) => targetRuntime.activateInstance(inst);
export const deactivateInstance = () => targetRuntime.deactivateInstance();
export const getActiveFramebuffer = () => targetRuntime.getActiveFramebuffer();
export const isFramebufferTarget = (target) =>
  targetRuntime.isFramebufferTarget(target);
