/** @param {number} x sRGB channel in [0,1] @returns {number} linear */
export function spectralUncompand(x: number): number;
/** @param {number} x linear channel @returns {number} sRGB, clamped [0,1] */
export function spectralCompand(x: number): number;
/**
 * spectral.frag spectral_linear_to_reflectance.
 * @param {[number, number, number]|number[]} lrgb linear rgb
 * @returns {Float64Array} 38-band reflectance
 */
export function linearToReflectance(lrgb: [number, number, number] | number[]): Float64Array;
/**
 * spectral.frag spectral_reflectance_to_xyz.
 * @param {ArrayLike<number>} R 38-band reflectance
 * @returns {[number, number, number]} XYZ
 */
export function reflectanceToXYZ(R: ArrayLike<number>): [number, number, number];
/**
 * Precomputes the hoisted half of spectral_mix for one sRGB color:
 * its 38-band reflectance packed vec4-wide (40 floats, last 2 zero —
 * matching `array<vec4f, 10>` uniform stride) and its XYZ luminance.
 *
 * Memoized on the last color seen — "compute once when the blend color
 * changes" — so the adapter can call this per composite without bookkeeping.
 *
 * @param {[number, number, number]|number[]} color sRGB in [0,1]
 * @returns {{r2: Float32Array, luminance: number}} shared, do not mutate
 */
export function precomputeReflectance(color: [number, number, number] | number[]): {
    r2: Float32Array;
    luminance: number;
};
/**
 * Packs the composite pass uniform block.
 *
 * @param {{color: number[], isBrush?: boolean, targetIsFramebuffer?: boolean}} opts
 *   color: blend color, sRGB [0,1] (spectral.frag u_color)
 * @param {Float32Array} [out] length ≥ 48; allocated when omitted
 * @returns {Float32Array} out — pass to uniformRing.write()
 */
export function packBlendUniforms(opts: {
    color: number[];
    isBrush?: boolean;
    targetIsFramebuffer?: boolean;
}, out?: Float32Array): Float32Array;
/**
 * Full CPU port of GLSL spectral_mix(color1, color2, factor)
 * (tintingStrength = 1). Float64 throughout.
 *
 * @param {number[]} color1 sRGB [0,1]
 * @param {number[]} color2 sRGB [0,1]
 * @param {number} t mix factor toward color2
 * @returns {[number, number, number]} sRGB [0,1]
 */
export function spectralMix(color1: number[], color2: number[], t: number): [number, number, number];
export const SPECTRAL_SIZE: 38;
/** 38×7 (w,c,m,y,r,g,b) — spectral.frag spectral_linear_to_reflectance. */
export const SPECTRAL_L2R: number[][];
/** 38×3 CIE weights — spectral.frag spectral_reflectance_to_xyz. */
export const SPECTRAL_R_TO_XYZ: number[][];
/** 3×3 XYZ→linear-sRGB rows — spectral.frag XYZ_RGB. */
export const SPECTRAL_XYZ_TO_RGB: number[][];
/** Byte size of BlendUniforms. */
export const BLEND_UNIFORM_BYTES: 192;
export namespace BLEND_UNIFORM_OFFSETS {
    let r2: number;
    let lum2: number;
    let isBrush: number;
    let targetIsFramebuffer: number;
    let color: number;
}
