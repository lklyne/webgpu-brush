/**
 * Builds the public surface of ONE painting.
 *
 * The return type is INFERRED from the object literal below, on purpose: it
 * is what `types/api.d.ts` publishes as the instance shape, and an explicit
 * `@returns {object}` would erase every method from it.
 *
 * @param {import("./core/context.js").BrushContext} ctx
 */
export function buildApi(ctx: import("./core/context.js").BrushContext): {
    DEGREES: string;
    RADIANS: string;
    Color: typeof runtime.Color;
    getAngleMode: typeof runtime.getAngleMode;
    createCanvas: typeof target.createCanvas;
    load: (buffer?: object | false, options?: object) => void;
    ready: typeof target.ready;
    readPixels: typeof target.readPixels;
    gpu: typeof target.gpu;
    random: (e?: number | any[], r?: number) => number;
    noise: (x: number, y: number) => number;
    wRand: (weights: object) => string | number;
    add: typeof strokes.add;
    box: typeof strokes.box;
    addField: typeof flow.addField;
    listFields: typeof flow.listFields;
    clip: typeof strokes.clip;
    hatchArray: typeof hatching.createHatch;
    massArray: typeof masses.createMassArray;
    Polygon: typeof Polygon;
    Plot: typeof Plot;
    Position: typeof Position;
    stream: typeof inspect.stream;
    onGeometry: typeof inspect.onGeometry;
    beginGeometry: typeof inspect.beginGeometry;
    endGeometry: typeof inspect.endGeometry;
    readGeometry: typeof inspect.readGeometry;
    snapshot: typeof snapshots.snapshot;
    restore: typeof snapshots.restore;
    freeSnapshot: typeof snapshots.freeSnapshot;
    seed: (s: number | string) => void;
    noiseSeed: (s: number | string) => void;
    angleMode: typeof runtime.angleMode;
    push: typeof runtime.push;
    pop: typeof runtime.pop;
    translate: typeof runtime.translate;
    rotate: typeof runtime.rotate;
    scale: typeof runtime.scale;
    render: typeof frame.render;
    clear: typeof frame.clear;
    field: typeof flow.field;
    noField: typeof flow.noField;
    refreshField: typeof flow.refreshField;
    wiggle: typeof flow.wiggle;
    rect: typeof prim.rect;
    circle: typeof prim.circle;
    arc: typeof prim.arc;
    beginShape: typeof prim.beginShape;
    vertex: typeof prim.vertex;
    endShape: typeof prim.endShape;
    beginStroke: typeof prim.beginStroke;
    move: typeof prim.move;
    endStroke: typeof prim.endStroke;
    spline: typeof prim.spline;
    polygon: typeof prim.polygon;
    scaleBrushes: typeof strokes.scaleBrushes;
    pick: typeof strokes.pick;
    stroke: typeof strokes.stroke;
    strokeWeight: typeof strokes.strokeWeight;
    set: typeof strokes.set;
    noStroke: typeof strokes.noStroke;
    noClip: typeof strokes.noClip;
    line: typeof strokes.line;
    flowLine: typeof strokes.flowLine;
    hatch: typeof hatching.hatch;
    hatchStyle: typeof hatching.hatchStyle;
    noHatch: typeof hatching.noHatch;
    mass: typeof masses.mass;
    noMass: typeof masses.noMass;
    fill: typeof fills.fill;
    noFill: typeof fills.noFill;
    fillTexture: typeof fills.fillTexture;
    fillBleed: typeof fills.fillBleed;
    wash: typeof washes.wash;
    noWash: typeof washes.noWash;
    cpuGeometry: () => void;
    noCpuGeometry: () => void;
    /**
     * This painting's canvas, or null before createCanvas()/load().
     * @returns {HTMLCanvasElement|OffscreenCanvas|null}
     */
    readonly canvas: HTMLCanvasElement | OffscreenCanvas | null;
    /**
     * Releases this painting. See `disposeInstance()` for exactly what is
     * freed; afterwards every method on this object throws.
     */
    dispose(): void;
};
/**
 * Creates an independent painting and returns its API.
 *
 * Synchronous, like the module-level `createCanvas()`: the deferred-call
 * recorder makes drawing before the device resolves legal, so
 *
 * ```js
 * const a = createBrush({ width: 800, height: 600 });
 * a.set("HB", "#000", 1);
 * a.line(-100, 0, 100, 0);
 * a.render();
 * const { pixels } = await a.readPixels();   // resolves after the replay
 * ```
 *
 * works with no `await` before the draw. `await a.ready()` resolves once the
 * device and the GPU stroke walker are up and the recorded calls have run.
 *
 * With no `width`/`height`/`canvas` the instance has no target yet; call
 * `api.createCanvas(w, h)` or `api.load(canvas)` when one exists.
 *
 * @param {object} [options]
 * @param {number} [options.width] logical painting width — with `height`,
 *   creates the canvas immediately.
 * @param {number} [options.height] logical painting height.
 * @param {number} [options.pixelDensity=1]
 * @param {string|Element|null} [options.parent] where to append the canvas
 *   (`document.body` by default, `null` to keep it out of the DOM).
 * @param {string} [options.id] canvas element id.
 * @param {HTMLCanvasElement|OffscreenCanvas} [options.canvas] draw into an
 *   existing canvas instead of creating one (`width`/`height` are ignored;
 *   the canvas's own size is used, as `load()` does).
 * @param {GPUDevice} [options.device] adopt an externally owned device
 *   instead of requesting one — pass `other.gpu().device` to put two
 *   paintings on one device.
 * @param {GPUAdapter|null} [options.adapter] the adapter that device came
 *   from, when the caller has it.
 * @returns {ReturnType<typeof buildApi>}
 */
export function createBrush(options?: {
    width?: number;
    height?: number;
    pixelDensity?: number;
    parent?: string | Element | null;
    id?: string;
    canvas?: HTMLCanvasElement | OffscreenCanvas;
    device?: GPUDevice;
    adapter?: GPUAdapter | null;
}): ReturnType<typeof buildApi>;
import * as runtime from "./adapters/standalone/runtime.js";
import * as target from "./adapters/standalone/target.js";
import * as strokes from "./stroke/stroke.js";
import * as flow from "./core/flowfield.js";
import * as hatching from "./hatch/hatch.js";
import * as masses from "./hatch/mass.js";
import { Polygon } from "./core/polygon.js";
import { Plot } from "./core/plot.js";
import { Position } from "./core/flowfield.js";
import * as inspect from "./webgpu/inspect.js";
import * as snapshots from "./adapters/standalone/snapshot.js";
import * as frame from "./adapters/standalone/frame.js";
import * as prim from "./core/primitives.js";
import * as fills from "./fill/fill.js";
import * as washes from "./fill/wash.js";
