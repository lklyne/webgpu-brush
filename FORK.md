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
- `scripts/profile-baseline.mjs` — the timing tables above.
- `scripts/assert-structure.mjs` — structural capture/compare/identity
  (W1b gate; see header comment for the calibrated rules).
