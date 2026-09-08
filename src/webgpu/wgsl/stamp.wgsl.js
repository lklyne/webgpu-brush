// =============================================================================
// Stamp WGSL (stamp-pipeline)
//
// One instanced-quad shader replacing both upstream stamp paths
// (stroke/shader.{vert,frag} point sprites and stroke/image.{vert,frag}
// instanced quads). Plan gotcha #1: gl_PointSize does not exist in WebGPU,
// so circle stamps become quads too.
//
// Two variants in one module, sharing the uniform block and one
// per-instance vertex layout (see INSTANCE_LAYOUT in ../stamps.js):
//   vs_disc / fs_disc   — procedural antialiased disc (ignores `angle`)
//   vs_image / fs_image — rotated quad sampling a tip texture's alpha
//
// The disc fragment reproduces upstream's point-sprite fragment shader
// (test/reference/glsl/stamp-circle.frag) exactly:
//   f = distance from center in point-sprite units (0.5 at the rim),
//   a = fwidth(f) — top-level, so gotcha #2 (derivatives in non-uniform
//   control flow) does not bite here,
//   mask = 1 - smoothstep(0.5 - a, 0.5 + a, f), discard below 0.01.
//
// The image vertex reproduces stroke/image.vert's rotation math verbatim;
// uv = corner * 0.5 + 0.5 with the same orientation notes (validated
// against the GL path by test/webgpu/stamps.js, image-grid test).
//
// Coordinates: instance `pos` and `halfSize` are DEVICE pixels. u.proj is
// (scaleX, scaleY, offsetX, offsetY): clip.xy = px * proj.xy + proj.zw.
// With proj = (2/W, 2/H, -1, -1) this is upstream's framebufferProjMatrix
// (y=0 at NDC -1, i.e. GL orientation); negate proj.y / flip proj.w for
// image-convention row order (stamps.js setSize flipY option).
//
// Blend state lives on the pipeline, not here: gotcha #4 row 1
// (srcFactor one-minus-dst-alpha, dstFactor one) — see ../stamps.js.
//
// NOTE: this is a .wgsl.js wrapper rather than a raw .wgsl file so it is
// importable in the browser and node with zero bundler configuration —
// WGSL is exported as a template-literal string and bundled by rollup
// directly, like any other module.
// =============================================================================

export default /* wgsl */ `
struct StampUniforms {
  // clip.xy = devicePx * proj.xy + proj.zw
  proj  : vec4f,
  // stroke color; rgb used, a ignored (per-stamp alpha rides the instance)
  color : vec4f,
};

@group(0) @binding(0) var<uniform> u : StampUniforms;
// Image variant only — absent from the disc pipeline's auto layout because
// vs_disc/fs_disc never reference them.
@group(0) @binding(1) var tipTex  : texture_2d<f32>;
@group(0) @binding(2) var tipSamp : sampler;

struct VSOut {
  @builtin(position) clip : vec4f,
  // disc: quad-local coord in [-1, 1]; image: uv in [0, 1]
  @location(0) local : vec2f,
  @location(1) alpha : f32,
};

// Triangle-strip unit-quad corner for vertex_index 0..3:
// (-1,-1) (1,-1) (-1,1) (1,1) — same winding as upstream's QUAD_CORNERS.
fn cornerFor(vi : u32) -> vec2f {
  return vec2f(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
}

// ---------------------------------------------------------------------------
// Disc variant (replaces the point-sprite path)
// ---------------------------------------------------------------------------

@vertex fn vs_disc(
  @builtin(vertex_index) vi : u32,
  @location(0) pos      : vec2f,
  @location(1) halfSize : f32,   // radius, device px
  @location(2) angle    : f32,   // unused — shared layout with the image variant
  @location(3) alpha    : f32,
) -> VSOut {
  let corner = cornerFor(vi);
  // GL clamps gl_PointSize to a minimum of 1.0 (ALIASED_POINT_SIZE_RANGE
  // floor), so upstream's sub-pixel discs — pen/rotring/2H weights are
  // 0.15–0.3 px — still rasterize as 1px point sprites. A 0.3px quad would
  // mostly miss every fragment center instead. Replicate the clamp; the
  // 511 upper clamp is NOT replicated — quads are simply correct above it.
  //
  // For the CLAMPED case the quad is additionally SNAPPED to the one
  // pixel GL point rasterization covers (fragment centers inside the 1px
  // square centered on pos → the single pixel with index ceil(pos - 1)).
  // An unsnapped ±0.5 quad spreads coverage over up to 4 pixels, which
  // reads as visibly bolder thin strokes than the point-sprite goldens.
  let h = max(halfSize, 0.5);
  var quadPos : vec2f;
  var local : vec2f;
  if (halfSize < 0.5) {
    // Pixel whose center lies in [pos-0.5, pos+0.5) — GL point
    // rasterization — with a tiny tie epsilon: ANGLE-on-Metal resolves
    // exact-boundary centers (integer device coords, common for
    // axis-aligned strokes) to the LOWER pixel, observed against the
    // upstream GL reference render. Only positions within 0.005 px of a
    // boundary are affected.
    let px = ceil(pos - 1.005);
    quadPos = px + vec2f(f32(vi & 1u), f32(vi >> 1u)); // spans [px, px+1]
    local = (quadPos - pos) / h;
  } else {
    quadPos = pos + corner * h;
    local = corner;
  }
  var out : VSOut;
  out.clip = vec4f(quadPos * u.proj.xy + u.proj.zw, 0.0, 1.0);
  out.local = local;
  out.alpha = alpha;
  return out;
}

@fragment fn fs_disc(in : VSOut) -> @location(0) vec4f {
  // local in [-1,1] spans the same square a point sprite of size 2r covers,
  // so f = length(local) * 0.5 matches gl_PointCoord - 0.5 distance exactly.
  let f = length(in.local) * 0.5;
  let a = fwidth(f);
  let m = 1.0 - smoothstep(0.5 - a, 0.5 + a, f);
  if (m < 0.01) {
    discard;
  }
  return vec4f(u.color.rgb, in.alpha * m);
}

// ---------------------------------------------------------------------------
// Image variant (replaces stroke/image.{vert,frag})
// ---------------------------------------------------------------------------

@vertex fn vs_image(
  @builtin(vertex_index) vi : u32,
  @location(0) pos      : vec2f,
  @location(1) halfSize : f32,
  @location(2) angle    : f32,   // radians
  @location(3) alpha    : f32,
) -> VSOut {
  let corner = cornerFor(vi);
  let c = cos(angle);
  let s = sin(angle);
  let rotated = vec2f(
    c * corner.x - s * corner.y,
    s * corner.x + c * corner.y,
  );
  var out : VSOut;
  out.clip = vec4f((pos + rotated * halfSize) * u.proj.xy + u.proj.zw, 0.0, 1.0);
  out.local = corner * 0.5 + vec2f(0.5, 0.5);
  out.alpha = alpha;
  return out;
}

@fragment fn fs_image(in : VSOut) -> @location(0) vec4f {
  // Preprocessed tip: white RGB, ink density in alpha (imageToWhite).
  let ink = textureSample(tipTex, tipSamp, in.local).a;
  if (ink < 0.01) {
    discard;
  }
  return vec4f(u.color.rgb, ink * in.alpha);
}
`;
