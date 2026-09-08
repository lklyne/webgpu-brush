// ============================================================
// brush-gpu Structural Assertions (W1b gate)
//
// Drives test/parity/structure.html headlessly (same server/browser
// resolution as diff-parity.mjs) and either captures a structural JSON
// or compares two captures with the W1b assertion rules.
//
//   node scripts/assert-structure.mjs --capture <out.json> [--module <url>] [--seed <s>]
//   node scripts/assert-structure.mjs --compare <pre.json> <post.json>
//   node scripts/assert-structure.mjs --identity <a.json> <b.json> [...more]
//
// Compare rules (docs/plans/p5-brush-pure-webgpu.md, W1b — tolerances
// calibrated against measured upstream cross-seed variance, see FORK.md):
//   - tile count and per-tile stroke count: exact
//   - stamp count per stroke exact — enforced on tip() invocations
//     (`steps`), which are RNG-independent for caller-specified geometry.
//     Tiles where stroke LENGTH itself derives from random draws
//     (hatch rand jitter, mass) legitimately re-roll: for those, stroke
//     count stays exact and per-tile total steps must be within 5%.
//   - grain-gated submissions (`drawn`) within 5% per tile total (the
//     gate re-rolls under the new RNG by design; measured Δ ≤ 1.8%)
//   - FillPoly structure: fill count exact, per-layer polygon count
//     exact (fixed control flow), per-layer mean vertex count within
//     40% (upstream's own seed-to-seed swing measures up to 56%;
//     measured pre→post worst is 25%)
//   - coverage area within 2% of tile area — except tiles containing
//     watercolor fills, whose thresholded coverage naturally swings
//     >40× with seed: those must land inside the upstream cross-seed
//     envelope (test/goldens/coverage-envelope.json), padded ×0.5/×2
//
// Identity rule: geomHash (exact float64 geometry fingerprint) equal
// across all inputs. This is the run-to-run reproducibility check that
// sidesteps the canvas2d pixel noise floor.
// ============================================================

import { startServer, launchBrowser, REPO_ROOT, WEBGPU_ARGS } from "./lib/headless.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

// ---------------------------------------------------------------------------
// Compare / identity modes (no browser needed)
// ---------------------------------------------------------------------------

async function loadJson(p) {
  return JSON.parse(await readFile(resolve(REPO_ROOT, p), "utf8"));
}

function fail(msgs) {
  for (const m of msgs) console.error(`  FAIL ${m}`);
  process.exit(1);
}

if (args.includes("--identity")) {
  const files = args.slice(args.indexOf("--identity") + 1);
  if (files.length < 2) {
    console.error("--identity needs at least two capture files");
    process.exit(2);
  }
  const caps = await Promise.all(files.map(loadJson));
  const hashes = caps.map((c) => c.geomHash);
  const ok = hashes.every((h) => h === hashes[0]);
  console.log(`identity: ${files.length} runs · geomHash ${hashes.join(", ")}`);
  if (!ok) fail(["geomHash differs across runs — output is not reproducible"]);
  console.log("identity: PASS (all geometry hashes equal)");
  process.exit(0);
}

if (args.includes("--compare")) {
  const i = args.indexOf("--compare");
  const [preF, postF] = [args[i + 1], args[i + 2]];
  const pre = await loadJson(preF);
  const post = await loadJson(postF);
  let envelope = null;
  try {
    envelope = (await loadJson("test/goldens/coverage-envelope.json")).tiles;
  } catch {
    /* optional */
  }
  const errors = [];
  const stats = { layerMeanDelta: [], stepsRel: [], drawnRel: [] };

  if (pre.tiles.length !== post.tiles.length) {
    fail([`tile count ${pre.tiles.length} → ${post.tiles.length}`]);
  }

  const TILE_AREA = pre.tile * pre.tile;
  for (let t = 0; t < pre.tiles.length; t++) {
    const a = pre.tiles[t];
    const b = post.tiles[t];
    const id = a.tile;
    if (id !== b.tile) errors.push(`tile order mismatch at ${t}: ${id} vs ${b.tile}`);

    // Coverage: 2% of tile area for structural tiles; upstream cross-seed
    // envelope (padded ×0.5/×2) for watercolor-fill tiles.
    const covDelta = Math.abs(a.coverage - b.coverage);
    const isFillTile = a.fills.length > 0;
    if (isFillTile && envelope?.[id]) {
      const lo = envelope[id].min * 0.5;
      const hi = Math.max(envelope[id].max * 2, 0.02 * TILE_AREA);
      if (b.coverage < lo || b.coverage > hi) {
        errors.push(`${id}: coverage ${b.coverage} outside upstream seed envelope [${lo.toFixed(0)}, ${hi.toFixed(0)}]`);
      }
    } else if (covDelta > Math.max(0.02 * TILE_AREA, 30)) {
      errors.push(`${id}: coverage ${a.coverage} → ${b.coverage} (Δ${covDelta} > ${Math.max(0.02 * TILE_AREA, 30).toFixed(0)})`);
    }

    // Stroke structure.
    if (a.strokes.length !== b.strokes.length) {
      errors.push(`${id}: stroke count ${a.strokes.length} → ${b.strokes.length}`);
      continue;
    }
    const stepsExact = a.strokes.every((sa, s) => sa.steps === b.strokes[s].steps);
    const totSteps = (x) => x.strokes.reduce((m, s) => m + s.steps, 0);
    const totDrawn = (x) => x.strokes.reduce((m, s) => m + s.drawn, 0);
    if (!stepsExact) {
      // Random-length strokes (hatch rand jitter / mass): totals within 5%.
      const ta = totSteps(a);
      const tb = totSteps(b);
      const rel = ta ? Math.abs(ta - tb) / ta : 0;
      stats.stepsRel.push(rel);
      if (rel > 0.05) {
        errors.push(`${id}: total steps ${ta} → ${tb} (${(rel * 100).toFixed(1)}% > 5%)`);
      }
    }
    const da = totDrawn(a);
    const db = totDrawn(b);
    const drel = da ? Math.abs(da - db) / da : 0;
    stats.drawnRel.push(drel);
    if (da > 20 && drel > 0.05) {
      errors.push(`${id}: total drawn ${da} → ${db} (${(drel * 100).toFixed(1)}% > 5%)`);
    }

    // Fill layer structure.
    if (a.fills.length !== b.fills.length) {
      errors.push(`${id}: fill count ${a.fills.length} → ${b.fills.length}`);
      continue;
    }
    for (let f = 0; f < a.fills.length; f++) {
      const la = a.fills[f].layers;
      const lb = b.fills[f].layers;
      const layers = new Set([...Object.keys(la), ...Object.keys(lb)]);
      for (const L of layers) {
        const va = la[L] ?? [];
        const vb = lb[L] ?? [];
        if (va.length !== vb.length) {
          errors.push(`${id}: fill ${f} layer ${L} polygon count ${va.length} → ${vb.length}`);
          continue;
        }
        const meanA = va.reduce((m, v) => m + v, 0) / (va.length || 1);
        const meanB = vb.reduce((m, v) => m + v, 0) / (vb.length || 1);
        const rel = meanA ? Math.abs(meanA - meanB) / meanA : 0;
        stats.layerMeanDelta.push(rel);
        if (rel > 0.4) {
          errors.push(
            `${id}: fill ${f} layer ${L} mean verts ${meanA.toFixed(1)} → ${meanB.toFixed(1)} (${(rel * 100).toFixed(1)}% > 40%)`,
          );
        }
      }
    }
  }

  const worstLayer = stats.layerMeanDelta.reduce((m, d) => Math.max(m, d), 0);
  const worstSteps = stats.stepsRel.reduce((m, d) => Math.max(m, d), 0);
  const worstDrawn = stats.drawnRel.reduce((m, d) => Math.max(m, d), 0);
  console.log(
    `compare: ${pre.tiles.length} tiles · worst random-length total-steps Δ ${(worstSteps * 100).toFixed(2)}% (limit 5%) · worst total-drawn Δ ${(worstDrawn * 100).toFixed(2)}% (limit 5%) · worst layer-mean Δ ${(worstLayer * 100).toFixed(1)}% (limit 40%)`,
  );
  if (errors.length) fail(errors);
  console.log("compare: PASS");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Capture mode (browser)
// ---------------------------------------------------------------------------

const OUT = opt("capture", null);
if (!OUT) {
  console.error("usage: --capture <out.json> | --compare <pre> <post> | --identity <a> <b> ...");
  process.exit(2);
}
const MODULE = opt("module", "/dist/brush.esm.js");
const SEED = opt("seed", "parity-0");

let server = null;
let browser = null;
let exitCode = 0;
try {
  server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  // W3: the fork requires WebGPU (no software WebGPU here) — Metal ANGLE.
  // Geometry capture (geomHash) is GPU-independent; the flags only need
  // to let the adapter initialize.
  browser = await launchBrowser({
    args: [...WEBGPU_ARGS, "--disable-accelerated-2d-canvas"],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  const params = new URLSearchParams({ seed: SEED, module: MODULE });
  await page.goto(`${baseUrl}/test/parity/structure.html?${params}`, {
    waitUntil: "load",
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__structuralResults !== undefined, null, {
    timeout: 180_000,
  });
  const results = await page.evaluate(() => window.__structuralResults);
  if (results.error) throw new Error(`structure page failed: ${results.error}`);
  if (pageErrors.length) {
    console.error(`page errors:\n${pageErrors.map((e) => `  ${e}`).join("\n")}`);
    exitCode = 1;
  }
  results.capturedAt = new Date().toISOString();
  await writeFile(resolve(REPO_ROOT, OUT), JSON.stringify(results, null, 2));
  console.log(
    `capture: ${results.tiles.length} tiles · geomHash ${results.geomHash} → ${OUT}`,
  );
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.close();
}
process.exit(exitCode);
