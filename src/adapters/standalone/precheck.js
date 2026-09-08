// =============================================================================
// Adapter: Standalone call-site prechecks for the deferred-call recorder
//
// While calls are being recorded (deferred.js), upstream's own argument and
// precondition checks would only run at replay, inside the ready() promise.
// A sketch written for upstream expects them at the call site — its error
// tests wrap `brush.line()` without a brush, `vertex()` outside
// `beginShape()`, `refreshField()` without a field, in try/catch. So the
// validators below run synchronously while deferring, against a SHADOW of
// exactly the state those checks read: whether a brush+color is set,
// whether a shape / stroke is open (and its vertex count), whether a field
// is active, and a push/pop stack for the first and last of those. The
// shadow is seeded from the real state when recording starts and is
// consulted only while deferring; once ready, the real functions check.
//
// The shadow belongs to the painting whose state it mirrors (`ctx`), like
// the recorder that seeds it: `createPrecheck(ctx)` builds one validator
// table per context, and `precheck` is the default painting's.
//
// Messages are upstream's verbatim (stroke/stroke.js, core/primitives.js,
// core/flowfield.js, adapters/standalone/runtime.js) so a caught error
// reads the same either way.
// =============================================================================

import { defaultContext, registerContextInit } from "../../core/context.js";
import { assertBrush } from "../../stroke/stroke.js";
import { assertField } from "../../core/flowfield.js";
import { DEGREES, RADIANS } from "./runtime.js";
import { onArm } from "./deferred.js";

function createShadow() {
  return {
    strokeActive: false,
    fieldActive: false,
    shapeOpen: false,
    shapeVerts: 0,
    strokeOpen: false,
    /** @type {Array<{strokeActive: boolean, fieldActive: boolean}>} */
    stack: [],
  };
}

/**
 * Re-seeds a context's shadow from that context's real state.
 * @param {import("../../core/context.js").BrushContext} ctx
 */
function seedShadow(ctx) {
  const shadow = ctx.precheckShadow;
  const State = ctx.state;
  shadow.strokeActive = !!(State.stroke?.isActive && State.stroke?.color);
  shadow.fieldActive = !!(State.field?.isActive && State.field?.current);
  shadow.shapeOpen = false;
  shadow.shapeVerts = 0;
  shadow.strokeOpen = false;
  shadow.stack.length = 0;
}

// Registered after deferred.js's initializer — this module imports it, so its
// recorder is installed on every context before the shadow is hung off one.
registerContextInit((ctx) => {
  ctx.precheckShadow = createShadow();
  onArm(ctx, () => seedShadow(ctx));
});

const NO_BRUSH = "No brush or color set. Call brush.set('brushName', color) before drawing.";

/**
 * Builds one painting's validator table, keyed by public export name. Each
 * entry mirrors one upstream check against `ctx`'s shadow.
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @returns {object}
 */
export function createPrecheck(ctx) {
  const requireBrush = () => {
    if (!ctx.precheckShadow.strokeActive) throw new Error(NO_BRUSH);
  };

  return {
    angleMode(mode) {
      if (mode !== DEGREES && mode !== RADIANS) {
        throw new Error(`Invalid angle mode "${mode}". Use "degrees" or "radians".`);
      }
    },

    push() {
      const shadow = ctx.precheckShadow;
      shadow.stack.push({ strokeActive: shadow.strokeActive, fieldActive: shadow.fieldActive });
    },
    pop() {
      const shadow = ctx.precheckShadow;
      const saved = shadow.stack.pop();
      if (saved) Object.assign(shadow, saved);
    },

    pick: (name) => assertBrush(name),
    set(name) {
      assertBrush(name);
      ctx.precheckShadow.strokeActive = true;
    },
    stroke() {
      ctx.precheckShadow.strokeActive = true;
    },
    noStroke() {
      ctx.precheckShadow.strokeActive = false;
    },
    line: requireBrush,
    flowLine: requireBrush,

    beginShape() {
      const shadow = ctx.precheckShadow;
      shadow.shapeOpen = true;
      shadow.shapeVerts = 0;
    },
    vertex() {
      const shadow = ctx.precheckShadow;
      if (!shadow.shapeOpen) {
        throw new Error(
          "vertex() called outside of beginShape()/endShape(). Call beginShape() first.",
        );
      }
      shadow.shapeVerts++;
    },
    endShape() {
      const shadow = ctx.precheckShadow;
      if (!shadow.shapeOpen) {
        throw new Error("endShape() called without beginShape(). Call beginShape() first.");
      }
      if (shadow.shapeVerts < 2) {
        throw new Error("endShape() requires at least 2 vertices. Add more with vertex().");
      }
      shadow.shapeOpen = false;
    },

    beginStroke(type) {
      if (type !== "curve" && type !== "segments") {
        throw new Error(`beginStroke() type must be "curve" or "segments", got "${type}".`);
      }
      ctx.precheckShadow.strokeOpen = true;
    },
    move() {
      if (!ctx.precheckShadow.strokeOpen) {
        throw new Error("move() called without beginStroke(). Call beginStroke() first.");
      }
    },
    endStroke() {
      const shadow = ctx.precheckShadow;
      if (!shadow.strokeOpen) {
        throw new Error("endStroke() called without beginStroke(). Call beginStroke() first.");
      }
      shadow.strokeOpen = false;
    },

    spline(points) {
      if (!points || points.length < 2) {
        throw new Error(
          "spline() requires at least 2 points. Each point should be [x, y, pressure].",
        );
      }
    },

    field(name) {
      assertField(name);
      ctx.precheckShadow.fieldActive = true;
    },
    noField() {
      ctx.precheckShadow.fieldActive = false;
    },
    wiggle() {
      ctx.precheckShadow.fieldActive = true;
    },
    refreshField() {
      if (!ctx.precheckShadow.fieldActive) {
        throw new Error(
          "No field is currently active. Call brush.field('name') to activate one before refreshing.",
        );
      }
    },
  };
}

/** The default painting's validators — what the module-level API is wrapped with. */
export const precheck = createPrecheck(defaultContext);
