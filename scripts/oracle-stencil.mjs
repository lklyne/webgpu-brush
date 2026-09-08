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

import { startServer, launchBrowser, REPO_ROOT } from "./lib/headless.mjs";
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const FIXTURE_PATH = join(REPO_ROOT, "test", "fixtures", "grow-poly.json");
const REPORT_PATH = join(REPO_ROOT, "test", "webgpu", "stencil-report.json");
const wantCapture = process.argv.includes("--capture");

let server = null;
let browser = null;
let exitCode = 0;

try {
  server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  browser = await launchBrowser();

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
