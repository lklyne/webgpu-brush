// ============================================================
// W4b oracle — headless driver
//
// Serves the repo and drives test/webgpu/oracle-w4b.html in headless
// Chromium with WebGPU enabled (real GPU — Metal; same launch flags as
// every other WebGPU oracle in this repo), then prints and gates on the
// four W4b acceptance tests (roundtrip fidelity, translate hook,
// performance isolation, cpu-vs-gpu parity).
//
//   pnpm build && node scripts/oracle-w4b.mjs
//
// (The page imports /dist/brush.esm.js — rebuild after touching src/.)
//
// Output: test/webgpu/oracle-w4b-report.json + console summary.
// Exit 0 iff all four tests pass.
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

  await page.goto(`${baseUrl}/test/webgpu/oracle-w4b.html`, {
    waitUntil: "load",
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__oracleResults !== undefined, null, {
    timeout: 300_000,
  });
  const results = await page.evaluate(() => window.__oracleResults);

  if (results.error) {
    console.error(`oracle page failed: ${results.error}`);
    exitCode = 1;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    tests: results.tests,
    pageErrors,
  };
  await writeFile(
    join(REPO_ROOT, "test", "webgpu", "oracle-w4b-report.json"),
    JSON.stringify(report, null, 2),
  );

  for (const t of results.tests) {
    const detail = Object.entries(t)
      .filter(([k]) => k !== "name" && k !== "pass")
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    console.log(`${t.pass ? "PASS" : "FAIL"} ${t.name}  ${detail}`);
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
