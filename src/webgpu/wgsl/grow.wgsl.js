// W3: canonical WGSL source, unified to the .wgsl.js string-export convention
// (was grow.wgsl, fetched at runtime pre-W3). Bundled by rollup like any module.
export const GROW_WGSL = /* wgsl */ `
// =============================================================================
// grow.wgsl — FillPoly.grow() on the GPU (W2 grow-compute)
//
// Bit-faithful port of src/fill/fill.js FillPoly.trim() + FillPoly.grow(),
// using the W1b counter-based hash RNG (src/core/utils.js hashU32/hash01 —
// lowbias32 finalizer over a multiply-xor combiner; u32-only, reproduced
// verbatim below). The CPU implementation stays untouched and is the oracle.
//
// NOT COMPILABLE STANDALONE: src/webgpu/grow.js prepends a generated prelude
// of \`const STREAM_*: u32 = ...;\` taken from STREAM in src/core/utils.js, so
// the stream ids cannot drift from the canonical map. See buildGrowPrelude().
//
// Two dispatches per grow() call (one "layer" step):
//   prepare (workgroup_size 1) — replicates all sequential scalar decisions:
//     trim fast-path test, op-salt consumption (GPU-resident op counter),
//     nTrim/s/nInsert, GROW_MOD999 draw, GROW_CAP step + skipInserted,
//     output count; writes Params, the dst header, and the drawIndirect
//     args embedded in the dst poly buffer (words 8..11).
//   exec (workgroup_size 64) — one thread per pre-cap output index j;
//     reconstructs trimmed vertices on the fly (never materialized) and
//     writes kept/inserted vertices, mods, dirs at cap-downsampled slots.
//     Thread count is CPU-fixed at 2*capacity; extra threads early-out, so
//     no dispatchIndirect and no readback anywhere (plan gotcha #9).
//
// Exact-integer parity machinery (why this file is longer than the JS):
//   - trim's \`~~((1 - f) * totalN)\` multiplies an f64 by a GPU-resident
//     integer. The fill() schedule (f = 1 - 0.0125*i, ...) makes the exact
//     product land on integers, where f32 truncates differently than f64
//     (e.g. f = 0.975, N = 40: f64 → 1, f32 → 0). f64FloorMulN() emulates
//     the f64 multiply bit-exactly (96-bit limbs + round-to-nearest-even).
//   - \`Math.ceil(idx / GROW_CAP)\` has the same integer attractor (GROW_CAP
//     multiples of 2024). capStep() looks up a JS-precomputed table of the
//     largest idx per step value, built with the very JS expression it
//     replaces — exact by construction.
//   - cos/sin go through utils.js's 1440-entry Float32Array LUT, uploaded
//     verbatim; angleToIdx() ports the index math (int decisions only).
//
// Poly storage-buffer layout (one binding, array<u32>, manual offsets;
// all offsets in 4-byte words; CAP = U.cap vertices):
//   word 0        count (u32)
//   words 1..4    midX, midY, sizeX, sizeY (f32)
//   words 5..7    reserved
//   words 8..11   drawIndirect { vertexCount=3*(count-2) fan-expanded,
//                 instanceCount=1, firstVertex=0, firstInstance=0 }
//                 → renderPass.drawIndirect(polyBuffer, 32)
//   words 16..    verts: CAP * vec2f (x,y interleaved)
//   16+2*CAP..    mods:  CAP * f32
//   16+3*CAP..    dirs:  CAP * u32 (0/1)
//
// consts buffer (array<f32>, see grow.js CONSTS_* offsets):
//   [0..512)      gaussian pool A (fill.js _gaussians[0], N(0.5, 0.2^2))
//   [512..1024)   gaussian pool B (fill.js _gaussians[1], N(0, 0.02^2))
//   [1024..2464)  cos LUT (1440 entries, 0.25 deg per step)
//   [2464..3904)  sin LUT
//   [3904..3968)  bitcast<u32> step table T[1..64] (word 3904 + s holds T[s])
// =============================================================================

const HDR_COUNT: u32 = 0u;
const HDR_MID_X: u32 = 1u;
const HDR_INDIRECT: u32 = 8u;
const HDR_WORDS: u32 = 16u;

const POOL_LEN: u32 = 512u;
const POOL_B_BASE: u32 = 512u;
const COS_BASE: u32 = 1024u;
const SIN_BASE: u32 = 2464u;
const STEP_TABLE_BASE: u32 = 3904u;
const STEP_TABLE_LEN: u32 = 64u;

struct Uniforms {
  f: f32,          // growth factor (f32 is exact for 1, 997, 999; schedule
                   // values only feed comparisons with wide margins — the
                   // precision-critical (1-f) goes through gMant* below)
  seed: u32,       // _seedU32 from core/utils.js (derived, see grow.js)
  saltBase: u32,   // fillId << 10 (fill.js nextOpSalt)
  cap: u32,        // poly buffer vertex capacity
  bleed: f32,      // State.fill.bleed_strength
  bleedDirDeg: f32,// -90 for direction "out", +90 otherwise (fill.js grow)
  growCap: f32,    // GROW_CAP (informational; exact path uses the table)
  floorCap: u32,   // Math.floor(GROW_CAP) — exact \`idx > GROW_CAP\` gate
  gMantHi: u32,    // f64 decomposition of (1 - f): value = mant * 2^-gShift
  gMantLo: u32,    //   mant = gMantHi * 2^32 + gMantLo  (<= 2^53)
  gShift: u32,     //   0 sentinel → (1-f) <= 0 → nTrim = 0
  _pad0: u32,
}

struct Params {
  doTrim: u32,
  skipInserted: u32,
  stepK: u32,      // cap downsample step
  idx: u32,        // pre-cap output count (2 * lenT, or lenT when skipping)
  lenT: u32,       // trimmed length
  totalN: u32,
  s: u32,          // trim start (kept prefix length)
  nTrim: u32,
  nInsert: u32,
  trimSalt: u32,
  growSalt: u32,
  dirBase: u32,
  jitterAmt: f32,
  eStartX: f32,
  eStartY: f32,
  evx: f32,
  evy: f32,
  mod999: f32,
  outCount: u32,
  _pad1: u32,
}

struct OpState {
  op: u32,         // fill.js _fillOp — GPU-resident so the trim fast path's
                   // data-dependent salt consumption stays correct
}

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read_write> opState: OpState;
@group(0) @binding(4) var<storage, read_write> P: Params;
@group(0) @binding(5) var<storage, read> cst: array<f32>;

// ---------------------------------------------------------------------------
// Hash RNG — verbatim port of core/utils.js hashU32/hash01/rh.
// Math.imul == u32 wrapping multiply bit-for-bit; the finalizer is
// lowbias32 (Wellons 2018). Exact u32 match with the CPU is asserted by
// the oracle's hashSelfTest.
// ---------------------------------------------------------------------------

fn hashU32(streamId: u32, salt: u32, index: u32) -> u32 {
  var h = U.seed ^ (streamId * 0x9E3779B1u) ^ (salt * 0x85EBCA77u) ^ (index * 0xC2B2AE3Du);
  h = (h ^ (h >> 16u)) * 0x21F0AAADu;
  h = (h ^ (h >> 15u)) * 0x735A2D97u;
  return h ^ (h >> 15u);
}

// CPU computes h * 2^-32 in f64; here f32(h) rounds h to 24 bits first —
// bounded by ~2^-25 absolute, part of the float-drift tolerance budget.
fn hash01(streamId: u32, salt: u32, index: u32) -> f32 {
  return f32(hashU32(streamId, salt, index)) * 2.3283064365386963e-10;
}

fn rh(streamId: u32, salt: u32, index: u32, minV: f32, maxV: f32) -> f32 {
  return minV + hash01(streamId, salt, index) * (maxV - minV);
}

// ---------------------------------------------------------------------------
// Trig LUT — port of core/utils.js angleToIdx + cossin. All decisions are
// integer; table values are the uploaded Float32Array entries, so results
// are bit-identical except when f32 angle drift crosses a 0.25-degree
// quantization boundary (bounded: one LUT step = 0.25 deg).
// ---------------------------------------------------------------------------

fn angleToIdx(angle: f32) -> u32 {
  var a = angle;
  if (a < 0.0) {
    if (a >= -360.0) {
      return min(u32((a + 360.0) * 4.0), 1439u);
    }
    a = a % 360.0;
    if (a < 0.0) { a = a + 360.0; }
    return min(u32(a * 4.0), 1439u);
  }
  if (a < 360.0) { return min(u32(a * 4.0), 1439u); }
  if (a < 720.0) { return min(u32((a - 360.0) * 4.0), 1439u); }
  if (a < 1080.0) { return min(u32((a - 720.0) * 4.0), 1439u); }
  a = a % 360.0;
  if (a < 0.0) { a = a + 360.0; }
  return min(u32(a * 4.0), 1439u);
}

fn cossinDeg(angle: f32) -> vec2f {
  let idx = angleToIdx(angle);
  return vec2f(cst[COS_BASE + idx], cst[SIN_BASE + idx]);
}

// ---------------------------------------------------------------------------
// Poly buffer accessors
// ---------------------------------------------------------------------------

fn srcVert(i: u32) -> vec2f {
  let b = HDR_WORDS + 2u * i;
  return vec2f(bitcast<f32>(src[b]), bitcast<f32>(src[b + 1u]));
}
fn srcMod(i: u32) -> f32 { return bitcast<f32>(src[HDR_WORDS + 2u * U.cap + i]); }
fn srcDir(i: u32) -> u32 { return src[HDR_WORDS + 3u * U.cap + i]; }

fn writeDst(o: u32, v: vec2f, m: f32, d: u32) {
  if (o >= U.cap) { return; }
  let b = HDR_WORDS + 2u * o;
  dst[b] = bitcast<u32>(v.x);
  dst[b + 1u] = bitcast<u32>(v.y);
  dst[HDR_WORDS + 2u * U.cap + o] = bitcast<u32>(m);
  dst[HDR_WORDS + 3u * U.cap + o] = d;
}

// ---------------------------------------------------------------------------
// Exact f64 floor((1-f) * N) — see header. mant = gMantHi:gMantLo (<= 2^53),
// N <= 2^16, so the product fits 96 bits (3 u32 limbs). Replicates IEEE-754
// round-to-nearest-even at 53 significant bits, then floors — bit-identical
// to JS \`~~((1 - f) * totalN)\` for the domain used here (g in (0, 1], N > 0).
// ---------------------------------------------------------------------------

fn mulWide(a: u32, b: u32) -> vec2u { // (lo, hi) — WGSL has no mul_hi
  let aL = a & 0xFFFFu; let aH = a >> 16u;
  let bL = b & 0xFFFFu; let bH = b >> 16u;
  let ll = aL * bL;
  let lh = aL * bH;
  let hl = aH * bL;
  let mid = lh + hl;
  let midC = select(0u, 0x10000u, mid < lh);
  let lo = ll + (mid << 16u);
  let loC = select(0u, 1u, lo < ll);
  let hi = (aH * bH) + (mid >> 16u) + midC + loC;
  return vec2u(lo, hi);
}

fn shr96(p: vec3u, k: u32) -> vec3u { // logical shift right of (p0,p1,p2) by k
  if (k == 0u) { return p; }
  if (k >= 96u) { return vec3u(0u); }
  if (k >= 64u) { return vec3u(p.z >> (k - 64u), 0u, 0u); }
  if (k >= 32u) {
    let t = k - 32u;
    if (t == 0u) { return vec3u(p.y, p.z, 0u); }
    return vec3u((p.y >> t) | (p.z << (32u - t)), p.z >> t, 0u);
  }
  return vec3u(
    (p.x >> k) | (p.y << (32u - k)),
    (p.y >> k) | (p.z << (32u - k)),
    p.z >> k,
  );
}

fn f64FloorMulN(n: u32) -> u32 {
  if (U.gShift == 0u || n == 0u) { return 0u; }
  // P = mant * n, 96-bit
  let a = mulWide(U.gMantLo, n);
  let b = mulWide(U.gMantHi, n);
  var p0 = a.x;
  var p1 = a.y + b.x;
  let c1 = select(0u, 1u, p1 < a.y);
  var p2 = b.y + c1;

  // bit length
  var bl: u32;
  if (p2 != 0u) { bl = 96u - countLeadingZeros(p2); }
  else if (p1 != 0u) { bl = 64u - countLeadingZeros(p1); }
  else { bl = 32u - countLeadingZeros(p0); }

  var r = vec3u(p0, p1, p2);
  var effShift = U.gShift;
  if (bl > 53u) {
    let t = bl - 53u; // <= 13 for mant <= 2^53, n <= 2^16 → t < 32
    let roundBit = (p0 >> (t - 1u)) & 1u;
    var sticky = 0u;
    if (t >= 2u) {
      sticky = select(0u, 1u, (p0 & ((1u << (t - 1u)) - 1u)) != 0u);
    }
    r = shr96(vec3u(p0, p1, p2), t);
    if (roundBit == 1u && (sticky == 1u || (r.x & 1u) == 1u)) {
      r.x = r.x + 1u;
      if (r.x == 0u) {
        r.y = r.y + 1u;
        if (r.y == 0u) { r.z = r.z + 1u; }
      }
    }
    effShift = U.gShift - t; // gShift >= 53 for g in (0,1], t <= 13 → positive
  }
  return shr96(r, effShift).x;
}

// Exact Math.ceil(idx / GROW_CAP) via the JS-precomputed step table:
// T[s] = largest integer idx whose JS expression yields <= s. Exact by
// construction (grow.js builds it with the replaced expression itself).
fn capStep(idx: u32) -> u32 {
  if (idx <= U.floorCap) { return 1u; } // JS: \`len * 2 > GROW_CAP\` gate
  for (var s = 1u; s <= STEP_TABLE_LEN; s = s + 1u) {
    if (idx <= bitcast<u32>(cst[STEP_TABLE_BASE + (s - 1u)])) { return s; }
  }
  return STEP_TABLE_LEN; // unreachable when the JS-side table assert holds
}

// ---------------------------------------------------------------------------
// Trimmed-polygon accessors — fill.js trim() without materializing.
// Mapping: k < s → source k; s <= k < s+nInsert → bridge vertex k-s;
// else → source k + nTrim - nInsert.
// ---------------------------------------------------------------------------

fn trimmedV(k: u32) -> vec2f {
  if (P.doTrim == 0u || k < P.s) { return srcVert(k); }
  if (k < P.s + P.nInsert) {
    let kk = k - P.s;
    let t = f32(kk + 1u) / f32(P.nInsert + 1u);
    return vec2f(
      P.eStartX + P.evx * t + rh(STREAM_TRIM_JIT_X, P.trimSalt, kk, -P.jitterAmt, P.jitterAmt),
      P.eStartY + P.evy * t + rh(STREAM_TRIM_JIT_Y, P.trimSalt, kk, -P.jitterAmt, P.jitterAmt),
    );
  }
  return srcVert(k + P.nTrim - P.nInsert);
}

fn trimmedM(k: u32) -> f32 {
  if (P.doTrim == 0u || k < P.s) { return srcMod(k); }
  if (k < P.s + P.nInsert) {
    return rh(STREAM_TRIM_MOD, P.trimSalt, k - P.s, 0.3, 0.5);
  }
  return srcMod(k + P.nTrim - P.nInsert);
}

fn trimmedD(k: u32) -> u32 {
  if (P.doTrim == 0u || k < P.s) { return srcDir(k); }
  if (k < P.s + P.nInsert) { return P.dirBase; }
  return srcDir(k + P.nTrim - P.nInsert);
}

// ---------------------------------------------------------------------------
// prepare — single thread; all sequential scalar decisions of one grow().
// ---------------------------------------------------------------------------

@compute @workgroup_size(1)
fn prepare() {
  let totalN = src[HDR_COUNT];
  let f = U.f;
  var op = opState.op;

  // fill.js trim(): fast path when f >= 1 || f < 0 || v.length <= 8 —
  // no salt is consumed (nextOpSalt sits after the early return).
  var doTrim = 0u;
  if (!(f >= 1.0 || f < 0.0 || totalN <= 8u)) { doTrim = 1u; }

  var trimSalt = 0u;
  if (doTrim == 1u) {
    trimSalt = U.saltBase + op;
    op = op + 1u;
  }
  let growSalt = U.saltBase + op;
  op = op + 1u;
  opState.op = op;

  var s = 0u;
  var nTrim = 0u;
  var nInsert = 0u;
  var lenT = totalN;
  var jitterAmt = 0.0;
  var eS = vec2f(0.0);
  var ev = vec2f(0.0);
  var dirBase = 0u;

  if (doTrim == 1u) {
    nTrim = f64FloorMulN(totalN);          // ~~((1 - f) * totalN), f64-exact
    s = (totalN - nTrim) / 2u;             // ~~(totalN/2 - nTrim/2): halves are
                                           // exact in fp, so == integer form
    let trimEnd = s + nTrim;
    eS = srcVert((s + totalN - 1u) % totalN);
    let eE = srcVert(trimEnd % totalN);
    ev = eE - eS;
    let edgeLen = length(ev);

    var sampleIdx = 0u;
    if (s >= 2u) {
      sampleIdx = u32(rh(STREAM_TRIM_SAMPLE, trimSalt, 0u, 0.0, f32(s - 1u)));
    } else if (trimEnd < totalN - 1u) {
      sampleIdx = trimEnd;
    }
    let sa = srcVert(sampleIdx);
    let sb = srcVert((sampleIdx + 1u) % totalN);
    let typicalSpacing = max(1.0, length(sb - sa));
    // f32 ceil vs f64: accepted risk — continuous geometric ratio, no
    // integer attractor (see FORK notes / oracle report).
    nInsert = max(2u, u32(ceil(edgeLen / typicalSpacing * 0.05)));
    lenT = totalN - nTrim + nInsert;
    jitterAmt = edgeLen * 0.06;
    dirBase = srcDir(s % totalN);
  }

  // Drawn unconditionally on CPU only when f === 999; hash draws have no
  // side effects, so computing it always is safe and branchless.
  let mod999 = rh(STREAM_GROW_MOD999, growSalt, 0u, 0.6, 0.8);

  let preStep = capStep(lenT * 2u);
  var skipInserted = 0u;
  if (preStep >= 2u && (preStep & 1u) == 0u) { skipInserted = 1u; }

  var idx = lenT * 2u;
  var stepK = preStep;
  var outCount: u32;
  if (skipInserted == 1u) {
    idx = lenT;
    stepK = 1u;
    outCount = lenT;
  } else {
    outCount = (idx + stepK - 1u) / stepK; // Math.ceil(idx / step), integers
  }
  outCount = min(outCount, U.cap);

  P.doTrim = doTrim;
  P.skipInserted = skipInserted;
  P.stepK = stepK;
  P.idx = idx;
  P.lenT = lenT;
  P.totalN = totalN;
  P.s = s;
  P.nTrim = nTrim;
  P.nInsert = nInsert;
  P.trimSalt = trimSalt;
  P.growSalt = growSalt;
  P.dirBase = dirBase;
  P.jitterAmt = jitterAmt;
  P.eStartX = eS.x;
  P.eStartY = eS.y;
  P.evx = ev.x;
  P.evy = ev.y;
  P.mod999 = mod999;
  P.outCount = outCount;

  // dst header + embedded drawIndirect (fan-expanded vertex count for a
  // storage-pulled triangle-list fan: tri t, corner c → poly index
  // (c == 0 ? 0 : t + c); vertexCount = 3 * (count - 2)).
  dst[HDR_COUNT] = outCount;
  dst[HDR_MID_X] = src[HDR_MID_X];
  dst[HDR_MID_X + 1u] = src[HDR_MID_X + 1u];
  dst[HDR_MID_X + 2u] = src[HDR_MID_X + 2u];
  dst[HDR_MID_X + 3u] = src[HDR_MID_X + 3u];
  var fan = 0u;
  if (outCount >= 3u) { fan = 3u * (outCount - 2u); }
  dst[HDR_INDIRECT] = fan;
  dst[HDR_INDIRECT + 1u] = 1u;
  dst[HDR_INDIRECT + 2u] = 0u;
  dst[HDR_INDIRECT + 3u] = 0u;
}

// ---------------------------------------------------------------------------
// exec — one thread per pre-cap output index j (fill.js grow() main loop).
// ---------------------------------------------------------------------------

@compute @workgroup_size(64)
fn exec(@builtin(global_invocation_id) gid: vec3u) {
  let j = gid.x;

  if (P.skipInserted == 1u) {
    // Fast path: GROW_CAP with an even step discards every inserted vertex
    // — result is exactly the trimmed polygon.
    if (j >= P.lenT) { return; }
    writeDst(j, trimmedV(j), trimmedM(j), trimmedD(j));
    return;
  }

  if (j >= P.idx) { return; }
  if (j % P.stepK != 0u) { return; }
  let o = j / P.stepK;
  let i = j >> 1u;

  if ((j & 1u) == 0u) {
    // Kept vertex: v = tr_v[i], mod = mi, dir = di (both CPU branches).
    writeDst(o, trimmedV(i), trimmedM(i), trimmedD(i));
    return;
  }

  // Inserted vertex between tr_v[i] and its wrap-around successor.
  let cv = trimmedV(i);
  var ni = i + 1u;
  if (ni >= P.lenT) { ni = 0u; }
  let nv = trimmedV(ni);
  let mi = trimmedM(i);
  let di = trimmedD(i);

  // CPU: mod = f === 999 ? rh(GROW_MOD999,...) : bleed; if (f < 997) mod = mi
  var modv = U.bleed;
  if (U.f == 999.0) { modv = P.mod999; }
  else if (U.f < 997.0) { modv = mi; }

  if (modv < 0.05) {
    writeDst(o, (cv + nv) * 0.5, mi, di);
    return;
  }

  var rotBase = -U.bleedDirDeg;
  if (di != 0u) { rotBase = U.bleedDirDeg; }
  let rotDeg = rotBase + rh(STREAM_GROW_ROT, P.growSalt, i, -1.0, 1.0) * 5.0;
  let cs = cossinDeg(rotDeg);

  let side = nv - cv;
  let dir = vec2f(
    cs.x * side.x + cs.y * side.y,
    cs.x * side.y - cs.y * side.x,
  );

  let d = cst[hashU32(STREAM_GROW_DIST_POOL, P.growSalt, i) % POOL_LEN]
    * rh(STREAM_GROW_DIST_SCALE, P.growSalt, i, 0.65, 1.35) * modv;
  let nextMod = mi + cst[POOL_B_BASE + (hashU32(STREAM_GROW_MOD_POOL, P.growSalt, i) % POOL_LEN)];

  writeDst(o, cv + side * 0.5 + dir * d, nextMod, di);
}

// ---------------------------------------------------------------------------
// Oracle-only entry points (never dispatched in a frame path).
// ---------------------------------------------------------------------------

// Exact-u32 hash parity vs CPU hashU32 — the W2 hard gate.
@compute @workgroup_size(64)
fn hashSelfTest(@builtin(global_invocation_id) gid: vec3u) {
  let k = gid.x;
  if (k >= U.cap) { return; }
  let streamId = k % 53u;
  let salt = k * 2654435761u; // wraps — exercises u32 overflow parity
  let index = k * 7u + 3u;
  dst[HDR_WORDS + k] = hashU32(streamId, salt, index);
}

// Exact-integer parity for nTrim and the cap step (vs the JS expressions).
@compute @workgroup_size(64)
fn intSelfTest(@builtin(global_invocation_id) gid: vec3u) {
  let k = gid.x;
  if (k >= U.cap) { return; }
  dst[HDR_WORDS + k] = f64FloorMulN(k);
  dst[HDR_WORDS + U.cap + k] = capStep(k);
}
`;
export default GROW_WGSL;
