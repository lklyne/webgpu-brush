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
