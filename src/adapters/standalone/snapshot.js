// =============================================================================
// Adapter: Standalone Painting Snapshots (undo support)
//
// snapshot() / restore(handle) / freeSnapshot(handle): a GPU-side snapshot
// stack for the persistent painting texture. p5.brush is immediate-mode —
// there are no stroke objects to replay — so undo for a host application is
// "copy the painting texture aside, copy it back later".
//
// Everything stays on the GPU: copyTextureToTexture into pooled textures
// matching the painting's size/format. NO readback, NO mapAsync (gotcha #9
// holds — grep for mapAsync still matches only webgpu/readback.js).
//
// Both snapshot() and restore() begin with flushActiveComposite(): snapshot
// so the copy includes everything drawn so far, restore so no stale mask
// content or dirty-rect bookkeeping composites onto the restored painting
// afterwards. After the restore copy, the painting is re-presented to the
// canvas via the same painting → getCurrentTexture copy path render() uses.
//
// The pool is bounded (MAX_SNAPSHOTS live handles): taking one beyond the
// bound silently drops the OLDEST live snapshot and reuses its texture.
//
// The pool belongs to the painting it was copied from (`ctx.snapshots`): the
// textures match that painting's size and format, and restoring into another
// painting would blit foreign pixels, so a handle is bound to its context
// and rejected anywhere else.
// =============================================================================

import { isCanvasReady } from "../../core/target.js";
import { flushActiveComposite } from "../../core/color.js";
import { defaultContext, registerContextInit } from "../../core/context.js";

/** Live snapshot bound; the oldest handle is dropped when exceeded. */
export const MAX_SNAPSHOTS = 20;

// Handle ids are opaque and never compared across paintings, so one counter
// serves every context; the pools themselves are per painting.
let nextId = 1;

/**
 * One painting's snapshot pool.
 *
 * @returns {object} The `ctx.snapshots` object.
 */
function createSnapshotPool() {
  return {
    /** @type {Map<number, GPUTexture>} live snapshots by handle id */
    live: new Map(),
    /** @type {number[]} live ids, oldest first (drop order) */
    order: [],
    /** @type {GPUTexture[]} freed textures kept for reuse */
    spare: [],
  };
}

registerContextInit((ctx) => {
  ctx.snapshots = createSnapshotPool();
});

/**
 * Which painting handed out a handle. Weak, so a dropped handle costs
 * nothing; a handle the caller rebuilt by hand has no entry and falls
 * through to the live-map lookup, as it always did.
 * @type {WeakMap<object, import("../../core/context.js").BrushContext>}
 */
const handleOwner = new WeakMap();

/**
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {object} handle
 */
function requireOwned(ctx, handle) {
  const owner = handle && typeof handle === "object" ? handleOwner.get(handle) : undefined;
  return owner === undefined || owner === ctx;
}

/**
 * @param {import("../../core/context.js").BrushContext} ctx
 */
function requireHost(ctx) {
  isCanvasReady(ctx);
  const host = ctx.renderer.host;
  if (!host) {
    throw new Error("brush-gpu: renderer has no WebGPU host — was a target loaded?");
  }
  host.requireReady();
  return host;
}

/** Pooled texture matching the CURRENT painting size/format (may be
 *  bgra8unorm or rgba16float etc. — always mirrors host.gpu.format). */
function acquireTexture(ctx, host) {
  const { spare } = ctx.snapshots;
  const w = host.painting.width;
  const h = host.painting.height;
  const format = host.painting.format;
  while (spare.length > 0) {
    const t = spare.pop();
    if (t.width === w && t.height === h && t.format === format) return t;
    t.destroy(); // stale size/format (canvas was resized) — not reusable
  }
  return host.gpu.createTexture({
    label: "painting-snapshot",
    size: { width: w, height: h },
    format,
    usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
  });
}

function release(ctx, id) {
  const { live, order, spare } = ctx.snapshots;
  const texture = live.get(id);
  if (!texture) return false;
  live.delete(id);
  const at = order.indexOf(id);
  if (at !== -1) order.splice(at, 1);
  if (spare.length < MAX_SNAPSHOTS) spare.push(texture);
  else texture.destroy();
  return true;
}

/**
 * Captures the current painting into a pooled GPU texture.
 *
 * Flushes pending stroke/fill compositing first, so the snapshot contains
 * everything drawn up to this call. Requires `await brush.ready()`.
 *
 * @returns {{__brushSnapshot: number, width: number, height: number}} opaque handle
 */
export function snapshot() {
  return _snapshot(defaultContext);
}

/**
 * Context-taking implementation of snapshot().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @returns {{__brushSnapshot: number, width: number, height: number}} opaque handle
 */
export function _snapshot(ctx) {
  const host = requireHost(ctx);
  const { live, order } = ctx.snapshots;
  flushActiveComposite(ctx);
  if (order.length >= MAX_SNAPSHOTS) release(ctx, order[0]);
  const texture = acquireTexture(ctx, host);
  const enc = host.gpu.device.createCommandEncoder({ label: "snapshot-copy" });
  enc.copyTextureToTexture(
    { texture: host.painting },
    { texture },
    { width: texture.width, height: texture.height },
  );
  host.gpu.device.queue.submit([enc.finish()]);
  const id = nextId++;
  live.set(id, texture);
  order.push(id);
  const handle = { __brushSnapshot: id, width: texture.width, height: texture.height };
  handleOwner.set(handle, ctx);
  return handle;
}

/**
 * Restores the painting from a snapshot handle and re-presents the canvas.
 *
 * Pending (uncomposited) mask work is discarded via the same flush/reset
 * path render() uses, so the next composite starts from clean dirty-rect
 * state. The handle stays valid — restore repeatedly, in any order.
 *
 * @param {{__brushSnapshot: number}} handle from snapshot()
 */
export function restore(handle) {
  return _restore(defaultContext, handle);
}

/**
 * Context-taking implementation of restore().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {{__brushSnapshot: number}} handle
 */
export function _restore(ctx, handle) {
  const host = requireHost(ctx);
  if (!requireOwned(ctx, handle)) {
    throw new Error(
      "brush.restore(): this snapshot was taken from a different painting — " +
        "restore it into the one that took it.",
    );
  }
  const texture = ctx.snapshots.live.get(handle?.__brushSnapshot);
  if (!texture) {
    throw new Error(
      "brush.restore(): unknown or freed snapshot handle (the pool keeps the " +
        `newest ${MAX_SNAPSHOTS}; older snapshots are dropped).`,
    );
  }
  if (texture.width !== host.painting.width || texture.height !== host.painting.height) {
    throw new Error("brush.restore(): snapshot size no longer matches the painting (canvas was resized).");
  }
  // Flush + reset composite state so stale masks / dirty rects cannot land
  // on the restored painting; whatever it composites is overwritten below.
  flushActiveComposite(ctx);
  const enc = host.gpu.device.createCommandEncoder({ label: "snapshot-restore" });
  enc.copyTextureToTexture(
    { texture },
    { texture: host.painting },
    { width: texture.width, height: texture.height },
  );
  host.present(enc);
  host.gpu.device.queue.submit([enc.finish()]);
}

/**
 * Returns a snapshot's texture to the pool. Safe to call with an already
 * freed/dropped handle, or with one belonging to another painting (no-op,
 * returns false).
 *
 * @param {{__brushSnapshot: number}} handle
 * @returns {boolean} true if the handle was live
 */
export function freeSnapshot(handle) {
  return _freeSnapshot(defaultContext, handle);
}

/**
 * Context-taking implementation of freeSnapshot().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {{__brushSnapshot: number}} handle
 * @returns {boolean} true if the handle was live
 */
export function _freeSnapshot(ctx, handle) {
  if (!requireOwned(ctx, handle)) return false;
  return release(ctx, handle?.__brushSnapshot ?? -1);
}
