// ============================================================
// Stroke A/B bench — attributes stroke-heavy cost to its parts.
//
// Same workload shape as stroke_bench.js (320 full-width field-driven
// flowLines) but every run is timed to GPU COMPLETION on both sides
// (fork: readPixels barrier; upstream: gl.finish + 1×1 readPixels), and
// URL params select the variant:
//
//   impl=fork|upstream    which module renders
//   color=cycle|fixed     palette per stroke (one composite per stroke)
//                         vs one color (one composite per run)
//   walk=gpu|cpu          fork only: force the retained CPU walk
//   n=320  runs=3  w=2000 h=1400
//
// Driven by scripts/bench-strokes.mjs; reports one JSON line per run.
// ============================================================

const q = new URLSearchParams(location.search);
const impl = q.get("impl") ?? "fork";
const colorMode = q.get("color") ?? "cycle";
const walk = q.get("walk") ?? "gpu";
const N = Number(q.get("n") ?? 320);
const RUNS = Number(q.get("runs") ?? 3);
const CANVAS_W = Number(q.get("w") ?? 2000);
const CANVAS_H = Number(q.get("h") ?? 1400);

const brush = await import(
  impl === "upstream" ? "/node_modules/p5.brush/dist/brush.esm.js" : "/dist/brush.esm.js"
);

const palette = ["#002185", "#c0392b", "#27ae60", "#8e44ad", "#e67e22"];
const tips = ["2B", "HB", "2H", "cpencil", "pen", "rotring", "spray", "marker"];
const BG = "#f6f1e8";

brush.createCanvas(CANVAS_W, CANVAS_H, {
  id: "brush-canvas",
  parent: "#canvas-host",
  pixelDensity: 1,
});
if (brush.ready) await brush.ready();
if (impl === "fork" && brush.cpuGeometry) (walk === "cpu" ? brush.cpuGeometry : brush.noCpuGeometry)();

const canvas = document.getElementById("brush-canvas");
const gl = impl === "upstream" ? canvas.getContext("webgl2") : null;

async function barrier() {
  if (impl === "fork") {
    await brush.readPixels();
  } else {
    gl.finish();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }
}

function workload(n) {
  brush.seed(1234);
  brush.noiseSeed(1234);
  brush.clear(BG);
  brush.push();
  brush.translate(-CANVAS_W / 2, -CANVAS_H / 2);
  brush.noFill();
  brush.noHatch();
  brush.field("seabed");
  for (let i = 0; i < n; i++) {
    const tip = tips[i % tips.length];
    const color = colorMode === "fixed" ? palette[0] : palette[i % palette.length];
    brush.set(tip, color, 1);
    const y = 20 + ((CANVAS_H - 40) * i) / Math.max(1, n - 1);
    brush.flowLine(30, y, CANVAS_W - 60, 0);
  }
  brush.noField();
  brush.pop();
  brush.render();
}

// Untimed warm-up (pipelines, pools), then drain.
workload(Math.max(1, Math.round(N / 8)));
await barrier();

const results = [];
for (let r = 0; r < RUNS; r++) {
  const t0 = performance.now();
  workload(N);
  const jsMs = performance.now() - t0;
  await barrier();
  const totalMs = performance.now() - t0;
  results.push({ jsMs, totalMs });
}
console.log(
  "BENCH " + JSON.stringify({ impl, color: colorMode, walk, n: N, w: CANVAS_W, h: CANVAS_H, results }),
);
