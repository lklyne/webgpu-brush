// ============================================================
// W8 deferred-call oracle — headless driver
//
// Serves the repo and drives test/webgpu/oracle-w8.html TWICE in headless
// Chromium with WebGPU on the real GPU (--enable-unsafe-webgpu
// --use-angle=metal, same as every other oracle here) — one fresh page per
// mode — then gates:
//   - no-await:      the deferred page draws straight after createCanvas()
//                    without awaiting ready() and throws nothing
//   - deferred=sync: the deferred page's pixel hash equals the sync page's
//   - user-stream:   random() values read before any seed, and the first
//                    value read after the flush, equal the sync page's
//   - post-flush:    after the first flush the wrappers are pass-through
//                    (a draw after ready lands in the next readPixels)
//
//   node scripts/oracle-w8.mjs
//
// Output: test/webgpu/oracle-w8-report.json + console summary.
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
  await page.goto(`${baseUrl}/test/webgpu/oracle-w8.html?mode=${mode}`, {
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

let server = null;
let browser = null;
let exitCode = 0;

try {
  server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  browser = await launchBrowser();

  const pageErrors = [];
  const deferred = await runMode(browser, baseUrl, "deferred", pageErrors);
  const sync = await runMode(browser, baseUrl, "sync", pageErrors);

  const tests = [];
  for (const r of [deferred, sync]) {
    if (r.error) {
      console.error(`${r.mode} page failed: ${r.error}`);
      exitCode = 1;
    }
    for (const t of r.tests) tests.push({ ...t, name: `${r.mode}:${t.name}` });
  }

  const hashOk = deferred.hash !== undefined && deferred.hash === sync.hash;
  tests.push({
    name: "deferred=sync",
    pass: hashOk,
    detail: hashOk
      ? `pixel hash ${deferred.hash} identical across a recorded+replayed run and a synchronous run (${deferred.ink} inked px)`
      : `deferred hash ${deferred.hash} (${deferred.ink} px) vs sync ${sync.hash} (${sync.ink} px)`,
  });

  // userDraws: [pre-seed a, pre-seed b, after-program, post-flush].
  // Sync consumes the stream in program order, so its after-program value is
  // the (n+1)th draw past the last seed (n = draws the program itself made).
  // Deferred reads its after-program value BEFORE the replay (the exempt
  // first draw); its post-flush value is the (n+1)th — it must equal the
  // sync page's after-program value.
  const d = deferred.userDraws ?? [];
  const s = sync.userDraws ?? [];
  const streamOk = d.length === 4 && s.length === 4 && d[0] === s[0] && d[1] === s[1] && d[3] === s[2];
  tests.push({
    name: "user-stream",
    pass: streamOk,
    detail: streamOk
      ? `pre-seed draws match and the post-flush draw ${d[3]} equals sync's continuation (exempt pre-ready draw ${d[2]})`
      : `deferred ${d.join(",")} vs sync ${s.join(",")} (want d[0..1]=s[0..1], d[3]=s[2])`,
  });

  const report = {
    generatedAt: new Date().toISOString(),
    tests,
    pageErrors,
  };
  await writeFile(
    join(REPO_ROOT, "test", "webgpu", "oracle-w8-report.json"),
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
