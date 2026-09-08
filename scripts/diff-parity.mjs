// ============================================================
// brush-gpu Headless Parity Diff
//
// Drives test/parity/parity.html in headless Chromium (same shape as
// test/e2e/smoke.mjs: local static server + playwright-chromium) and
// emits a machine-readable parity report.
//
//   node scripts/diff-parity.mjs [options]
//
// Options:
//   --regime parity|character   verdict criteria (default: parity)
//   --tolerance <rmse>          parity pass threshold (default: 2.0)
//   --seed <string>             tile seed (default: parity-0)
//   --left <url path>           left module (default: upstream npm dist)
//   --right <url path>          right module (default: /dist/brush.esm.js)
//   --baseline                  also freeze left-pane per-tile PNGs +
//                               baseline.json into test/parity/baseline/
//
// Outputs (all under test/parity/):
//   parity-report.json          { tile, feature, section, regime, rmse,
//                                 verdict }[] + summary
//   diffs/<tile>.png            amplified diff, failing tiles only
//   baseline/<tile>.png + baseline.json   (--baseline only)
//
// Regimes (docs/plans/p5-brush-pure-webgpu.md, "The two regimes"):
//   parity    — same geometry, different rasterizer. RMSE vs upstream is
//               the gate: verdict pass/fail against --tolerance.
//   character — geometry differs BY DESIGN (post hash-rng). RMSE vs
//               upstream is recorded but meaningless as a gate; every
//               verdict is "character" and real checks are structural,
//               against the hash-rng goldens, not here.
//
// Requires `npm run build` (dist/) and the p5.brush devDependency
// (node_modules/p5.brush/dist) to exist.
// ============================================================

import {
  startServer,
  launchBrowser,
  REPO_ROOT,
  WEBGPU_ARGS,
  SWIFTSHADER_ARGS,
} from "./lib/headless.mjs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PARITY_DIR = join(REPO_ROOT, "test", "parity");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(`--${name}`);
}
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const REGIME = opt("regime", "parity");
if (REGIME !== "parity" && REGIME !== "character") {
  console.error(`Invalid --regime "${REGIME}". Use parity or character.`);
  process.exit(2);
}
const TOLERANCE = Number(opt("tolerance", "2.0"));
const SEED = opt("seed", "parity-0");
const LEFT = opt("left", "/node_modules/p5.brush/dist/brush.esm.js");
const RIGHT = opt("right", "/dist/brush.esm.js");
const BASELINE = flag("baseline");
// W3: --goldens <url path dir> — right pane vs frozen golden PNGs (the
// integration gate); implies WebGPU-capable launch flags. --webgpu alone
// switches launch flags without the goldens comparison.
const GOLDENS = opt("goldens", null);
const WEBGPU = flag("webgpu") || GOLDENS !== null;
const DIFF_GAIN = 8;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function dataUrlToBuffer(dataUrl) {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

let server = null;
let browser = null;
let exitCode = 0;

try {
  server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Two launch profiles:
  // - default (upstream WebGL2 both panes): swiftshader — one
  //   deterministic software GL rasterizer; software canvas2d.
  // - WebGPU (the fork's adapter): software WebGPU does not exist on
  //   this machine, so real GPU via Metal ANGLE (same flags as the W1a+
  //   oracles).
  browser = await launchBrowser({
    args: WEBGPU
      ? [...WEBGPU_ARGS, "--disable-accelerated-2d-canvas"]
      : [
          ...SWIFTSHADER_ARGS,
          "--disable-accelerated-2d-canvas",
          "--disable-features=SkiaGraphite,CanvasOopRasterization,AcceleratedCanvas2d",
        ],
  });

  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  const params = new URLSearchParams({ seed: SEED, left: LEFT, right: RIGHT });
  if (GOLDENS) params.set("goldens", GOLDENS);
  if (flag("cpuwalk")) params.set("cpuwalk", "1");
  await page.goto(`${baseUrl}/test/parity/parity.html?${params}`, {
    waitUntil: "load",
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__parityResults !== undefined, null, {
    timeout: 120_000,
  });

  const results = await page.evaluate(() => window.__parityResults);
  if (results.error) {
    throw new Error(`parity page failed: ${results.error}`);
  }

  // Per-tile verdicts
  const tiles = results.tiles.map((t) => ({
    tile: t.tile,
    feature: t.feature,
    section: t.section,
    regime: REGIME,
    rmse: Number(t.rmse.toFixed(4)),
    verdict:
      // In goldens mode RMSE is measured against the frozen goldens, so it
      // gates even in the character regime (the plan's "character-regime
      // tiles are compared against the hash-rng goldens").
      REGIME === "character" && !GOLDENS
        ? "character"
        : t.rmse <= TOLERANCE
          ? "pass"
          : "fail",
  }));

  const failing = tiles.filter((t) => t.verdict === "fail");

  // Amplified diff PNGs for failing tiles
  const diffsDir = join(PARITY_DIR, "diffs");
  await rm(diffsDir, { recursive: true, force: true });
  if (failing.length > 0) {
    await mkdir(diffsDir, { recursive: true });
    for (const t of failing) {
      const i = results.tiles.findIndex((r) => r.tile === t.tile);
      const dataUrl = await page.evaluate(
        ([idx, gain]) => window.__parityDiff(idx, gain),
        [i, DIFF_GAIN],
      );
      await writeFile(join(diffsDir, `${t.tile}.png`), dataUrlToBuffer(dataUrl));
    }
  }

  // Baseline freeze (--freeze-goldens redirects into test/goldens/tiles —
  // W3 regenerated the goldens from the frozen W1b dist under the Metal
  // environment; see FORK.md "Goldens re-baselined").
  if (BASELINE) {
    const baseDir = flag("freeze-goldens")
      ? join(REPO_ROOT, "test", "goldens", "tiles")
      : join(PARITY_DIR, "baseline");
    await rm(baseDir, { recursive: true, force: true });
    await mkdir(baseDir, { recursive: true });
    for (let i = 0; i < results.tiles.length; i++) {
      const dataUrl = await page.evaluate((idx) => window.__parityCrop("left", idx), i);
      await writeFile(
        join(baseDir, `${results.tiles[i].tile}.png`),
        dataUrlToBuffer(dataUrl),
      );
    }
    await writeFile(
      join(baseDir, "baseline.json"),
      JSON.stringify(
        {
          frozenAt: new Date().toISOString(),
          seed: SEED,
          left: LEFT,
          tileSize: results.tile,
          cols: results.cols,
          tiles: tiles.map(({ tile, feature, section }) => ({ tile, feature, section })),
        },
        null,
        2,
      ),
    );
    console.log(`baseline: froze ${results.tiles.length} reference tiles into test/parity/baseline/`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    regime: REGIME,
    tolerance: TOLERANCE,
    seed: SEED,
    goldens: GOLDENS,
    left: LEFT,
    right: RIGHT,
    summary: {
      tiles: tiles.length,
      worst: Number(results.worst.toFixed(4)),
      mean: Number(results.mean.toFixed(4)),
      failing: failing.length,
      pageErrors,
    },
    tiles,
  };
  await writeFile(
    join(PARITY_DIR, "parity-report.json"),
    JSON.stringify(report, null, 2),
  );

  console.log(
    `parity-report.json: ${tiles.length} tiles · regime ${REGIME} · worst ${report.summary.worst} · mean ${report.summary.mean} · failing ${failing.length}`,
  );
  for (const t of failing) {
    console.log(`  FAIL ${t.tile} (${t.feature}) rmse ${t.rmse} > ${TOLERANCE}`);
  }
  if (pageErrors.length > 0) {
    console.error(`page errors:\n${pageErrors.map((e) => `  ${e}`).join("\n")}`);
    exitCode = 1;
  }
  if ((REGIME === "parity" || GOLDENS) && failing.length > 0) exitCode = 1;
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.close();
}

process.exit(exitCode);
