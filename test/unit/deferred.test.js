import { describe, it, expect } from "vitest";
import {
  armDeferred,
  flushDeferred,
  guard,
  guardReplay,
  isDeferring,
} from "../../src/adapters/standalone/deferred.js";

describe("deferred-call recorder", () => {
  it("records while armed, replays in order, then passes through", () => {
    const log = [];
    const a = guard((x) => log.push(`a${x}`));
    const b = guard((x) => log.push(`b${x}`));
    armDeferred();
    expect(isDeferring()).toBe(true);
    expect(a(1)).toBeUndefined();
    b(2);
    a(3);
    expect(log).toEqual([]);
    flushDeferred();
    expect(isDeferring()).toBe(false);
    expect(log).toEqual(["a1", "b2", "a3"]);
    expect(a(4)).toBe(4); // direct call returns fn's result
  });

  it("runs the validator at the call site while deferring", () => {
    const calls = [];
    const pick = guard(
      (name) => calls.push(name),
      (name) => {
        if (name !== "ok") throw new Error(`Brush "${name}" not found.`);
      },
    );
    armDeferred();
    expect(() => pick("nope")).toThrow('Brush "nope" not found.');
    pick("ok");
    flushDeferred();
    expect(calls).toEqual(["ok"]); // the rejected call was never recorded
  });

  it("guardReplay applies now and again at flush", () => {
    let value = null;
    const seed = guardReplay(
      (v) => (value = v),
      (v) => (value = `${v}:replayed`),
    );
    armDeferred();
    seed("s");
    expect(value).toBe("s");
    flushDeferred();
    expect(value).toBe("s:replayed");
  });

  it("preserves `this` for prototype methods", () => {
    class P {
      constructor(n) {
        this.n = n;
      }
    }
    P.prototype.show = guard(function () {
      return this.n;
    });
    armDeferred();
    const p = new P(7);
    expect(p.show()).toBeUndefined();
    flushDeferred();
    expect(p.show()).toBe(7);
  });
});
