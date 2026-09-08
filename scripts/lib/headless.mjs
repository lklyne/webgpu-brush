// =============================================================================
// Shared headless scaffolding for the oracle, bench, parity and smoke
// runners: a static server over the repo root, Chromium resolution, and the
// launch flags that put headless Chromium on the real GPU (WebGPU via Metal
// ANGLE — there is no software WebGPU on this machine).
//
//   import { startServer, launchBrowser, REPO_ROOT } from "./lib/headless.mjs";
//   const server = await startServer();
//   const browser = await launchBrowser();          // WebGPU flags
//   const baseUrl = `http://127.0.0.1:${server.address().port}`;
// =============================================================================

import { chromium } from "playwright-chromium";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

export const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wgsl": "text/plain",
  ".frag": "text/plain",
  ".vert": "text/plain",
};

/** Real-GPU WebGPU in headless Chromium. */
export const WEBGPU_ARGS = [
  "--enable-unsafe-webgpu",
  "--use-angle=metal",
  "--enable-features=WebGPU",
];

/** Software WebGL2 (deterministic rasterizer for WebGL-only pages). */
export const SWIFTSHADER_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

/**
 * Minimal static file server over the repo root on an ephemeral port.
 * @param {{ root?: string, rewrite?: (urlPath: string) => string }} [options]
 *   `rewrite` maps a request path to another repo path before lookup
 *   (used to swap the module a page imports).
 */
export function startServer({ root = REPO_ROOT, rewrite } = {}) {
  return new Promise((res, rej) => {
    const server = createServer(async (req, resp) => {
      let urlPath = req.url.split("?")[0];
      if (urlPath === "/favicon.ico") {
        resp.writeHead(204);
        resp.end();
        return;
      }
      if (rewrite) urlPath = rewrite(urlPath);
      try {
        const data = await readFile(join(root, urlPath));
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

/**
 * Chromium resolution. pnpm blocks playwright-chromium's postinstall
 * download by default (onlyBuiltDependencies), so fall back to any
 * Chromium-family binary on this machine. Returns undefined when
 * playwright's own download exists (let it pick its bundled build).
 */
export function findExecutable() {
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
  throw new Error(
    "No Chromium found. Set PARITY_CHROME, or run: pnpm exec playwright install chromium",
  );
}

/**
 * Launch headless Chromium with the resolved executable.
 * @param {{ args?: string[] }} [options] defaults to WEBGPU_ARGS
 */
export function launchBrowser({ args = WEBGPU_ARGS } = {}) {
  return chromium.launch({ executablePath: findExecutable(), args });
}
