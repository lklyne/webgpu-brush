// ============================================================
// W1a oracle — headless driver
//
// Serves the repo and drives test/webgpu/oracle-w1a.html in headless
// Chromium with WebGPU enabled, then prints and gates on the four W1a
// acceptance tests (premultiplied parity, dirty-rect scissor, resize
// leaks, pipeline-count stability).
//
//   node scripts/oracle-w1a.mjs
//
// Browser resolution follows scripts/diff-parity.mjs (PARITY_CHROME env →
// agent-browser Chrome for Testing → system Chrome). WebGPU needs a REAL
// GPU on this machine (Metal); swiftshader/software WebGPU is not
// available, so unlike diff-parity this does NOT force software GL.
//
// Output: test/webgpu/oracle-w1a-report.json + console summary.
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

  await page.goto(`${baseUrl}/test/webgpu/oracle-w1a.html`, {
    waitUntil: "load",
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__oracleResults !== undefined, null, {
    timeout: 120_000,
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
    join(REPO_ROOT, "test", "webgpu", "oracle-w1a-report.json"),
    JSON.stringify(report, null, 2),
  );

  console.log(`adapter: ${JSON.stringify(results.adapter)}`);
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
