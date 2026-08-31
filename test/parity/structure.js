// ============================================================
// brush-gpu structural capture (headless-drivable)
//
// Browser half of scripts/assert-structure.mjs. Renders the parity tile
// suite through ONE module (default: this fork's dist) with the `_stats`
// instrumentation enabled, and reports per-tile structural data instead
// of pixels:
//
//   - strokes: { steps, drawn } per stroke (tip() invocations are exact
//     and RNG-independent; `drawn` counts grain-gated submissions)
//   - fills: FillPoly vertex-count lists per layer index
//   - coverage: pixels in the tile crop that differ from the background
//     (pixel-derived, but thresholded — robust to canvas2d LSB noise)
//   - geomHash: cumulative FNV-1a over exact float64 geometry bits —
//     the run-to-run identity fingerprint
//
// Query params:
//   ?module=/dist/brush.esm.js&seed=parity-0&scale=0.8&bg=%23f6f1e8
//
// Exposes: window.__structuralResults
// ============================================================

import { buildTiles, registerCustomBrush, resetState } from "./tiles.js";

// Grid geometry — MUST match parity.js / the site harness.
const TILE = 150;
const COLS = 6;
const GRID_ROWS = 12;
const CANVAS_W = COLS * TILE;
const CANVAS_H = GRID_ROWS * TILE;

const query = new URLSearchParams(window.location.search);
const MOD_URL = query.get("module") ?? "/dist/brush.esm.js";
const SEED = query.get("seed") ?? "parity-0";
const SCALE = Number(query.get("scale") ?? 0.8);
const BG = query.get("bg") ?? "#f6f1e8";

function parseHexColor(hex) {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

(async () => {
  const status = document.getElementById("status");
  try {
    const brush = await import(MOD_URL);
    // Modules without instrumentation (e.g. upstream p5.brush) still get
    // coverage-only capture.
    const stats = brush._stats ?? {
      enabled: false,
      strokes: [],
      fills: [],
      geomHash: 0,
      reset() {},
    };

    const canvas = brush.createCanvas(CANVAS_W, CANVAS_H, {
      parent: document.getElementById("host"),
      pixelDensity: 1,
      id: "structure-canvas",
    });
    brush.angleMode("degrees");
    await registerCustomBrush(brush);
    brush.scaleBrushes(SCALE);
    brush.clear(BG);

    stats.reset();
    if (brush._stats) stats.enabled = true;

    const all = buildTiles(brush).slice(0, COLS * GRID_ROWS);
    const originX = -CANVAS_W / 2;
    const originY = -CANVAS_H / 2;

    const perTile = [];
    all.forEach((t, i) => {
      brush.seed(`${SEED}:${t.id}`);
      brush.noiseSeed(`${SEED}:${t.id}`);
      resetState(brush);

      const s0 = stats.strokes.length;
      const f0 = stats.fills.length;

      brush.push();
      brush.translate(originX + (i % COLS) * TILE, originY + Math.floor(i / COLS) * TILE);
      try {
        t.draw(brush, TILE);
      } catch (err) {
        console.error(`[structure] tile "${t.id}" threw:`, err);
      }
      brush.pop();

      perTile.push({
        tile: t.id,
        feature: t.label,
        section: t.section,
        strokes: stats.strokes.slice(s0).map((s) => ({ steps: s.steps ?? 0, drawn: s.drawn })),
        fills: stats.fills.slice(f0).map((f) => ({ layers: f.layers })),
        geomHash: stats.geomHash, // cumulative up to and including this tile
      });
    });
    stats.enabled = false;

    brush.render();

    // Coverage from the final composited canvas.
    const c = document.createElement("canvas");
    c.width = canvas.width;
    c.height = canvas.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0);
    const pix = ctx.getImageData(0, 0, c.width, c.height);
    const [bgR, bgG, bgB] = parseHexColor(BG);
    const THRESH = 12;

    perTile.forEach((entry, i) => {
      const x0 = (i % COLS) * TILE;
      const y0 = Math.floor(i / COLS) * TILE;
      let covered = 0;
      for (let row = y0; row < y0 + TILE; row++) {
        let p = (row * pix.width + x0) * 4;
        for (let col = 0; col < TILE; col++, p += 4) {
          if (
            Math.abs(pix.data[p] - bgR) > THRESH ||
            Math.abs(pix.data[p + 1] - bgG) > THRESH ||
            Math.abs(pix.data[p + 2] - bgB) > THRESH
          ) {
            covered++;
          }
        }
      }
      entry.coverage = covered;
    });

    status.textContent = `${perTile.length} tiles · geomHash ${stats.geomHash >>> 0}`;
    window.__structuralResults = {
      seed: SEED,
      module: MOD_URL,
      scale: SCALE,
      bg: BG,
      tile: TILE,
      cols: COLS,
      geomHash: stats.geomHash >>> 0,
      tiles: perTile,
    };
  } catch (err) {
    console.error("[structure] capture failed:", err);
    status.textContent = `failed: ${err.message}`;
    window.__structuralResults = { error: String(err && err.message) };
  }
})();
