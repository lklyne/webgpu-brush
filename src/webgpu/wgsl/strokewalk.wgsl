// =============================================================================
// strokewalk-compute (W2) — the flow-field walk on the GPU.
//
// Two entry points over one shared function set:
//   countStamps — one thread per stroke; evaluates the exact number of stamps
//                 the stroke will emit (pressure sim + grain gate + spray
//                 iteration counts are all pure scalar math over
//                 (strokeId, step) — no positions needed).
//   walkStrokes — one thread per stroke; walks the flow field sequentially
//                 ALONG the stroke and writes stamps to offsets[stroke]+k.
//
// Output-buffer determinism (plan gotcha #10): there is NO atomic append
// anywhere. Stamp slots are a pure function of stroke index: an exclusive
// prefix scan over countStamps' output (prefix-scan.wgsl) yields per-stroke
// base offsets, and each stroke's thread writes its stamps in step order from
// its own base. Same seed -> same buffer bytes, every run.
//
// Hash RNG: bit-exact WGSL transcription of hashU32 in src/core/utils.js
// (multiply-xor combiner + lowbias32 finalizer, u32-only — Math.imul === u32
// multiply). Stream ids and salts reproduce the canonical STREAM map
// verbatim: stamp salt = (strokeId << 2) | phase, phase 0 = main loop,
// 1 = markerTip at stroke start, 2 = markerTip at stroke end; spray dots use
// index (stampIndex << 12) + dotIndex.
//
// f32 vs f64 (known, documented): hash01 (u32 -> unit float), pressure sim
// transcendentals (pow), and position accumulation run in f32 here but f64 on
// the CPU. Exact-match items: hashU32 outputs, trig LUT values (uploaded
// Float32Array), field values (upstream stores Float32Array), gauss-pool
// picks (u32 mod). Everything else is oracle-gated by tolerance
// (scripts/oracle-strokewalk.mjs).
//
// Sequential-seeded data (gaussian pool, trig LUT, flow field) arrives as
// buffers — never re-derived on the GPU.
// =============================================================================

// ---- STREAM ids (must match src/core/utils.js STREAM — never renumber) ----
const ST_STROKE_SETUP: u32 = 1u;
const ST_STROKE_ALPHA_NOISE: u32 = 2u;
const ST_SPRAY_GAUSS: u32 = 3u;
const ST_SPRAY_SW: u32 = 4u;
const ST_SPRAY_DOT_R: u32 = 5u;
const ST_SPRAY_DOT_X: u32 = 6u;
const ST_SPRAY_DOT_Y: u32 = 7u;
const ST_MARKER_VIB_X: u32 = 8u;
const ST_MARKER_VIB_Y: u32 = 9u;
const ST_MARKER_ALPHA: u32 = 10u;
const ST_DEFAULT_GATE: u32 = 15u;
const ST_DEFAULT_SCATTER: u32 = 16u;
const ST_DEFAULT_PERP: u32 = 17u;
const ST_DEFAULT_ALONG: u32 = 18u;
const ST_DEFAULT_SIZE: u32 = 19u;
const ST_DEFAULT_ALPHA: u32 = 20u;

const KIND_DEFAULT: u32 = 0u;
const KIND_MARKER: u32 = 1u;
const KIND_SPRAY: u32 = 2u;

const FLAG_MARKER_TIP: u32 = 1u;
const FLAG_FIELD_ACTIVE: u32 = 2u;
const FLAG_CUSTOM_PRESSURE: u32 = 4u;

const GAUSS_POOL_N: u32 = 512u;
const TRIG_N: u32 = 1440u; // 360 deg x 4 samples/deg, matches utils.js LUT

struct Env {
  seed: u32,
  strokeCount: u32,
  fieldCols: u32,
  fieldRows: u32,
  cw: f32,
  ch: f32,
  fieldRes: f32,
  fieldLeftX: f32,
  fieldTopY: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
}

// Packed by src/webgpu/strokewalk.js — keep field order in sync with
// F_* / U_* constants there. All members 4 bytes; stride 144.
struct Stroke {
  x0: f32,           // start x, canvas coords (user x + cw/2)
  y0: f32,
  dxc: f32,          // constant-direction step delta (field-less path):
  dyc: f32,          //   f32(stepSize * cossin(-dir)) precomputed in f64
  dir: f32,          // internal degrees (calcAngle / toDegrees output)
  dirCos: f32,       // LUT cos(dir) — dispersion axis (drawDefault)
  dirSin: f32,       // LUT sin(dir)
  stepSize: f32,     // spacing()
  len: f32,          // stroke length
  strokeWeight: f32, // State.stroke.weight
  pWeight: f32,      // brush param weight
  scatter: f32,
  sharpness: f32,
  grain: f32,
  alpha: f32,        // current.alpha (incl. per-stroke noise), CPU-baked
  wiggle: f32,       // State.field.wiggle at stroke time
  mx: f32,           // affine matrix translation (getAffineMatrix)
  my: f32,
  pmin: f32,         // pressure.min_max
  pmax: f32,
  cp: f32,           // STROKE_SETUP draws / variation draws, CPU-baked
  ct: f32,
  cs: f32,
  ck: f32,
  aa: f32,           // gaussian pressure: 0.5 + curve[0]*a  (peak factor)
  bb: f32,           // gaussian pressure: 1  - curve[1]*b   (width factor)
  ns: f32,           // custom (array) pressure: normalized start/mid/end
  nm: f32,
  ne: f32,
  phase1P: f32,      // markerTip(1) pressure — carries the upstream
                     // cross-stroke pressure-cache leak, CPU-baked
  totalSteps: u32,
  salt: u32,         // (strokeId << 2)
  kind: u32,
  flags: u32,
  pad0: u32,
  pad1: u32,
}

@group(0) @binding(0) var<uniform> env: Env;
@group(0) @binding(1) var<storage, read> strokes: array<Stroke>;
// count pass output
@group(0) @binding(2) var<storage, read_write> counts: array<u32>;
// walk pass inputs/outputs
@group(0) @binding(3) var<storage, read> trig: array<f32>;      // cos[0..1439] ++ sin[1440..2879]
@group(0) @binding(4) var<storage, read> gaussPool: array<f32>; // 512 entries
@group(0) @binding(5) var<storage, read> field: array<f32>;     // col-major: c*fieldRows + r
@group(0) @binding(6) var<storage, read> offsets: array<u32>;   // strokeCount+1, exclusive
@group(0) @binding(7) var<storage, read_write> stamps: array<vec4f>; // x, y, size, alpha

// ---------------------------------------------------------------------------
// Hash RNG — bit-exact vs utils.js hashU32 (verified by the oracle battery).
// ---------------------------------------------------------------------------
fn hashU32(stream: u32, salt: u32, index: u32) -> u32 {
  var h = env.seed ^ (stream * 0x9E3779B1u) ^ (salt * 0x85EBCA77u) ^ (index * 0xC2B2AE3Du);
  h = (h ^ (h >> 16u)) * 0x21F0AAADu;
  h = (h ^ (h >> 15u)) * 0x735A2D97u;
  return h ^ (h >> 15u);
}

fn hash01(stream: u32, salt: u32, index: u32) -> f32 {
  // CPU computes h * 2^-32 in f64; f32 here (double rounding <= 2^-24 rel).
  return f32(hashU32(stream, salt, index)) * 2.3283064365386963e-10;
}

fn rh(stream: u32, salt: u32, index: u32, lo: f32, hi: f32) -> f32 {
  return lo + hash01(stream, salt, index) * (hi - lo);
}

// ---------------------------------------------------------------------------
// Trig LUT — replicates utils.js angleToIdx (~~ = trunc; table uploaded).
// ---------------------------------------------------------------------------
fn angleToIdx(angleIn: f32) -> u32 {
  var angle = angleIn;
  if (angle < 0.0) {
    if (angle >= -360.0) { return min(u32((angle + 360.0) * 4.0), TRIG_N - 1u); }
    angle = angle % 360.0; // WGSL f32 % == JS %: e1 - e2*trunc(e1/e2)
    if (angle < 0.0) { angle += 360.0; }
    return min(u32(angle * 4.0), TRIG_N - 1u);
  }
  if (angle < 360.0) { return min(u32(angle * 4.0), TRIG_N - 1u); }
  if (angle < 720.0) { return min(u32((angle - 360.0) * 4.0), TRIG_N - 1u); }
  if (angle < 1080.0) { return min(u32((angle - 720.0) * 4.0), TRIG_N - 1u); }
  angle = angle % 360.0;
  if (angle < 0.0) { angle += 360.0; }
  return min(u32(angle * 4.0), TRIG_N - 1u);
}

fn lutCos(angle: f32) -> f32 { return trig[angleToIdx(angle)]; }
fn lutSin(angle: f32) -> f32 { return trig[TRIG_N + angleToIdx(angle)]; }

// JS Math.round (round half up) — WGSL round() is half-to-even, do not use it.
fn jsRound(v: f32) -> i32 { return i32(floor(v + 0.5)); }

// ---------------------------------------------------------------------------
// Pressure simulation — ports stroke.js simPressure()/gauss() verbatim.
// ---------------------------------------------------------------------------
fn simPressure(s: Stroke, plotted: f32) -> f32 {
  if ((s.flags & FLAG_CUSTOM_PRESSURE) != 0u) {
    let t = plotted / s.len;
    let tc = clamp(0.5 + (t - 0.5 + s.ct) * s.cs, 0.0, 1.0);
    var cv: f32;
    if (tc < 0.5) {
      cv = s.ns + (s.nm - s.ns) * tc * 2.0;
    } else {
      cv = s.nm + (s.ne - s.nm) * (tc - 0.5) * 2.0;
    }
    let r = cv + s.cp + s.ck * (t - 0.5);
    // map(r, 0, 1, min, max, true) — clamped, handles min > max
    let v = s.pmin + r * (s.pmax - s.pmin);
    return clamp(v, min(s.pmin, s.pmax), max(s.pmin, s.pmax));
  }
  // gauss(a = 0.5 + curve[0]*a, b = 1 - curve[1]*b, c = cp) — aa/bb prebaked
  let peakPos = s.aa * s.len;
  var halfWidth = s.bb * 0.8;
  if (plotted < peakPos) { halfWidth = s.bb * 1.2; }
  halfWidth = halfWidth * (s.len / 2.0);
  let v = 1.0 / (1.0 + pow(abs((plotted - peakPos) / halfWidth), 2.0 * s.cp));
  // map(v, 0, 1, min, max) — unclamped
  return s.pmin + v * (s.pmax - s.pmin);
}

// calculatePressure() cache cadence, closed form. draw() resets the cache
// (pressureCount = 10, cachedPressure = undefined) AFTER markerTip(1), so the
// main loop recomputes at i % 10 == 0 and holds the value for 10 steps.
// CPU accumulates plotted by repeated f64 addition; f32(i)*step here.
fn stepPressure(s: Stroke, i: u32) -> f32 {
  return simPressure(s, f32(i - (i % 10u)) * s.stepSize);
}

// markerTip(2) pressure: recompute iff the cache expired at loop end
// (n == 0 -> cachedPressure undefined; n % 10 == 0 -> pressureCount == 10),
// else the value cached at the last recompute step survives.
fn phase2Pressure(s: Stroke) -> f32 {
  let n = s.totalSteps;
  if (n == 0u || (n % 10u) == 0u) {
    return simPressure(s, f32(n) * s.stepSize);
  }
  return stepPressure(s, n - 1u);
}

// ---------------------------------------------------------------------------
// Movement — ports flowfield.js Position (non-plot paths).
// ---------------------------------------------------------------------------
fn inCanvas(pos: vec2f, s: Stroke) -> bool {
  let x = pos.x + s.mx;
  let y = pos.y + s.my;
  return x >= -0.5 * env.cw && x <= 1.5 * env.cw &&
         y >= -0.5 * env.ch && y <= 1.5 * env.ch;
}

fn inField(col: i32, row: i32) -> bool {
  return col >= 0 && row >= 0 && col < i32(env.fieldCols) && row < i32(env.fieldRows);
}

fn fieldColIdx(pos: vec2f, s: Stroke) -> i32 {
  return jsRound((pos.x + s.mx - env.fieldLeftX) / env.fieldRes);
}
fn fieldRowIdx(pos: vec2f, s: Stroke) -> i32 {
  return jsRound((pos.y + s.my - env.fieldTopY) / env.fieldRes);
}

// ---------------------------------------------------------------------------
// Stamp emitters — port drawDefault / drawMarker / drawSpray. Writes are
// clamped to the stroke's [offset, nextOffset) window so a count/walk f32
// disagreement can never corrupt a neighboring stroke's slots.
// ---------------------------------------------------------------------------
fn emit(out: ptr<function, u32>, outEnd: u32, v: vec4f) {
  if (*out < outEnd) {
    stamps[*out] = v;
    *out = *out + 1u;
  }
}

fn emitDefault(s: Stroke, pos: vec2f, p: f32, i: u32, out: ptr<function, u32>, outEnd: u32) {
  if (hash01(ST_DEFAULT_GATE, s.salt, i) >= s.grain * p) { return; }
  let g = gaussPool[hashU32(ST_DEFAULT_SCATTER, s.salt, i) % GAUSS_POOL_N];
  let vibration = s.strokeWeight * s.scatter *
    (s.sharpness + ((1.0 - s.sharpness) * g) / p);
  let perp = vibration * rh(ST_DEFAULT_PERP, s.salt, i, -1.0, 1.0);
  let along = 0.3 * vibration * rh(ST_DEFAULT_ALONG, s.salt, i, -1.0, 1.0);
  let dx = perp * s.dirSin + along * s.dirCos;
  let dy = perp * s.dirCos - along * s.dirSin;
  let diameter = p * p * s.pWeight *
    rh(ST_DEFAULT_SIZE, s.salt, i, 0.85, 1.15) * s.strokeWeight;
  let al = max(0.9, p) * s.alpha * rh(ST_DEFAULT_ALPHA, s.salt, i, 0.75, 1.1);
  emit(out, outEnd, vec4f(pos.x + dx, pos.y + dy, diameter, al));
}

fn emitMarker(s: Stroke, pos: vec2f, p: f32, idx: u32, phase: u32, alphaIn: f32,
              out: ptr<function, u32>, outEnd: u32) {
  let salt = s.salt | phase;
  let vibration = s.strokeWeight * s.scatter;
  let rx = vibration * rh(ST_MARKER_VIB_X, salt, idx, -1.0, 1.0);
  let ry = vibration * rh(ST_MARKER_VIB_Y, salt, idx, -1.0, 1.0);
  let al = alphaIn * max(0.8, p) * rh(ST_MARKER_ALPHA, salt, idx, 0.9, 1.1);
  emit(out, outEnd, vec4f(pos.x + rx, pos.y + ry, s.strokeWeight * s.pWeight * p, al));
}

fn sprayIterations(s: Stroke, p: f32) -> u32 {
  return u32(ceil(s.grain / p));
}

fn emitSpray(s: Stroke, pos: vec2f, p: f32, i: u32, out: ptr<function, u32>, outEnd: u32) {
  let g = gaussPool[hashU32(ST_SPRAY_GAUSS, s.salt, i) % GAUSS_POOL_N];
  let vibration = s.strokeWeight * s.scatter * p +
    (s.strokeWeight * g * s.scatter) / 3.0;
  let sw = s.pWeight * rh(ST_SPRAY_SW, s.salt, i, 0.9, 1.1);
  let iterations = sprayIterations(s, p);
  for (var j = 0u; j < iterations; j++) {
    let dotIdx = (i << 12u) + j;
    let r = rh(ST_SPRAY_DOT_R, s.salt, dotIdx, 0.9, 1.1);
    let rX = r * vibration * rh(ST_SPRAY_DOT_X, s.salt, dotIdx, -1.0, 1.0);
    let yf = rh(ST_SPRAY_DOT_Y, s.salt, dotIdx, -1.0, 1.0);
    let sq = sqrt((r * vibration) * (r * vibration) - rX * rX);
    emit(out, outEnd, vec4f(pos.x + rX, pos.y + yf * sq, sw, s.alpha));
  }
}

// ---------------------------------------------------------------------------
// Pass 1: exact per-stroke stamp counts. Pure (strokeId, step) scalar math —
// identical expressions to the walk pass, so f32 results agree bit-for-bit.
// ---------------------------------------------------------------------------
@compute @workgroup_size(64)
fn countStamps(@builtin(global_invocation_id) gid: vec3u) {
  let si = gid.x;
  if (si >= env.strokeCount) { return; }
  let s = strokes[si];
  var total = 0u;
  let markerPhases = (s.flags & FLAG_MARKER_TIP) != 0u && s.kind == KIND_MARKER;
  if (markerPhases) { total += 9u; } // markerTip(1): s = 1..9
  for (var i = 0u; i < s.totalSteps; i++) {
    if (s.kind == KIND_DEFAULT) {
      let p = stepPressure(s, i);
      if (hash01(ST_DEFAULT_GATE, s.salt, i) < s.grain * p) { total += 1u; }
    } else if (s.kind == KIND_MARKER) {
      total += 1u;
    } else {
      let p = stepPressure(s, i);
      total += sprayIterations(s, p);
    }
  }
  if (markerPhases) { total += 9u; } // markerTip(2)
  counts[si] = total;
}

// ---------------------------------------------------------------------------
// Pass 3: the walk. Sequential along the stroke, parallel across strokes.
// One thread per stroke — do NOT parallelize within a stroke (each step's
// position depends on the previous). Warp divergence across stroke lengths is
// the accepted W2 risk; the per-step restructure is W4a's call and would
// reuse the same count/scan machinery.
// ---------------------------------------------------------------------------
@compute @workgroup_size(64)
fn walkStrokes(@builtin(global_invocation_id) gid: vec3u) {
  let si = gid.x;
  if (si >= env.strokeCount) { return; }
  let s = strokes[si];
  var out = offsets[si];
  let outEnd = offsets[si + 1u];

  let markerTipOn = (s.flags & FLAG_MARKER_TIP) != 0u;
  let fieldActive = (s.flags & FLAG_FIELD_ACTIVE) != 0u;

  var pos = vec2f(s.x0, s.y0);

  // markerTip(1) — at the stroke start. phase1P carries the upstream
  // pressure-cache value (may leak from the previous stroke; CPU-baked).
  if (markerTipOn && s.kind == KIND_MARKER) {
    for (var st = 1u; st < 10u; st++) {
      emitMarker(s, pos, s.phase1P * f32(st) / 10.0, st, 1u, s.alpha * 8.0, &out, outEnd);
    }
  }

  // Main loop: tip(i) at the current position, THEN move (stroke.js draw()).
  if (fieldActive) {
    // Kahan-compensated f32 accumulation — the CPU accumulates in f64, and a
    // drifted position can cross a field-cell rounding boundary and fork the
    // whole remaining walk. Compensation keeps GPU summation error ~1 ulp.
    var comp = vec2f(0.0, 0.0);
    var col = fieldColIdx(pos, s);
    var row = fieldRowIdx(pos, s);
    for (var i = 0u; i < s.totalSteps; i++) {
      let p = stepPressure(s, i);
      if (s.kind == KIND_DEFAULT) {
        emitDefault(s, pos, p, i, &out, outEnd);
      } else if (s.kind == KIND_MARKER) {
        emitMarker(s, pos, p, i, 0u, s.alpha, &out, outEnd);
      } else {
        emitSpray(s, pos, p, i, &out, outEnd);
      }
      // Position.movePos: bounds-check first; frozen once out of the field.
      if (inField(col, row)) {
        let fv = field[u32(col) * env.fieldRows + u32(row)];
        let angle = fv * s.wiggle - s.dir;
        let idx = angleToIdx(angle);
        let d = vec2f(s.stepSize * trig[idx], s.stepSize * trig[TRIG_N + idx]);
        // Kahan add
        let y = d - comp;
        let t = pos + y;
        comp = (t - pos) - y;
        pos = t;
        col = fieldColIdx(pos, s);
        row = fieldRowIdx(pos, s);
      }
    }
  } else {
    // _moveConstant: fixed direction; frozen permanently once outside the
    // margin-expanded canvas. Closed form pos = x0 + k*d avoids f32
    // accumulation drift entirely.
    var k = 0u;
    for (var i = 0u; i < s.totalSteps; i++) {
      let p = stepPressure(s, i);
      if (s.kind == KIND_DEFAULT) {
        emitDefault(s, pos, p, i, &out, outEnd);
      } else if (s.kind == KIND_MARKER) {
        emitMarker(s, pos, p, i, 0u, s.alpha, &out, outEnd);
      } else {
        emitSpray(s, pos, p, i, &out, outEnd);
      }
      if (inCanvas(pos, s)) {
        k += 1u;
        pos = vec2f(s.x0 + f32(k) * s.dxc, s.y0 + f32(k) * s.dyc);
      }
    }
  }

  // markerTip(2) — at the final position.
  if (markerTipOn && s.kind == KIND_MARKER) {
    let p2 = phase2Pressure(s);
    for (var st = 1u; st < 10u; st++) {
      emitMarker(s, pos, p2 * f32(st) / 10.0, st, 2u, s.alpha * 8.0, &out, outEnd);
    }
  }
}
