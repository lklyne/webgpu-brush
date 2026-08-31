# FORK.md — brush-gpu

Fork of [p5.brush](https://github.com/acamposuribe/p5.brush) (Alejandro Campos
Uribe, MIT) at upstream commit `fc37da3da3fa07e58edf880fb2788c5529a51ebe`
(v2.2.2), being ported to pure WebGPU + WGSL with GPU-resident geometry.
Plan: `docs/plans/p5-brush-pure-webgpu.md` in the host repo.

**The reference is upstream p5.brush installed from npm at the pinned version
(`p5.brush@2.2.2`, a devDependency here and in the host site), not code in this
fork.** It cannot drift, which frees this fork to replace or delete its
renderer outright. The split-screen parity harness always keeps upstream in
the left pane.

## Divergences from upstream

0. **W3 — WebGPU renderer.** The standalone build renders through pure
   WebGPU (no WebGL anywhere in the standalone path). Three API-visible
   consequences:
   - **`await brush.ready()` is required** after
     `createCanvas()`/`load()`, before the first drawing call. WebGPU
     device acquisition has no synchronous form; drawing before ready
     throws with a message pointing at `ready()`. Every harness/scenario
     in this repo awaits it (a `brush.ready` guard keeps them working
     against upstream, which has no such export).
   - **`brush.readPixels()`** (async, out-of-band) reads the painting
     texture back as RGBA — the supported way to capture output
     (canvas2d `drawImage()` of a WebGPU canvas is blank in some
     headless configurations; the parity harness uses `readPixels`).
   - **`brush.useCpuGeometry(bool)`** forces the retained CPU stroke
     walk (early W4b surface; the CPU path is a first-class producer).
   The p5 adapter (`adapters/p5/`) still references the old GL stroke
   path and is **broken at runtime** — per plan it is out of scope,
   untouched and untested; it still builds.

1. **W1b — counter-based hash RNG.** `rr()` (the internal sequential
   geometry stream) is gone; every internal random draw is
   `hash(seed, streamId, salt, index)`. **Upstream sketch reproduction is
   now broken: the same seed produces a different (equally plausible)
   image than upstream p5.brush.** This is a settled plan decision — the
   sequential stream cannot be reproduced by parallel GPU compute; a
   counter-based stream can. Run-to-run reproducibility per seed is fully
   preserved and asserted (`scripts/assert-structure.mjs --identity`).
   The user-facing `random()` / `wRand()` / `noise()` APIs still use their
   own seeded sequential generators, unchanged. See "W1b" below for the
   hash construction, stream list, and verification.

## W0 baseline timings

Median of 3 runs per scenario, first-frame timings reported by
`test/standalone/standalone_profiler.js`, driven headlessly by
`scripts/profile-baseline.mjs` (raw data: `test/parity/baseline-timings.json`).

Environment: headless Chromium 146 (Chrome for Testing) with
`--use-angle=swiftshader` — **software GL**, so absolute numbers are much
slower than a real GPU but stable and comparable. W4a must re-run under the
identical command and environment; the ≥10×/≥5× targets are ratios against
this table, not wall-clock goals.

Machine: Apple Silicon macOS 25.2.0, Node 22.17.1. Date: 2026-08-30.

| Scenario | total (ms) | draw JS (ms) | render (ms) |
|---|---:|---:|---:|
| visual_suite | 23552 | 23486 | 3 |
| hatch_test | 125 | — | — |
| fill_angle_test | 140 | 115 | 3 |
| angle_mode_test | 77 | — | — |
| wash_test | 58 | — | — |
| transform_test | 66 | — | — |
| pushpop_test | 76 | — | — |
| pastel_hatching_test | 396 | — | — |
| field_explorer | 72 | — | — |
| fill_circle_explorer | 1130 | — | — |

The visual_suite draw/render split confirms the plan's premise: ~23.5 s of
CPU JavaScript geometry against ~3 ms of GL submission. The cost is not the
rendering API.

## W0 self-test (harness proof)

`node scripts/diff-parity.mjs` with both panes on byte-identical bundles
(the npm dist and this fork's freshly built dist hash identically at W0),
54 tiles, seed `parity-0`:

- **43 of 54 tiles: RMSE exactly 0** across repeated runs — every stroke,
  field, hatch, and geometry tile is pixel-exact, including the image-tip
  brush tile (`brush-parity-image`, the stampImage path, deterministic
  inline SVG data-URI tip).
- **Fill/wash tiles: residual RMSE ≤ ~0.15/255, varying run-to-run.** The
  nonzero set is exactly the tiles that touch the canvas2d fill-mask path
  (`fill()`, `wash()`, hatch-with-fill, multi-color fill, alpha extremes,
  self-intersecting fill, tiny fill). Reproduces with a single module
  instance rendering both panes, identical seeds, byte-identical code — so
  it is Chromium canvas2d/texture-upload rasterization nondeterminism
  (±1 LSB at mask edges), not a seed, size, or harness fault.
  `--disable-accelerated-2d-canvas` + disabling SkiaGraphite cut it ~7×
  (mean 0.014 → 0.002); it was not fought to zero per the plan ("visual
  equivalence is the standard; byte-identity is a free signal, not a gate").
- Verdicts: 54/54 pass at the default 2.0 tolerance; worst tile ≈ 0.01–0.15
  depending on run.

Implication for later waves: pixel-exact 0 is only ever expectable on
non-fill tiles; fill-path comparisons bottom out around 0.15 RMSE noise.

## W1a — WebGPU device scaffold (additive, no src changes)

New files, zero runtime deps, plain JS + JSDoc matching the rest of `src/`:

- `src/webgpu/device.js` — `initDevice({canvas, width, height, density,
  onDeviceLost})` → `GpuContext`. Configures the canvas with
  `alphaMode: 'premultiplied'` (gotcha #7) and
  `RENDER_ATTACHMENT | COPY_SRC` usage; device-lost handler; `resize(w, h,
  density)`; tracked `createBuffer`/`createTexture` (live counters in
  `ctx.stats` — create GPU resources through the context, never
  `device.create*`, or leak assertions lie).
- `src/webgpu/pipeline.js` — `createPipelineCache(gpu)` with
  `getRenderPipeline` keyed on (module, blend, format, stencil, vertex
  layout, topology, cull, write mask), `getComputePipeline`, `getModule`
  (per WGSL source string), `getBindGroup` (identity-keyed — hold
  `getBindGroupLayout(0)` results, they're fresh wrappers per call);
  `cache.stats` instruments pipeline/bind-group counts (gotcha #8:
  asserted, not hoped). Plus `createUniformRing(gpu)` (256-byte slots,
  reallocate-only-when-exceeded) and `uploadTexture(gpu, source, opts)`.
- `src/webgpu/readback.js` — `readTexture` / `readBuffer`: staging buffer +
  `mapAsync`, strips 256-byte row padding. **Out-of-band only** (gotcha
  #9) — never call from a frame path.
- `test/webgpu/oracle-w1a.{html,js}` + `scripts/oracle-w1a.mjs` — the W1a
  oracle, rerunnable: `node scripts/oracle-w1a.mjs` (exit 0 iff all pass;
  report at `test/webgpu/oracle-w1a-report.json`).

W1a oracle results (headless Chrome for Testing, **real GPU** — adapter
`apple / metal-3`; software WebGPU is not available on this machine, so
unlike diff-parity the oracle runs with `--enable-unsafe-webgpu
--use-angle=metal` and no swiftshader):

1. premultiplied: WebGPU canvas vs upstream-configured WebGL2 canvas,
   uniform mask (a=0.6) × known color, both composited onto white —
   maxDiff **0**/255 (gate < 1.5), matches analytic expectation exactly.
2. dirty-rect: scissored corner draw — 0 of 245,760 outside pixels
   changed (byte-compared), 4096/4096 inside changed.
3. resize-leaks: 20 resize+render cycles (5 sizes × 2 densities) — no
   device loss, buffers 1→1, textures 0→0, bufferBytes 16384→16384,
   pipelines 1→1.
4. pipeline-stability: 60 frames × 3 blend configs — 3 pipelines and 3
   bind groups after warmup and at end, 177 cache hits each.

Stable across repeated runs.

## W1b — Hash RNG on the CPU, goldens frozen

### Hash construction and why

`src/core/utils.js`: `hashU32(streamId, salt, index)` =
multiply-xor combiner over `(seedU32, streamId·0x9E3779B1,
salt·0x85EBCA77, index·0xC2B2AE3D)` fed through the **lowbias32**
finalizer (Chris Wellons, "Prospecting for Hash Functions", 2018; bias
0.107). Derived helpers: `hash01`, `rh(stream, salt, index, min, max)`
(the `rr()` replacement) and `nh(...)` (Box-Muller gaussian on index
pairs `2i, 2i+1`).

Why this over the plan's other candidates: PCG needs 64-bit state and
multiplies (awkward in both JS and WGSL); plain composed `wang_hash`
needs more rounds for equivalent bias. lowbias32 is 5 `imul` + 6
xor/shift, u32-only, stateless — transcribes to WGSL verbatim.
Measured cost (Node 22, Apple Silicon): **4.8 ns/draw vs 8.1 ns/draw**
for the old Mulberry32 step (0.59×) — stateless beats stateful here, so
the "timing must be unchanged" gate is met with margin (table below).

`seed(s)` resets the seed word **and every scope counter** (via
`_onSeed`): stroke id, fill id/op, hatch id, gaussian pools.

### Stream map (W2 compute shaders must reproduce this verbatim)

`STREAM` in `src/core/utils.js` is the single source of truth — never
renumber, only append. Scope salts:

- **Strokes** (`src/stroke/stroke.js`): `_strokeId` increments per
  stroke; stamp salt = `(strokeId << 2) | phase` with phase 0 = main
  stamp loop, 1 = markerTip at stroke start, 2 = markerTip at stroke
  end. `index` = stamp loop counter (markerTip uses its own 1..9 / 1..4
  counter); spray dots use `(stampIndex << 12) + dotIndex`.
  Streams 1–20: STROKE_SETUP (slots 0..5 = a,b,cp,ct,cs,ck; slot 6 =
  legacy per-stroke seed), STROKE_ALPHA_NOISE, SPRAY_GAUSS, SPRAY_SW,
  SPRAY_DOT_R/X/Y, MARKER_VIB_X/Y, MARKER_ALPHA, TIP_VIB_X/Y, TIP_ROT,
  TIP_ALPHA, DEFAULT_GATE, DEFAULT_SCATTER, DEFAULT_PERP/ALONG/SIZE/ALPHA.
- **Fills** (`src/fill/fill.js`): `_fillId` increments per
  `createFill()`; every randomized FillPoly op (setup, constructor
  center, trim, grow, scatter, erase, darker) takes the next op salt
  `(fillId << 10) + opId` — op order is fixed control flow, so W2's
  grow-compute receives `(fillId, opId)` as a dispatch uniform and
  `index` = vertex/circle index. Streams 21–42: FILL_WR, FILL_MOD,
  FILL_SHIFT, FILL_CENTER_X/Y, FILL_DARKER, GROW_MOD999, GROW_ROT,
  GROW_DIST_POOL, GROW_DIST_SCALE, GROW_MOD_POOL, TRIM_SAMPLE,
  TRIM_JIT_X/Y, TRIM_MOD, SCATTER_PICK, SCATTER_PULL_X/Y, ERASE_COUNT,
  ERASE_X/Y (gaussian), ERASE_R.
- **Hatch** (`src/hatch/hatch.js`): `_hatchId` increments per
  `getHatchLines()`; `index` = segment j. Streams 43–47:
  HATCH_JIT_X1/Y1/X2/Y2, HATCH_WEIGHT.

Gaussian pools (stroke scatter pool, fill grow pools) are still filled by
the seeded *sequential* generator at seed time — they are plain data a
compute shader receives as a buffer; only the **pick** is hash-based
(`hashU32 % poolLen`). The stroke pool became fixed-size (512, was
lazily grown per stroke length), which is also where the
`pastel_hatching_test` speedup below comes from.

### Verification

- **Run-to-run identity** — `scripts/assert-structure.mjs --capture` ×3
  (54 tiles, seed `parity-0`): `geomHash` (FNV-1a over exact float64
  bits of all stamp/fill/erase geometry) identical across 3 consecutive
  runs: `3878505443`. Geometry is hashed, not fill-tile pixels, per the
  W0 note on the ~0.15 RMSE canvas2d noise floor. *Deviation: the plan
  asks for 2 machines; this was verified on one (Apple Silicon macOS,
  headless Chrome for Testing + swiftshader). Note the
  `brush-parity-image` tile rasterizes an SVG data-URI tip in-browser:
  same-machine goldens are exact, cross-machine AA may differ.*
- **Zero `rr()` call sites** — `grep -rn '\brr(' src/` matches only
  comments. `rr`/`randInt` no longer exist; internal `rArray`
  consumers were converted to hash picks.
- **Structural assertions vs pre-change output** —
  `scripts/assert-structure.mjs --compare test/goldens/structure-pre.json
  test/goldens/structure-post.json`: PASS. Stroke count exact per tile;
  per-stroke `steps` (tip() invocations) exact everywhere except
  hatch-rand/mass, whose stroke lengths are themselves random draws —
  there stroke count is exact and total steps land within 1.8%;
  grain-gated `drawn` totals within 1.8%; fill count and per-layer
  polygon counts exact; per-layer mean vertex counts within 25.1%
  (limit 40 — upstream's own seed-to-seed swing measures up to 56%);
  coverage within 2% of tile area for structural tiles. *Deviation from
  the plan's flat "coverage within 2%": thresholded coverage of
  watercolor-fill tiles swings up to 43× across upstream seeds
  (fill-basic: 34..1466 px over seeds parity-0..3), so those tiles are
  instead asserted against the measured upstream cross-seed envelope
  (`test/goldens/coverage-envelope.json`, padded ×0.5/×2).*
- **Goldens** — `test/goldens/`: `tiles/` (54 fork-output PNGs +
  `baseline.json`, frozen via `diff-parity --left /dist/brush.esm.js
  --baseline`), `structure-pre.json` / `structure-post.json`,
  `coverage-envelope.json`, `timings-w1b.json`.
  `test/parity/baseline/` keeps the W0 **upstream** reference tiles.
- **Character regime** — `diff-parity --regime character` vs upstream:
  mean RMSE 9.06, worst 90.5 (hatch-rand — decorrelated random line
  placement; visually same character). Fork-vs-fork self-test: worst
  0.037 RMSE. **Human call still owed:** whether the new wobble reads
  as p5.brush. Spot checks say yes for strokes/hatch/spray; `fill-basic`
  at seed `parity-0` renders a noticeably fainter wash than upstream's
  parity-0 render (within upstream's cross-seed envelope, but worth an
  eyeball at `test/goldens/tiles/fill-basic.png` vs
  `test/parity/baseline/fill-basic.png`).

### W1b timings (same command/environment as the W0 table)

Median of 3, `scripts/profile-baseline.mjs`, headless Chrome for
Testing + swiftshader, Apple Silicon, Node 22.17.1:

| Scenario | W0 total (ms) | W1b total (ms) | Δ |
|---|---:|---:|---:|
| visual_suite | 23552 | 23326 | −1.0% |
| hatch_test | 125 | 107 | −14% |
| fill_angle_test | 140 | 145 | +3.6% |
| angle_mode_test | 77 | 63 | −18% |
| wash_test | 58 | 54 | −8% |
| transform_test | 66 | 70 | +5% |
| pushpop_test | 76 | 67 | −12% |
| pastel_hatching_test | 396 | 143 | −64% |
| field_explorer | 72 | 56 | −22% |
| fill_circle_explorer | 1130 | 1121 | −0.8% |

No slowdown anywhere outside run noise; the pastel win is the fixed-size
gaussian pool (the old code pushed `gaussian()` per needed stamp on every
long stroke).

### Structural instrumentation

`src/core/stats.js` (`_stats` export; test-only, off by default — one
boolean check per hooked call when disabled). Hooks in `gl_draw.js`
(stamp counts + geometry hash), `stroke.js` (per-stroke steps/drawn),
`fill.js` (per-layer vertex counts, erase-circle hash). Browser half:
`test/parity/structure.html` + `structure.js` (also runs coverage-only
against uninstrumented modules, e.g. upstream).

## W3 — WebGPU adapter and integration

### Hook implementation (the contract, and nowhere else)

- **`core/compositor_runtime.js`** (6, via `setCompositorRuntime`, in
  `adapters/standalone/compositor.js` on the host in
  `adapters/standalone/gpu.js`):
  - `createFramebuffer` → `GPUTexture` wrapped in upstream's exact duck
    type (`__brushFramebuffer`, `framebuffer` (the texture — truthy
    handle slot), `colorTexture`, `view`, `width`, `height`, `density`,
    `pixelDensity()`, `remove()`).
  - `ensureBlendSourceFramebuffer` → persistent blend-source texture.
  - `blitSourceToFramebuffer` → `copyTextureToTexture` of the **dirty
    rect only** from the persistent painting texture (gotcha #3: the
    swapchain is never sampled; "current" is always the one painting
    texture — no ping-pong, dirty rects stay valid). Present =
    `copyTextureToTexture(painting → getCurrentTexture())` appended to
    each composite encoder (canvas usage gained COPY_DST in device.js).
  - `runBlendShaderPass` → fullscreen triangle with the W2 spectral WGSL
    (`packBlendUniforms` reflectance hoist), `setScissorRect` to the
    dirty rect, blend (one, one-minus-src-alpha).
  - `ensureBlendShaderProgram` → returns a marker object; the GLSL
    sources shared core still imports are ignored.
  - `clearTarget` → render-pass clear (framebuffer ducks) or the fill
    surface's ordered clear (fill mask).
- **`core/renderer_runtime.js`** (3): all three are **no-ops** in the
  WebGPU adapter — every render pass carries complete state. The hooks
  and their `gl_draw.js` call sites (including
  `resetDirectShaderTracking`) are kept: they are host-contract points
  the p5 adapter still implements meaningfully.
- **`core/target.js`** (8): `load` / `syncDensity` / `isCanvasReady` /
  `instance` / `activateInstance` / `deactivateInstance` (no-ops, as
  upstream standalone) / `isFramebufferTarget` (duck check).
  **`getActiveFramebuffer` returns `null` — the plan's open question is
  resolved by matching upstream**: the standalone build has no
  framebuffer targets, nothing in the scenarios or tiles ever needed
  one, and the adapter's composite throws loudly if the branch is ever
  reached.
- **`stroke/gl_draw.js` replaced outright** (no second backend). Kept:
  matrix snapshotting per stroke, flat-Float32Array queue packing with
  reallocate-only-when-exceeded growth (now inside `webgpu/stamps.js`),
  device-pixel dirty-rect accumulation, and the renderer-runtime hook
  call sites. Circles/image tips queue into the W2 stamp renderer
  (device px, alpha 0..1) and flush per stroke into `Renderer.glMask`.
- **Fill-mask canvas2d path deleted.** `fill/mask.js` is gone;
  `Mix.ctx` is now the **fill surface** (`fill/composite.js`): an
  explicit recorder (`layer` / `erase` / `washPolygon` / `clear` /
  `flush`) that transforms user-space geometry to device pixels and
  queues W2 stencil-fill passes on a pending encoder, flushed just
  before each composite samples the mask. `fill/fill.js` and
  `fill/wash.js` consume it; no `FillMaskUploadCanvas`, no
  `texSubImage2D`, no `Renderer.mask` canvas.

### Texture / orientation model

Everything is **image convention** (row 0 = top, y down): stamps render
with `flipY: true`, stencil-fill is natively y-down, the spectral
composite runs with UV-flip flags 0 (the GL-emulating flips the verbatim
port carried are now opt-in bits in `BlendUniforms.flags`). Scissor rects
are top-left device pixels end to end — no flips anywhere.

### GPU/CPU stroke routing split (strokewalk-compute)

`stroke/stroke.js` routes per stroke, by capability:

| GPU walk (strokewalk-compute) | Retained CPU walk |
|---|---|
| `line()` / `flowLine()` strokes | `plot()` strokes (splines, polygons, `beginStroke`, rect/circle/arc) |
| default / marker / spray tips | image and custom tips |
| gaussian or array-control-point pressure | function-curve custom pressure |
| pure-translation transform | rotated/scaled transforms |
| — | `Stats.enabled` capture runs, `useCpuGeometry(true)` |

The router (`tryGpuWalk`) replicates `saveState()`'s environment side
effects (lazy gaussian-pool fill order, `_strokeId` sequencing, blend
bookkeeping) and syncs the cross-stroke pressure-cache chain (upstream's
markerTip leak) through the descriptor builder, so CPU- and GPU-walked
strokes interleave without diverging from the all-CPU sequence.
Descriptors batch per (translation, stroke color); batches flush before
every CPU stamp flush, before every composite (via
`getStrokeShaderMask`), and before any walker environment change — stamp
order stays draw order (gotcha #10). Rasterization pulls stamps straight
from the walk's storage buffer via `drawIndirect` args written GPU-side
by a new `writeIndirect` entry in prefix-scan (no readback; `mapAsync`
appears only in `webgpu/readback.js`, verified by grep). The walker is
warmed up inside `brush.ready()` so fully-synchronous sketches route
from the first stroke.

**grow-compute is NOT in the default frame path.** Fills run CPU
`grow()` → GPU stencil raster. Reason: `FillPoly.fill()` interleaves
`scatter()` (and the erase/darker op-salt draws) with grow chains, and
`scatter()` needs actual vertices — GPU-resident grow would force a
mid-fill readback (gotcha #9) or a scatter compute port. The W3 enabling
refactors landed (`_getSeedU32` exported from utils.js and cross-checked
in grow.js; `fill.js` `_test` export with `FillPoly` + scope hooks), the
grow oracle stays green, and moving scatter GPU-side is W4a/W4b work.
`test/webgpu/grow-cpu-ref.js` still uses source-text extraction (it
fails loudly on drift); switching it to the `_test` export is follow-up.

### WGSL convention unified

All shaders are `.wgsl.js` string exports (bundled by rollup, no runtime
fetch): `spectral.wgsl.js`, `grow.wgsl.js`, `strokewalk.wgsl.js`,
`prefix-scan.wgsl.js` join `stamp.wgsl.js`, `fill.wgsl.js`, plus new
`walkraster.wgsl.js`. The raw `.wgsl` files are deleted; oracles import
the modules.

### Point-sprite emulation (clamped discs)

GL clamps `gl_PointSize` to ≥ 1 and rasterizes the sprite into the pixel
whose center falls in the unit square — a ±0.5 quad instead spreads
coverage over up to 4 pixels and reads visibly bolder on sub-pixel-weight
strokes. `vs_disc` (and the walk rasterizer) now snap clamped discs to
the GL-covered pixel, with a 0.005 px tie epsilon matching
ANGLE-on-Metal's observed boundary behavior at exact-integer centers.
Verified: stamps oracle disc-grid vs real GL = 0.0022 RMSE.

### Fill mask precision

`rgba16float` fill mask (removes this side's 8-bit rounding drift across
~90 layers per fill — see stencil oracle `full-fill-replay-16f`) plus 2×
supersampling over MSAA 4 with an exact box downsample before
compositing (the 4 MSAA sample positions are fixed, so per-layer edge
coverage rounding accumulates systematically otherwise). Supersampling
drops to 1× automatically when 2× would exceed
`maxTextureDimension2D` (the device now requests the adapter's real
limits — visual_suite is 2800×11400 device px).

### Goldens re-baselined (plan-sanctioned)

The W1b goldens were frozen under **swiftshader** GL. The WebGPU adapter
can only run on the **real GPU** (no software WebGPU on this machine),
and swiftshader's point-sprite rasterization differs measurably from
real GL — the stamps oracle proves the WGSL discs match Metal GL at
0.0022 RMSE while the same tiles diffed 4–9 against swiftshader
goldens. Per the plan ("worst case the goldens are regenerated and
downstream diffs re-baselined"), the goldens were re-frozen from the
**unchanged W1b dist** (built from commit `001b1a3`, committed at
`test/goldens/ref-dist/brush.esm.js`) under the Metal environment:
`node scripts/diff-parity.mjs --left /test/goldens/ref-dist/brush.esm.js
--webgpu --baseline --freeze-goldens`. Same hash-RNG geometry
(`assert-structure` geomHash `3878505443`, byte-identical to the W1b
value), faithful rasterizer. `test/parity/baseline/` (W0 upstream
reference) is untouched.

### Integration gate (frozen goldens, < 3.0/255)

`node scripts/diff-parity.mjs --goldens /test/goldens/tiles --regime
character --tolerance 3.0` — 54 tiles, **52 pass**, mean RMSE 1.28,
bit-identical across repeated runs (run-to-run reproducibility holds).
Hatching, `mass()`, `wash()`, and every fill tile pass. Two documented
residuals:

- `edge-subpixel` **3.75**: six strokes at weight 0.05 whose y sits at
  exact integer device coordinates — the pathological tie case for point
  rasterization. The golden shows sparse partial-alpha spill onto the
  adjacent row at scattered x positions (ANGLE's boundary resolution
  under sub-0.01 px jitter); we resolve ties one way. Lines land on the
  same row at the same saturation; character intact.
- `edge-self-intersect` **4.80**: layered self-intersecting fill whose
  bowtie wings read slightly denser than the canvas2d-derived golden.
  Per-layer stencil rasterization is oracle-exact (selfx +
  overlap-counts-once tests); the divergence is accumulation-level
  between two different rasterizers over ~90 crisscrossing layers.
  Same shape, same wash structure, slightly darker wings.

### W2 oracle regression suite

All five rerun green after W3: `oracle-spectral` (diff 0),
`oracle-stamps` (disc-grid 0.0022, image-grid 0, brush-smoke all
brushes, pipeline-count stable), `oracle-stencil` (12/12),
`oracle-grow` (8/8, op-counter sync intact), `oracle-strokewalk`
(hash battery, scan, walk parity, determinism). The stamps/strokewalk
pages gained the `await brush.ready()` the async adapter requires.

### Environment note for W4a

`scripts/profile-baseline.mjs` and `scripts/assert-structure.mjs` now
launch with `--enable-unsafe-webgpu --use-angle=metal` — the W0/W1b
swiftshader environment cannot run the fork at all. **The ≥10×/≥5×
targets can no longer be evaluated as ratios against the swiftshader
tables**; W4a must re-baseline upstream-vs-fork on Metal (the
`ref-dist` + `--webgpu` machinery does exactly this). Indicative
first-frame numbers on Metal (median-of-1, not a baseline):
visual_suite 5026 ms total / 4990 ms draw JS (fills are still CPU
`grow()` — the dominant cost, W4a's target), hatch_test 58 ms,
pastel_hatching 162 ms, fill_circle_explorer 56 ms. Batching levers
already in place for W4a: stamp flushes are per stroke
(internal-submit); composites submit 3 encoders each (blit / fill
flush / composite); fill passes are unbatched per layer (~185 passes
per fill, measured by the stencil oracle); walker batches break on
color/translation changes.

## Parity tooling

- `test/parity/parity.html` + `parity.js` + `tiles.js` — split-screen
  54-tile grid, browser half. Tile list is a JS port of the host site's
  `src/content/experiments/2026-08-30-brush-parity/tiles.ts`; keep in sync.
- `scripts/diff-parity.mjs` — headless driver. Emits
  `test/parity/parity-report.json`
  (`{ tile, feature, section, regime, rmse, verdict }[]` + summary),
  amplified diff PNGs to `test/parity/diffs/` for failing tiles,
  `--baseline` freezes reference PNGs + `baseline.json`,
  `--regime parity|character` selects verdict criteria.
  W3 flags: `--goldens <url dir>` (right pane vs frozen golden PNGs —
  the integration gate; RMSE gates even in the character regime),
  `--webgpu` (Metal launch flags), `--cpuwalk` (force the CPU stroke
  walk), `--freeze-goldens` (redirect `--baseline` into
  `test/goldens/tiles`). The right pane snapshots via
  `brush.readPixels()` when available.
- `scripts/profile-baseline.mjs` — the timing tables above.
- `scripts/assert-structure.mjs` — structural capture/compare/identity
  (W1b gate; see header comment for the calibrated rules).

## W4b — Inspection and manipulation API

Wraps the W1a readback primitives as supported public API, both
directions (plan: "Inspection and manipulation"). New module
`src/webgpu/inspect.js`; seam insertions in `stroke/gl_draw.js` /
`stroke/stroke.js` are all guarded by a single `_iflag.active` boolean so
the seam is a no-op when unused (verified: geomHash `3878505443`
unchanged, goldens gate unchanged — see below).

### API surface (standalone build)

- **`brush.stream(id?)`** — gets/sets the current geometry stream, a
  user-chosen label tagging every stroke drawn afterwards (default
  `"default"`). Streams are routing tags consulted per stroke; they do
  not exist on the GPU.
- **`brush.onGeometry(streamId, fn)`** → dispose fn (or pass `fn=null`
  to unregister). Hook between generation and rasterization, fired once
  per stroke flush with `{ streamId, kind: "disc"|"image", stride,
  vertices, counts, strokeIds }`; mutate `vertices` in place or return
  `{ vertices }` replacements (length % stride === 0) — the result is
  replayed into the stamp queue (dirty rects recomputed from post-hook
  positions) before the raster pass. **Honest cost:** a hooked stream's
  strokes take the retained CPU walk producer (`walkEligible` consults
  the hook table), so the hook runs synchronously on CPU-resident
  arrays with zero readback; that stream forfeits the GPU-walk speedup.
  Other streams keep the GPU walk untouched.
- **`brush.beginGeometry()`** → capture handle;
  **`await brush.readGeometry(handle)`** → `{ vertices, counts,
  strokeIds, images }`; **`brush.endGeometry(handle)`** discards an
  unread capture. The handle is a capture scope (immediate-mode library
  — there is no retained stroke object to hand out): open it, draw,
  read. One scope at a time. Capture does NOT reroute strokes: CPU-walk
  stamps are recorded as they queue; GPU-walk batches are retained
  (destroy deferred) and mapped only when `readGeometry` is awaited —
  the explicit out-of-band readback of gotcha #9. Format (both
  producers, normalized): `vertices` Float32Array ×4/stamp — x, y
  (device px, post-transform), radius (device px, pre GL 1px clamp),
  alpha 0..1; `counts`/`strokeIds` Uint32Array per stroke, ordered by
  the library's global sequential strokeId (= draw order). Image-tip
  stamps (5 floats: x, y, halfSize, angle, alpha) come back separately
  under `images`. Fill/hatch-mass polygon geometry is not captured
  (fills are CPU-produced; different consumer).
- **`brush.useCpuGeometry(bool)`** — unchanged from W3 (global CPU
  producer), now oracle-verified against the GPU producer.
- `_geometryStats()` / `_resetGeometryStats()` — test instrumentation,
  not API (routing counters used by the oracle).

### Oracle (`node scripts/oracle-w4b.mjs`, page
`test/webgpu/oracle-w4b.{html,js}`, report
`test/webgpu/oracle-w4b-report.json`)

Four gates, all PASS (headless Chrome for Testing, Metal, same launch
flags as every WebGPU oracle):

1. **roundtrip** — identity hook (read → write back unmodified) is
   **byte-identical** (0 differing bytes) to the CPU-producer baseline
   (same producer, minus the hook — the honest comparison, since a hook
   reroutes its stream to the CPU walk); replacement-returning identity
   hook likewise; an open capture does not perturb the GPU render
   (byte-identical); captured geometry structurally sound (14 strokes /
   27 162 stamps, counts·4 = vertices length, strokeIds strictly
   increasing); GPU capture vs CPU capture of the same scene:
   counts identical, max position delta 0 px (f32-rounds equal on these
   scenes; the strokewalk oracle stresses the f32 envelope harder).
2. **translate-hook** — hook adding +40 device px in x: ink bbox moves
   exactly +40 px in x (dxMin=dxMax=40), 0 in y, identical ink pixel
   count.
3. **perf-isolation** — hooked stream A (80 strokes) + unhooked stream
   B (400 strokes) in one scene, 7 reps: B draw-path median 0.3–0.4 ms
   with hook vs 0.3–0.4 ms without (threshold: ≤ 1.5×no-hook median
   + 3 ms), and routing asserted — with the hook, B's 400 strokes all
   stay on the GPU walk, A's 80 are all hooked (counters).
4. **cpu-vs-gpu** — `useCpuGeometry(true)/(false)` on four scenarios
   (default lines, marker+spray, field flowLines, mixed): RMSE 0.006 /
   0.330 / 0.383 / 0.248 per 255, all under the 1.0/255 gate (max
   single-channel diffs 2–66 at isolated AA/spray-dot edge pixels —
   f64-vs-f32 walk drift, exactly the strokewalk oracle's envelope).

Chain note baked into the oracle: stroke.js's cross-stroke
pressure-cache chain (upstream's markerTip leak) survives `seed()`, so
every run draws one sacrificial CPU-path stroke before reseeding —
without it, byte-identity across in-page runs depends on run order.

### Invariants re-verified (isolated worktree: W3 HEAD + only W4b files,
because W4a was mid-flight in the shared tree)

- `assert-structure` geomHash **`3878505443`** (identical to W1b/W3),
  no hooks, `useCpuGeometry(false)`.
- Goldens gate `diff-parity --goldens /test/goldens/tiles --regime
  character --tolerance 3.0`: **52/54, mean 1.2771, worst 4.7958** —
  bit-for-bit the W3 result (same two documented residuals,
  edge-subpixel 3.75 / edge-self-intersect 4.80).
- All five W2 oracles green post-change; `vitest` 99/99; `pnpm build`
  clean. The oracle also passes identically in the mixed tree.

Ownership per plan: new files only + minimal `_iflag`-guarded seam
calls; walker/grow internals untouched (W4a owns them) — inspect.js
depends only on the documented batch contract
(`{stampsBuffer, offsetsBuffer, countsBuffer}`, `readBatch`) and desc
fields (`salt`, `mx`, `my`).

## W4a — Tune (Metal re-baseline, fill batching, targets)

### Metal re-baseline (supersedes the swiftshader ratios)

The W0/W1b tables were swiftshader **software GL**; swiftshader cannot
run WebGPU, so the fork can only be measured on the real GPU and the
≥10×/≥5× targets are ratios against a **new upstream-on-Metal baseline**
(same machine, same scenarios, same command). Both sides: headless
Chrome for Testing, `--enable-unsafe-webgpu --use-angle=metal`, Apple
Silicon macOS 25.2.0, Node 22.17.1, median of 3 first-frame runs via
`scripts/profile-baseline.mjs`. Upstream = the pinned npm dist served in
place of `/dist/brush.esm.js` (new `--module` flag). Raw JSON:
`test/parity/baseline-upstream-metal.json` (upstream),
`test/parity/timings-w4a.json` (fork).

The re-baseline overturns the W0 premise for upstream: visual_suite
23.5 s → **296 ms** on real GL. Most of the swiftshader "draw JS" was
software rasterization inside synchronous gl.*/canvas2d calls, not
geometry JS. On Metal, upstream is already GPU-rasterized and its CPU
cost is the same geometry code both sides share (grow(), field fill,
scenario JS).

Two benchmark scenarios were added because every existing scenario
bottoms out at the ~40–60 ms page/parse floor on a real GPU:
`stroke_bench` (320 full-width field-driven flowLines across the 8
GPU-walkable tips, 2000×1400) and `fill_bench` (48 large high-bleed
watercolor fills, no strokes/hatch, 1600×1600). Public API only — the
same file runs against upstream and the fork.

### Final timing table (Metal, median of 3, first frame)

| Scenario | upstream total (ms) | fork total (ms) | ratio | upstream draw | fork draw | draw ratio |
|---|---:|---:|---:|---:|---:|---:|
| **stroke_bench** | 867 | 54 | **16.1×** | 845 | 28 | **30.2×** |
| **fill_bench** | 329 | 385 | **0.85×** | 305 | 360 | 0.85× |
| visual_suite | 301 | 265 | 1.14× | 273 | 236 | 1.16× |
| hatch_test | 111 | 52 | 2.1× | — | — | — |
| fill_angle_test | 123 | 144 | 0.85× | 103 | 119 | 0.87× |
| angle_mode_test | 63 | 44 | 1.4× | — | — | — |
| wash_test | 45 | 39 | 1.2× | — | — | — |
| transform_test | 58 | 65 | 0.9× | — | — | — |
| pushpop_test | 62 | 58 | 1.1× | — | — | — |
| pastel_hatching_test | 136 | 121 | 1.1× | — | — | — |
| field_explorer | 49 | 58 | 0.8× | — | — | — |
| fill_circle_explorer | 60 | 52 | 1.2× | — | — | — |

Scenarios without a draw split report only the total (page floor
~40–60 ms dominates them on both sides; ±10 ms run noise).

- **Stroke-heavy ≥10×: HIT** — 16.1× total, 30.2× on draw. No
  divergence work needed (the stop-condition branch never triggered);
  the two-pass per-step restructure was NOT built, per plan ("do not
  build it preemptively"). The fork's stroke_bench profile is
  idle/page-bound: walk 4.6 ms, composite 2.4 ms — nothing left to cut.
- **Fill-heavy ≥5×: NOT HIT — profile explains why** (next section).

### What was optimized: stencil-fill batching (the 19× fork-side win)

Where the fork's visual_suite first frame went at W3 handoff
(5.0 s draw, CPU profile, Metal): **4.11 s in webgpu/fill.js
`pushVerts`** — a `queue.writeBuffer` per polygon — plus 168 ms
`stencilThenCover`, 86 ms `pushUniform`, i.e. per-layer GPU API chatter:
~185 render passes, ~370 writeBuffers, ~370 bind groups per fill.

Fix (src/webgpu/fill.js + wgsl/fill.wgsl.js, internals only — public
renderer API and the fill/composite.js seam kept, oracle call sites
gained one `flushInto(encoder)` line):

1. **Record-then-flush**: layer/fillPolygon/strokePolygon/erase/clear
   append to CPU staging arrays (grow-only typed arrays); nothing GPU
   happens until `flushInto(encoder)` uploads the whole batch with one
   writeBuffer per arena.
2. **One render pass per batch** (was one per polygon): the cover
   pipeline's stencil passOp is now `zero` — covering a polygon zeroes
   exactly the stencil it consumed, so polygons no longer need
   per-polygon `stencilLoadOp: clear` passes. Pass splits only at
   `clear()` boundaries. Draw order = record order (gotcha #10 safe;
   MSAA resolve at pass end is idempotent, pixels bit-identical).
3. **Per-draw params via `firstInstance`**: `draw(n, 1, 0, paramIdx)`
   indexes a storage array of `{base, color}` with
   `@builtin(instance_index)` — no per-draw uniforms or bind groups
   (4 bind groups per flush total). Erase discs carry alpha in the
   vec4's w and share the same pass (their pipeline gained a no-op
   stencil state).
4. `buildStrokeGeometry`: preallocated scratch instead of
   `Array.push` + copy (87→26 ms), `Math.hypot`→`sqrt`, per-edge
   dx/dy/len computed once and shared by the quad and join loops,
   scissor bounds tracked during generation (conservative superset —
   output-neutral because the cover draw is stencil-gated).

Measured per lever (visual_suite draw, Metal): 4972 ms → 363 ms
(batching) → 304 ms (scratch buffer) → 236 ms (sqrt + bounds + edge
sharing). Stencil oracle encoder report: passesPerFill 185→**1**,
encode+submit median 15 ms→**1.0 ms**, all 12 stencil tests pass
unchanged. The W3-flagged composite-encoder lever (3 encoders/
composite, per-stroke stamp submits) became a no-op after this:
post-fix profiles show runComposite 2.4 ms / copyToBlendSource 1.6 ms
per scenario — the earlier 162 ms copyToBlendSource reading was
backpressure from the per-polygon writeBuffer flood, not submit cost.

### Fill-heavy: why 5× is not reachable without grow-compute, and why
### grow-compute was not wired this wave

fill_bench fork profile (376 ms draw): **grow() 207 ms**,
buildStrokeGeometry 66 ms, transformVerts 14 ms, flushInto 8.5 ms,
hash/gaussian 20 ms. Upstream's 305 ms draw contains the *same* CPU
grow (~200 ms) — both sides are grow-bound, which is why the ratio
pins near 1×. Arithmetic ceiling: zeroing every fork-side
rasterization cost leaves ~230 ms vs upstream 305 ms ≈ 1.3×; **5×
requires deleting grow() from the CPU**, i.e. the full
FillPoly-DAG-on-GPU integration, not tuning.

Wiring it was evaluated and deliberately deferred, with the blockers
mapped concretely:

- fill()'s op chain interleaves CPU vertex consumers with grow chains:
  `scatter()` (point-in-polygon + pull-in on *grown* vertices),
  erase-circle generation, and layer()'s border expansion all read
  vertex data mid-fill. GPU-resident grow therefore forces either a
  mid-fill readback (gotcha #9, forbidden) or WGSL ports of scatter +
  erase + border expansion.
- The op-salt counter cannot round-trip: trim()'s salt consumption
  depends on the polygon's *current* vertex count, which is
  data-dependent (trim's nInsert reads vertex coordinates), so counts
  exist only GPU-side mid-chain (grow.js already keeps the counter in
  a GPU buffer for exactly this reason). Any CPU op mid-fill would need
  the counter back — a readback. So it is all-or-nothing: every salt
  consumer in fill() must move to the GPU together.
- That is a W2-component-sized build (new scatter/erase/border WGSL
  kernels with bit-exact hash parity + oracles + indirect scissor
  bounds), and it **rewrites the fill generate→rasterize seam that W4b
  is concurrently hooking** (readGeometry/onGeometry/useCpuGeometry).
  Per the W4a brief ("keep that seam stable"), it was not touched.

Recommended next wave (post-W4b): port scatter/erase/border to compute
reusing the existing grow.wgsl machinery (STREAM ids SCATTER_PICK/
PULL_X/PULL_Y already exist), rasterize layer taps via the existing
`drawIndirect(poly.buffer, 32)` contract, and add a border-expansion
vertex shader (pulls polygon verts, emits edge quads + miter joins with
degenerate-triangle skips) — that also removes the last 66 ms of
buildStrokeGeometry and cuts fill vertex upload ~12×. Projected
fill_bench draw ≈ 50–70 ms ≈ 4.5–6× — the target lives exactly there.

### Deliberate no-ops (profile-justified)

- **Hatch**: stays on CPU. hatch_test fork profile is page-bound
  (idle 17 ms, program 14 ms; largest library frame `tryGpuWalk`
  1.1 ms) and the fork already beats upstream 2.1× — nothing to port.
- **strokewalk two-pass restructure**: not built; 30× draw on
  stroke_bench without it.
- **Composite encoder consolidation**: see above — post-batching cost
  is 2–4 ms/scenario.
- **Border expansion in the vertex shader**: valuable only as part of
  the grow-compute wave (66 ms standalone gain caps fill_bench at
  ~0.97×); folded into the recommendation above.

### Verification (after every change, final state)

- Five W2 oracles + oracle-w1a: PASS (stencil 12/12; grow op-counter
  sync intact; strokewalk determinism PASS).
- Goldens gate `diff-parity --goldens /test/goldens/tiles --regime
  character --tolerance 3.0`: **52/54, mean 1.2771, worst 4.7958 —
  bit-for-bit the W3 numbers**, same two documented residuals
  (edge-subpixel 3.75, edge-self-intersect 4.80). RMSEs did not move
  at all across the batching/sqrt/bounds changes.
- `assert-structure --identity` over 3 fresh captures: geomHash
  **`3878505443`** ×3 (the W1b/W3 value).
- `vitest` 99/99, `pnpm build` clean, `grep mapAsync src/` matches only
  `webgpu/readback.js` (+ a comment).
- All checks ran in the **mixed tree with W4b's seam hooks present**
  and stayed green.

### Tooling added in W4a

- `scripts/profile-baseline.mjs`: `--module <path>` (serve any dist at
  `/dist/brush.esm.js` — how the upstream Metal baseline is produced)
  and `--only <scenario>`; SCENARIOS now leads with the two benches.
- `test/standalone/stroke_bench.{html,js}`,
  `test/standalone/fill_bench.{html,js}` — the target-measurement
  scenarios (deterministic, module-agnostic).

Papercut carried forward (pre-existing, unchanged): webgpu/fill.js
still uses a local pipeline memo because pipeline.js's cache has no
`multisample` key.
