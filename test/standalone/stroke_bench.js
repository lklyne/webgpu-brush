// ============================================================
// Stroke-heavy benchmark (W4a)
//
// The existing scenarios bottom out at page overhead on a real GPU, so the
// stroke-heavy speedup target needs a workload where stroke rasterization
// dominates: 320 full-width field-driven flowLines across GPU-walkable
// brush tips. Public API only — runs unmodified against upstream p5.brush
// (dist swap via profile-baseline.mjs --module) and this fork.
//
// Deterministic: fixed seed/noiseSeed, no animation.
// ============================================================

import * as brush from "../../dist/brush.esm.js";

const CANVAS_W = 2000;
const CANVAS_H = 1400;
const scriptStart = performance.now();

const palette = ["#002185", "#c0392b", "#27ae60", "#8e44ad", "#e67e22"];
// GPU-walkable tips only (image/custom tips route to the CPU walk by design).
const tips = ["2B", "HB", "2H", "cpencil", "pen", "rotring", "spray", "marker"];

const pixelDensity = window.devicePixelRatio || 1;
brush.createCanvas(CANVAS_W, CANVAS_H, {
  id: "brush-canvas",
  parent: "#canvas-host",
  pixelDensity,
});
if (brush.ready) await brush.ready(); // W3: WebGPU device init is async

const drawStart = performance.now();

brush.seed(1234);
brush.noiseSeed(1234);
brush.push();
brush.translate(-CANVAS_W / 2, -CANVAS_H / 2);
brush.noFill();
brush.noHatch();
brush.field("seabed");

const N = 320;
for (let i = 0; i < N; i++) {
  const tip = tips[i % tips.length];
  brush.set(tip, palette[i % palette.length], 1);
  const y = 20 + ((CANVAS_H - 40) * i) / (N - 1);
  brush.flowLine(30, y, CANVAS_W - 60, 0);
}

brush.pop();
brush.render();

const drawMs = performance.now() - drawStart;
window.reportStandaloneFirstFrame?.("stroke_bench", {
  parseMs: scriptStart - (window.__brushLoadStart ?? scriptStart),
  drawMs,
});
console.log("stroke_bench complete");
