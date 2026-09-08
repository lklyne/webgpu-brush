// ============================================================
// W2 spectral-wgsl oracle — headless driver
//
// Serves the repo and drives test/webgpu/spectral-oracle.html in headless
// Chromium with WebGPU enabled: the WGSL composite (spectral.wgsl +
// spectral.js reflectance hoist) vs LUT values captured from the actual
// GLSL shader (test/reference/glsl/spectral.frag) in a WebGL2 context on the same
// page. Gate: < 1.5/255 per channel on every pair × t (plan, W2).
//
//   node scripts/oracle-spectral.mjs
//
// Browser resolution follows scripts/oracle-w1a.mjs (PARITY_CHROME env →
// agent-browser Chrome for Testing → system Chrome). WebGPU needs a REAL
// GPU on this machine (Metal); software WebGPU is not available.
//
// Output: test/webgpu/spectral-report.json + console summary.
// Exit 0 iff all cases pass.
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

  await page.goto(`${baseUrl}/test/webgpu/spectral-oracle.html`, {
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
    gate: "maxChannelDiff < 1.5/255 vs GLSL LUT, every pixel",
    tests: results.tests,
    timing: results.timing ?? null,
    pageErrors,
  };
  await writeFile(
    join(REPO_ROOT, "test", "webgpu", "spectral-report.json"),
    JSON.stringify(report, null, 2),
  );

  console.log(`adapter: ${JSON.stringify(results.adapter)}`);
  for (const t of results.tests ?? []) {
    console.log(`${t.pass ? "PASS" : "FAIL"} ${t.name}  worst=${t.worstDiff}`);
    for (const row of t.rows) {
      console.log(
        `    t=${row.t}  diff=${row.maxDiff}  glsl=[${row.glsl}] wgsl=[${row.wgsl}]` +
          (row.cpu ? ` cpu=[${row.cpu}]` : ""),
      );
    }
    if (!t.pass) exitCode = 1;
  }
  if ((results.tests ?? []).length < 6) {
    console.error(`expected ≥6 test groups, got ${results.tests?.length ?? 0}`);
    exitCode = 1;
  }
  if (results.timing) {
    console.log(
      `hoist timing @${results.timing.resolution}: full=${results.timing.msPerPassFull}ms ` +
        `precomputed=${results.timing.msPerPassPrecomputed}ms speedup=${results.timing.speedup}x`,
    );
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
