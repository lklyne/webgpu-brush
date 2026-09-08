// ============================================================
// brush-gpu Baseline Profiler Runner
//
// Loads each standalone test scenario headlessly (same scaffolding as
// scripts/diff-parity.mjs) and captures the first-frame timing line that
// test/standalone/standalone_profiler.js logs via
// window.reportStandaloneFirstFrame. Used to produce the W0 baseline
// table in FORK.md; W4a compares against these numbers.
//
//   node scripts/profile-baseline.mjs [--runs 3] [--json <path>]
//
// Requires `npm run build` (dist/) to exist.
// ============================================================

import { startServer, launchBrowser } from "./lib/headless.mjs";
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const RUNS = Number(opt("runs", "3"));
const JSON_OUT = opt("json", null);
// W4a: serve a different module at /dist/brush.esm.js (the path every
// standalone page imports), e.g. the upstream npm dist for the Metal
// upstream baseline:
//   --module /node_modules/p5.brush/dist/brush.esm.js
const MODULE_REMAP = opt("module", null);
const ONLY = opt("only", null);

// Every standalone page that calls reportStandaloneFirstFrame after an
// automatic first render. The two explorers render a default view before
// becoming interactive, so their first frame is still meaningful.
const SCENARIOS = [
  "stroke_bench",
  "fill_bench",
  "visual_suite",
  "hatch_test",
  "fill_angle_test",
  "angle_mode_test",
  "wash_test",
  "transform_test",
  "pushpop_test",
  "pastel_hatching_test",
  "field_explorer",
  "fill_circle_explorer",
];

// Parses "label: parse 12 ms · draw 345 ms · render 67 ms · total 424 ms"
// or "label: 42.0 ms" (pages that report no breakdown).
function parseTimingLine(text) {
  const out = {};
  for (const [, key, val] of text.matchAll(/(parse|draw|render|total)\s+(-?[\d.]+)\s*ms/g)) {
    out[key] = Number(val);
  }
  if (out.total == null) {
    const m = text.match(/([\d.]+)\s*ms/);
    if (m) out.total = Number(m[1]);
  }
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

let server = null;
let browser = null;
let exitCode = 0;

try {
  server = await startServer({
    rewrite: (p) => (MODULE_REMAP && p === "/dist/brush.esm.js" ? MODULE_REMAP : p),
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  // W3: the fork renders through WebGPU — no software WebGPU exists on
  // this machine, so scenarios run on the real GPU via Metal ANGLE.
  // (Timings are therefore NOT comparable to the W0/W1b swiftshader
  // tables; see FORK.md.)
  browser = await launchBrowser();

  const results = [];
  for (const name of SCENARIOS) {
    if (ONLY && name !== ONLY) continue;
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const page = await browser.newPage();
      page.on("pageerror", (err) => console.error(`[${name}] pageerror:`, err.message));
      page.on("console", (msg) => {
        if (msg.type() === "error") console.error(`[${name}] console.error:`, msg.text());
      });
      const timing = new Promise((res) => {
        page.on("console", (msg) => {
          const t = msg.text();
          if (/ ms\b/.test(t) && /(total|First load|: [\d.]+ ms)/.test(t)) {
            res(parseTimingLine(t));
          }
        });
        setTimeout(() => res(null), 90_000);
      });
      await page.goto(`${baseUrl}/test/standalone/${name}.html`, {
        waitUntil: "load",
        timeout: 60_000,
      });
      const t = await timing;
      await page.close();
      if (t) runs.push(t);
    }
    if (runs.length === 0) {
      console.error(`FAIL  ${name}: no timing reported`);
      exitCode = 1;
      continue;
    }
    const agg = {
      scenario: name,
      runs: runs.length,
      totalMs: median(runs.map((r) => r.total ?? NaN)),
      drawMs: runs.some((r) => r.draw != null) ? median(runs.map((r) => r.draw ?? NaN)) : null,
      renderMs: runs.some((r) => r.render != null) ? median(runs.map((r) => r.render ?? NaN)) : null,
      parseMs: runs.some((r) => r.parse != null) ? median(runs.map((r) => r.parse ?? NaN)) : null,
    };
    results.push(agg);
    console.log(
      `${name.padEnd(22)} total ${String(agg.totalMs).padStart(7)} ms` +
        (agg.drawMs != null ? ` · draw ${agg.drawMs} ms · render ${agg.renderMs} ms` : ""),
    );
  }

  if (JSON_OUT) {
    await writeFile(
      JSON_OUT,
      JSON.stringify({ generatedAt: new Date().toISOString(), runs: RUNS, results }, null, 2),
    );
  }
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.close();
}

process.exit(exitCode);
