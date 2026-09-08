/**
 * Retrieves a shallow copy of the current stroke state.
 * @returns {object} The stroke state.
 */
export function BrushState(): object;
/**
 * Updates the stroke state.
 * @param {object} state - The new stroke state.
 */
export function BrushSetState(state: object): void;
/**
 * Adds a new brush with the specified parameters to the brush list.
 * @param {string} name - The unique name for the new brush.
 * @param {object} params - The parameters defining the brush behavior and appearance.
 */
/**
 * Normalizes the pressure parameter to the internal { type, min_max, curve } format.
 * Accepts:
 *   [start, end]         — linear ramp between two pressure values
 *   [start, mid, end]    — piecewise linear (e.g. [1.5, 0.5, 1.5] for U-curve)
 *   (t) => value         — custom function, t ∈ [0,1], return value ∈ [0,1]
 *   { mode: "gaussian", curve, min_max } — advanced built-in pressure profile
 *   { curve, min_max }   — legacy gaussian format, preserved for compatibility
 */
export function normalizePressure(p: any): any;
export function add(name: any, params: any): Promise<any>;
/**
 * Retrieves the list of available brush names.
 * @returns {Array<string>} Array of brush names.
 */
export function box(): Array<string>;
export function getBrushParams(brushName: any): any;
/**
 * Scales standard brush parameters by the provided factor.
 * @param {number} scaleFactor - The scaling factor to apply.
 */
export function scaleBrushes(scaleFactor: number): void;
/**
 * Sets the current brush type by name.
 * @param {string} brushName - The name of the brush.
 */
export function pick(brushName: string): void;
/**
 * Throws if no brush is registered under `brushName`.
 * @param {string} brushName - The name of the brush.
 */
export function assertBrush(brushName: string): void;
/**
 * Sets the stroke style (color) for the current brush.
 * @param {number|string|Color} r - Red component, CSS color string, or Color object.
 * @param {number} [g] - Green component.
 * @param {number} [b] - Blue component.
 */
export function stroke(r: number | string | Color, g?: number, b?: number, ...args: any[]): void;
/**
 * Sets the brush weight (thickness).
 * @param {number} weight - The weight value.
 */
export function strokeWeight(weight: number): void;
/**
 * Sets the current brush with name, color, and weight.
 * @param {string} brushName - The brush name.
 * @param {string|Color} color - The brush color.
 * @param {number} [weight=1] - The brush weight.
 */
export function set(brushName: string, color: string | Color, weight?: number): void;
/**
 * Disables the stroke effect.
 */
export function noStroke(): void;
/**
 * Defines a clipping region for strokes.
 * The region uses the same coordinate space as brush drawing commands,
 * with the current runtime transform captured at call time.
 * @param {number[]} region - Array as [x1, y1, x2, y2] defining the clipping region.
 */
export function clip(region: number[]): number[];
/**
 * Disables the clipping region.
 */
export function noClip(): void;
/**
 * Draws a line using the current brush.
 * @param {number} x1 - Start x-coordinate.
 * @param {number} y1 - Start y-coordinate.
 * @param {number} x2 - End x-coordinate.
 * @param {number} y2 - End y-coordinate.
 */
export function line(x1: number, y1: number, x2: number, y2: number): void;
/**
 * Draws a stroke from a starting point in a given direction.
 * @param {number} x - Starting x-coordinate.
 * @param {number} y - Starting y-coordinate.
 * @param {number} length - Length of the stroke.
 * @param {number} dir - Direction, interpreted using the current runtime angle units.
 */
export function flowLine(x: number, y: number, length: number, dir: number): void;
