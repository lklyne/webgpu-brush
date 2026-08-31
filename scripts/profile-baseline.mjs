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

import { chromium } from "playwright-chromium";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const RUNS = Number(opt("runs", "3"));
const JSON_OUT = opt("json", null);

// Every standalone page that calls reportStandaloneFirstFrame after an
// automatic first render. The two explorers render a default view before
// becoming interactive, so their first frame is still meaningful.
const SCENARIOS = [
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

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

function startServer() {
  return new Promise((res, rej) => {
    const server = createServer(async (req, resp) => {
      const urlPath = req.url.split("?")[0];
      if (urlPath === "/favicon.ico") {
        resp.writeHead(204);
        resp.end();
        return;
      }
      try {
        const data = await readFile(join(REPO_ROOT, urlPath));
        resp.writeHead(200, { "Content-Type": MIME[extname(urlPath)] || "application/octet-stream" });
        resp.end(data);
      } catch {
        resp.writeHead(404);
        resp.end("Not found");
      }
    });
    server.listen(0, "127.0.0.1", () => res(server));
    server.on("error", rej);
  });
}

function findExecutable() {
  if (process.env.PARITY_CHROME && existsSync(process.env.PARITY_CHROME)) {
    return process.env.PARITY_CHROME;
  }
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return undefined;
  } catch {
    /* not downloaded */
  }
  const agentBrowsers = join(process.env.HOME ?? "", ".agent-browser", "browsers");
  if (existsSync(agentBrowsers)) {
    for (const dir of readdirSync(agentBrowsers).sort().reverse()) {
      const p = join(
        agentBrowsers,
        dir,
        "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      );
      if (existsSync(p)) return p;
    }
  }
  const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(systemChrome)) return systemChrome;
  throw new Error("No Chromium found. Set PARITY_CHROME.");
}

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
  server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: findExecutable(),
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });

  const results = [];
  for (const name of SCENARIOS) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const page = await browser.newPage();
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
