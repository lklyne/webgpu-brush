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
export function setRuntime(ctx: import("./context.js").BrushContext, hooks: object): void;
