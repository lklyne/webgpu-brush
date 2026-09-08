// =============================================================================
// Adapter: Standalone Runtime Hooks
// =============================================================================

import { setRuntime } from "../../core/runtime.js";
import { defaultContext, registerContextInit } from "../../core/context.js";
import { push as pushState, pop as popState } from "../../core/save.js";

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

export const DEGREES = "degrees";
export const RADIANS = "radians";

// The 2D context used to parse CSS color strings is a parser, not drawing
// state: one per document is correct, and it stays module-level.
let colorContext = null;

function getColorContext() {
  if (colorContext) return colorContext;

  if (typeof document !== "undefined") {
    colorContext = document.createElement("canvas").getContext("2d");
    return colorContext;
  }

  if (typeof OffscreenCanvas !== "undefined") {
    colorContext = new OffscreenCanvas(1, 1).getContext("2d");
    return colorContext;
  }

  throw new Error("Standalone color parsing requires CanvasRenderingContext2D support.");
}

function multiplyTransform(left, right) {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    x: left.a * right.x + left.c * right.y + left.x,
    y: left.b * right.x + left.d * right.y + left.y,
  };
}

/**
 * Runtime-native color object compatible with the expectations of core modules.
 */
export class Color {
  constructor(r, g, b) {
    if (r?._array) {
      this.r = Math.round(r._array[0] * 255);
      this.g = Math.round(r._array[1] * 255);
      this.b = Math.round(r._array[2] * 255);
      this.hex = this.rgbToHex(this.r, this.g, this.b);
      this._array = [...r._array];
      this.gl = this._array;
      return;
    }

    if (typeof r === "string") {
      const rgbaMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/i.exec(r);
      if (rgbaMatch) {
        this.r = clamp(parseInt(rgbaMatch[1]), 0, 255);
        this.g = clamp(parseInt(rgbaMatch[2]), 0, 255);
        this.b = clamp(parseInt(rgbaMatch[3]), 0, 255);
        this.hex = this.rgbToHex(this.r, this.g, this.b);
        const alpha = rgbaMatch[4] !== undefined ? clamp(parseFloat(rgbaMatch[4]), 0, 1) : 1;
        this._array = [this.r / 255, this.g / 255, this.b / 255, alpha];
        this.gl = this._array;
        return;
      }
      this.hex = this.standardize(r);
      const rgb = this.hexToRgb(this.hex);
      this.r = rgb.r;
      this.g = rgb.g;
      this.b = rgb.b;
    } else {
      this.r = clamp(r ?? 0, 0, 255);
      this.g = clamp(g ?? r ?? 0, 0, 255);
      this.b = clamp(b ?? r ?? 0, 0, 255);
      this.hex = this.rgbToHex(this.r, this.g, this.b);
    }

    this._array = [this.r / 255, this.g / 255, this.b / 255, 1];
    this.gl = this._array;
  }

  rgbToHex(r, g, b) {
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
  }

  hexToRgb(hex) {
    hex = hex.replace(
      /^#?([a-f\d])([a-f\d])([a-f\d])$/i,
      (_match, red, green, blue) => red + red + green + green + blue + blue,
    );
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) {
      throw new Error(`Invalid color value "${hex}".`);
    }
    return {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16),
    };
  }

  standardize(value) {
    const ctx = getColorContext();
    ctx.fillStyle = value;
    return ctx.fillStyle;
  }

  _getRed() {
    return this.r;
  }

  _getGreen() {
    return this.g;
  }

  _getBlue() {
    return this.b;
  }
}

/**
 * Sets the active standalone angle mode.
 *
 * @param {"degrees"|"radians"} mode
 */
export function angleMode(mode) {
  return _angleMode(defaultContext, mode);
}

/**
 * Context-taking implementation of angleMode().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {"degrees"|"radians"} mode
 */
export function _angleMode(ctx, mode) {
  if (mode !== DEGREES && mode !== RADIANS) {
    throw new Error(`Invalid angle mode "${mode}". Use "degrees" or "radians".`);
  }
  ctx.angleMode = mode;
}

/**
 * Returns the current standalone angle mode.
 *
 * @returns {"degrees"|"radians"}
 */
export function getAngleMode() {
  return _getAngleMode(defaultContext);
}

/**
 * Context-taking implementation of getAngleMode().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @returns {"degrees"|"radians"}
 */
export function _getAngleMode(ctx) {
  return ctx.angleMode;
}

/**
 * Pushes the current standalone transform onto the stack.
 */
export function push() {
  return _push(defaultContext);
}

/**
 * Context-taking implementation of push().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 */
export function _push(ctx) {
  pushState(ctx);
  ctx.transformStack.push({ ...ctx.transform });
}

/**
 * Pops the last standalone transform from the stack.
 */
export function pop() {
  return _pop(defaultContext);
}

/**
 * Context-taking implementation of pop().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 */
export function _pop(ctx) {
  if (ctx.transformStack.length === 0) return;
  ctx.transform = ctx.transformStack.pop();
  popState(ctx);
}

/**
 * Applies a translation to the current standalone transform.
 *
 * @param {number} x
 * @param {number} y
 */
export function translate(x, y) {
  return _translate(defaultContext, x, y);
}

/**
 * Context-taking implementation of translate().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {number} x
 * @param {number} y
 */
export function _translate(ctx, x, y) {
  ctx.transform = multiplyTransform(ctx.transform, {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    x,
    y,
  });
}

/**
 * Applies a rotation to the current standalone transform.
 *
 * @param {number} angle
 */
export function rotate(angle) {
  return _rotate(defaultContext, angle);
}

/**
 * Context-taking implementation of rotate().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {number} angle
 */
export function _rotate(ctx, angle) {
  const theta = ctx.angleMode === RADIANS ? angle : (angle * Math.PI) / 180;
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  ctx.transform = multiplyTransform(ctx.transform, {
    a: cosTheta,
    b: sinTheta,
    c: -sinTheta,
    d: cosTheta,
    x: 0,
    y: 0,
  });
}

/**
 * Applies a scale to the current standalone transform.
 *
 * @param {number} x
 * @param {number} [y=x]
 */
export function scale(x, y = x) {
  return _scale(defaultContext, x, y);
}

/**
 * Context-taking implementation of scale().
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 * @param {number} x
 * @param {number} [y=x]
 */
export function _scale(ctx, x, y = x) {
  ctx.transform = multiplyTransform(ctx.transform, {
    a: x,
    b: 0,
    c: 0,
    d: y,
    x: 0,
    y: 0,
  });
}

/**
 * Installs the standalone runtime hooks on a context. They close over the
 * context's own angle mode and transform, so two contexts can disagree.
 *
 * @param {import("../../core/context.js").BrushContext} ctx
 */
function installRuntime(ctx) {
  setRuntime(ctx, {
    usesRadians: () => ctx.angleMode === "radians",
    fromDegrees: (angle) =>
      ctx.angleMode === "radians" ? (angle * Math.PI) / 180 : angle,
    createColor: (...args) => {
      if (args.length === 1 && args[0]?._array) return args[0];
      return new Color(...args);
    },
    getAffineMatrix: () => ctx.transform,
  });
}

// Angle mode and the transform stack are context state, not module state.
// Every context this adapter drives gets its own, including `defaultContext`,
// which exists before this module is imported.
registerContextInit((ctx) => {
  ctx.angleMode = RADIANS;
  ctx.transform = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };
  ctx.transformStack = [];
  installRuntime(ctx);
});

/**
 * Installs the standalone runtime hooks used by core modules.
 */
export function initStandaloneRuntime() {
  installRuntime(defaultContext);
}
