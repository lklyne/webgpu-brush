// WGSL ships as a string export so rollup bundles it like any module (no
// runtime fetch).
export const PREFIX_SCAN_WGSL = /* wgsl */ `
// =============================================================================
// Exclusive prefix scan over a u32 array (strokewalk-compute; shaped for
// reuse by a per-step walk layout and grow-compute style consumers).
//
// dst[i]  = sum(src[0..i))  for i in [0, n)
// dst[n]  = sum(src[0..n))  — the total, so dst needs n+1 slots. The total is
//           readable out-of-band (readback.js) or usable for drawIndirect.
//
// Determinism (plan gotcha #10): single-workgroup, barrier-ordered — the
// output is a pure function of the input, no atomics, no inter-workgroup
// ordering. One dispatch(1, 1, 1) handles arbitrary n by looping 256-element
// tiles with a carried running total (Hillis–Steele scan per tile in shared
// memory: 8 barrier rounds per tile). Cost is O(n / 256) sequential tile
// iterations — sub-millisecond for anything stroke-shaped (n ~ 1e4 strokes,
// or 1e6 steps for a per-step layout; upgrade to a multi-workgroup two-level scan only if
// profiling ever shows this on the critical path).
// =============================================================================

struct ScanParams {
  n: u32,
  groupCount: u32, // writeIndirect: number of raster groups (stroke ranges)
  pad1: u32,
  pad2: u32,
}

const TILE: u32 = 256u;

@group(0) @binding(0) var<uniform> params: ScanParams;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>; // n + 1 slots

var<workgroup> tile: array<u32, TILE>;

@compute @workgroup_size(TILE)
fn scanExclusive(@builtin(local_invocation_id) lid3: vec3u) {
  let lid = lid3.x;
  var carry = 0u; // every thread tracks the same carry (uniform value)
  let tiles = (params.n + TILE - 1u) / TILE;
  for (var t = 0u; t < tiles; t++) {
    let gi = t * TILE + lid;
    var v = 0u;
    if (gi < params.n) { v = src[gi]; }
    tile[lid] = v;
    workgroupBarrier();
    // Hillis–Steele inclusive scan in shared memory.
    for (var off = 1u; off < TILE; off = off << 1u) {
      var add = 0u;
      if (lid >= off) { add = tile[lid - off]; }
      workgroupBarrier();
      tile[lid] = tile[lid] + add;
      workgroupBarrier();
    }
    if (gi < params.n) { dst[gi] = carry + tile[lid] - v; } // inclusive -> exclusive
    carry += tile[TILE - 1u];
    workgroupBarrier(); // protect tile[] reads from the next iteration's writes
  }
  if (lid == 0u) { dst[params.n] = carry; }
}

// ---------------------------------------------------------------------------
// drawIndirect args from the scan — one 16-byte entry per raster GROUP
// (a contiguous stroke range [start, end)): {vertexCount 4 (triangle-strip
// quad), instanceCount = dst[end] - dst[start], firstVertex 0, firstInstance
// 0}. The raster vertex shader adds dst[start] itself (walkraster.wgsl), so
// no indirect-first-instance feature is needed and nothing is read back
// (gotcha #9): stamp counts never touch the CPU.
// ---------------------------------------------------------------------------

@group(0) @binding(3) var<storage, read_write> indirectArgs: array<u32>;
@group(0) @binding(4) var<storage, read> groups: array<vec2u>; // start, end

@compute @workgroup_size(64)
fn writeIndirect(@builtin(global_invocation_id) gid: vec3u) {
  let g = gid.x;
  if (g >= params.groupCount) { return; }
  let r = groups[g];
  indirectArgs[g * 4u + 0u] = 4u;
  indirectArgs[g * 4u + 1u] = dst[r.y] - dst[r.x];
  indirectArgs[g * 4u + 2u] = 0u;
  indirectArgs[g * 4u + 3u] = 0u;
}
`;
export default PREFIX_SCAN_WGSL;
