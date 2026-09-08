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
// Messages are upstream's verbatim (stroke/stroke.js, core/primitives.js,
// core/flowfield.js, adapters/standalone/runtime.js) so a caught error
// reads the same either way.
// =============================================================================

import { defaultContext } from "../../core/context.js";
import { assertBrush } from "../../stroke/stroke.js";
import { assertField } from "../../core/flowfield.js";
import { DEGREES, RADIANS } from "./runtime.js";
import { onArm } from "./deferred.js";

const shadow = {
  strokeActive: false,
  fieldActive: false,
  shapeOpen: false,
  shapeVerts: 0,
  strokeOpen: false,
  /** @type {Array<{strokeActive: boolean, fieldActive: boolean}>} */
  stack: [],
};

onArm(() => {
  const State = defaultContext.state;
  shadow.strokeActive = !!(State.stroke.isActive && State.stroke.color);
  shadow.fieldActive = !!(State.field.isActive && State.field.current);
  shadow.shapeOpen = false;
  shadow.shapeVerts = 0;
  shadow.strokeOpen = false;
  shadow.stack.length = 0;
});

const NO_BRUSH = "No brush or color set. Call brush.set('brushName', color) before drawing.";

function requireBrush() {
  if (!shadow.strokeActive) throw new Error(NO_BRUSH);
}

/** Validators keyed by public export name. Each mirrors one upstream check. */
export const precheck = {
  angleMode(mode) {
    if (mode !== DEGREES && mode !== RADIANS) {
      throw new Error(`Invalid angle mode "${mode}". Use "degrees" or "radians".`);
    }
  },

  push() {
    shadow.stack.push({ strokeActive: shadow.strokeActive, fieldActive: shadow.fieldActive });
  },
  pop() {
    const saved = shadow.stack.pop();
    if (saved) Object.assign(shadow, saved);
  },

  pick: (name) => assertBrush(name),
  set(name) {
    assertBrush(name);
    shadow.strokeActive = true;
  },
  stroke() {
    shadow.strokeActive = true;
  },
  noStroke() {
    shadow.strokeActive = false;
  },
  line: requireBrush,
  flowLine: requireBrush,

  beginShape() {
    shadow.shapeOpen = true;
    shadow.shapeVerts = 0;
  },
  vertex() {
    if (!shadow.shapeOpen) {
      throw new Error(
        "vertex() called outside of beginShape()/endShape(). Call beginShape() first.",
      );
    }
    shadow.shapeVerts++;
  },
  endShape() {
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
    shadow.strokeOpen = true;
  },
  move() {
    if (!shadow.strokeOpen) {
      throw new Error("move() called without beginStroke(). Call beginStroke() first.");
    }
  },
  endStroke() {
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
    shadow.fieldActive = true;
  },
  noField() {
    shadow.fieldActive = false;
  },
  wiggle() {
    shadow.fieldActive = true;
  },
  refreshField() {
    if (!shadow.fieldActive) {
      throw new Error(
        "No field is currently active. Call brush.field('name') to activate one before refreshing.",
      );
    }
  },
};
