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

None yet. As of W0 this fork is a verbatim copy of the pinned commit — the
only changes are the package rename (`p5.brush` → `brush-gpu`), the README
fork notice, this file, and the added parity tooling
(`test/parity/`, `scripts/diff-parity.mjs`, `scripts/profile-baseline.mjs`).

When behavior diverges (first real entry lands at W1b, when `rr()` becomes a
counter-based hash RNG and upstream sketch reproduction breaks), list each
divergence here: what changed, why, and what verification covers it.

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
53 tiles, seed `parity-0`:

- **42 of 53 tiles: RMSE exactly 0** across repeated runs — every stroke,
  field, hatch, and geometry tile is pixel-exact.
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
- Verdicts: 53/53 pass at the default 2.0 tolerance; worst tile ≈ 0.10–0.15
  depending on run.

Implication for later waves: pixel-exact 0 is only ever expectable on
non-fill tiles; fill-path comparisons bottom out around 0.15 RMSE noise.

## Parity tooling

- `test/parity/parity.html` + `parity.js` + `tiles.js` — split-screen
  53-tile grid, browser half. Tile list is a JS port of the host site's
  `src/content/experiments/2026-08-30-brush-parity/tiles.ts`; keep in sync.
- `scripts/diff-parity.mjs` — headless driver. Emits
  `test/parity/parity-report.json`
  (`{ tile, feature, section, regime, rmse, verdict }[]` + summary),
  amplified diff PNGs to `test/parity/diffs/` for failing tiles,
  `--baseline` freezes reference PNGs + `baseline.json`,
  `--regime parity|character` selects verdict criteria.
- `scripts/profile-baseline.mjs` — the timing table above.
