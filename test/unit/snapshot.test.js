// ============================================================
// brush-gpu – painting snapshots belong to their painting
//
// The pooled textures match the painting they were copied from, so a
// handle taken by one context must not restore into another.
// Run:  npx vitest run test/unit/snapshot.test.js
// ============================================================

import { describe, it, expect, vi, beforeAll } from "vitest";

// snapshot.js only needs the composite flush from color.js; the real module
// pulls in the whole compositor.
vi.mock("../../src/core/color.js", () => ({
  flushActiveComposite: () => {},
}));

import { createContext } from "../../src/core/context.js";
import { setTargetRuntime } from "../../src/core/target.js";
import {
  _snapshot,
  _restore,
  _freeSnapshot,
} from "../../src/adapters/standalone/snapshot.js";

beforeAll(() => {
  globalThis.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2 };
});

/** A context with a minimal WebGPU host: enough to copy textures around. */
function makeContext() {
  const ctx = createContext();
  const painting = { width: 4, height: 4, format: "bgra8unorm" };
  const copies = [];
  ctx.renderer = {
    host: {
      painting,
      copies,
      requireReady: () => {},
      present: () => {},
      gpu: {
        createTexture: (desc) => ({
          width: desc.size.width,
          height: desc.size.height,
          format: desc.format,
          destroy: () => {},
        }),
        device: {
          createCommandEncoder: () => ({
            copyTextureToTexture: (src, dst) => copies.push([src.texture, dst.texture]),
            finish: () => ({}),
          }),
          queue: { submit: () => {} },
        },
      },
    },
  };
  setTargetRuntime(ctx, { isCanvasReady: () => {} });
  return ctx;
}

describe("snapshots are per painting", () => {
  it("rejects a handle taken by another context", () => {
    const a = makeContext();
    const b = makeContext();

    const handle = _snapshot(a);
    expect(a.snapshots.live.size).toBe(1);
    expect(b.snapshots.live.size).toBe(0);
    expect(a.snapshots).not.toBe(b.snapshots);

    expect(() => _restore(b, handle)).toThrow("different painting");
    expect(() => _restore(a, handle)).not.toThrow();

    // b cannot free a's texture either, and a's handle stays live.
    expect(_freeSnapshot(b, handle)).toBe(false);
    expect(a.snapshots.live.size).toBe(1);
    expect(_freeSnapshot(a, handle)).toBe(true);
    expect(a.snapshots.live.size).toBe(0);
  });

  it("keeps unknown handles on the old error", () => {
    const a = makeContext();
    expect(() => _restore(a, { __brushSnapshot: 9999 })).toThrow(
      "unknown or freed snapshot handle",
    );
  });
});
