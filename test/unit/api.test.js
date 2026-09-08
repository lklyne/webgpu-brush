// ============================================================
// brush-gpu – createBrush() instances
//
// The instance surface must stay the module surface, name for name, or a
// sketch written against `import * as brush` cannot be moved onto an
// instance by renaming one identifier. Also: class owners, independent seed
// streams, and dispose().
// Run:  npx vitest run test/unit/api.test.js
// ============================================================

import { describe, it, expect } from "vitest";

import * as brush from "../../src/index.standalone.js";
import { createBrush } from "../../src/api.js";
import { Polygon } from "../../src/core/polygon.js";
import { Plot } from "../../src/core/plot.js";
import { Position } from "../../src/core/flowfield.js";

/**
 * Module exports that are deliberately not per painting:
 * test instrumentation, the adapter installer, and the p5 no-op.
 */
const MODULE_ONLY = [
  "_stats",
  "_geometryStats",
  "_resetGeometryStats",
  "_fillDriverStats",
  "initStandaloneRuntime",
  "instance",
  "createBrush",
];

/** Instance-only members: no module-level equivalent exists. */
const INSTANCE_ONLY = ["canvas", "dispose"];

describe("createBrush() public surface", () => {
  const api = createBrush();

  it("carries every module export, name for name", () => {
    const expected = Object.keys(brush)
      .filter((name) => !MODULE_ONLY.includes(name))
      .sort();
    const actual = Object.keys(api)
      .filter((name) => !INSTANCE_ONLY.includes(name))
      .sort();
    expect(actual).toEqual(expected);
  });

  it("adds nothing beyond dispose() and canvas", () => {
    const extra = Object.keys(api).filter(
      (name) => !(name in brush) && !INSTANCE_ONLY.includes(name),
    );
    expect(extra).toEqual([]);
  });

  it("matches the module surface member for member in kind", () => {
    for (const name of Object.keys(api)) {
      if (INSTANCE_ONLY.includes(name)) continue;
      expect(typeof api[name], name).toBe(typeof brush[name]);
    }
  });

  it("has no target before createCanvas()", () => {
    expect(api.canvas).toBe(null);
  });
});

describe("class owners", () => {
  it("tags shapes built through an instance, and only those", () => {
    const a = createBrush();
    const b = createBrush();

    const pa = new a.Polygon([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    const pb = new b.Polygon([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    const bare = new Polygon([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);

    expect(pa).toBeInstanceOf(Polygon);
    expect(pa.owner).toBeTruthy();
    expect(pb.owner).toBeTruthy();
    expect(pa.owner).not.toBe(pb.owner);
    // A bare `new Polygon()` keeps falling back to the default painting.
    expect(bare.owner).toBeUndefined();
  });

  it("tags Plot too, and subclasses Position", () => {
    const a = createBrush();
    const plot = new a.Plot("curve");
    expect(plot).toBeInstanceOf(Plot);
    expect(plot.owner).toBe(new a.Polygon([[0, 0]]).owner);

    // Position's constructor builds a field grid, so it needs a live target
    // (the two-instance oracle exercises it); here just prove the binding.
    expect(Object.getPrototypeOf(a.Position)).toBe(Position);
    expect(a.Position.prototype).toBeInstanceOf(Position);
  });
});

describe("instance randomness", () => {
  it("seeds one painting's stream without touching another's", () => {
    const a = createBrush();
    const b = createBrush();

    a.seed("a");
    b.seed("b");
    const drawnByA = [a.random(), a.random()];
    b.random();
    b.random();
    b.random();

    const reference = createBrush();
    reference.seed("a");
    expect([reference.random(), reference.random()]).toEqual(drawnByA);
  });

  it("leaves the module-level stream alone", () => {
    brush.seed("module");
    const first = brush.random();

    const other = createBrush();
    other.seed("other");
    other.random();
    other.random();

    brush.seed("module");
    expect(brush.random()).toBe(first);
  });
});

describe("dispose()", () => {
  it("makes every method throw a disposed error", () => {
    const api = createBrush();
    api.dispose();

    expect(() => api.line(0, 0, 1, 1)).toThrow(/disposed painting/);
    expect(() => api.render()).toThrow(/disposed painting/);
    expect(() => api.seed("x")).toThrow(/disposed painting/);
    expect(() => api.readPixels()).toThrow(/disposed painting/);
  });

  it("is idempotent", () => {
    const api = createBrush();
    api.dispose();
    expect(() => api.dispose()).not.toThrow();
  });

  it("leaves other paintings drawing", () => {
    const a = createBrush();
    const b = createBrush();
    b.seed("b");
    const before = b.random();

    a.dispose();

    b.seed("b");
    expect(b.random()).toBe(before);
    expect(() => b.noStroke()).not.toThrow();
  });
});
