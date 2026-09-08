// ============================================================
// brush-gpu Playwright Smoke Test
//
// Loads the standalone visual suite in headless Chromium (real GPU, WebGPU
// via Metal ANGLE) and asserts:
//   - No uncaught page errors
//   - No unexpected console.error output
//   - A canvas holds a WebGPU context
//   - The painting has ink (readPixels, not a screenshot — canvas2d
//     drawImage of a WebGPU canvas is blank in some headless configurations)
//
// Run: node test/e2e/smoke.mjs  (requires npm run build first)
// ============================================================

import { startServer, launchBrowser } from "../../scripts/lib/headless.mjs";

// ---------------------------------------------------------------------------
// ALLOWED_CONSOLE_ERRORS
//
// The visual suite calls console.error only when an error-message test
// *fails to throw*. On a correctly-built library, all error tests throw and
// no console.error is produced. This array is intentionally left empty.
// If you see entries appear here, it means a library regression caused an
// expected error to stop being thrown — that is a real failure to fix.
// ---------------------------------------------------------------------------
const ALLOWED_CONSOLE_ERRORS = [];

const PAGES = [
  {
    name: "standalone WebGPU",
    path: "test/standalone/visual_suite.html",
  },
];

async function runSuite(page, { name, path }, baseUrl) {
  const url = `${baseUrl}/${path}`;
  const pageErrors = [];
  const consoleErrors = [];

  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      const allowed = ALLOWED_CONSOLE_ERRORS.some((rx) => rx.test(text));
      if (!allowed) {
        consoleErrors.push(text);
      }
    }
  });

  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForSelector("canvas", { timeout: 30_000 });

  // Let the suite draw; the standalone suite is a single static pass.
  await page.waitForTimeout(5_000);

  const failures = [];

  if (pageErrors.length > 0) {
    failures.push(`Uncaught page errors:\n${pageErrors.map((e) => `  ${e}`).join("\n")}`);
  }

  if (consoleErrors.length > 0) {
    failures.push(`Unexpected console.error messages:\n${consoleErrors.map((e) => `  ${e}`).join("\n")}`);
  }

  // The suite page has the brush canvas plus a 2D label overlay; getContext
  // returns null on a canvas that already holds a different context type, so
  // pass if any canvas answers to "webgpu".
  const hasWebGPU = await page.evaluate(() => {
    if (!navigator.gpu) return false;
    return Array.from(document.querySelectorAll("canvas")).some((c) => {
      try {
        return !!c.getContext("webgpu");
      } catch {
        return false;
      }
    });
  });
  if (!hasWebGPU) {
    failures.push("No WebGPU context found on any canvas element.");
  }

  const inked = await page.evaluate(async () => {
    const brush = await import("/dist/brush.esm.js");
    const { pixels } = await brush.readPixels();
    let n = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) n++;
    return n;
  });
  if (!(inked > 0)) {
    failures.push(`Painting is empty (${inked} pixels with alpha).`);
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let server = null;
let browser = null;
let exitCode = 0;

try {
  server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();

  for (const suite of PAGES) {
    const page = await browser.newPage();
    try {
      const failures = await runSuite(page, suite, baseUrl);
      if (failures.length === 0) {
        console.log(`PASS  ${suite.name}  (${suite.path})`);
      } else {
        console.error(`FAIL  ${suite.name}  (${suite.path})`);
        for (const f of failures) {
          console.error(`  ${f}`);
        }
        exitCode = 1;
      }
    } finally {
      await page.close();
    }
  }
} finally {
  if (browser) await browser.close();
  if (server) server.close();
}

process.exit(exitCode);
