// ============================================================
// W2 strokewalk-compute oracle — headless driver
//
// Serves the repo and drives test/webgpu/strokewalk.html in headless
// Chromium with WebGPU enabled (real GPU — same flags as oracle-w1a),
// then gates on the strokewalk acceptance tests:
//   hash-battery, prefix-scan, walk-parity, determinism (+ informational
//   timing).
//
//   node scripts/oracle-strokewalk.mjs
//
// Output: test/webgpu/strokewalk-report.json + console summary.
// Exit 0 iff all tests pass.
// ============================================================

import { startServer, launchBrowser, REPO_ROOT } from "./lib/headless.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const EXPECTED_TESTS = 5;

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

  await page.goto(`${baseUrl}/test/webgpu/strokewalk.html`, {
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
    join(REPO_ROOT, "test", "webgpu", "strokewalk-report.json"),
    JSON.stringify(report, null, 2),
  );

  console.log(`adapter: ${JSON.stringify(results.adapter)}`);
  for (const t of results.tests ?? []) {
    const detail = Object.entries(t)
      .filter(([k]) => !["name", "pass", "perStroke"].includes(k))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    console.log(`${t.pass ? "PASS" : "FAIL"} ${t.name}  ${detail}`);
    if (t.perStroke) {
      for (const s of t.perStroke) {
        console.log(
          `    stroke ${s.stroke} [${s.brush}] steps=${s.steps} cpu=${s.cpuCount} gpu=${s.gpuCount} ` +
            `posΔ=${s.maxPosDiff?.toExponential?.(2)} sizeΔ=${s.maxSizeDiff?.toExponential?.(2)} ` +
            `alphaΔ=${s.maxAlphaDiff?.toExponential?.(2)}${s.fail ? ` FAIL(${s.fail})` : ""}`,
        );
        if (s.firstBad) console.log(`      firstBad: ${JSON.stringify(s.firstBad)}`);
      }
    }
    if (!t.pass) exitCode = 1;
  }
  if ((results.tests ?? []).length < EXPECTED_TESTS) {
    console.error(`expected ${EXPECTED_TESTS} tests, got ${(results.tests ?? []).length}`);
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
