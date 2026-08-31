// =============================================================================
// Walk-raster WGSL (W3)
//
// Rasterizes GPU-walked stamps (strokewalk-compute output) straight from
// their storage buffer: instanced antialiased discs via vertex pulling and
// drawIndirect — the stamp count never touches the CPU (gotcha #9).
//
// Stamps are vec4f(x, y, diameter, alpha255) in position-space LOGICAL
// units (user coords + canvas half-extents), pre-matrix — exactly what
// stroke.js hands gl_draw.circle(). The GPU-walk route is limited to
// pure-translation matrices (anything else takes the CPU walk), so the
// full snapshot transform collapses to: device = (xy + trans) * density.
//
// The disc math mirrors stamp.wgsl.js vs_disc/fs_disc exactly, including
// the GL 1px point-size clamp (h >= 0.5 device px).
// Blend: gotcha #4 row 1 (one-minus-dst-alpha, one) — set on the pipeline.
// =============================================================================

export const WALK_RASTER_WGSL = /* wgsl */ `
struct WalkRasterU {
  proj  : vec4f, // clip.xy = devicePx * proj.xy + proj.zw
  color : vec4f, // stroke rgb; a ignored
  trans : vec4f, // x: matrix tx, y: matrix ty (logical), z: density, w: pad
};

@group(0) @binding(0) var<uniform> u : WalkRasterU;
@group(0) @binding(1) var<storage, read> stamps : array<vec4f>;

struct VSOut {
  @builtin(position) clip : vec4f,
  @location(0) local : vec2f,
  @location(1) alpha : f32,
};

@vertex fn vs(
  @builtin(vertex_index) vi : u32,
  @builtin(instance_index) ii : u32,
) -> VSOut {
  let s = stamps[ii];
  let corner = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
  let dev = (s.xy + u.trans.xy) * u.trans.z;
  let hRaw = s.z * u.trans.z * 0.5;
  let h = max(hRaw, 0.5); // GL point-size floor
  var quadPos : vec2f;
  var local : vec2f;
  if (hRaw < 0.5) {
    // Same GL point-sprite pixel snap as stamp.wgsl.js vs_disc.
    let px = ceil(dev - 1.005); // same tie epsilon as stamp.wgsl.js
    quadPos = px + vec2f(f32(vi & 1u), f32(vi >> 1u));
    local = (quadPos - dev) / h;
  } else {
    quadPos = dev + corner * h;
    local = corner;
  }
  var out : VSOut;
  out.clip = vec4f(quadPos * u.proj.xy + u.proj.zw, 0.0, 1.0);
  out.local = local;
  out.alpha = s.w / 255.0;
  return out;
}

@fragment fn fs(in : VSOut) -> @location(0) vec4f {
  let f = length(in.local) * 0.5;
  let a = fwidth(f);
  let m = 1.0 - smoothstep(0.5 - a, 0.5 + a, f);
  if (m < 0.01) {
    discard;
  }
  return vec4f(u.color.rgb, in.alpha * m);
}
`;
export default WALK_RASTER_WGSL;
