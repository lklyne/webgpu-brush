// ============================================================
// p5.brush – Position / flowfield characterization tests
//
// Characterizes the current behavior of Position (isInCanvas,
// moveTo, _moveToDegrees, movePos) and field setup.
// Run:  npx vitest run test/unit/flowfield.test.js
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Hoisted mock state ----
const { currentAngleMode, plotInstances } = vi.hoisted(() => ({
  currentAngleMode: { value: "radians" },
  plotInstances: [],
}));

vi.mock("../../src/core/color.js", () => ({
  isCanvasReady: () => {},
  isMixReady: () => {},
}));

vi.mock("../../src/stroke/stroke.js", () => ({
  BrushState: () => ({}),
  BrushSetState: () => {},
  set: () => {},
  line: () => {},
}));

vi.mock("../../src/core/polygon.js", () => ({
  Polygon: class Polygon {},
}));

vi.mock("../../src/core/plot.js", () => ({
  Plot: class Plot {
    constructor(type) {
      this.type = type;
      this.addSegment = vi.fn();
      this.endPlot = vi.fn();
      this.draw = vi.fn();
      this.show = vi.fn();
      plotInstances.push(this);
    }
  },
}));

import {
  Position,
  addField,
  field as activateField,
  noField,
  isFieldReady as isFieldReadyCtx,
  listFields,
  _onTargetResized as _onTargetResizedCtx,
  _fieldSnapshot as _fieldSnapshotCtx,
  _fieldEpochNow as _fieldEpochNowCtx,
} from "../../src/core/flowfield.js";
import { defaultContext } from "../../src/core/context.js";

// The state, the target and the host hooks all live on the context now, so
// the suite drives it directly instead of mocking core/target.js and
// core/runtime.js away. Mutable size: the field-grid tests swap the target
// the way a second createCanvas() would.
const canvasSize = { width: 800, height: 600 };
Object.defineProperties(defaultContext, {
  width: { get: () => canvasSize.width },
  height: { get: () => canvasSize.height },
});
Object.assign(defaultContext, {
  renderer: {},
  density: 1,
  usesRadians: () => currentAngleMode.value === "radians",
  fromDegrees: (angle) =>
    currentAngleMode.value === "radians" ? (angle * Math.PI) / 180 : angle,
  createColor: () => ({}),
  getAffineMatrix: () => ({ a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 }),
});
const mockState = defaultContext.state;

// isFieldReady() / _fieldSnapshot() / _onTargetResized() / _fieldEpochNow()
// take the drawing context first (core/context.js).
const isFieldReady = () => isFieldReadyCtx(defaultContext);
const _fieldSnapshot = () => _fieldSnapshotCtx(defaultContext);
const _onTargetResized = (w, h) => _onTargetResizedCtx(defaultContext, w, h);
const _fieldEpochNow = () => _fieldEpochNowCtx(defaultContext);

// Canvas is 800×600 (mocked in target.js).
// isInCanvas margin = 0.5
// Valid x range: [-400, 1200]  (-0.5*800 to 1.5*800)
// Valid y range: [-300, 900]   (-0.5*600 to 1.5*600)

beforeEach(() => {
  currentAngleMode.value = "radians";
  plotInstances.length = 0;
  if (mockState.field) {
    mockState.field.isActive = false;
    mockState.field.current = null;
    mockState.field.wiggle = 1;
  }
});

// ---------------------------------------------------------------------------
// 1. isInCanvas — margin pin
// ---------------------------------------------------------------------------
describe("Position.isInCanvas() — margin = 0.5", () => {
  it("returns true at canvas center (400, 300)", () => {
    noField();
    const pos = new Position(400, 300);
    expect(pos.isInCanvas()).toBe(true);
  });

  it("returns true at the canvas origin (0, 0)", () => {
    noField();
    const pos = new Position(0, 0);
    expect(pos.isInCanvas()).toBe(true);
  });

  it("returns true at the canvas edge (800, 600)", () => {
    noField();
    const pos = new Position(800, 600);
    expect(pos.isInCanvas()).toBe(true);
  });

  it("returns true at x=-400 (margin left boundary)", () => {
    noField();
    const pos = new Position(-400, 300);
    expect(pos.isInCanvas()).toBe(true);
  });

  it("returns false at x=-401 (just outside margin)", () => {
    noField();
    const pos = new Position(-401, 300);
    expect(pos.isInCanvas()).toBe(false);
  });

  it("returns true at x=1200 (margin right boundary)", () => {
    noField();
    const pos = new Position(1200, 300);
    expect(pos.isInCanvas()).toBe(true);
  });

  it("returns false at x=1201 (just outside margin right)", () => {
    noField();
    const pos = new Position(1201, 300);
    expect(pos.isInCanvas()).toBe(false);
  });

  it("returns true at y=-300 (margin top boundary)", () => {
    noField();
    const pos = new Position(400, -300);
    expect(pos.isInCanvas()).toBe(true);
  });

  it("returns false at y=-301 (just outside margin top)", () => {
    noField();
    const pos = new Position(400, -301);
    expect(pos.isInCanvas()).toBe(false);
  });

  it("returns true at y=900 (margin bottom boundary)", () => {
    noField();
    const pos = new Position(400, 900);
    expect(pos.isInCanvas()).toBe(true);
  });

  it("returns false at y=901 (just outside margin bottom)", () => {
    noField();
    const pos = new Position(400, 901);
    expect(pos.isInCanvas()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. moveTo — single step (radians and degrees modes)
// ---------------------------------------------------------------------------
describe("Position.moveTo() — no active field", () => {
  it("moves +x by L when direction is 0° (radians mode)", () => {
    currentAngleMode.value = "radians";
    noField();
    const pos = new Position(400, 300);
    pos.moveTo(0, 10, 10);
    expect(pos.x).toBeCloseTo(410, 3);
    expect(pos.y).toBeCloseTo(300, 3);
  });

  it("moves -y by L when direction is 90° (up in y-down coords, radians mode)", () => {
    currentAngleMode.value = "radians";
    noField();
    const pos = new Position(400, 300);
    pos.moveTo(Math.PI / 2, 10, 10);
    // cossin(-90°) = [cos(-90°), sin(-90°)] = [~0, -1], so y decreases
    expect(pos.x).toBeCloseTo(400, 3);
    expect(pos.y).toBeCloseTo(290, 3);
  });

  it("moves +x by L when direction is 0° (degrees mode)", () => {
    currentAngleMode.value = "degrees";
    noField();
    const pos = new Position(400, 300);
    pos.moveTo(0, 10, 10);
    expect(pos.x).toBeCloseTo(410, 3);
    expect(pos.y).toBeCloseTo(300, 3);
  });

  it("moves -y by L when direction is 90° (degrees mode)", () => {
    currentAngleMode.value = "degrees";
    noField();
    const pos = new Position(400, 300);
    pos.moveTo(90, 10, 10);
    expect(pos.x).toBeCloseTo(400, 3);
    expect(pos.y).toBeCloseTo(290, 3);
  });
});

// ---------------------------------------------------------------------------
// 3. Repeated moveTo accumulates
// ---------------------------------------------------------------------------
describe("Position.moveTo() — accumulated movement", () => {
  it("accumulates 2×L after two calls in the same direction (radians)", () => {
    currentAngleMode.value = "radians";
    noField();
    const pos = new Position(400, 300);
    pos.moveTo(0, 10, 10); // move 10 along x
    pos.moveTo(0, 10, 10); // move another 10 along x
    expect(pos.x).toBeCloseTo(420, 3);
    expect(pos.y).toBeCloseTo(300, 3);
  });

  it("plotted property accumulates step counts", () => {
    currentAngleMode.value = "radians";
    noField();
    const pos = new Position(400, 300);
    pos.moveTo(0, 10, 2); // 5 steps of size 2
    expect(pos.plotted).toBeCloseTo(10, 3);
  });
});

// ---------------------------------------------------------------------------
// 4. Position starting far outside canvas does not move
// ---------------------------------------------------------------------------
describe("Position.movePos() — early exit when outside canvas", () => {
  it("a position far outside the canvas does not move when movePos is called", () => {
    noField();
    // x=5000 is well beyond the 1200 right margin
    const pos = new Position(5000, 300);
    const xBefore = pos.x;
    const yBefore = pos.y;
    // movePos is called internally by moveTo when field is active;
    // call _moveConstant directly to test the isIn() early exit
    pos._moveConstant(0, 100, 10);
    // Should not have moved (isIn() returns false → early exit after single plotted increment)
    expect(pos.x).toBeCloseTo(xBefore, 5);
    expect(pos.y).toBeCloseTo(yBefore, 5);
  });

  it("plotted still increments on the early-exit step", () => {
    noField();
    const pos = new Position(5000, 300);
    pos._moveConstant(0, 100, 10);
    // The early-exit branch adds _step (10) to plotted
    expect(pos.plotted).toBeCloseTo(10, 5);
  });
});

// ---------------------------------------------------------------------------
// 5. With an active field — moveTo follows field angle
// ---------------------------------------------------------------------------
describe("Position.moveTo() — with active constant field", () => {
  it("field angle combines with direction arg: field=90°, dir=0° moves along +y, not +x", () => {
    // Register a constant 90° field (points downward in y-down coords).
    // movePos computes: angle = fieldAngle - plotAngle = 90 - 0 = 90
    // cossin(90°) = [cos(90°), sin(90°)] = [0, 1]
    // → x stays at 400, y increases by step (10) → final (400, 310)
    // This DIFFERS from the no-field result (410, 300), so the test catches
    // any regression where the field is silently ignored.
    addField(
      "const-ninety-deg",
      (_t, field) => {
        for (let c = 0; c < field.length; c++) {
          for (let r = 0; r < field[c].length; r++) {
            field[c][r] = 90; // 90 degrees → move along +y
          }
        }
        return field;
      },
      { angleMode: "degrees" },
    );

    activateField("const-ninety-deg");
    mockState.field.wiggle = 1;

    const pos = new Position(400, 300);
    currentAngleMode.value = "degrees";
    pos.moveTo(0, 10, 10);
    // field=90°, dir=0°: angle = 90 - 0 = 90 → cossin(90°) = [0, 1] → +y only
    expect(pos.x).toBeCloseTo(400, 1);
    expect(pos.y).toBeCloseTo(310, 1);
  });
});

// ---------------------------------------------------------------------------
// 6. Field grid follows the target size
// ---------------------------------------------------------------------------
describe("field grid — target size", () => {
  let generations = 0;

  addField(
    "resize-probe",
    (_t, field) => {
      generations++;
      return field;
    },
    { angleMode: "degrees" },
  );

  beforeEach(() => {
    // Normalize to the default 800×600 target before each case.
    canvasSize.width = 800;
    canvasSize.height = 600;
    _onTargetResized(800, 600);
    isFieldReady();
  });

  it("rebuilds the geometry for a target of a different size", () => {
    activateField("resize-probe");
    const small = _fieldSnapshot();
    expect(small.resolution).toBe(8); // 800 * 0.01
    expect(small.leftX).toBe(-400);
    expect(small.topY).toBe(-300);
    expect(small.numColumns).toBe(200);
    expect(small.numRows).toBe(150);
    expect(small.data.length).toBe(200 * 150);

    canvasSize.width = 400;
    canvasSize.height = 400;
    _onTargetResized(400, 400);
    isFieldReady();

    const square = _fieldSnapshot();
    expect(square.resolution).toBe(4); // 400 * 0.01
    expect(square.leftX).toBe(-200);
    expect(square.topY).toBe(-200);
    expect(square.numRows).toBe(200);
    expect(square.data.length).toBe(200 * 200);
    // The GPU stroke walker keys its upload on the epoch.
    expect(square.epoch).toBeGreaterThan(small.epoch);
    // Definitions survive; only the generated grids are discarded.
    expect(listFields()).toContain("resize-probe");
  });

  it("regenerates nothing when the target size is unchanged", () => {
    activateField("resize-probe");
    const before = generations;
    const epochBefore = _fieldEpochNow();

    _onTargetResized(800, 600);
    isFieldReady();

    expect(generations).toBe(before);
    expect(_fieldEpochNow()).toBe(epochBefore);
    expect(_fieldSnapshot().resolution).toBe(8);
  });
});
