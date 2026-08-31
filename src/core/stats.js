// =============================================================================
// Section: Structural Stats (test instrumentation)
// =============================================================================
/**
 * Opt-in structural instrumentation used by the parity/goldens harness
 * (test/parity/structure.js + scripts/assert-structure.mjs).
 *
 * Disabled by default; every hook is behind `Stats.enabled` so the cost in
 * normal rendering is a single boolean check. Exposed on the public module as
 * `_stats` (underscore: test-only, not API).
 *
 * Collected per run:
 * - strokes[]: { steps, drawn } — tip() invocations per stroke (exact,
 *   RNG-independent) and grain-gated stamps actually submitted.
 * - fills[]:  { layers: { [layerIndex]: [vertexCount, ...] } } — FillPoly
 *   vertex-count distribution per layer.
 * - geomHash: FNV-1a over the exact float64 bits of all submitted stroke
 *   stamps, fill-layer vertices and erase circles — a run-to-run identity
 *   fingerprint that sidesteps the canvas2d pixel noise floor.
 */

const FNV_OFFSET = 2166136261 >>> 0;
const _f64 = new DataView(new ArrayBuffer(8));

export const Stats = {
  enabled: false,
  strokes: [],
  fills: [],
  geomHash: FNV_OFFSET,
  _stroke: null,
  _fill: null,

  reset() {
    this.strokes = [];
    this.fills = [];
    this.geomHash = FNV_OFFSET;
    this._stroke = null;
    this._fill = null;
  },

  /** FNV-1a over the raw float64 bits of each number. */
  hashNums(...nums) {
    let h = this.geomHash;
    for (const n of nums) {
      _f64.setFloat64(0, n);
      const hi = _f64.getUint32(0);
      const lo = _f64.getUint32(4);
      h = Math.imul(h ^ hi, 16777619);
      h = Math.imul(h ^ lo, 16777619);
    }
    this.geomHash = h >>> 0;
  },

  beginStroke() {
    this._stroke = { steps: 0, drawn: 0 };
    this.strokes.push(this._stroke);
  },
  countStamp() {
    if (this._stroke) this._stroke.drawn++;
  },
  endStroke() {
    this._stroke = null;
  },

  beginFill() {
    this._fill = { layers: {} };
    this.fills.push(this._fill);
  },
  recordLayer(layerIndex, vertexCount) {
    if (!this._fill) return;
    (this._fill.layers[layerIndex] ??= []).push(vertexCount);
  },
  endFill() {
    this._fill = null;
  },
};
