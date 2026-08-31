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

import { chromium } from "playwright-chromium";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
};

function startServer() {
  return new Promise((res, rej) => {
    const server = createServer(async (req, resp) => {
      const urlPath = req.url.split("?")[0];
      if (urlPath === "/favicon.ico") {
        resp.writeHead(204);
        resp.end();
        return;
      }
      try {
        const data = await readFile(join(REPO_ROOT, urlPath));
        resp.writeHead(200, {
          "Content-Type": MIME[extname(urlPath)] || "application/octet-stream",
        });
        resp.end(data);
      } catch {
        resp.writeHead(404);
        resp.end("Not found");
      }
    });
    server.listen(0, "127.0.0.1", () => res(server));
    server.on("error", rej);
  });
}

// Same resolution chain as scripts/diff-parity.mjs.
function findExecutable() {
  if (process.env.PARITY_CHROME && existsSync(process.env.PARITY_CHROME)) {
    return process.env.PARITY_CHROME;
  }
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return undefined;
  } catch {
    /* not downloaded */
  }
  const agentBrowsers = join(process.env.HOME ?? "", ".agent-browser", "browsers");
  if (existsSync(agentBrowsers)) {
    for (const dir of readdirSync(agentBrowsers).sort().reverse()) {
      const p = join(
        agentBrowsers,
        dir,
        "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      );
      if (existsSync(p)) return p;
    }
  }
  const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(systemChrome)) return systemChrome;
  throw new Error("No Chromium found. Set PARITY_CHROME.");
}

let server = null;
let browser = null;
let exitCode = 0;

try {
  server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  browser = await chromium.launch({
    executablePath: findExecutable(),
    args: [
      // Real-GPU WebGPU in headless: unsafe flag + explicit Metal ANGLE.
      "--enable-unsafe-webgpu",
      "--use-angle=metal",
      "--enable-features=WebGPU",
    ],
  });

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
