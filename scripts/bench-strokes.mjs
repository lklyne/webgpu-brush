// ============================================================
// Stroke A/B bench runner — drives test/standalone/stroke_ab.html headlessly
// (real GPU via Metal, same flags as profile-baseline.mjs) across variants
// and prints median to-completion / JS-return times.
//
//   node scripts/bench-strokes.mjs [--runs 3] [--n 320] [--only fork,cycle,gpu]
//
// Requires `npm run build` (dist/).
// ============================================================

import { chromium } from "playwright-chromium";
import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const RUNS = opt("runs", "3");
const N = opt("n", "320");
const ONLY = opt("only", null);

const VARIANTS = [
  { impl: "upstream", color: "cycle", walk: "-" },
  { impl: "fork", color: "cycle", walk: "gpu" },
  { impl: "fork", color: "cycle", walk: "cpu" },
  { impl: "upstream", color: "fixed", walk: "-" },
  { impl: "fork", color: "fixed", walk: "gpu" },
  { impl: "fork", color: "fixed", walk: "cpu" },
];

const MIME = { ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript" };

function startServer() {
  return new Promise((res, rej) => {
    const server = createServer(async (req, resp) => {
      const urlPath = req.url.split("?")[0];
      try {
        const data = await readFile(join(REPO_ROOT, urlPath));
        resp.writeHead(200, { "Content-Type": MIME[extname(urlPath)] || "application/octet-stream" });
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

function findExecutable() {
  if (process.env.PARITY_CHROME && existsSync(process.env.PARITY_CHROME)) return process.env.PARITY_CHROME;
  const agentBrowsers = join(process.env.HOME ?? "", ".agent-browser", "browsers");
  if (existsSync(agentBrowsers)) {
    for (const dir of readdirSync(agentBrowsers).sort().reverse()) {
      const p = join(agentBrowsers, dir, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
      if (existsSync(p)) return p;
    }
  }
  const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(systemChrome)) return systemChrome;
  throw new Error("No Chromium found. Set PARITY_CHROME.");
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const server = await startServer();
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: findExecutable(),
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU"],
});

console.log(`${"variant".padEnd(28)} ${"total ms".padStart(9)} ${"js ms".padStart(8)}   (median of ${RUNS}, n=${N})`);
try {
  for (const v of VARIANTS) {
    const label = `${v.impl} · ${v.color} · ${v.walk}`;
    if (ONLY && !ONLY.split(",").every((k) => label.includes(k))) continue;
    const page = await browser.newPage();
    let fail;
    const failed = new Promise((res) => (fail = res));
    page.on("pageerror", (err) => {
      console.error(`[${label}] pageerror:`, err.message);
      fail(null);
    });
    const done = new Promise((res) => {
      failed.then(res);
      page.on("console", (msg) => {
        const t = msg.text();
        if (t.startsWith("BENCH ")) res(JSON.parse(t.slice(6)));
        else if (msg.type() === "error") console.error(`[${label}]`, t);
      });
      setTimeout(() => res(null), 120_000);
    });
    const qs = `impl=${v.impl}&color=${v.color}&walk=${v.walk}&n=${N}&runs=${RUNS}`;
    await page.goto(`${baseUrl}/test/standalone/stroke_ab.html?${qs}`, { waitUntil: "load" });
    const r = await done;
    await page.close();
    if (!r) {
      console.log(`${label.padEnd(28)} FAILED`);
      continue;
    }
    const total = median(r.results.map((x) => x.totalMs));
    const js = median(r.results.map((x) => x.jsMs));
    console.log(`${label.padEnd(28)} ${total.toFixed(0).padStart(9)} ${js.toFixed(0).padStart(8)}`);
  }
} finally {
  await browser.close();
  server.close();
}
