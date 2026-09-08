/**
 * A context's fill state.
 * @returns {object} The `ctx.state.fill` slice.
 */
export function createFillState(): object;
/**
 * Sets the fill color and opacity for subsequent drawing operations.
 * @param {number|string|Color} a - Either the red component, a CSS color string, or a Color object.
 * @param {number} [b] - The green component or the opacity if using grayscale.
 * @param {number} [c] - The blue component.
 * @param {number} [d] - The opacity.
 */
export function fill(a: number | string | Color, b?: number, c?: number, d?: number, ...args: any[]): void;
/**
 * Context-taking implementation of fill().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {...*} args - Color arguments plus optional opacity.
 */
export function _fill(ctx: import("../core/context.js").BrushContext, ...args: any[]): void;
/**
 * Sets the bleed (watercolor) intensity and direction.
 * @param {number} _i - The bleed intensity (clamped to [0,1]).
 * @param {string} [_direction="out"] - The bleeding direction.
 * @param {number|null} [_angle=null] - Optional wash direction angle in current angle mode.
 */
export function fillBleed(_i: number, _direction?: string, _angle?: number | null): void;
/**
 * Context-taking implementation of fillBleed().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} _i - The bleed intensity (clamped to [0,1]).
 * @param {string} [_direction="out"] - The bleeding direction.
 * @param {number|null} [_angle=null] - Optional wash direction angle.
 */
export function _fillBleed(ctx: import("../core/context.js").BrushContext, _i: number, _direction?: string, _angle?: number | null): void;
/**
 * Sets the texture and border strengths for the fill.
 * @param {number} [_texture=0.4] - The texture strength (clamped to [0,1]).
 * @param {number} [_border=0.4] - The border strength (clamped to [0,1]).
 * @param {boolean} [_scatter=true] - Whether to draw the scattered sparse polygon layers.
 *   Set to false to disable the scatter effect, which can help when a clean
 *   gradient trim is needed without extra texture noise at the edges.
 */
export function fillTexture(_texture?: number, _border?: number, _scatter?: boolean): void;
/**
 * Context-taking implementation of fillTexture().
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {number} [_texture=0.4] - The texture strength (clamped to [0,1]).
 * @param {number} [_border=0.4] - The border strength (clamped to [0,1]).
 * @param {boolean} [_scatter=true] - Whether to draw the scattered sparse polygon layers.
 */
export function _fillTexture(ctx: import("../core/context.js").BrushContext, _texture?: number, _border?: number, _scatter?: boolean): void;
/**
 * Disables fill for subsequent drawing operations.
 */
export function noFill(): void;
/**
 * Context-taking implementation of noFill().
 * @param {import("../core/context.js").BrushContext} ctx
 */
export function _noFill(ctx: import("../core/context.js").BrushContext): void;
/**
 * Fills a given polygon with a watercolor effect.
 * @param {import("../core/context.js").BrushContext} ctx
 * @param {Polygon} polygon - The polygon to fill.
 */
export function createFill(ctx: import("../core/context.js").BrushContext, polygon: Polygon): void;
/**
 * Test instrumentation (not API): the GPU fill driver's op counters, so
 * the oracle can assert routing rather than infer it from pixels.
 */
export function _fillDriverStats(): any;
export namespace _test {
    const FillPoly: {
        new (ctx: import("../core/context.js").BrushContext, v: any[], m: number[], center: any, dir: boolean[], isFirst: boolean, sx: any, sy: any): FillPoly;
    };
    function setScope({ fillId, op, growCap, gaussians }?: {}, ctx?: import("../core/context.js").BrushContext): void;
    function getOp(ctx?: import("../core/context.js").BrushContext): any;
}
import { Polygon } from "../core/polygon.js";
/**
 * The FillPolygon class is used to create and manage the properties of the polygons that produces
 * the watercolor effect. It includes methods to grow (expand) the polygon and apply layers
 * of color with varying intensity and erase parts to simulate a natural watercolor bleed.
 * The implementation follows Tyler Hobbs' guide to simulating watercolor:
 * https://tylerxhobbs.com/essays/2017/a-generative-approach-to-simulating-watercolor-paints
 */
declare class FillPoly_1 {
    /**
     * Constructs a FillPolygon.
     * @param {import("../core/context.js").BrushContext} ctx
     * @param {Object[]} v - Vertices of the polygon.
     * @param {number[]} m - Multipliers for the bleed effect at each vertex.
     * @param {Object} center - The polygon's center {x, y}.
     * @param {boolean[]} dir - Array indicating bleed direction per vertex.
     * @param {boolean} isFirst - True for initial polygon.
     */
    constructor(ctx: import("../core/context.js").BrushContext, v: any[], m: number[], center: any, dir: boolean[], isFirst: boolean, sx: any, sy: any);
    v: any[];
    m: number[];
    dir: any[];
    midP: any;
    sizeX: any;
    sizeY: any;
    /**
     * Trims vertices from the polygon based on a factor.
     * @param {import("../core/context.js").BrushContext} ctx
     * @param {number} [f=1] - Factor determining amount of trimming.
     * @returns {Object} An object containing trimmed vertices, multipliers, and direction.
     */
    trim(ctx: import("../core/context.js").BrushContext, f?: number): any;
    /**
     * Randomly samples a fraction of vertices, keeping their order.
     * Any sampled vertex outside the original polygon is pulled inward.
     * @param {import("../core/context.js").BrushContext} ctx
     * @param {number} [ratio=0.3] - Fraction of vertices to keep.
     * @returns {FillPoly} A new FillPoly with fewer vertices, guaranteed inside the original.
     */
    scatter(ctx: import("../core/context.js").BrushContext, ratio?: number): FillPoly;
    /**
     * Returns a copy with all bleed directions flipped.
     * @param {import("../core/context.js").BrushContext} ctx
     */
    flipDirs(ctx: import("../core/context.js").BrushContext): FillPoly;
    /**
     * Grows (or shrinks) the polygon vertices to simulate watercolor spread.
     * @param {import("../core/context.js").BrushContext} ctx
     * @param {number} [f=1] - Factor controlling growth.
     * @returns {FillPoly} A new FillPoly with adjusted vertices.
     */
    grow(ctx: import("../core/context.js").BrushContext, f?: number): FillPoly;
    /**
     * Fills the polygon with multiple layers to simulate a watercolor effect.
     * @param {import("../core/context.js").BrushContext} ctx
     * @param {Color|string} color - The fill color.
     * @param {number} intensity - Opacity intensity (mapped from 0 to 1).
     * @param {number} tex - Texture factor.
     */
    /**
     * The layer border width and the two alphas, shared verbatim by the CPU
     * and GPU producers (see GpuFillPoly.layer) so there is one source of
     * truth for the arithmetic.
     * @param {import("../core/context.js").BrushContext} ctx
     */
    _layerStyle(ctx: import("../core/context.js").BrushContext, i: any, size: any, int: any): {
        lineWidth: number;
        fillAlpha: number;
        borderAlpha: number;
    };
    fill(ctx: any, color: any, intensity: any, tex: any): void;
    /** @private the layer schedule; see fill() for the producer routing. */
    private _fillBody;
    /**
     * Draws a layer of the fill polygon with stroke and fill.
     * @param {import("../core/context.js").BrushContext} ctx
     * @param {number} i - The layer index.
     */
    layer(ctx: import("../core/context.js").BrushContext, i: number, size: any, int: any, matrix: any): void;
    /**
     * Erases parts of the polygon to create a natural watercolor texture.
     * @param {number} texture - Texture strength factor.
     * @param {number} intensity - Intensity value for size scaling.
     */
    /**
     * Everything erase() needs except the SALT — all of it CPU-known, because
     * sizeX/sizeY/midP are constant along a whole FillPoly chain. The GPU
     * producer takes exactly this record; only the salt (and therefore the
     * circle count) has to be resolved GPU-side, since the op counter lives
     * there. Shared so the two producers cannot drift.
     */
    _eraseParams(texture: any, intensity: any): {
        countFactor: number;
        halfSizeX: number;
        halfSizeY: number;
        minSizeFactor: number;
        maxSizeFactor: number;
        midX: any;
        midY: any;
        alpha: number;
    };
    /**
     * @param {import("../core/context.js").BrushContext} ctx
     */
    erase(ctx: import("../core/context.js").BrushContext, texture: any, intensity: any, matrix: any): void;
}
export {};
