// =============================================================================
// Module: Trigonometry tables
// =============================================================================
/**
 * The 1440-entry (360° × 4 samples) cos/sin lookup tables and the degree
 * normalizer that indexes them. Pure data and pure functions — no state, no
 * imports — so both core/rng.js (the gaussian's Box-Muller rotation) and
 * core/utils.js can depend on it without a cycle.
 *
 * The exact table values are load bearing: grow-compute uploads a rebuilt
 * copy and asserts it against `cos()`/`sin()` here, and every stamp position
 * in the goldens comes out of these lookups.
 */

// number of discrete steps (360° × 4 samples per degree)
const totalDegrees = 1440;
const radiansPerIndex = (2 * Math.PI) / totalDegrees;

// Pre-warmed lookup tables — filled at module load, no lazy-init overhead
const cLookup = new Float32Array(totalDegrees);
const sLookup = new Float32Array(totalDegrees);
for (let _i = 0; _i < totalDegrees; _i++) {
  cLookup[_i] = Math.cos(_i * radiansPerIndex);
  sLookup[_i] = Math.sin(_i * radiansPerIndex);
}

/**
 * Normalize an angle in degrees to a lookup-table index [0, 1440).
 * Avoids the % operator for the common range [-360, 720) found in the library.
 * @param {number} angle
 * @returns {number} integer index in [0, 1440)
 */
const angleToIdx = (angle) => {
  if (angle < 0) {
    if (angle >= -360) return ~~((angle + 360) * 4);
    angle = angle % 360;
    return ~~((angle < 0 ? angle + 360 : angle) * 4);
  }
  if (angle < 360) return ~~(angle * 4);
  if (angle < 720) return ~~((angle - 360) * 4);
  if (angle < 1080) return ~~((angle - 720) * 4);
  angle = angle % 360;
  return ~~((angle < 0 ? angle + 360 : angle) * 4);
};

/**
 * Cosine of an angle (degrees), via a pre-warmed lookup table.
 * @param {number} angle
 * @returns {number}
 */
export const cos = (angle) => cLookup[angleToIdx(angle)];

/**
 * Sine of an angle (degrees), via a pre-warmed lookup table.
 * @param {number} angle
 * @returns {number}
 */
export const sin = (angle) => sLookup[angleToIdx(angle)];

/**
 * Returns [cos(angle), sin(angle)] via a single index computation.
 * Use when both values are needed for the same angle — avoids computing
 * angleToIdx() twice (once per separate cos/sin call).
 * Returns a reusable Float32Array — use values immediately, do not store the reference.
 * @param {number} angle
 * @returns {Float32Array} [cos, sin]
 */
const _cosSinBuf = new Float32Array(2);
export const cossin = (angle) => {
  const idx = angleToIdx(angle);
  _cosSinBuf[0] = cLookup[idx];
  _cosSinBuf[1] = sLookup[idx];
  return _cosSinBuf;
};
