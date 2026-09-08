// =============================================================================
// Adapter: Standalone Frame Helpers
// =============================================================================

import { isCanvasReady } from "../../core/target.js";
import { flushActiveComposite } from "../../core/color.js";
import { defaultContext, registerContextInit } from "../../core/context.js";
import { setRuntime } from "../../core/runtime.js";
import { flushWalkBatch } from "../../stroke/gl_draw.js";

// ---- render() reminder ----
// If drawing calls are made but render() is never called, nothing appears on
// screen. We detect this via the notifyDraw hook and warn once per cycle.
// Per painting: one that is being rendered must not silence the warning for
// one that is not.

/**
 * @param {import("../../core/context.js").BrushContext} ctx
 */
function onDraw(ctx) {
  const frame = ctx.frame;
  if (frame.warnScheduled) return;
  frame.warnScheduled = true;
  frame.hasPendingDraw = true;
  requestAnimationFrame(() => {
    frame.warnScheduled = false;
    if (frame.hasPendingDraw) {
      console.warn(
        "[p5.brush] Drawing calls were made but brush.render() was never called. " +
        "Call brush.render() after your drawing code to flush to the canvas.",
      );
    }
  });
}

registerContextInit((ctx) => {
  ctx.frame = { hasPendingDraw: false, warnScheduled: false };
  setRuntime(ctx, { notifyDraw: () => onDraw(ctx) });
});

/**
 * @param {import("../../core/context.js").BrushContext} ctx
 */
function resetCompositeState(ctx) {
  // Deferred GPU-walk groups were drawn before this clear; composite them
  // (into pixels the clear then wipes) rather than letting them leak past it.
  flushWalkBatch(ctx);
  const Mix = ctx.mix;
  if (Mix.glMask) Mix.clearMask(ctx, Mix.glMask);
  if (Mix.mask) Mix.clearMask(ctx, Mix.mask);
  Mix.justChanged = false;
  Mix.isBlending = false;
  Mix.isBrush = null;
  Mix.cachedColor = null;
}

/**
 * Flushes any pending stroke/fill compositing into the active standalone target.
 *
 * Standalone users should call this at the end of a drawing pass or frame.
 */
export function render() {
  return _render(defaultContext);
}

/**
 * Context-taking implementation of render().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 */
export function _render(ctx) {
  ctx.frame.hasPendingDraw = false;
  flushActiveComposite(ctx);
}

/**
 * Clears the active standalone target.
 *
 * With no arguments, clears to transparent white.
 * With a color, clears to that color at full opacity.
 *
 * @param {...*} args
 */
export function clear(...args) {
  return _clear(defaultContext, ...args);
}

/**
 * Context-taking implementation of clear().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {...*} args
 */
export function _clear(ctx, ...args) {
  isCanvasReady(ctx);
  resetCompositeState(ctx);

  const color =
    args.length === 0
      ? [1, 1, 1, 0]
      : [...ctx.createColor(...args)._array.slice(0, 3), 1];

  ctx.renderer.host.clearPainting({
    r: color[0],
    g: color[1],
    b: color[2],
    a: color[3],
  });
}
