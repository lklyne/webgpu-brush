// ============================================================
// W5 GPU-resident fill oracle — headless driver
//
// Serves the repo and drives test/webgpu/oracle-w5.html in headless
// Chromium with WebGPU on the real GPU (--enable-unsafe-webgpu
// --use-angle=metal, same as every other oracle here), then gates:
//   - cpu-vs-gpu:  RMSE < 1.0/255 between cpuGeometry() and noCpuGeometry()
//                  on eight fill scenarios
//   - determinism: three consecutive GPU-fill renders byte-identical
//   - dirty-rect:  the GPU-accumulated composite rect never clips ink
//   - routing:     Stats/cpuGeometry fall back, GPU path taken otherwise
//
//   node scripts/oracle-w5.mjs [--dump]
//
// --dump writes test/webgpu/w5-dumps/<scene>-{gpu,cpu}.png for every
// failing scenario — the debugger for this wave.
//
// Output: test/webgpu/oracle-w5-report.json + console summary.
// Exit 0 iff all tests pass.
// ============================================================

import { startServer, launchBrowser, REPO_ROOT } from "./lib/headless.mjs";
import { writeFile, mkdir } from "node:fs/promises";
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

  await page.goto(`${baseUrl}/test/webgpu/oracle-w5.html`, {
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
    join(REPO_ROOT, "test", "webgpu", "oracle-w5-report.json"),
    JSON.stringify(report, null, 2),
  );

  if (process.argv.includes("--dump") && results.dumps) {
    const dir = join(REPO_ROOT, "test", "webgpu", "w5-dumps");
    await mkdir(dir, { recursive: true });
    for (const [name, pair] of Object.entries(results.dumps)) {
      for (const [which, dataUrl] of Object.entries(pair)) {
        const b64 = dataUrl.split(",")[1];
        await writeFile(join(dir, `${name}-${which}.png`), Buffer.from(b64, "base64"));
      }
    }
    console.log(`dumped ${Object.keys(results.dumps).length} failing scenes to ${dir}`);
  }

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
