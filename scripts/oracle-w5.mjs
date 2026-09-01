// ============================================================
// W5 GPU-resident fill oracle — headless driver
//
// Serves the repo and drives test/webgpu/oracle-w5.html in headless
// Chromium with WebGPU on the real GPU (--enable-unsafe-webgpu
// --use-angle=metal, same as every other oracle here), then gates:
//   - cpu-vs-gpu:  RMSE < 1.0/255 between useCpuGeometry(true) and (false)
//                  on eight fill scenarios
//   - determinism: three consecutive GPU-fill renders byte-identical
//   - dirty-rect:  the GPU-accumulated composite rect never clips ink
//   - routing:     Stats/useCpuGeometry fall back, GPU path taken otherwise
//
//   node scripts/oracle-w5.mjs [--dump]
//
// --dump writes test/webgpu/w5-dumps/<scene>-{gpu,cpu}.png for every
// failing scenario — the debugger for this wave.
//
// Output: test/webgpu/oracle-w5-report.json + console summary.
// Exit 0 iff all tests pass.
// ============================================================

import { chromium } from "playwright-chromium";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
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
