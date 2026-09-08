// ============================================================
// W2 stamp-pipeline oracle — headless driver
//
// Serves the repo and drives test/webgpu/stamps.html in headless Chromium
// with WebGPU enabled, then prints and gates on the stamp-pipeline
// acceptance tests (disc grid vs upstream WebGL point sprites, image grid
// vs upstream WebGL instanced tips, per-brush smoke, pipeline count).
//
//   node scripts/oracle-stamps.mjs
//
// Same environment contract as scripts/oracle-w1a.mjs: browser resolution
// PARITY_CHROME env → playwright download → agent-browser Chrome for
// Testing → system Chrome; real-GPU WebGPU (Metal) via
// --enable-unsafe-webgpu --use-angle=metal — no software WebGPU on this
// machine.
//
// Output: test/webgpu/stamps-report.json + console summary.
// Exit 0 iff all tests pass.
// ============================================================

import { startServer, launchBrowser, REPO_ROOT } from "./lib/headless.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

let server = null;
let browser = null;
let exitCode = 0;

try {
  server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  browser = await launchBrowser();

  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  await page.goto(`${baseUrl}/test/webgpu/stamps.html`, {
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
    tests: results.tests,
    pageErrors,
  };
  await writeFile(
    join(REPO_ROOT, "test", "webgpu", "stamps-report.json"),
    JSON.stringify(report, null, 2),
  );

  console.log(`adapter: ${JSON.stringify(results.adapter)}`);
  for (const t of results.tests) {
    const detail = Object.entries(t)
      .filter(([k]) => k !== "name" && k !== "pass" && k !== "brushes")
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    console.log(`${t.pass ? "PASS" : "FAIL"} ${t.name}  ${detail}`);
    if (t.brushes) {
      for (const b of t.brushes) {
        console.log(
          `  ${b.pass ? "ok  " : "FAIL"} ${b.name.padEnd(16)} discs=${b.discStamps} images=${b.imageStamps} pixels=${b.pixels}`,
        );
      }
    }
    if (!t.pass) exitCode = 1;
  }
  if (results.tests.length < 4) {
    console.error(`expected 4 tests, got ${results.tests.length}`);
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
