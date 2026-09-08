import { describe, it, expect, beforeEach } from "vitest";
import { armDeferred, flushDeferred } from "../../src/adapters/standalone/deferred.js";
import { createPrecheck, precheck as pre } from "../../src/adapters/standalone/precheck.js";
import { createContext, defaultContext } from "../../src/core/context.js";

// The prechecks mirror upstream's call-site errors while calls are being
// recorded. Arm the recorder so the shadow is (re)seeded, and flush
// afterwards so other suites see a pass-through recorder.
describe("deferred prechecks (upstream error semantics while recording)", () => {
  beforeEach(() => {
    armDeferred(defaultContext);
  });

  it("line() without a brush throws upstream's message; set() clears it", () => {
    expect(() => pre.line()).toThrow("No brush or color set");
    pre.set("HB");
    expect(() => pre.line()).not.toThrow();
    pre.noStroke();
    expect(() => pre.flowLine()).toThrow("No brush or color set");
    flushDeferred(defaultContext);
  });

  it("unknown brush and field names throw at the call site", () => {
    expect(() => pre.pick("__DOES_NOT_EXIST__")).toThrow('Brush "__DOES_NOT_EXIST__" not found');
    expect(() => pre.field("__DOES_NOT_EXIST__")).toThrow('Field "__DOES_NOT_EXIST__" does not exist');
    expect(() => pre.field("seabed")).not.toThrow(); // standard fields registered at load
    flushDeferred(defaultContext);
  });

  it("shape and stroke state machines", () => {
    expect(() => pre.vertex()).toThrow("vertex() called outside");
    expect(() => pre.endShape()).toThrow("endShape() called without");
    pre.beginShape();
    pre.vertex();
    expect(() => pre.endShape()).toThrow("at least 2 vertices");
    pre.vertex();
    expect(() => pre.endShape()).not.toThrow();
    expect(() => pre.move()).toThrow("move() called without");
    expect(() => pre.endStroke()).toThrow("endStroke() called without");
    expect(() => pre.beginStroke("INVALID_TYPE")).toThrow('must be "curve" or "segments"');
    pre.beginStroke("curve");
    expect(() => pre.move()).not.toThrow();
    expect(() => pre.endStroke()).not.toThrow();
    expect(() => pre.spline([[0, 0, 1]])).toThrow("at least 2 points");
    flushDeferred(defaultContext);
  });

  it("field activation and refreshField()", () => {
    pre.noField();
    expect(() => pre.refreshField()).toThrow("No field is currently active");
    pre.wiggle();
    expect(() => pre.refreshField()).not.toThrow();
    flushDeferred(defaultContext);
  });

  it("push/pop restore the brush and field shadow", () => {
    pre.set("HB");
    pre.field("seabed");
    pre.push();
    pre.noStroke();
    pre.noField();
    expect(() => pre.line()).toThrow();
    expect(() => pre.refreshField()).toThrow();
    pre.pop();
    expect(() => pre.line()).not.toThrow();
    expect(() => pre.refreshField()).not.toThrow();
    flushDeferred(defaultContext);
  });

  it("angleMode rejects unknown modes", () => {
    expect(() => pre.angleMode("gradians")).toThrow('Invalid angle mode "gradians"');
    expect(() => pre.angleMode("degrees")).not.toThrow();
    flushDeferred(defaultContext);
  });

  it("keeps one shadow per context", () => {
    const a = createContext();
    const b = createContext();
    const preA = createPrecheck(a);
    const preB = createPrecheck(b);
    armDeferred(a);
    armDeferred(b);

    preA.set("HB");
    preA.beginShape();
    preA.vertex();

    // b's shadow saw none of it.
    expect(() => preB.line()).toThrow("No brush or color set");
    expect(() => preB.vertex()).toThrow("vertex() called outside");
    expect(() => preA.line()).not.toThrow();

    // Arming a re-seeds only a's shadow from a's real state.
    armDeferred(a);
    expect(() => preA.vertex()).toThrow("vertex() called outside");
    expect(a.precheckShadow).not.toBe(b.precheckShadow);

    flushDeferred(a);
    flushDeferred(b);
  });
});
