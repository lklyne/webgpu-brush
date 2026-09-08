// =============================================================================
// Module: Randomness & Noise
// =============================================================================
/**
 * Every random draw the library makes comes from an `rng` object built here.
 * A context owns one (`ctx.rng`), so two paintings can be seeded
 * independently: `seed()` on one resets that object's streams, its scope
 * counters and its gaussian pools, and nothing else.
 *
 * Three generators live side by side:
 *   - the sequential Mulberry32 streams (`rng`, `rng2`) behind the
 *     user-facing `random()` / `gaussian()` / `rArray()` and the gaussian
 *     pools;
 *   - the two simplex-noise fields (`noise`, `noise2`), reseeded separately
 *     by `noiseSeed()`;
 *   - the counter-based hash stream (`hashU32` / `hash01` / `rh` / `nh`),
 *     which is what all internal geometry draws from.
 *
 * The hash math is a pure module function of an explicit seed word
 * (`hashU32From`); the rng object only binds its own word to it. The WGSL
 * ports receive that same word as a uniform, so the GPU side is unaffected by
 * where the word is stored.
 */

import { createNoise2D } from "simplex-noise";
import { cos, sin } from "./trig.js";

// ---------------------------------------------------------------------------
// Mulberry32 PRNG — ~4x faster than prng_alea (Alea), full statistical quality
// Passes PractRand and BigCrush; suitable for visual simulation.
// ---------------------------------------------------------------------------

/**
 * Maps any seed value (number or string) to a non-zero uint32.
 * Uses a finalizer from SplitMix64 for good avalanche behavior.
 * @param {number|string} seed
 * @returns {number} uint32
 */
function _hashSeed(seed) {
  let h = 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x9e3779b9) | 0;
    h ^= h >>> 15;
  }
  // Finalizer
  h = Math.imul(h ^ h >>> 16, 0x85ebca6b) | 0;
  h = Math.imul(h ^ h >>> 13, 0xc2b2ae35) | 0;
  return (h ^ h >>> 16) >>> 0 || 1;
}

/**
 * Creates a Mulberry32 PRNG seeded from an arbitrary value.
 * Returns a function that yields uniform floats in [0, 1).
 * @param {number|string} seed
 * @returns {() => number}
 */
function _makePRNG(seed) {
  let s = _hashSeed(seed);
  return () => {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, s | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) * 2.3283064365386963e-10;
  };
}

// ---------------------------------------------------------------------------
// Counter-based hash RNG — replaces upstream's sequential rr() stream.
//
// Internal geometry randomness no longer draws from an implicit sequential
// stream: every draw is hash(seed, streamId, salt, index), so any consumer
// (including the GPU compute shaders) can reproduce any single value
// from its coordinates alone, in any order, in parallel.
//
// Construction: multiply-xor input combiner + the lowbias32 finalizer
// (Chris Wellons, "Prospecting for Hash Functions", 2018 — bias 0.107).
// Cost is 5 imul + 6 xor/shift per draw, stateless — on par with one
// Mulberry32 step and trivially portable to WGSL (u32 ops only).
// Chosen over PCG: no 64-bit state/multiplies to emulate in either JS or
// WGSL; over wang_hash: fewer rounds for measurably lower bias.
//
// This intentionally breaks same-seed reproduction of upstream p5.brush
// sketches (settled plan decision). Run-to-run reproducibility per seed is
// preserved: seed() resets the seed word and every scope counter and pool
// registered on that rng (via onSeed).
// ---------------------------------------------------------------------------

const U32_TO_UNIT = 2.3283064365386963e-10;

/**
 * Counter-based hash: (seed, streamId, salt, index) → uint32. The seed word
 * is explicit so the math stays a pure function — the rng object binds its
 * own word, and grow-compute checks the construction against a seed it was
 * handed.
 * @param {number} seedU32 - The stream's seed word.
 * @param {number} streamId - STREAM.* purpose id.
 * @param {number} salt - Per-scope word (strokeSalt / fillSalt / hatchId).
 * @param {number} index - Loop counter at the call site.
 * @returns {number} uint32
 */
export const hashU32From = (seedU32, streamId, salt, index) => {
  let h =
    (seedU32 ^
      Math.imul(streamId, 0x9e3779b1) ^
      Math.imul(salt, 0x85ebca77) ^
      Math.imul(index, 0xc2b2ae3d)) |
    0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
};

/**
 * Counter-based uniform float in [0,1) from an explicit seed word.
 */
export const hash01From = (seedU32, streamId, salt, index) =>
  hashU32From(seedU32, streamId, salt, index) * U32_TO_UNIT;

/**
 * Seeded randomness for one painting.
 *
 * @typedef {object} BrushRng
 * @property {(e?: number|Array, r?: number) => number} random User-facing uniform draw.
 * @property {(e?: number, r?: number) => number} rr2 Uniform float in [min, max) — user stream.
 * @property {(e: number, r: number) => number} randInt2 Uniform integer — user stream.
 * @property {(array: Array) => any} rArray Uniform pick from an array.
 * @property {(mean?: number, stdev?: number) => number} gaussian Sequential gaussian draw.
 * @property {(weights: object) => string|number} weightedRand Weighted key pick.
 * @property {(x: number, y: number) => number} noise Simplex noise.
 * @property {(x: number, y: number) => number} noise2 Second noise stream.
 * @property {(streamId: number, salt: number, index: number) => number} hashU32 Counter-based hash.
 * @property {(streamId: number, salt: number, index: number) => number} hash01 Counter-based uniform float.
 * @property {(streamId: number, salt: number, index: number, min?: number, max?: number) => number} rh
 *   Counter-based uniform float in a range.
 * @property {(streamId: number, salt: number, index: number, mean?: number, stdev?: number) => number} nh
 *   Counter-based gaussian.
 * @property {(s: number|string) => void} seed Reseeds every stream and scope.
 * @property {(s: number|string) => void} noiseSeed Reseeds the noise streams.
 * @property {(cb: () => void) => void} onSeed Registers a reseed callback.
 * @property {() => number} seedU32 Current hash-stream seed word.
 * @property {object} scopes Per-module counters and pools, installed by their
 *   owning module and reset from that module's onSeed callback.
 */

/**
 * Builds an independent set of seeded generators.
 *
 * With no argument the streams are seeded from `Math.random()` — one draw per
 * stream, as the module-level generators always were. With a seed value the
 * sequential and hash streams take it through `seed()`; the noise fields stay
 * randomly seeded until `noiseSeed()` says otherwise, which is what `seed()`
 * does too.
 *
 * @param {number|string} [initialSeed]
 * @returns {BrushRng}
 */
export function createRng(initialSeed) {
  let rng = _makePRNG(Math.random());
  let rng2 = _makePRNG(Math.random() + ":2");
  let seedU32 = _hashSeed(Math.random());
  let noiseFn = createNoise2D(_makePRNG(Math.random()));
  let noise2Fn = createNoise2D(_makePRNG(Math.random() + ":2"));

  // Box-Muller with cached second value — halves Math.sqrt/Math.log calls.
  let gaussCached = false;
  let gaussZ1 = 0;

  /** @type {Array<() => void>} */
  const seedCallbacks = [];

  const hashU32 = (streamId, salt, index) =>
    hashU32From(seedU32, streamId, salt, index);
  const hash01 = (streamId, salt, index) =>
    hashU32From(seedU32, streamId, salt, index) * U32_TO_UNIT;

  const rr2 = (e = 0, r = 1) => e + rng2() * (r - e);
  const rArray = (array) => array[~~(rng() * array.length)];

  /** @type {BrushRng} */
  const api = {
    /**
     * Generates a random number or picks a random element from an array.
     * - random()        → float in [0, 1)
     * - random(max)     → float in [0, max)
     * - random(min,max) → float in [min, max)
     * - random(array)   → random element from array
     */
    random: function random(e = 0, r = 1) {
      if (Array.isArray(e)) return rArray(e);
      if (arguments.length === 1) return rng2() * e;
      return rr2(e, r);
    },
    rr2,
    randInt2: (e, r) => ~~rr2(e, r),
    rArray,

    /** Gaussian (normal) random sample N(mean, stdev²). */
    gaussian: (mean = 0, stdev = 1) => {
      if (gaussCached) {
        gaussCached = false;
        return gaussZ1 * stdev + mean;
      }
      const u = 1 - rng();
      const v = rng();
      const r = Math.sqrt(-2.0 * Math.log(u));
      const angle = 360 * v;
      gaussZ1 = r * sin(angle);
      gaussCached = true;
      return r * cos(angle) * stdev + mean;
    },

    /** Picks a key from an object according to weighted probabilities. */
    weightedRand: (weights) => {
      let totalWeight = 0;
      const entries = [];

      // Build cumulative weights array
      for (const key in weights) {
        totalWeight += weights[key];
        entries.push({ key, cumulative: totalWeight });
      }

      // Get a random number between 0 and totalWeight
      const rnd = rng() * totalWeight;

      // Pick the first entry where rnd is less than the cumulative weight
      for (const { key, cumulative } of entries) {
        if (rnd < cumulative) {
          return isNaN(key) ? key : parseInt(key);
        }
      }
    },

    noise: (x, y) => noiseFn(x, y),
    noise2: (x, y) => noise2Fn(x, y),

    hashU32,
    hash01,
    /** Counter-based uniform float in [min, max). The rr() replacement. */
    rh: (streamId, salt, index, min = 0, max = 1) =>
      min + hash01(streamId, salt, index) * (max - min),
    /**
     * Counter-based gaussian N(mean, stdev²) via Box-Muller on two hash draws
     * (index*2, index*2+1).
     */
    nh: (streamId, salt, index, mean = 0, stdev = 1) => {
      const u = 1 - hash01(streamId, salt, index * 2);
      const v = hash01(streamId, salt, index * 2 + 1);
      return (
        Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * stdev + mean
      );
    },

    /** Seed the random number generator. */
    seed: (s) => {
      rng = _makePRNG(s);
      rng2 = _makePRNG(`${s}:2`);
      seedU32 = _hashSeed(s);
      gaussCached = false; // reset cached gaussian on reseed
      for (const callback of seedCallbacks) callback();
    },

    /** Seed the noise generators. */
    noiseSeed: (s) => {
      noiseFn = createNoise2D(_makePRNG(s));
      noise2Fn = createNoise2D(_makePRNG(`${s}:2`));
    },

    /**
     * Register a callback to run whenever this rng is reseeded. Used by the
     * modules that keep scope counters and gaussian pools.
     */
    onSeed: (cb) => {
      seedCallbacks.push(cb);
    },

    /**
     * The current hash-stream seed word. GPU compute components
     * (grow-compute, strokewalk-compute) hand this to their shaders so WGSL
     * hashU32 reproduces the CPU streams bit-exactly.
     */
    seedU32: () => seedU32,

    // Scope counters and pools, keyed by owning module: `stroke`, `fill`,
    // `hatch`. They live here because seed() is what resets them.
    scopes: {},
  };

  if (initialSeed !== undefined) api.seed(initialSeed);
  return api;
}

// ---------------------------------------------------------------------------
// The default painting's generators. `defaultContext` (core/context.js)
// adopts this object, so the module-level functions below and the default
// context's draws share one stream — exactly as they did when these were
// module variables. A second context gets its own createRng().
// ---------------------------------------------------------------------------

const _defaultRng = createRng();

/** The rng `defaultContext` adopts. @returns {BrushRng} */
export const _getDefaultRng = () => _defaultRng;

/** @type {BrushRng["random"]} */
export const random = (...args) => _defaultRng.random(...args);
/** @type {BrushRng["rr2"]} */
export const rr2 = (e, r) => _defaultRng.rr2(e, r);
/** @type {BrushRng["randInt2"]} */
export const randInt2 = (e, r) => _defaultRng.randInt2(e, r);
/** @type {BrushRng["rArray"]} */
export const rArray = (array) => _defaultRng.rArray(array);
/** @type {BrushRng["gaussian"]} */
export const gaussian = (mean, stdev) => _defaultRng.gaussian(mean, stdev);
/** @type {BrushRng["weightedRand"]} */
export const weightedRand = (weights) => _defaultRng.weightedRand(weights);
/** @type {BrushRng["noise"]} */
export const noise = (x, y) => _defaultRng.noise(x, y);
/** @type {BrushRng["noise2"]} */
export const noise2 = (x, y) => _defaultRng.noise2(x, y);
/** @type {BrushRng["hashU32"]} */
export const hashU32 = (streamId, salt, index) =>
  _defaultRng.hashU32(streamId, salt, index);
/** @type {BrushRng["hash01"]} */
export const hash01 = (streamId, salt, index) =>
  _defaultRng.hash01(streamId, salt, index);
/** @type {BrushRng["rh"]} */
export const rh = (streamId, salt, index, min, max) =>
  _defaultRng.rh(streamId, salt, index, min, max);
/** @type {BrushRng["nh"]} */
export const nh = (streamId, salt, index, mean, stdev) =>
  _defaultRng.nh(streamId, salt, index, mean, stdev);
/** @type {BrushRng["seed"]} */
export const seed = (s) => _defaultRng.seed(s);
/** @type {BrushRng["noiseSeed"]} */
export const noiseSeed = (s) => _defaultRng.noiseSeed(s);
/** Current hash-stream seed word of the default painting. */
export const _getSeedU32 = () => _defaultRng.seedU32();
