// ============================================================
// grow-compute oracle — CPU reference (W2)
//
// The oracle must diff GPU grow() against the REAL CPU grow(), but
// fill.js does not export FillPoly and W2 may not edit shared files.
// Instead of hand-copying trim()/grow() (which would silently rot), this
// module fetches src/fill/fill.js, extracts the exact source text of the
// two methods by brace matching, and instantiates them via new Function
// with their module-level dependencies injected:
//
//   ctx                             → a drawing context (core/context.js)
//                                     shape: the real core/utils.js hash
//                                     stream as its rng, the oracle's fill
//                                     state, and the fill cursor + gaussian
//                                     pools the methods read (grow cap and
//                                     grow scratch live on ctx.fillCursor,
//                                     the pools on ctx.rng.scopes.fill)
//   STREAM / cossin                 → the real exports of core/utils.js
//   nextOpSalt                      → oracle-controlled
//   _fillGaussianPools              → noop
//
// So the reference EXECUTES the shipped CPU implementation. If fill.js
// refactors the method signatures, extraction throws and the oracle
// fails loudly rather than comparing against a stale copy.
// ============================================================

import { rh, hashU32, STREAM, cossin } from "../../src/core/utils.js";

/** Extracts the full text of `  name(ctx, f = 1) { ... }` from fill.js source. */
export function extractMethod(source, name) {
  const sig = `\n  ${name}(ctx, f = 1) {`;
  const at = source.indexOf(sig);
  if (at < 0) {
    throw new Error(
      `grow oracle: could not find "${name}(ctx, f = 1) {" in src/fill/fill.js — ` +
        "method signature changed; update grow-cpu-ref.js extraction",
    );
  }
  const open = source.indexOf("{", at + 1);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return bindContext(source.slice(at + 1, i + 1));
    }
  }
  throw new Error(`grow oracle: unbalanced braces extracting ${name}()`);
}

/**
 * The shipped methods take the drawing context as their first parameter.
 * The reference class supplies one from its closure instead, so the ctx
 * parameter and the ctx argument of every internal call are dropped — the
 * arithmetic, the stream draws and the control flow are untouched, and the
 * oracle keeps the pre-context call shape. Anything the extraction misses
 * throws at `new Function` rather than comparing against a stale copy.
 */
function bindContext(src) {
  return src
    .replace(/^(\s*)(trim|grow)\(ctx, /, "$1$2(")
    .replaceAll("this.trim(ctx, ", "this.trim(")
    .replaceAll("new FillPoly(ctx, ", "new FillPoly(")
    .replaceAll("_fillGaussianPools(ctx)", "_fillGaussianPools()");
}

/**
 * Builds a FillPoly class whose trim()/grow() are the extracted fill.js
 * implementations, closed over the given fill state.
 *
 * @param {Object} opts
 * @param {string} opts.source        text of src/fill/fill.js
 * @param {Object} opts.state         { fill: { direction, bleed_strength } }
 * @param {number} opts.growCap       fill.js grow cap for this fill
 * @param {[number[], number[]]} opts.gaussians  the two 512-entry pools
 * @param {{value: number}} opts.op   shared op counter (the fill scope's op)
 * @param {number} opts.fillId
 */
export function buildFillPolyRef({ source, state, growCap, gaussians, op, fillId }) {
  const trimSrc = extractMethod(source, "trim");
  const growSrc = extractMethod(source, "grow");

  const nextOpSalt = () => (((fillId << 10) + op.value++) >>> 0);
  // The context the extracted bodies read: the real hash streams, the
  // oracle's fill state, its grow cap and scratch, and its gaussian pools.
  const ctx = {
    rng: { rh, hashU32, scopes: { fill: { poolA: gaussians[0], poolB: gaussians[1] } } },
    state,
    fillCursor: { growCap, insX: [], insY: [], mods: [], dirs: [] },
  };
  const factory = new Function(
    "ctx",
    "STREAM",
    "cossin",
    "_fillGaussianPools",
    "nextOpSalt",
    `"use strict";
class FillPoly {
  constructor(v, m, center, dir = [], isFirst = false, sx, sy) {
    // grow()/trim() only ever construct with isFirst === false.
    this.v = v; this.m = m; this.dir = dir; this.midP = center;
    this.sizeX = sx; this.sizeY = sy;
  }
  ${trimSrc}
  ${growSrc}
}
return FillPoly;`,
  );

  return factory(
    ctx,
    STREAM,
    cossin,
    () => {}, // pools are prefilled by the oracle; refill hook is a noop
    nextOpSalt,
  );
}
