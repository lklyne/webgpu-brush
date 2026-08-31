// ============================================================
// Fill-heavy benchmark (W4a)
//
// Companion to stroke_bench.js: a workload dominated by watercolor fill
// rasterization — 48 large high-bleed filled blobs, no strokes, no hatch.
// Public API only; runs unmodified against upstream p5.brush and this fork.
//
// Deterministic: fixed seed/noiseSeed, no animation.
// ============================================================

import * as brush from "../../dist/brush.esm.js";

const CANVAS_W = 1600;
const CANVAS_H = 1600;
const scriptStart = performance.now();

const palette = ["#002185", "#c0392b", "#27ae60", "#8e44ad", "#e67e22", "#16a085"];

const pixelDensity = window.devicePixelRatio || 1;
brush.createCanvas(CANVAS_W, CANVAS_H, {
  id: "brush-canvas",
  parent: "#canvas-host",
  pixelDensity,
});
if (brush.ready) await brush.ready(); // W3: WebGPU device init is async

const drawStart = performance.now();

brush.seed(5678);
brush.noiseSeed(5678);
brush.push();
brush.translate(-CANVAS_W / 2, -CANVAS_H / 2);
brush.noStroke();
brush.noHatch();

const COLS = 8;
const ROWS = 6;
const CELL_W = CANVAS_W / COLS;
const CELL_H = CANVAS_H / ROWS;
const R = Math.min(CELL_W, CELL_H) * 0.62;

for (let i = 0; i < COLS * ROWS; i++) {
  const cx = (i % COLS) * CELL_W + CELL_W / 2;
  const cy = Math.floor(i / COLS) * CELL_H + CELL_H / 2;
  brush.fill(palette[i % palette.length], 70);
  brush.fillBleed(0.25 + 0.15 * (i % 3), "out");
  brush.fillTexture(0.6, 0.4);
  // 14-gon blob with deterministic radial wobble.
  const pts = [];
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    const r = R * (0.75 + 0.25 * Math.sin(i * 3.1 + k * 2.7));
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  brush.polygon(pts);
}

brush.noFill();
brush.pop();
brush.render();

const drawMs = performance.now() - drawStart;
window.reportStandaloneFirstFrame?.("fill_bench", {
  parseMs: scriptStart - (window.__brushLoadStart ?? scriptStart),
  drawMs,
});
console.log("fill_bench complete");
