/**
 * Ensures the field system is initialized and ready for use.
 * If the field is not loaded, it initializes the mixing system and creates the field.
 *
 * @param {import("./context.js").BrushContext} ctx
 */
export function isFieldReady(ctx: import("./context.js").BrushContext): void;
/**
 * Discards the field grid when the draw target's logical size changes.
 *
 * Grid geometry and every generated grid are derived from the target size, so
 * a target of a different size needs both rebuilt — otherwise the first canvas
 * to touch a field would fix the grid for every canvas after it. Field
 * definitions (generator and angle mode) survive; only the generated grids go.
 * A reload at the same size changes nothing, and in particular draws nothing
 * from the random stream.
 *
 * @param {number} width - The new logical target width.
 * @param {number} height - The new logical target height.
 */
export function _onTargetResized(width: number, height: number): void;
/**
 * Regenerates the current vector field using its associated generator function.
 * @param {number} [t=0] - An optional time parameter that can affect field generation.
 */
export function refreshField(t?: number): void;
/**
 * Context-taking implementation of refreshField().
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} [t=0] - An optional time parameter that can affect field generation.
 */
export function _refreshField(ctx: import("./context.js").BrushContext, t?: number): void;
/**
 * Flattened snapshot of the active flow field for GPU upload (col-major,
 * c * numRows + r — the layout strokewalk-compute expects), or null when
 * no field is active. Internal API for the GPU-walk stroke router.
 *
 * @param {import("./context.js").BrushContext} ctx
 */
export function _fieldSnapshot(ctx: import("./context.js").BrushContext): {
    data: Float32Array<ArrayBuffer>;
    numColumns: any;
    numRows: any;
    resolution: any;
    leftX: any;
    topY: any;
    epoch: number;
    name: any;
};
/** Current field epoch — bumps whenever any field content may have changed. */
export function _fieldEpochNow(): number;
/**
 * Throws if no field is registered under `name`.
 * @param {string} name - Field name.
 */
export function assertField(name: string): void;
/**
 * Activates a specific vector field by name, ensuring it's ready for use.
 * @param {string} a - The name of the vector field to activate.
 */
export function field(a: string): void;
/**
 * Context-taking implementation of field().
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {string} a - The name of the vector field to activate.
 */
export function _field(ctx: import("./context.js").BrushContext, a: string): void;
/**
 * Deactivates the current vector field.
 */
export function noField(): void;
/**
 * Context-taking implementation of noField().
 *
 * @param {import("./context.js").BrushContext} ctx
 */
export function _noField(ctx: import("./context.js").BrushContext): void;
/**
 * Adds a new vector field to the field list with a unique name and a generator function.
 * @param {string} name - The unique name for the new vector field.
 * @param {Function} funct - The function that generates the field values.
 * @param {object} [options] - Optional field configuration.
 * @param {"degrees"|"radians"} [options.angleMode="degrees"] - How the generator's output angles should be interpreted.
 */
export function addField(name: string, funct: Function, options?: {
    angleMode?: "degrees" | "radians";
}): void;
/**
 * Retrieves a list of all available vector field names.
 * @returns {string[]} An array of all the field names.
 */
export function listFields(): string[];
export function wiggle(a?: number): void;
/**
 * Context-taking implementation of wiggle().
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} [a=1] - Wiggle strength.
 */
export function _wiggle(ctx: import("./context.js").BrushContext, a?: number): void;
/**
 * The Position class represents a point within a two-dimensional space, which can interact with a vector field.
 * It provides methods to update the position based on the field's flow and to check whether the position is
 * within certain bounds (e.g., within the field or canvas).
 */
export class Position {
    /**
     * Gets the row index for a given y-coordinate.
     * @param {number} y - The y-coordinate.
     * @returns {number} - The row index.
     */
    static getRowIndex(y: number, d?: number): number;
    /**
     * Gets the column index for a given x-coordinate.
     * @param {number} x - The x-coordinate.
     * @returns {number} - The column index.
     */
    static getColIndex(x: number, d?: number): number;
    /**
     * Checks if a column and row index are within the flow field bounds.
     * @param {number} col - The column index.
     * @param {number} row - The row index.
     * @returns {boolean} - True if the indices are within bounds, false otherwise.
     */
    static isIn(col: number, row: number): boolean;
    /**
     * Constructs a new Position instance.
     * @param {number} x - The initial x-coordinate.
     * @param {number} y - The initial y-coordinate.
     * @param {import("./context.js").BrushContext} [owner] - Drawing context this
     *   position belongs to. Unset means the default context.
     */
    constructor(x: number, y: number, owner?: import("./context.js").BrushContext);
    /** @type {import("./context.js").BrushContext|undefined} */
    owner: import("./context.js").BrushContext | undefined;
    mx: number;
    my: number;
    plotted: number;
    /**
     * Updates the position's coordinates and calculates its offsets and indices within the flow field.
     * @param {number} x - The new x-coordinate.
     * @param {number} y - The new y-coordinate.
     */
    update(x: number, y: number): void;
    x: number;
    y: number;
    colIdx: number;
    rowIdx: number;
    /**
     * Resets the 'plotted' property to 0.
     */
    reset(): void;
    /**
     * Checks if the position is within the active flow field's bounds.
     * @returns {boolean} - True if the position is within the flow field, false otherwise.
     */
    isIn(): boolean;
    /**
     * Checks if the position is within the canvas bounds (with a margin).
     * @returns {boolean} - True if the position is within bounds, false otherwise.
     */
    isInCanvas(): boolean;
    /**
     * Calculates the angle of the flow field at the position's current coordinates.
     * @returns {number} - The internal flow angle in degrees, or 0 if the position is not in the field or if no field is active.
     */
    angle(skipCheck?: boolean): number;
    /**
     * Moves the position along the flow field by a certain length.
     * @param {number} _dir - The direction of movement, interpreted using the current runtime angle units.
     * @param {number} _length - The length to move along the field.
     * @param {number} _step_length - The length of each step.
     */
    moveTo(_dir: number, _length: number, _step_length?: number): void;
    /**
     * Internal variant of moveTo() that expects a degree value already normalized to the library's internal representation.
     */
    _moveToDegrees(_dir: any, _length: any, _step_length?: number): void;
    /**
     * Fast constant-direction movement (no field, no plot).
     * Precomputes trig once and applies dx/dy directly.
     */
    _moveConstant(_dir: any, _length: any, _step: any): void;
    /**
     * Plots a point to another position within the flow field, following a Plot object
     * @param {Position} _plot - The Plot path object.
     * @param {number} _length - The length to move towards the target position.
     * @param {number} _step_length - The length of each step.
     * @param {number} _scale - The scaling factor for the plotting path.
     */
    plotTo(_plot: Position, _length: number, _step_length: number, _scale?: number, precomputedAngle?: any): void;
    movePos(_dirPlot: any, _length: any, _step: any, _scale?: boolean, precomputedAngle?: any): void;
}
