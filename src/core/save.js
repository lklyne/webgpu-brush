import { isFieldReady } from "./flowfield.js";

// =============================================================================
// SAVE / RESTORE
// =============================================================================

/**
 * Pushes the current brush state onto the stack.
 *
 * @param {import("./context.js").BrushContext} ctx
 */
export function push(ctx) {
  isFieldReady(ctx);
  const State = ctx.state;
  ctx.stateStack.push({
    fill: { ...State.fill },
    wash: State.wash ? { ...State.wash } : null,
    stroke: { ...State.stroke },
    hatch: { ...State.hatch },
    mass: State.mass ? { ...State.mass } : null,
    field: { ...State.field },
  });
}

/**
 * Pops the top brush state from the stack and restores it.
 *
 * @param {import("./context.js").BrushContext} ctx
 */
export function pop(ctx) {
  const saved = ctx.stateStack.pop();
  if (!saved) return;
  const State = ctx.state;
  State.stroke = { ...saved.stroke };
  State.field = { ...saved.field };
  State.hatch = { ...saved.hatch };
  State.fill = { ...saved.fill };
  if (saved.wash) State.wash = { ...saved.wash };
  if (saved.mass) {
    State.mass = { ...saved.mass };
  } else if (State.mass) {
    State.mass = {
      ...State.mass,
      isActive: false,
      brush: null,
      color: null,
      options: {},
    };
  }
}
