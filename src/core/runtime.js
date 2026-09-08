// =============================================================================
// Runtime Hooks
// =============================================================================

/**
 * Registers or updates host-runtime hooks on a drawing context.
 *
 * The hooks are fields on the context, not module slots, so two contexts can
 * run against different angle modes and transforms. Their neutral defaults
 * live in `createContext()` (core/context.js), which is what core does when
 * no adapter has registered.
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {object} hooks
 */
export function setRuntime(ctx, hooks) {
  if (hooks.usesRadians) ctx.usesRadians = hooks.usesRadians;
  if (hooks.fromDegrees) ctx.fromDegrees = hooks.fromDegrees;
  if (hooks.createColor) ctx.createColor = hooks.createColor;
  if (hooks.getAffineMatrix) ctx.getAffineMatrix = hooks.getAffineMatrix;
  if (hooks.notifyDraw) ctx.notifyDraw = hooks.notifyDraw;
}
