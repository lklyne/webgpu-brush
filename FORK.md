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

0. **W3 — WebGPU renderer.** The library renders through pure WebGPU (no
   WebGL anywhere). API-visible consequences:
   - **`brush.ready()`** resolves once the WebGPU device is up. WebGPU
     device acquisition has no synchronous form. *Awaiting it is
     optional* (W8): stateful calls made before the device resolves are
     recorded and replayed in program order, so upstream's synchronous
     `createCanvas()`-then-draw sequence runs unmodified (see W8 for the
     one pre-ready `random()` caveat). Upstream's own standalone test
     pages run byte-identical in this repo (W9 dropped the `ready` guards
     they had carried since W3).
   - **`brush.readPixels()`** (async, out-of-band) reads the painting
     texture back as RGBA — the supported way to capture output
     (canvas2d `drawImage()` of a WebGPU canvas is blank in some
     headless configurations; the parity harness uses `readPixels`).
   - **`brush.cpuGeometry()` / `brush.noCpuGeometry()`** force / release
     the retained CPU producers (stroke walk and fill DAG; the CPU path is
     a first-class producer). Named as a toggle pair to match upstream's
     `fill`/`noFill`, `field`/`noField` (W8). The interim
     `useCpuGeometry(bool)` alias was removed in W9.
   - **`brush.gpu()`** (W7) and `createCanvas`/`load` `{device, adapter}`
     options: shared-device interop for hosts that own a WebGPU device.
   - **`snapshot()` / `restore()` / `freeSnapshot()`** and the geometry
     inspection API (`stream`, `onGeometry`, `beginGeometry`/`endGeometry`,
     `readGeometry`, W4b) are additive.
   **The p5 build is gone.** The p5 adapter needed p5's WebGL renderer
   (framebuffers, `createShader`) that W3 removed from the core, so it had
   been broken at runtime since W3 and unbuilt since W8. W9 deleted it
   along with the WebGL shader sources, `index.p5.js`/`index.shared.js`,
   the p5 test pages, the examples, the online tools and the Pages deploy.
   The package ships the standalone build only (`brush-gpu/standalone`;
   `main`/`module` point at it too). Upstream's GLSL shaders survive
   verbatim under `test/reference/glsl/` because two component oracles
   (spectral, stamps) render them in WebGL2 as their reference, and the
   spectral constant tables are transcribed from that `.frag`.

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

**grow-compute is NOT in the default frame path.** *(Superseded by W5 —
it is now the default; see the W5 section. The W3 reasoning is kept
because it is the record of why the seam is shaped the way it is.)*
Fills run CPU `grow()` → GPU stencil raster. Reason: `FillPoly.fill()` interleaves
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

## W5 — grow-compute wired: the FillPoly DAG, GPU-resident

W4a's recommendation is implemented as written. Fills no longer run
`grow()` on the CPU: `FillPoly.fill()` drives either the retained CPU
producer or a GPU handle, and on the GPU path **no fill vertex, vertex
count or bounding box ever touches the CPU**.

### Why it had to be all-or-nothing (and how the seam was cut)

The blocker was never grow() itself — it was the op-salt counter.
`trim()` consumes a salt only when `v.length > 8`, and the vertex counts
that decision keys on are data-dependent (`nInsert` reads coordinates),
so mid-chain counts exist only GPU-side. Any CPU op between two grows
would need the counter back, i.e. a frame-path readback (gotcha #9).
So every salt consumer moved together:

| op | where it lives now | salt |
|---|---|---|
| `grow()` / `trim()` | `growStep` (grow.wgsl) | GPU counter |
| `scatter()` | `scatterStep` | GPU counter |
| `erase()` | `eraseStep` | GPU counter |
| `flipDirs()` | a uniform flag on the next grow — no kernel | none |
| layer border | `vsBorderPoly` vertex shader | none |
| `createFill` / centre / `darker` | still CPU | CPU counter (ops 0–2, before the GPU takes over) |

`opInit` seeds the GPU counter from inside the compute pass, so the
per-fill reset is ordered structurally rather than by `queue.writeBuffer`
timing. `fill()` itself is unchanged control flow operating on a `root`
that is either `this` or a `GpuFillPoly` — **one schedule, so the op
order (and therefore the salt sequence) cannot drift between producers**.
`_layerStyle()` and `_eraseParams()` were extracted so both producers
share the same arithmetic verbatim.

### One dispatch per op, one workgroup

W2's grow was two dispatches (prepare @ 1 thread, exec @ `2 * capacity`
threads — 256 workgroups regardless of the real vertex count). A fill
issues ~220 ops, so at 48 fills that is ~21 000 dispatches of mostly
early-outs. `growStep` is now ONE dispatch of ONE workgroup: thread 0
runs the sequential prepare into workgroup memory, a barrier publishes
it, 256 threads stride the output indices, and a third phase reduces the
per-thread vertex bbox into the poly header. `scatterStep` has the same
shape. Halves the dispatch count and removes the fixed launch.

Gotcha #10 holds throughout: every output slot is a pure function of its
index (erase circles land at `i - floor(i/5) - 1`, the skipped `i % 5`
draws still consuming their RNG), and the only atomics are the
`atomicMin/Max` accumulating the dirty rect — commutative and
associative, so interleaving cannot change the result. No atomic append
anywhere.

### The two things that had no CPU-side answer

1. **Vertex counts** — `drawIndirect` args are written by the compute
   shader into the poly header: byte 32 for the fan fill
   (`3 * (count - 2)`), byte 48 for the border (`12 * count`).
2. **Bounding boxes** — a scissor rect cannot be indirect, so the
   geometry carries the bound instead:
   - the fill/border **cover draw is a bbox QUAD** (`vsCoverPoly`) built
     from the GPU-computed bbox in the header, snapped to whole pixels
     (a fractional edge under MSAA would leave stencil samples uncleared
     for the next of ~90 layers);
   - the **composite dirty rect is a GPU buffer**. `getFillCompositeRect`
     returns `{__gpuRect, buffer}`, and both consumers became quad draws:
     `spectral.wgsl`'s new `vsRect` entry replaces fullscreen-tri +
     `setScissorRect`, and the blend-source blit replaces
     `copyTextureToTexture` with a `textureLoad` quad. The buffer holds
     the GPU-accumulated half (ordered-u32-encoded f32) and a CPU half
     the retained path still writes, unioned in the shader — so CPU and
     GPU fills can coexist in one composite cycle. The flush moved into
     `getFillCompositeRect` because shared core calls it BEFORE the blit;
     that ordering is what guarantees the rect buffer is populated.

Full-canvas compositing was measured as the alternative and rejected:
192 composites × 2.56 Mpx of Kubelka-Munk per fill_bench frame.

### Border expansion in the vertex shader

`buildStrokeGeometry`'s CPU output is variable length (skipped degenerate
edges, a 3-vertex bevel fallback past the miter limit). `vsBorderPoly`
emits a FIXED 12 vertices per polygon vertex — 6 edge quad, 6 miter join
— and collapses every skipped case to a degenerate triangle, so the
vertex count stays a pure function of the vertex count. No compaction, no
atomics. This also deletes the 66 ms of `buildStrokeGeometry` and the
14 ms of `transformVerts` W4a measured (the affine now runs in the vertex
stage).

### Timings (Metal, median of 3, first frame; same command as W4a)

`node scripts/profile-baseline.mjs --json test/parity/timings-w5.json`;
upstream column is the unchanged `test/parity/baseline-upstream-metal.json`.

| Scenario | upstream | W4a fork | W5 fork | W4a ratio | **W5 ratio** | up draw | W5 draw | draw ratio |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **stroke_bench** | 867 | 54 | 53 | 16.1× | **16.4×** | 845 | 28 | 30.2× |
| **fill_bench** | 329 | 385 | **49** | 0.85× | **6.7×** | 305 | 28 | **10.9×** |
| visual_suite | 301 | 265 | 138 | 1.14× | 2.18× | 273 | 112 | 2.44× |
| hatch_test | 110.6 | 51.5 | 46.5 | 2.15× | 2.38× | — | — | — |
| fill_angle_test | 123 | 144 | 74 | 0.85× | 1.66× | 103 | 53 | 1.94× |
| angle_mode_test | 62.7 | 44 | 44.3 | 1.43× | 1.42× | — | — | — |
| wash_test | 44.9 | 38.5 | 43.6 | 1.17× | 1.03× | — | — | — |
| transform_test | 58.2 | 64.6 | 38.1 | 0.90× | 1.53× | — | — | — |
| pushpop_test | 61.5 | 57.6 | 39.6 | 1.07× | 1.55× | — | — | — |
| pastel_hatching_test | 135.9 | 121.2 | 126.6 | 1.12× | 1.07× | — | — | — |
| field_explorer | 48.5 | 58.3 | 51.7 | 0.83× | 0.94× | — | — | — |
| fill_circle_explorer | 60.2 | 52.3 | 35.2 | 1.15× | 1.71× | — | — | — |

- **Fill-heavy ≥5×: HIT** — 6.7× total, 10.9× on draw (was 0.85×).
  fill_bench draw went 358 ms → 28 ms.
- **Stroke-heavy ≥10×: still HIT** — 16.4×, untouched by this wave.
- The sub-60 ms scenarios (wash, angle_mode, pastel, field_explorer) are
  page/parse-floor bound on both sides at ±10 ms run noise; they are not
  measuring the library. field_explorer's 0.94× is that floor — an early
  W5 build made it worse (0.69×) by compiling the five new compute
  pipelines inside `ready()`, so **the fill driver is now built lazily on
  the first fill**; stroke-only sketches pay nothing.

### Verification (all re-run at final state)

- **`node scripts/oracle-w5.mjs`** (new; page `test/webgpu/oracle-w5.js`,
  report `test/webgpu/oracle-w5-report.json`, `--dump` writes failing
  scenes to `test/webgpu/w5-dumps/`). Eight fill scenarios spanning
  bleed strength/direction, texture (erase density), scatter on/off,
  alpha 255, multi-colour, self-intersecting, fill+stroke:
  1. **cpu-vs-gpu** `useCpuGeometry(true)` vs `(false)`: RMSE
     **0.0018–0.0080** per 255 (gate < 1.0), max single-channel diff
     **1**, 2–38 differing bytes out of 589 824. Effectively bit-exact.
  2. **determinism**: three consecutive GPU-fill renders **byte-identical**
     on all eight scenes.
  3. **dirty-rect**: GPU ink bbox contains the CPU ink bbox and ink pixel
     counts match to 1.0000–1.0001 on all eight — the GPU rect never
     clips the composite.
  4. **routing**: `useCpuGeometry(true)` and `Stats.enabled` fall back to
     the CPU DAG (0 GPU fills), the GPU path is taken otherwise.
- **Goldens gate** `diff-parity --goldens /test/goldens/tiles --regime
  character --tolerance 3.0`: **52/54, mean 1.2771, worst 4.7957** — the
  W3/W4a/W4b numbers to four decimals (edge-subpixel 3.7466,
  edge-self-intersect 4.7957 vs 4.7958). Fills included.
- **`assert-structure --identity`** over 3 fresh captures: geomHash
  **`3878505443`** ×3.
- All seven earlier oracles green: w1a, spectral, stamps, stencil (12/12,
  `passesPerFill` still 1), grow (8/8, op-counter sync intact),
  strokewalk, w4b (4/4).
- `pnpm build` clean, `vitest` 99/99, `grep -rn mapAsync src/` still
  matches only `webgpu/readback.js` (+ two comments).

### Deviations from W4a's written plan

- W4a proposed keeping prepare/exec as two dispatches. Profiling the op
  count (~220 per fill) made the fixed 256-workgroup exec launch the
  dominant term, so they were merged into one single-workgroup dispatch.
  This is an internal restructure of an oracle-verified W2 component; the
  grow oracle passes unchanged (`maxVertDev` ≤ 3e-5).
- W4a did not anticipate the composite dirty rect. It is the one place
  where "no readback" forced work outside `webgpu/` — `spectral.wgsl`
  gained `vsRect`, and `gpu.js` gained a quad blit. Shared core
  (`core/color.js`) is untouched: the rect marker flows through the
  existing hook signatures.
- `grow.js`'s uniform arena is now staged CPU-side and uploaded with ONE
  `writeBuffer` per batch (per-call `writeBuffer` was W4a's 4.1 s
  finding). Existing callers must add `gc.uploadBatch()` before submit;
  the grow oracle was updated accordingly.
- `pipeline.js#getComputePipeline` gained an optional explicit `layout`,
  needed because `layout: 'auto'` never declares `hasDynamicOffset` —
  and dynamic offsets are what keep bind groups keyed on buffers
  (~a dozen per frame) rather than per draw (~20 000).

### Papercuts

- **~29 MB of pooled poly buffers.** The driver never aliases a buffer
  within a fill (no lifetime analysis, no chance of a later op clobbering
  a buffer an earlier draw reads), so a fill's ~220 ops each take a fresh
  8192-vertex slot: 220 × 131 KB. Pooled and reused across fills, so it
  is a ceiling, not per-fill. A liveness pass over `_fillBody` would cut
  it to about a dozen buffers.
- **Uniform arena cannot grow mid-batch** (bind groups recorded during
  the batch hold it). Capacity is a fixed 8192 ops per batch — ~9× the
  largest fill this library produces — and overflow throws with a
  pointer to the fix rather than corrupting.
- `nh()`'s `1 - hash01()` had to be reproduced as `(2^32 - h) * 2^-32`
  in u32 space; the naive f32 subtraction cancels catastrophically and
  `nh` feeds `log()`, so a 2^-24 absolute error there becomes an
  unbounded erase-circle offset. Documented in the shader.
- Two f32-vs-f64 truncation risks are accepted rather than emulated:
  erase's `~~(rh(80,110) * countFactor)` and scatter's
  `~~(i*step + rh(...))` can flip by one with probability ~1e-5 per
  draw. Both are single-element effects (one circle, one vertex pick);
  the count-critical truncations (`~~((1-f) * N)`, `~~(L * ratio)`,
  `ceil(idx / GROW_CAP)`) all go through the exact-integer path.
- `scatter()` after `flipDirs()` throws — `fill()` never does it, and
  supporting it would need a copy kernel the lazy flag avoids.

### Files changed

`src/webgpu/wgsl/grow.wgsl.js` (growStep/scatterStep/eraseStep/opInit/
rectInit, bbox reduction, dirty-rect merge), `src/webgpu/grow.js`,
`src/webgpu/fillgpu.js` (new), `src/webgpu/fill.js` (GPU-geometry
pipelines + record ops), `src/webgpu/wgsl/fill.wgsl.js` (POLY_WGSL,
ERASE_POLY_WGSL), `src/webgpu/wgsl/spectral.wgsl.js` (`vsRect`),
`src/webgpu/pipeline.js` (explicit compute layout), `src/fill/fill.js`
(`GpuFillPoly`, `_tryGpuFill`, `_fillBody`, `_layerStyle`,
`_eraseParams`), `src/fill/composite.js` (GPU record API, GPU rect),
`src/adapters/standalone/gpu.js` (lazy driver, rect-quad blit +
composite), `src/stroke/gl_draw.js` (`_getUseCpuWalk`),
`src/index.standalone.js` (`_fillDriverStats`),
`test/webgpu/oracle-w5.{html,js}` (new), `scripts/oracle-w5.mjs` (new),
`test/webgpu/grow-oracle.js` (`uploadBatch`),
`test/parity/timings-w5.json` (new).

## Painting snapshots (undo support, standalone build)

`src/adapters/standalone/snapshot.js`, exported from the standalone entry.
p5.brush is immediate-mode (no stroke objects to replay), so host-side undo
is a snapshot stack of the painting texture — GPU-side only,
`copyTextureToTexture` into pooled textures matching the painting's
size/format. No readback, no `mapAsync` (gotcha #9 holds; the grep
invariant is unchanged).

- **`brush.snapshot()`** → opaque handle (`{__brushSnapshot, width,
  height}`). Flushes pending compositing first (`flushActiveComposite`), so
  the copy contains everything drawn up to the call. Requires
  `await brush.ready()`.
- **`brush.restore(handle)`** — flush/reset composite + dirty-rect state
  (same reset path `render()`/`clear()` use, so stale masks cannot land on
  the restored painting), copy the snapshot back into the painting, then
  re-present via the same painting → `getCurrentTexture()` copy path every
  composite uses. Handles stay valid across restores (undo AND redo work
  from one handle). Throws on freed/dropped handles and on size mismatch
  after a canvas resize.
- **`brush.freeSnapshot(handle)`** → boolean; returns the texture to the
  pool. No-op on already-freed handles.
- **Pool bound**: `MAX_SNAPSHOTS = 20` live snapshots; taking one beyond
  the bound drops the OLDEST live handle and reuses its texture. Freed
  textures are kept on a spare list (≤ 20) and reused when size/format
  still match; a resize invalidates them lazily.

## Timing semantics — read before quoting the tables above

The headline tables in this file (16.1× stroke-heavy, 6.7× fill-heavy) are
**wall-clock at JS return**. That measures different things on the two sides:

- **Upstream (WebGL2):** Chrome's GL driver drains most GPU work inside the
  JS calls, so JS-return ≈ pixels-done.
- **This fork (WebGPU):** JS-return is submission only — the GPU queue drains
  after. The number is main-thread cost, not completion.

Measured honestly to GPU completion on both sides (hard GL sync vs readback
barrier; the barrier's idle cost is ~10 ms), the two columns are:

| metric | fill-heavy (morph-style) | what it answers |
|---|---|---|
| main-thread (cpu) time | **10–16× faster** | how long JS is blocked — interactivity, achievable FPS |
| to-completion latency | **~1.3–2× faster** | when pixels are actually done — batch/export wall-clock |

Both are real; neither substitutes for the other. The fork's design target
was always the first column ("the win comes from deleting the CPU from the
hot path" — the plan's own words): total GPU raster work is comparable on
both sides, so end-to-end latency improves only by the CPU share it removed.
Quote the CPU column for interactive use, the completion column for offline
rendering, and never one as the other. Discovered via the site's perf tab
(`/experiments/brush-parity` → perf), which times both ways and displays both.

Order-of-runs note: without completion fences, a benchmark that runs WebGL
then WebGPU lets the GL queue's backlog bleed into the WebGPU measurement
(observed 433 ms vs a true ~30 ms submission). Any A/B timing of the two APIs
needs a full sync between runs.

## W6 — Deferred stroke groups (per-color flush was serializing the walk)

### Symptom

The site's perf tab (`strokes ×1`, 320 field-driven flowLines cycling four
colors) showed the fork at **0.2×** upstream to completion: p5.brush 412 ms,
fork 2399 ms — while the same workload in ONE color ran at 122 ms.
Reproduced headlessly with the new `scripts/bench-strokes.mjs`
(`test/standalone/stroke_ab.{html,js}`; 2000×1400, density 1, Metal, every
run timed to GPU completion on both sides):

| variant (before) | total ms | js ms |
|---|---:|---:|
| upstream · color cycles | 900 | 897 |
| fork · GPU walk · color cycles | **4469** | 22 |
| fork · CPU walk · color cycles | 867 | 856 |
| fork · GPU walk · one color | 122 | 6 |

### Cause

`gl_draw.js` batched GPU-walk descriptors per (translation, stroke color)
and flushed the batch on every color change, because the brush mask holds
one color and `Mix.blend` composites it at the change. With the palette
cycling per stroke every batch had **one** stroke, and strokewalk-compute is
one thread per stroke, sequential along it: at spacing 0.1 a 1940 px line
is ~20k dependent steps (64k for the marker at 0.03), ≈ 14 ms of
single-thread GPU latency per stroke, 320 times in a row. The design's
parallelism (across strokes) never engaged. The conservative field dirty
rect (start ± length, i.e. the whole canvas) was a second suspect and was
ruled out first: forcing a thin rect changed nothing (4498 ms).

### Fix — record groups, walk once, replay composites in order

`queueWalkStroke` no longer flushes on a color change. It seals the current
GROUP (a contiguous descriptor range sharing translation + color, in draw
order) and keeps queueing into the same super-batch. `flushWalkBatch()` then:

1. `walker.walk(descs, groups)` — ONE compute submit walks every queued
   stroke in parallel. `writeIndirect` now emits one drawIndirect entry per
   group (`{4, offsets[end] − offsets[start], 0, 0}`, 16 B stride; the
   raster vertex shader adds `offsets[start]` from a new binding, so no
   `indirect-first-instance` feature is needed) and the walk pass
   accumulates a **per-group GPU dirty rect** (device px, ordered-u32
   atomicMin/Max, 4 atomics per stroke from thread-local bounds; 256 B stride
   so a group's record binds at a storage-buffer offset; same record layout
   as W5's fill rect, decoded by `spectral.wgsl` `vsRect` and the
   blend-source blit unchanged).
2. One render encoder replays the groups in order. A **deferred** group
   (the mask held no CPU stamps when it opened) is: raster into the mask
   with `loadOp: "clear"` → blend-source blit of its GPU rect →
   `host.encodeRectComposite` (spectral, rect-bounded, no present). An
   **immediate** group (CPU stamps of the same color already sat in the
   mask — plot/image-tip strokes) rasters with `loadOp: "load"` and marks
   the old conservative CPU rect; `Mix.blend` composites it with those
   stamps exactly as before. One present at the end, then a mask clear if a
   deferred group left stamps in it.

Deferred composites run at the next ordering point, so draw order is
preserved (gotcha #10) without deferring anything else in the host:
`flushPending` is registered on the stroke composite and called from
`Mix.applyShader` before any fill-mask composite, from
`flushActiveComposite` (render / snapshot / restore), from `clear()`
(`resetCompositeState`), from every CPU stamp flush, and on environment
change. `Mix.blend`'s own per-color composite sees `isDrawn === false` for
deferred groups and skips itself.

Same-color join: a CPU stamp flush (`glDraw`/`glDrawImages`) calls
`flushWalkBatch(true)`; if the trailing deferred group matches the current
color/translation it is converted to immediate so the group and the CPU
stamps share one mask and one composite. Without this the goldens moved on
exactly one tile (`edge-custom-brush`: GPU-walked line + CPU-walked circle,
same ink, 0.9292 → 0.9775) because overlapping ink was spectrally mixed
twice. With it the parity report is byte-identical to W5's.

Uniform rings grew a `reserve(n)` (pipeline.js): growth destroys the old
buffer, which would invalidate bind groups already recorded in the flush's
encoder, so the raster ring and the blend ring are sized before encoding.

### Timings (same bench, after)

| variant (after) | total ms | js ms | vs upstream (completion) |
|---|---:|---:|---:|
| upstream · color cycles | 943 | 938 | — |
| fork · GPU walk · color cycles | **151** | 9 | **6.2×** |
| fork · GPU walk · one color | 129 | 6 | 7.5× |
| fork · CPU walk · color cycles | 956 | 943 | 1.0× |

The CPU (main-thread) column for the cycling case went from 22 ms to 9 ms
(one walk submit instead of 320). The to-completion floor is now the 320
rect-bounded spectral composites plus the walk of the longest stroke.

### Verification (final state)

- Goldens gate `diff-parity --webgpu --goldens /test/goldens/tiles --regime
  character --tolerance 3.0`: **52/54, mean 1.2771, worst 4.7957** — every
  tile's RMSE identical to the committed report (same two documented
  residuals).
- `assert-structure --identity` over 3 fresh captures: geomHash
  **`3878505443`** ×3.
- Oracles green: strokewalk (walk-parity, determinism), w4b (4/4 — captures
  now retain a multi-group batch), w5 (cpu-vs-gpu, determinism, dirty-rect,
  routing), w1a, spectral, stamps, stencil (12/12), grow.
- `vitest` 99/99 (the stroke_pressure mock gained the router exports);
  `npm run build` clean; `grep -rn mapAsync src/` still matches only
  `webgpu/readback.js` (+ comments).

### Files

`src/stroke/gl_draw.js` (groups, flush), `src/webgpu/strokewalk.js`
(`walk(descs, groups)`, rect/indirect/groups buffers, `density` env,
`RECT_BYTES`, `f32ToOrd`), `src/webgpu/wgsl/{strokewalk,prefix-scan,
walkraster}.wgsl.js`, `src/adapters/standalone/gpu.js`
(`encodeRectComposite`, `reserveBlendSlots`, `resetBlendSlots`),
`src/webgpu/pipeline.js` (`reserve`), `src/core/color.js` and
`src/stroke/composite.js` (`flushPending` hook), `src/adapters/standalone/
frame.js` (clear flushes), `scripts/bench-strokes.mjs`,
`test/standalone/stroke_ab.{html,js}`.

## W7 — Shared-device interop (`brush.gpu()`)

The first r3f embedding (the host site's draw tab) re-uploaded the fork's
canvas through a `THREE.CanvasTexture` on every dirty frame. This wave makes
the painting consumable by a host renderer on the **same GPUDevice** with
zero copies. Additive; no dependency on three in the fork.

### API surface (standalone build)

- **`brush.createCanvas(w, h, { device, adapter })` / `brush.load(target,
  { device, adapter })`** — adopt an externally owned device instead of
  requesting one. The owner keeps ownership: `GpuContext.destroy()`
  unconfigures the canvas but never destroys an injected device
  (`ctx.external`). The injected device must carry limits large enough for
  the target; the fork's own request asks for the adapter maximum of
  `maxTextureDimension2D` / `maxBufferSize` / `maxStorageBufferBindingSize`.
- **`brush.gpu()`** → `{ device, adapter, format, painting,
  onPaintingChanged(fn) → dispose }`. Synchronous; requires
  `await brush.ready()` (throws the not-ready error otherwise). `painting`
  is a getter for the LIVE painting `GPUTexture` — `ensurePainting()`
  recreates it on resize, and every listener receives the new texture. Image
  convention (row 0 = top); premultiplied colors in `format` (the preferred
  canvas format, not sRGB-typed).
- The fork's own `requestDevice` now asks for every feature the adapter
  supports — the same request three's WebGPUBackend makes — so a host
  adopting this device sees the feature set it would have requested itself
  (`core-features-and-limits` keeps three out of compatibility mode;
  `timestamp-query` feeds the host site's GPU-timing inspector). The
  fork's shaders need nothing beyond defaults.

### Intended pairing (verified on the host site)

Fork owns the device (it needs the raw limits); three adopts it:
`createCanvas` → `await ready()` → `gpu()` → `new WebGPURenderer({ device })`
→ `new ExternalTexture(painting)` sampled through a TSL `texture()` node
with v flipped (three plane UVs put v=0 at the bottom). Same device, same
queue: the fork's submissions land before the host's render in submission
order, no fences, no `needsUpdate`. Three initializes an `ExternalTexture`
exactly once, so on `onPaintingChanged` the host swaps a fresh wrapper into
the node's `.value` rather than re-pointing the old one. Bridge:
`src/lib/brush-three.ts` in the host repo.

### Verification

- `vitest` 99/99, `npm run build` clean.
- Host draw tab (`/experiments/brush-parity?tab=draw`): pointer strokes
  land live on the three plane through the shared device, orientation
  correct, undo (`restore()`) visible without any texture invalidation;
  console clean; `device.features` includes `core-features-and-limits`.
- Goldens gate re-run on the rebuilt dist, `diff-parity --webgpu --goldens
  /test/goldens/tiles --regime character --tolerance 3.0`: **52/54, mean
  1.2771, worst 4.7957** — bit-for-bit the W3/W5/W6 numbers, same two
  documented residuals (edge-subpixel 3.7466, edge-self-intersect 4.7957).
  Expected: the device request gained one optional feature and no shader
  or geometry path changed.

## W8 — Upstream consistency: sync-style API, naming, packaging

Three free-of-perf changes toward upstream's shape (host-site request:
"more parity without sacrificing perf"). None touch a shader, a geometry
path, or anything after the first frame.

### Deferred-call recorder (`await ready()` is optional)

`src/adapters/standalone/deferred.js` + `src/index.standalone.js`. Between
`createCanvas()`/`load()` and the device resolving, every stateful public
call (state setters, transforms, drawing, `render`, `clear`,
`Polygon#show`, `Plot#show`, the CPU-geometry switch) is recorded and
replayed in program order once the device is up and the GPU stroke walker
is warm — `applyLoadedTarget` now arms the recorder and starts `ready()`
itself, so a sketch that never awaits anything still runs, and `ready()` /
`readPixels()` hand back that same promise. After the first flush every
wrapper is one boolean check.

Immediate (never recorded): pure data (`random`, `noise`, `wRand`, `box`,
`listFields`, `hatchArray`, `massArray`, `clip`, class constructors,
`addField` registration, `add` — CPU tip rasterization and image loading,
returns its Promise as upstream does), lifecycle (`createCanvas`, `load`,
`ready`, `readPixels`, `gpu`), the W4b inspection API, and snapshots
(`snapshot` returns a handle, so it cannot be deferred and still requires
ready).

`seed()`/`noiseSeed()` are both: they apply immediately (a `random()` read
before ready is the seeded stream) AND replay in full at their place in
the sequence. Full replay is deliberate: `circle()`, `Plot`, `mass()` and
flow-field generation draw from the SAME stream as `brush.random()`
(upstream design, `rr2`), so the stream must be reset at the same points
for the replayed image to equal a synchronous run. The one consequence,
pre-ready only: a `random()` value read after a pre-ready `seed()` is
that stream's first draw, where a synchronous run would have consumed the
intervening drawing first. The replayed image and the post-ready
`random()` continuation both match the synchronous run exactly (oracle
below). Errors thrown by a deferred call surface at replay, inside the
ready promise, not at the call site.

### Naming

`cpuGeometry()` / `noCpuGeometry()` replace `useCpuGeometry(bool)` (kept
as a deprecated alias; the oracles still exercise it). Upstream spells
mode switches as toggle pairs.

### Packaging

Version **3.0.0** (the fork changes output per seed and swaps renderers).
The p5 build is no longer produced: rollup target removed, `dist/p5.brush.*`
deleted, root `.` export removed, `main`/`module`/`browser` point at the
standalone dist. `src/adapters/p5` and `test/p5` stay as upstream code.

### Verification

- **oracle-w8** (`node scripts/oracle-w8.mjs`; page
  `test/webgpu/oracle-w8.{html,js}`; report `oracle-w8-report.json`): two
  FRESH pages — one draws a full program (both stroke producers, a
  field-bent line, watercolor fill, hatch, transforms, `Polygon#show`, a
  mid-program reseed) immediately after `createCanvas()` with no await,
  the other awaits `ready()` first. **7/7**: no throw; pixel FNV-1a hash
  **identical** across the deferred and synchronous runs (3937 inked px);
  `random()` read before any seed matches, and the first post-flush
  `random()` equals the synchronous run's continuation; a stroke after the
  flush lands in the next `readPixels()`. Two pages rather than two passes
  because flow-field generation is lazy and cached per module — the first
  pass on a page consumes stream draws the second never does (a run-order
  effect upstream shares; not what the oracle measures).
- Goldens gate `diff-parity --webgpu --goldens /test/goldens/tiles --regime
  character --tolerance 3.0`: **52/54, mean 1.2771, worst 4.7957** —
  unchanged (the harness awaits ready, so it runs entirely post-flush).
- oracle-w4b 4/4, oracle-w5 4/4 (through the deprecated alias),
  `vitest` 99/99, `npm run build` clean.

## W9 — Cleanup: unify toward upstream (standalone-only)

Upstream `main` had not moved past the fork point (`fc37da3`) when this
wave ran, so "unify" meant shrinking the fork's divergence and removing
what no longer described the library, not merging.

### Removed

- **The p5 side.** `src/adapters/p5/`, `src/index.p5.js`,
  `src/index.shared.js` (only the p5 entry used it), the WebGL shader
  sources under `src/core/gl/` and `src/stroke/*.{frag,vert}`, the
  `rollup-plugin-glslify` dependency, the `p5` peer dependency, and the
  `test/p5/` pages, `example/`, `example2/`, `tools/`, `images/` and the
  GitHub Pages deploy workflow — all of which loaded `dist/p5.brush.js`,
  which W8 stopped producing. The p5 adapter had been broken since W3
  (it asks the core for WebGL framebuffers and `createShader`). Every
  upstream comparison uses the npm-pinned `p5.brush@2.2.2` (parity
  harness left pane, stroke A/B bench, the site's parity and perf tabs),
  so nothing about perf or parity testing changed.
- **The renderer-hook contract** (`core/renderer_runtime.js`,
  `adapters/standalone/renderer.js`, six call sites in
  `stroke/gl_draw.js`): begin/end/reset around raw WebGL mask draws. With
  the p5 adapter gone every implementation was a no-op.
  `compositor_runtime.js` lost `blitDefaultFramebufferSource` (WebGL
  `blitFramebuffer`, p5-only) and `ensureBlendShaderProgram` no longer
  receives GLSL sources — `color.js` no longer imports them.
- **`useCpuGeometry(bool)`**, the deprecated alias from W8. The oracles and
  the A/B bench use `cpuGeometry()` / `noCpuGeometry()`.
- `package-lock.json` (the pnpm workspace owns installs) and one timing
  JSON nothing referenced.

### Kept, moved

- Upstream's GLSL — the spectral blend shader and the four stamp shaders —
  now lives verbatim under `test/reference/glsl/`. The spectral and stamp
  component oracles render it in WebGL2 as their reference, and
  `scripts/spectral-gen-tables.mjs` transcribes the spectral constant
  tables from it (that script had also gone stale: it targeted
  `spectral.wgsl`, which W3 turned into `spectral.wgsl.js`; fixed).
- `example/brush_tips/brush.jpg`, because upstream's `visual_suite.js`
  loads it and that file is now byte-identical to upstream.

### Unified

- **Upstream test pages byte-identical.** The ten `test/standalone/*`
  files that had carried a `if (brush.ready) await brush.ready()` line
  since W3 are restored from `upstream/main`; the W8 recorder makes the
  guard unnecessary. `test/index.html`, `test/test-nav.js` and the smoke
  test list only the standalone suite; the smoke test asserts a WebGPU
  context and inked pixels (via `readPixels`) instead of a WebGL2 context.
- **One headless scaffold.** `scripts/lib/headless.mjs` (static server
  over the repo root with an optional path rewrite, Chromium resolution,
  `WEBGPU_ARGS` / `SWIFTSHADER_ARGS`, `launchBrowser()`) replaces the
  thirteen private copies in `scripts/*.mjs` and the smoke test.
- **Call-site validation in the recorder.** Restoring upstream's
  `visual_suite.js` exposed a recorder gap: its error-message tests
  (`pick("__DOES_NOT_EXIST__")`, `field("__DOES_NOT_EXIST__")`) expect a
  synchronous throw — eleven of them, nine depending on state (no brush
  set, `vertex()` outside `beginShape()`, `refreshField()` with no field)
  — but a deferred call returned undefined and threw at replay,
  nondeterministically, depending on whether the device resolved first.
  `guard(fn, validate)` now runs a precheck at the call site while
  deferring. `adapters/standalone/precheck.js` holds them: a shadow of
  exactly the state upstream's checks read (brush+color set, open shape
  and its vertex count, open stroke, active field, a push/pop stack for
  the first and last), seeded from the real state when recording starts,
  plus the pure-argument checks (`assertBrush`, `assertField`, angle
  mode, `beginStroke` type, `spline` length), with upstream's messages
  verbatim. For `field` to validate pre-ready the standard field
  generators are registered at module load (`addStandard()` at init)
  instead of only when the grid is first built — definitions only, so no
  grid is generated and the random stream is untouched; `createField()`
  still re-registers them as upstream does. `listFields()` (immediate, not
  recorded) is now a pure registry read: upstream routed it through
  `isFieldReady()`, which builds the compositor and therefore needed the
  device, so the suite's pre-ready `listFields()` call threw "device is
  still initializing". Errors outside that set (an invalid color value)
  still surface inside `ready()`, as documented.
  Unit-tested in `test/unit/precheck.test.js` and `deferred.test.js`.
- **Wave labels out of source comments.** Every `W0`–`W8` reference in
  `src/` was rewritten as an intent-level comment; this file keeps the
  chronology. Stale statements were corrected in passing (target.js no
  longer says callers must await `ready()`; WGSL comments no longer cite
  the glslify plugin).
- **Packaging.** `repository`/`bugs`/`homepage` point at the fork,
  keywords drop `p5`, `pnpm test:goldens` runs the goldens gate, and the
  README, `docs/standalone.md`, `llms.txt` and the adapter READMEs
  describe a single WebGPU build (install `brush-gpu/standalone`;
  requirements, `ready()` optional with the `random()` caveat,
  `readPixels`, `gpu()`, `cpuGeometry`, snapshots, inspection API, hash
  RNG divergence).

Not touched: `.github/workflows/publish-npm.yml` (publishes on a `v*` tag
through an npm trusted-publisher environment that this fork's repo has
not configured), the `p5.brush` devDependency (the reference), and the
plan documents in the host repo.

### Verification (final state)

All re-run on the final tree after `pnpm build` (Metal, headless Chromium):

- `pnpm exec vitest run` — 8 files, 109 tests (6 new for the recorder and
  its prechecks).
- `pnpm test:smoke` — upstream's `test/standalone/visual_suite.html`,
  byte-identical to `upstream/main`, three consecutive runs: PASS (no page
  errors, no unexpected `console.error`, a WebGPU context, inked pixels
  via `readPixels`). Its eleven error-message tests all throw at the call
  site while the device is still initializing.
- `node scripts/oracle-w8.mjs` — 7/7, pixel hash 2970327761 identical
  between the recorded+replayed run and the synchronous run (unchanged
  from W8).
- `oracle-w4b` 4/4, `oracle-w5` 4/4, `oracle-w1a` 4/4, `oracle-stencil`
  12/12, `oracle-spectral` 4/4, `oracle-stamps` 4/4, `oracle-grow` 4/4,
  `oracle-strokewalk` 5/5 — the spectral and stamp oracles now fetch
  their GLSL reference from `test/reference/glsl/`.
- `pnpm test:goldens` — 54 tiles, regime character, worst 4.7957, mean
  1.2771, failing 2 (edge-subpixel 3.7466, edge-self-intersect 4.7957):
  unchanged since W3.
- `node scripts/spectral-gen-tables.mjs --check` — both targets up to
  date against `test/reference/glsl/spectral.frag`.
- `grep -rn '\bW[0-8][ab]\?\b' src` — no matches.
- `src/` vs `upstream/main`: 18 files modified, 20 added, 18 deleted
  (the p5 adapter, GLSL, and the no-op renderer hooks); `scripts/*.mjs`
  2656 → 1874 lines including the new shared module.
