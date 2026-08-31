// W3: canonical WGSL source, unified to the .wgsl.js string-export convention
// (was prefix-scan.wgsl, fetched at runtime pre-W3). Bundled by rollup like any module.
export const PREFIX_SCAN_WGSL = /* wgsl */ `
// =============================================================================
// Exclusive prefix scan over a u32 array (W2 strokewalk-compute; designed for
// reuse by W4a's per-step restructure and grow-compute style consumers).
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
// or 1e6 steps for W4a; upgrade to a multi-workgroup two-level scan only if
// profiling ever shows this on the critical path).
// =============================================================================

struct ScanParams {
  n: u32,
  pad0: u32,
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
// W3: drawIndirect args from the scan total — {vertexCount 4 (triangle-strip
// quad), instanceCount = dst[n] = total stamps, firstVertex 0, firstInstance
// 0}. Lets the walker's stamp rasterization draw without any readback
// (gotcha #9): the instance count never touches the CPU.
// ---------------------------------------------------------------------------

@group(0) @binding(3) var<storage, read_write> indirectArgs: array<u32>;

@compute @workgroup_size(1)
fn writeIndirect() {
  indirectArgs[0] = 4u;
  indirectArgs[1] = dst[params.n];
  indirectArgs[2] = 0u;
  indirectArgs[3] = 0u;
}
`;
export default PREFIX_SCAN_WGSL;
