import { describe, it, expect } from "vitest";
import {
  armDeferred,
  flushDeferred,
  guard,
  guardFor,
  guardReplay,
  guardReplayFor,
  isDeferring,
} from "../../src/adapters/standalone/deferred.js";
import { createContext, defaultContext } from "../../src/core/context.js";

describe("deferred-call recorder", () => {
  it("records while armed, replays in order, then passes through", () => {
    const log = [];
    const a = guard((x) => log.push(`a${x}`));
    const b = guard((x) => log.push(`b${x}`));
    armDeferred(defaultContext);
    expect(isDeferring(defaultContext)).toBe(true);
    expect(a(1)).toBeUndefined();
    b(2);
    a(3);
    expect(log).toEqual([]);
    flushDeferred(defaultContext);
    expect(isDeferring(defaultContext)).toBe(false);
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
    armDeferred(defaultContext);
    expect(() => pick("nope")).toThrow('Brush "nope" not found.');
    pick("ok");
    flushDeferred(defaultContext);
    expect(calls).toEqual(["ok"]); // the rejected call was never recorded
  });

  it("guardReplay applies now and again at flush", () => {
    let value = null;
    const seed = guardReplay(
      (v) => (value = v),
      (v) => (value = `${v}:replayed`),
    );
    armDeferred(defaultContext);
    seed("s");
    expect(value).toBe("s");
    flushDeferred(defaultContext);
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
    armDeferred(defaultContext);
    const p = new P(7);
    expect(p.show()).toBeUndefined();
    flushDeferred(defaultContext);
    expect(p.show()).toBe(7);
  });

  it("each context records into its own queue", () => {
    const a = createContext();
    const b = createContext();
    const log = [];
    const drawA = guardFor(a, (x) => log.push(`a${x}`));
    const drawB = guardFor(b, (x) => log.push(`b${x}`));

    armDeferred(a);
    expect(isDeferring(a)).toBe(true);
    expect(isDeferring(b)).toBe(false);

    drawA(1); // recorded by a
    drawB(2); // b is not recording: runs now
    expect(log).toEqual(["b2"]);

    armDeferred(b);
    drawB(3);
    flushDeferred(a); // replays a's queue only
    expect(log).toEqual(["b2", "a1"]);
    expect(isDeferring(b)).toBe(true);

    flushDeferred(b);
    expect(log).toEqual(["b2", "a1", "b3"]);
  });

  it("guardReplayFor replays into the context it was built for", () => {
    const a = createContext();
    const b = createContext();
    const log = [];
    const seedA = guardReplayFor(a, (v) => log.push(`now:${v}`), (v) => log.push(`replay:${v}`));

    armDeferred(b); // b recording, a is not
    seedA("x");
    expect(log).toEqual(["now:x"]);
    flushDeferred(b);
    expect(log).toEqual(["now:x"]); // nothing of a's landed in b's queue

    armDeferred(a);
    seedA("y");
    flushDeferred(a);
    expect(log).toEqual(["now:x", "now:y", "replay:y"]);
  });
});
