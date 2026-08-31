// ============================================================
// stencil-fill oracle — headless driver (W2)
//
//   node scripts/oracle-stencil.mjs [--capture]
//
// 1. If test/fixtures/grow-poly.json is missing (or --capture given),
//    drives test/webgpu/stencil-capture.html to run one seeded
//    watercolor fill through the fork's dist build and serialize REAL
//    FillPoly.grow() polygons (self-intersecting, border, erase
//    circles, full command stream) into the fixture.
// 2. Drives test/webgpu/stencil-oracle.html: stencil-fill vs canvas2d,
//    gate < 2.0/255 RMSE, explicit overlap-counts-once assertion,
//    encoder-overhead measurement.
//
// Browser resolution and WebGPU flags follow scripts/oracle-w1a.mjs
// (real GPU: --enable-unsafe-webgpu --use-angle=metal).
//
// Output: test/webgpu/stencil-report.json. Exit 0 iff all gated tests
// pass and no page errors.
// ============================================================

import { chromium } from "playwright-chromium";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const FIXTURE_PATH = join(REPO_ROOT, "test", "fixtures", "grow-poly.json");
const REPORT_PATH = join(REPO_ROOT, "test", "webgpu", "stencil-report.json");
const wantCapture = process.argv.includes("--capture");

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
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
        resp.writeHead(200, {
          "Content-Type": MIME[extname(urlPath)] || "application/octet-stream",
        });
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

// Same resolution chain as scripts/diff-parity.mjs / oracle-w1a.mjs.
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

let server = null;
let browser = null;
let exitCode = 0;

try {
  server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  browser = await chromium.launch({
    executablePath: findExecutable(),
    args: [
      "--enable-unsafe-webgpu",
      "--use-angle=metal",
      "--enable-features=WebGPU",
    ],
  });

  // --- 1. Fixture capture ---------------------------------------------------
  if (wantCapture || !existsSync(FIXTURE_PATH)) {
    const page = await browser.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.goto(`${baseUrl}/test/webgpu/stencil-capture.html`, {
      waitUntil: "load",
      timeout: 60_000,
    });
    await page.waitForFunction(
      () => window.__fixture !== undefined || window.__fixtureError !== undefined,
      null,
      { timeout: 120_000 },
    );
    const err = await page.evaluate(() => window.__fixtureError);
    if (err) throw new Error(`fixture capture failed: ${err}`);
    const fixture = await page.evaluate(() => window.__fixture);
    if (errs.length) throw new Error(`capture page errors: ${errs.join("; ")}`);
    await mkdir(join(REPO_ROOT, "test", "fixtures"), { recursive: true });
    await writeFile(FIXTURE_PATH, JSON.stringify(fixture));
    console.log(
      `fixture captured: ${fixture.stats.layerOps} layers, ` +
        `${fixture.stats.selfIntersectingPolys} self-intersecting, ` +
        `${fixture.stats.eraseCircles} erase circles -> test/fixtures/grow-poly.json`,
    );
    await page.close();
  }

  // --- 2. Oracle ------------------------------------------------------------
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  await page.goto(`${baseUrl}/test/webgpu/stencil-oracle.html`, {
    waitUntil: "load",
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__oracleResults !== undefined, null, {
    timeout: 180_000,
  });
  const results = await page.evaluate(() => window.__oracleResults);

  if (results.error) {
    console.error(`oracle page failed: ${results.error}`);
    exitCode = 1;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    adapter: results.adapter ?? null,
    fixture: results.fixture ?? null,
    tests: results.tests,
    encoder: results.encoder ?? null,
    pageErrors,
  };
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`adapter: ${JSON.stringify(results.adapter)}`);
  for (const t of results.tests ?? []) {
    const detail = Object.entries(t)
      .filter(([k]) => k !== "name" && k !== "pass")
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    console.log(`${t.pass ? "PASS" : "FAIL"} ${t.name}  ${detail}`);
    if (!t.pass) exitCode = 1;
  }
  if (results.encoder) {
    console.log(`encoder: ${JSON.stringify(results.encoder)}`);
  }
  if ((results.tests?.length ?? 0) < 9) {
    console.error(`expected 9 tests, got ${results.tests?.length ?? 0}`);
    exitCode = 1;
  }
  if (pageErrors.length > 0) {
    console.error(`page errors:\n${pageErrors.map((e) => `  ${e}`).join("\n")}`);
    exitCode = 1;
  }
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.close();
}

process.exit(exitCode);
