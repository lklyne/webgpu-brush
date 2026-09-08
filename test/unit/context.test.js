// ============================================================
// brush-gpu – drawing context independence
//
// The context owns the drawing state. Two contexts must not share
// a brush state slice, a push/pop stack, or a flow-field grid.
// Run:  npx vitest run test/unit/context.test.js
// ============================================================

import { describe, it, expect, vi } from "vitest";

// color.js pulls in the compositor; the state under test never reaches it.
vi.mock("../../src/core/color.js", () => ({
  isCanvasReady: () => {},
  isMixReady: () => {},
  registerStrokeComposite: () => {},
  registerFillComposite: () => {},
}));

vi.mock("../../src/core/polygon.js", () => ({
  Polygon: class Polygon {},
}));

vi.mock("../../src/core/plot.js", () => ({
  Plot: class Plot {},
}));

// gl_draw reaches the WebGPU host; stroke.js itself is the real module so its
// state registrar runs.
vi.mock("../../src/stroke/gl_draw.js", () => ({
  isReady: () => {},
  glDraw: () => {},
  glDrawImages: () => {},
  circle: () => {},
  stampImage: () => {},
  invalidateTexEntry: () => {},
  snapshotMatrix: () => {},
  walkEligible: () => false,
  queueWalkStroke: () => ({}),
  flushWalkBatch: () => {},
  _getUseCpuWalk: () => true,
}));

import { createContext } from "../../src/core/context.js";
import {
  addField,
  _field,
  isFieldReady,
  _fieldSnapshot,
  _onTargetResized,
} from "../../src/core/flowfield.js";
import { createFillState } from "../../src/fill/fill.js";
import { push, pop } from "../../src/core/save.js";
import { createStrokeState } from "../../src/stroke/stroke.js";
import { createHatchState } from "../../src/hatch/hatch.js";
import { createWashState } from "../../src/fill/wash.js";
import { createMassState } from "../../src/hatch/mass.js";

/** A context with a target of the given size and neutral host hooks. */
function makeContext(width, height) {
  const ctx = createContext();
  ctx.renderer = {};
  ctx.width = width;
  ctx.height = height;
  ctx.density = 1;
  ctx.usesRadians = () => false;
  ctx.getAffineMatrix = () => ({ a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 });
  return ctx;
}

describe("createContext() — independent state", () => {
  it("gives each context its own state slices", () => {
    const a = makeContext(800, 600);
    const b = makeContext(400, 400);

    for (const slice of ["stroke", "fill", "wash", "hatch", "mass", "field"]) {
      expect(a.state[slice]).not.toBe(b.state[slice]);
    }

    a.state.stroke.type = "marker2";
    a.state.stroke.isActive = true;
    a.state.fill.bleed_strength = 0.9;
    a.state.hatch.angle = 12;
    a.state.field.wiggle = 4;

    expect(b.state.stroke.type).toBe(createStrokeState().type);
    expect(b.state.stroke.isActive).toBe(false);
    expect(b.state.fill.bleed_strength).toBe(createFillState().bleed_strength);
    expect(b.state.hatch.angle).toBe(createHatchState().angle);
    expect(b.state.field.wiggle).toBe(1);
    expect(b.state.wash.opacity).toBe(createWashState().opacity);
    expect(b.state.mass.isActive).toBe(createMassState().isActive);
    expect(a.strokeCursor).not.toBe(b.strokeCursor);
  });

  it("keeps push()/pop() stacks separate", () => {
    const a = makeContext(800, 600);
    const b = makeContext(400, 400);

    a.state.fill.opacity = 10;
    a.state.stroke.weight = 7;
    push(a); // a's stack now holds opacity 10 / weight 7
    a.state.fill.opacity = 20;

    b.state.fill.opacity = 99;
    pop(b); // b's stack is empty — nothing to restore

    expect(a.stateStack.length).toBe(1);
    expect(b.stateStack.length).toBe(0);
    expect(b.state.fill.opacity).toBe(99);

    a.state.stroke.weight = 3;
    pop(a);
    expect(a.state.fill.opacity).toBe(10);
    expect(a.state.stroke.weight).toBe(7);
    expect(b.state.stroke.weight).toBe(1);
  });

  it("builds a grid per context from that context's target size", () => {
    const a = makeContext(800, 600);
    const b = makeContext(400, 400);

    addField("ctx-probe", (_t, field) => field, { angleMode: "degrees" });

    _field(a, "ctx-probe");
    _field(b, "ctx-probe");

    const gridA = _fieldSnapshot(a);
    const gridB = _fieldSnapshot(b);

    expect(gridA.resolution).toBe(8);
    expect(gridA.numColumns).toBe(200);
    expect(gridA.numRows).toBe(150);

    expect(gridB.resolution).toBe(4);
    expect(gridB.numColumns).toBe(200);
    expect(gridB.numRows).toBe(200);

    expect(a.fields).not.toBe(b.fields);
    expect(a.fields.grids.get("ctx-probe").field).not.toBe(
      b.fields.grids.get("ctx-probe").field,
    );
  });

  it("resizing one context leaves the other's grid alone", () => {
    const a = makeContext(800, 600);
    const b = makeContext(800, 600);

    addField("ctx-resize-probe", (_t, field) => field, { angleMode: "degrees" });
    _field(a, "ctx-resize-probe");
    _field(b, "ctx-resize-probe");

    const epochB = b.fields.epoch;

    a.width = 200;
    a.height = 200;
    _onTargetResized(a, 200, 200);
    isFieldReady(a);

    expect(a.fields.resolution).toBe(2); // 200 * 0.01
    expect(a.fields.num_columns).toBe(200); // 2 * 200 / 2
    expect(b.fields.resolution).toBe(8);
    expect(b.fields.epoch).toBe(epochB);
    expect(_fieldSnapshot(b).numRows).toBe(150);
  });
});
