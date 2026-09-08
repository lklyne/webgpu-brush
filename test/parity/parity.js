// ============================================================
// brush-gpu split-screen parity grid (headless-drivable)
//
// Browser half of scripts/diff-parity.mjs — same shape as
// test/standalone/visual_suite.js: a plain module script served
// statically, no bundler.
//
// Left pane: upstream p5.brush (npm, pinned — the immutable reference).
// Right pane: this fork's dist build.
// Modules are separate ESM singletons (different URLs), but rendering is
// still sequential — the standalone build latches global state per module
// and sequential is the only order the site harness supports.
//
// Query params:
//   ?left=/node_modules/p5.brush/dist/brush.esm.js   (default)
//   ?right=/dist/brush.esm.js                        (default)
//   ?seed=parity-0&scale=0.8&bg=%23f6f1e8
//
// Exposes for the driver:
//   window.__parityResults        — per-tile scores + summary (set when done)
//   window.__parityCrop(pane, i)  — PNG dataURL of one tile crop
//   window.__parityDiff(i, gain)  — PNG dataURL of amplified per-pixel diff
// ============================================================

import { buildTiles, registerCustomBrush, resetState } from "./tiles.js";

// Grid geometry — MUST match the site harness (runtime.ts).
const TILE = 150;
const COLS = 6;
const GRID_ROWS = 12; // capacity; unused cells stay blank
const CANVAS_W = COLS * TILE;
const CANVAS_H = GRID_ROWS * TILE;

const query = new URLSearchParams(window.location.search);
const LEFT_URL = query.get("left") ?? "/node_modules/p5.brush/dist/brush.esm.js";
const RIGHT_URL = query.get("right") ?? "/dist/brush.esm.js";
const SEED = query.get("seed") ?? "parity-0";
// W3: ?goldens=/test/goldens/tiles renders ONLY the right pane and fills
// the left pane from the frozen golden PNGs — the < 3.0/255 integration
// gate compares the WebGPU adapter against test/goldens/, not upstream.
const GOLDENS = query.get("goldens");
const SCALE = Number(query.get("scale") ?? 0.8);
const BG = query.get("bg") ?? "#f6f1e8";

document.getElementById("left-caption").textContent = `left: ${LEFT_URL}`;
document.getElementById("right-caption").textContent = `right: ${RIGHT_URL}`;

/**
 * Draw every tile into a fresh canvas. Same sequence as the site harness
 * (scenes/grid.tsx renderGrid): canvas at full capacity size BEFORE anything
 * touches a field (the flow-field grid latches permanently on first use),
 * degrees mode (tiles pass degrees; standalone defaults to radians),
 * custom brush registered once per module before any scaling,
 * per-tile seeding so tiles stay independent.
 */
// Same-module bookkeeping, mirroring the site harness (runtime.ts):
// ?left and ?right may resolve to the SAME module instance (dynamic import
// caches by URL). add() must run exactly once per module instance, and
// scaleBrushes() is cumulative, so track the applied factor per module and
// apply only the delta.
const appliedScale = new WeakMap();
const initialized = new WeakSet();

async function renderGrid(brush, parent) {
  const canvas = brush.createCanvas(CANVAS_W, CANVAS_H, {
    parent,
    pixelDensity: 1,
    id: `parity-${parent.id}`,
  });
  // W3: the WebGPU fork initializes its device asynchronously.
  if (brush.ready) await brush.ready();
  if (query.get("cpuwalk") === "1") brush.cpuGeometry?.();

  brush.angleMode("degrees");
  if (!initialized.has(brush)) {
    // Async: the image-tip brush's add() resolves when its tip is loaded.
    await registerCustomBrush(brush);
    initialized.add(brush);
  }
  const current = appliedScale.get(brush) ?? 1;
  if (current !== SCALE) {
    brush.scaleBrushes(SCALE / current);
    appliedScale.set(brush, SCALE);
  }
  brush.clear(BG);

  const all = buildTiles(brush);
  const capacity = COLS * GRID_ROWS;
  if (all.length > capacity) {
    console.warn(`[parity] ${all.length} tiles exceeds capacity ${capacity}; raise GRID_ROWS.`);
  }
  const tiles = all.slice(0, capacity);

  // Standalone build is CENTER-origin, like p5's WEBGL mode.
  const originX = -CANVAS_W / 2;
  const originY = -CANVAS_H / 2;

  tiles.forEach((t, i) => {
    brush.seed(`${SEED}:${t.id}`);
    brush.noiseSeed(`${SEED}:${t.id}`);
    resetState(brush);

    brush.push();
    brush.translate(originX + (i % COLS) * TILE, originY + Math.floor(i / COLS) * TILE);
    try {
      t.draw(brush, TILE);
    } catch (err) {
      console.error(`[parity] tile "${t.id}" threw:`, err);
    }
    brush.pop();
  });

  brush.render();
  return { canvas, tiles, brush };
}

/**
 * Snapshot a pane. The WebGPU fork exposes readPixels() (out-of-band
 * readback of the painting texture) because canvas2d drawImage() of a
 * WebGPU canvas is blank in some headless configurations; WebGL upstream
 * uses the drawImage path.
 */
async function snapshotPane(pane) {
  if (pane.brush.readPixels) {
    const { width, height, pixels } = await pane.brush.readPixels();
    return new ImageData(pixels, width, height);
  }
  return snapshot(pane.canvas);
}

/** Builds a left-pane ImageData from the frozen golden tile PNGs. */
async function goldenSnapshot(tiles) {
  const c = document.createElement("canvas");
  c.width = CANVAS_W;
  c.height = CANVAS_H;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  await Promise.all(
    tiles.map(
      (t, i) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const { x, y } = tileOrigin(i);
            ctx.drawImage(img, x, y);
            resolve();
          };
          img.onerror = () => reject(new Error(`missing golden: ${t.id}`));
          img.src = `${GOLDENS}/${t.id}.png`;
        }),
    ),
  );
  return ctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
}

/** Snapshot a WebGL canvas into ImageData while its drawing buffer is valid. */
function snapshot(canvas) {
  const c = document.createElement("canvas");
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

/** RMSE over the RGB channels of one rectangular region. */
function regionRmse(a, b, x, y, w, h) {
  let sum = 0;
  let n = 0;
  for (let row = y; row < Math.min(y + h, a.height); row++) {
    let i = (row * a.width + x) * 4;
    for (let col = x; col < Math.min(x + w, a.width); col++, i += 4) {
      for (let ch = 0; ch < 3; ch++) {
        const d = a.data[i + ch] - b.data[i + ch];
        sum += d * d;
        n++;
      }
    }
  }
  return n ? Math.sqrt(sum / n) : 0;
}

let pixLeft = null;
let pixRight = null;
let tileList = [];

function tileOrigin(i) {
  return { x: (i % COLS) * TILE, y: Math.floor(i / COLS) * TILE };
}

/** PNG dataURL of one TILE×TILE crop from a pane snapshot. */
window.__parityCrop = (pane, i) => {
  const pix = pane === "left" ? pixLeft : pixRight;
  const { x, y } = tileOrigin(i);
  const c = document.createElement("canvas");
  c.width = TILE;
  c.height = TILE;
  const ctx = c.getContext("2d");
  const out = ctx.createImageData(TILE, TILE);
  for (let row = 0; row < TILE; row++) {
    const src = ((y + row) * pix.width + x) * 4;
    out.data.set(pix.data.subarray(src, src + TILE * 4), row * TILE * 4);
  }
  ctx.putImageData(out, 0, 0);
  return c.toDataURL("image/png");
};

/** PNG dataURL of the amplified |left-right| diff for one tile. */
window.__parityDiff = (i, gain = 8) => {
  const { x, y } = tileOrigin(i);
  const c = document.createElement("canvas");
  c.width = TILE;
  c.height = TILE;
  const ctx = c.getContext("2d");
  const out = ctx.createImageData(TILE, TILE);
  for (let row = 0; row < TILE; row++) {
    for (let col = 0; col < TILE; col++) {
      const src = ((y + row) * pixLeft.width + x + col) * 4;
      const dst = (row * TILE + col) * 4;
      const d =
        (Math.abs(pixLeft.data[src] - pixRight.data[src]) +
          Math.abs(pixLeft.data[src + 1] - pixRight.data[src + 1]) +
          Math.abs(pixLeft.data[src + 2] - pixRight.data[src + 2])) /
        3;
      const v = Math.min(255, d * gain);
      out.data[dst] = v;
      out.data[dst + 1] = v * 0.35;
      out.data[dst + 2] = v * 0.35;
      out.data[dst + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c.toDataURL("image/png");
};

(async () => {
  const status = document.getElementById("status");
  try {
    // Sequential on purpose — see header comment.
    const modRight = await import(RIGHT_URL);
    const right = await renderGrid(modRight, document.getElementById("right-host"));
    pixRight = await snapshotPane(right);
    tileList = right.tiles;

    if (GOLDENS) {
      pixLeft = await goldenSnapshot(right.tiles);
      document.getElementById("left-caption").textContent = `left: goldens ${GOLDENS}`;
    } else {
      const modLeft = await import(LEFT_URL);
      const left = await renderGrid(modLeft, document.getElementById("left-host"));
      pixLeft = await snapshotPane(left);
      tileList = left.tiles;
    }
    const scores = tileList.map((t, i) => {
      const { x, y } = tileOrigin(i);
      return {
        tile: t.id,
        feature: t.label,
        section: t.section,
        rmse: regionRmse(pixLeft, pixRight, x, y, TILE, TILE),
      };
    });

    const worst = scores.reduce((m, s) => Math.max(m, s.rmse), 0);
    const mean = scores.reduce((m, s) => m + s.rmse, 0) / (scores.length || 1);
    status.textContent = `${scores.length} tiles · worst ${worst.toFixed(3)} · mean ${mean.toFixed(3)}`;

    window.__parityResults = {
      seed: SEED,
      scale: SCALE,
      bg: BG,
      left: LEFT_URL,
      right: RIGHT_URL,
      tile: TILE,
      cols: COLS,
      tiles: scores,
      worst,
      mean,
    };
  } catch (err) {
    console.error("[parity] render failed:", err);
    status.textContent = `failed: ${err.message}`;
    window.__parityResults = { error: String(err && err.message) };
  }
})();
