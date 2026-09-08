/**
 * Sets the fill color and opacity for subsequent drawing operations.
 * @param {number|string|Color} a - Either the red component, a CSS color string, or a Color object.
 * @param {number} [b] - The green component or the opacity if using grayscale.
 * @param {number} [c] - The blue component.
 * @param {number} [d] - The opacity.
 */
export function fill(a: number | string | Color, b?: number, c?: number, d?: number, ...args: any[]): void;
/**
 * Sets the bleed (watercolor) intensity and direction.
 * @param {number} _i - The bleed intensity (clamped to [0,1]).
 * @param {string} [_direction="out"] - The bleeding direction.
 * @param {number|null} [_angle=null] - Optional wash direction angle in current angle mode.
 */
export function fillBleed(_i: number, _direction?: string, _angle?: number | null): void;
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
 * Disables fill for subsequent drawing operations.
 */
export function noFill(): void;
/**
 * Fills a given polygon with a watercolor effect.
 * @param {Polygon} polygon - The polygon to fill.
 */
export function createFill(polygon: Polygon): void;
/**
 * Test instrumentation (not API): the GPU fill driver's op counters, so
 * the oracle can assert routing rather than infer it from pixels.
 */
export function _fillDriverStats(): any;
export namespace _test {
    const FillPoly: {
        new (v: any, m: any, center: any, dir: boolean[], isFirst: boolean, sx: any, sy: any): FillPoly;
    };
    function setScope({ fillId, op, growCap, gaussians }?: {}): void;
    function getOp(): number;
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
     * @param {Object[]} _v - Vertices of the polygon.
     * @param {number[]} _m - Multipliers for the bleed effect at each vertex.
     * @param {Object} _center - The polygon's center {x, y}.
     * @param {boolean[]} dir - Array indicating bleed direction per vertex.
     * @param {boolean} isFirst - True for initial polygon.
     */
    constructor(v: any, m: any, center: any, dir: boolean[], isFirst: boolean, sx: any, sy: any);
    v: any;
    m: any;
    dir: any[];
    midP: any;
    sizeX: any;
    sizeY: any;
    /**
     * Trims vertices from the polygon based on a factor.
     * @param {number} [factor=1] - Factor determining amount of trimming.
     * @returns {Object} An object containing trimmed vertices, multipliers, and direction.
     */
    trim(f?: number): any;
    /**
     * Randomly samples a fraction of vertices, keeping their order.
     * Any sampled vertex outside the original polygon is pulled inward.
     * @param {number} [ratio=0.3] - Fraction of vertices to keep.
     * @returns {FillPoly} A new FillPoly with fewer vertices, guaranteed inside the original.
     */
    scatter(ratio?: number): FillPoly;
    /**
     * Returns a copy with all bleed directions flipped.
     */
    flipDirs(): FillPoly;
    /**
     * Grows (or shrinks) the polygon vertices to simulate watercolor spread.
     * @param {number} [growthFactor=1] - Factor controlling growth.
     * @returns {FillPoly} A new FillPoly with adjusted vertices.
     */
    grow(f?: number): FillPoly;
    /**
     * Fills the polygon with multiple layers to simulate a watercolor effect.
     * @param {Color|string} color - The fill color.
     * @param {number} intensity - Opacity intensity (mapped from 0 to 1).
     * @param {number} tex - Texture factor.
     */
    /**
     * The layer border width and the two alphas, shared verbatim by the CPU
     * and GPU producers (see GpuFillPoly.layer) so there is one source of
     * truth for the arithmetic.
     */
    _layerStyle(i: any, size: any, int: any): {
        lineWidth: number;
        fillAlpha: number;
        borderAlpha: number;
    };
    fill(color: any, intensity: any, tex: any): void;
    /** @private the layer schedule; see fill() for the producer routing. */
    private _fillBody;
    /**
     * Draws a layer of the fill polygon with stroke and fill.
     * @param {number} i - The layer index.
     */
    layer(i: number, size: any, int: any, matrix: any): void;
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
    erase(texture: any, intensity: any, matrix: any): void;
}
export {};
