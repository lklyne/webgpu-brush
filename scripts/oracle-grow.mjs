// ============================================================
// W2 grow-compute oracle — headless driver
//
// Serves the repo and drives test/webgpu/grow-oracle.html in headless
// Chromium with WebGPU enabled (real GPU — --enable-unsafe-webgpu
// --use-angle=metal, same as oracle-w1a), then gates on:
//   - hash-parity: exact u32 hashU32 match GPU vs CPU
//   - int-parity: exact nTrim / GROW_CAP-step integer decisions
//   - grow chains: vertex-for-vertex vs the CPU FillPoly.grow()
//     (extracted from fill.js at runtime), counts/dirs/op-counter exact,
//     positions within float tolerance
//   - batched single-pass run equals the step-by-step run
//
//   node scripts/oracle-grow.mjs
//
// Output: test/webgpu/grow-report.json + console summary.
// Exit 0 iff all tests pass. Permanent part of the test suite.
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

  await page.goto(`${baseUrl}/test/webgpu/grow-oracle.html`, {
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
    tolerances: results.tolerances ?? null,
    globalMaxVertDev: results.globalMaxVertDev ?? null,
    globalMaxModDev: results.globalMaxModDev ?? null,
    tests: results.tests ?? [],
    pageErrors,
  };
  await writeFile(
    join(REPO_ROOT, "test", "webgpu", "grow-report.json"),
    JSON.stringify(report, null, 2),
  );

  console.log(`adapter: ${JSON.stringify(results.adapter)}`);
  for (const t of report.tests) {
    const detail = Object.entries(t)
      .filter(([k]) => !["name", "pass", "steps", "step", "chain"].includes(k))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    console.log(`${t.pass ? "PASS" : "FAIL"} ${t.name}  ${detail}`);
    if (!t.pass) exitCode = 1;
  }
  if (report.tests.length < 7) {
    console.error(`expected 7 tests, got ${report.tests.length}`);
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
