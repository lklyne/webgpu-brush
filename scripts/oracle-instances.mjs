// ============================================================
// Two-instance oracle — headless driver
//
// Drives test/webgpu/oracle-instances.html four times in headless Chromium
// with WebGPU on the real GPU (same launch args as every other oracle here),
// one FRESH page per mode, and gates:
//
//   interleaved: A and B built together and stepped call by call; also the
//                module-level default painting on the same page, and
//                dispose(A) leaving B alone
//   soloA/soloB: the identical per-painting step list, one painting a page
//   shared:      A owns a device, B adopts it, interleaved again
//
// Cross-page gates: A's pixel hash is the same interleaved, alone and on a
// shared device — likewise B's — and each painting's seeded random()
// sequence is the same whether or not the other one drew.
//
//   node scripts/oracle-instances.mjs
//
// Output: test/webgpu/oracle-instances-report.json + console summary.
// Exit 0 iff all tests pass.
// ============================================================

import { startServer, launchBrowser, REPO_ROOT } from "./lib/headless.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

async function runMode(browser, baseUrl, mode, pageErrors) {
  const page = await browser.newPage();
  page.on("pageerror", (err) => pageErrors.push(`${mode}: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(`${mode}: ${msg.text()}`);
  });
  await page.goto(`${baseUrl}/test/webgpu/oracle-instances.html?mode=${mode}`, {
    waitUntil: "load",
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__oracleResults !== undefined, null, {
    timeout: 300_000,
  });
  const results = await page.evaluate(() => window.__oracleResults);
  await page.close();
  return results;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let server = null;
let browser = null;
let exitCode = 0;

try {
  server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();

  const pageErrors = [];
  const interleaved = await runMode(browser, baseUrl, "interleaved", pageErrors);
  const soloA = await runMode(browser, baseUrl, "soloA", pageErrors);
  const soloB = await runMode(browser, baseUrl, "soloB", pageErrors);
  const shared = await runMode(browser, baseUrl, "shared", pageErrors);

  const tests = [];
  for (const r of [interleaved, soloA, soloB, shared]) {
    if (r.error) {
      console.error(`${r.mode} page failed: ${r.error}`);
      exitCode = 1;
    }
    for (const t of r.tests) tests.push({ ...t, name: `${r.mode}:${t.name}` });
  }

  /**
   * @param {string} name
   * @param {{hash?: number, ink?: number}|undefined} got
   * @param {{hash?: number, ink?: number}|undefined} want
   */
  function hashGate(name, got, want) {
    const pass = got?.hash !== undefined && got.hash === want?.hash;
    tests.push({
      name,
      pass,
      detail: pass
        ? `pixel hash ${got.hash} identical (${got.ink} inked px)`
        : `${got?.hash} (${got?.ink} px) vs ${want?.hash} (${want?.ink} px)`,
    });
  }

  hashGate("A: interleaved = alone", interleaved.a, soloA.a);
  hashGate("B: interleaved = alone", interleaved.b, soloB.b);
  hashGate("A: shared device = alone", shared.a, soloA.a);
  hashGate("B: shared device = alone", shared.b, soloB.b);

  const distinct = interleaved.a?.hash !== interleaved.b?.hash;
  tests.push({
    name: "A and B differ",
    pass: distinct,
    detail: distinct
      ? `two different paintings (${interleaved.a?.hash} vs ${interleaved.b?.hash})`
      : "both paintings hashed identically — the sizes or programs collapsed",
  });

  /**
   * @param {string} name
   * @param {number[]|undefined} got
   * @param {number[]|undefined} want
   */
  function streamGate(name, got, want) {
    const pass = Array.isArray(got) && got.length === 3 && same(got, want);
    tests.push({
      name,
      pass,
      detail: pass
        ? `random() after seed() is ${got.join(", ")} either way`
        : `${got?.join(", ")} vs ${want?.join(", ")}`,
    });
  }

  streamGate("A: seeded stream unaffected by B", interleaved.streamA, soloA.streamA);
  streamGate("B: seeded stream unaffected by A", interleaved.streamB, soloB.streamB);
  streamGate("A: seeded stream on a shared device", shared.streamA, soloA.streamA);
  streamGate("B: seeded stream on a shared device", shared.streamB, soloB.streamB);

  const report = {
    generatedAt: new Date().toISOString(),
    hashes: {
      interleaved: { a: interleaved.a, b: interleaved.b },
      solo: { a: soloA.a, b: soloB.b },
      shared: { a: shared.a, b: shared.b },
    },
    tests,
    pageErrors,
  };
  await writeFile(
    join(REPO_ROOT, "test", "webgpu", "oracle-instances-report.json"),
    JSON.stringify(report, null, 2),
  );

  for (const t of tests) {
    console.log(`${t.pass ? "PASS" : "FAIL"} ${t.name}  detail=${JSON.stringify(t.detail)}`);
    if (!t.pass) exitCode = 1;
  }
  if (pageErrors.length) {
    console.log(`page errors (${pageErrors.length}):`);
    for (const e of pageErrors) console.log(`  ${e}`);
    exitCode = 1;
  }
  console.log(`\n${tests.filter((t) => t.pass).length}/${tests.length} pass`);
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await browser?.close();
  server?.close();
}

process.exit(exitCode);
