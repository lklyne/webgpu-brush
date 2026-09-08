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

let _hasPendingDraw = false;
let _warnScheduled = false;

function onDraw() {
  if (_warnScheduled) return;
  _warnScheduled = true;
  _hasPendingDraw = true;
  requestAnimationFrame(() => {
    _warnScheduled = false;
    if (_hasPendingDraw) {
      console.warn(
        "[p5.brush] Drawing calls were made but brush.render() was never called. " +
        "Call brush.render() after your drawing code to flush to the canvas.",
      );
    }
  });
}

// The reminder is a property of the page, not of a painting, but the hook
// is a context field: install it on every context.
registerContextInit((ctx) => setRuntime(ctx, { notifyDraw: onDraw }));

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
  _hasPendingDraw = false;
  flushActiveComposite(defaultContext);
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
  const ctx = defaultContext;
  isCanvasReady();
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
