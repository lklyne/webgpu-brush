/**
 * @fileoverview Standalone entry point for brush-gpu (WebGPU).
 *
 * The stateful public API is wrapped by the deferred-call recorder
 * (adapters/standalone/deferred.js). Between createCanvas()/load() and the
 * device resolving, calls are recorded and replayed in program order once
 * the device and the GPU stroke walker are ready, so `await brush.ready()`
 * is optional and upstream's synchronous call sequence works unmodified.
 * After the first flush every wrapper is one boolean check.
 *
 * Export groups below: immediate (pure, lifecycle, inspection), seeds
 * (immediate + replayed), deferred (everything that mutates state or draws).
 */

import { guard, guardReplay } from "./adapters/standalone/deferred.js";
import { precheck as pre } from "./adapters/standalone/precheck.js";
import * as runtime from "./adapters/standalone/runtime.js";
import * as frame from "./adapters/standalone/frame.js";
import * as utils from "./core/utils.js";
import * as flow from "./core/flowfield.js";
import * as prim from "./core/primitives.js";
import * as strokes from "./stroke/stroke.js";
import * as hatching from "./hatch/hatch.js";
import * as masses from "./hatch/mass.js";
import * as fills from "./fill/fill.js";
import * as washes from "./fill/wash.js";
import { Polygon } from "./core/polygon.js";
import { Plot } from "./core/plot.js";
import { _setUseCpuWalk } from "./stroke/gl_draw.js";

// ---------------------------------------------------------------------------
// Immediate: pure data, lifecycle, inspection. Live re-exports on purpose —
// `noise` is reassigned by noiseSeed() and must stay a live binding.
// ---------------------------------------------------------------------------
export {
  DEGREES,
  RADIANS,
  Color,
  getAngleMode,
  initStandaloneRuntime,
} from "./adapters/standalone/runtime.js";
// gpu() — shared-device interop handle (device + live painting texture).
export { createCanvas, ready, readPixels, gpu } from "./adapters/standalone/target.js";
export { random, noise, weightedRand as wRand } from "./core/utils.js";
export { Stats as _stats } from "./core/stats.js"; // test instrumentation, not API
export { load } from "./core/color.js";
export { instance } from "./core/target.js";
export { addField, listFields, Position } from "./core/flowfield.js";
export { Polygon } from "./core/polygon.js";
export { Plot } from "./core/plot.js";
export { add, box, clip } from "./stroke/stroke.js";
export { createHatch as hatchArray } from "./hatch/hatch.js";
export { createMassArray as massArray } from "./hatch/mass.js";
// Inspection and manipulation API — geometry streams, hooks between
// generate and rasterize, and out-of-band geometry capture/readback.
export {
  stream,
  onGeometry,
  beginGeometry,
  endGeometry,
  readGeometry,
  _geometryStats, // test instrumentation, not API
  _resetGeometryStats,
} from "./webgpu/inspect.js";
// GPU fill DAG routing counters — test instrumentation, not API.
export { _fillDriverStats } from "./fill/fill.js";
// Painting snapshots (GPU-side undo support for host applications). They
// return handles, so they cannot be deferred: still require ready().
export { snapshot, restore, freeSnapshot } from "./adapters/standalone/snapshot.js";

// ---------------------------------------------------------------------------
// Seeds: take effect now (random()/noise() read them immediately) AND hold
// their place in the replayed sequence, where they run again in full. The
// replay is a faithful re-execution: circle(), Plot, mass() and field
// generation draw from the same stream as brush.random() (upstream design),
// so the stream must be reset at the same points for the replayed image to
// match a synchronous run. Consequence, pre-ready only: a random() value
// read AFTER a pre-ready seed() is the stream's first draw, where the
// synchronous run would have consumed the intervening drawing first. Once
// ready, random() continues exactly where the synchronous sequence would.
// ---------------------------------------------------------------------------
export const seed = guardReplay(utils.seed, utils.seed);
export const noiseSeed = guardReplay(utils.noiseSeed, utils.noiseSeed);

// ---------------------------------------------------------------------------
// Deferred: state and drawing. Calls that upstream validates carry a
// precheck (precheck.js) so those errors throw at the call site even while
// recording, as a synchronous run would.
// ---------------------------------------------------------------------------
export const angleMode = guard(runtime.angleMode, pre.angleMode);
export const push = guard(runtime.push, pre.push);
export const pop = guard(runtime.pop, pre.pop);
export const translate = guard(runtime.translate);
export const rotate = guard(runtime.rotate);
export const scale = guard(runtime.scale);

export const render = guard(frame.render);
export const clear = guard(frame.clear);

export const field = guard(flow.field, pre.field);
export const noField = guard(flow.noField, pre.noField);
export const refreshField = guard(flow.refreshField, pre.refreshField);
export const wiggle = guard(flow.wiggle, pre.wiggle);

export const rect = guard(prim.rect);
export const circle = guard(prim.circle);
export const arc = guard(prim.arc);
export const beginShape = guard(prim.beginShape, pre.beginShape);
export const vertex = guard(prim.vertex, pre.vertex);
export const endShape = guard(prim.endShape, pre.endShape);
export const beginStroke = guard(prim.beginStroke, pre.beginStroke);
export const move = guard(prim.move, pre.move);
export const endStroke = guard(prim.endStroke, pre.endStroke);
export const spline = guard(prim.spline, pre.spline);
export const polygon = guard(prim.polygon);

export const scaleBrushes = guard(strokes.scaleBrushes);
export const pick = guard(strokes.pick, pre.pick);
export const stroke = guard(strokes.stroke, pre.stroke);
export const strokeWeight = guard(strokes.strokeWeight);
export const set = guard(strokes.set, pre.set);
export const noStroke = guard(strokes.noStroke, pre.noStroke);
export const noClip = guard(strokes.noClip);
export const line = guard(strokes.line, pre.line);
export const flowLine = guard(strokes.flowLine, pre.flowLine);

export const hatch = guard(hatching.hatch);
export const hatchStyle = guard(hatching.hatchStyle);
export const noHatch = guard(hatching.noHatch);
export const mass = guard(masses.mass);
export const noMass = guard(masses.noMass);

export const fill = guard(fills.fill);
export const noFill = guard(fills.noFill);
export const fillTexture = guard(fills.fillTexture);
export const fillBleed = guard(fills.fillBleed);
export const wash = guard(washes.wash);
export const noWash = guard(washes.noWash);

// Class drawing entry points draw with the current state, so they defer too.
Polygon.prototype.show = guard(Polygon.prototype.show);
Plot.prototype.show = guard(Plot.prototype.show);

// Geometry producer switch. cpuGeometry() forces the retained
// CPU walk and CPU fill DAG (same output, slower); noCpuGeometry() restores
// the GPU producers. Toggle pair, matching fill()/noFill(), field()/noField().
export const cpuGeometry = guard(() => _setUseCpuWalk(true));
export const noCpuGeometry = guard(() => _setUseCpuWalk(false));

// The public functions above are the default context's own wrappers (each
// module exports one, bound to `defaultContext`), so the guarded export list
// and its declared signatures are exactly what they were before the context
// was threaded through. `guard`/`guardReplay` are `guardFor`/`guardReplayFor`
// bound to that same context, and each context owns its recorder — building a
// second instance's surface is step 5.

import { initStandaloneTargetRuntime } from "./adapters/standalone/target.js";
import { initStandaloneCompositorRuntime } from "./adapters/standalone/compositor.js";
import { initStandaloneStrokeRuntime } from "./adapters/standalone/stroke.js";
import { initStandaloneRuntime } from "./adapters/standalone/runtime.js";

initStandaloneTargetRuntime();
initStandaloneRuntime();
initStandaloneCompositorRuntime();
initStandaloneStrokeRuntime();
