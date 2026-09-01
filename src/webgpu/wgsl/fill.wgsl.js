// =============================================================================
// stencil-fill WGSL (W2, batched in W4a)
//
// NOTE ON FILE NAMING: the plan places these shaders at
// src/webgpu/wgsl/fill*.wgsl. They live in a .wgsl.js module instead because
// (a) the test pages import src/ directly as ESM with no bundler (same as
// test/webgpu/oracle-w1a.js), and (b) rollup.config.js only has a loader for
// .frag/.vert (glslify) — adding a .wgsl loader is a shared-file edit that
// belongs to W3. Exported template literals are the zero-tooling equivalent.
//
// W4a batching: all polygons of a batch share ONE render pass. Per-draw
// parameters no longer arrive via a per-draw uniform bind group — they live
// in a storage array indexed by @builtin(instance_index), selected with the
// firstInstance argument of draw(). The cover pipeline stencil passOp is
// 'zero' (set on the pipeline, not here), which self-cleans the stencil
// inside the polygon's scissor so the next polygon needs no stencil clear.
//
// Two shader modules:
//
// FILL_WGSL — the stencil-based nonzero-winding polygon fill (plan gotcha #5):
//   vsFan    triangle-fan-via-vertex-pulling into the stencil buffer only.
//            Pipeline: stencilFront increment-wrap / stencilBack
//            decrement-wrap, compare always, color writeMask 0.
//            Winding cancels where the fan folds back, so a
//            self-intersecting polygon's overlap region ends nonzero
//            exactly like canvas2d's nonzero fill — and the covering pass
//            flattens coverage to ONCE (overlap is not double-composited).
//   vsTris   plain triangle-list vertex pulling for the stroke-expansion
//            border geometry (gotcha #6). Pipeline: increment-wrap on BOTH
//            faces — the border needs "any coverage counts once", not
//            winding (its quads+join geometry overlaps with arbitrary
//            winding).
//   fsNull   fragment stage for the stencil-only passes (writeMask 0 —
//            a fragmentless pipeline is not valid against a pass that has
//            a color attachment).
//   vsCover/fsCover  fullscreen triangle scissored to the polygon bbox,
//            stencil compare not-equal 0, writes premultiplied
//            source-over color once, zeroes the stencil it touched.
//
// ERASE_WGSL — instanced AA discs with the canvas2d destination-out blend
//   (gotcha #4 row 3: srcFactor zero / dstFactor one-minus-src-alpha).
//   Per-disc data is (x, y, radius, alpha); the disc range is selected via
//   firstInstance, same trick as the fill params.
//
// Both share the same coordinate convention: positions in mask-texture
// pixel space (y-down), viewport uniform = texture size in pixels.
// =============================================================================

export const FILL_WGSL = /* wgsl */ `
struct DrawParams {
  base: u32,     // first vertex of this polygon in the vertex arena
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  color: vec4f,  // straight-alpha rgba, used by the cover draw only
};

@group(0) @binding(0) var<uniform> vp: vec4f; // xy = mask size in pixels
@group(0) @binding(1) var<storage, read> verts: array<vec2f>;
@group(0) @binding(2) var<storage, read> params: array<DrawParams>;

fn toClip(p: vec2f) -> vec4f {
  let ndc = p / vp.xy * 2.0 - 1.0;
  return vec4f(ndc.x, -ndc.y, 0.0, 1.0); // pixel y-down -> clip y-up
}

// Triangle fan without a fan topology (WebGPU has none) and without an
// index buffer: triangle t = (0, t+1, t+2), pulled from the storage buffer.
// instance_index (via draw's firstInstance) selects this draw's params.
@vertex fn vsFan(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> @builtin(position) vec4f {
  let tri = vi / 3u;
  let corner = vi % 3u;
  let idx = select(tri + corner, 0u, corner == 0u);
  return toClip(verts[params[ii].base + idx]);
}

// Plain triangle list (border expansion geometry).
@vertex fn vsTris(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> @builtin(position) vec4f {
  return toClip(verts[params[ii].base + vi]);
}

// Stencil-only draws still need a fragment stage; color writeMask is 0.
@fragment fn fsNull() -> @location(0) vec4f {
  return vec4f(0.0);
}

struct CoverOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) color: vec4f,
};

// Fullscreen cover triangle; the pass scissors it to the polygon bbox.
@vertex fn vsCover(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> CoverOut {
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var out: CoverOut;
  out.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  out.color = params[ii].color;
  return out;
}

// Premultiplied output; pipeline blend is source-over
// (one, one-minus-src-alpha) to match canvas2d fill()/stroke() semantics.
@fragment fn fsCover(in: CoverOut) -> @location(0) vec4f {
  return vec4f(in.color.rgb * in.color.a, in.color.a);
}
`;

// =============================================================================
// POLY_WGSL (W5) — the same three stages, but pulling vertices straight out
// of a grow-compute poly buffer instead of a CPU-uploaded arena.
//
// Nothing about the fill geometry touches the CPU on this path: vertex counts
// arrive via drawIndirect args the compute shader wrote into the poly header,
// the affine fill matrix is applied in the vertex stage, and the cover quad is
// built from the GPU-computed vertex bbox in the header (a scissor rect cannot
// be indirect, so the cover geometry carries the bound instead).
//
//   vsFanPoly     nonzero-winding fan, drawIndirect(poly, 32)
//   vsBorderPoly  border expansion (gotcha #6) — a FIXED 12 vertices per
//                 polygon vertex, drawIndirect(poly, 48). This is the CPU
//                 buildStrokeGeometry() port: 6 for the edge quad, 6 for the
//                 miter join. Variable-length CPU output (skipped degenerate
//                 edges, 3-vertex bevel fallback) becomes degenerate
//                 triangles here, so the vertex count stays a pure function
//                 of the vertex count — no compaction, no atomics.
//   vsCoverPoly   the bbox quad that replaces setScissorRect + fullscreen tri
// =============================================================================
export const POLY_WGSL = /* wgsl */ `
struct PolyParams {
  m: vec4f,      // affine a, b, c, d (user space -> target px)
  t: vec2f,      // affine e, f
  halfW: f32,    // border half width, target px
  boxPad: f32,   // cover-quad padding, target px
  color: vec4f,  // straight-alpha rgba (cover draw only)
};

const HDR_COUNT: u32 = 0u;
const HDR_BBOX: u32 = 16u;
const HDR_WORDS: u32 = 24u;
const MITER_LIMIT: f32 = 10.0;

@group(0) @binding(0) var<uniform> vp: vec4f; // xy = target size in pixels
@group(0) @binding(1) var<storage, read> poly: array<u32>;
// A dynamic-offset uniform, not an instance-indexed array: drawIndirect
// owns firstInstance (the compute shader writes it), so @builtin
// (instance_index) is unavailable for selecting a per-draw record.
@group(0) @binding(2) var<uniform> params: PolyParams;

fn xf(p: vec2f) -> vec2f {
  let q = params.m;
  return vec2f(q.x * p.x + q.z * p.y + params.t.x,
               q.y * p.x + q.w * p.y + params.t.y);
}

fn toClip(p: vec2f) -> vec4f {
  let ndc = p / vp.xy * 2.0 - 1.0;
  return vec4f(ndc.x, -ndc.y, 0.0, 1.0); // pixel y-down -> clip y-up
}

fn pv(i: u32) -> vec2f {
  let b = HDR_WORDS + 2u * i;
  return vec2f(bitcast<f32>(poly[b]), bitcast<f32>(poly[b + 1u]));
}

@vertex fn vsFanPoly(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let tri = vi / 3u;
  let corner = vi % 3u;
  let idx = select(tri + corner, 0u, corner == 0u);
  return toClip(xf(pv(idx)));
}

// Border expansion. Positions are transformed to target px FIRST (the CPU
// path expands post-transform too), so halfW is a plain pixel radius.
@vertex fn vsBorderPoly(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let n = poly[HDR_COUNT];
  let i = vi / 12u;
  let k = vi % 12u;
  let halfW = params.halfW;
  let v = xf(pv(i));

  if (k < 6u) {
    // Edge quad for edge i -> i+1.
    var j = i + 1u;
    if (j >= n) { j = 0u; }
    let w = xf(pv(j));
    let d = w - v;
    let len = sqrt(d.x * d.x + d.y * d.y);
    if (len <= 1e-6) { return toClip(v); } // degenerate, matches CPU skip
    let nrm = vec2f(-d.y / len, d.x / len) * halfW;
    var p: vec2f;
    switch (k) {
      case 0u: { p = v + nrm; }
      case 1u: { p = w + nrm; }
      case 2u: { p = v - nrm; }
      case 3u: { p = w + nrm; }
      case 4u: { p = w - nrm; }
      default: { p = v - nrm; }
    }
    return toClip(p);
  }

  // Join at vertex i, between edge (i-1 -> i) and edge (i -> i+1).
  var prev = i;
  if (i == 0u) { prev = n - 1u; } else { prev = i - 1u; }
  var next = i + 1u;
  if (next >= n) { next = 0u; }
  let a0 = xf(pv(prev));
  let a2 = xf(pv(next));
  let e0 = v - a0;
  let e1 = a2 - v;
  let l0 = sqrt(e0.x * e0.x + e0.y * e0.y);
  let l1 = sqrt(e1.x * e1.x + e1.y * e1.y);
  if (l0 <= 1e-6 || l1 <= 1e-6) { return toClip(v); }
  let d0 = e0 / l0;
  let d1 = e1 / l1;
  let cross = d0.x * d1.y - d0.y * d1.x;
  if (abs(cross) < 1e-9) { return toClip(v); } // collinear / 180-degree cusp
  var sigma = 1.0;
  if (cross > 0.0) { sigma = -1.0; }
  let n0 = vec2f(-d0.y * sigma, d0.x * sigma);
  let n1 = vec2f(-d1.y * sigma, d1.x * sigma);
  let pa = v + n0 * halfW;
  let pb = v + n1 * halfW;
  var mm = n0 + n1;
  let mlen = sqrt(mm.x * mm.x + mm.y * mm.y);
  if (mlen < 1e-9) { return toClip(v); }
  mm = mm / mlen;
  let denom = dot(mm, n0); // cos(half turn angle)
  let kk = k - 6u;
  if (denom >= 1.0 / MITER_LIMIT) {
    let tip = v + mm * halfW / denom;
    var p: vec2f;
    switch (kk) {
      case 0u: { p = v; }
      case 1u: { p = pa; }
      case 2u: { p = tip; }
      case 3u: { p = v; }
      case 4u: { p = tip; }
      default: { p = pb; }
    }
    return toClip(p);
  }
  // Bevel fallback: 3 real vertices, the other 3 collapse to a degenerate.
  if (kk >= 3u) { return toClip(v); }
  var p: vec2f;
  switch (kk) {
    case 0u: { p = v; }
    case 1u: { p = pa; }
    default: { p = pb; }
  }
  return toClip(p);
}

struct CoverOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) color: vec4f,
};

// Cover quad from the GPU-computed vertex bbox (header words 16..19),
// transformed by the same affine and padded. Replaces
// setScissorRect(bbox) + fullscreen triangle, which would need a CPU-side
// bbox and therefore a readback.
@vertex fn vsCoverPoly(@builtin(vertex_index) vi: u32) -> CoverOut {
  let lo = vec2f(bitcast<f32>(poly[HDR_BBOX]), bitcast<f32>(poly[HDR_BBOX + 1u]));
  let hi = vec2f(bitcast<f32>(poly[HDR_BBOX + 2u]), bitcast<f32>(poly[HDR_BBOX + 3u]));
  // Affine: the transformed bbox is the bbox of the transformed corners.
  let c0 = xf(lo);
  let c1 = xf(vec2f(hi.x, lo.y));
  let c2 = xf(hi);
  let c3 = xf(vec2f(lo.x, hi.y));
  let pad = params.boxPad;
  // Snap to whole pixels. The quad replaces a SCISSOR, which always clips on
  // pixel boundaries; a fractional edge under MSAA would give the boundary
  // pixels partial coverage, so the cover would both under-apply its colour
  // there AND fail to zero every stencil sample it consumed — stencil that
  // then leaks into the next polygon, ~90 layers deep.
  var mn = floor(min(min(c0, c1), min(c2, c3)) - pad);
  var mx = ceil(max(max(c0, c1), max(c2, c3)) + pad);
  mn = max(mn, vec2f(0.0));
  mx = min(mx, vp.xy);
  // Two triangles: 0,1,2 / 0,2,3 over (mn.x,mn.y) (mx.x,mn.y) (mx.x,mx.y) (mn.x,mx.y)
  var idx = vi;
  if (vi == 3u) { idx = 0u; } else if (vi == 4u) { idx = 2u; } else if (vi == 5u) { idx = 3u; }
  var p = mn;
  if (idx == 1u) { p = vec2f(mx.x, mn.y); }
  else if (idx == 2u) { p = mx; }
  else if (idx == 3u) { p = vec2f(mn.x, mx.y); }
  var out: CoverOut;
  out.pos = toClip(p);
  out.color = params.color;
  return out;
}

@fragment fn fsNullPoly() -> @location(0) vec4f {
  return vec4f(0.0);
}

@fragment fn fsCoverPoly(in: CoverOut) -> @location(0) vec4f {
  return vec4f(in.color.rgb * in.color.a, in.color.a);
}
`;

// GPU-resident erase discs: circle centres/radii come from the compute
// shader's arena, the instance count from drawIndirect args the same shader
// wrote. Identical maths to ERASE_WGSL, plus the affine transform.
export const ERASE_POLY_WGSL = /* wgsl */ `
struct EraseParams {
  m: vec4f,     // affine a, b, c, d
  t: vec2f,     // affine e, f
  scale: f32,   // matrix scale, applied to the radius
  alpha: f32,
  base: u32,    // first slot of this erase in the circle arena
};

@group(0) @binding(0) var<uniform> vp: vec4f;   // xy = target size in pixels
@group(0) @binding(1) var<storage, read> circles: array<vec4f>; // x, y, r, -
@group(0) @binding(2) var<uniform> pr: EraseParams;

struct DiscOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) radius: f32,
  @location(2) @interpolate(flat) alpha: f32,
};

// WebGPU pins drawIndirect's firstInstance to 0 unless the optional
// 'indirect-first-instance' feature is present, so the arena base cannot ride
// in the indirect args: it travels in the per-draw uniform instead, and
// @builtin(instance_index) is the offset within this erase.
@vertex fn vsEraseGpu(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> DiscOut {
  let c = circles[pr.base + ii];
  let ctr = vec2f(pr.m.x * c.x + pr.m.z * c.y + pr.t.x,
                  pr.m.y * c.x + pr.m.w * c.y + pr.t.y);
  let radius = c.z * pr.scale;
  let ext = radius + 1.0;
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  var out: DiscOut;
  out.local = corner * ext;
  out.radius = radius;
  out.alpha = pr.alpha;
  let p = ctr + out.local;
  let ndc = p / vp.xy * 2.0 - 1.0;
  out.pos = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
  return out;
}

@fragment fn fsEraseGpu(in: DiscOut) -> @location(0) vec4f {
  let d = length(in.local);
  let aa = max(fwidth(d), 1e-4);
  let cov = 1.0 - smoothstep(in.radius - aa * 0.5, in.radius + aa * 0.5, d);
  return vec4f(0.0, 0.0, 0.0, cov * in.alpha);
}
`;

export const ERASE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> vp: vec4f; // xy = mask size in pixels
// x, y, radius, alpha — one vec4f per circle; firstInstance selects range
@group(0) @binding(1) var<storage, read> circles: array<vec4f>;

struct DiscOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f, // pixel offset from disc center
  @location(1) radius: f32,
  @location(2) @interpolate(flat) alpha: f32,
};

// 4-vertex triangle-strip quad per instance, 1px AA apron.
@vertex fn vsErase(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> DiscOut {
  let c = circles[ii];
  let ext = c.z + 1.0;
  let corner = vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
  var out: DiscOut;
  out.local = corner * ext;
  out.radius = c.z;
  out.alpha = c.w;
  let p = c.xy + out.local;
  let ndc = p / vp.xy * 2.0 - 1.0;
  out.pos = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
  return out;
}

// fwidth at top level — gotcha #2 does not apply here.
@fragment fn fsErase(in: DiscOut) -> @location(0) vec4f {
  let d = length(in.local);
  let aa = max(fwidth(d), 1e-4);
  let cov = 1.0 - smoothstep(in.radius - aa * 0.5, in.radius + aa * 0.5, d);
  // Blend is (zero, one-minus-src-alpha): only alpha matters.
  return vec4f(0.0, 0.0, 0.0, cov * in.alpha);
}
`;
