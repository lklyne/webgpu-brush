import { isMixReady } from "./color.js";
import { defaultContext, registerContextInit } from "./context.js";
import {
  sin,
  cos,
  cossin,
  map,
  toDegreesSigned,
} from "./utils.js";

// =============================================================================
// Section: Matrix transformations
// =============================================================================

// =============================================================================
// Section: Field Initialization
// =============================================================================

/**
 * Ensures the field system is initialized and ready for use.
 * If the field is not loaded, it initializes the mixing system and creates the field.
 *
 * @param {import("./context.js").BrushContext} ctx
 */
export function isFieldReady(ctx) {
  const grids = ctx.fields;
  if (grids.isLoaded) return;
  isMixReady(ctx); // Ensure the mixing system is ready
  createField(ctx); // Initialize the field
  grids.isLoaded = true;
  // The grid was just built against the current target size. If a field is
  // already active its cached grid was sized for the previous target and has
  // been discarded, so regenerate it before anything reads it.
  const field = ctx.state.field;
  if (field.isActive && field.current) {
    setGrid(ctx, field.current, generateField(ctx, list.get(field.current), 0));
    grids.epoch++;
  }
}

// =============================================================================
// Section: Position Class
// =============================================================================

/**
 * The Position class represents a point within a two-dimensional space, which can interact with a vector field.
 * It provides methods to update the position based on the field's flow and to check whether the position is
 * within certain bounds (e.g., within the field or canvas).
 */
export class Position {
  /**
   * Constructs a new Position instance.
   * @param {number} x - The initial x-coordinate.
   * @param {number} y - The initial y-coordinate.
   * @param {import("./context.js").BrushContext} [owner] - Drawing context this
   *   position belongs to. Unset means the default context.
   */
  constructor(x, y, owner) {
    /** @type {import("./context.js").BrushContext|undefined} */
    this.owner = owner;
    const ctx = owner ?? defaultContext;
    isFieldReady(ctx);
    const m = ctx.getAffineMatrix();
    this.mx = m.x;
    this.my = m.y;
    this.update(x, y);
    this.plotted = 0; // Tracks the total distance plotted
  }

  /**
   * Updates the position's coordinates and calculates its offsets and indices within the flow field.
   * @param {number} x - The new x-coordinate.
   * @param {number} y - The new y-coordinate.
   */
  update(x, y) {
    this.x = x;
    this.y = y;
    const ctx = this.owner ?? defaultContext;
    if (ctx.state.field.isActive) {
      const g = ctx.fields;
      this.colIdx = Math.round((x + this.mx - g.left_x) / g.resolution);
      this.rowIdx = Math.round((y + this.my - g.top_y) / g.resolution);
    }
  }

  /**
   * Resets the 'plotted' property to 0.
   */
  reset() {
    this.plotted = 0;
  }

  /**
   * Checks if the position is within the active flow field's bounds.
   * @returns {boolean} - True if the position is within the flow field, false otherwise.
   */
  isIn() {
    const ctx = this.owner ?? defaultContext;
    return ctx.state.field.isActive
      ? isInGrid(ctx, this.colIdx, this.rowIdx)
      : this.isInCanvas(this.x, this.y);
  }

  /**
   * Checks if the position is within the canvas bounds (with a margin).
   * @returns {boolean} - True if the position is within bounds, false otherwise.
   */
  isInCanvas() {
    const ctx = this.owner ?? defaultContext;
    const margin = 0.5;
    const w = ctx.width;
    const h = ctx.height;
    const x = this.x + this.mx;
    const y = this.y + this.my;
    return (
      x >= -margin * w &&
      x <= (1 + margin) * w &&
      y >= -margin * h &&
      y <= (1 + margin) * h
    );
  }

  /**
   * Calculates the angle of the flow field at the position's current coordinates.
   * @returns {number} - The internal flow angle in degrees, or 0 if the position is not in the field or if no field is active.
   */
  angle(skipCheck = false) {
    const ctx = this.owner ?? defaultContext;
    if (!ctx.state.field.isActive) return 0;
    return skipCheck || this.isIn()
      ? flow_field(ctx)[this.colIdx][this.rowIdx] * ctx.state.field.wiggle
      : 0;
  }

  /**
   * Moves the position along the flow field by a certain length.
   * @param {number} _dir - The direction of movement, interpreted using the current runtime angle units.
   * @param {number} _length - The length to move along the field.
   * @param {number} _step_length - The length of each step.
   */
  moveTo(_dir, _length, _step_length = 1) {
    const dir = toDegreesSigned(this.owner ?? defaultContext, _dir);
    if ((this.owner ?? defaultContext).state.field.isActive) {
      this.movePos(dir, _length, _step_length);
    } else {
      this._moveConstant(dir, _length, _step_length);
    }
  }

  /**
   * Internal variant of moveTo() that expects a degree value already normalized to the library's internal representation.
   */
  _moveToDegrees(_dir, _length, _step_length = 1) {
    if ((this.owner ?? defaultContext).state.field.isActive) {
      this.movePos(_dir, _length, _step_length);
    } else {
      this._moveConstant(_dir, _length, _step_length);
    }
  }

  /**
   * Fast constant-direction movement (no field, no plot).
   * Precomputes trig once and applies dx/dy directly.
   */
  _moveConstant(_dir, _length, _step) {
    if (!this.isIn()) {
      this.plotted += _step;
      return;
    }
    const steps = _length / _step;
    const _cs = cossin(-_dir);
    const dx = _step * _cs[0],
      dy = _step * _cs[1];
    for (let i = 0; i < steps; i++) {
      this.x += dx;
      this.y += dy;
      this.plotted += _step;
    }
  }

  /**
   * Plots a point to another position within the flow field, following a Plot object
   * @param {Position} _plot - The Plot path object.
   * @param {number} _length - The length to move towards the target position.
   * @param {number} _step_length - The length of each step.
   * @param {number} _scale - The scaling factor for the plotting path.
   */
  plotTo(
    _plot,
    _length,
    _step_length,
    _scale = 1,
    precomputedAngle = undefined,
  ) {
    this.movePos(_plot, _length, _step_length, _scale, precomputedAngle);
  }

  movePos(
    _dirPlot,
    _length,
    _step,
    _scale = false,
    precomputedAngle = undefined,
  ) {
    const scaleFactor = _scale || 1;
    if (!this.isIn()) {
      this.plotted += _step / scaleFactor;
      return;
    }
    const steps = _length / _step;
    const fieldActive = (this.owner ?? defaultContext).state.field.isActive;
    const usePlot = !!_scale;
    for (let i = 0; i < steps; i++) {
      const plotAngle =
        usePlot && precomputedAngle !== undefined && i === 0
          ? precomputedAngle
          : usePlot
            ? _dirPlot.angle(this.plotted)
            : _dirPlot;
      const angle = (fieldActive ? this.angle(true) : 0) - plotAngle;
      // Calculate new position — cossin() computes the index once for both cos and sin
      const _cs = cossin(angle);
      this.update(this.x + _step * _cs[0], this.y + _step * _cs[1]);
      this.plotted += _step / scaleFactor;
    }
  }

  // Static Methods
  //
  // The grid is per-context, and a static has no instance to take an owner
  // from, so these read the default context's grid. Instance methods use
  // `this.owner`.

  /**
   * Gets the row index for a given y-coordinate.
   * @param {number} y - The y-coordinate.
   * @returns {number} - The row index.
   */
  static getRowIndex(y, d = 1) {
    const g = defaultContext.fields;
    const y_offset = y + defaultContext.getAffineMatrix().y - g.top_y;
    return Math.round(y_offset / g.resolution / d);
  }

  /**
   * Gets the column index for a given x-coordinate.
   * @param {number} x - The x-coordinate.
   * @returns {number} - The column index.
   */
  static getColIndex(x, d = 1) {
    const g = defaultContext.fields;
    const x_offset = x + defaultContext.getAffineMatrix().x - g.left_x;
    return Math.round(x_offset / g.resolution / d);
  }

  /**
   * Checks if a column and row index are within the flow field bounds.
   * @param {number} col - The column index.
   * @param {number} row - The row index.
   * @returns {boolean} - True if the indices are within bounds, false otherwise.
   */
  static isIn(col, row) {
    return isInGrid(defaultContext, col, row);
  }
}

/**
 * Bounds check against a context's grid.
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} col - The column index.
 * @param {number} row - The row index.
 * @returns {boolean} True when the indices are inside the grid.
 */
function isInGrid(ctx, col, row) {
  const g = ctx.fields;
  return col >= 0 && row >= 0 && col < g.num_columns && row < g.num_rows;
}

// =============================================================================
// Section: VectorField
// =============================================================================

/**
 * Represents the state of the vector field.
 * @property {boolean} isActive - Indicates if the vector field is active.
 * @property {string|null} current - The name of the currently active vector field.
 */
function createFieldState() {
  return {
    isActive: false,
    current: null,
    wiggle: 1,
  };
}

/**
 * A context's flow-field grids: the geometry latch derived from the target
 * size, plus the generated grid for every field the context has activated.
 *
 * Grids are per-painting — an 800x600 canvas and a 400x400 one need different
 * cell counts — while the DEFINITIONS (`gen`, `angleMode`) live in the module
 * `list` below and are shared. `grids` records the definition object each grid
 * was generated from, so re-registering a name with `addField()` invalidates
 * the cached grid without needing a registry of live contexts.
 */
function createFieldGrids() {
  return {
    isLoaded: false,
    resolution: undefined,
    left_x: undefined,
    top_y: undefined,
    num_columns: undefined,
    num_rows: undefined,
    // Logical target size the current grid geometry was derived from.
    gridWidth: undefined,
    gridHeight: undefined,
    // Bumps whenever any grid content may have changed, so the GPU stroke
    // walker re-uploads the field.
    epoch: 0,
    /** @type {Map<string, {def: object, field: Float32Array[]}>} */
    grids: new Map(),
  };
}

registerContextInit((ctx) => {
  ctx.state.field = createFieldState();
  ctx.fields = createFieldGrids();
});

// Internal variables for field configuration
let list = new Map();
const FIELD_ANGLE_MODES = new Set(["degrees", "radians"]);

// Register the standard field generators once, at module load: definitions
// only, so field(name) can validate a name before the WebGPU device is ready.
// Grids are generated lazily per context once its target exists.
addStandard();

/**
 * The generated grid a context holds for `name`, or null when it has none or
 * the definition has been replaced since.
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {string} name - Field name.
 * @returns {Float32Array[]|null} The cached grid.
 */
function gridFor(ctx, name) {
  const record = ctx.fields.grids.get(name);
  return record && record.def === list.get(name) ? record.field : null;
}

/**
 * Caches a generated grid on a context.
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {string} name - Field name.
 * @param {Float32Array[]} field - The generated grid.
 */
function setGrid(ctx, name, field) {
  ctx.fields.grids.set(name, { def: list.get(name), field });
}

/**
 * Initializes the field grid and sets up the vector field's structure based on the renderer's dimensions.
 *
 * @param {import("./context.js").BrushContext} ctx
 */
function createField(ctx) {
  const g = ctx.fields;
  g.resolution = ctx.width * 0.01; // Determine the resolution of the field grid
  g.left_x = -0.5 * ctx.width; // Left boundary of the field
  g.top_y = -0.5 * ctx.height; // Top boundary of the field
  g.num_columns = Math.round((2 * ctx.width) / g.resolution); // Number of columns in the grid
  g.num_rows = Math.round((2 * ctx.height) / g.resolution); // Number of columns in the grid
  g.gridWidth = ctx.width;
  g.gridHeight = ctx.height;
}

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
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} width - The new logical target width.
 * @param {number} height - The new logical target height.
 */
export function _onTargetResized(ctx, width, height) {
  const g = ctx.fields;
  // No grid yet: the next isFieldReady() already builds it at the new size.
  if (!g.isLoaded) return;
  if (width === g.gridWidth && height === g.gridHeight) return;
  g.isLoaded = false;
  g.grids.clear();
  g.epoch++; // Make the GPU stroke walker re-upload the field.
}

/**
 * Retrieves the field values for the current vector field.
 * @param {import("./context.js").BrushContext} ctx
 * @returns {Float32Array[]} The current vector field grid.
 */
function flow_field(ctx) {
  return gridFor(ctx, ctx.state.field.current);
}

function normalizeFieldAngleMode(options = {}) {
  const config =
    typeof options === "string" ? { angleMode: options } : options || {};
  const angleMode = config.angleMode ?? "degrees";

  if (!FIELD_ANGLE_MODES.has(angleMode)) {
    throw new Error(
      `Invalid field angle mode "${angleMode}". Use "degrees" or "radians".`,
    );
  }

  return angleMode;
}

function normalizeFieldAngles(ctx, field, angleMode) {
  if (angleMode !== "radians") return field;

  for (let c = 0; c < field.length; c++) {
    for (let r = 0; r < field[c].length; r++) {
      field[c][r] = toDegreesSigned(ctx, field[c][r], true);
    }
  }

  return field;
}

/**
 * @param {import("./context.js").BrushContext} ctx
 * @param {object} entry - Registry entry (generator + angle mode).
 * @param {number} t - Time parameter handed to the generator.
 */
function generateField(ctx, entry, t) {
  return normalizeFieldAngles(
    ctx,
    entry.gen(t, genField(ctx), ctx.rng),
    entry.angleMode,
  );
}

/**
 * Regenerates the current vector field using its associated generator function.
 * @param {number} [t=0] - An optional time parameter that can affect field generation.
 */
export function refreshField(t = 0) {
  return _refreshField(defaultContext, t);
}

/**
 * Context-taking implementation of refreshField().
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} [t=0] - An optional time parameter that can affect field generation.
 */
export function _refreshField(ctx, t = 0) {
  const field = ctx.state.field;
  if (!field.isActive || !field.current) {
    throw new Error(
      "No field is currently active. Call brush.field('name') to activate one before refreshing.",
    );
  }
  isFieldReady(ctx); // Rebuild the grid first if the target was resized.
  setGrid(ctx, field.current, generateField(ctx, list.get(field.current), t));
  ctx.fields.epoch++;
}

// ---------------------------------------------------------------------------
// GPU-walk field snapshot. The stroke router uploads the active field
// to the strokewalk compute shader; the epoch lets it re-upload only when
// the field actually changed (activation, refresh, regeneration).
// ---------------------------------------------------------------------------

/**
 * Flattened snapshot of the active flow field for GPU upload (col-major,
 * c * numRows + r — the layout strokewalk-compute expects), or null when
 * no field is active. Internal API for the GPU-walk stroke router.
 *
 * @param {import("./context.js").BrushContext} ctx
 */
export function _fieldSnapshot(ctx) {
  const field = ctx.state.field;
  if (!field.isActive || !field.current) return null;
  const f = gridFor(ctx, field.current);
  if (!f) return null;
  const g = ctx.fields;
  const data = new Float32Array(g.num_columns * g.num_rows);
  for (let c = 0; c < g.num_columns; c++) data.set(f[c], c * g.num_rows);
  return {
    data,
    numColumns: g.num_columns,
    numRows: g.num_rows,
    resolution: g.resolution,
    leftX: g.left_x,
    topY: g.top_y,
    epoch: g.epoch,
    name: field.current,
  };
}

/**
 * Current field epoch — bumps whenever any field content may have changed.
 *
 * @param {import("./context.js").BrushContext} ctx
 */
export function _fieldEpochNow(ctx) {
  return ctx.fields.epoch;
}

/**
 * Generates an empty field array.
 * Reuses existing arrays to reduce memory allocation overhead.
 * @returns {Float32Array[]} Empty vector field grid.
 */
function genField(ctx) {
  const g = ctx.fields;
  return new Array(g.num_columns)
    .fill(null)
    .map(() => new Float32Array(g.num_rows));
}

/**
 * Throws if no field is registered under `name`.
 * @param {string} name - Field name.
 */
export function assertField(name) {
  if (!list.has(name)) {
    throw new Error(
      `Field "${name}" does not exist. Available fields: ${Array.from(list.keys()).join(", ")}.`,
    );
  }
}

/**
 * Activates a specific vector field by name, ensuring it's ready for use.
 * @param {string} a - The name of the vector field to activate.
 */
export function field(a) {
  return _field(defaultContext, a);
}

/**
 * Context-taking implementation of field().
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {string} a - The name of the vector field to activate.
 */
export function _field(ctx, a) {
  const state = ctx.state.field;
  if (!state.wiggle) {
    state.wiggle = 1;
  } // Set default wiggle value
  isFieldReady(ctx);
  assertField(a);
  state.isActive = true;
  state.current = a;
  if (!gridFor(ctx, a)) setGrid(ctx, a, generateField(ctx, list.get(a), 0));
  ctx.fields.epoch++;
}

/**
 * Deactivates the current vector field.
 */
export function noField() {
  return _noField(defaultContext);
}

/**
 * Context-taking implementation of noField().
 *
 * @param {import("./context.js").BrushContext} ctx
 */
export function _noField(ctx) {
  isFieldReady(ctx);
  ctx.state.field.isActive = false;
}

/**
 * Adds a new vector field to the field list with a unique name and a generator function.
 * @param {string} name - The unique name for the new vector field.
 * @param {Function} funct - The function that generates the field values.
 * @param {object} [options] - Optional field configuration.
 * @param {"degrees"|"radians"} [options.angleMode="degrees"] - How the generator's output angles should be interpreted.
 */
export function addField(name, funct, options = {}) {
  // A fresh definition object: any grid a context cached for this name is
  // recorded against the previous one and is therefore stale.
  list.set(name, {
    gen: funct,
    angleMode: normalizeFieldAngleMode(options),
  });
}

/**
 * Retrieves a list of all available vector field names.
 * @returns {string[]} An array of all the field names.
 */
export function listFields() {
  // Names only: the standard fields are registered at module load and
  // grids are generated lazily on activation, so no target is required.
  return Array.from(list.keys());
}

export function wiggle(a = 1) {
  return _wiggle(defaultContext, a);
}

/**
 * Context-taking implementation of wiggle().
 *
 * @param {import("./context.js").BrushContext} ctx
 * @param {number} [a=1] - Wiggle strength.
 */
export function _wiggle(ctx, a = 1) {
  _field(ctx, "hand");
  ctx.state.field.wiggle = a;
}

/**
 * Fills every cell of a field grid using a callback (c, r) => angle.
 */
function fillField(field, fn) {
  // The grid arrives pre-sized by genField(), so its own dimensions are the
  // column/row counts — no context needed.
  for (let c = 0; c < field.length; c++)
    for (let r = 0; r < field[c].length; r++) field[c][r] = fn(c, r);
  return field;
}

/**
 * Adds standard predefined vector fields to the list with unique behaviors.
 *
 * Definitions only, registered once at module load. Each generator receives
 * the pre-sized grid and the generating context's randomness, so one
 * definition serves every context.
 */
function addStandard() {
  // Organic noise — basis for brush.wiggle()
  addField("hand", (t, field, rng) => {
    const bs = rng.rr2(0.2, 0.8),
      ba = rng.randInt2(5, 10);
    return fillField(field, (c, r) => {
      const angle = 0.5 * ba * sin(bs * r * c + rng.randInt2(15, 25));
      return 0.2 * angle * cos(t) + rng.noise2(c, r) * ba * 0.7;
    });
  });
  // Smooth large-scale noise curves
  addField("curved", (t, field, rng) => {
    let ar = rng.randInt2(-10, 10);
    if (rng.randInt2(0, 100) % 2 == 0) ar *= -1;
    return fillField(
      field,
      (c, r) =>
        3 *
        map(rng.noise2(c * 0.02 + t * 0.03, r * 0.02 + t * 0.03), 0, 1, -ar, ar),
    );
  });
  // Sharp alternating angles per cell — herringbone / wicker look
  addField("zigzag", (t, field, rng) => {
    let ar = rng.randInt2(-30, -15) + Math.abs(44 * sin(t));
    if (rng.randInt2(0, 100) % 2 == 0) ar *= -1;
    let dif = ar,
      angle = 0;
    for (let c = 0; c < field.length; c++) {
      for (let r = 0; r < field[c].length; r++) {
        field[c][r] = angle;
        angle += dif;
        dif *= -1;
      }
      angle += dif;
      dif *= -1;
    }
    return field;
  });
  // Sinusoidal wave bands
  addField("waves", (t, field, rng) => {
    const sr = rng.randInt2(10, 15) + 5 * sin(t),
      cr = rng.randInt2(3, 6) + 3 * cos(t),
      ba = rng.randInt2(20, 35);
    return fillField(
      field,
      (c, r) => sin(sr * c) * ba * cos(r * cr) + rng.randInt2(-3, 3),
    );
  });
  // Dense oscillation from row×col product
  addField("seabed", (t, field, rng) => {
    const bs = rng.rr2(0.4, 0.8),
      ba = rng.randInt2(18, 26);
    return fillField(
      field,
      (c, r) => 1.1 * ba * sin(bs * r * c + rng.randInt2(15, 20)) * cos(t),
    );
  });
  // Radial vortex — angles spiral around the field centre
  addField("spiral", (_t, field, rng) => {
    const n = rng.randInt2(5, 10);
    const dir = rng.randInt2(0, 2) * 2 - 1;
    const offset = rng.randInt2(65, 80); // <90 = inward spiral
    const attractors = Array.from({ length: n }, () => ({
      x: rng.rr2(0.1, 0.9) * field.length,
      y: rng.rr2(0.1, 0.9) * field[0].length,
    }));
    return fillField(field, (c, r) => {
      let wx = 0,
        wy = 0;
      for (const att of attractors) {
        const dx = c - att.x,
          dy = r - att.y;
        const w = 1 / (dx * dx + dy * dy + 1);
        const a = Math.atan2(dy, dx) * (180 / Math.PI);
        const angle = (dir * (a + offset) * Math.PI) / 180;
        wx += w * Math.cos(angle);
        wy += w * Math.sin(angle);
      }
      return Math.atan2(wy, wx) * (180 / Math.PI);
    });
  });
  // Column-banded stripes — parallel rake marks
  addField("columns", (_t, field, rng) => {
    const freq = rng.randInt2(3, 8),
      amp = rng.randInt2(25, 45);
    return fillField(field, (c, _r) => sin(c * freq) * amp);
  });
}
